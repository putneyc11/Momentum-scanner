# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

<!-- Mobile-first PWA: primary use is iPhone, added to the Home Screen.
     Also used in desktop browsers. Deployed on Render from repo root
     (main branch); canonical source src/momentum-dashboard.jsx, built by
     build/build.py. React via esbuild, single-file bundle, no CSS
     framework — inline styles with a shared C color-token object. -->

## Users and job

One primary user (the owner, a small-cap momentum day trader) watching
for gapping low-float stocks from 4:00 AM ET premarket through the
8:00 PM after-hours close. Checks the phone in short bursts — premarket
coffee, mid-day glances, evening AH review. Trades manually on
Robinhood; a separate autonomous paper-trading ensemble (branch
claude/algo-paper-trader, own Render service) trades the same
discovery feed.

## What the product does

- Full-market, session-aware discovery on Alpaca SIP data: premarket
  snapshots vs prior close (≥10% gap + real premarket volume), RTH
  daily bars (≥25% + volume floor), separate After-Hours top-10 table
  (no % floor, illiquid names excluded).
- Live 3-second price ticks on all listed rows; setup score A–D per row
  (float rotation, VWAP, EMA stack, Supertrend, momentum, vol surge).
- Per-stock alert bells → in-app banners + lock-screen Web Push via the
  bundled Node server (server.js monitors the watchlist server-side).
- Advanced per-ticker view: canvas chart (1m–1D), VWAP/EMA overlays,
  live tape + big prints, confluence tracker, float, estimated LULD
  halt bands, tape replay scrubber, catalyst headline.
- Catalyst tagging from Alpaca news (📰 / red ⚠dil dilution flag),
  halt timers on rows, float-rotation display with 1×/2×/3× alerts.

## Positioning

Outperform generic mobile scanners (Webull/Moomoo screeners, Benzinga
Pro mobile) by showing what happens NEXT, not just what moves: session
awareness from 4 AM, halt/LULD intelligence, catalyst + dilution
context, tape replay, and (planned) odds/edge stats and strategy-grade
alerts powered by the paper-trading ensemble's recorded-day library.

## Durable constraints

- User brings their own Alpaca keys (entered in-app, stored locally;
  server keeps a copy for push monitoring). No accounts, no backend DB.
- Render free-tier server: may sleep; the app must degrade gracefully.
- Playwright test suite (tests/) pins behavior: clock-pinned sessions,
  route mocks, text-content assertions. UI changes must keep suites
  green; new UI needs test coverage.
- One-handed phone use: rows are fixed-height tap targets; no
  horizontal page scroll; dark theme only (committed look).
- Compliance copy ("Not financial advice", halt-heuristic and LULD
  estimate caveats) must remain reachable — being relocated from the
  home-screen footer to an ⓘ About page (decided 2026-08-31).
- Not a brokerage; never places real-money trades.

## Business goal (recorded 2026-08-31)

Target: a subscription consumer product (~$9.99/mo or $49.99/yr) built
on the "Option B" architecture — REAL-TIME ALERTS, DELAYED DISPLAY:

- One licensed vendor feed with commercial redistribution rights
  replaces the owner's personal Alpaca keys; the server consumes the
  feed centrally and computes everything (this is already the app's
  shape — server-side watchlist monitoring + push).
- Alerts pushed to users are DERIVED DATA → flat distributor licensing
  (planning figure ~$1.5k/mo), no per-user exchange fees, no
  non-professional attestations, no monthly user reporting.
- In-app charts/watchlist prices run 15-minute delayed for subscribers;
  the real-time alert IS the product.
- IEX-only real-time (already an app feed mode) is viable only as a
  free-tier teaser — too sparse for the small-cap universe as the paid
  backbone. Full real-time display ("Option A", ~$1/user/mo Nasdaq
  Basic fees + attestations) is a later premium tier once subscriber
  count makes per-user fees trivial.
- Planning economics: breakeven ≈150–230 subs at $9.99; ~85% marginal
  contribution after that; assume 8–15% monthly churn. Figures come
  from public fee schedules, NOT vendor quotes — redistribution pricing
  and the derived-data classification of alerts must be confirmed in
  writing during vendor/exchange onboarding.

Design/architecture implication for all future work: keep alert
computation SERVER-SIDE and centralized; keep the display layer
feed-agnostic and tolerant of delayed data; never build a feature that
requires per-user real-time display entitlements to function.

## Confirmed product decisions (2026-08-31)

- First-run onboarding: full-screen swipeable LIVE-PREVIEW slides
  (animated mini-demos per feature) shown before key entry; afterwards
  re-openable from a ? control in the header; app updates may add a
  one-time "What's new" slide.
- Disclosures move to an ⓘ-opened About page; home screen keeps only a
  one-line "Not financial advice" in small type.

## App Store build (native shell)

- `native/` is a Capacitor iOS shell that loads the deployed web app and adds
  APNs push. Web deploys reach the native app without a store review.
- In the shell the account flow is **email + Free only**: simulated Apple /
  Google sign-in and the pretend Pro purchase are hidden until StoreKit and
  Sign in with Apple are real (App Store 3.1.1, 4.8). Delete account lives in
  Settings (5.1.1(v)). `/privacy`, `/terms`, `/support` are served by the app.
- Shipping steps: `docs/APP_STORE.md`. Store copy: `native/store/metadata.md`.

## Accounts & plans (preview)

- First run: walkthrough → **Create account** (Continue with Apple / Google /
  email) → **Choose your plan** (Free vs Pro, $9.99/mo, 7-day trial) → connect.
- Sign-in and billing are **simulated on the device** in this build: no
  identity provider or payment processor is wired. The account
  ({provider, email, plan}) is stored locally and echoed to the server with
  the device claim so the operator can see who is on which plan. Real
  Sign in with Apple / Google and App Store billing land with the native
  shell (Phase 2). Nothing in the app is feature-gated by plan yet — the
  comparison table is the promise, per the Option B business goal above.

## Lock-screen push policy (confluence, not events)

- A push fires only when at least three of five signals line up on the same
  1-minute bar: above VWAP, EMA 8 > 21, volume ≥ 2× the 10-minute average AND
  ≥ $50k notional, fresh high of day (or PMH break after the open), three
  green candles. Tier 2 "setup" = three; tier 3 "breakout" = four including
  HOD and volume. 11:30–14:00 ET needs one more signal per tier.
- First observation of a symbol is a silent baseline. A symbol re-pushes only
  when it escalates to a higher tier or starts a fresh leg (≥ 8% pullback,
  then a 3% bounce with confluence, ≥ 20 min after the last push).
- Caps: 3 pushes per symbol per day, 6 per hour feed-wide; overflow rolls
  into one digest push per 15 minutes. Halts and user-set price levels still
  push directly. `LEGACY_PUSH=1` restores single-event pushes.
- Every push is journaled with the price 5 / 15 / 30 minutes later and the
  best/worst print in that window (`/journal`); the alert center shows the
  running hit rate. Thresholds get tuned against that, not by feel.

## AI trade plans (Advanced view)

- On demand only (Analyze button), cached 5 minutes per symbol, refresh
  rate-limited to once a minute. The server computes a level pack from the
  tape (PMH/PML, HOD/LOD, VWAP, EMA 8/21/50, LULD estimate, opening range,
  volume nodes, 5-minute pivots, prior-day levels, recent candles, signals)
  and the model may only anchor levels to those numbers; every returned
  price is range-checked against the live price.
- Long-only by decision: "Long continuation", "Dip buy", "Stand aside", plus
  must-hold / must-fail. Level chips add price-cross alerts; levels draw on
  the chart. Copy exports the plan as text.
- Model: Claude Opus 5 by decision (`PLAN_MODEL` env; `PLAN_EFFORT`
  defaults to medium), raw Messages API with JSON-schema structured output,
  server-side refusal fallbacks and a cached system prompt. Requires
  `ANTHROPIC_API_KEY` in Render; without it the card is hidden. Framed as
  generated text, never advice — About page carries the disclosure.
