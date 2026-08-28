# Start here

You have a working seven-pod paper trader that tunes itself nightly. What it
does not have is enough tape to tune *against*. This file is the shortest path
to fixing that, and to adding agents without breaking what already works.

`HANDOFF.md` is the system description. This is the operating plan.

---

## The one number that explains everything

```
engine.js   if (days.length >= 5)          nightly tune won't run below 5 days
tune.js:59  cut = floor(days.length * 0.7) at 5 days: train=3, validate=2
engine.js   7 pods × 120 iterations        840 perturbations per night
```

840 parameter searches a night, selecting against **two days** of validation
data. That is not a tuning loop, it is a random number generator with a
convincing log file. And it does not get better by adding compute or agents —
only by adding days, which arrive at one per day.

Unless you manufacture them.

---

## Day 1 — backfill the library (one command, then wait)

```bash
export APCA_API_KEY_ID=...      # the PAPER keys
export APCA_API_SECRET_KEY=...

node engine.js test                                  # 98 tests, no keys needed
node engine.js backfill --start 2026-02-01 --end 2026-08-27
```

It skips dates already on disk, so it is safe to interrupt and safe to re-run.
When it finishes it tells you your new tuner split. Roughly 125 trading days
turns `train=3 / validate=2` into `train=87 / validate=38`.

Then:

```bash
node engine.js backtest        # all seven pods over the real library
node engine.js tune --iters 200
```

### What the backfill actually does

Discovery is session-aware and cumulative — `discover()` runs every 90s and
unions everything that ever ranked, so a recorded day holds symbols that
qualified at 07:12 and were dead by lunch. Screening historical *closes* would
lose exactly those: the ran-and-faded names, which are most of them.

So `lib/backfill.js` replays each day minute by minute:

- **stage 1** — daily bars for the whole universe, one cheap pass. Keeps any
  (symbol, day) that *could* have qualified, judged on the day's high and total
  volume, which bound every intraday gate from above.
- **stage 2** — 1-minute tape for the survivors, walked 04:00 → 20:00 ET,
  applying the premarket / RTH / after-hours gates against running price and
  cumulative volume, exactly as the live loop does.

Every threshold is imported from `lib/data.js`. None are re-declared, and
there is a test that fails if anyone re-declares one. A second drifting copy of
`FAST_VOL_FLOOR` is the same class of bug your churn-guard invariant exists to
prevent.

### Two biases, both making backfilled days look better than reality

1. **Survivorship.** The universe is Alpaca's *currently active* assets, so
   anything delisted since is missing. Small-cap momentum names delist more
   than most, so the library under-represents the ones that went to zero.
2. **Polling cadence.** Live discovery polls every 90s; the replay checks every
   minute, so it catches a few movers the live engine was looking away for.

Neither is fixable from this data. Both are why a backfilled day is training
material and **not** evidence. Evidence is the paper account.

---

## Day 2 — fix the validation ratchet

`lib/tune.js` splits days 70/30 and requires a candidate to beat the champion
on train *and* score at least as well on validate. The intent is right. The
implementation leaks:

```js
if (ok) { champ = cand; champTrain = tScore; champValid = vScore; }
```

`champValid` ratchets upward on every acceptance. Across ~840 perturbations
you are selecting the best-scoring-on-validate, hundreds of looks deep — so
`bestScore.valid` is the maximum of many draws, not an unbiased estimate.

Invariant #6 says *never accept train-only improvements*. This accepts
**validate-selected** improvements, which is the same disease one layer out.

Two fixes, pick one:

- **Freeze the bar.** Set `champValid` once from the base champion and never
  raise it. Candidates must clear the original bar, not an escalating one.
- **Third split.** 60/20/20. The last 20% is scored once, after the search
  ends, and never used for acceptance. That number is the one you trust.

The second is better and it only becomes affordable *after* the backfill —
with 5 days there is nothing left to hold out.

---

## Day 3 onward — the loop

```
premarket  research pass reads yesterday's missed-mover audit + the tape,
           writes hypotheses into HYP/
day        the engine trades. nobody touches the deploy branch.
20:05 ET   nightly ensemble tune
evening    builders implement hypotheses, one pod per worktree
next day   red team reviews anything that beat its champion
you        merge at most one thing, outside session hours
```

`AGENTS.md` is who does which of those.

---

## Rules that are not negotiable

1. **Never push to `claude/algo-paper-trader` during 04:00–20:00 ET.**
   `render.yaml` has `autoDeploy: true`, and SIGTERM flattens open positions —
   a push mid-session closes live trades. Agents work in worktrees. You merge,
   deliberately, after hours.
2. **PAPER ONLY.** `lib/broker.js` throws on any non-paper URL. Never add a
   live path, never accept keys in chat.
3. **`node engine.js test` passes before any result is believed**, and before
   any push. A number computed on broken machinery is worse than no number,
   because you will act on it.
4. **Backfilled days never count as evidence of profitability.** They tune
   parameters. The paper account decides whether it works.
5. **The invariants in `HANDOFF.md` hold.** Especially #3: `entryViable` must
   behave identically in `lib/backtest.js` and the live loop, or every tuning
   result is measuring a system you do not run.

*Not financial advice.*
