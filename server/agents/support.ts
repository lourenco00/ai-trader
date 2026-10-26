import type { Appearance, BuildingId, MarketDTO, NewsItem } from '../../shared/types';
import { readRegime, type RegimeReading } from '../market/regime';
import { Agent } from './base';
import type { EcoContext } from './context';

const REGIME_TEXT: Record<string, string> = {
  bull: 'trending up',
  bear: 'trending down',
  ranging: 'moving sideways',
  volatile: 'getting stormy',
  unknown: 'still loading',
};

/** Pip. Watches the tape and reports market regimes. */
export class Scout extends Agent {
  private readings = new Map<string, RegimeReading>();
  candlesSeen = 0;

  constructor(ctx: EcoContext, id: string, name: string, appearance: Appearance) {
    super(ctx, id, name, 'scout', 'Market Scout', 'markets', appearance);
    this.activity = 'Climbing the lookout';
  }

  init(): void {
    for (const s of this.ctx.cfg.symbols) {
      this.readings.set(s, readRegime(this.ctx.feed.series(s), this.ctx.cfg.barsPerYear));
    }
  }

  onCandle(symbol: string): void {
    this.candlesSeen++;
    this.addXp(1);
    const prev = this.readings.get(symbol);
    const next = readRegime(this.ctx.feed.series(symbol), this.ctx.cfg.barsPerYear);
    this.readings.set(symbol, next);
    this.activity = `New ${symbol} candle: ${REGIME_TEXT[next.regime]}`;
    if (prev && prev.regime !== next.regime && next.regime !== 'unknown') {
      this.addXp(5);
      this.ctx.news('market', `${this.name}: ${symbol} is ${REGIME_TEXT[next.regime]} (vol ${(next.volatility * 100).toFixed(0)}% annualised)`, { agentId: this.id });
      this.ctx.emit({ kind: 'regime', agentId: this.id, text: `${symbol} ${next.regime}!`, building: 'markets' });
    }
    this.postChartSignal(symbol, next);
  }

  /**
   * The Scout's chart read goes on the same board as the news desk, so traders
   * and the commander see technicals and news side by side. A clear trend is a
   * directional signal; ranging/unknown posts nothing.
   */
  private postChartSignal(symbol: string, r: RegimeReading): void {
    const price = this.ctx.feed.price(symbol);
    if (price === undefined) return;
    let direction: 'long' | 'short' | null = null;
    let confidence = 0;
    if (r.regime === 'bull') {
      direction = 'long';
      confidence = Math.min(0.8, 0.4 + Math.abs(r.trend) * 10);
    } else if (r.regime === 'bear') {
      direction = 'short';
      confidence = Math.min(0.8, 0.4 + Math.abs(r.trend) * 10);
    }
    if (!direction) return;
    this.ctx.board.post({
      source: 'scout',
      authorId: this.id,
      authorName: this.name,
      symbol,
      direction,
      confidence,
      headline: `Chart regime ${r.regime} (trend ${(r.trend * 100).toFixed(1)}%, vol ${(r.volatility * 100).toFixed(0)}%)`,
      expiresAt: Date.now() + 6 * this.ctx.cfg.timeframeMs,
      refPrice: price,
    });
  }

  regime(symbol: string): RegimeReading | undefined {
    return this.readings.get(symbol);
  }

  markets(): MarketDTO[] {
    const tf = this.ctx.cfg.timeframeMs;
    const dayBars = Math.round(86_400_000 / tf);
    return this.ctx.cfg.symbols.map((symbol) => {
      const series = this.ctx.feed.series(symbol);
      const price = this.ctx.feed.price(symbol) ?? series[series.length - 1]?.c ?? 0;
      const ref = series[series.length - dayBars]?.c ?? series[0]?.c ?? price;
      const r = this.readings.get(symbol);
      const sparkSrc = series.slice(-dayBars);
      const step = Math.max(1, Math.floor(sparkSrc.length / 48));
      const spark: number[] = [];
      for (let i = 0; i < sparkSrc.length; i += step) spark.push(sparkSrc[i].c);
      spark.push(price);
      return {
        symbol,
        asset: this.ctx.cfg.assetClass(symbol),
        price,
        change24h: ref > 0 ? price / ref - 1 : 0,
        regime: r?.regime ?? 'unknown',
        volatility: r?.volatility ?? 0,
        trend: r?.trend ?? 0,
        lastCandleTime: series[series.length - 1]?.t ?? 0,
        spark,
        marketOpen: this.ctx.marketOpen(symbol),
        newsBias: this.ctx.board.bias(symbol).score,
      };
    });
  }

  brief(): string {
    return this.markets()
      .map((m) => `- ${m.symbol}: ${m.price.toFixed(2)}, 24h ${(m.change24h * 100).toFixed(1)}%, regime ${m.regime}, vol ${(m.volatility * 100).toFixed(0)}%`)
      .join('\n');
  }

  stats(): Record<string, string | number> {
    const out: Record<string, string | number> = { 'Candles watched': this.candlesSeen };
    for (const [s, r] of this.readings) out[s] = `${r.regime}, vol ${(r.volatility * 100).toFixed(0)}%`;
    return out;
  }

  protected saveExtra(): unknown {
    return { candlesSeen: this.candlesSeen };
  }

  protected restoreExtra(extra: unknown): void {
    this.candlesSeen = Number((extra as { candlesSeen?: number }).candlesSeen) || 0;
  }
}

const NEWS_BUILDING: Partial<Record<NewsItem['kind'], BuildingId>> = {
  trade: 'markets',
  discovery: 'vault',
  risk: 'warroom',
  allocation: 'command',
  retire: 'graveyard',
  market: 'markets',
};

/** Gus. Turns events into headlines and publishes the periodic Gazette. */
export class Reporter extends Agent {
  stories = 0;
  editions = 0;
  report: string | null = null;
  lastEditionAt = Date.now();

  constructor(ctx: EcoContext, id: string, name: string, appearance: Appearance) {
    super(ctx, id, name, 'reporter', 'Gazette Reporter', 'media', appearance);
    this.activity = 'Sharpening pencils';
  }

  cover(item: NewsItem): void {
    if (item.agentId === this.id) return;
    this.stories++;
    this.addXp(2);
    this.activity = `Covering: ${item.text.slice(0, 70)}${item.text.length > 70 ? '...' : ''}`;
    this.location = NEWS_BUILDING[item.kind] ?? 'media';
  }

  publish(text: string): void {
    this.report = text;
    this.editions++;
    this.lastEditionAt = Date.now();
    this.addXp(25);
    this.location = 'media';
    this.activity = `Published Gazette #${this.editions}`;
  }

  stats(): Record<string, string | number> {
    return { Stories: this.stories, Editions: this.editions };
  }

  protected saveExtra(): unknown {
    return { stories: this.stories, editions: this.editions, report: this.report, lastEditionAt: this.lastEditionAt };
  }

  protected restoreExtra(extra: unknown): void {
    const e = extra as Partial<{ stories: number; editions: number; report: string | null; lastEditionAt: number }>;
    this.stories = Number(e.stories) || 0;
    this.editions = Number(e.editions) || 0;
    this.report = typeof e.report === 'string' ? e.report : null;
    this.lastEditionAt = Number(e.lastEditionAt) || Date.now();
  }
}

/** Penny. Counts the coins and keeps the equity curve. */
export class Treasurer extends Agent {
  snapshots = 0;

  constructor(ctx: EcoContext, id: string, name: string, appearance: Appearance) {
    super(ctx, id, name, 'treasurer', 'Treasurer', 'bank', appearance);
    this.activity = 'Polishing the vault door';
  }

  counted(equity: number, change: number): void {
    this.snapshots++;
    this.addXp(1);
    this.activity = `Counted $${equity.toFixed(2)} (${change >= 0 ? '+' : ''}${(change * 100).toFixed(2)}% all-time)`;
    this.mood = change >= 0 ? 'happy' : 'sad';
  }

  stats(): Record<string, string | number> {
    return { 'Ledger entries': this.snapshots };
  }

  protected saveExtra(): unknown {
    return { snapshots: this.snapshots };
  }

  protected restoreExtra(extra: unknown): void {
    this.snapshots = Number((extra as { snapshots?: number }).snapshots) || 0;
  }
}
