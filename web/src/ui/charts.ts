import type { EquityPoint } from '../../../shared/types';

function setup(c: HTMLCanvasElement): { g: CanvasRenderingContext2D; w: number; h: number } | null {
  const rect = c.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(10, Math.floor(rect.width));
  const h = Math.max(10, Math.floor(rect.height));
  c.width = w * dpr;
  c.height = h * dpr;
  const g = c.getContext('2d');
  if (!g) return null;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h };
}

/** Pixel-styled equity curve with a baseline at starting capital. */
export function drawEquity(c: HTMLCanvasElement, points: EquityPoint[], baseline: number): void {
  const s = setup(c);
  if (!s) return;
  const { g, w, h } = s;
  g.clearRect(0, 0, w, h);
  g.font = '16px VT323, monospace';
  if (points.length < 2) {
    g.fillStyle = '#5a4128';
    g.fillText('Penny records a point every minute. Check back soon.', 12, h / 2);
    return;
  }
  const pad = { l: 64, r: 10, t: 10, b: 22 };
  const vals = points.map((p) => p.equity);
  let lo = Math.min(baseline, ...vals);
  let hi = Math.max(baseline, ...vals);
  if (hi - lo < baseline * 0.002) {
    hi += baseline * 0.001;
    lo -= baseline * 0.001;
  }
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const X = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (w - pad.l - pad.r);
  const Y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);

  g.strokeStyle = '#e2cc95';
  g.fillStyle = '#5a4128';
  g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i) / 4;
    const y = Math.round(Y(v)) + 0.5;
    g.beginPath();
    g.moveTo(pad.l, y);
    g.lineTo(w - pad.r, y);
    g.stroke();
    g.fillText(`$${v.toFixed(0)}`, 4, y + 4);
  }
  g.fillText(new Date(t0).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }), pad.l, h - 4);
  const endLabel = new Date(t1).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  g.fillText(endLabel, w - pad.r - g.measureText(endLabel).width, h - 4);

  // baseline
  g.strokeStyle = '#a8741a';
  g.setLineDash([4, 4]);
  g.beginPath();
  g.moveTo(pad.l, Y(baseline));
  g.lineTo(w - pad.r, Y(baseline));
  g.stroke();
  g.setLineDash([]);

  const last = vals[vals.length - 1];
  const up = last >= baseline;
  g.beginPath();
  points.forEach((p, i) => (i ? g.lineTo(X(p.t), Y(p.equity)) : g.moveTo(X(p.t), Y(p.equity))));
  g.lineTo(X(t1), Y(lo));
  g.lineTo(X(t0), Y(lo));
  g.closePath();
  g.fillStyle = up ? 'rgba(63,174,74,0.18)' : 'rgba(217,83,79,0.18)';
  g.fill();
  g.beginPath();
  points.forEach((p, i) => (i ? g.lineTo(X(p.t), Y(p.equity)) : g.moveTo(X(p.t), Y(p.equity))));
  g.strokeStyle = up ? '#1e7a32' : '#b3261e';
  g.lineWidth = 2;
  g.stroke();
}

export function drawSpark(c: HTMLCanvasElement, values: number[]): void {
  const s = setup(c);
  if (!s || values.length < 2) return;
  const { g, w, h } = s;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const up = values[values.length - 1] >= values[0];
  g.clearRect(0, 0, w, h);
  g.beginPath();
  values.forEach((v, i) => {
    const x = (i / (values.length - 1)) * (w - 2) + 1;
    const y = h - 2 - ((v - lo) / Math.max(1e-9, hi - lo)) * (h - 4);
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  });
  g.strokeStyle = up ? '#1e7a32' : '#b3261e';
  g.lineWidth = 2;
  g.stroke();
}
