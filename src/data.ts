// Open data, fetched straight from the browser: place search (Nominatim), railways (Overpass),
// elevation (Terrarium tiles) and aerial photos (Esri World Imagery).
import type { LatLon } from './geo';

export type BBox = { s: number; w: number; n: number; e: number };
export type Elevation = (lat: number, lon: number) => number;
export type RailTags = Record<string, string>;
export type RailWayData = { tags: RailTags; geometry: LatLon[] };

export async function geocode(q: string): Promise<{ lat: number; lon: number; name: string }> {
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) return { lat: +m[1], lon: +m[2], name: `${(+m[1]).toFixed(4)}, ${(+m[2]).toFixed(4)}` };
  const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q));
  const j = await r.json();
  if (!j.length) throw new Error(`Couldn't find “${q}”. Try adding a region or country.`);
  return { lat: +j[0].lat, lon: +j[0].lon, name: String(j[0].display_name).split(',').slice(0, 2).join(',') };
}

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/** Railway lines (no yards or sidings) in the box, with their geometry. Asks every mirror at once; first answer wins. */
export async function fetchRailways({ s, w, n, e }: BBox): Promise<RailWayData[]> {
  const q = `[out:json][timeout:40];way["railway"~"^(rail|light_rail|narrow_gauge)$"]["service"!~"^(yard|siding|spur)$"](${s},${w},${n},${e});out tags geom;`;
  const stop = new AbortController();
  const ask = async (url: string) => {
    const r = await fetch(url, {
      method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(45000)]),
    });
    if (!r.ok) throw new Error(new URL(url).host + ' ' + r.status);
    const j = await r.json() as { elements: { tags?: RailTags; geometry?: LatLon[] }[] };
    return j.elements.filter(el => el.geometry && el.geometry.length > 1).map(el => ({ tags: el.tags ?? {}, geometry: el.geometry! }));
  };
  try {
    const out = await Promise.any(OVERPASS.map(ask));
    stop.abort();
    return out;
  } catch {
    throw new Error('The railway data servers are busy right now. Try again in a minute.');
  }
}

// ---------- slippy-map tiles ----------

function tileMath(z: number) {
  const N = 2 ** z;
  const tx = (lon: number) => (lon + 180) / 360 * N;
  const ty = (lat: number) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * N; };
  return { tx, ty };
}

async function stitchTiles(b: BBox, z: number, url: (z: number, x: number, y: number) => string, raw: boolean) {
  const { tx, ty } = tileMath(z);
  const x0 = Math.floor(tx(b.w)), x1 = Math.floor(tx(b.e)), y0 = Math.floor(ty(b.n)), y1 = Math.floor(ty(b.s));
  const cv = document.createElement('canvas');
  cv.width = (x1 - x0 + 1) * 256; cv.height = (y1 - y0 + 1) * 256;
  const ctx = cv.getContext('2d', { willReadFrequently: raw })!;
  const jobs: Promise<void>[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push((async () => {
    const r = await fetch(url(z, x, y));
    if (!r.ok) throw new Error('Tile ' + r.status);
    const opts: ImageBitmapOptions = raw ? { colorSpaceConversion: 'none', premultiplyAlpha: 'none' } : {};
    ctx.drawImage(await createImageBitmap(await r.blob(), opts), (x - x0) * 256, (y - y0) * 256);
  })());
  const res = await Promise.allSettled(jobs);
  if (res.every(r => r.status === 'rejected')) throw new Error('No tiles available');
  return { cv, ctx, px: (lat: number, lon: number): [number, number] => [(tx(lon) - x0) * 256, (ty(lat) - y0) * 256] };
}

/** Global Terrarium elevation tiles (AWS open data, ~30 m in most of Europe). */
export async function fetchElevation(b: BBox): Promise<Elevation> {
  const { cv, ctx, px } = await stitchTiles(b, 13, (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`, true);
  const W = cv.width, H = cv.height;
  const d = ctx.getImageData(0, 0, W, H).data, h = new Float32Array(W * H);
  for (let i = 0; i < h.length; i++) h[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
  const at = (i: number, j: number) => h[Math.min(H - 1, Math.max(0, j)) * W + Math.min(W - 1, Math.max(0, i))];
  return (lat, lon) => {
    const [fx, fy] = px(lat, lon), x = fx - 0.5, y = fy - 0.5, i = Math.floor(x), j = Math.floor(y), u = x - i, v = y - j;
    return (at(i, j) * (1 - u) + at(i + 1, j) * u) * (1 - v) + (at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u) * v;
  };
}

/** Aerial photo of exactly the box, as a square canvas (north up). */
export async function fetchImagery(b: BBox, size = 4096): Promise<HTMLCanvasElement> {
  const z = 16;
  const { cv, px } = await stitchTiles(b, z, (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`, false);
  const [x0, y0] = px(b.n, b.w), [x1, y1] = px(b.s, b.e);
  const out = document.createElement('canvas');
  out.width = out.height = size;
  const ctx = out.getContext('2d')!;
  ctx.filter = 'saturate(1.1) contrast(1.05)';
  ctx.drawImage(cv, x0, y0, x1 - x0, y1 - y0, 0, 0, size, size);
  return out;
}
