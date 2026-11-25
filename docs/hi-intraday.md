# High-Activity paper short-hold experiment

## Scope

This redesign is for the **High-Activity local-paper fund only**. It does not
change Main, Niche/OKX, Small-Cap or Macro profile settings and does not authorize
real-money orders or paid model work.

The aim is to test whether shorter execution timeframes, bounded strategy holding
periods and a broader fixed candidate universe produce useful, more frequent
opportunities. It does not promise a trade count or profitability. An empty valid
candidate pool remains a reason to wait, not permission to bypass validation.

## Effective experiment controls

- **14 trader slots for 14 configured markets**, with exclusive symbol ownership;
  eight evolutionary researchers, not paid models.
- **5-minute stock/ETF bars:** SPY, QQQ, IWM, DIA, AAPL, MSFT, AMZN, GOOGL, META,
  NVDA, AMD and TSLA. **15-minute crypto bars:** BTC and ETH. Dynamic discovery is
  off, so it cannot silently repopulate the pool with SNXX or leveraged variants.
- Research-time stock holds are bounded to **4–24 bars**; crypto holds to **four
  bars**. Those are nominally up to 120/60 minutes only when bars arrive without
  session gaps. Invalid already-approved/restored genomes are rejected, not repaired.
- Standard local-paper risk: at most 1x gross exposure, 0.1% planned stop risk per
  trade, 0.25% shared per symbol and a 1% daily-loss review latch. Promotion still
  requires at least 120 training / 24 holdout / eight per-half trades plus the
  existing quality tests. These are historical screening counts, not forward quotas.
- Alpaca is selected for market data and requires data credentials. The feed
  requests 10,000 bars and refuses a symbol below **1,500 completed bars**; the
  request size is not a promise of available historical coverage. Real market-data
  connectivity and permissions must be verified during a reviewed rollout.
- Runtime reports `runtime.experiment: "hi-intraday-v1"`. Persisted experiment
  enrollment uses identity `hi-intraday-paper-v1`; those identifiers have different
  roles and are not interchangeable. Missing, corrupt, legacy or mixed custody is
  rejected rather than reset. Enrolled data cannot be started as an ordinary fund.

## Preserve the old experiment

Use a distinct durable data directory for the new experiment. Keep the old
`data-hi` intact: do not delete it, reset its season, relabel its results as new
intraday performance or import its existing assignments/positions into a changed
strategy policy. This is a separate paper cohort and must be evaluated separately.

Only the High-Activity service should be considered for a reviewed rollout. A
GitHub update is not evidence that the running fund has changed. Confirm the
runtime experiment marker and measured artifact identity after any rollout; do
not restart the other funds as part of this change.

## Execution and evidence boundaries

- Keep one strategy owner per symbol, including pending entries, and preserve
  existing planned-stop-risk, exposure, reconciliation and unknown-order gates.
- Keep configured costs and quality thresholds. Shorter bars do not make fees,
  spread or execution uncertainty disappear.
- Apply the same holding policy during research, validation and execution. Do
  not improve a backtest by changing the accepted genome afterward.
- A maximum number of completed bars is not an elapsed wall-clock deadline:
  closed stock sessions, weekends and missing data can extend a position's
  calendar holding time. This experiment is **not guaranteed flat overnight**.
  Early-close flattening is disabled. The pre-existing best-effort flatten on an
  observed market-clock transition to closed remains active for local paper;
  backtests do not model that exit. Clock polling can also lag or fail. Session
  filtering and polled-price execution differ from historical screening, so do
  not claim exact session/exit parity or guaranteed close-of-day execution.
- Do not interpret diverse ticker names as independent economic risk; ETFs and
  individual stocks can overlap substantially.

## Activity measurements

The experiment's Treasury panel reports:

- Recorded exits per **calendar day** over the observed season, only after at
  least 24 hours. It does not extrapolate the first minutes into a daily target.
- Distinct symbols and mean entry-to-exit interval in the **returned recent exit
  sample**, labeled with sample size and season exit-record count. Fund exit
  records may include partial exits; they are not necessarily complete round
  trips. Open positions and entry orders are not included in those statistics.
- Coverage of retained per-trader entry diagnostics, including no-signal checks,
  risk denials, submission attempts and booked entries. Missing coverage is
  unavailable, not zero. These counters are not unique candles, an exhaustive
  pipeline funnel or independently verified broker fills.

Malformed/duplicate recent exits do not become valid-looking holding/diversity
statistics. These UI calculations are observational and cannot approve an order,
change a candidate, reset a counter or grant model spending.

## Market-data and simulation limits

Alpaca's stock-bars API documents 5-minute aggregates. Actual coverage, timeliness,
entitlements and history depth must still be checked for the selected feed; API
support is not evidence that a particular running account has sufficient data.
Alpaca's own paper-trading documentation also identifies execution effects its
simulator omits. This application uses its own local simulator for this profile;
neither simulation should be treated as proof of live fill quality.

First-party references:
- https://docs.alpaca.markets/us/v1.1/reference/stockbars
- https://docs.alpaca.markets/us/docs/paper-trading

## Acceptance before rollout

Run the complete test suite, typechecks and build after all changes settle. Test
hostile inherited settings, independent state paths, profile-specific holding
policy, frozen/unknown-intent guards, actual synthetic entry/time-exit behavior,
activity telemetry and browser rendering without real broker/model calls. Obtain
independent review and verify the exact published tree. A successful synthetic
replay is a mechanics test, not an estimate of future trade frequency or returns.
