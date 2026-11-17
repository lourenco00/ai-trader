import type { Candle, SetupWatchlistSnapshot, SetupWatchRow } from '../../shared/types';
import { rsi, sma } from '../strategy/indicators';

interface WatchConfig {
  setupWatchlistEnabled?: boolean;
  frozen?: { enabled: boolean };
  symbols: readonly string[];
  assetClass(symbol: string): string;
  timeframeFor(symbol: string): number;
}

/** Read-only research projection. Never publishes signals or changes strategies. */
export function setupWatchlist(cfg: WatchConfig, feed: { series(symbol: string): Candle[] }, now = Date.now()): SetupWatchlistSnapshot {
  if (!cfg.setupWatchlistEnabled || cfg.frozen?.enabled) return {researchOnly:true,status:'disabled',rows:[]};
  const rows: SetupWatchRow[] = cfg.symbols.slice(0, 50).map(symbol => {
    const timeframeMs = cfg.timeframeFor(symbol);
    const asset = cfg.assetClass(symbol);
    if ((asset !== 'stock' && asset !== 'crypto') || !Number.isSafeInteger(timeframeMs) || timeframeMs <= 0) {
      return {symbol,timeframeMs:Number.isFinite(timeframeMs) ? timeframeMs : 0,asOf:null,bars:0,status:'unsupported',setups:[]};
    }
    // Unknown timestamps remain invalid; safely identifiable unfinished bars cannot contaminate results.
    const candles = feed.series(symbol).slice(-250).filter(c => !c || !Number.isSafeInteger(c.t) || c.t < 0 || c.t + timeframeMs <= now);
    const invalid = candles.some((c, i) => !c || ![c.t,c.o,c.h,c.l,c.c,c.v].every(Number.isFinite)
      || !Number.isSafeInteger(c.t) || c.t < 0 || Math.min(c.o,c.h,c.l,c.c) <= 0 || c.v < 0
      || c.h < Math.max(c.o,c.c,c.l) || c.l > Math.min(c.o,c.c,c.h)
      || (i > 0 && (c.t <= candles[i-1].t || (cfg.assetClass(symbol) === 'crypto' && c.t - candles[i-1].t !== timeframeMs))));
    if (invalid) return {symbol,timeframeMs,asOf:null,bars:0,status:'invalid-data',setups:[]};
    const row: SetupWatchRow = {symbol,timeframeMs,asOf:candles.length ? candles[candles.length-1].t+timeframeMs : null,
      bars:candles.length,status:candles.length < 30 ? 'insufficient-history' : 'no-match',setups:[]};
    if (row.asOf !== null && now - row.asOf > 3 * timeframeMs) {
      row.status = 'stale';
      return row;
    }
    if (candles.length >= 30) {
      const close = Float64Array.from(candles.map(c=>c.c));
      const last = close.length - 1;
      const average = sma(close, 20);
      const strength = rsi(close, 14);
      if (close[last] > Math.max(...close.slice(-21,-1))) row.setups.push('20-BAR closing breakout');
      if (close[last-1] < average[last-1] && close[last] > average[last]) row.setups.push('SMA20 reclaim');
      if (strength[last] < 30) row.setups.push('RSI14 oversold');
      if (strength[last-1] < 30 && close[last] > close[last-1]) row.setups.push('RSI14 oversold-bounce');
      if (row.setups.length) row.status = 'match';
    }
    return row;
  });
  return {researchOnly:true,status:'enabled',rows};
}
