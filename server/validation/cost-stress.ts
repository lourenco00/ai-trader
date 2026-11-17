import { isDeepStrictEqual } from 'node:util';
import type { Candle } from '../../shared/types';
import { backtest, type BacktestOptions } from '../strategy/backtest';
import { sanitize, warmupBars, type Genome } from '../strategy/genome';
import { IndicatorCache } from '../strategy/indicators';

export interface CostStressInput {
  genome: Genome;
  candles: Candle[];
  dataset: { kind: 'historical' | 'synthetic'; label: string };
  plan: { declaredAt: number; frozenAt: number; trainingEnd: number; testStart: number; testEnd: number; warmupBars: number };
  costs: BacktestOptions;
}

function requireValid(ok: unknown, field: string): asserts ok {
  if (!ok) throw new Error(`Invalid cost stress input: ${field}`);
}

function record(value: unknown, field: string): Record<string, unknown> {
  requireValid(value !== null && typeof value === 'object' && !Array.isArray(value), field);
  return value as Record<string, unknown>;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validate(raw: unknown): CostStressInput {
  const value = record(raw, 'root');
  let canonical = false;
  try { canonical = isDeepStrictEqual(value.genome, sanitize(value.genome)); } catch { /* reject, never repair */ }
  requireValid(canonical, 'genome must match the existing canonical supported Genome shape without sanitization');
  requireValid(Array.isArray(value.candles) && value.candles.length > 0, 'candles');
  let previous = -1;
  for (const rawBar of value.candles) {
    const bar = record(rawBar, 'candle');
    requireValid(Number.isSafeInteger(bar.t) && (bar.t as number) >= 0 && (bar.t as number) > previous, 'strictly increasing timestamp milliseconds');
    previous = bar.t as number;
    for (const key of ['o', 'h', 'l', 'c']) requireValid(finite(bar[key]) && (bar[key] as number) > 0, `candle ${key}`);
    requireValid((bar.l as number) <= Math.min(bar.o as number, bar.c as number) && (bar.h as number) >= Math.max(bar.o as number, bar.c as number), 'OHLC bounds');
    requireValid(finite(bar.v) && bar.v >= 0, 'candle volume');
  }
  const costs = record(value.costs, 'costs');
  for (const key of ['feeRate', 'slippage']) requireValid(finite(costs[key]) && (costs[key] as number) >= 0 && (costs[key] as number) * 3 < 1, `costs.${key} including 3x stress`);
  requireValid(finite(costs.barsPerYear) && costs.barsPerYear > 0, 'barsPerYear');
  const dataset = record(value.dataset, 'dataset');
  requireValid(dataset.kind === 'historical' || dataset.kind === 'synthetic', 'dataset.kind');
  requireValid(typeof dataset.label === 'string' && dataset.label.trim().length > 0, 'dataset.label');
  const plan = record(value.plan, 'plan');
  for (const key of ['declaredAt', 'frozenAt', 'trainingEnd', 'testStart', 'testEnd']) requireValid(Number.isSafeInteger(plan[key]) && (plan[key] as number) >= 0, `plan.${key} timestamp milliseconds`);
  requireValid((plan.declaredAt as number) < (plan.testStart as number) && (plan.trainingEnd as number) <= (plan.frozenAt as number) && (plan.frozenAt as number) < (plan.testStart as number), 'predeclared plan before testStart and trainingEnd <= frozenAt < testStart');
  const candles = value.candles as Candle[];
  const first = candles.findIndex(c => c.t === plan.testStart);
  const last = candles.findIndex(c => c.t === plan.testEnd);
  requireValid(first >= 0 && last > first, 'testStart/testEnd must be exact candle timestamps spanning at least two bars (inclusive)');
  requireValid(Number.isSafeInteger(plan.warmupBars) && (plan.warmupBars as number) >= warmupBars(value.genome as Genome) && (plan.warmupBars as number) <= first, 'explicit warmupBars must cover required indicators and fit before testStart');
  return value as unknown as CostStressInput;
}

export function runCostStress(raw: unknown) {
  const input = validate(raw);
  const { genome, candles, plan, costs } = input;
  const first = candles.findIndex(c => c.t === plan.testStart);
  const last = candles.findIndex(c => c.t === plan.testEnd);
  const cache = new IndicatorCache(candles.slice(first - plan.warmupBars, last + 1));
  const scenarios = [1, 2, 3].map(multiplier => {
    const feeRate = costs.feeRate * multiplier;
    const slippage = costs.slippage * multiplier;
    const { metrics } = backtest(cache, genome, plan.warmupBars, cache.length, { ...costs, feeRate, slippage });
    // Check intermediates: Infinity in the denominator can otherwise yield a finite -1.
    const benchmarkAmount = (amount: number): number => {
      // Subnormal products can round away costs even when every result stays finite.
      requireValid(finite(amount) && amount >= 2 ** -1022, 'benchmark exceeds supported numerical domain; intermediate must be finite and positive normal');
      return amount;
    };
    const exitProceeds = benchmarkAmount(benchmarkAmount(candles[last].c * (1 - slippage)) * (1 - feeRate));
    const entryCost = benchmarkAmount(benchmarkAmount(candles[first].o * (1 + slippage)) * (1 + feeRate));
    const buyHoldReturn = benchmarkAmount(exitProceeds / entryCost) - 1;
    requireValid(Object.values(metrics).every(finite) && finite(buyHoldReturn), 'results must be finite; inputs overflow numerical simulation');
    return {
      multiplier, feeRate, slippage, metrics,
      cashBenchmark: { initialCapital: 1, exposure: 0, netReturn: 0 },
      buyHoldBenchmark: { initialCapital: 1, exposure: 1, netReturn: buyHoldReturn },
      adequacy: { minimumTrades: 20, profitFactorThreshold: 1.3, enoughTrades: metrics.trades >= 20, profitFactorPass: metrics.profitFactor >= 1.3 },
    };
  });
  return {
    dataset: structuredClone(input.dataset),
    genome: structuredClone(genome),
    plan: structuredClone(plan),
    barsPerYear: costs.barsPerYear,
    window: { testBars: last - first + 1, firstSignalAt: plan.testStart, earliestPossibleFillAt: candles[first + 1].t, lastLiquidationAt: plan.testEnd, warmupBars: plan.warmupBars },
    scenarios,
    caveats: [
      'Cost sensitivity only, not proof of forward profitability; no optimization or strategy selection is performed.',
      'Plan times and historical provenance are self-attested, not independently verified; repeated inspection or tuning contaminates the holdout.',
      'Minimum 20 closed trades and profit factor >= 1.3 after costs are heuristic screens, not statistical significance or deployment approval.',
      'Capital starts at one normalized unit. Cash earns zero interest. Buy-and-hold is fully invested long from first test open to final test close with entry fee funded from capital; strategy sizing uses sizePct and fees are charged separately.',
      'Buy-and-hold has continuous exposure and an earlier entry than the strategy; strategy exposure counts end-of-bar positions, omitting same-bar round trips. Neither is risk-, exposure-, or capital-allocation matched, especially for shorts.',
      'Existing bar execution remains: close signals fill next open, stops win same-bar stop/target collisions, gap fills and trailing stops use OHLC assumptions. Costs can change stops, exits and trade counts, so strategy return need not be globally monotone.',
      'Backtester profit factor is capped at 99 (including no-loss winners); drawdown and Sharpe use bar marks before terminal liquidation costs, although net return and closed-trade profit factor include terminal costs. Early equity stop can shorten strategy evaluation relative to buy-and-hold.',
      'No spread dynamics, order book liquidity, market impact, partial fills, borrow/funding, margin constraints, taxes or data-bias corrections are modeled.',
      ...(input.dataset.kind === 'synthetic' ? ['SYNTHETIC FIXTURE ONLY: not real market performance or investment evidence.'] : []),
    ],
  };
}
