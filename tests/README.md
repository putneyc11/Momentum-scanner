# Tests

Build first, then run the server and alert recovery suites with Node 22:

```sh
python3 build/build.py
node tests/run-server-tests.js
```

The runner executes `test-setup`, `test-apns`, `test-plan`, `test-serverkeys`,
`test-dup`, `test-trig4`, `test-alert-delivery`, and `test-push-recovery` sequentially.
It uses the invoking Node executable for child servers, rejects a stale generated
server, and stops a suite after 90 seconds. Each suite gets a unique temporary
working directory and state directory. The runner changes old `/tmp/scanner-*`
paths only in temporary test copies, supplies an allowlisted environment without
live Alpaca/APNs/Anthropic credentials, and removes test servers and temporary
files on success, failure, or interruption. It requires macOS or Linux process
groups for descendant cleanup. Copied servers and stubs bind only to loopback;
tests that use HTTP require local loopback access.

Run a subset by name, or list the available suites:

```sh
node tests/run-server-tests.js test-apns test-serverkeys
node tests/run-server-tests.js --list
```

The two alert regression suites can also run directly without network access:

```sh
node tests/test-alert-delivery.js
node tests/test-push-recovery.js
```

- `test-alert-delivery.js`: persisted signing identity/subscriptions, paginated
  monitor data, failure visibility/recovery, overlapping ticks, bounded push
  requests, and failed storage writes.
- `test-push-recovery.js`: server acknowledgement, stale VAPID replacement,
  startup recovery, successful empty discovery, pending watch edits, permission
  handling, disabling races, native push, and connected credentials versus drafts.

## Existing suite coverage

- test-setup.js  — server unit: the CONFLUENCE PUSH GATE (signals, tiers,
                   lunch rule, ARRIVAL push vs silent baseline, the ALL
                   package options, a GCDT-shaped tape replayed through
                   old / recommended / all, escalation-only re-push,
                   new-leg after a pullback, daily cap, price floor, stale
                   tape), the plan sanitiser, journal stats and pivots.
                   Run: `node tests/run-server-tests.js test-setup`
- test-plan.js   — server unit: POST /plan against a stub Alpaca AND a stub
                   Anthropic endpoint (level pack contents, JSON-schema
                   structured output, fallbacks header, prompt caching,
                   range-checked levels, 5-min cache + refresh rate limit, the
                   202-pending / poll path for slow model calls,
                   refusal / malformed / no-tape errors, /journal, and the
                   no-key 503). Run: `node tests/run-server-tests.js test-plan`
- test-serverkeys.js — server unit: SERVER-KEYS mode (env-held credentials,
                   invite gate, per-device watchlists, proxy injection,
                   legacy passthrough). Run: `node tests/run-server-tests.js test-serverkeys`
- test-onboard.js — Playwright UI: first-run walkthrough → account sign-up
                   (Apple / Google / email, simulated on-device) → Free vs
                   Pro plan picker → connect screen; About page, relocated
                   disclosures, and the server-keys connect screen (access
                   code, no key fields).

- test-apns.js   — server unit: APNs for the iOS shell — provider JWT (ES256,
                   kid/iss/iat, 50-min cache), aps payload, HTTP/2 headers on
                   the wire against a local stub, dead-token folding,
                   /push/register { apns }, /auth/forget, legal pages.
                   Run: `node tests/run-server-tests.js test-apns`
- test-native.js — Playwright UI: App Store (Capacitor) mode via a fake
                   window.Capacitor bridge — simulated providers and pretend
                   billing hidden, APNs token registered through the bell,
                   denied-permission hint, foreground push → banner, Delete
                   account → /auth/forget, About legal links. Server on :8787.
- test-dup.js    — server unit: every duplicate-notification scenario (subscription
                   replacement, unified volume alert, bar consumption, cooldowns,
                   baseline swallowing). Run: `node tests/run-server-tests.js test-dup`
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

Helpers (not tests):
- capture-current.js <outdir> — drives the live build through every screen
                   (onboarding, plan, connect, home in each session, Advanced
                   sections, alerts sheet, replay, feed down, alert center,
                   settings, about) with mocked data and saves 390x790 @3x
                   PNGs to <outdir>/cap. Useful for App Store screenshots.
- render-ui.js <dir> — screenshots every .html in <dir> (the .device element)
                   to <dir>/png at 3x.
