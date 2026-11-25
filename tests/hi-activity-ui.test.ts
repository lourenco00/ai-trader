import test from 'node:test';
import assert from 'node:assert/strict';
import { buildingPanel } from '../web/src/ui/panels';
import { activityPanel } from '../web/src/ui/activity';

const now = Date.parse('2026-11-24T16:00:00Z');
function snapshot(name = 'High-Activity Fund'): any {
  return {runtime:name === 'High-Activity Fund' ? {experiment:'hi-intraday-v1'} : undefined,serverTime:now,seasonStartedAt:now-30*60_000,
    fund:{startingCapital:100000,equity:100000,peakEquity:100000,realizedPnl:0,fees:0,trades:0,winRate:0,profitFactor:0},
    traders:[],trades:[],equity:[]};
}

function trade(id: string, symbol: string, heldMinutes: number): any {
  return {id,symbol,traderName:'Test',strategyName:'Test',side:'long',entryPrice:100,exitPrice:101,pnl:1,pnlPct:0.01,fees:0,
    entryTime:now-(heldMinutes+10)*60_000,exitTime:now-10*60_000,reason:'max hold'};
}

test('mature experiment measures calendar-day frequency and explicitly bounded recent trade coverage', () => {
  const s=snapshot(); s.seasonStartedAt=now-2*86_400_000; s.fund.trades=24;
  s.trades=[trade('a','BTC',30),trade('b','NVDA',60)];
  const html=buildingPanel('bank',s).html;
  assert.ok(html.includes(`${(24/2).toFixed(2)} per calendar day`));
  assert.match(html,/latest 2 of 24 recorded exits/);
  assert.match(html,/2 distinct symbols/);
  assert.ok(html.includes(`${((30+60)/2).toFixed(1)} min`));
  assert.doesNotMatch(html,/Accumulating 24h/);
});

test('partial entry telemetry stays unknown rather than manufacturing zero decisions', () => {
  const s=snapshot();
  s.traders=[{entryDiagnostics:{counts:{'no-signal':10,'risk-rejected':2,'submission-attempted':3,'entry-filled':1}}},{}];
  let html=buildingPanel('bank',s).html;
  assert.match(html,/Telemetry coverage: 1\/2 traders/);
  assert.match(html,/No-signal checks: unavailable/);
  assert.match(html,/Submission attempts: unavailable/);
  s.traders[1]={entryDiagnostics:{counts:{'no-signal':4,'entry-filled':1}}};
  html=buildingPanel('bank',s).html;
  assert.ok(html.includes(`No-signal checks: ${10+4}`));
  assert.ok(html.includes(`Booked entries: ${1+1}`));
  assert.match(html,/not unique candles or independently verified fills/);
});

test('invalid or duplicate trade samples never become trustworthy hold/diversity statistics', () => {
  const s=snapshot(); s.seasonStartedAt=now-2*86_400_000; s.fund.trades=24;
  const good=trade('a','BTC',30);
  for (const bad of [{...good,id:'b',exitTime:now+1},{...good,id:'b',entryTime:now},good]) {
    s.trades=[good,bad];
    const html=activityPanel(s);
    assert.match(html,/Recent sample: unavailable/);
    assert.match(html,/Mean entry-to-exit interval: unavailable/);
    assert.doesNotMatch(html,/2 distinct symbols/);
  }
  s.seasonStartedAt=now+1;
  assert.match(activityPanel(s),/Exit-record frequency: unavailable/);
});

test('calendar frequency starts at exactly 24 hours, not one millisecond earlier', () => {
  const s=snapshot(); s.fund.trades=24; s.seasonStartedAt=now-86_400_000+1;
  assert.match(activityPanel(s),/Accumulating 24h/);
  s.seasonStartedAt=now-86_400_000;
  assert.ok(activityPanel(s).includes(`${(24/1).toFixed(2)} per calendar day`));
});

test('distinct-ID partial exits sharing an entry retain their own exit-record intervals', () => {
  const s=snapshot(); s.seasonStartedAt=now-2*86_400_000; s.fund.trades=2;
  const entry=now-120*60_000;
  s.trades=[{...trade('first','BTC',30),entryTime:entry,exitTime:entry+30*60_000},
    {...trade('second','BTC',60),entryTime:entry,exitTime:entry+60*60_000}];
  const html=activityPanel(s);
  assert.match(html,/latest 2 of 2 recorded exits; 1 distinct symbols/);
  assert.ok(html.includes(`${((30+60)/2).toFixed(1)} min`));
  assert.match(html,/partial exits, not only completed round trips/);
});

test('hostile symbols are not rendered and an unknown experiment never gets the card', () => {
  const s=snapshot(); s.seasonStartedAt=now-2*86_400_000; s.fund.trades=1;
  s.trades=[trade('bad','<img src=x onerror=alert(1)>',30)];
  const html=activityPanel(s);
  assert.match(html,/Recent sample: unavailable/);
  assert.doesNotMatch(html,/<img/);
  s.runtime.experiment='unknown-experiment';
  assert.equal(activityPanel(s),'');
});

test('invalid numeric decision counters stay unavailable rather than being coerced', () => {
  const s=snapshot();
  for (const n of [-1,NaN,Infinity,'0',null,Number.MAX_SAFE_INTEGER+1]) {
    s.traders=[{entryDiagnostics:{counts:{'no-signal':n}}}];
    const html=activityPanel(s);
    assert.match(html,/Telemetry coverage: 0\/1 traders/);
    assert.match(html,/No-signal checks: unavailable/);
  }
});

test('High-Activity Treasury exposes observations, not projected first-hour trade quotas; other funds unchanged', () => {
  const s = snapshot();
  const original = structuredClone(s);
  const html = buildingPanel('bank',s).html;
  assert.match(buildingPanel('bank',s).sub,/data-hi-intraday\/trades.jsonl/);
  assert.match(html,/Trading activity/);
  assert.match(html,/Accumulating 24h/);
  assert.match(html,/not a trade quota/);
  assert.doesNotMatch(buildingPanel('bank',snapshot('Main Fund')).html,/Trading activity/);
  assert.deepEqual(s,original);
});
