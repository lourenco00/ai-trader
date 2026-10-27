// Prints a plain-text verdict on the current paper season: npm run report
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config';

interface Trade {
  symbol: string;
  pnl: number;
  fees: number;
  exitTime: number;
  strategyName: string;
}

async function readLines(file: string): Promise<Trade[]> {
  try {
    const raw = await readFile(file, 'utf8');
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Trade);
  } catch {
    return [];
  }
}

const money = (x: number) => `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(2)}`;
const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

function summarize(trades: Trade[]) {
  const win = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const loss = trades.filter((t) => t.pnl <= 0).reduce((s, t) => s - t.pnl, 0);
  return {
    n: trades.length,
    pnl: win - loss,
    pf: loss > 0 ? win / loss : win > 0 ? 99 : 0,
    winRate: trades.length ? trades.filter((t) => t.pnl > 0).length / trades.length : 0,
  };
}

async function main(): Promise<void> {
  let state: any;
  try {
    state = JSON.parse(await readFile(path.join(config.dataDir, 'state.json'), 'utf8'));
  } catch {
    console.log('No season found yet (data/state.json is missing). Start the ecosystem first.');
    return;
  }
  const trades = await readLines(path.join(config.dataDir, 'trades.jsonl'));
  const f = state.fund;
  const equity: { t: number; equity: number }[] = state.equity ?? [];
  const last = equity[equity.length - 1]?.equity ?? f.startingCapital;
  const ret = last / f.startingCapital - 1;
  const days = (Date.now() - state.seasonStartedAt) / 86_400_000;
  const all = summarize(trades);
  const core = summarize(trades.filter((t) => config.isCore(t.symbol)));
  const explored = summarize(trades.filter((t) => !config.isCore(t.symbol)));

  // Last 7 days of the equity curve, to see whether the edge is still there.
  const weekAgo = Date.now() - 7 * 86_400_000;
  const base = equity.find((p) => p.t >= weekAgo)?.equity ?? f.startingCapital;
  const week = last / base - 1;

  console.log(`\nSeason day ${days.toFixed(1)} | equity $${last.toFixed(2)} (${pct(ret)}) | last 7d ${pct(week)} | max drawdown ${pct(-f.maxDrawdown)}`);
  console.log(`Trades ${all.n} | net ${money(all.pnl)} | profit factor ${all.pf.toFixed(2)} | win rate ${pct(all.winRate)} | fees paid $${f.fees.toFixed(2)}`);
  console.log(`  core markets:     ${core.n} trades, ${money(core.pnl)}, PF ${core.pf.toFixed(2)}`);
  console.log(`  explored markets: ${explored.n} trades, ${money(explored.pnl)}, PF ${explored.pf.toFixed(2)}`);

  const bySym = new Map<string, number>();
  for (const t of trades) bySym.set(t.symbol, (bySym.get(t.symbol) ?? 0) + t.pnl);
  const top = [...bySym].sort((a, b) => b[1] - a[1]);
  if (top.length) console.log(`  best: ${top.slice(0, 3).map(([s, p]) => `${s} ${money(p)}`).join(', ')} | worst: ${top.slice(-3).reverse().map(([s, p]) => `${s} ${money(p)}`).join(', ')}`);

  // One lucky trade can carry a whole month: show what is left without the biggest winner.
  const sorted = [...trades].sort((a, b) => b.pnl - a.pnl);
  if (sorted.length > 5) console.log(`  without the single best trade: ${money(all.pnl - sorted[0].pnl)}`);

  let verdict: string;
  if (days < 14 || all.n < 40) {
    verdict = `TOO EARLY. Need at least 14 days and 40 closed trades (have ${days.toFixed(1)} days, ${all.n} trades). Keep it running; paper results this young are mostly luck.`;
  } else if (ret <= 0 || all.pf < 1.1 || f.maxDrawdown > 0.15 || week < -0.03) {
    verdict = `NOT PROFITABLE ENOUGH. ${ret <= 0 ? 'Net return is not positive. ' : ''}${all.pf < 1.1 ? 'Profit factor is below 1.1. ' : ''}${f.maxDrawdown > 0.15 ? 'Drawdown exceeded 15%. ' : ''}${week < -0.03 ? 'Down more than 3% this week. ' : ''}Do not put money in; if real money were already in, this is the unplug signal.`;
  } else if (days >= 30 && all.n >= 100 && all.pnl - sorted[0].pnl > 0) {
    verdict = 'PASSING. Positive after costs for 30+ days with 100+ trades and not carried by one trade. Reasonable to start a small real-money test (an amount you can lose), with the same stop rules.';
  } else {
    verdict = 'PROMISING BUT UNPROVEN. Positive so far; keep it running until 30 days and 100 trades.';
  }
  console.log(`\nVerdict: ${verdict}\n`);
}

void main();
