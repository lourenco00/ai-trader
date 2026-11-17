# Opt-in frozen forward LOCAL PAPER experiment

This is a bounded fixed-policy forward observation mode, **not** rolling walk-forward optimization, a new strategy selector, or permission to trade real money. It runs existing eligible assignments with simulated local fills. It neither activates a venue nor changes the source fund. Default: off.

## Setup contract

1. Use a **separate process and separate data directory**. `DATA_DIR` remains the ordinary fund directory; `FROZEN_DATA_DIR` is the distinct experiment destination. The latter becomes the ecosystem's effective persistence directory only while opted in. Equal paths, including existing symlink aliases, are rejected. Do not run multiple writers against either experiment state or its code tree.
2. Obtain a reviewed, quiescent **local-paper** `state.json` written by this version. Its `executionMode` must be `paper`. Do not relabel a venue/live snapshot. Older unstamped snapshots require an independently reviewed offline export, not a live startup or a guessed provenance value. No automated exporter/conversion is included.
3. The seed must have no positions, execution intents or pending risk reservations in **any** wallet, including unstaffed wallets. No copied broker observations/reconciliation object or broker offset is accepted at enrollment. Assigned traders cannot be exit-only or retiring.
4. Choose the entire existing active cohort explicitly in `FROZEN_STRATEGY_IDS`. Every selected strategy must already be active, nontrial, linked to its actual restored trader, funded with positive cash/units, and in the restored/configured universe. No fresh selection, trial promotion, funding top-up, strategy swap, or automatic subset curation is performed. A seed with other active assignments is rejected rather than silently altered.
5. Copy only the reviewed paper seed to a **new** experiment directory, never `.env`, API credentials, venue observations or running ledger files. For example, after verifying the source is stopped/quiescent:

   ```sh
   install -d /absolute/experiments/frozen-btc-001
   cp /reviewed/local-paper-seed/state.json /absolute/experiments/frozen-btc-001/state.json
   ```

6. Match the source assignment's symbols/asset classes, trader count, timeframes, cost assumptions, risk, retirement and sizing/allocation controls. Declare a future absolute UTC end and written analysis/termination criteria **before** starting. For example (replace placeholders; this is not an executable launch recipe):

   ```dotenv
   EXECUTION=paper
   DATA_DIR=/absolute/ordinary-fund
   FROZEN_FORWARD_ENABLED=true
   FROZEN_DATA_DIR=/absolute/experiments/frozen-btc-001
   FROZEN_STRATEGY_IDS=<existing-active-nontrial-id>,<another-existing-id>
   FROZEN_END_AT=<predeclared-future-ISO-8601-UTC-timestamp>
   FROZEN_CRITERIA=Stop new entries at end; report change in net equity, fees, completed trades, drawdown and every retirement; no graduation.
   DATA_PROVIDER=coinbase
   ```

   Keep execution local paper even if the data provider is an exchange. Prefer an explicit public data provider rather than `auto` so data-source fallback does not change the observation regime. Stock data still requires an appropriate data client. Leave LLM and trading credentials out of this experiment environment. `DATA_PROVIDER=sim` is suitable for tests only: status explicitly reports `realDataForward=false`, even if a fake feed is injected in tests.

The criteria text is an immutable preregistration, **not** an executable rule language. The deadline is the automated experiment stop-entry criterion; ordinary risk and retirement can stop a strategy earlier. Further statistical/sample-size success criteria need independent analysis. There is no automatic experiment extension, winner selection or restart/reset button.

## What is frozen

`frozen-manifest.json` version 1 contains a canonical SHA-256 fingerprint covering:

- Selected strategy IDs, actual trader assignment, symbol, genome including size/exit controls, trial flag, origin and fixed wallet units; immutable train/test evidence, fitness, author and creation time.
- Restored universe membership, core/explored designation, asset classes and per-symbol timeframe.
- Effective per-symbol fee/slippage and frozen volume assumptions (which also determine participation caps).
- Risk, allocation, retirement, research eligibility controls, initial capital configuration, trader count, history size, configured provider and polling cadence (`pollMs`). Polling cadence affects stop/risk observation and cannot change on restart.
- A content identity of the **actual local** `server/` and `shared/` file trees, `package.json`, `package-lock.json`, `tsconfig.server.json`, Node version, platform and architecture. Source exports without `.git` work. Source/dependency-lock/config byte changes reject restarts; a revision string supplied by the operator cannot override this.
- Fixed enrollment/start timestamp, absolute end, criteria, and starting saved evidence (fund, agents, strategies, equity and trade history).

The manifest and separate `frozen-enrollment.json` seal are created exclusively, with read-only file permissions, and never rewritten. Actual frozen state (including fingerprint, cleared external signals and any expiry pause) is written through an awaited atomic checkpoint **before** the feed can start. Incomplete enrollment, null/malformed marker files, missing manifest, integrity failure, changed configuration or changed restored assignments fail closed. Even marker **existence** blocks ordinary-fund startup when opt-in is removed. A crash between seal, manifest and checkpoint creation needs offline investigation; it never silently starts a new experiment.

## Runtime behavior

- Evolution/research scheduling, strategist/LLM calls, news desks, external shadow research and dynamic discovery are not dispatched. Effective LLM/news/scanner settings are disabled. Restored board signals are cleared; scout chart signals are also not posted on candle dispatch. The scout can still provide initial market/status readings.
- Commander still reviews and retires under the existing rules, including confirmed residual liquidation. Idle assignment, upgrades, vault retesting, all capital rebalancing/top-ups, and trial graduation are disabled, including direct commander call paths. A retired strategy is never replaced. Wallet units stay fixed until retirement returns capital; natural realized trading P&L can change cash and future percentage-based order sizes. This is not fixed-dollar-per-order trading.
- Risk checks, entry reservations, durable intents, post-checkpoint revalidation, reconciliation review, normal stops/exits, kill switch and retirement enforcement are preserved. Frozen mode adds checks; it does not waive existing checks or repair holdings.
- Expiry uses the existing **entry-only review pause**, not a forced liquidation halt. Deadline checks run at entry approval, post-persistence revalidation, market-open checks, tick/minute dispatch and status. Ordinary ecosystem resume **or direct risk resume** cannot authorize a new entry while past the immutable end. Exits and retirement still run. A reservation already checkpointed when the end arrives is cancelled through existing durable intent/reservation controls rather than submitted.
- Known local-paper positions may resume after an enrolled restart with the same definition. Unknown/pending execution requires offline review and blocks startup; it is never silently cleared. Initial enrollment always requires flat state. Retired original assignments are an explicitly allowed one-way transition on restart; their original genome/evidence must still match.
- New-season reset and LLM resume are unavailable. Experiment graduation is explicitly failed in status; an old graduate badge is not inherited as a new license. This mode never auto-activates a normal fund or external execution venue.

Read-only `frozenExperiment` snapshot fields are `version`, `fingerprint`, `startedAt`, `endAt`, `criteria`, `expired`, and `realDataForward`. Existing fund totals still include seed history: analyze deltas from immutable `startingEvidence` and trades after `startedAt`, not historical aggregate return as new forward performance. The experiment's new trade log records subsequent fills; safety retirement dates/history are not reset to make results look better.

## Boundaries and operational caveats

- State persistence retains the existing atomic-rename writer, without an fsync-backed power-loss guarantee. Marker creation is also not a multi-file transaction; incomplete enrollment fails closed and needs offline review.
- This implementation does not deploy, contact a running fund, prepare production credentials, spend provider money, alter source ledgers or claim a realized forward result. Tests use fake feeds/local paper brokers.
- Hashes plus read-only files catch drift/accidental corruption, not an adversary able to rewrite the manifest, seal, state **and** code together. Preserve external copies of the initial fingerprint/manifest and use protected, single-writer storage if evidentiary integrity matters.
- Source pinning does **not** attest installed `node_modules` bytes, the Node binary itself, OS libraries, provider API responses, historical candle contents, external files outside the listed tree, or code hot-edited after startup. Dependencies must be installed faithfully from the pinned lockfile; use an immutable source/dependency image and trusted UTC clock. Runtime checks are not a cryptographic binary attestation. The configured `auto` provider can resolve differently; pin an explicit provider operationally. Symlinks encountered inside pinned source trees are unsupported and rejected.
- Restart checks validate the policy definition and original immutable evidence, not every evolving cash/live-stat value against a replayed ledger. They do not detect a fully replaced historical state, guarantee accounting auditability, or prove no look-ahead/selection bias in the seed.
- Paper slippage/liquidity assumptions are fixed estimates, not measured fills. A fixed cohort may already be overfit. One forward observation window does not establish stationarity, a statistically valid walk-forward study, an LLM causal value comparison or permission to graduate to real money.

## Verification / TDD record

`node --import tsx --test tests/frozen.test.ts` exercises the real ecosystem lifecycle, commander and trader paths with a fake feed and local paper broker. Each implementation slice was run RED before GREEN: external venue rejection; first manifest enrollment; disabled evolution/LLM/discovery and allocation; dedicated directory routing and validation; initial seed safety; durable pre-feed checkpoint and restart; deadline/resume/candle enforcement with continued exits; retirement/restart; blocking ordinary activation; external signal removal; evidence/intent restart drift; ordinary fast-loop ordering; actual source identity drift; graduation suppression; and null/malformed enrollment-marker safety. Additional green regression coverage checks disabled mode, deadline-crossing during durable entry persistence, known local-paper restart exits, deterministic source-export fingerprints and lockfile changes.

Prior local verification: **19 frozen tests passed; 171 full-suite tests passed; typecheck and production web build passed.** Earlier baseline run had the 83 existing tests passing while two sibling-agent test files temporarily lacked their implementations; that full run included their completed work.

Polling-cadence review fix: the real fake-feed lifecycle regression enrolls at `pollMs=10000`, rejects restart in the same directory at `20000` before feed startup, then successfully restarts at `10000` without changing the manifest. Before the fix, `node --import tsx --test --test-name-pattern='pollMs drift' tests/frozen.test.ts` failed with **Missing expected rejection** (0 passed, 1 failed). Adding `pollMs` to `definition.controls` made the same command pass (1 passed, 0 failed). Post-fix verification: **20 frozen tests passed; 173 full-suite tests passed; typecheck passed.** No commit, push, deploy, real venue startup or paid model call was performed.
