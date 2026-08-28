# research/

The measurements behind `HYP/HYP-001.md`. Every one is read-only — they load
`state/days` and print a table. None writes params, touches the broker, or
needs Alpaca keys.

```bash
cd ~/algo-trader && node research/<script>.js
```

Run them before proposing anything. If a claim in a HYP file has no script
here that reproduces it, that claim is not checkable and should not be graded.

| script | question it answers |
|---|---|
| `edge.js` | **Start here.** Is a pod's entry signal predictive *at all*? Mean forward return after a signal vs a random minute on the same symbol in the same session window. No strategy, no costs. Five of seven pods score worse than random. |
| `regime.js` | Does a pod work in both chronological halves, or only the easy one? |
| `splithalf.js` | The same split for one specific parameter change. |
| `exits.js` | What actually closes a pod's trades, and what each exit reason is worth in R. Run this before touching an exit parameter — redgreen turned out to be 77% stop-outs, which made its target and time-stop settings irrelevant. |
| `exitmix.js` | The same question as `exits.js`, but for a **tuned champion's** params file rather than DEFAULTS. Run it on anything a tune produced before describing what the change did: raising `maxStopPct` lifts only a cap, so a "wider stop" champion can turn out to be exiting on VWAP and time instead. Prints the verdict line. |
| `stops2.js` | Profit factor vs stop width, per pod, both halves. The sweep that produced HYP-001. |
| `falsifier2.js` | Is a stop-width gain real, or just fewer round trips paying less slippage? Re-runs at `slipBps 0`, where there is no cost to save. |
| `slip-sweep.js` | How much of a result survives a realistic slippage assumption? Also prints the price distribution of the traded tape. |

## A defect this file already had, and what it cost

`edge.js` originally stepped forward `h` **array positions** to measure a
forward return. Alpaca emits a 1-minute bar only when a trade printed, so
illiquid names and halts leave holes, and `h` positions is not `h` minutes.

It broke asymmetrically, which is the dangerous kind. Signals fire on
volume-surge bars that sit in dense tape; random draws land anywhere, including
sparse tape. At a nominal 5-bar horizon:

```
                signal entries    random entries
surge             5.5 minutes      10.6 minutes
moon              7.3 minutes      10.4 minutes
redgreen          7.3 minutes       9.3 minutes
```

The baseline was collecting up to twice the drift of the thing it was grading.
Horizons are now wall-clock minutes from each bar's `m`. The conclusion did not
change — redgreen's advantage went **up**, from 6.6x to 8.0x, and the five
worse-than-random pods stayed worse — but it could have, and nothing in the
output would have said so.

The lesson worth keeping: **the instrument gets audited before the result.**
A baseline that is quietly measured over a different horizon than the treatment
looks exactly like a real finding.

## Two traps these scripts exist to catch

**Gross profitability proves nothing.** At `slipBps 0`, gapgo scores PF 1.16 on
an entry that is measurably *worse than random* — because the universe itself
drifts up about +25 bps in five minutes. A pod can look profitable before costs
purely by being present. Compare against the random baseline, not against zero.

**A number computed over all 144 days is in-sample to whoever chose the
parameters.** `stops2.js` prints both halves, but if you swept a grid while
watching both columns, you selected on them and they are no longer
out-of-sample. Say so in the HYP file, and let the frozen holdout in
`lib/tune.js` be the honest read.
