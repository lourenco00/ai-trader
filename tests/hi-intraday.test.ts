import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { config, type Config } from '../server/config';
import { Researcher, validate } from '../server/agents/researcher';
import { Universe } from '../server/market/universe';
import { StrategyVault } from '../server/strategy/vault';
import { IndicatorCache } from '../server/strategy/indicators';
import { classicGenomes, type Genome } from '../server/strategy/genome';
import type { EcoContext } from '../server/agents/context';
import { Ecosystem } from '../server/ecosystem';
import { HI_STOCKS, HI_CRYPTO, HI_INTRADAY_ID } from '../server/profiles/hi-intraday';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { backtest } from '../server/strategy/backtest';
import { makeRecord, backtestOptions } from '../server/agents/researcher';
import { MarketFeed } from '../server/market/feed';
import { AlpacaClient } from '../server/broker/alpaca';

// Import config only after the same pure environment projection used by hi's entrypoint.
function hiConfig(extra: Record<string,string> = {}) {
  const capture = `const {config:c}=await import(${JSON.stringify(new URL('../server/config.ts',import.meta.url).href)}); console.log(JSON.stringify({execution:c.execution,dir:c.dataDir,fundName:c.fundName,intraday:c.intraday,llm:c.llm.enabled,news:c.news.enabled,dsa:c.dsa.enabled,scan:c.universe.scanEnabled,scanStocks:c.universe.scanStocks,frozen:c.frozen.enabled,live:c.live,symbols:c.symbolSpecs,traders:c.traders,timeframes:c.symbols.map(s=>[s,c.timeframeFor(s)]),risk:c.risk,promotion:c.research.promotion,flatten:c.flattenBeforeCloseMin,provider:c.provider}));`;
  // Exercise the real entrypoint but replace only index's server/network boundary.
  const script = `const {registerHooks}=await import('node:module');registerHooks({resolve(s,c,next){if(s==='./index'&&c.parentURL.endsWith('/server/hiact.ts'))return {url:'data:text/javascript,'+encodeURIComponent(${JSON.stringify(capture)}),shortCircuit:true};return next(s,c);}});await import('./server/hiact.ts');`;
  const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:process.cwd(),env:{...process.env,...extra},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('hi entry configuration forces isolated standard-risk local paper despite hostile environment',()=>{
  const c=hiConfig({EXECUTION:'okx',PROFILE:'aggressive',LEVERAGE:'4',DATA_DIR:'./data-hi',LLM_API_KEY:'fake-not-a-key',LLM_PROVIDER:'openai',NEWS_ENABLED:'true',DSA_ENABLED:'true',SCAN_ENABLED:'true',SCAN_STOCKS:'true',FROZEN_FORWARD_ENABLED:'true',FLATTEN_BEFORE_CLOSE_MIN:'30',SYMBOLS:'$SNXX,$NVD',TIMEFRAME:'1d',MIN_TEST_TRADES:'2',MIN_TRAIN_TRADES:'5',MIN_HALF_TRADES:'1'});
  assert.equal(c.execution,'paper'); assert.match(c.dir,/\/data-hi-intraday$/);
  assert.equal(c.fundName,'High-Activity Intraday — paper short-hold experiment');
  for(const k of ['llm','news','dsa','scan','scanStocks','frozen']) assert.equal(c[k],false,k);
  assert.equal(c.live.enabled,false); assert.equal(c.live.approval,null);
  assert.equal(c.risk.leverage,1); assert.equal(c.risk.maxGrossExposure,1);
  assert.equal(c.risk.dailyLossLimit,.01); assert.equal(c.risk.fundMaxDrawdown,.2);
  assert.equal(c.promotion.minTrainTrades,120); assert.equal(c.promotion.minTestTrades,24); assert.equal(c.promotion.minHalfTrades,8);
  assert.equal(c.flatten,0); assert.equal(c.provider,'alpaca');
  assert.equal(c.traders,c.symbols.length,'staffing matches the exclusive-owner fixed universe');
  assert.deepEqual(c.symbols.map((s:any)=>s.symbol),['SPY','QQQ','IWM','DIA','AAPL','MSFT','AMZN','GOOGL','META','NVDA','AMD','TSLA','BTC','ETH']);
  for(const [symbol,tf] of c.timeframes) assert.equal(tf,['BTC','ETH'].includes(symbol)?900_000:300_000);
});

test('normal config remains opt-out and keeps existing environment behavior',()=>{
  const script=`const {config:c}=await import('./server/config.ts');console.log(JSON.stringify({intraday:c.intraday,dir:c.dataDir,tf:c.timeframeFor('BTC'),name:c.fundName,traders:c.traders,scan:c.universe.scanEnabled}));`;
  const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{encoding:'utf8',env:{...process.env,HI_INTRADAY_EXPERIMENT:'',DATA_DIR:'./ordinary-fixture',TIMEFRAME:'1h',TIMEFRAME_CRYPTO:'1h',EXECUTION:'paper',TRADERS:'6',SCAN_ENABLED:'true'}});
  assert.equal(child.status,0,child.stderr);const c=JSON.parse(child.stdout);
  assert.equal(c.intraday,false);assert.equal(c.name,undefined);assert.match(c.dir,/ordinary-fixture$/);assert.equal(c.tf,3_600_000);assert.equal(c.traders,6);assert.equal(c.scan,true);
});

test('only hi compose storage moves to the durable isolated experiment directory',async()=>{
  const text=await readFile('docker-compose.yml','utf8');
  assert.match(text,/hi:[\s\S]*?volumes: \["\.\/data-hi-intraday:\/app\/data-hi-intraday"\]/);
  for(const volume of ['./data:/app/data','./data-niche:/app/data-niche','./data-small:/app/data-small'])assert.ok(text.includes(volume));
  assert.doesNotMatch(text,/\.\/data-hi:\/app\/data-hi/);
});

function researchFixture(symbol:string, intraday=true) {
  const stock=symbol==='SPY'; const tf=stock?300_000:900_000;
  const cfg={...config,intraday,symbols:[symbol],assetClass:()=>stock?'stock':'crypto',timeframeFor:()=>tf,isCore:()=>true,
    research:{...config.research,populationSize:12,generationsPerEpoch:3,restBetweenEpochsMs:0}} as unknown as Config;
  const bars=Array.from({length:1500},(_,i)=>{const c=100+Math.sin(i/5)*4;return {t:1_700_000_000_000+i*tf,o:c,h:c+1,l:c-1,c,v:100};});
  const data={symbol,lastT:bars.at(-1)!.t,cache:new IndicatorCache(bars),trainEnd:900};
  const ctx={cfg,universe:new Universe(cfg),vault:new StrategyVault(30),dataset:()=>data,countEvaluated:()=>{},levelUp:()=>{},news:()=>{},emit:()=>{},unlock:()=>{}} as unknown as EcoContext;
  return {cfg,ctx,data};
}

function isolatedConfig(dir:string): Config {
  const stocks=new Set<string>(HI_STOCKS); const symbols=[...HI_STOCKS,...HI_CRYPTO];
  return {...config,intraday:true,dataDir:dir,execution:'paper',provider:'alpaca',
    frozen:{...config.frozen,enabled:false},live:{...config.live,enabled:false,venue:null,approval:null},
    llm:{...config.llm,enabled:false},news:{...config.news,enabled:false},dsa:{...config.dsa,enabled:false},
    universe:{...config.universe,scanEnabled:false,scanStocks:false},
    symbols,symbolSpecs:symbols.map(symbol=>({symbol,asset:stocks.has(symbol)?'stock':'crypto'})),
    assetClass:s=>stocks.has(s)?'stock':'crypto',isCore:s=>symbols.includes(s as any),timeframeFor:s=>stocks.has(s)?300_000:900_000,
  } as Config;
}
function offline(cfg:Config): any {
  const eco:any=new Ecosystem(cfg); eco.feed.provider={name:'fake'};
  eco.feed.start=async()=>{}; eco.feed.stop=()=>{}; eco.feed.series=()=>[]; eco.feed.price=()=>100; eco.feed.isStale=()=>false;
  eco.scheduleResearch=()=>{}; eco.minuteLoop=()=>{}; eco.fastLoop=async()=>{};
  return eco;
}
async function isolated(fn:(cfg:Config)=>Promise<void>) {
  const root=await mkdtemp('/opt/data/cache/scratch/hi-intraday-test-');
  try {await fn(isolatedConfig(path.join(root,'data-hi-intraday')));} finally {await rm(root,{recursive:true,force:true});}
}

test('intraday startup enrolls empty isolation once and restarts only its own paper state before feed callbacks',async()=>{
  await isolated(async cfg=>{
    const eco=offline(cfg); let starts=0;
    eco.feed.start=async()=>{starts++; const marker=JSON.parse(await readFile(path.join(cfg.dataDir,'hi-intraday.json'),'utf8'));assert.equal(marker.identity,HI_INTRADAY_ID);};
    try {await eco.start(); assert.equal(starts,1); eco.artifactFingerprint=null;assert.equal(eco.snapshot().runtime.identityStatus,'unavailable');assert.equal(eco.snapshot().runtime.experiment,'hi-intraday-v1');} finally {await eco.stop();}
    const saved=JSON.parse(await readFile(path.join(cfg.dataDir,'state.json'),'utf8'));
    assert.equal(saved.intradayIdentity,HI_INTRADAY_ID); assert.equal(saved.executionMode,'paper');
    const again=offline(cfg);try {await again.start();} finally {await again.stop();}
    const ordinary=offline({...cfg,intraday:false});try {await assert.rejects(ordinary.start(),/intraday/i);} finally {await ordinary.stop();}
    await rm(path.join(cfg.dataDir,'hi-intraday.json'));
    const missingMarker=offline({...cfg,intraday:false});try {await assert.rejects(missingMarker.start(),/intraday/i);} finally {await missingMarker.stop();}
  });
});

test('intraday rejects legacy mixed corrupt or frozen directories before any market call without migration',async()=>{
  for(const [name,contents] of [['state.json','{}'],['trades.jsonl','{}'],['frozen-enrollment.json','null'],['frozen-manifest.json','{}'],['hi-intraday.json','null'],['hi-intraday.json','{']]) {
    await isolated(async cfg=>{
      await mkdir(cfg.dataDir); const file=path.join(cfg.dataDir,name); await writeFile(file,contents);
      const eco=offline(cfg);let starts=0;eco.feed.start=async()=>{starts++;};
      try {await assert.rejects(eco.start(),/intraday|frozen/i);assert.equal(starts,0);assert.equal(await readFile(file,'utf8'),contents);} finally {await eco.stop();}
    });
  }
});

test('intraday rejects wrong custody and changed hold policy in a marked restart before market startup',async()=>{
  const changes=[(s:any)=>{delete s.intradayIdentity;},(s:any)=>{s.executionMode='alpaca';},(s:any)=>{s.strategies=[{symbol:'SPY',genome:{...classicGenomes('trend')[0],maxBars:25}}];},(s:any)=>{s.strategies=[{symbol:'SNXX',genome:{...classicGenomes('trend')[0],maxBars:4}}];},(s:any)=>{s.universe.explored=[{symbol:'SNXX',asset:'stock'}];}];
  for(const change of changes) await isolated(async cfg=>{
    const first=offline(cfg);try {await first.start();} finally {await first.stop();}
    const file=path.join(cfg.dataDir,'state.json');const saved=JSON.parse(await readFile(file,'utf8'));change(saved);await writeFile(file,JSON.stringify(saved));
    const next=offline(cfg);let starts=0;next.feed.start=async()=>{starts++;};
    try {await assert.rejects(next.start(),/intraday/i);assert.equal(starts,0);} finally {await next.stop();}
  });
});

async function enrolledCheckpoint(cfg:Config) {
  const first=offline(cfg);try {await first.start();} finally {await first.stop();}
  const file=path.join(cfg.dataDir,'state.json');
  return {file,saved:JSON.parse(await readFile(file,'utf8'))};
}
async function refusesCheckpoint(cfg:Config,file:string,raw:string) {
  await writeFile(file,raw);
  const next=offline(cfg);let starts=0;next.feed.start=async()=>{starts++;};
  try {await assert.rejects(next.start(),/intraday/i);assert.equal(starts,0);assert.equal(await readFile(file,'utf8'),raw);}
  finally {await next.stop();assert.equal(await readFile(file,'utf8'),raw,'failed startup and stop must preserve exact evidence');}
}

test('intraday rejects duplicate trader identities in either intent ordering before feed and preserves checkpoint bytes',async()=>{
  for(const dirtyFirst of [true,false]) await isolated(async cfg=>{
    const {file,saved}=await enrolledCheckpoint(cfg);
    const clean=saved.agents.find((a:any)=>a.id==='t_earl'),dirty=structuredClone(clean);
    dirty.extra.executionIntent={kind:'exit',symbol:'SPY',qty:1,side:'sell',at:1_700_000_000_000};
    saved.agents=saved.agents.filter((a:any)=>a.id!==clean.id);
    saved.agents.push(...(dirtyFirst?[dirty,clean]:[clean,dirty]));
    await refusesCheckpoint(cfg,file,JSON.stringify(saved));
  });
});

test('intraday rejects missing or misidentified custody-bearing agents without guessing roles',async t=>{
  const changes: [string,(s:any)=>void][]=[
    ['missing trader',s=>{s.agents=s.agents.filter((a:any)=>a.id!=='t_earl');}],
    ['missing risk officer',s=>{s.agents=s.agents.filter((a:any)=>a.id!=='k_sarge');}],
    ['unknown trader',s=>{s.agents.find((a:any)=>a.id==='t_earl').id='t_unknown';}],
    ['whitespace identity',s=>{s.agents.find((a:any)=>a.id==='t_earl').id=' t_earl';}],
    ['nonnumeric identity',s=>{s.agents.find((a:any)=>a.id==='t_earl').id=1;}],
    ['wrong role custody',s=>{s.agents.find((a:any)=>a.id==='r_ada').extra.executionIntent={kind:'exit',symbol:'SPY',qty:1,side:'sell',at:1_700_000_000_000};}],
    ['wrong role wallet',s=>{s.agents.find((a:any)=>a.id==='r_ada').extra.wallet=s.agents.find((a:any)=>a.id==='t_earl').extra.wallet;}],
    ['missing trader extra',s=>{delete s.agents.find((a:any)=>a.id==='t_earl').extra;}],
    ['missing risk custody',s=>{delete s.agents.find((a:any)=>a.id==='k_sarge').extra;}],
  ];
  for(const [name,change] of changes) await t.test(name,async()=>isolated(async cfg=>{
    const {file,saved}=await enrolledCheckpoint(cfg);change(saved);
    await refusesCheckpoint(cfg,file,JSON.stringify(saved));
  }));
});

async function checkpointWithReview(cfg:Config) {
  const first=offline(cfg);
  try {await first.start();first.risk.requireReview('manual checkpoint custody review');}
  finally {await first.stop();}
  const file=path.join(cfg.dataDir,'state.json');
  return {file,saved:JSON.parse(await readFile(file,'utf8'))};
}

test('intraday rejects malformed risk pause authority before feed and preserves original bytes through stop',async t=>{
  const changes:[string,(r:any)=>void][]=[['empty risk',r=>{for(const key of Object.keys(r))delete r[key];}]];
  for(const key of ['halted','dailyReviewRequired','reconciliationReviewRequired']) {
    for(const value of [null,'true',0]) changes.push([`${key} ${String(value)}`,r=>{r[key]=value;}]);
    changes.push([`missing ${key}`,r=>{delete r[key];}]);
  }
  for(const [key,values] of Object.entries({haltReason:[0,[]],cooldownUntil:['1',-1,1.5,'RAW_INFINITY',8_640_000_000_000_001],blocked:[null,'1',-1,1.5,'RAW_INFINITY',Number.MAX_SAFE_INTEGER+1]})) {
    for(const value of values) changes.push([`${key} ${String(value)}`,r=>{r[key]=value;}]);
  }
  for(const key of ['haltReason','cooldownUntil','blocked']) changes.push([`missing ${key}`,r=>{delete r[key];}]);
  for(const [name,change] of changes) await t.test(name,async()=>isolated(async cfg=>{
    const {file,saved}=await checkpointWithReview(cfg);change(saved.agents.find((a:any)=>a.id==='k_sarge').extra);
    await refusesCheckpoint(cfg,file,JSON.stringify(saved).replaceAll('"RAW_INFINITY"','1e999'));
  }));
});

test('intraday valid risk review survives restart and denies actual entry approval',async()=>isolated(async cfg=>{
  const {file,saved}=await checkpointWithReview(cfg),expected=saved.agents.find((a:any)=>a.id==='k_sarge').extra;
  const next=offline(cfg);let starts=0;next.feed.start=async()=>{starts++;};
  try {
    await next.start();assert.equal(starts,1);assert.equal(next.risk.toRiskDTO().entriesPaused,true);
    assert.deepEqual(next.risk.save().extra,expected);
    assert.equal(next.risk.approveEntry({traderId:'t_earl',symbol:'SPY',side:'long',notional:100,stopRisk:1,unproven:true}).ok,false);
  } finally {await next.stop();}
  const restored=JSON.parse(await readFile(file,'utf8')).agents.find((a:any)=>a.id==='k_sarge').extra;
  assert.equal(restored.reconciliationReviewRequired,true);assert.deepEqual(restored.reconciliation,expected.reconciliation);
}));

const riskReservation={traderId:'t_earl',symbol:'SPY',side:'long',notional:100,stopRisk:1,unproven:true};

test('intraday rejects malformed or duplicate pending risk custody before feed without evidence loss',async t=>{
  const variants:[string,unknown][]=[['missing',undefined],['null',null],['object',{}],['string','pending'],['null entry',[null]],['array entry',[[]]],['primitive entry',[1]],
    ['duplicate identical',[riskReservation,riskReservation]],['duplicate conflicting',[riskReservation,{...riskReservation,symbol:'QQQ'}]]];
  for(const [key,values] of Object.entries({traderId:['',' t_earl','t_unknown','k_sarge',null,1],symbol:['',' SPY','SNXX',null],side:['buy','LONG',null],notional:[null,'100',0,-1,'RAW_INFINITY'],stopRisk:[null,'1',0,-1,'RAW_INFINITY'],unproven:[null,'true',0]})) {
    for(const value of values) variants.push([`${key} ${String(value)}`,[{...riskReservation,[key]:value}]]);
  }
  for(const key of Object.keys(riskReservation)) {const p:any={...riskReservation};delete p[key];variants.push([`missing ${key}`,[p]]);}
  for(const [name,pending] of variants) await t.test(name,async()=>isolated(async cfg=>{
    const {file,saved}=await checkpointWithReview(cfg);saved.agents.find((a:any)=>a.id==='k_sarge').extra.pending=pending;
    await refusesCheckpoint(cfg,file,JSON.stringify(saved).replaceAll('"RAW_INFINITY"','1e999'));
  }));
});

test('intraday preserves valid pending risk reservations and unresolved intent through restart and resume',async()=>isolated(async cfg=>{
  const first=offline(cfg);
  const pending=[riskReservation,{...riskReservation,traderId:'t_ant',symbol:'QQQ',side:'short',unproven:false}];
  const intent={kind:'entry',symbol:'SPY',qty:1,side:'buy',at:1_700_000_000_000};
  try {
    await first.start();
    for(const p of pending) assert.equal(first.risk.reserveEntry(p).ok,true);
    first.traders[0].executionIntent=intent;
  } finally {await first.stop();}
  const next=offline(cfg);
  try {
    await next.start();assert.deepEqual(next.risk.save().extra.pending,pending);assert.deepEqual(next.traders[0].executionIntent,intent);
    assert.equal(next.risk.toRiskDTO().entriesPaused,true);next.resume();assert.equal(next.risk.toRiskDTO().entriesPaused,true);
    assert.deepEqual(next.risk.save().extra.pending,pending);assert.deepEqual(next.traders[0].executionIntent,intent);
  } finally {await next.stop();}
  const saved=JSON.parse(await readFile(path.join(cfg.dataDir,'state.json'),'utf8'));
  assert.deepEqual(saved.agents.find((a:any)=>a.id==='k_sarge').extra.pending,pending);
  assert.deepEqual(saved.agents.find((a:any)=>a.id==='t_earl').extra.executionIntent,intent);
}));

test('intraday rejects malformed reconciliation diagnostics before feed and preserves risk evidence',async t=>{
  const variants:[string,unknown][]=[['missing',undefined],['array',[]],['primitive',1],['empty',{}]];
  const valid={at:1_700_000_000_000,ok:false,issues:['manual review'],broker:[],ledger:[]};
  for(const [key,values] of Object.entries({at:[null,'1',-1,1.5,'RAW_INFINITY',8_640_000_000_000_001],ok:[null,'false',0],issues:[null,'review',[1]],broker:[null,{},[null],[{}],[{symbol:1,qty:1}],[{symbol:'',qty:1}],[{symbol:'SPY',qty:'1'}],[{symbol:'SPY',qty:'RAW_INFINITY'}]],ledger:[null,{},[null],[{}],[{symbol:'SPY',qty:null}]],equityGap:[null,'1','RAW_INFINITY']})) {
    for(const value of values) variants.push([`${key} ${JSON.stringify(value)}`,{...valid,[key]:value}]);
  }
  for(const key of Object.keys(valid)) {const r:any={...valid};delete r[key];variants.push([`missing ${key}`,r]);}
  for(const [name,reconciliation] of variants) await t.test(name,async()=>isolated(async cfg=>{
    const {file,saved}=await checkpointWithReview(cfg);saved.agents.find((a:any)=>a.id==='k_sarge').extra.reconciliation=reconciliation;
    await refusesCheckpoint(cfg,file,JSON.stringify(saved).replaceAll('"RAW_INFINITY"','1e999'));
  }));
});

test('intraday preserves valid halt daily and reconciliation latches without repairing diagnostics',async t=>{
  for(const kind of ['halt','daily','reconciliation'] as const) await t.test(kind,async()=>isolated(async cfg=>{
    const first=offline(cfg);
    try {
      await first.start();
      if(kind==='halt') await first.risk.halt('manual offline halt');
      if(kind==='daily') {first.fundState.dayStartEquity=1_000_000;first.risk.checkDailyLoss();}
      if(kind==='reconciliation') first.risk.updateReconciliation({at:1_700_000_000_000,ok:false,issues:['signed quantities and equity gap'],broker:[{symbol:'SPY',qty:-1}],ledger:[{symbol:'QQQ',qty:0}],equityGap:-1});
    } finally {await first.stop();}
    const file=path.join(cfg.dataDir,'state.json'),expected=JSON.parse(await readFile(file,'utf8')).agents.find((a:any)=>a.id==='k_sarge').extra;
    const next=offline(cfg);
    try {
      await next.start();assert.deepEqual(next.risk.save().extra,expected);assert.equal(next.risk.toRiskDTO().entriesPaused,true);
      assert.equal(next.risk.approveEntry({traderId:'t_earl',symbol:'SPY',side:'long',notional:100,stopRisk:1,unproven:true}).ok,false);
    } finally {await next.stop();}
    const restored=JSON.parse(await readFile(file,'utf8')).agents.find((a:any)=>a.id==='k_sarge').extra;
    assert.deepEqual({...restored,blocked:expected.blocked},expected);
  }));
});

async function checkpointWithPosition(cfg:Config) {
  const eco=offline(cfg);
  try {
    await eco.start();
    const symbol='SPY',tf=cfg.timeframeFor(symbol);
    const bars=Array.from({length:1500},(_,i)=>{const c=100+i*.001;return {t:1_700_000_000_000+i*tf,o:c,h:c+1,l:c-1,c,v:10000};});
    const genome:Genome={side:'long',entry:[{left:{kind:'close',p:[]},op:'>',right:{t:'ind',spec:{kind:'sma',p:[20]}}}],exit:[],stopAtr:6,takeProfitAtr:0,trailAtr:0,maxBars:24,sizePct:.5,atrPeriod:14};
    const data={symbol,lastT:bars.at(-1)!.t,cache:new IndicatorCache(bars),trainEnd:900};
    const record=makeRecord(data,genome,validate(eco,data,genome),{id:'synthetic',name:'Offline custody fixture'},'evolution');
    assert.equal(eco.vault.add(record),true);
    const trader=eco.traders[0];eco.vault.assign(record.id,trader.id);trader.assign(record);trader.deposit(1000);eco.fundState.reserve-=1000;
    eco.feed.series=(s:string)=>s===symbol?bars:[];eco.feed.price=()=>bars.at(-1)!.c;
    await trader.onCandle(symbol);assert.ok(trader.wallet.position,'real PaperBroker entry must create the saved wallet');
  } finally {await eco.stop();}
  const file=path.join(cfg.dataDir,'state.json');
  return {file,saved:JSON.parse(await readFile(file,'utf8'))};
}

test('intraday rejects malformed wallet cash before a real position can be lost on restore',async t=>{
  for(const [name,cash] of [['null',null],['string','1000'],['missing',undefined],['infinity','RAW_INFINITY'],['negative infinity','RAW_NEG_INFINITY']] as const) {
    await t.test(name,async()=>isolated(async cfg=>{
      const {file,saved}=await checkpointWithPosition(cfg);
      saved.agents.find((a:any)=>a.id==='t_earl').extra.wallet.cash=cash;
      const raw=JSON.stringify(saved).replace('"RAW_INFINITY"','1e999').replace('"RAW_NEG_INFINITY"','-1e999');
      await refusesCheckpoint(cfg,file,raw);
    }));
  }
});

test('intraday rejects malformed wallet and position fields without changing custody evidence',async t=>{
  const changes:[string,(w:any)=>any][]=[
    ['wallet array',()=>[]],['wallet primitive',()=>100],['wallet null',()=>null],
    ['missing position',w=>{delete w.position;return w;}],['position array',w=>({...w,position:[]})],['position primitive',w=>({...w,position:1})],
    ['units missing',w=>{delete w.units;return w;}],['units null',w=>({...w,units:null})],['units string',w=>({...w,units:'1'})],['units negative',w=>({...w,units:-1})],['units infinite',w=>({...w,units:'RAW_INFINITY'})],
  ];
  for(const [field,values] of Object.entries({symbol:['',' SPY','SNXX',null],side:['buy','LONG',null],qty:[0,-1,'1',null,'RAW_INFINITY'],entryPrice:[0,-1,'100',null],entryTime:[null,-1,'1'],entryFee:[null,-1,'0'],stop:[null,'100','RAW_INFINITY'],takeProfit:['100','RAW_INFINITY'],extreme:[0,-1,null,'100'],barsHeld:[-1,.5,null,'0'],strategyId:['',null,1],partialPnl:[null,'1','RAW_INFINITY']})) {
    for(const value of values) changes.push([`${field} ${String(value)}`,w=>({...w,position:{...w.position,[field]:value}})]);
  }
  for(const field of ['symbol','side','qty','entryPrice','entryTime','entryFee','stop','takeProfit','extreme','barsHeld','strategyId']) {
    changes.push([`missing ${field}`,w=>{delete w.position[field];return w;}]);
  }
  // One real paper entry is the source of every corrupted wallet, not an invented save schema.
  await isolated(async source=>{
    const {saved:valid}=await checkpointWithPosition(source);
    for(const [name,change] of changes) await t.test(name,async()=>isolated(async cfg=>{
      const {file}=await enrolledCheckpoint(cfg),saved=structuredClone(valid);
      const trader=saved.agents.find((a:any)=>a.id==='t_earl');trader.extra.wallet=change(trader.extra.wallet);
      await refusesCheckpoint(cfg,file,JSON.stringify(saved).replaceAll('"RAW_INFINITY"','1e999'));
    }));
  });
});

test('intraday valid real wallet and unresolved intent survive restart with review still required',async()=>{
  await isolated(async cfg=>{
    const {file,saved}=await checkpointWithPosition(cfg);
    const trader=saved.agents.find((a:any)=>a.id==='t_earl');
    trader.extra.executionIntent={kind:'exit',symbol:'SPY',qty:1,side:'sell',at:1_700_000_000_000};
    await writeFile(file,JSON.stringify(saved));
    const next=offline(cfg);
    try {
      await next.start();assert.deepEqual(next.traders[0].wallet,trader.extra.wallet);assert.deepEqual(next.traders[0].executionIntent,trader.extra.executionIntent);
      assert.equal(next.risk.toRiskDTO().entriesPaused,true);next.resume();assert.equal(next.risk.toRiskDTO().entriesPaused,true);
    } finally {await next.stop();}
    const restored=JSON.parse(await readFile(file,'utf8')).agents.find((a:any)=>a.id==='t_earl');
    assert.deepEqual(restored.extra.wallet,trader.extra.wallet);assert.deepEqual(restored.extra.executionIntent,trader.extra.executionIntent);
  });
});

test('intraday accepts real nonempty flat and negative-cash short wallets without repair',async t=>{
  for(const kind of ['real long','negative-cash short','flat'] as const) await t.test(kind,async()=>isolated(async cfg=>{
    const {file,saved}=await checkpointWithPosition(cfg);
    const trader=saved.agents.find((a:any)=>a.id==='t_earl');
    if(kind==='negative-cash short') {
      trader.extra.wallet.cash=-10;trader.extra.wallet.position.side='short';
      trader.extra.wallet.position.takeProfit=-1;trader.extra.wallet.position.partialPnl=-5;
    }
    if(kind==='flat') trader.extra.wallet={cash:0,units:0,position:null};
    await writeFile(file,JSON.stringify(saved));
    const next=offline(cfg);let starts=0;next.feed.start=async()=>{starts++;};
    try {await next.start();assert.equal(starts,1);assert.deepEqual(next.traders[0].wallet,trader.extra.wallet);}
    finally {await next.stop();}
    assert.deepEqual(JSON.parse(await readFile(file,'utf8')).agents.find((a:any)=>a.id==='t_earl').extra.wallet,trader.extra.wallet);
  }));
});

test('intraday constructor refuses external execution frozen enrollment unsafe controls or legacy directories before clients',()=>{
  const cfg=isolatedConfig('/isolated/data-hi-intraday');
  for(const change of [{execution:'alpaca'},{execution:'okx'},{dataDir:'/isolated/data-hi'},{live:{...cfg.live,enabled:true}},{frozen:{...cfg.frozen,enabled:true}},{llm:{...cfg.llm,enabled:true}},{universe:{...cfg.universe,scanEnabled:true}},{timeframeFor:()=>3_600_000}]) {
    assert.throws(()=>new Ecosystem({...cfg,...change} as Config),/intraday/i);
  }
});

test('intraday history requires research-safe warmup while the ordinary 400-bar feed minimum is unchanged',async()=>{
  for(const intraday of [true,false]) {
    const cfg={...isolatedConfig('/isolated/data-hi-intraday'),intraday,symbols:['BTC']};
    const bars=Array.from({length:500},(_,i)=>({t:1_700_000_000_000+i*900_000,o:100,h:101,l:99,c:100,v:100}));
    const feed:any=new MarketFeed(cfg as Config,{fetchHistory:async()=>bars,fetchPrices:async()=>({BTC:100})} as any);feed.schedule=()=>{};
    try {if(intraday) await assert.rejects(feed.start(),/1500/);else await feed.start();} finally {feed.stop();}
  }
});

test('actual Alpaca history routes stock 5Min and crypto 15Min with 10000 closed bars and excludes unfinished warmup data',async(t)=>{
  const cfg={...isolatedConfig('/isolated/data-hi-intraday'),symbols:['SPY','BTC'],historyBars:10000,
    alpaca:{...config.alpaca,keyId:'fake',secret:'fake',dataUrl:'https://fake.invalid'}} as unknown as Config;
  const seen:URL[]=[];
  t.mock.method(globalThis,'fetch',async(input:any)=>{
    const url=new URL(String(input));seen.push(url);assert.match(url.pathname,/\/bars$/);
    const stock=url.pathname.includes('/stocks/'),tf=stock?300_000:900_000;
    assert.equal(url.searchParams.get('timeframe'),stock?'5Min':'15Min');
    if(stock) {assert.equal(url.searchParams.get('feed'),'iex');assert.ok(Date.now()-Date.parse(url.searchParams.get('start')!)>100*86_400_000);}
    const end=Math.floor(Date.now()/tf)*tf;
    const rows=Array.from({length:10001},(_,i)=>({t:new Date(end-(10000-i)*tf).toISOString(),o:100,h:101,l:99,c:100,v:100}));
    return new Response(JSON.stringify({bars:stock?rows:{'BTC/USD':rows},next_page_token:null}),{status:200,headers:{'content-type':'application/json'}});
  });
  const client=new AlpacaClient(cfg);t.mock.method(client,'fetchPrices',async(symbols:string[])=>Object.fromEntries(symbols.map(s=>[s,100])));
  const feed:any=new MarketFeed(cfg,client);feed.schedule=()=>{};
  try {await feed.start();for(const symbol of cfg.symbols){assert.equal(feed.series(symbol).length,10000);assert.ok(feed.series(symbol).at(-1).t+cfg.timeframeFor(symbol)<=Date.now());}assert.equal(seen.length,2);} finally {feed.stop();}
});

test('deterministic synthetic replay books entries and time exits on two allowed timeframes with unchanged validated genomes and actual risk',async()=>{
  await isolated(async cfg=>{
    const eco=offline(cfg);try {
      await eco.start();
      for(const [index,symbol] of ['SPY','BTC'].entries()) {
        const tf=cfg.timeframeFor(symbol),max=symbol==='SPY'?24:4;
        const all=Array.from({length:1500},(_,i)=>{const c=100+i*.001;return {t:1_700_000_000_000+i*tf,o:c,h:c+1,l:c-1,c,v:10000};});
        const g:Genome={side:'long',entry:[{left:{kind:'close',p:[]},op:'>',right:{t:'ind',spec:{kind:'sma',p:[20]}}}],exit:[],stopAtr:6,takeProfitAtr:0,trailAtr:0,maxBars:max,sizePct:.5,atrPeriod:14};
        const before=structuredClone(g),data={symbol,lastT:all.at(-1)!.t,cache:new IndicatorCache(all),trainEnd:900};
        const verdict=validate(eco,data,g);assert.equal(verdict.passed,false,'fixture is not claimed promoted');
        const costs=backtestOptions(eco,symbol);
        const replay=backtest(data.cache,g,0,all.length,costs).metrics;
        assert.ok(replay.trades>0);assert.ok(replay.totalReturn<backtest(data.cache,g,0,all.length,{...costs,feeRate:0,slippage:0}).metrics.totalReturn);
        // Manual fixture enrollment is not a promotion claim. Actual risk, durable
        // reservation/revalidation, PaperBroker and ledger are left unmodified.
        const record=makeRecord(data,g,verdict,{id:'synthetic',name:'Synthetic offline fixture'},'evolution');
        assert.equal(eco.vault.add(record),true);const trader=eco.traders[index];eco.vault.assign(record.id,trader.id);trader.assign(record);trader.deposit(1000);eco.fundState.reserve-=1000;
        const window=all.slice(0,1000);eco.feed.series=(s:string)=>s===symbol?window:[];eco.feed.price=()=>window.at(-1)!.c;
        await trader.onCandle(symbol);assert.ok(trader.wallet.position,JSON.stringify(trader.entryDiagnostics()));
        for(let i=1;i<max;i++){window.push(all[999+i]);await trader.onCandle(symbol);assert.ok(trader.wallet.position);}
        window.push(all[999+max]);await trader.onCandle(symbol);assert.equal(trader.wallet.position,null);
        const trade=eco.snapshot().trades.find((t:any)=>t.symbol===symbol);assert.ok(trade);assert.equal(trade.reason,'time limit');
        assert.equal(trade.fees>0,symbol==='BTC');assert.deepEqual(g,before);assert.strictEqual(record.genome,g);
        assert.equal(trader.entryDiagnostics().counts['entry-filled'],1);assert.equal(eco.risk.toRiskDTO().entriesPaused,false);
      }
      assert.equal(eco.snapshot().fund.trades,2);
    } finally {await eco.stop();}
  });
});

test('intraday admissions assignment and restores reject long holds instead of rewriting approved genomes',()=>{
  const cfg=isolatedConfig('/isolated/data-hi-intraday'); const eco=offline(cfg);eco.createAgents();
  const record:any={id:'fixed',symbol:'SPY',name:'synthetic',genome:{...classicGenomes('trend')[0],maxBars:25},status:'vault',traderId:null,fitness:1,
    train:{trades:120,totalReturn:.1},test:{trades:24,totalReturn:.1},live:{trades:0,pnl:0,lastTradeAt:null}};
  const original=structuredClone(record.genome);
  assert.equal(eco.vault.add(record),false);assert.throws(()=>eco.vault.restore([record]),/intraday/);
  assert.throws(()=>eco.traders[0].assign(record),/intraday/);assert.deepEqual(record.genome,original);
  const valid={...record,genome:{...record.genome,maxBars:24}};
  assert.equal(eco.vault.add(valid),true);eco.vault.assign(valid.id,eco.traders[0].id);eco.traders[0].assign(valid);
  const saved=eco.traders[0].save();eco.traders[0].strategy=null;eco.traders[0].restore(saved);
  assert.equal(eco.traders[0].strategy.genome.maxBars,24);assert.strictEqual(eco.traders[0].strategy.genome,valid.genome);
  const normal=offline({...cfg,intraday:false});assert.equal(normal.vault.add(record),true);normal.createAgents();assert.equal('experiment' in normal.snapshot().runtime,false);
});

test('real research evaluates only bounded timeframe-matched genomes across seeds immigrants and breeding, default unchanged',()=>{
  for(const symbol of ['SPY','BTC']) {
    const f=researchFixture(symbol); const r=new Researcher(f.ctx,'r','Ada',{skin:'',hair:'',shirt:'',pants:'',hat:'none'},'breakout',0);
    const seen:Genome[]=[]; const actual=(r as any).evaluate.bind(r);
    (r as any).evaluate=(data:any,g:Genome)=>{seen.push(structuredClone(g));actual(data,g);};
    r.receive([{...classicGenomes('trend')[0],maxBars:400}]); r.work(10_000);
    assert.equal(r.epoch,1); assert.equal(seen.length,36);
    const max=symbol==='SPY'?24:4;
    assert.ok(seen.every(g=>Number.isInteger(g.maxBars)&&g.maxBars>=4&&g.maxBars<=max),`${symbol}: ${seen.map(g=>g.maxBars)}`);
  }
  const f=researchFixture('SPY',false); const r=new Researcher(f.ctx,'r','Ada',{skin:'',hair:'',shirt:'',pants:'',hat:'none'},'breakout',0);
  r.work(0); assert.ok((r as any).population.some((g:Genome)=>g.maxBars>24));
});

test('real validation rejects nonconforming intraday genomes without repair while default retains its hold policy',()=>{
  for(const symbol of ['SPY','BTC']) {
    const f=researchFixture(symbol); const max=symbol==='SPY'?24:4;
    const g={...classicGenomes('trend')[0],maxBars:max+1}; const copy=structuredClone(g);
    const rejected=validate(f.ctx,f.data,g);
    assert.equal(rejected.passed,false); assert.equal(rejected.passedBasic,false); assert.match(rejected.why,/intraday hold policy/);
    assert.deepEqual(g,copy);
    assert.doesNotMatch(validate(f.ctx,f.data,{...g,maxBars:max}).why,/intraday hold policy/);
    const normal=researchFixture(symbol,false);
    assert.doesNotMatch(validate(normal.ctx,normal.data,g).why,/intraday hold policy/);
  }
});
