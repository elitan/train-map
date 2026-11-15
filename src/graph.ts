// Track graph: split ways at shared nodes into directed edges, and walk along them.
import type { XY } from './geo';

export type RoadWay = { pts: XY[]; highway: string; oneway: boolean; deckAt?: (x: number, y: number) => number; tunnel?: boolean; lane?: number };

// km/h by road type (Swedish defaults, roughly)
const SPEED: Record<string, number> = {
  motorway: 110, trunk: 90, primary: 80, secondary: 70, tertiary: 60, unclassified: 50,
  residential: 35, living_street: 15, service: 20,
};
const LANE: Record<string, number> = { motorway: 3.6, trunk: 3, primary: 2.6, secondary: 2.2, tertiary: 1.9, unclassified: 1.6, residential: 1.6 };

// ---------- road graph ----------

export type Edge = {
  id: number; pts: XY[]; cum: number[]; len: number;
  from: string; to: string; speed: number; lane: number; twin: number; // twin = reverse edge id or -1
  deckAt?: (x: number, y: number) => number; tunnel?: boolean;
};

export const nodeKey = ([x, y]: XY) => x.toFixed(1) + ',' + y.toFixed(1);

function makeEdge(id: number, pts: XY[], speed: number, lane: number): Edge {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { id, pts, cum, len: cum[cum.length - 1], from: nodeKey(pts[0]), to: nodeKey(pts[pts.length - 1]), speed, lane, twin: -1 };
}

/** Split ways at shared nodes (junctions) into directed edges. */
export function buildGraph(ways: RoadWay[]) {
  const uses = new Map<string, number>();
  for (const w of ways) w.pts.forEach((p, i) => {
    const k = nodeKey(p);
    uses.set(k, (uses.get(k) ?? 0) + (i === 0 || i === w.pts.length - 1 ? 2 : 1));
  });
  const edges: Edge[] = [], out = new Map<string, number[]>();
  const add = (pts: XY[], w: RoadWay) => {
    if (pts.length < 2) return -1;
    const e = makeEdge(edges.length, pts, (SPEED[w.highway] ?? 40) / 3.6, w.lane ?? (w.oneway ? 0 : (LANE[w.highway] ?? 1.5)));
    e.deckAt = w.deckAt; e.tunnel = w.tunnel;
    if (e.len < 0.5) return -1;
    edges.push(e);
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.id);
    return e.id;
  };
  for (const w of ways) {
    let seg: XY[] = [w.pts[0]];
    for (let i = 1; i < w.pts.length; i++) {
      seg.push(w.pts[i]);
      if (i === w.pts.length - 1 || (uses.get(nodeKey(w.pts[i])) ?? 0) > 1) {
        const a = add(seg, w);
        if (!w.oneway && a >= 0) {
          const b = add(seg.slice().reverse(), w);
          if (b >= 0) { edges[a].twin = b; edges[b].twin = a; }
        }
        seg = [w.pts[i]];
      }
    }
  }
  return { edges, out };
}

export function pointAt(e: Edge, s: number): XY {
  s = Math.max(0, Math.min(e.len, s));
  let i = 1;
  while (i < e.cum.length - 1 && e.cum[i] < s) i++;
  const t = (s - e.cum[i - 1]) / ((e.cum[i] - e.cum[i - 1]) || 1);
  const [ax, ay] = e.pts[i - 1], [bx, by] = e.pts[i];
  return [ax + (bx - ax) * t, ay + (by - ay) * t];
}

