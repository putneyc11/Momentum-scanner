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
  const pre = HZ.map(() => []), post = HZ.map(() => []);
  let nSig = 0, sigTried = 0, sigKept = 0, ctlTried = 0, ctlKept = 0, thinPool = 0;

  for (const day of days) {
    for (const sym of Object.keys(day.symbols)) {
      const bars = day.symbols[sym];
      if (!bars || bars.length < 30) continue;
      const S = prepSeries(bars, P);

      /* Find the signals first, because every one of them has to be kept OUT
         of the control pool. Excluding only the bar under test is not enough:
         on a flood pod the neighbours are mostly signals too -- 78.2% of moon's
         bucket candidates and 84.2% of gapgo's were other signal bars -- so the
         "control" was largely the treatment measured again. */
      const hitSet = new Set();
      for (let i = 0; i < bars.length - 1; i++) {
        const m = bars[i].m;
        if (m < P.entryStartMin || m > P.entryEndMin) continue;
        if (st.signalAt(S, bars, i, P)) hitSet.add(i);
      }
      if (!hitSet.size) continue;
      const hits = [...hitSet];
      nSig += hits.length;

      const pools = {}; for (const c of CONTROLS) pools[c] = new Map();
      for (let i = 0; i < bars.length - 1; i++) {
        const m = bars[i].m;
        if (m < P.entryStartMin || m > P.entryEndMin) continue;
        if (hitSet.has(i)) continue;
        for (const c of CONTROLS) {
          const k = keyFor(m, c);
          if (!pools[c].has(k)) pools[c].set(k, []);
          pools[c].get(k).push(i);
        }
      }

      for (const i of hits) {
        HZ.forEach((h, k) => {
          if (k === 0) sigTried++;
          const r = fwd(bars, i, h);
          if (r != null) { sig[k].push(r); if (k === 0) sigKept++; }
        });
        for (const c of CONTROLS) {
          const pool = pools[c].get(keyFor(bars[i].m, c));
          if (!pool || !pool.length) { if (c === "bucket15") thinPool++; continue; }
          const j = pool[Math.floor(rnd() * pool.length)];
          /* A draw BEFORE the signal bar can contain the very burst that later
             triggers the signal — that is hindsight, not a minute any rule
             could have chosen. Split it out rather than averaging over it. */
          const side = j < i ? pre : post;
          HZ.forEach((h, k) => {
            if (k === 0 && c === "bucket15") ctlTried++;
            const r = fwd(bars, j, h);
            if (r != null) {
              ctl[c][k].push(r);
              if (k === 0 && c === "bucket15") ctlKept++;
              if (c === "bucket15") side[k].push(r);
            }
          });
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
  console.log(row("  ..before", pre) + "   <- hindsight: draw precedes the signal");
  console.log(row("  ..after", post) + "   <- the comparison a rule could actually make");
  console.log(`  kept: signal ${sigKept}/${sigTried} (${(100*sigKept/Math.max(1,sigTried)).toFixed(1)}%)`
    + `  bucket15 control ${ctlKept}/${ctlTried} (${(100*ctlKept/Math.max(1,ctlTried)).toFixed(1)}%)`
    + `  signals with no usable bucket: ${thinPool}`);
  const s5 = mean(sig[0]);
  const a5 = post[0].length ? mean(post[0]) : null;
  console.log("  " + (a5 == null || a5 <= 0
    ? "vs after-signal control: unavailable or negative — read the columns"
    : `vs AFTER-SIGNAL control at +5m: ${(s5 / a5).toFixed(2)}x`
      + (s5 > a5 ? "   <== beats its own neighbourhood" : "   <== no timing edge")) + "\n");
}
console.log(`
How to read this — the controls assume different amounts of foreknowledge:

  window       assumes NOTHING. "Be in this name today, pick any minute."
               OVERSTATES a clustered signal: it is confounded by time of day.
  hour         assumes you knew the right hour.
  bucket15     assumes you knew the right 15 minutes, then threw a dart in it.
    ..before   UNUSABLE as a benchmark. The bucket is chosen because a signal
               fires in it, so a draw landing before that signal collects the
               very burst that later triggers it. No rule could pick that
               minute; it is hindsight, and every confirmation-based trigger
               loses to it by construction.
    ..after    THE ONE THAT MEANS SOMETHING. Same name, same day, same 15
               minutes, but a minute the signal did not need to see the future
               to reach. Beating this is a genuine timing edge.

Control bars exclude EVERY signal bar, not just the one under test, or on a
flood pod the control is mostly the treatment measured a second time.

Judge a signal on the ..after row. The blended bucket15 row is reported only
so the size of the hindsight gap stays visible.`);