import type { Side } from '../../shared/types';
import { Rng, hashString } from '../util/rng';
import {
  INDICATORS,
  INDICATOR_KINDS,
  describeSpec,
  specKey,
  type IndicatorKind,
  type IndicatorSpec,
} from './indicators';

/**
 * A strategy genome: entry rules (AND), exit rules (OR) and ATR-based risk
 * management. Researchers evolve these; traders execute them.
 */
export type Op = '>' | '<' | 'crossAbove' | 'crossBelow';

export type Operand = { t: 'ind'; spec: IndicatorSpec } | { t: 'const'; v: number };

export interface Condition {
  left: IndicatorSpec;
  op: Op;
  right: Operand;
}

export interface Genome {
  side: Side;
  entry: Condition[];
  exit: Condition[];
  stopAtr: number;
  takeProfitAtr: number; // 0 = no fixed target
  trailAtr: number; // 0 = no trailing stop
  maxBars: number;
  sizePct: number; // fraction of the trader's wallet committed per trade
  atrPeriod: number;
}

export const GENOME_BOUNDS = {
  stopAtr: [0.6, 6],
  takeProfitAtr: [0, 12],
  trailAtr: [0, 6],
  maxBars: [4, 400],
  sizePct: [0.2, 1],
  atrPeriod: [7, 30],
  entry: [1, 3],
  exit: [0, 2],
} as const;

export type Specialty = 'trend' | 'meanrev' | 'momentum' | 'breakout' | 'wildcard';

export const SPECIALTY_LABEL: Record<Specialty, string> = {
  trend: 'Trend Following',
  meanrev: 'Mean Reversion',
  momentum: 'Momentum',
  breakout: 'Breakouts',
  wildcard: 'Wildcard',
};

const SPECIALTY_WEIGHTS: Record<Specialty, Partial<Record<IndicatorKind, number>>> = {
  trend: { ema: 5, sma: 4, macdHist: 3, roc: 2, close: 3, donHigh: 1, donLow: 1, atrPct: 1, rsi: 1 },
  meanrev: { rsi: 5, bbPct: 4, zscore: 4, stoch: 3, bbLower: 2, bbUpper: 2, close: 2, sma: 1, atrPct: 1 },
  momentum: { roc: 5, macdHist: 4, stoch: 2, rsi: 3, volRatio: 2, ema: 2, close: 2 },
  breakout: { donHigh: 5, donLow: 5, close: 4, bbUpper: 2, bbLower: 2, volRatio: 3, atrPct: 2 },
  wildcard: {},
};

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round = (x: number, dp: number) => Math.round(x * 10 ** dp) / 10 ** dp;

function pickKind(rng: Rng, specialty: Specialty, type?: 'price' | 'osc'): IndicatorKind {
  const weights = SPECIALTY_WEIGHTS[specialty];
  const pool = INDICATOR_KINDS.filter((k) => !type || INDICATORS[k].type === type).map((k) => ({
    item: k,
    w: specialty === 'wildcard' ? 1 : (weights[k] ?? 0.3),
  }));
  return rng.weighted(pool);
}

function randomParam(rng: Rng, min: number, max: number, int: boolean): number {
  // Bias towards smaller look-backs, which are more common in practice.
  const u = rng.next() ** 1.6;
  const v = min + (max - min) * u;
  return int ? Math.round(v) : round(v, 2);
}

export function randomSpec(rng: Rng, kind: IndicatorKind): IndicatorSpec {
  const meta = INDICATORS[kind];
  return { kind, p: meta.params.map((ps) => randomParam(rng, ps.min, ps.max, ps.int)) };
}

function randomConst(rng: Rng, kind: IndicatorKind): number {
  const [lo, hi] = INDICATORS[kind].range ?? [0, 1];
  return round(rng.range(lo, hi), 3);
}

export function randomCondition(rng: Rng, specialty: Specialty): Condition {
  const leftKind = pickKind(rng, specialty);
  const meta = INDICATORS[leftKind];
  if (meta.type === 'price') {
    const left = randomSpec(rng, leftKind);
    let right: IndicatorSpec;
    let guard = 0;
    do {
      const rk = leftKind === 'close' ? pickKind(rng, specialty, 'price') : rng.chance(0.6) ? 'close' : pickKind(rng, specialty, 'price');
      right = randomSpec(rng, rk);
    } while (specKey(right) === specKey(left) && ++guard < 10);
    if (specKey(right) === specKey(left)) right = { kind: 'ema', p: [50] };
    const op = rng.pick<Op>(['crossAbove', 'crossBelow', '>', '<', 'crossAbove', 'crossBelow']);
    return { left, op, right: { t: 'ind', spec: right } };
  }
  const left = randomSpec(rng, leftKind);
  const op = rng.pick<Op>(['>', '<', '>', '<', 'crossAbove', 'crossBelow']);
  return { left, op, right: { t: 'const', v: randomConst(rng, leftKind) } };
}

export function randomGenome(rng: Rng, specialty: Specialty, allowShort = true): Genome {
  const nEntry = rng.int(1, 3);
  const nExit = rng.int(0, 2);
  return sanitize({
    side: allowShort && rng.chance(0.3) ? 'short' : 'long',
    entry: Array.from({ length: nEntry }, () => randomCondition(rng, specialty)),
    exit: Array.from({ length: nExit }, () => randomCondition(rng, specialty)),
    stopAtr: rng.range(1, 4),
    takeProfitAtr: rng.chance(0.25) ? 0 : rng.range(1, 8),
    trailAtr: rng.chance(0.5) ? 0 : rng.range(1, 4),
    maxBars: rng.int(8, 200),
    sizePct: rng.range(0.4, 1),
    atrPeriod: rng.int(10, 20),
  });
}

/** Hand-written classics used to seed populations so evolution does not start from pure noise. */
export function classicGenomes(specialty: Specialty): Genome[] {
  const base = { stopAtr: 2, takeProfitAtr: 4, trailAtr: 0, maxBars: 96, sizePct: 0.8, atrPeriod: 14 };
  const g: Record<Specialty, Genome[]> = {
    trend: [
      {
        ...base,
        side: 'long',
        entry: [{ left: { kind: 'ema', p: [12] }, op: 'crossAbove', right: { t: 'ind', spec: { kind: 'ema', p: [48] } } }],
        exit: [{ left: { kind: 'ema', p: [12] }, op: 'crossBelow', right: { t: 'ind', spec: { kind: 'ema', p: [48] } } }],
        takeProfitAtr: 0,
        trailAtr: 3,
      },
      {
        ...base,
        side: 'long',
        entry: [
          { left: { kind: 'macdHist', p: [12, 26, 9] }, op: 'crossAbove', right: { t: 'const', v: 0 } },
          { left: { kind: 'close' , p: [] }, op: '>', right: { t: 'ind', spec: { kind: 'ema', p: [100] } } },
        ],
        exit: [],
      },
    ],
    meanrev: [
      {
        ...base,
        side: 'long',
        entry: [{ left: { kind: 'rsi', p: [14] }, op: '<', right: { t: 'const', v: 28 } }],
        exit: [{ left: { kind: 'rsi', p: [14] }, op: '>', right: { t: 'const', v: 55 } }],
        takeProfitAtr: 3,
        maxBars: 48,
      },
      {
        ...base,
        side: 'long',
        entry: [{ left: { kind: 'bbPct', p: [20, 2] }, op: '<', right: { t: 'const', v: 0 } }],
        exit: [{ left: { kind: 'bbPct', p: [20, 2] }, op: '>', right: { t: 'const', v: 0.5 } }],
        maxBars: 48,
      },
    ],
    momentum: [
      {
        ...base,
        side: 'long',
        entry: [
          { left: { kind: 'roc', p: [12] }, op: '>', right: { t: 'const', v: 1.5 } },
          { left: { kind: 'volRatio', p: [20] }, op: '>', right: { t: 'const', v: 1.3 } },
        ],
        exit: [],
        trailAtr: 2,
      },
    ],
    breakout: [
      {
        ...base,
        side: 'long',
        entry: [{ left: { kind: 'close', p: [] }, op: 'crossAbove', right: { t: 'ind', spec: { kind: 'donHigh', p: [48] } } }],
        exit: [{ left: { kind: 'close', p: [] }, op: 'crossBelow', right: { t: 'ind', spec: { kind: 'donLow', p: [24] } } }],
        takeProfitAtr: 0,
        trailAtr: 2.5,
        maxBars: 200,
      },
      {
        ...base,
        side: 'short',
        entry: [{ left: { kind: 'close', p: [] }, op: 'crossBelow', right: { t: 'ind', spec: { kind: 'donLow', p: [48] } } }],
        exit: [{ left: { kind: 'close', p: [] }, op: 'crossAbove', right: { t: 'ind', spec: { kind: 'donHigh', p: [24] } } }],
        takeProfitAtr: 0,
        trailAtr: 2.5,
        maxBars: 200,
      },
    ],
    wildcard: [],
  };
  return g[specialty].map(sanitize);
}

function mutateSpec(rng: Rng, spec: IndicatorSpec): IndicatorSpec {
  const meta = INDICATORS[spec.kind];
  if (meta.params.length === 0) return spec;
  const p = spec.p.slice();
  const i = rng.int(0, p.length - 1);
  const ps = meta.params[i];
  const scaled = p[i] * (1 + rng.gauss() * 0.2) + rng.gauss() * (ps.int ? 1 : 0.1);
  p[i] = ps.int ? Math.round(clamp(scaled, ps.min, ps.max)) : round(clamp(scaled, ps.min, ps.max), 2);
  return { kind: spec.kind, p };
}

function mutateCondition(rng: Rng, c: Condition, specialty: Specialty): Condition {
  const roll = rng.next();
  if (roll < 0.35) return { ...c, left: mutateSpec(rng, c.left) };
  if (roll < 0.6) {
    if (c.right.t === 'const') {
      const [lo, hi] = INDICATORS[c.left.kind].range ?? [0, 1];
      const v = clamp(c.right.v + rng.gauss() * (hi - lo) * 0.08, lo, hi);
      return { ...c, right: { t: 'const', v: round(v, 3) } };
    }
    return { ...c, right: { t: 'ind', spec: mutateSpec(rng, c.right.spec) } };
  }
  if (roll < 0.75) {
    const flip: Record<Op, Op> = { '>': '<', '<': '>', crossAbove: 'crossBelow', crossBelow: 'crossAbove' };
    const toggleCross: Record<Op, Op> = { '>': 'crossAbove', '<': 'crossBelow', crossAbove: '>', crossBelow: '<' };
    return { ...c, op: rng.chance(0.5) ? flip[c.op] : toggleCross[c.op] };
  }
  return randomCondition(rng, specialty);
}

export function mutate(rng: Rng, g: Genome, specialty: Specialty, strength = 1): Genome {
  const out: Genome = structuredClone(g);
  const n = Math.max(1, Math.round(rng.range(1, 3) * strength));
  for (let k = 0; k < n; k++) {
    const roll = rng.next();
    if (roll < 0.3 && out.entry.length) {
      const i = rng.int(0, out.entry.length - 1);
      out.entry[i] = mutateCondition(rng, out.entry[i], specialty);
    } else if (roll < 0.42 && out.exit.length) {
      const i = rng.int(0, out.exit.length - 1);
      out.exit[i] = mutateCondition(rng, out.exit[i], specialty);
    } else if (roll < 0.5) {
      if (out.entry.length < GENOME_BOUNDS.entry[1] && rng.chance(0.5)) out.entry.push(randomCondition(rng, specialty));
      else if (out.entry.length > 1) out.entry.splice(rng.int(0, out.entry.length - 1), 1);
    } else if (roll < 0.56) {
      if (out.exit.length < GENOME_BOUNDS.exit[1] && rng.chance(0.5)) out.exit.push(randomCondition(rng, specialty));
      else if (out.exit.length > 0) out.exit.splice(rng.int(0, out.exit.length - 1), 1);
    } else if (roll < 0.66) {
      out.stopAtr *= 1 + rng.gauss() * 0.25;
    } else if (roll < 0.74) {
      out.takeProfitAtr = out.takeProfitAtr === 0 || rng.chance(0.1) ? rng.range(1, 8) : out.takeProfitAtr * (1 + rng.gauss() * 0.25);
      if (rng.chance(0.08)) out.takeProfitAtr = 0;
    } else if (roll < 0.82) {
      out.trailAtr = out.trailAtr === 0 || rng.chance(0.1) ? rng.range(1, 4) : out.trailAtr * (1 + rng.gauss() * 0.25);
      if (rng.chance(0.1)) out.trailAtr = 0;
    } else if (roll < 0.9) {
      out.maxBars = Math.round(out.maxBars * (1 + rng.gauss() * 0.3));
    } else if (roll < 0.95) {
      out.sizePct += rng.gauss() * 0.15;
    } else if (roll < 0.98) {
      out.atrPeriod = Math.round(out.atrPeriod + rng.gauss() * 3);
    } else {
      out.side = out.side === 'long' ? 'short' : 'long';
    }
  }
  return sanitize(out);
}

export function crossover(rng: Rng, a: Genome, b: Genome): Genome {
  const pickList = <T>(x: T[], y: T[], min: number, max: number): T[] => {
    const pool = [...x, ...y];
    const n = clamp(rng.int(Math.min(x.length, y.length), Math.max(x.length, y.length)), min, max);
    const out: T[] = [];
    const used = new Set<number>();
    while (out.length < n && used.size < pool.length) {
      const i = rng.int(0, pool.length - 1);
      if (used.has(i)) continue;
      used.add(i);
      out.push(structuredClone(pool[i]));
    }
    return out;
  };
  const from = () => (rng.chance(0.5) ? a : b);
  return sanitize({
    side: from().side,
    entry: pickList(a.entry, b.entry, 1, 3),
    exit: pickList(a.exit, b.exit, 0, 2),
    stopAtr: from().stopAtr,
    takeProfitAtr: from().takeProfitAtr,
    trailAtr: from().trailAtr,
    maxBars: from().maxBars,
    sizePct: from().sizePct,
    atrPeriod: from().atrPeriod,
  });
}

function sanitizeSpec(raw: unknown): IndicatorSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { kind?: unknown; p?: unknown };
  if (typeof r.kind !== 'string' || !(r.kind in INDICATORS)) return null;
  const kind = r.kind as IndicatorKind;
  const meta = INDICATORS[kind];
  const given = Array.isArray(r.p) ? r.p : [];
  const p = meta.params.map((ps, i) => {
    const v = Number(given[i]);
    const val = Number.isFinite(v) ? clamp(v, ps.min, ps.max) : (ps.min + ps.max) / 2;
    return ps.int ? Math.round(val) : round(val, 2);
  });
  return { kind, p };
}

function sanitizeCondition(raw: unknown): Condition | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { left?: unknown; op?: unknown; right?: unknown };
  const left = sanitizeSpec(r.left);
  if (!left) return null;
  const op = r.op;
  if (op !== '>' && op !== '<' && op !== 'crossAbove' && op !== 'crossBelow') return null;
  const meta = INDICATORS[left.kind];
  const right = r.right as { t?: unknown; v?: unknown; spec?: unknown } | undefined;
  if (meta.type === 'osc') {
    const [lo, hi] = meta.range ?? [0, 1];
    const v = Number(right?.v);
    if (!Number.isFinite(v)) return null;
    return { left, op, right: { t: 'const', v: round(clamp(v, lo, hi), 3) } };
  }
  const rs = sanitizeSpec(right?.spec);
  if (!rs || INDICATORS[rs.kind].type !== 'price' || specKey(rs) === specKey(left)) return null;
  return { left, op, right: { t: 'ind', spec: rs } };
}

/** Clamp every field into bounds and drop invalid rules. Also used to validate LLM output. */
export function sanitize(raw: unknown): Genome {
  const r = (raw ?? {}) as Partial<Record<keyof Genome, unknown>>;
  const num = (v: unknown, lo: number, hi: number, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
  };
  const conds = (v: unknown, max: number) => {
    const seen = new Set<string>();
    return (Array.isArray(v) ? v : [])
      .map(sanitizeCondition)
      .filter((c): c is Condition => {
        if (c === null) return false;
        // Crossover can produce the same rule twice; it adds nothing but looks like complexity.
        const key = JSON.stringify(c);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, max);
  };
  let entry = conds(r.entry, GENOME_BOUNDS.entry[1]);
  if (entry.length === 0) {
    entry = [{ left: { kind: 'rsi', p: [14] }, op: '<', right: { t: 'const', v: 30 } }];
  }
  const B = GENOME_BOUNDS;
  return {
    side: r.side === 'short' ? 'short' : 'long',
    entry,
    exit: conds(r.exit, B.exit[1]),
    stopAtr: round(num(r.stopAtr, B.stopAtr[0], B.stopAtr[1], 2), 2),
    takeProfitAtr: (() => {
      const v = num(r.takeProfitAtr, B.takeProfitAtr[0], B.takeProfitAtr[1], 0);
      return v < 0.5 ? 0 : round(v, 2);
    })(),
    trailAtr: (() => {
      const v = num(r.trailAtr, B.trailAtr[0], B.trailAtr[1], 0);
      return v < 0.5 ? 0 : round(v, 2);
    })(),
    maxBars: Math.round(num(r.maxBars, B.maxBars[0], B.maxBars[1], 96)),
    sizePct: round(num(r.sizePct, B.sizePct[0], B.sizePct[1], 0.8), 2),
    atrPeriod: Math.round(num(r.atrPeriod, B.atrPeriod[0], B.atrPeriod[1], 14)),
  };
}

export function genomeKey(g: Genome): string {
  return JSON.stringify(g);
}

function describeOperand(o: Operand): string {
  return o.t === 'const' ? String(o.v) : describeSpec(o.spec);
}

const OP_TEXT: Record<Op, string> = { '>': '>', '<': '<', crossAbove: 'crosses above', crossBelow: 'crosses below' };

export function describeCondition(c: Condition): string {
  return `${describeSpec(c.left)} ${OP_TEXT[c.op]} ${describeOperand(c.right)}`;
}

export function describeGenome(g: Genome): string[] {
  const lines = [`ENTER ${g.side.toUpperCase()} when ${g.entry.map(describeCondition).join(' AND ')}`];
  if (g.exit.length) lines.push(`EXIT when ${g.exit.map(describeCondition).join(' OR ')}`);
  const risk = [`stop ${g.stopAtr}×ATR(${g.atrPeriod})`];
  if (g.takeProfitAtr > 0) risk.push(`target ${g.takeProfitAtr}×ATR`);
  if (g.trailAtr > 0) risk.push(`trail ${g.trailAtr}×ATR`);
  risk.push(`max ${g.maxBars} bars`, `size ${Math.round(g.sizePct * 100)}%`);
  lines.push(`RISK: ${risk.join(', ')}`);
  return lines;
}

/** Bars needed before every indicator in the genome is defined. */
export function warmupBars(g: Genome): number {
  let w = g.atrPeriod + 1;
  const all = [...g.entry, ...g.exit];
  for (const c of all) {
    const specs = [c.left, ...(c.right.t === 'ind' ? [c.right.spec] : [])];
    for (const s of specs) {
      const m = s.kind === 'macdHist' ? (s.p[1] ?? 0) * 3 + (s.p[2] ?? 0) : s.kind === 'ema' ? (s.p[0] ?? 0) * 3 : Math.max(0, ...s.p);
      w = Math.max(w, Math.ceil(m) + 2);
    }
  }
  return w;
}

const ADJ = [
  'Crimson', 'Golden', 'Silent', 'Lucky', 'Rusty', 'Velvet', 'Iron', 'Cosmic', 'Mossy', 'Electric', 'Sly', 'Brave',
  'Frosty', 'Sunny', 'Midnight', 'Copper', 'Jade', 'Thunder', 'Misty', 'Ember', 'Witty', 'Nimble', 'Stormy', 'Amber',
  'Clever', 'Wild', 'Quiet', 'Shadow', 'Hasty', 'Patient',
];
const NOUN = [
  'Otter', 'Falcon', 'Badger', 'Turnip', 'Lantern', 'Comet', 'Fox', 'Heron', 'Pumpkin', 'Owl', 'Mole', 'Raven',
  'Beetle', 'Walrus', 'Gecko', 'Lynx', 'Marmot', 'Squid', 'Moth', 'Bison', 'Parsnip', 'Hare', 'Wolf', 'Crab',
  'Dragonfly', 'Yak', 'Toad', 'Pike', 'Goose', 'Stag',
];

export function strategyName(g: Genome, salt: string): string {
  const h = hashString(genomeKey(g) + salt);
  return `${ADJ[h % ADJ.length]} ${NOUN[Math.floor(h / ADJ.length) % NOUN.length]}`;
}
