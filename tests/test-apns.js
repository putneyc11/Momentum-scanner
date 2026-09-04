/* APNs (native iOS shell) — server unit test.
   Generates a throwaway ES256 key, points the server at a local plaintext
   HTTP/2 stub standing in for api.push.apple.com, and checks: /config.apns,
   /push/register with an APNs token (device + legacy paths), JWT shape and
   caching, the aps payload, the bearer / topic / collapse headers on the
   wire, dead-token folding (400 BadDeviceToken → 410), the /auth/forget
   wipe, and the /privacy /terms /support pages.
   Run from tests/: `cp ../deploy/server.js . && node test-apns.js` */
const { spawn } = require("child_process");
const http2 = require("http2");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("✓", m); } else { fail++; console.log("✗", m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function up(port) { for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {} await wait(150); } throw new Error("server never came up"); }
const b64uDec = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

(async () => {
  for (const f of ["/tmp/scanner-devices.json", "/tmp/scanner-subs.json"]) try { fs.unlinkSync(f); } catch {}
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });

  /* stub APNs: records every request; 410 for token "dead…", 400 BadDeviceToken for "bad…" */
  const got = [];
  const stub = http2.createServer();
  stub.on("stream", (st, h) => {
    let body = "";
    st.on("data", (c) => { body += c; });
    st.on("end", () => {
      got.push({ h, body: JSON.parse(body) });
      const tok = h[":path"].split("/").pop();
      if (tok.startsWith("dead")) { st.respond({ ":status": 410 }); st.end(JSON.stringify({ reason: "Unregistered" })); }
      else if (tok.startsWith("bad")) { st.respond({ ":status": 400 }); st.end(JSON.stringify({ reason: "BadDeviceToken" })); }
      else { st.respond({ ":status": 200, "apns-id": "x" }); st.end(); }
    });
  });
  await new Promise((r) => stub.listen(8799, r));

  const env = { ...process.env, PORT: "8798", APCA_API_KEY_ID: "SRVID", APCA_API_SECRET_KEY: "SRVSECRET", INVITE_CODE: "letmein",
    APNS_KEY_P8: Buffer.from(pem).toString("base64"), APNS_KEY_ID: "KEYID1234", APNS_TEAM_ID: "TEAM567890", APNS_BUNDLE_ID: "com.momentumscanner.app", APNS_HOST: "http://127.0.0.1:8799" };
  const srv = spawn("node", [path.join(__dirname, "server.js")], { env });
  let log = ""; srv.stdout.on("data", (d) => { log += d; }); srv.stderr.on("data", (d) => { log += d; });
  try {
    await up(8798);
    const B = "http://127.0.0.1:8798";
    const J = (u, b) => fetch(B + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    const cfg = await (await fetch(B + "/config")).json();
    ok(cfg.apns === true && cfg.serverKeys === true, "/config advertises apns: true when the key trio is set");

    /* JWT + payload via the module itself (same env) */
    Object.assign(process.env, env, { PORT: "8794" });
    const M = require("./server.js"); /* in-process copy on its own port, same APNS env */
    ok(M.APNS && M.APNS.topic === "com.momentumscanner.app" && M.APNS.host === "http://127.0.0.1:8799", "APNS config parsed from env (base64 p8, topic, host override)");
    const jwt = M.apnsJWT(1700000000000);
    const [h, p, sg] = jwt.split(".");
    const hd = JSON.parse(b64uDec(h)), pl = JSON.parse(b64uDec(p));
    ok(hd.alg === "ES256" && hd.kid === "KEYID1234" && pl.iss === "TEAM567890" && pl.iat === 1700000000, "provider JWT: ES256 header with kid, iss = team id, iat in seconds");
    ok(crypto.verify("sha256", Buffer.from(h + "." + p), { key: publicKey, dsaEncoding: "ieee-p1363" }, b64uDec(sg)), "JWT signature verifies against the public key (raw r||s encoding)");
    ok(M.apnsJWT(1700000000000 + 49 * 60e3) === jwt && M.apnsJWT(1700000000000 + 51 * 60e3) !== jwt, "JWT cached under 50 minutes, refreshed after");
    const ap = M.apnsPayload({ title: "🚀 ABCD setup", body: "3/5 signals", key: "ABCD-setup-2" });
    ok(ap.aps.alert.title === "🚀 ABCD setup" && ap.aps.alert.body === "3/5 signals" && ap.aps.sound === "default" && ap.aps["thread-id"] === "ABCD" && ap.aps["interruption-level"] === "time-sensitive" && ap.key === "ABCD-setup-2", "aps payload: alert title/body, sound, per-symbol thread, time-sensitive, key echoed");

    /* wire: send through the module to the stub */
    const tok = "a".repeat(64);
    const code = await M.sendPush({ apns: tok }, { title: "T", body: "B", key: "ABCD-vol-1" });
    ok(code === 200 && got.length === 1, "sendPush routes an { apns } subscription over HTTP/2 to the APNs host");
    const g = got[0];
    ok(g.h[":path"] === "/3/device/" + tok && g.h[":method"] === "POST", "POST /3/device/<token>");
    ok(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(g.h.authorization) && g.h["apns-topic"] === "com.momentumscanner.app" && g.h["apns-push-type"] === "alert" && g.h["apns-priority"] === "10" && g.h["apns-collapse-id"] === "ABCD-vol-1", "bearer JWT, apns-topic = bundle id, push-type alert, priority 10, collapse-id = alert key");
    ok(g.body.aps.alert.title === "T" && g.body.key === "ABCD-vol-1", "body is the aps payload");
    ok((await M.sendPush({ apns: "dead" + "0".repeat(60) }, { title: "T" })) === 410, "410 Unregistered passes through as 410");
    ok((await M.sendPush({ apns: "bad" + "0".repeat(61) }, { title: "T" })) === 410, "400 BadDeviceToken folds into 410 so the dead-sub sweep drops it");

    /* registration paths on the spawned server */
    const dev = "device-apns-test-0001";
    let r = await J("/auth/claim", { code: "letmein", device: dev, account: { email: "a@b.co", provider: "email", plan: "free" } });
    ok(r.ok, "device claimed");
    r = await J("/push/register", { apns: "AB" + "f".repeat(62), device: dev });
    ok(r.ok && (await r.json()).ok === true, "/push/register accepts { apns, device } for a claimed device");
    const devs = JSON.parse(fs.readFileSync("/tmp/scanner-devices.json", "utf8"));
    ok(devs[dev] && devs[dev].sub && devs[dev].sub.apns === "ab" + "f".repeat(62) && devs[dev].sub.endpoint.startsWith("apns:"), "token stored lowercase as the device's subscription with an apns: endpoint");
    r = await J("/push/register", { apns: "not-hex!", device: dev });
    ok(r.status === 400, "malformed token rejected");
    r = await J("/push/register", { apns: "c".repeat(64), device: "unclaimed-device-0001" });
    ok(r.status === 400, "unclaimed device rejected");
    r = await J("/auth/forget", { device: dev });
    ok(r.ok, "/auth/forget returns ok");
    const devs2 = JSON.parse(fs.readFileSync("/tmp/scanner-devices.json", "utf8"));
    ok(!devs2[dev], "forget wipes the device record (account, watchlist, push token)");

    for (const u of ["/privacy", "/terms", "/support"]) {
      const t = await fetch(B + u); const html = await t.text();
      ok(t.ok && t.headers.get("content-type").includes("text/html") && html.includes("<h1>") && html.includes("MOMENTUM SCANNER"), u + " serves an HTML page");
    }
    const priv = await (await fetch(B + "/privacy")).text();
    ok(/Delete your account/.test(priv) && /do not sell/.test(priv), "privacy page covers deletion and no-sale");
    const terms = await (await fetch(B + "/terms")).text();
    ok(/auto-renewing/.test(terms) && /Not investment advice/.test(terms), "terms cover subscriptions and the advice disclaimer");
  } catch (e) { fail++; console.log("✗ exception:", e, "\n", log.slice(-800)); }
  srv.kill(); stub.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
