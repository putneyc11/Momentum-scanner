/* THE PRIOR QUESTION: is any pod's entry signal predictive at all?
   No strategy wrapper, no stops, no targets, no position sizing, no costs.
   Just: when a pod says "enter", what does price actually do next — and is
   that better than entering at a random minute on the same names?

   Entry is the NEXT bar's open, exactly as the backtester fills. Forward
   return is measured to the bar N minutes later (last bar if the day ends).
   The baseline draws the same number of (symbol, minute) points from the same
   day, restricted to the same entry window, so time-of-day and symbol mix are
   controlled. If signal <= baseline, no exit logic can rescue the pod. */
const D = require("../lib/data");
const { STRATS } = require("../lib/strategies");
const { DEFAULTS, prepSeries } = require("../lib/strategy");

const days = D.loadRecordedDays();
const HZ = [5, 15, 30, 60];
let seed = 20260828;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

/* Horizon is WALL-CLOCK minutes, taken from each bar's `m`, not bar count.

   The first version of this stepped forward h array positions. Alpaca only
   emits a 1-minute bar when a trade printed, so an illiquid name or a halt
   leaves holes and h positions is not h minutes. That broke the comparison
   asymmetrically: signals fire on volume-surge bars, which sit in dense tape,
   while random draws land anywhere including sparse tape. Measured at a
   nominal 5-bar horizon, surge's signal entries averaged 5.5 real minutes and
   its random draws averaged 10.6 — so the baseline was collecting roughly
   twice the drift and every signal was being scored against an inflated
   number. Same defect, smaller, on redgreen (7.3 vs 9.3) and moon (7.3 vs 10.4).

   If no bar printed inside the window there is no observation, so the sample
   is dropped rather than scored as zero. Dropping applies identically to both
   arms; `edge.js` reports the rates so the symmetry is checkable, not assumed. */
const fwd = (bars, idx, h) => {
  const e = bars[idx + 1]; if (!e) return null;                 // next-bar open = fill
  const target = e.m + h;
  let j = idx + 1;
  while (j + 1 < bars.length && bars[j + 1].m <= target) j++;
  if (j === idx + 1) return null;                               // nothing printed in the window
  return e.o > 0 ? (bars[j].c - e.o) / e.o * 1e4 : null;        // basis points
};
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

console.log(`${days.length} days — forward return in bps from the fill, no costs\n`);
console.log("pod          n signals" + HZ.map(h => `+${h}m sig`.padStart(10)).join("")
  + "   |" + HZ.map(h => `+${h}m rnd`.padStart(10)).join(""));

for (const st of STRATS) {
  const P = { ...DEFAULTS, ...st.DEFAULTS };
  const sig = HZ.map(() => []), base = HZ.map(() => []);
  let sigTried = 0, sigKept = 0, rndTried = 0, rndKept = 0;
  for (const day of days) {
    for (const sym of Object.keys(day.symbols)) {
      const bars = day.symbols[sym];
      if (!bars || bars.length < 30) continue;
      const S = prepSeries(bars, P);
      const hits = [];
      for (let i = 0; i < bars.length - 1; i++) {
        if (bars[i].m < P.entryStartMin || bars[i].m > P.entryEndMin) continue;
        if (st.signalAt(S, bars, i, P)) hits.push(i);
      }
      if (!hits.length) continue;
      for (const i of hits) HZ.forEach((h, k) => {
        if (k === 0) sigTried++;
        const r = fwd(bars, i, h);
        if (r != null) { sig[k].push(r); if (k === 0) sigKept++; }
      });
      /* same count of random minutes, same symbol, same entry window */
      const pool = [];
      for (let i = 0; i < bars.length - 1; i++)
        if (bars[i].m >= P.entryStartMin && bars[i].m <= P.entryEndMin) pool.push(i);
      for (let n = 0; n < hits.length && pool.length; n++) {
        const i = pool[Math.floor(rnd() * pool.length)];
        HZ.forEach((h, k) => {
          if (k === 0) rndTried++;
          const r = fwd(bars, i, h);
          if (r != null) { base[k].push(r); if (k === 0) rndKept++; }
        });
      }
    }
  }
  if (!sig[0].length) { console.log(st.key.padEnd(12) + "  (no signals)"); continue; }
  console.log(st.key.padEnd(12) + String(sig[0].length).padStart(9)
    + sig.map(a => (a.length ? mean(a).toFixed(1) : "-").padStart(10)).join("")
    + "   |" + base.map(a => (a.length ? mean(a).toFixed(1) : "-").padStart(10)).join("")
    + `   drop sig ${(100 * (1 - sigKept / Math.max(1, sigTried))).toFixed(1)}% rnd ${(100 * (1 - rndKept / Math.max(1, rndTried))).toFixed(1)}%`);
}
console.log("\nsig = mean forward return after a signal; rnd = same names/minutes chosen at random.");
console.log("Horizons are wall-clock minutes from the fill bar, not bar counts.");
console.log("A pod whose sig column does not beat its rnd column has no entry edge to tune.");
