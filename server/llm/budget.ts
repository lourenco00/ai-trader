import { randomUUID } from 'node:crypto';
import type { LlmUsage } from './client';

export type LlmScope = 'strategy' | 'news' | 'other';
export type PauseKind = 'earnings' | 'accounting';
export interface AttemptStats {
  attempts: number; successes: number; lastAttemptAt: number | null; lastSuccessAt: number | null;
  lastError: 'provider-rejected' | 'ambiguous-billing' | 'persistence' | null;
}
export interface Reservation { id: string; day: string; at: number; dollars: number; scope: LlmScope; agentId: string }
interface DayCost { strategy: number; news: number; other: number }
export interface EvaluationGrant { startedAt: number; expiresAt: number; day: string; maxAdditionalUsd: number; baselineSpent: number }
export interface LlmCostState extends AttemptStats {
  version: 2;
  accountingStartedAt: number;
  season: { startedAt: number; spentBaseline: number; pnlBaseline: number };
  dayKey: string; spentToday: number; totalSpent: number; totalCalls: number; totalInputTokens: number; totalOutputTokens: number;
  paused: boolean; pauseReason: string | null; pauseKind: PauseKind | null; pausedAt: number | null;
  byDay: Record<string, DayCost>; reservations: Reservation[];
  agents: Record<string, AttemptStats>;
  accountingComplete: boolean;
  grant: EvaluationGrant | null;
}
export const MAX_LLM_DAYS = 400;
const nonnegative = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const count = (n: unknown): n is number => nonnegative(n) && Number.isSafeInteger(n);
const timestamp = (n: unknown): boolean => n === null || (count(n) && n <= 8.64e15);
const dayKey = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  Number.isFinite(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const object = (o: unknown): o is Record<string, any> => !!o && typeof o === 'object' && !Array.isArray(o);
function validStats(s: any): boolean {
  return object(s) && count(s.attempts) && count(s.successes) && s.successes <= s.attempts && timestamp(s.lastAttemptAt) && timestamp(s.lastSuccessAt) &&
    [null, 'provider-rejected', 'ambiguous-billing', 'persistence'].includes(s.lastError);
}
function validReservation(r: any): r is Reservation {
  return object(r) && typeof r.id === 'string' && r.id.length <= 80 && dayKey(r.day) && count(r.at) && nonnegative(r.dollars) &&
    ['strategy', 'news', 'other'].includes(r.scope) && typeof r.agentId === 'string' && r.agentId.length <= 100;
}
function validState(s: any): s is LlmCostState {
  if (!object(s) || s.version !== 2 || !count(s.accountingStartedAt) || s.accountingStartedAt > Date.now() || !object(s.season) || !count(s.season.startedAt) ||
      !nonnegative(s.season.spentBaseline) || s.season.spentBaseline > s.totalSpent || typeof s.season.pnlBaseline !== 'number' || !Number.isFinite(s.season.pnlBaseline) || !dayKey(s.dayKey) || !nonnegative(s.spentToday) || !nonnegative(s.totalSpent) ||
      !['totalCalls', 'totalInputTokens', 'totalOutputTokens'].every(k => count(s[k])) || !validStats(s) ||
      typeof s.paused !== 'boolean' || ![null, 'earnings', 'accounting'].includes(s.pauseKind) || !timestamp(s.pausedAt) ||
      !(s.pauseReason === null || (typeof s.pauseReason === 'string' && s.pauseReason.length <= 500)) ||
      (s.paused ? s.pauseKind === null || s.pauseReason === null || s.pausedAt === null : s.pauseKind !== null || s.pausedAt !== null || s.pauseReason !== null) ||
      typeof s.accountingComplete !== 'boolean' || (!s.accountingComplete && s.pauseKind !== 'accounting') ||
      !object(s.byDay) || Object.keys(s.byDay).length > MAX_LLM_DAYS || !Array.isArray(s.reservations) || s.reservations.length > 128 ||
      !s.reservations.every(validReservation) || new Set(s.reservations.map((r: Reservation) => r.id)).size !== s.reservations.length ||
      !object(s.agents) || Object.keys(s.agents).length > 32 || !Object.values(s.agents).every(validStats)) return false;
  let total = 0;
  for (const [day, d] of Object.entries(s.byDay)) {
    if (!dayKey(day) || day > utcDay() || !object(d) || !['strategy', 'news', 'other'].every(k => nonnegative(d[k]))) return false;
    total += d.strategy + d.news + d.other;
  }
  const d = s.byDay[s.dayKey];
  if (Math.abs(s.spentToday - (d ? d.strategy + d.news + d.other : 0)) > 1e-8 || total > s.totalSpent + 1e-8 || (s.accountingComplete && Math.abs(total - s.totalSpent) > 1e-8)) return false;
  const g = s.grant;
  return g === null || (object(g) && count(g.startedAt) && count(g.expiresAt) && g.expiresAt > g.startedAt &&
    g.expiresAt - g.startedAt <= 60 * 60_000 && dayKey(g.day) && nonnegative(g.maxAdditionalUsd) && g.maxAdditionalUsd > 0 && g.maxAdditionalUsd <= 0.25 &&
    nonnegative(g.baselineSpent) && g.baselineSpent <= s.totalSpent && s.paused);
}
const stats = (): AttemptStats => ({ attempts: 0, successes: 0, lastAttemptAt: null, lastSuccessAt: null, lastError: null });
export function utcDay(t = Date.now()): string { return new Date(t).toISOString().slice(0, 10); }
export function freshCost(): LlmCostState {
  return { version: 2, accountingStartedAt: Date.now(), season: { startedAt: Date.now(), spentBaseline: 0, pnlBaseline: 0 }, dayKey: utcDay(), spentToday: 0, totalSpent: 0, totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0,
    paused: false, pauseReason: null, pauseKind: null, pausedAt: null, byDay: {}, reservations: [], agents: {}, accountingComplete: true, grant: null, ...stats() };
}

/** Configured-price estimates, not invoices. Unknown billing is retained as a liability, never assumed free. */
export class LlmBudget {
  private state: LlmCostState;
  private persist?: (snapshot: LlmCostState) => Promise<void>;
  private grantActivated = false;
  private granting = false;
  private authorityGeneration = 0;
  private stopped = false;
  private persistenceTail: Promise<void> = Promise.resolve();
  constructor(state: LlmCostState, readonly dailyBudget: number) { this.state = freshCost(); this.load(state); }
  setPersistence(persist: (snapshot: LlmCostState) => Promise<void>): void { this.persist = persist; }
  /** Revoke new paid authority; already-submitted liabilities still settle normally. */
  stop(): void { this.stopped = true; this.authorityGeneration++; this.grantActivated = false; }
  get paused(): boolean { return this.state.paused && !this.evaluationActive(); }
  evaluationActive(): boolean {
    const g = this.state.grant;
    return this.grantActivated && this.state.pauseKind !== 'accounting' && !!g && Date.now() < g.expiresAt && utcDay() === g.day &&
      this.state.totalSpent - g.baselineSpent < g.maxAdditionalUsd;
  }
  canResume(): boolean {
    return !this.stopped && this.paused && this.state.pauseKind === 'earnings' && this.state.accountingComplete && !this.granting &&
      this.state.reservations.length === 0 && this.dailyBudget > this.spentToday();
  }
  async resumeEvaluation(): Promise<void> {
    if (!this.canResume()) throw new Error('LLM evaluation requires an earnings pause and available accounting/budget');
    this.granting = true;
    this.grantActivated = false;
    const generation = this.authorityGeneration;
    this.state.grant = { startedAt: Date.now(), expiresAt: Date.now() + 60 * 60_000, day: utcDay(),
      maxAdditionalUsd: Math.min(0.25, this.dailyBudget - this.spentToday()), baselineSpent: this.state.totalSpent };
    try {
      await this.checkpoint();
      this.grantActivated = this.authorityGeneration === generation && this.state.pauseKind === 'earnings';
    }
    finally { this.granting = false; }
  }
  set paused(value: boolean) {
    if (value) this.pause('earnings', 'Earnings review required');
    // Explicit bounded evaluation is the only resume authority.
  }
  pause(kind: PauseKind, reason: string): void {
    this.authorityGeneration++;
    if (this.state.pauseKind === 'accounting' && kind !== 'accounting') return;
    this.grantActivated = false;
    this.state.paused = true; this.state.pauseKind = kind; this.state.pauseReason = reason;
    this.state.pausedAt ??= Date.now();
    if (kind === 'accounting') this.state.accountingComplete = false;
  }
  load(raw: unknown): void {
    // A restored checkpoint never inherits activation from an in-flight grant.
    this.authorityGeneration++;
    this.grantActivated = false;
    const s = raw as any;
    if (!s || typeof s !== 'object') { this.pause('accounting', 'Accounting review: invalid checkpoint'); return; }
    if (!validState(s)) {
      this.state = freshCost();
      for (const key of ['totalSpent', 'totalCalls', 'totalInputTokens', 'totalOutputTokens'] as const) {
        if (nonnegative(s[key])) this.state[key] = s[key];
      }
      if (Array.isArray(s.reservations)) this.state.reservations = s.reservations.filter(validReservation).slice(0, 128);
      const legacyKeys = ['dayKey', 'spentToday', 'totalSpent', 'totalCalls', 'totalInputTokens', 'totalOutputTokens'];
      const cleanLegacyZero = Object.keys(s).length === legacyKeys.length && Object.keys(s).every(k => legacyKeys.includes(k)) &&
        dayKey(s.dayKey) && legacyKeys.slice(1).every(k => s[k] === 0);
      // Only the exact original zero ledger can migrate without trustworthy history.
      // Extra fields may carry unresolved billing, pause or grant evidence.
      if (!cleanLegacyZero) this.pause('accounting', 'Accounting review: invalid or legacy checkpoint has no trustworthy dated history');
      return;
    }
    this.state = structuredClone(s);
    if (s.reservations.length) this.pause('accounting', 'Accounting review: unresolved LLM reservations on restart');
    this.roll();
  }
  private roll(): void {
    const day = utcDay();
    this.state.dayKey = day;
    const d = this.state.byDay[day];
    this.state.spentToday = d ? d.strategy + d.news + d.other : 0;
  }
  reserved(except?: string): number { return this.state.reservations.reduce((n, r) => n + (r.id === except ? 0 : r.dollars), 0); }
  canSpend(dollars = 0, except?: string): boolean {
    this.roll();
    return !this.stopped && !this.paused && this.state.accountingComplete && Number.isFinite(dollars) && dollars >= 0 &&
      (!this.state.grant || !this.grantActivated || this.state.totalSpent - this.state.grant.baselineSpent + this.reserved(except) + dollars <= this.state.grant.maxAdditionalUsd) &&
      Number.isFinite(this.dailyBudget) && this.dailyBudget > 0 && this.spentToday() + this.reserved(except) + dollars <= this.dailyBudget &&
      (dollars > 0 || this.spentToday() + this.reserved(except) < this.dailyBudget);
  }
  private async checkpoint(releaseId?: string): Promise<void> {
    const save = async () => {
      try {
        if (!this.persist) throw new Error('LLM persistence unavailable');
        const snapshot = this.snapshot();
        if (releaseId) snapshot.reservations = snapshot.reservations.filter(r => r.id !== releaseId);
        await this.persist(snapshot);
        // Keep the liability in memory until this exact release is durable.
        // Commit before releasing the queue, so the next checkpoint cannot resurrect it.
        if (releaseId) this.state.reservations = this.state.reservations.filter(r => r.id !== releaseId);
      } catch {
        this.pause('accounting', 'Accounting review: LLM persistence failed');
        this.state.lastError = 'persistence';
        throw new Error('LLM accounting persistence failed');
      }
    };
    const pending = this.persistenceTail.then(save);
    this.persistenceTail = pending.catch(() => {});
    await pending;
  }
  async reserve(dollars: number, scope: LlmScope = 'other', agentId = 'unattributed'): Promise<Reservation> {
    if (!this.canSpend(dollars)) throw new Error('LLM spending authorization unavailable');
    if (this.state.reservations.length >= 128 || (!this.state.agents[agentId] && Object.keys(this.state.agents).length >= 32) ||
        (!this.state.byDay[utcDay()] && Object.keys(this.state.byDay).length >= MAX_LLM_DAYS)) {
      this.pause('accounting', 'Accounting review: LLM ledger capacity reached');
      await this.checkpoint(); throw new Error('LLM ledger capacity reached');
    }
    const r = { id: randomUUID(), day: utcDay(), at: Date.now(), dollars, scope, agentId };
    this.state.reservations.push(r);
    await this.checkpoint();
    return r;
  }
  /** Synchronous recheck must be immediately followed by transport invocation, without an await. */
  authorize(r: Reservation): boolean {
    return r.day === utcDay() && this.state.reservations.some(x => x.id === r.id) && this.canSpend(r.dollars, r.id);
  }
  async release(r: Reservation): Promise<void> {
    try { await this.checkpoint(r.id); }
    catch { throw new Error('LLM reservation release persistence failed'); }
  }
  attempted(r: Reservation): void {
    const perAgent = this.state.agents[r.agentId] ??= stats();
    for (const s of [this.state, perAgent]) { s.attempts++; s.lastAttemptAt = Date.now(); }
  }
  async settle(r: Reservation, usage: LlmUsage): Promise<void> {
    this.record(usage, r.scope, r.day);
    const perAgent = this.state.agents[r.agentId] ??= stats();
    for (const s of [this.state, perAgent]) { s.successes++; s.lastSuccessAt = Date.now(); s.lastError = null; }
    this.state.reservations = this.state.reservations.filter(x => x.id !== r.id);
    if (usage.costUsd > r.dollars) this.pause('accounting', 'Accounting review: observed usage exceeded configured-price reservation');
    await this.checkpoint();
  }
  async failed(r: Reservation, rejected: boolean): Promise<void> {
    const error = rejected ? 'provider-rejected' : 'ambiguous-billing';
    this.state.lastError = error;
    (this.state.agents[r.agentId] ??= stats()).lastError = error;
    if (rejected) await this.release(r);
    else { this.pause('accounting', 'Accounting review: ambiguous LLM billing; reservation retained'); await this.checkpoint(); }
  }
  async persistPause(): Promise<void> { await this.checkpoint(); }
  startSeason(directPnl: number): void {
    this.state.season = { startedAt: Date.now(), spentBaseline: this.state.totalSpent, pnlBaseline: directPnl };
  }
  window(days: number, pnlByDay: Record<string, number>) {
    const today = Date.parse(utcDay() + 'T00:00:00Z');
    const startDay = utcDay(today - (days - 1) * 86_400_000);
    const endDay = utcDay(today);
    let strategyCost = 0, newsCost = 0, otherCost = 0, directAuthoredPnl = 0;
    for (const [day, cost] of Object.entries(this.state.byDay)) if (day >= startDay && day <= endDay) {
      strategyCost += cost.strategy; newsCost += cost.news; otherCost += cost.other;
    }
    for (const [day, pnl] of Object.entries(pnlByDay)) if (day >= startDay && day <= endDay) directAuthoredPnl += pnl;
    return { startDay, endDay, days, policy: 'inclusive-utc-calendar-days' as const, strategyCost, newsCost, otherCost, directAuthoredPnl };
  }
  record(usage: LlmUsage, scope: LlmScope = 'other', day = utcDay()): void {
    this.state.accountingStartedAt = Math.min(this.state.accountingStartedAt, Date.parse(day + 'T00:00:00Z'));
    const d = this.state.byDay[day] ??= { strategy: 0, news: 0, other: 0 };
    d[scope] += usage.costUsd;
    this.state.totalSpent += usage.costUsd; this.state.totalCalls++;
    this.state.totalInputTokens += usage.inputTokens; this.state.totalOutputTokens += usage.outputTokens;
    this.roll();
  }
  spentToday(): number { this.roll(); return this.state.spentToday; }
  totalSpent(): number { return this.state.totalSpent; }
  snapshot(): LlmCostState { this.roll(); return structuredClone(this.state); }
}
