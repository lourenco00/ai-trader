// Look up any coin: npm run coin -- HUMA   (or a CoinGecko id, e.g. npm run coin -- osmosis)
import { config } from './config';
import { CoinIntel, describeDossier } from './market/intel';

const query = process.argv[2];
if (!query) {
  console.log('usage: npm run coin -- <ticker or coingecko id>');
  process.exit(1);
}
const d = await new CoinIntel(config).lookup(query, { fresh: true });
console.log(d ? describeDossier(d) : `No data found for "${query}" on CoinGecko or DEX Screener (or the free rate limit is exhausted; wait a minute).`);

export {};
