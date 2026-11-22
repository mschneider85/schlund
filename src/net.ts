import { joinRoom } from 'trystero';
import { Mqtt } from './mqtt';
import type { Game } from './game';
import { cleanName, type Hole } from './hole';

/**
 * Unsichtbarer Mehrspieler über WebRTC (Trystero, Signaling über öffentliche Nostr-Relays).
 * Kommt keine direkte Verbindung zustande (Mobilfunk-/Firmen-NAT), laufen die Nachrichten
 * verschlüsselt über öffentliche MQTT-Broker (WebSocket, Port 443-ähnlich, ohne Registrierung).
 *
 * - Alle offenen Spiele derselben Version treffen sich in einem gemeinsamen Raum.
 * - Wer eine Battle-Runde startet, ist deren Host: sein Gerät rechnet Physik, Bots und Punkte.
 * - Wer später „Spielen“ drückt, übernimmt das Loch eines Bots in einer laufenden Runde.
 * - Das eigene Loch bewegt jeder lokal (keine Eingabeverzögerung) und meldet die Position.
 * - Verschwindet der Host, übernimmt der verbleibende Spieler mit der kleinsten ID nahtlos.
 * - Klappt irgendetwas nicht, wird einfach offline gegen Bots gespielt.
 */

export interface HoleInfo {
  name: string; color: number; peer: string | null;
  level: number; xp: number; score: number; kills: number;
  alive: boolean; x: number; z: number;
}
export interface Welcome {
  seed: number; left: number; cd: number; slot: number; host: string;
  holes: HoleInfo[];
  /** Bitmaske der gefressenen Objekte (Base64) */
  dead: string;
}
interface Presence { st: 'idle' | 'host' | 'client'; left?: number; free?: number; n?: number; at?: number }
/** Ereignisse vom Host: gefressen, Loch gefressen, Besitzerwechsel, Rundenende */
type Ev =
  | ['e', number, number, number]
  | ['k', number, number]
  | ['id', number, string, number, string | null]
  | ['end'];
/** Zustand je Loch: x, z, vx, vz, level, xp, score, alive, kills */
type HoleState = number[];
interface State { left: number; h: HoleState[] }

const APP = 'schlund-p2p-' + __NET_ID__;
const r2 = (v: number) => Math.round(v * 100) / 100;
const now = () => performance.now() / 1000;
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function i16ToB64(a: Int16Array) { return b64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)); }
function b64ToI16(s: unknown) {
  if (typeof s !== 'string') return null;
  try { const u = unb64(s); return new Int16Array(u.buffer, 0, u.length >> 1); } catch { return null; }
}

/** öffentliche MQTT-Broker (WebSocket über TLS) – mehrere parallel, falls einer ausfällt */
const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
const TOPIC = 'schlund/' + __NET_ID__;
/** nach so vielen Sekunden ohne Lebenszeichen gilt ein Peer als weg */
const GONE = 7;

interface Peer { p: Presence; seen: number }
type Msg = { t: string; d: unknown };

export class Net {
  self = '';
  role: 'off' | 'host' | 'client' = 'off';
  /** Client: aktueller Host */
  host = '';
  private peers = new Map<string, Peer>();
  private room: ReturnType<typeof joinRoom> | null = null;
  private aM: { send: (d: any, o?: any) => Promise<void> } | null = null;
  private mq: Mqtt[] = [];
  private key: Promise<CryptoKey>;
  private seq = 0;
  private dedupe = new Set<string>();
  private handlers: Record<string, (d: any, from: string) => void> = {};
  private pending = new Map<string, (w: Welcome | null) => void>();
  private evQ: Ev[] = [];
  private stT = 0; private stTm = 0; private mvT = 0; private mvTm = 0; private inT = 0; private hiT = 0;
  private lastSt = 0;
  /** läuft gerade eine Beitrittsanfrage (dann selbst niemanden aufnehmen – sonst treten sich zwei gegenseitig bei) */
  private joining = false;

  constructor(private game: Game) {
    this.key = crypto.subtle.digest('SHA-256', new TextEncoder().encode(APP))
      .then((h) => crypto.subtle.importKey('raw', h, 'AES-GCM', false, ['encrypt', 'decrypt']));
    try {
      // ?nortc: direkte Verbindungen abschalten (zum Testen des MQTT-Notfallwegs)
      if (new URLSearchParams(location.search).has('nortc')) throw new Error('nortc');
      const room = (this.room = joinRoom({ appId: APP, identity: 'none' }, 'battle'));
      const a = room.makeAction<any>('m');
      this.aM = a;
      a.onMessage((m: Msg, { peerId }) => this.recv(m, peerId));
      room.onPeerJoin(({ peerId }) => this.sendTo('hi', this.presence(), peerId));
      room.onPeerLeave(({ peerId }) => {
        // direkte Verbindung weg – lebt der Peer noch über MQTT, meldet er sich gleich wieder
        const p = this.peers.get(peerId);
        if (p) p.seen = Math.min(p.seen, now() - GONE + 1.5);
      });
      room.onError(() => { /* Signaling-Probleme: dann eben MQTT bzw. offline */ });
      room.getSelf().then((s) => this.start(s.peerId)).catch(() => this.start(''));
    } catch { this.start(''); }
    setTimeout(() => this.start(''), 4000); // falls die Identität hängt

    this.handlers = {
      hi: (p: Presence, from) => {
        if (!p || typeof p !== 'object') return;
        const known = this.peers.has(from);
        p.at = now(); // Empfangszeit: Restzeit altert bis zur nächsten Meldung mit
        this.peers.set(from, { p, seen: now() });
        if (!known) this.sendTo('hi', this.presence(), from); // Neuling sofort begrüßen
      },
      join: (d: { name: string; rid: string }, from) => {
        const w = this.admit(from, d);
        this.sendTo('jr', { rid: d?.rid, w }, from);
      },
      jr: (d: { rid: string; w: Welcome | null }) => { this.pending.get(d?.rid)?.(d.w ?? null); },
      st: (s: State, from) => {
        if (this.role !== 'client' || !this.inRound(from) || !s || typeof s !== 'object') return;
        this.host = from; this.lastSt = now();
        this.game.applyNetState(s);
      },
      mv: (d: string, from) => {
        if (this.role !== 'client' || from !== this.host) return;
        const a = b64ToI16(d);
        if (a) this.game.world.applyMovers(a, now());
      },
      ev: (evs: Ev[], from) => {
        if (this.role !== 'client' || !this.inRound(from) || !Array.isArray(evs)) return;
        for (const e of evs) if (Array.isArray(e)) this.game.applyNetEvent(e);
      },
      in: (d: number[], from) => {
        if (this.role !== 'host') return;
        const h = this.holeOf(from);
        if (h && h.ctrl === 'net' && Array.isArray(d)) h.setNet(d[0], d[1], d[2], d[3], now());
      },
      bye: (_d: unknown, from) => this.left(from),
    };
  }

  /** eigene ID steht fest -> MQTT-Notfallweg starten */
  private start(id: string) {
    if (this.self) return;
    this.self = id || 'm' + Math.random().toString(36).slice(2, 14);
    const topics = [TOPIC + '/all', TOPIC + '/p/' + this.self];
    this.mq = BROKERS.map((u) => new Mqtt(u, topics, (_t, payload) => this.onMqtt(payload)));
  }

  // ---------- Transport ----------
  private rtcUp(id: string) { return !!this.room && id in this.room.getPeers(); }
  private alive(id: string) { const p = this.peers.get(id); return !!p && now() - p.seen < GONE; }

  /** an bestimmte Peers (direkt, sonst über MQTT) oder ohne Ziel an alle */
  private sendTo(t: string, d: unknown, target?: string | string[]) {
    const msg: Msg = { t, d };
    if (target === undefined) {
      this.aM?.send(msg).catch(() => {});
      this.mqPub(TOPIC + '/all', msg);
      return;
    }
    const list = (Array.isArray(target) ? target : [target]).filter(Boolean);
    const rtc = list.filter((id) => this.rtcUp(id));
    if (rtc.length) this.aM?.send(msg, { target: rtc }).catch(() => {});
    for (const id of list) if (!rtc.includes(id)) this.mqPub(TOPIC + '/p/' + id, msg);
  }

  private async mqPub(topic: string, msg: Msg) {
    if (!this.self || !this.mq.some((m) => m.ready)) return;
    const plain = new TextEncoder().encode(JSON.stringify({ f: this.self, s: ++this.seq, ...msg }));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.key, plain));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv); out.set(ct, 12);
    for (const m of this.mq) m.publish(topic, out);
  }

  private async onMqtt(payload: Uint8Array) {
    if (payload.length < 29) return;
    let m: { f: string; s: number; t: string; d: unknown };
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: payload.slice(0, 12) }, await this.key, payload.slice(12));
      m = JSON.parse(new TextDecoder().decode(plain));
    } catch { return; }
    if (!m || typeof m.f !== 'string' || m.f === this.self) return;
    // dieselbe Nachricht kommt über mehrere Broker
    const k = m.f + ':' + m.s;
    if (this.dedupe.has(k)) return;
    this.dedupe.add(k);
    if (this.dedupe.size > 4000) this.dedupe = new Set([...this.dedupe].slice(-2000));
    this.recv(m, m.f);
  }

  private recv(m: Msg, from: string) {
    if (!m || typeof m.t !== 'string') return;
    const p = this.peers.get(from);
    if (p) p.seen = now();
    this.handlers[m.t]?.(m.d, from);
  }

  get online() { return this.role !== 'off'; }
  private holeOf(peer: string) { return this.game.holes.find((h) => h.peer === peer); }
  private inRound(peer: string) { return !!this.holeOf(peer); }
  /** andere Menschen in der laufenden Runde */
  private humans() { return this.game.holes.filter((h) => h.peer && h.peer !== this.self).map((h) => h.peer!); }

  private presence(): Presence {
    const g = this.game;
    if (this.role === 'host' && g.running) {
      return { st: 'host', left: r2(g.timeLeft), free: g.holes.filter((h) => h.alive && !h.peer && h.ctrl === 'ai').length, n: this.humans().length + 1 };
    }
    return { st: this.role === 'client' ? 'client' : 'idle' };
  }

  // ---------- Einstieg ----------
  /** Laufende Runde zum Mitspielen suchen. null = keine gefunden -> selbst hosten */
  async findMatch(name: string): Promise<Welcome | null> {
    return this.tryJoin(name, this.openHosts());
  }

  /**
   * Eigene Runde läuft erst kurz und noch ohne Mitspieler: taucht eine ältere Runde auf, still dorthin
   * wechseln. Ältere Runde gewinnt (bei Gleichstand die kleinere ID), damit nur einer wechselt.
   */
  async lateMatch(name: string): Promise<Welcome | null> {
    const g = this.game;
    if (this.role !== 'host' || this.humans().length || !g.running) return null;
    const mine = g.timeLeft + g.countdown;
    const older = this.openHosts().filter(([id, p]) => {
      const left = this.leftOf(p);
      return left < mine - 1 || (Math.abs(left - mine) <= 1 && id < this.self);
    });
    if (!older.length) return null;
    return this.tryJoin(name, older);
  }

  private async tryJoin(name: string, hosts: [string, Presence][]): Promise<Welcome | null> {
    this.joining = true;
    try {
      for (const [peerId] of hosts.slice(0, 2)) {
        const rid = Math.random().toString(36).slice(2);
        const w = await new Promise<Welcome | null>((res) => {
          this.pending.set(rid, res);
          this.sendTo('join', { name, rid }, peerId);
          setTimeout(() => res(null), 3500); // über MQTT etwas langsamer
        });
        this.pending.delete(rid);
        if (w && Array.isArray(w.holes)) { this.role = 'client'; this.host = peerId; this.lastSt = now(); return w; }
      }
      return null;
    } finally { this.joining = false; }
  }

  /** Beitritt kam zu spät (Runde schon verlassen): beim Host wieder abmelden */
  cancelJoin(w: Welcome) {
    this.sendTo('bye', 1, w.host);
    this.role = 'off'; this.host = '';
  }

  private leftOf(p: Presence) { return (Number(p.left) || 0) - (now() - (p.at ?? now())); }

  /** Runden, in die man einsteigen kann (meiste Spieler, dann meiste Restzeit zuerst) */
  private openHosts(): [string, Presence][] {
    return [...this.peers].filter(([id, { p }]) => this.alive(id) && p.st === 'host' && this.leftOf(p) > 45 && (Number(p.free) || 0) > 0)
      .map(([id, { p }]) => [id, p] as [string, Presence])
      .sort((a, b) => (Number(b[1].n) || 0) - (Number(a[1].n) || 0) || this.leftOf(b[1]) - this.leftOf(a[1]));
  }

  /** Diagnose (Seite mit ?debug öffnen) */
  debugInfo() {
    return [`Version ${APP.slice(-10)}  ich ${this.self.slice(0, 6)}  Rolle ${this.role}${this.host ? ' → ' + this.host.slice(0, 6) : ''}`,
      `direkt: ${this.room ? Object.keys(this.room.getPeers()).length : '–'}  MQTT: ${this.mq.filter((m) => m.ready).length}/${this.mq.length}`,
      ...[...this.peers].filter(([id]) => this.alive(id)).map(([id, { p }]) =>
        `  ${id.slice(0, 6)} ${p.st}${p.st === 'host' ? ` ${Math.round(this.leftOf(p))}s frei ${p.free} Spieler ${p.n}` : ''} via ${this.rtcUp(id) ? 'WebRTC' : 'MQTT'}`),
    ].join('\n');
  }

  /** eigene Runde: wir sind Host, andere können einsteigen */
  becomeHost() {
    this.role = 'host';
    this.game.player.peer = this.self;
    this.hiT = 0;
  }

  /** Host: neuer Spieler übernimmt ein Bot-Loch */
  private admit(peerId: string, req: { name: string }): Welcome | null {
    const g = this.game;
    if (this.role !== 'host' || this.joining || !g.running || g.mode !== 'battle' || g.timeLeft < 40 || !g.player.alive) return null;
    if (this.holeOf(peerId)) return null;
    const bots = g.holes.filter((h) => h.alive && !h.peer && h.ctrl === 'ai');
    if (!bots.length) return null;
    // das kleinste Bot-Loch – fair für die, die schon spielen
    const h = bots.sort((a, b) => a.size - b.size)[0];
    const name = cleanName(req?.name);
    const color = h.color; // Farbe des Bot-Lochs – im Match ohnehin einzigartig
    h.setIdentity(name, color);
    h.peer = peerId; h.ctrl = 'net';
    h.setNet(h.x, h.z, 0, 0, now());
    if (!this.peers.has(peerId)) this.peers.set(peerId, { p: { st: 'client' }, seen: now() });
    this.emit(['id', h.id, name, color, peerId]);
    this.flush();
    return {
      seed: g.world.seed, left: g.timeLeft, cd: g.countdown, slot: h.id, host: this.self,
      holes: g.holes.map((o) => ({
        name: o.name, color: o.color, peer: o.peer, level: o.level, xp: o.xp, score: o.score, kills: o.kills,
        alive: o.alive, x: r2(o.x), z: r2(o.z),
      })),
      dead: b64(g.world.deadMask()),
    };
  }

  // ---------- laufend ----------
  emit(e: Ev) { if (this.role === 'host') this.evQ.push(e); }
  private flush() {
    if (!this.evQ.length) return;
    this.sendTo('ev', this.evQ, this.humans());
    this.evQ = [];
  }

  /** jedes Frame (läuft auch im Menü, für die Anwesenheit) */
  tick(dt: number) {
    const g = this.game;
    this.hiT -= dt;
    if (this.hiT <= 0) { this.hiT = 2; this.sendTo('hi', this.presence()); }
    // verstummte Peers austragen
    for (const [id, p] of this.peers) if (now() - p.seen > GONE) { this.peers.delete(id); this.left(id); }

    if (this.role === 'host') {
      const to = this.humans();
      if (!to.length) { this.evQ = []; return; }
      this.flush();
      // über MQTT seltener senden (Broker drosseln sonst)
      const rtc = to.filter((id) => this.rtcUp(id)), mq = to.filter((id) => !this.rtcUp(id));
      this.stT -= dt; this.stTm -= dt; this.mvT -= dt; this.mvTm -= dt;
      const st = () => ({
        left: r2(g.timeLeft),
        h: g.holes.map((h) => [r2(h.x), r2(h.z), r2(h.vx), r2(h.vz), h.level, r2(h.xp), h.score, h.alive ? 1 : 0, h.kills]),
      } as State);
      if (this.stT <= 0 && rtc.length) { this.stT = 1 / 15; this.sendTo('st', st(), rtc); }
      if (this.stTm <= 0 && mq.length) { this.stTm = 1 / 10; this.sendTo('st', st(), mq); }
      if (this.mvT <= 0 && rtc.length) { this.mvT = 1 / 10; this.sendTo('mv', i16ToB64(g.world.packMovers()), rtc); }
      if (this.mvTm <= 0 && mq.length) { this.mvTm = 1 / 4; this.sendTo('mv', i16ToB64(g.world.packMovers()), mq); }
    } else if (this.role === 'client') {
      this.inT -= dt;
      if (this.inT <= 0) {
        this.inT = this.rtcUp(this.host) ? 1 / 20 : 1 / 12;
        const p = g.player;
        this.sendTo('in', [r2(p.x), r2(p.z), r2(p.vx), r2(p.vz)], this.host);
      }
      // Host antwortet nicht mehr – aber nur abgeben, wenn er auch sonst kein Lebenszeichen gibt
      if (now() - this.lastSt > 4) {
        if (this.alive(this.host)) this.lastSt = now() - 2;
        else this.left(this.host);
      }
    }
  }

  /** ein Peer ist weg (Verbindung getrennt oder „bye“) */
  private left(peer: string) {
    const g = this.game;
    if (!peer || this.role === 'off') return;
    const h = this.holeOf(peer);
    if (!h) return;
    h.peer = null;
    if (this.role === 'host') {
      // Spieler weg: sein Loch spielt als Bot weiter
      h.ctrl = 'ai'; h.aiT = 0;
      this.emit(['id', h.id, h.name, h.color, null]);
    } else if (peer === this.host) {
      // Host weg: der verbleibende Spieler mit der kleinsten ID übernimmt
      const cands = g.holes.filter((o) => o.peer && o.alive && (o.peer === this.self || this.alive(o.peer)))
        .map((o) => o.peer!).sort();
      const nh = cands[0];
      if (!nh || nh === this.self) this.takeOver();
      else { this.host = nh; this.lastSt = now(); }
    }
  }

  /** Client wird Host: ab jetzt rechnet dieses Gerät Physik, Bots und Punkte */
  private takeOver() {
    this.role = 'host';
    for (const h of this.game.holes) {
      if (h.isPlayer) continue;
      h.ctrl = h.peer ? 'net' : 'ai';
      h.aiT = 0;
    }
    this.game.world.resumeMovers();
    this.stT = this.stTm = this.mvT = this.mvTm = 0;
  }

  /** Runde verlassen (Ende, Gefressen, Beenden, Tab im Hintergrund) */
  leaveRound(final = false) {
    if (this.role === 'off') return;
    const to = this.humans();
    if (this.role === 'host') {
      if (final) this.emit(['end']);
      this.flush();
    }
    this.sendTo('bye', 1, to);
    for (const h of this.game.holes) {
      if (h.isPlayer) continue;
      h.peer = null;
      if (h.ctrl === 'net') { h.ctrl = 'ai'; h.aiT = 0; }
    }
    this.game.player.peer = null;
    this.role = 'off';
    this.host = '';
  }
}

export type { Ev, State, Hole };
