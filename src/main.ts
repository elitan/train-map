// Train Map: a 3D patch of the world built from open data, with trains running on the real railway lines.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LocalProjection, toXY } from './geo';
import { bridgeGeometry, isBridge, isTunnel, makeDeckAt } from './bridges';
import { Railway, type RailWay, type Train } from './rail';
import { fetchElevation, fetchImagery, fetchRailways, geocode } from './data';
import './style.css';

const R = 2000;          // half-size of the map, meters
const MARGIN = 600;      // railway data beyond the edge, so trains can roll in from outside
const DEFAULT = 'Lund, Sweden';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status'), placeEl = $('place'), listEl = $('trains'), form = $<HTMLFormElement>('search'), input = $<HTMLInputElement>('q');

// ---------- renderer, scene, camera ----------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
// clip everything at the map edge: trains appear to roll in from beyond it
renderer.clippingPlanes = [
  new THREE.Plane(new THREE.Vector3(1, 0, 0), R), new THREE.Plane(new THREE.Vector3(-1, 0, 0), R),
  new THREE.Plane(new THREE.Vector3(0, 0, 1), R), new THREE.Plane(new THREE.Vector3(0, 0, -1), R),
];
$('view').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const SKY = new THREE.Color('#bcd3e6');
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, R * 2.2, R * 5.5);

const camera = new THREE.PerspectiveCamera(45, 1, 1, R * 8);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.47;
controls.minDistance = 25;
controls.maxDistance = R * 2.6;

scene.add(new THREE.HemisphereLight('#dfeaf5', '#5d5a48', 1.4));
const sun = new THREE.DirectionalLight('#fff3df', 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera as THREE.OrthographicCamera;
sc.left = sc.bottom = -250; sc.right = sc.top = 250; sc.near = 10; sc.far = 3000;
sun.shadow.bias = -0.0004;
scene.add(sun, sun.target);
const SUN_DIR = new THREE.Vector3(-0.55, 0.7, 0.45).normalize();

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------- world ----------

let world: THREE.Group | null = null;
let railway: Railway | null = null;
let H: (x: number, y: number) => number = () => 0;
let loadId = 0;

function terrainMesh(heightAt: (x: number, y: number) => number, tex: THREE.Texture | null) {
  const seg = 256, pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let j = 0; j <= seg; j++) for (let i = 0; i <= seg; i++) {
    const x = -R + 2 * R * i / seg, y = -R + 2 * R * j / seg;
    pos.push(x, heightAt(x, y), -y);
    uv.push(i / seg, j / seg);
  }
  for (let j = 0; j < seg; j++) for (let i = 0; i < seg; i++) {
    const a = j * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
    idx.push(a, b, d, a, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: tex, color: tex ? '#ffffff' : '#7c8d62', roughness: 0.95 }));
  m.receiveShadow = true;
  return m;
}

/** Walls of earth around the edge, so the map reads as a cut-out block. */
function skirt(heightAt: (x: number, y: number) => number, floor: number) {
  const pos: number[] = [], n = 128;
  const side = (f: (t: number) => [number, number]) => {
    for (let k = 0; k < n; k++) {
      const [ax, ay] = f(k / n), [bx, by] = f((k + 1) / n), ha = heightAt(ax, ay), hb = heightAt(bx, by);
      pos.push(ax, ha, -ay, bx, floor, -by, bx, hb, -by, ax, ha, -ay, ax, floor, -ay, bx, floor, -by);
    }
  };
  side(t => [-R + 2 * R * t, -R]); side(t => [R, -R + 2 * R * t]); side(t => [R - 2 * R * t, R]); side(t => [-R, R - 2 * R * t]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: '#6b5a48', roughness: 1, side: THREE.DoubleSide }));
}

async function load(query: string) {
  const id = ++loadId;
  following = null;
  setStatus(`Finding ${query}…`);
  try {
    const place = await geocode(query);
    if (id !== loadId) return;
    placeEl.textContent = place.name;
    input.value = query;
    history.replaceState(null, '', '?q=' + encodeURIComponent(query));

    const P = new LocalProjection(place.lat, place.lon);
    setStatus('Loading terrain, aerial photos and railways…');
    const [elev, img, rails] = await Promise.all([
      fetchElevation(P.bbox(R + MARGIN + 200)),
      fetchImagery(P.bbox(R)).catch(e => { console.warn('imagery', e); return null; }),
      fetchRailways(P.bbox(R + MARGIN)),
    ]);
    if (id !== loadId) return;

    // terrain height in local meters, lowest point in the area ≈ 0
    let base = Infinity;
    for (let i = 0; i <= 24; i++) for (let j = 0; j <= 24; j++) base = Math.min(base, elev(...P.unproj(-R + i * R / 12, -R + j * R / 12)));
    H = (x, y) => elev(...P.unproj(x, y)) - base;

    world?.removeFromParent();
    railway?.dispose();
    world = new THREE.Group();

    const tex = img ? new THREE.CanvasTexture(img) : null;
    if (tex) { tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = renderer.capabilities.getMaxAnisotropy(); }
    world.add(terrainMesh(H, tex), skirt(H, -40));

    const ways: RailWay[] = [], decks: THREE.BufferGeometry[] = [];
    for (const r of rails) {
      const pts = toXY(P, r.geometry);
      const bridge = isBridge(r.tags);
      ways.push({ pts, bridgeAt: bridge ? makeDeckAt(pts, H) : undefined, tunnel: isTunnel(r.tags) });
      if (bridge) decks.push(...bridgeGeometry({ pts, width: 4, rail: true }, H));
    }
    if (decks.length) {
      const m = new THREE.Mesh(mergeGeometries(decks), new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide }));
      m.castShadow = m.receiveShadow = true;
      world.add(m);
    }
    railway = ways.length ? new Railway(ways, H, R) : null;
    if (railway) world.add(railway.group);
    scene.add(world);

    // start looking at the railway nearest the centre (or the centre itself)
    let focus = new THREE.Vector3(0, H(0, 0), 0);
    let bestD = Infinity;
    for (const w of ways) for (const [x, y] of w.pts) {
      const d = Math.hypot(x, y);
      if (d < bestD && Math.abs(x) < R && Math.abs(y) < R) { bestD = d; focus = new THREE.Vector3(x, H(x, y), -y); }
    }
    controls.target.copy(focus);
    camera.position.copy(focus).add(new THREE.Vector3(-420, 380, 520));
    controls.update();

    setStatus(ways.length ? '' : 'No railway lines here. Try a town with a station.');
  } catch (e) {
    if (id === loadId) setStatus((e as Error).message);
  }
}

function setStatus(s: string) { statusEl.textContent = s; statusEl.hidden = !s; }

// ---------- following a train ----------

let following: Train | null = null;
const followPrev = new THREE.Vector3();

function trainCenter(t: Train) {
  const m = t.meshes.find(m => m.visible) ?? t.meshes[0];
  return m.position;
}

function follow(t: Train | null) {
  following = t;
  if (t) {
    followPrev.copy(trainCenter(t));
    const off = camera.position.clone().sub(controls.target).setLength(Math.min(260, controls.getDistance()));
    controls.target.copy(followPrev);
    camera.position.copy(followPrev).add(off);
  }
  renderList();
}

const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let down: [number, number] | null = null;
renderer.domElement.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', e => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
  ndc.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const meshes = railway?.trains.flatMap(t => t.meshes.filter(m => m.visible)) ?? [];
  const hit = ray.intersectObjects(meshes, false)[0];
  follow(hit ? (hit.object.userData.vehicle?.train as Train) : null);
});

let listKey = '';
function renderList() {
  const trains = railway?.trains ?? [];
  const key = trains.map(t => t.name + t.meshes.length).join('|') + (following ? trains.indexOf(following) : -1);
  if (key === listKey) return;
  listKey = key;
  listEl.replaceChildren(...trains.map(t => {
    const b = document.createElement('button');
    b.className = 'train' + (t === following ? ' on' : '');
    b.innerHTML = `<span class="dot ${t.name.startsWith('Freight') ? 'freight' : ''}"></span>${t.name}<small>${t.meshes.length} cars</small>`;
    b.onclick = () => follow(t === following ? null : t);
    return b;
  }));
  if (!trains.length && railway) listEl.innerHTML = '<p class="muted">Next train is on its way…</p>';
}

// ---------- loop ----------

const timer = new THREE.Timer();
timer.connect(document);
const speedEl = $('speed');
renderer.setAnimationLoop(() => {
  timer.update();
  const dt = timer.getDelta();
  railway?.update(dt);
  if (following && !railway?.trains.includes(following)) following = null;
  if (following) {
    const p = trainCenter(following), d = p.clone().sub(followPrev);
    controls.target.add(d); camera.position.add(d); followPrev.copy(p);
    speedEl.textContent = `${following.name} · ${Math.round(following.v * 3.6)} km/h`;
  }
  speedEl.hidden = !following;
  renderList();
  controls.update();
  // keep the shadow box around what we're looking at
  sun.target.position.copy(controls.target);
  sun.position.copy(controls.target).addScaledVector(SUN_DIR, 1200);
  renderer.render(scene, camera);
});

form.addEventListener('submit', e => { e.preventDefault(); if (input.value.trim()) load(input.value.trim()); });

load(new URLSearchParams(location.search).get('q') || DEFAULT);
