import type { Metrics } from '../../shared/types';
import { compile } from './engine';
import { warmupBars, type Genome } from './genome';
import type { IndicatorCache } from './indicators';

export interface BacktestOptions {
  feeRate: number;
  slippage: number;
  barsPerYear: number;
}

export interface BacktestResult {
  metrics: Metrics;
  equity: number[];
}

/**
 * Bar-by-bar simulation over [from, to).
 * - Signals are read on the close of bar i and filled at the open of bar i+1.
 * - Stops and targets are checked against each bar's high/low; if both are hit
 *   in the same bar the stop wins (pessimistic).
 * - Fees and slippage are charged on both legs.
 */
export function backtest(
  cache: IndicatorCache,
  g: Genome,
  from: number,
  to: number,
  opts: BacktestOptions,
  keepEquity = false,
): BacktestResult {
  const { o, h, l, c } = cache;
  const strat = compile(cache, g);
  const atr = strat.atr;
  const start = Math.max(from, warmupBars(g));
  const end = Math.min(to, cache.length);
  const long = g.side === 'long';
  const dir = long ? 1 : -1;

  let cash = 1;
  let inPos = false;
  let qty = 0;
  let entry = 0;
  let stop = 0;
  let target = 0;
  let barsHeld = 0;
  let extreme = 0;
  let pendingEntry = false;
  let pendingExit = false;

  let trades = 0;
  let wins = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let sumTradeRet = 0;
  let exposed = 0;

  let peak = 1;
  let maxDd = 0;
  let prevEq = 1;
  let sumR = 0;
  let sumR2 = 0;
  let sumDown2 = 0;
  let nR = 0;
  const equity: number[] = [];
  let lastBar = start;

  const closeTrade = (rawPx: number) => {
    const px = rawPx * (1 - dir * opts.slippage);
    const fee = Math.abs(qty * px) * opts.feeRate;
    const pnl = (px - entry) * qty * dir - fee;
    const entryFee = Math.abs(qty * entry) * opts.feeRate;
    const net = pnl - entryFee;
    cash += pnl;
    trades++;
    if (net > 0) {
      wins++;
      grossWin += net;
    } else {
      grossLoss -= net;
    }
    sumTradeRet += net / Math.abs(qty * entry);
    inPos = false;
    qty = 0;
  };

  for (let i = start; i < end; i++) {
    lastBar = i;
    // 1) Fills scheduled from the previous close happen at this bar's open.
    if (pendingExit && inPos) {
      closeTrade(o[i]);
    }
    pendingExit = false;
    if (pendingEntry && !inPos) {
      const a = atr[i - 1];
      if (a > 0) {
        const px = o[i] * (1 + dir * opts.slippage);
        const notional = cash * g.sizePct;
        qty = notional / px;
        entry = px;
        cash -= notional * opts.feeRate;
        stop = px - dir * g.stopAtr * a;
        target = g.takeProfitAtr > 0 ? px + dir * g.takeProfitAtr * a : NaN;
        extreme = px;
        barsHeld = 0;
        inPos = true;
      }
    }
    pendingEntry = false;

    // 2) Intrabar stop / target.
    if (inPos) {
      if (long) {
        if (l[i] <= stop) closeTrade(o[i] < stop ? o[i] : stop);
        else if (!Number.isNaN(target) && h[i] >= target) closeTrade(o[i] > target ? o[i] : target);
      } else {
        if (h[i] >= stop) closeTrade(o[i] > stop ? o[i] : stop);
        else if (!Number.isNaN(target) && l[i] <= target) closeTrade(o[i] < target ? o[i] : target);
      }
    }

    // 3) End-of-bar bookkeeping and signals.
    if (inPos) {
      exposed++;
      barsHeld++;
      extreme = long ? Math.max(extreme, h[i]) : Math.min(extreme, l[i]);
      if (g.trailAtr > 0 && atr[i] > 0) {
        const trail = extreme - dir * g.trailAtr * atr[i];
        stop = long ? Math.max(stop, trail) : Math.min(stop, trail);
      }
      if (barsHeld >= g.maxBars || strat.exit(i)) pendingExit = true;
    } else if (i + 1 < end && strat.entry(i)) {
      pendingEntry = true;
    }

    const eq = inPos ? cash + (c[i] - entry) * qty * dir : cash;
    const r = eq / prevEq - 1;
    prevEq = eq;
    sumR += r;
    sumR2 += r * r;
    if (r < 0) sumDown2 += r * r;
    nR++;
    if (eq > peak) peak = eq;
    const dd = 1 - eq / peak;
    if (dd > maxDd) maxDd = dd;
    if (keepEquity) equity.push(eq);
    if (eq <= 0.05) break; // blown up
  }

  if (inPos && lastBar < cache.length) closeTrade(c[lastBar]);

  const mean = nR ? sumR / nR : 0;
  const variance = nR > 1 ? Math.max(0, sumR2 / nR - mean * mean) : 0;
  const sd = Math.sqrt(variance);
  const downSd = nR ? Math.sqrt(sumDown2 / nR) : 0;
  const ann = Math.sqrt(opts.barsPerYear);

  return {
    metrics: {
      totalReturn: cash - 1,
      sharpe: sd > 0 ? (mean / sd) * ann : 0,
      sortino: downSd > 0 ? (mean / downSd) * ann : 0,
      maxDrawdown: maxDd,
      winRate: trades ? wins / trades : 0,
      profitFactor: grossLoss > 0 ? Math.min(99, grossWin / grossLoss) : grossWin > 0 ? 99 : 0,
      trades,
      exposure: nR ? exposed / nR : 0,
      avgTrade: trades ? sumTradeRet / trades : 0,
    },
    equity,
  };
}

/** Single score used for selection. Rewards risk-adjusted return, punishes drawdown and too few trades. */
export function fitness(m: Metrics, minTrades: number): number {
  if (m.trades < minTrades) return -5 + m.trades / minTrades;
  const confidence = Math.sqrt(Math.min(1, m.trades / (minTrades * 2)));
  const ddPenalty = 4 * Math.max(0, m.maxDrawdown - 0.12);
  const ret = Math.max(-1, Math.min(1, m.totalReturn));
  return m.sharpe * confidence + 0.5 * ret - ddPenalty;
}

export function emptyMetrics(): Metrics {
  return { totalReturn: 0, sharpe: 0, sortino: 0, maxDrawdown: 0, winRate: 0, profitFactor: 0, trades: 0, exposure: 0, avgTrade: 0 };
}
