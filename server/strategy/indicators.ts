import type { Candle } from '../../shared/types';

/**
 * Indicator catalogue. Every indicator is causal: value[i] only uses bars 0..i,
 * so backtests cannot peek into the future. Warm-up slots are NaN.
 *
 * 'price' indicators live on the price scale and are compared with each other.
 * 'osc' indicators are scale-free and are compared with constants in `range`.
 */
export type IndicatorKind =
  | 'close'
  | 'sma'
  | 'ema'
  | 'bbUpper'
  | 'bbLower'
  | 'donHigh'
  | 'donLow'
  | 'rsi'
  | 'stoch'
  | 'bbPct'
  | 'macdHist'
  | 'roc'
  | 'zscore'
  | 'atrPct'
  | 'volRatio';

export interface ParamSpec {
  min: number;
  max: number;
  int: boolean;
}

export interface IndicatorMeta {
  type: 'price' | 'osc';
  label: string;
  params: ParamSpec[];
  /** Plausible constant range for oscillator comparisons. */
  range?: [number, number];
}

const P = (min: number, max: number, int = true): ParamSpec => ({ min, max, int });

export const INDICATORS: Record<IndicatorKind, IndicatorMeta> = {
  close: { type: 'price', label: 'Close', params: [] },
  sma: { type: 'price', label: 'SMA', params: [P(3, 200)] },
  ema: { type: 'price', label: 'EMA', params: [P(3, 200)] },
  bbUpper: { type: 'price', label: 'BB Upper', params: [P(10, 60), P(1.2, 3.5, false)] },
  bbLower: { type: 'price', label: 'BB Lower', params: [P(10, 60), P(1.2, 3.5, false)] },
  donHigh: { type: 'price', label: 'Donchian High', params: [P(5, 120)] },
  donLow: { type: 'price', label: 'Donchian Low', params: [P(5, 120)] },
  rsi: { type: 'osc', label: 'RSI', params: [P(2, 30)], range: [5, 95] },
  stoch: { type: 'osc', label: 'Stoch %K', params: [P(5, 40)], range: [5, 95] },
  bbPct: { type: 'osc', label: 'BB %B', params: [P(10, 60), P(1.2, 3.5, false)], range: [-0.3, 1.3] },
  macdHist: { type: 'osc', label: 'MACD Hist %', params: [P(4, 24), P(18, 80), P(4, 18)], range: [-0.4, 0.4] },
  roc: { type: 'osc', label: 'ROC %', params: [P(2, 60)], range: [-6, 6] },
  zscore: { type: 'osc', label: 'Z-Score', params: [P(10, 120)], range: [-3, 3] },
  atrPct: { type: 'osc', label: 'ATR %', params: [P(5, 40)], range: [0.1, 3] },
  volRatio: { type: 'osc', label: 'Volume Ratio', params: [P(10, 60)], range: [0.4, 3.5] },
};

export const INDICATOR_KINDS = Object.keys(INDICATORS) as IndicatorKind[];

export interface IndicatorSpec {
  kind: IndicatorKind;
  p: number[];
}

export function specKey(s: IndicatorSpec): string {
  return `${s.kind}(${s.p.join(',')})`;
}

export function describeSpec(s: IndicatorSpec): string {
  const m = INDICATORS[s.kind];
  return s.p.length ? `${m.label}(${s.p.map((x) => (Number.isInteger(x) ? x : x.toFixed(1))).join(',')})` : m.label;
}

// ---------------------------------------------------------------------------
// Core series math
// ---------------------------------------------------------------------------

function nanArray(n: number): Float64Array {
  return new Float64Array(n).fill(NaN);
}

export function sma(src: Float64Array, n: number): Float64Array {
  const out = nanArray(src.length);
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    sum += src[i];
    if (i >= n) sum -= src[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(src: Float64Array, n: number): Float64Array {
  const out = nanArray(src.length);
  const k = 2 / (n + 1);
  let prev = NaN;
  let seed = 0;
  for (let i = 0; i < src.length; i++) {
    if (i < n - 1) {
      seed += src[i];
      continue;
    }
    if (i === n - 1) {
      prev = (seed + src[i]) / n;
    } else {
      prev = src[i] * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

function emaOfSeries(src: Float64Array, n: number): Float64Array {
  // EMA that skips leading NaNs (used for MACD signal line).
  const out = nanArray(src.length);
  const k = 2 / (n + 1);
  let prev = NaN;
  let count = 0;
  let seed = 0;
  for (let i = 0; i < src.length; i++) {
    const x = src[i];
    if (Number.isNaN(x)) continue;
    if (count < n) {
      seed += x;
      count++;
      if (count === n) {
        prev = seed / n;
        out[i] = prev;
      }
      continue;
    }
    prev = x * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function stdev(src: Float64Array, n: number): Float64Array {
  const out = nanArray(src.length);
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < src.length; i++) {
    sum += src[i];
    sumSq += src[i] * src[i];
    if (i >= n) {
      sum -= src[i - n];
      sumSq -= src[i - n] * src[i - n];
    }
    if (i >= n - 1) {
      const mean = sum / n;
      out[i] = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
    }
  }
  return out;
}

export function rsi(close: Float64Array, n: number): Float64Array {
  const out = nanArray(close.length);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < close.length; i++) {
    const ch = close[i] - close[i - 1];
    const gain = ch > 0 ? ch : 0;
    const loss = ch < 0 ? -ch : 0;
    if (i <= n) {
      avgGain += gain / n;
      avgLoss += loss / n;
      if (i < n) continue;
    } else {
      avgGain = (avgGain * (n - 1) + gain) / n;
      avgLoss = (avgLoss * (n - 1) + loss) / n;
    }
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function atr(h: Float64Array, l: Float64Array, c: Float64Array, n: number): Float64Array {
  const out = nanArray(c.length);
  let prev = NaN;
  let seed = 0;
  for (let i = 0; i < c.length; i++) {
    const tr = i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    if (i < n - 1) {
      seed += tr;
      continue;
    }
    if (i === n - 1) prev = (seed + tr) / n;
    else prev = (prev * (n - 1) + tr) / n;
    out[i] = prev;
  }
  return out;
}

/** Highest high of the previous n bars (excluding the current bar), so `close > donHigh` is a true breakout. */
function donchian(src: Float64Array, n: number, high: boolean): Float64Array {
  const out = nanArray(src.length);
  const dq: number[] = []; // monotonic deque of indices
  for (let i = 0; i < src.length; i++) {
    // window for out[i] is [i-n, i-1]
    if (i >= n) out[i] = src[dq[0]];
    while (dq.length && (high ? src[dq[dq.length - 1]] <= src[i] : src[dq[dq.length - 1]] >= src[i])) dq.pop();
    dq.push(i);
    while (dq.length && dq[0] <= i - n) dq.shift();
  }
  return out;
}

function rollingExtreme(src: Float64Array, n: number, high: boolean): Float64Array {
  // Includes current bar (used by stochastic).
  const out = nanArray(src.length);
  const dq: number[] = [];
  for (let i = 0; i < src.length; i++) {
    while (dq.length && (high ? src[dq[dq.length - 1]] <= src[i] : src[dq[dq.length - 1]] >= src[i])) dq.pop();
    dq.push(i);
    while (dq[0] <= i - n) dq.shift();
    if (i >= n - 1) out[i] = src[dq[0]];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cache: computes each indicator once per dataset.
// ---------------------------------------------------------------------------

export class IndicatorCache {
  readonly o: Float64Array;
  readonly h: Float64Array;
  readonly l: Float64Array;
  readonly c: Float64Array;
  readonly v: Float64Array;
  readonly t: Float64Array;
  readonly length: number;
  private cache = new Map<string, Float64Array>();
  private atrCache = new Map<number, Float64Array>();

  constructor(candles: Candle[], private maxEntries = 400) {
    const n = candles.length;
    this.length = n;
    this.o = new Float64Array(n);
    this.h = new Float64Array(n);
    this.l = new Float64Array(n);
    this.c = new Float64Array(n);
    this.v = new Float64Array(n);
    this.t = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const k = candles[i];
      this.o[i] = k.o;
      this.h[i] = k.h;
      this.l[i] = k.l;
      this.c[i] = k.c;
      this.v[i] = k.v;
      this.t[i] = k.t;
    }
  }

  atr(n: number): Float64Array {
    let a = this.atrCache.get(n);
    if (!a) {
      a = atr(this.h, this.l, this.c, n);
      this.atrCache.set(n, a);
    }
    return a;
  }

  get(spec: IndicatorSpec): Float64Array {
    const key = specKey(spec);
    let s = this.cache.get(key);
    if (s) return s;
    s = this.compute(spec);
    if (this.cache.size >= this.maxEntries) {
      // Drop the oldest entry; Map preserves insertion order.
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    this.cache.set(key, s);
    return s;
  }

  private compute(spec: IndicatorSpec): Float64Array {
    const { c, h, l, v } = this;
    const [a, b, d] = spec.p;
    switch (spec.kind) {
      case 'close':
        return c;
      case 'sma':
        return sma(c, a);
      case 'ema':
        return ema(c, a);
      case 'bbUpper':
      case 'bbLower': {
        const m = sma(c, a);
        const sd = stdev(c, a);
        const out = new Float64Array(c.length);
        const sign = spec.kind === 'bbUpper' ? 1 : -1;
        for (let i = 0; i < c.length; i++) out[i] = m[i] + sign * b * sd[i];
        return out;
      }
      case 'bbPct': {
        const m = sma(c, a);
        const sd = stdev(c, a);
        const out = new Float64Array(c.length);
        for (let i = 0; i < c.length; i++) {
          const width = 2 * b * sd[i];
          out[i] = width > 0 ? (c[i] - (m[i] - b * sd[i])) / width : NaN;
        }
        return out;
      }
      case 'donHigh':
        return donchian(h, a, true);
      case 'donLow':
        return donchian(l, a, false);
      case 'rsi':
        return rsi(c, a);
      case 'stoch': {
        const hh = rollingExtreme(h, a, true);
        const ll = rollingExtreme(l, a, false);
        const out = new Float64Array(c.length);
        for (let i = 0; i < c.length; i++) {
          const range = hh[i] - ll[i];
          out[i] = range > 0 ? ((c[i] - ll[i]) / range) * 100 : NaN;
        }
        return out;
      }
      case 'macdHist': {
        const fast = Math.min(a, b - 1);
        const slow = Math.max(b, a + 1);
        const ef = ema(c, fast);
        const es = ema(c, slow);
        const macd = new Float64Array(c.length);
        for (let i = 0; i < c.length; i++) macd[i] = ef[i] - es[i];
        const sig = emaOfSeries(macd, d);
        const out = new Float64Array(c.length);
        for (let i = 0; i < c.length; i++) out[i] = ((macd[i] - sig[i]) / c[i]) * 100;
        return out;
      }
      case 'roc': {
        const out = nanArray(c.length);
        for (let i = a; i < c.length; i++) out[i] = (c[i] / c[i - a] - 1) * 100;
        return out;
      }
      case 'zscore': {
        const m = sma(c, a);
        const sd = stdev(c, a);
        const out = new Float64Array(c.length);
        for (let i = 0; i < c.length; i++) out[i] = sd[i] > 0 ? (c[i] - m[i]) / sd[i] : NaN;
        return out;
      }
      case 'atrPct': {
        const at = this.atr(a);
        const out = new Float64Array(c.length);
        for (let i = 0; i < c.length; i++) out[i] = (at[i] / c[i]) * 100;
        return out;
      }
      case 'volRatio': {
        const m = sma(v, a);
        const out = new Float64Array(c.length);
        for (let i = 0; i < c.length; i++) out[i] = m[i] > 0 ? v[i] / m[i] : NaN;
        return out;
      }
    }
  }
}
