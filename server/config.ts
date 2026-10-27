import path from 'node:path';

try {
  process.loadEnvFile();
} catch {
  // No .env file: defaults apply.
}

const env = process.env;

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`config: ${name} must be a number, got "${raw}"`);
  return Math.min(max, Math.max(min, v));
}

function bool(name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

const TIMEFRAMES: Record<string, number> = { '5m': 5 * 60_000, '15m': 15 * 60_000, '1h': 60 * 60_000 };

const timeframe = env.TIMEFRAME?.trim() || '15m';
const timeframeMs = TIMEFRAMES[timeframe];
if (timeframeMs === undefined) {
  throw new Error(`config: TIMEFRAME must be one of ${Object.keys(TIMEFRAMES).join(', ')}`);
}

const provider = (env.DATA_PROVIDER?.trim() || 'auto') as 'auto' | 'binance' | 'coinbase' | 'alpaca' | 'sim';
if (!['auto', 'binance', 'coinbase', 'alpaca', 'sim'].includes(provider)) {
  throw new Error('config: DATA_PROVIDER must be auto, binance, coinbase, alpaca or sim');
}

export type AssetClass = 'crypto' | 'stock';

export interface SymbolSpec {
  /** Canonical ticker used everywhere in the app, e.g. BTC or NVDA. */
  symbol: string;
  asset: AssetClass;
}

// Crypto symbols are bare tickers (BTC). Stocks are prefixed with $ in SYMBOLS,
// e.g. "BTC,ETH,SOL,$NVDA,$AAPL". That keeps one list while tagging asset class.
function parseSymbols(raw: string): SymbolSpec[] {
  const out: SymbolSpec[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const t = part.trim().toUpperCase();
    if (!t) continue;
    const isStock = t.startsWith('$');
    const symbol = isStock ? t.slice(1) : t;
    if (!/^[A-Z0-9]{1,10}$/.test(symbol) || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({ symbol, asset: isStock ? 'stock' : 'crypto' });
  }
  return out;
}

const symbolSpecs = parseSymbols(env.SYMBOLS?.trim() || 'BTC,ETH,SOL');
if (symbolSpecs.length === 0) throw new Error('config: SYMBOLS must contain at least one symbol like BTC or $NVDA');
// Both lists are mutable on purpose: the Explorer adds and drops symbols at runtime and
// every other module reads them through `config`, so they must be edited in place.
const symbols = symbolSpecs.map((s) => s.symbol);
const assetOf = new Map(symbolSpecs.map((s) => [s.symbol, s.asset]));
const coreSymbols = new Set(symbols);

const llmProvider = env.LLM_PROVIDER?.trim().toLowerCase() || '';
const llmKey = env.LLM_API_KEY?.trim() || '';
const llmEnabled = llmKey !== '' && (llmProvider === 'anthropic' || llmProvider === 'openai');

// Default per-1M-token prices (USD) for the metered models. Override in .env if
// your pricing differs. Used only to show a cost estimate and enforce the budget.
const llmInPrice = num('LLM_PRICE_IN', llmProvider === 'anthropic' ? 0.8 : 0.15, 0, 1000);
const llmOutPrice = num('LLM_PRICE_OUT', llmProvider === 'anthropic' ? 4 : 0.6, 0, 1000);

const alpacaKey = env.ALPACA_KEY_ID?.trim() || '';
const alpacaSecret = env.ALPACA_SECRET?.trim() || '';
const alpacaPaper = bool('ALPACA_PAPER', true);
const hasAlpacaKeys = alpacaKey !== '' && alpacaSecret !== '';
const execMode = (env.EXECUTION?.trim().toLowerCase() || 'paper') as 'paper' | 'alpaca';
if (!['paper', 'alpaca'].includes(execMode)) throw new Error('config: EXECUTION must be paper or alpaca');
if (execMode === 'alpaca' && !alpacaPaper) {
  throw new Error('config: EXECUTION=alpaca requires ALPACA_PAPER=true. Live trading is deliberately disabled in this build.');
}
if (execMode === 'alpaca' && (!alpacaKey || !alpacaSecret)) {
  throw new Error('config: EXECUTION=alpaca needs ALPACA_KEY_ID and ALPACA_SECRET');
}

export const config = {
  port: num('PORT', 8787, 1, 65535),
  host: env.HOST?.trim() || '127.0.0.1',
  dataDir: path.resolve(env.DATA_DIR?.trim() || './data'),

  startingCapital: num('STARTING_CAPITAL', 10_000, 100, 1e9),
  symbols,
  symbolSpecs,
  /** Symbols from SYMBOLS in .env. The Explorer never removes these. */
  isCore: (symbol: string): boolean => coreSymbols.has(symbol),
  get hasStocks(): boolean {
    return symbolSpecs.some((s) => s.asset === 'stock');
  },
  assetClass: (symbol: string): AssetClass => assetOf.get(symbol) ?? 'crypto',
  registerSymbol(spec: SymbolSpec): void {
    if (assetOf.has(spec.symbol)) return;
    assetOf.set(spec.symbol, spec.asset);
    symbols.push(spec.symbol);
    symbolSpecs.push(spec);
  },
  unregisterSymbol(symbol: string): void {
    if (coreSymbols.has(symbol)) return;
    assetOf.delete(symbol);
    const i = symbols.indexOf(symbol);
    if (i >= 0) symbols.splice(i, 1);
    const j = symbolSpecs.findIndex((s) => s.symbol === symbol);
    if (j >= 0) symbolSpecs.splice(j, 1);
  },
  timeframe,
  timeframeMs,
  barsPerYear: (365 * 24 * 60 * 60_000) / timeframeMs,
  historyBars: num('HISTORY_BARS', 10_000, 1500, 20_000),
  provider,
  pollMs: num('POLL_MS', 10_000, 3000, 120_000),

  feeRate: num('FEE_RATE', 0.001, 0, 0.01),
  /** Alpaca's first crypto tier: takers pay 0.25%, makers 0.15% (taken in kind). US stocks are free. */
  alpacaCryptoFee: 0.0025,
  alpacaCryptoMakerFee: 0.0015,
  /** Post limit orders inside the spread for crypto entries and calm exits, to earn the maker fee. */
  limitOrders: bool('LIMIT_ORDERS', true),
  limitEntryWaitMs: num('LIMIT_ENTRY_WAIT_SEC', 90, 10, 600) * 1000,
  limitExitWaitMs: num('LIMIT_EXIT_WAIT_SEC', 60, 10, 600) * 1000,
  slippage: num('SLIPPAGE_BPS', 3, 0, 100) / 10_000,

  researchers: Math.round(num('RESEARCHERS', 4, 1, 8)),
  traders: Math.round(num('TRADERS', 6, 1, 10)),
  researchCpu: num('RESEARCH_CPU', 0.35, 0.05, 0.9),

  allocation: {
    reserveFraction: 0.2,
    maxTraderFraction: 0.25,
    minTraderFraction: 0.03,
    probationTrades: 5,
    rebalanceEveryMs: 60 * 60_000,
  },

  risk: {
    fundMaxDrawdown: 0.2,
    traderMaxDrawdown: 0.12,
    dailyLossLimit: 0.05,
    maxGrossExposure: 1.0,
    maxSymbolExposure: 0.5,
    /** Cap per explored (non-core) coin or stock: thin books and gappy prices. */
    maxExploredSymbolExposure: 0.15,
    /** Cap across all explored symbols together. */
    maxExploredExposure: 0.5,
    /** A single order may not exceed this share of the symbol's 24h dollar volume. */
    maxVolumeParticipation: 0.005,
    maxNetLong: 1.0,
    maxNetShort: 1.0,
    staleDataMs: 3 * 60_000,
  },

  research: {
    populationSize: 32,
    generationsPerEpoch: 10,
    restBetweenEpochsMs: 8_000,
    trainFraction: 0.7,
    promotion: {
      minTrainTrades: 30,
      minTrainSharpe: 0.3,
      minTestTrades: 6,
      minTestSharpe: 0.5,
      minTestReturn: 0.002,
      maxTestDrawdown: 0.2,
      minProfitFactor: 1.05,
    },
    vaultCapacity: 30,
  },

  retirement: {
    minTradesForJudgement: 6,
    navFloor: 0.95,
    minProfitFactorAfter15: 0.8,
    idleDays: 4,
  },

  llm: {
    enabled: llmEnabled,
    provider: llmProvider as 'anthropic' | 'openai' | '',
    apiKey: llmKey,
    model: env.LLM_MODEL?.trim() || (llmProvider === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4o-mini'),
    // Cheaper model for high-frequency news tagging. Falls back to the main model.
    fastModel: env.LLM_FAST_MODEL?.trim() || (llmProvider === 'anthropic' ? 'claude-3-5-haiku-latest' : 'gpt-4o-mini'),
    baseUrl: env.LLM_BASE_URL?.trim() || (llmProvider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'),
    intervalMs: num('LLM_INTERVAL_MIN', 30, 5, 24 * 60) * 60_000,
    priceInPerMTok: llmInPrice,
    priceOutPerMTok: llmOutPrice,
    dailyBudgetUsd: num('LLM_DAILY_BUDGET_USD', 1, 0, 10_000),
    // If LLM-attributed net P&L stays below this over the rolling window, the LLM
    // sleeps until a new season or manual resume. It must earn its keep.
    earnWindowDays: num('LLM_EARN_WINDOW_DAYS', 7, 1, 90),
  },

  /**
   * The Explorer scans beyond SYMBOLS for lower-cap crypto (Binance public tickers)
   * and US stocks (Alpaca screener) and adds the most interesting ones to the
   * universe the researchers work on.
   */
  universe: {
    scanEnabled: bool('SCAN_ENABLED', true),
    scanEveryMs: num('SCAN_INTERVAL_MIN', 30, 5, 1440) * 60_000,
    maxExplored: Math.round(num('SCAN_MAX_EXPLORED', 10, 0, 40)),
    addPerScan: Math.round(num('SCAN_ADD_PER_SCAN', 3, 1, 10)),
    // 24h quote volume band for crypto, in USD. The floor keeps out coins nobody can
    // trade; the ceiling keeps the scan on lower-cap names instead of the usual majors.
    minVolumeUsd: num('SCAN_MIN_VOLUME_USD', 2_000_000, 100_000, 1e12),
    maxVolumeUsd: num('SCAN_MAX_VOLUME_USD', 150_000_000, 1_000_000, 1e13),
    // Market-cap filter, from CoinGecko's free listing. Skips the well-known top of the table
    // and the dust at the bottom. If CoinGecko is unreachable the scan falls back to volume alone.
    skipTopRank: Math.round(num('SCAN_SKIP_TOP_RANK', 50, 0, 500)),
    minMarketCapUsd: num('SCAN_MIN_MCAP_USD', 10_000_000, 0, 1e12),
    /** Share of research epochs spent on crypto when both crypto and stocks are on the map. */
    cryptoFocus: num('RESEARCH_CRYPTO_SHARE', 0.75, 0, 1),
    scanStocks: bool('SCAN_STOCKS', hasAlpacaKeys) && hasAlpacaKeys,
    stockMinPrice: num('SCAN_STOCK_MIN_PRICE', 1, 0.1, 1000),
    stockMaxPrice: num('SCAN_STOCK_MAX_PRICE', 60, 1, 100_000),
    /** Explored symbols are dropped after this many research epochs if nothing was promoted on them. */
    evictAfterEpochs: Math.round(num('SCAN_EVICT_AFTER_EPOCHS', 4, 1, 100)),
    /** Minimum 15m history needed before researchers can use a symbol. */
    minBars: 1000,
  },

  news: {
    enabled: llmEnabled && bool('NEWS_ENABLED', true),
    pollMs: num('NEWS_POLL_MIN', 8, 2, 240) * 60_000,
    maxHeadlinesPerCall: Math.round(num('NEWS_BATCH', 12, 1, 40)),
    signalTtlMs: num('NEWS_SIGNAL_TTL_MIN', 180, 15, 1440) * 60_000,
    feeds: (env.NEWS_FEEDS?.trim() ||
      'https://www.coindesk.com/arc/outboundfeeds/rss/,https://cointelegraph.com/rss,https://decrypt.co/feed')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  alpaca: {
    keyId: alpacaKey,
    secret: alpacaSecret,
    paper: alpacaPaper,
    tradingUrl: env.ALPACA_TRADING_URL?.trim() || (alpacaPaper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets'),
    dataUrl: env.ALPACA_DATA_URL?.trim() || 'https://data.alpaca.markets',
  },

  execution: execMode,
} as const;

export type Config = typeof config;
