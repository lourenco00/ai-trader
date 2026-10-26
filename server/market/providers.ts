import type { Candle } from '../../shared/types';
import { Rng, hashString } from '../util/rng';

export interface MarketDataProvider {
  readonly name: string;
  /** Closed and possibly one in-progress candle, oldest first. */
  fetchHistory(symbol: string, intervalMs: number, bars: number): Promise<Candle[]>;
  fetchRecent(symbol: string, intervalMs: number, n: number): Promise<Candle[]>;
  fetchPrices(symbols: string[]): Promise<Record<string, number>>;
}

async function fetchJson(url: string, timeoutMs = 10_000): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'ai-trader-valley/0.1', Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET ${url} -> HTTP ${res.status} ${body.slice(0, 120)}`);
  }
  return res.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function finite(n: number, what: string): number {
  if (!Number.isFinite(n)) throw new Error(`provider returned non-numeric ${what}`);
  return n;
}

// ---------------------------------------------------------------------------
// Binance (public market data, no key needed)
// ---------------------------------------------------------------------------

const BINANCE_INTERVALS: Record<number, string> = { 300_000: '5m', 900_000: '15m', 3_600_000: '1h' };

export class BinanceProvider implements MarketDataProvider {
  readonly name = 'binance';
  private base = 'https://data-api.binance.vision';

  private pair(symbol: string): string {
    return `${symbol}USDT`;
  }

  private interval(intervalMs: number): string {
    const iv = BINANCE_INTERVALS[intervalMs];
    if (!iv) throw new Error(`binance: unsupported interval ${intervalMs}`);
    return iv;
  }

  private parse(rows: unknown): Candle[] {
    if (!Array.isArray(rows)) throw new Error('binance: unexpected klines payload');
    return rows.map((r) => {
      const row = r as (string | number)[];
      return {
        t: finite(Number(row[0]), 'time'),
        o: finite(Number(row[1]), 'open'),
        h: finite(Number(row[2]), 'high'),
        l: finite(Number(row[3]), 'low'),
        c: finite(Number(row[4]), 'close'),
        v: finite(Number(row[5]), 'volume'),
      };
    });
  }

  async fetchHistory(symbol: string, intervalMs: number, bars: number): Promise<Candle[]> {
    const out: Candle[] = [];
    let endTime: number | undefined;
    while (out.length < bars) {
      const limit = Math.min(1000, bars - out.length);
      const url =
        `${this.base}/api/v3/klines?symbol=${this.pair(symbol)}&interval=${this.interval(intervalMs)}&limit=${limit}` +
        (endTime !== undefined ? `&endTime=${endTime}` : '');
      const page = this.parse(await fetchJson(url));
      if (page.length === 0) break;
      out.unshift(...page);
      endTime = page[0].t - 1;
      if (page.length < limit) break;
      await sleep(150);
    }
    return dedupe(out);
  }

  async fetchRecent(symbol: string, intervalMs: number, n: number): Promise<Candle[]> {
    const url = `${this.base}/api/v3/klines?symbol=${this.pair(symbol)}&interval=${this.interval(intervalMs)}&limit=${n}`;
    return this.parse(await fetchJson(url));
  }

  async fetchPrices(symbols: string[]): Promise<Record<string, number>> {
    const list = encodeURIComponent(JSON.stringify(symbols.map((s) => this.pair(s))));
    const rows = await fetchJson(`${this.base}/api/v3/ticker/price?symbols=${list}`);
    if (!Array.isArray(rows)) throw new Error('binance: unexpected ticker payload');
    const out: Record<string, number> = {};
    for (const r of rows as { symbol: string; price: string }[]) {
      const sym = symbols.find((s) => this.pair(s) === r.symbol);
      if (sym) out[sym] = finite(Number(r.price), 'price');
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Coinbase Exchange (public, no key needed)
// ---------------------------------------------------------------------------

export class CoinbaseProvider implements MarketDataProvider {
  readonly name = 'coinbase';
  private base = 'https://api.exchange.coinbase.com';

  private product(symbol: string): string {
    return `${symbol}-USD`;
  }

  private parse(rows: unknown): Candle[] {
    if (!Array.isArray(rows)) throw new Error('coinbase: unexpected candles payload');
    // Coinbase rows: [time(s), low, high, open, close, volume], newest first.
    return rows
      .map((r) => {
        const row = r as number[];
        return {
          t: finite(Number(row[0]), 'time') * 1000,
          l: finite(Number(row[1]), 'low'),
          h: finite(Number(row[2]), 'high'),
          o: finite(Number(row[3]), 'open'),
          c: finite(Number(row[4]), 'close'),
          v: finite(Number(row[5]), 'volume'),
        };
      })
      .sort((a, b) => a.t - b.t);
  }

  private async page(symbol: string, intervalMs: number, start: number, end: number): Promise<Candle[]> {
    const g = intervalMs / 1000;
    if (![60, 300, 900, 3600, 21600, 86400].includes(g)) throw new Error(`coinbase: unsupported interval ${intervalMs}`);
    const url =
      `${this.base}/products/${this.product(symbol)}/candles?granularity=${g}` +
      `&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
    return this.parse(await fetchJson(url));
  }

  async fetchHistory(symbol: string, intervalMs: number, bars: number): Promise<Candle[]> {
    const out: Candle[] = [];
    let end = Date.now();
    let emptyPages = 0;
    while (out.length < bars && emptyPages < 3) {
      const start = end - 299 * intervalMs;
      const page = await this.page(symbol, intervalMs, start, end);
      if (page.length === 0) emptyPages++;
      out.unshift(...page);
      end = start - intervalMs;
      await sleep(200);
    }
    return dedupe(out).slice(-bars);
  }

  async fetchRecent(symbol: string, intervalMs: number, n: number): Promise<Candle[]> {
    const end = Date.now();
    return this.page(symbol, intervalMs, end - n * intervalMs, end);
  }

  async fetchPrices(symbols: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const s of symbols) {
      const r = (await fetchJson(`${this.base}/products/${this.product(s)}/ticker`)) as { price?: string };
      out[s] = finite(Number(r.price), 'price');
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Simulator: regime-switching random walk, aligned to wall-clock time.
// Used offline or when exchanges are unreachable. Results on simulated data
// say nothing about real markets; the UI labels the provider clearly.
// ---------------------------------------------------------------------------

interface SimState {
  rng: Rng;
  closed: Candle[];
  cur: Candle;
  mu: number;
  sigma: number;
  lastTick: number;
}

const SIM_BASE: Record<string, number> = { BTC: 65_000, ETH: 3_200, SOL: 150, BNB: 580, XRP: 0.6, DOGE: 0.15 };

export class SimulatedProvider implements MarketDataProvider {
  readonly name = 'sim';
  private states = new Map<string, SimState>();

  constructor(private intervalMs: number) {}

  private barsPerYear(): number {
    return (365 * 24 * 3_600_000) / this.intervalMs;
  }

  private newRegime(st: SimState): void {
    const bpy = this.barsPerYear();
    const annualDrift = st.rng.range(-1.2, 1.4);
    const annualVol = st.rng.range(0.35, 1.1);
    st.mu = annualDrift / bpy;
    st.sigma = annualVol / Math.sqrt(bpy);
  }

  private state(symbol: string): SimState {
    let st = this.states.get(symbol);
    if (st) return st;
    const rng = new Rng(hashString(symbol) ^ 0x5eed);
    const now = Date.now();
    const curT = Math.floor(now / this.intervalMs) * this.intervalMs;
    const price = SIM_BASE[symbol] ?? 100;
    st = {
      rng,
      closed: [],
      cur: { t: curT, o: price, h: price, l: price, c: price, v: 0 },
      mu: 0,
      sigma: 0.003,
      lastTick: now,
    };
    this.newRegime(st);
    this.states.set(symbol, st);
    return st;
  }

  private fullBar(st: SimState, t: number, open: number): Candle {
    if (st.rng.chance(1 / 250)) this.newRegime(st);
    const jump = st.rng.chance(0.01) ? st.rng.gauss() * st.sigma * 6 : 0;
    const r = st.mu + st.sigma * st.rng.gauss() + jump;
    const c = open * Math.exp(r);
    const wick = () => Math.abs(st.rng.gauss()) * st.sigma * 0.6;
    return {
      t,
      o: open,
      c,
      h: Math.max(open, c) * Math.exp(wick()),
      l: Math.min(open, c) * Math.exp(-wick()),
      v: Math.exp(st.rng.gauss() * 0.5) * 1000,
    };
  }

  /** Roll the in-progress candle forward to wall-clock time. */
  private advance(st: SimState, now: number): void {
    while (st.cur.t + this.intervalMs <= now) {
      const done = st.cur;
      if (done.v === 0) {
        // No ticks landed inside this bar (process was asleep): synthesise it whole.
        st.closed.push(this.fullBar(st, done.t, done.o));
      } else {
        st.closed.push(done);
      }
      const open = st.closed[st.closed.length - 1].c;
      st.cur = { t: done.t + this.intervalMs, o: open, h: open, l: open, c: open, v: 0 };
      if (st.closed.length > 30_000) st.closed.splice(0, st.closed.length - 30_000);
    }
  }

  async fetchHistory(symbol: string, intervalMs: number, bars: number): Promise<Candle[]> {
    if (intervalMs !== this.intervalMs) throw new Error('sim: interval mismatch');
    const st = this.state(symbol);
    if (st.closed.length === 0) {
      // Generate history backwards in time so it ends at the current price level.
      let price = st.cur.o;
      const startT = st.cur.t - bars * this.intervalMs;
      const tmp: Candle[] = [];
      for (let i = 0; i < bars; i++) {
        const bar = this.fullBar(st, startT + i * this.intervalMs, price);
        tmp.push(bar);
        price = bar.c;
      }
      // Rescale so the last close matches the in-progress open.
      const k = st.cur.o / tmp[tmp.length - 1].c;
      st.closed = tmp.map((b) => ({ ...b, o: b.o * k, h: b.h * k, l: b.l * k, c: b.c * k }));
    }
    this.advance(st, Date.now());
    return [...st.closed.slice(-bars), { ...st.cur }];
  }

  async fetchRecent(symbol: string, intervalMs: number, n: number): Promise<Candle[]> {
    if (intervalMs !== this.intervalMs) throw new Error('sim: interval mismatch');
    const st = this.state(symbol);
    this.advance(st, Date.now());
    return [...st.closed.slice(-(n - 1)), { ...st.cur }];
  }

  async fetchPrices(symbols: string[]): Promise<Record<string, number>> {
    const now = Date.now();
    const out: Record<string, number> = {};
    for (const s of symbols) {
      const st = this.state(s);
      this.advance(st, now);
      const dt = Math.max(0, now - st.lastTick) / this.intervalMs;
      st.lastTick = now;
      const step = st.mu * dt + st.sigma * Math.sqrt(dt) * st.rng.gauss();
      st.cur.c = st.cur.c * Math.exp(step);
      st.cur.h = Math.max(st.cur.h, st.cur.c);
      st.cur.l = Math.min(st.cur.l, st.cur.c);
      st.cur.v += Math.exp(st.rng.gauss() * 0.5) * 50;
      out[s] = st.cur.c;
    }
    return out;
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
