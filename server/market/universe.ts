import type { Config, SymbolSpec } from '../config';
import { logger } from '../util/log';

const log = logger('universe');

export interface ExploredEntry {
  symbol: string;
  asset: 'crypto' | 'stock';
  addedAt: number;
  /** Why the Explorer picked it, shown in the UI. */
  reason: string;
  score: number;
}

interface Stats {
  /** Latest 24h dollar volume, refreshed on every scan. */
  volumeUsd: number | null;
  /** Research epochs completed on this symbol since it joined. */
  epochs: number;
  /** Epochs started and not yet finished, so parallel researchers spread out. */
  inProgress: number;
  lastPicked: number;
}

export interface UniverseSave {
  explored: ExploredEntry[];
  volumes: Record<string, number>;
  epochs: Record<string, number>;
}

export type UniverseListener = (change: { added?: string; removed?: string }) => void;

/**
 * Which symbols the ecosystem works on. Core symbols come from SYMBOLS in .env and
 * are permanent; explored symbols are found by the Explorer and come and go.
 *
 * It also owns the per-symbol facts the rest of the system needs to stay honest on
 * small caps: trading cost, whether shorting is possible, and how big an order the
 * market can absorb.
 */
export class Universe {
  private explored = new Map<string, ExploredEntry>();
  private stats = new Map<string, Stats>();
  private listeners: UniverseListener[] = [];

  constructor(private cfg: Config) {}

  onChange(fn: UniverseListener): void {
    this.listeners.push(fn);
  }

  private emit(change: { added?: string; removed?: string }): void {
    for (const fn of this.listeners) {
      try {
        fn(change);
      } catch (err) {
        log.warn('listener failed', err);
      }
    }
  }

  private stat(symbol: string): Stats {
    let s = this.stats.get(symbol);
    if (!s) {
      s = { volumeUsd: null, epochs: 0, inProgress: 0, lastPicked: 0 };
      this.stats.set(symbol, s);
    }
    return s;
  }

  isCore(symbol: string): boolean {
    return this.cfg.isCore(symbol);
  }

  isExplored(symbol: string): boolean {
    return this.explored.has(symbol);
  }

  exploredEntries(): ExploredEntry[] {
    return [...this.explored.values()];
  }

  entry(symbol: string): ExploredEntry | undefined {
    return this.explored.get(symbol);
  }

  exploredCount(): number {
    return this.explored.size;
  }

  // --- Membership --------------------------------------------------------------

  /** Call only after the feed already holds history for the symbol. */
  add(e: ExploredEntry): boolean {
    if (this.cfg.isCore(e.symbol) || this.explored.has(e.symbol)) return false;
    this.cfg.registerSymbol({ symbol: e.symbol, asset: e.asset } satisfies SymbolSpec);
    this.explored.set(e.symbol, e);
    this.stats.set(e.symbol, { ...this.stat(e.symbol), epochs: 0, inProgress: 0, lastPicked: 0 });
    this.emit({ added: e.symbol });
    return true;
  }

  remove(symbol: string): boolean {
    if (!this.explored.delete(symbol)) return false;
    this.cfg.unregisterSymbol(symbol);
    this.stats.delete(symbol);
    this.emit({ removed: symbol });
    return true;
  }

  // --- Liquidity ---------------------------------------------------------------

  setVolume(symbol: string, volumeUsd: number): void {
    if (Number.isFinite(volumeUsd) && volumeUsd > 0) this.stat(symbol).volumeUsd = volumeUsd;
  }

  volume(symbol: string): number | null {
    return this.stats.get(symbol)?.volumeUsd ?? null;
  }

  /**
   * Round-trip-per-side slippage as a fraction. The base is the configured value
   * (fine for BTC/ETH); thinner markets pay more, because their books are shallow
   * and their spreads wide. This feeds backtests and paper fills alike, so a small
   * cap has to beat a much higher cost bar to be promoted.
   */
  slippage(symbol: string): number {
    const base = this.cfg.slippage;
    const v = this.volume(symbol);
    if (v === null) return this.cfg.isCore(symbol) ? base : base + 0.0025;
    const extraBps = v >= 500e6 ? 0 : v >= 50e6 ? 5 : v >= 10e6 ? 12 : v >= 2e6 ? 25 : 40;
    return base + extraBps / 10_000;
  }

  /** Largest single order the market can plausibly take without moving much. */
  maxNotional(symbol: string): number {
    const v = this.volume(symbol);
    if (v === null) return Infinity;
    return v * this.cfg.risk.maxVolumeParticipation;
  }

  /**
   * Shorting is only assumed to work on the core majors, which have liquid perps.
   * Borrowing a small-cap coin or a hard-to-borrow penny stock is often impossible,
   * so strategies on explored symbols are long-only.
   */
  shortable(symbol: string): boolean {
    // Alpaca cannot short crypto at all.
    if (this.cfg.execution === 'alpaca' && this.cfg.assetClass(symbol) === 'crypto') return false;
    return this.cfg.isCore(symbol);
  }

  /** Per-side fee as a fraction, matching what the execution venue really charges. */
  feeRate(symbol: string): number {
    if (this.cfg.execution !== 'alpaca') return this.cfg.feeRate;
    return this.cfg.assetClass(symbol) === 'crypto' ? this.cfg.alpacaCryptoFee : 0;
  }

  // --- Research scheduling -----------------------------------------------------

  /**
   * Picks the symbol whose turn it is: the one worked on least recently, counting
   * epochs already in flight. New arrivals have never been picked, so they go first.
   */
  pickForResearch(candidates: readonly string[], tie: number): string {
    let best = candidates[0];
    let bestKey = Infinity;
    candidates.forEach((sym, i) => {
      const s = this.stat(sym);
      const key = s.lastPicked + s.inProgress * 1e13 + ((i + tie) % candidates.length) * 1e-3;
      if (key < bestKey) {
        bestKey = key;
        best = sym;
      }
    });
    const s = this.stat(best);
    s.lastPicked = Date.now();
    s.inProgress++;
    return best;
  }

  finishResearch(symbol: string): void {
    const s = this.stats.get(symbol);
    if (!s) return;
    s.inProgress = Math.max(0, s.inProgress - 1);
    s.epochs++;
  }

  epochs(symbol: string): number {
    return this.stats.get(symbol)?.epochs ?? 0;
  }

  // --- Persistence -------------------------------------------------------------

  save(): UniverseSave {
    const volumes: Record<string, number> = {};
    const epochs: Record<string, number> = {};
    for (const [sym, s] of this.stats) {
      if (s.volumeUsd !== null) volumes[sym] = s.volumeUsd;
      epochs[sym] = s.epochs;
    }
    return { explored: this.exploredEntries(), volumes, epochs };
  }

  /** Restores facts only. Membership is re-established by `rehydrate` once the feed has data. */
  restoreFacts(saved: Partial<UniverseSave> | undefined): ExploredEntry[] {
    if (!saved) return [];
    for (const [sym, v] of Object.entries(saved.volumes ?? {})) this.setVolume(sym, Number(v));
    for (const [sym, n] of Object.entries(saved.epochs ?? {})) this.stat(sym).epochs = Number(n) || 0;
    return (saved.explored ?? []).filter((e) => e && typeof e.symbol === 'string' && (e.asset === 'crypto' || e.asset === 'stock'));
  }

  reset(): void {
    for (const sym of [...this.explored.keys()]) this.remove(sym);
    this.stats.clear();
  }
}
