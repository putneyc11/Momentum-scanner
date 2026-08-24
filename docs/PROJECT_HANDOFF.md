# Momentum Scanner v2 — Project Handoff

Owner: Corey Putney (Corner Post Web). This document is the complete context for
continuing development in a new workspace. Everything below was learned or
decided during the build; treat the "hard-won facts" and "decisions log"
sections as authoritative — several of them exist because the naive approach
was tried and failed.

---

## 1. What this is

A premarket/intraday small-cap momentum watchlist PWA for iPhone, with
lock-screen push alerts. It sweeps the ENTIRE US listed market via the user's
own Alpaca API keys (paid Algo Trader Plus / real-time SIP), ranks the top
movers by a technical "setup score," charts them, and fires push notifications
on technical triggers (VWAP reclaim, EMA cross, PMH break, volume events,
3-green-candle streaks, tape-silence halts). A separate After Hours section
runs 4:00–8:00 PM ET.

- Production: https://momentum-scanner-vbgw.onrender.com (Render free web
  service, auto-deploys from the `momentum-scanner` GitHub repo)
- Deploy = push BOTH `index.html` and `server.js` when either changes.
- iPhone usage: installed to home screen (required for lock-screen push,
  iOS 16.4+). Render free tier sleeps; a /health pinger or paid instance is
  needed for continuous monitoring.
- IMPORTANT OPEN OP ITEM: set `VAPID_PRIVATE_JWK` and `VAPID_PUBLIC_RAW` env
  vars in Render (the server logs a generated pair at boot). Without them,
  every deploy regenerates keys and silently invalidates the push
  subscription. The app shows an amber "push failing" warning when this
  happens (server tracks delivery errors at /push/status).

## 2. Repo layout (this export)

```
src/momentum-dashboard.jsx   ← CANONICAL client source. Edit this.
src/server.template.js       ← Server source (icon placeholder). Edit this.
build/build.py               ← Transforms + bundles both into deploy/.
build/icon.b64               ← 3257-byte lightning PNG, base64.
deploy/                      ← What actually ships (index.html, server.js,
                               package.json, render.yaml).
tests/                       ← Representative Playwright + unit tests.
docs/PROJECT_HANDOFF.md      ← This file.
```

The canonical JSX targets the claude.ai artifact runtime (`window.storage`,
absolute Alpaca URLs, `export default`). `build.py` rewrites those for
standalone deployment (localStorage, `/alpaca` + `/trading` proxy paths,
`createRoot` mount) via exact-string replacement pairs that ASSERT — if you
edit a storage block in the JSX, update the matching pair in build.py or the
build fails loudly (by design; silent drift shipped a broken build once).

## 3. Architecture

**Client** (`momentum-dashboard.jsx`, single file, ~2000 lines, React, no CSS
framework, canvas charts, mono/dark terminal aesthetic):

- **Universe sweep**: `/trading/v2/assets` filtered to non-OTC + `tradable` +
  `active`; cached 24h in localStorage (`uni-cache`). Batches of 1000,
  8 concurrent, every 60s (SIP) / 300s (delayed). SESSION-AWARE (this is
  load-bearing — see §5): during REGULAR HOURS it sweeps 1Day bars
  (candidates: traded today, ≥3% up, ≥$0.03, ≤ maxPrice, ≥ minDayVol).
  During PREMARKET (4:00–9:30 AM ET) Alpaca has NO daily bar for today yet,
  so the sweep reads batched `/v2/stocks/snapshots` instead: `latestTrade`
  (must be from today) vs the last COMPLETED daily bar = the gap. Snapshots
  are RAW prices, so every premarket candidate's prior close is re-verified
  against split-adjusted 1Day bars (drift >0.5% → re-price or drop) — the
  reverse-split phantom guard. Delayed mode reads IEX snapshots (snapshots
  can't be time-shifted; recent SIP is blocked on free plans).
  The first sweep of a new ET day wipes all list/alert state, so the
  watchlist auto-populates fresh from the 4:00 AM open.
- **Watchlist**: top 15 by setup score. RTH gates: ≥25% day / ≥5M day vol /
  $0.03–$100. PREMARKET gates: ≥10% gap (PM_PCT_FLOOR) and ≥25k cumulative
  premarket shares (PM_MIN_VOL, computed from the 5Min bars — snapshots
  carry no premarket cumulative volume); rows show PREMARKET volume.
  Setup score 0–100: float rotation, VWAP position, EMA 8>21>50
  stack, Supertrend(10,3) on 5-min, capped day %, 5-min volume surge. Grades
  A≥80 / B≥65 / C≥50 / D. Rows fixed 64px (never flex-stretch — dynamic row
  heights were an explicit user complaint). Session start is 4:00 AM ET
  (SESSION_START_ET=4) everywhere: charts, VWAP, trigger scans, and the
  server monitor all cover the full premarket tape.
- **Prices**: rows repriced every 3s via ONE batched
  `/v2/stocks/trades/latest?symbols=...` call (daily bars only re-aggregate
  ~1/min — polling them faster looks frozen). Full re-rank every 15s; sweep
  completion triggers an immediate re-rank via `refreshRef`.
- **Alert coverage ≠ display list**: `watchAllRef` carries up to 30 qualifying
  movers beyond the top-15 display; alerts/halts gate on that superset. (A
  +64% runner once ranked 16th by score and was missed entirely — coverage
  now follows QUALIFICATION, not RANK.)
- **Trigger scan** (`ignScan`): full-session 1-min bars for a ~45-symbol pool
  (list ∪ watchAll ∪ movers ∪ hot), every 60s in regular hours, piggybacked
  on the 15s refresh during AH. Computes client-side alerts (mirror of the
  server), halt flags, and the After Hours table. Reads symbols through
  `gainersRef` — NOT the `gainers` state — because the 3s price tick changes
  state identity and once caused the scan to re-run every 3 seconds.
- **After Hours (4:00–8:00 PM ET)**: top-10 AH gainers vs the 4:00 close.
  Qualify once (≥3% AH gain, ≥5k/min avg over last 3 bars, ≥1M shares full
  day) → sticky for the session, shown while gain is positive. Fully
  independent of main-list settings (a global rate filter once gutted the
  5 PM day list — never couple them again). Main rows show an ungated
  "AH +x% · vol" chip, absolutely positioned at the row bottom (in-flow
  placement collided with the VOL column).
- **Row tap → Advanced**: tapping any row (main list or After Hours) opens
  the Advanced detail page DIRECTLY. The old in-place preview card was
  removed by explicit user request — do not reintroduce it.
- **Advanced detail page**: live WS ticks (wss://stream.data.alpaca.markets),
  candles 1m–1D, windows 1D–5Y, hold-250ms-then-drag scrub (header tracks the
  inspected candle, reverts on lift), pinch zoom, always-visible touch-native
  Fit-all, NBBO book, time & sales with big-print ledger, tape-stall halt
  banner, Confluence Tracker (6 indicators + state-change log), left-edge
  swipe closes.
- **Alert banner / center**: banner tap → bottom-sheet history modal (last
  50); swipe LEFT clears (distance tracked in a ref — state timing missed
  fast flicks).
- **Settings persistence**: localStorage + server `/settings` (GET/POST
  merge) fallback; auto-starts when saved keys exist. iOS PWA storage is
  partitioned from Safari and evictable — the server copy is the safety net.

**Server** (`server.template.js` → `server.js`, ZERO dependencies, Node ≥18):

- Proxies `/alpaca` → data.alpaca.markets, `/trading` → paper-api (browser
  CORS requires it), passing APCA headers.
- PWA assets: `/sw.js`, `/manifest.json`, `/icon.png` (embedded base64).
- **Web Push from scratch**: VAPID ES256 (ieee-p1363 JWT) + RFC 8291
  aes128gcm payload encryption — crypto is roundtrip-verified; don't touch it
  casually.
- **Monitor**: every 45s, fetches 1-min bars for the client-synced watchlist
  (cap 40) and runs `computeTriggers` (exported for unit tests) — an exact
  mirror of the client's alert semantics.
- **Anti-duplication stack** (four incidents; treat as load-bearing):
  1. `/push/register` REPLACES all subscriptions (Safari + installed-PWA subs
     on one phone doubled everything).
  2. One unified VOLUME alert (spike + opening-drive were two triggers firing
     on the same bar); bar-timestamp keys consume each bar forever; 30-min
     per-symbol cooldown; silent first-sight baseline consumes in-progress
     events.
  3. monState (fired keys + per-symbol state) persisted to /tmp each tick —
     restart-proof; SIGTERM handler stops the monitor instantly (Render
     rolling deploys briefly run old+new instances together).
  4. Service worker dedupes BY ALERT KEY AT DELIVERY (Cache API, 24h) + tag
     coalescing — kills duplicates from ANY upstream source.
- `/settings` (GET/POST merge, /tmp), `/push/status` (devices, watch size,
  lastError), `/push/watchlist`, `/push/test`, `/health`, `/float/:sym`
  (Yahoo crumb flow, 24h cache, best-effort).

## 4. Alert semantics (both layers, keep mirrored)

All alerts: WATCH-SET symbols only; silent baseline on first sight (never
replay the past); re-baseline after a 3-min observation gap; fresh-bar-only
(<120s); transition-only where applicable. Types:

- VWAP reclaim (below→above cross)
- EMA 8/21 bull cross (1-min)
- PMH break (transition through the premarket high)
- Unified VOLUME: spike (≥3× 10-min avg AND biggest bar in 30 min AND ≥100k
  shares AND ≥1% bar thrust) OR ≥ the LARGEST of the first TEN 9:30 candles
  (only if that max itself ≥100k — matching a quiet open means nothing). One
  alert, keyed by bar timestamp, 30-min cooldown.
- mom3: streak of 3 green 1-min candles fires when the streak REACHES 3 (bar
  before was red/flat), once per streak, 15-min cooldown. Loosest trigger in
  the set; if noisy, add a ≥2% move-across-three-bars requirement.
- Halt (heuristic, NOT the official LULD feed): >150s tape gap after real
  activity (last-3 bars each ≥20k avg ≥30k) + ≥3% move into the gap; resume
  alert on tape return.

Client shows banner+sound always; the system notification is server-push-only
when a subscription is armed (`pushArmedRef` gate) — otherwise desktop doubles.

## 5. Hard-won Alpaca facts (do not re-derive)

- `delayed_sip` is NOT a valid feed param. Feed modes used: sip_delayed
  (rest=sip + 16-min `end`, stream=iex), iex, sip.
- `adjustment: "split"` on EVERY bar request (raw data produced a phantom
  +714% on a reverse split).
- Daily bars re-aggregate ~once/min and are useless for live prices; use
  batched `/v2/stocks/trades/latest?symbols=A,B` → `{trades:{SYM:{p,s,t}}}`.
- Movers endpoint (`/v1beta1/screener/stocks/movers`) includes sub-25% large
  caps — never let it bypass the pct floor.
- Quote sizes are round lots (×100). Assets: exclude OTC; `tradable` filter
  is now ON per user instruction (was deliberately OFF earlier — if a
  legitimate runner ever vanishes from the universe, suspect this flag; it
  refreshes only with the 24h universe cache).
- 1-min bars include the forming partial bar; extended-hours trades flow
  through the same endpoints.
- TODAY'S 1Day bar DOES NOT EXIST during premarket — it only appears after
  the 9:30 open. Any discovery gate that requires "today's daily bar" (or a
  full-day volume floor) silently blanks the entire premarket session; this
  is exactly the bug that kept the watchlist empty before the open. Premarket
  discovery must run on `/v2/stocks/snapshots` (latestTrade vs the last
  completed daily bar) + minute/5-min bars for premarket volume. Snapshots
  are RAW (no `adjustment` param) — always split-guard them.

## 6. Testing methodology (Playwright headless + unit)

- Chromium, iPhone viewport 390×844, `hasTouch` for gesture tests. Mock every
  Alpaca route; branch bar responses on timeframe + symbol count
  (1Day multi = sweep/re-rank; 5Min = scoring; 1Min multi = trigger scan;
  1Min single = detail/preview).
- Server unit tests import `computeTriggers` from server.js directly
  (tests/test-dup.js, tests/test-trig4.js) — every duplicate-scenario and
  trigger rule has a named assertion. Run before shipping alert changes.
- Gotchas that produced false test failures (all documented in git history):
  - Mock bar timestamps must be RELATIVE to now (`Date.now()-90s`), never
    `setUTCHours(14)` — after 8 PM ET the fixed stamp lands on tomorrow's ET
    day and the sweep correctly rejects it.
  - Playwright routes match LAST-REGISTERED FIRST — register catch-alls
    (`**/push/**`) BEFORE specific routes.
  - AH-window tests shift the browser clock with a FakeDate init script
    (offset to 17:30 ET).
  - Text probes on `#root` leak across sections — bound slices between
    section markers, and beware the dashboard header behind modals matching
    regexes (e.g. "upd HH:MM ET").
  - React state does not re-render between synthetically dispatched touch
    events — gesture logic must read refs, and tests must jitter mouse
    coordinates to force real events.
- Ship ritual: build → run tests → all-green ✓ output → copy to deploy/ →
  zip → deliver. Never claim a fix without a test that reproduces the
  original failure.

## 7. Decisions log (the "why" behind non-obvious code)

- Row height fixed at 64px, chip absolutely positioned: dynamic spacing and
  column collisions were explicit user complaints.
- ≥25% hard floor at re-rank kills movers-endpoint leakage (a +7% large cap
  once graded B on the list).
- Main list keeps $100 / 5M day-vol / ≥25%; per-minute rate filters live ONLY
  in After Hours (a global 15k/min filter once reduced the 5 PM list to two
  rows).
- AH stickiness: qualify once, stay all session, display while positive.
- Fit-all is permanent (dim when fitted): a conditionally-rendered button
  under 2×/sec live re-renders dropped iOS taps.
- Preview cards are static snapshots on purpose — live machinery (WS, tape,
  book) belongs to the detail page only.
- Diagnostic "why isn't TICKER listed" box was removed as clutter; the
  Playwright-era `{0 && ...}` falsy-number render leak is why every numeric
  conditional uses `> 0`.

## 8. Product / roadmap context

- Target user today: Corey himself (premarket 6–9:30 AM ET, iPhone).
- App Store path discussed: Capacitor wrap (reuse ~95%), APNs/FCM replaces
  Web Push (OneSignal shortcut viable), Capacitor Preferences replaces
  localStorage, CORS header for capacitor://localhost. Play Store accepts a
  TWA near-immediately.
- Monetization analysis: BYO-Alpaca-keys keeps data licensing clean (each
  user consumes under their own agreement). Managed-data version requires a
  vendor redistribution license + exchange fees → recurring cost, so $9.99
  one-time only pencils with delayed data + server-side alerts, or keep BYO
  keys as the real-time path. No execution, impersonal signals, "not
  investment advice" disclaimer → publisher's exclusion territory.
- Nice-to-haves user hinted at: tighter mom3 (≥2% across the streak),
  configurable AH thresholds, 6-value compact preview strip.

## 9. Quick start in a new workspace

```
1. npm i -g esbuild && npm i react react-dom
2. Edit src/momentum-dashboard.jsx and/or src/server.template.js
3. python3 build/build.py
4. Push deploy/index.html + deploy/server.js to the GitHub repo → Render
   auto-deploys (render.yaml + package.json already correct).
5. Set VAPID env vars in Render (see server boot log) — once, forever.
6. Tests: node deploy/server.js & then node tests/<file>.js
   (unit tests require server.js in the same dir or adjust the require path).
```
