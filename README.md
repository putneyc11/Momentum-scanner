# Momentum Algo Trader (paper)

Autonomous **paper-trading** engine driven by the Momentum Scanner's
discovery gates. Lives on its own branch (`claude/algo-paper-trader`) with a
completely separate history from the app — never merge it into `main`
(Render deploys `main`).

**PAPER ONLY.** The broker adapter is hard-pinned to
`paper-api.alpaca.markets` and throws on any other URL. There is no switch
for live trading in this codebase, on purpose. Nothing here is investment
advice; small-cap gappers are brutally volatile and most momentum entries
lose.

## What it does

1. **Discovers** the same stocks the scanner surfaces (premarket snapshot
   gates 4:00–9:30 ET, daily-bar gates after the open, split-guarded).
2. **Trades them on the Alpaca paper account** with the "Gap-and-Go
   Confluence" strategy (see `lib/strategy.js`): a mandatory break of the
   premarket-high/opening-range structure plus a confluence vote across
   VWAP, EMA 8/21, volume surge, RSI and Supertrend. Entries go in as
   bracket orders (stop + take-profit held at the broker, so protection
   survives even if this process dies). VWAP-loss, trailing and time exits
   are managed by the loop. Everything is flattened at 15:55 — no
   overnights. Risk is capped per trade (`riskPct`), per position
   (`maxNotionalPct`), and per day (`maxDailyLossPct` halt).
3. **Records every session** — 1-min bars for that day's universe land in
   `state/days/` as backtest day files.
4. **Improves itself nightly**: after the close it runs a walk-forward
   random search (`lib/tune.js`) over all recorded days. New parameters are
   accepted only when they beat the current ones on BOTH the training and
   the held-out validation split, then written to `params.json` — which the
   next morning's session picks up automatically.

## Run it

```bash
# Alpaca PAPER keys (dashboard → Paper account → API keys)
export APCA_API_KEY_ID=PK...
export APCA_API_SECRET_KEY=...

node engine.js test        # unit tests (no keys needed)
node engine.js scan        # show the current scanner universe
node engine.js trade       # the whole loop: trade → record → tune, forever
node engine.js report      # journal + tuning summary
node engine.js backtest    # backtest recorded days (or --synth 60)
node engine.js tune --iters 200   # manual tuning pass
```

Keep `trade` running 24/7 on any always-on box — a $5 VPS, a spare
machine, or a Render **Background Worker** (build command empty, start
command `node engine.js trade`, the two `APCA_*` env vars set; note
`state/` is ephemeral on Render's free tier, so a persistent disk or a real
machine preserves the recorded-day library and journal better).

## The improvement loop, honestly

Until real days are recorded, `backtest`/`tune` fall back to a seeded
synthetic gapper library (`lib/synth.js`) — good for validating mechanics
and comparing parameters, **not** a forecast of real returns. The loop gets
meaningful exactly as fast as the recorded library grows: ~5 days in, the
nightly tuner starts running; a few weeks in, the walk-forward split has
enough regime variety to mean something. Expect early paper results to be
noisy and possibly negative — that's the point of paper.

## Files

- `engine.js` — CLI + live loop (trade / scan / backtest / tune / report / test)
- `lib/strategy.js` — signals, exits, parameter ranges
- `lib/indicators.js` — EMA, VWAP, RSI, ATR, Supertrend, PMH/ORB levels (all causal)
- `lib/backtest.js` — portfolio simulator, pessimistic fills, metrics
- `lib/tune.js` — walk-forward random search
- `lib/data.js` — Alpaca data + scanner-gate discovery + day recording
- `lib/broker.js` — paper-pinned Alpaca trading adapter
- `lib/synth.js` — seeded synthetic gapper days (bootstrap/validation)
- `params.json` — the current "model"; rewritten by accepted tunes
- `state/` — journal, recorded days, tune log (gitignored)
