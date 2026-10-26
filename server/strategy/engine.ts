import type { Condition, Genome } from './genome';
import type { IndicatorCache } from './indicators';

export type BarPredicate = (i: number) => boolean;

function compileCondition(cache: IndicatorCache, c: Condition): BarPredicate {
  const left = cache.get(c.left);
  if (c.right.t === 'const') {
    const k = c.right.v;
    switch (c.op) {
      case '>':
        return (i) => left[i] > k;
      case '<':
        return (i) => left[i] < k;
      case 'crossAbove':
        return (i) => i > 0 && left[i] > k && left[i - 1] <= k;
      case 'crossBelow':
        return (i) => i > 0 && left[i] < k && left[i - 1] >= k;
    }
  }
  const right = cache.get(c.right.spec);
  switch (c.op) {
    case '>':
      return (i) => left[i] > right[i];
    case '<':
      return (i) => left[i] < right[i];
    case 'crossAbove':
      return (i) => i > 0 && left[i] > right[i] && left[i - 1] <= right[i - 1];
    case 'crossBelow':
      return (i) => i > 0 && left[i] < right[i] && left[i - 1] >= right[i - 1];
  }
}

export interface CompiledStrategy {
  entry: BarPredicate;
  exit: BarPredicate;
  atr: Float64Array;
}

/** Turn a genome into fast per-bar predicates over a dataset. NaN comparisons are false, so warm-up never fires. */
export function compile(cache: IndicatorCache, g: Genome): CompiledStrategy {
  const entries = g.entry.map((c) => compileCondition(cache, c));
  const exits = g.exit.map((c) => compileCondition(cache, c));
  return {
    entry: (i) => {
      for (const p of entries) if (!p(i)) return false;
      return entries.length > 0;
    },
    exit: (i) => {
      for (const p of exits) if (p(i)) return true;
      return false;
    },
    atr: cache.atr(g.atrPeriod),
  };
}
