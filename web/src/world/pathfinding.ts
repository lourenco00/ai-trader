import { MAP_H, MAP_W, Tile, type WorldMap } from './map';

export interface Pt {
  x: number;
  y: number;
}

/** Binary min-heap keyed by f-score. */
class Heap {
  private items: { k: number; f: number }[] = [];
  get size(): number {
    return this.items.length;
  }
  push(k: number, f: number): void {
    const a = this.items;
    a.push({ k, f });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): number {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top.k;
  }
}

/** A* over the tile grid. Streets cost less than grass, so villagers stick to paths. */
export function findPath(map: WorldMap, from: Pt, to: Pt): Pt[] {
  const N = MAP_W * MAP_H;
  const idx = (x: number, y: number) => y * MAP_W + x;
  const ok = (x: number, y: number) => x >= 0 && y >= 0 && x < MAP_W && y < MAP_H && !map.blocked[idx(x, y)];
  if (!ok(to.x, to.y) || !ok(from.x, from.y)) return [];
  const g = new Float32Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const start = idx(from.x, from.y);
  const goal = idx(to.x, to.y);
  const h = (k: number) => Math.abs((k % MAP_W) - to.x) + Math.abs(Math.floor(k / MAP_W) - to.y);
  const heap = new Heap();
  g[start] = 0;
  heap.push(start, h(start));
  let expanded = 0;
  while (heap.size && expanded++ < 6000) {
    const k = heap.pop();
    if (k === goal) break;
    if (closed[k]) continue;
    closed[k] = 1;
    const x = k % MAP_W;
    const y = Math.floor(k / MAP_W);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx;
      const ny = y + dy;
      if (!ok(nx, ny)) continue;
      const nk = idx(nx, ny);
      const t = map.tiles[nk];
      const cost = t === Tile.Path || t === Tile.Plaza ? 1 : 2.5;
      const ng = g[k] + cost;
      if (ng < g[nk]) {
        g[nk] = ng;
        came[nk] = k;
        heap.push(nk, ng + h(nk));
      }
    }
  }
  if (came[goal] === -1 && goal !== start) return [];
  const out: Pt[] = [];
  for (let k = goal; k !== start && k !== -1; k = came[k]) out.push({ x: k % MAP_W, y: Math.floor(k / MAP_W) });
  return out.reverse();
}
