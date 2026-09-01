/* Server-keys mode (Phase 1 of the App Store plan) — unit test.
   Spawns server.js twice: once with APCA_* env set (server-keys mode with an
   invite gate) against a stub upstream that captures auth headers, once bare
   (legacy mode). Run from tests/: `cp ../deploy/server.js . && node test-serverkeys.js` */
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("✓", m); } else { fail++; console.log("✗", m); } };
const j = (r) => r.json();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function up(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return; } catch {}
    await wait(150);
  }
  throw new Error("server on :" + port + " never came up");
}

(async () => {
  /* stub upstream: records the auth headers of the last proxied request */
  let lastHeaders = null;
  const stub = http.createServer((req, res) => {
    lastHeaders = { id: req.headers["apca-api-key-id"], secret: req.headers["apca-api-secret-key"] };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ bars: {} }));
  });
  await new Promise((r) => stub.listen(8796, r));

  const srvPath = path.join(__dirname, "server.js");
  const envBase = { ...process.env, ALPACA_DATA_URL: "http://127.0.0.1:8796" };

  /* ---- server-keys mode ---- */
  const s1 = spawn("node", [srvPath], { env: { ...envBase, PORT: "8795", APCA_API_KEY_ID: "SRVID", APCA_API_SECRET_KEY: "SRVSECRET", INVITE_CODE: "letmein" } });
  await up(8795);
  const B = "http://127.0.0.1:8795";

  const cfg = await j(await fetch(B + "/config"));
  ok(cfg.serverKeys === true && cfg.invite === true, "server-keys mode advertises itself via /config");

  let r = await fetch(B + "/alpaca/v2/stocks/bars?symbols=AAPL", { headers: { "X-Device": "dvunknown123" } });
  ok(r.status === 401, "proxy REFUSES an unclaimed device (no free data for strangers)");

  r = await fetch(B + "/auth/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "wrong", device: "dvtestdevice1" }) });
  ok(r.status === 403, "claim with the wrong access code is rejected");

  r = await fetch(B + "/auth/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "letmein", device: "dvtestdevice1" }) });
  ok(r.status === 200 && (await j(r)).ok === true, "claim with the right access code authorizes the device");

  r = await fetch(B + "/alpaca/v2/stocks/bars?symbols=AAPL", { headers: { "X-Device": "dvtestdevice1", "APCA-API-KEY-ID": "CLIENTJUNK", "APCA-API-SECRET-KEY": "CLIENTJUNK" } });
  ok(r.status === 200, "claimed device passes the proxy gate");
  ok(lastHeaders && lastHeaders.id === "SRVID" && lastHeaders.secret === "SRVSECRET", "SERVER credentials go upstream — client-sent keys are ignored");

  /* per-device watchlists: two devices, separate lists, union monitored */
  await fetch(B + "/auth/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "letmein", device: "dvtestdevice2" }) });
  await fetch(B + "/push/watchlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: ["AAA", "BBB"], device: "dvtestdevice1" }) });
  await fetch(B + "/push/watchlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: ["BBB", "CCC"], device: "dvtestdevice2" }) });
  const st = await j(await fetch(B + "/push/status"));
  ok(st.watch === 3, `two devices' lists monitor as a UNION (3 unique symbols, got ${st.watch})`);

  r = await fetch(B + "/push/watchlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: ["XXX"], device: "dvnotclaimed9" }) });
  ok(r.status === 400, "an unclaimed device cannot store a watchlist");

  /* client keys never stored in server mode */
  await fetch(B + "/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "LEAKED", secret: "LEAKED", alertsOn: true }) });
  const settings = await j(await fetch(B + "/settings"));
  ok(!settings.id && !settings.secret && settings.alertsOn === true, "client-sent keys are STRIPPED from stored settings in server mode");

  s1.kill("SIGTERM");

  /* ---- legacy mode: everything behaves exactly as before ---- */
  const s2 = spawn("node", [srvPath], { env: { ...envBase, PORT: "8797" } });
  await up(8797);
  const L = "http://127.0.0.1:8797";
  const cfg2 = await j(await fetch(L + "/config"));
  ok(cfg2.serverKeys === false, "without env keys /config reports legacy mode");
  lastHeaders = null;
  r = await fetch(L + "/alpaca/v2/stocks/bars?symbols=AAPL", { headers: { "APCA-API-KEY-ID": "MYKEY", "APCA-API-SECRET-KEY": "MYSECRET" } });
  ok(r.status === 200 && lastHeaders && lastHeaders.id === "MYKEY", "legacy mode still passes each client's own keys through");
  s2.kill("SIGTERM");

  stub.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("TEST CRASH:", e); process.exit(1); });
