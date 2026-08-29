/* The testable core of research/edge.js.

   It lives in lib/ rather than research/ so the test suite can pin it. Three
   defects have shipped in this instrument -- horizons counted in bars instead
   of minutes, a control that could not see the clock, and a control that could
   see the future -- and each looked reasonable in the output. Every one of them
   is a property of one of these two functions, so every one of them is now a
   fixture in test-engine.js with hand-computed values.

   Rule this exists to enforce: a research script's numbers are not reportable
   unless the thing computing them is pinned by a test that fails loudly. */

/* Forward return in bps from the fill, over WALL-CLOCK minutes.

   Alpaca emits a 1-minute bar only when a trade printed, so bar index is not
   minute offset -- illiquid names and halts leave holes. Entry is the next
   bar's open, matching how the backtester fills. The window is [entry.m,
   entry.m + h] and we take the last bar inside it.

   Returns null when nothing printed inside the window: that is an absence of
   observation, not a zero return, and scoring it as zero would quietly pull
   every mean toward the middle. */
function fwd(bars, idx, h) {
  const e = bars[idx + 1];
  if (!e) return null;
  const target = e.m + h;
  let j = idx + 1;
  while (j + 1 < bars.length && bars[j + 1].m <= target) j++;
  if (j === idx + 1) return null;
  return e.o > 0 ? ((bars[j].c - e.o) / e.o) * 1e4 : null;
}

/* Bucket key for a control. `window` pools the whole session, which is why it
   is biased for any signal that clusters in time. */
const keyFor = (m, control) =>
  control === "window" ? 0 : control === "hour" ? Math.floor(m / 60) : Math.floor(m / 15);

/* Eligible control bars, bucketed. EVERY signal bar is excluded, not just the
   one under test: on a flood pod the neighbours are mostly signals too, so
   excluding only the current bar leaves the control measuring the treatment. */
function controlPools(bars, hitSet, control, entryStartMin, entryEndMin) {
  const pools = new Map();
  for (let i = 0; i < bars.length - 1; i++) {
    const m = bars[i].m;
    if (m < entryStartMin || m > entryEndMin) continue;
    if (hitSet.has(i)) continue;
    const k = keyFor(m, control);
    if (!pools.has(k)) pools.set(k, []);
    pools.get(k).push(i);
  }
  return pools;
}

/* A control draw BEFORE the signal bar can contain the burst that later causes
   the signal -- hindsight no rule could act on. Classify, never average over. */
const side = (drawIdx, signalIdx) => (drawIdx < signalIdx ? "before" : "after");

module.exports = { fwd, keyFor, controlPools, side };
