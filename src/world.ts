import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-simd';
import { TYPES, materials, type ObjType } from './objects';
import { generateCity, HALF, ROADS, ROAD_HW, type Mover } from './city';

// ---- Kollisionsgruppen (16 Bit Mitgliedschaft << 16 | 16 Bit Filter) ----
export const MAX_HOLES = 6;
const G_GROUND = 1 << 0;
const G_OBJ = 1 << 1;
export const gFall = (i: number) => 1 << (2 + 2 * i);
export const gPit = (i: number) => 1 << (3 + 2 * i);
export const groups = (member: number, filter: number) => ((member & 0xffff) << 16) | (filter & 0xffff);

const groupsFalling = (i: number) => groups(gFall(i), gFall(i) | gPit(i));

export interface Obj {
  /** Index in World.objs (gleich auf allen Geräten, da aus demselben Seed erzeugt) */
  idx: number;
  type: ObjType;
  inst: number;
  /** Physikkörper – existiert erst, sobald das Objekt in ein Loch kippt */
  body: RAPIER.RigidBody | null;
  alive: boolean;
  /** Index des Lochs, dem das Objekt gerade (physikalisch) zugeordnet ist, sonst -1 */
  falling: number;
  mover?: Mover;
  /** Bewegungsmuster, das nach dem Deaktivieren wiederhergestellt wird */
  savedMover?: Mover;
  homeX: number; homeZ: number;
  x: number; y: number; z: number;
  /** Rotation (Quaternion) */
  q: THREE.Quaternion;
  vx: number; vz: number;
  dirty: boolean;
  /** Netz (Client): letzte vom Host empfangene Position + geschätzte Geschwindigkeit */
  net?: { x: number; z: number; vx: number; vz: number; at: number };
}

/** Wert im Mover-Paket für "bewegt sich beim Host gerade nicht" */
const NO_POS = 32767;
const POS_Q = 50;

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);
const _q2 = new THREE.Quaternion();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/** Verkehrsteilnehmer nimmt die Fahrt nur wieder auf, wenn er noch (fast) auf seiner Spur steht */
function canResume(o: Obj, m: Mover) {
  if (m.kind === 'walk' && !m.axis) return true;
  const perp = m.axis === 'x' ? o.z : o.x;
  return Math.abs(perp - m.lane) < 0.8;
}

export class World {
  physics: RAPIER.World;
  objs: Obj[] = [];
  meshes: THREE.InstancedMesh[] = [];
  group = new THREE.Group();
  groundTex: THREE.CanvasTexture;
  private dirtyTypes = new Set<number>();
  /** umgekippte, eingefrorene Objekte, die sich nach kurzer Zeit wieder aufrichten */
  private righting = new Map<Obj, number>();
  private time = 0;
  /** Objekte mit aktivem Physikkörper */
  active = new Set<Obj>();
  /** alle Objekte, die sich anfangs bewegen (Autos, Fußgänger) – feste Reihenfolge fürs Netz */
  movers: Obj[] = [];

  constructor(readonly seed: number) {
    this.physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.physics.timestep = 1 / 60;

    // Boden: ein großer Quader. Fallende Objekte ignorieren ihn per Kollisionsgruppe.
    const gb = this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -1, 0));
    this.physics.createCollider(
      RAPIER.ColliderDesc.cuboid(HALF + 30, 1, HALF + 30).setFriction(0.8).setCollisionGroups(groups(G_GROUND, G_OBJ)), gb);

    const { spawns, ground } = generateCity(seed);
    this.groundTex = ground;

    const counts = new Array(TYPES.length).fill(0);
    for (const s of spawns) counts[s.type.id]++;
    const mats = materials();
    for (const t of TYPES) {
      const mesh = new THREE.InstancedMesh(t.geo, t.textured ? mats.textured : mats.plain, Math.max(1, counts[t.id]));
      mesh.count = counts[t.id];
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.meshes.push(mesh);
      this.group.add(mesh);
    }

    const used = new Array(TYPES.length).fill(0);
    const col = new THREE.Color();
    for (const s of spawns) {
      const t = s.type;
      const inst = used[t.id]++;
      this.objs.push({
        idx: this.objs.length, type: t, inst, body: null, alive: true, falling: -1, mover: s.mover,
        homeX: s.x, homeZ: s.z, x: s.x, y: t.hh, z: s.z, vx: 0, vz: 0,
        q: new THREE.Quaternion().setFromAxisAngle(_up, s.rot), dirty: true,
      });
      this.meshes[t.id].setColorAt(inst, col.setHex(s.color));
    }
    for (const m of this.meshes) if (m.instanceColor) m.instanceColor.needsUpdate = true;
    this.movers = this.objs.filter((o) => o.mover);
    this.collectObstacles();
    this.sync();
  }

  /** Für frei laufende Fußgänger: feste Hindernisse in der Umgebung merken (Bäume, Bänke, Häuser …) */
  private collectObstacles() {
    const statics = this.objs.filter((o) => !o.mover);
    for (const w of this.objs) {
      const m = w.mover;
      if (!m || m.kind !== 'walk' || m.axis) continue;
      m.obs = [];
      for (const o of statics) {
        const d = Math.hypot(o.x - w.homeX, o.z - w.homeZ);
        // Bäume: nur der Stamm zählt (unter der Krone kann man durch)
        const r = o.type.name === 'Baum' ? 0.35 : Math.min(o.type.ro, 9);
        if (d < 9 + r) m.obs.push({ x: o.x, z: o.z, r, o });
      }
    }
  }

  /**
   * Objekt kommt in die Nähe von Loch i: ab jetzt ein dynamischer Rapier-Körper, der nur noch
   * mit dem Bodenring und der Grube dieses Lochs kollidiert. Ob es hineinfällt, entscheidet die Physik.
   */
  activate(o: Obj, i: number) {
    o.falling = i;
    if (o.mover) { o.savedMover = o.mover; o.mover = undefined; }
    const b = this.physics.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(o.x, o.y, o.z)
      .setRotation({ x: o.q.x, y: o.q.y, z: o.q.z, w: o.q.w })
      .setLinvel(o.vx * 0.5, 0, o.vz * 0.5)
      .setGravityScale(1.8)
      .setLinearDamping(0.6).setAngularDamping(0.4)
      .setCcdEnabled(o.type.ro < 0.5));
    for (const cd of o.type.colliders()) this.physics.createCollider(cd.setCollisionGroups(groupsFalling(i)), b);
    o.body = b;
    o.vx = o.vz = 0;
    this.active.add(o);
    this.righting.delete(o);
  }

  /**
   * Sog: passende Objekte über bzw. an der Kante werden sanft zur Mitte und nach unten gezogen,
   * damit sie zügig über die Kante kippen statt auf dem Rand zu balancieren.
   */
  suction(holes: { x: number; z: number; r: number; alive: boolean }[], dt: number) {
    for (const o of this.active) {
      const h = holes[o.falling], b = o.body;
      if (!h || !h.alive || !b) continue;
      const dx = h.x - o.x, dz = h.z - o.z, d = Math.hypot(dx, dz) || 1;
      if (d > h.r + o.type.ro * 0.6) continue;
      const m = b.mass();
      if (o.type.ro > h.r * 0.95) {
        // passt (noch) nicht: nur wackeln
        if (Math.random() < dt * 8) {
          const k = m * o.type.ro * 0.25;
          b.applyTorqueImpulse({ x: (Math.random() - 0.5) * k, y: 0, z: (Math.random() - 0.5) * k }, true);
        }
        continue;
      }
      const a = 7 * dt * m;
      b.applyImpulse({ x: (dx / d) * a, y: o.y > -0.5 ? -a * 0.8 : 0, z: (dz / d) * a }, true);
    }
  }

  /** Loch hat sich entfernt: Objekt wieder einfrieren (kostet dann keine Physik mehr) */
  deactivate(o: Obj) {
    const b = o.body;
    if (b) {
      const p = b.translation(), r = b.rotation();
      o.x = p.x; o.y = Math.max(p.y, 0.05); o.z = p.z;
      o.q.set(r.x, r.y, r.z, r.w);
      this.physics.removeRigidBody(b);
      o.body = null;
    }
    this.active.delete(o);
    o.falling = -1;
    o.dirty = true;
    // aufrecht stehende Fußgänger/Autos fahren weiter, umgekippte stellen sich bald wieder auf
    const upright = _p.set(0, 1, 0).applyQuaternion(o.q).y > 0.97;
    if (upright && o.savedMover && canResume(o, o.savedMover)) {
      o.mover = o.savedMover; o.savedMover = undefined;
      o.y = o.type.hh;
    } else if (!upright || Math.abs(o.y - o.type.hh) > 0.2) {
      this.righting.set(o, this.time + 3.5);
    }
  }

  remove(o: Obj) {
    o.alive = false;
    if (o.body) { this.physics.removeRigidBody(o.body); o.body = null; }
    this.active.delete(o);
    this.meshes[o.type.id].setMatrixAt(o.inst, ZERO);
    this.dirtyTypes.add(o.type.id);
  }

  /** Ampelphase: welche Achse hat Grün (null = alle rot, Räumzeit) */
  private green(t: number): 'x' | 'z' | null {
    const c = t % 16;
    return c < 6.5 ? 'x' : c < 8 ? null : c < 14.5 ? 'z' : null;
  }

  /** Verkehr & Fußgänger – reine JS-Kinematik, keine Physik nötig */
  updateMovers(dt: number, t: number) {
    this.time = t;
    const green = this.green(t);
    // Autos nach Spur gruppieren (für Abstand zum Vordermann)
    const lanes = new Map<string, Obj[]>();
    for (const o of this.objs) {
      const m = o.mover;
      if (!o.alive || !m || m.kind !== 'car') continue;
      const k = m.axis + m.lane;
      let l = lanes.get(k);
      if (!l) lanes.set(k, (l = []));
      l.push(o);
    }
    for (const o of this.objs) {
      const m = o.mover;
      if (!o.alive || !m) continue;
      if (m.kind === 'car') {
        const along = m.axis === 'x' ? o.x : o.z;
        const half = o.type.ro * 0.9;
        let target = m.speed;
        // rote Ampel: vor der Haltelinie stehen bleiben (wer schon drüber ist, fährt weiter)
        if (green !== m.axis) {
          for (const c of ROADS) {
            const gap = (c - along) * m.dir - (ROAD_HW + 1.6) - half;
            if (gap > -0.3 && gap < 7) { target = Math.min(target, Math.max(0, gap - 0.2) * 1.5); break; }
          }
        }
        // Abstand zum Vordermann
        for (const b of lanes.get(m.axis + m.lane)!) {
          if (b === o) continue;
          const ba = m.axis === 'x' ? b.x : b.z;
          const gap = (ba - along) * m.dir - half - b.type.ro * 0.9;
          if (gap > -0.5 && gap < 8) target = Math.min(target, Math.max(0, gap - 1.5) * 1.6);
        }
        const cur = m.cur ?? m.speed;
        m.cur = cur + Math.max(-14 * dt, Math.min(4 * dt, target - cur));
        const sp = m.dir * m.cur;
        if (m.axis === 'x') { o.vx = sp; o.vz = 0; o.z = m.lane; } else { o.vz = sp; o.vx = 0; o.x = m.lane; }
        o.x += o.vx * dt; o.z += o.vz * dt;
        if (m.dir > 0 ? along > HALF - 3 : along < -HALF + 3) {
          if (m.axis === 'x') o.x = -m.dir * (HALF - 3.5); else o.z = -m.dir * (HALF - 3.5);
        }
      } else {
        if (m.axis) {
          if (Math.random() < dt * 0.08) m.dir = (m.dir * -1) as 1 | -1;
          const along = m.axis === 'x' ? o.x : o.z;
          if (along > m.max) m.dir = -1; else if (along < m.min) m.dir = 1;
          o.vx = m.axis === 'x' ? m.dir * m.speed : 0;
          o.vz = m.axis === 'x' ? 0 : m.dir * m.speed;
        } else {
          if (Math.random() < dt * 0.4) m.heading += (Math.random() - 0.5) * 2.5;
          const hx = o.homeX - o.x, hz = o.homeZ - o.z;
          if (hx * hx + hz * hz > 49) m.heading = Math.atan2(hx, hz);
          o.vx = Math.sin(m.heading) * m.speed; o.vz = Math.cos(m.heading) * m.speed;
          // Hindernis voraus? -> abdrehen statt hindurchlaufen
          const nx = o.x + o.vx * 0.4, nz = o.z + o.vz * 0.4;
          for (const ob of m.obs ?? []) {
            if (!(ob.o as Obj).alive || (ob.o as Obj).falling >= 0) continue;
            const r = ob.r + 0.3;
            if ((nx - ob.x) ** 2 + (nz - ob.z) ** 2 < r * r) {
              m.heading = Math.atan2(o.x - ob.x, o.z - ob.z) + (Math.random() - 0.5) * 1.6;
              o.vx = Math.sin(m.heading) * m.speed; o.vz = Math.cos(m.heading) * m.speed;
              break;
            }
          }
        }
        o.x += o.vx * dt; o.z += o.vz * dt;
        // Watschelgang
        const yaw = Math.atan2(o.vx, o.vz) + Math.sin(t * 9 + o.inst) * 0.1;
        o.q.setFromAxisAngle(_up, yaw);
        o.y = o.type.hh + Math.abs(Math.sin(t * 9 + o.inst)) * 0.06;
      }
      o.dirty = true;
    }
    this.updateRighting(dt, t);
  }

  // ---------- Netz ----------
  /** Host: Positionen aller gerade fahrenden/laufenden Objekte (Int16, 1/50 Einheit) */
  packMovers() {
    const a = new Int16Array(this.movers.length * 2);
    this.movers.forEach((o, i) => {
      const moving = o.alive && o.mover && !o.body;
      a[i * 2] = moving ? Math.round(o.x * POS_Q) : NO_POS;
      a[i * 2 + 1] = moving ? Math.round(o.z * POS_Q) : NO_POS;
    });
    return a;
  }

  /** Client: Mover-Paket vom Host übernehmen */
  applyMovers(a: Int16Array, now: number) {
    if (a.length !== this.movers.length * 2) return;
    this.movers.forEach((o, i) => {
      if (a[i * 2] === NO_POS) { o.net = undefined; return; }
      const x = a[i * 2] / POS_Q, z = a[i * 2 + 1] / POS_Q, n = o.net;
      if (n && now > n.at && Math.hypot(x - n.x, z - n.z) < 12) {
        const dt = Math.max(0.05, now - n.at);
        n.vx = (x - n.x) / dt; n.vz = (z - n.z) / dt; n.x = x; n.z = z; n.at = now;
      } else {
        o.net = { x, z, vx: 0, vz: 0, at: now };
        if (!o.body && o.mover) { o.x = x; o.z = z; } // Sprung (z. B. Auto am Kartenrand)
      }
    });
  }

  /** Client: Verkehr folgt dem Host (mit Extrapolation), statt selbst zu simulieren */
  stepNetMovers(dt: number, t: number, now: number) {
    this.time = t;
    const k = 1 - Math.exp(-dt * 12);
    for (const o of this.movers) {
      const n = o.net, m = o.mover;
      if (!o.alive || !n || !m || o.body) continue;
      const age = Math.min(0.3, now - n.at);
      const ox = o.x, oz = o.z;
      o.x += (n.x + n.vx * age - o.x) * k;
      o.z += (n.z + n.vz * age - o.z) * k;
      if (m.kind === 'walk') {
        const vx = (o.x - ox) / dt, vz = (o.z - oz) / dt;
        if (vx * vx + vz * vz > 0.04) m.heading = Math.atan2(vx, vz);
        o.q.setFromAxisAngle(_up, m.heading + Math.sin(t * 9 + o.inst) * 0.1);
        o.y = o.type.hh + Math.abs(Math.sin(t * 9 + o.inst)) * 0.06;
      }
      o.vx = n.vx; o.vz = n.vz;
      o.dirty = true;
    }
    this.updateRighting(dt, t);
  }

  /** Host-Wechsel: ab jetzt wieder selbst simulieren */
  resumeMovers() { for (const o of this.movers) o.net = undefined; }

  /** Bitmaske der gefressenen Objekte (für Spieler, die mitten in der Runde einsteigen) */
  deadMask() {
    const b = new Uint8Array(Math.ceil(this.objs.length / 8));
    for (const o of this.objs) if (!o.alive) b[o.idx >> 3] |= 1 << (o.idx & 7);
    return b;
  }

  applyDeadMask(b: Uint8Array) {
    let pts = 0;
    for (const o of this.objs) if (b[o.idx >> 3] & (1 << (o.idx & 7))) { if (o.alive) this.remove(o); pts += o.type.points; }
    return pts;
  }

  /** Umgekippte Objekte richten sich langsam wieder auf (mit kleinem Hüpfer) */
  updateRighting(dt: number, t: number) {
    this.time = t;
    for (const [o, at] of this.righting) {
      if (!o.alive || o.body) { this.righting.delete(o); continue; }
      if (this.time < at) continue;
      // Gierwinkel aus der aktuellen Lage, dann Richtung aufrecht drehen
      const f = _p.set(1, 0, 0).applyQuaternion(o.q);
      const yaw = Math.hypot(f.x, f.z) > 0.3 ? Math.atan2(-f.z, f.x)
        : Math.atan2(_p.set(0, 0, 1).applyQuaternion(o.q).x, _p.z);
      const target = _q2.setFromAxisAngle(_up, yaw);
      const k = Math.min(1, dt * 6);
      o.q.slerp(target, k);
      const lift = Math.sin(Math.min(1, (this.time - at) * 2) * Math.PI) * 0.6;
      o.y += (o.type.hh + lift - o.y) * k;
      o.dirty = true;
      if (o.q.angleTo(target) < 0.02 && this.time - at > 0.6) {
        o.q.copy(target); o.y = o.type.hh;
        this.righting.delete(o);
        if (o.savedMover && canResume(o, o.savedMover)) { o.mover = o.savedMover; o.savedMover = undefined; }
      }
    }
  }

  /** Physik -> Objektzustand -> Instanz-Matrizen */
  sync() {
    for (const o of this.active) {
      const b = o.body!;
      if (b.isSleeping()) continue;
      const p = b.translation(), r = b.rotation();
      o.x = p.x; o.y = p.y; o.z = p.z;
      o.q.set(r.x, r.y, r.z, r.w);
      o.dirty = true;
    }
    for (const o of this.objs) {
      if (!o.alive || !o.dirty) continue;
      o.dirty = false;
      _m.compose(_p.set(o.x, o.y, o.z), o.q, _s);
      this.meshes[o.type.id].setMatrixAt(o.inst, _m);
      this.dirtyTypes.add(o.type.id);
    }
    for (const id of this.dirtyTypes) this.meshes[id].instanceMatrix.needsUpdate = true;
    this.dirtyTypes.clear();
  }

  dispose() {
    for (const m of this.meshes) m.dispose();
    this.groundTex.dispose();
    this.physics.free();
  }
}
