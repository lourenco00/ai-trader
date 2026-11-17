import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auditAccount, type AccountAuditInput } from '../server/validation/account-audit';

test('malformed evidence cannot appear consistent and never leaks supplied values', async (t) => {
  const cases: [string, (i: AccountAuditInput) => void][] = [
    ['nonfinite equity', (i) => { i.ledger.equity = NaN; }],
    ['nonfinite sum', (i) => { i.ledger.equity = Number.MAX_VALUE; i.ledger.brokerOffset = Number.MAX_VALUE; }],
    ['missing explicit offset', (i) => { delete (i.ledger as Partial<AccountAuditInput['ledger']>).brokerOffset; }],
    ['missing completeness', (i) => { delete (i.broker as Partial<AccountAuditInput['broker']>).ordersComplete; }],
    ['negative intent count', (i) => { i.ledger.unresolvedIntents = -1; }],
    ['invalid side', (i) => { (i.ledger.positions[0] as { side: string }).side = 'SECRET_VALUE'; }],
    ['negative ledger quantity', (i) => { i.ledger.positions[0]!.qty = -1; }],
    ['normalized symbol would hide identity', (i) => { i.broker.positions[0]!.symbol = ' amd '; }],
    ['duplicate broker rows', (i) => { i.broker.positions.push({ symbol: 'AMD', qty: 2 }); }],
    ['unbounded input', (i) => { i.broker.positions = Array.from({ length: 10_001 }, () => ({ symbol: 'AMD', qty: 1 })); }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const input = fixture(); mutate(input);
    assert.throws(() => auditAccount(input), /^TypeError: Invalid account audit evidence$/);
  });
});

test('JSON-array ledger side cannot produce a false consistent observation', () => {
  const input = JSON.parse(JSON.stringify(fixture()));
  input.ledger.positions[0].side = ['long'];
  input.broker.positions[0].qty = -2;
  assert.throws(() => auditAccount(input), /^TypeError: Invalid account audit evidence$/);
});

test('offline CLI emits review exit code without altering evidence or leaking malformed input', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'account-audit-test-'));
  const filename = path.join(dir, 'evidence.json');
  const run = () => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/account-audit.ts', filename], { encoding: 'utf8', timeout: 10_000 });
  try {
    const input = fixture(); input.now = input.ledger.observedAt = input.broker.observedAt = Date.now();
    const contents = Buffer.from(`  ${JSON.stringify(input, null, 2)}\n`);
    writeFileSync(filename, contents);
    const consistent = run();
    assert.equal(consistent.status, 0, consistent.stderr);
    assert.equal(JSON.parse(consistent.stdout).authorizesTrading, false);
    assert.deepEqual(readFileSync(filename), contents);
    input.broker.equity += 500;
    const mismatchContents = Buffer.from(`${JSON.stringify(input)}\n\n`);
    writeFileSync(filename, mismatchContents);
    const mismatch = run();
    assert.equal(mismatch.status, 2, mismatch.stderr);
    assert.ok(JSON.parse(mismatch.stdout).issues.includes('equity-mismatch'));
    assert.deepEqual(readFileSync(filename), mismatchContents);
    const invalidContents = Buffer.from('{"SECRET_VALUE":');
    writeFileSync(filename, invalidContents);
    const invalid = run();
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stderr.includes('SECRET_VALUE'), false);
    assert.deepEqual(readFileSync(filename), invalidContents);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('offline CLI rejects invalid UTF-8, oversized, missing and directory inputs with sanitized errors', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'account-audit-invalid-'));
  const filename = path.join(dir, 'SECRET_INPUT.json');
  const cases: [string, Buffer | undefined, string][] = [
    ['invalid UTF-8', Buffer.concat([Buffer.from(`${JSON.stringify(fixture()).slice(0, -1)},"SECRET_VALUE":"`), Buffer.from([0xff]), Buffer.from('"}')]), filename],
    ['oversized', Buffer.concat([Buffer.from(JSON.stringify(fixture())), Buffer.alloc(8 * 1024 * 1024, 0x20)]), filename],
    ['missing', undefined, path.join(dir, 'SECRET_MISSING.json')],
    ['directory', undefined, dir],
  ];
  try {
    for (const [name, contents, target] of cases) await t.test(name, () => {
      if (contents) writeFileSync(filename, contents);
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/account-audit.ts', target], {
        encoding: 'utf8', timeout: 3_000, killSignal: 'SIGKILL',
      });
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'Account audit rejected input. Usage: npm run audit:account -- evidence.json (bounded UTF-8 JSON evidence; no credentials).\n');
      if (contents) assert.deepEqual(readFileSync(filename), contents);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('offline CLI rejects FIFO without waiting for a writer', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'account-audit-fifo-'));
  const filename = path.join(dir, 'SECRET_FIFO');
  try {
    const created = spawnSync('mkfifo', [filename], { encoding: 'utf8', timeout: 3_000, killSignal: 'SIGKILL' });
    assert.equal(created.status, 0, created.stderr);
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/account-audit.ts', filename], {
      encoding: 'utf8', timeout: 3_000, killSignal: 'SIGKILL',
    });
    assert.equal(result.error, undefined, 'CLI must reject FIFO before the subprocess timeout');
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Account audit rejected input. Usage: npm run audit:account -- evidence.json (bounded UTF-8 JSON evidence; no credentials).\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const NOW = 1_800_000_000_000;
function fixture(): AccountAuditInput {
  return {
    now: NOW,
    ledger: { observedAt: NOW, equity: 10_000, brokerOffset: 500, positions: [{ ownerId: 't_one', symbol: 'AMD', side: 'long', qty: 2 }], unresolvedIntents: 0, pendingReservations: 0 },
    broker: { observedAt: NOW, equity: 10_500, cash: 9_500, positions: [{ symbol: 'AMD', qty: 2 }], openOrders: [], ordersComplete: true },
  };
}

test('account audit compares actual signed holdings and explicit account offset without mutating evidence', () => {
  const input = fixture();
  const original = JSON.stringify(input);
  const report = auditAccount(input);
  assert.equal(report.status, 'consistent-observation');
  assert.equal(report.authorizesTrading, false);
  assert.equal(report.equityGap, 0);
  assert.equal(JSON.stringify(input), original);
  assert.deepEqual(report.issues, []);
});

test('returned audit evidence is deeply frozen without freezing caller inputs', () => {
  for (const mismatch of [false, true]) {
    const input = fixture();
    if (mismatch) input.broker.positions[0]!.qty = -2;
    const report = auditAccount(input);
    const original = JSON.stringify(report);
    const targets = [report, report.positions, ...report.positions, report.issues];
    for (const target of targets) assert.equal(Object.isFrozen(target), true);
    assert.equal(Reflect.set(report, 'authorizesTrading', true), false);
    assert.equal(Reflect.set(report, 'status', 'consistent-observation'), false);
    assert.equal(Reflect.set(report, 'positions', []), false);
    assert.equal(Reflect.set(report, 'issues', []), false);
    for (const position of report.positions) {
      assert.equal(Reflect.set(position, 'difference', 0), false);
      assert.equal(Reflect.set(position, 'symbol', 'TSLA'), false);
    }
    assert.equal(Reflect.set(report.positions, '0', {}), false);
    assert.equal(Reflect.set(report.issues, '0', 'forged'), false);
    for (const array of [report.positions, report.issues]) {
      assert.throws(() => Array.prototype.push.call(array, 'forged'), TypeError);
      assert.throws(() => Array.prototype.splice.call(array, 0, 1), TypeError);
    }
    assert.equal(JSON.stringify(report), original);
    input.ledger.positions[0]!.qty = 99;
    input.broker.positions[0]!.symbol = 'TSLA';
    assert.equal(JSON.stringify(report), original);
    assert.equal(Object.isFrozen(input.ledger.positions[0]), false);
    assert.equal(Object.isFrozen(input.broker.positions[0]), false);
  }
});

test('signed quantity mismatch cannot be hidden by offsetting different symbols or cash', () => {
  const input = fixture();
  input.broker.positions = [{ symbol: 'AMD', qty: -2 }, { symbol: 'TSLA', qty: 3 }];
  const report = auditAccount(input);
  assert.equal(report.status, 'review-required');
  assert.ok(report.issues.includes('quantity-mismatch:AMD'));
  assert.ok(report.issues.includes('quantity-mismatch:TSLA'));
  assert.equal(report.positions.find((p) => p.symbol === 'AMD')?.difference, 4);
});

test('equity disagreement, unsettled execution and incomplete observations always require review', async (t) => {
  const cases: [string, (input: AccountAuditInput) => void][] = [
    ['equity-mismatch', (i) => { i.broker.equity += 100; }],
    ['outstanding-orders', (i) => { i.broker.openOrders.push({ id: 'accepted-1', symbol: 'AMD', status: 'accepted' }); }],
    ['incomplete-order-list', (i) => { i.broker.ordersComplete = false; }],
    ['unresolved-execution', (i) => { i.ledger.unresolvedIntents = 1; }],
    ['pending-reservations', (i) => { i.ledger.pendingReservations = 1; }],
    ['stale-broker-observation', (i) => { i.broker.observedAt -= 180_001; }],
    ['stale-ledger-observation', (i) => { i.ledger.observedAt -= 180_001; }],
    ['observation-time-skew', (i) => { i.broker.observedAt -= 30_001; }],
    ['future-observation', (i) => { i.broker.observedAt += 1; }],
    ['duplicate-ledger-symbol:AMD', (i) => { i.ledger.positions.push({ ownerId: 't_two', symbol: 'AMD', qty: 1, side: 'short' }); i.broker.positions[0]!.qty = 1; }],
  ];
  for (const [issue, mutate] of cases) {
    await t.test(issue, () => {
      const input = fixture(); mutate(input);
      const report = auditAccount(input);
      assert.equal(report.status, 'review-required', issue);
      assert.ok(report.issues.includes(issue), `${issue}: ${report.issues}`);
      assert.equal(report.authorizesTrading, false);
    });
  }
});
