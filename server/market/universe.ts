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
  private looks = new Map<string, number[]>();

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
    if (this.cfg.execution !== 'paper' && this.cfg.assetClass(symbol) === 'crypto') return false;
    return this.cfg.isCore(symbol);
  }

  /**
   * Bars per year for annualising Sharpe. Crypto trades around the clock; a US stock has
   * only the 6.5h session on weekdays, so using the crypto figure would inflate its Sharpe ~2.3x.
   */
  barsPerYear(symbol: string): number {
    if (this.cfg.assetClass(symbol) === 'crypto') return (365 * 24 * 3_600_000) / this.cfg.timeframeFor(symbol);
    // Slower than the 6.5h session means one bar a day.
    const perDay = Math.max(1, (6.5 * 3_600_000) / this.cfg.timeframeFor(symbol));
    return perDay * 252;
  }

  /**
   * The promotion gate for this market. The trade-count requirements are set for 15-minute candles; a slower
   * market has proportionally fewer bars and so fewer trades, so they scale down with the candle size, but never
   * below the standard minimums (30 train, 6 holdout, 2 per half). Every quality test is unchanged.
   */
  promotion(symbol: string): Config['research']['promotion'] {
    const base = this.cfg.research.promotion;
    const factor = Math.min(1, 900_000 / this.cfg.timeframeFor(symbol));
    const scale = (v: number, floor: number) => Math.max(floor, Math.round(v * factor));
    return {
      ...base,
      minTrainTrades: scale(base.minTrainTrades, 30),
      minTestTrades: scale(base.minTestTrades, 6),
      minHalfTrades: scale(base.minHalfTrades, 2),
    };
  }

  /** Per-side fee as a fraction, matching what the execution venue really charges. */
  feeRate(symbol: string): number {
    if (this.cfg.execution === 'okx') {
      const { makerFee, takerFee } = this.cfg.okx;
      return this.cfg.limitOrders ? (makerFee + takerFee) / 2 + 0.0002 : takerFee;
    }
    if (this.cfg.execution === 'paper') return this.cfg.assetClass(symbol) === 'stock' ? 0 : this.cfg.feeRate;
    if (this.cfg.execution !== 'alpaca') return this.cfg.feeRate;
    if (this.cfg.assetClass(symbol) !== 'crypto') return 0;
    // Entries and calm exits go out as limit orders when they can; stops always pay the taker fee.
    return this.cfg.limitOrders ? (this.cfg.alpacaCryptoFee + this.cfg.alpacaCryptoMakerFee) / 2 + 0.0002 : this.cfg.alpacaCryptoFee;
  }

  /**
   * Records one more strategy being judged on a market's holdout and returns how many were judged in
   * the last 7 days. Testing many strategies and keeping the best guarantees some look good by luck,
   * so the promotion gate raises its bar with this count.
   */
  noteLook(symbol: string): number {
    const now = Date.now();
    const list = (this.looks.get(symbol) ?? []).filter((t) => now - t < 7 * 86_400_000);
    list.push(now);
    this.looks.set(symbol, list);
    return list.length;
  }

  // --- Research scheduling -----------------------------------------------------

  /**
   * Picks the symbol whose turn it is: the one worked on least recently, counting
   * epochs already in flight. New arrivals have never been picked, so they go first.
   */
  pickForResearch(all: readonly string[], tie: number): string {
    // Lean towards crypto: it trades 24/7 and is the focus. Stocks get the remaining epochs.
    const crypto = all.filter((s) => this.cfg.assetClass(s) === 'crypto');
    const stocks = all.filter((s) => this.cfg.assetClass(s) === 'stock');
    const wantCrypto = stocks.length === 0 || (crypto.length > 0 && Math.random() < this.cfg.universe.cryptoFocus);
    const candidates = wantCrypto ? crypto : stocks;
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
