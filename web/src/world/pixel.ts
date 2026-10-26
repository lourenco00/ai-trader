export type Ctx = CanvasRenderingContext2D;

export function canvas(w: number, h: number): { c: HTMLCanvasElement; g: Ctx } {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  const g = c.getContext('2d');
  if (!g) throw new Error('2D canvas not supported');
  g.imageSmoothingEnabled = false;
  return { c, g };
}

export function px(g: Ctx, color: string, x: number, y: number, w = 1, h = 1): void {
  g.fillStyle = color;
  g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

/** Lighten (amt > 0) or darken (amt < 0) a #rrggbb colour. */
export function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(amt >= 0 ? v + (255 - v) * amt : v * (1 + amt))));
  const r = f((n >> 16) & 255);
  const gg = f((n >> 8) & 255);
  const b = f(n & 255);
  return `#${((1 << 24) | (r << 16) | (gg << 8) | b).toString(16).slice(1)}`;
}

/** Filled pixel circle. */
export function disc(g: Ctx, color: string, cx: number, cy: number, r: number): void {
  g.fillStyle = color;
  for (let y = -r; y <= r; y++) {
    const half = Math.floor(Math.sqrt(r * r - y * y));
    g.fillRect(Math.round(cx - half), Math.round(cy + y), half * 2 + 1, 1);
  }
}

export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    let t = (s = (s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
