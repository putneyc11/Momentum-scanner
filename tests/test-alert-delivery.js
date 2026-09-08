/* Offline delivery regression. No listeners, remote calls, real credentials,
   or shared /tmp/scanner-* files. Run: node tests/test-alert-delivery.js */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const source = fs.readFileSync(path.join(__dirname, "../src/server.template.js"), "utf8");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-delivery-test-"));
let passed = 0;
const ok = (name) => { passed++; console.log("PASS", name); };

function boot(directory, overrides = {}) {
  const state = { now: Date.parse("2026-09-08T14:30:00Z"), logs: [], fetches: [], pushes: [], failWrites: false, timeout: null, destroyed: false };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [state.now])); } static now() { return state.now; } }
  let handler;
  const context = vm.createContext({
    Buffer, URL, URLSearchParams, AbortSignal, Date: Clock,
    module: { exports: {} }, __dirname: path.dirname(__filename),
    process: { env: { SCANNER_STATE_DIR: directory, ...overrides }, pid: process.pid, on() {}, exit() {} },
    console: { log: (...args) => state.logs.push(args.join(" ")), error: (...args) => state.logs.push(args.join(" ")) },
    setInterval() { return 1; }, clearInterval() {},
    require(name) {
      if (name === "fs") return { ...fs, writeFileSync(...args) { if (state.failWrites) throw new Error("simulated disk failure"); return fs.writeFileSync(...args); } };
      if (name === "http") return { createServer(fn) { handler = fn; return { listen() {} }; } };
      if (name === "https") return { request() { const r = new EventEmitter(); r.setTimeout = (ms, cb) => { assert.equal(ms, 8000); state.timeout = cb; }; r.destroy = () => { state.destroyed = true; }; r.end = () => {}; return r; } };
      if (["path", "crypto", "http2"].includes(name)) return require(name);
      throw new Error("Unexpected dependency in test");
    },
    fetch: async (url, options) => {
      assert.equal(new URL(url).origin, "https://data.alpaca.markets");
      assert.equal(new URL(url).pathname, "/v2/stocks/bars");
      assert.equal(options.headers["APCA-API-KEY-ID"], "TEST_ID");
      assert.ok(options.signal);
      state.fetches.push(url);
      if (!state.respond) throw new Error("Unexpected upstream request");
      return state.respond(url, options);
    },
  });
  vm.runInContext(source, context, { filename: "server.template.js" });
  state.api = context.module.exports;
  state.evaluate = (code) => vm.runInContext(code, context);
  state.stubPush = () => {
    context.capturePush = async (sub, payload) => { state.pushes.push(payload); return 201; };
    state.evaluate("sendPush = capturePush");
  };
  state.request = async (url, body) => {
    const req = new EventEmitter();
    Object.assign(req, { url, method: body === undefined ? "GET" : "POST", headers: {} });
    let status, result;
    const res = { writeHead(s) { status = s; }, end(s) { result = JSON.parse(s); } };
    const pending = handler(req, res);
    if (body !== undefined) { req.emit("data", JSON.stringify(body)); req.emit("end"); }
    await pending;
    return { status, body: result };
  };
  return state;
}
const response = (bars, next_page_token = null) => ({ ok: true, status: 200, json: async () => ({ bars, next_page_token }) });
function bars(now) {
  return Array.from({ length: 20 }, (_, i) => ({ t: new Date(now - (20 - i) * 60000).toISOString(), o: 1 + i * 0.01, c: 1.01 + i * 0.01, h: 1.015 + i * 0.01, l: 0.995 + i * 0.01, v: 100000 }));
}
const fakeSubscription = () => {
  const client = crypto.createECDH("prime256v1"); client.generateKeys();
  return { endpoint: "https://push.invalid/test", keys: { p256dh: client.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") } };
};

(async () => {
  const directory = path.join(temporary, "state");
  const first = boot(directory);
  await first.api.monitorTick();
  assert.equal(first.api.monitorStatus.reason, "no_subscriptions");
  assert.equal(first.fetches.length, 0);
  ok("zero subscriptions is visible and does not pretend to monitor");

  const publicKey = (await first.request("/push/pubkey")).body.key;
  const sub = fakeSubscription();
  assert.equal((await first.request("/push/register", { subscription: sub, keys: { id: "TEST_ID", secret: "TEST_SECRET" }, feed: "sip" })).status, 200);
  assert.equal((await first.request("/push/watchlist", { symbols: ["AAA", "ZZZ"], mode: "all", prefs: { AAA: { lv: [1.5] } } })).status, 200);
  await first.request("/settings", { alertsOn: true });
  first.evaluate("monState.hour = 42; monState.hourN = 7; monState.digest = [{sym:'AAA',tier:2,price:1}]; monState.digestAt = 123; saveMonState(); journalAdd({sym:'AAA',t:1}); saveJournal();");
  for (const name of ["vapid", "subs", "settings", "monstate", "journal"]) assert.equal(fs.statSync(path.join(directory, `scanner-${name}.json`)).mode & 0o777, 0o600);
  const privatePart = JSON.parse(fs.readFileSync(path.join(directory, "scanner-vapid.json"))).privateJwk.d;
  assert.ok(!first.logs.join("\n").includes(privatePart));
  ok("registration and private atomic state writes succeed without logging signing secrets");

  const second = boot(directory);
  assert.equal((await second.request("/push/pubkey")).body.key, publicKey);
  const status = (await second.request("/push/status")).body;
  assert.equal(status.devices, 1); assert.equal(status.watch, 2);
  assert.equal((await second.request("/settings")).body.alertsOn, true);
  assert.equal(second.evaluate("monState.hourN"), 7);
  assert.equal(second.evaluate("monState.digest[0].sym"), "AAA");
  assert.equal(second.evaluate("journal[0].sym"), "AAA");
  assert.equal(second.evaluate("watchMode"), "all");
  assert.equal(second.evaluate("watchPrefs.AAA.lv[0]"), 1.5);
  ok("restart restores signing identity, subscription, watchlist, preferences, caps and journal");

  second.stubPush();
  second.respond = (url) => new URL(url).searchParams.get("page_token")
    ? response({ ZZZ: bars(second.now) }) : response({ AAA: bars(second.now) }, "page/2+opaque");
  await second.api.monitorTick();
  assert.equal(second.fetches.length, 2);
  assert.equal(new URL(second.fetches[1]).searchParams.get("page_token"), "page/2+opaque");
  assert.ok(second.pushes.some((p) => p.title.includes("ZZZ")));
  assert.equal(second.api.monitorStatus.lastSuccess, second.now);
  assert.equal(second.api.monitorStatus.running, false);
  ok("a symbol on the next Alpaca page is evaluated and reaches the mock push recipient");

  second.respond = () => ({ ok: false, status: 403 });
  await second.api.monitorTick();
  assert.equal(second.api.monitorStatus.reason, "market_data_error");
  assert.equal(second.api.monitorStatus.lastError.code, 403);
  second.now += 60000;
  second.respond = () => response({ AAA: bars(second.now), ZZZ: bars(second.now) });
  await second.api.monitorTick();
  assert.equal(second.api.monitorStatus.lastError, null);
  assert.equal(second.api.monitorStatus.lastSuccess, second.now);
  ok("market-data failures are reported and a later successful tick clears them");

  second.respond = () => response({ AAA: [] }, "repeated");
  await assert.rejects(second.api.fetchMonitorBars(["AAA"], "2026-09-08T08:00:00Z", "sip", { "APCA-API-KEY-ID": "TEST_ID" }), /pagination/);
  ok("repeated pagination tokens fail instead of looping indefinitely");

  let release;
  second.respond = () => new Promise((resolve) => { release = resolve; });
  const before = second.fetches.length;
  const tick = second.api.monitorTick();
  await second.api.monitorTick();
  assert.equal(second.fetches.length, before + 1);
  release(response({ AAA: [], ZZZ: [] }));
  await tick;
  assert.equal(second.api.monitorStatus.running, false);
  ok("overlapping monitor ticks do not duplicate requests or delivery state changes");

  const timed = boot(path.join(temporary, "timeout"));
  const pending = timed.api.sendPush(sub, { title: "Test" });
  assert.equal(typeof timed.timeout, "function");
  timed.timeout();
  assert.equal(await pending, 0); assert.equal(timed.destroyed, true);
  await timed.request("/push/register", { subscription: sub, keys: { id: "TEST_ID", secret: "TEST_SECRET" } });
  await timed.request("/push/watchlist", { symbols: ["AAA"] });
  const alert = timed.api.sendAlert("AAA", "Test", "Test", "AAA-setup-2", "rec");
  timed.timeout(); await alert;
  assert.equal((await timed.request("/push/status")).body.lastError.code, 0);
  ok("a stalled push times out and reports a transport failure");

  second.failWrites = true;
  const previousRecipients = second.evaluate("JSON.stringify(subs)");
  const previousWatch = second.evaluate("JSON.stringify({watch,watchPrefs,watchMode})");
  assert.equal((await second.request("/push/register", { subscription: { ...sub, endpoint: "https://push.invalid/replacement" }, keys: { id: "TEST_ID", secret: "TEST_SECRET" } })).status, 400);
  assert.equal((await second.request("/push/watchlist", { symbols: ["REJECTED"], prefs: { AAA: { off: ["setup"] } }, mode: "rec" })).status, 400);
  assert.equal(second.evaluate("JSON.stringify(subs)"), previousRecipients);
  assert.equal(second.evaluate("JSON.stringify({watch,watchPrefs,watchMode})"), previousWatch);
  assert.equal((await second.request("/push/unregister", {})).status, 400);
  assert.equal(second.evaluate("JSON.stringify(subs)"), previousRecipients);
  assert.equal((await second.request("/push/status")).body.storage.writable, false);
  ok("failed persistence preserves the active shared recipient, watchlist, preferences and mode");

  const deviceState = boot(path.join(temporary, "devices"), { APCA_API_KEY_ID: "TEST_ID", APCA_API_SECRET_KEY: "TEST_SECRET", INVITE_CODE: "test-invite" });
  await deviceState.request("/auth/claim", { device: "test-device", code: "test-invite" });
  await deviceState.request("/push/register", { device: "test-device", subscription: sub });
  await deviceState.request("/push/watchlist", { device: "test-device", symbols: ["AAA"], mode: "all" });
  const previousDevice = deviceState.evaluate("JSON.stringify(devices)");
  deviceState.failWrites = true;
  assert.equal((await deviceState.request("/push/register", { device: "test-device", subscription: { ...sub, endpoint: "https://push.invalid/replacement" } })).status, 400);
  assert.equal((await deviceState.request("/push/watchlist", { device: "test-device", symbols: [], mode: "rec" })).status, 400);
  assert.equal((await deviceState.request("/push/unregister", { device: "test-device" })).status, 400);
  assert.equal((await deviceState.request("/auth/claim", { device: "new-device", code: "test-invite" })).status, 400);
  assert.equal(deviceState.evaluate("JSON.stringify(devices)"), previousDevice);
  ok("failed persistence also preserves per-device subscriptions and rejects an unsaved claim");

  const corrupt = path.join(temporary, "corrupt"); fs.mkdirSync(corrupt);
  fs.writeFileSync(path.join(corrupt, "scanner-vapid.json"), "broken signing identity");
  assert.throws(() => boot(corrupt), /refusing to replace/);
  assert.equal(fs.readFileSync(path.join(corrupt, "scanner-vapid.json"), "utf8"), "broken signing identity");
  assert.throws(() => boot(path.join(temporary, "env"), { VAPID_PRIVATE_JWK: "secret-sentinel", VAPID_PUBLIC_RAW: "invalid" }), (e) => !e.message.includes("secret-sentinel") && /Configured VAPID/.test(e.message));
  ok("invalid saved/configured identities fail safely without rotating or exposing values");
  console.log(`\n${passed} delivery regression checks passed`);
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(temporary, { recursive: true, force: true }));
