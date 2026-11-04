import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { config } from '../server/config';
import { RiskOfficer } from '../server/agents/riskOfficer';
import { Trader } from '../server/agents/trader';
import { Commander } from '../server/agents/commander';
import { Ecosystem } from '../server/ecosystem';
import { PaperBroker, NotSubmittedError } from '../server/broker/broker';
import { buildingPanel } from '../web/src/ui/panels';
import { AlpacaClient, AlpacaBroker } from '../server/broker/alpaca';
import { GuardedBroker } from '../server/broker/guard';

test('empty positions with outstanding Alpaca orders never authorize resume', async () => {
  const eco:any=new Ecosystem({...config,execution:'paper',universe:{...config.universe,scanStocks:false}} as any);
  eco.createAgents(); eco.cfg.execution='alpaca'; eco.feed.isStale=()=>false;
  eco.alpaca={account:async()=>({equity:eco.fundEquity(),cash:10000}),positions:async()=>[],openOrders:async()=>[{id:'accepted-1',symbol:'AMD',status:'accepted'}]};
  await eco.checkBroker(); eco.risk.resume();
  assert.equal(eco.risk.approveEntry(request).ok,false);
  assert.match(eco.risk.reconciliation.issues.join(';'),/outstanding.*accepted-1/);
});

test('Alpaca outstanding-order API requires a successful complete list', async () => {
  const c:any=new AlpacaClient(config); let response:any={status:200,json:[]};
  c.send=async(method:string,route:string)=>{assert.equal(method,'GET');assert.equal(route,'/v2/orders?status=open&limit=500&nested=true');return response;};
  assert.deepEqual(await c.openOrders(),[]);
  response={status:503,json:[]}; await assert.rejects(c.openOrders(),/open orders/);
  response={status:200,json:Array.from({length:500},(_,i)=>({id:String(i),symbol:'AMD',status:'accepted'}))};
  await assert.rejects(c.openOrders(),/completeness/);
});

test('terminal order status with missing execution data stays unresolved instead of inventing a fill', async () => {
  const c:any=new AlpacaClient({...config,assetClass:()=> 'stock'} as any);
  c.send=async(method:string)=>({status:200,json:method==='POST' ? {id:'bad-fill'} : {status:'filled'}});
  await assert.rejects(c.submitOrder({symbol:'AMD',side:'buy',qty:1,refPrice:100}),/execution|fill|invalid/i);
});

test('unconfirmed limit cancellation cannot submit a replacement tail', async () => {
  const c:any=new AlpacaClient({...config,assetClass:()=> 'crypto',limitOrders:true} as any);
  c.quote=async()=>({bid:99.5,ask:100}); c.priceIncrement=async()=>0.01;
  c.awaitFill=async()=>({qty:1,price:100,fee:0,time:1});
  c.readOrder=async()=>({status:'accepted',qty:0,avg:0});
  let posts=0;
  c.send=async(method:string)=>{if(method==='POST') posts++;return {status:200,json:{id:'waiting'}};};
  c.cfg.limitEntryWaitMs=0;
  await assert.rejects(c.submitOrder({symbol:'BTC',side:'buy',qty:1,refPrice:100}),/unresolved|terminal|confirm/i);
  assert.equal(posts,1);
});

function fixture() {
  let equity = 10000;
  const cfg = structuredClone({ ...config, isCore: undefined, assetClass: undefined, registerSymbol: undefined, unregisterSymbol: undefined, timeframeFor: undefined });
  Object.assign(cfg, { execution: 'paper', assetClass: () => 'stock' });
  const ctx: any = { cfg, feed: { isStale: () => false, price: () => 100 }, fund: { equity: () => equity, grossExposure: () => 0, symbolExposure: () => 0, netExposure: () => ({long:0,short:0}) }, universe: { isExplored: () => false, maxNotional: () => Infinity, exploredEntries: () => [] }, board: { bias: () => ({strength:0}) }, news() {}, emit() {}, unlock() {}, levelUp() {}, recordTrade() {}, marketOpen: () => true, broker: new PaperBroker(0,0), vault: { get: () => undefined } };
  const traders: Trader[] = [];
  ctx.persistExecution=async()=>{};
  const state = {peakEquity:10000,dayStartEquity:10000};
  const risk = new RiskOfficer(ctx,'risk','Risk',{} as any,traders,state);
  ctx.risk = risk;
  return {ctx,risk,traders,state,setEquity: (x:number) => {equity=x;}};
}
const request = {traderId:'t1',symbol:'AMD',notional:1000,side:'long' as const,stopRisk:9,unproven:true};

async function pausedEntry(configure?: (f: ReturnType<typeof fixture>) => void) {
  const f = fixture();
  const trader = new Trader(f.ctx, 't1', 'One', {} as any);
  f.traders.push(trader); trader.deposit(5000);
  let release!: () => void;
  let reached!: () => void;
  const checkpoint = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const saved: any[] = [];
  f.ctx.persistExecution = async () => {
    saved.push(structuredClone({ trader: trader.save(), risk: f.risk.save() }));
    if (saved.length === 1) { reached(); await gate; }
  };
  const orders: any[] = [];
  const paper = new PaperBroker(0, 0);
  f.ctx.broker = { marketOrder: (req: any) => { orders.push(req); return paper.marketOrder(req); } };
  configure?.(f);
  const opening = (trader as any).open({id:'s',symbol:'AMD',genome:{side:'long',sizePct:0.9,stopAtr:2}},100,5,1);
  await checkpoint;
  assert.equal(saved[0].trader.extra.executionIntent.kind, 'entry');
  assert.equal(saved[0].risk.extra.pending.length, 1);
  return { ...f, trader, orders, saved, release, opening };
}

test('entry checkpoint daily loss revokes submission and durably releases only its reservation', async () => {
  const f = await pausedEntry();
  f.setEquity(9800);
  f.release(); await f.opening;
  assert.equal(f.orders.length, 0);
  assert.equal(f.risk.dailyReviewRequired, true);
  assert.equal(f.trader.executionIntent, null);
  assert.equal(f.trader.orderPending, false);
  assert.equal(f.trader.wallet.position, null);
  assert.equal(f.saved.at(-1).trader.extra.executionIntent, null);
  assert.deepEqual(f.saved.at(-1).risk.extra.pending, []);
});

test('entry checkpoint market close revokes submission', async () => {
  const f = await pausedEntry();
  f.ctx.marketOpen = () => false;
  f.release(); await f.opening;
  assert.equal(f.orders.length, 0);
  assert.equal(f.trader.executionIntent, null);
  assert.deepEqual(f.saved.at(-1).risk.extra.pending, []);
});

test('entry checkpoint retains authorization from fresh reconciliation for its own reservation only', async () => {
  const f = await pausedEntry(f => {
    f.ctx.cfg.execution = 'alpaca';
    f.risk.updateReconciliation({at:Date.now(),ok:true,issues:[],broker:[],ledger:[]});
    f.ctx.cfg.risk.maxGrossExposure = 0.01;
    f.ctx.cfg.risk.maxNetLong = 0.01;
    f.ctx.cfg.risk.maxSymbolStopRisk = 0.001;
  });
  f.release(); await f.opening;
  assert.equal(f.orders.length, 1);
  assert.equal(f.trader.wallet.position?.qty, 1);
  assert.equal(f.trader.executionIntent, null);
  assert.equal(f.trader.orderPending, false);
  assert.deepEqual(f.saved.at(-1).risk.extra.pending, []);
});

test('entry checkpoint revalues fixed quantity against current exposure budget', async () => {
  const f = await pausedEntry(f => { f.ctx.cfg.risk.maxGrossExposure = 0.015; });
  f.ctx.feed.price = () => 200;
  f.release(); await f.opening;
  assert.equal(f.orders.length, 0);
  assert.equal(f.trader.executionIntent, null);
  assert.deepEqual(f.saved.at(-1).risk.extra.pending, []);
});

test('entry checkpoint cancellation persistence failure retains intent and reservation for offline review', async () => {
  const f = await pausedEntry();
  f.ctx.feed.isStale = () => true;
  f.ctx.persistExecution = async () => { throw new Error('cancellation disk failure'); };
  f.release(); await assert.rejects(f.opening, /cancellation disk failure/);
  assert.equal(f.orders.length, 0);
  assert.equal(f.trader.executionIntent?.kind, 'entry');
  assert.equal(f.trader.orderPending, false);
  assert.equal(f.risk.reconciliationReviewRequired, true);
  assert.equal((f.risk.save().extra as any).pending.length, 1);
  f.risk.resume();
  assert.equal(f.trader.executionIntent?.kind, 'entry');
});

test('entry checkpoint wallet reduction revokes the original fixed quantity', async () => {
  const f = await pausedEntry();
  f.trader.withdraw(4990);
  f.release(); await f.opening;
  assert.equal(f.orders.length, 0);
  assert.equal(f.trader.executionIntent, null);
  assert.deepEqual(f.saved.at(-1).risk.extra.pending, []);
});

test('entry checkpoint exit-only transition revokes submission', async () => {
  const f = await pausedEntry();
  f.trader.exitOnly = true;
  f.release(); await f.opening;
  assert.equal(f.orders.length, 0);
  assert.equal(f.trader.executionIntent, null);
  assert.deepEqual(f.saved.at(-1).risk.extra.pending, []);
});

test('entry checkpoint kill switch revokes submission using the actual halt path', async () => {
  const f = await pausedEntry();
  await f.risk.halt('checkpoint regression');
  f.release(); await f.opening;
  assert.equal(f.orders.length, 0);
  assert.equal(f.trader.executionIntent, null);
  assert.equal(f.trader.orderPending, false);
  assert.deepEqual(f.saved.at(-1).risk.extra.pending, []);
});

const checkpointRevocations: [string, (f: Awaited<ReturnType<typeof pausedEntry>>) => void][] = [
  ['stale data', f => { f.ctx.feed.isStale = () => true; }],
  ['missing current price', f => { f.ctx.feed.price = () => undefined; }],
  ['reduced trade risk limit', f => { f.ctx.cfg.risk.unprovenTradeRisk /= 2; }],
  ['reduced equity before daily loss threshold', f => { f.setEquity(9950); }],
  ['new gross exposure', f => { f.ctx.fund.grossExposure = () => 10000; }],
  ['new directional exposure', f => { f.ctx.fund.netExposure = () => ({long:10000,short:0}); }],
  ['new symbol exposure', f => { f.ctx.fund.symbolExposure = () => 10000; }],
  ['reduced liquidity', f => { f.ctx.universe.maxNotional = () => 50; }],
  ['adverse news', f => { f.ctx.board.bias = () => ({strength:1,score:-1}); }],
  ['another unresolved intent', f => {
    const other = new Trader(f.ctx, 't2', 'Two', {} as any);
    other.executionIntent = {kind:'entry',symbol:'MSFT',qty:1,side:'buy',at:Date.now()};
    f.traders.push(other);
  }],
  ['another pending reservation', f => {
    f.ctx.cfg.risk.maxGrossExposure = 0.015;
    f.risk.retainEntry({...request,traderId:'t2',symbol:'MSFT',notional:100});
  }],
];
for (const [name, revoke] of checkpointRevocations) test(`entry checkpoint rechecks ${name}`, async () => {
  const f = await pausedEntry();
  revoke(f); f.release(); await f.opening;
  assert.equal(f.orders.length, 0);
  assert.equal(f.trader.wallet.position, null);
  assert.equal(f.trader.executionIntent, null);
  assert.equal(f.trader.orderPending, false);
  assert.equal(f.saved.at(-1).risk.extra.pending.some((p: any) => p.traderId === 't1'), false);
  if (name === 'another pending reservation') {
    assert.equal(f.saved.at(-1).risk.extra.pending[0].traderId, 't2');
  }
});

for (const change of ['failed', 'stale', 'missing', 'other order revision'] as const) {
  test(`entry checkpoint does not waive ${change} broker reconciliation`, async () => {
    const f = await pausedEntry(f => {
      f.ctx.cfg.execution = 'alpaca';
      f.risk.updateReconciliation({at:Date.now(),ok:true,issues:[],broker:[],ledger:[]});
    });
    if (change === 'failed') f.risk.updateReconciliation({at:Date.now(),ok:false,issues:['venue mismatch'],broker:[],ledger:[]});
    if (change === 'stale') f.risk.reconciliation!.at = Date.now() - 180001;
    if (change === 'missing') f.risk.reconciliation = null;
    if (change === 'other order revision') f.risk.orderChanged();
    f.release(); await f.opening;
    assert.equal(f.orders.length, 0);
    assert.equal(f.trader.executionIntent, null);
    assert.deepEqual(f.saved.at(-1).risk.extra.pending, []);
  });
}

test('entry checkpoint normal path invokes guarded broker before authorization microtasks can run', async () => {
  const f = await pausedEntry();
  let changed = false;
  let submitted = 0;
  const check = f.risk.revalidateEntry.bind(f.risk);
  f.risk.revalidateEntry = req => {
    const verdict = check(req);
    queueMicrotask(() => { changed = true; });
    return verdict;
  };
  const paper = new PaperBroker(0, 0);
  f.ctx.broker = new GuardedBroker({mode:'paper',marketOrder: req => {
    assert.equal(changed, false);
    submitted++;
    return paper.marketOrder(req);
  }}, {maxOrderUsd:1000,maxOrdersPerHour:10});
  f.release(); await f.opening;
  assert.equal(submitted, 1);
  assert.equal(f.trader.wallet.position?.qty, 1);
  assert.equal(f.trader.executionIntent, null);
  assert.equal(f.trader.orderPending, false);
  assert.deepEqual(f.saved.at(-1).risk.extra.pending, []);
});

for (const guarded of [false, true]) for (const revoked of [false, true]) {
  test(`entry checkpoint fake Alpaca ${guarded ? 'guarded' : 'raw'} ${revoked ? 'revoked' : 'authorized'} submission`, async () => {
    let submissions = 0;
    const f = await pausedEntry(f => {
      f.ctx.cfg.execution = 'alpaca';
      f.risk.updateReconciliation({at:Date.now(),ok:true,issues:[],broker:[],ledger:[]});
      const client: any = new AlpacaClient(f.ctx.cfg);
      client.send = async (method: string, route: string, body: any) => {
        assert.equal(method, 'POST'); assert.equal(route, '/v2/orders');
        assert.equal(body.qty, '1');
        submissions++;
        return {status:200,json:{id:'fake-entry'}};
      };
      client.awaitFill = async () => ({symbol:'AMD',side:'buy',qty:1,price:100,fee:0,time:1});
      const raw = new AlpacaBroker(client);
      f.ctx.broker = guarded ? new GuardedBroker(raw,{maxOrderUsd:1000,maxOrdersPerHour:10}) : raw;
    });
    if (revoked) f.setEquity(9800);
    f.release(); await f.opening;
    assert.equal(submissions, revoked ? 0 : 1);
    assert.equal(f.trader.wallet.position?.qty ?? 0, revoked ? 0 : 1);
    assert.equal(f.trader.executionIntent, null);
    assert.equal(f.trader.orderPending, false);
    assert.deepEqual(f.saved.at(-1).risk.extra.pending, []);
  });
}

test('aggressive profile and old market-cap environment overrides cannot relax safety defaults', () => {
  const output=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',"import {config} from './server/config.ts'; console.log(JSON.stringify({risk:config.risk,owners:config.research.minTradersPerMarketCap,minimum:config.allocation.probationTrades}));"],{encoding:'utf8',env:{PATH:process.env.PATH,PROFILE:'aggressive',EXECUTION:'paper',DATA_PROVIDER:'sim',MAX_TRADERS_PER_MARKET:'40',LEVERAGE:'4'}});
  const c=JSON.parse(output);
  assert.equal(c.risk.unprovenTradeRisk,0.001);
  assert.equal(c.risk.maxSymbolStopRisk,0.0025);
  assert.equal(c.risk.dailyLossLimit,0.01);
  assert.equal(c.owners,1);
  assert.equal(c.minimum,20);
});

test('in-flight notional counts against gross and directional caps across different symbols', () => {
  const f=fixture();
  f.ctx.cfg.risk.maxGrossExposure=0.15;
  assert.equal(f.risk.reserveEntry(request).ok,true);
  assert.equal(f.risk.approveEntry({...request,traderId:'t2',symbol:'MSFT'}).ok,false);
  f.risk.releaseEntry('t1');
  f.ctx.cfg.risk.maxGrossExposure=1;
  f.ctx.cfg.risk.maxNetLong=0.15;
  assert.equal(f.risk.reserveEntry(request).ok,true);
  assert.equal(f.risk.approveEntry({...request,traderId:'t2',symbol:'MSFT'}).ok,false);
});

test('resume refuses stale market data and saved successful broker observations are never trusted', () => {
  const f=fixture(); f.risk.dailyReviewRequired=true;
  f.ctx.feed.isStale=()=>true;
  f.risk.resume();
  assert.equal(f.risk.dailyReviewRequired,true);
  f.ctx.feed.isStale=()=>false;
  f.ctx.cfg.execution='alpaca';
  f.risk.updateReconciliation({at:Date.now(),ok:true,issues:[],broker:[],ledger:[]});
  const restored=new RiskOfficer(f.ctx,'risk','Risk',{} as any,f.traders,f.state);
  restored.restore(f.risk.save());
  restored.resume();
  assert.equal(restored.dailyReviewRequired,true);
  assert.equal(restored.approveEntry(request).ok,false);
});

test('broker observations overlapping an order revision cannot authorize new entries', async () => {
  const eco:any=new Ecosystem({...config,execution:'paper',universe:{...config.universe,scanStocks:false}} as any);
  eco.createAgents();
  eco.cfg.execution='alpaca';
  let resolvePositions:any;
  eco.alpaca={openOrders:async()=>[],account:async()=>({equity:10000,cash:10000}),positions:()=>new Promise(resolve=>{resolvePositions=resolve;})};
  const checking=eco.checkBroker();
  eco.risk.orderChanged();
  resolvePositions([]);
  await checking;
  assert.equal(eco.risk.approveEntry(request).ok,false);
  assert.equal(eco.risk.toRiskDTO().reconciliationCurrent,false);
});

test('War Room shows entry review pause and an explicit review/resume control without kill switch', () => {
  const f=fixture(); f.risk.dailyReviewRequired=true;
  const html=buildingPanel('warroom',{risk:f.risk.toRiskDTO(),fund:{dayStartEquity:10000,equity:10000,grossExposure:0},llmCost:{enabled:false},provider:'sim'} as any).html;
  assert.match(html,/ENTRY PAUSED/);
  assert.match(html,/data-action="resume"/);
  assert.match(html,/Review.*resume/);
  assert.match(html,/exits remain available/i);
});

test('risk DTO exposes pause reasons, timestamps and last observed broker/ledger snapshots', () => {
  const f=fixture(); f.ctx.cfg.execution='alpaca';
  const observed={at:Date.now(),ok:false,issues:['AMD quantity mismatch'],broker:[{symbol:'AMD',qty:2}],ledger:[{symbol:'AMD',qty:1}]};
  f.risk.updateReconciliation(observed);
  const dto=f.risk.toRiskDTO();
  assert.equal(dto.entriesPaused,true);
  assert.equal(dto.reconciliation?.at,observed.at);
  assert.equal(dto.reconciliation?.broker[0].qty,2);
  assert.ok(dto.entryPauseReasons.some(r=>r.includes('reconciliation')));
  f.risk.orderChanged();
  assert.equal(f.risk.toRiskDTO().reconciliation?.at,observed.at);
  const recovered=new RiskOfficer(f.ctx,'risk','Risk',{} as any,f.traders,f.state);
  recovered.restore(f.risk.save());
  assert.equal(recovered.toRiskDTO().entriesPaused,true);
});

test('day rollover observes the previous loss before resetting its baseline', () => {
  const eco:any=new Ecosystem({...config,execution:'paper',universe:{...config.universe,scanStocks:false}} as any);
  eco.createAgents();
  eco.checkPeriodicAchievements=()=>{};
  eco.publishGazette=()=>{};
  eco.fundState.reserve=9899;
  eco.fundState.dayStartEquity=10000;
  eco.fundState.dayKey='2000-01-01';
  eco.minuteLoop();
  assert.equal(eco.risk.dailyReviewRequired,true);
});

test('season reset cannot bypass review or erase pending/open positions', async () => {
  const eco:any=new Ecosystem({...config,execution:'paper',universe:{...config.universe,scanStocks:false}} as any);
  eco.createAgents();
  eco.risk.dailyReviewRequired=true;
  await assert.rejects(eco.newSeason(),/review|resume/);
  eco.risk.dailyReviewRequired=false;
  eco.traders[0].orderPending=true;
  await assert.rejects(eco.newSeason(),/pending|position/);
  eco.traders[0].orderPending=false;
  eco.traders[0].executionIntent={kind:'entry',symbol:'AMD',side:'buy',qty:1,at:Date.now()};
  eco.save=async()=>{throw new Error('unexpected persistence called');};
  await assert.rejects(eco.newSeason(),/pending|position|unresolved/);
});

test('season reset rechecks pending orders after asynchronous backup work', async () => {
  const eco:any=new Ecosystem({...config,execution:'paper',universe:{...config.universe,scanStocks:false}} as any);
  eco.createAgents();
  eco.save=async()=>{eco.traders[0].orderPending=true;};
  await assert.rejects(eco.newSeason(),/pending|position/);
});

test('startup retains unconfigured and orphaned positions instead of dropping them', () => {
  const eco:any=new Ecosystem({...config,execution:'paper',universe:{...config.universe,scanStocks:false}} as any);
  eco.createAgents();
  eco.traders[0].wallet.position={symbol:'DELISTED',side:'long',qty:1,entryPrice:100,stop:90};
  eco.reconcile();
  assert.equal(eco.traders[0].wallet.position.symbol,'DELISTED');
  eco.reclaimOrphanWallets([{id:'t_orphan',xp:0,level:1,extra:{wallet:{cash:500,units:500,position:{symbol:'AMD',side:'long',qty:2,entryPrice:100,stop:90}}}}]);
  assert.equal(eco.traders.find((t:any)=>t.id==='t_orphan')?.wallet.position.qty,2);
  assert.equal(eco.risk.reconciliationReviewRequired,true);
});

test('exit bypasses entry pauses and books only executed quantity, retaining residual holdings', async () => {
  const f=fixture(); const t=new Trader(f.ctx,'t1','One',{} as any); f.traders.push(t);
  t.wallet.cash=1000;
  t.wallet.position={symbol:'AMD',side:'long',qty:2,entryPrice:100,entryFee:2,entryTime:1,strategyId:'s',stop:90} as any;
  f.risk.dailyReviewRequired=true;
  f.risk.reconciliationReviewRequired=true;
  let trade:any;
  f.ctx.recordTrade=(x:any)=>{trade=x;};
  f.ctx.broker={marketOrder:async(req:any)=>{assert.equal(req.closing,true);return {qty:1,price:110,fee:1,time:2};}};
  await t.flatten('stop loss');
  assert.equal(t.wallet.cash,1009);
  assert.equal(t.wallet.position?.qty,1);
  assert.equal(trade.qty,1);
  assert.equal(trade.pnl,8);
});

test('partial exit fragments cannot inflate the forward completed-trade sample', async () => {
  const f=fixture(); const t=new Trader(f.ctx,'t1','One',{} as any);
  t.wallet.cash=1000;
  t.wallet.position={symbol:'AMD',side:'long',qty:2,entryPrice:100,entryFee:0,entryTime:1,strategyId:'s',stop:90} as any;
  t.strategy={id:'s',live:{trades:0,pnl:0,grossWin:0,grossLoss:0,wins:0}} as any;
  f.ctx.broker={marketOrder:async()=>({qty:1,price:110,fee:0,time:2})};
  await t.flatten('stop loss');
  assert.equal(t.strategy!.live.trades,0);
  await t.flatten('stop loss');
  assert.equal(t.strategy!.live.trades,1);
});

test('missing broker holding never becomes invented realized PnL and latches review', async () => {
  const f=fixture(); const t=new Trader(f.ctx,'t1','One',{} as any); f.traders.push(t);
  t.wallet.cash=1000;
  t.wallet.position={symbol:'AMD',side:'long',qty:1,entryPrice:100,entryFee:0,entryTime:1,strategyId:'s',stop:90} as any;
  let trades=0; f.ctx.recordTrade=()=>{trades++;};
  f.ctx.broker={marketOrder:async()=>{throw new Error('alpaca holds no AMD position to close');}};
  await t.flatten('stop loss');
  assert.equal(trades,0); assert.equal(t.wallet.cash,1000); assert.equal(t.wallet.position?.qty,1);
  assert.equal(f.risk.reconciliationReviewRequired,true);
});

test('partial retirement stays attached and exit-only across restart and halt until residual is flat', async () => {
  const f=fixture(); const t=new Trader(f.ctx,'t1','One',{} as any); f.traders.push(t); t.deposit(1000);
  const s:any={id:'s',status:'active',name:'Test',symbol:'AMD',live:{trades:0,pnl:0,grossWin:0,grossLoss:0,wins:0},genome:{side:'long',stopAtr:2,sizePct:0.9}};
  t.strategy=s; f.ctx.vault.get=()=>s;
  t.wallet.position={symbol:'AMD',side:'long',qty:2,entryPrice:100,entryFee:0,entryTime:1,strategyId:'s',stop:90} as any;
  let retirements=0,orders=0;
  f.ctx.vault.retire=()=>{retirements++;};
  f.ctx.broker={marketOrder:async()=>{orders++;return {qty:1,price:100,fee:0,time:2};}};
  const treasury={reserve:0}; const c=new Commander(f.ctx,'c','Commander',{} as any,f.traders,treasury);
  await c.retire(t,'failed probation');
  assert.equal(retirements,0); assert.equal(t.strategy,s); assert.equal(t.wallet.position?.qty,1);
  const recovered=new Trader(f.ctx,'t1','One',{} as any); recovered.restore(t.save()); f.traders.splice(0,1,recovered);
  assert.equal((recovered as any).retiringReason,'failed probation');
  f.risk.halted=true;
  await c.tick();
  assert.equal(retirements,1); assert.equal(recovered.wallet.position,null); assert.equal(recovered.strategy,null); assert.equal(treasury.reserve,1000);
  assert.equal(orders,2);
});

test('unknown retirement exit retains attachment and suppresses duplicate exits through resume and restore', async () => {
  const f=fixture(); const t=new Trader(f.ctx,'t1','One',{} as any); f.traders.push(t); t.deposit(1000);
  const s:any={id:'s',status:'active',name:'Test',symbol:'AMD',live:{trades:0,pnl:0}}; t.strategy=s; f.ctx.vault.get=()=>s;
  t.wallet.position={symbol:'AMD',side:'long',qty:2,entryPrice:100,entryFee:0,entryTime:1,strategyId:'s',stop:90} as any;
  let orders=0,retired=0; f.ctx.vault.retire=()=>{retired++;};
  f.ctx.broker={marketOrder:async()=>{orders++;throw new Error('accepted exit; response lost');}};
  const c=new Commander(f.ctx,'c','Commander',{} as any,f.traders,{reserve:0});
  await c.retire(t,'failed probation');
  f.risk.updateReconciliation({at:Date.now(),ok:true,issues:[],broker:[],ledger:[]}); f.risk.resume();
  assert.equal(f.risk.reconciliationReviewRequired,true);
  await c.review(); await t.flatten('retry');
  const recovered=new Trader(f.ctx,'t1','One',{} as any); recovered.restore(t.save()); f.traders.splice(0,1,recovered);
  await c.review(); await recovered.flatten('retry after restart');
  assert.equal(orders,1); assert.equal(retired,0); assert.equal(recovered.strategy,s); assert.equal(recovered.wallet.position?.qty,2);
  assert.equal(recovered.executionIntent?.kind,'exit'); assert.equal(recovered.retiringReason,'failed probation');
});

test('recovered orphan stays exit-only after flatten and resume, including later restore', async () => {
  const eco:any=new Ecosystem({...config,execution:'paper',universe:{...config.universe,scanStocks:false}} as any); eco.createAgents();
  eco.persistExecution=async()=>{};
  eco.reclaimOrphanWallets([{id:'t_orphan',xp:0,level:1,extra:{wallet:{cash:500,units:500,position:{symbol:'AMD',side:'long',qty:1,entryPrice:100,entryFee:0,entryTime:1,strategyId:'s',stop:90}}}}]);
  const t=eco.traders.find((x:any)=>x.id==='t_orphan'); await t.flatten('liquidate recovered wallet'); eco.feed.isStale=()=>false; eco.risk.resume();
  let orders=0; eco.broker={marketOrder:async()=>{orders++;}};
  await t.open({id:'s',symbol:'AMD',genome:{side:'long',stopAtr:2,sizePct:0.9}},100,5,1);
  assert.equal(orders,0); assert.equal(t.exitOnly,true);
  const recovered=new Trader(eco,'t_orphan','Recovered',{} as any); recovered.restore(t.save()); assert.equal((recovered as any).exitOnly,true);
});

test('allocator never scales losing or low-sample strategies and never resizes pending wallets', () => {
  const f=fixture();
  const t=new Trader(f.ctx,'t1','One',{} as any); f.traders.push(t);
  const treasury={reserve:10000};
  const commander=new Commander(f.ctx,'c','Commander',{} as any,f.traders,treasury);
  t.strategy={trial:true,live:{trades:8,pnl:-1,grossWin:10,grossLoss:11}} as any;
  t.deposit(2000);
  t.orderPending=true;
  commander.rebalance();
  assert.equal(t.wallet.cash,2000);
  t.orderPending=false;
  commander.rebalance();
  const probation=10000 * (1-f.ctx.cfg.allocation.reserveFraction) * f.ctx.cfg.research.trialSizeFactor;
  assert.ok(t.wallet.cash<=probation);
});

test('ecosystem reconciles aggregate signed quantity and equity; errors are visible and block entries', async () => {
  const eco:any = new Ecosystem({...config,execution:'paper',universe:{...config.universe,scanStocks:false}} as any);
  eco.createAgents();
  Object.defineProperty(eco.cfg,'execution',{value:'alpaca',configurable:true});
  const t=eco.traders[0];
  t.wallet.position={symbol:'AMD',side:'long',qty:2,entryPrice:100,stop:90};
  eco.alpaca={openOrders:async()=>[],account:async()=>({equity:eco.fundEquity(),cash:10000}), positions:async()=>[{symbol:'AMD',qty:1,side:'long',marketValue:100}]};
  await eco.checkBroker();
  assert.equal(eco.risk.reconciliation?.ok,false);
  assert.match(eco.risk.reconciliation.issues.join(' '),/AMD/);
  assert.equal(eco.risk.approveEntry({...request,symbol:'MSFT'}).ok,false);
  eco.lastBrokerCheck=0;
  eco.alpaca.positions=async()=>{throw new Error('offline');};
  await eco.checkBroker();
  assert.match(eco.risk.reconciliation.issues.join(' '),/offline/);
});

test('Alpaca whole-share lot minimum skips safely before reservation or submission', async () => {
  for (const guarded of [false,true]) {
  const f=fixture(); const t=new Trader(f.ctx,'t1','One',{} as any); f.traders.push(t); t.deposit(5000);
  const client:any=new AlpacaClient(f.ctx.cfg); let submissions=0,persisted=0;
  client.send=async()=>{submissions++;throw new Error('must not submit');};
  const raw=new AlpacaBroker(client);
  f.ctx.broker=guarded ? new GuardedBroker(raw,{maxOrderUsd:1000,maxOrdersPerHour:10}) : raw; f.ctx.persistExecution=async()=>{persisted++;};
  const s:any={id:'s',symbol:'AMD',genome:{side:'long',sizePct:0.9,stopAtr:2}};
  await (t as any).open(s,100,10,1);
  assert.equal(submissions,0); assert.equal(persisted,0); assert.equal(t.executionIntent,null);
  assert.equal(f.risk.reconciliationReviewRequired,false); assert.equal(f.risk.approveEntry(request).ok,true);
  }
});

test('guard cap pre-submission rejection is typed and releases without ambiguous fund review', async () => {
  const f=fixture(); const t=new Trader(f.ctx,'t1','One',{} as any); f.traders.push(t); t.deposit(5000);
  const checkpoints:any[]=[]; f.ctx.persistExecution=async()=>{checkpoints.push(structuredClone(t.save()));};
  f.ctx.broker=new GuardedBroker(new PaperBroker(0,0),{maxOrderUsd:1,maxOrdersPerHour:10});
  await (t as any).open({id:'s',symbol:'AMD',genome:{side:'long',sizePct:0.9,stopAtr:2}},100,5,1);
  assert.equal(checkpoints.at(-1).extra.executionIntent,null);
  assert.equal(t.executionIntent,null); assert.equal(f.risk.reconciliationReviewRequired,false); assert.equal(f.risk.approveEntry(request).ok,true);
});

test('real trader sizes by stop risk and holds reservation during async order; release on failure', async () => {
  const f=fixture();
  const t=new Trader(f.ctx,'t1','One',{} as any); t.deposit(5000); f.traders.push(t);
  const strategy:any={id:'s',symbol:'AMD',name:'Test',genome:{side:'long',sizePct:0.9,stopAtr:2,takeProfitAtr:0},live:{trades:0,pnl:0,grossWin:0,grossLoss:0}};
  let finish:any;
  let order:any;
  f.ctx.broker={marketOrder: (req:any) => {order=req;return new Promise(resolve=>{finish=resolve;});}};
  const running=(t as any).open(strategy,100,5,1);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(order.qty,1);
  assert.equal(f.risk.approveEntry({...request,traderId:'t2'}).ok,false);
  assert.equal(t.orderPending,true);
  finish({symbol:'AMD',side:'buy',qty:1,price:100,fee:0,time:1});
  await running;
  assert.equal(t.orderPending,false);
  t.wallet.position=null;
  f.ctx.broker={marketOrder:async()=>{throw new NotSubmittedError('not filled');}};
  await (t as any).open(strategy,100,5,2);
  assert.equal(f.risk.approveEntry(request).ok,true);
});

test('ambiguous entry failure latches review and retains its reservation', async () => {
  const f=fixture(); const t=new Trader(f.ctx,'t1','One',{} as any); t.deposit(5000); f.traders.push(t);
  const strategy:any={id:'s',symbol:'AMD',name:'Test',genome:{side:'long',sizePct:0.9,stopAtr:2,takeProfitAtr:0}};
  f.ctx.broker={marketOrder:async()=>{throw new Error('order timed out: outcome unknown');}};
  await assert.rejects((t as any).open(strategy,100,5,1),/outcome unknown/);
  assert.equal(t.orderPending,false);
  assert.equal(f.risk.reconciliationReviewRequired,true);
  assert.equal((f.risk.save().extra as any).pending.length,1);
});

test('unknown execution intent survives empty-position reconciliation, ordinary resume and restart', async () => {
  const f=fixture(); const t=new Trader(f.ctx,'t1','One',{} as any); f.traders.push(t); t.deposit(5000);
  let submitted=0;
  f.ctx.broker={marketOrder:async()=>{submitted++;throw new Error('accepted but response lost');}};
  const strategy:any={id:'s',symbol:'AMD',genome:{side:'long',sizePct:0.9,stopAtr:2}};
  await assert.rejects((t as any).open(strategy,100,5,1));
  f.risk.updateReconciliation({at:Date.now(),ok:true,issues:[],broker:[],ledger:[]});
  f.risk.resume();
  await (t as any).open(strategy,100,5,2);
  assert.equal(f.risk.approveEntry(request).ok,false);
  assert.ok((t.save().extra as any).executionIntent);
  assert.equal((f.risk.save().extra as any).pending.length,1);
  const restored=new Trader(f.ctx,'t1','One',{} as any); restored.restore(t.save());
  f.traders.splice(0,1,restored);
  const risk=new RiskOfficer(f.ctx,'risk','Risk',{} as any,f.traders,f.state); risk.restore(f.risk.save()); f.ctx.risk=risk;
  risk.updateReconciliation({at:Date.now(),ok:true,issues:[],broker:[],ledger:[]}); risk.resume();
  await (restored as any).open(strategy,100,5,3);
  assert.equal(submitted,1);
  assert.equal(risk.approveEntry(request).ok,false);
});

test('restored pending reservation fails closed even if trader intent is missing', () => {
  const f=fixture(); assert.equal(f.risk.reserveEntry(request).ok,true);
  const recovered=new RiskOfficer(f.ctx,'risk','Risk',{} as any,f.traders,f.state); recovered.restore(f.risk.save());
  recovered.updateReconciliation({at:Date.now(),ok:true,issues:[],broker:[],ledger:[]}); recovered.resume();
  assert.equal(recovered.approveEntry({...request,traderId:'other',symbol:'MSFT'}).ok,false);
});

test('post-fill persistence failure keeps an unresolved flag that resume cannot clear', async () => {
  const f=fixture(); const t=new Trader(f.ctx,'t1','One',{} as any); f.traders.push(t); t.deposit(5000);
  let writes=0; f.ctx.persistExecution=async()=>{if(++writes===2) throw new Error('disk full');};
  await assert.rejects((t as any).open({id:'s',symbol:'AMD',genome:{side:'long',sizePct:0.9,stopAtr:2}},100,5,1),/disk full/);
  assert.ok(t.executionIntent);
  f.risk.updateReconciliation({at:Date.now(),ok:true,issues:[],broker:[],ledger:[]}); f.risk.resume();
  assert.equal(f.risk.approveEntry({...request,traderId:'other',symbol:'MSFT'}).ok,false);
});

test('wallet stays pending until successful fill booking is persisted', async () => {
  const f=fixture(); const t=new Trader(f.ctx,'t1','One',{} as any); f.traders.push(t); t.deposit(5000);
  let writes=0,finish:any; f.ctx.persistExecution=()=>++writes===2 ? new Promise<void>(resolve=>{finish=resolve;}) : Promise.resolve();
  const running=(t as any).open({id:'s',symbol:'AMD',genome:{side:'long',sizePct:0.9,stopAtr:2}},100,5,1);
  await new Promise(resolve=>setImmediate(resolve));
  try { assert.equal(t.orderPending,true); } finally { finish(); await running; }
  assert.equal(t.orderPending,false);
});

test('execution intent and reservation are on disk before a venue submission, and restore stays closed', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'risk-intent-'));
  try {
    const eco:any=new Ecosystem({...config,execution:'paper',universe:{...config.universe,scanStocks:false}} as any); eco.createAgents();
    eco.started=true; eco.stateFile=path.join(dir,'state.json'); eco.feed.isStale=()=>false; eco.feed.price=()=>100; eco.marketOpen=()=>true;
    const t=eco.traders[0]; t.deposit(5000);
    const symbol=eco.cfg.symbols[0]; let submitted=0;
    eco.broker={marketOrder:async()=>{
      submitted++;
      const state=JSON.parse(await readFile(eco.stateFile,'utf8'));
      const intent=state.agents.find((a:any)=>a.id===t.id).extra.executionIntent;
      assert.equal(intent.symbol,symbol);
      assert.equal(intent.side,'buy'); assert.ok(intent.at > 0);
      assert.ok(state.agents.find((a:any)=>a.id===eco.risk.id).extra.pending.some((p:any)=>p.traderId===t.id));
      throw new Error('accepted but disconnected');
    }};
    await assert.rejects(t.open({id:'s',symbol,genome:{side:'long',sizePct:0.9,stopAtr:2}},100,5,1),/accepted but disconnected/);
    assert.equal(submitted,1);
    const state=JSON.parse(await readFile(eco.stateFile,'utf8'));
    const fresh:any=new Ecosystem({...config,execution:'paper',universe:{...config.universe,scanStocks:false}} as any); fresh.createAgents(); fresh.feed.isStale=()=>false;
    for(const a of fresh.agents) {const saved=state.agents.find((s:any)=>s.id===a.id); if(saved) a.restore(saved);}
    fresh.risk.updateReconciliation({at:Date.now(),ok:true,issues:[],broker:[],ledger:[]}); fresh.risk.resume();
    assert.equal(fresh.risk.approveEntry({...request,symbol}).ok,false);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('failed pre-submission persistence never calls the venue', async () => {
  const f=fixture(); const t=new Trader(f.ctx,'t1','One',{} as any); f.traders.push(t); t.deposit(5000);
  f.ctx.persistExecution=async()=>{throw new Error('disk unavailable');}; let submitted=0;
  f.ctx.broker={marketOrder:async()=>{submitted++;}};
  await assert.rejects((t as any).open({id:'s',symbol:'AMD',genome:{side:'long',sizePct:0.9,stopAtr:2}},100,5,1),/disk unavailable/);
  assert.equal(submitted,0); assert.ok(t.executionIntent); f.risk.resume(); assert.equal(f.risk.approveEntry(request).ok,false);
});

test('entry reservations cover in-flight symbol ownership and planned stop risk', () => {
  const f=fixture();
  assert.equal(f.risk.approveEntry({...request,stopRisk:26}).ok,false);
  const first=f.risk.reserveEntry(request);
  assert.equal(first.ok,true);
  assert.equal(f.risk.reserveEntry({...request,traderId:'t2'}).ok,false);
  f.risk.releaseEntry('t1');
  assert.equal(f.risk.approveEntry(request).ok,true);
  const t=new Trader(f.ctx,'held','Held',{} as any);
  t.wallet.position={symbol:'AMD',side:'short',qty:1,entryPrice:100,stop:110} as any;
  f.traders.push(t);
  assert.equal(f.risk.approveEntry(request).ok,false);
});

test('venue reconciliation fails closed without cache and after failure/staleness; mismatch needs review', () => {
  const f = fixture();
  f.ctx.cfg.execution = 'alpaca';
  assert.equal(f.risk.approveEntry(request).ok,false);
  f.risk.updateReconciliation({ at: Date.now(), ok:true, issues:[], broker:[], ledger:[] });
  assert.equal(f.risk.approveEntry(request).ok,true);
  f.risk.updateReconciliation({ at: Date.now()-300001, ok:true, issues:[], broker:[], ledger:[] });
  assert.equal(f.risk.approveEntry(request).ok,false);
  f.risk.updateReconciliation({ at:Date.now(), ok:false, issues:['missing AMD'], broker:[], ledger:[] });
  f.risk.resume();
  assert.equal(f.risk.approveEntry(request).ok,false);
  f.risk.updateReconciliation({ at:Date.now(), ok:true, issues:[], broker:[], ledger:[] });
  assert.equal(f.risk.approveEntry(request).ok,false);
  f.risk.resume();
  assert.equal(f.risk.approveEntry(request).ok,true);
});

test('daily loss pauses entries across save/restore and day reset until explicit safe resume', async () => {
  const f = fixture();
  f.setEquity(9899);
  await f.risk.check();
  assert.equal(f.risk.approveEntry(request).ok, false);
  const saved = f.risk.save();
  f.state.dayStartEquity = 9899;
  const restored = new RiskOfficer(f.ctx,'risk','Risk',{} as any,f.traders,f.state);
  restored.restore(saved);
  await restored.check();
  assert.equal(restored.approveEntry(request).ok,false);
  restored.resume();
  assert.equal(restored.approveEntry(request).ok,true);
});
