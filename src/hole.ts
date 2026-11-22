import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-simd';
import { gFall, gPit, groups } from './world';

/** XP, die für den nächsten Level nötig sind */
export const xpNext = (lvl: number) => Math.round(4 * Math.pow(1.48, lvl));
export const radiusFor = (lvl: number) => 1.15 * Math.pow(1.22, lvl);
export const MAX_LEVEL = 16;

// Werte aus dem Netz nie ungeprüft übernehmen (landen u. a. im HTML der Rangliste)
const num = (v: unknown, lo: number, hi: number) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo; };
export const cleanName = (v: unknown) => String(v ?? '').slice(0, 16) || 'Spieler';
export const cleanColor = (v: unknown) => (Number(v) & 0xffffff) >>> 0;

const pitGeo = new THREE.CylinderGeometry(1, 1, 1, 56, 1, false).translate(0, -0.5, 0);
const pitMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  vertexShader: `varying float vY; void main(){ vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `varying float vY; void main(){
    float t = smoothstep(-0.55, 0.0, vY);
    gl_FragColor = vec4(mix(vec3(0.0), vec3(0.11, 0.09, 0.17), t*t), 1.0);
  }`,
});
const rimGeo = new THREE.RingGeometry(1, 1.06, 72).rotateX(-Math.PI / 2);
const threatGeo = new THREE.RingGeometry(1.1, 1.24, 72).rotateX(-Math.PI / 2);
const progGeo = new THREE.RingGeometry(1.1, 1.2, 96).rotateX(-Math.PI / 2);
// Richtungspfeil (Chevron), zeigt in Ruhelage nach -z
const arrowShape = new THREE.Shape();
arrowShape.moveTo(0, 1); arrowShape.lineTo(-0.9, -0.35); arrowShape.lineTo(0, 0.05); arrowShape.lineTo(0.9, -0.35); arrowShape.closePath();
const arrowGeo = new THREE.ShapeGeometry(arrowShape).rotateX(-Math.PI / 2);

export class Hole {
  x = 0; z = 0; vx = 0; vz = 0;
  /** gewünschte Richtung (Länge 0..1) */
  dirX = 0; dirZ = 0;
  level = 0; xp = 0; score = 0;
  r = radiusFor(0);
  alive = true;
  respawnIn = 0;
  kills = 0;
  /** Battle-Modus: endgültig ausgeschieden (Zeitpunkt für die Rangliste) */
  outAt = 0;
  /** Puls-Animation beim Levelaufstieg */
  pulse = 0;
  /** wird gerade von einem anderen Loch eingesaugt */
  private suckBy: Hole | null = null;
  private suckT = 0;
  // Physik
  private body: RAPIER.RigidBody;
  private walls: RAPIER.Collider[] = [];
  private builtR = 0;
  // Darstellung
  group = new THREE.Group();
  private pit: THREE.Mesh;
  private rim: THREE.Mesh;
  private prog?: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private arrow?: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private arrowA = 0;
  /** Markierung gegenüber dem Spieler: 1 = gefährlich (rot), -1 = Beute (grün), 0 = neutral */
  threat = 0;
  private threatRing?: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private t = 0;
  label: HTMLDivElement;
  /** wer steuert: eigenes Gerät, KI oder Netz (Position kommt von einem anderen Spieler/Host) */
  ctrl: 'local' | 'ai' | 'net';
  /** Peer-ID des menschlichen Spielers (null = Bot) */
  peer: string | null = null;
  /** letzte Netzposition */
  private net = { x: 0, z: 0, vx: 0, vz: 0, at: 0 };
  // KI
  aiT = 0; tx = 0; tz = 0; skill = 1;
  /** aktuelles Futter-Ziel + seit wann; Ziele, die nicht hineinfallen, werden eine Weile ignoriert */
  aiTarget: object | null = null; aiSince = 0;
  aiIgnore = new Map<object, number>();

  constructor(
    public id: number, public name: string, public color: number, public isPlayer: boolean,
    private physics: RAPIER.World, scene: THREE.Scene,
  ) {
    this.ctrl = isPlayer ? 'local' : 'ai';
    this.body = physics.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    this.pit = new THREE.Mesh(pitGeo, pitMat);
    this.rim = new THREE.Mesh(rimGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }));
    this.rim.position.y = 0.03;
    this.group.add(this.pit, this.rim);
    if (isPlayer) {
      const c = new THREE.Color(color);
      this.prog = new THREE.Mesh(progGeo, new THREE.ShaderMaterial({
        transparent: true, depthWrite: false,
        uniforms: { uP: { value: 0 }, uC: { value: c } },
        vertexShader: `varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `uniform float uP; uniform vec3 uC; varying vec2 vP; void main(){
          float a = fract(atan(vP.x, -vP.y) / 6.2831853 + 1.0);
          if (a > uP) gl_FragColor = vec4(1.0, 1.0, 1.0, 0.25);
          else gl_FragColor = vec4(mix(uC, vec3(1.0), 0.25), 0.95);
        }`,
      }));
      this.prog.position.y = 0.04;
      this.arrow = new THREE.Mesh(arrowGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
      this.arrow.position.y = 0.06;
      this.group.add(this.prog, this.arrow);
    }
    if (!isPlayer) {
      this.threatRing = new THREE.Mesh(threatGeo, new THREE.MeshBasicMaterial({ color: 0xff3b3b, transparent: true, opacity: 0, depthWrite: false }));
      this.threatRing.position.y = 0.05;
      this.group.add(this.threatRing);
    }
    scene.add(this.group);
    this.label = document.createElement('div');
    this.label.className = 'label' + (isPlayer ? ' me' : '');
    this.label.textContent = name;
    this.label.style.color = '#' + new THREE.Color(color).getHexString();
    document.getElementById('labels')!.appendChild(this.label);
  }

  /** Name/Farbe ändern (ein Spieler übernimmt ein Bot-Loch) */
  setIdentity(name: string, color: number) {
    name = cleanName(name); color = cleanColor(color);
    this.name = name; this.color = color;
    (this.rim.material as THREE.MeshBasicMaterial).color.setHex(color);
    this.label.style.color = '#' + new THREE.Color(color).getHexString();
    this.label.textContent = (this.crowned ? '👑 ' : '') + name;
  }

  /** neue Position aus dem Netz */
  setNet(x: number, z: number, vx: number, vz: number, now: number) {
    if (![x, z, vx, vz].every(Number.isFinite)) return;
    const n = this.net;
    x = num(x, -200, 200); z = num(z, -200, 200); vx = num(vx, -30, 30); vz = num(vz, -30, 30);
    n.x = x; n.z = z; n.vx = vx; n.vz = vz; n.at = now;
    // weit daneben (Einstieg, Neustart) -> springen statt gleiten
    if (Math.hypot(x - this.x, z - this.z) > 12 + this.r) { this.x = x; this.z = z; }
  }

  /** Stand vom Host übernehmen (Level/Punkte); löst den Level-Puls aus */
  setStats(level: number, xp: number, score: number, kills: number) {
    level = Math.round(num(level, 0, MAX_LEVEL));
    if (level > this.level) this.pulse = 1;
    this.level = level; this.xp = num(xp, 0, 1e9); this.score = Math.round(num(score, 0, 1e9)); this.kills = Math.round(num(kills, 0, 99));
  }

  get targetR() { return radiusFor(this.level); }
  get depth() { return 3 + this.r * 2.2; }
  /** Objekt gilt als gefressen, wenn sein Zentrum tiefer ist */
  get killY() { return -(1.6 + this.r * 1.25); }
  /** konstantes Tempo – unabhängig von der Größe */
  get speed() { return 9.5; }
  /** sichtbar (lebt oder wird gerade eingesaugt) */
  get visible() { return this.alive || !!this.suckBy; }
  /** Größe für die Rangliste (Level + Fortschritt zum nächsten) */
  get size() { return this.level + Math.min(1, this.progress); }
  private crowned = false;
  setCrown(on: boolean) {
    if (on === this.crowned) return;
    this.crowned = on;
    this.label.textContent = (on ? '👑 ' : '') + this.name;
  }

  get progress() { return this.level >= MAX_LEVEL ? 1 : this.xp / xpNext(this.level); }

  gain(points: number) {
    this.score += points;
    if (this.level >= MAX_LEVEL) return false;
    this.xp += points;
    let up = false;
    while (this.level < MAX_LEVEL && this.xp >= xpNext(this.level)) {
      this.xp -= xpNext(this.level); this.level++; up = true;
    }
    if (up) this.pulse = 1;
    return up;
  }

  /** Bewegung + Radius-Animation */
  update(dt: number, limit: number, frozen = false) {
    if (this.suckBy) {
      // eingesaugt: zum Fresser gleiten und schrumpfen
      this.suckT += dt;
      const k = Math.min(1, dt * 10);
      this.x += (this.suckBy.x - this.x) * k; this.z += (this.suckBy.z - this.z) * k;
      this.r *= Math.exp(-dt * 7);
      this.applyVisuals();
      if (this.suckT > 0.5) this.hide();
      return;
    }
    if (!this.alive) return;
    if (frozen) { this.applyVisuals(); return; }
    if (this.ctrl === 'net') {
      // fremdes Loch: der letzten Netzposition (vorausberechnet) weich folgen
      const n = this.net, age = Math.min(0.25, performance.now() / 1000 - n.at);
      const k = 1 - Math.exp(-dt * 12);
      this.x += (n.x + n.vx * age - this.x) * k;
      this.z += (n.z + n.vz * age - this.z) * k;
      this.vx = n.vx; this.vz = n.vz;
      const l = Math.hypot(n.vx, n.vz);
      this.dirX = l > 0.5 ? n.vx / this.speed : 0; this.dirZ = l > 0.5 ? n.vz / this.speed : 0;
    } else {
      const sp = this.speed;
      const k = 1 - Math.exp(-dt * 9);
      this.vx += (this.dirX * sp - this.vx) * k;
      this.vz += (this.dirZ * sp - this.vz) * k;
      this.x += this.vx * dt; this.z += this.vz * dt;
    }
    const lim = limit - this.r;
    this.x = Math.max(-lim, Math.min(lim, this.x));
    this.z = Math.max(-lim, Math.min(lim, this.z));
    this.r += (this.targetR - this.r) * (1 - Math.exp(-dt * 4));
    if (Math.abs(this.r - this.builtR) > this.builtR * 0.04) this.buildWalls();
    this.body.setNextKinematicTranslation({ x: this.x, y: 0, z: this.z });
    this.pulse = Math.max(0, this.pulse - dt * 2.5);
    this.applyVisuals();
  }

  private applyVisuals() {
    this.t += 1 / 60;
    this.group.position.set(this.x, 0, this.z);
    if (this.threatRing) {
      const m = this.threatRing.material;
      if (this.threat) m.color.setHex(this.threat > 0 ? 0xff3b3b : 0x5dff7a);
      const target = this.threat && this.alive ? 0.55 + Math.sin(this.t * 7) * 0.3 : 0;
      m.opacity += (target - m.opacity) * 0.2;
      this.threatRing.scale.setScalar(this.r);
    }
    this.pit.scale.set(this.r, this.depth, this.r);
    const p = 1 + Math.sin(this.pulse * Math.PI) * 0.12;
    this.rim.scale.setScalar(this.r * p);
    if (this.prog) { this.prog.scale.setScalar(this.r * p); this.prog.material.uniforms.uP.value = this.progress; }
    if (this.arrow) {
      // Pfeil vor dem Loch in Bewegungsrichtung, blendet bei Stillstand aus
      const moving = Math.hypot(this.dirX, this.dirZ) > 0.1 && this.alive;
      if (moving) this.arrowA = Math.atan2(-this.dirX, -this.dirZ);
      const m = this.arrow.material;
      m.opacity += ((moving ? 0.9 : 0) - m.opacity) * 0.2;
      const size = 0.5 + this.r * 0.22, dist = this.r * 1.2 * p + size * 0.6 + 0.3;
      this.arrow.position.set(-Math.sin(this.arrowA) * dist, 0.06, -Math.cos(this.arrowA) * dist);
      this.arrow.rotation.y = this.arrowA;
      this.arrow.scale.setScalar(size);
    }
  }

  /**
   * Physikalische Umgebung des Lochs, nur für Objekte, die diesem Loch zugeordnet sind:
   *  - ein Bodenring (r .. R) mit echtem Loch in der Mitte -> Objekte kippen über die Kante
   *  - Grubenwände darunter
   */
  private buildWalls() {
    for (const c of this.walls) this.physics.removeCollider(c, false);
    this.walls = [];
    const r = this.r;
    const grp = groups(gPit(this.id), gFall(this.id));
    // Bodenring: Quader, deren Innenkante tangential bei r liegt (überdecken nie das Lochinnere)
    // breit genug für Objekte bis 2,2× Lochradius, die übers Loch ragen
    const R = r * 5.6 + 3, nr = 40;
    const halfT = R * Math.tan(Math.PI / nr) * 1.02;
    for (let i = 0; i < nr; i++) {
      const a = (i / nr) * Math.PI * 2;
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a);
      const mid = (r + R) / 2;
      const cd = RAPIER.ColliderDesc.cuboid((R - r) / 2, 0.5, halfT)
        .setTranslation(Math.cos(a) * mid, -0.5, Math.sin(a) * mid)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        // reibungsfrei, damit der mitfahrende Ring keine Objekte mitschleift
        .setFriction(0).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setCollisionGroups(grp);
      this.walls.push(this.physics.createCollider(cd, this.body));
    }
    const depth = this.depth + 4, th = 0.6, n = 24;
    const half = (r + th * 2) * Math.tan(Math.PI / n) * 1.1;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a);
      const cd = RAPIER.ColliderDesc.cuboid(th, depth / 2, half)
        .setTranslation(Math.cos(a) * (r + th), -depth / 2 - 0.08, Math.sin(a) * (r + th))
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setFriction(0.3)
        .setCollisionGroups(grp);
      this.walls.push(this.physics.createCollider(cd, this.body));
    }
    this.builtR = r;
  }

  /** von Loch `by` gefressen: sofort aus dem Spiel, optisch noch kurz eingesaugt */
  die(by?: Hole) {
    this.alive = false;
    this.label.style.display = 'none';
    for (const c of this.walls) this.physics.removeCollider(c, false);
    this.walls = []; this.builtR = 0;
    if (by) { this.suckBy = by; this.suckT = 0; } else this.hide();
  }

  private hide() {
    this.suckBy = null;
    this.group.visible = false;
  }

  respawn(x: number, z: number, level: number) {
    this.alive = true;
    this.suckBy = null;
    this.pulse = 0;
    this.x = x; this.z = z; this.vx = this.vz = 0;
    this.level = level; this.xp = 0; this.r = radiusFor(level);
    this.body.setTranslation({ x, y: 0, z }, true);
    this.group.visible = true;
    this.label.style.display = '';
    this.buildWalls();
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.group);
    this.label.remove();
  }
}
