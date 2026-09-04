/* Confluence push gate — unit tests on the pure functions.
   Run from tests/: `cp ../deploy/server.js . && node test-setup.js` */
const { setupSignals, tierOf, setupGate, sanitizePlan, journalStats, pivots } = require("./server.js");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("✓", m); } else { fail++; console.log("✗", m); } };
/* bars at 10:00 ET today, 1-min, ending "now" */
const nowD = new Date();
const et = new Date(nowD.toLocaleString("en-US", { timeZone: "America/New_York" }));
const diff = nowD.getTime() - et.getTime();
const atET = (h, m) => { const d = new Date(et); d.setHours(h, m, 0, 0); return d.getTime() + diff; };
function mk(n, opts) {
  const o = { start: [9, 30], base: 2, drift: 0, vol: 50000, ...opts };
  const t0 = atET(o.start[0], o.start[1]);
  const a = [];
  let c = o.base;
  for (let i = 0; i < n; i++) {
    const open = c; c = c + o.drift; const h = Math.max(open, c) + 0.005, l = Math.min(open, c) - 0.005;
    a.push({ t: t0 + i * 60000, o: open, h, l, c, v: typeof o.vol === "function" ? o.vol(i) : o.vol });
  }
  return a;
}
const now = (arr) => arr[arr.length - 1].t + 20000;

/* --- signals --- */
let arr = mk(20, { drift: 0.01, vol: (i) => (i === 19 ? 200000 : 50000) });
let s = setupSignals(arr, now(arr));
ok(s && s.sig.vwap && s.sig.ema && s.sig.mom3 && s.sig.hod && s.sig.vol && s.n === 5, "rising tape with a volume bar lights all five signals");
arr = mk(20, { drift: -0.01 });
s = setupSignals(arr, now(arr));
ok(s && !s.sig.vwap && !s.sig.ema && !s.sig.mom3 && s.n <= 1, "falling tape lights none of the trend signals");
arr = mk(20, { drift: 0.001, base: 0.2, vol: (i) => (i === 19 ? 200000 : 50000) });
s = setupSignals(arr, now(arr));
ok(s && !s.sig.vol, "volume signal needs $50k/min of notional — 200k shares of a $0.20 stock does not count");

/* --- tiers --- */
ok(tierOf(3, { hod: false, vol: false }, 600) === 2 && tierOf(2, {}, 600) === 1, "three signals = tier 2 (setup), two = tier 1 (in-app only)");
ok(tierOf(4, { hod: true, vol: true }, 600) === 3 && tierOf(4, { hod: false, vol: true }, 600) === 2, "tier 3 (breakout) needs four signals INCLUDING high-of-day and volume");
ok(tierOf(3, { hod: true, vol: true }, 720) === 1 && tierOf(4, { hod: true, vol: true }, 720) === 2, "lunch chop (11:30–14:00) demands one more signal per tier");

/* --- gate: baseline, escalation, re-push rules --- */
const st = {};
arr = mk(20, { drift: 0.01, vol: 50000 }); // 4 signals, no vol → tier 2
let r = setupGate("AAA", arr, st, now(arr), { minPrice: 0.5, dailyCap: 3 });
ok(r === null && st.setupInit === true && st.tier === 2, "first observation is a silent baseline — a stock already set up is not replayed");
r = setupGate("AAA", arr, st, now(arr) + 45000, { minPrice: 0.5, dailyCap: 3 });
ok(r === null, "same tier again → no push (no news)");
arr = mk(21, { drift: 0.01, vol: (i) => (i === 20 ? 200000 : 50000) }); // adds vol + fresh HOD → tier 3
r = setupGate("AAA", arr, st, now(arr), { minPrice: 0.5, dailyCap: 3 });
ok(r && r.tier === 3 && /breakout/.test(r.title) && /HOD/.test(r.body) && /vol 4\.0×/.test(r.body), "escalation to tier 3 pushes once, naming the signals: " + (r && r.title + " — " + r.body));
ok(st.pushes === 1 && st.tier === 3, "gate records the push and the tier");
r = setupGate("AAA", arr, st, now(arr) + 45000, { minPrice: 0.5, dailyCap: 3 });
ok(r === null, "still tier 3 → no re-push");

/* new leg: 10% pullback then a 3% bounce with confluence, 20+ min later */
const hi = arr[arr.length - 1].c;
let dip = mk(30, { drift: -(hi * 0.10) / 30, base: hi, vol: 50000, start: [10, 0] });
r = setupGate("AAA", dip, st, now(dip), { minPrice: 0.5, dailyCap: 3 });
ok(r === null && st.pbLo <= st.legHi * 0.92, "a 10% pullback arms a new leg but pushes nothing on the way down");
let bounce = mk(25, { drift: 0.006, base: dip[dip.length - 1].c, vol: (i) => (i === 24 ? 200000 : 50000), start: [10, 31] });
r = setupGate("AAA", bounce, st, now(bounce), { minPrice: 0.5, dailyCap: 3 });
ok(r && r.newLeg && /new leg/.test(r.body), "the bounce off the pullback re-arms and pushes as a new leg");

/* daily cap */
const st2 = { setupInit: true, setupDay: null };
arr = mk(21, { drift: 0.01, vol: (i) => (i === 20 ? 200000 : 50000) });
setupGate("BBB", arr, st2, now(arr), { minPrice: 0.5, dailyCap: 1 }); // baseline (day rollover resets init)
st2.tier = 0; st2.setupInit = true;
r = setupGate("BBB", arr, st2, now(arr) + 45000, { minPrice: 0.5, dailyCap: 1 });
ok(r && st2.pushes === 1, "cap of 1: first push goes");
st2.tier = 0;
r = setupGate("BBB", arr, st2, now(arr) + 90000, { minPrice: 0.5, dailyCap: 1 });
ok(r === null, "cap of 1: a second push the same day is refused");

/* price floor + staleness */
const st3 = { setupInit: true, setupDay: null };
arr = mk(21, { drift: 0.002, base: 0.3, vol: (i) => (i === 20 ? 900000 : 50000) });
setupGate("CCC", arr, st3, now(arr)); st3.tier = 0; st3.setupInit = true;
ok(setupGate("CCC", arr, st3, now(arr) + 45000, { minPrice: 0.5 }) === null, "sub-$0.50 names never push");
const st4 = { setupInit: true, setupDay: null };
arr = mk(21, { drift: 0.01, vol: (i) => (i === 20 ? 200000 : 50000) });
setupGate("DDD", arr, st4, now(arr)); st4.tier = 0; st4.setupInit = true;
ok(setupGate("DDD", arr, st4, now(arr) + 10 * 60000, { minPrice: 0.5 }) === null, "a bar older than 2 minutes is stale — no push on dead tape");

/* --- plan sanitiser --- */
const plan = sanitizePlan({
  bias: "bullish", summary: "x", must_hold: 1.0, must_fail: 0.85, risk_notes: "r",
  levels: [{ price: 1.18, kind: "resistance", label: "LULD up", strength: 9 }, { price: 0.98, kind: "support", label: "EMA 8", strength: 2 }, { price: 40, kind: "support", label: "nonsense", strength: 1 }],
  scenarios: [
    { name: "x", stance: "long", trigger: "t", entry_lo: 1.01, entry_hi: 0.98, stop: 1.05, targets: [1.07, 0.5, 1.18, 1.39, 1.75], invalidation: "i", note: "n" },
    { name: "y", stance: "long", trigger: "t", entry_lo: 0.85, entry_hi: 0.88, stop: 0.80, targets: [1.0], invalidation: "i", note: "n" },
    { name: "z", stance: "long", trigger: "wait", entry_lo: 5, entry_hi: 6, stop: 4, targets: [9], invalidation: "i", note: "n" },
  ],
}, 1.03);
ok(plan.levels.length === 2 && plan.levels[0].price === 0.98 && plan.levels[1].strength === 3, "levels: out-of-range dropped, sorted ascending, strength clamped to 3");
const s1 = plan.scenarios[0];
ok(s1.name === "Long continuation" && s1.entry_lo === 0.98 && s1.entry_hi === 1.01 && s1.stop === null && s1.targets.join() === "1.07,1.18,1.39", "long scenario: entry zone reordered, stop above entry rejected, targets kept above entry and capped at 3");
ok(plan.scenarios[2].name === "Stand aside" && plan.scenarios[2].stance === "wait" && plan.scenarios[2].entry_lo === 0 && plan.scenarios[2].targets.length === 0, "third scenario is always Stand aside / wait with zeroed prices");

/* --- journal stats --- */
const T = Date.now() - 3600e3;
const rows = [
  { t: T, sym: "A", tier: 2, price: 1, p15: 1.05, p30: 1.1, hi30: 1.2, lo30: 0.98 },
  { t: T, sym: "B", tier: 3, price: 2, p15: 1.9, p30: 1.8, hi30: 2.1, lo30: 1.7 },
  { t: T, sym: "C", tier: 2, price: 1, p15: null },
];
const js = journalStats(20, rows);
ok(js.n === 2 && Math.round(js.green15) === 50 && Math.abs(js.avg15 - 0) < 1e-9 && js.tier3.n === 1, "journal stats: only filled rows count, green rate and averages by tier");

/* --- pivots --- */
const b5 = [];
for (let i = 0; i < 20; i++) b5.push({ t: i, o: 1, h: i === 10 ? 1.5 : 1.1, l: i === 5 ? 0.8 : 0.95, c: 1 });
const pv = pivots(b5, 1.0);
ok(pv.some((p) => p.price === 1.5 && p.side === "above") && pv.some((p) => p.price === 0.8 && p.side === "below"), "pivots find the swing high above and swing low below price");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
