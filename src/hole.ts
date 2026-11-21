import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-simd';
import { gFall, gPit, groups } from './world';

/** XP, die für den nächsten Level nötig sind */
export const xpNext = (lvl: number) => Math.round(6 * Math.pow(1.6, lvl));
export const radiusFor = (lvl: number) => 1.15 * Math.pow(1.22, lvl);
export const MAX_LEVEL = 14;

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
const progGeo = new THREE.RingGeometry(1.1, 1.2, 96).rotateX(-Math.PI / 2);

export class Hole {
  x = 0; z = 0; vx = 0; vz = 0;
  /** gewünschte Richtung (Länge 0..1) */
  dirX = 0; dirZ = 0;
  level = 0; xp = 0; score = 0;
  r = radiusFor(0);
  alive = true;
  respawnIn = 0;
  kills = 0;
  // Physik
  private body: RAPIER.RigidBody;
  private walls: RAPIER.Collider[] = [];
  private builtR = 0;
  // Darstellung
  group = new THREE.Group();
  private pit: THREE.Mesh;
  private rim: THREE.Mesh;
  private prog?: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  label: HTMLDivElement;
  // KI
  aiT = 0; tx = 0; tz = 0; skill = 1;

  constructor(
    public id: number, public name: string, public color: number, public isPlayer: boolean,
    private physics: RAPIER.World, scene: THREE.Scene,
  ) {
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
      this.group.add(this.prog);
    }
    scene.add(this.group);
    this.label = document.createElement('div');
    this.label.className = 'label' + (isPlayer ? ' me' : '');
    this.label.textContent = name;
    this.label.style.color = '#' + new THREE.Color(color).getHexString();
    document.getElementById('labels')!.appendChild(this.label);
  }

  get targetR() { return radiusFor(this.level); }
  get depth() { return 3 + this.r * 2.2; }
  /** Objekt gilt als gefressen, wenn sein Zentrum tiefer ist */
  get killY() { return -(1.6 + this.r * 1.25); }
  get speed() { return 7.5 + this.r * 0.75; }
  get progress() { return this.level >= MAX_LEVEL ? 1 : this.xp / xpNext(this.level); }

  gain(points: number) {
    this.score += points;
    if (this.level >= MAX_LEVEL) return false;
    this.xp += points;
    let up = false;
    while (this.level < MAX_LEVEL && this.xp >= xpNext(this.level)) {
      this.xp -= xpNext(this.level); this.level++; up = true;
    }
    return up;
  }

  /** Bewegung + Radius-Animation */
  update(dt: number, limit: number) {
    if (!this.alive) return;
    const sp = this.speed;
    const k = 1 - Math.exp(-dt * 9);
    this.vx += (this.dirX * sp - this.vx) * k;
    this.vz += (this.dirZ * sp - this.vz) * k;
    this.x += this.vx * dt; this.z += this.vz * dt;
    const lim = limit - this.r;
    this.x = Math.max(-lim, Math.min(lim, this.x));
    this.z = Math.max(-lim, Math.min(lim, this.z));
    this.r += (this.targetR - this.r) * (1 - Math.exp(-dt * 4));
    if (Math.abs(this.r - this.builtR) > this.builtR * 0.04) this.buildWalls();
    this.body.setNextKinematicTranslation({ x: this.x, y: 0, z: this.z });
    this.group.position.set(this.x, 0, this.z);
    this.pit.scale.set(this.r, this.depth, this.r);
    this.rim.scale.setScalar(this.r);
    if (this.prog) { this.prog.scale.setScalar(this.r); this.prog.material.uniforms.uP.value = this.progress; }
  }

  /** Ring aus Quadern als Grubenwand – kollidiert nur mit Objekten, die in dieses Loch fallen */
  private buildWalls() {
    for (const c of this.walls) this.physics.removeCollider(c, false);
    this.walls = [];
    const r = this.r, depth = this.depth + 4, th = 0.6, n = 24;
    const half = (r + th * 2) * Math.tan(Math.PI / n) * 1.1;
    const grp = groups(gPit(this.id), gFall(this.id));
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

  die() {
    this.alive = false;
    this.group.visible = false;
    this.label.style.display = 'none';
    for (const c of this.walls) this.physics.removeCollider(c, false);
    this.walls = []; this.builtR = 0;
  }

  respawn(x: number, z: number, level: number) {
    this.alive = true;
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
