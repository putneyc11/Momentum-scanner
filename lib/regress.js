/* Regression gate: does this working tree cost any pod its edge?

   The failure this exists to catch actually happened on 2026-08-28. A live
   fix (the rider stall exit) was correct in its own terms — a dead position
   was occupying a slot all day — and it silently took the only profitable
   pod from profit factor 1.24 to 1.02. Nobody noticed for eight hours,
   because nothing compared before to after.

   That is the failure mode agents will hit faster than people do, so the
   comparison has to be mechanical:

     node engine.js regress --base <git-ref>

   It replays every pod over the recorded days twice — once with the strategy
   code at <base>, once with the working tree — and fails if any pod loses
   more than --maxDrop of profit factor.

   Two deliberate choices:

   - It compares on DEFAULTS, never on state/params. Saved champions differ
     between machines and drift with every tune, so scoring against them would
     make the gate non-reproducible. DEFAULTS are in git, so two people on the
     same two refs get the same table.
   - It reloads the base's strategy code, not the base's day files. The tape is
     the control variable; only the code is allowed to differ. */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

/* The backtest chain (backtest -> strategy -> indicators, strategies ->
   indicators + strategy) requires nothing outside these four files, so a
   historical copy runs standalone — no state/ path to resolve, no keys. */
const CHAIN = ["backtest.js", "strategy.js", "strategies.js", "indicators.js"];

function loadLibAt(ref, repoRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "algo-regress-"));
  for (const f of CHAIN) {
    let src;
    try {
      src = execFileSync("git", ["show", `${ref}:lib/${f}`], { cwd: repoRoot, maxBuffer: 1 << 24, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      throw new Error(`cannot read lib/${f} at ${ref} — is that ref valid, and did it predate the file?`);
    }
    fs.writeFileSync(path.join(dir, f), src);
  }
  return {
    STRATS: require(path.join(dir, "strategies.js")).STRATS,
    DEFAULTS: require(path.join(dir, "strategy.js")).DEFAULTS,
    runBacktest: require(path.join(dir, "backtest.js")).runBacktest,
    dir,
  };
}

function scoreAll(lib, days, equity) {
  const out = new Map();
  for (const st of lib.STRATS) {
    const m = lib.runBacktest(days, { ...lib.DEFAULTS, ...st.DEFAULTS }, equity, st.signalAt).metrics;
    out.set(st.key, m);
  }
  return out;
}

/* Returns { rows, failed }. Pods present on only one side are reported as
   added/removed and never fail the gate — adding a pod is not a regression,
   and deleting one is a decision the table should show rather than block. */
function compare(days, baseRef, opts = {}) {
  const repoRoot = opts.repoRoot || path.join(__dirname, "..");
  const equity = opts.equity || 100000;
  const maxDrop = opts.maxDrop != null ? opts.maxDrop : 0.03;

  const head = {
    STRATS: require("./strategies").STRATS,
    DEFAULTS: require("./strategy").DEFAULTS,
    runBacktest: require("./backtest").runBacktest,
  };
  const base = loadLibAt(baseRef, repoRoot);

  const baseScores = scoreAll(base, days, equity);
  const headScores = scoreAll(head, days, equity);

  const rows = [];
  let failed = false;
  for (const key of new Set([...baseScores.keys(), ...headScores.keys()])) {
    const b = baseScores.get(key);
    const h = headScores.get(key);
    if (!b) { rows.push({ key, status: "added", head: h }); continue; }
    if (!h) { rows.push({ key, status: "removed", base: b }); continue; }
    const delta = +(h.profitFactor - b.profitFactor).toFixed(4);
    /* A drop is a regression; a rise is not. Compare against -maxDrop rather
       than Math.abs so an improvement can never fail the gate. */
    const regressed = delta < -maxDrop;
    if (regressed) failed = true;
    rows.push({ key, status: regressed ? "REGRESSED" : "ok", base: b, head: h, delta });
  }
  rows.sort((x, y) => (x.delta ?? 0) - (y.delta ?? 0));
  try { fs.rmSync(base.dir, { recursive: true, force: true }); } catch {}
  return { rows, failed, maxDrop, days: days.length };
}

function formatTable(res, baseRef) {
  const L = [];
  L.push(`regression gate: working tree vs ${baseRef} over ${res.days} recorded days`);
  L.push(`default params, fail if any pod loses more than ${res.maxDrop} profit factor\n`);
  L.push("pod           base PF   head PF     delta   base trades   head trades   status");
  for (const r of res.rows) {
    if (r.status === "added") {
      L.push(r.key.padEnd(12) + "        -" + String(r.head.profitFactor).padStart(10)
        + "         -" + "             -" + String(r.head.trades).padStart(14) + "   added");
      continue;
    }
    if (r.status === "removed") {
      L.push(r.key.padEnd(12) + String(r.base.profitFactor).padStart(9) + "         -"
        + "         -" + String(r.base.trades).padStart(14) + "             -   removed");
      continue;
    }
    const d = (r.delta > 0 ? "+" : "") + r.delta.toFixed(2);
    L.push(r.key.padEnd(12) + String(r.base.profitFactor).padStart(9)
      + String(r.head.profitFactor).padStart(10) + d.padStart(10)
      + String(r.base.trades).padStart(14) + String(r.head.trades).padStart(14)
      + "   " + r.status);
  }
  L.push("");
  L.push(res.failed
    ? "FAIL — at least one pod lost edge. Do not merge without explaining why that is acceptable."
    : "PASS — no pod lost more than the threshold.");
  return L.join("\n");
}

module.exports = { compare, formatTable, loadLibAt, scoreAll };
