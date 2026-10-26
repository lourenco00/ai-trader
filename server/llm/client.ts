import type { Config } from '../config';
import { logger } from '../util/log';

const log = logger('llm');

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface LlmResult {
  text: string;
  usage: LlmUsage;
}

export type Budget = {
  /** Returns true and reserves nothing if the call is allowed; the caller reports actual spend after. */
  canSpend(): boolean;
  record(usage: LlmUsage): void;
  spentToday(): number;
  dailyBudget: number;
  paused: boolean;
};

/**
 * One place for every LLM call. It meters tokens, converts them to a dollar
 * estimate from the configured per-token prices, and refuses to call when the
 * day's budget is already spent. Both the strategist and the news desk go
 * through here so the cost ledger is complete.
 */
export class LlmClient {
  constructor(
    private cfg: Config,
    private budget: Budget,
  ) {}

  get enabled(): boolean {
    return this.cfg.llm.enabled;
  }

  affordable(): boolean {
    return this.cfg.llm.enabled && this.budget.canSpend();
  }

  affordableReason(): string {
    if (!this.cfg.llm.enabled) return 'Asleep (no LLM key configured)';
    if (this.budget.paused) return 'Asleep: not earning its keep (resume in the War Room)';
    if (this.cfg.llm.dailyBudgetUsd > 0 && this.budget.spentToday() >= this.cfg.llm.dailyBudgetUsd) {
      return `Daily LLM budget spent ($${this.budget.spentToday().toFixed(2)}/$${this.cfg.llm.dailyBudgetUsd.toFixed(2)})`;
    }
    return 'Resting';
  }

  private price(usage: { inputTokens: number; outputTokens: number }): number {
    return (
      (usage.inputTokens / 1_000_000) * this.cfg.llm.priceInPerMTok +
      (usage.outputTokens / 1_000_000) * this.cfg.llm.priceOutPerMTok
    );
  }

  /**
   * @param fast use the cheaper model (news tagging). Falls back to the main model.
   */
  async complete(prompt: string, opts: { fast?: boolean; maxTokens?: number; temperature?: number } = {}): Promise<LlmResult> {
    if (!this.cfg.llm.enabled) throw new Error('LLM is not configured');
    if (!this.budget.canSpend()) {
      throw new Error(`daily LLM budget of $${this.cfg.llm.dailyBudgetUsd.toFixed(2)} is spent ($${this.budget.spentToday().toFixed(4)} used)`);
    }
    const model = opts.fast ? this.cfg.llm.fastModel : this.cfg.llm.model;
    const maxTokens = opts.maxTokens ?? 3000;
    const { provider, apiKey, baseUrl } = this.cfg.llm;
    const signal = AbortSignal.timeout(90_000);
    let text = '';
    let usage: LlmUsage;

    if (provider === 'anthropic') {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: maxTokens, temperature: opts.temperature ?? 0.7, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!res.ok) throw new Error(`anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
      text = (body.content ?? []).map((c) => c.text ?? '').join('');
      const input = body.usage?.input_tokens ?? estimateTokens(prompt);
      const output = body.usage?.output_tokens ?? estimateTokens(text);
      usage = { inputTokens: input, outputTokens: output, costUsd: this.price({ inputTokens: input, outputTokens: output }) };
    } else {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, temperature: opts.temperature ?? 0.7, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!res.ok) throw new Error(`openai-compatible HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      text = body.choices?.[0]?.message?.content ?? '';
      const input = body.usage?.prompt_tokens ?? estimateTokens(prompt);
      const output = body.usage?.completion_tokens ?? estimateTokens(text);
      usage = { inputTokens: input, outputTokens: output, costUsd: this.price({ inputTokens: input, outputTokens: output }) };
    }

    this.budget.record(usage);
    log.debug(`call: ${usage.inputTokens}+${usage.outputTokens} tok, $${usage.costUsd.toFixed(5)} (today $${this.budget.spentToday().toFixed(4)}/${this.budget.dailyBudget})`);
    return { text, usage };
  }
}

/** Rough fallback when the API omits usage: ~4 chars per token. */
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}
