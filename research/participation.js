/* Profit factor across FILL-SIZE assumptions, per AGENTS.md reporting standard 2.

   MAX_BAR_PARTICIPATION is 0.10 and lib/strategy.js calls that "the loosest
   number that is still honest." HYP-001 scored PF 1.16 at 10% and 1.00 at 1%:
   the whole result lived in an aggressive fill assumption and a single number
   hid it. Any score quoted at 10% alone is quoted at its most flattering.

     node research/participation.js surge
     node research/participation.js surge state/params/surge.json

   The cap is a frozen constant and deliberately absent from RANGES, so this
   does NOT add a knob. It reloads the module graph with a different value per
   level, which a research script may do and the tuner may not -- the tuner
   would optimise its way out of paying for size. Read-only: writes nothing. */
const fs = require("fs");
const path = require("path");

const LEVELS = [0.10, 0.05, 0.02, 0.01];
const [key, pfile] = process.argv.slice(2);
const overrides = pfile ? JSON.parse(fs.readFileSync(pfile, "utf8")) : {};

const D = require("../lib/data");
const days = D.loadRecordedDays();
if (!days.length) { console.log("no recorded days in state/days"); process.exit(1); }

/* Reload strategy/backtest/strategies per level. backtest.js destructures
   MAX_BAR_PARTICIPATION from strategy's exports at load time, so mutating the
   exports object before backtest is required is what changes the cap. */
function scoreAt(level) {
  for (const m of ["../lib/strategy", "../lib/backtest", "../lib/strategies"])
    delete require.cache[require.resolve(m)];
  const strategy = require("../lib/strategy");
  strategy.MAX_BAR_PARTICIPATION = level;
  const { runBacktest } = require("../lib/backtest");
  const { STRATS } = require("../lib/strategies");
  const st = STRATS.find((s) => s.key === key);
  if (!st) return null;
  const P = { ...strategy.DEFAULTS, ...st.DEFAULTS, ...overrides };
  const r = runBacktest(days, P, 100000, st.signalAt);
  let capped = 0;
  for (const t of r.trades || []) if (t.capped) capped++;
  return { m: r.metrics, capped, trades: (r.trades || []).length };
}

if (!key || !scoreAt(LEVELS[0])) {
  const { STRATS } = require("../lib/strategies");
  console.log(`usage: node research/participation.js <pod> [params.json]\n  pods: ${STRATS.map((s) => s.key).join(", ")}`);
  process.exit(1);
}

console.log(`\n[${key}] ${pfile || "DEFAULTS"} over ${days.length} days`);
console.log("  max share of the entry bar you are assumed to get:\n");
console.log("  participation   trades    netPct   maxDDPct   profitFactor");
let first = null, last = null;
for (const level of LEVELS) {
  const r = scoreAt(level);
  if (first == null) first = r.m.profitFactor;
  last = r.m.profitFactor;
  console.log("  " + (level * 100).toFixed(0).padStart(9) + "%"
    + String(r.m.trades).padStart(11)
    + r.m.netPct.toFixed(2).padStart(10)
    + r.m.maxDDPct.toFixed(2).padStart(11)
    + r.m.profitFactor.toFixed(3).padStart(15));
}
const drop = first - last;
console.log(`\n  10% → 1% costs ${drop.toFixed(3)} profit factor.`
  + (first >= 1 && last < 1
    ? "  THE RESULT DEPENDS ON THE FILL ASSUMPTION: profitable at 10%, not at 1%."
    : first < 1
      ? "  Below 1.0 at every level — the fill assumption is not what is wrong."
      : "  Above 1.0 at every level."));
