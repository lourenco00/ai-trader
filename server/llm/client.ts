import type { Config } from '../config';
import type { LlmBudget, LlmScope } from './budget';

export interface LlmUsage { inputTokens: number; outputTokens: number; costUsd: number }
export interface LlmResult { text: string; usage: LlmUsage }
export type Budget = LlmBudget;
export type LlmReadinessState = 'disabled' | 'paused-earnings' | 'paused-budget' | 'paused-accounting' | 'waiting' | 'running' | 'error';

/** Configured-price estimates, never a provider invoice or provider hard cap. */
export class LlmClient {
  constructor(private cfg: Config, private budget: Budget) {}
  get enabled(): boolean { return this.cfg.llm.enabled && !this.cfg.frozen?.enabled; }
  affordable(): boolean { return this.enabled && this.budget.canSpend(); }
  readiness(agentId?: string, running = false, nextRunAt: number | null = null, configured = true) {
    const s = this.budget.snapshot();
    const a = agentId ? s.agents[agentId] : s;
    let state: LlmReadinessState = 'waiting';
    if (!this.enabled || !configured) state = 'disabled';
    else if (s.pauseKind === 'accounting') state = 'paused-accounting';
    else if (this.budget.paused) state = 'paused-earnings';
    else if (!this.budget.canSpend()) state = 'paused-budget';
    else if (running) state = 'running';
    else if (a?.lastError) state = 'error';
    const reason = state === 'disabled' ? 'LLM work disabled by configuration' : state.startsWith('paused') ? this.affordableReason() :
      state === 'error' ? `LLM ${a?.lastError}` : state === 'running' ? 'LLM request in progress' : 'Waiting for schedule or input';
    return { state, reason, lastAttemptAt: a?.lastAttemptAt ?? null, lastSuccessAt: a?.lastSuccessAt ?? null, nextRunAt,
      attempts: a?.attempts ?? 0, successes: a?.successes ?? 0, lastError: a?.lastError ?? null };
  }
  affordableReason(): string {
    const s = this.budget.snapshot();
    if (!this.enabled) return 'LLM work disabled by configuration';
    if (this.budget.paused) return s.pauseReason ?? 'LLM paused';
    if (!this.budget.canSpend()) return 'Daily LLM budget unavailable (zero means no spend)';
    return 'Waiting for schedule or input';
  }
  private price(inputTokens: number, outputTokens: number): number {
    return (inputTokens * this.cfg.llm.priceInPerMTok + outputTokens * this.cfg.llm.priceOutPerMTok) / 1_000_000;
  }
  async complete(prompt: string, opts: { fast?: boolean; maxTokens?: number; temperature?: number; agentId?: string; category?: LlmScope } = {}): Promise<LlmResult> {
    if (!this.enabled) throw new Error('LLM work disabled');
    const maxTokens = opts.maxTokens ?? 3000;
    const prices = [this.cfg.llm.priceInPerMTok, this.cfg.llm.priceOutPerMTok];
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 100_000 || prices.some(p => !Number.isFinite(p) || p < 0) || !prices.some(p => p > 0)) {
      throw new Error('LLM configured pricing or output bound invalid');
    }
    // UTF-8 bytes upper-bound prompt tokens, plus framing allowance. This is not a provider billing guarantee.
    const bound = this.price(Buffer.byteLength(prompt, 'utf8') + 32, maxTokens);
    const model = opts.fast ? this.cfg.llm.fastModel : this.cfg.llm.model;
    const { provider, apiKey, baseUrl } = this.cfg.llm;
    const anthropic = provider === 'anthropic';
    const url = `${baseUrl.replace(/\/$/, '')}${anthropic ? '/v1/messages' : '/chat/completions'}`;
    const init: RequestInit = {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90_000),
      headers: anthropic ? { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } :
        { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, max_tokens: maxTokens, ...(anthropic ? {} : { temperature: opts.temperature ?? 0.7 }), messages: [{ role: 'user', content: prompt }] }),
    };
    const r = await this.budget.reserve(bound, opts.category, opts.agentId);
    if (!this.enabled || !this.budget.authorize(r)) {
      await this.budget.release(r);
      throw new Error('LLM authorization changed before submission');
    }
    this.budget.attempted(r);
    let rejected = false;
    let settled = false;
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        // No provider body is read, persisted or logged.
        rejected = res.status >= 400 && res.status < 500 && res.status !== 408;
        throw new Error(rejected ? 'LLM provider-rejected' : 'LLM ambiguous-billing');
      }
      const body: any = await res.json();
      const text = anthropic ? (body.content ?? []).map((c: any) => c.text ?? '').join('') : body.choices?.[0]?.message?.content;
      const input = anthropic ? body.usage?.input_tokens : body.usage?.prompt_tokens;
      const output = anthropic ? body.usage?.output_tokens : body.usage?.completion_tokens;
      if (typeof text !== 'string' || ![input, output].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('LLM ambiguous-billing');
      const usage = { inputTokens: input, outputTokens: output, costUsd: this.price(input, output) };
      settled = true;
      await this.budget.settle(r, usage);
      return { text, usage };
    } catch {
      if (!settled) await this.budget.failed(r, rejected);
      throw new Error(settled ? 'LLM accounting persistence failed' : rejected ? 'LLM provider-rejected' : 'LLM ambiguous-billing');
    }
  }
}
