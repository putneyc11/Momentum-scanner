# Who does what

Three agents, three roles, one rule that makes it work: **the agent that
invents an idea never grades it.** Doubt has to come from something with no
stake in the answer.

Read `START-HERE.md` and `HANDOFF.md` first.

| | Agent | Owns | May edit | May never edit |
|---|---|---|---|---|
| 1 | **Grok** — the scout | today's ideas | `HYP/HYP-###.md` | any code |
| 2 | **Claude Code** — the builder | implementation | one pod's files, in its own worktree | `HYP/`, `REVIEWS/`, `lib/tune.js` |
| 3 | **Codex** — the red team | doubt | `REVIEWS/HYP-###.md` | everything else |
| — | **You** | the merge | anything | — |

---

## Before anything: the deploy hazard

`render.yaml` sets `autoDeploy: true` on `claude/algo-paper-trader`, so any
push to that branch redeploys immediately. As of `d96f331` a restart no longer
flattens — the position book persists to the Render disk and broker-held RTH
stops rest server-side, so the next boot resumes each position under its own
pod's plan. **Deploys are safe during RTH (09:30–16:00 ET).** Outside those
hours the stops are engine-managed and the 1s exit tick is down through the
restart, so do not deploy premarket or after-hours unless the account is flat.

Agents get worktrees and never push to the deploy branch:

```bash
./scripts/new-hyp.sh 007          # branch hyp/007, worktree ../algo-hyp-007
```

You merge, by hand, after 20:00 ET.

---

## The merge gate — not optional

Before any change to `lib/` is proposed for merge, whoever made it runs:

```bash
node engine.js test                       # must be 0 failed
node engine.js regress --base <the ref you branched from>
```

`regress` replays every pod over the recorded days twice — once with the
strategy code at `--base`, once with the working tree — and prints a
before/after profit-factor table. It exits 1 if any pod lost more than 0.03
profit factor. **Paste that table into the proposal.** A change with no table
is not reviewable and does not get merged.

This exists because of a real failure on 2026-08-28. The rider stall exit was
a correct fix for a real problem — a dead position was holding a slot all day
— and it quietly took moon from profit factor 1.24 to 1.02. It went unnoticed
for eight hours, because nothing compared before to after. Agents will produce
that failure faster than people do.

**The gate is blind to a pure `RANGES` change, by construction.** It scores
`DEFAULTS`, so widening or narrowing the tuner's search space always returns a
table of exact `0.00` deltas and always PASSes. That is correct behaviour — the
change genuinely moves no pod's default score — but a PASS there is not
evidence of anything, and presenting it as evidence is worse than omitting it.

For a range change, the table that means something is an **A/B tune**: the same
pods, same seeds, same cost model, same days, run once inside the old bounds and
once inside the new ones. `base -> best` within a single tune only shows that
tuning beat not-tuning; it cannot separate "the wider box found something" from
"200 iterations found something." Report the frozen holdout from both arms.

Two things the gate deliberately does not do:

- It does not read `state/params`. Saved champions differ per machine and move
  with every tune, so scoring against them would make the verdict
  irreproducible. It compares `DEFAULTS`, which are in git.
- It does not block an improvement, and it does not block a pod being added.

A FAIL is not automatically a veto. The participation cap fails this gate
against its own parent, and it should — it removed fictional fills, so the
honest number is lower. The rule is that a FAIL must be **explained in the
proposal**, not silently carried.

---

## 1. Grok — the daily research pass

This is the one that runs **every day**, and it is the only role that needs
information from outside the repo.

Two inputs, both of which already exist:

- **The missed-mover audit.** `noteMovers` records every symbol that ever
  ranked in discovery, whether or not a pod traded it. After the backfill you
  have months of these. They are the record of what the engine *saw and did
  not take*, and nobody has read them.
- **The tape.** X, filings, halts, news — why those specific names moved.

### The daily prompt

> You are the scout on a small-cap momentum trading system. It runs seven
> models on one paper account: two RIDERS (`moon`, `surge` — no profit target,
> exit only on a dip off the high-water mark) and five QUICK-STRIKE pods
> (`gapgo`, `reclaim`, `flag`, `igniter`, `redgreen` — ~1.3R targets, 90%
> banked, dip re-entries).
>
> Discovery screens the full market for Robinhood-tradable names: premarket
> ≥10% vs prior close on ≥25K shares; RTH ≥25% on ≥5M shares, or a fast lane
> at ≥12% on ≥300K; after-hours ≥10% vs today's close.
>
> Here are the symbols that ranked yesterday and were NOT traded:
> `<paste the missed-mover list>`
>
> Research what actually moved them. Then propose ONE hypothesis. It must be
> expressible as exactly one of:
>
> **(a) a discovery change** — a gate in `lib/data.js` (a floor, a price bound,
>   a session window)
> **(b) an entry-signal change** — a condition inside one named pod's
>   `signalAt` in `lib/strategies.js`
> **(c) a parameter-range change** — a knob in `RANGES` in `lib/strategy.js`
>
> If it does not fit (a), (b) or (c), it is not implementable here — discard it
> and propose something else.
>
> Give me five things and nothing more:
> 1. **Claim** — one sentence, specific and numeric.
> 2. **Category** — (a), (b) or (c), and which file and pod.
> 3. **Mechanism** — why it might be true, two sentences.
> 4. **Falsifier** — the specific backtest result that kills it.
> 5. **Cost** — how many of yesterday's ranked movers does this add or remove?
>
> If you cannot write #4, the idea is not testable. Discard it.
>
> Do not write code. Do not tell me an idea is promising.

Good: *"Names that gapped ≥10% premarket on a halt-resume rather than on news
give back the gap within 30 minutes. Category (a): add a halt-resume exclusion
to discovery. Falsified if excluding them does not raise `gapgo`'s validate
score."*

Bad: *"Look for stocks with strong catalysts."* Not a rule. Reject and re-ask.

Save as `HYP/HYP-007.md`.

**Why the constraint matters:** an unconstrained scout produces market
commentary, which is free and worth what it costs. Forcing every idea through
(a)/(b)/(c) means it lands somewhere you already have machinery to test it.

---

## 2. Claude Code — the builder

**Seven pods is seven genuinely non-colliding workstreams.** This is the only
place in the system where parallelism actually pays: each pod has its own
`signalAt`, its own champion in `state/params/<pod>.json`, and its own tune.
Two agents on two pods never touch the same line.

From inside the worktree:

> Read `HANDOFF.md`, `START-HERE.md`, `lib/strategies.js`, and `HYP/HYP-007.md`.
>
> Implement exactly the change in HYP-007. Nothing else.
>
> Constraints:
> - Touch ONE pod. If the hypothesis needs changes to more than one, stop and
>   say so — it needs splitting into separate hypotheses.
> - Do not edit `lib/tune.js`. The referee does not get edited by the player.
> - Do not edit `lib/backtest.js` unless the hypothesis is explicitly about the
>   fill model. If you do, invariant #3 is now your problem: `entryViable` must
>   behave identically there and in the live loop.
> - Riders (`moon`, `surge`) never get profit targets. Their RANGES exclude
>   `targetR`/`scaleOutPct` deliberately — invariant #4.
> - Add a test to `test-engine.js` for any new condition you introduce.
> - `node engine.js test` must pass.
>
> Then run and paste the RAW output of:
> ```
> node engine.js test
> node engine.js backtest
> node engine.js tune --iters 200 --seed 11
> node engine.js tune --iters 200 --seed 29
> ```
>
> Two seeds, because one tuning run is a sample of one. Report the pod's
> before/after on both seeds as a table. Do not editorialise about whether the
> result looks promising.

---

## 3. Codex — the red team

The highest-value seat, and the easiest to ruin. Ruin it by telling Codex what
you hope it finds. Clean session, no build history, no hint that you like the
result.

> This repository backtests and paper-trades a momentum strategy. A change to
> one pod reportedly improved its score. Find the reason that result is wrong.
> Assume it is wrong. Your default conclusion is "this does not survive."
>
> Read `lib/backtest.js`, `lib/tune.js`, `lib/strategy.js`, `lib/backfill.js`,
> and the changed pod in `lib/strategies.js`.
>
> Work through:
>
> 1. **Churn-guard divergence (invariant #3).** Does `entryViable` behave
>    identically in `lib/backtest.js` and the live loop in `engine.js`? This
>    rots silently the moment anyone touches either side, and every tuning
>    result depends on it. Show the two call sites.
> 2. **Validation leakage.** `lib/tune.js` ratchets `champValid` on every
>    acceptance. How many candidates were scored against the validation split
>    in this run? Is the reported `bestScore.valid` an unbiased estimate or the
>    maximum of many draws?
> 3. **Backfill bias.** The library is reconstructed from currently-active
>    assets, so delisted names are absent. Which direction does that push this
>    pod's result, and roughly how far?
> 4. **Lookahead.** Does any decision use information from after the moment of
>    that decision? Check the entry fill (next bar's open), the stop/target
>    ordering, and anything reading a whole-day field at signal time.
> 5. **Fill realism.** Could these entries actually be filled at these sizes on
>    these names? Check the volume on the entry bar.
> 6. **Regime.** Split the day library in half chronologically and rerun. Does
>    the improvement exist in both halves, or one?
> 7. **Parameter count.** How many knobs moved? Against how many days?
>
> Output: a numbered list of concrete defects with `file:line`, each marked
> FATAL / SERIOUS / MINOR, then one final line: KILL or SURVIVES-REVIEW.
> Prefer KILL when uncertain.

Save as `REVIEWS/HYP-007.md`.

---

## The rhythm

```
premarket   Grok: yesterday's missed movers -> one HYP file
during day  nobody touches the deploy branch
20:05 ET    engine records the day and runs the ensemble tune
evening     Claude implements, one pod per worktree, two tuning seeds
next day    Codex red-teams anything that beat its champion
after 20:00 you merge at most one thing
```

You will kill most of them. **Killing fast is the skill.** Keep the losers in
`HYP/` with their verdicts — the graveyard is the only thing stopping you from
re-testing in November what you already killed in August.

---

## When agents disagree

They will. Claude reports a validate score up 40%; Codex calls it leakage.

The tiebreaker is never "which agent is smarter." It is: **make the
disagreement run.** Ask Codex to write the specific test that would expose the
defect it claims, add it to `test-engine.js`, and run it. Either it fails and
Codex was right, or it passes and the objection is answered on the record.

An argument between two agents that does not end in a committed test is wasted
tokens.
