// Railways in 3D: a smoothed track bed (ballast, sleepers, two rails) that follows embankments and cuttings,
// rides over bridge decks, and carries trains that enter from the map edge and pass through.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { pick, rand, type XY } from './geo';
import { buildGraph, nodeKey, pointAt, type Edge } from './graph';

type Height = (x: number, y: number) => number;
export type RailWay = { pts: XY[]; bridgeAt?: Height; tunnel?: boolean };

const GAUGE = 1.435, RAIL_TOP = 0.55;

// ---------- track profile ----------

function densify(pts: XY[], step: number): XY[] {
  const out: XY[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= n; k++) out.push([ax + (bx - ax) * k / n, ay + (by - ay) * k / n]);
  }
  return out;
}
function cumulative(pts: XY[]) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return cum;
}

/**
 * Track bed height along a way: terrain averaged over ±12 m (railways are smooth; the 1 m terrain is not),
 * pinned to shared anchor heights at the ends so neighbouring ways (and bridge decks) join without steps.
 */
function profile(pts: XY[], cum: number[], H: Height, anchors: Map<string, number>, bridgeAt?: Height) {
  if (bridgeAt) return pts.map(([x, y]) => bridgeAt(x, y));
  const raw = pts.map(([x, y]) => H(x, y)), out = new Array<number>(pts.length), L = cum[cum.length - 1];
  for (let i = 0, a = 0, b = 0, sum = 0; i < pts.length; i++) {
    while (b < pts.length && cum[b] <= cum[i] + 12) sum += raw[b++];
    while (cum[a] < cum[i] - 12) sum -= raw[a++];
    out[i] = sum / (b - a);
  }
  const h0 = anchors.get(nodeKey(pts[0])) ?? raw[0], h1 = anchors.get(nodeKey(pts[pts.length - 1])) ?? raw[raw.length - 1];
  for (let i = 0; i < pts.length; i++) {
    const w0 = Math.max(0, 1 - cum[i] / 15), w1 = Math.max(0, 1 - (L - cum[i]) / 15);
    out[i] += (h0 - out[i]) * w0;
    out[i] += (h1 - out[i]) * w1;
  }
  return out;
}

/** Surface height near a track (projected onto its centre line). */
function surfaceAt(pts: XY[], hs: number[]): Height {
  return (x, y) => {
    let best = Infinity, bi = 1, bt = 0;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      const d = (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2;
      if (d < best) { best = d; bi = i; bt = t; }
    }
    return hs[bi - 1] + (hs[bi] - hs[bi - 1]) * bt;
  };
}

// ---------- track geometry ----------

function colorize(g: THREE.BufferGeometry, hex: string) {
  const geo = g.index ? g.toNonIndexed() : g, c = new THREE.Color(hex);
  const a = new Float32Array(geo.attributes.position.count * 3);
  for (let i = 0; i < a.length; i += 3) { a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  geo.deleteAttribute('uv');
  geo.computeVertexNormals();
  return geo;
}

/** Box swept along the line: lateral offsets (left/right) and vertical offsets (top/bottom) from the profile. */
function sweep(pts: XY[], hs: number[], left: number, right: number, top: number, bottom: number, topInset = 0) {
  const pos: number[] = [];
  const ring = (i: number) => {
    const p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1]; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const rx = dy, ry = -dx, h = hs[i];
    const at = (o: number, z: number) => new THREE.Vector3(p[0] + rx * o, h + z, -(p[1] + ry * o));
    return [at(left + topInset, top), at(right - topInset, top), at(right, bottom), at(left, bottom)];
  };
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) =>
    pos.push(a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z, a.x, a.y, a.z, d.x, d.y, d.z, c.x, c.y, c.z);
  let prev = ring(0);
  for (let i = 1; i < pts.length; i++) {
    const cur = ring(i);
    quad(prev[0], prev[1], cur[1], cur[0]);
    quad(prev[1], prev[2], cur[2], cur[1]);
    quad(prev[3], prev[0], cur[0], cur[3]);
    prev = cur;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

// ---------- trains ----------

type CarSpec = { len: number; geo: THREE.BufferGeometry };
const geoCache = new Map<string, THREE.BufferGeometry>();

function box(w: number, h: number, l: number, x: number, y: number, z = 0) { return new THREE.BoxGeometry(l, h, w).translate(x, y, z); }

/** Side-profile slab (x forward, y up) extruded across the width. */
function slab(points: [number, number][], width: number) {
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y))), { depth: width, bevelEnabled: false });
  return g.translate(0, 0, -width / 2);
}

/** Passenger multiple unit car (Pågatåg-style purple livery). `nose`: 1 = streamlined front, -1 = rear cab, 0 = middle. */
function emuCar(nose: number) {
  const key = 'emu' + nose;
  if (geoCache.has(key)) return geoCache.get(key)!;
  const L = 26, half = L / 2, W = 3.0, parts: THREE.BufferGeometry[] = [];
  const body = (n: number) => {
    const f = n === 1 ? half : half, r = -half;
    const pts: [number, number][] = [[r, 1.0], [f - (n ? 1.6 : 0), 1.0], [f, 1.5], [f, 2.6], [f - (n ? 2.4 : 0), 4.1], [r + 0.2, 4.1], [r, 3.8]];
    return slab(pts, W);
  };
  let b = body(Math.abs(nose));
  if (nose === -1) b = b.rotateY(Math.PI);
  parts.push(colorize(b, '#5a2a82'));
  parts.push(colorize(box(W + 0.04, 0.85, L - (nose ? 3.2 : 1.2), nose * -0.9, 2.75), '#1c2430'));      // window band
  parts.push(colorize(box(W - 0.3, 0.3, L - (nose ? 3 : 0.6), nose * -0.9, 4.2), '#c9c9c9'));          // roof
  parts.push(colorize(box(W + 0.05, 0.18, L - (nose ? 2.6 : 0.4), nose * -0.6, 1.9), '#f2c230'));      // yellow stripe
  for (const x of [half - 3.5, -half + 3.5]) parts.push(colorize(box(2.4, 0.7, 3.2, x, 0.75), '#2a2a2c'));
  if (nose) parts.push(colorize(box(1.6, 0.9, 0.08, nose * (half + 0.03), 3.0), '#1c2430'));            // windscreen
  const g = mergeGeometries(parts.map(p => p.index ? p.toNonIndexed() : p));
  geoCache.set(key, g);
  return g;
}

function locomotive() {
  if (geoCache.has('loco')) return geoCache.get('loco')!;
  const L = 19, half = L / 2, W = 3.0, parts: THREE.BufferGeometry[] = [];
  parts.push(colorize(slab([[-half, 1.1], [half, 1.1], [half, 2.7], [half - 0.9, 4.2], [-half + 0.9, 4.2], [-half, 2.7]], W), '#2e6b3f'));
  for (const s of [1, -1]) parts.push(colorize(box(W * 0.8, 0.8, 0.08, s * (half - 0.3), 3.3), '#1c2430'));
  parts.push(colorize(box(W + 0.04, 0.3, L - 2, 0, 1.6), '#f2f2ee'));
  parts.push(colorize(box(1.2, 0.6, 3, 0, 4.4), '#555a5e'));
  for (const x of [half - 3.2, -half + 3.2]) parts.push(colorize(box(2.4, 0.8, 3.4, x, 0.75), '#2a2a2c'));
  const g = mergeGeometries(parts.map(p => p.index ? p.toNonIndexed() : p));
  geoCache.set('loco', g);
  return g;
}

function wagon(kind: 'box' | 'tank' | 'flat', color: string) {
  const key = kind + color;
  if (geoCache.has(key)) return geoCache.get(key)!;
  const L = 15, parts: THREE.BufferGeometry[] = [colorize(box(2.9, 0.4, L, 0, 1.2), '#3a3a3c')];
  if (kind === 'box') parts.push(colorize(box(2.9, 2.6, L - 0.6, 0, 2.7), color));
  if (kind === 'tank') parts.push(colorize(new THREE.CylinderGeometry(1.35, 1.35, L - 1.4, 14).rotateZ(Math.PI / 2).translate(0, 2.8, 0), color));
  if (kind === 'flat') parts.push(colorize(box(2.4, 1.2, L - 3, 0, 2.0), color)); // timber / load
  for (const x of [L / 2 - 2.5, -L / 2 + 2.5]) parts.push(colorize(box(2.4, 0.7, 2.6, x, 0.7), '#2a2a2c'));
  const g = mergeGeometries(parts.map(p => p.index ? p.toNonIndexed() : p));
  geoCache.set(key, g);
  return g;
}

function makeConsist(): { cars: CarSpec[]; speed: number; name: string } {
  if (Math.random() < 0.65) {
    const n = pick([2, 3, 3, 4]);
    return { name: 'Passenger train', speed: rand(110, 140) / 3.6, cars: Array.from({ length: n }, (_, i) => ({ len: 26, geo: emuCar(i === 0 ? 1 : i === n - 1 ? -1 : 0) })) };
  }
  const n = Math.round(rand(8, 18));
  const loads = [['box', '#7b3b2a'], ['box', '#4b5a63'], ['tank', '#2f3438'], ['flat', '#9b7a4c'], ['box', '#8a2f2a']] as const;
  return { name: 'Freight train', speed: rand(70, 90) / 3.6, cars: [{ len: 19, geo: locomotive() }, ...Array.from({ length: n }, () => { const [k, c] = pick([...loads]); return { len: 15, geo: wagon(k, c) }; })] };
}

export type Train = { meshes: THREE.Mesh[]; cars: CarSpec[]; path: Edge[]; head: number; v: number; vmax: number; length: number; name: string };
type Entry = { edge: Edge; s: number };

export class Railway {
  readonly group = new THREE.Group();
  private edges: Edge[] = []; private out = new Map<string, number[]>();
  private surface = new Map<number, Height>(); // edge id -> rail-bed height
  readonly trains: Train[] = [];
  private material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.3 }); // semi-gloss paint
  private nextSpawn = rand(1, 4);
  private entries: Entry[] = [];

  constructor(ways: RailWay[], H: Height, private R: number) {
    // anchor heights at way ends: bridge deck ends win, so the track meets the deck level
    const anchors = new Map<string, number>();
    for (const w of ways) if (w.bridgeAt) for (const p of [w.pts[0], w.pts[w.pts.length - 1]]) anchors.set(nodeKey(p), w.bridgeAt(p[0], p[1]));

    const ballast: THREE.BufferGeometry[] = [], steel: THREE.BufferGeometry[] = [], sleepers: THREE.Matrix4[] = [];
    const graphWays: { pts: XY[]; highway: string; oneway: boolean; lane: number; deckAt?: Height; tunnel?: boolean }[] = [];
    for (const w of ways) {
      const pts = densify(w.pts, 3), cum = cumulative(pts), hs = profile(pts, cum, H, anchors, w.bridgeAt);
      const at = surfaceAt(pts, hs);
      graphWays.push({ pts: w.pts, highway: 'rail', oneway: false, lane: 0, deckAt: at, tunnel: w.tunnel });
      if (w.tunnel) continue;
      if (!w.bridgeAt) ballast.push(colorize(sweep(pts, hs, -2.3, 2.3, 0.32, -0.9, 0.6), '#8c877f'));
      for (const o of [-GAUGE / 2, GAUGE / 2]) steel.push(colorize(sweep(pts, hs, o - 0.04, o + 0.04, RAIL_TOP, 0.4), '#8a8d92'));
      // sleepers every 0.65 m, oriented across the track
      const L = cum[cum.length - 1];
      for (let s = 0.3; s < L; s += 0.65) {
        let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
        const t = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
        const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
        const x = ax + (bx - ax) * t, y = ay + (by - ay) * t, h = hs[i - 1] + (hs[i] - hs[i - 1]) * t;
        sleepers.push(new THREE.Matrix4().compose(new THREE.Vector3(x, h + 0.36, -y),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(by - ay, bx - ax)), new THREE.Vector3(1, 1, 1)));
      }
    }
    const add = (geos: THREE.BufferGeometry[]) => {
      if (!geos.length) return;
      const m = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide }));
      m.receiveShadow = true; m.castShadow = false;
      this.group.add(m);
    };
    add(ballast); add(steel);
    if (sleepers.length) {
      const im = new THREE.InstancedMesh(new THREE.BoxGeometry(0.24, 0.14, 2.6), new THREE.MeshStandardMaterial({ color: '#9b978e' }), sleepers.length);
      sleepers.forEach((m, i) => im.setMatrixAt(i, m));
      im.receiveShadow = true;
      this.group.add(im);
    }

    // graph for trains; surface height per edge comes from its way
    ({ edges: this.edges, out: this.out } = buildGraph(graphWays));
    for (const e of this.edges) if (e.deckAt) this.surface.set(e.id, e.deckAt);
    // trains enter where a line crosses into the map: start ~150 m before the edge (hidden by the map clipping)
    const inside = ([x, y]: XY) => Math.abs(x) < R - 5 && Math.abs(y) < R - 5;
    for (const e of this.edges) {
      if (inside(e.pts[0])) continue;
      for (let s = 0; s < e.len; s += 5) if (inside(pointAt(e, s))) { this.entries.push({ edge: e, s: Math.max(0, s - 150) }); break; }
    }
    if (this.entries.length) this.spawn(true);
  }

  dispose() { this.group.removeFromParent(); this.material.dispose(); }

  private choose(e: Edge): Edge | null {
    const opts = (this.out.get(e.to) ?? []).map(i => this.edges[i]).filter(n => n.id !== e.twin);
    if (!opts.length) return null;
    const [ax, ay] = e.pts[e.pts.length - 2], [bx, by] = e.pts[e.pts.length - 1], din = Math.atan2(by - ay, bx - ax);
    // trains can't turn sharply: take the straightest continuation
    return opts.reduce((best, n) => {
      const dir = Math.atan2(n.pts[1][1] - n.pts[0][1], n.pts[1][0] - n.pts[0][0]);
      const c = Math.cos(dir - din);
      return c > best.c ? { n, c } : best;
    }, { n: opts[0], c: -2 }).n;
  }

  /** `midway`: start already inside the map (used on load, so there's always a train to see). */
  private spawn(midway = false) {
    if (!this.entries.length) return;
    const start = pick(this.entries), consist = makeConsist();
    const length = consist.cars.reduce((s, c) => s + c.len + 1, 0);
    const meshes = consist.cars.map(c => { const m = new THREE.Mesh(c.geo, this.material); m.castShadow = true; this.group.add(m); return m; });
    const train: Train = { meshes, cars: consist.cars, path: [start.edge], head: start.s + (midway ? 150 + length + rand(100, 400) : 0), v: consist.speed * 0.85, vmax: consist.speed, length, name: consist.name };
    for (const m of meshes) m.userData.vehicle = { kind: 'train', train };
    this.trains.push(train);
  }

  /** Point and rail-bed height at distance d along a train's path (d may run back past the start: clamped). */
  private sample(t: Train, d: number): [number, number, number] {
    let acc = 0;
    for (const e of t.path) {
      if (d <= acc + e.len || e === t.path[t.path.length - 1]) {
        const [x, y] = pointAt(e, d - acc);
        const h = this.surface.get(e.id)?.(x, y) ?? 0;
        return [x, y, h];
      }
      acc += e.len;
    }
    return [0, 0, 0];
  }

  update(dt: number) {
    dt = Math.min(dt, 0.05);
    if (!dt) return;
    // always keep a train on the line: refill quickly when it's empty, sometimes add a second one
    this.nextSpawn -= dt;
    if (!this.trains.length && this.nextSpawn > 4) this.nextSpawn = rand(1, 4);
    if (this.nextSpawn <= 0 && this.trains.length < 2) { this.spawn(); this.nextSpawn = rand(20, 45); }

    for (const t of [...this.trains]) {
      t.v += (t.vmax - t.v) * Math.min(1, dt * 0.3);
      t.head += t.v * dt;
      // extend the path ahead; trim edges far behind the tail
      let total = t.path.reduce((s, e) => s + e.len, 0);
      while (t.head > total - 5) {
        const n = this.choose(t.path[t.path.length - 1]);
        if (!n) break;
        t.path.push(n); total += n.len;
      }
      while (t.path.length > 1 && t.head - t.length - 30 > t.path[0].len) { t.head -= t.path[0].len; t.path.shift(); }

      // place each car on its two bogies
      let d = t.head;
      t.cars.forEach((c, i) => {
        const f = this.sample(t, d - c.len * 0.18), r = this.sample(t, d - c.len * 0.82);
        const m = t.meshes[i];
        m.position.set((f[0] + r[0]) / 2, (f[2] + r[2]) / 2 + RAIL_TOP - 0.05, -(f[1] + r[1]) / 2);
        m.rotation.set(0, Math.atan2(f[1] - r[1], f[0] - r[0]), Math.atan2(f[2] - r[2], Math.hypot(f[0] - r[0], f[1] - r[1])), 'YZX');
        m.visible = d - c.len >= 0;
        d -= c.len + 1;
      });

      // gone: the whole train has left the map (or hit the end of the line)
      const tail = this.sample(t, t.head - t.length);
      const atEnd = t.head >= total - 1;
      if ((Math.abs(tail[0]) > this.R + 60 || Math.abs(tail[1]) > this.R + 60) && t.head > t.length + 100 || atEnd) {
        for (const m of t.meshes) m.removeFromParent();
        this.trains.splice(this.trains.indexOf(t), 1);
      }
    }
  }
}
