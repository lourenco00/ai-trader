import type { Appearance, ResearcherDTO } from '../../shared/types';
import { describeGenome, sanitize, type Genome } from '../strategy/genome';
import { INDICATORS } from '../strategy/indicators';
import { logger } from '../util/log';
import { Agent } from './base';
import type { EcoContext } from './context';
import { makeRecord, pct, validate } from './researcher';

const log = logger('strategist');

interface Proposal {
  symbol: string;
  genome: Genome;
}

/**
 * Optional LLM-backed researcher. Periodically shows the model the market
 * regime, what is working and what died, and asks for new genomes as JSON.
 * Every idea still has to pass the same backtest + holdout gate as evolved
 * ones; ideas that fail are handed to the evolutionary researchers as seeds.
 */
export class Strategist extends Agent {
  private nextRunAt = Date.now() + 60_000;
  private running = false;
  sessions = 0;
  proposed = 0;
  discoveries = 0;
  lastResult: string;
  shareIdeas: (ideas: Proposal[]) => void = () => {};
  marketBrief: () => string = () => '';

  constructor(ctx: EcoContext, id: string, name: string, appearance: Appearance) {
    super(ctx, id, name, 'strategist', 'LLM Strategist', 'lab', appearance);
    this.lastResult = ctx.cfg.llm.enabled
      ? `Thinking with ${ctx.cfg.llm.provider}/${ctx.cfg.llm.model}`
      : 'Asleep. Set LLM_PROVIDER and LLM_API_KEY in .env to wake me up';
    if (!ctx.cfg.llm.enabled) {
      this.mood = 'sleeping';
      this.activity = 'Snoozing (no LLM key configured)';
      this.location = 'hall';
    }
  }

  tick(): void {
    if (!this.ctx.cfg.llm.enabled || this.running) return;
    const now = Date.now();
    if (now < this.nextRunAt) {
      this.activity = `Pondering. Next brainstorm in ${Math.ceil((this.nextRunAt - now) / 60_000)} min`;
      return;
    }
    if (!this.ctx.llm.affordable()) {
      this.mood = 'sleeping';
      this.activity = this.ctx.llm.affordableReason();
      this.nextRunAt = now + 60_000;
      return;
    }
    this.running = true;
    this.activity = 'Brainstorming with the LLM...';
    this.mood = 'excited';
    void this.session()
      .catch((err) => {
        log.warn('LLM session failed', err);
        this.lastResult = `LLM call failed: ${(err as Error).message.slice(0, 120)}`;
        this.mood = 'sad';
      })
      .finally(() => {
        this.running = false;
        this.nextRunAt = Date.now() + this.ctx.cfg.llm.intervalMs;
      });
  }

  private async session(): Promise<void> {
    const prompt = this.buildPrompt();
    const res = await this.ctx.llm.complete(prompt, { maxTokens: 3000, temperature: 0.9 });
    this.ctx.attributeLlm(this.id);
    const ideas = parseProposals(res.text, this.ctx.cfg.symbols);
    this.sessions++;
    this.proposed += ideas.length;
    this.addXp(10 + ideas.length * 2);
    if (ideas.length === 0) {
      this.lastResult = 'The LLM answer had no usable strategies';
      return;
    }
    const passed: string[] = [];
    const leftovers: Proposal[] = [];
    for (const idea of ideas) {
      const data = this.ctx.dataset(idea.symbol);
      if (!data || this.ctx.vault.has(idea.symbol, idea.genome)) continue;
      const v = validate(this.ctx, data, idea.genome);
      this.ctx.countEvaluated(1);
      if (v.passed && passed.length < 2) {
        const rec = makeRecord(data, idea.genome, v, this, 'llm');
        if (this.ctx.vault.add(rec)) {
          passed.push(rec.name);
          this.discoveries++;
          this.addXp(80);
          this.ctx.news('discovery', `${this.name}'s LLM idea "${rec.name}" (${rec.symbol}) passed the holdout: ${pct(rec.test.totalReturn)}, Sharpe ${rec.test.sharpe.toFixed(2)}`, { agentId: this.id, good: true });
          this.ctx.emit({ kind: 'discovery', agentId: this.id, text: `Big brain: ${rec.name}`, building: 'vault' });
          this.ctx.unlock('eureka');
          this.ctx.unlock('big_brain');
          continue;
        }
      }
      leftovers.push(idea);
    }
    this.shareIdeas(leftovers);
    this.mood = passed.length ? 'excited' : 'neutral';
    this.lastResult = passed.length
      ? `Session ${this.sessions}: ${passed.length}/${ideas.length} ideas promoted (${passed.join(', ')})`
      : `Session ${this.sessions}: 0/${ideas.length} passed; handed them to the lab as seeds`;
  }

  private buildPrompt(): string {
    const vault = this.ctx.vault.all();
    const working = vault
      .filter((s) => s.status !== 'retired')
      .sort((a, b) => b.fitness - a.fitness)
      .slice(0, 6)
      .map((s) => `- ${s.symbol} ${s.name}: ${describeGenome(s.genome).join(' | ')} | holdout ${pct(s.test.totalReturn)} Sharpe ${s.test.sharpe.toFixed(2)} | live trades ${s.live.trades} pnl $${s.live.pnl.toFixed(2)}`)
      .join('\n');
    const dead = vault
      .filter((s) => s.status === 'retired')
      .slice(-5)
      .map((s) => `- ${s.symbol} ${s.name}: ${describeGenome(s.genome)[0]} | died: ${s.retiredReason}`)
      .join('\n');
    const kinds = Object.entries(INDICATORS)
      .map(([k, m]) => `${k}${m.params.length ? `(${m.params.map((p) => `${p.min}-${p.max}`).join(', ')})` : ''} [${m.type}${m.range ? ` const ${m.range[0]}..${m.range[1]}` : ''}]`)
      .join('\n');
    const newsLines = this.ctx.cfg.symbols
      .map((s) => {
        const b = this.ctx.board.bias(s);
        if (b.strength < 0.1) return null;
        return `- ${s}: news leans ${b.score > 0 ? 'bullish' : 'bearish'} (${(b.score * 100).toFixed(0)}, strength ${(b.strength * 100).toFixed(0)}%)${b.top ? ` — "${b.top.headline}"` : ''}`;
      })
      .filter(Boolean)
      .join('\n');
    return `You design systematic trading strategies for a paper-trading research lab.
Timeframe: ${this.ctx.cfg.timeframe} candles. Fees ${(this.ctx.cfg.feeRate * 100).toFixed(2)}% per side plus slippage, so strategies must trade selectively.
Symbols: ${this.ctx.cfg.symbols.join(', ')}.

Market now:
${this.marketBrief()}

News desk signals (from the shared board; bias toward sides that agree with strong, fresh news):
${newsLines || '- no strong news signals right now'}

Currently working strategies:
${working || '- none yet'}

Recently retired (learn from these):
${dead || '- none yet'}

Indicator kinds (params ranges) [type]:
${kinds}
Rules: 'price' indicators compare to another price indicator ({"t":"ind","spec":{...}}). 'osc' indicators compare to a constant ({"t":"const","v":number}).
Ops: ">", "<", "crossAbove", "crossBelow". Entry conditions are ANDed (1-3). Exit conditions are ORed (0-2).

Reply with ONLY a JSON array of 5 objects, no prose:
[{"symbol":"BTC","genome":{"side":"long","entry":[{"left":{"kind":"ema","p":[12]},"op":"crossAbove","right":{"t":"ind","spec":{"kind":"ema","p":[50]}}}],"exit":[],"stopAtr":2,"takeProfitAtr":4,"trailAtr":0,"maxBars":96,"sizePct":0.8,"atrPeriod":14}}]
Make the 5 ideas diverse (different symbols, sides and indicator families).`;
  }

  toResearcherDTO(): ResearcherDTO {
    return {
      agentId: this.id,
      name: this.name,
      specialty: 'LLM Brainstorming',
      symbol: this.ctx.cfg.symbols.join('/'),
      generation: 0,
      generationsPerEpoch: 0,
      epoch: this.sessions,
      evaluated: this.proposed,
      discoveries: this.discoveries,
      bestFitness: null,
      bestTrainSharpe: null,
      bestRules: [],
      lastResult: this.lastResult,
      origin: 'llm',
      enabled: this.ctx.cfg.llm.enabled,
    };
  }

  stats(): Record<string, string | number> {
    return {
      Model: this.ctx.cfg.llm.enabled ? `${this.ctx.cfg.llm.provider}/${this.ctx.cfg.llm.model}` : 'not configured',
      Sessions: this.sessions,
      'Ideas proposed': this.proposed,
      Discoveries: this.discoveries,
      'Last result': this.lastResult,
    };
  }

  protected saveExtra(): unknown {
    return { sessions: this.sessions, proposed: this.proposed, discoveries: this.discoveries };
  }

  protected restoreExtra(extra: unknown): void {
    const e = extra as Partial<{ sessions: number; proposed: number; discoveries: number }>;
    this.sessions = Number(e.sessions) || 0;
    this.proposed = Number(e.proposed) || 0;
    this.discoveries = Number(e.discoveries) || 0;
  }
}

/** Extract and validate proposals. Anything malformed is dropped; numbers are clamped by sanitize(). */
export function parseProposals(text: string, symbols: readonly string[]): Proposal[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: Proposal[] = [];
  for (const item of raw.slice(0, 10)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as { symbol?: unknown; genome?: unknown };
    const symbol = typeof r.symbol === 'string' ? r.symbol.toUpperCase() : '';
    if (!symbols.includes(symbol)) continue;
    out.push({ symbol, genome: sanitize(r.genome) });
  }
  return out;
}
