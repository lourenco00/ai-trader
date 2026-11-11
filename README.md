# AI Trader Valley

A multi-agent crypto trading ecosystem with a pixel-art village UI. Research agents evolve trading strategies around the clock, trader agents run the winners on live market data with paper money, and a risk officer and fund commander keep the whole thing honest. Everything you see in the village is driven by what the agents are actually doing.

It defaults to **local paper execution**. Alpaca/OKX adapters and approval-gated live execution exist; do not infer the venue or money mode from the legacy snapshot `mode: 'paper'` label. Inspect `EXECUTION`, `ALPACA_PAPER`, `OKX_DEMO`, endpoint overrides and live approval configuration. This risk update does not enable real money.

## Quick start

```bash
npm install
npm start            # builds the UI and starts the ecosystem
# open http://localhost:8787
```

For UI work with hot reload: `npm run dev` and open http://localhost:5173.

Requirements: Node 22.12+. No API keys needed; market data comes from Binance's public endpoint (falls back to Coinbase, then to a simulator if both are unreachable).

## The village

| Building | Who | What you'll find |
| --- | --- | --- |
| Command Center | Maxine (commander) | Fund equity curve, capital allocation per trader, the **Real Money License** checklist |
| Research Lab | Ada, Linus, Marie, Nikola (+ Prof. Quill) | Genetic-algorithm researchers, each with a specialty, and their latest results |
| Strategy Vault | | Strategies that passed the holdout test, with training, holdout and live stats |
| Trading Floor | Earl, Ant, Rosa, Blaze, Mika, Juno | Live prices, open positions, recent trades. The LED board shows live tickers |
| War Room | Sarge (risk) | Limits, the kill switch, and "new season" reset |
| Treasury | Penny | Equity curve and the trade ledger |
| Gazette | Gus | Event wire and a summary edition every 6 hours |
| Graveyard | | Retired strategies, cause of death, and how their holdout compared to live results |
| Hall of Fame | | Achievements and the agent leaderboard. Researchers take coffee breaks here |

Click buildings or villagers, drag to pan, scroll or `+`/`-` to zoom, arrow keys to move. The weather follows BTC's regime (rain when volatile, butterflies in a bull trend) and the day/night cycle follows your clock. Deep links work too: `/#building=lab`, `/#agent=t_earl`.

## How the ecosystem works

**Research.** Each researcher runs a genetic algorithm over strategy "genomes": 1-3 entry rules (ANDed), 0-2 exit rules, ATR-based stop / target / trailing stop, max holding time and position size, long or short. Indicators: SMA, EMA, Bollinger, Donchian, RSI, Stochastic, MACD, ROC, z-score, ATR%, volume ratio. Candidates are scored on three separate folds of the training data, weighted toward the worst fold. At the end of each epoch the best few face an untouched holdout (the most recent 40% of history). Only one strategy per epoch can be promoted, and only if it clears the gate after fees and slippage. The gate is deliberately hard to pass: the holdout is the most recent 40% of history, split in two halves that must both trade and earn; the Sharpe needed rises with how many strategies were already judged on that market in the last 7 days (up to 2.0); and a long strategy must beat simply holding the asset, so a rising market alone does not count as skill.

**Optional LLM strategist.** Set `LLM_PROVIDER` and `LLM_API_KEY` in `.env` and Prof. Quill wakes up. Every 30 minutes he sends the model the market regime, the working strategies and the recent failures, and asks for new genomes as JSON. The ideas are validated, clamped and put through the same gate; rejected ideas are handed to the evolutionary researchers as seeds. Only strategy parameters and market summaries are sent, never keys or wallet data. `openai` works with any OpenAI-compatible endpoint (OpenAI, OpenRouter, Ollama, LM Studio).

**Trading.** The commander hands the best waiting strategy to an idle trader with probation capital (half a normal slot, smaller for trials). Traders act on closed candles (default 15m) and check stops and targets on every price poll. Default local fills pay 0.1% fees plus 3 bps slippage each way; asset/venue overrides can differ. Hourly allocation cannot graduate a strategy until at least 20 forward closed fills, positive net P&L and profit factor >= 1.3. Per-trade planned stop risk remains capped at 0.1% of fund equity even after graduation.

**Natural selection.** A strategy is retired to the graveyard when it loses 5% on probation, draws down 12% from its peak, has a profit factor under 0.8 after 15 trades, or goes 4 days without a trade. Waiting strategies are re-tested on fresh data every 6 hours and archived if their edge faded.

**Risk.** Standard gross exposure is capped at 100% of equity and symbol notional at 50%. Planned stop risk is capped at **0.1% fund equity per trade** and **0.25% shared per symbol**, including in-flight reservations. **One owner per symbol**, including pending entries, prevents correlated duplicate strategies and ambiguous aggregate venue exits. A **1% daily equity loss** latches a new-entry pause until explicit review/resume; UTC rollover and restored saved state do not clear it. These bounds apply to aggressive profiles too. Exits bypass entry pauses. Market-data staleness blocks entries. The existing 20% standard fund-drawdown kill switch still attempts to flatten; venue failures are not guaranteed exits. See [docs/risk-safety.md](docs/risk-safety.md) for reconciliation, review and validation limits.

## Optional external research (shadow only)

The opt-in daily_stock_analysis adapter defaults to **read-only history ingestion**, with no
analysis submission or provider spend. Validated stock-only records appear under
`/api/state` → `dsaResearch`; they never enter SignalBoard, agents, strategies, risk or orders.
See [setup, pinned source contract, and private sidecar instructions](docs/dsa-shadow.md).
It is disabled by default; no sidecar is deployed or started by the normal Compose file.

## Exploring beyond the usual coins

The **Explorer** (Magellan) scans every 30 minutes for markets nobody put in `SYMBOLS`:

- **Crypto:** every USDT pair on Binance, filtered to a 24h volume band ($2M-$150M), CoinGecko market-cap rank below the top 50 and at least $10M cap. It then reads a week of hourly candles and scores volume surge, 7-day move and volatility.
- **Stocks** (needs Alpaca keys): the screener's most active names between $1 and $60 with real dollar volume.

Up to 10 explored markets are kept (`SCAN_MAX_EXPLORED`). The researchers always work on the least recently researched market, so new arrivals get attention first, and a market that yields nothing after a few epochs is dropped to make room.

Small caps are treated more harshly than BTC, on purpose: slippage rises as 24h volume falls (3 bps up to 43 bps), strategies on explored markets are long-only, one order can use at most 0.5% of the market's daily volume, and Sarge caps each explored market at 15% of the fund and all of them together at 50%. Run `npm run report` any time for a plain verdict on the season.

## The high-activity profile

`npm run hi` starts a separate local simulated $100,000 fund (http://localhost:8789), with 24 traders, 8 researchers, up to 90% research CPU, short stock / hourly crypto candles and broader notional allowances. It retains the same 0.1% trade stop-risk cap, 0.25% symbol stop-risk cap, one symbol owner, 1% manual-review daily loss pause and forward-evidence sizing gate. Extra traders may remain idle rather than duplicate symbol exposure. Fills are local simulations against market data, not Alpaca account orders. Compare using `DATA_DIR=./data-hi npm run report`.

## Real money, and the server

Real money is off by default and cannot be switched on by editing .env alone. `npm run approve-live` writes `LIVE_APPROVAL.json` only when the paper evidence (proven strategies only) says PASSING, and only after you type a confirmation sentence and set a capital cap, a per-order cap and a loss limit. The approval expires after 30 days. While live, the fund unplugs itself if the loss limit is hit, the approval expires, the evidence turns unprofitable, or the books stop matching the account, and strategies on trial are not allowed. `npm run daily` shows the season day by day. To run everything on an always-on server, see [deploy/README.md](deploy/README.md).

## Before real money

The Command Center tracks a Real Money License: 30+ days on real data, 100+ trades, positive net return, max drawdown under 15%, hourly Sharpe of 1.0+, and 3+ strategies profitable after 10 live trades. Treat a full license as evidence, not a guarantee. Paper fills ignore order-book depth, partial fills, funding rates, exchange downtime and withdrawal risk, and many strategies that look good for a month stop working.

Live adapters already exist; this checklist is not an authorization or proof of safety. In particular, OKX currently lacks integrated account/position reconciliation and therefore **new OKX entries fail closed**, including the niche demo profile; exits are still attempted. Do not enable live execution based on these tests.

## Running it 24/7

State is saved every 30 seconds and on shutdown. Each execution also awaits an atomic state checkpoint containing its intent before submission and checkpoints booking afterward. Unknown entry/exit outcomes remain blocked across restart: ordinary resume cannot clear them, even with empty broker positions. Follow the offline recovery workflow in [docs/risk-safety.md](docs/risk-safety.md); do not assume an interruption left no outstanding orders. Retiring strategies retain residual positions and retry liquidation without reentry; recovered orphan traders remain exit-only. For continuous operation:

- macOS laptop: `caffeinate -i npm run serve` keeps the machine awake (run `npm run build` once first).
- Better: a small always-on Linux box or VPS with a process supervisor such as systemd, so it restarts on crashes and reboots.

The server binds to `127.0.0.1` and has **no authentication**. If you change `HOST` to expose it, put it behind a VPN or an authenticating reverse proxy, because anyone who can reach it can pull the kill switch or reset the season.

## Configuration

Copy `.env.example` to `.env`. Main knobs: `STARTING_CAPITAL`, `SYMBOLS` (default `BTC,ETH,SOL`), `TIMEFRAME` (`5m`/`15m`/`1h`), `DATA_PROVIDER`, `FEE_RATE`, `SLIPPAGE_BPS`, `RESEARCHERS`, `TRADERS`, `RESEARCH_CPU` (fraction of one core the lab may use), and the `LLM_*` settings. Promotion, allocation and risk thresholds live in [server/config.ts](server/config.ts).

## Data

- `data/state.json`: the whole season (fund, agents, strategies, equity curve). Written atomically.
- `data/trades.jsonl`: every closed trade, append-only.
- `data/state-season-*.json`: backups made when you start a new season.

## Layout

```
server/
  agents/      researcher, strategist (LLM), trader, commander, riskOfficer, support (scout, reporter, treasurer)
  strategy/    indicators, genome (mutation/crossover), engine, backtest, vault
  market/      providers (Binance, Coinbase, simulator), feed, regime
  broker/      Broker interface + PaperBroker
  ecosystem.ts wiring, scheduling, persistence, snapshots
  index.ts     HTTP + WebSocket server
shared/types.ts  DTOs shared with the UI
web/src/
  world/       procedural pixel art, map, A* pathfinding, villager simulation
  ui/          HUD, panels, charts
```
