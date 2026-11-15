// Saves the default place (centre + railway lines) to public/default.json, so the first view
// doesn't wait on Overpass. Run with: bun scripts/snapshot.ts "Lund, Sweden"
import { LocalProjection } from '../src/geo';

const query = process.argv[2] ?? 'Lund, Sweden';
const R = 2000, MARGIN = 600; // keep in step with src/main.ts
const headers = { 'User-Agent': 'train-map snapshot script' };

const [hit] = await (await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(query), { headers })).json();
const lat = +hit.lat, lon = +hit.lon, name = String(hit.display_name).split(',').slice(0, 2).join(',');
const { s, w, n, e } = new LocalProjection(lat, lon).bbox(R + MARGIN);
const q = `[out:json][timeout:90];way["railway"~"^(rail|light_rail|narrow_gauge)$"]["service"!~"^(yard|siding|spur)$"](${s},${w},${n},${e});out tags geom;`;
let r: Response | null = null;
for (const url of ['https://overpass-api.de', 'https://maps.mail.ru/osm/tools/overpass', 'https://overpass.private.coffee', 'https://overpass.kumi.systems']) {
  r = await fetch(url + '/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' } }).catch(() => null);
  console.log(url, r?.status);
  if (r?.ok) break;
}
if (!r?.ok) throw new Error('Overpass: no mirror answered');
const j = await r.json() as { elements: { tags?: Record<string, string>; geometry?: { lat: number; lon: number }[] }[] };
const rails = j.elements.filter(el => el.geometry && el.geometry.length > 1)
  .map(el => ({ tags: el.tags ?? {}, geometry: el.geometry!.map(p => ({ lat: +p.lat.toFixed(7), lon: +p.lon.toFixed(7) })) }));
await Bun.write('public/default.json', JSON.stringify({ query, lat, lon, name, rails }));
console.log(`${name}: ${rails.length} railway ways`);
