/* THE PRIOR QUESTION: is a pod's entry signal predictive at all?

   No strategy wrapper, no stops, no targets, no sizing, no costs. Just: when a
   pod says "enter", what does price do next — and is that better than entering
   at some other minute you did not have to be clever to find?

   Everything here turns on what "some other minute" means. Two versions of
   this file got that wrong, both in the direction that flattered the result
   being tested, so the controls are now reported side by side rather than one
   being chosen:

   window    any minute in the pod's entry window, same symbol and day.
             This is the naive control and it is BIASED whenever a signal
             clusters in time. redgreen fires 6,191 of 13,870 times in the
             09:00 hour, so against a whole-day average it is largely being
             credited for what time of day it is.
   hour      same symbol, same day, same clock hour as the signal.
   bucket15  same symbol, same day, same 15-minute block. Tightest control:
             it asks whether the signal beat its own immediate neighbourhood.

   Read bucket15 first. If a signal only wins under `window`, it has found the
   time of day, not an edge.

   Horizons are WALL-CLOCK minutes from each bar's `m`, never array positions.
   Alpaca emits a bar only when a trade printed, so h positions is not h
   minutes, and signals sit in denser tape than random draws do — measured, a
   nominal 5-bar horizon was 5.5 real minutes for surge's signals and 10.6 for
   its controls. */
const D = require("../lib/data");
const { STRATS } = require("../lib/strategies");
const { DEFAULTS, prepSeries } = require("../lib/strategy");

const days = D.loadRecordedDays();
const HZ = [5, 15, 30, 60];
const CONTROLS = ["window", "hour", "bucket15"];
let seed = 20260828;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

/* Where nothing printed inside the window there is no observation, so the
   sample is dropped rather than scored as zero. */
const fwd = (bars, idx, h) => {
  const e = bars[idx + 1]; if (!e) return null;
  const target = e.m + h;
  let j = idx + 1;
  while (j + 1 < bars.length && bars[j + 1].m <= target) j++;
  if (j === idx + 1) return null;
  return e.o > 0 ? (bars[j].c - e.o) / e.o * 1e4 : null;
};
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const keyFor = (m, c) => c === "window" ? 0 : c === "hour" ? Math.floor(m / 60) : Math.floor(m / 15);

console.log(`${days.length} days — forward return in bps from the fill, no costs`);
console.log(`controls are matched on symbol and day; "hour" and "bucket15" also match time of day\n`);

for (const st of STRATS) {
  const P = { ...DEFAULTS, ...st.DEFAULTS };
  const sig = HZ.map(() => []);
  const ctl = {}; for (const c of CONTROLS) ctl[c] = HZ.map(() => []);
  let nSig = 0;

  for (const day of days) {
    for (const sym of Object.keys(day.symbols)) {
      const bars = day.symbols[sym];
      if (!bars || bars.length < 30) continue;
      const S = prepSeries(bars, P);

      /* eligible minutes, bucketed once per symbol-day per control */
      const pools = {}; for (const c of CONTROLS) pools[c] = new Map();
      const hits = [];
      for (let i = 0; i < bars.length - 1; i++) {
        const m = bars[i].m;
        if (m < P.entryStartMin || m > P.entryEndMin) continue;
        for (const c of CONTROLS) {
          const k = keyFor(m, c);
          if (!pools[c].has(k)) pools[c].set(k, []);
          pools[c].get(k).push(i);
        }
        if (st.signalAt(S, bars, i, P)) hits.push(i);
      }
      if (!hits.length) continue;
      nSig += hits.length;

      for (const i of hits) {
        HZ.forEach((h, k) => { const r = fwd(bars, i, h); if (r != null) sig[k].push(r); });
        for (const c of CONTROLS) {
          /* draw the control from the signal's OWN bucket — same symbol, same
             day, same slice of the clock. Exclude the signal bar itself, or
             the control is partly the thing being tested. */
          const pool = pools[c].get(keyFor(bars[i].m, c));
          if (!pool || pool.length < 2) continue;
          let j = i;
          for (let tries = 0; tries < 8 && j === i; tries++) j = pool[Math.floor(rnd() * pool.length)];
          if (j === i) continue;
          HZ.forEach((h, k) => { const r = fwd(bars, j, h); if (r != null) ctl[c][k].push(r); });
        }
      }
    }
  }
  if (!sig[0].length) { console.log(`[${st.key}] no signals`); continue; }
  const row = (label, arrs) => "  " + label.padEnd(10)
    + arrs.map(a => (a.length ? mean(a).toFixed(1) : "-").padStart(10)).join("");
  console.log(`[${st.key}]  ${nSig} signals` + " ".repeat(Math.max(1, 22 - String(nSig).length - st.key.length))
    + HZ.map(h => `+${h}m`.padStart(10)).join(""));
  console.log(row("signal", sig));
  for (const c of CONTROLS) console.log(row(c, ctl[c]));
  const s5 = mean(sig[0]), b5 = ctl.bucket15[0].length ? mean(ctl.bucket15[0]) : null;
  console.log("  " + (b5 == null ? "bucket15 unavailable"
    : b5 <= 0 ? `vs bucket15: control is negative (${b5.toFixed(1)}), read the columns directly`
    : `vs bucket15 at +5m: ${(s5 / b5).toFixed(2)}x` + (s5 <= b5 ? "   <== NO EDGE against its own neighbourhood" : "")) + "\n");
}
console.log(`
How to read the three controls — they assume different amounts of foreknowledge:

  window    assumes NOTHING. "Be in this name today, pick any minute."
            Beating it means the signal adds something over no information.
  hour      assumes you knew the right hour.
  bucket15  assumes you knew the right 15 minutes, then threw a dart inside it.
            Beating it means the signal picked the right MINUTE, which is the
            only part a human or a tuner is actually choosing.

bucket15 is not a strategy you could trade — you cannot know in advance which
15 minutes will matter. It is a decomposition, and that is what makes it
useful: it splits a signal's apparent edge into "found the right
neighbourhood" and "found the right minute inside it."

Losing to bucket15 while beating window is a specific, actionable diagnosis. It
says the screening layer that decides WHICH name and WHEN is carrying the
result, and the entry trigger that decides the exact bar is adding nothing —
or, where the signal scores below its own neighbourhood by a wide margin, is
actively mistimed and buying late into a move that was already underway.`);
