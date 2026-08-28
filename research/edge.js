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

const fwd = (bars, idx, h) => {
  const e = bars[idx + 1]; if (!e) return null;                 // next-bar open = fill
  const j = Math.min(idx + 1 + h, bars.length - 1);
  return e.o > 0 ? (bars[j].c - e.o) / e.o * 1e4 : null;        // basis points
};
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

console.log(`${days.length} days — forward return in bps from the fill, no costs\n`);
console.log("pod          n signals" + HZ.map(h => `+${h}m sig`.padStart(10)).join("")
  + "   |" + HZ.map(h => `+${h}m rnd`.padStart(10)).join(""));

for (const st of STRATS) {
  const P = { ...DEFAULTS, ...st.DEFAULTS };
  const sig = HZ.map(() => []), base = HZ.map(() => []);
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
      for (const i of hits) HZ.forEach((h, k) => { const r = fwd(bars, i, h); if (r != null) sig[k].push(r); });
      /* same count of random minutes, same symbol, same entry window */
      const pool = [];
      for (let i = 0; i < bars.length - 1; i++)
        if (bars[i].m >= P.entryStartMin && bars[i].m <= P.entryEndMin) pool.push(i);
      for (let n = 0; n < hits.length && pool.length; n++) {
        const i = pool[Math.floor(rnd() * pool.length)];
        HZ.forEach((h, k) => { const r = fwd(bars, i, h); if (r != null) base[k].push(r); });
      }
    }
  }
  if (!sig[0].length) { console.log(st.key.padEnd(12) + "  (no signals)"); continue; }
  console.log(st.key.padEnd(12) + String(sig[0].length).padStart(9)
    + sig.map(a => (a.length ? mean(a).toFixed(1) : "-").padStart(10)).join("")
    + "   |" + base.map(a => (a.length ? mean(a).toFixed(1) : "-").padStart(10)).join(""));
}
console.log("\nsig = mean forward return after a signal; rnd = same names/minutes chosen at random.");
console.log("A pod whose sig column does not beat its rnd column has no entry edge to tune.");
