# Validation improvements: deployment and evidence boundaries

## What this change is for

Optimize evidence quality and diagnose execution inactivity before increasing capital, risk, model spend, or trade frequency. The repository already contains the conservative entry-risk and fail-closed execution update; publishing a commit is not proof that production uses it.

Implementation entry points:

- `docs/account-audit.md`: offline comparison of independently exported broker/ledger evidence, without ledger writes or trading authority.
- `docs/entry-diagnostics.md`: actual trader early-return counters, not just risk rejection totals.
- `docs/cost-stress.md`: fixed-candidate cost sensitivity, not reoptimization or venue execution simulation.
- `docs/frozen-forward.md`: separately configured local-paper frozen forward experiment, disabled by default.

No strategy profitability is established by the implementation tests. Synthetic test fixtures are not market evidence.

## Production boundary

The agent's current production transport allows only GET state snapshots. It cannot read independent broker fills/order history, edit host configuration, back up host trading state, restart containers or deploy code. Do not broaden or bypass that restricted status bridge. A host-authorized deployment session is required for the remaining operations.

Do not clear an execution intent, pending reservation, position, daily review latch or reconciliation review merely to get a green dashboard. In particular, a cached broker equity gap is not enough information to repair accounting, and absence of internal positions is not proof that the account is flat.

## Required host-side sequence

1. Establish the actual deployed source/image and compose configuration, all profile entrypoints, volumes and data directories. The deployed source may be an exported tree without `.git`; a blind `git pull` is not a valid deployment procedure. Do not print secret environment files. Verify effective execution venue, paper/demo endpoints and live approvals from a restricted, redacted inspection.
2. Quiesce entry submission using the supported host-side procedure. Before any stop/restart, independently inspect open venue orders/positions, preserve evidence, and understand unresolved submissions. Stopping a process does not cancel existing venue orders or provide protective exits. Do not restart a second writer against the same account.
3. Back up each profile's complete configured state, append-only trade ledger, approval/configuration evidence and current deployed source/image reference. Keep secrets/backups outside published artifacts. Confirm the backup is readable.
4. Use the stopped-process recovery protocol in `docs/risk-safety.md` for Main's discrepancy. Collect account identity/environment, signed positions, the complete outstanding-order list, relevant order/fill history, fees and cash movements. Compare evidence with `audit:account`; record an audited exact repair diff only if supported by actual fills. If evidence is incomplete, keep review latched and do not invent a correction.
5. Build the reviewed new artifact separately. Run `npm ci --ignore-scripts`, `npm test`, `npm run typecheck`, `npm run build`. Do not copy demonstration state over any live season. Upgrade restored state conservatively; preserve open/pending/exit-only records.
6. Deploy one explicitly paper/demo profile first under host supervision, then read back the exact running `/api/state`. Require expected effective limits, fresh provider data, positions preserved, unresolved flags present and reconciliation evidence correct. OKX new entries are intentionally blocked by the existing safety patch until actual account/order reconciliation is implemented; do not call this a missing-key failure or bypass the gate.
7. Ordinary review/resume requires actual fresh consistent venue evidence and market data. Unknown execution cannot be cleared by normal resume. Roll back code only with compatible state and retained evidence; never restore an older snapshot over newer fills.
8. Repeat per profile only after verifying the first deployment. Keep local paper experiments separate from every production data directory/account. Do not change real-money mode or automatically enable additional LLM agents.

## Measurable next experiments

Before running any forward comparison, predeclare duration, minimum complete round trips, benchmark, costs, asset/session universe, code revision, and risk/exposure treatment. Log all experimental runs, including failures and inactive runs. Do not declare a winner based only on total return or the best historical candidate.

- Baseline rule-driven strategies versus LLM-authored candidates: use identical eligible universe, data timing, cost and risk assumptions. Report model dollars separately, and distinguish direct strategy attribution from news influences. Zero direct attributed P&L does not by itself establish the value of every news signal.
- News enabled versus disabled: the frozen baseline disables changing news input; a controlled news comparison needs separately isolated matching arms. This change does not claim to implement a causal LLM/news A/B harness or override the current earn-your-keep spending pause.
- Cost sensitivity: run the same fixed strategy through base, doubled and tripled configured costs. Failure under stress is evidence of cost fragility, not a measurement of actual venue slippage.
- Concentration: one symbol owner is not cross-symbol diversification. Sector/beta/correlation-aware group controls need validated mapping/return-history inputs and dedicated tests before activation. They are not added or claimed by this change.

There is no automatic capital increase, automatic full-village LLM rollout, real-money authorization or production deployment in this branch.
