import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";

/* ============================================================
   PREMARKET MOMENTUM — ranked small-cap gainers watchlist
   Data: Alpaca Market Data API. Discovery: full-market sweep.
   Ranking: setup score (float rotation, VWAP, EMA stack,
   Supertrend, momentum, volume surge) — not just day %.
   Alerts: server-side monitor + Web Push for lock screen;
   in-app banner + sound while open. S/R feature removed.
   ============================================================ */

const DATA_URL = "https://data.alpaca.markets";
const TRADING_URL = "https://paper-api.alpaca.markets";
const SESSION_START_ET = 4;      // premarket tape opens 4:00 AM ET
const OPEN_ET_MIN = 9 * 60 + 30; // 9:30 AM ET in minutes
const PREMARKET_START_MIN = 4 * 60; // 4:00 AM ET in minutes
/* Premarket discovery gates. The RTH gates (≥25% day, minDayVol) are
   FULL-DAY numbers — at 5 AM nothing on the tape can meet them, which is
   why the list used to sit empty until the open. Premarket runs its own
   floors: gap vs the prior close and CUMULATIVE PREMARKET volume. */
const PM_PCT_FLOOR = 10;   // display floor: ≥10% gap vs prior close
const PM_MIN_VOL = 25000;  // premarket cumulative shares — permissive at 4 AM, filters one-lot junk
const PM_CAND_PCT = 3;     // sweep candidate floor (mirrors the RTH sweep)

const FEED_MODES = {
  sip_delayed: { rest: "sip", delayMs: 16 * 60000, stream: "iex", short: "SIP 15m-delay" },
  iex:         { rest: "iex", delayMs: 0,          stream: "iex", short: "IEX RT" },
  sip:         { rest: "sip", delayMs: 0,          stream: "sip", short: "SIP RT" },
};
const feedMode = (f) => FEED_MODES[f] || FEED_MODES.sip_delayed;
const endISO = (f) => {
  const d = feedMode(f).delayMs;
  return d ? new Date(Date.now() - d).toISOString() : null;
};
const barParams = (f, extra) => {
  const p = { ...extra, feed: feedMode(f).rest };
  const e = endISO(f);
  if (e) p.end = e;
  return p;
};

/* ---------------- palette ---------------- */
const C = {
  bg: "#0A0E13", panel: "#10161E", panel2: "#151D27", border: "#1E2A38",
  text: "#E7EEF5", muted: "#7E8C9A", dim: "#55636F",
  up: "#2EBD85", down: "#F6465D", vwap: "#E8B54D",
  ema8: "#5AC8FA", ema21: "#B18CFF", ema50: "#FF8A5C", amber: "#E8B54D",
};
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const BIG_PRINT = 10000;
const AH_MIN_RATE = 5000;     // after-hours ONLY: avg shares/minute floor (last 3 bars)
const AH_MIN_VOL = 25000;     // after-hours cumulative shares — replaces the old full-day 1M gate

/* ---------------- formatting ---------------- */
const fp = (v, d) =>
  v == null || isNaN(v) ? "—" : Number(v).toFixed(d != null ? d : v >= 100 ? 2 : v >= 1 ? 2 : 4);
const fv = (v) => {
  if (v == null || isNaN(v)) return "—";
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
};
const fpct = (v) =>
  v == null || isNaN(v) ? "—" : (v >= 0 ? "+" : "") + Number(v).toFixed(2) + "%";
const ftime = (d) =>
  new Date(d).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" });
const fdate = (d) =>
  new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });

/* ---------------- time helpers (ET) ---------------- */
function etOffsetMs() {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return now.getTime() - et.getTime();
}
function todayETStartISO(hour) {
  const off = etOffsetMs();
  const d = new Date(Date.now() - off);
  d.setHours(hour, 0, 0, 0);
  return new Date(d.getTime() + off).toISOString();
}
const daysAgoISO = (n) => new Date(Date.now() - n * 864e5).toISOString();
const etDay = (t) => new Date(t).toLocaleDateString("en-US", { timeZone: "America/New_York" });
function inAfterHours() {
  const m = etMinutes(Date.now());
  return m >= 16 * 60 && m < 20 * 60;
}
/* 4:00–9:30 AM ET — the whole premarket session. In this window Alpaca has
   NO daily bar for "today" yet (it only appears after the 9:30 open), so
   discovery must run on snapshots instead of 1Day bars. */
function inPremarket() {
  const m = etMinutes(Date.now());
  return m >= PREMARKET_START_MIN && m < OPEN_ET_MIN;
}
function etMinutes(t) {
  const s = new Date(t).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" });
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

/* ---------------- responsive ---------------- */
function useWidth() {
  const [w, setW] = useState(typeof window !== "undefined" ? window.innerWidth : 1024);
  useEffect(() => {
    const f = () => setW(window.innerWidth);
    window.addEventListener("resize", f);
    window.addEventListener("orientationchange", f);
    return () => { window.removeEventListener("resize", f); window.removeEventListener("orientationchange", f); };
  }, []);
  return w;
}

/* ---------------- indicators ---------------- */
function emaSeries(vals, n) {
  const k = 2 / (n + 1);
  let e = null;
  return vals.map((v) => { e = e === null ? v : v * k + e * (1 - k); return e; });
}
function vwapSeries(bars) {
  let pv = 0, vv = 0;
  return bars.map((b) => {
    const tp = (b.h + b.l + b.c) / 3;
    pv += tp * b.v; vv += b.v;
    return vv ? pv / vv : b.c;
  });
}
/* Supertrend per-bar direction series (+1 bull / -1 bear, null while warming) */
function supertrendDirs(bars, period, mult) {
  period = period || 10; mult = mult || 3;
  const dirs = new Array(bars ? bars.length : 0).fill(null);
  if (!bars || bars.length < period + 2) return dirs;
  const trs = [];
  let prevC = bars[0].c;
  for (const b of bars) {
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - prevC), Math.abs(b.l - prevC)));
    prevC = b.c;
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const atrArr = [...Array(period - 1).fill(null), atr];
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    atrArr.push(atr);
  }
  let upper = Infinity, lower = -Infinity, dir = 1, started = false;
  for (let i = 0; i < bars.length; i++) {
    const at = atrArr[i];
    if (at == null) continue;
    const b = bars[i];
    const mid = (b.h + b.l) / 2;
    let bu = mid + mult * at, bl = mid - mult * at;
    if (started) {
      const pc = bars[i - 1].c;
      if (!(bl > lower || pc < lower)) bl = lower;
      if (!(bu < upper || pc > upper)) bu = upper;
      dir = b.c > upper ? 1 : b.c < lower ? -1 : dir;
    }
    upper = bu; lower = bl; started = true;
    dirs[i] = dir;
  }
  return dirs;
}
const supertrendDir = (bars, period, mult) => {
  const d = supertrendDirs(bars, period, mult);
  for (let i = d.length - 1; i >= 0; i--) if (d[i] != null) return d[i];
  return null;
};
function macdHistSeries(closes) {
  const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
  const m = closes.map((_, i) => e12[i] - e26[i]);
  const sig = emaSeries(m, 9);
  return m.map((v, i) => v - sig[i]);
}
function rsiSeries(closes, n) {
  n = n || 14;
  const out = new Array(closes.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) {
      g += up; l += dn;
      if (i === n) { g /= n; l /= n; out[i] = 100 - 100 / (1 + g / (l || 1e-9)); }
    } else {
      g = (g * (n - 1) + up) / n;
      l = (l * (n - 1) + dn) / n;
      out[i] = 100 - 100 / (1 + g / (l || 1e-9));
    }
  }
  return out;
}
const rocSeries = (closes, n) => {
  n = n || 10;
  return closes.map((c, i) => (i >= n ? ((c - closes[i - n]) / closes[i - n]) * 100 : null));
};

/* Confluence: six-indicator consensus + state-change log */
const CONF_DESC = {
  SUPERTREND: (b) => (b ? "Price broke above the Supertrend rail" : "Price lost the Supertrend rail"),
  MACD: (b, v) => `Histogram crossed ${b ? "above" : "below"} zero (${v.hist != null ? v.hist.toFixed(3) : ""})`,
  "MA 9/21": (b) => `EMA 9 crossed ${b ? "above" : "below"} EMA 21`,
  VWAP: (b) => (b ? "Price reclaimed VWAP" : "Price lost VWAP"),
  "RSI 14": (b, v) => `RSI crossed ${b ? "above" : "below"} 50 (${v.rsi != null ? v.rsi.toFixed(1) : ""})`,
  "ROC 10": (b) => (b ? "Rate of change turned positive" : "Rate of change turned negative"),
};
function confluence(bars) {
  if (!bars || bars.length < 30) return null;
  const closes = bars.map((b) => b.c);
  const e9 = emaSeries(closes, 9), e21 = emaSeries(closes, 21);
  const vw = vwapSeries(bars);
  const hist = macdHistSeries(closes);
  const rsi = rsiSeries(closes, 14);
  const roc = rocSeries(closes, 10);
  const dirs = supertrendDirs(bars);
  const stateAt = (i) => ({
    SUPERTREND: dirs[i] === 1,
    MACD: hist[i] > 0,
    "MA 9/21": e9[i] > e21[i],
    VWAP: closes[i] > vw[i],
    "RSI 14": rsi[i] != null && rsi[i] > 50,
    "ROC 10": roc[i] != null && roc[i] > 0,
  });
  const warm = Math.min(27, bars.length - 2);
  const flips = [];
  let prev = stateAt(warm);
  let lastFlipIdx = warm;
  for (let i = warm + 1; i < bars.length; i++) {
    const cur = stateAt(i);
    for (const k of Object.keys(cur)) {
      if (cur[k] !== prev[k]) {
        flips.push({ t: bars[i].t, ind: k, bull: cur[k], price: closes[i], desc: CONF_DESC[k](cur[k], { hist: hist[i], rsi: rsi[i] }) });
        lastFlipIdx = i;
      }
    }
    prev = cur;
  }
  const i = bars.length - 1;
  const now = stateAt(i);
  const rows = [
    { k: "SUPERTREND", bull: now.SUPERTREND, val: now.SUPERTREND ? "bull rail" : "bear rail" },
    { k: "MACD", bull: now.MACD, val: (hist[i] >= 0 ? "+" : "") + hist[i].toFixed(3) },
    { k: "MA 9/21", bull: now["MA 9/21"], val: `${fp(e9[i])} / ${fp(e21[i])}` },
    { k: "VWAP", bull: now.VWAP, val: "$" + fp(vw[i]) },
    { k: "RSI 14", bull: now["RSI 14"], val: rsi[i] != null ? rsi[i].toFixed(1) : "—" },
    { k: "ROC 10", bull: now["ROC 10"], val: roc[i] != null ? roc[i].toFixed(2) + "%" : "—" },
  ];
  return {
    score: rows.filter((r) => r.bull).length,
    rows,
    flips: flips.slice(-12).reverse(),
    barsSinceFlip: i - lastFlipIdx,
  };
}

/* ---------------- setup score (0-100) ---------------- */
function setupScore(g, bars5, floatShares) {
  const parts = { rotation: 0, vwap: 0, ema: 0, st: 0, momo: 0, surge: 0 };
  if (bars5 && bars5.length >= 8) {
    const closes = bars5.map((b) => b.c);
    const p = closes[closes.length - 1];
    const vw = vwapSeries(bars5);
    const vwL = vw[vw.length - 1];
    const e8 = emaSeries(closes, 8), e21 = emaSeries(closes, 21), e50 = emaSeries(closes, 50);
    const a8 = e8[e8.length - 1], a21 = e21[e21.length - 1], a50 = e50[e50.length - 1];
    parts.vwap = p > vwL ? 15 : p >= vwL * 0.99 ? 8 : 0;
    parts.ema = a8 > a21 && a21 > a50 ? 15 : a8 > a21 ? 8 : 0;
    parts.st = supertrendDir(bars5) === 1 ? 15 : 0;
    const last = bars5[bars5.length - 1];
    const prior = bars5.slice(-7, -1);
    const avgV = prior.length ? prior.reduce((a, b) => a + b.v, 0) / prior.length : 0;
    parts.surge = avgV && last.v >= 2 * avgV ? 15 : avgV && last.v >= 1.3 * avgV ? 8 : 0;
  }
  const rot = floatShares ? g.dayVol / floatShares : null;
  parts.rotation = rot == null ? 8
    : rot >= 3 ? 25 : rot >= 1 ? 20 : rot >= 0.5 ? 15 : rot >= 0.25 ? 10 : rot >= 0.1 ? 5 : 0;
  parts.momo = Math.round((Math.min(Math.max(g.pct, 0), 100) / 100) * 15);
  const score = Object.values(parts).reduce((a, b) => a + b, 0);
  const grade = score >= 80 ? "A" : score >= 65 ? "B" : score >= 50 ? "C" : "D";
  return { score, grade, parts, rotation: rot };
}
const gradeColor = (gr) => (gr === "A" ? C.up : gr === "B" ? C.amber : gr === "C" ? C.muted : C.down);

/* ---------------- Alpaca fetch ---------------- */
/* stable anonymous device identity — the server-keys proxy gate and the
   per-device watchlist/push routing key off this */
const DEVICE = { id: "" };
async function req(base, path, params, keys) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${base}${path}${qs ? "?" + qs : ""}`, {
    headers: { "APCA-API-KEY-ID": keys.id.trim(), "APCA-API-SECRET-KEY": keys.secret.trim(), ...(DEVICE.id ? { "X-Device": DEVICE.id } : {}) },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`${r.status}: ${t.slice(0, 140) || r.statusText}`);
  }
  return r.json();
}
const alpaca = (path, params, keys) => req(DATA_URL, path, params, keys);
const alpacaT = (path, params, keys) => req(TRADING_URL, path, params, keys);
const normBar = (b) => ({ t: new Date(b.t).getTime(), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });

/* ---------------- canvas chart ---------------- */
function drawChart(canvas, bars, opts) {
  if (!canvas || !bars || bars.length === 0) return;
  const o = opts || {};
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const padR = o.axes ? 62 : 4;
  const padT = 8, padL = 4;
  const volH = o.volume === false ? 0 : Math.round(H * 0.15);
  const padB = (o.axes ? 22 : 4) + volH;
  const pw = W - padL - padR, ph = H - padT - padB;

  let lo = Infinity, hi = -Infinity;
  for (const b of bars) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
  for (const s of o.lines || []) for (const v of s.vals) if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = Math.max(hi - lo, hi * 0.002) || 1;
  lo -= span * 0.06; hi += span * 0.06;
  const y = (p) => padT + ((hi - p) / (hi - lo)) * ph;
  const n = bars.length;
  const step = pw / n;
  const cw = Math.max(1, Math.min(step * 0.68, 16));
  const x = (i) => padL + i * step + step / 2;
  const multiDay = n > 1 && fdate(bars[0].t) !== fdate(bars[n - 1].t);

  if (o.axes) {
    ctx.font = `10px ${MONO}`;
    const ticks = 6;
    for (let i = 0; i <= ticks; i++) {
      const p = hi - ((hi - lo) * i) / ticks;
      const yy = y(p);
      ctx.strokeStyle = "rgba(255,255,255,0.05)";
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
      ctx.fillStyle = C.muted;
      ctx.fillText("$" + fp(p), W - padR + 5, yy + 3);
    }
    const labEvery = Math.max(1, Math.floor(n / (W < 500 ? 4 : 7)));
    ctx.textAlign = "center";
    for (let i = 0; i < n; i += labEvery) {
      const xx = x(i);
      ctx.strokeStyle = "rgba(255,255,255,0.035)";
      ctx.beginPath(); ctx.moveTo(xx, padT); ctx.lineTo(xx, padT + ph); ctx.stroke();
      if (xx > W - padR - 88) continue; /* keep clear of the axis caption */
      ctx.fillStyle = C.muted;
      const lab = o.daily ? fdate(bars[i].t) : multiDay ? `${fdate(bars[i].t)} ${ftime(bars[i].t)}` : ftime(bars[i].t);
      ctx.fillText(lab, Math.max(xx, 30), H - 7); /* clamp so the first label isn't clipped */
    }
    ctx.textAlign = "left";
    ctx.fillStyle = C.dim;
    ctx.font = `bold 9px ${MONO}`;
    ctx.fillText("USD", W - padR + 5, padT + 15); /* below the top tick, no overlap */
    ctx.textAlign = "right";
    const axCap = o.daily ? "DATE" : "TIME (ET)";
    const axW = ctx.measureText(axCap).width;
    ctx.fillStyle = "#0A0E13";
    ctx.fillRect(W - padR - 9 - axW, H - 16, axW + 9, 12); /* solid chip under the caption */
    ctx.fillStyle = C.dim;
    ctx.fillText(axCap, W - padR - 4, H - 7);
    ctx.textAlign = "left";
    if (volH > 0) ctx.fillText("VOL", padL + 2, H - 22 - volH + 9);
    ctx.font = `10px ${MONO}`;
  }

  if (volH > 0) {
    let vmax = 0;
    for (const b of bars) if (b.v > vmax) vmax = b.v;
    const vy0 = H - (o.axes ? 22 : 4);
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      const hgt = vmax ? (b.v / vmax) * (volH - 2) : 0;
      ctx.fillStyle = (b.c >= b.o ? C.up : C.down) + "55";
      ctx.fillRect(x(i) - cw / 2, vy0 - hgt, cw, hgt);
    }
  }

  /* premarket high/low reference lines */
  for (const l of o.pmLines || []) {
    if (l.price == null) continue;
    const yy = y(l.price);
    if (yy < padT - 4 || yy > padT + ph + 4) continue;
    const col = l.kind === "pmh" ? C.amber : l.kind === "sup" ? C.up : l.kind === "res" ? C.down : "#5A7184";
    ctx.strokeStyle = col + "BB";
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
    ctx.setLineDash([]);
    if (o.axes) {
      /* opaque chips so PMH/PML never garble the price ticks; PML sits BELOW its line */
      const pmTxt = (l.kind === "pmh" ? "PMH $" : l.kind === "pml" ? "PML $" : (l.label || (l.kind === "sup" ? "S" : "R")) + " $") + fp(l.price);
      ctx.font = `bold 9px ${MONO}`;
      const tw = ctx.measureText(pmTxt).width;
      const ty = l.kind === "pmh" || l.kind === "res" ? yy - 4 : yy + 12;
      ctx.fillStyle = "#0A0E13";
      ctx.fillRect(W - padR + 2, ty - 8, tw + 7, 11);
      ctx.fillStyle = col;
      ctx.fillText(pmTxt, W - padR + 5, ty);
      ctx.font = `10px ${MONO}`;
    }
  }

  for (const s of o.lines || []) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width || 1.2;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const v = s.vals[i];
      if (v == null) continue;
      if (!started) { ctx.moveTo(x(i), y(v)); started = true; }
      else ctx.lineTo(x(i), y(v));
    }
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const col = b.c >= b.o ? C.up : C.down;
    ctx.strokeStyle = col; ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(x(i), y(b.h)); ctx.lineTo(x(i), y(b.l)); ctx.stroke();
    const yo = y(b.o), yc = y(b.c);
    ctx.fillRect(x(i) - cw / 2, Math.min(yo, yc), cw, Math.max(1, Math.abs(yc - yo)));
  }

  const last = bars[n - 1];
  const ly = y(last.c);
  ctx.strokeStyle = C.text + "55";
  ctx.setLineDash([2, 3]);
  ctx.beginPath(); ctx.moveTo(padL, ly); ctx.lineTo(W - padR, ly); ctx.stroke();
  ctx.setLineDash([]);
  if (o.axes) {
    ctx.fillStyle = last.c >= last.o ? C.up : C.down;
    ctx.fillRect(W - padR + 1, ly - 8, padR - 2, 16);
    ctx.fillStyle = "#06090D";
    ctx.font = `bold 10px ${MONO}`;
    ctx.fillText("$" + fp(last.c), W - padR + 4, ly + 3);
  }

  if (o.cross && o.cross.i != null && o.cross.i >= 0 && o.cross.i < n) {
    const i = o.cross.i, b = bars[i];
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x(i), padT); ctx.lineTo(x(i), padT + ph); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(padL, y(b.c)); ctx.lineTo(W - padR, y(b.c)); ctx.stroke();
    ctx.setLineDash([]);
    const ind = (o.lines || []).filter((s) => s.name && s.vals[i] != null).map((s) => ({ name: s.name, val: s.vals[i], color: s.color }));
    const rows = 4 + ind.length;
    const bh = 20 + rows * 13 + 6;
    const bw = 156;
    const bx = x(i) + bw + 14 > W - padR ? x(i) - bw - 14 : x(i) + 14;
    const by = Math.min(padT + 6, padT + ph - bh);
    ctx.fillStyle = "rgba(10,14,19,0.94)";
    ctx.strokeStyle = C.border;
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeRect(bx, by, bw, bh);
    ctx.font = `bold 10px ${MONO}`;
    ctx.fillStyle = C.text;
    ctx.fillText(`${o.daily || multiDay ? fdate(b.t) + " " : ""}${o.daily ? "" : ftime(b.t) + " ET"}`, bx + 8, by + 14);
    ctx.font = `10px ${MONO}`;
    let ry = by + 28;
    ctx.fillStyle = C.muted;
    ctx.fillText(`O $${fp(b.o)}   H $${fp(b.h)}`, bx + 8, ry); ry += 13;
    ctx.fillText(`L $${fp(b.l)}   C $${fp(b.c)}`, bx + 8, ry); ry += 13;
    ctx.fillText(`Vol ${fv(b.v)}`, bx + 8, ry); ry += 13;
    for (const s of ind) {
      ctx.fillStyle = s.color;
      ctx.fillRect(bx + 8, ry - 7, 7, 7);
      ctx.fillText(`${s.name}  $${fp(s.val)}`, bx + 19, ry);
      ry += 13;
    }
  }
}

/* ---------------- sparkline ---------------- */
function Spark({ bars, up, h, fill }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !bars || bars.length < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const cs = bars.map((b) => b.c);
    let lo = Math.min(...cs), hi = Math.max(...cs);
    if (hi - lo < 1e-9) hi = lo + 1e-9;
    ctx.strokeStyle = up ? C.up : C.down;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    cs.forEach((c, i) => {
      const xx = (i / (cs.length - 1)) * (W - 7) + 1; /* inset so the line never touches the right edge */
      const yy = H - 2 - ((c - lo) / (hi - lo)) * (H - 4);
      i === 0 ? ctx.moveTo(xx, yy) : ctx.lineTo(xx, yy);
    });
    ctx.stroke();
  }, [bars, up]);
  /* On phones (fill) the spark FLEXES instead of forcing 72px: a rigid width
     made the row overflow, which shoved the spark flush against the row edge
     and clipped its padding entirely. marginRight keeps a real gap between
     the end of the line and the row edge at every width. */
  return <canvas ref={ref} style={{
    ...(fill ? { flex: "0 1 72px", minWidth: 30, maxWidth: 72, width: "auto" } : { width: 72, flexShrink: 0 }),
    height: h || 24, display: "block", marginRight: fill ? 0 : 10,
  }} />;
}

/* ---------------- outline bell (stroke-only, inherits the row's gray) ---------------- */
function BellIcon({ muted, size }) {
  return (
    <svg width={size || 15} height={size || 15} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }}>
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      {muted && <line x1="2" y1="2" x2="22" y2="22" />}
    </svg>
  );
}

/* ---------------- outline copy / save icons ---------------- */
function CopyIcon({ size }) {
  return (
    <svg width={size || 13} height={size || 13} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block", flexShrink: 0 }} aria-hidden="true">
      <rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
function SaveIcon({ size }) {
  return (
    <svg width={size || 13} height={size || 13} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block", flexShrink: 0 }} aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" />
    </svg>
  );
}

/* ---------------- outline newspaper icon ---------------- */
function NewsIcon({ size }) {
  return (
    <svg width={size || 13} height={size || 13} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block", flexShrink: 0 }}>
      <path d="M4 22h14a2 2 0 0 0 2-2V6l-4-4H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2z" />
      <path d="M16 2v4h4" /><path d="M9 13h6" /><path d="M9 17h6" /><path d="M9 9h2" />
    </svg>
  );
}

/* ---------------- watchlist row ---------------- */
/* per-ticker alert categories a user can switch off individually */
const ALERT_CATS = [
  ["setup", "Setup pushes"], ["vwap", "VWAP reclaim"], ["ema", "EMA cross"], ["pmh", "PMH break"],
  ["mom3", "3 green"], ["vol", "Volume surge"], ["halt", "Halts"], ["rot", "Rotation"],
];

/* catalyst headlines that smell like dilution — flagged in red on the row */
const DILUTE_RE = /offering|registered direct|private placement|dilut|at-the-market|warrant inducement|reverse split|\bS-1\b|\bS-3\b|prices? public/i;

function GainerRow({ g, bars, halted, haltedAt, news, onOpen, fill, ah, muted, onMute }) {
  /* Phone metrics (fill): slightly slimmer columns + tighter gaps so the row
     NEVER overflows — overflow is what used to jam the spark flush against
     the row edge with zero padding. The chevron is desktop-only (on phones
     it was always clipped anyway, and the whole row is tappable). */
  const w = fill ? { tick: 46, price: 50, pct: 58, vol: 40 } : { tick: 54, price: 56, pct: 66, vol: 48 };
  return (
    <div
      onClick={() => onOpen(g.symbol)}
      className="noscrollbar"
      style={{ display: "flex", alignItems: "center", gap: fill ? 3 : 10, padding: fill ? "9px 10px" : "9px 12px", borderBottom: `1px solid ${C.border}88`, cursor: "pointer", overflowX: "auto", WebkitOverflowScrolling: "touch", ...(fill ? { height: 64, boxSizing: "border-box", position: "relative" } : {}) }}
    >
      <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 800, color: gradeColor(g.grade), background: gradeColor(g.grade) + "1A", border: `1px solid ${gradeColor(g.grade)}55`, borderRadius: 5, padding: fill ? "2px 5px" : "2px 6px", minWidth: fill ? 34 : 40, textAlign: "center", flexShrink: 0 }}>
        {g.grade} {g.score}
      </span>
      <span style={{ fontWeight: 800, fontSize: 14, minWidth: w.tick, display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap", flexShrink: 0 }}>
        {g.symbol}
        {halted && (
          <span style={{ color: C.down, fontSize: 10, fontFamily: MONO }}>
            ⛔{haltedAt ? `${Math.max(1, Math.round((Date.now() - haltedAt) / 60000))}m` : ""}
          </span>
        )}
        {g.pct >= 200 && <span title="verify split/relisting" style={{ color: C.amber, fontSize: 10 }}>⚠</span>}
      </span>
      <span style={{ fontFamily: MONO, fontSize: 13, minWidth: w.price, flexShrink: 0 }}>{fp(g.price)}</span>
      <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: g.pct >= 0 ? C.up : C.down, minWidth: w.pct, flexShrink: 0 }}>
        {fpct(g.pct)}
        {ah && !fill && <span style={{ display: "block", fontSize: 9, fontWeight: 700, color: C.ema21, whiteSpace: "nowrap" }}>{`AH ${fpct(ah.pct)}\u00A0\u00A0\u00B7\u00A0\u00A0${fv(ah.vol)}`}</span>}
      </span>
      {ah && fill && (
        /* AH readout: its own band anchored to the ROW bottom (out of flow),
           aligned under the % column — clear of the centered number line */
        <span style={{ position: "absolute", bottom: 5, left: 186, fontSize: 9, fontWeight: 700, color: C.ema21, whiteSpace: "nowrap" }}>
          {`AH ${fpct(ah.pct)}\u00A0\u00A0\u00B7\u00A0\u00A0${fv(ah.vol)}`}
        </span>
      )}
      <span style={{ fontFamily: MONO, fontSize: 11, color: C.muted, minWidth: w.vol, flexShrink: 0 }}>
        {fv(g.dayVol)}
        {g.rotation != null && g.rotation >= 0.5 && (
          /* float rotation: cumulative volume ÷ float — the gap trader's #1 stat */
          <span style={{ display: "block", fontSize: 9, fontWeight: 700, color: g.rotation >= 1 ? C.amber : C.dim }}>
            {g.rotation.toFixed(1)}×F
          </span>
        )}
      </span>
      <div style={{ flex: 1 }} />
      {bars && bars.length > 1 && <Spark bars={bars} up={g.pct >= 0} h={fill ? 32 : 24} fill={fill} />}
      {onMute && (
        /* outline bell, vertically centered, padded both sides; stretching to
           the row height makes the whole strip a comfortable tap target */
        <span
          onClick={(e) => { e.stopPropagation(); onMute(g.symbol); }}
          aria-label={muted ? "unmute alerts for this stock" : "mute alerts for this stock"}
          title={muted ? "alerts muted for this stock — tap to unmute" : "alerts on for this stock — tap to mute"}
          style={{ display: "flex", alignItems: "center", alignSelf: "stretch", padding: "0 5px", color: muted ? C.dim : C.muted, opacity: muted ? 0.55 : 1, cursor: "pointer", flexShrink: 0 }}>
          <BellIcon muted={muted} />
        </span>
      )}
      {news && (
        /* catalyst attached — sits at the END of the row (scroll to it on a
           phone); the full headline lives in the Advanced view */
        <span title={news.headline} style={{ display: "inline-flex", alignItems: "center", gap: 3, color: news.dilution ? C.down : C.dim, flexShrink: 0, paddingRight: 2 }}>
          <NewsIcon />
          {news.dilution && <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: 0.5 }}>DIL</span>}
        </span>
      )}
      {!fill && <span style={{ color: C.dim }}>›</span>}
    </div>
  );
}

/* ---------------- first-run walkthrough ----------------
   Six swipeable slides, each a LIVE mini-demo built from the app's real
   components (GainerRow, Spark, BellIcon) running scripted data — the
   preview IS the product, not a brochure. Shown before key entry on a
   fresh device; reopenable any time from the header's ? control. */
const OB_ROW = (over) => ({ symbol: "DMO", price: 4.86, pct: 62.4, dayVol: 8.4e6, score: 82, grade: "A", rotation: null, ...over });
const OB_SLIDES = [
  { title: "The market opens at 4 AM.\nSo do we.", sub: "Full-market discovery from the first premarket print — the list fills itself, re-ranks by setup score, and re-prices every 3 seconds through the 8 PM after-hours close." },
  { title: "Know why it's moving.", sub: "The latest catalyst headline rides on every row — and when recent news smells like an offering, a dilution flag warns you before you chase." },
  { title: "Halts won't surprise you.", sub: "Tape-stall detection with a live halt timer, plus estimated LULD halt bands so you can see where the next pause would arm." },
  { title: "Watch the float rotate.", sub: "Live float rotation on every row — and an alert the moment the float has traded 1×, 2×, 3× over." },
  { title: "Rewind any run.", sub: "Scrub back through the session's tape bar by bar, or press play and watch the move rebuild — right on your phone." },
  { title: "Your alerts, your rules.", sub: "A bell on every row. VWAP reclaims, breakouts, volume surges and float rotations reach your lock screen — only for the stocks you keep armed." },
];
function ObDemo({ slide, tick }) {
  const t = tick;
  const wrap = { background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", width: "100%" };
  const noop = () => {};
  if (slide === 0) {
    const sess = ["PREMARKET", "REGULAR HOURS", "AFTER HOURS"][Math.floor(t / 4) % 3];
    const rows = [
      OB_ROW({ symbol: "DMO", price: 4.86 + (t % 2) * 0.03, pct: 62.4 + (t % 2) * 0.4 }),
      OB_ROW({ symbol: "GAPR", price: 2.31 + (t % 2) * 0.01, pct: 41.1, score: 74, grade: "B", dayVol: 5.1e6 }),
      OB_ROW({ symbol: "RNNR", price: 7.12, pct: 28.9 + (t % 2) * 0.2, score: 61, grade: "C", dayVol: 3.2e6 }),
    ].slice(0, Math.min(3, 1 + Math.floor(t / 2)));
    return (
      <div style={wrap}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", borderBottom: `1px solid ${C.border}` }}>
          <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 1.5, color: C.amber }}>{sess}</span>
          <span style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>· live 3s</span>
        </div>
        {rows.map((g) => <GainerRow key={g.symbol} g={g} bars={null} onOpen={noop} fill />)}
      </div>
    );
  }
  if (slide === 1) {
    const staged = t >= 5;
    const g = staged
      ? OB_ROW({ symbol: "DILU", price: 1.92, pct: 44.0, score: 55, grade: "C", dayVol: 6.2e6 })
      : OB_ROW();
    const news = t >= 2 ? { headline: staged ? "DILU announces $12M registered direct offering" : "DMO receives FDA fast-track designation for lead candidate", at: Date.now() - 3600e3, dilution: staged } : null;
    return (
      <div style={wrap}>
        <GainerRow g={g} bars={null} news={news} onOpen={noop} fill />
        {news && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 12px", borderTop: `1px solid ${C.border}`, fontSize: 11, color: C.muted }}>
            {news.dilution && <span style={{ color: C.down, fontFamily: MONO, fontSize: 9, fontWeight: 800, border: `1px solid ${C.down}66`, borderRadius: 4, padding: "1px 5px", flexShrink: 0 }}>DILUTION RISK</span>}
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>📰 {news.headline}</span>
          </div>
        )}
      </div>
    );
  }
  if (slide === 2) {
    return (
      <div style={wrap}>
        <GainerRow g={OB_ROW({ symbol: "HLTD", price: 5.11, pct: 88.2, score: 77, grade: "B" })} bars={null} halted haltedAt={Date.now() - ((t % 4) + 1) * 60000} onOpen={noop} fill />
        <div style={{ display: "flex", gap: 14, padding: "8px 12px", borderTop: `1px solid ${C.border}`, fontFamily: MONO, fontSize: 11 }}>
          <span style={{ color: C.amber }}>LULD ↑ est {fp(5.11 * 1.1)}</span>
          <span style={{ color: C.down }}>LULD ↓ est {fp(5.11 * 0.9)}</span>
          <span style={{ color: C.dim }}>10% band</span>
        </div>
      </div>
    );
  }
  if (slide === 3) {
    const rot = Math.min(2.4, 0.6 + t * 0.15);
    return (
      <div style={wrap}>
        <GainerRow g={OB_ROW({ rotation: rot, dayVol: 8.4e6 * rot })} bars={null} onOpen={noop} fill />
        {rot >= 1 && (
          <div style={{ margin: 10, padding: "7px 10px", background: "#231A0A", border: `1px solid ${C.amber}66`, borderRadius: 8 }}>
            <div style={{ fontFamily: MONO, fontSize: 9, color: C.amber, letterSpacing: 1 }}>🔔 now</div>
            <div style={{ fontSize: 12, fontWeight: 700 }}>🔄 DMO float rotation {Math.floor(rot)}×</div>
          </div>
        )}
      </div>
    );
  }
  if (slide === 4) {
    const all = Array.from({ length: 40 }, (_, i) => ({ c: 2 + i * 0.05 + Math.sin(i / 3) * 0.08 }));
    const n = Math.max(2, Math.min(40, 4 + t * 4));
    return (
      <div style={{ ...wrap, padding: "12px 12px 8px" }}>
        <Spark bars={all.slice(0, n)} up h={56} />
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
          <span style={{ fontFamily: MONO, fontSize: 11, color: C.amber }}>▶</span>
          <div style={{ flex: 1, height: 3, background: C.border, borderRadius: 2, overflow: "hidden" }}>
            <div style={{ width: "100%", height: "100%", background: C.amber, borderRadius: 2, transform: `scaleX(${n / 40})`, transformOrigin: "left", transition: "transform 600ms linear" }} />
          </div>
          <span style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>{n}/40</span>
        </div>
      </div>
    );
  }
  const armed = Math.floor(t / 3) % 2 === 0;
  return (
    <div style={{ ...wrap, padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontWeight: 800, fontSize: 14 }}>DMO</span>
        <span style={{ fontFamily: MONO, fontSize: 12, color: C.up }}>+62.4%</span>
        <div style={{ flex: 1 }} />
        <span style={{ color: armed ? C.muted : C.dim, opacity: armed ? 1 : 0.55 }}><BellIcon muted={!armed} /></span>
      </div>
      <div style={{ marginTop: 10, padding: "9px 11px", background: "#10161E", border: `1px solid ${C.border}`, borderRadius: 10, opacity: armed ? 1 : 0.35, transform: armed ? "translateY(0)" : "translateY(4px)", transition: "opacity 400ms ease, transform 400ms ease" }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", fontFamily: MONO, fontSize: 9, color: C.dim }}>
          <span style={{ width: 8, height: 8, background: C.amber, borderRadius: 2, display: "inline-block" }} />
          MOMENTUM SCANNER · now
        </div>
        <div style={{ fontSize: 12, fontWeight: 700, marginTop: 3 }}>🚨 DMO broke premarket high</div>
        <div style={{ fontSize: 11, color: C.muted }}>Through PMH $4.61 · now $4.86</div>
      </div>
    </div>
  );
}
function OnboardSlides({ mode, onDone, onSkip }) {
  const [idx, setIdx] = useState(0);
  const [tick, setTick] = useState(0);
  const touchRef = useRef(null);
  const last = idx === OB_SLIDES.length - 1;
  useEffect(() => {
    setTick(0);
    const id = setInterval(() => setTick((x) => x + 1), 700);
    return () => clearInterval(id);
  }, [idx]);
  const go = (d) => setIdx((i) => Math.max(0, Math.min(OB_SLIDES.length - 1, i + d)));
  return (
    <div
      onTouchStart={(e) => { touchRef.current = e.touches[0].clientX; }}
      onTouchEnd={(e) => {
        const x0 = touchRef.current;
        touchRef.current = null;
        if (x0 == null) return;
        const dx = e.changedTouches[0].clientX - x0;
        if (dx < -50) go(1); else if (dx > 50) go(-1);
      }}
      style={{ position: "fixed", inset: 0, zIndex: 100, background: C.bg, color: C.text, display: "flex", flexDirection: "column", paddingTop: "calc(14px + env(safe-area-inset-top))", paddingBottom: "calc(14px + env(safe-area-inset-bottom))", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", padding: "0 18px" }}>
        <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 2, color: C.amber }}>MOMENTUM SCANNER</span>
        <div style={{ flex: 1 }} />
        <button onClick={onSkip} style={{ background: "transparent", border: "none", color: C.dim, fontSize: 13, cursor: "pointer", padding: 8 }}>Skip</button>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", gap: 22, padding: "0 22px", maxWidth: 560, width: "100%", margin: "0 auto", boxSizing: "border-box", minHeight: 0 }}>
        <h1 style={{ fontSize: 27, lineHeight: 1.16, fontWeight: 800, margin: 0, whiteSpace: "pre-line" }}>{OB_SLIDES[idx].title}</h1>
        <ObDemo slide={idx} tick={tick} />
        <p style={{ color: C.muted, fontSize: 14, lineHeight: 1.55, margin: 0 }}>{OB_SLIDES[idx].sub}</p>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "8px 22px 0", maxWidth: 560, width: "100%", margin: "0 auto", boxSizing: "border-box" }}>
        <div style={{ display: "flex", gap: 7 }}>
          {OB_SLIDES.map((_, i) => (
            <span key={i} onClick={() => setIdx(i)}
              style={{ width: i === idx ? 18 : 7, height: 7, borderRadius: 4, background: i === idx ? C.amber : C.border, cursor: "pointer", transition: "background 250ms ease" }} />
          ))}
        </div>
        <div style={{ flex: 1 }} />
        {last ? (
          <button onClick={onDone}
            style={{ background: C.amber, color: "#06090D", border: "none", borderRadius: 8, padding: "13px 22px", fontWeight: 800, fontSize: 14, cursor: "pointer" }}>
            {mode === "help" ? "Done" : "Create account →"}
          </button>
        ) : (
          <button onClick={() => go(1)}
            style={{ background: "transparent", border: `1px solid ${C.amber}`, color: C.amber, borderRadius: 8, padding: "12px 22px", fontWeight: 700, fontSize: 14, cursor: "pointer" }}>
            Next →
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------------- account + plan (first-run, after the walkthrough) ----------------
   PREVIEW BUILD: sign-in and billing are simulated on this device — no
   identity provider or payment processor is wired yet. The screens are the
   real UX so the App Store flow can be judged before the backend lands. */
const PLAN_ROWS = [
  ["Watchlist", "Top 10 movers", "Full ranked list + After Hours table"],
  ["Market data", "15-min delayed display", "Real-time alerts from the server monitor"],
  ["Alerts", "In-app banner", "Lock-screen push · per-ticker rules · 15 price levels"],
  ["Tape replay", "—", "Scrub any session bar by bar"],
  ["Halt intel", "—", "Estimated LULD bands + halt timers"],
  ["Catalysts", "—", "Headlines + dilution flags on every row"],
];
const PRO_PRICE = "$9.99/mo";
const acctLabel = (a) => !a ? "" : a.provider === "apple" ? "Apple ID" : a.provider === "google" ? "Google account" : a.email;

function AccountFlow({ onDone, onSkip }) {
  const [step, setStep] = useState("signup"); // signup | email | plan
  const [email, setEmail] = useState("");
  const [acct, setAcct] = useState(null);
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const signIn = (provider, em) => {
    setAcct({ provider, email: em || "", plan: "free", createdAt: Date.now() });
    setStep("plan");
  };
  const pick = (plan) => onDone({ ...acct, plan, trial: plan === "pro" });
  const shell = { position: "fixed", inset: 0, zIndex: 100, background: C.bg, color: C.text, display: "flex", flexDirection: "column", paddingTop: "calc(14px + env(safe-area-inset-top))", paddingBottom: "calc(14px + env(safe-area-inset-bottom))", fontFamily: "system-ui, sans-serif", overflowY: "auto" };
  const col = { display: "flex", flexDirection: "column", gap: 14, padding: "0 22px", maxWidth: 520, width: "100%", margin: "0 auto", boxSizing: "border-box" };
  const big = (extra) => ({ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, width: "100%", boxSizing: "border-box", borderRadius: 10, padding: "14px 16px", fontSize: 15, fontWeight: 700, cursor: "pointer", ...extra });
  const AppleMark = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.37 12.6c0-2.4 1.96-3.55 2.05-3.6-1.12-1.64-2.86-1.86-3.47-1.89-1.48-.15-2.89.87-3.64.87-.75 0-1.9-.85-3.13-.83-1.61.02-3.1.94-3.93 2.38-1.68 2.91-.43 7.22 1.2 9.58.8 1.16 1.75 2.46 3 2.41 1.2-.05 1.66-.78 3.11-.78 1.45 0 1.86.78 3.13.75 1.29-.02 2.11-1.18 2.9-2.34.91-1.34 1.29-2.64 1.31-2.71-.03-.01-2.52-.97-2.53-3.84zM14 5.4c.66-.8 1.11-1.92.99-3.03-.95.04-2.1.63-2.79 1.43-.61.71-1.15 1.84-1.01 2.93 1.06.08 2.15-.54 2.81-1.33z"/></svg>
  );
  const GoogleMark = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5c-.3 1.5-1.1 2.7-2.4 3.6v3h3.9c2.2-2.1 3.5-5.1 3.5-8.7z"/><path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1C3.3 21.3 7.3 24 12 24z"/><path fill="#FBBC05" d="M5.3 14.3c-.2-.7-.4-1.5-.4-2.3s.1-1.6.4-2.3V6.6H1.3C.5 8.2 0 10 0 12s.5 3.8 1.3 5.4l4-3.1z"/><path fill="#EA4335" d="M12 4.7c1.8 0 3.3.6 4.6 1.8l3.4-3.4C18 1.2 15.2 0 12 0 7.3 0 3.3 2.7 1.3 6.6l4 3.1c.9-2.9 3.6-5 6.7-5z"/></svg>
  );
  return (
    <div style={shell}>
      <div style={{ display: "flex", alignItems: "center", padding: "0 18px 10px" }}>
        <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 2, color: C.amber }}>MOMENTUM SCANNER</span>
        <div style={{ flex: 1 }} />
        {step !== "plan" && <button onClick={onSkip} style={{ background: "transparent", border: "none", color: C.dim, fontSize: 13, cursor: "pointer", padding: 8 }}>Not now</button>}
      </div>
      {step === "signup" && (
        <div style={{ ...col, flex: 1, justifyContent: "center" }}>
          <h1 style={{ fontSize: 27, lineHeight: 1.16, fontWeight: 800, margin: 0 }}>Create your account</h1>
          <p style={{ color: C.muted, fontSize: 14, lineHeight: 1.55, margin: "0 0 8px" }}>Your watchlist, alert rules and plan follow you to every device you sign in on.</p>
          <button onClick={() => signIn("apple")} style={big({ background: "#FFFFFF", color: "#000", border: "none" })}><AppleMark /> Continue with Apple</button>
          <button onClick={() => signIn("google")} style={big({ background: "#FFFFFF", color: "#1F1F1F", border: "none" })}><GoogleMark /> Continue with Google</button>
          <button onClick={() => setStep("email")} style={big({ background: "transparent", color: C.text, border: `1px solid ${C.border}` })}>✉ Continue with email</button>
          <div style={{ fontSize: 11, color: C.dim, lineHeight: 1.5, marginTop: 6 }}>
            Preview build — sign-in is simulated on this device and nothing is sent anywhere. By continuing you agree this is market information, not investment advice.
          </div>
        </div>
      )}
      {step === "email" && (
        <div style={{ ...col, flex: 1, justifyContent: "center" }}>
          <h1 style={{ fontSize: 27, lineHeight: 1.16, fontWeight: 800, margin: 0 }}>What's your email?</h1>
          <p style={{ color: C.muted, fontSize: 14, lineHeight: 1.55, margin: 0 }}>We'll use it to sign you in — no password to remember.</p>
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" inputMode="email" autoCapitalize="none" autoComplete="email" placeholder="you@example.com"
            onKeyDown={(e) => { if (e.key === "Enter" && emailOk) signIn("email", email.trim()); }}
            style={{ width: "100%", boxSizing: "border-box", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, color: C.text, padding: "14px 14px", fontFamily: MONO, fontSize: 15 }} />
          <button disabled={!emailOk} onClick={() => signIn("email", email.trim())}
            style={big({ background: emailOk ? C.amber : C.panel2, color: emailOk ? "#06090D" : C.dim, border: "none", cursor: emailOk ? "pointer" : "default" })}>Continue</button>
          <button onClick={() => setStep("signup")} style={{ background: "transparent", border: "none", color: C.dim, fontSize: 13, cursor: "pointer", padding: 8 }}>← Other ways to sign in</button>
        </div>
      )}
      {step === "plan" && (
        <div style={{ ...col, paddingBottom: 16 }}>
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 2, color: C.up }}>✓ SIGNED IN · {acctLabel(acct).toUpperCase()}</div>
          <h1 style={{ fontSize: 27, lineHeight: 1.16, fontWeight: 800, margin: 0 }}>Choose your plan</h1>
          <p style={{ color: C.muted, fontSize: 14, lineHeight: 1.55, margin: 0 }}>Free shows you the market. Pro tells you the moment it moves.</p>
          <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr 1.3fr", gap: 8, padding: "10px 14px", borderBottom: `1px solid ${C.border}`, fontFamily: MONO, fontSize: 9, letterSpacing: 1.2, textTransform: "uppercase" }}>
              <span style={{ color: C.dim }}>Feature</span>
              <span style={{ color: C.muted }}>Free</span>
              <span style={{ color: C.amber }}>Pro · {PRO_PRICE}</span>
            </div>
            {PLAN_ROWS.map(([f, a, b]) => (
              <div key={f} style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr 1.3fr", gap: 8, padding: "10px 14px", borderBottom: `1px solid ${C.border}66`, fontSize: 12, lineHeight: 1.4 }}>
                <span style={{ fontWeight: 700 }}>{f}</span>
                <span style={{ color: a === "—" ? C.dim : C.muted }}>{a}</span>
                <span style={{ color: C.text }}>{b}</span>
              </div>
            ))}
          </div>
          <button onClick={() => pick("pro")} style={big({ background: C.amber, color: "#06090D", border: "none", flexDirection: "column", gap: 2 })}>
            <span>Start Pro · {PRO_PRICE}</span>
            <span style={{ fontSize: 11, fontWeight: 600, opacity: 0.8 }}>7-day free trial · cancel any time</span>
          </button>
          <button onClick={() => pick("free")} style={big({ background: "transparent", color: C.text, border: `1px solid ${C.border}` })}>Continue with Free</button>
          <div style={{ fontSize: 11, color: C.dim, lineHeight: 1.5 }}>Preview build — no charge today; billing arrives with the App Store release. Real-time alert pricing is subject to the data plan we finalize with our market-data vendor.</div>
        </div>
      )}
    </div>
  );
}

/* ---------------- about & disclosures (moved off the home screen) ---------------- */
function AboutPage({ onClose }) {
  const S = ({ title, children }) => (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1.5, color: C.amber, textTransform: "uppercase", marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13, lineHeight: 1.6, color: C.muted }}>{children}</div>
    </div>
  );
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 90, background: C.bg, color: C.text, display: "flex", flexDirection: "column", paddingTop: "env(safe-area-inset-top)", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: `1px solid ${C.border}` }}>
        <button onClick={onClose} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.muted, borderRadius: 6, padding: "5px 11px", cursor: "pointer", fontSize: 13 }}>←</button>
        <span style={{ fontSize: 16, fontWeight: 800 }}>How this works</span>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 18px calc(24px + env(safe-area-inset-bottom))", maxWidth: 640, width: "100%", margin: "0 auto", boxSizing: "border-box" }}>
        <S title="Discovery & ranking">
          Every listed non-OTC symbol is swept and ranked by setup score: float rotation (volume ÷ float), price vs VWAP, the EMA 8&gt;21&gt;50 stack, Supertrend(10,3) on 5-minute bars, capped day momentum, and 5-minute volume surge — A ≥80 · B ≥65 · C ≥50 · D below.
        </S>
        <S title="Sessions">
          PREMARKET (4:00–9:30 AM ET): live snapshots against the prior close — the list auto-populates from the 4:00 AM open with gappers ≥{PM_PCT_FLOOR}% on ≥{fv(PM_MIN_VOL)} premarket shares, resetting each new day. REGULAR HOURS: top 15 by score among stocks up ≥25% with real day volume, prices refreshing every 3 seconds. AFTER HOURS (4:00–8:00 PM ET): a separate full-market table — the top 10 by AH % against the 4:00 close, no percentage floor, illiquid names (&lt;{fv(AH_MIN_VOL)} real AH shares) excluded, true cumulative AH volume shown.
        </S>
        <S title="Row indicators">
          📰 marks a catalyst headline from the last 48 hours; a red ⚠dil means recent news carries dilution-risk language (offerings, placements, reverse splits). ×F is live float rotation, with alerts at each 1×/2×/3× milestone. ⛔ shows minutes since a suspected halt.
        </S>
        <S title="Advanced view">
          Tap any row for the full chart, live tape and big prints, confluence tracker, estimated LULD halt bands (Tier-2 percentages off the 5-minute average — an estimate, not the official band feed), and ▶ Replay to scrub back through the session's tape. Halt flags are a tape-silence heuristic, not the official LULD feed.
        </S>
        <S title="Alerts & push">
          The bell on each row arms alerts for just that stock — in-app banners plus lock-screen push (mutes reset each new day). Lock-screen push requires the bell enabled and, on iPhone, the app added to the Home Screen; the server must be awake to monitor — keep it pinged or on a paid instance.
          Lock-screen pushes fire on confluence, not single events: at least three of VWAP, EMA stack, volume, high-of-day and three-green must line up on the same bar (four over the lunch chop), a stock re-pushes only when it escalates or starts a fresh leg, each stock is capped per day and the feed per hour, and overflow rolls into one digest. Every push is journaled with its 5, 15 and 30-minute follow-through; the alert center shows the running hit rate.
        </S>
        <S title="AI trade plans">
          The Advanced view can ask a language model for support and resistance plus three long-only scenarios, built only from numbers the server computes off today's tape. It is generated text: it can be wrong, it does not know news you do, and it is never a recommendation. Nothing is sent until you tap Analyze, and plans are cached for five minutes.
        </S>
        <S title="Data & keys">
          Market data comes from your own Alpaca keys, entered in Settings and stored on this device; the push server keeps a copy solely to monitor your watchlist.
        </S>
        <S title="Not financial advice">
          Nothing in this app is investment advice or a recommendation. Small-cap momentum stocks are extremely volatile; most gappers fade. Scores, bands, and flags are heuristics that can be wrong. Trade at your own risk.
        </S>
      </div>
    </div>
  );
}

/* ---------------- advanced full-screen chart ---------------- */
const TFS = [
  { key: "1Min", label: "1m", ms: 6e4 },
  { key: "5Min", label: "5m", ms: 3e5 },
  { key: "15Min", label: "15m", ms: 9e5 },
  { key: "1Hour", label: "1h", ms: 36e5 },
  { key: "1Day", label: "1D", ms: 864e5 },
];
const WINS = [
  { key: "1D", label: "1D", days: 1 },
  { key: "5D", label: "5D", days: 7 },
  { key: "1M", label: "1M", days: 31 },
  { key: "3M", label: "3M", days: 92 },
  { key: "6M", label: "6M", days: 186 },
  { key: "1Y", label: "1Y", days: 372 },
  { key: "5Y", label: "5Y", days: 1830 },
];
const WIN_TF = { "1D": null, "5D": "15Min", "1M": "1Hour", "3M": "1Hour", "6M": "1Day", "1Y": "1Day", "5Y": "1Day" };
const MAX_BARS = 2000;

/* ---------------- Level 2 ----------------
   Best bid / best ask up top, a depth chart, and a ladder. Alpaca's stock
   feed carries the NBBO top of book, not resting depth, so the ladder's
   first row is the live quote and every row below it is the TRADED depth:
   shares that actually printed at each price in the last 15 minutes. The
   chart stacks the same thing outward from the spread. Labeled as such. */
const fmtInt = (n) => Math.round(n || 0).toLocaleString("en-US");
function tradedDepth(prints, quote) {
  const now = Date.now();
  const bins = new Map();
  for (const t of prints || []) {
    if (now - t.t > 15 * 60000 || !(t.p > 0)) continue;
    const k = Math.round(t.p * 100) / 100;
    bins.set(k, (bins.get(k) || 0) + t.s);
  }
  const bp = quote ? quote.bp : null, ap = quote ? quote.ap : null;
  const mid = bp && ap ? (bp + ap) / 2 : null;
  const bids = [], asks = [];
  for (const [p, sz] of bins) {
    /* rows beyond the NBBO only: prints AT the bid/ask belong to row 1,
       prints inside the spread belong to neither side */
    if (mid == null) continue;
    if (p < bp) bids.push({ p, s: sz });
    else if (p > ap) asks.push({ p, s: sz });
  }
  bids.sort((a, b) => b.p - a.p);
  asks.sort((a, b) => a.p - b.p);
  return { bids, asks, mid };
}
function Level2({ quote, prints }) {
  const ref = useRef(null);
  const depth = useMemo(() => tradedDepth(prints, quote), [prints, quote]);
  const bs = quote ? (quote.bs || 0) * 100 : 0, as = quote ? (quote.as || 0) * 100 : 0;
  const spr = quote ? quote.ap - quote.bp : null;
  const sprPct = spr != null && depth.mid ? (spr / depth.mid) * 100 : null;
  const bidRows = quote ? [{ p: quote.bp, s: bs, live: true }, ...depth.bids.slice(0, 4)] : [];
  const askRows = quote ? [{ p: quote.ap, s: as, live: true }, ...depth.asks.slice(0, 4)] : [];
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !quote) return;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const padB = 18, top = 6;
    /* cumulative from the spread outward; the NBBO size is the first step */
    const cum = (rows, first) => { let a = first; return rows.map((r) => ({ p: r.p, c: (a += r.s) })); };
    const bidC = cum(depth.bids, bs), askC = cum(depth.asks, as);
    const lo = bidC.length ? bidC[bidC.length - 1].p : quote.bp, hi = askC.length ? askC[askC.length - 1].p : quote.ap;
    const half = Math.max(depth.mid - lo, hi - depth.mid, depth.mid * 0.004);
    const x0 = depth.mid - half, x1 = depth.mid + half;
    const X = (p) => ((p - x0) / (x1 - x0)) * W;
    const maxC = Math.max(bs, as, ...bidC.map((r) => r.c), ...askC.map((r) => r.c), 1);
    const Y = (c) => top + (H - padB - top) * (1 - c / maxC);
    const dots = (col) => {
      const pc = document.createElement("canvas"); pc.width = pc.height = 6;
      const g = pc.getContext("2d"); g.fillStyle = col; g.globalAlpha = 0.55; g.beginPath(); g.arc(3, 3, 1.2, 0, Math.PI * 2); g.fill();
      return ctx.createPattern(pc, "repeat");
    };
    const side = (rows, first, startP, dir, col) => {
      /* dir -1 = bids march left, +1 = asks march right */
      const pts = [[X(startP), Y(first)]];
      let c = first, p = startP;
      for (const r of rows) { pts.push([X(r.p), Y(c)]); c += r.s; pts.push([X(r.p), Y(c)]); p = r.p; }
      const edge = dir < 0 ? 0 : W;
      pts.push([edge, Y(c)]);
      ctx.beginPath(); ctx.moveTo(pts[0][0], H - padB);
      for (const [x, y] of pts) ctx.lineTo(x, y);
      ctx.lineTo(edge, H - padB); ctx.closePath();
      ctx.fillStyle = col + "22"; ctx.fill();
      ctx.fillStyle = dots(col); ctx.fill();
      ctx.beginPath(); ctx.moveTo(pts[0][0], H - padB);
      for (const [x, y] of pts) ctx.lineTo(x, y);
      ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.stroke();
    };
    side(depth.bids, bs, quote.bp, -1, C.up);
    side(depth.asks, as, quote.ap, +1, C.down);
    ctx.strokeStyle = C.border; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, H - padB + 0.5); ctx.lineTo(W, H - padB + 0.5); ctx.stroke();
    ctx.font = `10px ${MONO}`; ctx.fillStyle = C.dim; ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left"; ctx.fillText("$" + fp(x0), 4, H - 5);
    ctx.textAlign = "center"; ctx.fillText("$" + fp(depth.mid), W / 2, H - 5);
    ctx.textAlign = "right"; ctx.fillText("$" + fp(x1), W - 4, H - 5);
  }, [quote, depth, bs, as]);
  const Row = ({ b, a, i }) => (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", padding: "6px 12px", fontFamily: MONO, fontSize: 12, background: i === 0 ? C.panel2 : "transparent", borderBottom: `1px solid ${C.border}44` }}>
      <span style={{ color: C.text, textAlign: "left" }}>{b ? fmtInt(b.s) : ""}</span>
      <span style={{ color: C.up, textAlign: "right", paddingRight: 10, borderRight: `1px dotted ${C.border}` }}>{b ? "$" + fp(b.p) : ""}</span>
      <span style={{ color: C.down, textAlign: "left", paddingLeft: 10 }}>{a ? "$" + fp(a.p) : ""}</span>
      <span style={{ color: C.text, textAlign: "right" }}>{a ? fmtInt(a.s) : ""}</span>
    </div>
  );
  const nRows = Math.max(bidRows.length, askRows.length);
  return (
    <div style={{ borderBottom: `1px solid ${C.border}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px 0" }}>
        <span style={{ fontSize: 9, letterSpacing: 1.5, color: C.amber, textTransform: "uppercase", fontFamily: MONO }}>Level 2</span>
        <span style={{ fontSize: 9, color: C.dim, fontFamily: MONO }}>NBBO · traded depth 15m</span>
        <div style={{ flex: 1 }} />
        {sprPct != null && (
          <span style={{ fontFamily: MONO, fontSize: 9, color: sprPct < 0.3 ? C.up : sprPct < 1 ? C.amber : C.down }}>spread ${spr.toFixed(2)} · {sprPct.toFixed(2)}%</span>
        )}
      </div>
      {!quote && <div style={{ padding: "10px 12px 12px", color: C.dim, fontSize: 11 }}>Waiting for a quote…</div>}
      {quote && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", padding: "8px 12px 4px" }}>
            <div>
              <div style={{ fontSize: 10, color: C.dim }}>Best bid</div>
              <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 800, color: C.up, lineHeight: 1.1 }}>${fp(quote.bp)}</div>
              <div style={{ fontFamily: MONO, fontSize: 11, color: C.muted }}>× {fmtInt(bs)}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 10, color: C.dim }}>Best ask</div>
              <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 800, color: C.down, lineHeight: 1.1 }}>${fp(quote.ap)}</div>
              <div style={{ fontFamily: MONO, fontSize: 11, color: C.muted }}>{fmtInt(as)} ×</div>
            </div>
          </div>
          <canvas ref={ref} style={{ display: "block", width: "100%", height: 120 }} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", padding: "8px 12px 4px", fontFamily: MONO, fontSize: 9, letterSpacing: 1, color: C.dim, textTransform: "uppercase", borderTop: `1px solid ${C.border}` }}>
            <span>Size</span><span style={{ textAlign: "right", paddingRight: 10 }}>Bid</span><span style={{ paddingLeft: 10 }}>Ask</span><span style={{ textAlign: "right" }}>Size</span>
          </div>
          {Array.from({ length: nRows }, (_, i) => <Row key={i} i={i} b={bidRows[i]} a={askRows[i]} />)}
          <div style={{ padding: "6px 12px 8px", fontSize: 9, color: C.dim, fontFamily: MONO }}>
            Row 1 = live NBBO · rows below = shares printed at that price, last 15 min
          </div>
        </>
      )}
    </div>
  );
}

/* Chart chrome lives at MODULE scope on purpose. Defined inside the chart's
   render these were new component types on every data tick, so React
   remounted the buttons under the user's finger — a tap that began on the
   old element never produced a click ("tap targets not usable"). */
const IndToggle = ({ on, label, color, onClick }) => (
  <button onClick={onClick}
    style={{ background: on ? color + "22" : "transparent", border: `1px solid ${on ? color : C.border}`, color: on ? color : C.dim, borderRadius: 5, height: 30, padding: "0 7px", fontFamily: MONO, fontSize: 10, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0, touchAction: "manipulation" }}>
    {label}
  </button>
);
const Seg = ({ items, val, set }) => (
  <div style={{ display: "flex", gap: 2, background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 6, padding: 2 }}>
    {items.map((it) => (
      <button key={it.key} onClick={() => set(it.key)}
        style={{ background: val === it.key ? C.amber : "transparent", color: val === it.key ? "#06090D" : C.muted, fontWeight: val === it.key ? 700 : 400, border: "none", borderRadius: 5, minWidth: 26, height: 34, padding: "0 5px", fontFamily: MONO, fontSize: 10, cursor: "pointer", whiteSpace: "nowrap", touchAction: "manipulation" }}>
        {it.label}
      </button>
    ))}
  </div>
);
const CtrlBtn = ({ onClick, children, title }) => (
  <button onClick={onClick} title={title}
    style={{ background: C.panel2, border: `1px solid ${C.border}`, color: C.muted, borderRadius: 6, width: 30, height: 30, cursor: "pointer", fontFamily: MONO, fontSize: 13, display: "grid", placeItems: "center", touchAction: "manipulation" }}>
    {children}
  </button>
);
const StatCell = ({ label, value, color }) => (
  <div style={{ minWidth: 0 }}>
    <div style={{ fontSize: 8, letterSpacing: 0.8, color: C.dim, textTransform: "uppercase" }}>{label}</div>
    <div style={{ fontFamily: MONO, fontSize: 12, color: color || C.text, whiteSpace: "nowrap" }}>{value}</div>
  </div>
);

function AdvancedChart({ symbol, keys, feed, g, pm, news, prefs, plans, onTogglePref, onSetLevels, onClose, onAlert }) {
  const width = useWidth();
  const mobile = width < 720;
  const [tf, setTf] = useState("1Min");
  const [win, setWin] = useState("1D");
  const [bars, setBars] = useState([]);
  const [ticks, setTicks] = useState([]);
  const [live, setLive] = useState(false);
  const [show, setShow] = useState({ vwap: true, e8: true, e21: true, e50: true, pm: true });
  const [crossAbs, setCrossAbs] = useState(null);
  const [view, setView] = useState(null);
  const [err, setErr] = useState("");
  const [quote, setQuote] = useState(null);
  const [bigTicks, setBigTicks] = useState([]);
  const [chartHalt, setChartHalt] = useState(false);
  const [flt, setFlt] = useState(null);
  const chartHaltRef = useRef(false);
  const lastTradeMsRef = useRef(0);
  const tradesSeenRef = useRef(0);
  const tradeTimesRef = useRef([]);
  const canvasRef = useRef(null);
  const wsRef = useRef(null);
  const dragRef = useRef(null);
  const pinchRef = useRef(null);
  const touchRef = useRef(null);
  const barsRef = useRef([]);
  barsRef.current = bars;

  const [replay, setReplay] = useState(null); // {idx, playing} — TAPE REPLAY scrubs the session
  const [alertsOpen, setAlertsOpen] = useState(false); // per-ticker alert sheet (bell in the header)
  const printsRef = useRef([]);                        // last ~15 min of prints — feeds the Level 2 traded depth
  /* AI trade plan: levels + three long-only scenarios, built server-side from the tape */
  const [plan, setPlan] = useState(null);
  const [planT, setPlanT] = useState(0);
  const [planPx, setPlanPx] = useState(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [planErr, setPlanErr] = useState("");
  const [planLines, setPlanLines] = useState(true);
  const [planTick, setPlanTick] = useState(0);
  useEffect(() => { setPlan(null); setPlanT(0); setPlanPx(null); setPlanErr(""); }, [symbol]);
  useEffect(() => { if (!plan) return; const id = setInterval(() => setPlanTick((x) => x + 1), 30000); return () => clearInterval(id); }, [plan]);
  const [lvIn, setLvIn] = useState(""); // price-level alert input

  const tfObj = TFS.find((t) => t.key === tf);
  const daily = tf === "1Day";
  /* replay mode renders only the tape up to the scrub point */
  const rBars = useMemo(
    () => (replay ? bars.slice(0, Math.max(2, Math.min(replay.idx, bars.length))) : bars),
    [bars, replay]
  );
  const len = rBars.length;
  const defC = Math.max(1, len);
  const vc = view ? Math.max(15, Math.min(view.c, len || 1)) : defC;
  const vo = view ? Math.max(0, Math.min(view.o, Math.max(0, len - vc))) : Math.max(0, len - vc);
  const visBars = useMemo(() => rBars.slice(vo, vo + vc), [rBars, vo, vc]);

  /* replay autoplay: one bar per 200ms until the scrub reaches the live edge */
  useEffect(() => {
    if (!replay || !replay.playing) return;
    const id = setInterval(() => {
      setReplay((r) => {
        if (!r) return r;
        const max = barsRef.current.length;
        return r.idx >= max ? { ...r, playing: false } : { ...r, idx: r.idx + 1 };
      });
    }, 200);
    return () => clearInterval(id);
  }, [replay && replay.playing]);

  /* LULD band ESTIMATE (Tier-2 assumption): reference = 5-min average price;
     band 10% ≥$3 · 20% $0.75–3 · 75% below — where the next halt would arm */
  const luld = useMemo(() => {
    if (tf !== "1Min" || bars.length < 5) return null;
    const last5 = bars.slice(-5);
    const ref = last5.reduce((a, b) => a + b.c, 0) / last5.length;
    const p = last5[last5.length - 1].c;
    const band = p >= 3 ? 10 : p >= 0.75 ? 20 : 75;
    return { up: ref * (1 + band / 100), dn: Math.max(0.01, ref * (1 - band / 100)), band };
  }, [bars, tf]);

  /* bars */
  useEffect(() => {
    let dead = false;
    setBars([]); setErr(""); setView(null); setCrossAbs(null);
    const load = async (initial) => {
      try {
        const w = WINS.find((x) => x.key === win);
        const start = win === "1D" && !daily ? todayETStartISO(SESSION_START_ET) : daysAgoISO(w.days);
        const j = await alpaca("/v2/stocks/bars", barParams(feed, {
          symbols: symbol, timeframe: tf, start, limit: 10000, adjustment: "split",
        }), keys);
        if (dead) return;
        let bs = ((j.bars && j.bars[symbol]) || []).map(normBar);
        if (bs.length > MAX_BARS) bs = bs.slice(-MAX_BARS);
        setBars((prev) => (initial || bs.length >= prev.length ? bs : prev));
      } catch (e) { if (!dead && initial) setErr(String(e.message || e)); }
    };
    load(true);
    const id = feedMode(feed).delayMs ? setInterval(() => load(false), 30000) : null;
    return () => { dead = true; if (id) clearInterval(id); };
  }, [symbol, tf, win, feed]);

  /* float (server-side lookup, cached) */
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const r = await fetch(`/float/${symbol}`);
        const j = await r.json();
        if (!dead) setFlt(j.float || null);
      } catch (e) { if (!dead) setFlt(null); }
    })();
    return () => { dead = true; };
  }, [symbol]);

  /* live ticks + quotes, polling fallback, tape-stall halt */
  useEffect(() => {
    let poll = null, dead = false;
    tradesSeenRef.current = 0; lastTradeMsRef.current = 0; tradeTimesRef.current = [];
    chartHaltRef.current = false; setChartHalt(false); setQuote(null); setBigTicks([]); printsRef.current = [];
    const haltId = setInterval(() => {
      const lastT = lastTradeMsRef.current;
      const preRate = tradeTimesRef.current.filter((t) => t >= lastT - 30000 && t <= lastT).length;
      if (preRate >= 12 && lastT && Date.now() - lastT > 25000 && !chartHaltRef.current) {
        chartHaltRef.current = true; setChartHalt(true);
        if (onAlert) onAlert(`⛔ ${symbol} tape stalled`, "No prints for 20s+ on a live tape — possible LULD halt");
      }
    }, 5000);
    const applyTrade = (p, s, t) => {
      lastTradeMsRef.current = Date.now();
      tradesSeenRef.current += 1;
      tradeTimesRef.current = [...tradeTimesRef.current.slice(-40), Date.now()];
      if (chartHaltRef.current) {
        chartHaltRef.current = false; setChartHalt(false);
        if (onAlert) onAlert(`▶ ${symbol} prints resumed`, "Tape is moving again after the stall");
      }
      setTicks((prev) => [{ p, s, t }, ...prev].slice(0, 40));
      printsRef.current = [{ p, s, t }, ...printsRef.current].slice(0, 800);
      if (s >= BIG_PRINT) setBigTicks((prev) => [{ p, s, t }, ...prev].slice(0, 80));
      if (feedMode(feed).delayMs) return;
      setBars((prev) => {
        if (prev.length === 0 || daily) return prev;
        const ms = tfObj.ms;
        const bucket = Math.floor(t / ms) * ms;
        const last = prev[prev.length - 1];
        if (bucket <= last.t) {
          const nb = { ...last, c: p, h: Math.max(last.h, p), l: Math.min(last.l, p), v: last.v + s };
          return [...prev.slice(0, -1), nb];
        }
        return [...prev, { t: bucket, o: p, h: p, l: p, c: p, v: s }];
      });
    };
    const startPolling = () => {
      poll = setInterval(async () => {
        try {
          const j = await alpaca(`/v2/stocks/${symbol}/trades/latest`, { feed: feedMode(feed).stream }, keys);
          if (j.trade) applyTrade(j.trade.p, j.trade.s, new Date(j.trade.t).getTime());
          const qj = await alpaca(`/v2/stocks/${symbol}/quotes/latest`, { feed: feedMode(feed).stream }, keys);
          if (qj.quote) setQuote({ bp: qj.quote.bp, bs: qj.quote.bs, ap: qj.quote.ap, as: qj.quote.as, t: new Date(qj.quote.t).getTime() });
        } catch (e) {}
      }, 2000);
    };
    try {
      const ws = new WebSocket(`wss://stream.data.alpaca.markets/v2/${feedMode(feed).stream}`);
      wsRef.current = ws;
      ws.onopen = () => ws.send(JSON.stringify({ action: "auth", key: keys.id.trim(), secret: keys.secret.trim() }));
      ws.onmessage = (ev) => {
        let msgs; try { msgs = JSON.parse(ev.data); } catch { return; }
        for (const m of msgs) {
          if (m.T === "success" && m.msg === "authenticated") {
            ws.send(JSON.stringify({ action: "subscribe", trades: [symbol], quotes: [symbol] }));
            setLive(true);
          }
          if (m.T === "error") { try { ws.close(); } catch {} }
          if (m.T === "t" && m.S === symbol) applyTrade(m.p, m.s, new Date(m.t).getTime());
          if (m.T === "q" && m.S === symbol) setQuote({ bp: m.bp, bs: m.bs, ap: m.ap, as: m.as, t: new Date(m.t).getTime() });
        }
      };
      ws.onerror = () => { setLive(false); if (!poll && !dead) startPolling(); };
      ws.onclose = () => { setLive(false); if (!poll && !dead) startPolling(); };
    } catch { startPolling(); }
    return () => {
      dead = true;
      clearInterval(haltId);
      if (poll) clearInterval(poll);
      try { wsRef.current && wsRef.current.close(); } catch {}
    };
  }, [symbol, feed, tf]);

  /* indicators + intraday stats */
  const calc = useMemo(() => {
    if (bars.length === 0) return null;
    const closes = bars.map((b) => b.c);
    const e8 = emaSeries(closes, 8), e21 = emaSeries(closes, 21), e50 = emaSeries(closes, 50);
    const vw = vwapSeries(bars);
    const lines = [];
    if (show.vwap && !daily) lines.push({ name: "VWAP", vals: vw, color: C.vwap, width: 1.6 });
    if (show.e8) lines.push({ name: "EMA 8", vals: e8, color: C.ema8, width: 1.3 });
    if (show.e21) lines.push({ name: "EMA 21", vals: e21, color: C.ema21, width: 1.3 });
    if (show.e50) lines.push({ name: "EMA 50", vals: e50, color: C.ema50, width: 1.3 });
    let hi = -Infinity, lo = Infinity, vol = 0, pmH = null, pmL = null;
    const today = etDay(Date.now());
    for (const b of bars) {
      if (etDay(b.t) !== today) continue;
      hi = Math.max(hi, b.h); lo = Math.min(lo, b.l); vol += b.v;
      if (!daily && etMinutes(b.t) < OPEN_ET_MIN) {
        pmH = pmH == null ? b.h : Math.max(pmH, b.h);
        pmL = pmL == null ? b.l : Math.min(pmL, b.l);
      }
    }
    return {
      lines,
      vwapNow: vw[vw.length - 1], e8Now: e8[e8.length - 1], e21Now: e21[e21.length - 1], e50Now: e50[e50.length - 1],
      dayHi: hi === -Infinity ? null : hi, dayLo: lo === Infinity ? null : lo, dayVol: vol || (g && g.dayVol),
      pmH: pmH != null ? pmH : pm && pm.h, pmL: pmL != null ? pmL : pm && pm.l,
    };
  }, [bars, show, daily, g, pm]);

  const visLines = calc ? calc.lines.map((l) => ({ ...l, vals: l.vals.slice(vo, vo + vc) })) : [];
  const pmLines = [
    ...(show.pm && calc && !daily ? [{ price: calc.pmH, kind: "pmh" }, { price: calc.pmL, kind: "pml" }] : []),
    ...(plan && planLines ? plan.levels.map((l) => ({ price: l.price, kind: l.kind === "support" ? "sup" : "res", label: l.label })) : []),
  ];
  const crossRel = crossAbs != null && crossAbs >= vo && crossAbs < vo + vc ? { i: crossAbs - vo } : null;
  const conf = useMemo(() => confluence(bars), [bars]);

  useEffect(() => {
    drawChart(canvasRef.current, visBars, { lines: visLines, pmLines, axes: true, volume: true, daily, cross: crossRel });
  });
  useEffect(() => {
    const onR = () => drawChart(canvasRef.current, barsRef.current.slice(vo, vo + vc), { lines: visLines, pmLines, axes: true, volume: true, daily });
    window.addEventListener("resize", onR);
    return () => window.removeEventListener("resize", onR);
  });

  /* pointer: pan / zoom / crosshair */
  const relIndex = (clientX) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const step = (rect.width - 66) / Math.max(1, visBars.length);
    return Math.max(0, Math.min(visBars.length - 1, Math.floor((clientX - rect.left - 4) / step)));
  };
  const stepPx = () => {
    const rect = canvasRef.current.getBoundingClientRect();
    return (rect.width - 66) / Math.max(1, vc);
  };
  const pan = (fromO, dxPx) => {
    const dBars = Math.round(dxPx / stepPx());
    setView({ o: Math.max(0, Math.min(fromO + dBars, Math.max(0, len - vc))), c: vc });
  };
  const zoom = (factor, frac) => {
    const newC = Math.max(15, Math.min(Math.round(vc * factor), Math.max(15, len)));
    const anchor = vo + frac * vc;
    const newO = Math.max(0, Math.min(Math.round(anchor - frac * newC), Math.max(0, len - newC)));
    setView({ o: newO, c: newC });
  };
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - rect.left - 4) / (rect.width - 66)));
      zoom(e.deltaY > 0 ? 1.18 : 0.85, frac);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });
  const onMouseDown = (e) => { dragRef.current = { x: e.clientX, o: vo, moved: false }; };
  const onMouseMove = (e) => {
    if (dragRef.current) {
      const dx = dragRef.current.x - e.clientX;
      if (Math.abs(dx) > 3) dragRef.current.moved = true;
      if (dragRef.current.moved) { setCrossAbs(null); pan(dragRef.current.o, dx); }
    } else setCrossAbs(vo + relIndex(e.clientX));
  };
  const onMouseUp = () => { dragRef.current = null; };
  const onMouseLeave = () => { dragRef.current = null; setCrossAbs(null); };
  /* left-edge swipe → back to the watchlist */
  const edgeRef = useRef(null);
  const onEdgeStart = (e) => {
    const t = e.touches && e.touches[0];
    if (t && t.clientX <= 28) edgeRef.current = { x: t.clientX, y: t.clientY };
  };
  const onEdgeMove = (e) => {
    const a = edgeRef.current;
    const t = e.touches && e.touches[0];
    if (!a || !t) return;
    if (Math.abs(t.clientY - a.y) > 60) { edgeRef.current = null; return; }
    if (t.clientX - a.x > 70) { edgeRef.current = null; onClose(); }
  };
  const onEdgeEnd = () => { edgeRef.current = null; };
  const dist2 = (ts) => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
  const holdTimerRef = useRef(null);
  const fitAll = () => {
    setView(null); setCrossAbs(null);
    pinchRef.current = null; touchRef.current = null;
    if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
  };
  const onTouchStart = (e) => {
    if (e.touches.length === 2) {
      const rect = canvasRef.current.getBoundingClientRect();
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      pinchRef.current = { d: dist2(e.touches), c: vc, o: vo, frac: Math.max(0, Math.min(1, (cx - rect.left - 4) / (rect.width - 66))) };
      touchRef.current = null;
      if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
    } else if (e.touches.length === 1) {
      const x0 = e.touches[0].clientX;
      touchRef.current = { x: x0, lastX: x0, o: vo, t: Date.now(), mode: null };
      /* press & hold (250ms) enters SCRUB: finger drives the crosshair and
         the header tracks the candle under it until the finger lifts */
      holdTimerRef.current = setTimeout(() => {
        const tr = touchRef.current;
        if (tr && tr.mode === null) {
          tr.mode = "scrub";
          setCrossAbs(vo + relIndex(tr.lastX));
        }
      }, 250);
    }
  };
  const onTouchMove = (e) => {
    if (pinchRef.current && e.touches.length === 2) {
      const pr = pinchRef.current;
      const f = pr.d / Math.max(1, dist2(e.touches));
      const newC = Math.max(15, Math.min(Math.round(pr.c * f), Math.max(15, len)));
      const anchor = pr.o + pr.frac * pr.c;
      const newO = Math.max(0, Math.min(Math.round(anchor - pr.frac * newC), Math.max(0, len - newC)));
      setView({ o: newO, c: newC });
    } else if (touchRef.current && e.touches.length === 1) {
      const tr = touchRef.current;
      const x = e.touches[0].clientX;
      tr.lastX = x;
      if (tr.mode === null && Math.abs(x - tr.x) > 10) {
        tr.mode = "pan"; /* a quick swipe before the hold fires = pan */
        if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
      }
      if (tr.mode === "pan") { setCrossAbs(null); pan(tr.o, tr.x - x); }
      else if (tr.mode === "scrub") setCrossAbs(vo + relIndex(x));
    }
  };
  const onTouchEnd = (e) => {
    if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
    if (e.touches.length < 2) pinchRef.current = null;
    if (e.touches.length === 0) {
      touchRef.current = null;
      setCrossAbs(null); /* fingers up = the minute-detail readout goes away */
    }
  };

  /* separate after-hours % (vs today's 4:00 PM close) once the AH session is live */
  const ahPct = useMemo(() => {
    if (tf !== "1Min" || bars.length < 2) return null;
    const nowMin = etMinutes(Date.now());
    if (nowMin < 960 || nowMin >= 1200) return null;
    let regClose = null;
    for (const b of bars) if (etMinutes(b.t) < 960) regClose = b.c;
    const lastB = bars[bars.length - 1];
    if (regClose == null || etMinutes(lastB.t) < 960) return null;
    return ((lastB.c - regClose) / regClose) * 100;
  }, [bars, tf]);

  /* the browser must never treat a chart drag as a text/image selection —
     non-passive preventDefault kills the iOS long-press copy callout and
     the gesture arbitration lag */
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const prevent = (e) => e.preventDefault();
    cv.addEventListener("touchstart", prevent, { passive: false });
    cv.addEventListener("touchmove", prevent, { passive: false });
    cv.addEventListener("contextmenu", prevent);
    return () => {
      cv.removeEventListener("touchstart", prevent);
      cv.removeEventListener("touchmove", prevent);
      cv.removeEventListener("contextmenu", prevent);
    };
  }, []);

  const last = bars[len - 1];
  const price = last ? last.c : null;
  const inspBar = crossAbs != null && bars[crossAbs] ? bars[crossAbs] : null;
  const dispPrice = inspBar ? inspBar.c : price;
  const prevClose = g && g.pct != null && g.price ? g.price / (1 + g.pct / 100) : null;
  const dispPct = inspBar
    ? (prevClose ? ((inspBar.c - prevClose) / prevClose) * 100
       : bars[0] ? ((inspBar.c - bars[0].o) / bars[0].o) * 100 : null)
    : g ? g.pct : null;
  const following = view === null;
  const hasCustom = !!(prefs && ((prefs.off && prefs.off.length) || (prefs.lv && prefs.lv.length)));
  const spr = quote ? quote.ap - quote.bp : null;
  const mid = quote ? (quote.ap + quote.bp) / 2 : null;
  const sprPct = spr != null && mid ? (spr / mid) * 100 : null;

  const Toggle = ({ k, label, color }) => <IndToggle on={!!show[k]} label={label} color={color} onClick={() => setShow((s) => ({ ...s, [k]: !s[k] }))} />;

  /* one-tap chart snapshot: the chart canvas + the minute's price and every
     level, composed into a single PNG — built for "screenshot → ask my AI" */
  const buildShot = () => {
    /* SYNCHRONOUS on purpose: toDataURL instead of toBlob, so the share sheet /
       clipboard call still sits inside the tap's user activation on iOS —
       an await before navigator.share() is exactly what made it silently no-op */
    const src = canvasRef.current;
    if (!src || !src.width) return null;
    const scale = src.width / Math.max(1, src.clientWidth);
    const lineH = Math.round(17 * scale), pad = Math.round(12 * scale);
    const rows = [
      `${symbol}  $${fp(dispPrice)}  ${fpct(dispPct)}${ahPct != null ? "  AH " + fpct(ahPct) : ""}  ${inspBar ? (daily ? fdate(inspBar.t) : ftime(inspBar.t) + " ET") : "live"}`,
      calc ? `VWAP ${fp(calc.vwapNow)}   EMA8 ${fp(calc.e8Now)}   EMA21 ${fp(calc.e21Now)}   EMA50 ${fp(calc.e50Now)}` : "",
      calc ? `DayH ${fp(calc.dayHi)}   DayL ${fp(calc.dayLo)}   Vol ${fv(calc.dayVol)}   Float ${flt ? fv(flt) : "—"}` : "",
      `PMH ${calc && calc.pmH != null ? fp(calc.pmH) : "—"}   PML ${calc && calc.pmL != null ? fp(calc.pmL) : "—"}   LULD↑ ${luld ? fp(luld.up) : "—"}   LULD↓ ${luld ? fp(luld.dn) : "—"}`,
    ].filter(Boolean);
    const out = document.createElement("canvas");
    out.width = src.width;
    out.height = src.height + rows.length * lineH + pad * 2;
    const ctx = out.getContext("2d");
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, 0, 0);
    ctx.fillStyle = C.text;
    ctx.font = `${Math.round(12 * scale)}px ui-monospace, Menlo, monospace`;
    rows.forEach((r, i) => ctx.fillText(r, pad, src.height + pad + (i + 0.8) * lineH));
    const b64 = out.toDataURL("image/png").split(",")[1];
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: "image/png" });
  };
  /* bottom toast — every snapshot action reports success or failure right here,
     because the home-screen alert banner is hidden under this full-screen view */
  const [toast, setToast] = useState(null); // {msg, ok}
  const toastRef = useRef(null);
  const say = (msg, ok) => {
    setToast({ msg, ok: ok !== false });
    if (toastRef.current) clearTimeout(toastRef.current);
    toastRef.current = setTimeout(() => setToast(null), 2600);
  };
  useEffect(() => () => { if (toastRef.current) clearTimeout(toastRef.current); }, []);
  const analyze = async (fresh) => {
    if (planBusy) return;
    setPlanBusy(true); setPlanErr("");
    try {
      const r = await fetch("/plan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "APCA-API-KEY-ID": (keys.id || "").trim(), "APCA-API-SECRET-KEY": (keys.secret || "").trim(),
          ...(DEVICE.id ? { "X-Device": DEVICE.id } : {}),
        },
        body: JSON.stringify({ symbol, feed: feedMode(feed).delayMs ? "iex" : feed, fresh: !!fresh, news: news ? news.headline : null, float: flt || null, grade: g && g.grade, score: g && g.score }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.plan) throw new Error(j.error || `${r.status} ${r.statusText}`);
      setPlan(j.plan); setPlanT(j.t || Date.now()); setPlanPx(price);
      if (j.cached && fresh) say("Plan is under a minute old — showing it", true);
    } catch (e) { setPlanErr(String(e.message || e)); }
    setPlanBusy(false);
  };
  const planText = () => {
    if (!plan) return "";
    const L = (v) => "$" + fp(v);
    const lines = [`${symbol} trade plan — ${plan.bias.toUpperCase()} · ${ftime(planT)} ET at ${L(planPx)}`, plan.summary, ""];
    lines.push("Levels:");
    for (const l of [...plan.levels].reverse()) lines.push(`  ${l.kind === "support" ? "S" : "R"} ${L(l.price)} · ${l.label} (${l.strength}/3)`);
    if (plan.must_hold != null) lines.push(`Must hold ${L(plan.must_hold)} · must fail ${plan.must_fail != null ? L(plan.must_fail) : "—"}`);
    for (const sc of plan.scenarios) {
      lines.push("", `${sc.name} (${sc.stance}): ${sc.trigger}`);
      if (sc.stance === "long") lines.push(`  entry ${sc.entry_lo != null ? L(sc.entry_lo) + "–" + L(sc.entry_hi) : "—"} · stop ${sc.stop != null ? L(sc.stop) : "—"} · targets ${sc.targets.map(L).join(" → ") || "—"}`);
      if (sc.invalidation) lines.push(`  invalid if: ${sc.invalidation}`);
      if (sc.note) lines.push(`  ${sc.note}`);
    }
    lines.push("", plan.risk_notes, "AI-generated · not financial advice");
    return lines.join("\n");
  };
  const copyPlan = async () => {
    try { await navigator.clipboard.writeText(planText()); say("Plan copied"); }
    catch (e) { say("Couldn't copy the plan", false); }
  };
  const saveShot = async () => {
    let blob = null;
    try { blob = buildShot(); } catch (e) {}
    if (!blob) { say("Nothing to save yet — chart is still loading", false); return; }
    const file = new File([blob], `${symbol}-chart.png`, { type: "image/png" });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: `${symbol} chart` }); say("Saved — snapshot shared"); return; }
      catch (e) { if (e && e.name === "AbortError") { say("Save cancelled", false); return; } }
    }
    try {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      say("Saved — check your downloads");
    } catch (e) { say("Couldn't save the snapshot", false); }
  };
  const copyShot = async () => {
    let blob = null;
    try { blob = buildShot(); } catch (e) {}
    if (!blob) { say("Nothing to copy yet — chart is still loading", false); return; }
    try {
      if (!navigator.clipboard || typeof ClipboardItem === "undefined") throw new Error("no image clipboard");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      say("Copied — paste the snapshot into your AI");
      return;
    } catch (e) {}
    /* no image clipboard here (older iOS / some webviews): the share sheet
       offers Copy as one of its actions */
    const file = new File([blob], `${symbol}-chart.png`, { type: "image/png" });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: `${symbol} chart` }); say("Shared — pick Copy or a target"); return; }
      catch (e) { if (e && e.name === "AbortError") { say("Copy cancelled", false); return; } }
    }
    say("Copy isn't supported in this browser — use Save", false);
  };

  const sidebar = (
    <>
      <Level2 quote={quote} prints={printsRef.current} />
      <div style={{ padding: "8px 12px", fontSize: 10, letterSpacing: 1, color: C.dim, textTransform: "uppercase", borderBottom: `1px solid ${C.border}`, display: "flex", gap: 8 }}>
        <span>Time & sales</span>
        <span style={{ color: C.amber, textTransform: "none" }}>■ {fv(BIG_PRINT)}+ prints</span>
      </div>
      <div style={{ flex: mobile ? "0 0 auto" : 1, maxHeight: mobile ? 180 : undefined, overflowY: "auto", padding: "4px 0" }}>
        {ticks.length === 0 && <div style={{ color: C.dim, fontSize: 11, padding: 12 }}>Waiting for trades…</div>}
        {ticks.map((t, i) => {
          const prev = ticks[i + 1];
          const col = !prev || t.p === prev.p ? C.muted : t.p > prev.p ? C.up : C.down;
          const big = t.s >= BIG_PRINT;
          return (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "2px 12px", fontFamily: MONO, fontSize: 11, background: big ? C.amber + "1A" : "transparent", borderLeft: big ? `2px solid ${C.amber}` : "2px solid transparent", fontWeight: big ? 700 : 400 }}>
              <span style={{ color: big ? C.amber : C.dim }}>{ftime(t.t)}</span>
              <span style={{ color: col }}>{fp(t.p)}</span>
              <span style={{ color: big ? C.amber : C.dim }}>{fv(t.s)}</span>
            </div>
          );
        })}
      </div>
      <div style={{ borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`, padding: "7px 12px", fontSize: 10, letterSpacing: 1, textTransform: "uppercase", display: "flex", gap: 8, alignItems: "baseline" }}>
        <span style={{ color: C.amber }}>■ Big prints</span>
        <span style={{ color: C.dim, textTransform: "none" }}>{fv(BIG_PRINT)}+ shares · {bigTicks.length} this session</span>
      </div>
      <div style={{ flex: "0 0 auto", maxHeight: mobile ? 170 : 200, overflowY: "auto", padding: "4px 0" }}>
        {bigTicks.length === 0 && <div style={{ color: C.dim, fontSize: 11, padding: "8px 12px" }}>No {fv(BIG_PRINT)}+ share prints yet.</div>}
        {bigTicks.map((t, i) => {
          const prev = bigTicks[i + 1];
          const col = !prev || t.p === prev.p ? C.amber : t.p > prev.p ? C.up : C.down;
          return (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "3px 12px", fontFamily: MONO, fontSize: 11, background: C.amber + "0D", borderLeft: `2px solid ${C.amber}` }}>
              <span style={{ color: C.dim }}>{ftime(t.t)}</span>
              <span style={{ color: col, fontWeight: 700 }}>{fp(t.p)}</span>
              <span style={{ color: C.amber, fontWeight: 700 }}>{fv(t.s)}</span>
              <span style={{ color: C.muted }}>${fv(t.p * t.s)}</span>
            </div>
          );
        })}
      </div>
    </>
  );

  return (
    <div
      onTouchStart={onEdgeStart} onTouchMove={onEdgeMove} onTouchEnd={onEdgeEnd}
      style={{ position: "fixed", inset: 0, background: C.bg, zIndex: 50, display: "flex", flexDirection: "column", paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}>
      {/* 1 · price line — sized so ticker + price + % + AH always fit a 390px phone, nothing spills */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-start", flexWrap: "nowrap", overflow: "hidden", gap: 5, padding: "12px 16px", borderBottom: `1px solid ${C.border}` }}>
        <button onClick={onClose} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.muted, borderRadius: 7, padding: "5px 9px", cursor: "pointer", fontSize: 15, lineHeight: 1.2, flexShrink: 0 }}>←</button>
        {g && g.grade && (
          <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 800, color: gradeColor(g.grade), background: gradeColor(g.grade) + "1A", border: `1px solid ${gradeColor(g.grade)}55`, borderRadius: 5, padding: "2px 5px", whiteSpace: "nowrap", flexShrink: 0 }}>{g.grade} {g.score}</span>
        )}
        <span style={{ fontSize: 17, fontWeight: 800, letterSpacing: 0, whiteSpace: "nowrap", flexShrink: 0 }}>{symbol}</span>
        <span style={{ fontFamily: MONO, fontSize: 15, color: inspBar ? C.amber : C.text, whiteSpace: "nowrap", flexShrink: 0 }}>{fp(dispPrice)}</span>
        <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 700, color: (dispPct || 0) >= 0 ? C.up : C.down, whiteSpace: "nowrap", flexShrink: 0 }}>{fpct(dispPct)}</span>
        {inspBar ? (
          <span style={{ fontFamily: MONO, fontSize: 11, color: C.dim, whiteSpace: "nowrap", flexShrink: 0 }}>{daily ? fdate(inspBar.t) : ftime(inspBar.t) + " ET"}</span>
        ) : ahPct != null ? (
          <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: C.ema21, whiteSpace: "nowrap", flexShrink: 0 }}>AH {(ahPct >= 0 ? "+" : "") + ahPct.toFixed(1)}%</span>
        ) : null}
        {onTogglePref && (
          <button onClick={() => setAlertsOpen(true)} aria-label={`alerts for ${symbol}`} title="alert rules for this stock"
            style={{ marginLeft: "auto", background: "transparent", border: "none", color: hasCustom ? C.amber : C.muted, cursor: "pointer", padding: "4px 0 4px 3px", display: "flex", alignItems: "center", flexShrink: 0 }}>
            <BellIcon size={19} />
          </button>
        )}
      </div>
      {/* 2 · catalyst — headline group hugs the left edge, snapshot group the right */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "12px 16px", borderBottom: `1px solid ${C.border}`, fontSize: 12, color: C.muted, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "1 1 auto", minWidth: 0 }}>
          <span style={{ color: news && news.dilution ? C.down : C.dim, flexShrink: 0, display: "flex" }}><NewsIcon size={16} /></span>
          {news && news.dilution && (
            <span style={{ color: C.down, fontFamily: MONO, fontSize: 9, fontWeight: 800, border: `1px solid ${C.down}66`, borderRadius: 4, padding: "2px 6px", flexShrink: 0 }}>DILUTION RISK</span>
          )}
          {news ? (
            <a href={news.url || undefined} target="_blank" rel="noopener noreferrer"
               style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: C.text, textDecoration: news.url ? "underline" : "none", textUnderlineOffset: 3, minWidth: 0, flexShrink: 1 }}>
              {news.headline}
            </a>
          ) : (
            <span style={{ color: C.dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>No recent headline for {symbol}.</span>
          )}
          {news && (
            <span style={{ color: C.dim, fontFamily: MONO, fontSize: 9, flexShrink: 0 }}>{Math.max(1, Math.round((Date.now() - news.at) / 3600000))}h</span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <button onClick={copyShot} aria-label="copy chart snapshot" title="copy a snapshot of the chart + levels to the clipboard"
            style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.muted, borderRadius: 6, height: 32, padding: "0 10px", fontFamily: MONO, fontSize: 10, cursor: "pointer", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 5, touchAction: "manipulation" }}>
            <CopyIcon /> Copy
          </button>
          <button onClick={saveShot} aria-label="save chart snapshot" title="save a snapshot of the chart + levels as a photo"
            style={{ background: C.amber + "1A", border: `1px solid ${C.amber}66`, color: C.amber, borderRadius: 6, height: 32, padding: "0 10px", fontFamily: MONO, fontSize: 10, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 5, touchAction: "manipulation" }}>
            <SaveIcon /> Save
          </button>
        </div>
      </div>
      {/* 3 · bar size left, look-back window right */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "12px 16px", borderBottom: `1px solid ${C.border}` }}>
        <Seg items={TFS} val={tf} set={setTf} />
        <Seg items={WINS} val={win} set={(k) => { setWin(k); const s = WIN_TF[k]; if (s) setTf(s); }} />
      </div>
      {/* 4 · indicator toggles left, view controls (zoom / fit / replay) right */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "12px 16px", borderBottom: `1px solid ${C.border}` }}>
        <div className="noscrollbar" style={{ display: "flex", alignItems: "center", gap: 4, flex: "1 1 auto", minWidth: 0, overflowX: "auto" }}>
          <Toggle k="vwap" label="VWAP" color={C.vwap} />
          <Toggle k="e8" label="EMA 8" color={C.ema8} />
          <Toggle k="e21" label="EMA 21" color={C.ema21} />
          <Toggle k="e50" label="EMA 50" color={C.ema50} />
          <Toggle k="pm" label="PM H/L" color={C.amber} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
          <CtrlBtn onClick={() => zoom(1.3, 0.5)} title="zoom out">−</CtrlBtn>
          <CtrlBtn onClick={() => zoom(0.75, 0.5)} title="zoom in">+</CtrlBtn>
          <button
            onClick={fitAll} aria-label="fit all" title="fit all"
            onTouchEnd={(e) => { e.preventDefault(); fitAll(); }}
            style={{ background: following ? C.panel2 : C.amber + "22", border: `1px solid ${following ? C.border : C.amber}`, color: following ? C.muted : C.amber, borderRadius: 6, width: 30, height: 30, fontFamily: MONO, fontSize: 14, cursor: "pointer", flexShrink: 0, display: "grid", placeItems: "center", touchAction: "manipulation" }}>
            ⟲
          </button>
          <button
            onClick={() => setReplay((r) => (r ? null : { idx: Math.max(2, Math.floor(barsRef.current.length / 4)), playing: false }))}
            aria-label="replay" title={replay ? "stop tape replay" : "tape replay"}
            style={{ background: replay ? C.amber + "22" : C.panel2, border: `1px solid ${replay ? C.amber : C.border}`, color: replay ? C.amber : C.muted, borderRadius: 6, width: 30, height: 30, fontFamily: MONO, fontSize: 12, cursor: "pointer", flexShrink: 0, display: "grid", placeItems: "center", touchAction: "manipulation" }}>
            {replay ? "■" : "▶"}
          </button>
        </div>
      </div>
      {err && <div style={{ padding: "6px 16px", borderBottom: `1px solid ${C.border}`, color: C.down, fontSize: 11, fontFamily: MONO }}>{err}</div>}
      {replay && (
        /* TAPE REPLAY: scrub the session bar by bar, or press play */
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 16px", borderBottom: `1px solid ${C.border}`, background: C.amber + "0D" }}>
          <button
            onClick={() => setReplay((r) => r && { ...r, playing: !r.playing })}
            style={{ background: "transparent", border: `1px solid ${C.amber}`, color: C.amber, borderRadius: 6, padding: "3px 10px", fontFamily: MONO, fontSize: 11, cursor: "pointer", flexShrink: 0 }}>
            {replay.playing ? "❚❚" : "▶"}
          </button>
          <input
            type="range" min={2} max={Math.max(2, bars.length)} value={Math.min(replay.idx, bars.length)}
            onChange={(e) => setReplay((r) => r && { ...r, idx: Number(e.target.value), playing: false })}
            style={{ flex: 1, accentColor: C.amber }}
          />
          <span style={{ fontFamily: MONO, fontSize: 10, color: C.amber, whiteSpace: "nowrap" }}>
            {rBars.length ? `${ftime(rBars[rBars.length - 1].t)} ET` : ""} · {Math.min(replay.idx, bars.length)}/{bars.length}
          </span>
        </div>
      )}
      <div style={{ flex: 1, display: "flex", flexDirection: mobile ? "column" : "row", minHeight: 0, overflowY: mobile ? "auto" : "hidden" }}>
        <div style={{ flex: mobile ? "0 0 auto" : 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0, overflowY: mobile ? "visible" : "auto" }}>
          <div className="chartbox" style={{ position: "relative", flex: mobile ? "0 0 auto" : "0 0 52%", height: mobile ? "34vh" : "auto", minHeight: mobile ? 220 : 300, touchAction: "none" }}>
            {chartHalt && (
              <div style={{ position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)", zIndex: 5, background: "#2A0F14", border: `1px solid ${C.down}`, color: C.down, fontFamily: MONO, fontSize: 11, borderRadius: 6, padding: "5px 10px", whiteSpace: "nowrap" }}>
                ⛔ tape stalled — possible halt
              </div>
            )}
            {visBars.length === 0 && !err && (
              <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: C.dim }}>loading…</div>
            )}
            <span style={{ position: "absolute", top: 8, right: 8, zIndex: 4, fontFamily: MONO, fontSize: 9, letterSpacing: 0.5, color: live ? C.up : C.amber, pointerEvents: "none" }}>
              {live ? (feedMode(feed).delayMs ? "● TICKS RT · 15m BARS" : "● LIVE") : "● 2s POLL"}
            </span>
            <canvas
              ref={canvasRef}
              onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseLeave}
              onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
              style={{ width: "100%", height: "100%", display: "block", cursor: "crosshair", touchAction: "none" }}
            />
            <div style={{ position: "absolute", left: 8, bottom: 26, fontFamily: MONO, fontSize: 9, color: C.dim, pointerEvents: "none" }}>
              {mobile ? "hold & drag: inspect · swipe: pan · pinch: zoom" : "drag: pan · scroll: zoom · hover: inspect"}
            </div>
          </div>
          {/* today's numbers */}
          <div style={{ borderTop: `1px solid ${C.border}`, background: C.panel }}>
            <div style={{ padding: "10px 16px 0", fontSize: 9, letterSpacing: 1.5, color: C.amber, textTransform: "uppercase", fontFamily: MONO }}>Today's numbers</div>
            <div style={{ padding: 16, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px 10px" }}>
              <StatCell label="Day high" value={calc ? fp(calc.dayHi) : "—"} color={C.up} />
              <StatCell label="Day low" value={calc ? fp(calc.dayLo) : "—"} color={C.down} />
              <StatCell label="Day vol" value={calc ? fv(calc.dayVol) : "—"} />
              <StatCell label="Float" value={flt ? fv(flt) : "—"} />
              <StatCell label="PM high" value={calc && calc.pmH != null ? fp(calc.pmH) : "—"} color={C.amber} />
              <StatCell label="PM low" value={calc && calc.pmL != null ? fp(calc.pmL) : "—"} />
              <StatCell label={luld ? `LULD ↑ est ${luld.band}%` : "LULD ↑ est"} value={luld ? fp(luld.up) : "—"} color={C.amber} />
              <StatCell label={luld ? `LULD ↓ est ${luld.band}%` : "LULD ↓ est"} value={luld ? fp(luld.dn) : "—"} color={C.down} />
              <StatCell label="VWAP" value={calc ? fp(calc.vwapNow) : "—"} color={C.vwap} />
              <StatCell label="EMA 8" value={calc ? fp(calc.e8Now) : "—"} color={C.ema8} />
              <StatCell label="EMA 21" value={calc ? fp(calc.e21Now) : "—"} color={C.ema21} />
              <StatCell label="EMA 50" value={calc ? fp(calc.e50Now) : "—"} color={C.ema50} />
            </div>
          </div>
          {/* AI trade plan — support/resistance + three long-only scenarios, on demand */}
          {plans && (() => {
            const ageMin = plan ? Math.max(0, Math.round((Date.now() - planT) / 60000)) : 0;
            const drift = plan && planPx && price ? ((price - planPx) / planPx) * 100 : 0;
            const biasCol = !plan ? C.dim : plan.bias === "bullish" ? C.up : plan.bias === "bearish" ? C.down : C.amber;
            const L = (v) => (v == null ? "—" : "$" + fp(v));
            const sBtn = { background: "transparent", border: `1px solid ${C.border}`, color: C.muted, borderRadius: 6, height: 28, padding: "0 9px", fontFamily: MONO, fontSize: 10, cursor: "pointer", whiteSpace: "nowrap", touchAction: "manipulation" };
            return (
              <div style={{ margin: 8, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", borderBottom: `1px solid ${C.border}` }}>
                  <span style={{ fontSize: 9, letterSpacing: 1.5, color: C.amber, textTransform: "uppercase", fontFamily: MONO, whiteSpace: "nowrap" }}>AI trade plan</span>
                  {plan && <span style={{ fontFamily: MONO, fontSize: 9, color: C.dim, whiteSpace: "nowrap" }}>{ageMin < 1 ? "just now" : `${ageMin}m ago`}</span>}
                  <div style={{ flex: 1 }} />
                  {plan && <button onClick={() => setPlanLines((v) => !v)} aria-label="toggle plan levels on chart" style={{ ...sBtn, color: planLines ? C.amber : C.muted, borderColor: planLines ? C.amber + "66" : C.border }}>levels {planLines ? "on" : "off"}</button>}
                  {plan && <button onClick={copyPlan} aria-label="copy plan" style={sBtn}><CopyIcon /></button>}
                  <button onClick={() => analyze(!!plan)} disabled={planBusy} aria-label={plan ? "refresh plan" : "analyze"}
                    style={{ ...sBtn, background: C.amber + "1A", border: `1px solid ${C.amber}66`, color: C.amber, fontWeight: 700, opacity: planBusy ? 0.6 : 1 }}>
                    {planBusy ? "Analyzing…" : plan ? "↻ Refresh" : "✦ Analyze"}
                  </button>
                </div>
                {!plan && !planBusy && !planErr && (
                  <div style={{ padding: "10px 12px", color: C.dim, fontSize: 11, lineHeight: 1.5 }}>
                    Support and resistance from today's tape, plus three long-only ways to trade it. Nothing is sent until you tap Analyze.
                  </div>
                )}
                {planBusy && !plan && <div style={{ padding: "10px 12px", color: C.amber, fontSize: 11, fontFamily: MONO }}>Reading the tape — this takes a few seconds…</div>}
                {planErr && <div style={{ padding: "8px 12px", color: C.down, fontSize: 11, fontFamily: MONO }}>✕ {planErr}</div>}
                {plan && (
                  <>
                    {Math.abs(drift) >= 8 && (
                      <div style={{ padding: "6px 12px", background: C.amber + "12", color: C.amber, fontSize: 10, fontFamily: MONO, borderBottom: `1px solid ${C.border}` }}>
                        price has moved {drift >= 0 ? "+" : ""}{drift.toFixed(1)}% since this plan — refresh before acting on it
                      </div>
                    )}
                    <div style={{ padding: "10px 12px 6px", display: "flex", gap: 10, alignItems: "flex-start" }}>
                      <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 800, letterSpacing: 1, color: biasCol, border: `1px solid ${biasCol}66`, borderRadius: 4, padding: "2px 6px", flexShrink: 0, textTransform: "uppercase" }}>{plan.bias}</span>
                      <div style={{ fontSize: 12, lineHeight: 1.5, color: C.text }}>{plan.summary}</div>
                    </div>
                    <div style={{ padding: "4px 12px 2px", fontSize: 8, letterSpacing: 1.2, color: C.dim, textTransform: "uppercase", fontFamily: MONO }}>Levels · tap one to set a price alert</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "4px 12px 10px" }}>
                      {[...plan.levels].reverse().map((l, i) => (
                        <button key={i} onClick={() => { if (onSetLevels) { onSetLevels(symbol, [...new Set([...((prefs && prefs.lv) || []), +l.price.toFixed(4)])].sort((a, b) => a - b).slice(0, 15)); say(`Alert at $${fp(l.price)} set`); } }}
                          title={l.label}
                          style={{ display: "inline-flex", alignItems: "center", gap: 6, background: (l.kind === "support" ? C.up : C.down) + "12", border: `1px solid ${(l.kind === "support" ? C.up : C.down)}55`, borderRadius: 6, padding: "5px 8px", fontFamily: MONO, fontSize: 10, color: l.kind === "support" ? C.up : C.down, cursor: "pointer", touchAction: "manipulation" }}>
                          <span style={{ fontWeight: 800 }}>{l.kind === "support" ? "S" : "R"} ${fp(l.price)}</span>
                          <span style={{ color: C.muted, maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.label}</span>
                          <span style={{ color: C.dim, letterSpacing: 1 }}>{"●".repeat(l.strength)}{"○".repeat(3 - l.strength)}</span>
                        </button>
                      ))}
                    </div>
                    {(plan.must_hold != null || plan.must_fail != null) && (
                      <div style={{ display: "flex", gap: 14, padding: "0 12px 10px", fontFamily: MONO, fontSize: 10 }}>
                        <span><span style={{ color: C.dim }}>MUST HOLD </span><span style={{ color: C.up, fontWeight: 800 }}>{L(plan.must_hold)}</span></span>
                        <span><span style={{ color: C.dim }}>MUST FAIL </span><span style={{ color: C.down, fontWeight: 800 }}>{L(plan.must_fail)}</span></span>
                      </div>
                    )}
                    <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "repeat(3, 1fr)", gap: 8, padding: "0 12px 10px" }}>
                      {plan.scenarios.map((sc) => (
                        <div key={sc.name} style={{ background: C.panel2, border: `1px solid ${sc.stance === "long" ? C.up + "33" : C.border}`, borderRadius: 8, padding: "9px 10px", display: "flex", flexDirection: "column", gap: 5 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 12, fontWeight: 800 }}>{sc.name}</span>
                            <span style={{ fontFamily: MONO, fontSize: 8, fontWeight: 800, color: sc.stance === "long" ? C.up : C.dim, background: (sc.stance === "long" ? C.up : C.dim) + "1C", borderRadius: 3, padding: "1px 5px" }}>{sc.stance === "long" ? "LONG" : "WAIT"}</span>
                          </div>
                          <div style={{ fontSize: 11, color: C.text, lineHeight: 1.45 }}>{sc.trigger}</div>
                          {sc.stance === "long" && (
                            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 8px", fontFamily: MONO, fontSize: 10 }}>
                              <span style={{ color: C.dim }}>ENTRY</span><span style={{ color: C.text }}>{sc.entry_lo != null ? `${L(sc.entry_lo)} – ${L(sc.entry_hi)}` : "—"}</span>
                              <span style={{ color: C.dim }}>STOP</span><span style={{ color: C.down, fontWeight: 700 }}>{L(sc.stop)}</span>
                              <span style={{ color: C.dim }}>TARGETS</span><span style={{ color: C.up, fontWeight: 700 }}>{sc.targets.length ? sc.targets.map(L).join(" → ") : "—"}</span>
                            </div>
                          )}
                          {sc.invalidation && <div style={{ fontSize: 10, color: C.muted, lineHeight: 1.4 }}><span style={{ color: C.down, fontFamily: MONO, fontSize: 8, letterSpacing: 1 }}>INVALID IF </span>{sc.invalidation}</div>}
                          {sc.note && <div style={{ fontSize: 10, color: C.dim, lineHeight: 1.4 }}>{sc.note}</div>}
                        </div>
                      ))}
                    </div>
                    {plan.risk_notes && <div style={{ padding: "0 12px 8px", fontSize: 10, color: C.muted, lineHeight: 1.45 }}>{plan.risk_notes}</div>}
                    <div style={{ padding: "6px 12px 10px", borderTop: `1px solid ${C.border}`, fontFamily: MONO, fontSize: 8, letterSpacing: 0.8, color: C.dim, textTransform: "uppercase" }}>
                      AI-generated · not financial advice · built {ftime(planT)} ET at ${fp(planPx)} · {plan.model || "model"}
                    </div>
                  </>
                )}
              </div>
            );
          })()}
          {/* confluence tracker */}
          <div style={{ margin: 8, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderBottom: `1px solid ${C.border}` }}>
              <span style={{ fontSize: 9, letterSpacing: 1.5, color: C.amber, textTransform: "uppercase", fontFamily: MONO }}>Confluence tracker</span>
              <div style={{ flex: 1 }} />
              {conf && (
                <>
                  <span style={{ fontFamily: MONO, fontSize: 16, fontWeight: 800, color: conf.score >= 5 ? C.up : conf.score >= 3 ? C.amber : C.down }}>
                    {conf.score}/6
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>
                    {conf.score >= 5 ? "BULLISH" : conf.score >= 3 ? "MIXED" : "BEARISH"} · {conf.barsSinceFlip} bars since flip
                  </span>
                </>
              )}
            </div>
            {!conf && <div style={{ padding: "10px 12px", color: C.dim, fontSize: 11 }}>needs ~30 bars on this timeframe…</div>}
            {conf && (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 6, padding: "8px 10px" }}>
                  {conf.rows.map((r) => (
                    <div key={r.k} style={{ display: "flex", alignItems: "center", gap: 6, background: C.panel2, border: `1px solid ${r.bull ? C.up : C.down}33`, borderRadius: 7, padding: "6px 8px" }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontFamily: MONO, fontSize: 8, letterSpacing: 0.8, color: C.dim }}>{r.k}</div>
                        <div style={{ fontFamily: MONO, fontSize: 11, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.val}</div>
                      </div>
                      <span style={{ fontFamily: MONO, fontSize: 8, fontWeight: 800, color: r.bull ? C.up : C.down, background: (r.bull ? C.up : C.down) + "1C", borderRadius: 3, padding: "2px 5px", flexShrink: 0 }}>
                        {r.bull ? "BULL" : "BEAR"}
                      </span>
                    </div>
                  ))}
                </div>
                <div style={{ padding: "6px 12px 4px", fontSize: 8, letterSpacing: 1.2, color: C.dim, textTransform: "uppercase", fontFamily: MONO, borderTop: `1px solid ${C.border}` }}>
                  State changes — most recent first
                </div>
                {conf.flips.length === 0 && <div style={{ padding: "6px 12px 10px", color: C.dim, fontSize: 11 }}>No indicator flips in this window.</div>}
                {conf.flips.map((f, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "5px 12px", borderBottom: `1px solid ${C.border}44`, fontSize: 11 }}>
                    <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim, flexShrink: 0 }}>{ftime(f.t)}</span>
                    <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: C.text, minWidth: 66, flexShrink: 0 }}>{f.ind}</span>
                    <span style={{ fontFamily: MONO, fontSize: 8, fontWeight: 800, color: f.bull ? C.up : C.down, background: (f.bull ? C.up : C.down) + "1C", borderRadius: 3, padding: "1px 5px", flexShrink: 0 }}>
                      {f.bull ? "BEAR → BULL" : "BULL → BEAR"}
                    </span>
                    <span style={{ color: C.muted, minWidth: 0 }}>{f.desc}</span>
                    <div style={{ flex: 1 }} />
                    <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim, flexShrink: 0 }}>${fp(f.price)}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
        <div style={{ width: mobile ? "100%" : 210, borderLeft: mobile ? "none" : `1px solid ${C.border}`, borderTop: mobile ? `1px solid ${C.border}` : "none", display: "flex", flexDirection: "column", minHeight: 0, flexShrink: 0 }}>
          {sidebar}
        </div>
      </div>
      {toast && (
        <div role="status" style={{ position: "fixed", left: "50%", bottom: "calc(22px + env(safe-area-inset-bottom))", transform: "translateX(-50%)", zIndex: 70, maxWidth: "calc(100% - 32px)", background: toast.ok ? "#0F2A1A" : "#2A0F14", border: `1px solid ${toast.ok ? C.up : C.down}`, color: toast.ok ? C.up : C.down, borderRadius: 10, padding: "10px 16px", fontFamily: MONO, fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", boxShadow: "0 10px 30px #000000AA", pointerEvents: "none" }}>
          {toast.ok ? "✓ " : "✕ "}{toast.msg}
        </div>
      )}
      {alertsOpen && onTogglePref && (
        /* per-ticker alert rules + price-cross levels — a sheet, not a section,
           so the chart and numbers keep the screen */
        <div onClick={() => setAlertsOpen(false)}
          style={{ position: "fixed", inset: 0, zIndex: 60, background: "#000000A6", display: "flex", alignItems: mobile ? "flex-end" : "center", justifyContent: "center", padding: 12, paddingBottom: "calc(12px + env(safe-area-inset-bottom))" }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: "100%", maxWidth: 520, maxHeight: "80vh", overflowY: "auto", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, boxShadow: "0 18px 50px #000000AA" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: `1px solid ${C.border}` }}>
              <span style={{ color: C.amber, display: "flex" }}><BellIcon size={16} /></span>
              <span style={{ fontSize: 10, letterSpacing: 1.5, color: C.amber, textTransform: "uppercase", fontFamily: MONO }}>Alerts for {symbol}</span>
              <div style={{ flex: 1 }} />
              <button onClick={() => setAlertsOpen(false)} aria-label="close alerts"
                style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.muted, borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12 }}>✕</button>
            </div>
            <div style={{ padding: "12px 16px 4px", fontSize: 8, letterSpacing: 1.2, color: C.dim, textTransform: "uppercase", fontFamily: MONO }}>
              Alert types for this stock · tap to switch off
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "6px 16px 14px" }}>
              {ALERT_CATS.map(([cat, label]) => {
                const on = !(prefs && prefs.off && prefs.off.includes(cat));
                return (
                  <button key={cat} onClick={() => onTogglePref(symbol, cat, !on)}
                    style={{ background: on ? C.up + "1A" : "transparent", border: `1px solid ${on ? C.up : C.border}`, color: on ? C.up : C.dim, borderRadius: 6, padding: "6px 10px", fontFamily: MONO, fontSize: 10, cursor: "pointer" }}>
                    {on ? "✓ " : ""}{label}
                  </button>
                );
              })}
            </div>
            <div style={{ padding: "0 16px 6px", fontSize: 8, letterSpacing: 1.2, color: C.dim, textTransform: "uppercase", fontFamily: MONO }}>
              Price-cross levels · alerts when price crosses · up to 15
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "0 16px 16px", alignItems: "center" }}>
              {((prefs && prefs.lv) || []).map((L) => (
                <span key={L} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: C.amber + "14", border: `1px solid ${C.amber}55`, borderRadius: 6, padding: "5px 9px", fontFamily: MONO, fontSize: 11, color: C.amber }}>
                  ${fp(L)}
                  <span onClick={() => onSetLevels(symbol, ((prefs && prefs.lv) || []).filter((x) => x !== L))}
                    style={{ cursor: "pointer", color: C.muted, fontWeight: 700 }} aria-label={`remove level ${L}`}>×</span>
                </span>
              ))}
              {((prefs && prefs.lv) || []).length < 15 && (
                <>
                  <input value={lvIn} onChange={(e) => setLvIn(e.target.value)} inputMode="decimal" placeholder="price"
                    style={{ width: 74, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, padding: "6px 8px", fontFamily: MONO, fontSize: 11 }} />
                  <button
                    onClick={() => {
                      const v = Number(lvIn);
                      if (!isFinite(v) || v <= 0) return;
                      onSetLevels(symbol, [...new Set([...((prefs && prefs.lv) || []), +v.toFixed(4)])].sort((a, b) => a - b));
                      setLvIn("");
                    }}
                    style={{ background: "transparent", border: `1px solid ${C.amber}`, color: C.amber, borderRadius: 6, padding: "6px 12px", fontFamily: MONO, fontSize: 10, fontWeight: 700, cursor: "pointer" }}>
                    + Add level
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- main app ---------------- */
/* The tap-to-preview card is gone by request: tapping a row now opens the
   Advanced detail view directly. */

export default function App() {
  const width = useWidth();
  const mobile = width < 720;
  const [keys, setKeys] = useState({ id: "", secret: "" });
  const [remember, setRemember] = useState(true);
  const [feed, setFeed] = useState("sip_delayed");
  const [maxPrice, setMaxPrice] = useState(100);
  const [minDayVol, setMinDayVol] = useState(5000000);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [gainers, setGainers] = useState([]);
  const [barsMap, setBarsMap] = useState({});
  const [pmMap, setPmMap] = useState({});
  const [selected, setSelected] = useState(null);
  const [updated, setUpdated] = useState(null);
  const [found, setFound] = useState(0);
  const [alertsOn, setAlertsOn] = useState(false);
  const [pushArmed, setPushArmed] = useState(false);
  const [alertLog, setAlertLog] = useState([]);
  const [alertCenter, setAlertCenter] = useState(false);
  const [jStats, setJStats] = useState(null); // push follow-through from the server journal
  useEffect(() => {
    const load = () => fetch("/journal").then((r) => r.json())
      .then((j) => setJStats(j && j.stats ? j.stats : null)).catch(() => {});
    load();
    const id = setInterval(load, 5 * 60000);
    return () => clearInterval(id);
  }, []);
  /* refresh the moment the history opens, so the panel is never a stale copy */
  useEffect(() => {
    if (!alertCenter) return;
    fetch("/journal").then((r) => r.json()).then((j) => setJStats(j && j.stats ? j.stats : null)).catch(() => {});
  }, [alertCenter]);
  const [bannerX, setBannerX] = useState(0);
  const bannerTouchRef = useRef(null);
  const [pushWarn, setPushWarn] = useState(false);
  const [haltedSyms, setHaltedSyms] = useState([]);
  const [newsMap, setNewsMap] = useState({}); // sym -> {headline, at, dilution}
  const haltAtRef = useRef({});               // sym -> ms the halt flag was first raised
  const [onboardOpen, setOnboardOpen] = useState(false);
  const [onboardMode, setOnboardMode] = useState("first"); // "first" | "help"
  const [aboutOpen, setAboutOpen] = useState(false);
  const [srvCfg, setSrvCfg] = useState(null); // {serverKeys, invite, feed} — server-held-keys mode
  const [invite, setInvite] = useState("");
  const [account, setAccount] = useState(null); // {provider, email, plan, createdAt} — preview: on-device only
  const accountRef = useRef(null);
  const [acctOpen, setAcctOpen] = useState(false);
  const saveAccount = useCallback((a) => {
    accountRef.current = a;
    setAccount(a);
    if (a) { try { window.storage.set("account", JSON.stringify(a)); } catch (e) {} }
    else { try { window.storage.delete("account"); } catch (e) {} }
  }, []);
  useEffect(() => {
    (async () => {
      try {
        const ar = await window.storage.get("account");
        if (ar && ar.value) { const a = JSON.parse(ar.value); accountRef.current = a; setAccount(a); }
      } catch {}
    })();
  }, []);

  /* server mode discovery + a stable per-device id */
  useEffect(() => {
    fetch("/config").then((r) => r.json()).then((c) => setSrvCfg(c || { serverKeys: false }))
      .catch(() => setSrvCfg({ serverKeys: false }));
    (async () => {
      let id = null;
      try {
        const dr = await window.storage.get("device-id");
        if (dr && dr.value) id = dr.value;
      } catch {}
      if (!id) {
        id = "dv" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
        try { window.storage.set("device-id", id); } catch (e) {}
      }
      DEVICE.id = id;
    })();
  }, []);

  /* keyless connect: claim this device with the access code, then run */
  const connectServer = useCallback(async () => {
    setErr("");
    try {
      const r = await fetch("/auth/claim", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: invite.trim(), device: DEVICE.id, account: account ? { email: account.email, provider: account.provider, plan: account.plan } : undefined }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "access denied");
      const sv = { id: "server", secret: "server", code: invite.trim(), feed: (srvCfg && srvCfg.feed) || "sip", maxPrice, minDayVol, ver: 3 };
      setKeys({ id: "server", secret: "server", code: sv.code });
      setFeed(sv.feed);
      try { window.storage.set("alpaca-keys", JSON.stringify(sv)); } catch (e) {}
      setRunning(true);
    } catch (e) { setErr(String(e.message || e)); }
  }, [invite, srvCfg, maxPrice, minDayVol, account]);

  /* the server's device store is ephemeral across deploys — re-claim
     silently on boot so a running device never gets locked out */
  useEffect(() => {
    if (!srvCfg || !srvCfg.serverKeys || !running || keys.id !== "server") return;
    const t = setTimeout(() => {
      try {
        fetch("/auth/claim", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: keys.code || "", device: DEVICE.id }),
        }).catch(() => {});
      } catch (e) {}
    }, 1200);
    return () => clearTimeout(t);
  }, [srvCfg, running, keys]);

  /* first-run walkthrough: only on a device with no stored keys yet */
  useEffect(() => {
    (async () => {
      let seen = false, hasKeys = false;
      try {
        const os = await window.storage.get("onboard-seen");
        seen = !!(os && os.value);
      } catch {}
      try {
        const kr = await window.storage.get("alpaca-keys");
        hasKeys = !!(kr && kr.value);
      } catch {}
      if (!seen && !hasKeys) { setOnboardMode("first"); setOnboardOpen(true); }
    })();
  }, []);
  const finishOnboard = useCallback(() => {
    setOnboardOpen(false);
    try { window.storage.set("onboard-seen", "1"); } catch (e) {}
    if (onboardMode === "first" && !accountRef.current) setAcctOpen(true);
  }, [onboardMode]);
  const openHelp = useCallback(() => { setOnboardMode("help"); setOnboardOpen(true); }, []);

  /* per-ticker notification prefs: switched-off categories + up to 15
     price-cross levels per symbol. Synced to the push monitor with the
     watchlist (~15s), persisted on this device. */
  const alertPrefsRef = useRef({}); // sym -> { off: [cats], lv: [levels] }
  const [alertPrefsVer, setAlertPrefsVer] = useState(0);
  useEffect(() => {
    (async () => {
      try {
        const pr = await window.storage.get("alert-prefs");
        if (pr && pr.value) alertPrefsRef.current = JSON.parse(pr.value) || {};
      } catch {}
      setAlertPrefsVer((v) => v + 1);
    })();
  }, []);
  const savePrefs = useCallback(() => {
    try { window.storage.set("alert-prefs", JSON.stringify(alertPrefsRef.current)); } catch (e) {}
    setAlertPrefsVer((v) => v + 1);
  }, []);
  const setPref = useCallback((sym, cat, on) => {
    const p = alertPrefsRef.current[sym] || (alertPrefsRef.current[sym] = { off: [], lv: [] });
    p.off = on ? (p.off || []).filter((c) => c !== cat) : [...new Set([...(p.off || []), cat])];
    savePrefs();
  }, [savePrefs]);
  const setLevels = useCallback((sym, lv) => {
    const p = alertPrefsRef.current[sym] || (alertPrefsRef.current[sym] = { off: [], lv: [] });
    p.lv = lv.filter((x) => typeof x === "number" && isFinite(x) && x > 0).slice(0, 15);
    savePrefs();
  }, [savePrefs]);
  const prefOff = useCallback((sym, cat) => {
    const p = alertPrefsRef.current[sym];
    return !!(p && p.off && p.off.includes(cat));
  }, []);
  const [ahMoves, setAhMoves] = useState([]);
  const [ahInfo, setAhInfo] = useState({}); /* ungated AH stats for main-row chips */
  const [mutedSyms, setMutedSyms] = useState([]); /* mirrors mutedRef for the row bells */
  const universeRef = useRef(null);
  const uniSetRef = useRef(null);
  const candRef = useRef({});
  const hotRef = useRef([]);
  const sweepBusy = useRef(false);
  const busy = useRef(false);
  const alertsOnRef = useRef(false);
  const audioRef = useRef(null);
  const firedRef = useRef(new Set());
  const haltRef = useRef(new Set());
  const floatRef = useRef({});
  const trigRef = useRef({});
  const gainersRef = useRef([]);
  const refreshRef = useRef(null);
  const moversRef = useRef([]);
  const ahRef = useRef([]);
  const ahStickyRef = useRef(new Set()); /* qualified once = stays for the AH session */
  const ahCandRef = useRef([]); /* FULL-MARKET AH discovery (snapshots) — feeds the AH scan pool */
  const watchAllRef = useRef([]); /* EVERY qualifying ≥25% mover — alert coverage follows qualification, not rank */
  const ignScanRef = useRef(null);
  const dayRef = useRef(null); /* ET day of the last sweep — rollover wipes the slate for the 4 AM open */
  const mutedRef = useRef(new Set()); /* per-symbol alert mutes (see toggleMute) */
  const watchPoolRef = useRef([]); /* latest computed monitor pool, pre-mute-filter */

  /* ---- per-symbol alert mutes: the small bell on every watchlist row.
     A muted symbol is skipped by the in-app trigger scan AND filtered out of
     the server push watchlist, so the phone stays quiet for exactly the
     stocks you silence. Mutes are day-scoped — every new session starts
     with alerts ON for everything. ---- */
  const persistMuted = (set) => {
    try { window.storage.set("muted-syms", JSON.stringify({ day: etDay(Date.now()), syms: [...set] })); } catch (e) {}
  };
  const restoreMuted = (mv) => {
    if (mv && mv.day === etDay(Date.now()) && Array.isArray(mv.syms)) {
      mutedRef.current = new Set(mv.syms);
      setMutedSyms(mv.syms);
    }
  };
  const syncWatch = useCallback(() => {
    try {
      fetch("/push/watchlist", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols: watchPoolRef.current.filter((s) => !mutedRef.current.has(s)).slice(0, 40), device: DEVICE.id || undefined, prefs: alertPrefsRef.current }),
      }).catch(() => {});
    } catch (e) {}
  }, []);
  const toggleMute = useCallback((sym) => {
    const next = new Set(mutedRef.current);
    if (next.has(sym)) next.delete(sym); else next.add(sym);
    mutedRef.current = next;
    setMutedSyms([...next]);
    persistMuted(next);
    syncWatch(); /* the push monitor follows the mute immediately */
  }, [syncWatch]);

  /* load saved settings: device storage first, then the server copy —
     and if a saved setup exists, go STRAIGHT to the scanner (no re-entry) */
  useEffect(() => {
    (async () => {
      let v = null;
      try {
        const r = await window.storage.get("alpaca-keys");
        if (r && r.value) v = JSON.parse(r.value);
      } catch {}
      if (!v || !v.id || !v.secret) {
        try {
          const sr = await fetch("/settings");
          const sv = await sr.json();
          if (sv && sv.id && sv.secret) {
            v = sv;
            try { await window.storage.set("alpaca-keys", JSON.stringify({ ...sv, ver: 3 })); } catch {}
          }
        } catch {}
      }
      if (v) {
        setKeys({ id: v.id || "", secret: v.secret || "" });
        if (v.maxPrice) setMaxPrice(v.maxPrice);
        if (FEED_MODES[v.feed]) setFeed(v.feed);
        if (v.minDayVol) setMinDayVol(v.minDayVol);
        if (v.alertsOn) setAlertsOn(true);
        if (v.id && v.secret) setRunning(true);
      }
      try {
        const mr = await window.storage.get("muted-syms");
        if (mr && mr.value) restoreMuted(JSON.parse(mr.value));
      } catch {}
      try {
        if ("serviceWorker" in navigator) {
          const reg = await navigator.serviceWorker.getRegistration();
          const sub = reg && (await reg.pushManager.getSubscription());
          if (sub) setPushArmed(true);
        }
      } catch {}
    })();
  }, []);

  useEffect(() => { alertsOnRef.current = alertsOn; }, [alertsOn]);
  const pushArmedRef = useRef(false);
  useEffect(() => { pushArmedRef.current = pushArmed; }, [pushArmed]);
  useEffect(() => {
    (async () => {
      try {
        const r0 = await window.storage.get("alpaca-keys");
        const v0 = r0 && r0.value ? JSON.parse(r0.value) : {};
        await window.storage.set("alpaca-keys", JSON.stringify({ ...v0, alertsOn }));
      } catch {}
      try {
        fetch("/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ alertsOn }) }).catch(() => {});
      } catch {}
    })();
  }, [alertsOn]);

  /* alert engine: in-app banner + sound; lock-screen via server Web Push */
  const notify = useCallback((title, body) => {
    setAlertLog((l) => [{ t: Date.now(), title, body }, ...l].slice(0, 50));
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = audioRef.current || (audioRef.current = new Ctx());
      const o = ctx.createOscillator(); const gn = ctx.createGain();
      o.connect(gn); gn.connect(ctx.destination);
      o.frequency.value = 880;
      gn.gain.setValueAtTime(0.08, ctx.currentTime);
      gn.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      o.start(); o.stop(ctx.currentTime + 0.25);
    } catch (e) {}
    try {
      /* if the server monitor is pushing to this device, it owns the system
         notification — the in-app layer stays banner + sound only */
      if (!pushArmedRef.current && "Notification" in window && Notification.permission === "granted")
        new Notification(title, { body });
    } catch (e) {}
  }, []);
  const alertOnce = useCallback((key, title, body) => {
    const k = etDay(Date.now()) + "|" + key;
    if (firedRef.current.has(k)) return;
    firedRef.current.add(k);
    notify(title, body);
  }, [notify]);
  const chartAlert = useCallback((title, body) => {
    if (alertsOnRef.current) notify(title, body);
  }, [notify]);

  /* enable alerts: register SW + Web Push subscription with the server */
  const toggleAlerts = async () => {
    if (alertsOn) {
      setAlertsOn(false);
      setPushArmed(false);
      try {
        let endpoint = null;
        if ("serviceWorker" in navigator) {
          const reg = await navigator.serviceWorker.getRegistration();
          const sub = reg && (await reg.pushManager.getSubscription());
          if (sub) { endpoint = sub.endpoint; try { await sub.unsubscribe(); } catch (e) {} }
        }
        await fetch("/push/unregister", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint, device: DEVICE.id || undefined }) });
      } catch (e) {}
      return;
    }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioRef.current = new Ctx();
    } catch (e) {}
    let armed = false;
    try {
      if ("serviceWorker" in navigator && "PushManager" in window && "Notification" in window) {
        const reg = await navigator.serviceWorker.register("/sw.js");
        const perm = await Notification.requestPermission();
        if (perm === "granted") {
          const pk = await (await fetch("/push/pubkey")).json();
          const raw = atob(pk.key.replace(/-/g, "+").replace(/_/g, "/"));
          const arr = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
          const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: arr });
          await fetch("/push/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ subscription: sub, keys, feed, device: DEVICE.id || undefined }),
          });
          armed = true;
        }
      } else if ("Notification" in window && Notification.permission === "default") {
        await Notification.requestPermission();
      }
    } catch (e) {}
    setPushArmed(armed);
    setAlertsOn(true);
    notify(armed ? "🔔 Lock-screen alerts armed" : "🔔 In-app alerts on",
      armed ? "The server is now watching the tape and will push to this device." : "Add to Home Screen (iOS) or use desktop/Android for lock-screen push.");
  };

  /* Full-market sweep on the consolidated tape */
  const sweep = useCallback(async () => {
    if (sweepBusy.current) return;
    sweepBusy.current = true;
    try {
      if (!universeRef.current) {
        /* universe is cached for 24h — the big asset download happens once a day */
        try {
          const uc = await window.storage.get("uni-cache");
          if (uc && uc.value) {
            const v = JSON.parse(uc.value);
            if (v.t && Date.now() - v.t < 24 * 3600e3 && Array.isArray(v.symbols) && v.symbols.length > 1000) {
              universeRef.current = v.symbols;
              uniSetRef.current = new Set(v.symbols);
            }
          }
        } catch (e) {}
      }
      if (!universeRef.current) {
        setNote("Loading listed-stock universe (cached for 24h after this)…");
        const assets = await alpacaT("/v2/assets", { status: "active", asset_class: "us_equity" }, keys);
        universeRef.current = assets.filter((a) => a.exchange !== "OTC" && a.tradable === true && a.status === "active").map((a) => a.symbol);
        uniSetRef.current = new Set(universeRef.current);
        try { await window.storage.set("uni-cache", JSON.stringify({ t: Date.now(), symbols: universeRef.current })); } catch (e) {}
      }
      const uni = universeRef.current;
      const cands = {};
      const today = etDay(Date.now());
      /* NEW ET DAY = fresh slate. The first sweep of a new day (the app left
         open overnight, or reopened premarket) clears yesterday's list and
         state, so the 4:00 AM premarket open starts clean and the watchlist
         auto-populates with the NEW day's gappers as they print. */
      if (dayRef.current && dayRef.current !== today) {
        candRef.current = {}; hotRef.current = []; moversRef.current = [];
        watchAllRef.current = []; gainersRef.current = [];
        firedRef.current = new Set(); trigRef.current = {};
        ahStickyRef.current = new Set();
        mutedRef.current = new Set(); setMutedSyms([]); persistMuted(mutedRef.current);
        setGainers([]); setBarsMap({}); setPmMap({}); setFound(0);
        setAhMoves([]); setAhInfo({});
      }
      dayRef.current = today;
      const pmMode = inPremarket();
      /* PARALLEL sweep: batches of 1,000 symbols, 8 requests in flight at
         once — the whole market in a couple of seconds on the paid plan */
      const B = 1000;
      const batches = [];
      for (let off = 0; off < uni.length; off += B) batches.push(uni.slice(off, off + B));
      let doneSyms = 0;
      setNote(`Sweeping the tape: 0 / ${uni.length.toLocaleString()} symbols…`);
      const runBatch = async (batch) => {
        try {
          if (pmMode) {
            /* PREMARKET: today's daily bar does not exist before the 9:30
               open, so the 1Day sweep finds NOTHING here (this is exactly why
               the list used to be empty every morning). Batched snapshots
               carry what premarket needs: latestTrade = the live premarket
               print, and the last COMPLETED daily bar = the prior close.
               Snapshots can't be time-shifted, so delayed mode reads the
               free real-time IEX tape for this step. */
            const snapFeed = feedMode(feed).delayMs ? "iex" : feedMode(feed).rest;
            const j = await alpaca("/v2/stocks/snapshots", { symbols: batch.join(","), feed: snapFeed }, keys);
            for (const s of batch) {
              const sn = j && j[s];
              if (!sn || !sn.latestTrade || !sn.latestTrade.p) continue;
              if (etDay(sn.latestTrade.t) !== today) continue; /* must have printed THIS premarket */
              const db = sn.dailyBar, pdb = sn.prevDailyBar;
              const dbToday = db && etDay(db.t) === today;
              const ref = dbToday ? pdb && pdb.c : db && db.c;
              if (!ref || ref < 0.05) continue;
              const p = sn.latestTrade.p;
              if (p < 0.03 || p > Number(maxPrice || 9999)) continue;
              const pct = ((p - ref) / ref) * 100;
              if (pct < PM_CAND_PCT) continue;
              cands[s] = { price: p, pct, dayVol: dbToday ? db.v : null, prevClose: ref, pm: true };
            }
          } else {
            const bj = await alpaca("/v2/stocks/bars", barParams(feed, {
              symbols: batch.join(","), timeframe: "1Day", start: daysAgoISO(6), limit: 10000, adjustment: "split",
            }), keys);
            for (const s of batch) {
              const arr = (bj.bars && bj.bars[s]) || [];
              if (arr.length < 2) continue;
              const lastB = arr[arr.length - 1], prevB = arr[arr.length - 2];
              if (etDay(lastB.t) !== today) continue;
              if (!lastB.v || lastB.v < Number(minDayVol || 0)) continue;
              const prev = prevB.c, p = lastB.c;
              if (!prev || prev < 0.05 || !p || p < 0.03 || p > Number(maxPrice || 9999)) continue;
              const pct = ((p - prev) / prev) * 100;
              if (pct < 3) continue;
              cands[s] = { price: p, pct, dayVol: lastB.v, prevClose: prev };
            }
          }
          candRef.current = { ...cands };
          hotRef.current = Object.keys(cands).sort((a, b) => cands[b].pct - cands[a].pct).slice(0, pmMode ? 45 : 30);
        } catch (e) {}
        doneSyms += batch.length;
        setNote(`Sweeping the tape: ${Math.min(doneSyms, uni.length).toLocaleString()} / ${uni.length.toLocaleString()} symbols…`);
      };
      const POOL = 8;
      let bIdx = 0;
      await Promise.all(
        Array.from({ length: Math.min(POOL, batches.length) }, async () => {
          while (bIdx < batches.length) {
            const b = batches[bIdx++];
            await runBatch(b);
          }
        })
      );
      if (pmMode) {
        /* SPLIT-GUARD: snapshots are RAW prices, and a reverse split read
           against yesterday's raw close once shipped as a phantom +714%.
           Re-check every candidate's prior close against split-adjusted
           daily bars and re-price (or drop) the ones that drifted. */
        const syms = Object.keys(cands);
        for (let off = 0; off < syms.length; off += 1000) {
          const batch = syms.slice(off, off + 1000);
          try {
            const bj = await alpaca("/v2/stocks/bars", barParams(feed, {
              symbols: batch.join(","), timeframe: "1Day", start: daysAgoISO(6), limit: 10000, adjustment: "split",
            }), keys);
            for (const s of batch) {
              const arr = (bj.bars && bj.bars[s]) || [];
              let adj = null;
              for (let i = arr.length - 1; i >= 0; i--)
                if (etDay(arr[i].t) !== today) { adj = arr[i].c; break; }
              const c = cands[s];
              if (!c || !adj || !c.prevClose) continue;
              if (Math.abs(adj - c.prevClose) / c.prevClose > 0.005) {
                const pct = ((c.price - adj) / adj) * 100;
                if (pct < PM_CAND_PCT) delete cands[s];
                else { c.prevClose = adj; c.pct = pct; }
              }
            }
          } catch (e) {}
        }
        candRef.current = { ...cands };
        hotRef.current = Object.keys(cands).sort((a, b) => cands[b].pct - cands[a].pct).slice(0, 45);
      }
      if (inAfterHours()) {
        /* FULL-MARKET after-hours discovery: the AH list must catch a stock
           that slept all day and gapped on 5 PM news. Snapshots give the
           live AH print vs TODAY's official close for every listed symbol;
           the 1-min-bar scan then verifies tape and ranks the top 10. */
        const ahc = {};
        const snapFeed = feedMode(feed).delayMs ? "iex" : feedMode(feed).rest;
        for (let off = 0; off < uni.length; off += B) {
          const batch = uni.slice(off, off + B);
          try {
            const j = await alpaca("/v2/stocks/snapshots", { symbols: batch.join(","), feed: snapFeed }, keys);
            for (const s of batch) {
              const sn = j && j[s];
              if (!sn || !sn.latestTrade || !sn.latestTrade.p || !sn.dailyBar) continue;
              if (etDay(sn.latestTrade.t) !== today || etMinutes(sn.latestTrade.t) < 16 * 60) continue;
              const db = sn.dailyBar;
              if (etDay(db.t) !== today || !db.c || db.c < 0.05) continue;
              const p = sn.latestTrade.p;
              if (p < 0.03 || p > Number(maxPrice || 9999)) continue;
              const pct = ((p - db.c) / db.c) * 100;
              /* NO percentage floor — the AH table is an unconditional
                 top-10 ranking of everything that printed after the close */
              ahc[s] = { symbol: s, price: p, pct, close: db.c };
            }
          } catch (e) {}
        }
        /* verify the leaders' REAL tape: 1-min bars from 16:00 give true
           cumulative AH volume — illiquid one-print names are dropped, and
           the verified volume rides into the table (never a dash) */
        const leaders = Object.values(ahc).sort((a, b) => b.pct - a.pct).slice(0, 40);
        const verified = [];
        for (let off = 0; off < leaders.length; off += 15) {
          const batch = leaders.slice(off, off + 15);
          try {
            const bj = await alpaca("/v2/stocks/bars", barParams(feed, {
              symbols: batch.map((c) => c.symbol).join(","), timeframe: "1Min",
              start: todayETStartISO(16), limit: 10000,
            }), keys);
            for (const c of batch) {
              const arr = (bj.bars && bj.bars[c.symbol]) || [];
              let v = 0;
              const tape = []; /* the AH 1-min tape doubles as the row sparkline */
              for (const b of arr) if (etDay(b.t) === today && etMinutes(b.t) >= 960) { v += b.v; tape.push(normBar(b)); }
              if (v >= AH_MIN_VOL) verified.push({ ...c, ahVol: v, ahBars: tape });
            }
          } catch (e) {}
        }
        ahCandRef.current = verified.sort((a, b) => b.pct - a.pct).slice(0, 15);
      } else ahCandRef.current = [];
      setFound(Object.keys(cands).length);
      setNote("");
      if (refreshRef.current) refreshRef.current(); /* rows appear the moment the sweep lands */
    } catch (e) {
      setNote("");
      setErr(String(e.message || e));
    } finally {
      sweepBusy.current = false;
    }
  }, [keys, feed, maxPrice, minDayVol]);
  useEffect(() => {
    if (!running) return;
    sweep();
    const id = setInterval(sweep, feed === "sip" ? 60000 : 300000);
    return () => clearInterval(id);
  }, [running, sweep]);

  /* float lookup with per-symbol cache */
  const getFloat = useCallback((sym) => {
    const c = floatRef.current[sym];
    if (c !== undefined) return c === "pending" ? null : c;
    floatRef.current[sym] = "pending";
    fetch(`/float/${sym}`)
      .then((r) => r.json())
      .then((j) => { floatRef.current[sym] = j.float || null; })
      .catch(() => { floatRef.current[sym] = null; });
    return null;
  }, []);

  /* trigger-alert scan: full-session 1-min bars for the watch pool */
  const ignScan = useCallback(async () => {
    if (feedMode(feed).delayMs) return;
    const listSyms = gainersRef.current.map((g) => g.symbol); /* ref: 3s price ticks must not re-trigger this scan */
    /* alerts + halt flags cover ALL qualifying movers (a runner that ranks
       16th by setup score is still a runner) plus the AH list */
    const listSet = new Set([...listSyms, ...watchAllRef.current, ...ahRef.current]);
    const ahOn = inAfterHours();
    /* after hours the scan pool ALSO carries the full-market AH discovery —
       a stock that did nothing all day but gapped after the close enters here */
    const pool = Array.from(new Set([
      ...listSyms, ...watchAllRef.current, ...moversRef.current, ...hotRef.current,
      ...(ahOn ? ahCandRef.current.map((c) => c.symbol) : []),
    ])).slice(0, ahOn ? 60 : 45);
    if (pool.length === 0) return;
    const ahAll = {};
    try {
      const allBars = {};
      for (let off = 0; off < pool.length; off += 15) {
        const batch = pool.slice(off, off + 15);
        const j = await alpaca("/v2/stocks/bars", barParams(feed, {
          symbols: batch.join(","), timeframe: "1Min",
          start: todayETStartISO(SESSION_START_ET), limit: 10000,
        }), keys);
        for (const s of batch) allBars[s] = ((j.bars && j.bars[s]) || []).map(normBar);
      }
      const newHalt = [];
      const nowMs = Date.now();
      const hr = Math.floor(nowMs / 3600000);
      for (const s of pool) {
        const arr = allBars[s] || [];
        if (arr.length === 0) continue;
        const last = arr[arr.length - 1];
        /* strict halt: bars right before the silence were heavy AND price was
           moving hard into it — thin-tape lulls don't qualify */
        const gapMs = nowMs - last.t;
        if (gapMs > 150000 && arr.length >= 6) {
          const l3 = arr.slice(-3);
          const preHeavy = l3.every((b) => b.v >= 20000) && l3.reduce((a, b) => a + b.v, 0) / 3 >= 30000;
          const back = arr[arr.length - 6];
          const preMove = Math.abs((last.c - back.o) / (back.o || 1)) * 100;
          if (preHeavy && preMove >= 3) newHalt.push(s);
        }
        /* ---- after-hours movers: change vs today's 4:00 PM regular close,
                same per-minute activity filter as the main list ---- */
        if (ahOn && arr.length >= 2) {
          /* gather AH data per symbol — the table itself is built below from
             the full-market snapshot ranking, with NO qualification gates */
          let regClose = null, ahVol = 0;
          const ahBars = [];
          for (const b of arr) {
            if (etMinutes(b.t) < 960) regClose = b.c;
            else { ahVol += b.v; ahBars.push(b); }
          }
          if (regClose && etMinutes(last.t) >= 960 && ahBars.length >= 1) {
            const ahPct = ((last.c - regClose) / regClose) * 100;
            ahAll[s] = { pct: ahPct, vol: ahVol, bars: ahBars, price: last.c, regClose, sessVol: arr.reduce((x, y) => x + y.v, 0) };
          }
        }
        if (arr.length < 8) continue;
        /* ---- trigger alerts: WATCHLIST symbols only, transitions only,
                and only when the signal bar is the live one ---- */
        if (alertsOnRef.current && listSet.has(s) && !mutedRef.current.has(s) && arr.length >= 8) {
          const st = trigRef.current[s] || (trigRef.current[s] = {});
          /* re-baseline silently if this symbol wasn't observed recently
             (left the list / app slept) — never fire on off-list history */
          if (st.init && st.lastSeen && nowMs - st.lastSeen > 180000) st.init = false;
          st.lastSeen = nowMs;
          const fresh = nowMs - last.t < 120000;
          const closes = arr.map((b) => b.c);
          const vw = vwapSeries(arr);
          const p = last.c, vwL = vw[vw.length - 1];
          const above = p > vwL;
          const e8 = emaSeries(closes, 8), e21 = emaSeries(closes, 21);
          const emAbove = e8[e8.length - 1] > e21[e21.length - 1];
          let pmH = null;
          const opens = [];
          for (const b of arr) {
            const m = etMinutes(b.t);
            if (m < OPEN_ET_MIN) pmH = pmH == null ? b.h : Math.max(pmH, b.h);
            if (m >= OPEN_ET_MIN && m < OPEN_ET_MIN + 10) opens.push(b.v); /* first ten 9:30 candles */
          }
          const pmhNow = pmH != null && etMinutes(last.t) >= OPEN_ET_MIN && p > pmH;
          /* ONE unified volume signal (mirrors the server):
             spike = 3× avg + biggest in 30m + ≥100k + ≥1% thrust;
             opening-drive comparison only vs a REAL (≥100k) opening candle;
             each bar fires at most once ever; 30-min per-symbol cooldown */
          const prior = arr.slice(-11, -1);
          const avg10 = prior.length ? prior.reduce((a, b) => a + b.v, 0) / prior.length : 0;
          const prior30 = arr.slice(-31, -1);
          const max30 = prior30.length ? Math.max(...prior30.map((b) => b.v)) : 0;
          const barMove = Math.abs((last.c - last.o) / (last.o || 1)) * 100;
          const openMax = opens.length ? Math.max(...opens) : 0;
          const surgeQ = !!(avg10 && last.v >= 3 * avg10 && last.v >= max30 && last.v >= 100000 && barMove >= 1);
          const openQ = openMax >= 100000 && last.v >= openMax;
          const volQ = surgeQ || openQ;
          if (!st.init) {
            /* first sight = silent baseline; never replay the past */
            st.init = true; st.vwapSide = above; st.emaSide = emAbove; st.pmhBroken = pmhNow;
            if (volQ) st.volBarT = last.t;
          } else {
            if (fresh) {
              if (st.vwapSide === false && above && !prefOff(s, "vwap"))
                alertOnce(`${s}-vwapx`, `🚨 ${s} reclaimed VWAP`, `Crossed above $${fp(vwL)} · now $${fp(p)}`);
              if (st.emaSide === false && emAbove && !prefOff(s, "ema"))
                alertOnce(`${s}-emax`, `🚨 ${s} 8/21 EMA bull cross`, `EMA 8 crossed above EMA 21 · $${fp(p)}`);
              if (!st.pmhBroken && pmhNow && !prefOff(s, "pmh"))
                alertOnce(`${s}-pmh`, `🚨 ${s} broke premarket high`, `Through PMH $${fp(pmH)} · now $${fp(p)}`);
              /* 3+ consecutive green 1-min candles: fires when a streak
                 REACHES 3 (bar before the run was red/flat), once per streak,
                 15-min per-symbol cooldown */
              const last3 = arr.slice(-3);
              const before3 = arr.length >= 4 ? arr[arr.length - 4] : null;
              const streak3 = last3.length === 3 && last3.every((b) => b.c > b.o) && (!before3 || before3.c <= before3.o);
              if (streak3 && !prefOff(s, "mom3") && (!st.lastMom3 || nowMs - st.lastMom3 > 15 * 60000)) {
                st.lastMom3 = nowMs;
                const runPct = ((last.c - last3[0].o) / last3[0].o) * 100;
                alertOnce(`${s}-mom3-${last.t}`, `📈 ${s} 3 green candles in a row`, `$${fp(last3[0].o)} → $${fp(last.c)} (+${runPct.toFixed(1)}%) on 1-min`);
              }
              if (volQ && !prefOff(s, "vol") && last.t !== st.volBarT && (!st.lastVolAlert || nowMs - st.lastVolAlert > 30 * 60000)) {
                st.lastVolAlert = nowMs;
                alertOnce(`${s}-vol-${last.t}`, `🔥 ${s} volume spike ${avg10 ? (last.v / avg10).toFixed(1) : "?"}×`, `${fv(last.v)}/min ${last.c >= last.o ? "↑" : "↓"}${barMove.toFixed(1)}%${openQ ? " · ≥ opening drive" : ""} @ $${fp(last.c)}`);
              }
            }
            if (volQ) st.volBarT = last.t;
            st.vwapSide = above; st.emaSide = emAbove; st.pmhBroken = pmhNow;
          }
        }
      }
      if (alertsOnRef.current) {
        const hr2 = Math.floor(nowMs / 3600000);
        for (const s of newHalt)
          if (!haltRef.current.has(s) && listSet.has(s) && !mutedRef.current.has(s) && !prefOff(s, "halt"))
            alertOnce(`${s}-halt-${hr2}`, `⛔ ${s} possible halt`, "Heavy tape went silent — no prints for 2+ min (LULD?)");
        for (const s of haltRef.current)
          if (!newHalt.includes(s) && listSet.has(s) && !mutedRef.current.has(s) && !prefOff(s, "halt"))
            alertOnce(`${s}-resume-${hr2}`, `▶ ${s} trading again`, "Prints resumed after the pause");
      }
      /* halt timers: stamp when a flag first raises, clear on resume */
      for (const s of newHalt) if (!haltRef.current.has(s)) haltAtRef.current[s] = Date.now();
      for (const s of haltRef.current) if (!newHalt.includes(s)) delete haltAtRef.current[s];
      haltRef.current = new Set(newHalt);
      setHaltedSyms(newHalt);
      /* AH TABLE: ALWAYS the top 10 by AH % across the whole market — no
         percentage floor, no volume floor. The snapshot sweep ranks; 1-min
         bars (for pool symbols) refine the %, volume and sparkline. */
      const ahTop = [];
      if (ahOn) {
        for (const c of ahCandRef.current) {
          if (ahTop.length >= 10) break;
          const info = ahAll[c.symbol];
          const pct = info ? info.pct : c.pct;
          const sc = setupScore({ pct, dayVol: info ? info.sessVol : 0 }, allBars[c.symbol], getFloat(c.symbol));
          ahTop.push({
            symbol: c.symbol, price: info ? info.price : c.price, pct,
            dayVol: info ? info.vol : c.ahVol, score: sc.score, grade: sc.grade,
            /* every row gets a Trend spark: the scan's AH bars when the symbol
               is in the pool, else the sweep-verified AH tape */
            bars: info ? info.bars : (c.ahBars && c.ahBars.length > 1 ? c.ahBars : null),
            close: info ? info.regClose : c.close, /* 4:00 PM close — the 3s price tick re-prices AH % against this */
          });
        }
        ahTop.sort((a, b) => b.pct - a.pct);
      }
      ahRef.current = ahTop.map((r) => r.symbol);
      setAhMoves(ahTop);
      setAhInfo(ahOn ? ahAll : {});
    } catch (e) {}
  }, [keys, feed, alertOnce, getFloat, prefOff]);
  useEffect(() => { ignScanRef.current = ignScan; }, [ignScan]);
  useEffect(() => {
    if (!running) return;
    ignScan();
    let lastFull = Date.now();
    /* during after hours the scan piggybacks on the 15s watchlist refresh;
       this timer covers regular hours (alerts + halts) */
    const id = setInterval(() => {
      const now = Date.now();
      if (!inAfterHours() && now - lastFull >= 60000) { lastFull = now; ignScan(); }
    }, 10000);
    return () => clearInterval(id);
  }, [running, ignScan]);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      let hot = hotRef.current;
      try {
        const mv = await alpaca("/v1beta1/screener/stocks/movers", { top: 50 }, keys);
        const extra = (mv.gainers || []).map((g) => g.symbol)
          .filter((s) => !hot.includes(s) && (!uniSetRef.current || uniSetRef.current.has(s)));
        moversRef.current = extra; /* fresh movers feed AH scanning too */
        hot = hot.concat(extra).slice(0, 45);
      } catch (e) {}
      if (hot.length === 0) return;
      const pmMode = inPremarket();
      const today = etDay(Date.now());
      const ranked = [];
      if (pmMode) {
        /* PREMARKET: the sweep already priced every candidate off the live
           premarket tape (snapshots, split-guarded) — rank straight from it.
           Re-checking 1Day bars here would erase the list again: today's
           daily bar doesn't exist yet and minDayVol is a full-day floor. */
        for (const s of hot) {
          const c = candRef.current[s];
          if (!c || !c.pm) continue;
          if (c.price < 0.03 || c.price > Number(maxPrice || 9999)) continue;
          ranked.push({ symbol: s, price: c.price, pct: c.pct, change: c.prevClose ? c.price - c.prevClose : null, dayVol: c.dayVol || 0, prevClose: c.prevClose });
        }
      } else {
        const rj = await alpaca("/v2/stocks/bars", barParams(feed, {
          symbols: hot.join(","), timeframe: "1Day", start: daysAgoISO(6), limit: 10000, adjustment: "split",
        }), keys);
        for (const s of hot) {
          const arr = (rj.bars && rj.bars[s]) || [];
          if (arr.length < 2) continue;
          const lastB = arr[arr.length - 1], prevB = arr[arr.length - 2];
          if (etDay(lastB.t) !== today) continue;
          if (!lastB.v || lastB.v < Number(minDayVol || 0)) continue;
          const prev = prevB.c, p = lastB.c;
          if (!prev || !p || p < 0.03 || p > Number(maxPrice || 9999)) continue;
          ranked.push({ symbol: s, price: p, pct: ((p - prev) / prev) * 100, change: p - prev, dayVol: lastB.v, prevClose: prev });
        }
      }
      /* HARD FLOOR: the RTH list only carries real movers, ≥25% on the day.
         (Movers-endpoint symbols used to slip in below the sweep threshold —
         that's how a +7% large cap ended up graded on your list.)
         Premarket uses its own ≥10% gap floor — 25% of the day's move often
         hasn't happened yet at 5 AM. */
      const movers25 = ranked.filter((g) => g.pct >= (pmMode ? PM_PCT_FLOOR : 25));
      movers25.sort((a, b) => b.pct - a.pct);
      watchAllRef.current = movers25.slice(0, 30).map((g) => g.symbol);
      let pool = movers25.slice(0, 25);
      const syms = pool.map((g) => g.symbol);
      if (syms.length === 0) return;
      const bj = await alpaca("/v2/stocks/bars", barParams(feed, {
        symbols: syms.join(","), timeframe: "5Min", start: todayETStartISO(SESSION_START_ET), limit: 10000,
      }), keys);
      const bm = {}, pm = {}, pmVol = {};
      for (const s of syms) {
        const arr = ((bj.bars && bj.bars[s]) || []).map(normBar);
        bm[s] = arr;
        let h = null, l = null, v = 0;
        for (const b of arr) {
          if (etDay(b.t) === today && etMinutes(b.t) < OPEN_ET_MIN) {
            h = h == null ? b.h : Math.max(h, b.h);
            l = l == null ? b.l : Math.min(l, b.l);
            v += b.v;
          }
        }
        pm[s] = { h, l };
        pmVol[s] = v;
      }
      if (pmMode) {
        /* premarket rows show PREMARKET volume, and thin tape is dropped —
           this (not the 5M full-day floor) is the premarket liquidity gate */
        for (const g of pool) g.dayVol = pmVol[g.symbol] || 0;
        pool = pool.filter((g) => g.dayVol >= PM_MIN_VOL);
        watchAllRef.current = watchAllRef.current.filter((s) => pmVol[s] == null || pmVol[s] >= PM_MIN_VOL);
      }
      for (const g of pool) {
        const flVal = getFloat(g.symbol);
        const sc = setupScore(g, bm[g.symbol], flVal);
        g.score = sc.score; g.grade = sc.grade; g.rotation = sc.rotation;
        /* float-rotation milestones: alert once per level per day (1x, 2x, 3x…) */
        const rotM = Math.floor(g.rotation || 0);
        if (rotM >= 1 && rotM <= 10 && alertsOnRef.current && !mutedRef.current.has(g.symbol) && !prefOff(g.symbol, "rot"))
          alertOnce(`${g.symbol}-rot${rotM}`, `🔄 ${g.symbol} float rotation ${rotM}×`, `${fv(g.dayVol)} traded vs ${fv(flVal)} float @ $${fp(g.price)}`);
      }
      pool.sort((a, b) => b.score - a.score || b.pct - a.pct);
      const top = pool.slice(0, 15);
      gainersRef.current = top;
      setGainers(top);
      setBarsMap(bm);
      if (inAfterHours() && ignScanRef.current) ignScanRef.current(); /* AH table updates in the same beat */
      setPmMap(pm);
      setUpdated(new Date());
      setErr("");
      /* the server monitor watches exactly this list — nothing else */
      try {
        fetch("/push/status").then((r) => r.json()).then((st2) => {
          setPushWarn(!!(st2 && st2.lastError && Date.now() - st2.lastError.t < 10 * 60000));
        }).catch(() => {});
        watchPoolRef.current = [...new Set([...top.map((x) => x.symbol), ...watchAllRef.current, ...ahRef.current])];
        syncWatch(); /* muted symbols never reach the push monitor */
      } catch (e) {}
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      busy.current = false;
    }
  }, [keys, maxPrice, feed, minDayVol, getFloat, syncWatch, alertOnce, prefOff]);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);

  /* CATALYST TAGGING: Alpaca's news feed, one batched call a minute for the
     listed symbols — latest headline per symbol + a dilution-risk flag */
  const newsTick = useCallback(async () => {
    const syms = [...new Set([...gainersRef.current.map((x) => x.symbol), ...ahRef.current])].slice(0, 40);
    if (syms.length === 0) return;
    try {
      const j = await alpaca("/v1beta1/news", { symbols: syms.join(","), limit: 50 }, keys);
      const items = j.news || [];
      if (!Array.isArray(items)) return;
      setNewsMap((prev) => {
        const map = { ...prev };
        for (const n of items) {
          const at = new Date(n.created_at || n.updated_at || 0).getTime();
          if (!at || Date.now() - at > 48 * 3600e3) continue; /* stale news is noise */
          const dil = DILUTE_RE.test(n.headline || "");
          for (const s of n.symbols || []) {
            if (!syms.includes(s)) continue;
            if (!map[s] || at > map[s].at) map[s] = { headline: n.headline, at, url: n.url || null, dilution: dil || (map[s] ? map[s].dilution : false) };
            else if (dil) map[s] = { ...map[s], dilution: true };
          }
        }
        return map;
      });
    } catch (e) {}
  }, [keys]);
  useEffect(() => {
    if (!running) return;
    newsTick();
    const id = setInterval(newsTick, 60000);
    return () => clearInterval(id);
  }, [running, newsTick]);
  useEffect(() => {
    if (!running) return;
    refresh();
    const id = setInterval(refresh, 15000); /* full re-rank + scoring */
    return () => clearInterval(id);
  }, [running, refresh]);

  /* LIVE prices: daily bars only re-aggregate ~once a minute, so the rows
     poll the real-time latest-trade endpoint instead — the main watchlist AND
     the After Hours table together in ONE batched call, every 3 seconds */
  /* custom price-cross alerts: up to 15 levels per ticker, once per level
     per direction per day, checked on the same 3s live tick */
  const checkLevels = useCallback((sym, prev, now) => {
    if (prev == null || now == null || prev === now) return;
    const p = alertPrefsRef.current[sym];
    if (!p || !p.lv || !p.lv.length || !alertsOnRef.current || mutedRef.current.has(sym)) return;
    for (const L of p.lv) {
      if ((prev - L) * (now - L) < 0)
        alertOnce(`${sym}-xlvl-${L}-${now > L ? "up" : "dn"}`, `🎯 ${sym} crossed $${fp(L)}`, `${now > L ? "Up" : "Down"} through your level — now $${fp(now)}`);
    }
  }, [alertOnce]);
  const priceTick = useCallback(async () => {
    const syms = gainersRef.current.map((g) => g.symbol);
    const all = Array.from(new Set([...syms, ...ahRef.current]));
    if (all.length === 0) return;
    try {
      const j = await alpaca("/v2/stocks/trades/latest", { symbols: all.join(","), feed: feedMode(feed).stream }, keys);
      const tr = j.trades || {};
      setGainers((prev) => {
        const next = prev.map((g) => {
          const t = tr[g.symbol];
          if (!t || !t.p) return g;
          checkLevels(g.symbol, g.price, t.p);
          const pct = g.prevClose ? ((t.p - g.prevClose) / g.prevClose) * 100 : g.pct;
          return { ...g, price: t.p, pct };
        });
        gainersRef.current = next;
        return next;
      });
      /* AH rows re-price on the same 3s beat, % vs today's 4:00 PM close */
      setAhMoves((prev) => prev.map((r) => {
        const t = tr[r.symbol];
        if (!t || !t.p) return r;
        checkLevels(r.symbol, r.price, t.p);
        const pct = r.close ? ((t.p - r.close) / r.close) * 100 : r.pct;
        return { ...r, price: t.p, pct };
      }));
      setUpdated(new Date());
    } catch (e) {}
  }, [keys, feed, checkLevels]);
  useEffect(() => {
    if (!running) return;
    priceTick();
    const id = setInterval(priceTick, 3000);
    return () => clearInterval(id);
  }, [running, priceTick]);

  const connect = async () => {
    setErr("");
    if (!keys.id.trim() || !keys.secret.trim()) { setErr("Enter both the API key ID and secret."); return; }
    try {
      await alpaca("/v2/stocks/bars", barParams(feed, {
        symbols: "AAPL", timeframe: "1Day", start: daysAgoISO(6), limit: 10, adjustment: "split",
      }), keys);
      if (remember) {
        try { await window.storage.set("alpaca-keys", JSON.stringify({ ...keys, maxPrice, feed, minDayVol, ver: 3 })); } catch {}
        try {
          fetch("/settings", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: keys.id.trim(), secret: keys.secret.trim(), feed, maxPrice, minDayVol, alertsOn }),
          }).catch(() => {});
        } catch {}
      }
      setRunning(true);
    } catch (e) {
      setErr("Couldn't authenticate: " + String(e.message || e));
    }
  };

  /* rows go straight to the Advanced detail view */
  const openAdvanced = useCallback((s) => setSelected(s), []);
  const selG = gainers.find((g) => g.symbol === selected);
  const sel = selected ? selG || { symbol: selected, pct: null } : null;
  const pmNow = inPremarket(); /* re-evaluated on every render (3s price ticks) */
  /* push follow-through headline: % of pushes green 15 minutes later. Below
     10 pushes the sample cannot support a verdict, so it renders neutral. */
  const jThin = !jStats || !jStats.n || jStats.n < 10;
  const jHit = jStats && jStats.n ? Math.round(jStats.green15) : null;
  const jHitCol = jThin ? C.muted : jHit >= 50 ? C.up : C.down;
  const inputStyle = { width: "100%", boxSizing: "border-box", marginTop: 5, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, padding: "10px 10px", fontFamily: MONO, fontSize: 14 };
  const labStyle = { fontSize: 11, color: C.dim, textTransform: "uppercase", letterSpacing: 1 };
  const globalCss = `.noscrollbar::-webkit-scrollbar{display:none}.noscrollbar{scrollbar-width:none}canvas{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}.chartbox,.chartbox *{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}`;

  if (!running) {
    return (
      <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "system-ui, sans-serif", display: "grid", placeItems: "center", padding: 20 }}>
        <style>{globalCss}</style>
        <div style={{ width: "100%", maxWidth: 460 }}>
          <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: 2, color: C.amber, marginBottom: 8 }}>PREMARKET // 04:00 ET</div>
          <h1 style={{ fontSize: 26, fontWeight: 800, margin: "0 0 6px" }}>Momentum Gainers</h1>
          <p style={{ color: C.muted, fontSize: 13, lineHeight: 1.5, margin: "0 0 20px" }}>
            Full-market sweep, ranked by setup score (float rotation, VWAP,
            EMA stack, Supertrend, momentum, volume surge) — with lock-screen
            push alerts via the server monitor.
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 10, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 16px", marginBottom: 12, fontSize: 12 }}>
            {account ? (
              <>
                <span style={{ color: C.up, fontWeight: 700 }}>●</span>
                <span style={{ color: C.muted, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{acctLabel(account)}</span>
                <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 800, letterSpacing: 1, color: account.plan === "pro" ? C.amber : C.dim, border: `1px solid ${account.plan === "pro" ? C.amber + "66" : C.border}`, borderRadius: 4, padding: "1px 5px", flexShrink: 0 }}>{account.plan === "pro" ? "PRO" : "FREE"}</span>
                <div style={{ flex: 1 }} />
                <span onClick={() => setAcctOpen(true)} style={{ color: C.dim, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 3, flexShrink: 0 }}>Plan</span>
                <span onClick={() => saveAccount(null)} style={{ color: C.dim, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 3, flexShrink: 0 }}>Sign out</span>
              </>
            ) : (
              <>
                <span style={{ color: C.muted }}>Not signed in</span>
                <div style={{ flex: 1 }} />
                <span onClick={() => setAcctOpen(true)} style={{ color: C.amber, cursor: "pointer", fontWeight: 700 }}>Create account →</span>
              </>
            )}
          </div>
          <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
            {srvCfg && srvCfg.serverKeys ? (
              /* SERVER-KEYS MODE: live data is included — no API keys, ever */
              <>
                <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
                  <span style={{ color: C.up, fontWeight: 700 }}>✓ Live market data included</span> — no API keys needed on this server.
                </div>
                {srvCfg.invite && (
                  <label style={labStyle}>Access code
                    <input value={invite} onChange={(e) => setInvite(e.target.value)} autoCapitalize="none" style={inputStyle} />
                  </label>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <label style={labStyle}>Max price ($)
                    <input type="number" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} style={inputStyle} />
                  </label>
                  <label style={labStyle}>Min day volume
                    <input type="number" value={minDayVol} onChange={(e) => setMinDayVol(e.target.value)} style={inputStyle} />
                  </label>
                </div>
                <button onClick={connectServer}
                  style={{ background: C.amber, color: "#06090D", border: "none", borderRadius: 6, padding: "12px 0", fontWeight: 800, fontSize: 14, cursor: "pointer" }}>
                  Start scanning
                </button>
              </>
            ) : (
              <>
                <label style={labStyle}>API key ID
                  <input value={keys.id} onChange={(e) => setKeys((k) => ({ ...k, id: e.target.value }))} style={inputStyle} />
                </label>
                <label style={labStyle}>API secret
                  <input type="password" value={keys.secret} onChange={(e) => setKeys((k) => ({ ...k, secret: e.target.value }))} style={inputStyle} />
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <label style={labStyle}>Max price ($)
                    <input type="number" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} style={inputStyle} />
                  </label>
                  <label style={labStyle}>Min day volume
                    <input type="number" value={minDayVol} onChange={(e) => setMinDayVol(e.target.value)} style={inputStyle} />
                  </label>
                </div>
                <label style={labStyle}>Data feed
                  <select value={feed} onChange={(e) => setFeed(e.target.value)} style={inputStyle}>
                    <option value="sip">SIP real-time, full market (paid Algo Trader Plus)</option>
                    <option value="sip_delayed">Full market, 15-min delayed (free)</option>
                    <option value="iex">IEX real-time (free — partial volume)</option>
                  </select>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: C.muted, cursor: "pointer" }}>
                  <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                  Remember keys on this device
                </label>
                <button onClick={connect}
                  style={{ background: C.amber, color: "#06090D", border: "none", borderRadius: 6, padding: "12px 0", fontWeight: 800, fontSize: 14, cursor: "pointer" }}>
                  Start scanning
                </button>
              </>
            )}
            {err && <div style={{ color: C.down, fontSize: 12, fontFamily: MONO }}>{err}</div>}
          </div>
          <div style={{ marginTop: 14, display: "flex", gap: 16, fontSize: 12, color: C.dim }}>
            <span onClick={openHelp} style={{ cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 3 }}>▶ Watch the walkthrough</span>
            <span onClick={() => setAboutOpen(true)} style={{ cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 3 }}>ⓘ How this works</span>
          </div>
        </div>
        {onboardOpen && <OnboardSlides mode={onboardMode} onDone={finishOnboard} onSkip={finishOnboard} />}
        {acctOpen && !onboardOpen && <AccountFlow onDone={(a) => { saveAccount(a); setAcctOpen(false); }} onSkip={() => setAcctOpen(false)} />}
        {aboutOpen && <AboutPage onClose={() => setAboutOpen(false)} />}
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "system-ui, sans-serif" }}>
      <style>{globalCss}</style>
      <div style={{ position: "sticky", top: 0, zIndex: 10, background: C.bg + "F2", backdropFilter: "blur(6px)", borderBottom: `1px solid ${C.border}`, padding: "10px 14px", paddingTop: "calc(10px + env(safe-area-inset-top))", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 2, color: C.amber }}>RANKED BY SETUP SCORE</div>
          <div style={{ fontSize: 17, fontWeight: 800, display: "flex", alignItems: "center", gap: 8 }}>
            Momentum Scanner
            {account && account.plan === "pro" && (
              <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 800, letterSpacing: 1, color: C.amber, border: `1px solid ${C.amber}66`, borderRadius: 4, padding: "1px 5px" }}>PRO</span>
            )}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: MONO, fontSize: 11, color: C.dim }}>
          {pmNow
            ? `PREMARKET · ≤$${maxPrice} · ≥${fv(PM_MIN_VOL)} PM vol · ≥${PM_PCT_FLOOR}% gap · ${found} movers`
            : `≤$${maxPrice} · ≥${fv(minDayVol)} vol · ≥25% day · ${found} movers`} · {feedMode(feed).short} · {updated ? `upd ${ftime(updated)} ET` : "loading…"}
        </span>
        <button onClick={toggleAlerts} aria-label={alertsOn ? "alerts on — tap to switch off" : "alerts off — tap to switch on"}
          style={{ background: alertsOn ? C.amber + "22" : "transparent", border: `1px solid ${alertsOn ? C.amber : C.border}`, color: alertsOn ? C.amber : C.muted, borderRadius: 8, height: 44, padding: "0 14px", cursor: "pointer", fontSize: 12, fontFamily: MONO, display: "flex", alignItems: "center", gap: 6, touchAction: "manipulation" }}>
          <BellIcon muted={!alertsOn} /> {alertsOn ? (pushArmed ? "Lock-screen" : "On") : "Off"}
        </button>
        <button onClick={() => setAlertCenter(true)}
          aria-label={jHit == null ? "push follow-through: no pushes recorded yet" : `push follow-through: ${jHit}% green 15 minutes after the push, ${jStats.n} pushes over 20 days`}
          title="how the last 20 days of pushes actually followed through"
          style={{ background: "transparent", border: `1px solid ${jThin ? C.border : jHitCol + "55"}`, color: C.dim, borderRadius: 8, height: 44, padding: "0 12px", cursor: "pointer", fontFamily: MONO, fontSize: 12, display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap", touchAction: "manipulation" }}>
          <span style={{ fontSize: 9, letterSpacing: 1.2 }}>HIT</span>
          <span style={{ fontWeight: 800, color: jHit == null ? C.dim : jHitCol }}>{jHit == null ? "—" : jHit + "%"}</span>
        </button>
        <button onClick={openHelp} aria-label="watch the feature walkthrough" title="feature walkthrough"
          style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.muted, borderRadius: 8, height: 44, minWidth: 44, padding: 0, cursor: "pointer", fontSize: 13, fontFamily: MONO, display: "grid", placeItems: "center", touchAction: "manipulation" }}>
          ?
        </button>
        <button onClick={() => setAboutOpen(true)} aria-label="how this works and disclosures" title="how this works"
          style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.muted, borderRadius: 8, height: 44, minWidth: 44, padding: 0, cursor: "pointer", fontSize: 13, fontFamily: MONO, display: "grid", placeItems: "center", touchAction: "manipulation" }}>
          ⓘ
        </button>
        <button onClick={() => setRunning(false)}
          style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.muted, borderRadius: 8, height: 44, padding: "0 14px", cursor: "pointer", fontSize: 13, touchAction: "manipulation" }}>
          Settings
        </button>
      </div>

      {err && (
        <div style={{ margin: "12px 14px 0", padding: "8px 12px", background: C.down + "15", border: `1px solid ${C.down}55`, borderRadius: 6, color: C.down, fontSize: 12, fontFamily: MONO }}>
          {err}
        </div>
      )}
      {alertLog.length > 0 && (
        <div
          onClick={() => { if (Math.abs(bannerX) < 10) setAlertCenter(true); }}
          onTouchStart={(e) => { bannerTouchRef.current = { x: e.touches[0].clientX, dx: 0 }; }}
          onTouchMove={(e) => {
            const tr = bannerTouchRef.current;
            if (!tr) return;
            tr.dx = e.touches[0].clientX - tr.x;
            if (tr.dx < 0) setBannerX(tr.dx);
          }}
          onTouchEnd={() => {
            if ((bannerTouchRef.current && bannerTouchRef.current.dx) < -70) setAlertLog([]);
            setBannerX(0);
            bannerTouchRef.current = null;
          }}
          style={{ margin: "12px 14px 0", padding: "8px 12px", background: "#231A0A", border: `1px solid ${C.amber}66`, borderRadius: 8, cursor: "pointer",
                   transform: `translateX(${bannerX}px)`, opacity: 1 + bannerX / 200, transition: bannerX === 0 ? "transform 180ms ease, opacity 180ms ease" : "none" }}>
          <div style={{ fontFamily: MONO, fontSize: 9, color: C.amber, letterSpacing: 1 }}>
            🔔 {ftime(alertLog[0].t)} ET · {alertLog.length} alert{alertLog.length > 1 ? "s" : ""} · tap: history · swipe ←: clear
          </div>
          <div style={{ fontSize: 13, fontWeight: 700 }}>{alertLog[0].title}</div>
          <div style={{ fontSize: 11, color: C.muted }}>{alertLog[0].body}</div>
        </div>
      )}
      {pushWarn && (
        <div style={{ margin: "8px 14px 0", padding: "6px 12px", border: `1px dashed ${C.amber}66`, borderRadius: 6, color: C.amber, fontSize: 11, fontFamily: MONO }}>
          ⚠ lock-screen push is failing — toggle the 🔔 bell off and on to re-arm
        </div>
      )}
      {alertCenter && (
        <div onClick={() => setAlertCenter(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)", zIndex: 60, display: "flex", alignItems: "flex-end" }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: "100%", maxHeight: "78dvh", background: C.panel, borderTop: `1px solid ${C.amber}66`, borderRadius: "14px 14px 0 0", display: "flex", flexDirection: "column", paddingBottom: "env(safe-area-inset-bottom)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: `1px solid ${C.border}` }}>
              <span style={{ color: C.amber, display: "flex" }}><BellIcon size={14} /></span>
              <span style={{ fontFamily: MONO, fontSize: 11, letterSpacing: 1.5, color: C.amber, textTransform: "uppercase" }}>Alerts</span>
              <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>{alertLog.length} today</span>
              <div style={{ flex: 1 }} />
              <button onClick={() => setAlertLog([])} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.dim, borderRadius: 6, padding: "5px 10px", fontFamily: MONO, fontSize: 10, cursor: "pointer" }}>Clear all</button>
              <button onClick={() => setAlertCenter(false)} style={{ background: C.amber + "1A", border: `1px solid ${C.amber}66`, color: C.amber, borderRadius: 6, padding: "5px 12px", fontFamily: MONO, fontSize: 10, fontWeight: 700, cursor: "pointer" }}>Close</button>
            </div>
            <div style={{ padding: "12px 16px 14px", borderBottom: `1px solid ${C.border}` }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: jStats && jStats.n > 0 ? 10 : 6 }}>
                <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 1.4, color: C.amber, textTransform: "uppercase" }}>Push follow-through</span>
                <div style={{ flex: 1 }} />
                {jStats && jStats.n > 0 && (
                  <span style={{ fontFamily: MONO, fontSize: 9, color: C.dim, whiteSpace: "nowrap" }}>{jStats.n} push{jStats.n === 1 ? "" : "es"} · 20 days</span>
                )}
              </div>
              {jStats && jStats.n > 0 ? (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                    {[
                      ["Green at 15m", jHit + "%", jThin ? C.text : jHit >= 50 ? C.up : C.down],
                      ["Avg at 15m", (jStats.avg15 >= 0 ? "+" : "") + jStats.avg15.toFixed(1) + "%", jStats.avg15 >= 0 ? C.up : C.down],
                      ["Avg peak 30m", jStats.avgMaxUp30 != null ? "+" + jStats.avgMaxUp30.toFixed(1) + "%" : "—", C.text],
                    ].map(([label, value, col]) => (
                      <div key={label}>
                        <div style={{ fontFamily: MONO, fontSize: 17, fontWeight: 700, color: col, lineHeight: 1.15 }}>{value}</div>
                        <div style={{ fontSize: 8.5, letterSpacing: 0.8, color: C.dim, textTransform: "uppercase", marginTop: 3 }}>{label}</div>
                      </div>
                    ))}
                  </div>
                  {jThin && (
                    <div style={{ marginTop: 8, fontSize: 10, color: C.muted, lineHeight: 1.4 }}>
                      Thin sample. Under 10 pushes these numbers move too much to tune against.
                    </div>
                  )}
                  {jStats.tier2 && jStats.tier3 && jStats.tier2.n > 0 && jStats.tier3.n > 0 && (
                    <div style={{ marginTop: 10, paddingTop: 8, borderTop: `1px solid ${C.border}66`, display: "flex", gap: 16, fontFamily: MONO, fontSize: 10, color: C.muted }}>
                      <span>Setup <b style={{ color: C.text, fontWeight: 700 }}>{Math.round(jStats.tier2.green15)}%</b> <span style={{ color: C.dim }}>({jStats.tier2.n})</span></span>
                      <span>Breakout <b style={{ color: C.text, fontWeight: 700 }}>{Math.round(jStats.tier3.green15)}%</b> <span style={{ color: C.dim }}>({jStats.tier3.n})</span></span>
                    </div>
                  )}
                </>
              ) : (
                <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5 }}>
                  No pushes recorded yet. Every confluence push is logged with the price 5, 15 and 30 minutes later, and the rate appears here once they land.
                </div>
              )}
            </div>
            <div style={{ overflowY: "auto", flex: 1 }}>
              {alertLog.length === 0 && <div style={{ padding: 20, color: C.dim, fontFamily: MONO, fontSize: 12 }}>No alerts yet today.</div>}
              {alertLog.map((a, i) => (
                <div key={a.t + "-" + i} style={{ padding: "10px 16px", borderBottom: `1px solid ${C.border}66` }}>
                  <div style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>{ftime(a.t)} ET</div>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{a.title}</div>
                  <div style={{ fontSize: 11, color: C.muted }}>{a.body}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {feedMode(feed).delayMs > 0 && (
        <div style={{ margin: "12px 14px 0", padding: "8px 12px", border: `1px dashed ${C.border}`, borderRadius: 8, color: C.dim, fontSize: 11 }}>
          🔔 Trigger alerts need a real-time feed — switch to SIP real-time in Settings.
        </div>
      )}

      {/* ranked watchlist table — stretches to fill the phone screen */}
      <div style={{ margin: "12px 14px", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
        <div className="noscrollbar" style={{ display: "flex", gap: mobile ? 6 : 10, padding: "7px 12px", borderBottom: `1px solid ${C.border}`, fontFamily: MONO, fontSize: 9, letterSpacing: 1, color: C.dim, textTransform: "uppercase" }}>
          <span style={{ minWidth: 40 }}>Rank</span>
          <span style={{ minWidth: mobile ? 50 : 54 }}>Ticker</span>
          <span style={{ minWidth: mobile ? 52 : 56 }}>Price</span>
          <span style={{ minWidth: mobile ? 62 : 66 }}>% Day</span>
          <span style={{ minWidth: mobile ? 42 : 48 }}>Vol</span>
          <div style={{ flex: 1 }} />
          <span>Trend</span>
        </div>
        {gainers.length === 0 && !err && (
          <div style={{ color: C.dim, fontFamily: MONO, fontSize: 13, padding: "12px" }}>
            {note
              ? "sweeping the tape… results appear as the scan progresses"
              : pmNow
              ? `No premarket gappers ≥${PM_PCT_FLOOR}% under $${maxPrice} yet — watching the 4:00 AM tape; the list fills itself as movers print.`
              : `No gainers ≥25% under $${maxPrice} found yet — the sweep re-runs automatically.`}
          </div>
        )}
        {gainers.map((g) => (
          <GainerRow key={g.symbol} g={g} bars={barsMap[g.symbol]} halted={haltedSyms.includes(g.symbol)} haltedAt={haltAtRef.current[g.symbol]} news={newsMap[g.symbol]} onOpen={openAdvanced} fill={mobile} ah={ahInfo[g.symbol]} muted={mutedSyms.includes(g.symbol)} onMute={toggleMute} />
        ))}
      </div>

      {ahMoves.length > 0 && (
        <div style={{ margin: "12px 14px 0", background: C.panel, border: `1px solid ${C.ema21}66`, borderRadius: 10, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: `1px solid ${C.ema21}33` }}>
            <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1.5, color: C.ema21, textTransform: "uppercase" }}>🌙 After hours</span>
            <span style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>top 10 by AH % · whole market · real tape only, ≥{fv(AH_MIN_VOL)} AH shares · live 3s</span>
          </div>
          <div className="noscrollbar" style={{ display: "flex", gap: mobile ? 6 : 10, padding: "7px 12px", borderBottom: `1px solid ${C.border}`, fontFamily: MONO, fontSize: 9, letterSpacing: 1, color: C.dim, textTransform: "uppercase" }}>
            <span style={{ minWidth: 40 }}>Rank</span>
            <span style={{ minWidth: mobile ? 50 : 54 }}>Ticker</span>
            <span style={{ minWidth: mobile ? 52 : 56 }}>Price</span>
            <span style={{ minWidth: mobile ? 62 : 66 }}>% AH</span>
            <span style={{ minWidth: mobile ? 42 : 48 }}>Vol</span>
            <div style={{ flex: 1 }} />
            <span>Trend</span>
          </div>
          {ahMoves.map((r) => (
            <GainerRow key={r.symbol} g={r} bars={r.bars} halted={haltedSyms.includes(r.symbol)} haltedAt={haltAtRef.current[r.symbol]} news={newsMap[r.symbol]} onOpen={openAdvanced} fill={mobile} muted={mutedSyms.includes(r.symbol)} onMute={toggleMute} />
          ))}
        </div>
      )}


      {note && !err && (
        <div style={{ padding: "0 14px 10px", color: C.dim, fontSize: 10, fontFamily: MONO }}>
          {note}
        </div>
      )}
      <div style={{ padding: "2px 14px 18px", color: C.dim, fontSize: 11, fontFamily: MONO }}>
        Not financial advice ·{" "}
        <span onClick={() => setAboutOpen(true)} style={{ cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 3 }}>
          ⓘ how this works
        </span>
      </div>

      {onboardOpen && <OnboardSlides mode={onboardMode} onDone={finishOnboard} onSkip={finishOnboard} />}
      {aboutOpen && <AboutPage onClose={() => setAboutOpen(false)} />}
      {sel && (
        <AdvancedChart
          symbol={sel.symbol}
          keys={keys}
          feed={feed}
          plans={!!(srvCfg && srvCfg.plans)}
          g={sel}
          pm={pmMap[sel.symbol]}
          news={newsMap[sel.symbol]}
          prefs={{ ...(alertPrefsRef.current[sel.symbol] || { off: [], lv: [] }), v: alertPrefsVer }}
          onTogglePref={setPref}
          onSetLevels={setLevels}
          onClose={() => setSelected(null)}
          onAlert={chartAlert}
        />
      )}
    </div>
  );
}
