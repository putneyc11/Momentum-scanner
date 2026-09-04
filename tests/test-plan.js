/* AI trade plan endpoint — spawns server.js against a stub Alpaca AND a stub
   Anthropic endpoint. Run from tests/: `cp ../deploy/server.js . && node test-plan.js` */
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("✓", m); } else { fail++; console.log("✗", m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function up(port) { for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return; } catch {} await wait(150); } throw new Error("no server"); }

/* session bars: 60 one-minute bars ending now, rising from $1 to $1.30 */
const nowMs = Date.now();
const bars1 = []; for (let i = 0; i < 60; i++) { const c = 1 + i * 0.005; bars1.push({ t: new Date(nowMs - (60 - i) * 60000).toISOString(), o: c - 0.004, h: c + 0.01, l: c - 0.01, c, v: 30000 + (i === 59 ? 100000 : 0) }); }
const barsD = []; for (let d = 6; d >= 1; d--) barsD.push({ t: new Date(nowMs - d * 864e5).toISOString(), o: 0.8, h: 0.9, l: 0.75, c: 0.82, v: 4e5 });

const PLAN = {
  bias: "bullish", summary: "Holding above VWAP with a rising tape; best trade is the dip to 1.24.",
  levels: [{ price: 1.40, kind: "resistance", label: "LULD up", strength: 2 }, { price: 1.24, kind: "support", label: "EMA 8", strength: 3 }, { price: 1.15, kind: "support", label: "VWAP", strength: 2 }, { price: 9.9, kind: "support", label: "bogus", strength: 1 }],
  scenarios: [
    { name: "Long continuation", stance: "long", trigger: "hold 1.24 and push 1.31", entry_lo: 1.25, entry_hi: 1.28, stop: 1.19, targets: [1.34, 1.40], invalidation: "loses 1.19 on a 1-min close", note: "partials at T1" },
    { name: "Dip buy", stance: "long", trigger: "pullback to 1.15 VWAP that holds", entry_lo: 1.15, entry_hi: 1.18, stop: 1.10, targets: [1.28], invalidation: "no bounce inside 3 bars", note: "" },
    { name: "Stand aside", stance: "wait", trigger: "below 1.10 there is no long", entry_lo: 0, entry_hi: 0, stop: 0, targets: [], invalidation: "", note: "reclaim of 1.15 reopens the dip buy" },
  ],
  must_hold: 1.19, must_fail: 1.10, risk_notes: "Size small; halts likely above 1.40.",
};
let aiCalls = 0, lastReq = null, mode = "ok";
const stub = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url.startsWith("/v1/messages")) {
      aiCalls++; lastReq = { headers: req.headers, body: JSON.parse(body || "{}") };
      res.writeHead(200, { "Content-Type": "application/json" });
      if (mode === "refuse") return res.end(JSON.stringify({ stop_reason: "refusal", stop_details: { type: "refusal", category: null }, content: [] }));
      if (mode === "junk") return res.end(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "not json" }] }));
      return res.end(JSON.stringify({ model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(PLAN) }], usage: { input_tokens: 1800, output_tokens: 600, cache_read_input_tokens: 900 } }));
    }
    const u = new URL(req.url, "http://x");
    const tf = u.searchParams.get("timeframe");
    const sym = (u.searchParams.get("symbols") || "").split(",")[0];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ bars: { [sym]: sym === "NOPE" ? [] : tf === "1Day" ? barsD : bars1 } }));
  });
});

(async () => {
  await new Promise((r) => stub.listen(8798, r));
  const srvPath = path.join(__dirname, "server.js");
  const env = { ...process.env, ALPACA_DATA_URL: "http://127.0.0.1:8798", ANTHROPIC_BASE_URL: "http://127.0.0.1:8798", ANTHROPIC_API_KEY: "sk-test", PLAN_MODEL: "claude-opus-5", PORT: "8797" };
  const s1 = spawn("node", [srvPath], { env });
  await up(8797);
  const B = "http://127.0.0.1:8797";
  const post = (b, h) => fetch(B + "/plan", { method: "POST", headers: { "Content-Type": "application/json", "APCA-API-KEY-ID": "K", "APCA-API-SECRET-KEY": "S", ...(h || {}) }, body: JSON.stringify(b) });

  const cfg = await (await fetch(B + "/config")).json();
  ok(cfg.plans === true && cfg.planModel === "claude-opus-5", "/config advertises AI plans and the model");

  let r = await post({ symbol: "gooda", feed: "iex", news: "GOODA announces something", grade: "B", score: 74 });
  let j = await r.json();
  ok(r.status === 200 && j.plan && j.cached === false, "POST /plan returns a plan on the first call");
  ok(aiCalls === 1 && lastReq.headers["x-api-key"] === "sk-test" && lastReq.body.model === "claude-opus-5", "one model call, with the server's key and the configured model");
  ok(lastReq.body.output_config && lastReq.body.output_config.format && lastReq.body.output_config.format.type === "json_schema" && lastReq.body.output_config.effort, "request uses a JSON-schema structured output plus an effort setting");
  ok(lastReq.body.fallbacks === "default" && lastReq.headers["anthropic-beta"] === "server-side-fallback-2026-07-01", "refusal fallbacks are on for the Opus 5 tier");
  ok(Array.isArray(lastReq.body.system) && lastReq.body.system[0].cache_control && lastReq.body.system[0].cache_control.type === "ephemeral", "the stable system prompt is marked for prompt caching");
  const pack = JSON.parse(lastReq.body.messages[0].content.split("\n").slice(1).join("\n"));
  ok(pack.symbol === "GOODA" && pack.bars_today === 60 && pack.vwap > 1 && pack.ema8 > pack.ema21 && pack.prev_close === 0.82 && pack.headline && pack.setup_grade === "B", "level pack carries tape-derived numbers (VWAP, EMAs, prior close) plus the client's headline and grade");
  ok(pack.luld_est && pack.luld_est.band_pct === 20 && Array.isArray(pack.volume_nodes) && pack.volume_nodes.length === 3 && Array.isArray(pack.recent_5min), "level pack includes LULD estimate, volume nodes and recent 5-minute candles");
  ok(j.plan.levels.length === 3 && j.plan.levels[0].price === 1.15 && !j.plan.levels.some((l) => l.price === 9.9), "returned levels are range-checked against price and sorted");
  ok(j.plan.scenarios.length === 3 && j.plan.scenarios[2].stance === "wait" && j.plan.scenarios[0].targets.join() === "1.34,1.4", "three scenarios come back, third is Stand aside");
  ok(j.plan.model === "claude-opus-5" && j.plan.usage && j.plan.usage.cached === 900, "plan reports the serving model and token usage");

  r = await post({ symbol: "GOODA" }); j = await r.json();
  ok(r.status === 200 && j.cached === true && aiCalls === 1, "second call inside 5 minutes is served from cache (no model call)");
  r = await post({ symbol: "GOODA", fresh: true }); j = await r.json();
  ok(j.cached === true && aiCalls === 1, "refresh inside a minute is still the cached plan (rate limit)");

  mode = "refuse";
  r = await post({ symbol: "REFU" }); j = await r.json();
  ok(r.status === 502 && /declined/.test(j.error), "a refusal is surfaced as an error, not an empty plan");
  mode = "junk";
  r = await post({ symbol: "JUNK" }); j = await r.json();
  ok(r.status === 502 && /malformed/.test(j.error), "malformed model output is surfaced as an error");
  mode = "ok";
  r = await post({ symbol: "NOPE" }); j = await r.json();
  ok(r.status === 400 && /not enough tape/.test(j.error), "a symbol with no bars today is rejected before any model call");
  r = await post({}); ok(r.status === 400, "missing symbol is a 400");

  const jr = await (await fetch(B + "/journal")).json();
  ok(jr && jr.stats && jr.policy && jr.policy.legacy === false && jr.policy.hourlyCap === 6, "/journal exposes stats and the push policy");
  s1.kill();

  /* no key → plans off */
  const s2 = spawn("node", [srvPath], { env: { ...env, ANTHROPIC_API_KEY: "", PORT: "8799" } });
  await up(8799);
  const c2 = await (await fetch("http://127.0.0.1:8799/config")).json();
  r = await fetch("http://127.0.0.1:8799/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol: "GOODA" }) });
  ok(c2.plans === false && r.status === 503, "without ANTHROPIC_API_KEY, /config says plans are off and /plan is a 503");
  s2.kill();
  stub.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
