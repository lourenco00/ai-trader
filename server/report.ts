// Prints a plain-text verdict on the current paper season: npm run report
import { config } from './config';
import { assess, loadEvidence, summarize } from './verdict';

const money = (x: number) => `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(2)}`;
const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

const e = loadEvidence(config.dataDir);
if (!e) {
  console.log('No season found yet (data/state.json is missing). Start the ecosystem first.');
} else {
  const trades = e.trades;
  const all = summarize(trades);
  const core = summarize(trades.filter((t) => config.isCore(t.symbol)));
  const explored = summarize(trades.filter((t) => !config.isCore(t.symbol)));
  const trial = summarize(trades.filter((t) => e.trialIds.has(t.strategyId)));
  const proven = summarize(trades.filter((t) => !e.trialIds.has(t.strategyId)));

  console.log(`\nSeason day ${e.days.toFixed(1)} | equity $${e.equity.toFixed(2)} (${pct(e.equity / e.startingCapital - 1)}) | last 7d ${pct(e.weekReturn)} | max drawdown ${pct(-e.maxDrawdown)}`);
  console.log(`Trades ${all.n} | net ${money(all.pnl)} | profit factor ${all.pf.toFixed(2)} | win rate ${pct(all.winRate)} | fees paid $${e.fees.toFixed(2)}`);
  console.log(`  core markets:     ${core.n} trades, ${money(core.pnl)}, PF ${core.pf.toFixed(2)}`);
  console.log(`  explored markets: ${explored.n} trades, ${money(explored.pnl)}, PF ${explored.pf.toFixed(2)}`);
  console.log(`  proven strategies: ${proven.n} trades, ${money(proven.pnl)}, PF ${proven.pf.toFixed(2)}`);
  console.log(`  trial strategies:  ${trial.n} trades, ${money(trial.pnl)}, PF ${trial.pf.toFixed(2)}`);

  const bySym = new Map<string, number>();
  for (const t of trades) bySym.set(t.symbol, (bySym.get(t.symbol) ?? 0) + t.pnl);
  const top = [...bySym].sort((a, b) => b[1] - a[1]);
  if (top.length) console.log(`  best: ${top.slice(0, 3).map(([s, p]) => `${s} ${money(p)}`).join(', ')} | worst: ${top.slice(-3).reverse().map(([s, p]) => `${s} ${money(p)}`).join(', ')}`);

  const v = assess(e);
  if (trades.length > 5) console.log(`  without the single best trade: ${money(v.withoutBest)}`);
  console.log(`\nVerdict (all trades): ${v.text}`);
  const vp = assess(e, { provenOnly: true });
  console.log(`Verdict for real money (proven strategies only): ${vp.text}\n`);
}
