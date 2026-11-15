// Map tiles, loaded straight into the 3D scene: elevation (Terrarium) and aerial photos (Esri).
// These are images for three.js, not app data, so they don't go through `api`.

export type BBox = { s: number; w: number; n: number; e: number };
export type Elevation = (lat: number, lon: number) => number;

function tileMath(z: number) {
  const N = 2 ** z;
  const tx = (lon: number) => (lon + 180) / 360 * N;
  const ty = (lat: number) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * N; };
  return { tx, ty };
}

/** Stitch the slippy-map tiles covering a box into one canvas. */
async function stitchTiles(b: BBox, z: number, url: (z: number, x: number, y: number) => string, raw: boolean) {
  const { tx, ty } = tileMath(z);
  const x0 = Math.floor(tx(b.w)), x1 = Math.floor(tx(b.e)), y0 = Math.floor(ty(b.n)), y1 = Math.floor(ty(b.s));
  const cv = document.createElement('canvas');
  cv.width = (x1 - x0 + 1) * 256; cv.height = (y1 - y0 + 1) * 256;
  const ctx = cv.getContext('2d', { willReadFrequently: raw })!;
  const opts: ImageBitmapOptions = raw ? { colorSpaceConversion: 'none', premultiplyAlpha: 'none' } : {};
  const jobs: Promise<void>[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push((async () => {
    const r = await fetch(url(z, x, y));
    if (!r.ok) throw new Error('Tile ' + r.status);
    ctx.drawImage(await createImageBitmap(await r.blob(), opts), (x - x0) * 256, (y - y0) * 256);
  })());
  const res = await Promise.allSettled(jobs);
  if (res.every(r => r.status === 'rejected')) throw new Error('No map tiles available');
  return { cv, ctx, px: (lat: number, lon: number): [number, number] => [(tx(lon) - x0) * 256, (ty(lat) - y0) * 256] };
}

/** Global Terrarium elevation tiles (AWS open data, ~30 m in most of Europe). Meters above sea level. */
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
  const { cv, px } = await stitchTiles(b, 16, (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`, false);
  const [x0, y0] = px(b.n, b.w), [x1, y1] = px(b.s, b.e);
  const out = document.createElement('canvas');
  out.width = out.height = size;
  const ctx = out.getContext('2d')!;
  ctx.filter = 'saturate(1.1) contrast(1.05)';
  ctx.drawImage(cv, x0, y0, x1 - x0, y1 - y0, 0, 0, size, size);
  return out;
}
