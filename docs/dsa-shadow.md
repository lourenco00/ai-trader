# daily_stock_analysis: opt-in SHADOW research

## Safety boundary and chosen design

Default: disabled (`DSA_ENABLED=false`). Enabled default mode is **history**, which only
reads the sidecar database through two GET endpoints. It never calls analyze, starts
upstream analysis, generates reports, or requires provider keys. An empty sidecar database
returns no research; this is expected, not a request to generate paid reports.

Records are observational metadata, **not trading signals**. The adapter has no references
to broker, SignalBoard, agent prompts, strategies, sizing or risk. The ecosystem owns a
separate worker and adds its sanitized snapshot to the existing `/api/state` (and normal
world snapshots) as `dsaResearch`. No UI change or executable trading behavior was added.
No broker credentials, arbitrary report text, context payloads, URLs, provider settings or
upstream error bodies are retained or exposed. Do not use this feature as an approval to
trade or as a fix for unrelated broker reconciliation / paused LLM issues.

## Pinned source contract

Repository: `ZhuLinsen/daily_stock_analysis`.
Inspected and verified through `gh api .../commits/main` and the actual source checkout:
**`ef44660f00e08ce66dcd4dc4d2e700836c45e833`**. This is the compatibility revision, not an
unversioned promise of compatibility with future main. No upstream implementation is vendored.

Source paths at this revision:

- `api/v1/endpoints/history.py`: `get_history_list` (233+) supports
  `GET /api/v1/history?stock_code=AAPL&page=1&limit=1`; `get_history_detail` (532+)
  returns `AnalysisReport` from `GET /api/v1/history/{id}`. We require a positive numeric
  record ID, exact stock code and query ID, and matching detail ID. Numeric ID matters:
  query IDs can be shared by batch reports. Only the newest item is ingested, not backfilled.
- `api/v1/schemas/history.py`: `HistoryItem`, `AnalysisReport`, `ReportMeta`, `ReportSummary`.
  Report shape is `{meta:{id?, query_id, stock_code, created_at?, asset_type?, ...},
  summary:{action?, sentiment_score?, ...}, ...}`. Missing timestamp is rejected. Explicit
  non-stock asset type / market-review reports are rejected. Missing action stays null;
  advice text is not parsed into a signal. Sentiment is a raw nullable integer (upstream
  permits historical values outside 0..100), **never confidence or direction**.
- `src/schemas/decision_action.py:21`: preserve exact eight-state taxonomy:
  `buy`, `add`, `hold`, `reduce`, `sell`, `watch`, `avoid`, `alert`. Unknown values are
  rejected, not forced to hold. Hold/watch/null never become buys. Sell/reduce are upstream
  long-position exits, **not short instructions**. No actions execute in this integration.
- `api/v1/schemas/analysis.py`: `AnalyzeRequest`, `TaskAccepted`, `TaskStatus`,
  `AnalysisResultResponse`. Optional submit mode sends exactly:
  `{stock_code, async_mode:true, notify:false, force_refresh:false, report_language:"en"}`
  to `POST /api/v1/analysis/analyze`; accepts a bounded safe `task_id` with
  pending/processing status. Polls `GET /api/v1/analysis/status/{task_id}`.
- `api/v1/endpoints/analysis.py`: `get_analysis_status` (1170+),
  `_build_task_analysis_result` (1067+). Completed report is **`result.report`**, not a
  top-level report. Task ID, result stock, result query and report meta must agree.
  `src/services/task_queue.py:818-822` passes `query_id=task_id` to `analyze_stock`;
  `src/services/analysis_service.py` preserves that ID in the result and report metadata.
  Both completed query IDs must equal the accepted task ID, not merely each other.
  Failed/cancelled/cancel_requested tasks stop; malformed or transport errors consume
  the poll allowance. Upstream in-memory queues are process-local; its DB fallback is
  not a guarantee that an interrupted task resumes. Never rely on upstream dedupe for cost safety.
- `main.py:407-436`: `--webui-only --host ... --port ...` are actual supported flags.
  `docker/Dockerfile:104-105` defaults to **`--schedule`**: NEVER start the default command.
  The supplied standalone Compose explicitly overrides it and disables scheduling.

Upstream daily candles / phase labels are not a verified intraday feed. US stock/ETF
coverage, vendor availability, accuracy and profitability have **not** been live-validated.
Stock-only allowlisting is a local eligibility policy, not a coverage guarantee.

## Timezone contract (important)

Upstream `ReportMeta.created_at` is optional and examples/runtime can produce naive ISO
strings. Default parser requires ISO datetime with `Z` or numeric offset, a valid calendar
date, no more than 60 seconds future skew, and age within `DSA_MAX_AGE_HOURS` (48 default).

To consume new naive reports from the supplied sidecar, explicitly set `DSA_ASSUME_UTC=true`
**only after verifying that the sidecar process uses UTC**. The Compose sets `TZ=UTC`.
Upstream's image bakes `/etc/localtime` as Asia/Shanghai, but Python/libc process timezone
honors `TZ`; verify in that exact container with:

```bash
docker compose -f deploy/dsa-shadow.compose.yml --profile dsa-shadow exec dsa-shadow \
  python -c 'import time,datetime; print(time.tzname, datetime.datetime.now(), datetime.datetime.now(datetime.timezone.utc))'
```

Historical naive timestamps written in Asia/Shanghai are NOT converted by setting TZ on
restart. Use timezone-correct migrated/copied history or keep the strict default and reject
such records. Never blindly label old local timestamps as UTC. Six fractional second digits
from Python are accepted. Null/malformed dates and mismatched/stale reports are rejected.
Already-ingested records dynamically acquire `stale:true` after expiry; freshness is not
renewed by repeated reads or restarts.

## Manual private sidecar setup (no auto-deploy, no paid calls)

These are operator instructions, not actions performed by this change. Build/start only
after review. Keep sidecar outside the trading source tree and never mount the trader data,
ledger, source, credentials, shared `secrets.env`, broker keys or Docker socket into it.

```bash
git clone https://github.com/ZhuLinsen/daily_stock_analysis.git /opt/dsa-shadow-source
git -C /opt/dsa-shadow-source checkout --detach ef44660f00e08ce66dcd4dc4d2e700836c45e833
test "$(git -C /opt/dsa-shadow-source rev-parse HEAD)" = ef44660f00e08ce66dcd4dc4d2e700836c45e833
export DSA_SOURCE_DIR=/opt/dsa-shadow-source
# Inspect rendered configuration before manually starting ONLY this optional service.
docker compose -f deploy/dsa-shadow.compose.yml --profile dsa-shadow config
docker compose -f deploy/dsa-shadow.compose.yml --profile dsa-shadow up -d --build dsa-shadow
# Read-only readiness / history check, not analyze:
curl --fail 'http://127.0.0.1:8000/api/v1/history?stock_code=AAPL&page=1&limit=1'
```

The image source revision is immutable; base images and upstream Python/npm dependency
resolution are not fully reproducible. Build once, audit and optionally record the built
image digest before deploying. Normal `docker-compose.yml` is unchanged; the sidecar
file is standalone with an explicit profile, no automatic restart, no keys and an internal
network that blocks ordinary outbound provider access. Do not add a watchtower/updater.

Sidecar volumes are separate. To ingest pre-existing history, restore an operator-reviewed
**copy/backup** of upstream `stock_analysis.db` into its dedicated data volume while the
sidecar is stopped (including a correct SQLite backup/WAL checkpoint). Never mount a live
writer's SQLite DB directly. The upstream entrypoint handles volume ownership. Empty
history needs no provider configuration. Do not click upstream Analyze to test readiness.

Only loopback publishes port 8000; API authentication is optional upstream admin **session
cookie** authentication, not a documented service Bearer token. This client sends no auth
header or cookie and does not implement login. Use an isolated, access-controlled sidecar
without admin auth for the integration; auth-enabled endpoints safely fail as transport
errors. Do not expose the unauthenticated sidecar to the Internet or other untrusted users.
If shared-host untrusted users can reach loopback, add OS/network isolation before enabling.

For the existing containerized trader, `127.0.0.1` inside the trader is NOT the sidecar.
Attach only the intended trader service to the private `dsa-shadow` network (preserve its
existing default network); set its per-service `DSA_BASE_URL=http://172.30.91.2:8000`.
Use a non-conflicting subnet if 172.30.91.0/24 is already allocated. Do not attach the other
profiles, publish a public port, or put DSA settings in the shared secrets.env. A host-run
trader uses the default loopback origin instead. Only literal loopback/RFC1918 IPv4 or
IPv6 loopback origins are accepted; DNS names, credentials, query/path/fragment and
redirects are refused. HTTPS uses normal certificate verification; no insecure TLS bypass.

Trader configuration (set only on the chosen instance):

```dotenv
# AAPL must ALSO exist as $AAPL in the trader's existing SYMBOLS configuration.
# Do not change execution mode or broker setup as part of enabling shadow research.
DSA_ENABLED=true
DSA_MODE=history
DSA_SYMBOLS=AAPL
DSA_BASE_URL=http://127.0.0.1:8000
DSA_ASSUME_UTC=true
DSA_MAX_DAILY=0
```

The existing stock market-feed setup still needs its own credentials/configuration; this
adapter neither uses nor forwards them. Do not start a real trading runtime to test this
feature: use `node --import tsx --test tests/dsa.test.ts` against local fake HTTP servers.

## Optional automatic submissions: explicit spend authorization required

History is recommended. Submit mode is provided for an operator who separately authorizes
paid analysis and provisions a private sidecar with its own provider credentials and network
egress. It is **not enabled** by the supplied Compose or defaults. Never reuse trader
secrets. Use a dedicated sidecar provider account / hard provider-side spending limit.

`DSA_MODE=submit` requires explicit `DSA_MAX_DAILY=1..10`. This is a maximum count of
submission **attempts per UTC calendar day**, across the allowlist, not a dollar or token
budget. One upstream job can make multiple paid/search/data-provider calls; the app LLM
budget does not cover these costs. Midnight can allow a new day's submissions even while an
upstream job from yesterday is still running. Fair allocation across symbols is not promised:
the allowlist is processed in order. At most one submission per symbol per day.

Intent and poll count are atomically checkpointed, file/directory synced **before** POST/GET.
The UTC day is rechecked after the awaited intent checkpoint and before POST. If midnight
crossed, the old authorization is skipped; a later tick durably charges the new day's attempt.
Timeout, 409, disconnect, malformed acceptance or crash after POST is ambiguous: that symbol
stays charged and **is not re-submitted that day**, including after restart. No automatic
retry of POST. A returned task ID resumes bounded GET polling across restart, at most
`DSA_MAX_POLLS` requests (default 30), one per worker interval. Pending tasks expire when
the UTC day advances; they are not cancelled remotely. Clock rollback does not reset budget.
Do not delete/restore old checkpoints to retry a job; inspect upstream history manually.
This is an at-most-attempt policy, not exactly-once delivery or a claim that no charge occurred.

Use **one running writer per DATA_DIR** on a local durable filesystem supporting atomic
rename/fsync. Multi-process sharing and network filesystems are unsupported. Corrupt,
oversized, schema-invalid or unwritable research checkpoints fail the worker closed without
HTTP traffic, including an existing file containing JSON `null` (only ENOENT means absent),
without taking trading down. On storage error, resolve it offline and restart; never erase cost intent
without reviewing upstream paid jobs. Restarting on a future UTC day starts a new allowance.

## Limits and observing status

All settings are in `.env.example`; invalid booleans/enums, duplicate or malformed symbols,
URLs and out-of-range/noninteger numbers fail configuration rather than silently widening scope.
Exact uppercase bare symbols (no `$` in DSA_SYMBOLS), maximum 10, must currently be in the
mutable configured universe AND explicitly classified `stock`. Removed/crypto/unknown symbols
cause no HTTP request. Eligibility is rechecked before every HTTP request and when accepting its response.

- `DSA_INTERVAL_SEC`: 10..86400, default 300; one background batch at a time; overlapping
  ticks skip. Startup loads local state and schedules HTTP without waiting for a report.
- `DSA_TIMEOUT_MS`: 50..30000 (5000 default), covers headers **and streaming body**.
- `DSA_MAX_BYTES`: 1024..1048576 (262144 default), checks declared and streamed decoded size.
- `DSA_MAX_AGE_HOURS`: 1..168 (48 default).
- `DSA_MAX_RECORDS`: 1..500 (100 default), bounded separate `DATA_DIR/dsa-research.json`;
  latest observational records only, not a trade ledger or full research archive.
- `DSA_MAX_POLLS`: 1..100 (30 default). Maximum 10 allowed symbols bounds requests per batch.

`dsaResearch` exposes enabled/running/mode/shadowOnly, fixed error codes, budgetDay,
dailyCap, attemptedToday (for budgetDay), pending/exhausted/ambiguous counts and sanitized
records `{symbol,queryId,reportId,createdAt,receivedAt,action,sentimentScore,stale}`.
`lastError`: `transport_error`, `invalid_report`, `storage_error`, `task_failed`, or null;
never exception text/endpoint internals. Historical observations remain on disk but the
snapshot filters currently ineligible symbols. Stop clears the worker timer, aborts HTTP and
invalidates and awaits any shared in-progress initialization, then waits for local work to
settle; concurrent starts cannot resurrect a stopped worker. It never cancels or resubmits
a remote job. No report wait or
poll sleep is placed in trading ticks. No new API command enables submissions remotely.

## Verification performed

Baseline after `npm ci`: 63 tests, typecheck and build passed. Before dependencies were
installed, test/typecheck/build could not run (tsx/tsc/vite absent).

Actual vertical RED → GREEN runs used `node --import tsx --test tests/dsa.test.ts`, or its
`--test-name-pattern` subset. Observed failures included missing integration module,
4 unwanted disabled/crypto requests, acceptance of mismatched reports, ignored opt-in
settings, rejection of explicitly opted-in UTC naive dates, followed redirects, missing async
POST, overlapping ticks, unbounded records (4 vs 2), missing ecosystem ownership,
missing budget counters, stale snapshot metadata, start/stop initialization race, and
Date.parse normalizing November 31. Each was implemented and rerun green before continuing.
Local HTTP tests exercise real fetch POST/list/detail/status paths; no paid/external analysis
was invoked. Lifecycle test replaces only the external market feed startup, with provider
spend/scan/LLM disabled, and compares board/strategies/risk/fund before/after research.

No live source coverage, sidecar image build/run, provider cost estimate, external analysis,
trading startup, deployment or publication was performed by this change. Source contracts
were read; readiness in your environment still requires operator verification above.

Independent-review fixes each received a separate observed RED → GREEN regression:
concurrent starts resurrected a stopped worker (`running:true` instead of false); an awaited
intent checkpoint crossing UTC midnight sent a stale POST (1 instead of 0); JSON `null`
was treated as absent (`lastError:null` instead of `storage_error`); matching but unrelated
completed query IDs were accepted (1 record instead of 0). Initialization is now shared and
awaited by stop, POST authorization revalidates the day, every existing checkpoint is restored
or rejected, and completed query IDs are bound to the accepted task. Submit fixtures now
follow the pinned upstream task/query identity contract; history query IDs remain unchanged.

Final checks after review fixes: 20 targeted DSA tests passed; full `npm test` passed 83/83;
`npm run typecheck`, `npm run build`, and `git diff --check` passed.
Before these fixes, parent verification passed 79 tests, typecheck, build and `git diff --check`;
the revised changes still require the parent's independent rereview.
Compose rendered successfully with the official standalone Docker Compose v5.7.1 binary
(SHA-256 checked against its release checksum), using the pinned source checkout.
The rendered service retained its API-only command, loopback-only port, internal network,
separate volumes and disabled scheduling. No image/container was built or started.
