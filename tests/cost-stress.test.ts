import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { backtest } from '../server/strategy/backtest';
import { IndicatorCache } from '../server/strategy/indicators';
import type { Genome } from '../server/strategy/genome';
import { runCostStress } from '../server/validation/cost-stress';

// Deliberately synthetic unit-test bars; not observations or investment evidence.
function fixture() {
  const genome: Genome = { side: 'long', entry: [{ left: { kind: 'roc', p: [2] }, op: '>', right: { t: 'const', v: -6 } }], exit: [], stopAtr: 6, takeProfitAtr: 0, trailAtr: 0, maxBars: 4, sizePct: 0.8, atrPeriod: 7 };
  const candles = Array.from({ length: 180 }, (_, i) => ({ t: 1_700_000_000_000 + i * 60_000, o: 100 + i * 0.1, h: 101 + i * 0.1, l: 99 + i * 0.1, c: 100.1 + i * 0.1, v: 100 }));
  return { genome, candles, dataset: { kind: 'synthetic' as const, label: 'SYNTHETIC TEST ONLY' }, plan: { declaredAt: candles[10].t, frozenAt: candles[19].t, trainingEnd: candles[19].t, testStart: candles[20].t, testEnd: candles[179].t, warmupBars: 10 }, costs: { feeRate: 0.001, slippage: 0.0005, barsPerYear: 525600 } };
}

test('fixed genome uses the real backtester at base, 2x and 3x costs without mutation', () => {
  const input = fixture();
  const before = structuredClone(input);
  const report = runCostStress(input);
  assert.deepEqual(input, before);
  assert.deepEqual(report, runCostStress(input));
  assert.equal(report.dataset.kind, 'synthetic');
  assert.deepEqual(report.scenarios.map(s => s.multiplier), [1, 2, 3]);
  for (const scenario of report.scenarios) {
    const expected = backtest(new IndicatorCache(input.candles.slice(10)), input.genome, 10, 170, { ...input.costs, feeRate: input.costs.feeRate * scenario.multiplier, slippage: input.costs.slippage * scenario.multiplier });
    assert.deepEqual(scenario.metrics, expected.metrics);
    assert.equal(scenario.cashBenchmark.netReturn, 0);
    assert.equal(scenario.adequacy.minimumTrades, 20);
    assert.equal(scenario.adequacy.profitFactorThreshold, 1.3);
    assert.equal(scenario.adequacy.enoughTrades, scenario.metrics.trades >= 20);
    assert.equal(scenario.adequacy.profitFactorPass, scenario.metrics.profitFactor >= 1.3);
  }
  const [a,b,c] = report.scenarios;
  assert.ok(a.metrics.trades > 0);
  assert.ok(a.metrics.totalReturn > b.metrics.totalReturn && b.metrics.totalReturn > c.metrics.totalReturn);
  assert.ok(a.buyHoldBenchmark.netReturn > b.buyHoldBenchmark.netReturn && b.buyHoldBenchmark.netReturn > c.buyHoldBenchmark.netReturn);
  const f = input.costs.feeRate, s = input.costs.slippage;
  assert.ok(Math.abs(a.buyHoldBenchmark.netReturn - ((input.candles[179].c * (1-s) * (1-f)) / (input.candles[20].o * (1+s) * (1+f)) - 1)) < 1e-12);
  assert.match(report.caveats.join(' '), /sensitivity.*not.*proof/i);
});

test('rejects malformed candles, noncanonical genomes, cost settings and missing provenance instead of repairing', () => {
  const invalid: unknown[] = [null, {}, { ...fixture(), genome: {} }];
  for (const change of [
    (x: any) => { x.candles[25].o = 0; },
    (x: any) => { x.candles[25].h = Infinity; },
    (x: any) => { x.candles[25].l = x.candles[25].h + 1; },
    (x: any) => { x.candles[25].c = '100'; },
    (x: any) => { x.candles[25].t = x.candles[24].t; },
    (x: any) => { x.candles.reverse(); },
    (x: any) => { x.candles[25].v = -1; },
    (x: any) => { delete x.candles[25].v; },
    (x: any) => { x.candles[25].t = 1.5; },
    (x: any) => { x.genome.entry[0].left.kind = 'invented'; },
    (x: any) => { x.genome.entry[0].right.v = -600; },
    (x: any) => { x.genome.atrPeriod = '7'; },
    (x: any) => { x.genome.sizePct = 2; },
    (x: any) => { x.genome.extra = true; },
    (x: any) => { x.costs.feeRate = -0.1; },
    (x: any) => { x.costs.slippage = NaN; },
    (x: any) => { x.costs.slippage = 0.4; },
    (x: any) => { x.costs.barsPerYear = 0; },
    (x: any) => { x.dataset.kind = 'unknown'; },
    (x: any) => { x.dataset.label = ''; },
    (x: any) => { x.candles = []; },
  ]) { const value = fixture(); change(value); invalid.push(value); }
  for (const value of invalid) assert.throws(() => runCostStress(value), /invalid/i);
});

test('requires predeclared chronological split, exact inclusive cutoff bars and sufficient explicit warmup', () => {
  for (const change of [
    (x: any) => { delete x.plan.testStart; },
    (x: any) => { x.plan.frozenAt = x.plan.testStart; },
    (x: any) => { x.plan.declaredAt = x.plan.testStart; },
    (x: any) => { x.plan.trainingEnd = x.plan.testStart; },
    (x: any) => { x.plan.testStart++; },
    (x: any) => { x.plan.testEnd++; },
    (x: any) => { x.plan.testEnd = x.plan.testStart; },
    (x: any) => { x.plan.warmupBars = 7; },
    (x: any) => { x.plan.warmupBars = 21; },
    (x: any) => { x.plan.warmupBars = 9.5; },
    (x: any) => { x.plan.declaredAt = -1; },
  ]) { const value = fixture(); change(value); assert.throws(() => runCostStress(value), /invalid/i); }
  const input = fixture();
  input.plan.warmupBars = 8; // real warmupBars(genome) = 8, exact minimum allowed
  input.plan.testEnd = input.candles[100].t;
  const report = runCostStress(input);
  assert.equal(report.window.testBars, 81);
  assert.equal(report.window.firstSignalAt, input.plan.testStart);
  assert.equal(report.window.earliestPossibleFillAt, input.candles[21].t);
  assert.equal(report.window.lastLiquidationAt, input.plan.testEnd);
  const changed = structuredClone(input);
  changed.candles[101].c = changed.candles[101].h; // outside test end
  changed.candles[0].c = changed.candles[0].l; // before explicit warmup
  assert.deepEqual(runCostStress(changed), report);
});

test('freeze may follow training but must precede test; report discloses attestations, capital and execution limitations', () => {
  const input = fixture();
  input.plan.frozenAt++;
  const report = runCostStress(input);
  assert.deepEqual(report.plan, input.plan);
  assert.deepEqual(report.genome, input.genome);
  assert.equal(report.scenarios[0].cashBenchmark.initialCapital, 1);
  assert.equal(report.scenarios[0].cashBenchmark.exposure, 0);
  assert.equal(report.scenarios[0].buyHoldBenchmark.initialCapital, 1);
  assert.equal(report.scenarios[0].buyHoldBenchmark.exposure, 1);
  for (const term of [/self.attest/i, /heuristic/i, /capital/i, /exposure/i, /terminal/i, /99/, /same.bar/i, /synthetic/i]) assert.match(report.caveats.join(' '), term);
  input.plan.frozenAt = input.plan.trainingEnd - 1;
  assert.throws(() => runCostStress(input), /invalid/i);
});

test('rejects finite but numerically unrepresentable benchmark results rather than emitting JSON null', () => {
  const input = fixture();
  input.candles[20].o = Number.MIN_VALUE;
  input.candles[20].l = Number.MIN_VALUE;
  assert.throws(() => runCostStress(input), /invalid.*finite/i);
});

test('rejects benchmark denominator overflow even when the final return is finite', () => {
  const input = fixture();
  input.genome.entry[0].right = { t: 'const', v: 6 }; // No strategy entries on these flat synthetic bars.
  input.candles = Array.from({ length: 30 }, (_, i) => ({ t: 1000 + i * 1000, o: 1.797e308, h: 1.797e308, l: 1.796e308, c: 1.797e308, v: 100 }));
  input.plan = { declaredAt: 0, frozenAt: 19000, trainingEnd: 19000, testStart: 21000, testEnd: 30000, warmupBars: 10 };
  input.costs.barsPerYear = 1;
  assert.throws(() => runCostStress(input), /invalid.*benchmark.*numerical/i);
});

test('rejects subnormal benchmark arithmetic rather than silently losing costs', () => {
  for (const price of [Number.MIN_VALUE, 1e-310]) {
    const input = fixture();
    input.genome.entry[0].right = { t: 'const', v: 6 };
    input.candles = input.candles.map(bar => ({ ...bar, o: price, h: price, l: price, c: price }));
    input.costs.barsPerYear = 1;
    assert.throws(() => runCostStress(input), /invalid.*benchmark.*numerical/i);
  }
});

test('rejects zero and subnormal benchmark ratios even with normal price products', () => {
  for (const finalPrice of [1e-200, 1e-120]) {
    const input = fixture();
    input.genome.entry[0].right = { t: 'const', v: 6 };
    input.candles = input.candles.map(bar => ({ ...bar, o: 1e200, h: 1e200, l: 1e200, c: 1e200 }));
    const last = input.candles.at(-1)!;
    last.l = last.c = finalPrice;
    input.costs.barsPerYear = 1;
    assert.throws(() => runCostStress(input), /invalid.*benchmark.*numerical/i);
  }
});

const cliFailure = 'cost-stress: invalid arguments or input files; see docs/cost-stress.md for usage.\n';

async function withCliInputs(check: (directory: string, args: string[]) => Promise<void>) {
  const directory = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), 'cost-stress-rejection-'));
  try {
    const input = fixture();
    for (const [name, value] of Object.entries({ genome: input.genome, dataset: { ...input.dataset, candles: input.candles }, plan: { ...input.plan, costs: input.costs } })) await writeFile(path.join(directory, `${name}.json`), JSON.stringify(value));
    const args = ['--import', 'tsx', 'scripts/cost-stress.ts', '--genome', path.join(directory, 'genome.json'), '--candles', path.join(directory, 'dataset.json'), '--plan', path.join(directory, 'plan.json')];
    await check(directory, args);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function assertCliRejected(directory: string, args: string[]) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory }, timeout: 5000, maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined, 'CLI must exit before the subprocess timeout');
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, cliFailure);
  assert.doesNotMatch(result.stdout + result.stderr, /SENTINEL/);
}

test('CLI sanitizes malformed JSON containing a secret', async () => {
  await withCliInputs(async (directory, args) => {
    await writeFile(path.join(directory, 'genome.json'), 'SENTINEL_private_file_secret');
    assertCliRejected(directory, args);
  });
});

test('CLI rejects a valid JSON file above the 16 MiB byte limit', async () => {
  await withCliInputs(async (directory, args) => {
    const json = JSON.stringify(fixture().genome);
    await writeFile(path.join(directory, 'genome.json'), json.padEnd(16 * 1024 * 1024 + 1, ' '));
    assertCliRejected(directory, args);
  });
});

test('CLI rejects invalid UTF-8 rather than accepting replacement characters', async () => {
  await withCliInputs(async (directory, args) => {
    const input = fixture();
    const json = JSON.stringify({ ...input.dataset, label: 'UTF8_MARKER', candles: input.candles });
    const [before, after] = json.split('UTF8_MARKER');
    await writeFile(path.join(directory, 'dataset.json'), Buffer.concat([Buffer.from(before), Buffer.from([0xff]), Buffer.from(after)]));
    assertCliRejected(directory, args);
  });
});

test('CLI rejects a FIFO with no writer without hanging', { skip: process.platform === 'win32' }, async () => {
  await withCliInputs(async (directory, args) => {
    const file = path.join(directory, 'genome.json');
    await rm(file);
    const created = spawnSync('mkfifo', [file], { encoding: 'utf8', timeout: 5000 });
    assert.equal(created.error, undefined);
    assert.equal(created.status, 0, created.stderr);
    assertCliRejected(directory, args);
  });
});

test('CLI sanitizes missing-file failures for every input flag', async () => {
  for (const name of ['genome', 'dataset', 'plan']) {
    await withCliInputs(async (directory, args) => {
      await rm(path.join(directory, `${name}.json`));
      assertCliRejected(directory, args);
    });
  }
});

test('CLI rejects directories for every input flag', async () => {
  for (const flag of ['--genome', '--candles', '--plan']) {
    await withCliInputs(async (directory, args) => {
      args[args.indexOf(flag) + 1] = directory;
      assertCliRejected(directory, args);
    });
  }
});

test('CLI sanitizes argument and semantic-validation failures', async () => {
  await withCliInputs(async (directory, args) => {
    assertCliRejected(directory, args.slice(0, 3));
    const duplicate = [...args];
    duplicate[5] = '--genome';
    assertCliRejected(directory, duplicate);
    const unknown = [...args];
    unknown[3] = '--SENTINEL';
    assertCliRejected(directory, unknown);
    await writeFile(path.join(directory, 'genome.json'), JSON.stringify({ SENTINEL: 'private_secret' }));
    assertCliRejected(directory, args);
  });
});

test('CLI accepts valid JSON at the exact 16 MiB limit', async () => {
  await withCliInputs(async (directory, args) => {
    await writeFile(path.join(directory, 'genome.json'), JSON.stringify(fixture().genome).padEnd(16 * 1024 * 1024, ' '));
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory }, timeout: 5000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), runCostStress(fixture()));
  });
});

test('CLI subprocess reads explicit frozen genome/dataset/plan locally and labels synthetic output', async () => {
  const directory = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), 'cost-stress-test-'));
  try {
    const input = fixture();
    for (const [name, value] of Object.entries({ genome: input.genome, dataset: { ...input.dataset, candles: input.candles }, plan: { ...input.plan, costs: input.costs } })) await writeFile(path.join(directory, `${name}.json`), JSON.stringify(value));
    const args = ['--import', 'tsx', 'scripts/cost-stress.ts', '--genome', path.join(directory, 'genome.json'), '--candles', path.join(directory, 'dataset.json'), '--plan', path.join(directory, 'plan.json')];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory }, timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), runCostStress(input));
    assert.match(result.stdout, /SYNTHETIC TEST ONLY/);
    const missing = spawnSync(process.execPath, args.slice(0, 3), { encoding: 'utf8', timeout: 15000 });
    assert.notEqual(missing.status, 0);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /usage/i);
    await writeFile(path.join(directory, 'genome.json'), '{invalid');
    const malformed = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 });
    assert.notEqual(malformed.status, 0);
    assert.equal(malformed.stdout, '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
