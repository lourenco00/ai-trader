// Approve real-money trading: npm run approve-live
//
// Interactive on purpose. It shows the paper evidence, refuses unless it says PASSING, asks for a
// capital cap, and makes you type a confirmation sentence. The approval expires after 30 days.
import { createInterface } from 'node:readline/promises';
import { confirmationPhrase, createApproval, evidenceFor, type LiveVenue } from './live';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string, d = '') => rl.question(`${q}${d ? ` [${d}]` : ''}: `).then((a) => a.trim() || d);

console.log('\nReal-money approval\n');
const evidenceDir = await ask('Paper fund folder that earned this (the evidence)', './data');
const ev = evidenceFor(evidenceDir);
if (!ev) {
  console.log(`\nNo paper evidence found in ${evidenceDir}.`);
  process.exit(1);
}
const v = ev.verdict;
console.log(`\nEvidence (proven strategies only): ${v.trades} trades, net $${v.pnl.toFixed(2)}, profit factor ${v.profitFactor.toFixed(2)}, season day ${ev.days.toFixed(1)}`);
console.log(`Verdict: ${v.text}\n`);
if (v.code !== 'PASSING') {
  console.log('Not approved. Real money stays off until the verdict is PASSING.');
  process.exit(1);
}
const venue = (await ask('Venue (alpaca or okx)', 'alpaca')) as LiveVenue;
const capUsd = Number(await ask('Most money the agents may ever use, in USD'));
const maxOrderUsd = Number(await ask('Largest single order in USD', String(Math.round(capUsd * 0.2))));
const maxLossPct = Number(await ask('Stop everything after losing this share of the cap', '0.2'));
console.log(`\nTo approve, type exactly:\n  ${confirmationPhrase(capUsd)}\n`);
const typed = await ask('Type it');
rl.close();
try {
  const a = createApproval({ venue, capUsd, maxOrderUsd, maxLossPct, evidenceDir, typed });
  console.log(`\nApproved until ${new Date(a.expiresAt).toISOString().slice(0, 10)}: cap $${a.capUsd}, max order $${a.maxOrderUsd}, stop at -${(a.maxLossPct * 100).toFixed(0)}%.`);
  console.log('Next: start a separate live instance with DATA_DIR=./data-live and ALPACA_PAPER=false (or OKX_DEMO=false).');
} catch (err) {
  console.log(`\n${(err as Error).message}`);
  process.exit(1);
}
