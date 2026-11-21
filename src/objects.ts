import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import RAPIER from '@dimforge/rapier3d-simd';

/** Ein Objekttyp der Stadt. Geometrie ist um den Schwerpunkt (Bounding-Box-Mitte) zentriert. */
export interface ObjType {
  id: number;
  name: string;
  geo: THREE.BufferGeometry;
  /** halbe Höhe – Spawn-y */
  hh: number;
  /** horizontaler "Fußabdruck"-Radius: Loch muss größer sein */
  ro: number;
  points: number;
  colliders: () => RAPIER.ColliderDesc[];
  palette: number[];
  textured?: boolean;
  /** Sound-/Haptik-Gewicht */
  weight: number;
}

const C = (hex: number) => new THREE.Color(hex);

/** Baut ein Teilstück mit Vertex-Farbe und Tint-Flag (1 = wird pro Instanz eingefärbt). */
function part(geo: THREE.BufferGeometry, color: number, tint: number, x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0): THREE.BufferGeometry {
  const keepUv = !!geo.userData.facade;
  let g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('normal');
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(1, 1, 1),
  );
  g.applyMatrix4(m);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  const c = C(color);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(n).fill(tint), 1));
  // Nur Fassaden bekommen echte UVs, alles andere sampelt die einfarbige Wandecke der Textur
  if (!keepUv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2).fill(0.03), 2));
  return g;
}

/** Fügt Teile zusammen, berechnet Flat-Normals und zentriert auf die Bounding-Box. */
function build(parts: THREE.BufferGeometry[]): { geo: THREE.BufferGeometry; hh: number } {
  const g = mergeGeometries(parts, false)!;
  g.computeVertexNormals();
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  const cy = (bb.min.y + bb.max.y) / 2;
  g.translate(0, -cy, 0);
  g.computeBoundingSphere();
  return { geo: g, hh: cy };
}

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt: number, rb: number, h: number, s = 8) => new THREE.CylinderGeometry(rt, rb, h, s);

/** Box mit Fenster-UVs (Weltmaßstab) für Gebäude; Dach bekommt Wandfarbe. */
function facadeBox(w: number, h: number, d: number, floorH = 3.4, winW = 3): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const face = Math.floor(i / 4);
    let u = uv.getX(i), v = uv.getY(i);
    if (face === 2 || face === 3) { u = 0.03; v = 0.03; }
    else {
      const fw = face < 2 ? d : w;
      u *= Math.max(1, Math.round(fw / winW));
      v *= Math.max(1, Math.round(h / floorH));
    }
    uv.setXY(i, u, v);
  }
  g.userData.facade = true;
  return g;
}

export const TYPES: ObjType[] = [];
let nextId = 0;
function def(t: Omit<ObjType, 'id' | 'geo' | 'hh'>, parts: THREE.BufferGeometry[]): ObjType {
  const { geo, hh } = build(parts);
  // Collider sind in Bodenkoordinaten definiert -> auf Schwerpunkt (Bounding-Box-Mitte) verschieben
  const colliders = () => t.colliders().map((d) => d.setTranslation(d.translation.x, d.translation.y - hh, d.translation.z));
  const o: ObjType = { ...t, colliders, id: nextId++, geo, hh };
  TYPES.push(o);
  return o;
}

/** Quader-Collider; (x,y,z) = Mittelpunkt in Bodenkoordinaten */
const cub = (hx: number, hy: number, hz: number, d = 1, x = 0, y = hy, z = 0) =>
  RAPIER.ColliderDesc.cuboid(hx, hy, hz).setDensity(d).setFriction(0.7).setTranslation(x, y, z);
const ball = (r: number, d: number, y: number) => RAPIER.ColliderDesc.ball(r).setDensity(d).setFriction(0.7).setTranslation(0, y, 0);

const SHIRTS = [0xe84a5f, 0x2a9df4, 0xffcf3f, 0x6ac46a, 0xb46ee8, 0xff8c42, 0xf5f5f5, 0x3dd6c4];
const CARS = [0xe63946, 0x1d7cf2, 0xffc93c, 0xf1f1f1, 0x2b2d42, 0x52b788, 0xff7b00, 0x9d4edd, 0x48cae4];
const WALLS = [0xf4a261, 0xe9c46a, 0x8ecae6, 0xf28482, 0xb8c0ff, 0xcdb4db, 0xa8dadc, 0xffd6a5, 0xfdffb6, 0xcaffbf, 0xd0d0d8];
const HOUSES = [0xffadad, 0xffd6a5, 0xfdffb6, 0xcaffbf, 0x9bf6ff, 0xa0c4ff, 0xbdb2ff, 0xffc6ff];

export const T = {
  person: def({ name: 'Mensch', ro: 0.25, points: 1, weight: 0.1, palette: SHIRTS,
    colliders: () => [cub(0.2, 0.68, 0.14, 1)] }, [
    part(box(0.14, 0.55, 0.18), 0x33415c, 0, -0.09, 0.275),
    part(box(0.14, 0.55, 0.18), 0x33415c, 0, 0.09, 0.275),
    part(box(0.42, 0.5, 0.24), 0xffffff, 1, 0, 0.8),
    part(box(0.26, 0.26, 0.26), 0xf1c27d, 0, 0, 1.18),
    part(box(0.28, 0.08, 0.28), 0x4a3426, 0, 0, 1.33),
  ]),
  cone: def({ name: 'Pylone', ro: 0.22, points: 1, weight: 0.05, palette: [0xffffff],
    colliders: () => [cub(0.2, 0.3, 0.2, 0.5)] }, [
    part(box(0.44, 0.06, 0.44), 0xff6b1a, 0, 0, 0.03),
    part(cyl(0.04, 0.18, 0.55, 8), 0xff6b1a, 0, 0, 0.33),
    part(cyl(0.11, 0.135, 0.1, 8), 0xffffff, 0, 0, 0.3),
  ]),
  hydrant: def({ name: 'Hydrant', ro: 0.2, points: 1, weight: 0.1, palette: [0xffffff],
    colliders: () => [cub(0.17, 0.36, 0.17, 2)] }, [
    part(cyl(0.15, 0.15, 0.55, 8), 0xe63946, 0, 0, 0.3),
    part(cyl(0.08, 0.17, 0.15, 8), 0xe63946, 0, 0, 0.64),
    part(box(0.36, 0.1, 0.1), 0xc1121f, 0, 0, 0.38),
  ]),
  trash: def({ name: 'Mülleimer', ro: 0.3, points: 1, weight: 0.15, palette: [0x4f772d, 0x3a86ff, 0x6c757d],
    colliders: () => [cub(0.27, 0.42, 0.27, 0.8)] }, [
    part(cyl(0.27, 0.23, 0.8, 10), 0xffffff, 1, 0, 0.4),
    part(cyl(0.29, 0.29, 0.06, 10), 0x2b2d42, 0, 0, 0.82),
  ]),
  bush: def({ name: 'Busch', ro: 0.6, points: 2, weight: 0.2, palette: [0x52b788, 0x40916c, 0x74c69d],
    colliders: () => [ball(0.55, 0.3, 0.55)] }, [
    part(new THREE.IcosahedronGeometry(0.6, 0), 0xffffff, 1, 0, 0.55),
    part(new THREE.IcosahedronGeometry(0.4, 0), 0xffffff, 1, 0.35, 0.45, 0.2),
  ]),
  bench: def({ name: 'Bank', ro: 0.85, points: 2, weight: 0.25, palette: [0xc68b59, 0x8d5524, 0x6c757d],
    colliders: () => [cub(0.8, 0.45, 0.25, 0.6)] }, [
    part(box(1.6, 0.08, 0.45), 0xffffff, 1, 0, 0.45),
    part(box(1.6, 0.4, 0.07), 0xffffff, 1, 0, 0.7, -0.2),
    part(box(0.08, 0.45, 0.4), 0x2b2d42, 0, -0.7, 0.22),
    part(box(0.08, 0.45, 0.4), 0x2b2d42, 0, 0.7, 0.22),
  ]),
  lamp: def({ name: 'Laterne', ro: 0.3, points: 2, weight: 0.25, palette: [0xffffff],
    colliders: () => [cub(0.1, 2.2, 0.1, 2), cub(0.4, 0.08, 0.12, 1, 0.35, 4.33, 0)] }, [
    part(box(0.3, 0.2, 0.3), 0x495057, 0, 0, 0.1),
    part(cyl(0.06, 0.08, 4.4, 6), 0x495057, 0, 0, 2.2),
    part(box(0.8, 0.08, 0.1), 0x495057, 0, 0.38, 4.35),
    part(box(0.3, 0.12, 0.22), 0xfff3b0, 0, 0.7, 4.28),
  ]),
  tree: def({ name: 'Baum', ro: 1.0, points: 4, weight: 0.4, palette: [0x52b788, 0x2d6a4f, 0x95d5b2, 0x80b918, 0xf4a261],
    colliders: () => [cub(0.2, 0.9, 0.2, 1), ball(1.05, 0.2, 2.75)] }, [
    part(cyl(0.16, 0.24, 1.8, 6), 0x7f5539, 0, 0, 0.9),
    part(new THREE.IcosahedronGeometry(1.25, 0), 0xffffff, 1, 0, 2.6),
    part(new THREE.IcosahedronGeometry(0.8, 0), 0xffffff, 1, 0.3, 3.4, -0.2),
  ]),
  car: def({ name: 'Auto', ro: 1.3, points: 6, weight: 0.6, palette: CARS,
    colliders: () => [cub(1.15, 0.6, 0.55, 1)] }, [
    part(box(2.3, 0.55, 1.1), 0xffffff, 1, 0, 0.5),
    part(box(1.3, 0.45, 1.0), 0xffffff, 1, -0.1, 0.98),
    part(box(1.32, 0.3, 1.02), 0x9ad1f5, 0, -0.1, 1.0),
    ...[-0.72, 0.72].flatMap((x) => [0.5, -0.5].map((z) =>
      part(cyl(0.26, 0.26, 0.18, 10), 0x1b1b1b, 0, x, 0.26, z, 0, Math.PI / 2))),
    part(box(0.05, 0.15, 0.25), 0xfff3b0, 0, 1.16, 0.6, 0.3),
    part(box(0.05, 0.15, 0.25), 0xfff3b0, 0, 1.16, 0.6, -0.3),
  ]),
  kiosk: def({ name: 'Kiosk', ro: 1.6, points: 8, weight: 0.6, palette: [0xff595e, 0x1982c4, 0x8ac926, 0xffca3a],
    colliders: () => [cub(1.2, 1.09, 1.2, 0.5)] }, [
    part(box(2.0, 2.0, 2.0), 0xfaf3dd, 0, 0, 1.0),
    part(box(2.4, 0.15, 2.4), 0xffffff, 1, 0, 2.1),
    part(box(2.4, 0.4, 0.1), 0xffffff, 1, 0, 1.95, 1.2),
    part(box(1.4, 0.8, 0.05), 0x2b2d42, 0, 0, 1.3, 1.01),
  ]),
  bus: def({ name: 'Bus', ro: 3.0, points: 22, weight: 1.2, palette: [0xffc300, 0xe63946, 0x1d7cf2],
    colliders: () => [cub(2.8, 0.95, 0.67, 0.6)] }, [
    part(box(5.6, 1.6, 1.3), 0xffffff, 1, 0, 1.1),
    part(box(5.62, 0.5, 1.32), 0x9ad1f5, 0, 0, 1.45),
    ...[-1.9, 1.9].flatMap((x) => [0.62, -0.62].map((z) =>
      part(cyl(0.34, 0.34, 0.2, 10), 0x1b1b1b, 0, x, 0.34, z, 0, Math.PI / 2))),
  ]),
  house: def({ name: 'Haus', ro: 2.9, points: 28, weight: 1.6, palette: HOUSES, textured: true,
    colliders: () => [cub(2.0, 2.5, 2.0, 0.4)] }, [
    part(facadeBox(4, 3.2, 4, 3.2, 2), 0xffffff, 1, 0, 1.6),
    part(new THREE.ConeGeometry(3.1, 1.8, 4), 0xb5523b, 0, 0, 4.1, 0, Math.PI / 4),
    part(box(0.8, 1.6, 0.06), 0x6f4518, 0, 0, 0.8, 2.01),
  ]),
};

export interface BuildingDef { w: number; d: number; h: number; type: ObjType }
/** Gebäude-Vorlagen: (Breite, Tiefe, Höhe) – Punkte ~ Volumen */
export const BUILDINGS: BuildingDef[] = ([
  [6, 6, 8], [8, 6, 11], [8, 8, 14], [10, 8, 18], [10, 10, 22], [12, 10, 27], [14, 12, 32], [16, 14, 40],
] as const).map(([w, d, h], i) => {
  const ac = 0x9aa0a6;
  const parts = [
    part(facadeBox(w, h, d), 0xffffff, 1, 0, h / 2),
    part(box(w + 0.3, 0.4, d + 0.3), 0xbfc5cc, 0, 0, h + 0.2),
    part(box(1.4, 0.9, 1.0), ac, 0, w * 0.2, h + 0.85, d * 0.15),
    part(box(1.0, 0.7, 1.0), ac, 0, -w * 0.25, h + 0.75, -d * 0.2),
  ];
  if (h >= 18) parts.push(part(cyl(0.05, 0.05, 4, 4), 0x6c757d, 0, 0, h + 2.4, 0));
  const vol = w * d * h;
  const type = def({
    name: 'Gebäude ' + (i + 1), ro: Math.hypot(w, d) / 2, points: Math.round(vol / 6), weight: 2 + i,
    palette: WALLS, textured: true,
    colliders: () => [cub(w / 2, (h + 0.4) / 2, d / 2, 0.25)],
  }, parts);
  return { w, d, h, type };
});

/** Fenstertextur (eine Kachel = ein Fenster pro Etage) */
function windowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#5d7fa8'; g.fillRect(12, 14, 40, 36);
  g.fillStyle = '#8fb3dc'; g.fillRect(12, 14, 40, 10);
  g.fillStyle = '#e8e8e8'; g.fillRect(10, 50, 44, 4);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.generateMipmaps = true;
  return t;
}

/**
 * Lambert-Material mit zwei Shader-Erweiterungen:
 *  - "tint": nur markierte Vertices werden mit der Instanzfarbe eingefärbt
 *  - Abdunkeln unterhalb des Bodens (Objekt fällt ins Loch)
 */
/** Bildschirmposition (px) + Radius des Spielerlochs: Objekte davor werden durchsichtig gerastert */
export const xray = { value: new THREE.Vector3(0, 0, 0) };

function objMaterial(map?: THREE.Texture): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, map: map ?? null });
  m.onBeforeCompile = (s) => {
    s.uniforms.uXray = xray;
    s.vertexShader = 'attribute float tint;\nvarying float vWY;\n' + s.vertexShader
      .replace('#include <color_vertex>', `
        vColor = vec4(1.0);
        #ifdef USE_COLOR
          vColor.rgb *= color.rgb;
        #endif
        #ifdef USE_INSTANCING_COLOR
          vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, tint);
        #endif`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 wpY = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          wpY = instanceMatrix * wpY;
        #endif
        vWY = (modelMatrix * wpY).y;`);
    s.fragmentShader = 'uniform vec3 uXray;\nvarying float vWY;\n' + s.fragmentShader
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (uXray.z > 0.0 && vWY > 1.2) {
          float xd = distance(gl_FragCoord.xy, uXray.xy);
          if (xd < uXray.z && mod(floor(gl_FragCoord.x) + floor(gl_FragCoord.y), 2.0) < 1.0) discard;
        }`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
        gl_FragColor.rgb *= clamp(1.0 + vWY * 0.22, 0.0, 1.0);`);
  };
  return m;
}

let _mats: { plain: THREE.Material; textured: THREE.Material } | null = null;
export function materials() {
  if (!_mats) _mats = { plain: objMaterial(), textured: objMaterial(windowTexture()) };
  return _mats;
}
