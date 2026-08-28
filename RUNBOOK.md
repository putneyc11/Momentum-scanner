# The runbook

`START-HERE.md` explains *why*. `HANDOFF.md` explains *how it works*. This file
is just **what you type, and where**. If you only read one file, read this one.

Everything below happens in **one Terminal window**, in **one folder**:

```bash
cd ~/algo-trader
```

That's the only place you ever run `node engine.js`. If a command below doesn't
start with `cd`, you're already in the right folder.

---

## The one rule that can cost you money

```
Never merge, push, or restart between 04:00 and 20:00 Eastern.
```

`render.yaml` has `autoDeploy: true`. A push restarts the live process, and the
process flattens every open position on shutdown, by design. Mid-session that
means it sells your open trades at whatever the market is doing right then.

**Do all merging after 20:00 ET.** Reading, backtesting and tuning are safe at
any hour — they only read files.

---

## Part 1 — the four commands, and what each one is for

| Command | What it does | How long |
|---|---|---|
| `node engine.js test` | Checks the machinery isn't broken. Needs no keys. | ~5 sec |
| `node engine.js backtest` | Replays all 7 pods over your recorded days. Read-only. | ~40 sec |
| `node engine.js tune --iters 200` | Searches for better parameters and saves winners. | **~80 min** |
| `node engine.js report` | What the live paper account has actually done. | instant |

Two of these need your Alpaca keys loaded first:

```bash
source ~/.alpaca-paper.env
```

Do that once per Terminal window. `test` and `backtest` don't need it; `tune`
doesn't either, but `backfill` and `trade` do.

**Rule: `node engine.js test` must pass before you believe any other number.**
A result computed on broken machinery is worse than no result, because you'll
act on it.

---

## Part 2 — merging the tuner fix

The fix is already written and committed, on your machine, on a branch called
`fix/tune-holdout`. Nothing has touched your live branch.

**After 20:00 ET**, type these five lines:

```bash
cd ~/algo-trader
git merge fix/tune-holdout          # bring the fix onto the live branch
node engine.js test                 # must say "107 passed, 0 failed"
git worktree remove ../algo-tune-holdout
git branch -d fix/tune-holdout
```

If `test` says anything other than `0 failed`, stop and run `git merge --abort`.

### What the fix actually changed, in plain English

Think of the tuner as a student and the validation days as a practice exam.

The old code let the student **retake the practice exam 200 times** and kept
whichever attempt scored highest — then reported that score as if it were the
student's ability. Score 200 random guesses and one of them looks brilliant.
That's all `bestScore.valid` was: the luckiest of hundreds of draws.

Two changes:

1. **The passing grade is now fixed in advance.** It's set once, from the
   parameters you already have, and never moves. A candidate has to clear that
   original bar — not one the search has already walked upward.

2. **There's a sealed final exam now.** Days split three ways instead of two:
   the first 60% to search on, the next 20% to accept on, and the **last 20%
   the tuner is never allowed to look at while searching**. It's scored exactly
   twice — once for your old parameters, once for the new ones — after the
   search is over.

That last number is the one to trust. Every `tune` run now prints it:

```
tune moon: 14/97 accepted  base {...} best {...}  holdout 12.40 → 19.80 (held)
tune flag: 22/88 accepted  base {...} best {...}  holdout  8.10 →  2.30 (DID NOT HOLD)
```

**`held`** = the improvement showed up on days the tuner never saw. Real, so far.
**`DID NOT HOLD`** = the tuner memorised the practice exam. Ignore that pod's
"improvement" entirely, no matter how good `best` looks.

You will see a lot of `DID NOT HOLD`. That is the fix working. Before it, those
same runs printed a confident improvement and you had no way to tell.

---

## Part 3 — what the backtest is telling you right now

Ignore `netPct`. Look at **profit factor** — dollars won per dollar lost. Above
1.0 makes money; below 1.0 loses it.

```
moon      PF 1.24    the only pod with an edge
redgreen  PF 0.91    nearly break-even
igniter   PF 0.69
gapgo     PF 0.66
surge     PF 0.62
flag      PF 0.58
reclaim   PF 0.49    loses two dollars for every one it makes
```

Five of seven aren't "untuned" — they're structurally negative on default
parameters. Tuning may rescue some. It will not rescue all of them, and the
honest expected outcome is that you end up running two or three pods, not seven.

`moon` returning +143% with a 55% drawdown is also not as good as it sounds: a
55% drawdown means at some point the account was down more than half from its
peak. On 144 days and 22.5% win rate, that's a strategy that survives on rare
big winners — which is what a rider is supposed to be, but it means a quiet
month looks identical to a broken one.

**Nothing here is evidence of profitability.** Backfilled days are missing every
company that delisted (they went to zero and vanished from the universe), and
the replay checks every minute where the live engine checks every 90 seconds.
Both make the past look kinder than it was. The paper account is the evidence.

---

## Part 4 — the daily loop, and who does what

Three agents. One rule makes the whole thing work: **the agent that invents an
idea never grades it.** Doubt has to come from something with no stake.

| Who | Seat | Touches | Never touches |
|---|---|---|---|
| **Scout** | today's idea | `HYP/HYP-###.md` | any code |
| **Builder** | implementation | one pod, in its own worktree | `HYP/`, `REVIEWS/`, `lib/tune.js` |
| **Red Team** | doubt | `REVIEWS/HYP-###.md` | everything else |
| **You** | the merge | anything | — |

They live in the `momentum-trading` channel. You start each one by `@`-mentioning
it — you don't configure anything per-task.

### The rhythm

```
morning      @Scout   — one hypothesis from yesterday's missed movers
during day   nobody touches the deploy branch
evening      @Builder — implement HYP-###, report both tuning seeds
next day     @Red Team — try to kill it
after 20:00  you merge AT MOST ONE THING
```

### What you actually type

**Morning:**
> @Scout Yesterday's missed movers are in `state/journal.jsonl`. Read them and give me one hypothesis.

**Evening, if the hypothesis is worth testing:**
> @Builder Implement HYP-007. Own worktree, one pod, both seeds, report the holdout column.

**Next day:**
> @Red Team Review HYP-007. Try to kill it.

Do not tell Red Team you like the result. That's the entire value of the seat.

**When Builder and Red Team disagree:** don't pick a side. Ask Red Team to write
the specific test that would expose the defect it claims, add it to
`test-engine.js`, and run it. Either it fails and Red Team was right, or it
passes and the objection is answered on the record. An argument between two
agents that doesn't end in a committed test is wasted tokens.

**Expect to kill most hypotheses.** Killing fast is the skill. Keep the dead
ones in `HYP/` with their verdicts — the graveyard is the only thing stopping
you from re-testing in November what you already killed in August.

---

## Part 5 — when something looks wrong

| Symptom | What it means | What to do |
|---|---|---|
| `no recorded days yet — falling back to synthetic` | It can't find `state/days` | You're in the wrong folder. `cd ~/algo-trader` |
| `test` fails | The machinery is broken | Stop. Don't believe any number until it's green |
| Every pod says `DID NOT HOLD` | The search isn't finding real edges | Correct behaviour. The pods need better signals, not better parameters |
| `tune` seems frozen | It isn't. ~80 minutes is normal | Leave it. Lower `--iters` if you want a faster read |
| A pod trades 0 times | Its gates are too tight for this library | Fine on synthetic days; investigate if it happens on real ones |

---

## Part 6 — the rules, one more time

1. **Never merge or push between 04:00 and 20:00 ET.** It closes live trades.
2. **PAPER ONLY.** `lib/broker.js` throws on any non-paper URL. Never add a live
   path. Never put keys in chat, in either direction.
3. **`node engine.js test` passes before any number is believed.**
4. **Backfilled days tune parameters. They are never evidence of profit.**
5. **Merge at most one thing per day**, so that when something changes you know
   what changed it.

*Not financial advice.*
