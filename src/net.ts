import { joinRoom } from 'trystero';
import type { Game } from './game';
import { cleanName, type Hole } from './hole';

/**
 * Unsichtbarer Mehrspieler über WebRTC (Trystero, Signaling über öffentliche Nostr-Relays).
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
interface Presence { st: 'idle' | 'host' | 'client'; left?: number; free?: number; n?: number }
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
function toI16(d: unknown): Int16Array | null {
  if (d instanceof ArrayBuffer) return new Int16Array(d.slice(0, d.byteLength & ~1));
  if (ArrayBuffer.isView(d)) {
    const u = new Uint8Array(d.buffer, d.byteOffset, d.byteLength & ~1).slice();
    return new Int16Array(u.buffer);
  }
  return null;
}

export class Net {
  self = '';
  role: 'off' | 'host' | 'client' = 'off';
  /** Client: aktueller Host */
  host = '';
  private peers = new Map<string, Presence>();
  private room;
  private aHi; private aJoin; private aSt; private aMv; private aEv; private aIn; private aBye;
  private evQ: Ev[] = [];
  private stT = 0; private mvT = 0; private inT = 0; private hiT = 0;
  private lastSt = 0;
  private born = now();

  constructor(private game: Game) {
    const room = (this.room = joinRoom({ appId: APP, identity: 'none' }, 'battle'));
    this.aHi = room.makeAction<any>('hi');
    this.aJoin = room.makeAction<any, any>('join', { kind: 'request' });
    this.aSt = room.makeAction<any>('st');
    this.aMv = room.makeAction<any>('mv');
    this.aEv = room.makeAction<any>('ev');
    this.aIn = room.makeAction<any>('in');
    this.aBye = room.makeAction<any>('bye');
    room.getSelf().then((s) => { this.self = s.peerId; }).catch(() => {});

    room.onPeerJoin(({ peerId }) => { this.send(this.aHi, this.presence(), peerId); });
    room.onPeerLeave(({ peerId }) => { this.peers.delete(peerId); this.left(peerId); });
    room.onError(() => { /* Signaling-Probleme: dann eben offline */ });

    this.aHi.onMessage((p: Presence, { peerId }) => { this.peers.set(peerId, p); });
    this.aJoin.onRequest((req: { name: string }, { peerId }) => this.admit(peerId, req));
    this.aSt.onMessage((s: State, { peerId }) => {
      if (this.role !== 'client' || !this.inRound(peerId)) return;
      this.host = peerId; this.lastSt = now();
      this.game.applyNetState(s);
    });
    this.aMv.onMessage((d: unknown, { peerId }) => {
      if (this.role !== 'client' || peerId !== this.host) return;
      const a = toI16(d);
      if (a) this.game.world.applyMovers(a, now());
    });
    this.aEv.onMessage((evs: Ev[], { peerId }) => {
      if (this.role !== 'client' || !this.inRound(peerId) || !Array.isArray(evs)) return;
      for (const e of evs) this.game.applyNetEvent(e);
    });
    this.aIn.onMessage((d: number[], { peerId }) => {
      if (this.role !== 'host') return;
      const h = this.holeOf(peerId);
      if (h && h.ctrl === 'net' && Array.isArray(d)) h.setNet(d[0], d[1], d[2], d[3], now());
    });
    this.aBye.onMessage((_d: unknown, { peerId }) => this.left(peerId));
  }

  private send(a: { send: (d: any, o?: any) => Promise<void> }, data: unknown, target?: string | string[]) {
    if (Array.isArray(target) && !target.length) return;
    a.send(data, target ? { target } : undefined).catch(() => {});
  }

  get online() { return this.role !== 'off'; }
  private holeOf(peer: string) { return this.game.holes.find((h) => h.peer === peer); }
  private inRound(peer: string) { return !!this.holeOf(peer); }
  /** andere Menschen in der laufenden Runde */
  private humans() { return this.game.holes.filter((h) => h.peer && h.peer !== this.self).map((h) => h.peer!); }

  private presence(): Presence {
    const g = this.game;
    if (this.role === 'host' && g.running) {
      return { st: 'host', left: g.timeLeft, free: g.holes.filter((h) => h.alive && !h.peer && h.ctrl === 'ai').length, n: this.humans().length + 1 };
    }
    return { st: this.role === 'client' ? 'client' : 'idle' };
  }

  // ---------- Einstieg ----------
  /** Laufende Runde zum Mitspielen suchen. null = keine gefunden -> selbst hosten */
  async findMatch(name: string): Promise<Welcome | null> {
    // Direkt nach dem Laden kennt man die anderen noch nicht: kurz auf die Suche warten
    while (now() - this.born < 7 && !this.openHosts().length) await new Promise((r) => setTimeout(r, 150));
    const hosts = this.openHosts();
    for (const [peerId] of hosts.slice(0, 2)) {
      try {
        const w = await this.aJoin.request({ name }, { target: peerId, timeoutMs: 2500 }) as Welcome | null;
        if (w && w.holes) { this.role = 'client'; this.host = peerId; this.lastSt = now(); return w; }
      } catch { /* nächster */ }
    }
    return null;
  }

  /** Runden, in die man einsteigen kann (meiste Spieler, dann meiste Restzeit zuerst) */
  private openHosts() {
    return [...this.peers].filter(([, p]) => p.st === 'host' && (p.left ?? 0) > 45 && (p.free ?? 0) > 0)
      .sort((a, b) => (b[1].n ?? 0) - (a[1].n ?? 0) || (b[1].left ?? 0) - (a[1].left ?? 0));
  }

  /** Diagnose (Seite mit ?debug öffnen) */
  debugInfo() {
    const peers = this.room.getPeers();
    return [`Version ${APP.slice(-10)}  ich ${this.self.slice(0, 6)}  Rolle ${this.role}${this.host ? ' → ' + this.host.slice(0, 6) : ''}`,
      `verbunden: ${Object.keys(peers).length}`,
      ...[...this.peers].map(([id, p]) => `  ${id.slice(0, 6)} ${p.st}${p.st === 'host' ? ` ${Math.round(p.left ?? 0)}s frei ${p.free} Spieler ${p.n}` : ''}${peers[id]?.direct === false ? ' (Relay)' : ''}`),
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
    if (this.role !== 'host' || !g.running || g.mode !== 'battle' || g.timeLeft < 40 || !g.player.alive) return null;
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
    this.send(this.aEv, this.evQ, this.humans());
    this.evQ = [];
  }

  /** jedes Frame (läuft auch im Menü, für die Anwesenheit) */
  tick(dt: number) {
    const g = this.game;
    this.hiT -= dt;
    if (this.hiT <= 0) { this.hiT = 2; this.send(this.aHi, this.presence()); }
    if (this.role === 'host') {
      const to = this.humans();
      if (!to.length) { this.evQ = []; return; }
      this.flush();
      this.stT -= dt; this.mvT -= dt;
      if (this.stT <= 0) {
        this.stT = 1 / 15;
        const st: State = {
          left: r2(g.timeLeft),
          h: g.holes.map((h) => [r2(h.x), r2(h.z), r2(h.vx), r2(h.vz), h.level, h.xp, h.score, h.alive ? 1 : 0, h.kills]),
        };
        this.send(this.aSt, st, to);
      }
      if (this.mvT <= 0) { this.mvT = 1 / 10; this.send(this.aMv, g.world.packMovers(), to); }
    } else if (this.role === 'client') {
      this.inT -= dt;
      if (this.inT <= 0) {
        this.inT = 1 / 20;
        const p = g.player;
        this.send(this.aIn, [r2(p.x), r2(p.z), r2(p.vx), r2(p.vz)], this.host);
      }
      // Host antwortet nicht mehr (Verbindung tot, Tab eingefroren …)
      // (nur wenn die Verbindung wirklich weg ist – ein kurz eingefrorener Tab ist kein Grund)
      if (now() - this.lastSt > 4) {
        if (this.host in this.room.getPeers()) this.lastSt = now() - 2;
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
      const cands = g.holes.filter((o) => o.peer && o.alive && (o.peer === this.self || o.peer in this.room.getPeers()))
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
    this.stT = this.mvT = 0;
  }

  /** Runde verlassen (Ende, Gefressen, Beenden, Tab im Hintergrund) */
  leaveRound(final = false) {
    if (this.role === 'off') return;
    const to = this.humans();
    if (this.role === 'host') {
      if (final) this.emit(['end']);
      this.flush();
    }
    this.send(this.aBye, 1, to);
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
