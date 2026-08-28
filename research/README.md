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
| `stops2.js` | Profit factor vs stop width, per pod, both halves. The sweep that produced HYP-001. |
| `falsifier2.js` | Is a stop-width gain real, or just fewer round trips paying less slippage? Re-runs at `slipBps 0`, where there is no cost to save. |
| `slip-sweep.js` | How much of a result survives a realistic slippage assumption? Also prints the price distribution of the traded tape. |

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
