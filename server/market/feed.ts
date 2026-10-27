import type { Candle } from '../../shared/types';
import { AlpacaProvider, type AlpacaClient } from '../broker/alpaca';
import type { Config } from '../config';
import { logger } from '../util/log';
import { BinanceProvider, CoinbaseProvider, SimulatedProvider, type MarketDataProvider } from './providers';

const log = logger('feed');

type TickListener = (prices: Record<string, number>) => void;
type CandleListener = (symbol: string, closed: Candle) => void;

const MIN_HISTORY = 400;

/**
 * Owns market data: a rolling window of closed candles per symbol plus the latest
 * polled price. Agents subscribe to ticks (every poll) and candle closes.
 *
 * Supports mixed asset classes: crypto can come from Binance/Coinbase (deep
 * history, 24/7) while stocks come from Alpaca. Each symbol is bound to whichever
 * provider successfully returns its history.
 */
export class MarketFeed {
  provider!: MarketDataProvider; // the primary (crypto) provider, for display
  readonly candles = new Map<string, Candle[]>();
  readonly prices = new Map<string, number>();
  lastUpdate = 0;
  consecutiveFailures = 0;

  private providerOf = new Map<string, MarketDataProvider>();
  private tickListeners: TickListener[] = [];
  private candleListeners: CandleListener[] = [];
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private stopped = false;

  constructor(
    private cfg: Config,
    private alpaca: AlpacaClient | null = null,
  ) {}

  onTick(fn: TickListener): void {
    this.tickListeners.push(fn);
  }

  onCandle(fn: CandleListener): void {
    this.candleListeners.push(fn);
  }

  price(symbol: string): number | undefined {
    return this.prices.get(symbol);
  }

  series(symbol: string): Candle[] {
    return this.candles.get(symbol) ?? [];
  }

  isStale(now = Date.now()): boolean {
    return now - this.lastUpdate > this.cfg.risk.staleDataMs;
  }

  async start(): Promise<void> {
    const cryptoSymbols = this.cfg.symbols.filter((s) => this.cfg.assetClass(s) === 'crypto');
    const stockSymbols = this.cfg.symbols.filter((s) => this.cfg.assetClass(s) === 'stock');

    if (cryptoSymbols.length) {
      const chosen = await this.bindSymbols(cryptoSymbols, this.cryptoProviders());
      this.provider = chosen;
    }
    if (stockSymbols.length) {
      if (!this.alpaca) throw new Error('stocks are configured but Alpaca keys are missing (set ALPACA_KEY_ID/ALPACA_SECRET)');
      const alp = new AlpacaProvider(this.alpaca);
      await this.bindSymbols(stockSymbols, [alp]);
      if (!this.provider) this.provider = alp;
    }
    if (!this.provider) throw new Error('no market data provider could be initialised');
    this.lastUpdate = Date.now();
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** The provider that serves crypto; the Explorer scans through it. */
  cryptoProvider(): MarketDataProvider | null {
    for (const s of this.cfg.symbols) {
      const p = this.providerOf.get(s);
      if (p && this.cfg.assetClass(s) === 'crypto') return p;
    }
    return null;
  }

  /**
   * Loads history for a symbol that is not in the startup list and starts polling it.
   * Returns a reason string on failure, null on success. Nothing is left behind on failure.
   */
  async addSymbol(symbol: string, asset: 'crypto' | 'stock', minBars: number): Promise<string | null> {
    if (this.providerOf.has(symbol)) return null;
    let p: MarketDataProvider | null;
    if (asset === 'crypto') {
      p = this.cryptoProvider() ?? this.provider ?? null;
      if (!p || p.name === 'sim') return 'no real crypto data provider';
    } else {
      if (!this.alpaca) return 'no Alpaca keys for stocks';
      p = new AlpacaProvider(this.alpaca);
    }
    // The Alpaca client routes by asset class, so the symbol must be known to the config first.
    const wasKnown = this.cfg.symbols.includes(symbol);
    if (!wasKnown) this.cfg.registerSymbol({ symbol, asset });
    try {
      const now = Date.now();
      const raw = await p.fetchHistory(symbol, this.cfg.timeframeMs, this.cfg.historyBars + 1);
      const closed = raw.filter((c) => c.t + this.cfg.timeframeMs <= now);
      if (closed.length < minBars) return `only ${closed.length} bars of history`;
      const last = closed[closed.length - 1];
      if (now - last.t > 12 * 3_600_000 && asset === 'crypto') return 'history is stale';
      if (!(raw[raw.length - 1].c > 0)) return 'no price';
      this.candles.set(symbol, closed);
      this.prices.set(symbol, raw[raw.length - 1].c);
      this.providerOf.set(symbol, p);
      log.info(`added ${symbol} (${asset}) via ${p.name}: ${closed.length} bars`);
      return null;
    } catch (err) {
      return String((err as Error).message ?? err).slice(0, 120);
    } finally {
      if (!this.providerOf.has(symbol) && !wasKnown) this.cfg.unregisterSymbol(symbol);
    }
  }

  removeSymbol(symbol: string): void {
    this.providerOf.delete(symbol);
    this.candles.delete(symbol);
    this.prices.delete(symbol);
  }

  private cryptoProviders(): MarketDataProvider[] {
    const sim = new SimulatedProvider(this.cfg.timeframeMs);
    const alp = this.alpaca ? [new AlpacaProvider(this.alpaca)] : [];
    switch (this.cfg.provider) {
      case 'binance':
        return [new BinanceProvider()];
      case 'coinbase':
        return [new CoinbaseProvider()];
      case 'alpaca':
        return this.alpaca ? [new AlpacaProvider(this.alpaca)] : [sim];
      case 'sim':
        return [sim];
      default:
        return [new BinanceProvider(), new CoinbaseProvider(), ...alp, sim];
    }
  }

  /** Try each provider for this group of symbols; the first that returns enough history wins. */
  private async bindSymbols(symbols: string[], candidates: MarketDataProvider[]): Promise<MarketDataProvider> {
    let lastErr: unknown;
    for (const p of candidates) {
      try {
        log.info(`trying provider ${p.name} for ${symbols.join(', ')}`);
        await this.loadHistory(p, symbols);
        for (const s of symbols) this.providerOf.set(s, p);
        log.info(`provider ${p.name}: ${symbols.map((s) => `${s}=${this.series(s).length} bars`).join(', ')}`);
        return p;
      } catch (err) {
        lastErr = err;
        log.warn(`provider ${p.name} failed for ${symbols.join(', ')}`, err);
        for (const s of symbols) {
          this.candles.delete(s);
          this.prices.delete(s);
        }
      }
    }
    throw new Error(`no provider could load ${symbols.join(', ')}: ${String(lastErr).slice(0, 160)}`);
  }

  private async loadHistory(p: MarketDataProvider, symbols: string[]): Promise<void> {
    const now = Date.now();
    for (const symbol of symbols) {
      const raw = await p.fetchHistory(symbol, this.cfg.timeframeMs, this.cfg.historyBars + 1);
      const closed = raw.filter((c) => c.t + this.cfg.timeframeMs <= now);
      if (closed.length < MIN_HISTORY) {
        throw new Error(`${symbol}: only ${closed.length} candles of history, need at least ${MIN_HISTORY}`);
      }
      this.candles.set(symbol, closed);
      this.prices.set(symbol, raw[raw.length - 1].c);
    }
    const prices = await p.fetchPrices(symbols);
    for (const [s, px] of Object.entries(prices)) this.prices.set(s, px);
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.poll(), delay);
  }

  private byProvider(): Map<MarketDataProvider, string[]> {
    const groups = new Map<MarketDataProvider, string[]>();
    for (const s of this.cfg.symbols) {
      const p = this.providerOf.get(s);
      if (!p) continue;
      const list = groups.get(p);
      if (list) list.push(s);
      else groups.set(p, [s]);
    }
    return groups;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const prices: Record<string, number> = {};
      // Prices per provider. One provider failing (e.g. stocks closed) must not
      // starve the others, so failures are tolerated and the rest still update.
      await Promise.all(
        [...this.byProvider()].map(async ([p, symbols]) => {
          try {
            const got = await p.fetchPrices(symbols);
            Object.assign(prices, got);
          } catch (err) {
            log.debug(`price poll via ${p.name} failed`, err);
          }
        }),
      );
      if (Object.keys(prices).length === 0) throw new Error('all price providers failed');
      for (const [s, px] of Object.entries(prices)) this.prices.set(s, px);
      this.lastUpdate = Date.now();
      this.consecutiveFailures = 0;
      this.emitTick(prices);
      await this.syncCandles();
    } catch (err) {
      this.consecutiveFailures++;
      const level = this.consecutiveFailures > 3 ? 'warn' : 'debug';
      log[level](`poll failed (${this.consecutiveFailures} in a row)`, err);
    } finally {
      this.polling = false;
      const backoff = Math.min(60_000, this.cfg.pollMs * Math.max(1, this.consecutiveFailures));
      this.schedule(backoff);
    }
  }

  private async syncCandles(): Promise<void> {
    const now = Date.now();
    const tf = this.cfg.timeframeMs;
    for (const symbol of this.cfg.symbols) {
      const series = this.candles.get(symbol);
      const p = this.providerOf.get(symbol);
      if (!series || series.length === 0 || !p) continue;
      const last = series[series.length - 1];
      // The bar after `last` closes at last.t + 2*tf. Nothing new before that.
      if (now < last.t + 2 * tf + 2_000) continue;
      const missing = Math.min(300, Math.ceil((now - last.t) / tf) + 2);
      let recent: Candle[];
      try {
        recent = await p.fetchRecent(symbol, tf, missing);
      } catch (err) {
        log.debug(`candle sync for ${symbol} failed`, err);
        continue;
      }
      const fresh = recent.filter((c) => c.t > last.t && c.t + tf <= now).sort((a, b) => a.t - b.t);
      for (const c of fresh) {
        series.push(c);
        this.emitCandle(symbol, c);
      }
      const cap = this.cfg.historyBars + 500;
      if (series.length > cap) series.splice(0, series.length - cap);
    }
  }

  private emitTick(prices: Record<string, number>): void {
    for (const fn of this.tickListeners) {
      try {
        fn(prices);
      } catch (err) {
        log.error('tick listener failed', err);
      }
    }
  }

  private emitCandle(symbol: string, c: Candle): void {
    for (const fn of this.candleListeners) {
      try {
        fn(symbol, c);
      } catch (err) {
        log.error('candle listener failed', err);
      }
    }
  }
}
