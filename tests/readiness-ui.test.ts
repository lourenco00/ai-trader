import assert from 'node:assert/strict';
import test from 'node:test';
import { agentPanel, buildingPanel } from '../web/src/ui/panels';
import { agentReadiness, llmReadiness } from '../web/src/ui/readiness';
import { renderHotbar, renderHud, renderRoster } from '../web/src/ui/hud';

test('readiness distinguishes disabled, paused, running and market-waiting from mere configuration', () => {
  const s = pausedNewsSnapshot();
  assert.equal(llmReadiness(s,'n_test',false).state,'disabled');
  assert.equal(llmReadiness(s,'n_test',true).state,'paused');
  s.llmCost.paused=false;
  s.analysts[0].readiness={state:'error',reason:'provider-rejected'};
  assert.equal(llmReadiness(s,'n_test',true).state,'error');
  s.analysts[0].readiness={state:'running',reason:'request in progress'};
  assert.equal(llmReadiness(s,'n_test',true).state,'running');
  const a: any={id:'t',role:'trader'};
  s.risk={halted:false,entriesPaused:false};
  s.traders=[{agentId:'t',strategyId:'strategy',symbol:'AAPL',cash:100,position:null}];
  s.markets=[{symbol:'AAPL',marketOpen:false}];
  assert.equal(agentReadiness(a,s).state,'waiting-market');
  s.traders[0].position={}; s.risk.halted=true;
  assert.equal(agentReadiness(a,s).state,'managing-position');
});

test('fresh-data waiting researchers do not appear to be running the next completed epoch', () => {
  const r: any={agentId:'r',name:'Research',specialty:'Trend',symbol:'BTC',epoch:1,generation:10,generationsPerEpoch:10,
    evaluated:320,discoveries:0,bestFitness:null,bestRules:[],lastResult:'completed',origin:'evolution',enabled:true,workState:'waiting-data'};
  const s: any={researchers:[r],agents:[],strategies:[],llmEnabled:false,totals:{genomesEvaluated:320,strategiesDiscovered:0,strategiesRetired:0},
    gate:{holdoutFraction:0.4,minTestReturn:0.002,minTestSharpe:0.5,minProfitFactor:1.05,maxTestDrawdown:0.2,feeRate:0.001,slippage:0.0003}};
  const html=buildingPanel('lab',s).html;
  assert.match(html,/waiting-data/);
  assert.match(html,/1 completed epochs/);
  assert.doesNotMatch(html,/epoch 2</);
  assert.equal(agentReadiness({id:'r',role:'researcher',activity:'old prose'} as any,s).state,'waiting-data');
});

test('parked shelf rows are visibly quiet/recheckable, not labeled as performance failures', () => {
  const metrics={totalReturn:0,sharpe:0,maxDrawdown:0,trades:0};
  const strategy={id:'s',name:'Quiet',symbol:'BTC',side:'long',author:'Test',origin:'evolution',trial:false,createdAt:1,
    status:'vault',rules:[],test:metrics,train:metrics,live:{trades:0},parked:{at:1,reason:'quiet <script>bad</script>',afterBar:1,navSinceAssign:1,peakNav:1}};
  const html=buildingPanel('vault',{strategies:[strategy],agents:[]} as any).html;
  assert.match(html,/parked/);
  assert.match(html,/quiet &lt;script&gt;bad&lt;\/script&gt;/);
  assert.doesNotMatch(html,/<script>/);
});

function pausedNewsSnapshot(): any {
  return {
    news: [], signals: [], report: null, llmEnabled: true,
    llmCost: { enabled: true, paused: true, pausedReason: 'earnings review required', dailyBudget: 3, spentToday: 0 },
    analysts: [{ agentId: 'n_test', name: 'Test analyst', beat: 'test', enabled: true,
      headlinesRead: 1, signalsPosted: 0, hitRate: null, scored: 0, lastHeadline: 'previous report' }],
    agents: [], researchers: [], traders: [], markets: [],
  };
}

test('Media does not describe a configured but earnings-paused analyst as on duty', () => {
  const html = buildingPanel('media', pausedNewsSnapshot()).html;
  assert.match(html, /paused/i);
  assert.match(html, /earnings review required/);
  assert.doesNotMatch(html, /on duty/);
});

test('Activity XP display groups work by role instead of presenting a universal skill ranking', () => {
  const view = buildingPanel('hall', { achievements: [], agents: [
    { id: 'research', name: 'Research', role: 'researcher', title: 'Researcher', level: 400, xp: 1_000_000 },
    { id: 'trader', name: 'Trader', role: 'trader', title: 'Trader', level: 1, xp: 10 },
  ] } as any);
  assert.match(view.sub, /activity/i);
  assert.match(view.html, /not.*(?:skill|profit)/i);
  assert.match(view.html, /Within-role/);
  assert.doesNotMatch(view.html, /<h3>Leaderboard<\/h3>/);
});

test('agent panel prioritizes blockers and dates reported activity instead of claiming Now', () => {
  const s = pausedNewsSnapshot();
  const a: any = { id:'n_test', name:'Test', title:'Analyst', role:'analyst', home:'media',
    level:5, xp:500, xpForLevel:400, xpToNext:600, mood:'sleeping', activity:'Pondering <script>bad</script>',
    stats:{}, activityAt:1_700_000_000_000, lastWorkAt:1_699_999_000_000 };
  s.serverTime = 1_700_000_060_000;
  const html = agentPanel(a, s).html;
  assert.match(html, /earnings review required/);
  assert.match(html, /Last reported activity/);
  assert.match(html, /Last recorded work/);
  assert.match(html, /Activity level/);
  assert.doesNotMatch(html, /<b>Now:<\/b>/);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('hotbar does not call configuration-enabled researchers busy', () => {
  const s: any = { fund:{openPositions:0,equity:100}, researchers:[{enabled:true}], strategies:[],
    graveyard:[], achievements:[], risk:{halted:false}, signals:[] };
  const el = { innerHTML:'' };
  renderHotbar(el as HTMLElement, s);
  assert.doesNotMatch(el.innerHTML, /1 busy/);
  assert.match(el.innerHTML, /1 enabled/);
});

test('roster shows actual pause before old prose and clamps restored progress', () => {
  const s = pausedNewsSnapshot();
  s.agents = [{id:'n_test',name:'Test',role:'analyst',level:5,xp:1000,xpForLevel:0,xpToNext:100,
    activity:'Pondering',appearance:{hat:'none',skin:'#ffffff',hair:'#111111',shirt:'#333333',pants:'#444444'}}];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const drawing = new Proxy({}, {get:()=>()=>{}});
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>({getContext:()=>drawing,toDataURL:()=> 'data:image/png;base64,'})}});
  try {
    const el = {innerHTML:'',classList:{toggle(){}}};
    renderRoster(el as any, s, false);
    assert.match(el.innerHTML,/paused/);
    assert.match(el.innerHTML,/Activity Lv/);
    assert.match(el.innerHTML,/width:100%/);
    assert.doesNotMatch(el.innerHTML,/width:1000%/);
    assert.doesNotMatch(el.innerHTML,/<span class="act">Pondering<\/span>/);
  } finally {
    if (descriptor) Object.defineProperty(globalThis,'document',descriptor);
    else Reflect.deleteProperty(globalThis,'document');
  }
});

test('HUD does not label a configured live venue or an unverified legacy venue as paper', () => {
  const s: any = {serverTime:1_700_000_000_000,seasonStartedAt:1_699_000_000_000,graduation:[],provider:'alpaca',
    execution:'alpaca',broker:null,risk:{dataStale:false,halted:false},
    fund:{equity:100,totalReturn:0,pnlToday:0,drawdown:0,openPositions:0},runtime:{configuredMoneyMode:'live'}};
  const el = {innerHTML:''};
  renderHud(el as HTMLElement,s);
  assert.match(el.innerHTML,/ALPACA LIVE/);
  assert.doesNotMatch(el.innerHTML,/ALPACA PAPER/);
  delete s.runtime;
  renderHud(el as HTMLElement,s);
  assert.match(el.innerHTML,/MODE UNVERIFIED/);
  assert.doesNotMatch(el.innerHTML,/ALPACA PAPER/);
});

test('vault distinguishes waiting shelf size from currently assignment-eligible candidates', () => {
  const s: any = {strategies:[],allocationDiagnostics:{waiting:36,eligible:0,
    blocked:{'parked':0,'market-closed':36,'symbol-owned':0,'trial-cap':0,'frozen':0,'halted':0},parked:[]}};
  const html=buildingPanel('vault',s).html;
  assert.match(html,/36 waiting/);
  assert.match(html,/0 assignment-eligible/);
  assert.match(html,/market-closed: 36/);
  assert.match(html,/not.*(?:entry|order).*approval/i);
});

test('War Room offers only explicitly eligible bounded evaluation grants, never an unconditional wake', () => {
  const s: any = { ...pausedNewsSnapshot(), execution:'local', provider:'sim',
    risk:{halted:false,entriesPaused:false,entryPauseReasons:[],limits:{unprovenTradeRisk:0.001,maxSymbolStopRisk:0.0025,fundMaxDrawdown:0.2,dailyLossLimit:0.01,maxGrossExposure:1,maxSymbolExposure:0.5,traderMaxDrawdown:0.12},netLong:0,netShort:0,lastDataAt:1},
    fund:{equity:100,dayStartEquity:100,drawdown:0,grossExposure:0} };
  Object.assign(s.llmCost,{totalSpent:1,totalCalls:1,totalTokens:10,attributedPnl:0,netOfCost:-1,canResume:false});
  let html=buildingPanel('warroom',s).html;
  assert.doesNotMatch(html,/data-action="resume-llm"/);
  assert.match(html,/estimated/i);
  s.llmCost.canResume=true;
  html=buildingPanel('warroom',s).html;
  assert.match(html,/data-action="resume-llm"/);
  assert.match(html,/bounded/i);
  assert.doesNotMatch(html,/Wake the LLM back up/);
});
