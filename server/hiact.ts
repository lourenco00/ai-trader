// The high-activity paper profile: npm run hi
//
// A third ecosystem, next to the Alpaca fund and the OKX one, that is allowed to trade a lot and
// risk more: more traders and researchers, a bigger share of the CPU, 15-minute candles, liquid
// stocks (no commission) plus BTC and ETH, 2x leverage and looser loss limits. Fills are simulated
// against live prices with its own $100,000, so it never touches the Alpaca account. The promotion
// gate is unchanged: only the amount risked differs, which keeps the comparison honest.
//
// Settings are applied unconditionally, so they win over .env and over variables a container injects
// from it: a profile is what it says it is.
const env = process.env;
env.PROFILE = 'aggressive';
env.EXECUTION = 'paper'; // simulated fills, never Alpaca or OKX orders
env.PORT = '8789';
env.DATA_DIR = './data-hi';
env.LLM_API_KEY = ''; // no paid LLM here
env.NEWS_ENABLED = 'false';
env.SYMBOLS = '$SPY,$QQQ,$NVDA,$TSLA,$AMD,BTC,ETH';
env.TIMEFRAME = '15m';
env.TIMEFRAME_STOCK = '15m'; // commission-free stocks suit short candles
env.TIMEFRAME_CRYPTO = '1h'; // crypto costs too much for 15m; small caps pass the gate on 1h
env.STARTING_CAPITAL = '100000';
env.TRADERS = '24';
env.MAX_TRIAL_TRADERS = '10';
env.MAX_TRADERS_PER_MARKET = '8'; // strategies bunch up on a few volatile stocks; the exposure caps still bound the total
env.RESEARCHERS = '8';
env.MIN_TRAIN_TRADES = '120'; // four times the usual trades per window, so strategies trade often
env.MIN_TEST_TRADES = '24';
env.MIN_HALF_TRADES = '8';
env.FLATTEN_BEFORE_CLOSE_MIN = '0';
env.RESEARCH_CPU = '0.9';
env.FEE_RATE = '0.0025'; // crypto at Alpaca's taker rate; stocks are charged nothing
env.SCAN_STOCKS = 'true';
env.SCAN_INTERVAL_MIN = '15';
env.SCAN_MAX_EXPLORED = '16';
env.SCAN_ADD_PER_SCAN = '4';
env.RESEARCH_CRYPTO_SHARE = '0.5';

await import('./index');

export {};
