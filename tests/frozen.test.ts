import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../server/config';
import { Ecosystem } from '../server/ecosystem';
import { STAFF } from '../server/roster';
import { sourceIdentity, fingerprint } from '../server/validation/frozen';

function settings(dir: string): any {
  return { ...config, dataDir: path.join(dir, 'normal-not-used'), execution: 'paper', provider: 'sim', traders: 2,
    frozen: { enabled: true, dataDir: dir, strategyIds: ['fixed'], endAt: Date.now() + 86_400_000, criteria: 'Stop at end; report net P&L and drawdown, no graduation.' },
    live: { ...config.live, enabled: false, venue: null, approval: null },
    universe: { ...config.universe, scanStocks: false },
    symbols: ['BTC'], symbolSpecs: [{ symbol: 'BTC', asset: 'crypto' }],
    assetClass: () => 'crypto', isCore: () => true, timeframeFor: () => 900000,
  };
}

test('opt-in requires distinct dedicated directory, selected IDs and a finite predeclared end and criteria', () => {
  const cfg = settings('/dedicated/frozen');
  for (const frozen of [
    { ...cfg.frozen, dataDir: '' }, { ...cfg.frozen, dataDir: cfg.dataDir },
    { ...cfg.frozen, strategyIds: [] }, { ...cfg.frozen, strategyIds: ['fixed', 'fixed'] },
    { ...cfg.frozen, endAt: NaN }, { ...cfg.frozen, endAt: Infinity }, { ...cfg.frozen, criteria: '' },
  ]) assert.throws(() => new Ecosystem({ ...cfg, frozen }), /frozen/i);
});

test('frozen constructor rejects every external execution venue before constructing clients', () => {
  for (const execution of ['alpaca', 'okx']) {
    assert.throws(() => new Ecosystem({ ...settings('/dedicated/frozen'), execution }), /frozen.*local paper/i);
  }
});

async function seed(cfg: any) {
  const eco: any = new Ecosystem({ ...cfg, dataDir: cfg.frozen.dataDir, frozen: { ...cfg.frozen, enabled: false } });
  eco.createAgents();
  const strategy: any = { id: 'fixed', name: 'Fixed', symbol: 'BTC', origin: 'evolution', author: 'Fixture', authorId: 'r_fixture', trial: false,
    genome: { side: 'long', entry: [{ left: { kind: 'close', p: [] }, op: '>', right: { t: 'const', v: 0 } }], exit: [], stopAtr: 2, takeProfitAtr: 0, trailAtr: 0, maxBars: 20, sizePct: 0.5, atrPeriod: 14 },
    createdAt: Date.now(), fitness: 1, train: { trades: 30 }, test: { trades: 10 },
    live: { trades: 0, wins: 0, pnl: 0, grossWin: 0, grossLoss: 0, lastTradeAt: null },
    status: 'active', traderId: eco.traders[0].id, retiredAt: null, retiredReason: null, epitaph: null };
  eco.vault.restore([strategy]); eco.traders[0].assign(strategy); eco.traders[0].deposit(1000); eco.fundState.reserve -= 1000;
  eco.started = true; await eco.save(true); eco.started = false;
}
function offline(cfg: any): any {
  const eco: any = new Ecosystem(cfg);
  eco.feed.provider = { name: 'fake' };
  eco.feed.start = async () => {}; eco.feed.stop = () => {};
  eco.feed.series = () => []; eco.feed.price = () => 100; eco.feed.isStale = () => false;
  return eco;
}
async function fixture(fn: (cfg: any) => Promise<void>) {
  const dir = await mkdtemp('/opt/data/cache/scratch/frozen-test-');
  try { const cfg = settings(dir); await seed(cfg); await fn(cfg); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('startup freezes restored assigned strategies, universe, costs, controls and evidence once', async () => {
  await fixture(async cfg => {
    const eco = offline(cfg);
    eco.scheduleResearch = () => {};
    try {
      await eco.start();
      const manifest = JSON.parse(await readFile(path.join(cfg.frozen.dataDir, 'frozen-manifest.json'), 'utf8'));
      assert.equal(manifest.version, 1);
      assert.match(manifest.fingerprint, /^[a-f0-9]{64}$/);
      assert.equal(manifest.definition.strategies[0].id, 'fixed');
      assert.equal(manifest.definition.universe[0].symbol, 'BTC');
      assert.equal(manifest.definition.costs[0].feeRate, cfg.feeRate);
      assert.equal(manifest.definition.controls.risk.unprovenTradeRisk, cfg.risk.unprovenTradeRisk);
      assert.equal(manifest.startingEvidence.fund.startingCapital, cfg.startingCapital);
      assert.equal(eco.snapshot().frozenExperiment.fingerprint, manifest.fingerprint);
      assert.equal(eco.cfg.dataDir, cfg.frozen.dataDir);
    } finally { await eco.stop(); }
  });
});

test('initial enrollment rejects trial, missing assignments, positions and pending intents before market startup', async () => {
  const corruptions: ((s: any) => void)[] = [
    s => { s.strategies[0].trial = true; },
    s => { s.strategies[0].status = 'vault'; },
    s => { s.strategies[0].symbol = 'MISSING'; },
    s => { s.agents.find((a: any) => a.id === s.strategies[0].traderId).extra.wallet.position = { symbol: 'BTC', qty: 1 }; },
    s => { s.agents.find((a: any) => a.id === s.strategies[0].traderId).extra.executionIntent = { kind: 'entry' }; },
    s => { s.agents.find((a: any) => a.id === STAFF.risk.id).extra.pending = [{ traderId: 't_unknown' }]; },
    s => { s.agents.find((a: any) => a.id === STAFF.risk.id).extra.reconciliation = { ok: true, broker: [] }; },
    s => { s.executionMode = 'alpaca'; },
  ];
  for (const corrupt of corruptions) await fixture(async cfg => {
    const file = path.join(cfg.frozen.dataDir, 'state.json');
    const saved = JSON.parse(await readFile(file, 'utf8')); corrupt(saved); await writeFile(file, JSON.stringify(saved));
    const eco = offline(cfg); let starts = 0; eco.feed.start = async () => { starts++; };
    try { await assert.rejects(eco.start(), /frozen/i); assert.equal(starts, 0); }
    finally { await eco.stop(); }
  });
});

test('restart verifies the same immutable manifest and checkpoints the fingerprint before feed startup', async () => {
  await fixture(async cfg => {
    const file = path.join(cfg.frozen.dataDir, 'frozen-manifest.json');
    const first = offline(cfg); let observed = false;
    first.feed.start = async () => {
      const state = JSON.parse(await readFile(path.join(cfg.frozen.dataDir, 'state.json'), 'utf8'));
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(state.frozenFingerprint, manifest.fingerprint); observed = true;
    };
    try { await first.start(); assert.equal(observed, true); } finally { await first.stop(); }
    const bytes = await readFile(file, 'utf8');
    const second = offline(cfg);
    try { await second.start(); assert.equal(await readFile(file, 'utf8'), bytes); }
    finally { await second.stop(); }
  });
});

test('pollMs drift rejects restart before feed startup while the enrolled cadence still restarts', async () => {
  await fixture(async cfg => {
    cfg.pollMs = 10000;
    const first = offline(cfg); let enrollmentStarts = 0;
    first.feed.start = async () => { enrollmentStarts++; };
    try { await first.start(); assert.equal(enrollmentStarts, 1); }
    finally { await first.stop(); }
    const file = path.join(cfg.frozen.dataDir, 'frozen-manifest.json');
    const bytes = await readFile(file, 'utf8');

    const drifted = offline({ ...cfg, pollMs: 20000 }); let driftedStarts = 0;
    drifted.feed.start = async () => { driftedStarts++; };
    try {
      await assert.rejects(drifted.start(), /frozen.*config mismatch/i);
      assert.equal(driftedStarts, 0);
    } finally { await drifted.stop(); }
    assert.equal(await readFile(file, 'utf8'), bytes);

    const same = offline(cfg); let restartStarts = 0;
    same.feed.start = async () => { restartStarts++; };
    try { await same.start(); assert.equal(restartStarts, 1); }
    finally { await same.stop(); }
    assert.equal(await readFile(file, 'utf8'), bytes);
  });
});

test('expiry blocks actual candle entries and risk approval after ordinary and direct risk resume, while exits remain', async () => {
  await fixture(async cfg => {
    const eco = offline(cfg); const clock = Date.now;
    eco.feed.series = () => Array.from({ length: 100 }, (_, i) => ({ t: i + 1, o: 100, h: 101, l: 99, c: 100, v: 1000 }));
    let orders = 0; const submit = eco.broker.marketOrder.bind(eco.broker);
    eco.broker.marketOrder = (req: any) => { orders++; return submit(req); };
    try {
      await eco.start();
      const trader = eco.traders[0]; await trader.onCandle('BTC');
      assert.ok(trader.wallet.position); assert.equal(orders, 1);
      Date.now = () => cfg.frozen.endAt + 1;
      eco.minuteLoop(); eco.resume(); eco.risk.resume();
      const req = { traderId: eco.traders[1].id, symbol: 'BTC', side: 'long', notional: 100, stopRisk: 1, unproven: true };
      assert.equal(eco.risk.approveEntry(req).ok, false);
      await trader.flatten('experiment expiry exit'); assert.equal(trader.wallet.position, null); assert.equal(orders, 2);
      eco.resume(); eco.risk.resume();
      await trader.onCandle('BTC'); assert.equal(orders, 2); assert.equal(trader.wallet.position, null);
      assert.equal(eco.snapshot().frozenExperiment.expired, true);
      assert.ok(eco.snapshot().risk.entryPauseReasons.some((r: string) => /frozen.*end/i.test(r)));
    } finally { Date.now = clock; await eco.stop(); }
  });
});

test('retirement still closes through broker and returns capital, never replaces, and restart accepts the retired original', async () => {
  await fixture(async cfg => {
    const first = offline(cfg);
    try {
      await first.start();
      const trader = first.traders[0];
      await trader.open(trader.strategy, 100, 1, 1);
      assert.ok(trader.wallet.position);
      trader.retiringReason = 'predeclared retirement enforcement';
      await first.commander.tick();
      assert.equal(trader.wallet.position, null); assert.equal(trader.strategy, null);
      assert.equal(first.vault.get('fixed').status, 'retired');
      assert.equal(first.commander.retirements, 1); assert.equal(first.commander.hires, 0);
    } finally { await first.stop(); }
    const second = offline(cfg);
    try { await second.start(); assert.equal(second.traders[0].strategy, null); assert.equal(second.commander.hires, 0); }
    finally { await second.stop(); }
  });
});

test('enrolled data cannot run as a normal fund when the opt-in flag is removed', async () => {
  await fixture(async cfg => {
    const first = offline(cfg); try { await first.start(); } finally { await first.stop(); }
    const second = offline({ ...cfg, dataDir: cfg.frozen.dataDir, frozen: { ...cfg.frozen, enabled: false } });
    let starts = 0; second.feed.start = async () => { starts++; };
    try { await assert.rejects(second.start(), /frozen/i); assert.equal(starts, 0); }
    finally { await second.stop(); }
  });
});

test('frozen removes restored external signals and never calls chart/news influence on candle dispatch', async () => {
  await fixture(async cfg => {
    const file = path.join(cfg.frozen.dataDir, 'state.json'); const saved = JSON.parse(await readFile(file, 'utf8'));
    saved.signals = [{ id: 'old-news', source: 'news', symbol: 'BTC', direction: 'short', confidence: 1, createdAt: Date.now(), expiresAt: cfg.frozen.endAt }];
    await writeFile(file, JSON.stringify(saved));
    const eco = offline(cfg);
    try {
      await eco.start(); assert.deepEqual(eco.board.all(), []);
      let chartCalls = 0; eco.scout.onCandle = () => { chartCalls++; };
      eco.onCandle('BTC'); await eco.traders[0].onTick();
      assert.equal(chartCalls, 0); assert.equal(eco.board.bias('BTC').strength, 0);
      assert.equal(eco.snapshot().frozenExperiment.realDataForward, false);
    } finally { await eco.stop(); }
  });
});

test('restart rejects config, assignment/evidence drift, tampering, missing manifest and unresolved intent without refreezing', async () => {
  const changes: ((cfg: any, state: any, manifest: any) => string | void)[] = [
    c => { c.risk = { ...c.risk, unprovenTradeRisk: 0.003 }; },
    c => { c.feeRate += 0.001; }, c => { c.timeframeFor = () => 3600000; },
    c => { c.traders += 1; }, c => { c.frozen = { ...c.frozen, endAt: c.frozen.endAt + 1 }; },
    c => { c.frozen = { ...c.frozen, criteria: 'new criteria' }; },
    (_c, s) => { s.strategies[0].genome.sizePct = 0.8; },
    (_c, s) => { s.strategies[0].train.trades += 1; },
    (_c, s) => { s.strategies[0].traderId = 'different-owner'; },
    (_c, s) => { s.agents.find((a: any) => a.id === s.strategies[0].traderId).extra.wallet.position = { symbol: 'OTHER', strategyId: 'not-fixed' }; },
    (_c, s) => { s.agents.find((a: any) => a.id === s.strategies[0].traderId).extra.executionIntent = { kind: 'entry', symbol: 'BTC' }; },
    (_c, s) => { s.executionMode = 'alpaca'; },
    (_c, _s, m) => { m.startingEvidence.fund.startingCapital += 1; },
    () => 'remove',
  ];
  for (const change of changes) await fixture(async cfg => {
    const first = offline(cfg); try { await first.start(); } finally { await first.stop(); }
    const stateFile = path.join(cfg.frozen.dataDir, 'state.json'); const manifestFile = path.join(cfg.frozen.dataDir, 'frozen-manifest.json');
    const state = JSON.parse(await readFile(stateFile, 'utf8')); const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    const remove = change(cfg, state, manifest) === 'remove';
    await writeFile(stateFile, JSON.stringify(state));
    if (remove) await rm(manifestFile); else { await chmod(manifestFile, 0o644); await writeFile(manifestFile, JSON.stringify(manifest)); }
    const second = offline(cfg); let starts = 0; second.feed.start = async () => { starts++; };
    try { await assert.rejects(second.start(), /frozen/i); assert.equal(starts, 0); }
    finally { await second.stop(); }
    if (remove) await assert.rejects(readFile(manifestFile), /ENOENT/);
  });
});

test('disabled mode preserves ordinary research, news/discovery dispatch, signals and allocations', async () => {
  await fixture(async cfg => {
    const eco = offline({ ...cfg, dataDir: cfg.frozen.dataDir, frozen: { ...cfg.frozen, enabled: false } });
    let research = 0; let shadow = 0; let influence = 0;
    eco.scheduleResearch = () => { research++; }; eco.dsaResearch.start = async () => { shadow++; };
    const create = eco.createAgents.bind(eco);
    eco.createAgents = () => { create(); for (const a of [eco.strategist, eco.explorer, ...eco.analysts]) a.tick = () => { influence++; }; };
    try {
      await eco.start(); await eco.fastLoop();
      assert.equal(research, 1); assert.equal(shadow, 1); assert.ok(influence > 0);
      assert.ok(eco.commander.rebalances > 0); assert.equal(eco.snapshot().frozenExperiment, null);
      let charts = 0; eco.scout.onCandle = () => { charts++; }; eco.onCandle('BTC'); await eco.traders[0].onTick(); assert.equal(charts, 1);
    } finally { await eco.stop(); }
  });
});

test('expiry during durable entry checkpoint revokes submission without spending or erasing intent controls', async () => {
  await fixture(async cfg => {
    const eco = offline(cfg); const clock = Date.now;
    let orders = 0; eco.broker.marketOrder = async () => { orders++; throw new Error('must not submit'); };
    try {
      await eco.start();
      const persist = eco.persistExecution.bind(eco); let checkpoints = 0;
      eco.persistExecution = async () => { await persist(); if (++checkpoints === 1) Date.now = () => cfg.frozen.endAt + 1; };
      const trader = eco.traders[0]; await trader.open(trader.strategy, 100, 1, 1);
      assert.equal(orders, 0); assert.equal(trader.wallet.position, null); assert.equal(trader.executionIntent, null);
      assert.deepEqual(eco.risk.save().extra.pending, []);
      eco.risk.resume();
      const req = { traderId: trader.id, symbol: 'BTC', side: 'long', notional: 100, stopRisk: 1, unproven: true };
      assert.equal(eco.risk.reserveEntry(req).ok, false);
    } finally { Date.now = clock; await eco.stop(); }
  });
});

test('ordinary fast loop retains earnings enforcement before commander dispatch', async () => {
  const cfg = settings('/dedicated/frozen'); cfg.frozen.enabled = false;
  const eco = offline(cfg); eco.createAgents(); const order: string[] = [];
  eco.enforceLlmEarnings = () => { order.push('earnings'); }; eco.commander.tick = async () => { order.push('commander'); };
  eco.strategist.tick = () => {}; eco.explorer.tick = () => {}; eco.analysts = [];
  await eco.fastLoop(); assert.deepEqual(order, ['earnings', 'commander']);
});

test('source exports without git pin actual source content and refuse a changed local artifact on restart', async () => {
  await fixture(async cfg => {
    const first = offline(cfg); try { await first.start(); } finally { await first.stop(); }
    const source = new URL(`../server/validation/frozen-identity-probe-${process.pid}.ts`, import.meta.url);
    await writeFile(source, 'export const identityProbe = 1;\n');
    const second = offline(cfg); let starts = 0; second.feed.start = async () => { starts++; };
    try { await assert.rejects(second.start(), /frozen.*(artifact|config|source)/i); assert.equal(starts, 0); }
    finally { await second.stop(); await rm(source, { force: true }); }
  });
});

test('restart retains known local-paper positions for exits and cannot extend an expired deadline', async () => {
  await fixture(async cfg => {
    const first = offline(cfg); const clock = Date.now;
    try {
      await first.start(); await first.traders[0].open(first.traders[0].strategy, 100, 1, 1);
      assert.ok(first.traders[0].wallet.position);
    } finally { await first.stop(); }
    Date.now = () => cfg.frozen.endAt + 1;
    const second = offline(cfg);
    try {
      await second.start(); assert.ok(second.traders[0].wallet.position);
      second.risk.resume(); second.resume();
      assert.equal(second.snapshot().frozenExperiment.endAt, cfg.frozen.endAt);
      await second.traders[0].flatten('known local-paper restart exit'); assert.equal(second.traders[0].wallet.position, null);
      second.risk.resume();
      assert.equal(second.risk.approveEntry({ traderId: second.traders[0].id, symbol: 'BTC', side: 'long', notional: 100, stopRisk: 1, unproven: true }).ok, false);
    } finally { Date.now = clock; await second.stop(); }
  });
});

test('content identity is deterministic without git and includes both source and dependency lockfile bytes', async () => {
  const root = await mkdtemp('/opt/data/cache/scratch/frozen-source-');
  try {
    await mkdir(path.join(root, 'server')); await mkdir(path.join(root, 'shared'));
    for (const name of ['package.json', 'package-lock.json', 'tsconfig.server.json', 'server/example.ts', 'shared/types.ts']) await writeFile(path.join(root, name), '{}');
    const initial = await sourceIdentity(root); assert.equal(await sourceIdentity(root), initial);
    assert.equal(fingerprint({ b: 1, a: [2] }), fingerprint({ a: [2], b: 1 }));
    await writeFile(path.join(root, 'server/example.ts'), 'export const revision = 2;'); const changedSource = await sourceIdentity(root); assert.notEqual(changedSource, initial);
    await writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}'); assert.notEqual(await sourceIdentity(root), changedSource);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('frozen experiments never advertise graduation or inherit a prior graduate badge', async () => {
  await fixture(async cfg => {
    const file = path.join(cfg.frozen.dataDir, 'state.json'); const saved = JSON.parse(await readFile(file, 'utf8'));
    saved.unlocked.graduate = Date.now(); await writeFile(file, JSON.stringify(saved));
    const eco = offline(cfg);
    try {
      await eco.start();
      assert.ok(eco.snapshot().graduation.some((c: any) => c.id === 'frozen_experiment' && !c.passed));
      assert.equal(eco.snapshot().achievements.find((a: any) => a.id === 'graduate').unlockedAt, null);
    } finally { await eco.stop(); }
  });
});

test('marker existence blocks normal activation even for JSON null, malformed or incomplete enrollment', async () => {
  for (const name of ['frozen-enrollment.json', 'frozen-manifest.json']) for (const contents of ['null', '{broken']) {
    await fixture(async cfg => {
      await writeFile(path.join(cfg.frozen.dataDir, name), contents);
      const eco = offline({ ...cfg, dataDir: cfg.frozen.dataDir, frozen: { ...cfg.frozen, enabled: false } });
      let starts = 0; eco.feed.start = async () => { starts++; };
      try { await assert.rejects(eco.start(), /frozen/i); assert.equal(starts, 0); }
      finally { await eco.stop(); }
      const enabled = offline(cfg);
      try { await assert.rejects(enabled.start(), /frozen/i); }
      finally { await enabled.stop(); }
    });
  }
});

test('frozen actual lifecycle never schedules research, LLM, news or discovery and commander cannot allocate or swap', async () => {
  await fixture(async cfg => {
    const eco = offline(cfg); let research = 0; let shadow = 0;
    eco.scheduleResearch = () => { research++; }; eco.dsaResearch.start = async () => { shadow++; };
    try {
      await eco.start();
      let influence = 0;
      for (const agent of [eco.strategist, eco.explorer, ...eco.analysts]) agent.tick = () => { influence++; };
      eco.researchers.forEach((r: any) => { r.work = () => { influence++; }; });
      const trader = eco.traders[0];
      const waiting = { ...structuredClone(trader.strategy), id: 'better', status: 'vault', traderId: null, fitness: 100 };
      eco.vault.restore([waiting]);
      const before = { cash: trader.wallet.cash, units: trader.wallet.units, reserve: eco.fundState.reserve };
      await eco.fastLoop(); eco.commander.assignIdle(); eco.commander.upgradeUntested(); eco.commander.rebalance(); eco.commander.revalidateVault();
      assert.equal(research, 0); assert.equal(shadow, 0); assert.equal(influence, 0);
      assert.equal(trader.strategy.id, 'fixed'); assert.equal(eco.traders[1].strategy, null);
      assert.deepEqual({ cash: trader.wallet.cash, units: trader.wallet.units, reserve: eco.fundState.reserve }, before);
      assert.equal(eco.commander.rebalances, 0);
      assert.equal(eco.cfg.llm.enabled, false); assert.equal(eco.cfg.news.enabled, false); assert.equal(eco.cfg.universe.scanEnabled, false);
      await assert.rejects(eco.newSeason(), /frozen/i);
    } finally { await eco.stop(); }
  });
});
