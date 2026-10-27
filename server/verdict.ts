import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * One definition of "is this making money?", used by the report, the daily report, the live-money
 * approval, and the watchdog that unplugs a live fund. Keeping a single copy means the bar you are
 * shown is the bar that is enforced.
 */

export interface TradeLite {
  symbol: string;
  pnl: number;
  fees: number;
  exitTime: number;
  strategyId: string;
  strategyName: string;
}

export interface Evidence {
  dir: string;
  days: number;
  seasonStartedAt: number;
  startingCapital: number;
  equity: number;
  maxDrawdown: number;
  weekReturn: number;
  fees: number;
  curve: { t: number; equity: number }[];
  trades: TradeLite[];
  trialIds: Set<string>;
}

export type VerdictCode = 'TOO_EARLY' | 'NOT_PROFITABLE' | 'PROMISING' | 'PASSING';

export interface Verdict {
  code: VerdictCode;
  text: string;
  trades: number;
  pnl: number;
  profitFactor: number;
  returnPct: number;
  withoutBest: number;
}

export function loadEvidence(dir: string): Evidence | null {
  let state: any;
  try {
    state = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'));
  } catch {
    return null;
  }
  let trades: TradeLite[] = [];
  try {
    trades = readFileSync(path.join(dir, 'trades.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as TradeLite);
  } catch {
    // No closed trades yet.
  }
  const started = Number(state.seasonStartedAt) || Date.now();
  // trades.jsonl is append-only across seasons; only this season's trades count.
  trades = trades.filter((t) => t.exitTime >= started);
  const curve: { t: number; equity: number }[] = state.equity ?? [];
  const f = state.fund ?? {};
  const last = curve[curve.length - 1]?.equity ?? f.startingCapital ?? 0;
  const weekAgo = Date.now() - 7 * 86_400_000;
  const base = curve.find((p) => p.t >= weekAgo)?.equity ?? f.startingCapital ?? last;
  return {
    dir,
    days: (Date.now() - started) / 86_400_000,
    seasonStartedAt: started,
    startingCapital: Number(f.startingCapital) || 0,
    equity: last,
    maxDrawdown: Number(f.maxDrawdown) || 0,
    weekReturn: base > 0 ? last / base - 1 : 0,
    fees: Number(f.fees) || 0,
    curve,
    trades,
    trialIds: new Set<string>(((state.strategies ?? []) as { id: string; trial?: boolean }[]).filter((s) => s.trial).map((s) => s.id)),
  };
}

export function summarize(trades: TradeLite[]): { n: number; pnl: number; pf: number; winRate: number } {
  const win = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const loss = trades.filter((t) => t.pnl <= 0).reduce((s, t) => s - t.pnl, 0);
  return { n: trades.length, pnl: win - loss, pf: loss > 0 ? win / loss : win > 0 ? 99 : 0, winRate: trades.length ? trades.filter((t) => t.pnl > 0).length / trades.length : 0 };
}

/**
 * @param provenOnly judge only strategies that passed the strict gate. Real money uses this: a fund
 *   that is up only because of unproven trial strategies has not earned a live slot.
 */
export function assess(e: Evidence, opts: { provenOnly?: boolean } = {}): Verdict {
  const trades = opts.provenOnly ? e.trades.filter((t) => !e.trialIds.has(t.strategyId)) : e.trades;
  const s = summarize(trades);
  const ret = e.startingCapital > 0 ? e.equity / e.startingCapital - 1 : 0;
  const best = [...trades].sort((a, b) => b.pnl - a.pnl)[0]?.pnl ?? 0;
  const withoutBest = s.pnl - best;
  const base = { trades: s.n, pnl: s.pnl, profitFactor: s.pf, returnPct: ret, withoutBest };
  const who = opts.provenOnly ? 'proven-strategy ' : '';
  if (e.days < 14 || s.n < 40) {
    return { ...base, code: 'TOO_EARLY', text: `TOO EARLY. Need at least 14 days and 40 closed ${who}trades (have ${e.days.toFixed(1)} days, ${s.n} trades). Paper results this young are mostly luck.` };
  }
  const why = [
    ret <= 0 ? 'net return is not positive' : '',
    s.pf < 1.1 ? 'profit factor is below 1.1' : '',
    e.maxDrawdown > 0.15 ? 'drawdown exceeded 15%' : '',
    e.weekReturn < -0.03 ? 'down more than 3% this week' : '',
  ].filter(Boolean);
  if (why.length) return { ...base, code: 'NOT_PROFITABLE', text: `NOT PROFITABLE ENOUGH: ${why.join('; ')}. Do not put money in; if real money is already in, this is the unplug signal.` };
  if (e.days >= 30 && s.n >= 100 && withoutBest > 0) {
    return { ...base, code: 'PASSING', text: `PASSING: positive after costs for 30+ days with 100+ ${who}trades and not carried by one trade.` };
  }
  return { ...base, code: 'PROMISING', text: `PROMISING BUT UNPROVEN: positive so far; keep going until 30 days and 100 ${who}trades.` };
}
