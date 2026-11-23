import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { config } from '../server/config';
import { Ecosystem } from '../server/ecosystem';

test('running snapshots expose measured artifact identity without credentials or broker claims', async () => {
  const dir = await mkdtemp(path.join(process.cwd(), '.runtime-status-'));
  const cfg: any = { ...config, execution:'paper', provider:'sim', dataDir:dir, symbols:['BTC'],
    symbolSpecs:[{symbol:'BTC',asset:'crypto'}], hasStocks:false, assetClass:()=> 'crypto',
    live:{...config.live,enabled:false,venue:null,approval:null},
    frozen:{...config.frozen,enabled:false}, llm:{...config.llm,enabled:false},
    news:{...config.news,enabled:false}, dsa:{...config.dsa,enabled:false},
    universe:{...config.universe,scanEnabled:false,scanStocks:false},
  };
  const eco: any = new Ecosystem(cfg);
  eco.feed.start = async () => { eco.feed.provider = {name:'sim'}; };
  eco.scheduleResearch = () => {};
  try {
    await eco.start();
    const runtime = eco.snapshot().runtime;
    assert.ok(runtime, 'missing runtime provenance');
    const allocation = eco.snapshot().allocationDiagnostics;
    assert.ok(allocation, 'missing allocation eligibility diagnostics');
    assert.equal(allocation.waiting, allocation.eligible + Object.values(allocation.blocked).reduce((sum: number, n: any) => sum + n, 0));
    assert.match(runtime.artifactFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(runtime.configuredMoneyMode,'paper');
    assert.equal(runtime.venue,'local');
    assert.equal(runtime.brokerVerified,false);
    const copy = {...runtime};
    runtime.artifactFingerprint = 'modified';
    assert.deepEqual(eco.snapshot().runtime,copy);
    const text = JSON.stringify(copy);
    assert.equal(text.includes('secret'),false);
    assert.equal(text.includes('apiKey'),false);
    // Admit a real research epoch without evaluating synthetic prices. Shutdown
    // must release the actual universe reservation without inventing completion.
    eco.dataset = (symbol: string) => ({symbol,lastT:Date.now()-cfg.timeframeFor(symbol)});
    eco.researchers[0].work(0);
    assert.equal(eco.universe.researchInProgress('BTC'),1);
    await eco.stop();
    assert.equal(eco.universe.researchInProgress('BTC'),0);
    assert.equal(eco.universe.epochs('BTC'),0);
  } finally {
    await eco.stop();
    await rm(dir,{recursive:true,force:true});
  }
});
