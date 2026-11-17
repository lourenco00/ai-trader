import assert from 'node:assert/strict';
import test from 'node:test';
import type { Candle } from '../shared/types';
import { Trader } from '../server/agents/trader';
import { PaperBroker } from '../server/broker/broker';
import { emptyLive, type StrategyRecord } from '../server/strategy/vault';

function fixture() {
  const bars: Candle[] = Array.from({ length: 100 }, (_, i) => ({ t: 1_700_000_000_000 + i * 60_000, o: 100, h: 101, l: 99, c: 100, v: 1000 }));
  let reservations = 0, submissions = 0;
  const paper = new PaperBroker(0, 0);
  const ctx: any = {
    cfg: { risk: { leverage: 1, unprovenTradeRisk: 0.001 } },
    feed: { series: () => bars, price: () => 100 },
    fund: { equity: () => 10_000 },
    marketOpen: () => true,
    risk: { reserveEntry: () => { reservations++; return { ok: true }; }, revalidateEntry: () => ({ ok: true }), releaseEntry() {}, orderChanged() {}, requireReview() {} },
    broker: { marketOrder: (r: any) => { submissions++; return paper.marketOrder(r); } },
    persistExecution: async () => {}, news() {}, emit() {}, unlock() {}, levelUp() {}, recordTrade() {},
    vault: { get: (id: string) => id === strategy.id ? strategy : undefined },
  };
  const metrics = { totalReturn: 0, sharpe: 0, sortino: 0, maxDrawdown: 0, winRate: 0, profitFactor: 0, trades: 0, exposure: 0, avgTrade: 0 };
  const strategy: StrategyRecord = {
    id: 's_test', name: 'Synthetic fixture', symbol: 'AMD', status: 'active', live: emptyLive(),
    author: 'fixture', authorId: 'r_fixture', origin: 'evolution', createdAt: 1, fitness: 0,
    train: { ...metrics }, test: { ...metrics }, traderId: 't_test', retiredAt: null, retiredReason: null, epitaph: null,
    genome: { side: 'long', entry: [{ left: { kind: 'close', p: [] }, op: '>', right: { t: 'const', v: 1 } }], exit: [], stopAtr: 2, takeProfitAtr: 0, trailAtr: 0, maxBars: 20, sizePct: 0.5, atrPeriod: 7 },
  };
  const trader = new Trader(ctx, 't_test', 'Synthetic trader', {} as any);
  trader.deposit(1000); trader.assign(strategy);
  return { ctx, bars, strategy, trader, counts: () => ({ reservations, submissions }) };
}
test('telemetry survives restore, rejects malformed saved counters, and snapshots cannot mutate it', async () => {
  const f = fixture(); f.strategy.genome.entry[0].right = { t: 'const', v: 1000 };
  await f.trader.onCandle('AMD');
  const restored = new Trader(f.ctx, 't_test', 'Restored', {} as any);
  restored.restore(f.trader.save());
  assert.deepEqual(diagnostics(restored), diagnostics(f.trader));
  assert.equal(restored.stats()['Last entry decision'], 'no-signal');
  const copy = diagnostics(restored); copy.counts['no-signal'] = 99;
  assert.equal(diagnostics(restored).counts['no-signal'], 1);
  const corrupt: any = restored.save();
  corrupt.extra.entryDiagnostics = { counts: { 'no-signal': -1, 'risk-rejected': Infinity, 'minimum-notional': 0.5, injected: 100, 'entry-filled': 2 }, lastReason: 'injected', lastAt: 'bad' };
  restored.restore(corrupt);
  assert.deepEqual(diagnostics(restored), { counts: { 'entry-filled': 2 }, lastReason: null, lastAt: null });
  delete corrupt.extra.entryDiagnostics; restored.restore(corrupt);
  assert.deepEqual(diagnostics(restored), { counts: {}, lastReason: null, lastAt: null });
});

test('checkpoint cancellation and ambiguous execution are distinct and preserve unknown intent', async (t) => {
  await t.test('revoked authorization', async () => {
    const f = fixture(); f.ctx.risk.revalidateEntry = () => ({ ok: false, reason: 'fixture revoked' });
    await f.trader.onCandle('AMD');
    assert.equal(diagnostics(f.trader).lastReason, 'checkpoint-cancelled');
    assert.equal(f.counts().submissions, 0);
    assert.equal(f.trader.executionIntent, null);
  });
  await t.test('unknown venue response', async () => {
    const f = fixture(); f.ctx.broker.marketOrder = async () => { throw new Error('synthetic accepted-but-disconnected'); };
    await f.trader.onCandle('AMD');
    assert.equal(diagnostics(f.trader).lastReason, 'execution-unknown');
    assert.equal(f.trader.executionIntent?.kind, 'entry');
    assert.equal(f.trader.wallet.position, null);
    assert.equal(diagnostics(f.trader).counts['entry-filled'], undefined);
  });
});

test('synchronous broker throw counts invocation and preserves unknown entry intent', async () => {
  const f = fixture();
  let invocations = 0;
  let submittedIntent: Trader['executionIntent'] = null;
  let releases = 0;
  f.ctx.risk.releaseEntry = () => { releases++; };
  f.ctx.broker.marketOrder = () => {
    invocations++;
    submittedIntent = f.trader.executionIntent;
    throw new Error('synthetic synchronous adapter failure');
  };

  await f.trader.onCandle('AMD');

  assert.equal(invocations, 1);
  assert.equal(diagnostics(f.trader).counts['submission-attempted'], 1);
  assert.equal(diagnostics(f.trader).counts['execution-unknown'], 1);
  assert.equal(diagnostics(f.trader).lastReason, 'execution-unknown');
  assert.ok(submittedIntent);
  assert.equal(f.trader.executionIntent?.kind, 'entry');
  assert.strictEqual(f.trader.executionIntent, submittedIntent);
  assert.equal(releases, 0);
  assert.equal(f.trader.wallet.position, null);
  assert.equal(diagnostics(f.trader).counts['entry-filled'], undefined);
});

function diagnostics(trader: Trader): any { return (trader.toTraderDTO(10_000, false) as any).entryDiagnostics; }

test('actual signal path identifies lifecycle, session, sizing and reservation skips', async (t) => {
  const cases: [string, (f: ReturnType<typeof fixture>) => void, number][] = [
    ['unresolved-execution', (f) => { f.trader.executionIntent = { kind: 'entry', symbol: 'AMD', qty: 1, side: 'buy', at: 1 }; }, 0],
    ['exit-only', (f) => { f.trader.exitOnly = true; }, 0],
    ['retiring', (f) => { f.trader.retiringReason = 'retired'; }, 0],
    ['market-closed', (f) => { f.ctx.marketOpen = () => false; }, 0],
    ['invalid-size', (f) => { f.ctx.broker.entryQty = () => 0; }, 0],
    ['minimum-notional', (f) => { f.trader.wallet.cash = 1; }, 0],
    ['risk-rejected', (f) => { const original = f.ctx.risk.reserveEntry; f.ctx.risk.reserveEntry = (r: any) => { original(r); return { ok: false, reason: 'fixture limit' }; }; }, 1],
  ];
  for (const [reason, configure, reservations] of cases) await t.test(reason, async () => {
    const f = fixture(); configure(f); await f.trader.onCandle('AMD');
    assert.equal(diagnostics(f.trader).lastReason, reason);
    assert.equal(diagnostics(f.trader).counts[reason], 1);
    assert.deepEqual(f.counts(), { reservations, submissions: 0 });
  });
});

test('post-checkpoint price failure is identified without invoking broker', async () => {
  const f = fixture();
  f.ctx.persistExecution = async () => { f.ctx.feed.price = () => undefined; };
  await f.trader.onCandle('AMD');
  assert.equal(diagnostics(f.trader).lastReason, 'missing-price');
  assert.equal(f.counts().submissions, 0);
  assert.equal(f.trader.executionIntent, null);
});

test('broker invocation and booked entry are counted without counting unrelated symbol broadcasts', async () => {
  const f = fixture(); await f.trader.onCandle('TSLA');
  assert.equal(diagnostics(f.trader).lastReason, null);
  await f.trader.onCandle('AMD');
  assert.deepEqual(f.counts(), { reservations: 1, submissions: 1 });
  assert.equal(diagnostics(f.trader).counts['submission-attempted'], 1);
  assert.equal(diagnostics(f.trader).counts['entry-filled'], 1);
  assert.equal(diagnostics(f.trader).lastReason, 'entry-filled');
  assert.equal(f.trader.wallet.position?.symbol, 'AMD');
});

test('actual candle path distinguishes idle, warmup and no signal before risk evaluation', async (t) => {
  const cases: [string, (f: ReturnType<typeof fixture>) => void][] = [
    ['no-strategy', (f) => { f.trader.strategy = null; }],
    ['insufficient-history', (f) => { f.bars.splice(0); }],
    ['no-signal', (f) => { f.strategy.genome.entry[0].right = { t: 'const', v: 1000 }; }],
    ['invalid-atr', (f) => { f.bars.forEach((b) => { b.h = b.l = b.c; }); }],
  ];
  for (const [reason, configure] of cases) await t.test(reason, async () => {
    const f = fixture(); configure(f);
    await f.trader.onCandle('AMD');
    assert.equal(diagnostics(f.trader)?.lastReason, reason);
    assert.equal(diagnostics(f.trader).counts[reason], 1);
    assert.ok(diagnostics(f.trader).lastAt > 0);
    assert.deepEqual(f.counts(), { reservations: 0, submissions: 0 });
  });
});
