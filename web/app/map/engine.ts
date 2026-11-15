// The 3D scene: terrain with aerial photos, the railway, and trains running on it.
// Plain three.js, driven by the React page: `show()` a place, `follow()` a train, `dispose()` on unmount.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { RailLine } from 'northstack';
import { LocalProjection, type XY } from './geo';
import { bridgeGeometry, makeDeckAt } from './bridges';
import { Railway, type RailWay, type Train } from './rail';
import { fetchElevation, fetchImagery, type BBox } from './tiles';

/** Half-size of the map, meters. */
export const R = 2000;
/** Railway data beyond the edge, so trains can roll in from outside. */
export const MARGIN = 600;

/** The area to load railways for around a centre point. */
export function railwayArea(lat: number, lon: number): BBox {
  return new LocalProjection(lat, lon).bbox(R + MARGIN);
}

export type TrainInfo = { id: number; name: string; cars: number; freight: boolean };
export type MapState = {
  /** Loading the terrain and photos, or an error doing so; null when the map is ready. */
  status: string | null;
  trains: TrainInfo[];
  following: number | null;
  /** km/h of the train being followed. */
  speed: number | null;
};

const SKY = new THREE.Color('#bcd3e6');
const SUN_DIR = new THREE.Vector3(-0.55, 0.7, 0.45).normalize();

export class TrainMap {
  private renderer = new THREE.WebGLRenderer({ antialias: true });
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 1, R * 8);
  private controls: OrbitControls;
  private sun = new THREE.DirectionalLight('#fff3df', 2.6);
  private timer = new THREE.Timer();
  private world: THREE.Group | null = null;
  private railway: Railway | null = null;
  private loadId = 0;
  private following: Train | null = null;
  private followPrev = new THREE.Vector3();
  private ids = new WeakMap<Train, number>();
  private nextId = 1;
  private state: MapState = { status: null, trains: [], following: null, speed: null };
  private listeners = new Set<(s: MapState) => void>();
  private resizeObserver: ResizeObserver;

  constructor(private el: HTMLElement) {
    const r = this.renderer;
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    // clip everything at the map edge: trains appear to roll in from beyond it
    r.clippingPlanes = [
      new THREE.Plane(new THREE.Vector3(1, 0, 0), R), new THREE.Plane(new THREE.Vector3(-1, 0, 0), R),
      new THREE.Plane(new THREE.Vector3(0, 0, 1), R), new THREE.Plane(new THREE.Vector3(0, 0, -1), R),
    ];
    el.appendChild(r.domElement);

    this.scene.background = SKY;
    this.scene.fog = new THREE.Fog(SKY, R * 2.2, R * 5.5);

    const c = this.controls = new OrbitControls(this.camera, r.domElement);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.maxPolarAngle = Math.PI * 0.47;
    c.minDistance = 25;
    c.maxDistance = R * 2.6;

    this.scene.add(new THREE.HemisphereLight('#dfeaf5', '#5d5a48', 1.4));
    const sun = this.sun;
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = sc.bottom = -250; sc.right = sc.top = 250; sc.near = 10; sc.far = 3000;
    sun.shadow.bias = -0.0004;
    this.scene.add(sun, sun.target);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(el);
    this.resize();
    this.listenForClicks();
    this.timer.connect(document);
    r.setAnimationLoop(() => this.frame());
  }

  /** Subscribe to status and train list changes. Returns the unsubscribe function. */
  subscribe(fn: (s: MapState) => void) {
    this.listeners.add(fn);
    fn(this.state);
    return () => { this.listeners.delete(fn); };
  }

  /** Build the map around a place, with its railway lines. */
  async show(lat: number, lon: number, rails: RailLine[]) {
    const id = ++this.loadId;
    this.follow(null);
    this.set({ status: 'Loading terrain and aerial photos…' });
    try {
      const P = new LocalProjection(lat, lon);
      const [elev, img] = await Promise.all([
        fetchElevation(P.bbox(R + MARGIN + 200)),
        fetchImagery(P.bbox(R)).catch(e => { console.warn('imagery', e); return null; }),
      ]);
      if (id !== this.loadId) return;

      // terrain height in local meters, lowest point in the area ≈ 0
      let base = Infinity;
      for (let i = 0; i <= 24; i++) for (let j = 0; j <= 24; j++) base = Math.min(base, elev(...P.unproj(-R + i * R / 12, -R + j * R / 12)));
      const H = (x: number, y: number) => elev(...P.unproj(x, y)) - base;

      this.clearWorld();
      const world = this.world = new THREE.Group();
      const tex = img ? new THREE.CanvasTexture(img) : null;
      if (tex) { tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy(); }
      world.add(terrainMesh(H, tex), skirt(H, -40));

      const ways: RailWay[] = [], decks: THREE.BufferGeometry[] = [];
      for (const line of rails) {
        const pts: XY[] = line.pts.map(p => P.proj(p.lat, p.lon));
        ways.push({ pts, bridgeAt: line.bridge ? makeDeckAt(pts, H) : undefined, tunnel: line.tunnel });
        if (line.bridge) decks.push(...bridgeGeometry({ pts, width: 4, rail: true }, H));
      }
      if (decks.length) {
        const m = new THREE.Mesh(mergeGeometries(decks), new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide }));
        m.castShadow = m.receiveShadow = true;
        world.add(m);
      }
      this.railway = ways.length ? new Railway(ways, H, R) : null;
      if (this.railway) world.add(this.railway.group);
      this.scene.add(world);

      // start looking at the railway nearest the centre (or the centre itself)
      let focus = new THREE.Vector3(0, H(0, 0), 0), best = Infinity;
      for (const w of ways) for (const [x, y] of w.pts) {
        const d = Math.hypot(x, y);
        if (d < best && Math.abs(x) < R && Math.abs(y) < R) { best = d; focus = new THREE.Vector3(x, H(x, y), -y); }
      }
      this.controls.target.copy(focus);
      this.camera.position.copy(focus).add(new THREE.Vector3(-420, 380, 520));
      this.controls.update();
      this.set({ status: ways.length ? null : 'No railway lines here. Try a town with a station.' });
    } catch (e) {
      if (id === this.loadId) this.set({ status: (e as Error).message });
    }
  }

  /** Ride along with a train (by id from the train list), or stop following. */
  follow(id: number | null) {
    const t = id === null ? null : this.railway?.trains.find(t => this.ids.get(t) === id) ?? null;
    this.following = t;
    if (t) {
      this.followPrev.copy(trainCenter(t));
      const off = this.camera.position.clone().sub(this.controls.target).setLength(Math.min(260, this.controls.getDistance()));
      this.controls.target.copy(this.followPrev);
      this.camera.position.copy(this.followPrev).add(off);
    }
    this.syncTrains();
  }

  dispose() {
    this.loadId++;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.timer.dispose();
    this.controls.dispose();
    this.clearWorld();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.listeners.clear();
  }

  // ---------- internals ----------

  private set(patch: Partial<MapState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  private clearWorld() {
    this.railway?.dispose();
    this.railway = null;
    if (this.world) {
      this.world.removeFromParent();
      this.world.traverse(o => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          for (const m of [o.material].flat()) { (m as THREE.MeshStandardMaterial).map?.dispose(); m.dispose(); }
        }
      });
    }
    this.world = null;
  }

  private resize() {
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private listenForClicks() {
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), el = this.renderer.domElement;
    let down: [number, number] | null = null;
    el.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
    el.addEventListener('pointerup', e => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
      const rect = el.getBoundingClientRect();
      ndc.set((e.clientX - rect.left) / rect.width * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      const meshes = this.railway?.trains.flatMap(t => t.meshes.filter(m => m.visible)) ?? [];
      const train = ray.intersectObjects(meshes, false)[0]?.object.userData.vehicle?.train as Train | undefined;
      this.follow(train ? this.idOf(train) : null);
    });
  }

  private idOf(t: Train) {
    let id = this.ids.get(t);
    if (id === undefined) this.ids.set(t, id = this.nextId++);
    return id;
  }

  /** Publish the train list when it changes (trains come and go every minute or so). */
  private syncTrains() {
    const trains = (this.railway?.trains ?? []).map(t => ({ id: this.idOf(t), name: t.name, cars: t.meshes.length, freight: t.name.startsWith('Freight') }));
    const following = this.following ? this.idOf(this.following) : null;
    const same = trains.length === this.state.trains.length && trains.every((t, i) => t.id === this.state.trains[i].id);
    if (!same || following !== this.state.following) this.set({ trains, following });
  }

  private frame() {
    this.timer.update();
    const dt = this.timer.getDelta();
    this.railway?.update(dt);
    if (this.following && !this.railway?.trains.includes(this.following)) this.following = null;
    if (this.following) {
      const p = trainCenter(this.following), d = p.clone().sub(this.followPrev);
      this.controls.target.add(d); this.camera.position.add(d); this.followPrev.copy(p);
    }
    this.syncTrains();
    const speed = this.following ? Math.round(this.following.v * 3.6) : null;
    if (speed !== this.state.speed) this.set({ speed });
    this.controls.update();
    // keep the shadow box around what we're looking at
    this.sun.target.position.copy(this.controls.target);
    this.sun.position.copy(this.controls.target).addScaledVector(SUN_DIR, 1200);
    this.renderer.render(this.scene, this.camera);
  }
}

function trainCenter(t: Train) {
  return (t.meshes.find(m => m.visible) ?? t.meshes[0]).position;
}

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
