# Technical setup watchlist — observation only

This is a selective adaptation of ideas from Jake Schincariol's
`day-trader-skill`, reviewed at upstream revision
`3d0f4ef6986f4984b7c6bd46f7ff4f87744c3abd`. It is not an installation of the
Claude skills, a broker connector, or a claim that their strategies are profitable.
The TypeScript detector is implemented locally using the existing indicator code;
no upstream Python runtime or market-data dependency is added.

## What was worth adding

An explainable watchlist of technical chart conditions, shown in the Research Lab
and exposed in `/api/state` under `setupWatchlist`. It uses only candles already
loaded by this fund's MarketFeed. It supports configured stock and crypto markets,
labels each market's actual timeframe, and does not discover or register symbols.

The conditions are observations, not buy signals:

- **20-bar closing breakout:** latest completed close is strictly above the
  preceding 20 closes. This is not a breakout above their intrabar highs.
- **SMA20 reclaim:** previous close was below its SMA20 and latest completed
  close is above its SMA20.
- **RSI14 oversold:** latest Wilder RSI14 is below 30.
- **Oversold bounce:** previous Wilder RSI14 was below 30 and latest completed
  close is above the previous close. This does not require RSI to cross 30.

These are **bar-based** rules. Twenty 15-minute bars are not twenty trading days.
No intraday-to-daily aggregation, opening-range breakout, holiday calendar,
volume/liquidity ranking, probability of profit or trade sizing is inferred.

## What stays in place

Existing evolutionary/LLM research, strategy validation and promotion, frozen
forward experiments, venue adapters, reservations, sizing, circuit breakers,
reconciliation, execution-intent recovery and account diagnostics stay in place.
The watchlist is never passed to SignalBoard, research seeds, strategy selection,
agent prompts, risk approvals, wallet mutations or order submission.

The upstream manual broker workflow would duplicate or conflict with the current
autonomous execution path. Its risk rules are not imported over this fund's
existing controls. The intraday resampling simulator and its resulting
probabilities are not imported, and Yahoo is not added as a data source.

## Enable only for observation

Default:

```dotenv
SETUP_WATCHLIST_ENABLED=false
```

To opt in in a separately reviewed configuration:

```dotenv
SETUP_WATCHLIST_ENABLED=true
```

Only literal `true` and `false` are accepted. Restart the application after a
configuration change. Merging this code does not change any deployed environment
or restart a fund. Frozen forward mode suppresses the watchlist even if enabled.

The API includes per-market status so absent matches are distinguishable from
unusable data. Disabled operation does not read candle histories. Enabled scans
have bounded work: the first 50 configured symbols and the last 250 input candles
per symbol, with at least 30 completed candles required for pattern evaluation.
This is not a whole-market scan; markets beyond that cap are not evaluated. There
are no extra network requests, paid calls, timers, sidecars, files or broker
credentials. A source observation becomes stale strictly after three of that
symbol's candle intervals have elapsed since its close.

## Data and interpretation limits

Only completed candles can contribute. Invalid or non-finite OHLCV and ambiguous
time ordering must not produce setups. The observation's `asOf` refers to the
source candle's close, not the time somebody reopens the dashboard. A fresh price
tick cannot refresh an old candle observation.

Stale data is reported rather than treated as current. Equity overnight/weekend
closures can therefore show a stale status; the watchlist is not an exchange
calendar and does not claim the market is open. It does not fill missing bars or
pretend stock session gaps are continuous crypto trading.

A simulated feed produces simulated observations, not market evidence; the normal
fund provider label still identifies the data source. More generally, detecting a
named pattern does not establish an edge after fees, spreads and slippage. Future
trading influence would require a separate change with cost-aware out-of-sample
validation and a predeclared forward test. This integration grants no such influence.
