/** Escape anything dynamic before it goes into innerHTML (strategy names can come from an LLM). */
export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function money(x: number, signed = false): string {
  const s = Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (!signed) return `${x < 0 ? '-' : ''}$${s}`;
  return `${x >= 0 ? '+' : '-'}$${s}`;
}

export function pct(x: number, dp = 2, signed = true): string {
  const v = (x * 100).toFixed(dp);
  return signed && x >= 0 ? `+${v}%` : `${v}%`;
}

export function cls(x: number): string {
  return x > 0 ? 'good' : x < 0 ? 'bad' : '';
}

export function price(p: number): string {
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (p >= 1) return p.toFixed(2);
  return p.toPrecision(4);
}

export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function clock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function dateTime(t: number): string {
  return new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
