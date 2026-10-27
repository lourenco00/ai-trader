import type { Appearance, Candle } from '../../shared/types';
import type { AlpacaClient } from '../broker/alpaca';
import { BinanceProvider } from '../market/providers';
import { logger } from '../util/log';
import { Agent } from './base';
import type { EcoContext } from './context';

const log = logger('explorer');

interface Candidate {
  symbol: string;
  asset: 'crypto' | 'stock';
  score: number;
  reason: string;
  volumeUsd: number;
}

// Not interesting to trade: stablecoins, fiat pairs, wrapped or staked copies of a bigger coin.
const SKIP_BASES = new Set([
  'USDC', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'BUSD', 'USDE', 'USD1', 'PYUSD', 'EUR', 'EURI', 'AEUR', 'GBP', 'TRY', 'BRL',
  'ARS', 'MXN', 'UAH', 'COP', 'CZK', 'PLN', 'RON', 'WBTC', 'WBETH', 'BETH', 'WBNB', 'XUSD', 'USDS', 'USDT', 'BFUSD',
]);

async function fetchCaps(): Promise<Map<string, { cap: number; rank: number }>> {
  const out = new Map<string, { cap: number; rank: number }>();
  for (let page = 1; page <= 4; page++) {
    const res = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}`, {
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`coingecko HTTP ${res.status}`);
    const rows = (await res.json()) as { symbol?: string; market_cap?: number; market_cap_rank?: number }[];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      const sym = String(r.symbol ?? '').toUpperCase();
      // Several coins share a ticker; the listing is sorted by cap, so the first one is the real one.
      if (sym && !out.has(sym) && r.market_cap && r.market_cap_rank) out.set(sym, { cap: r.market_cap, rank: r.market_cap_rank });
    }
    await sleep(2500);
  }
  return out;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function fmtUsd(x: number): string {
  if (x >= 1e9) return `$${(x / 1e9).toFixed(1)}B`;
  if (x >= 1e6) return `$${(x / 1e6).toFixed(1)}M`;
  return `$${(x / 1e3).toFixed(0)}K`;
}

/** What the last week of hourly candles says about how alive a coin is. */
export function analyzeHourly(c: Candle[]): { surge: number; week: number; annVol: number } | null {
  const n = c.length;
  if (n < 120) return null;
  const recent = c.slice(-24).map((x) => x.v);
  const base = c.slice(-192, -24).map((x) => x.v);
  const baseMean = mean(base);
  const surge = baseMean > 0 ? mean(recent) / baseMean : 1;
  const week = c[n - 1].c / c[Math.max(0, n - 169)].c - 1;
  const rets: number[] = [];
  for (let i = 1; i < n; i++) if (c[i - 1].c > 0 && c[i].c > 0) rets.push(Math.log(c[i].c / c[i - 1].c));
  const m = mean(rets);
  const sd = Math.sqrt(mean(rets.map((r) => (r - m) ** 2)));
  return { surge, week, annVol: sd * Math.sqrt(24 * 365) };
}

/**
 * Magellan. Looks past the usual suspects: scans the whole exchange for coins (and,
 * with Alpaca keys, US stocks) that are liquid enough to trade but small enough to be
 * overlooked, scores how much is happening in them, and adds the best to the universe
 * so the researchers dig into them. Coins that never yield a strategy are dropped to
 * make room for new ones.
 */
export class Explorer extends Agent {
  private nextScanAt = Date.now() + 15_000;
  private running = false;
  scans = 0;
  examined = 0;
  added = 0;
  dropped = 0;
  lastScanAt = 0;
  lastSummary = 'Packing the map and compass';
  /** What the execution venue accepts. Null when paper-trading locally (anything goes). */
  private tradable: { crypto: Set<string>; stocks: Set<string> } | null = null;
  private tradableAt = 0;
  private caps = new Map<string, { cap: number; rank: number }>();
  private capsAt = 0;

  constructor(
    ctx: EcoContext,
    id: string,
    name: string,
    appearance: Appearance,
    private alpaca: AlpacaClient | null,
  ) {
    super(ctx, id, name, 'explorer', 'Explorer', 'lab', appearance);
    if (!ctx.cfg.universe.scanEnabled || ctx.cfg.universe.maxExplored === 0) {
      this.mood = 'sleeping';
      this.activity = 'Scanning is off (SCAN_ENABLED=false)';
    } else {
      this.activity = 'Studying the map';
    }
  }

  tick(): void {
    const u = this.ctx.cfg.universe;
    if (!u.scanEnabled || u.maxExplored === 0 || this.running) return;
    if (Date.now() < this.nextScanAt) return;
    this.running = true;
    this.mood = 'neutral';
    this.activity = 'Scanning the markets...';
    void this.scan()
      .catch((err) => {
        log.warn('scan failed', err);
        this.lastSummary = `Scan failed: ${(err as Error).message.slice(0, 100)}`;
        this.mood = 'sad';
      })
      .finally(() => {
        this.running = false;
        this.lastScanAt = Date.now();
        this.nextScanAt = Date.now() + u.scanEveryMs;
      });
  }

  private async scan(): Promise<void> {
    const cfg = this.ctx.cfg.universe;
    const universe = this.ctx.universe;
    const candidates: Candidate[] = [];
    const notes: string[] = [];
    await this.refreshTradable(notes);

    const crypto = this.ctx.feed.cryptoProvider();
    if (crypto instanceof BinanceProvider) {
      try {
        candidates.push(...(await this.scanCrypto(crypto)));
      } catch (err) {
        notes.push(`crypto scan failed (${(err as Error).message.slice(0, 60)})`);
      }
    } else {
      notes.push('crypto scan needs Binance data');
    }
    if (cfg.scanStocks && this.alpaca) {
      try {
        candidates.push(...(await this.scanStocks(this.alpaca)));
      } catch (err) {
        notes.push(`stock scan failed (${(err as Error).message.slice(0, 60)})`);
      }
    }

    this.dropStale();

    candidates.sort((a, b) => b.score - a.score);
    const good = candidates.filter((c) => c.score >= 0.45);
    // Crypto first: it trades 24/7 and is where the overlooked small caps are. Stocks only
    // get a seat while their share of the map is small, one per scan.
    const ordered = [...good.filter((c) => c.asset === 'crypto'), ...good.filter((c) => c.asset === 'stock')];
    // Stocks are a small minority of the map (crypto is the focus), one per scan.
    const stockCap = Math.max(1, Math.ceil(cfg.maxExplored / 5));
    let added = 0;
    let stocksAdded = 0;
    let attempts = 0;
    for (const c of ordered) {
      if (added >= cfg.addPerScan || attempts >= cfg.addPerScan + 4) break;
      if (c.asset === 'stock' && (stocksAdded >= 1 || universe.exploredEntries().filter((e) => e.asset === 'stock').length >= stockCap)) continue;
      if (universe.exploredCount() >= cfg.maxExplored && !this.makeRoom()) break;
      attempts++;
      const why = await this.ctx.feed.addSymbol(c.symbol, c.asset, cfg.minBars);
      if (why) {
        log.debug(`skipped ${c.symbol}: ${why}`);
        notes.push(`${c.symbol} skipped (${why})`);
        continue;
      }
      if (c.asset === 'stock') stocksAdded++;
      universe.setVolume(c.symbol, c.volumeUsd);
      universe.add({ symbol: c.symbol, asset: c.asset, addedAt: Date.now(), reason: c.reason, score: c.score });
      added++;
      this.added++;
      this.addXp(15);
      this.mood = 'excited';
      this.ctx.news('market', `${this.name} put ${c.symbol} on the map (${c.asset}): ${c.reason}`, { agentId: this.id, good: true });
      this.ctx.emit({ kind: 'regime', agentId: this.id, text: `New find: ${c.symbol}!`, building: 'lab' });
    }

    this.scans++;
    this.addXp(3);
    this.examined += candidates.length;
    const watching = universe.exploredCount();
    this.lastSummary =
      `Scan ${this.scans}: ${candidates.length} candidates, ${good.length} promising, ${added} added` +
      (notes.length ? `; ${notes.slice(0, 2).join('; ')}` : '');
    this.activity = `Exploring ${watching}/${cfg.maxExplored} off-the-map markets`;
    if (added === 0) this.mood = 'neutral';
    log.info(this.lastSummary);
  }

  // --- Crypto -------------------------------------------------------------------

  private async scanCrypto(p: BinanceProvider): Promise<Candidate[]> {
    const cfg = this.ctx.cfg;
    const u = cfg.universe;
    const tickers = await p.fetchTickers24h();
    await this.refreshCaps();

    // Keep dollar volumes fresh for everything we already trade; slippage and order caps depend on them.
    for (const t of tickers) {
      if (cfg.symbols.includes(t.base) && cfg.assetClass(t.base) === 'crypto') this.ctx.universe.setVolume(t.base, t.quoteVolume);
    }

    const pool = tickers.filter(
      (t) =>
        /^[A-Z0-9]{2,10}$/.test(t.base) &&
        !SKIP_BASES.has(t.base) &&
        !cfg.symbols.includes(t.base) &&
        t.quoteVolume >= u.minVolumeUsd &&
        t.quoteVolume <= u.maxVolumeUsd &&
        t.trades >= 3000 &&
        Math.abs(t.change24h) < 0.8 &&
        this.capOk(t.base) &&
        (!this.tradable || this.tradable.crypto.has(t.base)),
    );
    // Cheap first pass on the 24h numbers, then look at candles for the short list only.
    const shortlist = pool
      .map((t) => ({ t, pre: Math.abs(t.change24h) * 3 + Math.log10(t.quoteVolume) * 0.15 }))
      .sort((a, b) => b.pre - a.pre)
      .slice(0, 24);

    const out: Candidate[] = [];
    for (const { t } of shortlist) {
      let hourly: Candle[];
      try {
        hourly = await p.fetchRecent(t.base, 3_600_000, 200);
      } catch {
        continue;
      }
      await sleep(150);
      const a = analyzeHourly(hourly);
      if (!a || a.annVol > 5 || a.annVol < 0.15) continue;
      const score =
        0.45 * clamp(Math.log2(Math.max(a.surge, 0.01)), -1, 3) +
        // Long-only venue: a rising coin is worth more attention than a falling one.
        0.35 * clamp((a.week >= 0 ? a.week : a.week * 0.4) / 0.25, 0, 2) +
        0.2 * clamp(a.annVol / 1.5, 0, 2);
      out.push({
        symbol: t.base,
        asset: 'crypto',
        score,
        volumeUsd: t.quoteVolume,
        reason: `${this.caps.has(t.base) ? `#${this.caps.get(t.base)!.rank} by cap (${fmtUsd(this.caps.get(t.base)!.cap)}), ` : ''}${fmtUsd(t.quoteVolume)}/day, volume x${a.surge.toFixed(1)} vs last week, 7d ${(a.week * 100).toFixed(0)}%, vol ${(a.annVol * 100).toFixed(0)}%`,
      });
    }
    return out;
  }

  /** With Alpaca as the venue, an idea is worthless if Alpaca cannot trade it. Refreshed twice a day. */
  private async refreshTradable(notes: string[]): Promise<void> {
    if (this.ctx.cfg.execution !== 'alpaca' || !this.alpaca) return;
    if (this.tradable && Date.now() - this.tradableAt < 12 * 3_600_000) return;
    try {
      const got = await this.alpaca.tradableAssets();
      if (got.crypto.size === 0 || got.stocks.size === 0) throw new Error('empty asset list');
      this.tradable = got;
      this.tradableAt = Date.now();
      log.info(`alpaca can trade ${this.tradable.crypto.size} crypto and ${this.tradable.stocks.size} stocks`);
    } catch (err) {
      notes.push(`asset list failed (${(err as Error).message.slice(0, 50)})`);
    }
    if (!this.tradable) throw new Error('cannot confirm what Alpaca can trade; skipping this scan');
  }

  /** Market caps change slowly; refresh a few times a day. A failure keeps the old table. */
  private async refreshCaps(): Promise<void> {
    if (Date.now() - this.capsAt < 6 * 3_600_000) return;
    try {
      const caps = await fetchCaps();
      if (caps.size > 0) {
        this.caps = caps;
        this.capsAt = Date.now();
      }
    } catch (err) {
      log.warn('market cap lookup failed, scanning on volume alone', err);
      this.capsAt = Date.now() - 5 * 3_600_000; // retry in an hour
    }
  }

  private capOk(base: string): boolean {
    const c = this.caps.get(base);
    if (!c) return this.caps.size === 0; // outside CoinGecko's top 1000 means dust; no table at all means lookup failed
    const u = this.ctx.cfg.universe;
    return c.rank > u.skipTopRank && c.cap >= u.minMarketCapUsd;
  }

  // --- Stocks -------------------------------------------------------------------

  private async scanStocks(alpaca: AlpacaClient): Promise<Candidate[]> {
    const cfg = this.ctx.cfg;
    const u = cfg.universe;
    const rows = (await alpaca.screenStocks(50)).filter(
      (r) => /^[A-Z]{1,5}$/.test(r.symbol) && !cfg.symbols.includes(r.symbol) && r.volume > 0 && (!this.tradable || this.tradable.stocks.has(r.symbol)),
    );
    if (rows.length === 0) return [];
    const prices = await alpaca.latestStockPrices(rows.map((r) => r.symbol));
    const out: Candidate[] = [];
    for (const r of rows) {
      const price = r.price ?? prices[r.symbol];
      if (!price || price < u.stockMinPrice || price > u.stockMaxPrice) continue;
      const dollarVol = r.volume * price;
      if (dollarVol < 5_000_000) continue;
      const move = r.changePct ?? 0;
      // Gaps of 30%+ are earnings, mergers or halts, not something a bar strategy can trade.
      if (Math.abs(move) > 0.3) continue;
      const score = 0.5 * clamp(Math.abs(move) / 0.1, 0, 2) + 0.5 * clamp(Math.log10(dollarVol / 5_000_000), 0, 2);
      out.push({
        symbol: r.symbol,
        asset: 'stock',
        score,
        volumeUsd: dollarVol,
        reason: `$${price.toFixed(2)}, ${fmtUsd(dollarVol)} traded today${r.changePct !== null ? `, ${(move * 100).toFixed(1)}% move` : ''}`,
      });
    }
    return out;
  }

  // --- Pruning ------------------------------------------------------------------

  private inUse(symbol: string): boolean {
    if (this.ctx.fund.symbolExposure(symbol) > 0) return true;
    return this.ctx.vault.all().some((s) => s.symbol === symbol && s.status !== 'retired');
  }

  /** Remove explored symbols that are no longer tradable (volume dried up) and unused. */
  private dropStale(): void {
    const floor = this.ctx.cfg.universe.minVolumeUsd * 0.5;
    for (const e of this.ctx.universe.exploredEntries()) {
      const v = this.ctx.universe.volume(e.symbol);
      if (v !== null && v < floor && !this.inUse(e.symbol)) this.drop(e.symbol, `volume fell to ${fmtUsd(v)}/day`);
    }
  }

  /** Free one slot by dropping the oldest explored symbol that got a fair try and yielded nothing. */
  private makeRoom(): boolean {
    const u = this.ctx.cfg.universe;
    const victims = this.ctx.universe
      .exploredEntries()
      .filter((e) => Date.now() - e.addedAt > 2 * 3_600_000 && this.ctx.universe.epochs(e.symbol) >= u.evictAfterEpochs && !this.inUse(e.symbol))
      .sort((a, b) => a.addedAt - b.addedAt);
    if (victims.length === 0) return false;
    this.drop(victims[0].symbol, `${this.ctx.universe.epochs(victims[0].symbol)} research epochs without a strategy`);
    return true;
  }

  private drop(symbol: string, why: string): void {
    if (!this.ctx.universe.remove(symbol)) return;
    this.dropped++;
    this.ctx.news('market', `${this.name} dropped ${symbol} from the map: ${why}`, { agentId: this.id });
  }

  stats(): Record<string, string | number> {
    const u = this.ctx.cfg.universe;
    return {
      Watching: `${this.ctx.universe.exploredCount()}/${u.maxExplored}`,
      Scans: this.scans,
      'Markets examined': this.examined,
      Added: this.added,
      Dropped: this.dropped,
      'Next scan': u.scanEnabled ? `${Math.max(0, Math.round((this.nextScanAt - Date.now()) / 60_000))} min` : 'off',
      'Last scan': this.lastSummary,
    };
  }

  protected saveExtra(): unknown {
    return { scans: this.scans, examined: this.examined, added: this.added, dropped: this.dropped, lastSummary: this.lastSummary };
  }

  protected restoreExtra(extra: unknown): void {
    const e = extra as Partial<{ scans: number; examined: number; added: number; dropped: number; lastSummary: string }>;
    this.scans = Number(e.scans) || 0;
    this.examined = Number(e.examined) || 0;
    this.added = Number(e.added) || 0;
    this.dropped = Number(e.dropped) || 0;
    if (typeof e.lastSummary === 'string') this.lastSummary = e.lastSummary;
  }
}
