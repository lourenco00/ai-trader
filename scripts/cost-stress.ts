import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { runCostStress } from '../server/validation/cost-stress';

const maxInputBytes = 16 * 1024 * 1024;

async function readJson(file: string) {
  // Nonblocking open prevents a FIFO without a writer from hanging before fstat.
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxInputBytes) throw new Error('invalid input');
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxInputBytes) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxInputBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxInputBytes) throw new Error('invalid input');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, total)));
  } finally {
    await handle.close();
  }
}

const usage = 'Usage: node --import tsx scripts/cost-stress.ts --genome frozen-genome.json --candles dataset.json --plan plan.json';

try {
  const args = process.argv.slice(2);
  const files = new Map<string, string>();
  if (args.length !== 6) throw new Error(usage);
  for (let i = 0; i < args.length; i += 2) {
    if (!['--genome', '--candles', '--plan'].includes(args[i]) || files.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(usage);
    files.set(args[i], args[i + 1]);
  }
  // Filesystem only: no config, feeds, brokers, ecosystem or environment-key imports.
  const [genome, dataset, plan] = await Promise.all(['--genome', '--candles', '--plan'].map(flag => readJson(files.get(flag)!)));
  const { costs, ...split } = plan ?? {};
  const report = runCostStress({ genome, candles: dataset?.candles, dataset: { kind: dataset?.kind, label: dataset?.label }, plan: split, costs });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch {
  process.stderr.write('cost-stress: invalid arguments or input files; see docs/cost-stress.md for usage.\n');
  process.exitCode = 1;
}
