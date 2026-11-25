import path from 'node:path';
import { lstat, mkdir, open, readFile, readdir } from 'node:fs/promises';
import type { Config } from '../config';
import { NEWS_ANCHORS, RESEARCHERS, STAFF, TRADERS } from '../roster';
import { conformsIntraday, HI_INTRADAY_ID, HI_STOCKS, HI_CRYPTO } from './hi-intraday';
import { hasFrozenEnrollment } from '../validation/frozen';
import { StrategyVault, type StrategyRecord } from '../strategy/vault';

/** Profile-only admission boundary; the ordinary vault and frozen cohorts are unchanged. */
export class IntradayVault extends StrategyVault {
  constructor(private cfg: Config) {super(cfg.research.vaultCapacity);}
  override add(record: StrategyRecord): boolean {
    return conformsIntraday(this.cfg,record.symbol,record.genome) && super.add(record);
  }
  override restore(records: StrategyRecord[]): void {
    if (records.some(r=>!conformsIntraday(this.cfg,r.symbol,r.genome))) throw new Error('intraday restore refuses nonconforming approved genomes');
    super.restore(records);
  }
  override assign(id: string, traderId: string): void {
    const r=this.get(id);
    if (r && !conformsIntraday(this.cfg,r.symbol,r.genome)) throw new Error('intraday assignment refuses nonconforming approved genome');
    super.assign(id,traderId);
  }
}

const MARKER = 'hi-intraday.json';
const identity = JSON.stringify({identity:HI_INTRADAY_ID});

/** Fail before client construction if the explicit experiment has contradictory controls. */
export function validateIntradayConfig(cfg: Config): void {
  if (!cfg.intraday) return;
  const symbols=[...HI_STOCKS,...HI_CRYPTO];
  if (path.basename(path.resolve(cfg.dataDir)) !== 'data-hi-intraday' || cfg.execution !== 'paper' ||
      cfg.live.enabled || cfg.live.venue || cfg.live.approval || cfg.frozen?.enabled || cfg.llm.enabled || cfg.news.enabled || cfg.dsa.enabled ||
      cfg.universe.scanEnabled || cfg.universe.scanStocks || cfg.flattenBeforeCloseMin !== 0 ||
      cfg.risk.leverage !== 1 || cfg.risk.maxGrossExposure !== 1 ||
      cfg.symbols.length !== symbols.length || symbols.some(s=>!cfg.symbols.includes(s)) ||
      symbols.some(s=>cfg.assetClass(s)!==((HI_STOCKS as readonly string[]).includes(s)?'stock':'crypto') || cfg.timeframeFor(s)!==((HI_STOCKS as readonly string[]).includes(s)?300_000:900_000))) {
    throw new Error('intraday experiment requires isolated data-hi-intraday, fixed liquid universe/timeframes and conservative local-paper-only controls');
  }
}

async function exists(file: string): Promise<boolean> {
  try {await lstat(file);return true;} catch(error) {if ((error as NodeJS.ErrnoException).code==='ENOENT') return false;throw error;}
}

function isRecord(value: unknown): value is Record<string,unknown> {
  return value !== null && typeof value==='object' && !Array.isArray(value);
}

function validTimestamp(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number)>=0 && (value as number)<=8_640_000_000_000_000;
}

/** Enrolled risk authority must not pass through generic restore's coercions/defaults. */
function validateRisk(cfg: Config, extra: Record<string,unknown>, custodyIds: Set<string>): void {
  if (!['halted','dailyReviewRequired','reconciliationReviewRequired'].every(k=>typeof extra[k]==='boolean') ||
      (extra.haltReason!==null && typeof extra.haltReason!=='string') ||
      (extra.cooldownUntil!==null && !validTimestamp(extra.cooldownUntil)) ||
      !Number.isSafeInteger(extra.blocked) || (extra.blocked as number)<0) {
    throw new Error('intraday checkpoint contains malformed risk pause authority');
  }
  if (!Array.isArray(extra.pending)) throw new Error('intraday checkpoint is missing valid pending risk custody');
  const pendingIds=new Set<string>();
  const traderIds=new Set(TRADERS.map(a=>a.id));
  for (const p of extra.pending) {
    if (!isRecord(p) || typeof p.traderId!=='string' || !traderIds.has(p.traderId) || !custodyIds.has(p.traderId) || pendingIds.has(p.traderId) ||
        typeof p.symbol!=='string' || !cfg.symbols.includes(p.symbol) || (p.side!=='long' && p.side!=='short') ||
        !['notional','stopRisk'].every(k=>Number.isFinite(p[k]) && (p[k] as number)>0) || typeof p.unproven!=='boolean') {
      throw new Error('intraday checkpoint contains malformed or duplicate pending risk custody');
    }
    pendingIds.add(p.traderId);
  }
  const r=extra.reconciliation;
  if (r!==null && (!isRecord(r) || !validTimestamp(r.at) || typeof r.ok!=='boolean' ||
      !Array.isArray(r.issues) || !r.issues.every(issue=>typeof issue==='string') ||
      ![r.broker,r.ledger].every(rows=>Array.isArray(rows) && rows.every(row=>isRecord(row) &&
        typeof row.symbol==='string' && row.symbol.length>0 && Number.isFinite(row.qty))) ||
      ('equityGap' in r && !Number.isFinite(r.equityGap)))) {
    throw new Error('intraday checkpoint contains malformed risk reconciliation diagnostics');
  }
}

/** Match Trader's persisted Wallet/Position, rather than its permissive restore fallback. */
function validateWallet(cfg: Config, wallet: unknown): void {
  if (!isRecord(wallet) || !Number.isFinite(wallet.cash) || !Number.isFinite(wallet.units) || (wallet.units as number)<0) {
    throw new Error('intraday checkpoint contains a malformed wallet');
  }
  // Negative cash can represent a legitimate short loss. A flat zero-unit wallet is valid.
  if (wallet.position===null) return;
  const p=wallet.position;
  if (!isRecord(p) || typeof p.symbol!=='string' || !cfg.symbols.includes(p.symbol) ||
      (p.side!=='long' && p.side!=='short') ||
      !['qty','entryPrice','extreme'].every(k=>Number.isFinite(p[k]) && (p[k] as number)>0) ||
      !Number.isSafeInteger(p.entryTime) || (p.entryTime as number)<0 ||
      !Number.isFinite(p.entryFee) || (p.entryFee as number)<0 ||
      !Number.isFinite(p.stop) || (p.takeProfit!==null && !Number.isFinite(p.takeProfit)) ||
      !Number.isSafeInteger(p.barsHeld) || (p.barsHeld as number)<0 ||
      typeof p.strategyId!=='string' || !p.strategyId.length ||
      ('partialPnl' in p && !Number.isFinite(p.partialPnl))) {
    throw new Error('intraday checkpoint contains a malformed or unconfigured position');
  }
  // Stops/targets are arithmetic ATR thresholds: unlike fill prices, they can cross zero.
}

/** Existence is enrollment, including corrupt/null markers. Never migrate or reset legacy state. */
export async function prepareIntradayDirectory(cfg: Config): Promise<void> {
  const marker=path.join(cfg.dataDir,MARKER);
  if (!cfg.intraday) {
    if (await exists(marker)) throw new Error('intraday enrolled directory cannot activate as an ordinary fund');
    return;
  }
  validateIntradayConfig(cfg);
  await mkdir(cfg.dataDir,{recursive:true});
  if ((await lstat(cfg.dataDir)).isSymbolicLink()) throw new Error('intraday directory must not be a symbolic link');
  if (await hasFrozenEnrollment(cfg.dataDir)) throw new Error('intraday directory cannot contain frozen enrollment');
  const names=await readdir(cfg.dataDir);
  if (!names.includes(MARKER)) {
    if (names.length) throw new Error('intraday directory is not empty: refuse legacy/mixed state, no automatic migration');
    const handle=await open(marker,'wx');
    try {await handle.writeFile(identity);await handle.sync();} finally {await handle.close();}
  } else {
    if ((await lstat(marker)).isSymbolicLink()) throw new Error('intraday marker must not be a symbolic link');
    let markerValue: unknown;
    try {markerValue=JSON.parse(await readFile(marker,'utf8'));} catch {throw new Error('intraday marker is corrupt');}
    if (JSON.stringify(markerValue)!==identity) throw new Error('intraday marker identity mismatch');
  }
  const stateFile=path.join(cfg.dataDir,'state.json');
  if (!await exists(stateFile)) {
    if (names.some(n=>n!==MARKER)) throw new Error('intraday checkpoint is missing; refuse a new season over existing evidence');
    return;
  }
  if ((await lstat(stateFile)).isSymbolicLink()) throw new Error('intraday checkpoint must not be a symbolic link');
  let saved: any;
  try {saved=JSON.parse(await readFile(stateFile,'utf8'));} catch {throw new Error('intraday checkpoint is corrupt');}
  if (!saved || saved.version!==1 || saved.intradayIdentity!==HI_INTRADAY_ID || saved.executionMode!=='paper' || saved.frozenFingerprint ||
      !Array.isArray(saved.strategies) || !Array.isArray(saved.agents) || (saved.universe?.explored?.length ?? 0)!==0) {
    throw new Error('intraday checkpoint custody/identity mismatch or mixed explored universe');
  }
  for (const s of saved.strategies) {
    if (!s || !s.genome || !conformsIntraday(cfg,s.symbol,s.genome)) throw new Error('intraday checkpoint contains a nonconforming strategy; never repair promoted genomes');
  }
  const ids=new Set<string>();
  const traderIds=new Set(TRADERS.map(a=>a.id));
  const knownIds=new Set([...TRADERS,...RESEARCHERS,...NEWS_ANCHORS,...Object.values(STAFF)].map(a=>a.id));
  for (const a of saved.agents) {
    if (!a || typeof a.id!=='string' || !knownIds.has(a.id) || ids.has(a.id)) throw new Error('intraday checkpoint contains invalid or duplicate agent identities');
    ids.add(a.id);
    if ((traderIds.has(a.id) || a.id===STAFF.risk.id) && !isRecord(a.extra)) throw new Error('intraday checkpoint is missing agent custody');
    if (traderIds.has(a.id)) {
      validateWallet(cfg,a.extra.wallet);
    } else if (a.extra && ('wallet' in Object(a.extra) || 'executionIntent' in Object(a.extra))) {
      throw new Error('intraday checkpoint custody belongs to a non-trader identity');
    }
  }
  if ([STAFF.risk,...TRADERS.slice(0,cfg.traders)].some(a=>!ids.has(a.id))) throw new Error('intraday checkpoint is missing a custody-bearing agent');
  validateRisk(cfg,saved.agents.find((a:any)=>a.id===STAFF.risk.id).extra,ids);
}
