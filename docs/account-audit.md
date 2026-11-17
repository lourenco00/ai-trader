# Offline account evidence audit

`npm run audit:account -- evidence.json` compares explicitly exported ledger and broker observations. It **does not connect to a broker, submit/cancel orders, repair state, clear a pause or authorize trading**. Exit codes: 0 = observations consistent within tolerances; 2 = review required; 1 = invalid/incomplete schema or unreadable/oversized input. JSON only, regular UTF-8 files up to 8 MiB, at most 10,000 rows per collection. Errors omit input content.

## Evidence contract

Use actual records from the same dedicated account and venue environment. Do not substitute dashboard assumptions for missing records. The input shape is `AccountAuditInput` in `server/validation/account-audit.ts`:

- `now`: evaluation time, UTC epoch milliseconds. For current checks set this to the actual current time, not the export timestamp. Historical replay only establishes consistency at the supplied historical evaluation time.
- `ledger.observedAt`, `equity`, explicit `brokerOffset`, `positions`, `unresolvedIntents`, `pendingReservations`.
- Each ledger position: `{ownerId, symbol, side: 'long'|'short', qty}` with positive quantity.
- `broker.observedAt`, `equity`, `cash`, `positions`, `openOrders`, `ordersComplete`.
- Each broker position: `{symbol, qty}` with **signed** quantity, negative for short. Export every holding, not just configured symbols.
- Each outstanding broker order: `{id, symbol, status}`. Include accepted/unfilled and partially filled orders. Do not treat no positions as no orders.
- `ordersComplete` may be true only after exhausting actual outstanding-order pagination successfully. A capped/failed query is incomplete. Do not manufacture zero counts when uncertain.

Identifiers are preserved exactly; malformed symbols are rejected, not trimmed/uppercased. Ledger sides must be the literal strings `long` or `short`; arrays or other values that stringify to those strings are rejected. Duplicate broker symbols are rejected; consolidate real lots with an audited process before producing an account-level export. Multiple ledger rows for the same symbol are reported for review even if their net quantity matches the broker.

Quantity tolerance is max(1e-8 units, 1e-6 of expected signed quantity). Expected account equity is ledger equity plus the explicit account/fund offset; tolerance is max($1, 0.1% of broker equity). Missing offsets must not be guessed to eliminate a gap. Observations older than 180 seconds, more than 30 seconds apart, or in the future require review. Those thresholds do not make separate endpoint reads atomic.

Cash is validated as finite evidence but **cash movements, realized P&L and fees are not reconstructed**. A matching report cannot prove execution history is complete, establish which orders belong to a lost response, or establish fund profitability. Keep original statements, account identity/environment, timestamps and fill records in a separately protected audit bundle. No secrets or account credentials belong in this JSON.

## Recovery boundary

The returned `AccountAuditReport` is deeply immutable: its exported types are readonly, and the report, every position row, the positions array and the issues array are frozen at runtime. Input evidence is neither mutated nor frozen; subsequent input edits cannot alter the report. JSON output is a serialization of that evidence, not a trading authorization.

For any discrepancy or unknown execution, follow `docs/risk-safety.md`'s stopped-process recovery. Preserve holdings, pending reservations, execution intents, exit-only flags and risk latches. This tool intentionally cannot write a corrected ledger. A production repair requires verified fills/order history, backups and a reviewed exact diff; current read-only monitoring exposes insufficient evidence for such a repair.

## Verification

Tests use explicit synthetic evidence only, not venue requests or inferred production fills. The first test failed because the audit module did not exist, then passed after implementation. Signed mismatch and ten review conditions were observed failing before their fixes. Ten malformed-evidence cases were observed failing before input validation. The CLI smoke failed before the CLI existed, then passed for consistent/review/malformed files.

Independent-review fixes used separate RED/GREEN cycles:

- `node --import tsx --test --test-name-pattern='JSON-array ledger side' tests/account-audit.test.ts`: RED, one failure (`Missing expected exception`) for JSON `side: ["long"]` paired with broker quantity -2. Direct literal side validation then made the targeted suite GREEN, 26 passing.
- `node --import tsx --test --test-name-pattern='rejects FIFO' tests/account-audit.test.ts`: RED, one failure (`ETIMEDOUT`) at the 3-second subprocess bound. Opening read-only with `O_NONBLOCK` before descriptor-based `fstat` then made the targeted suite GREEN, 27 passing. The CLI rejects nonregular descriptors before reading; FIFOs need no writer and produce exit 1 with the same sanitized error as other rejected inputs. The test uses `os.tmpdir()` (honoring `TMPDIR`) and kills a hung subprocess at the bound.

Additional coverage verifies byte-for-byte evidence readback after consistent, review and malformed CLI runs; invalid UTF-8, oversized, missing and directory inputs all produce exit 1, no stdout and the exact sanitized error. Existing files remain byte-for-byte unchanged after rejection. These checks passed against existing behavior without additional production changes. The final immutability regression was observed RED (`Object.isFrozen` returned false), then GREEN after freezing the report and all nested output containers/rows. It attempts property replacement, nested edits, array push/splice and post-audit input edits for both consistent and review-required reports, including an empty issues array. Final targeted suite: `node --import tsx --test tests/account-audit.test.ts` — **33 passing, 0 failing**. `npm run typecheck` passed for server, web and tests. Caller-supplied `now` remains the forensic evaluation time; the CLI neither substitutes wall-clock time nor grants trading authority.
