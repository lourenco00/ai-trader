# Independent risk-review fixes

## Outcomes

- Unknown entry outcomes retain the risk reservation and a saved execution intent; unknown exits retain an intent and their unmodified ledger position. Ordinary resume, an empty broker position list, a later empty order list, and new-season reset cannot discard unresolved execution. Repeated entry/flatten attempts do not resubmit an unresolved trader's order.
- Each submission awaits an atomic state checkpoint containing the intent (symbol, side, quantity, kind, timestamp), plus the entry reservation where applicable. Submission is prevented if checkpointing fails. The fill booking and removal of intent are checkpointed afterward; failure retains a non-resumable flag. Allocator/polling pending status covers booking persistence, not just the broker await.
- Alpaca reconciliation now also reads outstanding orders. Accepted/unfilled orders block resume even when positions are empty. Failed or potentially truncated order-list responses fail closed. Limit-order tail replacement requires a confirmed terminal order state; timeouts no longer claim a cancel was confirmed. Missing execution data does not become an invented fill.
- Retirement persists an exit-only retiring reason and retains the strategy/wallet until confirmed flat. Reviews retry confirmed residual exits, including during halted ticks. Unresolved exit failures retain review/intent and suppress duplicate liquidation attempts across restart.
- Alpaca whole-share sizing is applied before risk reservation, including through the guarded broker. Sub-lot entries safely skip. Deterministic pre-submission adapter/guard rejects use a typed no-submission guarantee rather than error-message regexes; clearing those intents is checkpointed.
- Recovered unstaffed traders persist `exitOnly`, preventing subsequent assignment, upgrades, allocation and reentry after liquidation/resume. Orphans with unresolved intent but no ledger position are also retained.
- Entry authorization is rechecked synchronously after the pre-submission checkpoint, immediately before broker invocation. Own intent/reservation are excluded exactly once; current equity, wallet, market/data, reconciliation, stop risk and exposure are rechecked. Revoked entries persist a no-submission cancellation; failed cancellation persistence restores both intent and reservation and latches review. The synchronous guard wrapper adds no await. Adapter-internal async quote/tick reads and replacement submissions remain outside this invocation-boundary guarantee; see `risk-safety.md`.

## Verified locally

Final execution on the working tree:

| Command | Result |
| --- | --- |
| `npm test` | 63 tests passed; 0 failed, skipped, cancelled or todo |
| `npm run typecheck` | Exit 0 (server, web and tests) |
| `npm run build` | Exit 0; Vite transformed 19 modules and produced the client build |
| `git diff --check` | Exit 0; no whitespace errors |

Regression coverage includes deferred-checkpoint daily loss/kill switch, market closure/staleness, reduced equity/wallet/risk capacity, current-price exposure, other pending/unresolved execution, reconciliation failure/staleness/revision changes, cancellation persistence failure, no-double-count authorization at exact limits, synchronous guard delegation and raw/guarded fake Alpaca submissions. Existing coverage includes ordinary resume with no holdings, accepted outstanding orders, unresolved entry/exit restart, persistent reservations without a corresponding trader intent, real on-disk pre-submission checkpoint/restore, pre- and post-submission persistence failures, pending status through booking, partial retirement across restart/halt, orphan reentry prevention, Alpaca lot minimums, typed guard rejection, incomplete order lists and unconfirmed cancellation replacement prevention. Error/warning logs in fault-injection tests are expected simulated venue/persistence failures, not failed tests.

No commits, pushes, deployments, service starts, broker network calls or credential access were performed.

## Remaining limitations / recovery

Automatic order-history-to-ledger recovery is intentionally not implemented. An unresolved execution is **not clearable by ordinary resume**. The stopped-process, audited manual workflow in `risk-safety.md` requires full order history, terminal status / confirmed cancellation, zero outstanding orders, accounting for actual fills and fees, reviewed ledger repair and only then removal of the specific saved intent/reservation. Restart must pass fresh reconciliation before explicit resume. Do not infer no order from no positions.

The checkpoint writer uses atomic rename, not fsync-backed power-loss durability or client-order-id exactly-once execution. Legacy snapshots cannot reconstruct orders forgotten by old code. Dynamic per-asset crypto lot/notional metadata, allocated exits for legacy duplicate-symbol owners and OKX reconciliation remain unsupported. New OKX entries stay fail-closed. These offline tests establish neither live execution quality nor strategy profitability.
