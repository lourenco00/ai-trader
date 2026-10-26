import type { Appearance } from '../../shared/types';
import type { StrategyRecord } from '../strategy/vault';
import { Agent } from './base';
import type { EcoContext } from './context';
import { pct, validate } from './researcher';
import type { Trader } from './trader';

export interface Treasury {
  reserve: number;
}

const EPITAPHS = [
  'It bought the top. Twice.',
  'Fees ate it alive.',
  'Great in backtest. Shy in real life.',
  'Overfit, but with style.',
  'Tried to catch a falling knife.',
  'Chased every breakout, caught none.',
  'Mean reverted into the ground.',
  'The trend was not its friend.',
  'Gone, but its stop loss was respected.',
  'Never met a whipsaw it did not like.',
];

/**
 * Capital allocator. Hands Vault strategies to idle traders, sizes their wallets
 * by live performance, and retires strategies that stop earning their keep.
 */
export class Commander extends Agent {
  private lastRebalance = 0;
  private lastRevalidate = 0;
  rebalances = 0;
  hires = 0;
  retirements = 0;

  constructor(
    ctx: EcoContext,
    id: string,
    name: string,
    appearance: Appearance,
    private traders: Trader[],
    private treasury: Treasury,
  ) {
    super(ctx, id, name, 'commander', 'Fund Commander', 'command', appearance);
    this.activity = 'Reviewing the battle plan';
  }

  private baseFraction(): number {
    const a = this.ctx.cfg.allocation;
    return (1 - a.reserveFraction) / Math.max(1, this.traders.length);
  }

  /** Called every minute. Cheap checks first, rebalance hourly. */
  async tick(): Promise<void> {
    if (this.ctx.risk.halted) {
      this.activity = 'Trading halted. Waiting for the all-clear';
      this.mood = 'sad';
      return;
    }
    await this.review();
    this.assignIdle();
    this.upgradeUntested();
    const now = Date.now();
    if (now - this.lastRebalance >= this.ctx.cfg.allocation.rebalanceEveryMs) {
      this.lastRebalance = now;
      this.rebalance();
    }
    if (now - this.lastRevalidate >= 6 * 3_600_000) {
      this.lastRevalidate = now;
      this.revalidateVault();
    }
    const active = this.traders.filter((t) => t.strategy).length;
    this.activity = `Commanding ${active}/${this.traders.length} traders, ${this.ctx.vault.byStatus('vault').length} strategies in reserve`;
    this.mood = 'neutral';
  }

  assignIdle(): void {
    if (this.ctx.risk.halted) return;
    for (const t of this.traders) {
      if (t.strategy) continue;
      const activeSymbols = this.traders.filter((x) => x.strategy).map((x) => x.strategy!.symbol);
      const maxPerSymbol = Math.max(1, Math.ceil(this.traders.length / this.ctx.cfg.symbols.length));
      const s = this.ctx.vault.bestAvailable(activeSymbols, maxPerSymbol);
      if (!s) return;
      this.ctx.vault.assign(s.id, t.id);
      t.assign(s);
      const target = this.ctx.fund.equity() * this.baseFraction() * 0.5; // probation size
      const amount = Math.min(target, this.treasury.reserve - this.minReserve());
      if (amount > 0) {
        this.treasury.reserve -= amount;
        t.deposit(amount);
        // Reset NAV baseline after the first deposit so returns start at zero.
        t.navAtAssign = t.nav();
      }
      this.hires++;
      this.addXp(10);
      this.ctx.news('allocation', `${this.name} handed "${s.name}" (${s.symbol}) to ${t.name} with $${amount.toFixed(0)} on probation`, { agentId: this.id });
      this.ctx.emit({ kind: 'assign', agentId: t.id, text: `New strategy: ${s.name}`, building: 'vault' });
    }
  }

  /**
   * A trader whose strategy has not traded yet can swap it for a clearly better
   * one on the same coin. Nothing is lost: the old strategy goes back on the shelf.
   * At most one swap per tick keeps it calm.
   */
  upgradeUntested(): void {
    if (this.ctx.risk.halted) return;
    const waiting = this.ctx.vault.byStatus('vault');
    for (const t of this.traders) {
      const cur = t.strategy;
      if (!cur || t.wallet.position || cur.live.trades > 0) continue;
      const better = waiting
        .filter((s) => s.symbol === cur.symbol && s.fitness > cur.fitness + 0.5)
        .sort((a, b) => b.fitness - a.fitness)[0];
      if (!better) continue;
      this.ctx.vault.shelve(cur.id);
      this.ctx.vault.assign(better.id, t.id);
      const nav = t.navAtAssign;
      t.assign(better);
      t.navAtAssign = nav;
      this.addXp(5);
      this.ctx.news('allocation', `${this.name} swapped ${t.name}'s untested "${cur.name}" for the stronger "${better.name}" (${better.symbol})`, { agentId: this.id });
      this.ctx.emit({ kind: 'assign', agentId: t.id, text: `Upgrade: ${better.name}`, building: 'vault' });
      return;
    }
  }

  private minReserve(): number {
    return this.ctx.fund.equity() * this.ctx.cfg.allocation.reserveFraction * 0.5;
  }

  /** Score-weighted allocation. Only flat traders are resized so open positions keep their margin. */
  rebalance(): void {
    const a = this.ctx.cfg.allocation;
    const equity = this.ctx.fund.equity();
    const base = this.baseFraction();
    let moved = 0;
    for (const t of this.traders) {
      if (!t.strategy || t.wallet.position) continue;
      const live = t.strategy.live;
      let fraction: number;
      if (live.trades < a.probationTrades) {
        fraction = base * 0.5;
      } else {
        const ret = t.navSinceAssign() - 1;
        fraction = base * Math.max(0.25, Math.min(2, 1 + ret * 10));
      }
      fraction = Math.min(a.maxTraderFraction, Math.max(a.minTraderFraction, fraction));
      const target = equity * fraction;
      const current = t.equity();
      const delta = target - current;
      if (Math.abs(delta) < target * 0.1) continue;
      if (delta > 0) {
        const amount = Math.min(delta, this.treasury.reserve - this.minReserve());
        if (amount <= 1) continue;
        this.treasury.reserve -= amount;
        t.deposit(amount);
        moved += amount;
      } else {
        const got = t.withdraw(-delta);
        this.treasury.reserve += got;
        moved += got;
      }
    }
    this.rebalances++;
    this.addXp(5);
    if (moved > 1) {
      this.ctx.news('allocation', `${this.name} rebalanced $${moved.toFixed(0)} across the trading floor`, { agentId: this.id });
      this.ctx.emit({ kind: 'rebalance', agentId: this.id, text: 'Rebalancing!', building: 'markets' });
    }
  }

  /** Retirement rules, judged on live paper results since the strategy was handed out. */
  async review(): Promise<void> {
    const r = this.ctx.cfg.retirement;
    const maxDd = this.ctx.cfg.risk.traderMaxDrawdown;
    for (const t of this.traders) {
      const s = t.strategy;
      if (!s) continue;
      const live = s.live;
      const pf = live.grossLoss > 0 ? live.grossWin / live.grossLoss : live.grossWin > 0 ? 99 : 0;
      const idleMs = Date.now() - (live.lastTradeAt ?? t.assignedAt);
      let reason: string | null = null;
      if (t.drawdownSinceAssign() > maxDd) reason = `drawdown ${pct(-t.drawdownSinceAssign())} breached the ${pct(-maxDd)} limit`;
      else if (live.trades >= r.minTradesForJudgement && t.navSinceAssign() < r.navFloor) reason = `lost ${pct(t.navSinceAssign() - 1)} on probation`;
      else if (live.trades >= 15 && pf < r.minProfitFactorAfter15) reason = `profit factor ${pf.toFixed(2)} after ${live.trades} trades`;
      else if (!t.wallet.position && idleMs > r.idleDays * 86_400_000) reason = `no trades for ${r.idleDays} days`;
      if (reason) await this.retire(t, reason);
    }
  }

  async retire(t: Trader, reason: string): Promise<void> {
    const s = t.strategy;
    if (!s) return;
    await t.flatten(`retired: ${reason}`);
    const epitaph = EPITAPHS[Math.floor(Math.random() * EPITAPHS.length)];
    this.ctx.vault.retire(s.id, reason, epitaph);
    const back = t.withdraw(t.wallet.cash);
    this.treasury.reserve += back;
    t.unassign();
    this.retirements++;
    this.addXp(8);
    this.ctx.news('retire', `${this.name} retired "${s.name}" from ${t.name}: ${reason}. Live P&L $${s.live.pnl.toFixed(2)} over ${s.live.trades} trades`, { agentId: this.id, good: false });
    this.ctx.emit({ kind: 'retire', agentId: t.id, text: `RIP ${s.name}`, building: 'graveyard' });
    this.ctx.unlock('funeral');
  }

  /** Re-test waiting strategies on fresh data; drop the ones whose edge faded. */
  revalidateVault(): void {
    const waiting = this.ctx.vault.byStatus('vault').filter((s) => Date.now() - s.createdAt > 6 * 3_600_000);
    let dropped: StrategyRecord[] = [];
    for (const s of waiting) {
      const data = this.ctx.dataset(s.symbol);
      if (!data) continue;
      const v = validate(this.ctx, data, s.genome);
      this.ctx.countEvaluated(1);
      if (v.passed) {
        s.test = v.test;
        s.train = v.train;
        s.fitness = v.fitness;
      } else {
        this.ctx.vault.remove(s.id);
        dropped = [...dropped, s];
      }
    }
    if (dropped.length) {
      this.ctx.news('allocation', `${this.name} archived ${dropped.length} stale strateg${dropped.length === 1 ? 'y' : 'ies'} that failed re-testing on fresh data`, { agentId: this.id });
    }
  }

  stats(): Record<string, string | number> {
    return {
      'Strategies handed out': this.hires,
      Rebalances: this.rebalances,
      Retirements: this.retirements,
      'Cash reserve': `$${this.treasury.reserve.toFixed(2)}`,
    };
  }

  protected saveExtra(): unknown {
    return { rebalances: this.rebalances, hires: this.hires, retirements: this.retirements, lastRebalance: this.lastRebalance };
  }

  protected restoreExtra(extra: unknown): void {
    const e = extra as Partial<{ rebalances: number; hires: number; retirements: number; lastRebalance: number }>;
    this.rebalances = Number(e.rebalances) || 0;
    this.hires = Number(e.hires) || 0;
    this.retirements = Number(e.retirements) || 0;
    this.lastRebalance = Number(e.lastRebalance) || 0;
  }
}
