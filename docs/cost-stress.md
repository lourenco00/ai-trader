# Offline frozen-strategy cost stress

This CLI runs **one explicitly supplied, already frozen strategy** through the existing `server/strategy/backtest.ts` at base, 2× and 3× fee **and** slippage. It does not evolve, rank, select or retune strategies. It is sensitivity analysis, not evidence of profitability or authorization to trade.

## Run locally

From the repository root with dependencies already installed:

```sh
node --import tsx scripts/cost-stress.ts \
  --genome /absolute/path/frozen-genome.json \
  --candles /absolute/path/historical-dataset.json \
  --plan /absolute/path/predeclared-plan.json > cost-stress-report.json

node --import tsx --test tests/cost-stress.test.ts
```

The CLI reads three local JSON files and writes a JSON report to stdout (`npm run validate:costs -- --genome ... --candles ... --plan ...` is also available). Failures exit with status 1 and no partial stdout report. Missing, duplicate or unknown arguments fail. URLs are not downloaded; arguments are filesystem paths. It imports neither application config nor brokers, feeds, API clients or ecosystem boot code; no API/broker keys are needed or read. No live service should be started to use this tool.

### Local-file safety and limits

- Each of the three inputs must resolve to a **regular file**, at most **16 MiB per file** (inclusive), encoded as valid UTF-8 JSON. Oversized files, invalid UTF-8, malformed JSON, missing files, directories, FIFOs and other nonregular files fail closed. Symbolic links are allowed only when their opened target is a regular file meeting the same limits.
- Files are opened read-only with `O_NONBLOCK`, then checked using the **opened descriptor's `fstat`** before reading. In particular, opening a FIFO with no writer does not wait for a writer. Descriptors are closed in `finally` on success and failure.
- Reads use chunks of at most 64 KiB and stop after at most 16 MiB plus one overflow-detection byte per input, even if a file grows after `fstat`. Decoding is fatal on malformed UTF-8 (no replacement-character repair); a UTF-8 BOM is not stripped and is rejected by JSON parsing. The byte limit bounds input reads, not total process memory or backtest runtime. Use stable local files; concurrent file edits are not an atomic snapshot, and nonblocking mode is not a deadline for a stalled filesystem.
- Argument, filesystem, decoding, parsing and report-validation failures all emit only this fixed stderr line, never an input path, file contents, secret or raw exception:

  ```text
  cost-stress: invalid arguments or input files; see docs/cost-stress.md for usage.
  ```

  Correct the inputs locally; the CLI deliberately does not expose detailed parser diagnostics. Successful reports intentionally contain the supplied genome and dataset label, so treat report output as data rather than a sanitized log.
- Isolated subprocess regression tests enforce a five-second timeout for rejected inputs, including a real FIFO with **no writer** on POSIX (the FIFO case is skipped on Windows). They also check a secret sentinel never appears in failure output, the exact size boundary, and the unchanged synthetic success report.

## Input contracts

### `--genome`

A bare existing `Genome` object, not a strategy-vault wrapper. Fields are `side`, `entry`, `exit`, `stopAtr`, `takeProfitAtr`, `trailAtr`, `maxBars`, `sizePct`, `atrPeriod`. Conditions and indicator specifications must use the existing representation from `server/strategy/genome.ts` and indicator catalog from `server/strategy/indicators.ts`.

Validation compares the supplied genome structurally with the existing canonical sanitizer's output, **then executes the original unchanged genome**. Anything that would be defaulted, rounded, clamped, dropped, coerced, replaced, or stripped (including extra genome fields) fails rather than silently changing the frozen strategy. Object key order is immaterial. Export a canonical strategy before freezing; do not sanitize or optimize it in response to stress results.

### `--candles`

```ts
{
  kind: 'historical' | 'synthetic',
  label: string, // nonempty source/instrument/timeframe/adjustment description
  candles: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>
}
```

`t` is candle **open time in integer Unix milliseconds**, nonnegative and strictly increasing. OHLC must be finite positive numbers, with `l <= min(o,c)` and `h >= max(o,c)`; volume must be finite and nonnegative. No sorting, deduplication, missing-value repair, string-to-number conversion, or synthetic-data generation occurs. All supplied bars are validated, including unused history. Nonfinite numerical simulation/benchmark output fails closed rather than becoming JSON `null`. The benchmark also rejects unsupported intermediate arithmetic: each cost-adjusted entry/exit product and their gross-proceeds ratio must be finite positive **normal** IEEE-754 numbers (at least `2 ** -1022`). Overflow, zero underflow and subnormal intermediates fail even if subtracting one would otherwise produce a finite return. This is conservative rejection, not arbitrary-precision support for extreme prices.

Supply actual local historical observations yourself; the repository does not fabricate or fetch a market dataset for this command. Source quality, timestamp meaning, adjustments, delistings, survivorship bias, timezone/session treatment, and regular spacing are your responsibility. The tool accepts gaps and cannot infer the correct annualization for you. Set `kind: "synthetic"` for artificial fixtures; output then includes a prominent synthetic-only warning. Historical provenance is self-attested, not verified by the CLI.

### `--plan`

```ts
{
  declaredAt: number,
  frozenAt: number,
  trainingEnd: number,
  testStart: number,
  testEnd: number,
  warmupBars: number,
  costs: { feeRate: number; slippage: number; barsPerYear: number }
}
```

All five times are explicit nonnegative safe integer milliseconds. Declare the split, execution costs, annualization and warmup **before observing test results**. Required chronology:

- `declaredAt < testStart`;
- `trainingEnd <= frozenAt < testStart`;
- `testStart` and `testEnd` must exactly match dataset candle timestamps;
- `testEnd > testStart`; both boundary bars are **included**.

`trainingEnd` is the last timestamp allowed for fitting/selection, not an instruction to train. `frozenAt` attests that the supplied strategy was fixed after training and before the first test candle. These fields enforce an explicit split, but cannot independently establish that the user truly froze the strategy or never inspected the holdout. Repeated experiments or cherry-picked reports destroy the forward interpretation.

`warmupBars` is an explicit integer at least `warmupBars(genome)` from the actual genome module, and no greater than the number of dataset bars before `testStart`. Exactly that many immediately preceding bars seed indicators. Only that warmup plus the inclusive test window reaches the backtester; extra earlier history and post-test bars cannot influence results. Warmup bars may overlap training, but cannot open positions or contribute performance. There is no carried training position or pending signal: the first possible strategy signal is the close of `testStart`; its earliest fill is the next test bar's open. Initializing EMA with a finite warmup is not identical to using unlimited prehistory.

Costs are fractional rates per leg, not basis points or percentages: e.g. `0.001` means 0.1%. Both rates must be finite, nonnegative and remain below one at 3×. `barsPerYear` must be finite positive and should reflect the actual market/timeframe; it is not inferred. Zero costs are permitted but make the stress scenarios identical.

## Report and comparison conventions

The report records dataset identity, the unchanged genome, declared plan, annualization, effective window, earliest possible fill, and each scenario's rates and real backtester metrics. `metrics.totalReturn` is net return relative to starting capital; returns/drawdown/exposure are fractions, not percentage points. Metrics include closed trades, net return, drawdown, profit factor, win rate, average trade, exposure, Sharpe and Sortino.

Every scenario includes:

- **Cash:** one normalized starting unit, zero interest, zero exposure, zero return.
- **Buy-and-hold:** one normalized starting unit, fully invested long at the first test open, liquidated at the last test close. Entry fees are funded from that unit, so quantity is `1 / (firstOpen * (1 + slippage) * (1 + feeRate))`. Final net proceeds are `quantity * lastClose * (1 - slippage) * (1 - feeRate)`; subtract one for net return.
- **Adequacy:** `minimumTrades: 20`, `enoughTrades`, `profitFactorThreshold: 1.3`, and `profitFactorPass`. Both are heuristic screens after scenario costs, not proof, significance tests, or a production gate. A high PF on fewer than 20 trades is still inadequate; no-loss samples are not infinite evidence.

These are not allocation-, exposure-, volatility-, or direction-matched comparisons. The strategy uses its own `sizePct` and starts one signal/fill later; it may be short or mostly in cash. The inherited backtester sizes notional as cash × sizePct and charges fees separately, whereas buy-and-hold reserves its entry fee inside the starting capital. At sizePct=1 this difference matters. Strategy exposure counts end-of-bar positions and omits same-bar round trips; buy-and-hold's exposure=1 means continuous holding, not identical capital at risk.

## Inherited execution and metric limitations

- Signals use bar close and execute next open; intrabar stop/target checks use OHLC only, with stop-first collisions and the existing gap/trailing-stop assumptions. There is no tick-path reconstruction.
- Strategy parameters, bars and window remain identical, **not necessarily the realized trade path**. Cost-adjusted entries can change stop levels, exits, compounding and eventual trade counts. General monotonicity of strategy return is not promised. Tests establish monotonic deterioration only for a controlled synthetic path where those interactions do not change the relevant behavior; buy-and-hold net return is tested against its direct formula.
- Real backtester PF is capped at 99, including profitable samples without a loss. Drawdown/Sharpe are computed from bar marks before terminal liquidation costs; net return and closed-trade PF include final liquidation costs. These values are deliberately not relabeled as execution-grade metrics.
- The inherited low-equity early stop may shorten strategy execution versus the full-window benchmark; window metadata describes the configured horizon, not a guarantee that execution reached its end.
- No order book, market impact, dynamic spreads, partial fills, financing, borrow availability, margin, taxes or data-bias correction is introduced.

All smoke/unit fixtures are explicitly labeled **SYNTHETIC TEST ONLY**. They test mechanics, validation, boundaries, repeatability, nonmutation and actual CLI subprocess execution. They are not real strategy performance, and no historical or live profitability claim is supplied by this implementation.
