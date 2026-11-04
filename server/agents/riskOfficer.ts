import type { Appearance, RiskDTO } from '../../shared/types';
import { Agent } from './base';
import type { EcoContext, EntryRequest, RiskGate } from './context';
import type { Trader } from './trader';

export interface FundRiskState {
  peakEquity: number;
  dayStartEquity: number;
}

export interface ReconciliationSnapshot {
  at: number;
  ok: boolean;
  issues: string[];
  broker: { symbol: string; qty: number }[];
  ledger: { symbol: string; qty: number }[];
  equityGap?: number;
}

/** Sarge. Pre-trade checks, fund-level circuit breakers, and the manual kill switch. */
export class RiskOfficer extends Agent implements RiskGate {
  halted = false;
  haltReason: string | null = null;
  cooldownUntil: number | null = null;
  blocked = 0;
  dailyReviewRequired = false;
  reconciliation: ReconciliationSnapshot | null = null;
  reconciliationReviewRequired = false;
  private reconciliationCurrent = false;
  private safeMinutes = 0;
  private pending = new Map<string, EntryRequest>();
  // Ephemeral proof: only this reservation may discount its own order revision.
  private reservationRevision = new Map<string, number>();
  orderRevision = 0;

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
    return this.checkEntry(req);
  }

  revalidateEntry(req: EntryRequest): { ok: true } | { ok: false; reason: string } {
    const reserved = this.pending.get(req.traderId);
    if (!reserved || reserved.symbol !== req.symbol || reserved.side !== req.side ||
      reserved.stopRisk !== req.stopRisk || reserved.unproven !== req.unproven) {
      return { ok: false, reason: 'entry reservation missing or changed' };
    }
    return this.checkEntry(req, true);
  }

  private checkEntry(req: EntryRequest, ownReservation = false): { ok: true } | { ok: false; reason: string } {
    const lim = this.ctx.cfg.risk;
    const deny = (reason: string) => {
      this.blocked++;
      this.addXp(3);
      return { ok: false as const, reason };
    };
    if (this.halted) return deny('trading is halted');
    if (this.traders.some(t => t.executionIntent && !(ownReservation && t.id === req.traderId &&
      t.executionIntent.kind === 'entry' && t.executionIntent.symbol === req.symbol &&
      t.executionIntent.side === (req.side === 'long' ? 'buy' : 'sell')))) return deny('unresolved execution intent; offline order review required (resume cannot clear)');
    const brokerProblem = this.brokerProblem(ownReservation && this.reservationRevision.get(req.traderId) === this.orderRevision);
    if (brokerProblem || this.reconciliationReviewRequired) return deny(brokerProblem ?? 'reconciliation requires explicit review/resume');
    this.checkDailyLoss();
    if (this.dailyReviewRequired) return deny('daily loss limit hit; explicit review/resume required');
    if (this.ctx.feed.isStale()) return deny('market data is stale');
    const equity = this.ctx.fund.equity();
    if (!(equity > 0)) return deny('fund has no equity');
    if (!(req.notional > 0) || !Number.isFinite(req.notional) || !(req.stopRisk > 0) || !Number.isFinite(req.stopRisk)) return deny('invalid planned entry risk');
    const pending = [...this.pending.values()].filter(p => !ownReservation || p.traderId !== req.traderId);
    const positions = this.traders.flatMap(t => t.wallet.position ? [t.wallet.position] : []);
    const symbolRisk = positions.filter(p => p.symbol === req.symbol).reduce((sum,p) => sum + Math.max(0, (p.stop-p.entryPrice) * (p.side === 'short' ? 1 : -1)) * p.qty, 0) + pending.filter(p => p.symbol === req.symbol).reduce((sum,p) => sum+p.stopRisk,0);
    if (symbolRisk + req.stopRisk > equity * lim.maxSymbolStopRisk) return deny('shared symbol planned stop risk cap');
    if (req.unproven && req.stopRisk > equity * lim.unprovenTradeRisk + 1e-8) return deny('unproven trade planned stop risk cap');
    // Venue exits operate on aggregate symbols; do not share ownership.
    if (positions.some(p => p.symbol === req.symbol) || pending.some(p => p.symbol === req.symbol || p.traderId === req.traderId)) return deny('symbol already held or entry pending');
    const gross = this.ctx.fund.grossExposure() + pending.reduce((sum,p) => sum+p.notional,0) + req.notional;
    if (gross > equity * lim.maxGrossExposure) return deny(`gross exposure would reach ${((gross / equity) * 100).toFixed(0)}%`);
    const sym = this.ctx.fund.symbolExposure(req.symbol) + req.notional;
    const explored = this.ctx.universe.isExplored(req.symbol);
    const symCap = explored ? lim.maxExploredSymbolExposure : lim.maxSymbolExposure;
    if (sym > equity * symCap) return deny(`${req.symbol} exposure would reach ${((sym / equity) * 100).toFixed(0)}% of the ${(symCap * 100).toFixed(0)}% cap`);
    if (explored) {
      const all = this.ctx.universe.exploredEntries().reduce((s, e) => s + this.ctx.fund.symbolExposure(e.symbol), 0) + pending.filter(p=>this.ctx.universe.isExplored(p.symbol)).reduce((sum,p)=>sum+p.notional,0) + req.notional;
      if (all > equity * lim.maxExploredExposure) return deny(`explored markets would reach ${((all / equity) * 100).toFixed(0)}% of equity`);
    }
    const room = this.ctx.universe.maxNotional(req.symbol);
    if (req.notional > room) return deny(`order $${req.notional.toFixed(0)} is too big for ${req.symbol} liquidity (cap $${room.toFixed(0)})`);
    const net = this.ctx.fund.netExposure();
    for (const p of pending) net[p.side] += p.notional;
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

  reserveEntry(req: EntryRequest): { ok: true } | { ok: false; reason: string } {
    const result = this.approveEntry(req);
    if (result.ok) {
      const wasCurrent = this.reconciliationCurrent;
      this.pending.set(req.traderId, { ...req });
      this.orderChanged();
      if (wasCurrent) this.reservationRevision.set(req.traderId, this.orderRevision);
    }
    return result;
  }

  releaseEntry(traderId: string): EntryRequest | undefined {
    const reservation = this.pending.get(traderId);
    this.pending.delete(traderId);
    this.reservationRevision.delete(traderId);
    this.orderChanged();
    return reservation;
  }

  /** Roll back an unpersisted release, without granting submission authority. */
  retainEntry(req: EntryRequest): void {
    this.pending.set(req.traderId, req);
    this.orderChanged();
  }

  orderChanged(): void { this.orderRevision++; this.reconciliationCurrent = false; }

  requireReview(reason: string): void {
    this.updateReconciliation({at:Date.now(),ok:false,issues:[reason],broker:[],ledger:[]});
    this.ctx.news('risk', `Execution requires manual review: ${reason}`, {good:false});
  }

  /** Runs on every price tick. */
  async check(): Promise<void> {
    const lim = this.ctx.cfg.risk;
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
    this.checkDailyLoss();
    if (this.ctx.feed.isStale()) {
      this.activity = 'Market data is stale, entries blocked';
      this.mood = 'sad';
    } else if (this.dailyReviewRequired || this.reconciliationReviewRequired || this.brokerProblem()) {
      this.activity = 'New entries paused; review risk diagnostics. Exits available';
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
    this.ctx.news('risk', `${this.name} pulled the kill switch: ${reason}. Flatten requested; verify fills and residual holdings`, { agentId: this.id, good: false });
    this.ctx.emit({ kind: 'halt', agentId: this.id, text: 'HALT! Kill switch!', building: 'warroom' });
    this.ctx.unlock('circuit_breaker');
    await Promise.all(this.traders.map((t) => t.flatten('kill switch')));
  }

  resume(): void {
    if (this.pending.size || this.traders.some(t => t.executionIntent)) return;
    if (this.brokerProblem() || this.ctx.feed.isStale() || !(this.ctx.fund.equity() > 0)) return;
    this.reconciliationReviewRequired = false;
    if (this.dailyReviewRequired) {
      this.dailyReviewRequired = false;
      this.cooldownUntil = null;
      this.fundState.dayStartEquity = this.ctx.fund.equity();
    }
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
    const reasons = [this.halted ? this.haltReason ?? 'halted' : null, this.dailyReviewRequired ? 'daily loss review required' : null,
      this.traders.some(t => t.executionIntent) ? 'unresolved execution intent: offline order review required; resume cannot clear' : null,
      this.reconciliationReviewRequired ? 'reconciliation review required' : null, this.brokerProblem(), this.ctx.feed.isStale() ? 'market data stale' : null].filter((r): r is string => r !== null);
    return {
      entriesPaused: reasons.length > 0,
      entryPauseReasons: reasons,
      dailyReviewRequired: this.dailyReviewRequired,
      reconciliationReviewRequired: this.reconciliationReviewRequired,
      reconciliationCurrent: this.reconciliationCurrent && !this.brokerProblem(),
      reconciliation: this.reconciliation,
      halted: this.halted,
      haltReason: this.haltReason,
      cooldownUntil: this.cooldownUntil,
      dataStale: this.ctx.feed.isStale(),
      lastDataAt: this.ctx.feed.lastUpdate,
      limits: {
        fundMaxDrawdown: lim.fundMaxDrawdown,
        traderMaxDrawdown: lim.traderMaxDrawdown,
        dailyLossLimit: lim.dailyLossLimit,
        unprovenTradeRisk: lim.unprovenTradeRisk,
        maxSymbolStopRisk: lim.maxSymbolStopRisk,
        maxGrossExposure: lim.maxGrossExposure,
        maxSymbolExposure: lim.maxSymbolExposure,
      },
      netLong: net.long / eq,
      netShort: net.short / eq,
    };
  }

  stats(): Record<string, string | number> {
    return {
      Status: this.halted ? 'HALTED' : this.toRiskDTO().entriesPaused ? 'Entry review pause' : 'Armed',
      'Entries blocked': this.blocked,
      'Fund DD limit': `${(this.ctx.cfg.risk.fundMaxDrawdown * 100).toFixed(0)}%`,
      'Daily loss limit': `${(this.ctx.cfg.risk.dailyLossLimit * 100).toFixed(0)}%`,
    };
  }

  protected saveExtra(): unknown {
    return { pending: [...this.pending.values()], halted: this.halted, haltReason: this.haltReason, cooldownUntil: this.cooldownUntil, blocked: this.blocked, dailyReviewRequired: this.dailyReviewRequired, reconciliationReviewRequired: this.reconciliationReviewRequired, reconciliation: this.reconciliation };
  }

  protected restoreExtra(extra: unknown): void {
    const e = extra as Partial<{ halted: boolean; haltReason: string | null; cooldownUntil: number | null; blocked: number; dailyReviewRequired: boolean; reconciliationReviewRequired: boolean; reconciliation: ReconciliationSnapshot }>;
    this.halted = e.halted === true;
    this.pending = new Map(((extra as {pending?:EntryRequest[]}).pending ?? []).map(p => [p.traderId,p]));
    this.haltReason = typeof e.haltReason === 'string' ? e.haltReason : null;
    this.cooldownUntil = typeof e.cooldownUntil === 'number' ? e.cooldownUntil : null;
    this.dailyReviewRequired = e.dailyReviewRequired === true || this.cooldownUntil !== null;
    this.reconciliationReviewRequired = e.reconciliationReviewRequired === true || this.pending.size > 0;
    this.reconciliation = e.reconciliation ?? null;
    this.reconciliationCurrent = false; // saved diagnostics are never proof of current broker state
    this.blocked = Number(e.blocked) || 0;
  }

  checkDailyLoss(): void {
    if (this.fundState.dayStartEquity > 0 && this.ctx.fund.equity() <= this.fundState.dayStartEquity * (1 - this.ctx.cfg.risk.dailyLossLimit)) {
      if (!this.dailyReviewRequired) this.ctx.news('risk', 'Daily loss limit hit: new entries paused until explicit review/resume; exits remain available', { good: false });
      this.dailyReviewRequired = true;
    }
  }

  updateReconciliation(snapshot: ReconciliationSnapshot): void {
    this.reconciliation = snapshot;
    this.reconciliationCurrent = true;
    if (!snapshot.ok) this.reconciliationReviewRequired = true;
  }

  private brokerProblem(ownReservationRevision = false): string | null {
    if (this.ctx.cfg.execution === 'paper') return null;
    if (!this.reconciliation || (!this.reconciliationCurrent && !ownReservationRevision)) return 'broker reconciliation unavailable; fresh read required';
    if (!this.reconciliation.ok) return 'broker reconciliation failed: ' + this.reconciliation.issues.join('; ');
    const age = Date.now() - this.reconciliation.at;
    if (age < 0 || age > 180_000) return 'broker reconciliation stale';
    return null;
  }
}
