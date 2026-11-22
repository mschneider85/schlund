import * as THREE from 'three';
import { World, MAX_HOLES, type Obj } from './world';
import { Hole, cleanName, cleanColor } from './hole';
import { HALF, ROADS } from './city';
import { Sfx } from './sfx';
import { xray } from './objects';
import { SKINS, STAR_STEPS, starsFor, escapeHtml, type Mode } from './config';
import type { Net, Welcome, Ev, State } from './net';

export const ROUND_TIME = 120;

export interface Result {
  mode: Mode;
  rank: number;
  score: number;
  /** Solo: Anteil der gefressenen Stadt (0..1) */
  percent: number;
  table: Hole[];
  eliminated: boolean;
}
const BOT_NAMES = ['Gulpi', 'NomNom', 'Krater', 'Vortex', 'Mampfred', 'Abgrund', 'Strudel', 'Bodenlos', 'Schlucki', 'Tiefgang', 'Blackie', 'Gully'];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Bodenmaterial: Fragmente innerhalb eines Lochs werden verworfen (discard) – das eigentliche "Loch". */
function groundMaterial(holes: THREE.Vector4[], params: THREE.MeshLambertMaterialParameters) {
  const m = new THREE.MeshLambertMaterial(params);
  m.onBeforeCompile = (s) => {
    s.uniforms.uHoles = { value: holes };
    s.vertexShader = 'varying vec3 vWPos;\n' + s.vertexShader.replace('#include <project_vertex>',
      '#include <project_vertex>\n vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    s.fragmentShader = `uniform vec4 uHoles[${MAX_HOLES}];\nvarying vec3 vWPos;\n` + s.fragmentShader.replace('#include <dithering_fragment>', `
      #include <dithering_fragment>
      float shade = 1.0;
      for (int i = 0; i < ${MAX_HOLES}; i++) {
        vec4 h = uHoles[i];
        if (h.w < 0.5) continue;
        float d = distance(vWPos.xz, h.xy);
        if (d < h.z) discard;
        shade = min(shade, mix(0.55, 1.0, smoothstep(h.z, h.z * 1.18 + 0.15, d)));
      }
      gl_FragColor.rgb *= shade;`);
  };
  return m;
}

export class Game {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(30, 1, 1, 1200);
  sun = new THREE.DirectionalLight(0xffffff, 2.2);
  world!: World;
  holes: Hole[] = [];
  player!: Hole;
  ground!: THREE.Mesh;
  holeUniforms = Array.from({ length: MAX_HOLES }, () => new THREE.Vector4());
  sfx = new Sfx();
  /** Mehrspieler (null, solange nicht geladen) */
  net: Net | null = null;
  /** Pausenmenü offen – online läuft das Spiel dabei weiter */
  menuPaused = false;

  running = false;
  paused = false;
  mode: Mode = 'battle';
  /** wie viel größer ein Loch sein muss, um ein anderes zu fressen */
  readonly eatRatio = 1.1;
  /** Sekunden bis zum Start (3-2-1) */
  countdown = 0;
  timeLeft = ROUND_TIME;
  totalPoints = 1;
  eatenPoints = 0;
  private popAcc = 0;
  private popT = 0;
  acc = 0;
  t = 0;
  camH = 20;
  // Eingabe
  keys = new Set<string>();
  /** aktiver Zeiger: Touch = Wischen relativ zum (mitwandernden) Ankerpunkt, Maus = zum Zeiger hin */
  ptr: { id: number; touch: boolean; ax: number; ay: number; x: number; y: number } | null = null;
  onEnd: (r: Result) => void = () => {};
  private boardT = 0;
  private toastT = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.background = new THREE.Color(0x8fcbef);
    this.scene.fog = new THREE.Fog(0x8fcbef, 150, 420);
    this.scene.add(new THREE.HemisphereLight(0xdff1ff, 0x8a7a68, 1.5));
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);
    // Die Stadt ist eine Insel: Wasser ringsum (mit Loch-Ausschnitt, falls es unter der Karte sichtbar wäre)
    const water = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400).rotateX(-Math.PI / 2),
      groundMaterial(this.holeUniforms, { color: 0x3f9fd8 }));
    water.position.y = -1.2;
    this.scene.add(water);
    // Kaimauer an der Inselkante
    const quayMat = new THREE.MeshLambertMaterial({ color: 0xcfc6b4 });
    const capMat = new THREE.MeshLambertMaterial({ color: 0xe9e2d2 });
    for (const [x, z, w, d] of [[0, -HALF, HALF * 2 + 1.2, 0.6], [0, HALF, HALF * 2 + 1.2, 0.6], [-HALF, 0, 0.6, HALF * 2], [HALF, 0, 0.6, HALF * 2]]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 1.5, d), quayMat);
      wall.position.set(x, -0.74, z);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.2, 0.25, d + 0.2), capMat);
      cap.position.set(x, 0.1, z);
      cap.castShadow = true;
      this.scene.add(wall, cap);
    }
    // ein paar Wellen-Glanzlichter auf dem Wasser
    const glint = new THREE.MeshBasicMaterial({ color: 0x9fd6f5, transparent: true, opacity: 0.6 });
    const gGeo = new THREE.PlaneGeometry(3, 0.25).rotateX(-Math.PI / 2);
    for (let i = 0; i < 160; i++) {
      const a = Math.random() * Math.PI * 2, r = HALF + 6 + Math.random() * 160;
      const m = new THREE.Mesh(gGeo, glint);
      m.position.set(Math.cos(a) * r * 1.1, -1.18, Math.sin(a) * r * 1.1);
      if (Math.abs(m.position.x) < HALF + 3 && Math.abs(m.position.z) < HALF + 3) continue;
      m.scale.x = 0.5 + Math.random();
      this.scene.add(m);
    }
    addEventListener('resize', () => this.resize());
    this.resize();
    this.bindInput();
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Neue Runde: Stadt, Physik und Löcher neu aufbauen */
  setup(playerName: string, mode: Mode = 'battle', w?: Welcome) {
    this.mode = mode;
    this.menuPaused = false;
    if (this.world) {
      this.scene.remove(this.world.group, this.ground);
      for (const h of this.holes) h.dispose(this.scene);
      this.world.dispose();
    }
    const seed = w ? w.seed : (Math.random() * 1e9) | 0;
    this.world = new World(seed);
    this.scene.add(this.world.group);
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(HALF * 2, HALF * 2).rotateX(-Math.PI / 2), groundMaterial(this.holeUniforms, { map: this.world.groundTex }));
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.holes = [];
    this.timeLeft = ROUND_TIME;
    this.totalPoints = this.world.objs.reduce((a, o) => a + o.type.points, 0);
    this.eatenPoints = 0;
    if (w) {
      // Einstieg in eine laufende Runde eines anderen Spielers
      w.holes.forEach((info, i) => {
        const me = i === w.slot;
        const h = new Hole(i, cleanName(info.name), cleanColor(info.color), me, this.world.physics, this.scene);
        h.ctrl = me ? 'local' : 'net';
        h.peer = typeof info.peer === 'string' ? info.peer : null;
        h.setStats(info.level, info.xp, info.score, info.kills);
        h.respawn(Number(info.x) || 0, Number(info.z) || 0, h.level);
        h.setStats(info.level, info.xp, info.score, info.kills);
        h.setNet(info.x, info.z, 0, 0, performance.now() / 1000);
        if (!info.alive) { h.die(); h.outAt = -1; }
        this.holes.push(h);
      });
      this.player = this.holes[w.slot];
      this.timeLeft = Math.min(ROUND_TIME, Number(w.left) || 0);
      const bin = Uint8Array.from(atob(w.dead), (c) => c.charCodeAt(0));
      this.eatenPoints = this.world.applyDeadMask(bin);
    }
    const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
    // Farben je Match zufällig und alle verschieden
    const colors = [...SKINS].sort(() => Math.random() - 0.5);
    const n = w ? 0 : mode === 'solo' ? 1 : MAX_HOLES;
    for (let i = 0; i < n; i++) {
      const me = i === 0;
      const h = new Hole(i, me ? playerName : names[i - 1], colors[i % colors.length], me, this.world.physics, this.scene);
      // gestreute Bot-Stärke -> Größenunterschiede -> Duelle
      h.skill = 0.68 + Math.random() * 0.32;
      const [x, z] = this.spawnPoint(h);
      h.respawn(x, z, 0);
      this.holes.push(h);
    }
    if (!w) this.player = this.holes[0];
    this.popAcc = 0;
    this.acc = 0;
    this.camH = 36;
    this.snapCamera();
  }

  /** Spawn auf einer Straße, weit weg von großen Löchern */
  spawnPoint(self: Hole): [number, number] {
    const roads = ROADS;
    let best: [number, number] = [0, 0], bestD = -1;
    for (let k = 0; k < 20; k++) {
      const along = (Math.random() * 2 - 1) * (HALF - 10);
      const c = roads[(Math.random() * roads.length) | 0];
      const p: [number, number] = Math.random() < 0.5 ? [along, c] : [c, along];
      let d = 1e9;
      for (const h of this.holes) if (h !== self && h.alive) d = Math.min(d, Math.hypot(h.x - p[0], h.z - p[1]) - h.r * 2);
      if (d > bestD) { bestD = d; best = p; }
    }
    return best;
  }

  start(cd = 3) {
    this.running = true;
    this.countdown = cd;
    this.sfx.resume();
    this.sfx.tick(false);
    this.showCount(String(Math.ceil(cd)));
  }

  private showCount(txt: string) {
    const el = $('count');
    el.textContent = txt;
    el.classList.remove('go');
    void el.offsetWidth; // Animation neu starten
    el.classList.add('go');
  }

  // ---------------- Eingabe ----------------
  private bindInput() {
    addEventListener('keydown', (e) => this.keys.add(e.key.toLowerCase()));
    addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    addEventListener('blur', () => { this.keys.clear(); this.ptr = null; });
    const cv = this.renderer.domElement;
    cv.addEventListener('pointerdown', (e) => {
      if (this.ptr) return;
      this.ptr = { id: e.pointerId, touch: e.pointerType !== 'mouse', ax: e.clientX, ay: e.clientY, x: e.clientX, y: e.clientY };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      const p = this.ptr;
      if (!p || e.pointerId !== p.id) return;
      p.x = e.clientX; p.y = e.clientY;
      if (p.touch) {
        // Anker zieht hinterher -> Richtungswechsel greifen sofort, ohne weit zurückwischen zu müssen
        const dx = p.x - p.ax, dy = p.y - p.ay, len = Math.hypot(dx, dy), max = 24;
        if (len > max) { p.ax += (dx / len) * (len - max); p.ay += (dy / len) * (len - max); }
      }
    });
    const up = (e: PointerEvent) => { if (this.ptr && e.pointerId === this.ptr.id) this.ptr = null; };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
  }

  private readInput() {
    let dx = 0, dz = 0;
    const k = this.keys;
    if (k.has('w') || k.has('arrowup')) dz -= 1;
    if (k.has('s') || k.has('arrowdown')) dz += 1;
    if (k.has('a') || k.has('arrowleft')) dx -= 1;
    if (k.has('d') || k.has('arrowright')) dx += 1;
    const p = this.ptr;
    let dead = 0.15;
    if (p && p.touch) {
      dx += p.x - p.ax; dz += p.y - p.ay; dead = 8; // Pixel
    } else if (p) {
      // Maus: Richtung vom Loch (auf dem Bildschirm) zum Zeiger, Stillstand über dem Loch
      const h = this.player;
      this._v.set(h.x, 0, h.z).project(this.camera);
      const sx = (this._v.x * 0.5 + 0.5) * innerWidth, sy = (-this._v.y * 0.5 + 0.5) * innerHeight;
      this._v.set(h.x + h.r, 0, h.z).project(this.camera);
      const rpx = Math.abs((this._v.x * 0.5 + 0.5) * innerWidth - sx);
      dx += p.x - sx; dz += p.y - sy; dead = Math.max(12, rpx * 0.5);
    }
    // konstantes Tempo: nur die Richtung zählt
    const l = Math.hypot(dx, dz);
    if (l < dead || this.menuPaused) { dx = 0; dz = 0; } else { dx /= l; dz /= l; }
    this.player.dirX = dx; this.player.dirZ = dz;
  }

  // ---------------- KI ----------------
  private think(h: Hole, dt: number) {
    h.aiT -= dt;
    if (h.aiT > 0) { this.steer(h); return; }
    h.aiT = 0.35 + Math.random() * 0.2;
    // 1) Gefahr: größere Löcher in der Nähe -> fliehen
    let fx = 0, fz = 0;
    for (const o of this.holes) {
      if (o === h || !o.alive) continue;
      const d = Math.hypot(o.x - h.x, o.z - h.z);
      if (o.r > h.r * this.eatRatio * 0.95 && d < o.r + 14) { fx += (h.x - o.x) / (d + 0.1); fz += (h.z - o.z) / (d + 0.1); }
    }
    if (fx || fz) { h.tx = h.x + fx * 20; h.tz = h.z + fz * 20; this.steer(h); return; }
    // 2) Beute: kleinere Löcher
    let best = 0, bx = 0, bz = 0;
    for (const o of this.holes) {
      if (o === h || !o.alive || h.r < o.r * (this.eatRatio + 0.05)) continue;
      const d = Math.hypot(o.x - h.x, o.z - h.z);
      // Bots jagen weit und gern
      const range = 70, lure = 120;
      if (d < range) { const v = (lure + o.score * 0.3) / (d + 3); if (v > best) { best = v; bx = o.x; bz = o.z; } }
    }
    // 3) Futter: das lohnendste erreichbare Objekt
    const maxRo = h.r * 0.9, R = 26 + h.r * 3;
    let target: Obj | null = null;
    for (const o of this.world.objs) {
      if (!o.alive || o.type.ro > maxRo || (o.falling >= 0 && o.falling !== h.id)) continue;
      const ig = h.aiIgnore.get(o);
      if (ig !== undefined && ig > this.t) continue;
      const dx = o.x - h.x, dz = o.z - h.z;
      if (Math.abs(dx) > R || Math.abs(dz) > R) continue;
      const v = o.type.points / (Math.hypot(dx, dz) + 2.5);
      if (v > best) { best = v; bx = o.x; bz = o.z; target = o; }
    }
    // hängt das Ziel zu lange (z. B. quer über dem Loch), eine Weile ignorieren
    if (target !== h.aiTarget) { h.aiTarget = target; h.aiSince = this.t; }
    else if (target && this.t - h.aiSince > 2.5) { h.aiIgnore.set(target, this.t + 8); h.aiTarget = null; }
    if (best > 0) { h.tx = bx; h.tz = bz; }
    else if (Math.hypot(h.tx - h.x, h.tz - h.z) < 3) { h.tx = (Math.random() * 2 - 1) * HALF * 0.8; h.tz = (Math.random() * 2 - 1) * HALF * 0.8; }
    this.steer(h);
  }

  private steer(h: Hole) {
    const dx = h.tx - h.x, dz = h.tz - h.z, d = Math.hypot(dx, dz);
    if (d < 0.3) { h.dirX = h.dirZ = 0; return; }
    const s = Math.min(1, d / 2) * h.skill;
    h.dirX = (dx / d) * s; h.dirZ = (dz / d) * s;
  }

  // ---------------- Spiellogik ----------------
  /** auth = dieses Gerät entscheidet (offline/Host). Als Client nur Optik: Punkte kommen vom Host. */
  private swallow(dt: number, auth = true) {
    const w = this.world;
    for (const o of w.objs) {
      if (!o.alive) continue;
      const ro = o.type.ro;
      if (o.falling >= 0) {
        const h = this.holes[o.falling];
        if (!h.alive) { if (o.y < -0.5) w.remove(o); else w.deactivate(o); continue; }
        if (o.y < h.killY) { if (auth) this.eat(h, o); else w.remove(o); continue; }
        // Loch ist weitergezogen und das Objekt steht noch oben -> wieder einfrieren
        const dx = o.x - h.x, dz = o.z - h.z, lim = h.r + ro + 2.5;
        if (o.y > -0.2 && dx * dx + dz * dz > lim * lim) w.deactivate(o);
        continue;
      }
      // Objekte in Lochnähe werden physikalisch. Zu große (bis 2,2× Radius) erst, wenn sie übers Loch
      // ragen: sie kippeln, verkeilen sich und fallen, sobald das Loch groß genug ist.
      // Alles andere in Lochnähe wird ein festes Hindernis, damit Fallendes nicht hindurchrutscht.
      let near = false, act = false;
      for (const h of this.holes) {
        if (!h.alive) continue;
        const dx = o.x - h.x, dz = o.z - h.z, d2 = dx * dx + dz * dz;
        if (ro <= h.r * 2.2) {
          const lim = ro > h.r * 1.25 ? h.r + ro * 0.35 : h.r + ro + 0.6;
          if (d2 < lim * lim) { w.activate(o, h.id); act = true; break; }
        }
        const nl = h.r * 1.3 + ro + 4;
        if (d2 < nl * nl) near = true;
      }
      if (!act) w.setNear(o, near);
    }
    if (!auth) return;
    // Löcher fressen Löcher
    for (const a of this.holes) {
      if (!a.alive) continue;
      for (const b of this.holes) {
        if (a === b || !b.alive || a.r < b.r * this.eatRatio) continue;
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (d < a.r - b.r * 0.4) this.eatHole(a, b);
      }
    }
    if (this.running) return; // im Spiel kein Comeback – nur die Menü-Demo füllt nach
    for (const h of this.holes) {
      if (h.alive || h.isPlayer) continue;
      h.respawnIn -= dt;
      if (h.respawnIn <= 0 && this.timeLeft > 3) {
        const [x, z] = this.spawnPoint(h);
        h.respawn(x, z, Math.max(0, h.level - 3));
      }
    }
  }

  private eat(h: Hole, o: Obj) {
    this.world.remove(o);
    const up = h.gain(o.type.points);
    this.net?.emit(['e', o.idx, h.id, o.type.points]);
    this.eaten(h, o, o.type.points);
    if (up && h.isPlayer) this.levelUpFx(h);
  }

  /** Rückmeldung fürs Fressen (lokal entschieden oder vom Host gemeldet) */
  private eaten(h: Hole, o: Obj, pts: number) {
    this.eatenPoints += pts;
    if (h.isPlayer) {
      this.popAcc += pts;
      this.sfx.gulp(o.type.weight);
      if (o.type.weight >= 1.5) navigator.vibrate?.(Math.min(60, 10 * o.type.weight));
    }
  }

  private levelUpFx(h: Hole) { this.sfx.levelUp(); this.toast(`LEVEL ${h.level + 1}!`); }

  private eatHole(a: Hole, b: Hole, auth = true) {
    b.die(a);
    b.respawnIn = 3;
    b.outAt = this.t;
    if (auth) {
      a.kills++;
      const bonus = 25 + Math.round(b.score * 0.25);
      a.gain(bonus);
      this.net?.emit(['k', a.id, b.id]);
      if (a.isPlayer) this.popAcc += bonus;
    }
    if (a.isPlayer) { this.toast(`${b.name} verschlungen! 😈`); this.sfx.levelUp(); navigator.vibrate?.([30, 40, 60]); }
    if (b.isPlayer) {
      this.toast(`${a.name} hat dich gefressen!`); this.sfx.hurt(); navigator.vibrate?.(200);
      setTimeout(() => this.running && this.finish(), 1200);
    }
    if (this.running && this.player.alive && this.holes.filter((h) => h.alive).length === 1) {
      this.toast('Letztes Loch! 🏆');
      setTimeout(() => this.running && this.finish(), 1200);
    }
  }

  // ---------------- Netz (Client) ----------------
  applyNetState(s: State) {
    const now = performance.now() / 1000;
    this.timeLeft = Math.min(ROUND_TIME, Number(s.left) || 0);
    if (!Array.isArray(s.h)) return;
    s.h.forEach((d, i) => {
      const h = this.holes[i];
      if (!h || !Array.isArray(d)) return;
      if (!h.isPlayer) h.setNet(d[0], d[1], d[2], d[3], now);
      const before = h.level;
      h.setStats(d[4], d[5], d[6], d[8]);
      if (h.isPlayer && h.level > before) this.levelUpFx(h);
      if (!d[7] && h.alive) {
        h.die(); h.outAt = this.t;
        if (h.isPlayer) setTimeout(() => this.running && this.finish(), 1200);
      }
    });
  }

  applyNetEvent(e: Ev) {
    switch (e[0]) {
      case 'e': {
        const o = this.world.objs[e[1]], h = this.holes[e[2]];
        if (!o || !h) return;
        if (o.alive) this.world.remove(o);
        this.eaten(h, o, Math.max(0, Math.min(1e5, Number(e[3]) || 0)));
        break;
      }
      case 'k': {
        const a = this.holes[e[1]], b = this.holes[e[2]];
        if (a && b && b.alive) this.eatHole(a, b, false);
        break;
      }
      case 'id': {
        const h = this.holes[e[1]];
        if (!h) return;
        h.setIdentity(e[2], e[3]);
        h.peer = typeof e[4] === 'string' ? e[4] : null;
        break;
      }
      case 'end': if (this.running) this.finish(); break;
    }
  }

  toast(msg: string) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    this.toastT = 1.8;
  }

  // ---------------- Frame ----------------
  /** Hintergrund-Demo fürs Menü: Bots spielen, kein Spieler */
  demo() {
    this.net?.leaveRound();
    this.running = false;
    this.paused = false;
    this.setup('');
    this.player.die();
  }

  setPaused(p: boolean) {
    if (!this.running) p = false;
    this.menuPaused = p;
    // online lässt sich die Welt nicht anhalten – nur die eigene Eingabe ruht
    this.paused = p && !this.net?.online;
    this.ptr = null;
    this.keys.clear();
  }

  frame(dt: number) {
    dt = Math.min(dt, 0.1);
    this.net?.tick(dt);
    if (this.paused) { this.renderer.render(this.scene, this.camera); return; }
    this.t += dt;
    if (this.running && this.net?.role === 'client') {
      this.clientFrame(dt);
    } else if (this.running && this.countdown > 0) {
      const before = Math.ceil(this.countdown);
      this.countdown -= dt;
      const now = Math.ceil(this.countdown);
      if (now !== before) {
        if (now > 0) { this.showCount(String(now)); this.sfx.tick(false); }
        else { this.showCount('LOS!'); this.sfx.tick(true); }
      }
      for (const h of this.holes) h.update(dt, HALF, true);
      this.world.updateMovers(dt, this.t);
      this.world.sync();
    } else if (this.running) {
      this.timeLeft -= dt;
      this.readInput();
      for (const h of this.holes) if (h.ctrl === 'ai' && h.alive) this.think(h, dt);
      for (const h of this.holes) h.update(dt, HALF);
      this.world.updateMovers(dt, this.t);
      // Physik mit festem Zeitschritt
      this.acc += dt;
      let steps = 0;
      while (this.acc >= 1 / 60 && steps < 4) {
        this.world.suction(this.holes, 1 / 60);
        this.world.physics.step(); this.acc -= 1 / 60; steps++;
      }
      if (steps === 4) this.acc = 0;
      this.world.sync();
      this.swallow(dt);
      if (this.timeLeft <= 0) this.finish();
    } else if (this.world) {
      // Menü-Hintergrund: Bots spielen weiter, langsamer Kameraschwenk
      for (const h of this.holes) { if (!h.isPlayer && h.alive) this.think(h, dt); h.update(dt, HALF); }
      this.world.updateMovers(dt, this.t);
      this.world.suction(this.holes, 1 / 60);
      this.world.physics.step();
      this.world.sync();
      this.swallow(dt);
    }
    if (!this.world) return;
    // Krone für das größte Loch (nur mit Gegnern)
    let leader: Hole | null = null;
    for (const h of this.holes) if (h.alive && this.holes.length > 1 && (!leader || h.size > leader.size)) leader = h;
    for (const h of this.holes) h.setCrown(h === leader);
    // Gefahr/Beute relativ zum Spieler markieren
    const pl = this.player;
    for (const h of this.holes) {
      if (h === pl) continue;
      h.threat = !pl.alive || !this.running ? 0 : h.r >= pl.r * this.eatRatio ? 1 : pl.r >= h.r * this.eatRatio ? -1 : 0;
    }
    for (let i = 0; i < MAX_HOLES; i++) {
      const h = this.holes[i];
      this.holeUniforms[i].set(h?.x ?? 0, h?.z ?? 0, h?.r ?? 0, h?.visible ? 1 : 0);
    }
    this.updateCamera(dt);
    this.updateXray();
    this.renderer.render(this.scene, this.camera);
    this.updateHud(dt);
  }

  /** Client: eigenes Loch lokal, alles andere folgt dem Host; Physik nur für die Optik */
  private clientFrame(dt: number) {
    if (this.countdown > 0) {
      const before = Math.ceil(this.countdown);
      this.countdown -= dt;
      const now = Math.ceil(this.countdown);
      if (now !== before) {
        if (now > 0) { this.showCount(String(now)); this.sfx.tick(false); }
        else { this.showCount('LOS!'); this.sfx.tick(true); }
      }
      this.player.dirX = this.player.dirZ = 0;
    } else this.readInput();
    this.timeLeft -= dt;
    for (const h of this.holes) h.update(dt, HALF);
    this.world.stepNetMovers(dt, this.t, performance.now() / 1000);
    this.acc += dt;
    let steps = 0;
    while (this.acc >= 1 / 60 && steps < 4) {
      this.world.suction(this.holes, 1 / 60);
      this.world.physics.step(); this.acc -= 1 / 60; steps++;
    }
    if (steps === 4) this.acc = 0;
    this.world.sync();
    this.swallow(dt, false);
    // Host meldet das Ende; falls er dabei verloren ging, nicht ewig weiterlaufen
    if (this.timeLeft < -3) this.finish();
  }

  private snapCamera() { this.updateCamera(1, true); }

  private updateCamera(dt: number, snap = false) {
    const p = this.player;
    // Zoomstufen: Kamera folgt dem Level, mit weicher Fahrt
    const targetH = 36 + p.targetR * 9;
    this.camH += (targetH - this.camH) * (snap ? 1 : 1 - Math.exp(-dt * 1.6));
    // Hochformat: weiter rauszoomen
    const aspectBoost = this.camera.aspect < 1 ? 1.35 : 1;
    const H = this.camH * aspectBoost;
    const tx = p.x + p.vx * 0.25, tz = p.z + p.vz * 0.25;
    const k = snap ? 1 : 1 - Math.exp(-dt * 6);
    const c = this.camera.position;
    c.x += (tx - c.x) * k;
    c.z += (tz + H * 0.42 - c.z) * k;
    c.y += (H - c.y) * k;
    this.camera.lookAt(c.x, 0, c.z - H * 0.42);
    // Sonne + Schatten folgen
    const s = this.sun, ext = 12 + H * 0.55;
    s.target.position.set(c.x, 0, c.z - H * 0.42);
    s.position.set(s.target.position.x - 50, 120, s.target.position.z + 40);
    const sc = s.shadow.camera;
    if (sc.right !== ext) {
      sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.near = 1; sc.far = 320;
      sc.updateProjectionMatrix();
    }
    const fog = this.scene.fog as THREE.Fog;
    fog.near = H * 3; fog.far = H * 6 + 120;
  }

  private _v = new THREE.Vector3();
  private updateXray() {
    const p = this.player;
    if (!p.alive || !this.running) { xray.value.z = 0; return; }
    const pr = this.renderer.getPixelRatio(), w = innerWidth * pr, h = innerHeight * pr;
    this._v.set(p.x, 0, p.z).project(this.camera);
    const sx = (this._v.x * 0.5 + 0.5) * w, sy = (this._v.y * 0.5 + 0.5) * h;
    this._v.set(p.x + p.r * 1.8 + 1.5, 0, p.z).project(this.camera);
    xray.value.set(sx, sy, Math.abs((this._v.x * 0.5 + 0.5) * w - sx));
  }

  private updateHud(dt: number) {
    // Namensschilder
    const w = innerWidth, hgt = innerHeight;
    for (const h of this.holes) {
      if (!h.alive) continue;
      this._v.set(h.x, 0, h.z - h.r - 0.4).project(this.camera);
      const x = (this._v.x * 0.5 + 0.5) * w, y = (-this._v.y * 0.5 + 0.5) * hgt;
      h.label.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
    }
    if (this.toastT > 0) { this.toastT -= dt; if (this.toastT <= 0) $('toast').classList.remove('show'); }
    if (!this.running) return;
    // Punkte-Popups über dem eigenen Loch (gesammelt, damit es nicht flackert)
    this.popT -= dt;
    if (this.popAcc > 0 && this.popT <= 0 && this.player.visible) {
      this.popT = 0.3;
      const p = this.player;
      this._v.set(p.x, 0, p.z - p.r * 0.6).project(this.camera);
      const el = document.createElement('div');
      el.className = 'pop' + (this.popAcc >= 50 ? ' big' : '');
      el.textContent = '+' + this.popAcc;
      el.style.left = `${(this._v.x * 0.5 + 0.5) * w + (Math.random() - 0.5) * 40}px`;
      el.style.top = `${(-this._v.y * 0.5 + 0.5) * hgt}px`;
      $('labels').appendChild(el);
      setTimeout(() => el.remove(), 900);
      this.popAcc = 0;
    }
    const t = Math.max(0, Math.ceil(this.timeLeft));
    const timer = $('timer');
    timer.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    timer.classList.toggle('hurry', t <= 10);
    const p = this.player;
    $('levelnum').textContent = `Level ${p.level + 1}`;
    $('levelfill').style.width = `${(p.progress * 100).toFixed(1)}%`;
    this.boardT -= dt;
    if (this.boardT <= 0) {
      this.boardT = 0.25;
      if (this.mode === 'solo') {
        const pc = this.percent();
        $('soloval').textContent = this.percentText();
        $('solofill').style.width = `${Math.min(100, pc * 100 / STAR_STEPS[2]).toFixed(1)}%`;
        const n = starsFor(pc);
        document.querySelectorAll('#solostars span').forEach((el, i) => el.classList.toggle('on', i < n));
      } else {
        // schmale Bildschirme: nur Top 3 + eigene Zeile
        const compact = innerWidth < 600;
        $('board').innerHTML = this.ranking().map((h, i) => {
          if (compact && i >= 3 && !h.isPlayer) return '';
          const out = !h.alive;
          return `<li class="${h.isPlayer ? 'me' : ''}${out ? ' out' : ''}"><span>${i + 1}.</span><span class="dot" style="background:#${h.color.toString(16).padStart(6, '0')}"></span><span class="n">${escapeHtml(h.name)}</span><span class="s">${out ? '💀' : 'Lv ' + (h.level + 1)}</span></li>`;
        }).join('');
      }
    }
  }

  private percent() { return Math.min(1, this.eatenPoints / this.totalPoints); }
  private percentText() { return (this.percent() * 100).toFixed(1) + ' %'; }

  /** Rangliste nach Lochgröße: zuerst die Überlebenden, dann die Ausgeschiedenen (zuletzt gefressen zuerst) */
  ranking() {
    return [...this.holes].sort((a, b) =>
      a.alive !== b.alive ? (a.alive ? -1 : 1) : a.alive ? (b.size - a.size || b.score - a.score) : b.outAt - a.outAt);
  }

  private finish() {
    this.net?.leaveRound(this.timeLeft <= 0.5);
    this.running = false;
    this.ptr = null;
    $('count').classList.remove('go');
    const table = this.ranking();
    const rank = table.indexOf(this.player) + 1;
    this.sfx.end(this.mode === 'solo' ? this.percent() > 0.1 : rank === 1);
    this.onEnd({ mode: this.mode, rank, score: this.player.score, percent: this.percent(), table, eliminated: !this.player.alive });
  }
}


