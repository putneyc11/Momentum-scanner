# Tests (representative subset)

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
- test26.js      — Playwright UI: row tap opens the Advanced view directly (the
                   tap-to-preview card was removed), back navigation. Clock pinned
                   to 13:00 ET so the RTH discovery path runs.
- test28.js      — Playwright UI: alert coverage beyond the top-15, mom3 in-app,
                   alert-center modal, swipe-to-clear, and the per-symbol mute
                   bell (mute drops the stock from the push-monitor sync,
                   unmute restores it). Clock pinned to 17:30 ET.

Playwright tests expect the server on :8787 (`node ../deploy/server.js &`) and
playwright installed (npm dev dependency, or globally — the require falls back).
If the environment pins a Chromium build, point at it:
`PW_EXECUTABLE=/opt/pw-browsers/chromium node tests/test-pm.js`.
ALL UI tests must pin the browser clock now — discovery is session-aware, so an
unpinned test flips behavior depending on when it runs. See
docs/PROJECT_HANDOFF.md §6 for the mock conventions and the timestamp/route-order
gotchas before writing new tests.
