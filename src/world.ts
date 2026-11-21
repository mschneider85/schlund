import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-simd';
import { TYPES, materials, type ObjType } from './objects';
import { generateCity, HALF, type Mover } from './city';

// ---- Kollisionsgruppen (16 Bit Mitgliedschaft << 16 | 16 Bit Filter) ----
export const MAX_HOLES = 6;
const G_GROUND = 1 << 0;
const G_OBJ = 1 << 1;
export const gFall = (i: number) => 1 << (2 + 2 * i);
export const gPit = (i: number) => 1 << (3 + 2 * i);
export const groups = (member: number, filter: number) => ((member & 0xffff) << 16) | (filter & 0xffff);

const GROUPS_OBJ = groups(G_OBJ, G_GROUND | G_OBJ);
const groupsFalling = (i: number) => groups(gFall(i), gFall(i) | gPit(i));

export interface Obj {
  type: ObjType;
  inst: number;
  /** Physikkörper – existiert erst, sobald das Objekt in ein Loch kippt */
  body: RAPIER.RigidBody | null;
  alive: boolean;
  /** Index des Lochs, in das das Objekt gerade fällt, sonst -1 */
  falling: number;
  mover?: Mover;
  homeX: number; homeZ: number;
  x: number; y: number; z: number;
  /** Rotation (Quaternion) */
  q: THREE.Quaternion;
  vx: number; vz: number;
  dirty: boolean;
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export class World {
  physics: RAPIER.World;
  objs: Obj[] = [];
  meshes: THREE.InstancedMesh[] = [];
  group = new THREE.Group();
  groundTex: THREE.CanvasTexture;
  private dirtyTypes = new Set<number>();
  /** Objekte mit aktivem Physikkörper */
  private active = new Set<Obj>();

  constructor(seed: number) {
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
        type: t, inst, body: null, alive: true, falling: -1, mover: s.mover,
        homeX: s.x, homeZ: s.z, x: s.x, y: t.hh, z: s.z, vx: 0, vz: 0,
        q: new THREE.Quaternion().setFromAxisAngle(_up, s.rot), dirty: true,
      });
      this.meshes[t.id].setColorAt(inst, col.setHex(s.color));
    }
    for (const m of this.meshes) if (m.instanceColor) m.instanceColor.needsUpdate = true;
    this.sync();
  }

  /** Objekt beginnt in Loch i zu fallen: jetzt erst wird es ein dynamischer Rapier-Körper */
  startFalling(o: Obj, i: number, hx: number, hz: number) {
    o.falling = i;
    o.mover = undefined;
    const b = this.physics.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(o.x, o.y, o.z)
      .setRotation({ x: o.q.x, y: o.q.y, z: o.q.z, w: o.q.w })
      .setLinvel(o.vx, 0, o.vz)
      .setGravityScale(2.6)
      .setLinearDamping(0.1).setAngularDamping(0.3)
      .setCcdEnabled(o.type.ro < 0.5));
    for (const cd of o.type.colliders()) this.physics.createCollider(cd.setCollisionGroups(groupsFalling(i)), b);
    o.body = b;
    this.active.add(o);
    // leichter Sog in Richtung Lochmitte -> Kippen über die Kante
    const m = b.mass();
    const dx = hx - o.x, dz = hz - o.z, d = Math.hypot(dx, dz) || 1;
    b.applyImpulse({ x: (dx / d) * m * 1.2, y: -m * 1.5, z: (dz / d) * m * 1.2 }, true);
    b.applyTorqueImpulse({ x: (dz / d) * m * 0.4, y: 0, z: (-dx / d) * m * 0.4 }, true);
  }

  /** Fallen abbrechen (Loch ist weggefahren, bevor das Objekt versank) – bleibt normal simuliert */
  stopFalling(o: Obj) {
    o.falling = -1;
    const b = o.body;
    if (!b) return;
    for (let k = 0; k < b.numColliders(); k++) b.collider(k).setCollisionGroups(GROUPS_OBJ);
    b.setGravityScale(1, true);
  }

  remove(o: Obj) {
    o.alive = false;
    if (o.body) { this.physics.removeRigidBody(o.body); o.body = null; }
    this.active.delete(o);
    this.meshes[o.type.id].setMatrixAt(o.inst, ZERO);
    this.dirtyTypes.add(o.type.id);
  }

  /** Verkehr & Fußgänger – reine JS-Kinematik, keine Physik nötig */
  updateMovers(dt: number, t: number) {
    for (const o of this.objs) {
      const m = o.mover;
      if (!o.alive || !m) continue;
      if (m.kind === 'car') {
        const sp = m.dir * m.speed;
        if (m.axis === 'x') { o.vx = sp; o.vz = 0; o.z = m.lane; } else { o.vz = sp; o.vx = 0; o.x = m.lane; }
        o.x += o.vx * dt; o.z += o.vz * dt;
        const along = m.axis === 'x' ? o.x : o.z;
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
        }
        o.x += o.vx * dt; o.z += o.vz * dt;
        // Watschelgang
        const yaw = Math.atan2(o.vx, o.vz) + Math.sin(t * 9 + o.inst) * 0.1;
        o.q.setFromAxisAngle(_up, yaw);
        o.y = o.type.hh + Math.abs(Math.sin(t * 9 + o.inst)) * 0.06;
      }
      o.dirty = true;
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
