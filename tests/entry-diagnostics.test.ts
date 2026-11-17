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

test('wallet-bound initial sizing explains the unchanged submitted quantity', async () => {
  const f = fixture();
  f.ctx.cfg.risk.unprovenTradeRisk = 0.01;
  let submittedQty: number | undefined;
  const submit = f.ctx.broker.marketOrder;
  f.ctx.broker.marketOrder = (request: any) => { submittedQty = request.qty; return submit(request); };
  const before = Date.now();
  await f.trader.onCandle('AMD');
  const sizing = diagnostics(f.trader).lastSizing;
  assert.ok(sizing, 'initial sizing snapshot should be available');
  assert.ok(sizing.evaluatedAt >= before && sizing.evaluatedAt <= Date.now());
  assert.deepEqual(sizing, {
    symbol: 'AMD', strategyId: 's_test', evaluatedAt: sizing.evaluatedAt,
    referencePrice: 100, stopDistance: 4, walletNotionalLimit: 500, riskNotionalLimit: 2500,
    requestedQty: 5, roundedQty: 5, actualNotional: 500, plannedStopRisk: 20,
    bindingLimit: 'wallet', venueRounded: false,
  });
  assert.equal(submittedQty, 5);
  assert.deepEqual(f.counts(), { reservations: 1, submissions: 1 });
});

test('sizing snapshots are cloned and never persisted or restored', async () => {
  const f = fixture();
  await f.trader.onCandle('AMD');
  const copy = diagnostics(f.trader).lastSizing;
  copy.symbol = 'tampered'; copy.roundedQty = 99;
  assert.equal(diagnostics(f.trader).lastSizing.symbol, 'AMD');
  assert.equal(diagnostics(f.trader).lastSizing.roundedQty, 2.5);
  const saved: any = f.trader.save();
  assert.equal(saved.extra.entryDiagnostics.lastSizing, undefined);
  saved.extra.entryDiagnostics.lastSizing = copy;
  f.trader.restore(saved);
  assert.equal(diagnostics(f.trader).lastSizing, undefined);
  assert.equal(diagnostics(f.trader).counts['entry-filled'], 1);
});

test('invalid numeric sizing inputs never produce valid-looking explanations', async (t) => {
  const cases: [string, (f: ReturnType<typeof fixture>) => void][] = [
    ['NaN wallet ceiling', (f) => { f.strategy.genome.sizePct = NaN; }],
    ['infinite wallet ceiling', (f) => { f.ctx.cfg.risk.leverage = Infinity; }],
    ['negative wallet ceiling', (f) => { f.trader.wallet.cash = -1; }],
    ['NaN risk ceiling', (f) => { f.ctx.cfg.risk.unprovenTradeRisk = NaN; }],
    ['infinite risk ceiling', (f) => { f.ctx.cfg.risk.unprovenTradeRisk = Infinity; }],
    ['negative risk ceiling', (f) => { f.ctx.cfg.risk.unprovenTradeRisk = -1; }],
    ['NaN venue quantity', (f) => { f.ctx.broker.entryQty = () => NaN; }],
    ['infinite venue quantity', (f) => { f.ctx.broker.entryQty = () => Infinity; }],
    ['negative venue quantity', (f) => { f.ctx.broker.entryQty = () => -1; }],
    ['venue quantity above request', (f) => { f.ctx.broker.entryQty = () => 3; }],
  ];
  for (const [name, configure] of cases) await t.test(name, async () => {
    const f = fixture(); configure(f);
    await f.trader.onCandle('AMD');
    assert.equal(diagnostics(f.trader).lastSizing, undefined);
  });
});

test('risk and equal ceilings explain initial sizing without extra getter calls', async (t) => {
  for (const [riskRate, bindingLimit, requestedQty, notional, stopRisk] of [
    [0.001, 'risk', 2.5, 250, 10], [0.002, 'both', 5, 500, 20],
  ] as const) await t.test(bindingLimit, async () => {
    const f = fixture();
    let equityReads = 0, leverageReads = 0, rateReads = 0;
    f.ctx.fund.equity = () => { equityReads++; return 10_000; };
    Object.defineProperty(f.ctx.cfg.risk, 'leverage', { get: () => { leverageReads++; return 1; } });
    Object.defineProperty(f.ctx.cfg.risk, 'unprovenTradeRisk', { get: () => { rateReads++; return riskRate; } });
    let submittedQty: number | undefined;
    const submit = f.ctx.broker.marketOrder;
    f.ctx.broker.marketOrder = (request: any) => { submittedQty = request.qty; return submit(request); };
    await f.trader.onCandle('AMD');
    const sizing = diagnostics(f.trader).lastSizing;
    assert.equal(sizing.bindingLimit, bindingLimit);
    assert.equal(sizing.requestedQty, requestedQty);
    assert.equal(sizing.roundedQty, requestedQty);
    assert.equal(sizing.actualNotional, notional);
    assert.equal(sizing.plannedStopRisk, stopRisk);
    assert.equal(submittedQty, requestedQty);
    assert.deepEqual({ equityReads, leverageReads, rateReads }, { equityReads: 1, leverageReads: 2, rateReads: 1 });
  });
});

test('venue rounding is reported once including zero-lot rejection', async (t) => {
  for (const roundedQty of [2, 0]) await t.test(String(roundedQty), async () => {
    const f = fixture();
    let roundingCalls = 0, submittedQty: number | undefined;
    f.ctx.broker.entryQty = (symbol: string, requestedQty: number) => {
      roundingCalls++; assert.equal(symbol, 'AMD'); assert.equal(requestedQty, 2.5); return roundedQty;
    };
    const submit = f.ctx.broker.marketOrder;
    f.ctx.broker.marketOrder = (request: any) => { submittedQty = request.qty; return submit(request); };
    await f.trader.onCandle('AMD');
    const sizing = diagnostics(f.trader).lastSizing;
    assert.equal(sizing.requestedQty, 2.5);
    assert.equal(sizing.roundedQty, roundedQty);
    assert.equal(sizing.actualNotional, roundedQty * 100);
    assert.equal(sizing.plannedStopRisk, roundedQty * 4);
    assert.equal(sizing.venueRounded, true);
    assert.equal(sizing.bindingLimit, 'risk');
    assert.equal(roundingCalls, 1);
    assert.equal(submittedQty, roundedQty || undefined);
    assert.equal(diagnostics(f.trader).lastReason, roundedQty ? 'entry-filled' : 'invalid-size');
    assert.deepEqual(f.counts(), { reservations: roundedQty ? 1 : 0, submissions: roundedQty ? 1 : 0 });
  });
});

test('minimum-notional and exposure denials retain sizing rather than becoming sizing limits', async (t) => {
  await t.test('minimum notional', async () => {
    const f = fixture(); f.trader.wallet.cash = 1;
    await f.trader.onCandle('AMD');
    const sizing = diagnostics(f.trader).lastSizing;
    assert.equal(sizing.bindingLimit, 'wallet');
    assert.equal(sizing.requestedQty, 0.005);
    assert.equal(sizing.roundedQty, 0.005);
    assert.equal(sizing.actualNotional, 0.5);
    assert.equal(sizing.plannedStopRisk, 0.02);
    assert.equal(diagnostics(f.trader).lastReason, 'minimum-notional');
    assert.deepEqual(f.counts(), { reservations: 0, submissions: 0 });
  });
  await t.test('exposure rejection', async () => {
    const f = fixture();
    let request: any;
    f.ctx.risk.reserveEntry = (r: any) => {
      request = r;
      const initial = diagnostics(f.trader).lastSizing;
      assert.equal(initial.actualNotional, r.notional);
      assert.equal(initial.plannedStopRisk, r.stopRisk);
      return { ok: false, reason: 'exposure limit' };
    };
    await f.trader.onCandle('AMD');
    const sizing = diagnostics(f.trader).lastSizing;
    assert.equal(sizing.bindingLimit, 'risk');
    assert.equal(sizing.roundedQty, 2.5);
    assert.equal(sizing.actualNotional, 250);
    assert.equal(sizing.plannedStopRisk, 10);
    assert.equal(request.notional, 250);
    assert.equal(request.stopRisk, 10);
    assert.equal(diagnostics(f.trader).lastReason, 'risk-rejected');
    assert.equal(f.counts().submissions, 0);
  });
});

test('initial sizing remains distinct from checkpoint repricing and later no-signal decisions', async () => {
  const f = fixture();
  f.ctx.persistExecution = async () => { f.ctx.feed.price = () => 101; };
  let submittedQty: number | undefined;
  const submit = f.ctx.broker.marketOrder;
  f.ctx.broker.marketOrder = (request: any) => { submittedQty = request.qty; return submit(request); };
  await f.trader.onCandle('AMD');
  const initial = diagnostics(f.trader).lastSizing;
  assert.equal(initial.referencePrice, 100);
  assert.equal(initial.actualNotional, 250);
  assert.equal(submittedQty, 2.5);
  assert.equal(f.trader.wallet.position?.entryPrice, 101);
  f.trader.wallet.position = null;
  f.strategy.genome.entry[0].right = { t: 'const', v: 1000 };
  await f.trader.onCandle('AMD');
  assert.equal(diagnostics(f.trader).lastReason, 'no-signal');
  assert.deepEqual(diagnostics(f.trader).lastSizing, initial);
});

test('agent panel labels and escapes the original optional sizing evaluation', async () => {
  const { agentPanel } = await import('../web/src/ui/panels');
  const f = fixture(); await f.trader.onCandle('AMD');
  const trader = f.trader.toTraderDTO(10_000, false);
  const sizing = trader.entryDiagnostics!.lastSizing!;
  sizing.symbol = '<old-symbol>'; sizing.strategyId = '<old-strategy>';
  sizing.evaluatedAt = 1_700_000_000_000;
  const snapshot: any = { traders: [trader], strategies: [], researchers: [] };
  const render = () => agentPanel(f.trader.toDTO(), snapshot).html;
  const html = render();
  assert.ok(html.includes('Last sizing evaluation (not a fill or approval)'));
  assert.ok(html.includes('&lt;old-symbol&gt;'));
  assert.ok(html.includes('&lt;old-strategy&gt;'));
  assert.ok(html.includes('2023-11-14T22:13:20.000Z'));
  assert.ok(html.includes('Wallet ceiling: $500.00'));
  assert.ok(html.includes('Risk ceiling: $250.00'));
  assert.ok(html.includes('Requested quantity: 2.5'));
  assert.ok(html.includes('Rounded quantity: 2.5'));
  assert.ok(html.includes('Planned stop risk: $10.00'));
  assert.ok(html.includes('Binding limit: risk'));
  assert.ok(!html.includes('<old-symbol>') && !html.includes('<old-strategy>'));
  delete trader.entryDiagnostics!.lastSizing;
  assert.ok(!render().includes('Last sizing evaluation'));
  delete trader.entryDiagnostics;
  assert.ok(!render().includes('Last sizing evaluation'));
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
