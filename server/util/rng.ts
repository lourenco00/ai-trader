import { randomBytes } from 'node:crypto';

/** Small seeded PRNG (mulberry32). Deterministic when seeded, which keeps the simulator reproducible. */
export class Rng {
  private s: number;

  constructor(seed?: number) {
    this.s = (seed ?? randomBytes(4).readUInt32LE(0)) >>> 0;
  }

  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty list');
    return items[Math.floor(this.next() * items.length)];
  }

  weighted<T>(items: readonly { item: T; w: number }[]): T {
    const total = items.reduce((s, x) => s + x.w, 0);
    let r = this.next() * total;
    for (const x of items) {
      r -= x.w;
      if (r <= 0) return x.item;
    }
    return items[items.length - 1].item;
  }

  gauss(): number {
    const u = Math.max(1e-12, this.next());
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

export function shortId(prefix = ''): string {
  return prefix + randomBytes(5).toString('hex');
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
