import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { config } from '../server/config';
import { Ecosystem } from '../server/ecosystem';
import type { Candle } from '../shared/types';
import { setupWatchlist } from '../server/research/setups';
import { buildingPanel } from '../web/src/ui/panels';

const tf = 900_000;
const now = Date.now() - 1_000;
function bars(closes = Array(30).fill(100)): Candle[] {
  return closes.map((c, i) => ({t: now - (closes.length - i) * tf, o:c, h:c+1, l:c-1, c, v:10}));
}
function ecosystem(enabled = true, frozen = false): any {
  const eco: any = new Ecosystem({...config, setupWatchlistEnabled:enabled, execution:'paper',provider:'sim',
    dataDir:'/opt/data/cache/scratch/setup-watchlist-normal', symbols:['BTC'],symbolSpecs:[{symbol:'BTC',asset:'crypto'}],
    assetClass:()=> 'crypto',timeframeFor:()=>tf,live:{...config.live,enabled:false,approval:null,venue:null},
    frozen:{enabled:frozen,dataDir:'/opt/data/cache/scratch/setup-watchlist-frozen',strategyIds:['fixed'],endAt:Date.now()+tf,criteria:'research test'},
    dsa:{...config.dsa,enabled:false},llm:{...config.llm,enabled:false},news:{...config.news,enabled:false},
    universe:{...config.universe,scanEnabled:false,scanStocks:false}} as any);
  eco.createAgents(); eco.feed.provider={name:'sim'};
  return eco;
}

test('snapshot disables research without reading candles including frozen opt-in', () => {
  for(const [enabled,frozen] of [[false,false],[true,true]]) {
    const eco=ecosystem(enabled,frozen);
    eco.scout.markets=()=>[]; // Existing market DTOs also read series; isolate the new research path.
    eco.feed.series=()=>{throw new Error('disabled must not scan');};
    assert.deepEqual(eco.snapshot().setupWatchlist,{researchOnly:true,status:'disabled',rows:[]});
  }
});

test('enabled snapshot reports completed no-match research without changing trading state', () => {
  const eco=ecosystem();
  const candles=bars(); eco.feed.candles.set('BTC',candles);
  eco.traders[0].deposit(100); eco.traders[0].executionIntent={kind:'entry',symbol:'BTC',marker:'unchanged'};
  const state=()=>structuredClone({board:eco.board.all(),vault:eco.vault.all(),wallets:eco.traders.map((t:any)=>t.wallet),
    intents:eco.traders.map((t:any)=>t.executionIntent),fund:eco.fundState,broker:JSON.parse(JSON.stringify(eco.broker))});
  const before=state();
  const watch=eco.snapshot().setupWatchlist;
  assert.equal(watch.status,'enabled'); assert.equal(watch.researchOnly,true);
  assert.deepEqual(watch.rows,[{symbol:'BTC',timeframeMs:tf,asOf:candles.at(-1)!.t+tf,bars:30,status:'no-match',setups:[]}]);
  assert.deepEqual(state(),before); assert.deepEqual(eco.feed.series('BTC'),candles);
});

function scan(candles: Candle[], asset = 'crypto', timeframeMs = tf, at = now) {
  return setupWatchlist({setupWatchlistEnabled:true,symbols:['TEST'],assetClass:()=>asset,timeframeFor:()=>timeframeMs},
    {series:()=>candles},at).rows[0];
}

test('requires 30 completed bars before evaluating setups', () => {
  for(const length of [0,1,20,29]) {
    const row=scan(bars(Array(length).fill(100)));
    assert.equal(row.status,'insufficient-history'); assert.deepEqual(row.setups,[]);
  }
  assert.equal(scan(bars()).status,'no-match');
});

test('20-BAR closing breakout compares strictly against previous closes, not highs', () => {
  const candles=bars([...Array(29).fill(100),101]); candles.forEach(c=>{c.h=150;});
  assert.ok(scan(candles).setups.includes('20-BAR closing breakout'));
  assert.equal(scan(candles).status,'match');
  assert.equal(scan(bars()).setups.includes('20-BAR closing breakout'),false);
  const olderHigh=bars([...Array(9).fill(120),...Array(20).fill(100),101]);
  assert.ok(scan(olderHigh).setups.includes('20-BAR closing breakout'));
});

test('SMA20 reclaim requires strict below-to-above crossing', () => {
  assert.ok(scan(bars([...Array(28).fill(100),90,101])).setups.includes('SMA20 reclaim'));
  for(const closes of [[...Array(29).fill(100),101],[...Array(28).fill(100),90,99],Array(30).fill(100)]) {
    assert.equal(scan(bars(closes)).setups.includes('SMA20 reclaim'),false);
  }
});

test('RSI14 oversold uses existing Wilder math below 30', () => {
  assert.deepEqual(scan(bars(Array.from({length:30},(_,i)=>100-i))).setups,['RSI14 oversold']);
  assert.equal(scan(bars(Array.from({length:30},(_,i)=>100+i))).setups.includes('RSI14 oversold'),false);
});

test('oversold bounce needs rising close after oversold, not RSI crossing 30', () => {
  const falling=Array.from({length:29},(_,i)=>100-i);
  assert.deepEqual(scan(bars([...falling,73])).setups,['RSI14 oversold','RSI14 oversold-bounce']);
  assert.ok(scan(bars([...falling,90])).setups.includes('RSI14 oversold-bounce'));
  assert.equal(scan(bars([...falling,72])).setups.includes('RSI14 oversold-bounce'),false);
  assert.equal(scan(bars([...Array(29).fill(100),101])).setups.includes('RSI14 oversold-bounce'),false);
});

test('invalid OHLCV and ambiguous completed times fail closed without setups', () => {
  const mutations: ((c:any[])=>void)[]=[
    c=>{c[10]=null;}, c=>{c[10]={};}, c=>{c[10].c='100';},
    ...(['t','o','h','l','c','v'] as const).flatMap(key=>[NaN,Infinity,-Infinity].map(value=>(c:any[])=>{c[10][key]=value;})),
    c=>{c[10].o=0;},c=>{c[10].c=-1;},c=>{c[10].v=-1;},c=>{c[10].h=99;},c=>{c[10].l=101;},
    c=>{c[10].t=c[9].t;}, c=>{[c[10],c[11]]=[c[11],c[10]];},c=>{c[10].t=-1;},
  ];
  for(const mutate of mutations) {
    const candles=bars([...Array(29).fill(100),101]); mutate(candles);
    const row=scan(candles); assert.equal(row.status,'invalid-data'); assert.deepEqual(row.setups,[]); assert.equal(row.asOf,null);
  }
  const zeroVolume=bars();zeroVolume[10].v=0;assert.equal(scan(zeroVolume).status,'no-match');
});

for (const [label, t] of [['unsafe integer', Number.MAX_SAFE_INTEGER + 1], ['fractional future', now + tf + 0.5]] as const) {
  test(`${label} timestamps cannot bypass validation as future bars at the input limit`, () => {
    const completed=bars([...Array(249).fill(100),101]);
    assert.equal(scan(completed).status,'match');
    const row=scan([...completed,{...completed[249],t}]);
    assert.equal(row.status,'invalid-data');
    assert.deepEqual(row.setups,[]);
    assert.equal(row.asOf,null);
  });
}

test('unfinished and future bars are excluded before OHLCV validation or time-order checks', () => {
  const completed=bars([...Array(29).fill(100),101]);
  const expected=scan(completed);
  for(const t of [now-tf+1,now,now+tf]) {
    const badFuture={t,o:NaN,h:Infinity,l:-1,c:1e9,v:-1};
    assert.deepEqual(scan([...completed,badFuture]),expected);
    assert.deepEqual(scan([badFuture,...completed,badFuture]),expected);
  }
  assert.equal(scan([{t:now,o:100,h:101,l:99,c:100,v:10}]).status,'insufficient-history');
  assert.equal(expected.asOf,now);
});

test('staleness uses each last completed candle end and preserves original asOf', () => {
  const candles=bars([...Array(29).fill(100),101]);
  assert.equal(scan(candles,'crypto',tf,now+3*tf).status,'match');
  const stale=scan(candles,'crypto',tf,now+3*tf+1);
  assert.equal(stale.status,'stale');assert.equal(stale.asOf,now);assert.deepEqual(stale.setups,[]);
  assert.equal(scan(candles,'stock',tf,now+3*tf+1).status,'stale');
  const eco=ecosystem();eco.feed.candles.set('BTC',candles.map(c=>({...c,t:c.t-4*tf})));
  eco.feed.lastUpdate=Date.now();
  assert.equal(eco.snapshot().setupWatchlist.rows[0].status,'stale');
});

test('crypto missing bars fail closed but stock session gaps stay valid', () => {
  const candles=bars([...Array(29).fill(100),101]);
  candles.slice(0,15).forEach(c=>{c.t-=2*86_400_000;});
  assert.equal(scan(candles).status,'invalid-data'); assert.deepEqual(scan(candles).setups,[]);
  assert.equal(scan(candles,'stock').status,'match');
  assert.equal(scan(candles,'stock').asOf,now);
});

test('unsupported asset classes and invalid timeframes never scan histories', () => {
  for(const [asset,timeframeMs] of [['forex',tf],['index',tf],['crypto',NaN],['stock',0],['crypto',-1],['stock',Infinity],['crypto',1.5]] as const) {
    const result=setupWatchlist({setupWatchlistEnabled:true,symbols:['TEST'],assetClass:()=>asset,timeframeFor:()=>timeframeMs},
      {series:()=>{throw new Error('unsupported read');}},now);
    assert.equal(result.rows[0].status,'unsupported'); assert.deepEqual(result.rows[0].setups,[]);
  }
});

test('snapshot work is capped at first 50 configured symbols and last 250 input bars', () => {
  const history=bars(Array(10_000).fill(100));
  const protectedHistory=new Proxy(history,{get(target,key,receiver){
    if(typeof key==='string' && /^\d+$/.test(key) && Number(key)<history.length-250) throw new Error('scanned old history');
    return Reflect.get(target,key,receiver);
  }});
  let reads=0;
  const watch=setupWatchlist({setupWatchlistEnabled:true,symbols:Array.from({length:100},(_,i)=>`S${i}`),assetClass:()=> 'crypto',timeframeFor:()=>tf},
    {series:()=>{reads++;return protectedHistory;}},now);
  assert.equal(reads,50);assert.equal(watch.rows.length,50);
  assert.ok(watch.rows.every(row=>row.bars===250 && row.status==='no-match'));
});

test('Lab shows disabled help or escaped research-only watches with actual timeframe and warnings', () => {
  const eco=ecosystem(false);
  assert.match(buildingPanel('lab',eco.snapshot()).html,/SETUP_WATCHLIST_ENABLED=true/);
  eco.cfg.setupWatchlistEnabled=true;
  eco.feed.candles.set('BTC',bars([...Array(29).fill(100),101]));
  const snapshot=eco.snapshot();snapshot.setupWatchlist.rows[0].symbol='<script>bad</script>';
  const html=buildingPanel('lab',snapshot).html;
  assert.match(html,/Research-only/);assert.match(html,/not trade recommendations/);
  assert.match(html,/15 min\/bar/);assert.match(html,/20-BAR closing breakout/);
  assert.match(html,/&lt;script&gt;bad&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>bad/);
  assert.match(html,/No daily aggregation/);assert.match(html,/stale/);
});

test('strict setup opt-in defaults off and accepts only literal true/false', () => {
  for (const [value, expected] of [[undefined,false],['true',true],['false',false]] as const) {
    const env={...process.env}; delete env.SETUP_WATCHLIST_ENABLED;
    if(value !== undefined) env.SETUP_WATCHLIST_ENABLED=value;
    const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',"import {config} from './server/config.ts'; console.log(JSON.stringify(config.setupWatchlistEnabled));"],{env,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr); assert.equal(result.stdout.trim(),String(expected));
  }
  for(const value of ['yes','1','TRUE',' true ','']) {
    const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',"import './server/config.ts'"],{env:{...process.env,SETUP_WATCHLIST_ENABLED:value},encoding:'utf8'});
    assert.notEqual(result.status,0); assert.match(result.stderr,/SETUP_WATCHLIST_ENABLED/);
  }
});
