import test from 'node:test';
import assert from 'node:assert/strict';
import { LlmBudget, freshCost } from '../server/llm/budget';
import { LlmClient } from '../server/llm/client';
import { config } from '../server/config';
import { Ecosystem } from '../server/ecosystem';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const usage = (costUsd: number) => ({ inputTokens: 1, outputTokens: 1, costUsd });
const ecosystemConfig = (dir: string): any => ({ ...cfg(), dataDir: dir, execution: 'paper', provider: 'sim', universe: { ...config.universe, scanStocks: false }, live: { ...config.live, approval: null } });
const cfg = (dailyBudgetUsd = 1): any => ({ ...config, frozen: { enabled: false }, llm: { ...config.llm, enabled: true, apiKey: 'fake-no-secret', baseUrl: 'http://fake.invalid', provider: 'anthropic', dailyBudgetUsd, priceInPerMTok: 1000, priceOutPerMTok: 1000 } });

test('legacy positive cost has unknown dated accounting and must preserve a review pause', () => {
  const b = new LlmBudget(freshCost(), 1);
  b.load({ dayKey: '2026-11-01', spentToday: 0, totalSpent: 6.2, totalCalls: 378, totalInputTokens: 8, totalOutputTokens: 9 } as any);
  assert.equal(b.canSpend(), false);
  assert.equal(b.paused, true);
  assert.match(b.snapshot().pauseReason!, /accounting/i);
  assert.equal(b.totalSpent(), 6.2);
});

test('real client refuses legacy zero checkpoints containing additional accounting evidence', async () => {
  const legacy = { dayKey: freshCost().dayKey, spentToday: 0, totalSpent: 0, totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0 };
  const reservation = { id: 'unresolved', day: legacy.dayKey, at: Date.now(), dollars: 0.1, scope: 'strategy', agentId: 'quill' };
  const previous = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = (async () => {
    posts++;
    return new Response(JSON.stringify({ content: [{ text: 'ok' }], usage: { input_tokens: 1, output_tokens: 2 } }));
  }) as any;
  try {
    for (const evidence of [{ reservations: [reservation] }, { reservations: [] }, { byDay: {} }, { grant: null },
      { paused: false }, { paused: true }, { pauseKind: 'earnings' }, { accountingComplete: false }, { version: undefined }]) {
      const b = new LlmBudget(freshCost(), 1);
      b.load({ ...legacy, ...evidence });
      b.setPersistence(async () => {});
      await assert.rejects(new LlmClient(cfg(), b).complete('x', { maxTokens: 10 }), JSON.stringify(evidence));
      assert.equal(posts, 0);
      assert.equal(b.snapshot().pauseKind, 'accounting');
      if (evidence.reservations?.length) assert.deepEqual(b.snapshot().reservations, [reservation]);
    }
    const clean = new LlmBudget(freshCost(), 1);
    clean.load(legacy);
    assert.equal(clean.canSpend(0.01), true, 'exact legacy zero schema still migrates');
    const restored = new LlmBudget({ ...freshCost(), reservations: [reservation] } as any, 1);
    assert.equal(restored.canSpend(0.01), false, 'versioned unresolved liability also blocks spending');
  } finally { globalThis.fetch = previous; }
});

test('real ecosystem shutdown revokes a pending paid-call checkpoint before transport', async () => {
  const dir = await mkdtemp('/opt/data/cache/scratch/llm-stop-');
  const previous = globalThis.fetch;
  let posts = 0, entered!: () => void, done!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let writes = 0, durable: any;
  const eco: any = new Ecosystem(ecosystemConfig(dir));
  eco.llmBudget.setPersistence(async (snapshot: any) => {
    if (++writes === 1) { entered(); await new Promise<void>(resolve => { done = resolve; }); }
    durable = snapshot;
  });
  globalThis.fetch = (async () => {
    posts++;
    return new Response(JSON.stringify({content:[{text:'ok'}],usage:{input_tokens:1,output_tokens:2}}));
  }) as any;
  try {
    const pending = eco.llm.complete('x',{maxTokens:10});
    const refused = assert.rejects(pending,/authorization changed/);
    await ready;
    await eco.stop();
    done(); await refused;
    assert.equal(posts,0);
    assert.equal(eco.llmBudget.snapshot().reservations.length,0);
    assert.equal(durable.reservations.length,0);
    eco.llmBudget.load(freshCost());
    await assert.rejects(eco.llm.complete('x',{maxTokens:10}));
    assert.equal(eco.llmBudget.canResume(),false);
    assert.equal(posts,0,'restoring state cannot reopen a stopped budget instance');
  } finally { globalThis.fetch = previous; done?.(); await eco.stop(); await rm(dir,{recursive:true,force:true}); }
});

function harness(cap = 0.045) {
  const b = new LlmBudget(freshCost(), cap);
  const checkpoints: any[] = [];
  b.setPersistence(async () => { checkpoints.push(b.snapshot()); });
  return { b, checkpoints, client: new LlmClient(cfg(cap), b) };
}

test('real client atomically reserves concurrent dollars and checkpoints before fake HTTP', async () => {
  const { b, checkpoints, client } = harness();
  const previous = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = (async () => {
    posts++;
    assert.ok(checkpoints.some(s => s.reservations.length === 1));
    await new Promise(r => setTimeout(r, 10));
    return new Response(JSON.stringify({ content: [{ text: 'ok' }], usage: { input_tokens: 1, output_tokens: 2 } }));
  }) as any;
  try {
    const results = await Promise.allSettled([client.complete('x', { maxTokens: 10 }), client.complete('x', { maxTokens: 10 })]);
    assert.equal(posts, 1);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(b.snapshot().reservations.length, 0);
    assert.equal(b.snapshot().attempts, 1);
    assert.equal(b.snapshot().totalCalls, 1);
  } finally { globalThis.fetch = previous; }
});

test('bounded evaluation persists before authority and re-pauses on expiry without forgiving prior spend', async () => {
  const { b } = harness(1);
  b.record(usage(0.8), 'strategy');
  b.pause('earnings', 'Direct authored costs exceeded direct realized P&L');
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(r => { entered = r; });
  b.setPersistence(async () => { entered(); await new Promise<void>(r => { release = r; }); });
  const grant = b.resumeEvaluation();
  await ready;
  assert.equal(b.canSpend(0.01), false);
  release();
  await grant;
  assert.equal(b.canSpend(0.19), true);
  assert.equal(b.canSpend(0.21), false);
  assert.ok(b.snapshot().grant!.maxAdditionalUsd <= 0.2);
  assert.equal(b.totalSpent(), 0.8);
  const now = Date.now;
  try {
    const expiresAt = b.snapshot().grant!.expiresAt;
    Date.now = () => expiresAt;
    assert.equal(b.canSpend(0.01), false);
    assert.equal(b.paused, true);
  } finally { Date.now = now; }
});

test('pending evaluation cannot activate after a newer pause or restored checkpoint', async () => {
  for (const revoke of ['earnings', 'accounting', 'load'] as const) {
    const { b } = harness(1);
    b.pause('earnings', 'Original pause');
    let entered!: () => void, done!: () => void;
    const ready = new Promise<void>(r => { entered = r; });
    b.setPersistence(async () => { entered(); await new Promise<void>(r => { done = r; }); });
    const pending = b.resumeEvaluation();
    await ready;
    if (revoke === 'load') {
      const restored = b.snapshot();
      restored.pauseReason = 'New restored pause';
      b.load(restored);
    } else b.pause(revoke, 'New pause');
    done(); await pending;
    assert.equal(b.evaluationActive(), false, revoke);
    assert.equal(b.canSpend(0.01), false, revoke);
    assert.equal(b.snapshot().pauseReason, revoke === 'load' ? 'New restored pause' : 'New pause');
    assert.equal(b.snapshot().pauseKind, revoke === 'accounting' ? 'accounting' : 'earnings');
  }
});

test('versioned corrupt checkpoint variants fail closed without losing safe lifetime totals', () => {
  for (const corrupt of [null, {}, { ...freshCost(), totalSpent: NaN }, { ...freshCost(), spentToday: null },
    { ...freshCost(), byDay: null }, { ...freshCost(), reservations: [{}] }, { ...freshCost(), totalCalls: -1 },
    { ...freshCost(), paused: false, pauseKind: 'earnings', pauseReason: 'bad', pausedAt: 1 },
    { ...freshCost(), byDay: { '2026-02-30': { strategy: 0, news: 0, other: 0 } } },
    { ...freshCost(), totalSpent: 5 },
    { ...freshCost(), byDay: { '2099-01-01': { strategy: 0, news: 0, other: 0 } } },
    { ...freshCost(), accountingStartedAt: Date.now() + 86400000 }]) {
    const b = new LlmBudget(freshCost(), 1);
    assert.doesNotThrow(() => b.load(corrupt));
    assert.equal(b.canSpend(), false, JSON.stringify(corrupt));
    assert.equal(b.snapshot().pauseKind, 'accounting');
  }
});

test('real ecosystem guard compares identical inclusive UTC day scopes, not lifetime or news cost', async () => {
  const now = Date.now;
  Date.now = () => Date.parse('2026-11-23T12:00:00Z');
  const dir = await mkdtemp('/opt/data/cache/scratch/llm-eco-');
  try {
    const c: any = { ...cfg(), dataDir: dir, execution: 'paper', provider: 'sim', universe: { ...config.universe, scanStocks: false }, live: { ...config.live, approval: null }, llm: { ...cfg().llm, earnWindowDays: 7 } };
    const eco: any = new Ecosystem(c);
    eco.llmBudget.setPersistence(async () => {});
    eco.seasonStartedAt = Date.parse('2026-10-01T00:00:00Z');
    eco.llmBudget.record(usage(10), 'strategy', '2026-11-16'); // outside inclusive Nov17..23
    eco.llmBudget.record(usage(0.4), 'news', '2026-11-23'); // news is not direct authored earnings
    eco.llmBudget.record(usage(0.1), 'strategy', '2026-11-17');
    eco.llmAttribution = { total: 0.2, byDay: { '2026-11-17': 0.2 } };
    await eco.enforceLlmEarnings();
    assert.equal(eco.llmBudget.paused, false);
    eco.llmAttribution.byDay['2026-11-17'] = -0.2;
    await eco.enforceLlmEarnings();
    assert.equal(eco.llmBudget.paused, true);
    const dto = eco.llmCostDTO();
    assert.equal(dto.window.strategyCost, 0.1);
    assert.equal(dto.window.newsCost, 0.4);
    assert.equal(dto.window.directAuthoredPnl, -0.2);
    assert.equal(dto.totalSpent, 10.5);
    assert.match(dto.accountingBasis, /estimated/i);
  } finally { Date.now = now; await rm(dir, { recursive: true, force: true }); }
});

test('ecosystem writes durable LLM checkpoint before POST and restores pause independently of season save', async () => {
  const dir = await mkdtemp('/opt/data/cache/scratch/llm-durable-');
  const previous = globalThis.fetch;
  const c = ecosystemConfig(dir);
  let posts = 0;
  globalThis.fetch = (async () => {
    posts++;
    const disk = JSON.parse(await readFile(path.join(dir, 'llm-cost.json'), 'utf8'));
    assert.equal(disk.reservations.length, 1);
    return new Response(JSON.stringify({ content: [{ text: 'ok' }], usage: { input_tokens: 1, output_tokens: 2 } }));
  }) as any;
  try {
    const eco: any = new Ecosystem(c);
    await eco.llm.complete('x', { maxTokens: 10, agentId: 'quill', category: 'strategy' });
    assert.equal(posts, 1);
    eco.llmBudget.pause('earnings', 'Persist me');
    await eco.llmBudget.persistPause();
    const restored: any = new Ecosystem(c);
    await restored.loadLlmCost(null);
    assert.equal(restored.llmBudget.paused, true);
    assert.equal(restored.llmCostDTO().pausedReason, 'Persist me');
    assert.equal(restored.llmCostDTO().totalCalls, 1);
    await writeFile(path.join(dir, 'llm-cost.json'), 'null');
    const corrupt: any = new Ecosystem(c);
    await corrupt.loadLlmCost(null);
    assert.equal(corrupt.llmCostDTO().status, 'paused-accounting');
  } finally { globalThis.fetch = previous; await rm(dir, { recursive: true, force: true }); }
});

test('real LLM agents report a pause ahead of countdowns and failed news leaves its batch unread', async () => {
  const dir = await mkdtemp('/opt/data/cache/scratch/llm-agents-');
  const previous = globalThis.fetch;
  let rejected = true;
  globalThis.fetch = (async (_url: any, init: any) => init?.method === 'POST' ? rejected ?
    new Response('provider-secret-error-body', { status: 400 }) :
    new Response(JSON.stringify({ content: [{ text: '[]' }], usage: { input_tokens: 1, output_tokens: 1 } })) :
    new Response('<rss><channel><item><title>BTC news</title><link>https://fake.invalid/story</link></item></channel></rss>')) as any;
  try {
    const c = ecosystemConfig(dir);
    c.llm.priceInPerMTok = 1; c.llm.priceOutPerMTok = 1;
    c.news = { ...config.news, enabled: true, feeds: ['https://fake.invalid/rss'] };
    const eco: any = new Ecosystem(c); eco.createAgents();
    eco.llmBudget.pause('earnings', 'Review required');
    eco.strategist.tick();
    assert.equal(eco.strategist.toResearcherDTO().readiness.state, 'paused-earnings');
    assert.match(eco.strategist.activity, /Review/);
    assert.doesNotMatch(eco.strategist.activity, /Pondering/);
    await eco.resumeLlm();
    const analyst = eco.analysts[0]; analyst.nextRunAt = 0;
    await analyst.tick();
    assert.equal(analyst.headlinesRead, 0);
    assert.equal(analyst.seen.size, 0);
    assert.equal(analyst.toAnalystDTO().readiness.state, 'error');
    assert.doesNotMatch(analyst.lastHeadline, /provider-secret/);
    rejected = false; analyst.nextRunAt = 0;
    await analyst.tick();
    assert.equal(analyst.headlinesRead, 1);
    assert.equal(analyst.seen.size, 1);
    assert.equal(analyst.toAnalystDTO().readiness.attempts, 2);
    assert.equal(analyst.toAnalystDTO().readiness.successes, 1);
  } finally { globalThis.fetch = previous; await rm(dir, { recursive: true, force: true }); }
});

test('failed no-submission release retains its liability without erasing a concurrent reservation', async () => {
  const { b } = harness(1);
  const first = await b.reserve(0.1);
  let entered!: () => void, fail!: () => void;
  const ready = new Promise<void>(r => { entered = r; });
  let calls = 0;
  b.setPersistence(async () => {
    if (++calls === 1) { entered(); await new Promise<void>((_resolve, reject) => { fail = () => reject(new Error('disk')); }); }
  });
  const release = b.release(first);
  const rejected = assert.rejects(release, /persistence/);
  await ready;
  const second = b.reserve(0.2);
  fail(); await rejected;
  const other = await second;
  assert.deepEqual(new Set(b.snapshot().reservations.map(r => r.id)), new Set([first.id, other.id]));
  assert.equal(b.canSpend(), false);
});

test('release retains spending headroom until its exact checkpoint commits', async () => {
  const { b } = harness(0.3);
  const r = await b.reserve(0.2);
  let entered!: () => void, done!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let saved: any;
  b.setPersistence((async (snapshot: any) => {
    saved = snapshot;
    entered();
    await new Promise<void>(resolve => { done = resolve; });
  }) as any);
  const releasing = b.release(r);
  await ready;
  assert.equal(b.canSpend(0.2), false, 'uncommitted release cannot authorize more spending');
  assert.ok(saved && !saved.reservations.some((x: any) => x.id === r.id));
  done(); await releasing;
  assert.equal(b.reserved(), 0);
  assert.equal(b.canSpend(0.2), true);
});
