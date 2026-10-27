// A second ecosystem for niche coins: npm run niche
//
// Alpaca only lists ~36 crypto pairs, so the Alpaca fund cannot trade the smaller coins. This
// instance runs next to it and researches what an EU account can trade on OKX: the USDC pairs,
// with OKX's own live prices, the account's real fee level (0.35% taker) and slippage that grows
// as a pair's volume shrinks. Orders go to OKX's demo account (play money), which lists only a
// few dozen coins, so the Explorer is limited to coins the demo can trade. Never touches Alpaca.
//
// Settings are applied unconditionally, so they win over .env and over variables a container injects
// from it: a profile is what it says it is.
const env = process.env;
env.EXECUTION = 'okx'; // OKX demo account: play money, never Alpaca, never live
env.OKX_DEMO = 'true';
env.PORT = '8788';
env.DATA_DIR = './data-niche';
env.SYMBOLS = 'BTC'; // the only permanent market; everything else is explored
env.SCAN_STOCKS = 'false';
env.DATA_PROVIDER = 'okx';
env.STARTING_CAPITAL = '4500'; // the demo account holds 5,000 USDC
env.TRADERS = '6';
env.MAX_TRIAL_TRADERS = '3';
env.RESEARCHERS = '3';
env.MIN_TRAIN_TRADES = '30';
env.MIN_TEST_TRADES = '6';
env.MIN_HALF_TRADES = '2';
env.FLATTEN_BEFORE_CLOSE_MIN = '0';
env.RESEARCH_CPU = '0.25'; // shares the server with three other funds
env.HISTORY_BARS = '5000';
env.TIMEFRAME = '1h'; // hourly: the OKX day-trading evidence fund
env.LLM_API_KEY = ''; // keep the paid LLM on the main fund only
env.NEWS_ENABLED = 'false';
env.SCAN_MAX_EXPLORED = '14';
env.SCAN_SKIP_TOP_RANK = '30'; // the EU-tradable set is small, so only the very top is skipped
env.SCAN_MIN_MCAP_USD = '5000000';
env.SCAN_MIN_VOLUME_USD = '300000'; // EU USDC pairs trade far less than USDT ones
env.SCAN_MAX_VOLUME_USD = '80000000';
env.RESEARCH_CRYPTO_SHARE = '1';

await import('./index');

export {};
