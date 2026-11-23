import assert from 'node:assert/strict';
import test from 'node:test';
import { config, type Config } from '../server/config';
import { Researcher } from '../server/agents/researcher';
import type { Dataset, EcoContext } from '../server/agents/context';
import { Universe } from '../server/market/universe';
import { IndicatorCache } from '../server/strategy/indicators';
import { StrategyVault } from '../server/strategy/vault';
import type { Genome } from '../server/strategy/genome';
import type { Appearance } from '../shared/types';

const appearance: Appearance = {skin:'',hair:'',shirt:'',pants:'',hat:'none'};
// Deterministic synthetic offline candles exercise the real indicators/backtester,
// never observations, execution responses or investment-performance evidence.
function dataset(symbol: string, lastT = 1_700_000_000_000, length = 360): Dataset {
  const bars = Array.from({length}, (_, i) => {
    const c = 100 + i * .025 + Math.sin(i / 5) * 4;
    return {t:lastT - (length-1-i)*900_000,o:c,h:c+1,l:c-1,c,v:100};
  });
  return {symbol,lastT,cache:new IndicatorCache(bars),trainEnd:Math.floor(length*.6)};
}
function fixture(symbols = ['BTC']) {
  const cfg = {...config, symbols:[...symbols], isCore:()=>true, assetClass:()=> 'crypto',
    research:{...config.research,populationSize:6,generationsPerEpoch:2,restBetweenEpochsMs:0},
    universe:{...config.universe,cryptoFocus:1}} as unknown as Config;
  const universe = new Universe(cfg);
  const data = new Map(symbols.map(s => [s, dataset(s)]));
  let counted = 0, looks = 0;
  const noteLook = universe.noteLook.bind(universe);
  universe.noteLook = (symbol) => { looks++; return noteLook(symbol); };
  const ctx = { cfg, universe, vault:new StrategyVault(30), dataset:(symbol:string)=>data.get(symbol) ?? null,
    countEvaluated:(n:number)=>{ counted += n; }, levelUp:()=>{},news:()=>{},emit:()=>{},unlock:()=>{} } as unknown as EcoContext;
  const researcher = new Researcher(ctx,'r','Ada',appearance,'trend',0);
  const run = () => researcher.work(1000);
  return {cfg,ctx,universe,data,researcher,run,get counted(){return counted;},get looks(){return looks;}};
}

test('one epoch per completed dataset bounds evaluations, holdout reuse and activity XP', () => {
  const f = fixture();
  f.run();
  assert.equal(f.researcher.epoch,1);
  const first = {evaluated:f.counted,looks:f.looks,xp:f.researcher.xp};
  assert.ok(first.evaluated > 0);
  for (let i=0;i<12;i++) f.run();
  assert.equal(f.researcher.epoch,1);
  assert.deepEqual({evaluated:f.counted,looks:f.looks,xp:f.researcher.xp},first);
  assert.match(f.researcher.activity,/Waiting for new completed data/);
  f.data.set('BTC',dataset('BTC',1_700_000_900_000));
  f.run();
  assert.equal(f.researcher.epoch,2);
});

test('completed/resting status never overruns generation progress and real work has a heartbeat', () => {
  const f = fixture();
  f.run();
  assert.doesNotMatch(f.researcher.activity,/gen 3\/2/);
  assert.match(f.researcher.activity,/Completed.*2\/2/);
  assert.equal(f.researcher.stats()['Work status'],'resting');
  assert.equal((f.researcher.toResearcherDTO() as any).workState,'resting');
  assert.equal(typeof f.researcher.lastWorkAt,'number');
  const lastWorkAt = f.researcher.lastWorkAt;
  f.run();
  assert.equal(f.researcher.stats()['Work status'],'waiting-data');
  assert.equal(f.researcher.lastWorkAt,lastWorkAt);
});

test('saved admission watermark prevents restart replay, including interrupted epochs', () => {
  const f = fixture();
  f.run();
  const saved = f.researcher.save();
  const restarted = new Researcher(f.ctx,'r','Ada',appearance,'trend',0);
  restarted.restore(saved);
  restarted.work(1000);
  assert.equal(restarted.epoch,1);
  assert.equal(restarted.evaluated,f.researcher.evaluated);
  f.data.set('BTC',dataset('BTC',1_700_000_900_000));
  restarted.work(0); // Reserve only, before the first cooperative evaluation.
  const midEpoch = restarted.save();
  const again = new Researcher(f.ctx,'r','Ada',appearance,'trend',0);
  again.restore(midEpoch);
  again.work(1000);
  assert.equal(again.epoch,1);
  assert.equal(again.evaluated,f.researcher.evaluated);
});

test('legacy and invalid saved versions conservatively baseline once without clearing history', () => {
  for (const extra of [undefined,{epoch:20,evaluated:400},{datasetVersions:{BTC:Infinity}},{datasetVersions:{BTC:'1700000000000'}},null]) {
    const f = fixture();
    f.data.delete('BTC'); // History can be unavailable during restoration.
    f.researcher.restore({id:'r',xp:1234,level:99,extra});
    f.run();
    const savedWhileWaiting = f.researcher.save();
    const restarted = new Researcher(f.ctx,'r','Ada',appearance,'trend',0);
    restarted.restore(savedWhileWaiting);
    f.data.set('BTC',dataset('BTC'));
    restarted.work(1000);
    assert.equal(restarted.evaluated,extra && 'evaluated' in extra ? extra.evaluated : 0);
    assert.equal(restarted.xp,1234);
    const baseline = restarted.save();
    restarted.restore(baseline);
    f.data.set('BTC',dataset('BTC',1_700_000_900_000));
    restarted.work(1000);
    assert.ok(restarted.evaluated > 0);
    assert.equal(restarted.epoch,(extra && 'epoch' in extra ? extra.epoch ?? 0 : 0) + 1);
  }
});

test('universe eviction evidence counts distinct completed datasets, never replay or abandoned reservations', () => {
  const f = fixture();
  for (let i=0;i<5;i++) {
    f.universe.pickForResearch(['BTC'],i);
    f.universe.finishResearch('BTC',1_700_000_000_000);
  }
  assert.equal(f.universe.epochs('BTC'),1);
  f.universe.pickForResearch(['BTC'],0);
  f.universe.finishResearch('BTC'); // legacy/unversioned caller releases only
  assert.equal(f.universe.epochs('BTC'),1);
  f.universe.pickForResearch(['BTC'],0);
  f.universe.finishResearch('BTC',1_700_000_900_000);
  assert.equal(f.universe.epochs('BTC'),2);
  const saved = f.universe.save();
  const restored = new Universe(f.cfg);
  restored.restoreFacts(saved);
  restored.pickForResearch(['BTC'],0);
  restored.finishResearch('BTC',1_700_000_900_000);
  assert.equal(restored.epochs('BTC'),2);
  restored.restoreFacts({epochs:{BTC:999999}});
  assert.equal(restored.epochs('BTC'),0);
});

test('completed epochs release reservations with coverage; resets release without credit or replay', () => {
  const f = fixture();
  f.run();
  assert.equal(f.universe.epochs('BTC'),1);
  assert.equal(f.universe.researchInProgress('BTC'),0);
  f.data.set('BTC',dataset('BTC',1_700_000_900_000));
  f.researcher.work(0);
  assert.equal(f.universe.researchInProgress('BTC'),1);
  assert.equal(f.researcher.evaluated,12);
  f.researcher.resetResearch();
  assert.equal(f.universe.researchInProgress('BTC'),0);
  assert.equal(f.universe.epochs('BTC'),1);
  f.run();
  assert.equal(f.researcher.epoch,1);
  assert.equal(f.researcher.evaluated,12);
  assert.equal(f.universe.researchInProgress('BTC'),0);
});

test('rehydrated explored symbols retain coverage and in-flight research cannot be evicted', () => {
  const f = fixture();
  Object.assign(f.cfg,{isCore:()=>false,registerSymbol:()=>{},unregisterSymbol:()=>{}});
  const entry = {symbol:'ALT',asset:'crypto' as const,addedAt:1,reason:'test',score:1};
  f.universe.add(entry);
  f.universe.pickForResearch(['ALT'],0);
  assert.equal(f.universe.remove('ALT'),false);
  f.universe.finishResearch('ALT',1_700_000_000_000);
  const restored = new Universe(f.cfg);
  const entries = restored.restoreFacts(f.universe.save());
  restored.add(entries[0]);
  assert.equal(restored.epochs('ALT'),1);
  assert.equal(restored.remove('ALT'),true);
});

test('shutdown cancellation, restore and failed work release reservations without replay rewards', () => {
  const f = fixture();
  f.researcher.work(0);
  const saved = f.researcher.save();
  f.researcher.restore(saved);
  assert.equal(f.universe.researchInProgress('BTC'),0);
  f.data.set('BTC',dataset('BTC',1_700_000_900_000));
  f.researcher.work(0);
  f.researcher.cancelResearch();
  f.researcher.cancelResearch();
  assert.equal(f.universe.researchInProgress('BTC'),0);
  assert.equal(f.researcher.xp,0);
  f.data.set('BTC',dataset('BTC',1_700_001_800_000));
  f.ctx.vault.all = () => { throw new Error('offline fixture failure'); };
  assert.throws(()=>f.run(),/offline fixture failure/);
  assert.equal(f.universe.researchInProgress('BTC'),0);
});

test('cooperative partial work earns no per-loop XP and resumes within a fixed dataset budget', (t) => {
  const f = fixture();
  let clock = 0;
  const timer = t.mock.method(performance,'now',()=>clock++);
  f.researcher.work(8); // six real evaluations and one completed generation
  assert.equal(f.researcher.generation,1);
  assert.equal(f.researcher.evaluated,6);
  assert.equal(f.researcher.xp,0);
  timer.mock.restore();
  f.run();
  assert.equal(f.researcher.epoch,1);
  assert.equal(f.researcher.evaluated,12);
  assert.ok(f.researcher.xp >= 1);
});

test('conservative restart baseline prevents replay after a crash before the admission checkpoint', () => {
  const f = fixture();
  const beforeAdmission = f.researcher.save();
  f.run(); // Crash loses this unsaved admission/completion.
  const restarted = new Researcher(f.ctx,'r','Ada',appearance,'trend',0);
  restarted.restore(beforeAdmission);
  restarted.work(1000);
  assert.equal(restarted.epoch,0);
  assert.equal(restarted.evaluated,0);
  f.data.set('BTC',dataset('BTC',1_700_000_900_000));
  restarted.work(1000);
  assert.equal(restarted.epoch,1);
});

test('invalid, missing, stale and exhausted data do not reserve work or starve fresh markets', () => {
  const f = fixture(['BTC','ETH','SOL']);
  f.data.delete('BTC');
  for (const invalid of [NaN,Infinity,-Infinity,0,-1]) {
    f.data.set('ETH',{...dataset('ETH'),lastT:invalid});
    f.data.delete('SOL');
    f.run();
    assert.equal(f.researcher.evaluated,0);
    assert.equal(f.universe.researchInProgress('ETH'),0);
  }
  f.data.set('SOL',dataset('SOL'));
  f.run();
  assert.equal(f.researcher.symbol,'SOL');
  assert.equal(f.researcher.epoch,1);
  f.data.set('ETH',dataset('ETH'));
  f.run();
  assert.equal(f.researcher.symbol,'ETH');
  assert.equal(f.researcher.epoch,2);
  f.data.set('ETH',dataset('ETH',1_699_999_900_000));
  f.run();
  assert.equal(f.researcher.epoch,2);
  assert.equal(f.researcher.evaluated,24);
});

test('actual holdout judgments stop after the admitted epoch, even when new seeds arrive', () => {
  const f = fixture();
  f.data.set('BTC',dataset('BTC',1_700_000_000_000,1800));
  const genome: Genome = {side:'long',entry:[{left:{kind:'roc',p:[2]},op:'crossAbove',right:{t:'const',v:0}}],
    exit:[{left:{kind:'roc',p:[2]},op:'crossBelow',right:{t:'const',v:0}}],stopAtr:6,takeProfitAtr:0,
    trailAtr:0,maxBars:24,sizePct:.8,atrPeriod:7};
  f.researcher.receive([genome]);
  f.run();
  assert.ok(f.looks > 0 && f.looks <= 5,'must exercise real holdout validation, not only train rejection');
  const first = {looks:f.looks,evaluated:f.counted,xp:f.researcher.xp};
  for (let i=0;i<10;i++) { f.researcher.receive([genome]); f.run(); }
  assert.deepEqual({looks:f.looks,evaluated:f.counted,xp:f.researcher.xp},first);
});
