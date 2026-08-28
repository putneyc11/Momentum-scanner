# Agent Handoff — Momentum Algo Trader (paper)

Everything an agent needs to take over this system. Read this, then
`README.md`, then `engine.js`'s header comment.

## Where everything lives

| Thing | Location |
|---|---|
| Code (this package) | GitHub `putneyc11/Momentum-scanner`, branch **`claude/algo-paper-trader`** — an ORPHAN branch, zero shared history with the scanner app. **Never merge it into `main`** (Render deploys the scanner app from `main`'s root files). |
| Live deployment | Render web service **`momentum-algo-trader`**, blueprint in `render.yaml`, `autoDeploy: true` → every push to the branch redeploys. Start command: `node engine.js trade`. |
| Dashboard | `https://momentum-algo-trader.onrender.com` (or with a Render suffix — exact URL at the top of the service page). Token-gated: `?token=<DASH_TOKEN>`, value under the service's **Environment** tab; a cookie remembers the browser afterwards. |
| Broker | Alpaca **PAPER** account. Keys live ONLY in Render env (`APCA_API_KEY_ID` / `APCA_API_SECRET_KEY`). `lib/broker.js` is hard-pinned to `paper-api.alpaca.markets` and throws on any other URL — there is deliberately no live-trading switch. Keep it that way. |
| Persistent state | Render disk mounted at `state/` (1 GB): `journal.jsonl` (every entry/scale/exit), `equity.jsonl` (~30s samples), `days/` (recorded 1-min day files — the training library), `params/<pod>.json` (tuned per-model params), `alloc.json` (risk weights), `tune-log.jsonl`. Survives redeploys. Everything else is ephemeral. |
| Related but separate | The Momentum Scanner PWA lives on `main` of the same repo (root `index.html`/`server.js`, built from `src/momentum-dashboard.jsx` via `build/build.py`; scanner feature work happens on `claude/premarket-scanner-discovery-tk67jh` then merges to `main`). The algo shares the scanner's discovery *logic*, not its code or deploy. |

## What it is

A zero-dependency Node engine (`node >= 18`, no npm install) that
paper-trades small-cap momentum gappers 4:00 AM–8:00 PM ET with a
SEVEN-MODEL ensemble sharing one account, and improves itself nightly.

- **Discovery** (`lib/data.js`): session-aware full-market sweeps every
  90s (premarket snapshots vs prior close, RTH daily bars with a
  fast-lane for early movers ≥12%/300K shares, after-hours snapshots vs
  today's close), all screened to **Robinhood-tradable tickers only**
  (`rhTradable`: no OTC, warrants, rights, units, preferreds).
- **Models** (`lib/strategies.js`): 2 RIDERS first (moon, surge) — no
  profit target, exit only on a dip `hwmTrailPct`% off the high-water
  mark (the ride ratchet in `lib/strategy.js#exitCheck`); then 5
  QUICK-STRIKE pods (gapgo, reclaim, flag, igniter, redgreen) — ~1.3R
  targets, 90% banked, dip re-entries (4/day, 5-min cooldown). One pod
  claims a symbol at a time; per-pod position caps; account cap 8.
- **Execution** (`engine.js`): 15s bar loop (entries + structure exits)
  plus a 1-SECOND fast tick (batched latest-trades) enforcing stops,
  ratchets and scale-outs on live prints. RTH entries carry broker-held
  stops; extended-hours orders are marketable limits (Alpaca rejects
  market orders off-RTH) with engine-managed stops. Flatten 19:55, no
  overnights. Account-wide 3% daily-loss halt.
- **Nightly ensemble tune** (~20:05 ET, `ensembleTune`): records the
  day's tape (INCLUDING movers never traded — the missed-mover audit),
  then every pod runs a walk-forward random search (`lib/tune.js`) over
  the SAME recorded-day library, cross-pollinating with sibling
  champions' params; validated improvements persist to
  `state/params/`, and validated scores re-split risk weights
  0.4–1.6× into `state/alloc.json`.

## Invariants — do not break these

1. **PAPER ONLY.** Never add a live-trading path, never accept keys in
   chat, never point the broker anywhere but `paper-api`.
2. **Stateful exits.** A sell's submission sets `meta.exiting`; the
   position is journaled and its slot freed ONLY when the broker
   confirms it is gone; working sells are re-priced 3% harder every
   45s. Never revert to fire-and-forget (it caused duplicate $0 exit
   spam and phantom slots).
3. **Churn guard** (`entryViable`): never take an entry the exit engine
   would immediately close. Applied identically in the live loop and
   `lib/backtest.js`, so tuning matches live behavior — keep them in
   sync if you touch either.
4. **Riders never get profit targets.** Their tuner RANGES exclude
   `targetR`/`scaleOutPct` by design.
5. **Tradability screen** (`rhTradable`) gates the universe; a purge
   force-closes any held position that fails it.
6. **Tuner acceptance** requires beating the champion on the held-out
   validation split — never accept train-only improvements on real days.
7. Boot must stay dashboard-first with the retry loop: a bad key must
   surface as a banner, never a crash loop.

## Working on it

```bash
node engine.js test        # 80 unit tests, no keys needed — run before every push
node engine.js backtest [--synth 60]
node engine.js tune  [--synth 60] [--iters N]   # manual ensemble tune
node engine.js scan | report
APCA_API_KEY_ID=.. APCA_API_SECRET_KEY=.. node engine.js trade  # local live loop, dashboard on :8788
```

Git: commit as the repo owner, push to `claude/algo-paper-trader` only.
Every push auto-redeploys the service; SIGTERM flattens open paper
positions by design, so mid-session deploys close trades (they re-enter
if setups still hold).

## Current status & known items (as of 2026-08-28)

- All 80 tests green. Journal rows before the stateful-exit refactor
  (Aug 27) contain duplicate $0 `vwap`/`bracket` exits — per-model P/L
  computed over that window is unreliable; post-refactor rows are clean.
- A stranded pre-screen warrant position (GME.WS) may still exist until
  the purge's RTH market close fills; if it has literally no bids it
  stays as an inert line (manual close: Alpaca paper dashboard →
  Positions).
- The nightly tune needs ≥5 recorded real days before it runs; until
  then pods trade on their seeded defaults and `backtest`/`tune` fall
  back to synthetic days (mechanics only, not predictive).
- Owner preferences on record: quick pods bank small wins and re-enter
  dips; riders exist to hold monster runs (never cap them); decisions
  second-by-second on exits; everything must be Robinhood-tradable.
