// Day-by-day view of a season: npm run daily   (set DATA_DIR to look at another fund)
//
// Answers one question: are the results holding up, or did one good day carry everything?
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { assess, loadEvidence, summarize } from './verdict';

const e = loadEvidence(config.dataDir);
if (!e) {
  console.log('No season found yet. Start the ecosystem first.');
  process.exit(0);
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

// End-of-day equity from the minute curve.
const closeOf = new Map<string, number>();
for (const p of e.curve) closeOf.set(day(p.t), p.equity);
const days = [...new Set([...closeOf.keys(), ...e.trades.map((t) => day(t.exitTime))])].sort();

const lines: string[] = [];
let prev = e.startingCapital;
let peak = e.startingCapital;
let pos = 0;
let losingRun = 0;
let longestLosing = 0;
const dayPnls: { d: string; pnl: number }[] = [];
lines.push('day         trades  win%   net P&L   day%    equity      drawdown  trial P&L');
for (const d of days) {
  const trades = e.trades.filter((t) => day(t.exitTime) === d);
  const s = summarize(trades);
  const close = closeOf.get(d) ?? prev;
  const dayRet = prev > 0 ? close / prev - 1 : 0;
  peak = Math.max(peak, close);
  const dd = peak > 0 ? 1 - close / peak : 0;
  const trialPnl = summarize(trades.filter((t) => e.trialIds.has(t.strategyId))).pnl;
  if (dayRet > 0) {
    pos++;
    losingRun = 0;
  } else if (dayRet < 0) {
    losingRun++;
    longestLosing = Math.max(longestLosing, losingRun);
  }
  dayPnls.push({ d, pnl: close - prev });
  lines.push(
    `${d}  ${String(s.n).padStart(6)}  ${(s.n ? `${(s.winRate * 100).toFixed(0)}%` : '-').padStart(4)}  ${(close - prev >= 0 ? '+' : '-') + '$' + Math.abs(close - prev).toFixed(2).padStart(8)}  ${(dayRet * 100).toFixed(2).padStart(6)}%  $${close.toFixed(2).padStart(10)}  ${(dd * 100).toFixed(2).padStart(6)}%   ${trialPnl >= 0 ? '+' : '-'}$${Math.abs(trialPnl).toFixed(2)}`,
  );
  prev = close;
}

const total = dayPnls.reduce((s, x) => s + x.pnl, 0);
const best = [...dayPnls].sort((a, b) => b.pnl - a.pnl)[0];
const worst = [...dayPnls].sort((a, b) => a.pnl - b.pnl)[0];
const out: string[] = [`Fund ${path.basename(config.dataDir)} | season day ${e.days.toFixed(1)} | start $${e.startingCapital.toFixed(0)} -> $${e.equity.toFixed(2)}`, '', ...lines, ''];
if (dayPnls.length) {
  out.push(`Up days: ${pos} of ${dayPnls.length} (${((pos / dayPnls.length) * 100).toFixed(0)}%) | longest losing run: ${longestLosing} days`);
  out.push(`Best day ${best.d} ${best.pnl >= 0 ? '+' : '-'}$${Math.abs(best.pnl).toFixed(2)} | worst day ${worst.d} ${worst.pnl >= 0 ? '+' : '-'}$${Math.abs(worst.pnl).toFixed(2)}`);
  if (dayPnls.length >= 5 && best.pnl > 0 && total > 0 && best.pnl / total > 0.5) out.push(`WARNING: the best day is ${((best.pnl / total) * 100).toFixed(0)}% of all profit. That is luck until it repeats.`);
  const half = Math.floor(dayPnls.length / 2);
  if (half >= 3) {
    const a = dayPnls.slice(0, half).reduce((s, x) => s + x.pnl, 0);
    const b = dayPnls.slice(half).reduce((s, x) => s + x.pnl, 0);
    out.push(`First half of the season ${a >= 0 ? '+' : '-'}$${Math.abs(a).toFixed(2)} | second half ${b >= 0 ? '+' : '-'}$${Math.abs(b).toFixed(2)}${a > 0 && b < 0 ? '  <- the edge may be fading' : ''}`);
  }
}
out.push('', `Verdict (proven strategies only, the bar for real money): ${assess(e, { provenOnly: true }).text}`);
const text = out.join('\n');
console.log('\n' + text + '\n');
try {
  writeFileSync(path.join(config.dataDir, 'daily-report.txt'), text + '\n');
} catch {
  // Read-only location: the printout is enough.
}
