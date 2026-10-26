import type { AnalystDTO, Appearance, Side } from '../../shared/types';
import { fetchAllHeadlines, type Headline } from '../news/feeds';
import { logger } from '../util/log';
import { Agent } from './base';
import type { EcoContext } from './context';

const log = logger('newsdesk');

interface Pending {
  symbol: string;
  direction: Side;
  confidence: number;
  headline: string;
  refPrice: number;
  postedAt: number;
  horizonMs: number;
  scored: boolean;
}

interface Tag {
  symbol: string;
  direction: Side;
  confidence: number;
  horizonH: number;
  headline: string;
}

/**
 * A news analyst. Pulls RSS headlines, batches the new ones into one cheap LLM
 * call that tags each with an affected symbol, direction, confidence and
 * horizon, and posts the strong ones to the signal board. Every posted call is
 * scored later against the realised price move so a bad analyst's influence
 * (and the LLM spend behind it) is visible and can be shut off.
 */
export class NewsDesk extends Agent {
  private nextRunAt = Date.now() + 20_000;
  private running = false;
  private seen = new Set<string>();
  private pending: Pending[] = [];
  headlinesRead = 0;
  signalsPosted = 0;
  scored = 0;
  hits = 0;
  lastHeadline = 'Warming up the newsroom';

  constructor(
    ctx: EcoContext,
    id: string,
    name: string,
    private beat: string,
    appearance: Appearance,
  ) {
    super(ctx, id, name, 'analyst', `News Analyst (${beat})`, 'media', appearance);
    if (!ctx.cfg.news.enabled) {
      this.mood = 'sleeping';
      this.activity = ctx.cfg.llm.enabled ? 'Newsroom disabled (NEWS_ENABLED=false)' : 'Asleep (no LLM key configured)';
      this.location = 'hall';
    } else {
      this.activity = `Reading the ${beat}`;
    }
  }

  async tick(): Promise<void> {
    this.scorePending();
    if (!this.ctx.cfg.news.enabled || this.running) return;
    const now = Date.now();
    if (now < this.nextRunAt) return;
    if (!this.ctx.llm.affordable()) {
      this.mood = 'sleeping';
      this.activity = this.ctx.llm.affordableReason();
      this.nextRunAt = now + 60_000;
      return;
    }
    this.running = true;
    this.activity = `Scanning the ${this.beat}...`;
    this.mood = 'neutral';
    try {
      await this.session();
    } catch (err) {
      log.warn(`${this.name} failed`, err);
      this.lastHeadline = `News run failed: ${(err as Error).message.slice(0, 100)}`;
      this.mood = 'sad';
    } finally {
      this.running = false;
      this.nextRunAt = Date.now() + this.ctx.cfg.news.pollMs;
    }
  }

  private async session(): Promise<void> {
    const all = await fetchAllHeadlines(this.ctx.cfg.news.feeds);
    const fresh = all.filter((h) => !this.seen.has(key(h))).slice(0, this.ctx.cfg.news.maxHeadlinesPerCall);
    for (const h of fresh) this.seen.add(key(h));
    if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-1000));
    if (fresh.length === 0) {
      this.activity = 'No fresh headlines; waiting for the wire';
      return;
    }
    this.headlinesRead += fresh.length;
    this.location = 'media';
    this.addXp(fresh.length);
    const tags = await this.classify(fresh);
    this.ctx.attributeLlm(this.id);
    let posted = 0;
    for (const t of tags) {
      const price = this.ctx.feed.price(t.symbol);
      if (price === undefined || t.confidence < 0.45) continue;
      const ttl = Math.min(this.ctx.cfg.news.signalTtlMs, t.horizonH * 3_600_000);
      this.ctx.board.post({
        source: 'news',
        authorId: this.id,
        authorName: this.name,
        symbol: t.symbol,
        direction: t.direction,
        confidence: t.confidence,
        headline: t.headline.slice(0, 120),
        expiresAt: Date.now() + ttl,
        refPrice: price,
      });
      this.pending.push({
        symbol: t.symbol,
        direction: t.direction,
        confidence: t.confidence,
        headline: t.headline.slice(0, 120),
        refPrice: price,
        postedAt: Date.now(),
        horizonMs: ttl,
        scored: false,
      });
      posted++;
      this.signalsPosted++;
      this.addXp(4);
      this.ctx.news('signal', `${this.name}: ${t.direction === 'long' ? 'bullish' : 'bearish'} ${t.symbol} (${Math.round(t.confidence * 100)}%) — ${t.headline.slice(0, 90)}`, { agentId: this.id, good: t.direction === 'long' });
      this.ctx.emit({ kind: 'signal', agentId: this.id, text: `${t.direction === 'long' ? '▲' : '▼'} ${t.symbol}`, building: 'media' });
    }
    this.mood = posted ? 'excited' : 'neutral';
    this.lastHeadline = fresh[0] ? `${fresh[0].title.slice(0, 90)} (${posted} signal${posted === 1 ? '' : 's'} from ${fresh.length} read)` : this.lastHeadline;
  }

  private async classify(headlines: Headline[]): Promise<Tag[]> {
    const list = headlines.map((h, i) => `${i + 1}. [${h.source}] ${h.title}${h.summary ? ` — ${h.summary.slice(0, 160)}` : ''}`).join('\n');
    const prompt = `You are a markets news analyst. For each headline decide whether it is tradeable for any of these assets and how it should bias price.
Assets: ${this.ctx.cfg.symbols.join(', ')}.
Headlines:
${list}

Return ONLY a JSON array. One object per headline that is clearly relevant to one of the assets (skip the rest):
[{"n":1,"symbol":"BTC","direction":"long","confidence":0.0,"horizonH":6}]
- direction: "long" if the news should push the price up, "short" if down.
- confidence: 0..1, your conviction this moves THAT asset. Be strict: most headlines are noise; use <0.45 or omit them.
- horizonH: hours you expect the effect to last (1..72).
Only use the exact asset tickers listed. No prose.`;
    const res = await this.ctx.llm.complete(prompt, { fast: true, maxTokens: 700, temperature: 0.2 });
    return this.parse(res.text, headlines);
  }

  private parse(text: string, headlines: Headline[]): Tag[] {
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
    const out: Tag[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const r = item as { n?: unknown; symbol?: unknown; direction?: unknown; confidence?: unknown; horizonH?: unknown };
      const symbol = typeof r.symbol === 'string' ? r.symbol.toUpperCase() : '';
      if (!this.ctx.cfg.symbols.includes(symbol)) continue;
      const direction: Side = r.direction === 'short' ? 'short' : 'long';
      const confidence = Math.max(0, Math.min(1, Number(r.confidence)));
      if (!Number.isFinite(confidence)) continue;
      const horizonH = Math.max(1, Math.min(72, Number(r.horizonH) || 6));
      const idx = Number(r.n) - 1;
      const headline = headlines[idx]?.title ?? `${symbol} news`;
      out.push({ symbol, direction, confidence, horizonH, headline });
    }
    return out;
  }

  /** Grade past calls once their horizon has elapsed: was the move in the called direction after fees? */
  private scorePending(): void {
    const now = Date.now();
    const fee = this.ctx.cfg.feeRate * 2 + this.ctx.cfg.slippage * 2;
    let changed = false;
    for (const p of this.pending) {
      if (p.scored || now < p.postedAt + p.horizonMs) continue;
      const price = this.ctx.feed.price(p.symbol);
      if (price === undefined) {
        p.scored = true;
        continue;
      }
      const move = (price - p.refPrice) / p.refPrice * (p.direction === 'long' ? 1 : -1);
      p.scored = true;
      this.scored++;
      if (move > fee) {
        this.hits++;
        this.addXp(6);
      }
      changed = true;
    }
    if (changed) this.pending = this.pending.filter((p) => !p.scored).concat(this.pending.filter((p) => p.scored).slice(-20));
  }

  hitRate(): number | null {
    return this.scored >= 5 ? this.hits / this.scored : null;
  }

  toAnalystDTO(): AnalystDTO {
    return {
      agentId: this.id,
      name: this.name,
      beat: this.beat,
      headlinesRead: this.headlinesRead,
      signalsPosted: this.signalsPosted,
      hitRate: this.hitRate(),
      scored: this.scored,
      lastHeadline: this.lastHeadline,
      enabled: this.ctx.cfg.news.enabled,
    };
  }

  stats(): Record<string, string | number> {
    const hr = this.hitRate();
    return {
      Beat: this.beat,
      'Headlines read': this.headlinesRead,
      'Signals posted': this.signalsPosted,
      'Calls graded': this.scored,
      'Hit rate': hr === null ? 'need 5+ calls' : `${Math.round(hr * 100)}%`,
      Latest: this.lastHeadline,
    };
  }

  protected saveExtra(): unknown {
    return { headlinesRead: this.headlinesRead, signalsPosted: this.signalsPosted, scored: this.scored, hits: this.hits, pending: this.pending.slice(-40), lastHeadline: this.lastHeadline };
  }

  protected restoreExtra(extra: unknown): void {
    const e = extra as Partial<{ headlinesRead: number; signalsPosted: number; scored: number; hits: number; pending: Pending[]; lastHeadline: string }>;
    this.headlinesRead = Number(e.headlinesRead) || 0;
    this.signalsPosted = Number(e.signalsPosted) || 0;
    this.scored = Number(e.scored) || 0;
    this.hits = Number(e.hits) || 0;
    if (Array.isArray(e.pending)) this.pending = e.pending.filter((p) => p && typeof p.symbol === 'string');
    if (typeof e.lastHeadline === 'string') this.lastHeadline = e.lastHeadline;
  }
}

function key(h: Headline): string {
  return h.title.toLowerCase().slice(0, 80);
}
