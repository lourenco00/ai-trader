import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../server/config';
import { Ecosystem } from '../server/ecosystem';
import { ShadowResearch, dsaSettings } from '../server/research/dsa';

const now = Date.now();
const report = (action: string | null = 'hold', queryId = 'q1') => ({meta:{id:1,query_id:queryId,stock_code:'AAPL',created_at:new Date(now).toISOString(),asset_type:'stock'},summary:{action,operation_advice:'Neutral / hold',sentiment_score:50}});
async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const dir = await mkdtemp(path.join(process.cwd(), '.dsa-test-'));
  const baseUrl = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const settings = {...dsaSettings({}),enabled:true,baseUrl,symbols:['AAPL'],intervalMs:10_000};
  const cfg = {dataDir:dir,symbols:['AAPL'],assetClass:(_s:string)=>'stock'};
  return {settings,cfg,dir,async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}};
}
function json(res: ServerResponse, body: unknown) {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));}

test('history mode ingests actual list/detail paths without POST and persists deduped hold', async () => {
  const requests:string[]=[];
  const f=await fixture((req,res)=>{requests.push(`${req.method} ${req.url}`);json(res,req.url?.startsWith('/api/v1/history?') ? {total:1,page:1,limit:1,items:[{id:1,query_id:'q1',stock_code:'AAPL'}]} : report());});
  const r=new ShadowResearch(f.settings,f.cfg,()=>now);
  try {
    await r.start(false);await r.tick();
    assert.equal(r.snapshot().records[0]?.action,'hold');
    assert.equal(r.snapshot().records[0]?.sentimentScore,50);
    assert.equal('confidence' in r.snapshot().records[0],false);
    assert.deepEqual(requests,['GET /api/v1/history?stock_code=AAPL&page=1&limit=1','GET /api/v1/history/1']);
    await r.stop();
    const restarted=new ShadowResearch(f.settings,f.cfg,()=>now);
    await restarted.start(false);await restarted.tick();
    assert.equal(restarted.snapshot().records.length,1);
    assert.equal(JSON.parse(await readFile(path.join(f.dir,'dsa-research.json'),'utf8')).version,1);
    await restarted.stop();
  } finally {await r.stop();await f.close();}
});

test('disabled and non-stock/unconfigured/removed symbols never cause HTTP traffic', async () => {
  let hits=0;
  const f=await fixture((_req,res)=>{hits++;json(res,{items:[]});});
  try {
    for (const kind of ['disabled','crypto','unknown','removed']) {
      const cfg={...f.cfg,symbols:kind==='unknown'?[]:['AAPL'],assetClass:()=>kind==='crypto'?'crypto':'stock'};
      const r=new ShadowResearch({...f.settings,enabled:kind!=='disabled'},cfg,()=>now);
      await r.start(false);
      if(kind==='removed') cfg.symbols.length=0;
      await r.tick();await r.stop();
    }
    assert.equal(hits,0);
  } finally {await f.close();}
});

test('rejects malformed, stale, future, naive, mismatched or non-stock history reports', async () => {
  const cases=[
    (r:any)=>{r.meta.stock_code='MSFT';}, (r:any)=>{r.meta.query_id='wrong';},
    (r:any)=>{r.meta.id=2;}, (r:any)=>{r.meta.asset_type='index';},
    (r:any)=>{r.meta.created_at=new Date(now-200_000_000).toISOString();},
    (r:any)=>{r.meta.created_at=new Date(now+600_000).toISOString();},
    (r:any)=>{r.meta.created_at='2026-11-11T01:00:00';},
    (r:any)=>{r.meta.created_at=null;}, (r:any)=>{r.summary.action='short';},
    (r:any)=>{r.summary.sentiment_score='99';}, (r:any)=>{r.summary=null;},
    (r:any)=>{r.meta.report_type='market_review';},
  ];
  for (const mutate of cases) {
    const bad=report();mutate(bad);
    const f=await fixture((req,res)=>json(res,req.url?.includes('?')?{items:[{id:1,query_id:'q1',stock_code:'AAPL'}]}:bad));
    const r=new ShadowResearch(f.settings,f.cfg,()=>now);
    try {await r.start(false);await r.tick();assert.equal(r.snapshot().records.length,0);assert.equal(r.snapshot().lastError,'invalid_report');}
    finally {await r.stop();await f.close();}
  }
});

test('settings are strict opt-in with capped explicit submission budget and private credential-free origin', () => {
  assert.equal(dsaSettings({}).enabled,false);
  assert.equal(dsaSettings({}).mode,'history');
  assert.equal(dsaSettings({DSA_ENABLED:'true',DSA_SYMBOLS:'AAPL'}).enabled,true);
  for (const env of [
    {DSA_ENABLED:'yes'}, {DSA_MODE:'live'}, {DSA_SYMBOLS:'AAPL,AAPL'}, {DSA_SYMBOLS:'aapl'},
    {DSA_MAX_DAILY:'NaN'}, {DSA_MAX_DAILY:'1.5'}, {DSA_MAX_DAILY:'11'},
    {DSA_MODE:'submit'}, {DSA_BASE_URL:'http://user:secret@127.0.0.1:8000'},
    {DSA_BASE_URL:'https://example.com'}, {DSA_BASE_URL:'http://127.0.0.1:8000/path'},
  ]) assert.throws(()=>dsaSettings(env),/DSA/);
});

test('explicit UTC contract supports upstream naive dates and retains all eight actions or null without directional inference', async () => {
  let action:string|null='buy';
  const f=await fixture((req,res)=>{
    const value=report(action);value.meta.created_at=new Date(now).toISOString().replace('Z','');value.meta.query_id=action ?? 'neutral';
    json(res,req.url?.includes('?')?{items:[{id:1,query_id:action ?? 'neutral',stock_code:'AAPL'}]}:value);
  });
  const r=new ShadowResearch({...f.settings,assumeUtc:true},f.cfg,()=>now);
  try {
    await r.start(false);
    for(const a of ['buy','add','hold','reduce','sell','watch','avoid','alert',null]) {action=a;await r.tick();assert.equal(r.snapshot().records.at(-1)?.action,a);}
    assert.equal(r.snapshot().records.length,9);
    assert.equal('direction' in r.snapshot().records[0],false);
  } finally {await r.stop();await f.close();}
});

test('HTTP transport refuses redirects, non-JSON, errors, oversized and slow responses without leaking internals', async () => {
  for (const behavior of ['redirect','type','error','size','stream','slow','json']) {
    let redirected=0;
    const f=await fixture((req,res)=>{
      if(req.url==='/secret') {redirected++;json(res,{items:[]});return;}
      if(behavior==='redirect') {res.writeHead(302,{Location:'/secret'});res.end();}
      else if(behavior==='error') {res.writeHead(500);res.end('credential=secret');}
      else if(behavior==='type') res.end('<html>secret</html>');
      else if(behavior==='slow') { /* timeout must cancel */ }
      else if(behavior==='json') {res.setHeader('Content-Type','application/json');res.end('{');}
      else {res.setHeader('Content-Type','application/json');if(behavior==='size') res.setHeader('Content-Length','99999');res.end(' '.repeat(2048));}
    });
    const r=new ShadowResearch({...f.settings,timeoutMs:50,maxBytes:1024},f.cfg,()=>now);
    try {await r.start(false);await r.tick();assert.equal(r.snapshot().lastError,'transport_error');assert.equal(redirected,0);assert.equal(JSON.stringify(r.snapshot()).includes('secret'),false);}
    finally {await r.stop();await f.close();}
  }
});

test('submit mode checkpoints daily budget before async POST and resumes bounded GET status after restart', async () => {
  const calls:string[]=[];let payload:unknown;let dir='';
  const f=await fixture((req,res)=>{
    calls.push(`${req.method} ${req.url}`);
    if(req.method==='POST') {
      let raw='';req.on('data',b=>{raw+=b;});req.on('end',async()=>{
        payload=JSON.parse(raw);
        const saved=JSON.parse(await readFile(path.join(dir,'dsa-research.json'),'utf8'));
        assert.deepEqual(saved.daily.attempted,['AAPL']);
        json(res,{task_id:'task_1',status:'pending'});
      });
    } else json(res,{task_id:'task_1',status:'completed',result:{query_id:'task_1',stock_code:'AAPL',created_at:new Date(now).toISOString(),report:report('hold','task_1')}});
  });dir=f.dir;
  const settings={...f.settings,mode:'submit' as const,maxDaily:1};
  let r=new ShadowResearch(settings,f.cfg,()=>now);
  try {
    await r.start(false);await r.tick();await r.stop();
    r=new ShadowResearch(settings,f.cfg,()=>now);await r.start(false);await r.tick();await r.tick();
    assert.deepEqual(payload,{stock_code:'AAPL',async_mode:true,notify:false,force_refresh:false,report_language:'en'});
    assert.deepEqual(calls,['POST /api/v1/analysis/analyze','GET /api/v1/analysis/status/task_1']);
    assert.equal(r.snapshot().records[0]?.action,'hold');
    assert.equal(r.snapshot().records[0]?.queryId,'task_1');
    assert.equal(r.snapshot().attemptedToday,1);
  } finally {await r.stop();await f.close();}
});

test('completed result and report query IDs must match the accepted task ID', async () => {
  for(const [queryId,metaQueryId] of [['other','other'],['task_1','other'],['other','task_1']]) {
    const f=await fixture((req,res)=>json(res,req.method==='POST'?{task_id:'task_1',status:'pending'}:
      {task_id:'task_1',status:'completed',result:{query_id:queryId,stock_code:'AAPL',report:report('hold',metaQueryId)}}));
    const r=new ShadowResearch({...f.settings,mode:'submit',maxDaily:1},f.cfg,()=>now);
    try {
      await r.start(false);await r.tick();await r.tick();
      assert.equal(r.snapshot().records.length,0,`${queryId}/${metaQueryId} is not the accepted task`);
      assert.equal(r.snapshot().lastError,'invalid_report');
    } finally {await r.stop();await f.close();}
  }
});

test('stop aborts in-flight work, serializes ticks and never accepts a late response', async () => {
  let hits=0;let reached!:()=>void;
  const seen=new Promise<void>(resolve=>{reached=resolve;});
  const f=await fixture((_req,_res)=>{hits++;reached();});
  const r=new ShadowResearch({...f.settings,timeoutMs:5000},f.cfg,()=>now);
  try {
    await r.start(false);const first=r.tick();await seen;
    await r.tick();
    const stoppedAt=Date.now();await r.stop();await first;
    assert.ok(Date.now()-stoppedAt<500,'stop must cancel rather than await network timeout');
    await r.tick();assert.equal(hits,1);assert.equal(r.snapshot().records.length,0);
  } finally {await r.stop();await f.close();}
});

test('bounded persistence and fail-closed corrupt checkpoint never replenish paid budget or leak stored fields', async () => {
  let q=0;let hits=0;
  const f=await fixture((req,res)=>{hits++;const value=report();value.meta.query_id=`q${q}`;json(res,req.url?.includes('?')?{items:[{id:1,query_id:`q${q}`,stock_code:'AAPL'}]}:value);});
  let r=new ShadowResearch({...f.settings,maxRecords:2},f.cfg,()=>now);
  try {
    await r.start(false);for(q=0;q<4;q++) await r.tick();
    assert.equal(r.snapshot().records.length,2);await r.stop();
    const file=path.join(f.dir,'dsa-research.json');
    const saved=JSON.parse(await readFile(file,'utf8'));saved.records[0].apiKey='secret';
    await writeFile(file,JSON.stringify(saved));
    r=new ShadowResearch(f.settings,f.cfg,()=>now);await r.start(false);
    assert.equal(JSON.stringify(r.snapshot()).includes('secret'),false);await r.stop();
    await writeFile(file,'{broken');
    const before=hits;
    r=new ShadowResearch({...f.settings,mode:'submit',maxDaily:1},f.cfg,()=>now);
    await r.start(false);await r.tick();
    assert.equal(r.snapshot().lastError,'storage_error');assert.equal(hits,before);
  } finally {await r.stop();await f.close();}
});

test('existing JSON null checkpoint fails closed before any HTTP', async () => {
  let hits=0;
  const f=await fixture((_req,res)=>{hits++;json(res,{task_id:'task_1',status:'pending'});});
  const r=new ShadowResearch({...f.settings,mode:'submit',maxDaily:1},f.cfg,()=>now);
  try {
    await writeFile(path.join(f.dir,'dsa-research.json'),'null');
    await r.start(false);await r.tick();
    assert.equal(r.snapshot().lastError,'storage_error');
    assert.equal(r.snapshot().running,false);
    assert.equal(hits,0);
    assert.equal(await readFile(path.join(f.dir,'dsa-research.json'),'utf8'),'null');
  } finally {await r.stop();await f.close();}
});

test('ecosystem lifecycle exposes shadow state while research never changes board, strategies, risk or fund', async () => {
  let reached!:()=>void;const seen=new Promise<void>(resolve=>{reached=resolve;});
  let finish!:()=>void;
  const f=await fixture((req,res)=>{
    if(req.url?.includes('?')) {finish=()=>json(res,{items:[{id:1,query_id:'q1',stock_code:'AAPL'}]});reached();}
    else json(res,report('sell'));
  });
  const eco:any=new Ecosystem({...config,dataDir:f.dir,dsa:f.settings,symbols:['AAPL'],symbolSpecs:[{symbol:'AAPL',asset:'stock'}],assetClass:()=> 'stock',
    execution:'paper',provider:'sim',llm:{...config.llm,enabled:false},news:{...config.news,enabled:false},universe:{...config.universe,scanEnabled:false,scanStocks:false}} as any);
  eco.feed.start=async()=>{eco.feed.provider={name:'sim'};};
  try {
    assert.ok(eco.dsaResearch,'ecosystem must own the shadow lifecycle');
    await eco.start();await Promise.race([seen,new Promise((_,reject)=>setTimeout(()=>reject(new Error('no scheduled research')),1000).unref())]);
    const before=eco.snapshot();assert.equal(before.dsaResearch.shadowOnly,true);
    finish();
    for(let n=0;n<100 && !eco.snapshot().dsaResearch.records.length;n++) await new Promise(resolve=>setTimeout(resolve,5));
    const after=eco.snapshot();assert.equal(after.dsaResearch.records[0]?.action,'sell');
    assert.deepEqual(after.signals,before.signals);assert.deepEqual(after.strategies,before.strategies);
    assert.deepEqual(after.fund,before.fund);assert.deepEqual(after.risk,before.risk);
    assert.equal(JSON.stringify(after.dsaResearch).includes(f.settings.baseUrl),false);
    await eco.stop();assert.equal(eco.dsaResearch.snapshot().running,false);
  } finally {await eco.stop();await f.close();}
});

test('daily submission and polling caps survive ambiguous timeout, restart and clock rollback', async () => {
  for(const behavior of ['timeout','pending','failed','mismatched','stale']) {
    let posts=0,gets=0;let time=now;
    const f=await fixture((req,res)=>{
      if(req.method==='POST') {posts++;if(behavior!=='timeout') json(res,{task_id:'task_1',status:'pending'});return;}
      gets++;
      const value=report('hold','task_1');
      if(behavior==='stale') value.meta.created_at=new Date(now-200_000_000).toISOString();
      json(res,behavior==='stale'?{task_id:'task_1',status:'completed',result:{stock_code:'AAPL',query_id:'task_1',report:value}}:
        {task_id:behavior==='mismatched'?'wrong':'task_1',status:behavior==='failed'?'failed':'pending'});
    });
    const settings={...f.settings,mode:'submit' as const,maxDaily:1,maxPolls:2,timeoutMs:50};
    let r=new ShadowResearch(settings,f.cfg,()=>time);
    try {
      await r.start(false);await r.tick();await r.tick();await r.stop();
      r=new ShadowResearch(settings,f.cfg,()=>time);await r.start(false);
      for(let n=0;n<4;n++) await r.tick();
      time=now-86_400_000;await r.tick();
      assert.equal(posts,1);assert.ok(gets<=2);assert.equal(r.snapshot().records.length,0);
      assert.equal(r.snapshot().dailyCap,1);
      if(behavior==='pending') assert.equal(r.snapshot().exhaustedTasks,1);
      if(behavior==='timeout') assert.equal(r.snapshot().ambiguousSubmissions,1);
    } finally {await r.stop();await f.close();}
  }
});

test('UTC midnight during durable intent skips stale authorization before POST', async () => {
  let time=Date.parse('2026-11-11T23:59:59.999Z');
  const posts:number[]=[];
  const f=await fixture((req,res)=>{
    if(req.method==='POST') {posts.push(time);json(res,{task_id:'task_1',status:'pending'});}
    else json(res,{task_id:'task_1',status:'pending'});
  });
  const r=new ShadowResearch({...f.settings,mode:'submit',maxDaily:1},f.cfg,()=>time);
  const worker=r as any;
  const persist=worker.persist.bind(r);
  let crossMidnight=true;
  worker.persist=async()=>{await persist();if(crossMidnight) {crossMidnight=false;time=Date.parse('2026-11-12T00:00:00.000Z');}};
  try {
    await r.start(false);await r.tick();
    assert.equal(posts.length,0,"yesterday's durable intent cannot authorize a POST today");
    await r.tick();await r.tick();
    assert.deepEqual(posts,[Date.parse('2026-11-12T00:00:00.000Z')]);
    const saved=JSON.parse(await readFile(path.join(f.dir,'dsa-research.json'),'utf8'));
    assert.equal(saved.daily.day,'2026-11-12');
    assert.deepEqual(saved.daily.attempted,['AAPL']);
    assert.equal(r.snapshot().attemptedToday,1);
  } finally {await r.stop();await f.close();}
});

test('snapshot marks expired research stale and excludes symbols removed while HTTP is in flight', async () => {
  let time=now;let release!:()=>void;let reached!:()=>void;
  const seen=new Promise<void>(resolve=>{reached=resolve;});
  let defer=false;
  const f=await fixture((req,res)=>{
    if(req.url?.includes('?')) json(res,{items:[{id:1,query_id:'q1',stock_code:'AAPL'}]});
    else if(defer) {release=()=>json(res,report());reached();} else json(res,report());
  });
  const r=new ShadowResearch(f.settings,f.cfg,()=>time);
  try {
    await r.start(false);await r.tick();time=now+200_000_000;
    assert.equal(r.snapshot().records[0]?.stale,true);
    time=now;defer=true;const active=r.tick();await seen;f.cfg.symbols=[];release();await active;
    assert.equal(r.snapshot().records.length,0);
    f.cfg.symbols=['AAPL'];assert.equal(r.snapshot().records.length,1);
  } finally {await r.stop();await f.close();}
});

test('stop during initialization cannot restart the worker', async () => {
  const f=await fixture((_req,res)=>json(res,{items:[]}));
  const r=new ShadowResearch(f.settings,f.cfg,()=>now);
  try {const starting=r.start();await r.stop();await starting;assert.equal(r.snapshot().running,false);}
  finally {await r.stop();await f.close();}
});

test('concurrent starts cannot resurrect initialization after stop', async () => {
  let hits=0;
  const f=await fixture((_req,res)=>{hits++;json(res,{items:[]});});
  const r=new ShadowResearch(f.settings,f.cfg,()=>now);
  try {
    const first=r.start(false), second=r.start(false);
    await r.stop();await Promise.all([first,second]);await r.tick();
    assert.equal(r.snapshot().running,false);
    assert.equal(hits,0);
    // A deliberate later start still works; the cancelled initialization is not sticky.
    await r.start(false);await r.tick();assert.equal(hits,1);
  } finally {await r.stop();await f.close();}
});

test('calendar-invalid timestamps are rejected even when Date.parse normalizes them into a fresh date', async () => {
  const f=await fixture((req,res)=>{const value=report();value.meta.created_at='2026-11-31T12:00:00Z';json(res,req.url?.includes('?')?{items:[{id:1,query_id:'q1',stock_code:'AAPL'}]}:value);});
  const r=new ShadowResearch(f.settings,f.cfg,()=>Date.parse('2026-12-01T12:00:00Z'));
  try {await r.start(false);await r.tick();assert.equal(r.snapshot().records.length,0);}
  finally {await r.stop();await f.close();}
});

test('removal during history list response prevents the follow-up detail HTTP request', async () => {
  let hits=0;
  const f=await fixture((_req,res)=>{hits++;f.cfg.symbols=[];json(res,{items:[{id:1,query_id:'q1',stock_code:'AAPL'}]});});
  const r=new ShadowResearch(f.settings,f.cfg,()=>now);
  try {await r.start(false);await r.tick();assert.equal(hits,1);assert.equal(r.snapshot().records.length,0);}
  finally {await r.stop();await f.close();}
});

test('ecosystem stops trading feed before waiting for shadow worker shutdown', async () => {
  const eco=new Ecosystem({...config,execution:'paper',universe:{...config.universe,scanStocks:false}});
  let feedStopped=false;let release!:()=>void;
  eco.feed.stop=()=>{feedStopped=true;};
  eco.dsaResearch.stop=()=>new Promise<void>(resolve=>{release=resolve;});
  const stopping=eco.stop();
  try {assert.equal(feedStopped,true);} finally {release();await stopping;}
});
