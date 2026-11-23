# Lifecycle, activity and LLM accounting controls

These changes repair lifecycle and reporting behavior; they do not target a minimum
trade count, loosen risk limits, turn on live money, or deploy themselves.

## Quiet strategies: observe, then park

Flat strategies no longer fail simply because two/four calendar days pass. The
trader records distinct, completed, tradable candle observations at the symbol's
own timeframe after a conservative baseline. Duplicated/unfinished callbacks,
closed sessions, insufficient warmup and unresolved execution do not manufacture
observations. Stock observation targets use regular-session bar opportunities,
not weekend wall-clock time; this is not a replacement for the broker clock.

The existing `retirement.idleDays` setting now determines an observation target:
crypto uses 24-hour days, stocks use 6.5-hour regular-session equivalents, rounded
up to whole symbol-timeframe bars. Hard drawdown/probation/profit-factor rules
still retire strategies and take priority over quiet-strategy parking.

An eligible quiet strategy is shelved with `parked` metadata and a reason, rather
than added to the graveyard as a proven failure. Its realized results are retained.
Reassignment requires newer completed data; the same bar and timestamp jitter do
not immediately recycle it. Requeue preserves the prior relative NAV/drawdown
baseline so parking cannot erase losses. Existing retired records are not revived.
Frozen forward cohorts do not get this adaptive parking/reassignment behavior.

The replacement/upgrade path now checks trial eligibility/cap, wallet compatibility,
market availability, parked-data eligibility, ownership and pending/exit-only
state. A fitter trial is not permission to bypass a zero-trial policy.

## Candidate diversity

Full and trial shelves remain separate. New admissions bound same-symbol/side
variants (two full-qualified and one trial variant per side), compare variants
within a symbol and prefer retaining coverage over filling every slot with one
market. These rules manage already-validated candidates; they do not lower the
validation threshold or relax the one-owner-per-symbol execution policy.

Existing active/retired records are preserved. Restored over-quota waiting shelves
are not destructively cleared; future admissions gradually improve coverage.
Stronger near-clone replacement is atomic even in legacy over-quota shelves.

`/api/state` now exposes `allocationDiagnostics`: waiting and assignment-eligible
counts, one primary blocker per waiting candidate, and parked records. Blockers
include parked data, closed market, symbol ownership, trial cap, frozen cohort and
halted allocation. Assignment eligibility is not an entry/order approval: sizing,
reconciliation and risk checks still apply. The Vault shows this distinction.

## Research pacing and activity XP

Each evolutionary researcher admits at most one bounded epoch per symbol's new
completed dataset timestamp. Exhausted/missing data cannot monopolize the symbol
picker or block a different fresh market. Interrupted/reset work consumes its
admission rather than farming rewards by replay. Shutdown/error cancellation can
release an in-flight research reservation without counting it as completed evidence.

Per-symbol admitted timestamps are saved and validated. Restores establish a
conservative baseline for currently available history rather than treating it as
new evidence; historical epochs/XP are retained. Universe coverage counts distinct
completed dataset periods, not repeated or abandoned computational epochs.

Researchers earn baseline activity XP at completed bounded epochs, not each work
slice or repeated generation callback. Freshness pacing does not eliminate all
historical selection bias and does not turn overlapping historical holdouts into
independent forward evidence. Frozen experiments remain the separate mechanism.

All levels are labeled **activity XP** and grouped within roles. Historical levels
are preserved, while restore derives a consistent level from bounded finite XP.
Neither levels nor village animation authorize trading or prove skill. Agent DTOs
have `activityAt` and `lastWorkAt`; missing historical heartbeat data is explicitly
unknown, not reconstructed from animation or lifetime counters.

## LLM dated accounting and spending authority

A separate `llm-cost.json` ledger is atomically replaced and fsynced before any
paid request. It records inclusive UTC-day estimated costs by strategy/news/other,
attempt/success metadata, pauses and unresolved reservations. It stores no prompts,
responses, API keys or provider error bodies. Ordinary season snapshots cannot
overwrite this paid-call ledger.

The earnings guard compares **the same inclusive UTC calendar days** for
strategy-authored estimated usage and direct-authored realized P&L. It no longer
uses lifetime spend or the current budget as historical-window cost. News cost is
reported separately: news influence and evolutionary descendants remain unmeasured,
not assumed worthless and not automatically credited all evolution profit.
Configured-price dollars are estimates, not reconciled provider invoices or a
provider-enforced hard cap; main/fast pricing currently shares configured rates.

**Behavior change: `LLM_DAILY_BUDGET_USD=0` means no spending, not unlimited.**
Calls reserve a conservative configured-price allowance before transport. Concurrent
requests include each other's in-flight liabilities; allowance is not released
before its exact release checkpoint is durable. Authorization is rechecked after
persistence. Timeouts, malformed/missing usage and unknown billing retain liabilities
and require review. Provable provider rejection can release its reservation;
sanitized outcome categories distinguish it from successful calls.

Earnings and accounting pauses survive restart. An explicit, eligible War Room
request can grant a bounded evaluation: at most **$0.25 additional estimated
usage**, for at most **one hour**, within the remaining daily budget. The grant is
persisted before authority, expires at UTC day rollover, and is not automatically
reactivated after restart. It does not forgive past spending or resolve accounting
uncertainty. No grant is created by merging/deploying this code.

Legacy positive usage lacks trustworthy dated history; it migrates to an
**accounting-review pause**, preserving available lifetime counters. Existing
invalid/null/unreadable checkpoints and unresolved reservations also fail closed.
Do not delete the ledger, zero counters, reset the season or bypass the pause to
make agents look active. Reconcile billing/unknown requests offline and adopt an
explicit reviewed migration before granting new authority. The UI does not offer
an ordinary evaluation grant to clear an accounting pause.

The dated ledger is bounded to 400 recorded UTC days, 128 reservations and 32 agent
counter entries; capacity exhaustion pauses rather than silently dropping billing
liabilities. Plan a reviewed archive/migration before exhausting those bounds.

## Readiness and runtime provenance

LLM readiness distinguishes disabled, paused-earnings, paused-budget,
paused-accounting, waiting, running and provider error, with attempt/success times.
A configured flag no longer means an analyst is on duty, and a countdown no longer
overrides a pause. Failed news classification does not consume its headline batch
as successfully read. Entry telemetry remains separate from signals/fills.

Snapshots expose `runtime.artifactFingerprint`, measured once during startup from
the existing source-identity scope (server/shared bytes, package/lock/tsconfig and
Node/platform/architecture). Missing identity is labeled unavailable. This works
for source exports without Git, but it is not a signed binary/deployment attestation
or a broker verification. Configuration money mode is labeled configured; legacy
snapshots without this information are not assumed paper merely from venue name.

## Publication is not deployment

This repository update does not restart any fund, resume paid models, clear a risk
review, repair account balances or enable live trading. Before a paper rollout:

1. Back up and inspect the current source export and all fund/accounting records.
2. Identify the deployed artifact and effective profile settings; profile entrypoints
   override inherited environment values.
3. Review legacy LLM accounting migration and any unresolved broker orders/positions.
4. Note that previously merged fail-closed venue/reconciliation safeguards can block
   new entries (notably unsupported OKX reconciliation); do not disable them to
   preserve old apparent activity.
5. Check a separate paper instance with fake/provider-safe boundaries, then verify
   runtime fingerprint, limits, diagnostics, paused authority and ledger continuity.
6. Existing frozen enrollments pin source identity. Do not overwrite/refreeze their
   cohort to accept changed code; preserve the original artifact or finish the
   existing experiment before starting a distinct reviewed enrollment.

Regression tests use synthetic candles, local files and fake HTTP, never paid model
or broker orders. Passing them establishes tested behavior, not profitability or
live execution quality.
