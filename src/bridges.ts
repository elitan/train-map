// Bridges: the 1 m terrain is bare earth (bridges removed), so roads/rails tagged bridge=* get a real deck
// spanning between their two ends, with railings and, for longer spans, supports down to the ground.
import * as THREE from 'three';
import type { XY } from './geo';

type Height = (x: number, y: number) => number;
export type Bridge = { pts: XY[]; width: number; rail: boolean };

/** Deck height at both ends: the higher of the end point and a few meters beyond it (the solid bank). */
export function deckEnds(pts: XY[], H: Height): [number, number] {
  const end = (p: XY, q: XY) => {
    const dx = p[0] - q[0], dy = p[1] - q[1], l = Math.hypot(dx, dy) || 1;
    return Math.max(H(p[0], p[1]), H(p[0] + dx / l * 4, p[1] + dy / l * 4));
  };
  return [end(pts[0], pts[1]), end(pts[pts.length - 1], pts[pts.length - 2])];
}

/** Height of the deck surface at fraction t (0..1) along the bridge: straight line plus a slight camber. */
export function deckHeight(ends: [number, number], len: number, t: number) {
  return ends[0] + (ends[1] - ends[0]) * t + Math.min(0.5, len * 0.012) * Math.sin(Math.PI * t) + 0.25;
}

function cumulative(pts: XY[]) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return cum;
}

function colorize(g: THREE.BufferGeometry, hex: string) {
  const geo = g.index ? g.toNonIndexed() : g, c = new THREE.Color(hex);
  const a = new Float32Array(geo.attributes.position.count * 3);
  for (let i = 0; i < a.length; i += 3) { a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  geo.deleteAttribute('uv');
  geo.computeVertexNormals();
  return geo;
}

/**
 * A swept box along the bridge centre line. `top` and `bottom` are vertical offsets from the deck surface,
 * `left`/`right` lateral offsets (meters, right = positive).
 */
function sweep(pts: XY[], hAt: (i: number) => number, left: number, right: number, top: number, bottom: number) {
  const pos: number[] = [];
  const ring = (i: number) => {
    const p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1]; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const rx = dy, ry = -dx, h = hAt(i);
    const at = (o: number, z: number) => new THREE.Vector3(p[0] + rx * o, h + z, -(p[1] + ry * o));
    return [at(left, top), at(right, top), at(right, bottom), at(left, bottom)]; // TL TR BR BL
  };
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) =>
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
  let prev = ring(0);
  quad(prev[0], prev[3], prev[2], prev[1]); // start cap
  for (let i = 1; i < pts.length; i++) {
    const cur = ring(i);
    quad(prev[0], prev[1], cur[1], cur[0]); // top
    quad(prev[1], prev[2], cur[2], cur[1]); // right side
    quad(prev[2], prev[3], cur[3], cur[2]); // bottom
    quad(prev[3], prev[0], cur[0], cur[3]); // left side
    prev = cur;
  }
  quad(prev[0], prev[1], prev[2], prev[3]); // end cap
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

/** Deck height at any point near the bridge (projected onto its centre line), for cars driving across. */
export function makeDeckAt(pts: XY[], H: Height) {
  const cum = cumulative(pts), len = cum[cum.length - 1], ends = deckEnds(pts, H);
  return (x: number, y: number) => {
    let best = Infinity, bestS = 0;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
      if (d < best) { best = d; bestS = cum[i - 1] + t * (cum[i] - cum[i - 1]); }
    }
    return deckHeight(ends, len, bestS / (len || 1));
  };
}

export const isBridge = (t: Record<string, string>) => !!t.bridge && t.bridge !== 'no';
export const isTunnel = (t: Record<string, string>) => !!t.tunnel && t.tunnel !== 'no' && t.tunnel !== 'building_passage';

export function bridgeGeometry({ pts, width, rail }: Bridge, H: Height): THREE.BufferGeometry[] {
  if (pts.length < 2) return [];
  const cum = cumulative(pts), len = cum[cum.length - 1];
  const ends = deckEnds(pts, H);
  const hAt = (i: number) => deckHeight(ends, len, cum[i] / len);
  const half = width / 2 + 0.6;
  const out: THREE.BufferGeometry[] = [];
  // deck: surface + concrete edge beams, double-sided enough to read from below
  out.push(colorize(sweep(pts, hAt, -half + 0.4, half - 0.4, 0.02, -0.12), rail ? '#6b5f55' : '#5f5f62'));
  out.push(colorize(sweep(pts, hAt, -half, half, -0.05, -0.9), '#b9b5ac'));
  // railings / parapets
  for (const side of [-1, 1]) out.push(colorize(sweep(pts, hAt, side * half - 0.12, side * half + 0.12, 1.0, -0.05), '#9aa0a5'));
  // supports for longer spans, where the ground is well below the deck
  if (len > 22) {
    const n = Math.floor(len / 18);
    for (let k = 1; k <= n; k++) {
      const s = (k / (n + 1)) * len;
      let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
      const t = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
      const x = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, y = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t;
      const top = deckHeight(ends, len, s / len) - 0.9, ground = H(x, y) - 0.5;
      if (top - ground < 3) continue;
      const pier = new THREE.BoxGeometry(1.2, top - ground, width * 0.7);
      const dir = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
      pier.rotateY(dir).translate(x, (top + ground) / 2, -y);
      out.push(colorize(pier, '#b0aca3'));
    }
  }
  return out;
}
