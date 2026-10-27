import type { Config } from '../config';
import { logger } from '../util/log';

const log = logger('intel');

export interface ExchangeListing {
  name: string;
  volumeUsd: number;
  trust: string | null;
  spreadPct: number | null;
}

export interface CoinDossier {
  /** Where the facts came from: CoinGecko for listed coins, DEX Screener for DEX-only tokens. */
  source: 'coingecko' | 'dexscreener';
  symbol: string;
  name: string;
  /** CoinGecko id, or `chain:address` for a DEX token. Check it is the coin you meant: tickers are not unique. */
  id: string;
  rank: number | null;
  priceUsd: number | null;
  marketCap: number | null;
  fdv: number | null;
  volume24h: number | null;
  circulating: number | null;
  total: number | null;
  max: number | null;
  /** Share of total supply already circulating. Low means large unlocks still to come. */
  circulatingPct: number | null;
  fdvToCap: number | null;
  change7d: number | null;
  change30d: number | null;
  change200d: number | null;
  athDrawdown: number | null;
  categories: string[];
  genesisDate: string | null;
  homepage: string | null;
  exchanges: ExchangeListing[];
  devCommits4w: number | null;
  sentimentUp: number | null;
  dex: { chain: string; dex: string; liquidityUsd: number | null; ageDays: number | null; pair: string } | null;
  flags: { hard: string[]; soft: string[] };
  fetchedAt: number;
}

const TTL_MS = 6 * 3_600_000;

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/**
 * One place to look up facts about any coin. Listed coins come from CoinGecko; a token that only
 * trades on DEXs falls back to DEX Screener. Calls are queued and cached because the free tiers
 * allow only a few requests a minute.
 */
export class CoinIntel {
  private cache = new Map<string, CoinDossier>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastCall = 0;
  private blockedUntil = 0;

  constructor(private cfg: Config) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'ai-trader-valley/0.1' };
    if (this.cfg.intel.coingeckoProKey) h['x-cg-pro-api-key'] = this.cfg.intel.coingeckoProKey;
    else if (this.cfg.intel.coingeckoKey) h['x-cg-demo-api-key'] = this.cfg.intel.coingeckoKey;
    return h;
  }

  private get base(): string {
    return this.cfg.intel.coingeckoProKey ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3';
  }

  /** Serialises requests and spaces them out so the shared free limit is respected. */
  private async get(url: string): Promise<unknown | null> {
    const run = async (): Promise<unknown | null> => {
      const wait = Math.max(this.lastCall + this.cfg.intel.minGapMs - Date.now(), this.blockedUntil - Date.now(), 0);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastCall = Date.now();
      try {
        const res = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
        if (res.status === 429) {
          this.blockedUntil = Date.now() + 60_000;
          log.warn('rate limited; pausing lookups for a minute');
          return null;
        }
        if (!res.ok) return null;
        return await res.json();
      } catch (err) {
        log.debug(`GET ${url} failed`, err);
        return null;
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  async lookup(symbolOrId: string, opts: { fresh?: boolean } = {}): Promise<CoinDossier | null> {
    const key = symbolOrId.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && !opts.fresh && Date.now() - hit.fetchedAt < TTL_MS) return hit;
    const d = (await this.fromCoinGecko(symbolOrId)) ?? (await this.fromDexScreener(symbolOrId));
    if (d) this.cache.set(key, d);
    return d;
  }

  // --- CoinGecko -----------------------------------------------------------------

  private async fromCoinGecko(query: string): Promise<CoinDossier | null> {
    const found = (await this.get(`${this.base}/search?query=${encodeURIComponent(query)}`)) as {
      coins?: { id: string; symbol: string; name: string; market_cap_rank: number | null }[];
    } | null;
    const coins = found?.coins ?? [];
    const q = query.toLowerCase();
    // Exact id or ticker match, best-ranked first (search already orders by market cap).
    const pick = coins.find((c) => c.id === q) ?? coins.find((c) => c.symbol.toLowerCase() === q && c.market_cap_rank);
    if (!pick) return null;
    const c = (await this.get(
      `${this.base}/coins/${encodeURIComponent(pick.id)}?localization=false&tickers=true&market_data=true&community_data=false&developer_data=true&sparkline=false`,
    )) as Record<string, any> | null;
    if (!c) return null;
    const m = c.market_data ?? {};
    const usd = (o: unknown) => num((o as Record<string, unknown> | undefined)?.usd);

    const byExchange = new Map<string, ExchangeListing>();
    for (const t of (c.tickers ?? []) as Record<string, any>[]) {
      const name = String(t.market?.name ?? '');
      const vol = num(t.converted_volume?.usd) ?? 0;
      if (!name) continue;
      const cur = byExchange.get(name);
      if (cur) cur.volumeUsd += vol;
      else byExchange.set(name, { name, volumeUsd: vol, trust: t.trust_score ?? null, spreadPct: num(t.bid_ask_spread_percentage) });
    }
    const exchanges = [...byExchange.values()].sort((a, b) => b.volumeUsd - a.volumeUsd).slice(0, 8);

    const circulating = num(m.circulating_supply);
    const total = num(m.total_supply);
    const marketCap = usd(m.market_cap);
    const fdv = usd(m.fully_diluted_valuation);
    const d: CoinDossier = {
      source: 'coingecko',
      symbol: String(c.symbol ?? pick.symbol).toUpperCase(),
      name: String(c.name ?? pick.name),
      id: pick.id,
      rank: num(c.market_cap_rank),
      priceUsd: usd(m.current_price),
      marketCap,
      fdv,
      volume24h: usd(m.total_volume),
      circulating,
      total,
      max: num(m.max_supply),
      circulatingPct: circulating !== null && total ? circulating / total : null,
      fdvToCap: marketCap && fdv ? fdv / marketCap : null,
      change7d: num(m.price_change_percentage_7d) !== null ? num(m.price_change_percentage_7d)! / 100 : null,
      change30d: num(m.price_change_percentage_30d) !== null ? num(m.price_change_percentage_30d)! / 100 : null,
      change200d: num(m.price_change_percentage_200d) !== null ? num(m.price_change_percentage_200d)! / 100 : null,
      athDrawdown: usd(m.ath_change_percentage) !== null ? usd(m.ath_change_percentage)! / 100 : null,
      categories: ((c.categories ?? []) as string[]).filter(Boolean).slice(0, 6),
      genesisDate: c.genesis_date ?? null,
      homepage: (c.links?.homepage?.[0] as string) || null,
      exchanges,
      devCommits4w: num(c.developer_data?.commit_count_4_weeks),
      sentimentUp: num(c.sentiment_votes_up_percentage),
      dex: null,
      flags: { hard: [], soft: [] },
      fetchedAt: Date.now(),
    };
    d.flags = this.flag(d);
    return d;
  }

  // --- DEX Screener (tokens with no CoinGecko listing) -----------------------------

  private async fromDexScreener(query: string): Promise<CoinDossier | null> {
    const body = (await this.get(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`)) as {
      pairs?: Record<string, any>[];
    } | null;
    const q = query.toLowerCase();
    const pairs = (body?.pairs ?? []).filter((p) => String(p.baseToken?.symbol ?? '').toLowerCase() === q);
    if (pairs.length === 0) return null;
    const best = pairs.sort((a, b) => (num(b.liquidity?.usd) ?? 0) - (num(a.liquidity?.usd) ?? 0))[0];
    const liquidity = num(best.liquidity?.usd);
    const created = num(best.pairCreatedAt);
    const d: CoinDossier = {
      source: 'dexscreener',
      symbol: String(best.baseToken.symbol).toUpperCase(),
      name: String(best.baseToken.name ?? best.baseToken.symbol),
      id: `${best.chainId}:${best.baseToken.address}`,
      rank: null,
      priceUsd: best.priceUsd ? Number(best.priceUsd) : null,
      marketCap: num(best.marketCap),
      fdv: num(best.fdv),
      volume24h: num(best.volume?.h24),
      circulating: null,
      total: null,
      max: null,
      circulatingPct: null,
      fdvToCap: null,
      change7d: null,
      change30d: null,
      change200d: null,
      athDrawdown: null,
      categories: [],
      genesisDate: null,
      homepage: null,
      exchanges: [],
      devCommits4w: null,
      sentimentUp: null,
      dex: {
        chain: String(best.chainId),
        dex: String(best.dexId),
        liquidityUsd: liquidity,
        ageDays: created ? (Date.now() - created) / 86_400_000 : null,
        pair: String(best.pairAddress),
      },
      flags: { hard: [], soft: [] },
      fetchedAt: Date.now(),
    };
    d.flags = this.flag(d);
    return d;
  }

  // --- Red flags -------------------------------------------------------------------

  /**
   * Hard flags are reasons to stay away entirely; soft flags are things to know. They are
   * deliberately blunt: they catch the usual small-cap traps (huge unlocks ahead, thin or
   * brand-new pools, volume far out of proportion to size), not a verdict on the project.
   */
  private flag(d: CoinDossier): { hard: string[]; soft: string[] } {
    const hard: string[] = [];
    const soft: string[] = [];
    const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
    if (d.circulatingPct !== null) {
      if (d.circulatingPct < 0.1) hard.push(`only ${pct(d.circulatingPct)} of supply circulates: big unlocks ahead`);
      else if (d.circulatingPct < 0.3) soft.push(`${pct(d.circulatingPct)} of supply circulating, unlocks to come`);
    }
    if (d.fdvToCap !== null) {
      if (d.fdvToCap > 10) hard.push(`fully diluted value is ${d.fdvToCap.toFixed(0)}x market cap`);
      else if (d.fdvToCap > 3) soft.push(`FDV is ${d.fdvToCap.toFixed(1)}x market cap`);
    }
    if (d.marketCap && d.volume24h && d.volume24h / d.marketCap > 1.5) soft.push(`daily volume is ${(d.volume24h / d.marketCap).toFixed(1)}x market cap (possible pump or wash trading)`);
    if (d.athDrawdown !== null && d.athDrawdown < -0.9) soft.push(`down ${pct(-d.athDrawdown)} from its all-time high`);
    if (d.source === 'coingecko') {
      if (d.exchanges.length < 2) soft.push('listed on fewer than 2 exchanges');
      if (d.exchanges[0]?.spreadPct && d.exchanges[0].spreadPct > 1) soft.push(`${d.exchanges[0].spreadPct.toFixed(1)}% spread on its main exchange`);
      if (d.devCommits4w === 0 && !d.categories.some((c) => /meme/i.test(c))) soft.push('no developer commits in 4 weeks');
    } else {
      hard.push('DEX-only token: cannot be traded on any exchange the agents use');
      if (d.dex?.liquidityUsd !== null && d.dex!.liquidityUsd! < 100_000) soft.push(`only $${Math.round(d.dex!.liquidityUsd!).toLocaleString()} of liquidity`);
      if (d.dex?.ageDays !== null && d.dex!.ageDays! < 14) soft.push(`pool is only ${d.dex!.ageDays!.toFixed(0)} days old`);
    }
    return { hard, soft };
  }
}

export function describeDossier(d: CoinDossier): string {
  const usd = (x: number | null) => (x === null ? '?' : x >= 1e9 ? `$${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : `$${Math.round(x).toLocaleString()}`);
  const pct = (x: number | null) => (x === null ? '?' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`);
  const lines = [
    `${d.name} (${d.symbol}) [${d.source}, id ${d.id}]`,
    `price ${d.priceUsd ?? '?'} | rank ${d.rank ?? '-'} | cap ${usd(d.marketCap)} | FDV ${usd(d.fdv)} | 24h volume ${usd(d.volume24h)}`,
    `change 7d ${pct(d.change7d)}, 30d ${pct(d.change30d)}, 200d ${pct(d.change200d)} | from ATH ${pct(d.athDrawdown)}`,
  ];
  if (d.circulatingPct !== null) lines.push(`supply: ${(d.circulatingPct * 100).toFixed(0)}% circulating of total${d.max ? `, max ${d.max.toLocaleString()}` : ''}`);
  if (d.categories.length) lines.push(`categories: ${d.categories.join(', ')}`);
  if (d.exchanges.length) lines.push(`exchanges: ${d.exchanges.map((e) => `${e.name} ${usd(e.volumeUsd)}`).join(', ')}`);
  if (d.dex) lines.push(`DEX: ${d.dex.dex} on ${d.dex.chain}, liquidity ${usd(d.dex.liquidityUsd)}, pool age ${d.dex.ageDays?.toFixed(0) ?? '?'} days`);
  if (d.devCommits4w !== null) lines.push(`dev commits (4 weeks): ${d.devCommits4w}`);
  if (d.homepage) lines.push(`site: ${d.homepage}`);
  lines.push(d.flags.hard.length ? `AVOID: ${d.flags.hard.join('; ')}` : 'no hard red flags');
  if (d.flags.soft.length) lines.push(`watch: ${d.flags.soft.join('; ')}`);
  return lines.join('\n');
}
