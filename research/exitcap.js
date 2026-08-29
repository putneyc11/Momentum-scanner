/* What the exit participation cap (HYP-005) actually did to a pod.

   Three things the ruling required be reported rather than assumed:

   1. HOW OFTEN EXITS ARE CAPPED at all — if it is rare, the fix changes little.
   2. WHETHER CARRYING HELPED OR HURT. A carried remainder is a live position
      and can get a BETTER price than the first attempt (a ratchet moves, a
      target fills) as well as a worse one. Suppressing the better half would be
      a differently-signed thumb on the scale, so it is allowed — but if a
      meaningful share of a result comes from remainders improving after a
      failed exit, that is a finding and not a detail.
   3. THE FORCED RESIDUE. End-of-day exits cannot carry, so they fill at any
      size with participation-scaled slippage. They are the only fills in the
      model not backed by volume, and their contribution is broken out here so
      no result quietly rests on them.

     node research/exitcap.js surge [params.json]

   Read-only: loads state/days, prints tables, writes nothing. */
const fs = require("fs");
const D = require("../lib/data");
const { STRATS } = require("../lib/strategies");
const { DEFAULTS } = require("../lib/strategy");
const { runBacktest } = require("../lib/backtest");

const [key, pfile] = process.argv.slice(2);
const st = STRATS.find((s) => s.key === key);
if (!st) {
  console.log(`usage: node research/exitcap.js <pod> [params.json]\n  pods: ${STRATS.map((s) => s.key).join(", ")}`);
  process.exit(1);
}
const P = { ...DEFAULTS, ...st.DEFAULTS, ...(pfile ? JSON.parse(fs.readFileSync(pfile, "utf8")) : {}) };
const days = D.loadRecordedDays();
if (!days.length) { console.log("no recorded days in state/days"); process.exit(1); }

const res = runBacktest(days, P, 100000, st.signalAt);
const t = res.trades || [];
const sum = (a, f) => a.reduce((x, y) => x + f(y), 0);
const share = (n, d) => d ? `${(100 * n / d).toFixed(1)}%` : "—";

console.log(`\n[${st.key}] ${pfile || "DEFAULTS"} over ${days.length} days`);
console.log(`  ${JSON.stringify(res.metrics)}\n`);

const capped = t.filter((x) => x.capped);
console.log(`1. CAPPED FILLS — the tape, not the strategy, decided the size`);
console.log(`   ${capped.length} of ${t.length} fills (${share(capped.length, t.length)}) could not take the whole position`);

const carried = t.filter((x) => x.carried > 0);
const better = carried.filter((x) => x.exit > x.firstPx);
const worse = carried.filter((x) => x.exit < x.firstPx);
console.log(`\n2. CARRIED REMAINDERS — live positions, so this cuts both ways`);
console.log(`   ${carried.length} fills (${share(carried.length, t.length)}) are the remainder of an earlier attempt`);
console.log(`   better price than the first attempt: ${better.length} (${share(better.length, carried.length)})  PnL ${sum(better, (x) => x.pnl).toFixed(0)}`);
console.log(`   worse  price than the first attempt: ${worse.length} (${share(worse.length, carried.length)})  PnL ${sum(worse, (x) => x.pnl).toFixed(0)}`);
console.log(`   net effect of carrying vs filling it all at the first price: ${sum(carried, (x) => (x.exit - x.firstPx) * x.qty).toFixed(0)}`);
if (carried.length) {
  const waits = carried.map((x) => x.carried).sort((a, b) => a - b);
  console.log(`   bars waited — median ${waits[Math.floor(waits.length / 2)]}  max ${waits[waits.length - 1]}`);
}

const forced = t.filter((x) => x.forced);
const totalPnl = sum(t, (x) => x.pnl);
console.log(`\n3. FORCED END-OF-DAY RESIDUE — the only fills not backed by volume`);
console.log(`   ${forced.length} fills (${share(forced.length, t.length)})  PnL ${sum(forced, (x) => x.pnl).toFixed(0)} of ${totalPnl.toFixed(0)} total`);
if (forced.length) {
  const pf = (ts) => {
    const w = sum(ts.filter((x) => x.pnl > 0), (x) => x.pnl);
    const l = Math.abs(sum(ts.filter((x) => x.pnl <= 0), (x) => x.pnl));
    return l ? (w / l).toFixed(3) : "inf";
  };
  console.log(`   profit factor WITHOUT the forced residue: ${pf(t.filter((x) => !x.forced))}  (with: ${res.metrics.profitFactor})`);
}
