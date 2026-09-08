# Alert delivery recovery

The scanner can show live prices even when the server has no push recipient.
On September 8, 2026, production reported zero registered devices and 12 watched
symbols. The old client accepted an existing browser subscription as proof that
server registration still existed, and ignored rejected registration responses.
Render also regenerated the VAPID identity and stored recipients in ephemeral
`/tmp` files. These are delivery failures independent of signal thresholds.

## Behavior in this patch

- Reconcile browser/native registration on restoration, foreground, reconnect,
  and every 60 seconds while the app is open. Replace browser subscriptions
  bound to a different VAPID identity. Automatic recovery never prompts for
  notification permission or sends a test notification.
- Show lock-screen readiness only after the server accepts both registration
  and a watchlist established by discovery. Preserve previous targets while
  discovery is pending or failing. A completed empty scan clears targets.
- Serialize recovery and disabling; retain the user's alert preference during
  settings hydration and report failures visibly. Drain watchlist changes made
  during a request. Use the last connected credentials, keeping Settings drafts
  separate; a newly validated connection is registered before readiness resolves.
- Persist the VAPID identity, subscriptions, device records, settings, monitor
  state/caps/digest, and journal under `SCANNER_STATE_DIR`. Writes use private
  files and atomic replacement. Rejected registration/watchlist writes roll
  back the in-memory change. Private VAPID values are no longer logged.
- Follow every Alpaca minute-bars page, prevent overlapping monitor cycles,
  bound stalled requests, and expose market-data/storage failures in
  `/push/status`.

Recommended/ALL thresholds, discovery volume floors, signal logic, and halt
heuristics are unchanged. Push service acceptance is not proof that a phone
displayed a notification; this patch does not add automatic delivery retries.

## Existing Render service rollout

Target only the existing `momentum-scanner` service
(`srv-d975j23tqb8s73c0dqbg`). It runs one Starter instance from `main` with
automatic deploys. Root `server.js` and `index.html` are the deployed artifacts;
regenerate them and their `deploy/` copies with `python3 build/build.py`.

For state to survive Render redeploys while the phone stays closed:

1. Confirm the service's Disks page. Reuse a suitable existing mount if present;
   otherwise attach a 1 GB disk mounted at `/var/data` after cost approval.
2. Set `SCANNER_STATE_DIR=/var/data/scanner` on that same service, then deploy
   the reviewed patch. Preserve the existing environment and feed settings.
3. Existing `VAPID_PRIVATE_JWK` / `VAPID_PUBLIC_RAW` environment values, when
   configured as a valid pair, take precedence. Otherwise the server creates
   and privately saves an identity on the mount. Never copy key values into
   logs, source control, screenshots, or issue comments.
4. Open the installed scanner on the owner's phone after the deploy. Allow
   discovery to finish and confirm the bell shows **Lock-screen** without a
   delivery warning. A first empty mount cannot recreate previously lost
   browser subscriptions; the phone must register once.
5. Check `/health` and `/push/status`: recipients are present, the watch count
   matches the discovered list, storage is writable, and a monitor cycle
   finishes without an error. An empty watchlist correctly remains idle.
6. With the phone closed, perform an agreed restart check: verify the instance
   ID changes while recipient count, watchlist and public VAPID identity remain
   intact. During market hours, confirm `monitor.lastSuccess` advances. A real
   notification test and confirmation on the phone complete delivery validation.

Render lists persistent disks at **$0.25 per GB per month**, so 1 GB adds $0.25
monthly to the existing compute charge. A disk allows only one service instance
and causes a brief interruption during deployments. See [Render disk behavior](https://render.com/docs/disks)
and [pricing](https://render.com/pricing), checked September 8, 2026.

The default `SCANNER_STATE_DIR=/tmp` supports local use and recovery when the
browser reopens, but does not retain state across Render redeploys. Merely setting
an environment path does not attach a disk. `storage.directoryConfigured` reports
the configuration, not proof of a persistent mount; verify persistence by the
restart check. Do not apply the repository's old free-tier `render.yaml` to
recreate the existing service.

For rollback, keep the disk attached and preserve its files. Reverting to an
older server that only reads `/tmp` also reverts durable delivery support, so
re-register the phone and verify delivery again. Disk state must not be placed
inside a directory served as static assets: it can contain BYOK credentials.

## Validation

Run `node tests/run-server-tests.js` under Node 22. The runner isolates the
existing server suites from real credentials and shared temporary state. The
new client and server regressions cover recovery, rejected requests, stale
VAPID identity, startup watchlist handling, disabling races, pagination, request
timeouts, failed persistence, and state restoration.

Validation on September 8, 2026: all eight selected suites passed under Node
22.23.2, including 27 client recovery cases and 11 server delivery cases. The
build completed and root/deploy artifact pairs match. Separate offline replays
of the saved GCDT and NUR SIP tape produced identical discovery entries and
signals to base commit `3812de9`.

Offline tests do not establish delivery to a physical phone. The production
rollout and phone check above remain required after deployment approval.
