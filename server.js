/* Premarket Momentum Scanner — server (Node 18+, ZERO npm dependencies)
   - Serves the app (index.html), service worker, manifest, icon
   - Proxies Alpaca data + trading APIs past browser CORS
   - Web Push (VAPID ES256 + RFC8291 aes128gcm) implemented with node:crypto
   - Server-side trigger monitor => lock-screen alerts while the app is closed:
       VWAP cross up · EMA 8/21 bull cross · premarket-high break ·
       volume >= opening 9:30/9:31 candles · 2x volume surge · possible halt
   - /float/:sym — best-effort float lookup via Yahoo (cached 24h)
   NOTE: on Render's free tier the service sleeps when idle; keep it pinged
   (e.g. cron-job.org hitting /health every 5 min) or use a paid instance
   so the monitor can run while your phone is locked.
   Run: node server.js  →  http://localhost:8787
*/
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8787;
/* upstream feed is overridable so the whole stack stays feed-agnostic —
   swapping Alpaca for a licensed vendor later is an env change here */
const DATA = process.env.ALPACA_DATA_URL || "https://data.alpaca.markets";
const TRADING = process.env.ALPACA_TRADING_URL || "https://paper-api.alpaca.markets";
const ROUTES = { "/alpaca": DATA, "/trading": TRADING };
const SUBS_FILE = "/tmp/scanner-subs.json";
const DEVICES_FILE = "/tmp/scanner-devices.json";

/* SERVER-KEYS MODE (Phase 1 of the App Store plan): when both APCA_* env
   vars are set on the server, users never enter API keys — the proxy
   injects the server's credentials, access is gated by an invite code plus
   a per-device id, and each device keeps its own watchlist + push routing.
   With the env vars unset, everything behaves exactly as before (each
   client brings its own keys). */
const SERVER_KEYS = !!(process.env.APCA_API_KEY_ID && process.env.APCA_API_SECRET_KEY);
const INVITE_CODE = process.env.INVITE_CODE || "";
const SERVER_FEED = process.env.SERVER_FEED === "iex" ? "iex" : "sip";
const MAX_DEVICES = Number(process.env.MAX_DEVICES || 500);
const OPEN_ET_MIN = 9 * 60 + 30;

/* ============================ small utils ============================ */
const b64u = (b) => Buffer.from(b).toString("base64url");
const fromB64u = (s) => Buffer.from(s, "base64url");
const fp = (v) => (v == null || isNaN(v) ? "—" : Number(v).toFixed(v >= 1 ? 2 : 4));
const fv = (v) => (v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? (v / 1e3).toFixed(1) + "K" : String(Math.round(v || 0)));
const etDay = (t) => new Date(t).toLocaleDateString("en-US", { timeZone: "America/New_York" });
const etMinutes = (t) => {
  const s = new Date(t).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" });
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};
function fetchJSON(url, headers) {
  return fetch(url, { headers }).then(async (r) => {
    if (!r.ok) throw new Error(r.status + ": " + (await r.text()).slice(0, 120));
    return r.json();
  });
}

/* ============================ VAPID keys ============================ */
let vapid;
function loadVapid() {
  if (process.env.VAPID_PRIVATE_JWK && process.env.VAPID_PUBLIC_RAW) {
    const priv = crypto.createPrivateKey({ key: JSON.parse(process.env.VAPID_PRIVATE_JWK), format: "jwk" });
    vapid = { priv, pubRaw: fromB64u(process.env.VAPID_PUBLIC_RAW) };
    console.log("VAPID keys loaded from env.");
    return;
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const pubRaw = Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]);
  vapid = { priv: privateKey, pubRaw };
  const privJwk = JSON.stringify(privateKey.export({ format: "jwk" }));
  console.log("\n*** Generated new VAPID keys (subscriptions reset on every restart). ***");
  console.log("To persist them, add these environment variables in Render:");
  console.log("VAPID_PRIVATE_JWK=" + privJwk);
  console.log("VAPID_PUBLIC_RAW=" + b64u(pubRaw) + "\n");
}
loadVapid();

function vapidJWT(audience) {
  const hdr = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const pay = b64u(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: "mailto:alerts@cornerpostweb.com",
  }));
  const sig = crypto.sign("sha256", Buffer.from(hdr + "." + pay), { key: vapid.priv, dsaEncoding: "ieee-p1363" });
  return hdr + "." + pay + "." + b64u(sig);
}

/* ================= RFC 8291 payload encryption (aes128gcm) ================= */
function encryptPayload(clientPubB64u, authB64u, plaintext) {
  const clientPub = fromB64u(clientPubB64u);
  const auth = fromB64u(authB64u);
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const serverPub = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(clientPub);
  const salt = crypto.randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), clientPub, serverPub]);
  const prk = Buffer.from(crypto.hkdfSync("sha256", shared, auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", prk, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", prk, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const padded = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]); // 0x02 = last record delimiter
  const ct = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.concat([
    salt,
    Buffer.from([0, 0, 16, 0]),     // rs = 4096
    Buffer.from([serverPub.length]),
    serverPub,
  ]);
  return Buffer.concat([header, ct]);
}

function sendPush(sub, payloadObj) {
  return new Promise((resolve) => {
    try {
      const url = new URL(sub.endpoint);
      const body = encryptPayload(sub.keys.p256dh, sub.keys.auth, JSON.stringify(payloadObj));
      const jwt = vapidJWT(url.origin);
      const req2 = https.request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          TTL: "120",
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          "Content-Length": body.length,
          Authorization: `vapid t=${jwt}, k=${b64u(vapid.pubRaw)}`,
        },
      }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req2.on("error", () => resolve(0));
      req2.end(body);
    } catch (e) { resolve(0); }
  });
}

/* ============================ subscriptions ============================ */
let subs = [];   // [{ sub, keys:{id,secret}, feed }]
let watch = [];  // the app's current ranked list — the ONLY symbols monitored
try {
  const saved = JSON.parse(fs.readFileSync(SUBS_FILE, "utf8"));
  if (Array.isArray(saved)) subs = saved;
  else { subs = saved.subs || []; watch = saved.watch || []; }
} catch (e) {}
function saveSubs() { try { fs.writeFileSync(SUBS_FILE, JSON.stringify({ subs, watch })); } catch (e) {} }
let lastPushErr = null;
async function broadcast(title, bodyTxt, key) {
  const dead = [];
  for (const s of subs) {
    const code = await sendPush(s.sub, { title, body: bodyTxt, key: key || "" });
    if (code >= 400 && code !== 404 && code !== 410) lastPushErr = { t: Date.now(), code };
    if (code === 404 || code === 410) dead.push(s.sub.endpoint);
  }
  if (dead.length) { subs = subs.filter((s) => !dead.includes(s.sub.endpoint)); saveSubs(); }
}

/* ============================ per-device accounts (server-keys mode) ==== */
let devices = {}; // id -> { symbols: [], sub: push subscription|null, t }
try { devices = JSON.parse(fs.readFileSync(DEVICES_FILE, "utf8")) || {}; } catch (e) {}
function saveDevices() { try { fs.writeFileSync(DEVICES_FILE, JSON.stringify(devices)); } catch (e) {} }
const deviceOk = (id) => !!(id && typeof id === "string" && devices[id]);
function watchUnion() {
  const set = new Set(watch);
  for (const d of Object.values(devices)) for (const s of d.symbols || []) set.add(s);
  return [...set];
}
/* route an alert by INTEREST: the legacy shared list broadcasts as before;
   claimed devices are pushed only for symbols on their own watchlist */
async function sendAlert(sym, title, bodyTxt, key) {
  if (watch.includes(sym)) await broadcast(title, bodyTxt, key);
  let changed = false;
  for (const d of Object.values(devices)) {
    if (!d.sub || !(d.symbols || []).includes(sym)) continue;
    const code = await sendPush(d.sub, { title, body: bodyTxt, key: key || "" });
    if (code >= 400 && code !== 404 && code !== 410) lastPushErr = { t: Date.now(), code };
    if (code === 404 || code === 410) { d.sub = null; changed = true; }
  }
  if (changed) saveDevices();
}

/* ============================ float lookup ============================ */
const floatCache = {}; // sym -> { v, t }
let yCookie = null, yCrumb = null, yAuthAt = 0;
async function yahooAuth() {
  if (yCrumb && Date.now() - yAuthAt < 3600e3) return;
  const r = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": "Mozilla/5.0" } }).catch(() => null);
  yCookie = r && r.headers.get("set-cookie") ? r.headers.get("set-cookie").split(";")[0] : null;
  if (yCookie) {
    const c = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": "Mozilla/5.0", Cookie: yCookie },
    }).catch(() => null);
    yCrumb = c && c.ok ? await c.text() : null;
  }
  yAuthAt = Date.now();
}
async function getFloat(sym) {
  const c = floatCache[sym];
  if (c && Date.now() - c.t < 24 * 3600e3) return c.v;
  let v = null;
  try {
    await yahooAuth();
    if (yCrumb) {
      const j = await fetchJSON(
        `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=defaultKeyStatistics&crumb=${encodeURIComponent(yCrumb)}`,
        { "User-Agent": "Mozilla/5.0", Cookie: yCookie }
      );
      const ks = j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0];
      const f = ks && ks.defaultKeyStatistics && ks.defaultKeyStatistics.floatShares;
      v = f && f.raw ? f.raw : null;
    }
  } catch (e) {}
  floatCache[sym] = { v, t: Date.now() };
  return v;
}

/* ============================ trigger monitor ============================ */
/* Pure function so it's unit-testable: takes 1-min session bars, returns triggers. */
function computeTriggers(sym, arr, st, nowMs) {
  /* Transition-only + live-only semantics:
     - The FIRST observation of a symbol establishes a silent baseline.
       Nothing that already happened earlier in the day is ever replayed.
     - Signals only fire when (a) the state CHANGED versus the last
       observation and (b) the latest bar is current (< 2 min old). */
  const out = [];
  if (!arr || arr.length === 0) return out;
  /* if we stopped observing this symbol for a while (left the watchlist,
     server slept), silently re-baseline — never fire on state that changed
     while nobody was watching */
  if (st.init && st.lastSeen && nowMs - st.lastSeen > 180000) st.init = false;
  st.lastSeen = nowMs;
  const last = arr[arr.length - 1];
  const fresh = nowMs - last.t < 120000;
  /* HALT: only when the bars immediately before the silence were heavy AND
     the tape was moving hard into it (LULD needs a violent move) — a thin
     small-cap going quiet over lunch is not a halt */
  const gapMs = nowMs - last.t;
  let preHeavy = false, preMove = 0;
  if (arr.length >= 6) {
    const l3 = arr.slice(-3);
    preHeavy = l3.every((b) => b.v >= 20000) && l3.reduce((a, b) => a + b.v, 0) / 3 >= 30000;
    const back = arr[arr.length - 6];
    preMove = Math.abs((last.c - back.o) / (back.o || 1)) * 100;
  }
  const halted = gapMs > 150000 && preHeavy && preMove >= 3;
  const canFire = !!st.init;
  if (canFire && halted && !st.halted)
    out.push({ key: `${sym}-halt-${Math.floor(nowMs / 36e5)}`, title: `⛔ ${sym} possible halt`, body: "Heavy tape went silent — no prints for 2+ min (LULD?)" });
  if (canFire && !halted && st.halted)
    out.push({ key: `${sym}-resume-${Math.floor(nowMs / 36e5)}`, title: `▶ ${sym} trading again`, body: "Prints resumed after the pause" });
  st.halted = halted;
  if (arr.length < 8) { st.init = true; return out; }
  const closes = arr.map((b) => b.c);
  const p = last.c;
  let pv = 0, vv = 0;
  for (const b of arr) { pv += ((b.h + b.l + b.c) / 3) * b.v; vv += b.v; }
  const vw = vv ? pv / vv : p;
  const above = p > vw;
  const ema = (n) => { const k = 2 / (n + 1); let e = null; for (const c of closes) e = e === null ? c : c * k + e * (1 - k); return e; };
  const emAbove = ema(8) > ema(21);
  let pmH = null; const opens = [];
  for (const b of arr) {
    const m = etMinutes(b.t);
    if (m < OPEN_ET_MIN) pmH = pmH == null ? b.h : Math.max(pmH, b.h);
    if (m >= OPEN_ET_MIN && m < OPEN_ET_MIN + 10) opens.push(b.v); /* first ten 9:30 candles */
  }
  const pmhNow = pmH != null && etMinutes(last.t) >= OPEN_ET_MIN && p > pmH;
  /* ---- ONE unified volume signal ----
     Spike: ≥3× 10-min avg, biggest bar in 30 min, ≥100k shares, ≥1% thrust.
     Opening-drive comparison only counts against a REAL opening drive
     (9:30/9:31 candles themselves ≥100k) — matching a quiet open means nothing.
     Dedup: each bar can fire at most once EVER (keyed by bar timestamp),
     one volume alert per symbol per 30 min, and the baseline pass consumes
     any bar that already qualifies. */
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
    st.init = true;
    st.vwapSide = above; st.emaSide = emAbove; st.pmhBroken = pmhNow;
    if (volQ) st.volBarT = last.t; /* consume: this already happened */
    return out; /* baseline pass: record states, fire nothing */
  }
  if (fresh) {
    if (st.vwapSide === false && above)
      out.push({ key: `${sym}-vwapx`, title: `🚨 ${sym} reclaimed VWAP`, body: `Crossed above $${fp(vw)} · now $${fp(p)}` });
    if (st.emaSide === false && emAbove)
      out.push({ key: `${sym}-emax`, title: `🚨 ${sym} 8/21 EMA bull cross`, body: `EMA 8 crossed above EMA 21 · $${fp(p)}` });
    if (!st.pmhBroken && pmhNow)
      out.push({ key: `${sym}-pmh`, title: `🚨 ${sym} broke premarket high`, body: `Through PMH $${fp(pmH)} · now $${fp(p)}` });
    const last3 = arr.slice(-3);
    const before3 = arr.length >= 4 ? arr[arr.length - 4] : null;
    const streak3 = last3.length === 3 && last3.every((b) => b.c > b.o) && (!before3 || before3.c <= before3.o);
    if (streak3 && (!st.lastMom3 || nowMs - st.lastMom3 > 15 * 60000)) {
      st.lastMom3 = nowMs;
      const runPct = ((last.c - last3[0].o) / last3[0].o) * 100;
      out.push({ key: `${sym}-mom3-${last.t}`, title: `📈 ${sym} 3 green candles in a row`, body: `$${fp(last3[0].o)} → $${fp(last.c)} (+${runPct.toFixed(1)}%) on 1-min` });
    }
    if (volQ && last.t !== st.volBarT && (!st.lastVolAlert || nowMs - st.lastVolAlert > 30 * 60000)) {
      st.lastVolAlert = nowMs;
      const mult = avg10 ? (last.v / avg10).toFixed(1) : "?";
      out.push({
        key: `${sym}-vol-${last.t}`,
        title: `🔥 ${sym} volume spike ${mult}×`,
        body: `${fv(last.v)}/min ${last.c >= last.o ? "↑" : "↓"}${barMove.toFixed(1)}%${openQ ? " · ≥ opening drive" : ""} @ $${fp(last.c)}`,
      });
    }
  }
  if (volQ) st.volBarT = last.t; /* a seen qualifying bar never fires again */
  st.vwapSide = above; st.emaSide = emAbove; st.pmhBroken = pmhNow;
  return out;
}

const MONSTATE_FILE = "/tmp/scanner-monstate.json";
const monState = { fired: new Set(), sym: {}, day: null };
try {
  const ms = JSON.parse(fs.readFileSync(MONSTATE_FILE, "utf8"));
  monState.day = ms.day || null;
  monState.fired = new Set(ms.fired || []);
  monState.sym = ms.sym || {};
  console.log("monitor state restored:", monState.fired.size, "fired keys");
} catch (e) {}
function saveMonState() {
  try {
    fs.writeFileSync(MONSTATE_FILE, JSON.stringify({
      day: monState.day, fired: [...monState.fired].slice(-800), sym: monState.sym,
    }));
  } catch (e) {}
}
async function monitorTick() {
  let H, feed;
  if (SERVER_KEYS) {
    if (subs.length === 0 && !Object.values(devices).some((d) => d.sub)) return;
    H = { "APCA-API-KEY-ID": process.env.APCA_API_KEY_ID, "APCA-API-SECRET-KEY": process.env.APCA_API_SECRET_KEY };
    feed = SERVER_FEED;
  } else {
    if (subs.length === 0) return;
    const cfg = subs[subs.length - 1]; // latest registration carries the API keys
    H = { "APCA-API-KEY-ID": cfg.keys.id, "APCA-API-SECRET-KEY": cfg.keys.secret };
    feed = cfg.feed === "sip" ? "sip" : "iex"; // real-time only for triggers
  }
  const day = etDay(Date.now());
  if (monState.day !== day) { monState.fired = new Set(); monState.sym = {}; monState.day = day; }
  try {
    /* monitor covers the shared list plus every claimed device's list */
    const pool = (SERVER_KEYS ? watchUnion() : watch).slice(0, SERVER_KEYS ? 80 : 40);
    if (pool.length === 0) return;
    const off = new Date();
    const et = new Date(off.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const diff = off.getTime() - et.getTime();
    const d = new Date(et); d.setHours(4, 0, 0, 0); /* full premarket window — PMH and baselines track from the 4:00 AM open */
    const start = new Date(d.getTime() + diff).toISOString();
    const nowMs = Date.now();
    for (let i = 0; i < pool.length; i += 15) {
      const batch = pool.slice(i, i + 15);
      const j = await fetchJSON(
        `${DATA}/v2/stocks/bars?symbols=${batch.join(",")}&timeframe=1Min&start=${encodeURIComponent(start)}&limit=10000&feed=${feed}`, H
      ).catch(() => null);
      if (!j) continue;
      for (const s of batch) {
        const arr = ((j.bars && j.bars[s]) || []).map((b) => ({ t: new Date(b.t).getTime(), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
        const st = monState.sym[s] || (monState.sym[s] = {});
        for (const trig of computeTriggers(s, arr, st, nowMs)) {
          if (monState.fired.has(trig.key)) continue;
          monState.fired.add(trig.key);
          console.log("PUSH:", trig.title);
          await sendAlert(s, trig.title, trig.body, trig.key);
        }
      }
    }
  } catch (e) { console.log("monitor error:", String(e).slice(0, 120)); }
  saveMonState();
}
const monitorTimer = setInterval(monitorTick, 45000);
/* Render rolling deploys briefly run OLD + NEW instances together; the old
   one must stop pushing the instant it is told to shut down */
process.on("SIGTERM", () => {
  clearInterval(monitorTimer);
  try { saveMonState(); saveSubs(); } catch (e) {}
  process.exit(0);
});

/* ============================ settings persistence ============================ */
const SETTINGS_FILE = "/tmp/scanner-settings.json";
let settings = {};
try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch (e) {}
function saveSettings() { try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings)); } catch (e) {} }

/* ============================ static assets ============================ */
const SW_JS = `self.addEventListener("push", (e) => {
  let d = { title: "Scanner alert", body: "", key: "" };
  try { d = e.data.json(); } catch (err) {}
  e.waitUntil((async () => {
    /* DELIVERY-POINT DEDUPE: the same alert key is shown at most once per 24h
       on this device, no matter how many times or from where it arrives
       (overlapping server instances during deploys, restarts, retries). */
    if (d.key) {
      try {
        const cache = await caches.open("alert-dedupe");
        const u = "/dedupe/" + encodeURIComponent(d.key);
        const hit = await cache.match(u);
        if (hit) {
          const ts = Number(await hit.text());
          if (Date.now() - ts < 24 * 3600e3) return; /* duplicate — swallow */
        }
        await cache.put(u, new Response(String(Date.now())));
      } catch (err) {}
    }
    await self.registration.showNotification(d.title, { body: d.body, icon: "/icon.png", badge: "/icon.png", tag: d.key || undefined });
  })());
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: "window" }).then((cs) => cs.length ? cs[0].focus() : clients.openWindow("/")));
});
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(clients.claim()));`;

const MANIFEST = JSON.stringify({
  name: "Momentum Scanner",
  short_name: "Scanner",
  start_url: "/",
  display: "standalone",
  background_color: "#0A0E13",
  theme_color: "#0A0E13",
  icons: [{ src: "/icon.png", sizes: "192x192", type: "image/png" }],
});

const ICON = Buffer.from("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", "base64");

/* ============================ HTTP server ============================ */
function readBody(req) {
  return new Promise((res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => res(b));
  });
}

const server = http.createServer(async (req, res) => {
  const u = req.url.split("?")[0];

  const prefix = Object.keys(ROUTES).find((p) => req.url.startsWith(p + "/"));
  if (prefix) {
    /* server-keys mode: the server's own credentials go upstream, and (when
       an invite code is configured) only claimed devices may use the proxy —
       otherwise anyone with the URL gets free market data on our dime */
    if (SERVER_KEYS && INVITE_CODE && !deviceOk(req.headers["x-device"])) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "device not authorized — enter the access code" }));
      return;
    }
    try {
      const r = await fetch(ROUTES[prefix] + req.url.slice(prefix.length), {
        headers: SERVER_KEYS ? {
          "APCA-API-KEY-ID": process.env.APCA_API_KEY_ID,
          "APCA-API-SECRET-KEY": process.env.APCA_API_SECRET_KEY,
        } : {
          "APCA-API-KEY-ID": req.headers["apca-api-key-id"] || "",
          "APCA-API-SECRET-KEY": req.headers["apca-api-secret-key"] || "",
        },
      });
      const body = await r.text();
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(body);
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  if (u === "/health") { res.writeHead(200); res.end("ok"); return; }
  if (u === "/sw.js") { res.writeHead(200, { "Content-Type": "application/javascript" }); res.end(SW_JS); return; }
  if (u === "/manifest.json") { res.writeHead(200, { "Content-Type": "application/manifest+json" }); res.end(MANIFEST); return; }
  if (u === "/icon.png") { res.writeHead(200, { "Content-Type": "image/png" }); res.end(ICON); return; }

  if (u === "/config" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ serverKeys: SERVER_KEYS, invite: !!INVITE_CODE, feed: SERVER_FEED }));
    return;
  }
  if (u === "/auth/claim" && req.method === "POST") {
    try {
      if (!SERVER_KEYS) throw new Error("server-keys mode is off");
      const b = JSON.parse(await readBody(req));
      const id = String(b.device || "");
      if (id.length < 8 || id.length > 64) throw new Error("bad device id");
      if (INVITE_CODE && String(b.code || "") !== INVITE_CODE) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "wrong access code" }));
        return;
      }
      if (!devices[id] && Object.keys(devices).length >= MAX_DEVICES) throw new Error("device limit reached");
      devices[id] = devices[id] || { symbols: [], sub: null, t: Date.now() };
      saveDevices();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (u === "/settings" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(settings));
    return;
  }
  if (u === "/settings" && req.method === "POST") {
    try {
      const b = JSON.parse(await readBody(req));
      if (SERVER_KEYS) { delete b.id; delete b.secret; } /* never store client keys in server-keys mode */
      settings = { ...settings, ...b };
      saveSettings();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  if (u === "/push/status") {
    const devSubs = Object.values(devices).filter((d) => d.sub).length;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ devices: subs.length + devSubs, watch: (SERVER_KEYS ? watchUnion() : watch).length, lastError: lastPushErr }));
    return;
  }
  if (u === "/push/pubkey") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ key: b64u(vapid.pubRaw) }));
    return;
  }
  if (u === "/push/register" && req.method === "POST") {
    try {
      const b = JSON.parse(await readBody(req));
      if (!b.subscription || !b.subscription.endpoint) throw new Error("bad subscription");
      if (SERVER_KEYS && b.device) {
        /* per-device: this device's subscription only (must be claimed) */
        if (!deviceOk(b.device)) throw new Error("device not authorized");
        devices[b.device].sub = b.subscription;
        saveDevices();
        console.log("push registered for device — devices with push:", Object.values(devices).filter((d) => d.sub).length);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, devices: 1 }));
        return;
      }
      /* single-user app: a new registration replaces ALL prior subscriptions.
         (Safari sub + installed-PWA sub on the same phone = every alert doubled) */
      subs = [{ sub: b.subscription, keys: b.keys || {}, feed: b.feed || "sip" }];
      saveSubs();
      console.log("push subscription registered — monitor covering", subs.length, "device(s)");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, devices: subs.length }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  if (u === "/push/watchlist" && req.method === "POST") {
    try {
      const b = JSON.parse(await readBody(req));
      const syms = (b.symbols || []).filter((s) => typeof s === "string").slice(0, 40);
      if (SERVER_KEYS && b.device) {
        if (!deviceOk(b.device)) throw new Error("device not authorized");
        devices[b.device].symbols = syms; /* this device's own watchlist */
        saveDevices();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, watching: syms.length }));
        return;
      }
      watch = syms;
      saveSubs();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, watching: watch.length }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  if (u === "/push/unregister" && req.method === "POST") {
    try {
      const b = JSON.parse(await readBody(req));
      if (SERVER_KEYS && b.device && devices[b.device]) {
        devices[b.device].sub = null; /* this device only */
        saveDevices();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, devices: 0 }));
        return;
      }
      if (b.endpoint) subs = subs.filter((s) => s.sub.endpoint !== b.endpoint);
      else subs = []; /* single-user app: bell off = full silence */
      saveSubs();
      console.log("push unregistered —", subs.length, "device(s) remain");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, devices: subs.length }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  if (u === "/push/test" && req.method === "POST") {
    await broadcast("🔔 Test alert", "Lock-screen push is working.", "test-" + Date.now());
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, devices: subs.length }));
    return;
  }

  if (u.startsWith("/float/")) {
    const sym = u.slice(7).toUpperCase().replace(/[^A-Z.]/g, "");
    const v = await getFloat(sym);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ symbol: sym, float: v }));
    return;
  }

  fs.readFile(path.join(__dirname, "index.html"), (e2, data) => {
    if (e2) { res.writeHead(500); res.end("index.html not found"); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`\n  Momentum scanner running → http://localhost:${PORT}\n`));

module.exports = { computeTriggers, encryptPayload, vapidJWT };
