import * as THREE from 'three';
import { World, MAX_HOLES, type Obj } from './world';
import { Hole } from './hole';
import { HALF } from './city';
import { Sfx } from './sfx';
import { xray } from './objects';

export const ROUND_TIME = 120;
export type Mode = 'classic' | 'battle' | 'solo';
export const MODE_NAMES: Record<Mode, string> = { classic: 'Klassik', battle: 'Battle', solo: 'Solo' };

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
export const SKINS = [0xff5caa, 0x4cc9f0, 0xffd250, 0x7bf06c, 0xb77cff, 0xff8a4c, 0xffffff];

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

  running = false;
  mode: Mode = 'classic';
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
  joy: { id: number; sx: number; sy: number; dx: number; dy: number } | null = null;
  onEnd: (r: Result) => void = () => {};
  private boardT = 0;
  private toastT = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.background = new THREE.Color(0xa7d8f5);
    this.scene.fog = new THREE.Fog(0xa7d8f5, 150, 420);
    this.scene.add(new THREE.HemisphereLight(0xdff1ff, 0x8a7a68, 1.5));
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);
    // Umland außerhalb der Karte
    const outer = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400).rotateX(-Math.PI / 2), groundMaterial(this.holeUniforms, { color: 0x7cc35d }));
    outer.position.y = -0.05;
    this.scene.add(outer);
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
  setup(playerName: string, skin: number, mode: Mode = 'classic') {
    this.mode = mode;
    if (this.world) {
      this.scene.remove(this.world.group, this.ground);
      for (const h of this.holes) h.dispose(this.scene);
      this.world.dispose();
    }
    const seed = (Math.random() * 1e9) | 0;
    this.world = new World(seed);
    this.scene.add(this.world.group);
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(HALF * 2, HALF * 2).rotateX(-Math.PI / 2), groundMaterial(this.holeUniforms, { map: this.world.groundTex }));
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.holes = [];
    const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
    const colors = SKINS.filter((c) => c !== skin).sort(() => Math.random() - 0.5);
    const n = mode === 'solo' ? 1 : MAX_HOLES;
    for (let i = 0; i < n; i++) {
      const me = i === 0;
      const h = new Hole(i, me ? playerName : names[i - 1], me ? skin : colors[(i - 1) % colors.length], me, this.world.physics, this.scene);
      h.skill = 0.82 + Math.random() * 0.18;
      const [x, z] = this.spawnPoint(h);
      h.respawn(x, z, 0);
      this.holes.push(h);
    }
    this.player = this.holes[0];
    this.timeLeft = ROUND_TIME;
    this.totalPoints = this.world.objs.reduce((a, o) => a + o.type.points, 0);
    this.eatenPoints = 0;
    this.popAcc = 0;
    this.acc = 0;
    this.camH = 36;
    this.snapCamera();
  }

  /** Spawn auf einer Straße, weit weg von großen Löchern */
  spawnPoint(self: Hole): [number, number] {
    const roads = [-96, -48, 0, 48, 96];
    let best: [number, number] = [0, 0], bestD = -1;
    for (let k = 0; k < 20; k++) {
      const along = (Math.random() * 2 - 1) * (HALF - 15);
      const c = roads[(Math.random() * roads.length) | 0];
      const p: [number, number] = Math.random() < 0.5 ? [along, c] : [c, along];
      let d = 1e9;
      for (const h of this.holes) if (h !== self && h.alive) d = Math.min(d, Math.hypot(h.x - p[0], h.z - p[1]) - h.r * 2);
      if (d > bestD) { bestD = d; best = p; }
    }
    return best;
  }

  start() {
    this.running = true;
    this.countdown = 3;
    this.sfx.resume();
    this.sfx.tick(false);
    this.showCount('3');
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
    addEventListener('blur', () => this.keys.clear());
    const cv = this.renderer.domElement;
    const joyEl = $('joy'), knob = $('knob');
    cv.addEventListener('pointerdown', (e) => {
      if (this.joy) return;
      this.joy = { id: e.pointerId, sx: e.clientX, sy: e.clientY, dx: 0, dy: 0 };
      cv.setPointerCapture(e.pointerId);
      joyEl.style.display = 'block';
      joyEl.style.left = e.clientX + 'px'; joyEl.style.top = e.clientY + 'px';
      knob.style.transform = '';
    });
    cv.addEventListener('pointermove', (e) => {
      if (!this.joy || e.pointerId !== this.joy.id) return;
      let dx = e.clientX - this.joy.sx, dy = e.clientY - this.joy.sy;
      const len = Math.hypot(dx, dy), max = 50;
      if (len > max) {
        // Joystick wandert mit, damit Richtungswechsel sofort greifen
        this.joy.sx += (dx / len) * (len - max); this.joy.sy += (dy / len) * (len - max);
        dx = (dx / len) * max; dy = (dy / len) * max;
        joyEl.style.left = this.joy.sx + 'px'; joyEl.style.top = this.joy.sy + 'px';
      }
      this.joy.dx = dx / max; this.joy.dy = dy / max;
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
    });
    const up = (e: PointerEvent) => {
      if (!this.joy || e.pointerId !== this.joy.id) return;
      this.joy = null; joyEl.style.display = 'none';
    };
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
    if (this.joy) { dx += this.joy.dx; dz += this.joy.dy; }
    // konstantes Tempo: nur die Richtung zählt (mit kleiner Totzone)
    const l = Math.hypot(dx, dz);
    if (l < 0.15) { dx = 0; dz = 0; } else { dx /= l; dz /= l; }
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
      if (o.r > h.r * 1.15 && d < o.r + 14) { fx += (h.x - o.x) / (d + 0.1); fz += (h.z - o.z) / (d + 0.1); }
    }
    if (fx || fz) { h.tx = h.x + fx * 20; h.tz = h.z + fz * 20; this.steer(h); return; }
    // 2) Beute: kleinere Löcher
    let best = 0, bx = 0, bz = 0;
    for (const o of this.holes) {
      if (o === h || !o.alive || h.r < o.r * 1.25) continue;
      const d = Math.hypot(o.x - h.x, o.z - h.z);
      // im Battle jagen Bots weiter und lieber
      const range = this.mode === 'battle' ? 70 : 30, lure = this.mode === 'battle' ? 120 : 40;
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
  private swallow(dt: number) {
    const w = this.world;
    for (const o of w.objs) {
      if (!o.alive) continue;
      const ro = o.type.ro;
      if (o.falling >= 0) {
        const h = this.holes[o.falling];
        if (!h.alive) { if (o.y < -0.5) w.remove(o); else w.deactivate(o); continue; }
        if (o.y < h.killY) { this.eat(h, o); continue; }
        // Loch ist weitergezogen und das Objekt steht noch oben -> wieder einfrieren
        const dx = o.x - h.x, dz = o.z - h.z, lim = h.r + ro + 2.5;
        if (o.y > -0.2 && dx * dx + dz * dz > lim * lim) w.deactivate(o);
        continue;
      }
      // Objekte in Lochnähe werden physikalisch; zu große bleiben liegen und überbrücken das Loch
      for (const h of this.holes) {
        if (!h.alive || ro > h.r * 1.25) continue;
        const dx = o.x - h.x, dz = o.z - h.z, lim = h.r + ro + 0.6;
        if (dx * dx + dz * dz < lim * lim) { w.activate(o, h.id); break; }
      }
    }
    // Löcher fressen Löcher
    for (const a of this.holes) {
      if (!a.alive) continue;
      for (const b of this.holes) {
        if (a === b || !b.alive || a.r < b.r * 1.2) continue;
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (d < a.r - b.r * 0.4) this.eatHole(a, b);
      }
    }
    if (this.mode === 'battle') return; // keine Wiederkehr
    for (const h of this.holes) {
      if (h.alive) continue;
      h.respawnIn -= dt;
      if (h.respawnIn <= 0 && this.timeLeft > 3) {
        const [x, z] = this.spawnPoint(h);
        h.respawn(x, z, Math.max(0, h.level - 3));
        if (h.isPlayer) this.toast('Weiter geht’s!');
      }
    }
  }

  private eat(h: Hole, o: Obj) {
    this.world.remove(o);
    const up = h.gain(o.type.points);
    this.eatenPoints += o.type.points;
    if (h.isPlayer) {
      this.popAcc += o.type.points;
      this.sfx.gulp(o.type.weight);
      if (o.type.weight >= 1.5) navigator.vibrate?.(Math.min(60, 10 * o.type.weight));
      if (up) { this.sfx.levelUp(); this.toast(`LEVEL ${h.level + 1}!`); }
    }
  }

  private eatHole(a: Hole, b: Hole) {
    b.die(a);
    b.respawnIn = 3;
    b.outAt = this.t;
    a.kills++;
    const bonus = 25 + Math.round(b.score * 0.25);
    a.gain(bonus);
    if (a.isPlayer) { this.popAcc += bonus; this.toast(`${b.name} verschlungen! 😈`); this.sfx.levelUp(); navigator.vibrate?.([30, 40, 60]); }
    if (b.isPlayer) {
      this.toast(`${a.name} hat dich gefressen!`); this.sfx.hurt(); navigator.vibrate?.(200);
      if (this.mode === 'battle') setTimeout(() => this.running && this.finish(), 1200);
    }
    if (this.mode === 'battle' && this.player.alive && this.holes.filter((h) => h.alive).length === 1) {
      this.toast('Letztes Loch! 🏆');
      setTimeout(() => this.running && this.finish(), 1200);
    }
  }

  toast(msg: string) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    this.toastT = 1.8;
  }

  // ---------------- Frame ----------------
  frame(dt: number) {
    dt = Math.min(dt, 0.1);
    this.t += dt;
    if (this.running && this.countdown > 0) {
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
      for (const h of this.holes) if (!h.isPlayer && h.alive) this.think(h, dt);
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
    for (let i = 0; i < MAX_HOLES; i++) {
      const h = this.holes[i];
      this.holeUniforms[i].set(h?.x ?? 0, h?.z ?? 0, h?.r ?? 0, h?.visible ? 1 : 0);
    }
    this.updateCamera(dt);
    this.updateXray();
    this.renderer.render(this.scene, this.camera);
    this.updateHud(dt);
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
        $('board').innerHTML = `<li class="me"><span class="n">Stadt gefressen</span><span class="s">${this.percentText()}</span></li>`;
      } else {
        $('board').innerHTML = this.ranking().map((h, i) => {
          const out = this.mode === 'battle' && !h.alive;
          return `<li class="${h.isPlayer ? 'me' : ''}${out ? ' out' : ''}"><span>${i + 1}.</span><span class="dot" style="background:#${h.color.toString(16).padStart(6, '0')}"></span><span class="n">${escapeHtml(h.name)}</span><span class="s">${out ? '💀' : h.score}</span></li>`;
        }).join('');
      }
    }
  }

  private percent() { return Math.min(1, this.eatenPoints / this.totalPoints); }
  private percentText() { return (this.percent() * 100).toFixed(1) + ' %'; }

  /** Rangliste: im Battle zuerst die Überlebenden, dann die Ausgeschiedenen (zuletzt gefressen zuerst) */
  ranking() {
    if (this.mode !== 'battle') return [...this.holes].sort((a, b) => b.score - a.score);
    return [...this.holes].sort((a, b) =>
      a.alive !== b.alive ? (a.alive ? -1 : 1) : a.alive ? b.score - a.score : b.outAt - a.outAt);
  }

  private finish() {
    this.running = false;
    this.joy = null;
    $('joy').style.display = 'none';
    $('count').classList.remove('go');
    const table = this.ranking();
    const rank = table.indexOf(this.player) + 1;
    this.sfx.end(this.mode === 'solo' ? this.percent() > 0.1 : rank === 1);
    this.onEnd({ mode: this.mode, rank, score: this.player.score, percent: this.percent(), table, eliminated: !this.player.alive });
  }
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

