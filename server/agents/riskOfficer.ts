import type { Appearance, RiskDTO } from '../../shared/types';
import { Agent } from './base';
import type { EcoContext, EntryRequest, RiskGate } from './context';
import type { Trader } from './trader';

export interface FundRiskState {
  peakEquity: number;
  dayStartEquity: number;
}

function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** Sarge. Pre-trade checks, fund-level circuit breakers, and the manual kill switch. */
export class RiskOfficer extends Agent implements RiskGate {
  halted = false;
  haltReason: string | null = null;
  cooldownUntil: number | null = null;
  blocked = 0;
  private safeMinutes = 0;

  constructor(
    ctx: EcoContext,
    id: string,
    name: string,
    appearance: Appearance,
    private traders: Trader[],
    private fundState: FundRiskState,
  ) {
    super(ctx, id, name, 'risk', 'Risk Officer', 'warroom', appearance);
    this.activity = 'Inspecting the circuit breakers';
  }

  approveEntry(req: EntryRequest): { ok: true } | { ok: false; reason: string } {
    const lim = this.ctx.cfg.risk;
    const deny = (reason: string) => {
      this.blocked++;
      this.addXp(3);
      return { ok: false as const, reason };
    };
    if (this.halted) return deny('trading is halted');
    if (this.cooldownUntil && Date.now() < this.cooldownUntil) return deny('daily loss limit hit, cooling down');
    if (this.ctx.feed.isStale()) return deny('market data is stale');
    const equity = this.ctx.fund.equity();
    if (!(equity > 0)) return deny('fund has no equity');
    const gross = this.ctx.fund.grossExposure() + req.notional;
    if (gross > equity * lim.maxGrossExposure) return deny(`gross exposure would reach ${((gross / equity) * 100).toFixed(0)}%`);
    const sym = this.ctx.fund.symbolExposure(req.symbol) + req.notional;
    const explored = this.ctx.universe.isExplored(req.symbol);
    const symCap = explored ? lim.maxExploredSymbolExposure : lim.maxSymbolExposure;
    if (sym > equity * symCap) return deny(`${req.symbol} exposure would reach ${((sym / equity) * 100).toFixed(0)}% of the ${(symCap * 100).toFixed(0)}% cap`);
    if (explored) {
      const all = this.ctx.universe.exploredEntries().reduce((s, e) => s + this.ctx.fund.symbolExposure(e.symbol), 0) + req.notional;
      if (all > equity * lim.maxExploredExposure) return deny(`explored markets would reach ${((all / equity) * 100).toFixed(0)}% of equity`);
    }
    const room = this.ctx.universe.maxNotional(req.symbol);
    if (req.notional > room) return deny(`order $${req.notional.toFixed(0)} is too big for ${req.symbol} liquidity (cap $${room.toFixed(0)})`);
    const net = this.ctx.fund.netExposure();
    if (req.side === 'long' && net.long + req.notional > equity * lim.maxNetLong) {
      return deny(`net long would reach ${(((net.long + req.notional) / equity) * 100).toFixed(0)}% of the ${(lim.maxNetLong * 100).toFixed(0)}% cap`);
    }
    if (req.side === 'short' && net.short + req.notional > equity * lim.maxNetShort) {
      return deny(`net short would reach ${(((net.short + req.notional) / equity) * 100).toFixed(0)}% of the ${(lim.maxNetShort * 100).toFixed(0)}% cap`);
    }
    // Don't fight the news: block a long into strongly bearish news and vice versa.
    const bias = this.ctx.board.bias(req.symbol);
    if (bias.strength > 0.4) {
      if (req.side === 'long' && bias.score < -0.5) return deny(`strong bearish news on ${req.symbol}`);
      if (req.side === 'short' && bias.score > 0.5) return deny(`strong bullish news on ${req.symbol}`);
    }
    return { ok: true };
  }

  /** Runs on every price tick. */
  async check(): Promise<void> {
    const lim = this.ctx.cfg.risk;
    const now = Date.now();
    const equity = this.ctx.fund.equity();
    if (equity > this.fundState.peakEquity) this.fundState.peakEquity = equity;
    if (this.halted) {
      this.activity = `HALTED: ${this.haltReason}`;
      this.mood = 'sad';
      return;
    }
    const dd = 1 - equity / this.fundState.peakEquity;
    if (dd > lim.fundMaxDrawdown) {
      await this.halt(`fund drawdown ${(dd * 100).toFixed(1)}% exceeded ${(lim.fundMaxDrawdown * 100).toFixed(0)}% limit`);
      return;
    }
    if (this.cooldownUntil && now >= this.cooldownUntil) {
      this.cooldownUntil = null;
      this.ctx.news('risk', `${this.name}: new trading day, daily loss cooldown lifted`, { agentId: this.id, good: true });
    }
    const dayLoss = 1 - equity / this.fundState.dayStartEquity;
    if (!this.cooldownUntil && dayLoss > lim.dailyLossLimit) {
      this.cooldownUntil = nextUtcMidnight(now);
      this.ctx.news('risk', `${this.name}: fund is down ${(dayLoss * 100).toFixed(1)}% today. No new entries until UTC midnight`, { agentId: this.id, good: false });
      this.ctx.emit({ kind: 'halt', agentId: this.id, text: 'Daily loss limit!', building: 'warroom' });
    }
    if (this.ctx.feed.isStale()) {
      this.activity = 'Market data is stale, entries blocked';
      this.mood = 'sad';
    } else if (this.cooldownUntil) {
      this.activity = 'Daily loss cooldown in effect';
      this.mood = 'sad';
    } else {
      this.activity = `Watching risk: drawdown ${(dd * 100).toFixed(1)}%, exposure ${((this.ctx.fund.grossExposure() / equity) * 100).toFixed(0)}%`;
      this.mood = 'neutral';
    }
  }

  minuteTick(): void {
    if (!this.halted) {
      this.safeMinutes++;
      if (this.safeMinutes % 60 === 0) this.addXp(2);
    }
  }

  async halt(reason: string): Promise<void> {
    if (this.halted) return;
    this.halted = true;
    this.haltReason = reason;
    this.mood = 'sad';
    this.activity = `HALTED: ${reason}`;
    this.addXp(20);
    this.ctx.news('risk', `${this.name} pulled the kill switch: ${reason}. All positions flattened`, { agentId: this.id, good: false });
    this.ctx.emit({ kind: 'halt', agentId: this.id, text: 'HALT! Kill switch!', building: 'warroom' });
    this.ctx.unlock('circuit_breaker');
    await Promise.all(this.traders.map((t) => t.flatten('kill switch')));
  }

  resume(): void {
    if (!this.halted) return;
    this.halted = false;
    this.haltReason = null;
    // Reset the high-water mark, otherwise the same drawdown would re-trigger immediately.
    this.fundState.peakEquity = this.ctx.fund.equity();
    this.ctx.news('risk', `${this.name}: kill switch released, trading resumes with a fresh high-water mark`, { agentId: this.id, good: true });
    this.ctx.emit({ kind: 'resume', agentId: this.id, text: 'All clear!', building: 'warroom' });
  }

  toRiskDTO(): RiskDTO {
    const lim = this.ctx.cfg.risk;
    const eq = Math.max(1, this.ctx.fund.equity());
    const net = this.ctx.fund.netExposure();
    return {
      halted: this.halted,
      haltReason: this.haltReason,
      cooldownUntil: this.cooldownUntil,
      dataStale: this.ctx.feed.isStale(),
      lastDataAt: this.ctx.feed.lastUpdate,
      limits: {
        fundMaxDrawdown: lim.fundMaxDrawdown,
        traderMaxDrawdown: lim.traderMaxDrawdown,
        dailyLossLimit: lim.dailyLossLimit,
        maxGrossExposure: lim.maxGrossExposure,
        maxSymbolExposure: lim.maxSymbolExposure,
      },
      netLong: net.long / eq,
      netShort: net.short / eq,
    };
  }

  stats(): Record<string, string | number> {
    return {
      Status: this.halted ? 'HALTED' : this.cooldownUntil ? 'Cooldown' : 'Armed',
      'Entries blocked': this.blocked,
      'Fund DD limit': `${(this.ctx.cfg.risk.fundMaxDrawdown * 100).toFixed(0)}%`,
      'Daily loss limit': `${(this.ctx.cfg.risk.dailyLossLimit * 100).toFixed(0)}%`,
    };
  }

  protected saveExtra(): unknown {
    return { halted: this.halted, haltReason: this.haltReason, cooldownUntil: this.cooldownUntil, blocked: this.blocked };
  }

  protected restoreExtra(extra: unknown): void {
    const e = extra as Partial<{ halted: boolean; haltReason: string | null; cooldownUntil: number | null; blocked: number }>;
    this.halted = e.halted === true;
    this.haltReason = typeof e.haltReason === 'string' ? e.haltReason : null;
    this.cooldownUntil = typeof e.cooldownUntil === 'number' ? e.cooldownUntil : null;
    this.blocked = Number(e.blocked) || 0;
  }
}
