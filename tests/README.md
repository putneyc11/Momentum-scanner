# Tests (representative subset)

- test-setup.js  — server unit: the CONFLUENCE PUSH GATE (signals, tiers,
                   lunch rule, silent baseline, escalation-only re-push,
                   new-leg after a pullback, daily cap, price floor, stale
                   tape), the plan sanitiser, journal stats and pivots.
                   Run from tests/: `cp ../deploy/server.js . && node test-setup.js`
- test-plan.js   — server unit: POST /plan against a stub Alpaca AND a stub
                   Anthropic endpoint (level pack contents, JSON-schema
                   structured output, fallbacks header, prompt caching,
                   range-checked levels, 5-min cache + refresh rate limit,
                   refusal / malformed / no-tape errors, /journal, and the
                   no-key 503). Run from tests/: `cp ../deploy/server.js . && node test-plan.js`
- test-serverkeys.js — server unit: SERVER-KEYS mode (env-held credentials,
                   invite gate, per-device watchlists, proxy injection,
                   legacy passthrough). Run with server.js in the same
                   directory: `cp ../deploy/server.js . && node test-serverkeys.js`
- test-onboard.js — Playwright UI: first-run walkthrough → account sign-up
                   (Apple / Google / email, simulated on-device) → Free vs
                   Pro plan picker → connect screen; About page, relocated
                   disclosures, and the server-keys connect screen (access
                   code, no key fields).

- test-dup.js    — server unit: every duplicate-notification scenario (subscription
                   replacement, unified volume alert, bar consumption, cooldowns,
                   baseline swallowing). Run with server.js in the same directory:
                   `cp ../deploy/server.js . && PORT=8793 node test-dup.js`
- test-trig4.js  — server unit: 10-candle opening drive + mom3 streak rules.
- test-pm.js     — Playwright UI: PREMARKET discovery. Clock pinned to 07:30 ET,
                   Alpaca mocked realistically (NO daily bar for today before the
                   open). Asserts the list populates from snapshots, gap % is vs
                   the split-ADJUSTED prior close, thin tape is volume-gated,
                   reverse-split phantoms are dropped, and a row tap opens the
                   Advanced view directly.
- test26.js      — Playwright UI: row tap opens the Advanced view directly, the
                   four top bars fit a 390px phone with left/right groups on
                   their edges, the header bell opens the per-ticker alerts
                   sheet (categories + price levels), timeframe buttons are
                   real tap targets that select on tap, Copy reports via a
                   bottom toast, icon-only replay/fit-all, the AI trade plan
                   card (idle until Analyze, three scenarios, level chips →
                   price alerts, levels on the chart), back navigation.
                   Clock pinned to 13:00 ET so the RTH discovery path runs.
- test28.js      — Playwright UI: alert coverage beyond the top-15, mom3 in-app,
                   alert-center modal, swipe-to-clear, the After Hours table
                   (full-market top-10, illiquid filter, true AH volume, a
                   sparkline on every row, 3s live re-pricing), and the
                   per-symbol mute bell (mute drops the stock from the
                   push-monitor sync, unmute restores it). Clock pinned to
                   17:30 ET.

Playwright tests expect the server on :8787 (`node ../deploy/server.js &`) and
playwright installed (npm dev dependency, or globally — the require falls back).
If the environment pins a Chromium build, point at it:
`PW_EXECUTABLE=/opt/pw-browsers/chromium node tests/test-pm.js`.
ALL UI tests must pin the browser clock now — discovery is session-aware, so an
unpinned test flips behavior depending on when it runs. See
docs/PROJECT_HANDOFF.md §6 for the mock conventions and the timestamp/route-order
gotchas before writing new tests.
