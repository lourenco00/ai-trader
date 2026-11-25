import type { EntryDecisionReason, WorldSnapshot } from '../../../shared/types';
import { esc } from './format';

/** Observations only: never a source of assignment, entry or spending authority. */
export function activityPanel(s: WorldSnapshot): string {
  if (s.runtime?.experiment !== 'hi-intraday-v1') return '';
  const validClock = Number.isSafeInteger(s.serverTime) && Number.isSafeInteger(s.seasonStartedAt) &&
    s.seasonStartedAt > 0 && s.serverTime >= s.seasonStartedAt;
  const validTotal = Number.isSafeInteger(s.fund.trades) && s.fund.trades >= 0;
  const days = (s.serverTime - s.seasonStartedAt) / 86_400_000;
  const frequency = !validClock || !validTotal ? 'unavailable' : days >= 1
    ? `${(s.fund.trades / days).toFixed(2)} per calendar day` : 'Accumulating 24h';
  const validSample = validClock && validTotal && s.trades.length <= s.fund.trades &&
    new Set(s.trades.map(t => t.id)).size === s.trades.length && s.trades.every(t =>
      typeof t.id === 'string' && t.id.length > 0 && typeof t.symbol === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(t.symbol) &&
      Number.isSafeInteger(t.entryTime) && Number.isSafeInteger(t.exitTime) &&
      t.entryTime >= s.seasonStartedAt && t.exitTime >= t.entryTime && t.exitTime <= s.serverTime);
  const symbols = validSample ? [...new Set(s.trades.map(t => t.symbol))].sort() : [];
  const meanHold = validSample && s.trades.length ? s.trades.reduce((n,t) => n + (t.exitTime-t.entryTime)/60_000,0) / s.trades.length : null;
  const telemetry = s.traders.flatMap(t => {
    const counts = t.entryDiagnostics?.counts;
    return counts && typeof counts === 'object' && !Array.isArray(counts) &&
      Object.values(counts).every(n => Number.isSafeInteger(n) && n! >= 0) ? [counts] : [];
  });
  const labels: [EntryDecisionReason,string][] = [['no-signal','No-signal checks'],['risk-rejected','Risk denials'],
    ['submission-attempted','Submission attempts'],['entry-filled','Booked entries']];
  const decisions = labels.map(([key,label]) => {
    const n = telemetry.reduce((sum,c) => sum + (c[key] ?? 0),0);
    return `${label}: ${telemetry.length === s.traders.length && telemetry.length > 0 && Number.isSafeInteger(n) ? n : 'unavailable'}`;
  }).join(' · ');
  return `<h3>Trading activity</h3>
    <p>Exit-record frequency: ${frequency}. Observed frequency is not a trade quota.</p>
    <p>Recent sample: ${validSample ? `latest ${s.trades.length} of ${s.fund.trades} recorded exits; ${symbols.length} distinct symbols${symbols.length ? ` (${symbols.map(esc).join(', ')})` : ''}` : 'unavailable (invalid or duplicate trade data)'}.
    Mean entry-to-exit interval: ${meanHold === null ? 'unavailable' : `${meanHold.toFixed(1)} min`}. Exit records can include partial exits, not only completed round trips. Sample is not a full-season attribution or a count of entry orders.</p>
    <p>Telemetry coverage: ${telemetry.length}/${s.traders.length} traders. ${decisions}.</p>
    <p class="muted">Decision counters are retained best-effort observations, not unique candles or independently verified fills. Missing coverage is unavailable, not zero.</p>`;
}
