import type { Genome } from '../strategy/genome';
import type { Config } from '../config';

export const HI_INTRADAY_ID = 'hi-intraday-paper-v1';
export const HI_INTRADAY_FUND_NAME = 'High-Activity Intraday — paper short-hold experiment';
export const HI_STOCKS = ['SPY','QQQ','IWM','DIA','AAPL','MSFT','AMZN','GOOGL','META','NVDA','AMD','TSLA'] as const;
export const HI_CRYPTO = ['BTC','ETH'] as const;

/** Convert the experiment's nominal minute horizon using this symbol's actual candles.
 * This is a bar-count hold bound, not a session-flat or wall-clock exit guarantee. */
export function intradayMaxBars(cfg: Config, symbol: string): number {
  const minutes = cfg.assetClass(symbol) === 'stock' ? 120 : 60;
  const bars = Math.floor(minutes * 60_000 / cfg.timeframeFor(symbol));
  if (!Number.isSafeInteger(bars) || bars < 4) throw new Error('intraday hold policy requires at least four bars');
  return bars;
}

export function conformsIntraday(cfg: Config, symbol: string, g: Genome): boolean {
  if (!cfg.intraday) return true;
  const allowed = cfg.assetClass(symbol) === 'stock' ? HI_STOCKS : HI_CRYPTO;
  return (allowed as readonly string[]).includes(symbol) && Number.isInteger(g.maxBars) && g.maxBars >= 4 && g.maxBars <= intradayMaxBars(cfg,symbol);
}

/** Research generation only. Never project a promoted/restored/executing strategy. */
export function projectIntraday(cfg: Config, symbol: string, g: Genome): Genome {
  return cfg.intraday ? {...g,maxBars:Math.max(4,Math.min(intradayMaxBars(cfg,symbol),g.maxBars))} : g;
}

/** Pure entrypoint projection: never imports config, index, credentials or clients. */
export function highActivityEnvironment(env: Record<string,string|undefined>): Record<string,string|undefined> {
  return {...env,
    HI_INTRADAY_EXPERIMENT: HI_INTRADAY_ID,
    PROFILE:'standard', EXECUTION:'paper', PORT:'8789', DATA_DIR:'./data-hi-intraday',
    LLM_API_KEY:'', LLM_PROVIDER:'', NEWS_ENABLED:'false', DSA_ENABLED:'false',
    FROZEN_FORWARD_ENABLED:'false', LIVE_APPROVAL_FILE:'',
    SYMBOLS:[...HI_STOCKS.map(s=>`$${s}`),...HI_CRYPTO].join(','),
    TIMEFRAME:'5m', TIMEFRAME_STOCK:'5m', TIMEFRAME_CRYPTO:'15m',
    DATA_PROVIDER:'alpaca', HISTORY_BARS:'10000',
    STARTING_CAPITAL:'100000', TRADERS:String(HI_STOCKS.length+HI_CRYPTO.length), RESEARCHERS:'8', RESEARCH_CPU:'0.9',
    MAX_TRIAL_TRADERS:'2', MAX_TRADERS_PER_MARKET:'1',
    MIN_TRAIN_TRADES:'120', MIN_TEST_TRADES:'24', MIN_HALF_TRADES:'8',
    FLATTEN_BEFORE_CLOSE_MIN:'0', FEE_RATE:'0.0025', SLIPPAGE_BPS:'3',
    SCAN_ENABLED:'false', SCAN_STOCKS:'false', SCAN_MAX_EXPLORED:'0', RESEARCH_CRYPTO_SHARE:'0.5',
  };
}
