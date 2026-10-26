import type { Candle, Regime } from '../../shared/types';

export interface RegimeReading {
  regime: Regime;
  trend: number; // (EMA20 - EMA100) / EMA100
  volatility: number; // annualised, recent
  baselineVol: number; // annualised, long window
}

function emaLast(values: number[], n: number): number {
  const k = 2 / (n + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function annualVol(closes: number[], barsPerYear: number): number {
  if (closes.length < 3) return 0;
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v * barsPerYear);
}

/** Coarse market weather. Drives news, the LLM brief and the village weather. */
export function readRegime(candles: Candle[], barsPerYear: number): RegimeReading {
  if (candles.length < 300) return { regime: 'unknown', trend: 0, volatility: 0, baselineVol: 0 };
  const closes = candles.slice(-400).map((c) => c.c);
  const fast = emaLast(closes, 20);
  const slow = emaLast(closes, 100);
  const trend = (fast - slow) / slow;
  const recent = annualVol(candles.slice(-96).map((c) => c.c), barsPerYear);
  const baseline = annualVol(candles.slice(-2000).map((c) => c.c), barsPerYear);
  let regime: Regime;
  if (baseline > 0 && recent > baseline * 1.6) regime = 'volatile';
  else if (trend > 0.0075) regime = 'bull';
  else if (trend < -0.0075) regime = 'bear';
  else regime = 'ranging';
  return { regime, trend, volatility: recent, baselineVol: baseline };
}
