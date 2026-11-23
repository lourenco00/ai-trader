import assert from 'node:assert/strict';
import test from 'node:test';
import { Commander } from '../server/agents/commander';
import { Trader } from '../server/agents/trader';
import { PaperBroker } from '../server/broker/broker';
import { StrategyVault, emptyLive, type StrategyRecord } from '../server/strategy/vault';
import type { Candle } from '../shared/types';

function record(id: string, symbol = 'A', fitness = 1, trial = false): StrategyRecord {
  const metrics = { totalReturn: fitness, sharpe: 2, sortino: 2, maxDrawdown: 0.05, winRate: 0.6, profitFactor: 2, trades: 30, exposure: 0.1, avgTrade: 0.01 };
  return { id, name: id, symbol, fitness, trial, status: 'vault', live: emptyLive(), author: 'test', authorId: 'r', origin: 'evolution', createdAt: Date.now(), train: {...metrics}, test: {...metrics}, traderId: null, retiredAt: null, retiredReason: null, epitaph: null,
    genome: { side: 'long', entry: [{left: {kind:'close',p:[]},op:'>',right:{t:'const',v:1000}}], exit: [], stopAtr: 2, takeProfitAtr: 0, trailAtr: 0, maxBars: 20, sizePct: 0.1 + fitness / 10000, atrPeriod: 7 } };
}
function fixture() {
  const bars: Candle[] = Array.from({length:100}, (_,i) => ({t: Date.now() - (105-i)*60_000,o:100,h:101,l:99,c:100,v:100}));
  const vault = new StrategyVault(30);
  const ctx: any = { cfg: { frozen: {enabled:false}, assetClass:()=> 'crypto', timeframeFor:()=>60_000,
    allocation: {reserveFraction:0.2,probationTrades:6}, research: {maxTrialTraders:0,trialSizeFactor:0.1}, retirement:{idleDays:4,minTradesForJudgement:6,navFloor:0.9,minProfitFactorAfter15:1}, risk:{traderMaxDrawdown:0.12}},
    vault, feed:{series:()=>bars,price:()=>100}, risk:{halted:false},fund:{equity:()=>10_000},marketOpen:()=>true,news(){},emit(){},unlock(){},levelUp(){} };
  const trader = new Trader(ctx,'t','Trader',{} as any);
  const treasury = {reserve:9000};
  const commander = new Commander(ctx,'c','Commander',{} as any,[trader],treasury);
  const cur = record('current'); vault.restore([cur]); vault.assign(cur.id,trader.id); trader.assign(cur); trader.deposit(1000);
  return {ctx,bars,vault,trader,commander,cur,treasury};
}
test('trial swaps uphold cap and reject oversized wallets while compatible upgrades remain legal', () => {
  for (const kind of ['cap','oversized','legal-trial','legal-full'] as const) {
    const f=fixture(); f.cur.trial=kind !== 'legal-full';
    f.ctx.cfg.research.maxTrialTraders=kind === 'cap' ? 0 : 1;
    const better=record('better','A',3,kind !== 'legal-full'); f.vault.restore([better]);
    if (kind === 'legal-trial') f.trader.withdraw(300);
    f.commander.upgradeUntested();
    assert.equal(f.trader.strategy?.id,kind.startsWith('legal') ? 'better' : 'current',kind);
  }
});

test('calendar age alone never retires a quiet flat strategy', async () => {
  const f=fixture(); f.trader.assignedAt=1;
  await f.commander.review();
  assert.equal(f.trader.strategy?.id,'current'); assert.equal(f.cur.status,'active'); assert.equal(f.commander.retirements,0);
});

test('distinct completed tradable candles park quiet strategies without recording failure or reusing same data', async () => {
  const f=fixture(); f.ctx.cfg.retirement.idleDays=2/1440;
  await f.trader.onCandle('A');
  assert.equal((f.cur as any).opportunity?.count,0,'old history starts a baseline, not invented observations');
  await f.trader.onCandle('A');
  for (let i=0;i<2;i++) { const last=f.bars.at(-1)!; f.bars.push({...last,t:last.t+60_000}); await f.trader.onCandle('A'); }
  assert.equal((f.cur as any).opportunity.count,2);
  await f.commander.review();
  assert.equal(f.trader.strategy,null); assert.equal(f.cur.status,'vault');
  assert.match((f.cur as any).parked.reason,/2.*opportunit/); assert.equal(f.cur.retiredAt,null); assert.equal(f.commander.retirements,0);
  f.commander.assignIdle(); assert.equal(f.trader.strategy,null,'same completed data stays parked');
  const restored = new StrategyVault(30); restored.restore(JSON.parse(JSON.stringify(f.vault.all())));
  f.ctx.vault=restored; f.commander.assignIdle(); assert.equal(f.trader.strategy,null,'restart retains parked blocker');
  const last=f.bars.at(-1)!; f.bars.push({...last,t:last.t+60_000});
  f.commander.assignIdle(); assert.equal((f.trader.strategy as StrategyRecord | null)?.id,'current');
});

test('parking/requeue preserves live losses and original NAV/drawdown baseline', async () => {
  const f=fixture(); f.ctx.cfg.retirement.idleDays=1/1440;
  f.trader.wallet.cash=950; f.cur.live.pnl=-50; f.cur.live.trades=2; f.trader.peakNav=1.02;
  const ret=f.trader.navSinceAssign(), dd=f.trader.drawdownSinceAssign();
  await f.trader.onCandle('A'); const last=f.bars.at(-1)!; f.bars.push({...last,t:last.t+60_000}); await f.trader.onCandle('A');
  await f.commander.review(); assert.equal(f.trader.strategy,null);
  f.bars.push({...last,t:last.t+120_000}); f.commander.assignIdle();
  assert.ok(Math.abs(f.trader.navSinceAssign()-ret)<1e-12); assert.ok(Math.abs(f.trader.drawdownSinceAssign()-dd)<1e-12);
  assert.equal(f.cur.live.pnl,-50); assert.equal(f.cur.live.trades,2);
});

test('upgrade into an actually parked strategy preserves its own losses and drawdown baseline', async () => {
  const f=fixture(); f.ctx.cfg.retirement.idleDays=1/1440;
  f.cur.fitness=3; f.cur.live.pnl=-50; f.cur.live.trades=2;
  f.trader.wallet.cash=950; f.trader.peakNav=1.02;
  const ret=f.trader.navSinceAssign(), dd=f.trader.drawdownSinceAssign();
  assert.equal(ret,0.95);
  await f.trader.onCandle('A');
  f.bars.push({...f.bars.at(-1)!,t:f.bars.at(-1)!.t+60_000}); await f.trader.onCandle('A');
  await f.commander.review();
  assert.equal(f.trader.strategy,null); assert.equal(f.cur.status,'vault'); assert.ok(f.cur.parked);
  const fresh=record('fresh-lower-fitness','A',1); f.vault.restore([fresh]);
  f.commander.assignIdle();
  assert.strictEqual(f.trader.strategy,fresh,'parked candidate remains blocked on the same bar');
  const outgoingBaseline=f.trader.navAtAssign;
  f.bars.push({...f.bars.at(-1)!,t:f.bars.at(-1)!.t+60_000});
  f.commander.upgradeUntested();
  assert.strictEqual(f.trader.strategy,f.cur); assert.equal(fresh.status,'vault'); assert.equal(f.cur.parked,undefined);
  assert.ok(Math.abs(f.trader.navSinceAssign()-ret)<1e-12,'incoming parked loss baseline survives upgrade');
  assert.notEqual(f.trader.navAtAssign,outgoingBaseline);
  assert.equal(f.trader.peakNav,1.02); assert.ok(Math.abs(f.trader.drawdownSinceAssign()-dd)<1e-12);
  assert.equal(f.cur.live.pnl,-50); assert.equal(f.cur.live.trades,2);
});

test('upgrades respect parked data, market closure and exclusive symbol ownership', () => {
  for (const blocker of ['parked','closed','owned'] as const) {
    const f=fixture(); const better=record('better','A',3); f.vault.restore([better]);
    if (blocker==='parked') better.parked={at:Date.now(),reason:'quiet',afterBar:f.bars.at(-1)!.t,navSinceAssign:1,peakNav:1};
    if (blocker==='closed') f.ctx.marketOpen=()=>false;
    if (blocker==='owned') { const other=new Trader(f.ctx,'other','Other',{} as any); other.assign(record('legacy','A')); (f.commander as any).traders.push(other); }
    f.commander.upgradeUntested(); assert.equal(f.trader.strategy?.id,'current',blocker);
  }
});

test('allocation diagnostics count each waiting candidate once with deterministic blocker priority and no mutation', () => {
  const f=fixture(); const rows=[record('parked','C'),record('closed','C'),record('owned','A'),record('trial','B',3,true),record('ready','D')];
  rows[0].parked={at:1,reason:'quiet',afterBar:Date.now(),navSinceAssign:1,peakNav:1}; f.vault.restore(rows);
  f.ctx.marketOpen=(symbol:string)=>symbol!=='C';
  const before=JSON.stringify({vault:f.vault.all(),trader:f.trader.save(),commander:f.commander.save()});
  const d=(f.commander as any).allocationDiagnostics();
  assert.equal(d.waiting,5); assert.equal(d.eligible,1);
  assert.deepEqual(d.blocked,{'parked':1,'market-closed':1,'symbol-owned':1,'trial-cap':1,'frozen':0,'halted':0});
  assert.equal(d.parked[0].strategyId,'parked'); d.parked[0].reason='mutated';
  assert.equal(JSON.stringify({vault:f.vault.all(),trader:f.trader.save(),commander:f.commander.save()}),before);
});

test('validated new symbols displace concentrated full/trial shelves without destroying restored history', () => {
  for (const trial of [false,true]) {
    const v=new StrategyVault(30); const size=trial?6:30;
    const legacy=Array.from({length:size},(_,i)=>record(`old-${i}`,'A',100+i,trial));
    const active=record('active','A',500); active.status='active'; active.traderId='owner';
    const retired=record('retired','C',1); retired.status='retired'; retired.retiredAt=1;
    v.restore([...legacy,active,retired]); assert.equal(v.all().length,size+2);
    assert.equal(v.add(record('new-qualified','B',2,trial)),true);
    assert.equal(v.byStatus('vault').length,size); assert.ok(v.get('new-qualified')); assert.strictEqual(v.get('active'),active); assert.strictEqual(v.get('retired'),retired);
  }
  const v=new StrategyVault(2); v.restore([record('a','A',10),record('b','B',1)]);
  assert.equal(v.add(record('a-worse','A',9)),false); assert.ok(v.get('b'));
  assert.equal(v.add(record('a-better','A',11)),true); assert.ok(v.get('b'));
});

test('new admissions bound same-symbol variants separately by long/short risk and qualification shelf', () => {
  for (const trial of [false,true]) {
    const v=new StrategyVault(30); const perSide=trial?1:2;
    for (const side of ['long','short'] as const) for (let i=0;i<8;i++) {
      const s=record(`${side}-${i}`,'A',i+1,trial); s.genome.side=side; s.genome.maxBars=20+i;
      v.add(s);
    }
    assert.equal(v.byStatus('vault').length,perSide*2);
    for (const side of ['long','short']) assert.equal(v.byStatus('vault').filter(s=>s.genome.side===side).length,perSide);
    assert.equal(v.add(record('B','B',0.1,trial)),true);
    assert.equal(v.bestAvailable(['A'],1)?.symbol,'B');
  }
});

test('trial near-clones never evict full-qualified records', () => {
  const v=new StrategyVault(30); const full=record('full','A',1), trial=record('trial-clone','A',2,true);
  trial.train={...full.train}; trial.test={...full.test};
  v.restore([full]); assert.equal(v.add(trial),true); assert.strictEqual(v.get('full'),full);
});

test('completed-bar work heartbeat advances for real observations, not duplicate or closed callbacks', async (t) => {
  const f=fixture(); let now=Date.now(); t.mock.method(Date,'now',()=>now);
  assert.notEqual(f.trader.lastWorkAt,null,'assignment is genuine work');
  now+=1000; await f.trader.onCandle('A'); assert.equal(f.trader.lastWorkAt,now);
  now+=1000; await f.trader.onCandle('A'); assert.equal(f.trader.lastWorkAt,now-1000);
  f.ctx.marketOpen=()=>false; f.bars.push({...f.bars.at(-1)!,t:f.bars.at(-1)!.t+60_000});
  now+=1000; await f.trader.onCandle('A'); assert.equal(f.trader.lastWorkAt,now-2000);
});

test('confirmed entries and exits advance work heartbeat after booking, not in authorization gap', async (t) => {
  const f=fixture(); let now=Date.now(); t.mock.method(Date,'now',()=>now);
  f.cur.genome.entry[0].right={t:'const',v:1};
  f.ctx.cfg.risk.leverage=1; f.ctx.cfg.risk.unprovenTradeRisk=0.001;
  f.ctx.broker=new PaperBroker(0,0);
  Object.assign(f.ctx.risk,{reserveEntry:()=>({ok:true}),revalidateEntry:()=>({ok:true}),releaseEntry(){},orderChanged(){},requireReview(){}});
  f.ctx.persistExecution=async()=>{now+=1000;}; f.ctx.recordTrade=()=>{};
  await f.trader.onCandle('A'); assert.ok(f.trader.wallet.position); assert.equal(f.trader.lastWorkAt,now);
  f.ctx.feed.price=()=>90; now+=1000;
  await f.trader.onTick(); assert.equal(f.trader.wallet.position,null); assert.equal(f.trader.lastWorkAt,now);
});

test('same-timeframe timestamp jitter is not another opportunity', async () => {
  const f=fixture(); await f.trader.onCandle('A');
  f.bars.push({...f.bars.at(-1)!,t:f.bars.at(-1)!.t+1}); await f.trader.onCandle('A');
  assert.equal(f.cur.opportunity?.count,0);
});

test('closed session, missing history and unfinished candles never create observations', async () => {
  for (const blocker of ['closed','history','unfinished'] as const) {
    const f=fixture();
    if (blocker==='closed') f.ctx.marketOpen=()=>false;
    if (blocker==='history') f.bars.splice(0,99);
    if (blocker==='unfinished') f.bars.at(-1)!.t=Date.now();
    await f.trader.onCandle('A'); assert.equal(f.cur.opportunity,undefined,blocker);
  }
});

test('stock idle targets use regular-session opportunity bars on the per-symbol timeframe, not weekends', async (t) => {
  const f=fixture(); t.mock.method(Date,'now',()=>Date.parse('2026-11-24T18:00:00Z'));
  f.ctx.cfg.assetClass=()=> 'stock'; f.ctx.cfg.timeframeFor=()=>3_600_000; f.ctx.cfg.retirement.idleDays=1;
  const push=async (at:string)=>{f.bars.push({...f.bars.at(-1)!,t:Date.parse(at)});await f.trader.onCandle('A');};
  await push('2026-11-23T14:30:00Z'); assert.equal(f.cur.opportunity?.count,0);
  await push('2026-11-22T15:30:00Z'); assert.equal(f.cur.opportunity?.count,0,'Sunday never counts');
  for (const hour of [15,16,17,18,19]) await push(`2026-11-23T${hour}:30:00Z`);
  await push('2026-11-23T21:30:00Z'); assert.equal(f.cur.opportunity?.count,5,'after hours never count');
  await push('2026-11-24T14:30:00Z'); await f.commander.review(); assert.ok(f.trader.strategy,'six observed bars below rounded-up session target');
  await push('2026-11-24T15:30:00Z'); await f.commander.review(); assert.equal(f.trader.strategy,null); assert.equal(f.cur.opportunity?.count,7);
});

test('frozen and unresolved/exit-only safeguards prohibit idle parking and strategy swaps', async () => {
  for (const guard of ['frozen','pending','intent','exit-only','retiring','position'] as const) {
    const f=fixture(); await f.trader.onCandle('A'); f.cur.opportunity!.count=100_000;
    if (guard==='frozen') f.ctx.cfg.frozen.enabled=true;
    if (guard==='pending') f.trader.orderPending=true;
    if (guard==='intent') f.trader.executionIntent={kind:'entry',symbol:'A',qty:1,side:'buy',at:1};
    if (guard==='exit-only') f.trader.exitOnly=true;
    if (guard==='retiring') { f.trader.retiringReason='hard-risk retirement pending'; f.trader.executionIntent={kind:'exit',symbol:'A',qty:1,side:'sell',at:1}; }
    if (guard==='position') f.trader.wallet.position={symbol:'A',side:'long',qty:1,entryPrice:100,entryTime:1,entryFee:0,stop:90,takeProfit:null,extreme:100,barsHeld:1,strategyId:f.cur.id};
    f.vault.restore([record('better','A',3)]);
    const before=JSON.stringify(f.cur.opportunity);
    await f.trader.onCandle('A'); await f.commander.review(); f.commander.assignIdle(); f.commander.upgradeUntested();
    assert.strictEqual(f.trader.strategy,f.cur,guard); assert.equal(f.cur.parked,undefined,guard); assert.equal(JSON.stringify(f.cur.opportunity),before,guard);
  }
});

test('hard risk retirement still wins over opportunity parking', async () => {
  for (const kind of ['drawdown','probation','profit-factor','trial-failure'] as const) {
    const f=fixture(); await f.trader.onCandle('A'); f.cur.opportunity!.count=100_000;
    if (kind==='drawdown') f.trader.wallet.cash=800;
    if (kind==='probation') {f.ctx.cfg.risk.traderMaxDrawdown=0.5;f.cur.live.trades=6; f.trader.wallet.cash=850;}
    if (kind==='profit-factor') {f.cur.live.trades=15;f.cur.live.grossWin=1;f.cur.live.grossLoss=2;}
    if (kind==='trial-failure') {f.cur.trial=true;f.cur.live.trades=8;f.cur.live.grossWin=1;f.cur.live.grossLoss=2;}
    await f.commander.review(); assert.equal(f.cur.status,'retired',kind); assert.equal(f.cur.parked,undefined,kind); assert.equal(f.commander.retirements,1,kind);
  }
});

test('parked strategies cannot requeue from timestamp jitter on the same bar', async () => {
  const f=fixture(); f.ctx.cfg.retirement.idleDays=1/1440;
  await f.trader.onCandle('A'); f.bars.push({...f.bars.at(-1)!,t:f.bars.at(-1)!.t+60_000}); await f.trader.onCandle('A'); await f.commander.review();
  f.bars.push({...f.bars.at(-1)!,t:f.bars.at(-1)!.t+1}); f.commander.assignIdle();
  assert.equal(f.trader.strategy,null);
});

test('a stronger clone replacement is atomic even in restored over-quota shelves', () => {
  const v=new StrategyVault(30); const old=record('old','A',1); const other=[record('higher-1','A',3),record('higher-2','A',4)];
  v.restore([old,...other]); const candidate=record('clone','A',2); candidate.train={...old.train};candidate.test={...old.test};
  assert.equal(v.add(candidate),true); assert.equal(v.all().length,3); assert.ok(v.get('clone')); assert.equal(v.get('old'),undefined);
});

test('actual upgrade refuses full-to-trial replacement even with fitter trial and zero trial cap', () => {
  const f=fixture(); const better=record('trial','A',3,true); f.vault.restore([better]);
  f.commander.upgradeUntested(); assert.equal(f.trader.strategy?.id,'current'); assert.equal(better.status,'vault');
});
