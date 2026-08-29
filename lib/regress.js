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

/* Profit factor is computed over trade RECORDS, and a record is a fill, not a
   position. That makes it sensitive to how finely an exit is sliced, which is
   not an economic property at all.

   Splitting one exit into fills that straddle zero adds the same offsetting
   amount to gross profit and gross loss, and adding equal amounts to both sides
   of a ratio pulls it toward 1.0 — so for a losing pod, slicing exits more
   finely RAISES profit factor while net P&L does not move. Builder measured
   exactly that on the exit cap: reclaim 0.44 -> 0.48 and gapgo 0.61 -> 0.64
   with netPct unchanged to two decimals.

   Aggregating fills back into positions removes the lever. A position is
   uniquely (date, sym, entryM) — the backtester holds at most one open position
   per symbol — and those three fields are present on every ref this gate can
   reach, so the aggregation is comparable across history. */
function positionPF(trades) {
  const byPos = new Map();
  for (const t of trades || []) {
    const k = `${t.date}|${t.sym}|${t.entryM}`;
    byPos.set(k, (byPos.get(k) || 0) + t.pnl);
  }
  let grossW = 0, grossL = 0;
  for (const pnl of byPos.values()) { if (pnl > 0) grossW += pnl; else grossL -= pnl; }
  return {
    positions: byPos.size,
    pf: grossL ? +(grossW / grossL).toFixed(3) : (grossW > 0 ? Infinity : 0),
  };
}

function scoreAll(lib, days, equity) {
  const out = new Map();
  for (const st of lib.STRATS) {
    const r = lib.runBacktest(days, { ...lib.DEFAULTS, ...st.DEFAULTS }, equity, st.signalAt);
    const pos = positionPF(r.trades);
    /* posPF is what the gate judges on; the record-level PF and netPct are
       carried so a granularity artefact is visible instead of silent. */
    out.set(st.key, { ...r.metrics, posPF: pos.pf, positions: pos.positions });
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
    const delta = +(h.posPF - b.posPF).toFixed(4);
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
  L.push(`default params, fail if any pod loses more than ${res.maxDrop} POSITION profit factor`);
  L.push(`posPF aggregates fills back into positions, so it cannot be moved by slicing exits;`);
  L.push(`recPF is the old per-fill number and netPct is carried so an artefact stays visible\n`);
  L.push("pod          base posPF  head posPF     delta   base recPF  head recPF   base netPct  head netPct   status");
  for (const r of res.rows) {
    if (r.status === "added") {
      L.push(r.key.padEnd(12) + "        -" + String(r.head.posPF).padStart(10)
        + "         -" + "             -" + String(r.head.trades).padStart(14) + "   added");
      continue;
    }
    if (r.status === "removed") {
      L.push(r.key.padEnd(12) + String(r.base.posPF).padStart(9) + "         -"
        + "         -" + String(r.base.trades).padStart(14) + "             -   removed");
      continue;
    }
    const d = (r.delta > 0 ? "+" : "") + r.delta.toFixed(3);
    L.push(r.key.padEnd(12) + String(r.base.posPF).padStart(10)
      + String(r.head.posPF).padStart(12) + d.padStart(10)
      + String(r.base.profitFactor).padStart(12) + String(r.head.profitFactor).padStart(12)
      + String(r.base.netPct).padStart(14) + String(r.head.netPct).padStart(13)
      + "   " + r.status);
  }
  L.push("");
  L.push(res.failed
    ? "FAIL — at least one pod lost edge. Do not merge without explaining why that is acceptable."
    : "PASS — no pod lost more than the threshold.");
  return L.join("\n");
}

module.exports = { compare, formatTable, loadLibAt, scoreAll, positionPF };
