// The small-cap crypto research fund: npm run small
//
// Crypto only, hourly candles, simulated fills on Binance prices with OKX-level fees (0.35% taker) and
// slippage that grows as a coin's volume shrinks. Small caps were the one place strategies cleared the
// strict gate in testing, so this fund gives them a whole CPU instead of sharing with stocks.
//
// These coins are not tradable at size from the EU (the liquid markets are USDT pairs), so this is
// research and paper evidence, not a route to real money. It never touches Alpaca or OKX.
//
// Settings are applied unconditionally, so they win over .env and over variables a container injects
// from it: a profile is what it says it is.
const env = process.env;
env.EXECUTION = 'paper';
env.PORT = '8790';
env.DATA_DIR = './data-small';
env.SYMBOLS = 'BTC';
env.SCAN_STOCKS = 'false';
env.DATA_PROVIDER = 'binance';
env.TIMEFRAME = '1h';
env.TIMEFRAME_STOCK = '1h';
env.TIMEFRAME_CRYPTO = '1h';
env.STARTING_CAPITAL = '10000';
env.FEE_RATE = '0.0035';
env.TRADERS = '8';
env.RESEARCHERS = '4';
env.RESEARCH_CPU = '0.8';
env.RESEARCH_CRYPTO_SHARE = '1';
env.MAX_TRADERS_PER_MARKET = '4';
env.MAX_TRIAL_TRADERS = '4';
env.MIN_TRAIN_TRADES = '30';
env.MIN_TEST_TRADES = '6';
env.MIN_HALF_TRADES = '2';
env.FLATTEN_BEFORE_CLOSE_MIN = '0';
env.LLM_API_KEY = '';
env.NEWS_ENABLED = 'false';
env.SCAN_INTERVAL_MIN = '10';
env.SCAN_MAX_EXPLORED = '14';
env.SCAN_ADD_PER_SCAN = '4';
env.SCAN_MIN_VOLUME_USD = '1000000';
env.SCAN_MAX_VOLUME_USD = '150000000';
env.SCAN_SKIP_TOP_RANK = '50';
env.SCAN_MIN_MCAP_USD = '10000000';

await import('./index');

export {};
