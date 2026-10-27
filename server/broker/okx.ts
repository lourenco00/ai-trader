import crypto from 'node:crypto';
import type { Config } from '../config';
import { logger } from '../util/log';
import type { Broker, Fill, OrderRequest } from './broker';

const log = logger('okx');

interface Rules {
  lotSz: number;
  minSz: number;
  tickSz: number;
}

interface OrderState {
  state: string;
  qty: number;
  avg: number;
  /** Fee in the order's fee currency; OKX reports charges as negative numbers. */
  fee: number;
  feeCcy: string;
}

interface Part {
  qty: number;
  avg: number;
  /** Fee already converted to the quote currency (about USD). */
  feeUsd: number;
  /** Base-currency fee, which comes out of the coins received on a buy. */
  feeBase: number;
}

const TERMINAL = ['filled', 'canceled', 'mmp_canceled'];

/**
 * OKX spot client, signed REST. Runs against OKX's demo trading by default: the same API with an
 * `x-simulated-trading` header and play money. `Config` refuses anything but demo.
 */
export class OkxClient {
  private rules = new Map<string, Rules>();

  constructor(private cfg: Config) {}

  get quote(): string {
    return this.cfg.okx.quote;
  }

  instId(symbol: string): string {
    return `${symbol}-${this.cfg.okx.quote}`;
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown, signed = true): Promise<{ code: string; msg: string; data: any[] }> {
    const text = body ? JSON.stringify(body) : '';
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cfg.okx.demo) headers['x-simulated-trading'] = '1';
    if (signed) {
      const ts = new Date().toISOString();
      const sign = crypto.createHmac('sha256', this.cfg.okx.secret).update(ts + method + path + text).digest('base64');
      Object.assign(headers, {
        'OK-ACCESS-KEY': this.cfg.okx.keyId,
        'OK-ACCESS-SIGN': sign,
        'OK-ACCESS-TIMESTAMP': ts,
        'OK-ACCESS-PASSPHRASE': this.cfg.okx.passphrase,
      });
    }
    const res = await fetch(`${this.cfg.okx.baseUrl}${path}`, { method, headers, body: text || undefined, signal: AbortSignal.timeout(15_000) });
    const json = (await res.json().catch(() => null)) as { code?: string; msg?: string; data?: any[] } | null;
    if (!json) throw new Error(`okx ${method} ${path.split('?')[0]} -> HTTP ${res.status}`);
    return { code: String(json.code ?? ''), msg: String(json.msg ?? ''), data: json.data ?? [] };
  }

  private async ok(method: 'GET' | 'POST', path: string, body?: unknown, signed = true): Promise<any[]> {
    const r = await this.request(method, path, body, signed);
    if (r.code !== '0') {
      const detail = r.data?.[0]?.sMsg ? ` (${r.data[0].sMsg})` : '';
      throw new Error(`okx ${path.split('?')[0]} -> ${r.code} ${r.msg}${detail}`);
    }
    return r.data;
  }

  /** Loads trading rules and confirms the keys work. Call once at startup. */
  async init(): Promise<void> {
    const rows = await this.ok('GET', '/api/v5/public/instruments?instType=SPOT', undefined, false);
    for (const i of rows) {
      if (i.state !== 'live' || i.quoteCcy !== this.cfg.okx.quote) continue;
      this.rules.set(i.instId, { lotSz: Number(i.lotSz), minSz: Number(i.minSz), tickSz: Number(i.tickSz) });
    }
    const [acct] = await this.ok('GET', '/api/v5/account/config');
    const [fee] = await this.ok('GET', '/api/v5/account/trade-fee?instType=SPOT');
    log.info(
      `${this.cfg.okx.demo ? 'demo' : 'LIVE'} account ready: permissions ${acct?.perm}, fee maker ${(-Number(fee?.maker) * 100).toFixed(2)}% taker ${(-Number(fee?.taker) * 100).toFixed(2)}%, ${this.rules.size} ${this.quote} pairs tradable`,
    );
    if (String(acct?.perm ?? '').includes('withdraw')) log.warn('this API key can withdraw; recreate it with Read and Trade only');
  }

  /** Coins that can be traded against our quote currency in this environment. */
  tradableBases(): Set<string> {
    return new Set([...this.rules.keys()].map((id) => id.slice(0, -(this.quote.length + 1))));
  }

  rule(instId: string): Rules | undefined {
    return this.rules.get(instId);
  }

  async balance(ccy: string): Promise<number> {
    const rows = await this.ok('GET', `/api/v5/account/balance?ccy=${ccy}`);
    return Number(rows[0]?.details?.find((d: any) => d.ccy === ccy)?.availBal) || 0;
  }

  async book(instId: string): Promise<{ bid: number; ask: number } | null> {
    try {
      const [t] = await this.ok('GET', `/api/v5/market/ticker?instId=${instId}`, undefined, false);
      const bid = Number(t?.bidPx);
      const ask = Number(t?.askPx);
      return bid > 0 && ask >= bid ? { bid, ask } : null;
    } catch {
      return null;
    }
  }

  async place(order: Record<string, string>): Promise<string> {
    const [r] = await this.ok('POST', '/api/v5/trade/order', order);
    if (r?.sCode && r.sCode !== '0') throw new Error(`okx order rejected: ${r.sCode} ${r.sMsg}`);
    return String(r.ordId);
  }

  async cancel(instId: string, ordId: string): Promise<void> {
    await this.request('POST', '/api/v5/trade/cancel-order', { instId, ordId }).catch(() => undefined);
  }

  async read(instId: string, ordId: string): Promise<OrderState> {
    const [o] = await this.ok('GET', `/api/v5/trade/order?instId=${instId}&ordId=${ordId}`);
    return { state: String(o?.state ?? 'unknown'), qty: Number(o?.accFillSz) || 0, avg: Number(o?.avgPx) || 0, fee: Number(o?.fee) || 0, feeCcy: String(o?.feeCcy ?? '') };
  }
}

function floorToStep(x: number, step: number): number {
  const n = Math.floor(x / step + 1e-9);
  const decimals = Math.max(0, Math.round(-Math.log10(step)));
  return Number((n * step).toFixed(decimals));
}

function fmt(x: number, step: number): string {
  const decimals = Math.max(0, Math.round(-Math.log10(step)));
  return x.toFixed(decimals);
}

export class OkxBroker implements Broker {
  // Orders go to a venue, but config refuses anything except the demo environment.
  readonly mode = 'live' as const;
  /** Coins we bought and still hold, net of fees, so a close never sells the demo account's own stock. */
  private held = new Map<string, number>();

  constructor(
    private client: OkxClient,
    private cfg: Config,
  ) {}

  async marketOrder(req: OrderRequest): Promise<Fill> {
    if (!(req.qty > 0) || !Number.isFinite(req.qty)) throw new Error(`okx broker: invalid qty ${req.qty}`);
    const inst = this.client.instId(req.symbol);
    const rules = this.client.rule(inst);
    if (!rules) throw new Error(`${inst} is not tradable on OKX here`);
    const buy = req.side === 'buy';
    const { takerFee } = this.cfg.okx;

    let qty = req.qty;
    if (req.closing) {
      const have = Math.min(this.held.get(req.symbol) ?? req.qty * (1 - takerFee), await this.client.balance(req.symbol));
      qty = Math.min(req.qty, have);
    }
    qty = floorToStep(qty, rules.lotSz);
    if (qty < rules.minSz) throw new Error(`${inst} order of ${qty} is below the ${rules.minSz} minimum`);

    const parts: Part[] = [];
    if (this.cfg.limitOrders && !(req.closing && req.urgent)) {
      const resting = await this.rest(req, inst, rules, qty, buy);
      if (resting) parts.push(resting);
    }
    const done = parts.reduce((s, p) => s + p.qty, 0);
    const left = floorToStep(qty - done, rules.lotSz);
    // Whatever did not rest-fill goes out at market, so an entry is not lost and an exit always completes.
    if (left >= rules.minSz) {
      const id = await this.client.place({ instId: inst, tdMode: 'cash', side: req.side, ordType: 'market', sz: fmt(left, rules.lotSz), ...(buy ? { tgtCcy: 'base_ccy' } : {}) });
      parts.push(await this.wait(inst, id, 20_000, false));
    }
    if (parts.length === 0) throw new Error(`${inst} order did not fill`);

    const total = parts.reduce((s, p) => s + p.qty, 0);
    const avg = parts.reduce((s, p) => s + p.avg * p.qty, 0) / total;
    const feeUsd = parts.reduce((s, p) => s + p.feeUsd, 0);
    const feeBase = parts.reduce((s, p) => s + p.feeBase, 0);
    if (buy) this.held.set(req.symbol, (this.held.get(req.symbol) ?? 0) + total - feeBase);
    else {
      const left2 = (this.held.get(req.symbol) ?? 0) - total;
      if (left2 > rules.lotSz) this.held.set(req.symbol, left2);
      else this.held.delete(req.symbol);
    }
    log.info(`${req.side} ${req.symbol}: ${total} @ ${avg.toPrecision(6)}, fee $${feeUsd.toFixed(4)}`);
    return { symbol: req.symbol, side: req.side, qty: total, price: avg, fee: feeUsd, time: Date.now() };
  }

  /** Post inside the spread and wait; returns what filled (possibly nothing). The caller finishes the rest at market. */
  private async rest(req: OrderRequest, inst: string, rules: Rules, qty: number, buy: boolean): Promise<Part | null> {
    const book = await this.client.book(inst);
    if (!book) return null;
    const spread = (book.ask - book.bid) / ((book.ask + book.bid) / 2);
    if (spread > 0.01) {
      if (req.closing) return null;
      throw new Error(`${req.symbol} spread too wide (${(spread * 100).toFixed(2)}%)`);
    }
    // 30% of the way across the spread from our own side: inside the book, never crossing it.
    const raw = buy ? book.bid + 0.3 * (book.ask - book.bid) : book.ask - 0.3 * (book.ask - book.bid);
    const price = buy ? floorToStep(raw, rules.tickSz) : Math.ceil(raw / rules.tickSz - 1e-9) * rules.tickSz;
    const id = await this.client.place({ instId: inst, tdMode: 'cash', side: req.side, ordType: 'limit', px: fmt(price, rules.tickSz), sz: fmt(qty, rules.lotSz) });
    const part = await this.wait(inst, id, req.closing ? this.cfg.limitExitWaitMs : this.cfg.limitEntryWaitMs, true);
    log.info(`limit ${req.side} ${inst} @ ${price}: filled ${part.qty} of ${qty}`);
    return part.qty > 0 ? part : null;
  }

  /** Poll an order until it is done or the time is up; cancel what is left when `cancelAtEnd`. */
  private async wait(inst: string, id: string, waitMs: number, cancelAtEnd: boolean): Promise<Part> {
    const end = Date.now() + waitMs;
    let o = await this.client.read(inst, id);
    while (!TERMINAL.includes(o.state) && Date.now() < end) {
      await new Promise((r) => setTimeout(r, cancelAtEnd ? 2000 : 500));
      o = await this.client.read(inst, id);
    }
    if (!TERMINAL.includes(o.state)) {
      await this.client.cancel(inst, id);
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 400));
        o = await this.client.read(inst, id);
        if (TERMINAL.includes(o.state)) break;
      }
      if (!cancelAtEnd && !(o.qty > 0)) throw new Error(`okx order ${id} did not fill in time and was cancelled`);
    }
    // Fees are negative. A buy pays in the coin received, a sell in the quote currency.
    const base = o.feeCcy && o.feeCcy !== this.client.quote ? -o.fee : 0;
    const quote = o.feeCcy === this.client.quote ? -o.fee : 0;
    return { qty: o.qty, avg: o.avg, feeBase: base, feeUsd: quote + base * o.avg };
  }
}
