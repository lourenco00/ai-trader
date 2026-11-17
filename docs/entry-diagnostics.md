# Trader entry-decision diagnostics

Each `traders[]` snapshot includes additive `entryDiagnostics`:

- `counts`: fixed bounded reason vocabulary, monotonically increasing saturated safe-integer counters.
- `lastReason`: last recorded entry-path outcome, or null before evaluation.
- `lastAt`: epoch milliseconds of that evaluation.

Trader agent panels also show the last entry decision, no-signal checks and entry broker-call count through normal agent stats. Diagnostics are observational only: no risk limit, strategy threshold, wallet, order or fill is changed to make activity increase.

## Interpretation

The actual candle/open path reports no strategy, insufficient history, no signal, invalid ATR, unresolved execution, exit-only/retiring state, closed session, invalid/lot-minimum size, minimum notional, rejected risk reservation, unavailable post-checkpoint current price, confirmed no-submission/checkpoint cancellation, broker invocation, booked entry, and unknown execution failure.

`submission-attempted` means **broker adapter invoked**, not exchange acceptance or a guaranteed venue POST. `entry-filled` is recorded only after successful booking checkpoint; it is not a substitute for venue fill history. `checkpoint-cancelled` includes any typed `NotSubmittedError` guarantee, including adapter pre-submission rejection. Unknown outcomes retain the original unresolved intent and review semantics.

Counters count evaluation events, not unique signals, strategies or completed trades. Idle/no-strategy callbacks may occur for multiple market broadcasts. Assigned traders ignore unrelated symbols without changing diagnostics. No-signal checks do not reach the risk gate, so zero risk blocks does not imply the trader was eligible to submit. Lifecycle/size/session reasons are reached only after a valid entry signal. Existing position management does not produce no-entry diagnostics. Pending queue work is serialized by the existing trader queue; unresolved saved intents are reported when a signal reaches the entry method.

The final authorization-to-adapter boundary remains synchronous: diagnostics for a submission are updated **after invoking the adapter**. No await, logging or diagnostic call is inserted between authorization and invocation. Existing order reservations, before/after execution checkpoints, partial-fill handling and fail-closed reviews remain unchanged.

## Persistence

Saved trader extras include a deep-copy diagnostics object. Old snapshots without it restore to empty counters. Unknown keys, negative/fractional/nonfinite/unsafe counts, invalid reason names and invalid timestamps are ignored. Only the fixed known key set is inspected. Returned snapshot objects cannot modify internal counters.

These are best-effort telemetry persisted with ordinary state, not a durable order journal. A crash between booking and the next save can lose diagnostic counts; do not use them to reconstruct fills, prove exactly-once execution or clear unresolved execution.

## Verification

`node --import tsx --test tests/entry-diagnostics.test.ts` exercises actual Trader candle/open methods against deterministic synthetic candles and a fake broker. Four early candle reasons and seven signal-path skips were each observed failing before instrumentation, then passing; post-checkpoint missing price and broker-invocation/booking counters also failed before implementation. Save/restore initially failed before additive persistence was added. Revoked authorization and ambiguous failures retain existing safety behavior. The original real risk/trader checkpoint, guard and fake-Alpaca regression suite must also pass before publication.
