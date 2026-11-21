import * as THREE from 'three';
import { T, BUILDINGS, type ObjType } from './objects';

export const HALF = 120; // Karte: [-HALF, HALF]²
export const ROADS = [-96, -48, 0, 48, 96];
export const ROAD_HW = 4.5; // halbe Fahrbahnbreite
export const WALK_HW = 6.5; // inkl. Gehweg

export type Mover =
  | { kind: 'car'; axis: 'x' | 'z'; dir: 1 | -1; speed: number; lane: number }
  | { kind: 'walk'; axis: 'x' | 'z' | null; dir: 1 | -1; speed: number; lane: number; heading: number; min: number; max: number };

export interface Spawn {
  type: ObjType;
  x: number; z: number; rot: number;
  color: number;
  mover?: Mover;
}

/** deterministischer Zufall (mulberry32) */
export function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type BlockKind = 'city' | 'park' | 'homes';
interface Block { x0: number; x1: number; z0: number; z1: number; kind: BlockKind; downtown: number }

export function generateCity(seed: number): { spawns: Spawn[]; ground: THREE.CanvasTexture } {
  const R = rng(seed);
  const pick = <T,>(a: readonly T[]) => a[Math.floor(R() * a.length)];
  const spawns: Spawn[] = [];
  const add = (type: ObjType, x: number, z: number, rot = R() * Math.PI * 2, mover?: Mover) =>
    spawns.push({ type, x, z, rot, color: pick(type.palette), mover });

  // Blockgrenzen
  const edges: [number, number][] = [];
  const cuts = [-HALF, ...ROADS.flatMap((c) => [c - WALK_HW, c + WALK_HW]), HALF];
  for (let i = 0; i < cuts.length; i += 2) edges.push([cuts[i], cuts[i + 1]]);

  const blocks: Block[] = [];
  for (const [x0, x1] of edges) for (const [z0, z1] of edges) {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const dist = Math.hypot(cx, cz) / HALF; // 0 Mitte .. ~1.4 Ecke
    const thin = x1 - x0 < 25 || z1 - z0 < 25;
    let kind: BlockKind;
    const r = R();
    if (thin) kind = r < 0.55 ? 'homes' : 'park';
    else if (dist < 0.75) kind = r < 0.85 ? 'city' : 'park';
    else kind = r < 0.45 ? 'city' : r < 0.75 ? 'homes' : 'park';
    blocks.push({ x0, x1, z0, z1, kind, downtown: Math.max(0, 1 - dist) });
  }

  // ---------- Bodentextur ----------
  const PX = 2048, S = PX / (HALF * 2);
  const cv = document.createElement('canvas');
  cv.width = cv.height = PX;
  const g = cv.getContext('2d')!;
  const X = (v: number) => (v + HALF) * S;
  const rect = (x0: number, z0: number, x1: number, z1: number, col: string) => {
    g.fillStyle = col; g.fillRect(X(x0), X(z0), (x1 - x0) * S, (z1 - z0) * S);
  };
  rect(-HALF, -HALF, HALF, HALF, '#8fd16c');
  for (const b of blocks) {
    if (b.kind === 'city') {
      rect(b.x0, b.z0, b.x1, b.z1, '#e4ddd0');
      g.strokeStyle = 'rgba(0,0,0,0.05)'; g.lineWidth = 1;
      for (let x = b.x0; x < b.x1; x += 2) { g.beginPath(); g.moveTo(X(x), X(b.z0)); g.lineTo(X(x), X(b.z1)); g.stroke(); }
      for (let z = b.z0; z < b.z1; z += 2) { g.beginPath(); g.moveTo(X(b.x0), X(z)); g.lineTo(X(b.x1), X(z)); g.stroke(); }
    } else if (b.kind === 'park') {
      rect(b.x0, b.z0, b.x1, b.z1, '#7cc95b');
      g.strokeStyle = '#efe2c2'; g.lineWidth = 2.2 * S; g.lineCap = 'round';
      g.beginPath(); g.moveTo(X(b.x0), X(b.z0)); g.lineTo(X(b.x1), X(b.z1));
      g.moveTo(X(b.x1), X(b.z0)); g.lineTo(X(b.x0), X(b.z1)); g.stroke();
      const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
      const rr = Math.min(b.x1 - b.x0, b.z1 - b.z0) * 0.18;
      g.fillStyle = '#efe2c2'; g.beginPath(); g.arc(X(cx), X(cz), rr * S * 1.4, 0, 7); g.fill();
      g.fillStyle = '#5fb3e6'; g.beginPath(); g.arc(X(cx), X(cz), rr * S, 0, 7); g.fill();
    } else {
      rect(b.x0, b.z0, b.x1, b.z1, '#9edb78');
    }
  }
  for (const c of ROADS) {
    rect(c - WALK_HW, -HALF, c + WALK_HW, HALF, '#d6d2ca');
    rect(-HALF, c - WALK_HW, HALF, c + WALK_HW, '#d6d2ca');
  }
  for (const c of ROADS) {
    rect(c - ROAD_HW - 0.25, -HALF, c + ROAD_HW + 0.25, HALF, '#b9b4ab');
    rect(-HALF, c - ROAD_HW - 0.25, HALF, c + ROAD_HW + 0.25, '#b9b4ab');
  }
  for (const c of ROADS) {
    rect(c - ROAD_HW, -HALF, c + ROAD_HW, HALF, '#596070');
    rect(-HALF, c - ROAD_HW, HALF, c + ROAD_HW, '#596070');
  }
  const nearCross = (t: number, m: number) => ROADS.some((c) => Math.abs(t - c) < m);
  for (const c of ROADS) {
    for (let t = -HALF; t < HALF; t += 4) {
      if (nearCross(t + 1, WALK_HW + 1.5)) continue;
      rect(c - 0.12, t, c + 0.12, t + 2, '#f4f1e8');
      rect(t, c - 0.12, t + 2, c + 0.12, '#f4f1e8');
    }
    // Zebrastreifen
    for (const c2 of ROADS) {
      for (let k = -ROAD_HW + 0.5; k < ROAD_HW; k += 1.2) {
        for (const side of [-1, 1]) {
          const o = c2 + side * (ROAD_HW + 1.2);
          rect(c + k, o - 0.9, c + k + 0.6, o + 0.9, '#f4f1e8');
          rect(o - 0.9, c + k, o + 0.9, c + k + 0.6, '#f4f1e8');
        }
      }
    }
  }
  const ground = new THREE.CanvasTexture(cv);
  ground.colorSpace = THREE.SRGBColorSpace;
  ground.anisotropy = 8;

  // ---------- Straßenmöbel & Verkehr ----------
  for (const c of ROADS) {
    for (const axis of ['x', 'z'] as const) {
      const at = (along: number, off: number): [number, number] => (axis === 'x' ? [along, c + off] : [c + off, along]);
      const rotAlong = axis === 'x' ? 0 : -Math.PI / 2;
      for (let t = -HALF + 6; t < HALF - 4; t += 2) {
        if (nearCross(t, WALK_HW + 2)) continue;
        for (const side of [-1, 1]) {
          const r = R();
          // Gehweg
          if (Math.round(t) % 16 === 0) add(T.lamp, ...at(t, side * 5.9), side > 0 ? rotAlong + Math.PI / 2 : rotAlong - Math.PI / 2);
          else if (r < 0.025) add(T.hydrant, ...at(t, side * 5.8));
          else if (r < 0.05) add(T.trash, ...at(t, side * 5.8));
          else if (r < 0.065) add(T.bench, ...at(t, side * 5.9), rotAlong + (side > 0 ? Math.PI : 0));
          else if (r < 0.085) add(T.tree, ...at(t, side * 5.6));
          if (R() < 0.07) {
            const lane = c + side * (5 + R() * 0.6);
            const dir = R() < 0.5 ? 1 : -1;
            const [x, z] = at(t, lane - c);
            add(T.person, x, z, 0, { kind: 'walk', axis, dir, speed: 1.1 + R() * 0.8, lane, heading: 0, min: -HALF + 2, max: HALF - 2 });
          }
          // Parkende Autos / Pylonen am Rand
          const r2 = R();
          if (r2 < 0.06 && !nearCross(t, WALK_HW + 4)) add(T.car, ...at(t, side * 3.5), rotAlong + (R() < 0.5 ? 0 : Math.PI));
          else if (r2 < 0.07) add(T.cone, ...at(t, side * (1 + R() * 2.5)));
        }
      }
      // Fließender Verkehr
      for (const side of [-1, 1] as const) {
        const laneSpeed = 5.5 + R() * 3;
        let t = -HALF + 4 + R() * 10;
        while (t < HALF - 4) {
          const isBus = R() < 0.12;
          const [x, z] = at(t, side * 1.9);
          const dir = side as 1 | -1;
          const rot = rotAlong + (dir < 0 ? Math.PI : 0);
          add(isBus ? T.bus : T.car, x, z, rot, { kind: 'car', axis, dir, speed: laneSpeed, lane: c + side * 1.9 });
          t += 18 + R() * 30;
        }
      }
    }
  }

  // ---------- Blöcke ----------
  for (const b of blocks) {
    const occ: [number, number, number][] = [];
    const free = (x: number, z: number, r: number) =>
      x - r > b.x0 + 0.3 && x + r < b.x1 - 0.3 && z - r > b.z0 + 0.3 && z + r < b.z1 - 0.3 &&
      occ.every(([ox, oz, or]) => Math.hypot(ox - x, oz - z) > or + r);
    const place = (type: ObjType, x: number, z: number, r: number, rot?: number, mover?: Mover) => {
      if (!free(x, z, r)) return false;
      occ.push([x, z, r]); add(type, x, z, rot, mover); return true;
    };
    const scatter = (type: ObjType, n: number, r: number) => {
      for (let i = 0, tries = 0; i < n && tries < n * 12; tries++) {
        if (place(type, b.x0 + R() * (b.x1 - b.x0), b.z0 + R() * (b.z1 - b.z0), r)) i++;
      }
    };
    const wanderers = (n: number) => {
      for (let i = 0; i < n; i++) {
        const x = b.x0 + 1 + R() * (b.x1 - b.x0 - 2), z = b.z0 + 1 + R() * (b.z1 - b.z0 - 2);
        if (!free(x, z, 0.3)) continue;
        const m: Mover = { kind: 'walk', axis: null, dir: 1, speed: 0.8 + R() * 0.8, lane: 0, heading: R() * Math.PI * 2, min: 0, max: 0 };
        add(T.person, x, z, 0, R() < 0.6 ? m : undefined);
      }
    };
    const W = b.x1 - b.x0, D = b.z1 - b.z0;
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;

    if (b.kind === 'city') {
      const nx = W > 30 && R() < 0.6 ? 3 : 2, nz = D > 30 && R() < 0.6 ? 3 : 2;
      const lw = W / nx, ld = D / nz;
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
        const lx = b.x0 + lw * (i + 0.5), lz = b.z0 + ld * (j + 0.5);
        if (R() < 0.12) { // kleiner Platz
          place(T.kiosk, lx, lz, 1.8, R() * 6);
          for (let k = 0; k < 4; k++) place(T.tree, lx + (k % 2 ? 1 : -1) * lw * 0.3, lz + (k < 2 ? 1 : -1) * ld * 0.3, 1.2);
          continue;
        }
        const rotate = R() < 0.5;
        const fits = BUILDINGS.filter((B) => {
          const [w, d] = rotate ? [B.d, B.w] : [B.w, B.d];
          return w <= lw - 2 && d <= ld - 2;
        });
        if (!fits.length) continue;
        // in der Innenstadt eher die großen
        const bias = Math.min(fits.length - 1, Math.floor(Math.pow(R(), 1.4 - b.downtown) * fits.length + b.downtown * 2));
        const B = fits[Math.max(0, Math.min(fits.length - 1, bias))];
        const [w, d] = rotate ? [B.d, B.w] : [B.w, B.d];
        const jx = (lw - 2 - w) * (R() - 0.5), jz = (ld - 2 - d) * (R() - 0.5);
        const bx = lx + jx, bz = lz + jz;
        occ.push([bx, bz, Math.hypot(w, d) / 2]);
        add(B.type, bx, bz, rotate ? Math.PI / 2 : 0);
      }
      scatter(T.tree, 4, 1.1);
      scatter(T.bush, 5, 0.6);
      scatter(T.bench, 3, 0.9);
      scatter(T.trash, 2, 0.35);
      wanderers(6 + Math.floor(R() * 6));
    } else if (b.kind === 'homes') {
      const nx = Math.max(1, Math.round(W / 11)), nz = Math.max(1, Math.round(D / 11));
      const lw = W / nx, ld = D / nz;
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
        const lx = b.x0 + lw * (i + 0.5), lz = b.z0 + ld * (j + 0.5);
        place(T.house, lx + (R() - 0.5) * (lw - 7), lz + (R() - 0.5) * (ld - 7), 2.9, Math.floor(R() * 4) * Math.PI / 2);
        if (R() < 0.35) place(T.car, lx + (R() - 0.5) * lw * 0.6, lz + (R() - 0.5) * ld * 0.6, 1.3);
      }
      scatter(T.tree, Math.round(W * D / 70), 1.1);
      scatter(T.bush, Math.round(W * D / 60), 0.6);
      wanderers(3 + Math.floor(R() * 3));
    } else {
      // Park mit Brunnen in der Mitte (freihalten)
      occ.push([cx, cz, Math.min(W, D) * 0.18 * 1.4 + 0.5]);
      scatter(T.tree, Math.round(W * D / 45), 1.1);
      scatter(T.bush, Math.round(W * D / 70), 0.6);
      scatter(T.bench, 6, 0.9);
      scatter(T.trash, 3, 0.35);
      if (W > 25 && D > 25 && R() < 0.6) scatter(T.kiosk, 1, 1.8);
      wanderers(10 + Math.floor(R() * 8));
    }
  }
  return { spawns, ground };
}
