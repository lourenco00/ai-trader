import type { Candle } from '../../shared/types';
import type { Config } from '../config';
import type { MarketDataProvider } from '../market/providers';
import { logger } from '../util/log';
import type { Broker, Fill, OrderRequest } from './broker';

const log = logger('alpaca');

const BAR_TIMEFRAME: Record<number, string> = { 300_000: '5Min', 900_000: '15Min', 3_600_000: '1Hour' };

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/**
 * Alpaca client: market data for both crypto and US stocks, plus a live/paper
 * execution broker. Crypto and stocks use different data endpoints, so the
 * client reads asset class from config and routes each call. Trading is one
 * endpoint (orders), with the paper/live URL chosen by config.
 */
export class AlpacaClient {
  constructor(private cfg: Config) {}

  private headers(): Record<string, string> {
    return {
      'APCA-API-KEY-ID': this.cfg.alpaca.keyId,
      'APCA-API-SECRET-KEY': this.cfg.alpaca.secret,
      Accept: 'application/json',
    };
  }

  private cryptoPair(symbol: string): string {
    return `${symbol}/USD`;
  }

  private async getJson(url: string, timeoutMs = 15_000): Promise<unknown> {
    const res = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`alpaca GET ${url} -> HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
    return res.json();
  }

  // --- Market data -----------------------------------------------------------

  private barsUrl(symbol: string, intervalMs: number, limit: number, pageToken?: string, end?: number): string {
    const tf = BAR_TIMEFRAME[intervalMs];
    if (!tf) throw new Error(`alpaca: unsupported interval ${intervalMs}`);
    const base = this.cfg.alpaca.dataUrl.replace(/\/$/, '');
    const q = new URLSearchParams({ timeframe: tf, limit: String(limit) });
    if (end) q.set('end', new Date(end).toISOString());
    if (pageToken) q.set('page_token', pageToken);
    if (this.cfg.assetClass(symbol) === 'crypto') {
      q.set('symbols', this.cryptoPair(symbol));
      return `${base}/v1beta3/crypto/us/bars?${q.toString()}`;
    }
    // Free stock data is the IEX feed.
    q.set('feed', 'iex');
    return `${base}/v2/stocks/${symbol}/bars?${q.toString()}`;
  }

  private parseBars(body: unknown, symbol: string): { bars: Candle[]; next: string | null } {
    const b = body as { bars?: unknown; next_page_token?: string | null };
    let rows: AlpacaBar[] = [];
    if (Array.isArray(b.bars)) {
      rows = b.bars as AlpacaBar[];
    } else if (b.bars && typeof b.bars === 'object') {
      // crypto returns { bars: { "BTC/USD": [...] } }
      const map = b.bars as Record<string, AlpacaBar[]>;
      rows = map[this.cryptoPair(symbol)] ?? map[symbol] ?? Object.values(map)[0] ?? [];
    }
    const bars = rows.map((r) => ({ t: Date.parse(r.t), o: r.o, h: r.h, l: r.l, c: r.c, v: r.v })).filter((c) => Number.isFinite(c.t) && Number.isFinite(c.c));
    return { bars, next: b.next_page_token ?? null };
  }

  async fetchHistory(symbol: string, intervalMs: number, bars: number): Promise<Candle[]> {
    const out: Candle[] = [];
    let token: string | undefined;
    let guard = 0;
    while (out.length < bars && guard++ < 25) {
      const url = this.barsUrl(symbol, intervalMs, Math.min(10_000, bars - out.length + 1), token);
      const { bars: page, next } = this.parseBars(await this.getJson(url), symbol);
      out.push(...page);
      if (!next || page.length === 0) break;
      token = next;
    }
    return dedupe(out).slice(-bars);
  }

  async fetchRecent(symbol: string, intervalMs: number, n: number): Promise<Candle[]> {
    const url = this.barsUrl(symbol, intervalMs, n);
    return dedupe(this.parseBars(await this.getJson(url), symbol).bars).slice(-n);
  }

  async fetchPrices(symbols: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    const base = this.cfg.alpaca.dataUrl.replace(/\/$/, '');
    const crypto = symbols.filter((s) => this.cfg.assetClass(s) === 'crypto');
    const stocks = symbols.filter((s) => this.cfg.assetClass(s) === 'stock');
    if (crypto.length) {
      const pairs = crypto.map((s) => this.cryptoPair(s)).join(',');
      const body = (await this.getJson(`${base}/v1beta3/crypto/us/latest/trades?symbols=${encodeURIComponent(pairs)}`)) as { trades?: Record<string, { p: number }> };
      for (const s of crypto) {
        const t = body.trades?.[this.cryptoPair(s)];
        if (t && Number.isFinite(t.p)) out[s] = t.p;
      }
    }
    if (stocks.length) {
      const body = (await this.getJson(`${base}/v2/stocks/trades/latest?symbols=${stocks.join(',')}&feed=iex`)) as { trades?: Record<string, { p: number }> };
      for (const s of stocks) {
        const t = body.trades?.[s];
        if (t && Number.isFinite(t.p)) out[s] = t.p;
      }
    }
    return out;
  }

  // --- Trading ---------------------------------------------------------------

  async clock(): Promise<{ isOpen: boolean; nextOpen: string; nextClose: string }> {
    const base = this.cfg.alpaca.tradingUrl.replace(/\/$/, '');
    const body = (await this.getJson(`${base}/v2/clock`)) as { is_open?: boolean; next_open?: string; next_close?: string };
    return { isOpen: body.is_open ?? false, nextOpen: body.next_open ?? '', nextClose: body.next_close ?? '' };
  }

  async account(): Promise<{ equity: number; cash: number; status: string }> {
    const base = this.cfg.alpaca.tradingUrl.replace(/\/$/, '');
    const body = (await this.getJson(`${base}/v2/account`)) as { equity?: string; cash?: string; status?: string };
    return { equity: Number(body.equity) || 0, cash: Number(body.cash) || 0, status: body.status ?? 'unknown' };
  }

  /** Submit a market order and poll briefly for the fill. */
  async submitOrder(req: OrderRequest): Promise<Fill> {
    const base = this.cfg.alpaca.tradingUrl.replace(/\/$/, '');
    const isCrypto = this.cfg.assetClass(req.symbol) === 'crypto';
    const apiSymbol = isCrypto ? this.cryptoPair(req.symbol) : req.symbol;
    const body = {
      symbol: apiSymbol,
      side: req.side,
      type: 'market',
      time_in_force: isCrypto ? 'gtc' : 'day',
      qty: String(req.qty),
    };
    const res = await fetch(`${base}/v2/orders`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`alpaca order ${req.side} ${apiSymbol} -> HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const order = (await res.json()) as { id: string };
    return this.awaitFill(order.id, req);
  }

  private async awaitFill(id: string, req: OrderRequest): Promise<Fill> {
    const base = this.cfg.alpaca.tradingUrl.replace(/\/$/, '');
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, i < 5 ? 300 : 1000));
      const o = (await this.getJson(`${base}/v2/orders/${id}`, 8000)) as {
        status?: string;
        filled_qty?: string;
        filled_avg_price?: string;
      };
      if (o.status === 'filled') {
        const qty = Number(o.filled_qty) || req.qty;
        const price = Number(o.filled_avg_price) || req.refPrice;
        return { symbol: req.symbol, side: req.side, qty, price, fee: 0, time: Date.now() };
      }
      if (o.status === 'canceled' || o.status === 'rejected' || o.status === 'expired') {
        throw new Error(`alpaca order ${id} ended ${o.status}`);
      }
    }
    throw new Error(`alpaca order ${id} did not fill in time`);
  }
}

/** Market data provider backed by Alpaca. */
export class AlpacaProvider implements MarketDataProvider {
  readonly name = 'alpaca';
  constructor(private client: AlpacaClient) {}
  fetchHistory(symbol: string, intervalMs: number, bars: number): Promise<Candle[]> {
    return this.client.fetchHistory(symbol, intervalMs, bars);
  }
  fetchRecent(symbol: string, intervalMs: number, n: number): Promise<Candle[]> {
    return this.client.fetchRecent(symbol, intervalMs, n);
  }
  fetchPrices(symbols: string[]): Promise<Record<string, number>> {
    return this.client.fetchPrices(symbols);
  }
}

/**
 * Live/paper execution through Alpaca. Fees are reported as 0 because Alpaca
 * crypto/stock commissions are 0; slippage is whatever the real fill shows.
 */
export class AlpacaBroker implements Broker {
  readonly mode = 'live' as const;
  constructor(private client: AlpacaClient) {}

  async marketOrder(req: OrderRequest): Promise<Fill> {
    if (!(req.qty > 0) || !Number.isFinite(req.qty)) throw new Error(`alpaca broker: invalid qty ${req.qty}`);
    log.info(`submitting ${req.side} ${req.qty} ${req.symbol}`);
    return this.client.submitOrder(req);
  }
}

function dedupe(candles: Candle[]): Candle[] {
  const seen = new Set<number>();
  const out: Candle[] = [];
  for (const c of candles.sort((a, b) => a.t - b.t)) {
    if (seen.has(c.t)) continue;
    seen.add(c.t);
    out.push(c);
  }
  return out;
}
