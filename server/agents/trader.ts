import type { Appearance, PositionDTO, Side, TradeDTO, TraderDTO } from '../../shared/types';
import { compile } from '../strategy/engine';
import { warmupBars } from '../strategy/genome';
import { IndicatorCache } from '../strategy/indicators';
import type { StrategyRecord } from '../strategy/vault';
import { logger } from '../util/log';
import { shortId } from '../util/rng';
import { Agent } from './base';
import type { EcoContext } from './context';

const log = logger('trader');

export interface Position {
  symbol: string;
  side: Side;
  qty: number;
  entryPrice: number;
  entryTime: number;
  entryFee: number;
  stop: number;
  takeProfit: number | null;
  extreme: number;
  barsHeld: number;
  strategyId: string;
}

/**
 * Wallet uses a 1x margin model for both longs and shorts: cash only moves by
 * realised PnL and fees, and position notional at entry never exceeds cash.
 * `units` track deposits/withdrawals so NAV (equity per unit) measures skill,
 * not capital moves.
 */
export interface Wallet {
  cash: number;
  units: number;
  position: Position | null;
}

const MIN_NOTIONAL = 10;

export class Trader extends Agent {
  wallet: Wallet = { cash: 0, units: 0, position: null };
  strategy: StrategyRecord | null = null;
  assignedAt = 0;
  navAtAssign = 1;
  peakNav = 1;
  trades = 0;
  wins = 0;
  streak = 0;
  private queue: Promise<void> = Promise.resolve();
  private lastBlockedBar = 0;

  constructor(ctx: EcoContext, id: string, name: string, appearance: Appearance) {
    super(ctx, id, name, 'trader', 'Trader', 'markets', appearance);
    this.activity = 'Waiting for a strategy from the Vault';
  }

  /** Serialise all wallet mutations; ticks, candles and commands can arrive concurrently. */
  private run(fn: () => Promise<void> | void): Promise<void> {
    const next = this.queue.then(fn).catch((err) => log.error(`${this.name}: action failed`, err));
    this.queue = next;
    return next;
  }

  markPrice(): number | null {
    const p = this.wallet.position;
    if (!p) return null;
    return this.ctx.feed.price(p.symbol) ?? p.entryPrice;
  }

  unrealized(): number {
    const p = this.wallet.position;
    if (!p) return 0;
    const mark = this.markPrice() ?? p.entryPrice;
    return (mark - p.entryPrice) * p.qty * (p.side === 'long' ? 1 : -1);
  }

  equity(): number {
    return this.wallet.cash + this.unrealized();
  }

  nav(): number {
    return this.wallet.units > 0 ? this.equity() / this.wallet.units : 1;
  }

  /** Nav relative to when the current strategy was assigned. */
  navSinceAssign(): number {
    return this.navAtAssign > 0 ? this.nav() / this.navAtAssign : 1;
  }

  drawdownSinceAssign(): number {
    const rel = this.navSinceAssign();
    return Math.max(0, 1 - rel / Math.max(this.peakNav, 1e-9));
  }

  notional(): number {
    const p = this.wallet.position;
    if (!p) return 0;
    return Math.abs(p.qty * (this.markPrice() ?? p.entryPrice));
  }

  deposit(amount: number): void {
    if (!(amount > 0)) return;
    const nav = this.nav();
    this.wallet.units += amount / nav;
    this.wallet.cash += amount;
  }

  /** Withdraw free cash. Only allowed while flat so margin is never touched. */
  withdraw(amount: number): number {
    if (this.wallet.position) return 0;
    const amt = Math.min(amount, this.wallet.cash);
    if (!(amt > 0)) return 0;
    const nav = this.nav();
    this.wallet.units = Math.max(0, this.wallet.units - amt / nav);
    this.wallet.cash -= amt;
    if (this.wallet.cash < 1e-6) {
      this.wallet.cash = 0;
      this.wallet.units = 0;
    }
    return amt;
  }

  assign(s: StrategyRecord): void {
    this.strategy = s;
    this.assignedAt = Date.now();
    this.navAtAssign = this.nav();
    this.peakNav = 1;
    this.activity = `Studying ${s.name} (${s.symbol})`;
    this.mood = 'happy';
  }

  unassign(): void {
    this.strategy = null;
    this.activity = 'Waiting for a strategy from the Vault';
    this.mood = 'neutral';
  }

  onCandle(symbol: string): Promise<void> {
    return this.run(() => this.handleCandle(symbol));
  }

  onTick(): Promise<void> {
    return this.run(() => this.handleTick());
  }

  flatten(reason: string): Promise<void> {
    return this.run(async () => {
      const p = this.wallet.position;
      if (!p) return;
      await this.close(this.ctx.feed.price(p.symbol) ?? p.entryPrice, reason);
    });
  }

  private async handleCandle(symbol: string): Promise<void> {
    const s = this.strategy;
    if (!s || s.symbol !== symbol) return;
    const g = s.genome;
    const series = this.ctx.feed.series(symbol);
    const need = Math.max(600, warmupBars(g) * 2);
    if (series.length < warmupBars(g) + 2) return;
    const window = series.slice(-need);
    const cache = new IndicatorCache(window, 64);
    const strat = compile(cache, g);
    const i = window.length - 1;
    const bar = window[i];
    const atr = strat.atr[i];
    const price = this.ctx.feed.price(symbol) ?? bar.c;
    const p = this.wallet.position;

    if (p) {
      p.barsHeld++;
      const long = p.side === 'long';
      p.extreme = long ? Math.max(p.extreme, bar.h) : Math.min(p.extreme, bar.l);
      if (g.trailAtr > 0 && atr > 0) {
        const trail = p.extreme - (long ? 1 : -1) * g.trailAtr * atr;
        p.stop = long ? Math.max(p.stop, trail) : Math.min(p.stop, trail);
      }
      if (p.barsHeld >= g.maxBars) await this.close(price, 'time limit');
      else if (strat.exit(i)) await this.close(price, 'exit signal');
      else this.activity = `${p.side.toUpperCase()} ${p.symbol} ${fmtPct(this.unrealized() / (p.qty * p.entryPrice))} (bar ${p.barsHeld}/${g.maxBars})`;
      return;
    }

    if (!strat.entry(i)) {
      this.activity = `Watching ${symbol} with ${s.name}`;
      this.mood = 'neutral';
      return;
    }
    if (!(atr > 0)) return;
    await this.open(s, price, atr, bar.t);
  }

  private async open(s: StrategyRecord, price: number, atr: number, barT: number): Promise<void> {
    const g = s.genome;
    if (!this.ctx.marketOpen(s.symbol)) {
      this.activity = `${s.symbol} market is closed; waiting for the open`;
      this.mood = 'sleeping';
      return;
    }
    // Leave headroom for fees and slippage so margin never exceeds cash (1x).
    const notional = this.wallet.cash * Math.min(g.sizePct, 0.99);
    if (notional < MIN_NOTIONAL) {
      this.activity = 'Signal fired but my wallet is empty';
      return;
    }
    const verdict = this.ctx.risk.approveEntry({ traderId: this.id, symbol: s.symbol, notional, side: g.side });
    if (!verdict.ok) {
      this.activity = `Entry blocked: ${verdict.reason}`;
      this.mood = 'sad';
      if (this.lastBlockedBar !== barT) {
        this.lastBlockedBar = barT;
        this.ctx.news('risk', `Sarge blocked ${this.name}'s ${g.side} ${s.symbol} entry: ${verdict.reason}`, { agentId: this.id });
      }
      return;
    }
    const long = g.side === 'long';
    let fill;
    try {
      fill = await this.ctx.broker.marketOrder({
        symbol: s.symbol,
        side: long ? 'buy' : 'sell',
        qty: notional / price,
        refPrice: price,
      });
    } catch (err) {
      // A resting entry that never filled is not an error: the price ran away and we stay flat.
      if (/not filled|spread too wide/.test((err as Error).message)) {
        this.activity = `${s.symbol} entry skipped: ${(err as Error).message.slice(0, 60)}`;
        this.mood = 'neutral';
        return;
      }
      throw err;
    }
    const dir = long ? 1 : -1;
    this.wallet.cash -= fill.fee;
    this.wallet.position = {
      symbol: s.symbol,
      side: g.side,
      qty: fill.qty,
      entryPrice: fill.price,
      entryTime: fill.time,
      entryFee: fill.fee,
      stop: fill.price - dir * g.stopAtr * atr,
      takeProfit: g.takeProfitAtr > 0 ? fill.price + dir * g.takeProfitAtr * atr : null,
      extreme: fill.price,
      barsHeld: 0,
      strategyId: s.id,
    };
    this.addXp(5);
    this.mood = 'excited';
    this.activity = `Opened ${g.side.toUpperCase()} ${s.symbol} @ ${fmtPrice(fill.price)}`;
    this.ctx.news('trade', `${this.name} went ${g.side.toUpperCase()} ${s.symbol} @ ${fmtPrice(fill.price)} ($${(fill.qty * fill.price).toFixed(0)}) using ${s.name}`, { agentId: this.id });
    this.ctx.emit({ kind: 'trade_open', agentId: this.id, text: `${g.side.toUpperCase()} ${s.symbol}!`, building: 'markets' });
    this.ctx.unlock('first_trade');
  }

  private async handleTick(): Promise<void> {
    const p = this.wallet.position;
    if (!p) return;
    const price = this.ctx.feed.price(p.symbol);
    if (price === undefined) return;
    // A stock order sent after the bell would sit until the next open; stops resume then.
    if (!this.ctx.marketOpen(p.symbol)) return;
    const long = p.side === 'long';
    if (long ? price <= p.stop : price >= p.stop) {
      await this.close(price, p.stop === p.entryPrice ? 'breakeven stop' : 'stop loss');
      return;
    }
    if (p.takeProfit !== null && (long ? price >= p.takeProfit : price <= p.takeProfit)) {
      await this.close(price, 'take profit');
      return;
    }
    if (this.equity() <= 0) {
      await this.close(price, 'liquidated');
      return;
    }
    const rel = this.navSinceAssign();
    if (rel > this.peakNav) this.peakNav = rel;
    this.activity = `${p.side.toUpperCase()} ${p.symbol} ${fmtPct(this.unrealized() / (p.qty * p.entryPrice))}`;
    this.mood = this.unrealized() >= 0 ? 'happy' : 'sad';
  }

  private async close(price: number, reason: string): Promise<void> {
    const p = this.wallet.position;
    if (!p) return;
    const long = p.side === 'long';
    // Only calm exits may rest as limit orders; anything else (stops, kill switch, retirement) leaves immediately.
    const urgent = !['take profit', 'exit signal', 'time limit'].includes(reason);
    const fill = await this.ctx.broker.marketOrder({ symbol: p.symbol, side: long ? 'sell' : 'buy', qty: p.qty, refPrice: price, closing: true, urgent });
    const gross = (fill.price - p.entryPrice) * p.qty * (long ? 1 : -1);
    this.wallet.cash += gross - fill.fee;
    this.wallet.position = null;
    const net = gross - fill.fee - p.entryFee;
    const s = this.strategy && this.strategy.id === p.strategyId ? this.strategy : this.ctx.vault.get(p.strategyId);

    const trade: TradeDTO = {
      id: shortId('t_'),
      traderId: this.id,
      traderName: this.name,
      strategyId: p.strategyId,
      strategyName: s?.name ?? 'unknown',
      symbol: p.symbol,
      side: p.side,
      qty: p.qty,
      entryPrice: p.entryPrice,
      exitPrice: fill.price,
      entryTime: p.entryTime,
      exitTime: fill.time,
      pnl: net,
      pnlPct: net / (p.qty * p.entryPrice),
      fees: fill.fee + p.entryFee,
      reason,
    };

    if (s) {
      s.live.trades++;
      s.live.pnl += net;
      s.live.lastTradeAt = fill.time;
      if (net > 0) {
        s.live.wins++;
        s.live.grossWin += net;
      } else {
        s.live.grossLoss -= net;
      }
    }
    this.trades++;
    if (net > 0) {
      this.wins++;
      this.streak = this.streak > 0 ? this.streak + 1 : 1;
      this.addXp(10 + Math.min(200, trade.pnlPct * 2000));
      this.mood = 'excited';
    } else {
      this.streak = this.streak < 0 ? this.streak - 1 : -1;
      this.addXp(4);
      this.mood = 'sad';
    }
    const rel = this.navSinceAssign();
    if (rel > this.peakNav) this.peakNav = rel;
    this.activity = `Closed ${p.symbol} ${reason}: ${net >= 0 ? '+' : '-'}$${Math.abs(net).toFixed(2)}`;
    this.ctx.recordTrade(trade);
    this.ctx.emit({
      kind: 'trade_close',
      agentId: this.id,
      text: `${net >= 0 ? '+' : '-'}$${Math.abs(net).toFixed(2)}`,
      value: net,
      building: 'markets',
    });
  }

  positionDTO(): PositionDTO | null {
    const p = this.wallet.position;
    if (!p) return null;
    const mark = this.markPrice() ?? p.entryPrice;
    const u = this.unrealized();
    return {
      symbol: p.symbol,
      side: p.side,
      qty: p.qty,
      entryPrice: p.entryPrice,
      entryTime: p.entryTime,
      stop: p.stop,
      takeProfit: p.takeProfit,
      markPrice: mark,
      unrealizedPnl: u,
      unrealizedPct: u / (p.qty * p.entryPrice),
      barsHeld: p.barsHeld,
    };
  }

  toTraderDTO(fundEquity: number, halted: boolean): TraderDTO {
    const eq = this.equity();
    return {
      agentId: this.id,
      name: this.name,
      strategyId: this.strategy?.id ?? null,
      strategyName: this.strategy?.name ?? null,
      symbol: this.strategy?.symbol ?? null,
      equity: eq,
      cash: this.wallet.cash,
      nav: this.nav(),
      allocationPct: fundEquity > 0 ? eq / fundEquity : 0,
      position: this.positionDTO(),
      trades: this.trades,
      wins: this.wins,
      streak: this.streak,
      status: halted ? 'halted' : this.wallet.position ? 'in-trade' : this.strategy ? 'watching' : 'idle',
    };
  }

  stats(): Record<string, string | number> {
    return {
      Strategy: this.strategy ? `${this.strategy.name} (${this.strategy.symbol})` : 'none',
      Wallet: `$${this.equity().toFixed(2)}`,
      'NAV since hire': fmtPct(this.navSinceAssign() - 1),
      Trades: this.trades,
      'Win rate': this.trades ? `${Math.round((this.wins / this.trades) * 100)}%` : '-',
      Streak: this.streak,
    };
  }

  protected saveExtra(): unknown {
    return {
      wallet: this.wallet,
      strategyId: this.strategy?.id ?? null,
      assignedAt: this.assignedAt,
      navAtAssign: this.navAtAssign,
      peakNav: this.peakNav,
      trades: this.trades,
      wins: this.wins,
      streak: this.streak,
    };
  }

  protected restoreExtra(extra: unknown): void {
    const e = extra as Partial<{
      wallet: Wallet;
      strategyId: string | null;
      assignedAt: number;
      navAtAssign: number;
      peakNav: number;
      trades: number;
      wins: number;
      streak: number;
    }>;
    if (e.wallet && Number.isFinite(e.wallet.cash)) this.wallet = e.wallet;
    if (e.strategyId) {
      const s = this.ctx.vault.get(e.strategyId);
      if (s && s.status === 'active') this.strategy = s;
    }
    this.assignedAt = Number(e.assignedAt) || 0;
    this.navAtAssign = Number(e.navAtAssign) || 1;
    this.peakNav = Number(e.peakNav) || 1;
    this.trades = Number(e.trades) || 0;
    this.wins = Number(e.wins) || 0;
    this.streak = Number(e.streak) || 0;
    if (this.strategy) this.activity = `Back on duty with ${this.strategy.name}`;
  }
}

export function fmtPct(x: number): string {
  return `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;
}

export function fmtPrice(p: number): string {
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (p >= 1) return p.toFixed(2);
  return p.toPrecision(4);
}
