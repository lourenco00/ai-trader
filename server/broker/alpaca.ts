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

  private barsUrl(symbol: string, intervalMs: number, limit: number, pageToken?: string, end?: number, start?: number): string {
    const tf = BAR_TIMEFRAME[intervalMs];
    if (!tf) throw new Error(`alpaca: unsupported interval ${intervalMs}`);
    const base = this.cfg.alpaca.dataUrl.replace(/\/$/, '');
    const q = new URLSearchParams({ timeframe: tf, limit: String(limit) });
    if (start) q.set('start', new Date(start).toISOString());
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
    if (this.cfg.assetClass(symbol) === 'stock') {
      // Stock bars come oldest first from `start` (default: today only), so ask for a
      // window long enough to hold `bars` regular-session bars and page to the end.
      const perDay = Math.max(1, Math.floor((6.5 * 3_600_000) / intervalMs));
      const tradingDays = Math.ceil(bars / perDay) + 5;
      const start = Date.now() - Math.ceil((tradingDays * 7) / 5) * 86_400_000;
      while (guard++ < 25) {
        const url = this.barsUrl(symbol, intervalMs, 10_000, token, undefined, start);
        const { bars: page, next } = this.parseBars(await this.getJson(url), symbol);
        out.push(...page);
        if (!next || page.length === 0) break;
        token = next;
      }
      return dedupe(out).slice(-bars);
    }
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

  /** Latest trade price for stocks not (yet) registered in the config, which `fetchPrices` would route as crypto. */
  async latestStockPrices(symbols: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    if (symbols.length === 0) return out;
    const base = this.cfg.alpaca.dataUrl.replace(/\/$/, '');
    const body = (await this.getJson(`${base}/v2/stocks/trades/latest?symbols=${symbols.join(',')}&feed=iex`)) as { trades?: Record<string, { p: number }> };
    for (const s of symbols) {
      const t = body.trades?.[s];
      if (t && Number.isFinite(t.p)) out[s] = t.p;
    }
    return out;
  }

  /** Today's most active and biggest-moving US stocks, from Alpaca's screener. */
  async screenStocks(top = 50): Promise<{ symbol: string; volume: number; trades: number; price: number | null; changePct: number | null }[]> {
    const base = this.cfg.alpaca.dataUrl.replace(/\/$/, '');
    const [active, movers] = await Promise.all([
      this.getJson(`${base}/v1beta1/screener/stocks/most-actives?by=volume&top=${top}`) as Promise<{ most_actives?: { symbol: string; volume: number; trade_count: number }[] }>,
      this.getJson(`${base}/v1beta1/screener/stocks/movers?top=${top}`) as Promise<{
        gainers?: { symbol: string; price: number; percent_change: number }[];
        losers?: { symbol: string; price: number; percent_change: number }[];
      }>,
    ]);
    const out = new Map<string, { symbol: string; volume: number; trades: number; price: number | null; changePct: number | null }>();
    for (const a of active.most_actives ?? []) {
      out.set(a.symbol, { symbol: a.symbol, volume: Number(a.volume) || 0, trades: Number(a.trade_count) || 0, price: null, changePct: null });
    }
    for (const m of [...(movers.gainers ?? []), ...(movers.losers ?? [])]) {
      const cur = out.get(m.symbol) ?? { symbol: m.symbol, volume: 0, trades: 0, price: null, changePct: null };
      cur.price = Number(m.price) || null;
      cur.changePct = Number(m.percent_change) / 100;
      out.set(m.symbol, cur);
    }
    return [...out.values()];
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

  private async send(method: 'GET' | 'POST' | 'DELETE', pathAndQuery: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const base = this.cfg.alpaca.tradingUrl.replace(/\/$/, '');
    const res = await fetch(`${base}${pathAndQuery}`, {
      method,
      headers: { ...this.headers(), ...(body ? { 'content-type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(15_000),
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }

  private orderError(what: string, r: { status: number; json: unknown }): Error {
    return new Error(`alpaca ${what} -> HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  }

  /**
   * Market order for an entry, or an exact close of the real position for an exit.
   * Crypto buys are charged in kind, so the quantity held is a little below what was
   * bought; closing through the positions endpoint sells exactly what is there.
   */
  async submitOrder(req: OrderRequest): Promise<Fill> {
    const isCrypto = this.cfg.assetClass(req.symbol) === 'crypto';
    const apiSymbol = isCrypto ? this.cryptoPair(req.symbol) : req.symbol;
    if (isCrypto && this.cfg.limitOrders && !(req.closing && req.urgent)) {
      const resting = await this.restingCryptoOrder(req, apiSymbol);
      if (resting) return resting;
    }
    let r;
    if (req.closing) {
      // The positions endpoint names crypto without the slash (ETHUSD).
      r = await this.send('DELETE', `/v2/positions/${apiSymbol.replace('/', '')}`);
      if (r.status === 404) throw new Error(`alpaca holds no ${apiSymbol} position to close`);
      if (r.status >= 300) throw this.orderError(`close ${apiSymbol}`, r);
    } else {
      // Stocks trade in whole shares: not every name is fractionable and a whole share is clean to close.
      const qty = isCrypto ? req.qty : Math.floor(req.qty);
      if (!(qty > 0)) throw new Error(`alpaca: ${req.symbol} order too small for a whole share (${req.qty.toFixed(3)})`);
      r = await this.send('POST', '/v2/orders', {
        symbol: apiSymbol,
        side: req.side,
        type: 'market',
        time_in_force: isCrypto ? 'gtc' : 'day',
        qty: isCrypto ? qty.toFixed(8).replace(/0+$/, '').replace(/\.$/, '') : String(qty),
      });
      if (r.status >= 300) throw this.orderError(`${req.side} ${apiSymbol}`, r);
    }
    const order = r.json as { id: string };
    return this.awaitFill(order.id, req, isCrypto);
  }

  // --- Limit orders (crypto) ----------------------------------------------------

  private async quote(apiSymbol: string): Promise<{ bid: number; ask: number } | null> {
    const base = this.cfg.alpaca.dataUrl.replace(/\/$/, '');
    try {
      const body = (await this.getJson(`${base}/v1beta3/crypto/us/latest/quotes?symbols=${encodeURIComponent(apiSymbol)}`)) as { quotes?: Record<string, { bp: number; ap: number }> };
      const q = body.quotes?.[apiSymbol];
      if (q && q.bp > 0 && q.ap > 0 && q.ap >= q.bp) return { bid: q.bp, ask: q.ap };
    } catch (err) {
      log.debug(`quote ${apiSymbol} failed`, err);
    }
    return null;
  }

  private tickCache = new Map<string, number>();

  /** Smallest price step the venue accepts for this pair. */
  private async priceIncrement(apiSymbol: string): Promise<number> {
    const hit = this.tickCache.get(apiSymbol);
    if (hit) return hit;
    const r = await this.send('GET', `/v2/assets/${encodeURIComponent(apiSymbol)}`);
    const inc = Number((r.json as { price_increment?: string | number })?.price_increment);
    const tick = Number.isFinite(inc) && inc > 0 ? inc : 1e-6;
    this.tickCache.set(apiSymbol, tick);
    return tick;
  }

  private roundToTick(price: number, tick: number, mode: 'down' | 'up'): number {
    const n = (mode === 'down' ? Math.floor : Math.ceil)(price / tick + 1e-9);
    const decimals = Math.max(0, Math.round(-Math.log10(tick)));
    return Number((n * tick).toFixed(Math.min(decimals + 1, 10)));
  }

  private async readOrder(id: string): Promise<{ status: string; qty: number; avg: number }> {
    const r = await this.send('GET', `/v2/orders/${id}`);
    const o = r.json as { status?: string; filled_qty?: string; filled_avg_price?: string };
    return { status: o.status ?? 'unknown', qty: Number(o.filled_qty) || 0, avg: Number(o.filled_avg_price) || 0 };
  }

  /** Wait until the order is filled or the time is up, then cancel whatever is still resting. */
  private async restUntil(id: string, waitMs: number): Promise<{ qty: number; avg: number }> {
    const terminal = ['filled', 'canceled', 'rejected', 'expired'];
    const end = Date.now() + waitMs;
    let o = await this.readOrder(id);
    while (!terminal.includes(o.status) && Date.now() < end) {
      await new Promise((res) => setTimeout(res, 2000));
      o = await this.readOrder(id);
    }
    if (!terminal.includes(o.status)) {
      await this.send('DELETE', `/v2/orders/${id}`);
      // The order can fill in the instant before the cancel lands, so read the final state.
      for (let i = 0; i < 5; i++) {
        await new Promise((res) => setTimeout(res, 400));
        o = await this.readOrder(id);
        if (terminal.includes(o.status)) break;
      }
    }
    return { qty: o.qty, avg: o.avg };
  }

  /**
   * Crypto entry or calm exit as a limit order inside the spread, so it is a maker order
   * (0.15% instead of 0.25%). Returns null to fall back to a market order.
   */
  private async restingCryptoOrder(req: OrderRequest, apiSymbol: string): Promise<Fill | null> {
    const q = await this.quote(apiSymbol);
    if (!q) return null;
    const mid = (q.bid + q.ask) / 2;
    const spread = (q.ask - q.bid) / mid;
    if (spread > 0.01) {
      if (req.closing) return null; // get out at market rather than wait on a 1%-wide book
      throw new Error(`${req.symbol} spread too wide (${(spread * 100).toFixed(2)}%)`);
    }
    const tick = await this.priceIncrement(apiSymbol);
    const buy = req.side === 'buy';
    // 30% of the way across the spread from our own side: inside the book, never crossing it.
    const raw = buy ? q.bid + 0.3 * (q.ask - q.bid) : q.ask - 0.3 * (q.ask - q.bid);
    const price = this.roundToTick(raw, tick, buy ? 'down' : 'up');
    if (!(price > 0)) return null;

    let qty = req.qty;
    if (req.closing) {
      const pos = await this.send('GET', `/v2/positions/${apiSymbol.replace('/', '')}`);
      const held = Number((pos.json as { qty_available?: string })?.qty_available);
      if (pos.status === 404 || !(held > 0)) throw new Error(`alpaca holds no ${apiSymbol} position to close`);
      qty = held;
    }
    const qtyStr = qty.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
    const r = await this.send('POST', '/v2/orders', { symbol: apiSymbol, side: req.side, type: 'limit', limit_price: String(price), time_in_force: 'gtc', qty: qtyStr });
    if (r.status >= 300) throw this.orderError(`limit ${req.side} ${apiSymbol}`, r);
    const id = (r.json as { id: string }).id;
    const got = await this.restUntil(id, req.closing ? this.cfg.limitExitWaitMs : this.cfg.limitEntryWaitMs);
    const maker = this.cfg.alpacaCryptoMakerFee;
    log.info(`limit ${req.side} ${apiSymbol} @ ${price}: filled ${got.qty} of ${qtyStr}`);

    // Whatever did not rest-fill goes out at market, so an entry is never lost to a price that ran away
    // and an exit always fully closes. The delay is seconds against hourly candles.
    const rest = qty - got.qty;
    if (rest <= qty * 0.001) {
      return { symbol: req.symbol, side: req.side, qty: got.qty, price: got.avg, fee: got.avg * got.qty * maker, time: Date.now() };
    }
    let tail: Fill;
    if (req.closing) {
      const closed = await this.send('DELETE', `/v2/positions/${apiSymbol.replace('/', '')}`);
      if (closed.status === 404) {
        // Filled in the meantime; treat what we know as the exit.
        return { symbol: req.symbol, side: req.side, qty: got.qty, price: got.avg || req.refPrice, fee: got.avg * got.qty * maker, time: Date.now() };
      }
      if (closed.status >= 300) throw this.orderError(`close ${apiSymbol}`, closed);
      tail = await this.awaitFill((closed.json as { id: string }).id, { ...req, qty: rest }, true);
    } else {
      const m = await this.send('POST', '/v2/orders', {
        symbol: apiSymbol,
        side: req.side,
        type: 'market',
        time_in_force: 'gtc',
        qty: rest.toFixed(8).replace(/0+$/, '').replace(/.$/, ''),
      });
      if (m.status >= 300) throw this.orderError(`${req.side} ${apiSymbol}`, m);
      tail = await this.awaitFill((m.json as { id: string }).id, { ...req, qty: rest }, true);
    }
    const total = got.qty + tail.qty;
    return {
      symbol: req.symbol,
      side: req.side,
      qty: total,
      price: (got.avg * got.qty + tail.price * tail.qty) / total,
      fee: got.avg * got.qty * maker + tail.fee,
      time: Date.now(),
    };
  }

  private async awaitFill(id: string, req: OrderRequest, isCrypto: boolean): Promise<Fill> {
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, i < 5 ? 300 : 1000));
      const r = await this.send('GET', `/v2/orders/${id}`);
      const o = r.json as { status?: string; filled_qty?: string; filled_avg_price?: string };
      if (o.status === 'filled') {
        const qty = Number(o.filled_qty) || req.qty;
        const price = Number(o.filled_avg_price) || req.refPrice;
        // Alpaca does not report the crypto fee; it is taken from the coins received.
        const fee = isCrypto ? price * qty * this.cfg.alpacaCryptoFee : 0;
        return { symbol: req.symbol, side: req.side, qty, price, fee, time: Date.now() };
      }
      if (o.status === 'canceled' || o.status === 'rejected' || o.status === 'expired') {
        throw new Error(`alpaca order ${id} ended ${o.status}`);
      }
    }
    // Never leave a stray order that could fill later and put the account out of step with the ledger.
    await this.send('DELETE', `/v2/orders/${id}`).catch(() => undefined);
    throw new Error(`alpaca order ${id} did not fill in time and was cancelled`);
  }

  async positions(): Promise<{ symbol: string; qty: number; marketValue: number; side: string }[]> {
    const r = await this.send('GET', '/v2/positions');
    if (r.status !== 200 || !Array.isArray(r.json)) throw this.orderError('positions', r);
    return (r.json as { symbol: string; qty: string; market_value: string; side: string }[]).map((p) => ({
      // Crypto positions come back as BTCUSD; the ledger uses the bare ticker.
      symbol: p.symbol.replace(/\/?USD$/, ''),
      qty: Number(p.qty),
      marketValue: Number(p.market_value),
      side: p.side,
    }));
  }

  /** What Alpaca will let us trade: USD crypto pairs and non-OTC US equities. Cached by the caller. */
  async tradableAssets(): Promise<{ crypto: Set<string>; stocks: Set<string> }> {
    const crypto = new Set<string>();
    const stocks = new Set<string>();
    const c = await this.send('GET', '/v2/assets?status=active&asset_class=crypto');
    if (c.status === 200 && Array.isArray(c.json)) {
      for (const a of c.json as { symbol: string; tradable: boolean }[]) {
        if (a.tradable && a.symbol.endsWith('/USD')) crypto.add(a.symbol.slice(0, -4));
      }
    }
    const s = await this.send('GET', '/v2/assets?status=active&asset_class=us_equity');
    if (s.status === 200 && Array.isArray(s.json)) {
      for (const a of s.json as { symbol: string; tradable: boolean; exchange: string }[]) {
        if (a.tradable && a.exchange !== 'OTC') stocks.add(a.symbol);
      }
    }
    return { crypto, stocks };
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
  // Orders go to a real venue, but config refuses anything except the paper account.
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
