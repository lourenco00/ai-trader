import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import type { Config } from '../config';
import type { Ecosystem } from '../ecosystem';
import { STAFF } from '../roster';
import { readJson } from '../util/persist';

/** Existence, not JSON truthiness, is the enrollment boundary after a crash. */
export async function hasFrozenEnrollment(dir: string): Promise<boolean> {
  for (const name of ['frozen-enrollment.json', 'frozen-manifest.json']) {
    try { await lstat(path.join(dir, name)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return false;
}

export function validateFrozenConfig(c: Config): void {
  if (!c.frozen?.enabled) return;
  const f = c.frozen;
  const resolved = (p: string): string => { try { return realpathSync(p); } catch { return path.resolve(p); } };
  if (!f.dataDir || !path.isAbsolute(f.dataDir) || resolved(f.dataDir) === resolved(c.dataDir)) {
    throw new Error('frozen requires an explicit dedicated absolute FROZEN_DATA_DIR distinct from DATA_DIR');
  }
  if (!f.strategyIds.length || new Set(f.strategyIds).size !== f.strategyIds.length || f.strategyIds.some(id => !/^[A-Za-z0-9_-]+$/.test(id))) {
    throw new Error('frozen requires unique existing selected strategy IDs');
  }
  if (!Number.isSafeInteger(f.endAt) || f.endAt <= 0 || !f.criteria.trim()) {
    throw new Error('frozen requires a finite predeclared end time and nonempty criteria');
  }
}

export interface FrozenManifest {
  version: 1;
  fingerprint: string;
  startedAt: number;
  endAt: number;
  criteria: string;
  definition: ReturnType<typeof definition>;
  startingEvidence: unknown;
}

/** Sorted object keys, ordered arrays, no credentials or runtime-only functions. */
export function fingerprint(value: unknown): string {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
/** Content identity works in a source export with no git metadata. */
export async function sourceIdentity(root = fileURLToPath(new URL('../../', import.meta.url))): Promise<string> {
  const files = ['package.json', 'package-lock.json', 'tsconfig.server.json'];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      const name = `${dir}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`frozen artifact contains unsupported symlink: ${name}`);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) files.push(name);
      else throw new Error(`frozen artifact contains unsupported file: ${name}`);
    }
  };
  await walk('server'); await walk('shared');
  const hashes: [string,string][] = [];
  for (const name of files.sort()) hashes.push([name, createHash('sha256').update(await readFile(path.join(root, name))).digest('hex')]);
  return fingerprint({ files: hashes, node: process.version, platform: process.platform, arch: process.arch });
}

function definition(eco: Ecosystem, artifact: string) {
  const c = eco.cfg;
  return {
    artifact,
    strategies: eco.traders.filter(t => t.strategy).map(t => ({ id: t.strategy!.id, traderId: t.id,
      symbol: t.strategy!.symbol, genome: t.strategy!.genome, trial: !!t.strategy!.trial,
      origin: t.strategy!.origin, units: t.wallet.units,
      evidence: { train: t.strategy!.train, test: t.strategy!.test, fitness: t.strategy!.fitness, createdAt: t.strategy!.createdAt,
        author: t.strategy!.author, authorId: t.strategy!.authorId } })).sort((a,b) => a.id.localeCompare(b.id)),
    universe: c.symbols.map(symbol => ({ symbol, asset: c.assetClass(symbol), core: c.isCore(symbol), timeframeMs: c.timeframeFor(symbol) })).sort((a,b) => a.symbol.localeCompare(b.symbol)),
    costs: c.symbols.map(symbol => ({ symbol, feeRate: eco.universe.feeRate(symbol), slippage: eco.universe.slippage(symbol), volume: eco.universe.volume(symbol) })).sort((a,b) => a.symbol.localeCompare(b.symbol)),
    controls: { risk: c.risk, allocation: c.allocation, retirement: c.retirement, startingCapital: c.startingCapital,
      traders: c.traders, historyBars: c.historyBars, provider: c.provider, pollMs: c.pollMs, flattenBeforeCloseMin: c.flattenBeforeCloseMin,
      feeRate: c.feeRate, slippage: c.slippage, limitOrders: c.limitOrders, research: c.research },
  };
}
export async function freeze(eco: Ecosystem, saved: any): Promise<FrozenManifest> {
  if (!saved || saved.version !== 1) throw new Error('frozen requires an existing seeded state');
  const risk = saved.agents?.find((a: any) => a.id === STAFF.risk.id)?.extra;
  if (saved.executionMode !== 'paper' || saved.brokerOffset || risk?.pending?.length ||
    saved.agents.some((a: any) => a.extra?.executionIntent) || eco.traders.some(t => t.orderPending)) {
    throw new Error('frozen requires local paper state with no unresolved execution intents/reservations');
  }
  const assignedTraders = eco.traders.filter(t => t.strategy);
  if (eco.vault.byStatus('active').length !== assignedTraders.length || assignedTraders.some(t => t.strategy!.traderId !== t.id) ||
    eco.traders.some(t => t.wallet.position && (!t.strategy || t.wallet.position.strategyId !== t.strategy.id ||
      t.wallet.position.symbol !== t.strategy.symbol || t.wallet.position.side !== t.strategy.genome.side))) {
    throw new Error('frozen restored ownership/position does not match a known local-paper assignment');
  }
  const file = path.join(eco.cfg.dataDir, 'frozen-manifest.json');
  const sealFile = path.join(eco.cfg.dataDir, 'frozen-enrollment.json');
  const existing = await readJson<FrozenManifest>(file);
  const seal = await readJson<{ fingerprint: string }>(sealFile);
  if ((!existing || !seal) && await hasFrozenEnrollment(eco.cfg.dataDir)) {
    throw new Error('frozen enrollment is incomplete/corrupt; never refreeze or activate normally');
  }
  const artifact = await sourceIdentity();
  if (existing) {
    const { fingerprint: hash, ...payload } = existing;
    if (existing.version !== 1 || fingerprint(payload) !== hash || seal?.fingerprint !== hash || saved.frozenFingerprint !== hash) {
      throw new Error('frozen manifest integrity/checkpoint mismatch; never refreeze');
    }
    const restored = definition(eco, artifact);
    // Retirement is a one-way safety transition, not a replacement/refreeze.
    // Retired genomes remain in the vault and must still match their frozen identity.
    for (const original of existing.definition.strategies) {
      const record = eco.vault.get(original.id);
      if (record?.status !== 'retired') continue;
      const trader = eco.traders.find(t => t.id === original.traderId);
      if (!trader || trader.strategy || trader.wallet.position || trader.executionIntent || trader.wallet.units !== 0 || record.traderId !== null) {
        throw new Error('frozen retired assignment has unexpected holdings or owner');
      }
      restored.strategies.push({ id: record.id, traderId: original.traderId, symbol: record.symbol, genome: record.genome,
        trial: !!record.trial, origin: record.origin, units: original.units,
        evidence: { train: record.train, test: record.test, fitness: record.fitness, createdAt: record.createdAt, author: record.author, authorId: record.authorId } });
    }
    restored.strategies.sort((a,b) => a.id.localeCompare(b.id));
    if (existing.endAt !== eco.cfg.frozen.endAt || existing.criteria !== eco.cfg.frozen.criteria ||
      fingerprint(existing.definition) !== fingerprint(restored) ||
      fingerprint(existing.definition.strategies.map(s => s.id).sort()) !== fingerprint([...eco.cfg.frozen.strategyIds].sort())) {
      throw new Error('frozen restored assignments/config mismatch; never refreeze');
    }
    return existing;
  }
  if (seal || saved.frozenFingerprint) throw new Error('frozen manifest missing for enrolled experiment; never refreeze');
  if (risk?.reconciliation) {
    throw new Error('frozen seed must be local paper with no venue observations or pending reservations');
  }
  if (saved.agents.some((a: any) => a.extra?.wallet?.position || a.extra?.executionIntent) || eco.traders.some(t => t.orderPending || t.exitOnly || t.retiringReason)) {
    throw new Error('frozen initial enrollment requires flat wallets and no pending/retiring execution');
  }
  const selected = [...eco.cfg.frozen.strategyIds].sort();
  const assigned = eco.traders.filter(t => t.strategy);
  if (fingerprint(assigned.map(t => t.strategy!.id).sort()) !== fingerprint(selected) ||
    assigned.some(t => t.strategy!.trial || t.strategy!.traderId !== t.id || !eco.cfg.symbols.includes(t.strategy!.symbol) || !(t.wallet.cash > 0) || !(t.wallet.units > 0)) ||
    eco.vault.byStatus('active').length !== assigned.length) {
    throw new Error('frozen requires exactly the selected eligible nontrial existing assignments and funded wallets');
  }
  if (eco.cfg.frozen.endAt <= Date.now()) throw new Error('frozen initial end time must be in the future');
  const current = definition(eco, artifact);
  const startedAt = Date.now();
  const payload = { version: 1 as const, startedAt, endAt: eco.cfg.frozen.endAt, criteria: eco.cfg.frozen.criteria,
    definition: current, startingEvidence: { savedAt: saved.savedAt, fund: saved.fund, agents: saved.agents, strategies: saved.strategies, equity: saved.equity, trades: saved.trades } };
  const manifest: FrozenManifest = { ...payload, fingerprint: fingerprint(payload) };
  await writeFile(sealFile, JSON.stringify({ fingerprint: manifest.fingerprint }), { flag: 'wx', mode: 0o444 });
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
  return manifest;
}
