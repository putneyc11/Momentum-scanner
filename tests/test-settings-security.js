/* No ports, live endpoints, real settings files, credentials, or background
   monitor are used. Execute the actual source sections in an isolated VM. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src/server.template.js"), "utf8");
const section = (start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, "Security test anchors must track the real routes");
  return source.slice(from, to);
};
const settingsSection = section('const SETTINGS_FILE = ', '/* ============================ static assets');
const settingsRoutes = section('  if (u === "/settings" && req.method === "GET")', '  if (u === "/push/status")');
const subsSection = section('let subs = [];', '/* per-ticker alert-category filtering:');
const pushRoute = section('  if (u === "/push/register" && req.method === "POST")', '  if (u === "/push/watchlist"');
function harness(serverKeys, existing = {}, subscriptions = { subs: [] }) {
  const files = new Map([["/tmp/scanner-settings.json", JSON.stringify(existing)], ["/tmp/scanner-subs.json", JSON.stringify(subscriptions)]]);
  const writes = [];
  const context = vm.createContext({
    fs: {
      readFileSync: (name) => { if (!files.has(name)) throw new Error("ENOENT"); return files.get(name); },
      writeFileSync: (name, value) => { writes.push({ name, value }); files.set(name, value); },
    },
    SERVER_KEYS: serverKeys, SERVER_FEED: "iex", SUBS_FILE: "/tmp/scanner-subs.json", APNS: null,
    devices: {}, deviceOk: () => false, console: { log() {} },
    readBody: async (req) => req.body,
  });
  vm.runInContext(`${settingsSection}\n${subsSection}\nasync function request(url, method, body) {
    const u = url.split('?')[0], req = { url, method, body }, response = {};
    const res = { writeHead(status, headers) { response.status = status; response.headers = headers; }, end(value) { response.body = value; } };
    await (async () => { ${settingsRoutes}\n${pushRoute} })();
    return response;
  }\nglobalThis.request = request;`, context);
  return { request: context.request, files, writes, context };
}
const parse = response => JSON.parse(response.body);

for (const serverKeys of [false, true]) {
  test(`settings never load, return or persist credentials (serverKeys=${serverKeys})`, async () => {
    const h = harness(serverKeys, { id: "fixture-old-id", secret: "fixture-old-secret", keys: { secret: "fixture-nested" }, token: "fixture-token", feed: "sip", maxPrice: "100", minDayVol: 2000000, alertsOn: true, ver: 4 });
    const expected = { feed: "sip", alertsOn: true, maxPrice: 100, minDayVol: 2000000, ver: 4 };
    const first = await h.request("/settings?cacheBust=1", "GET", "");
    assert.deepEqual(parse(first), expected);
    assert.equal(first.headers["Cache-Control"], "no-store");
    assert.deepEqual(JSON.parse(h.files.get("/tmp/scanner-settings.json")), expected, "startup migration scrubs old credential fields");
    const post = await h.request("/settings", "POST", JSON.stringify({ id: "fixture-new-id", secret: "fixture-new-secret", APCA_API_SECRET_KEY: "fixture-env-secret", nested: { secret: "fixture-hidden" }, feed: "iex", maxPrice: "125.5", alertsOn: false }));
    assert.equal(post.status, 200);
    const result = parse(await h.request("/settings", "GET", ""));
    assert.deepEqual(result, { ...expected, feed: "iex", maxPrice: 125.5, alertsOn: false });
    assert.deepEqual(JSON.parse(h.files.get("/tmp/scanner-settings.json")), result);
    assert.ok(h.writes.every(write => !write.value.includes("fixture-")), "no secret fixture ever written back to persistence");
  });
}
test("typed allowlist excludes nested secrets, inherited keys, arrays and invalid numeric settings", async () => {
  const h = harness(false);
  await h.request("/settings", "POST", '{"__proto__":{"secret":"fixture-prototype"},"feed":{"secret":"fixture-feed"},"maxPrice":{"secret":"fixture-price"},"alertsOn":"fixture-alert","minDayVol":-1,"ver":null}');
  assert.deepEqual(parse(await h.request("/settings", "GET", "")), {});
  assert.equal((await h.request("/settings", "POST", "[]")).status, 400);
  assert.equal((await h.request("/settings", "POST", "null")).status, 400);
});
test("malformed JSON errors cannot echo submitted credential fragments", async () => {
  const h = harness(false);
  const response = await h.request("/settings", "POST", '{"secret":"fixture-sensitive" BROKEN}');
  assert.equal(response.status, 400);
  assert.deepEqual(parse(response), { error: "Invalid settings preferences" });
  assert.ok(!response.body.includes("fixture-sensitive"));
});
test("server-key push storage removes obsolete keys without disabling the legacy per-client monitor", async () => {
  const initial = { subs: [{ sub: { endpoint: "https://example.test/old-push" }, keys: { id: "fixture-old-id", secret: "fixture-old-secret" }, feed: "sip" }] };
  const server = harness(true, {}, initial);
  assert.ok(!server.files.get("/tmp/scanner-subs.json").includes("fixture-old-secret"));
  await server.request("/push/register", "POST", JSON.stringify({ subscription: { endpoint: "https://example.test/new-push" }, keys: { id: "fixture-new-id", secret: "fixture-new-secret" }, feed: "sip" }));
  const stored = JSON.parse(server.files.get("/tmp/scanner-subs.json"));
  assert.equal(stored.subs[0].feed, "iex");assert.equal(stored.subs[0].keys, undefined);
  const legacy = harness(false, {}, initial);
  assert.equal(JSON.parse(legacy.files.get("/tmp/scanner-subs.json")).subs[0].keys.id, "fixture-old-id");
});
test("proxy still injects server environment credentials and config exposes booleans only", async () => {
  const prefixRoute = section('  const prefix = Object.keys(ROUTES)', '  if (u === "/health")');
  const configRoute = section('  if (u === "/config" && req.method === "GET")', '  if (u === "/auth/forget"');
  let captured;
  const context = vm.createContext({
    ROUTES: { "/alpaca": "https://upstream.test" }, SERVER_KEYS: true, SERVER_FEED: "iex", INVITE_CODE: "fixture-invite", deviceOk: () => true,
    ANTHROPIC_API_KEY: "", PLAN_MODEL: "unused", APNS: null,
    process: { env: { APCA_API_KEY_ID: "fixture-env-id", APCA_API_SECRET_KEY: "fixture-env-secret" } },
    fetch: async (_url, options) => { captured = options; return { status: 200, text: async () => '{"bars":{}}' }; },
  });
  vm.runInContext(`async function request(url) { const req = {url, method:'GET', headers:{'x-device':'fixture-device','apca-api-key-id':'client-junk'}}, u=url, out={};
    const res={writeHead(status){out.status=status},end(body){out.body=body}};
    await(async()=>{${prefixRoute}\n${configRoute}})();return out; } globalThis.request=request;`, context);
  assert.equal((await context.request("/alpaca/v2/stocks/bars")).status, 200);
  assert.equal(captured.headers["APCA-API-KEY-ID"], "fixture-env-id");
  assert.equal(captured.headers["APCA-API-SECRET-KEY"], "fixture-env-secret");
  const config = await context.request("/config");
  assert.equal(parse(config).serverKeys, true);assert.equal(parse(config).feed, "iex");
  assert.ok(!config.body.includes("fixture-env"));assert.ok(!config.body.includes("fixture-invite"));
});
test("active deployment server copies match the sanitized canonical source", () => {
  const expected = source.replace("__ICON_B64__", fs.readFileSync(path.join(root, "build/icon.b64"), "utf8").trim());
  for (const file of ["server.js", "deploy/server.js"]) {
    assert.ok(fs.readFileSync(path.join(root, file), "utf8") === expected, `${file} must be rebuilt from src/server.template.js`);
  }
  const archived = fs.readFileSync(path.join(root, "momentum-scanner-deploy/server.js"), "utf8");
  assert.ok(!archived.includes('u === "/settings"'), "Archived pre-settings server should not acquire unrelated features in this hotfix");
});
