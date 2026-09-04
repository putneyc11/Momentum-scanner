# Momentum Scanner — Agent Handoff

Operating manual for an AI agent taking over development. Written 2026-09-04,
current as of commit `6d6737c`.

Owner: Corey Putney. Repo: `putneyc11/Momentum-scanner`.

This file supersedes `docs/PROJECT_HANDOFF.md` (written 2026-08-26) for
everything shipped since. That older file is still the best reference for the
original architecture and the Alpaca lessons; read it second, and distrust any
part that contradicts this one.

---

## 0. Read this before you touch anything

Five rules. Breaking any of them ships a broken app or leaks a secret.

1. **Never put an API key in a file, a commit, a log, or a chat message.**
   All keys live only in Render environment variables. If you need a key to
   test, use a fake one against a mocked endpoint. The owner has a standing
   instruction on this.
2. **Edit `src/`, never `deploy/` or the repo root.** `index.html`,
   `server.js`, `deploy/index.html` and `deploy/server.js` are all build
   artifacts. Editing them directly gets silently overwritten on the next
   build.
3. **Run the build after every source edit.** `python3 build/build.py`.
4. **Run the tests before every push.** They catch real regressions; see §6.
5. **This is a live trading tool.** Wrong numbers are worse than missing
   numbers. Never invent a price, a level, or a threshold. If data is
   unavailable, show that it is unavailable.

---

## 1. What this is

A small-cap momentum scanner PWA, used on an iPhone from the home screen.
It sweeps the entire US listed market through Alpaca, ranks movers by a
"setup score," charts them, and sends lock-screen push alerts.

- **Production:** https://momentum-scanner-vbgw.onrender.com
- **Hosting:** Render web service, auto-deploys from `main`
- **Runtime:** Node 22, zero npm dependencies at runtime. `package.json` has
  no `dependencies` block. The server is plain `http`/`https`/`fs`/`crypto`.
  Keep it that way; Render's build command is empty.
- **Sessions:** premarket 4:00 AM ET, regular hours, after-hours 4:00–8:00 PM ET.

---

## 2. Build pipeline

```
src/momentum-dashboard.jsx   ← the entire React client (single file, ~3300 lines)
src/server.template.js       ← the entire Node server (single file, ~1100 lines)
        │
        │  python3 build/build.py
        ▼
deploy/index.html            ← bundled single-file client (esbuild, minified)
deploy/server.js             ← server with the icon spliced in
index.html, server.js        ← identical copies at the repo root
```

Render runs `node server.js` from the repo root, so the **root copies are what
actually ships**. The build writes all four files; commit all of them.

`build/build.py` holds a `REPS` list of 30 exact-string replacement pairs. It
rewrites the canonical JSX (which targets a `window.storage` runtime) into
browser code (`localStorage`, same-origin proxy paths). **Every pair asserts.**
If you change a storage block or a URL constant in the JSX and the matching
anchor no longer appears, the build fails loudly with
`BUILD ANCHOR DRIFTED: <first 70 chars>`. That is the intended behavior. Fix
the pair in `build/build.py`; never delete the assert.

---

## 3. Deploy procedure

Development happens on `claude/premarket-scanner-discovery-tk67jh`. Use your
own branch name if you prefer, but the merge step is what deploys.

```bash
python3 build/build.py
# ... run tests, see §6 ...
git add src/ deploy/ index.html server.js tests/
git commit -m "..."
git push -u origin <your-branch>
git fetch origin main
git checkout -B main origin/main
git merge --no-edit -X theirs <your-branch>
git push origin main
git checkout <your-branch>
```

`-X theirs` is deliberate: the feature branch is the source of truth, and the
build artifacts conflict on every merge otherwise.

Commit as `Corey Putney <corey.putney111@gmail.com>`. Use whatever co-author
trailer your own harness requires. Do not put a model name in commit messages,
PR bodies, or code comments.

---

## 4. Environment variables (Render)

| Variable | Required | Effect |
|---|---|---|
| `APCA_API_KEY_ID` / `APCA_API_SECRET_KEY` | for server-keys mode | Turns on SERVER-KEYS mode. Server holds Alpaca credentials; clients never enter keys. |
| `INVITE_CODE` | with server keys | Gates the proxy. Unclaimed devices get 401 on every Alpaca call. |
| `VAPID_PRIVATE_JWK` / `VAPID_PUBLIC_RAW` | **yes** | Push signing keys. **If unset, every deploy regenerates them and silently kills all existing push subscriptions.** The server logs a generated pair at boot; copy it into Render once. This is a long-standing open item. |
| `ANTHROPIC_API_KEY` | for AI plans | Enables `POST /plan`. Without it `/config` reports `plans:false` and the UI hides the card. |
| `PLAN_MODEL` | no | Defaults to `claude-opus-5`. |
| `PLAN_EFFORT` | no | Defaults to `medium`. Ignored for Haiku models. |
| `SERVER_FEED` | no | `sip` (default) or `iex`. Sets the feed clients get in server-keys mode. |
| `LEGACY_PUSH` | no | `1` restores the old behavior where every single trigger pushes. Default `0` (confluence-gated). |
| `PUSH_HOURLY_CAP` | no | Default 6. Overflow rolls into a digest. |
| `PUSH_SYM_DAILY_CAP` | no | Default 3 pushes per symbol per day. |
| `MIN_PUSH_PRICE` | no | Default 0.50. |
| `MAX_DEVICES` | no | Device registration cap. |
| `ALPACA_DATA_URL` / `ALPACA_TRADING_URL` | tests only | Point the proxy at a stub upstream. |

**Server state lives in `/tmp` and is wiped on every deploy:**
`scanner-subs.json`, `scanner-devices.json`, `scanner-settings.json`,
`scanner-monstate.json`, `scanner-journal.json`. Device claims and the push
journal do not survive a redeploy. The client silently re-claims about a
second after a page load, so an already-open tab keeps 401ing until reloaded.
If you make state durable, that is a real improvement.

---

## 5. Architecture

### Client (`src/momentum-dashboard.jsx`)

One React file, no router, no state library. Key loops:

| Loop | Interval | Job |
|---|---|---|
| `sweep` | slow | Full-market candidate discovery from snapshots |
| `refresh` | slow | Ranks candidates, seeds each row's price from the **daily bar close** |
| `priceTick` | 3s | Overwrites row prices with the live last trade |
| `ignScan` | ~30s | Full-session 1-min bars: in-app trigger alerts, halt flags, AH table |
| `newsTick` | 60s | Catalyst headlines, dilution-language flagging |

Views: watchlist, After Hours table, `AdvancedChart` (full-screen), onboarding
walkthrough, account/plan flow, About page.

`AdvancedChart` holds the canvas chart, Level 2, time and sales, big prints,
confluence tracker, "Today's numbers," the AI trade plan card, and the
per-ticker alerts sheet.

### Server (`src/server.template.js`)

Static file server + Alpaca proxy + push monitor. Routes:

- `/alpaca/*`, `/trading/*` — proxy. Injects server keys in server-keys mode,
  otherwise passes the client's own headers through.
- `/config` — feature discovery: `serverKeys`, `invite`, `feed`, `plans`.
- `/auth/claim` — device claim against `INVITE_CODE`.
- `/push/register`, `/push/watchlist`, `/push/unregister`, `/push/status`, `/push/pubkey`, `/push/test`
- `/plan` — POST, AI trade plan (see §7).
- `/journal` — push follow-through stats.
- `/float/<sym>` — Yahoo float lookup, 24h cache.
- `/health`, `/sw.js`, `/manifest.json`, `/icon.png`

`monitorTick` runs every 45s over the union of every claimed device's
watchlist, capped at 80 symbols.

### The two alert layers must stay mirrored

In-app alerts (client `ignScan`) and lock-screen push (server
`computeTriggers` + `setupGate`) implement the same rules in two places. If
you change trigger semantics, change both, or the app and the phone disagree.
This duplication is deliberate: the client works without the server awake.

---

## 6. Testing

Playwright suites need the built server running on port 8787:

```bash
python3 build/build.py
rm -f /tmp/scanner-*.json
(setsid node deploy/server.js > /tmp/srv.log 2>&1 < /dev/null &) ; sleep 1.5
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8787/   # expect 200
```

Then, with `PW_EXECUTABLE` pointing at the sandbox Chromium:

| Suite | Clock pinned to | Expect |
|---|---|---|
| `tests/test26.js` | 13:00 ET | 32 checks, Advanced view |
| `tests/test28.js` | 17:30 ET | 16 checks, alerts + After Hours |
| `tests/test-pm.js` | 07:30 ET | 8 checks, premarket discovery |
| `tests/test-onboard.js` | 13:00 ET | 19 checks, onboarding + accounts |

```bash
PW_EXECUTABLE=/opt/pw-browsers/chromium node tests/test26.js
```

Server unit suites run from `tests/` with a copy of the built server beside them:

```bash
cd tests && cp ../deploy/server.js .
rm -f /tmp/scanner-*.json
node test-setup.js        # 22 passed  — confluence tiers, budgets, journal
node test-plan.js         # 19 passed  — level pack, plan sanitizer, pivots
node test-serverkeys.js   # 11 passed  — server-keys mode, invite gate, proxy
PORT=8793 node test-dup.js   # "ALL DUPLICATE-SCENARIO TESTS PASS"
node test-trig4.js           # "ALL TRIGGER TESTS PASS"
rm -f server.js           # MUST remove before committing
```

Gotchas that will waste your time:

- **Every UI test must pin the browser clock.** Discovery is session-aware, so
  an unpinned test behaves differently depending on when it runs.
- **Clear `/tmp/scanner-*.json` between server unit runs** or state leaks
  across suites.
- **Delete `tests/server.js` before committing.** It is a build artifact copy.
- Mock route order matters: register the specific pattern
  (`**/alpaca/v1beta1/news**`) before the general one (`**/alpaca/v1beta1/**`).
- Test tickers must clear the real gates. A mock priced at +8% never appears,
  because the RTH floor is +25% on the day.

---

## 7. What shipped recently (not in the older handoff)

- **Confluence-gated push.** Single triggers no longer push. A symbol earns a
  lock-screen alert only when 3 of 5 signals (VWAP, EMA 8>21, volume, high of
  day, three green candles) line up on the same bar, 4 of 5 during the
  11:30–14:00 chop window. Tier 2 is "setup," tier 3 is "breakout." A symbol
  pushes again only on escalation or a new leg after an 8% pullback. Caps:
  3 per symbol per day, 6 per hour globally, overflow becomes one digest.
  Halts bypass the gate. `LEGACY_PUSH=1` restores old behavior.
- **Push journal.** Every push is recorded with price at 5, 15 and 30 minutes
  after, plus the best and worst print in that window. `/journal` serves the
  stats; the alert center shows the hit rate. This is the evidence for tuning
  the tier thresholds. It is currently unused for automatic tuning.
- **AI trade plans.** `POST /plan` builds a **level pack** from the tape
  (PMH/PML, HOD/LOD, VWAP, EMA 8/21/50, LULD estimate, opening range, volume
  nodes, swing pivots, prior-day levels, recent 5-min candles, active signals)
  and asks the model to arrange those numbers into three long-only scenarios:
  Long continuation, Dip buy, Stand aside. **The model never invents a price.**
  Everything it returns is range-checked against the live price by
  `sanitizePlan` before it reaches the UI. Cached 5 minutes per symbol.
- **Level 2 panel.** Best bid/ask, a depth chart, and a Size·Bid·Ask·Size
  ladder. Alpaca gives NBBO top of book only, not resting depth, so row 1 is
  the live quote and rows below are **traded depth**: shares that printed at
  that price in the last 15 minutes. The footer says so. Do not relabel this
  as real order-book depth.
- **Accounts and plans (preview).** First run goes walkthrough → sign up
  (Apple / Google / email) → Free vs Pro picker → connect. Sign-in and billing
  are **simulated on-device**; no identity provider or payment processor is
  wired. Real auth arrives with the native shell.
- **Watchlist row layout.** News icon and DIL tag sit at the end of the row
  after the bell; rows scroll horizontally for overflow.

---

## 8. Known open bugs

Diagnosed but **not yet fixed**. Highest value work available.

### 8.1 False halt flags (confirmed, reproducible)

Symptom: a stock shows the ⛔ halt badge and fires a halt push while trading
normally.

Root cause: **Alpaca only emits a 1-minute bar for minutes that had trades.**
Minutes with no prints are absent from the array. The halt heuristic treats
the array as contiguous minutes:

- `arr.slice(-3)` is meant to be "the three minutes before the silence." It is
  actually the last three minutes that had *any* trades, which for a
  burst-trading small cap can span 20+ minutes.
- `arr[arr.length - 6]` is meant to be "six minutes ago" for the ≥3% move
  gate. It can be half an hour ago, so ordinary drift clears the gate.

Both supposedly-strict gates therefore pass for free, leaving only "no new bar
for 150 seconds," which any quiet small cap trips.

Locations: client `ignScan` at `src/momentum-dashboard.jsx:2658` and server
`computeTriggers` at `src/server.template.js:285`. **Both must change.**

Suggested fix: require the three volume bars to be genuinely consecutive
minutes, and cross-check against the latest trade timestamp. The app already
fetches `/v2/stocks/trades/latest` for every watchlist symbol every 3 seconds
and **discards the `t` field**, keeping only `p`. A stock that printed 20
seconds ago cannot be halted.

### 8.2 `priceTick` swallows every error

`priceTick` has a bare `catch (e) {}` (`src/momentum-dashboard.jsx:2999`) and
never calls `setErr`. When the live
price feed dies, rows silently fall back to the daily-bar close from the last
slow discovery scan. Prices look wrong and frozen with no error on screen, and
a dead feed is indistinguishable from a quiet tape.

Compare: `refresh` does call `setErr`, so discovery failures show the red
banner. Suggested fix: track the last successful tick and show a stale-data
warning in the header when no fresh print has landed in 30 seconds.

### 8.3 Delayed-feed mode looks like a broken app

`FEED_MODES.sip_delayed` pulls bars with `end` set 16 minutes back **and**
routes last-trade lookups to `iex`. IEX carries a thin slice of small-cap
volume, so prices land wrong and barely move. Combined with 8.2 there is no
error shown. The header pill is the only tell: `SIP RT` vs `SIP 15m-delay`.
Worth making that difference much louder.

### 8.4 Halt/LULD are heuristics

The halt flag is tape-silence inference and the LULD bands are computed from
Tier-2 percentages off a 5-bar average. Neither is the official feed. The
About page says so; keep it that way.

---

## 9. Hard-won Alpaca facts

Do not re-derive these; each cost a debugging cycle.

- **Bars are omitted for minutes with no trades.** Never assume the array is
  contiguous. See §8.1.
- **Bar timestamps mark the bar's START.** A bar stamped 10:55 covers
  10:55:00–10:56:00, so a fresh bar can look up to 60s old.
- **Today's daily bar does not exist before the open.** Premarket discovery
  must price off snapshots, not `1Day` bars, or the list sits empty until
  9:30. This is why `refresh` has a separate premarket branch.
- **Split-adjusted vs raw prices produce phantom gappers.** Reverse splits
  show as +900% moves. Discovery cross-checks the adjusted prior close and
  drops mismatches over 0.5%.
- **`sip` requires the paid subscription.** Without it those requests 403.
- **The screener movers endpoint returns symbols below the sweep threshold,**
  which is how a +7% large cap once appeared on a ≥25% list. There is a hard
  floor filter after ranking; keep it.
- **Extended-hours orders need limit prices.** Market orders are rejected
  outside 9:30–16:00 (relevant to the algo trader, not the scanner).

---

## 10. Related project: the algo paper trader

Separate orphan branch `claude/algo-paper-trader`, separate Render service
`momentum-algo-trader`. Not part of the scanner deploy. A seven-pod strategy
ensemble that paper-trades through Alpaca, with nightly cross-pollinated
parameter tuning. It has its own `HANDOFF.md` on that branch. Do not merge it
into `main`.

---

## 11. Product direction

`PRODUCT.md` in the repo root is the source of truth for product decisions.
The important standing one:

**Business goal, Option B.** Real-time alerts are computed server-side and
treated as flat-licensed derived data; the display feed is delayed. Never
build a feature that requires per-user real-time market-data entitlements.
Target price around $9.99/month. All vendor figures in that file are planning
numbers and must be confirmed in writing before anyone relies on them.

Explicitly deferred by the owner, do not start without asking: edge stats,
strategy-grade alerts, a 9:15 digest, websocket streaming, Phase 2 Capacitor
iOS shell with APNs.

---

## 12. Working style the owner expects

- Ship complete, tested work. Run the suites; report real pass counts.
- When asked a diagnostic question, investigate and report findings. Do not
  start fixing until asked.
- Say plainly when something is unverified or when you could not observe
  production. Do not guess and present it as fact.
- Scanner changes are pushed to `main` automatically once tested; that is a
  standing instruction, not something to ask about each time.
