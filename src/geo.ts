// Geometry helpers: local metric projection, OSM polygon assembly, hit tests.

export type XY = [number, number]; // [east, north] in meters from the map center
export type LatLon = { lat: number; lon: number };
export type Poly = { outer: XY[]; holes: XY[][] };

export type OsmMember = { type: string; ref: number; role: string; geometry?: LatLon[] };
export type OsmElement = {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: LatLon[];
  members?: OsmMember[];
  _polys?: Poly[];
};
export type OsmData = { elements: OsmElement[] };

const M_LAT = 110540;

/** Equirectangular projection around a center point; accurate enough for a few km. */
export class LocalProjection {
  constructor(public lat0: number, public lon0: number) {}
  get mLon() { return 111320 * Math.cos(this.lat0 * Math.PI / 180); }
  get mLat() { return M_LAT; }
  proj(lat: number, lon: number): XY { return [(lon - this.lon0) * this.mLon, (lat - this.lat0) * M_LAT]; }
  unproj(x: number, y: number): [number, number] { return [this.lat0 + y / M_LAT, this.lon0 + x / this.mLon]; }
  bbox(R: number) {
    const dLat = R / M_LAT, dLon = R / this.mLon;
    return { s: this.lat0 - dLat, w: this.lon0 - dLon, n: this.lat0 + dLat, e: this.lon0 + dLon };
  }
}

export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];

export function pip(x: number, y: number, ring: XY[]) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
export const inPoly = (x: number, y: number, p: Poly) => pip(x, y, p.outer) && !p.holes.some(h => pip(x, y, h));

export function segDist(x: number, y: number, pts: XY[]) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

const key = (p: LatLon) => p.lat.toFixed(7) + ',' + p.lon.toFixed(7);

/** Join relation member ways end-to-end into closed rings. */
function stitch(segs: LatLon[][]) {
  const rest = segs.map(s => s.slice());
  const rings: LatLon[][] = [];
  while (rest.length) {
    let cur = rest.shift()!;
    let guard = 0;
    while (key(cur[0]) !== key(cur[cur.length - 1]) && guard++ < 2000) {
      const end = key(cur[cur.length - 1]);
      const i = rest.findIndex(s => key(s[0]) === end || key(s[s.length - 1]) === end);
      if (i < 0) break;
      const s = rest.splice(i, 1)[0];
      if (key(s[0]) !== end) s.reverse();
      cur = cur.concat(s.slice(1));
    }
    rings.push(cur);
  }
  return rings;
}

export const toXY = (P: LocalProjection, g: LatLon[]) => g.map(p => P.proj(p.lat, p.lon));

/** Polygons (with holes) for a closed way or multipolygon relation; cached on the element. */
export function polygons(P: LocalProjection, el: OsmElement): Poly[] {
  if (el._polys) return el._polys;
  let out: Poly[] = [];
  if (el.type === 'way') {
    if (el.geometry && el.geometry.length >= 4) out = [{ outer: toXY(P, el.geometry), holes: [] }];
  } else if (el.type === 'relation' && el.members) {
    const ways = (inner: boolean) => el.members!
      .filter(m => m.type === 'way' && m.geometry?.length && (inner ? m.role === 'inner' : m.role !== 'inner'))
      .map(m => m.geometry!);
    out = stitch(ways(false)).filter(r => r.length > 3).map(r => ({ outer: toXY(P, r), holes: [] }));
    for (const r of stitch(ways(true))) {
      const xy = toXY(P, r);
      const o = out.find(o => pip(xy[0][0], xy[0][1], o.outer));
      if (o) o.holes.push(xy);
    }
  }
  return (el._polys = out);
}
