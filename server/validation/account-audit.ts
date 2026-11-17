/** Offline evidence comparison only. Never submits orders, edits a ledger or clears a review latch. */
export interface AccountAuditInput {
  now: number;
  ledger: {
    observedAt: number;
    equity: number;
    brokerOffset: number;
    positions: { ownerId: string; symbol: string; side: 'long' | 'short'; qty: number }[];
    unresolvedIntents: number;
    pendingReservations: number;
  };
  broker: {
    observedAt: number;
    equity: number;
    cash: number;
    positions: { symbol: string; qty: number }[];
    openOrders: { id: string; symbol: string; status: string }[];
    ordersComplete: boolean;
  };
}

export interface AccountAuditReport {
  readonly status: 'consistent-observation' | 'review-required';
  readonly authorizesTrading: false;
  readonly equityGap: number;
  readonly equityTolerance: number;
  readonly positions: readonly Readonly<{ symbol: string; ledgerQty: number; brokerQty: number; difference: number; tolerance: number }>[];
  readonly issues: readonly string[];
}

function invalid(): never { throw new TypeError('Invalid account audit evidence'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function timestamp(value: unknown): boolean { return finite(value) && Number.isSafeInteger(value) && value > 0; }
function count(value: unknown): boolean { return finite(value) && Number.isSafeInteger(value) && value >= 0; }
function identity(value: unknown): boolean { return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value); }
function symbol(value: unknown): boolean { return typeof value === 'string' && /^[A-Z0-9][A-Z0-9./-]{0,31}$/.test(value); }
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 10_000) return invalid();
  return value.map(object);
}
function validate(value: unknown): asserts value is AccountAuditInput {
  const input = object(value), ledger = object(input.ledger), broker = object(input.broker);
  if (!timestamp(input.now) || !timestamp(ledger.observedAt) || !timestamp(broker.observedAt) ||
      !finite(ledger.equity) || !finite(ledger.brokerOffset) || !finite(broker.equity) || !finite(broker.cash) ||
      !count(ledger.unresolvedIntents) || !count(ledger.pendingReservations) || typeof broker.ordersComplete !== 'boolean') invalid();
  for (const p of rows(ledger.positions)) {
    if (!identity(p.ownerId) || !symbol(p.symbol) || (p.side !== 'long' && p.side !== 'short') || !finite(p.qty) || p.qty <= 0) invalid();
  }
  const seen = new Set<unknown>();
  for (const p of rows(broker.positions)) {
    if (!symbol(p.symbol) || !finite(p.qty) || p.qty === 0 || seen.has(p.symbol)) invalid();
    seen.add(p.symbol);
  }
  const ids = new Set<unknown>();
  for (const o of rows(broker.openOrders)) {
    if (!identity(o.id) || !symbol(o.symbol) || !identity(o.status) || ids.has(o.id)) invalid();
    ids.add(o.id);
  }
}

export function auditAccount(input: unknown): AccountAuditReport {
  validate(input);
  const ledgerQty = new Map<string, number>();
  for (const p of input.ledger.positions) ledgerQty.set(p.symbol, (ledgerQty.get(p.symbol) ?? 0) + p.qty * (p.side === 'long' ? 1 : -1));
  const brokerQty = new Map(input.broker.positions.map((p) => [p.symbol, p.qty]));
  const positions = [...new Set([...ledgerQty.keys(), ...brokerQty.keys()])].sort().map((symbol) => {
    const expected = ledgerQty.get(symbol) ?? 0;
    const actual = brokerQty.get(symbol) ?? 0;
    return { symbol, ledgerQty: expected, brokerQty: actual, difference: expected - actual, tolerance: Math.max(1e-8, Math.abs(expected) * 1e-6) };
  });
  const issues = positions.filter((p) => Math.abs(p.difference) > p.tolerance).map((p) => `quantity-mismatch:${p.symbol}`);
  const equityGap = input.ledger.equity + input.ledger.brokerOffset - input.broker.equity;
  if (!finite(equityGap) || positions.some((p) => !finite(p.ledgerQty) || !finite(p.difference))) invalid();
  const equityTolerance = Math.max(1, Math.abs(input.broker.equity) * 0.001);
  if (Math.abs(equityGap) > equityTolerance) issues.push('equity-mismatch');
  if (input.broker.openOrders.length) issues.push('outstanding-orders');
  if (!input.broker.ordersComplete) issues.push('incomplete-order-list');
  if (input.ledger.unresolvedIntents) issues.push('unresolved-execution');
  if (input.ledger.pendingReservations) issues.push('pending-reservations');
  if (input.now - input.broker.observedAt > 180_000) issues.push('stale-broker-observation');
  if (input.now - input.ledger.observedAt > 180_000) issues.push('stale-ledger-observation');
  if (Math.abs(input.broker.observedAt - input.ledger.observedAt) > 30_000) issues.push('observation-time-skew');
  if (input.broker.observedAt > input.now || input.ledger.observedAt > input.now) issues.push('future-observation');
  const symbols = new Set<string>();
  for (const position of input.ledger.positions) {
    if (symbols.has(position.symbol) && !issues.includes(`duplicate-ledger-symbol:${position.symbol}`)) issues.push(`duplicate-ledger-symbol:${position.symbol}`);
    symbols.add(position.symbol);
  }
  return Object.freeze({
    status: issues.length ? 'review-required' : 'consistent-observation', authorizesTrading: false,
    equityGap, equityTolerance,
    positions: Object.freeze(positions.map((position) => Object.freeze(position))), issues: Object.freeze(issues),
  });
}
