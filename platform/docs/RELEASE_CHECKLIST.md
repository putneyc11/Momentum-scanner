# Verification and safe rollout

## Implemented and checked locally

- TypeScript engine, API and web production build.
- Engine tests: session/DST/risk halt, trade simulation, chronological research and fill/metric logic.
- API tests: operator/viewer separation, CSRF, credential-route removal, candidate bounds/approval rejection, identity expiry, separate performance books, stale/deduplicated market data and production configuration.
- Fake-broker tests: lost order acknowledgement, partial/cumulative fills, cancellation confirmation, ownership mismatch, lease loss, risk reservation and managed exits. No test sends a broker order.
- Browser checks: strategy navigation/candidate creation, automatic stock analysis, tape, timeframe changes, research insufficiency report, narrow/mobile layout and console errors.
- SwiftUI simulator Debug/Release builds and native unit/UI tests. Result bundles/screenshots are under `apps/ios/Verification` and `apps/ios/Screenshots`.
- Isolated legacy `/settings` security regression tests in the separate hotfix changeset. The fix does not remove every old authentication or proxy weakness.

These establish software behavior against local fixtures and mocked broker responses. They do not establish deployment, a real feed, real broker execution, profitability, redistribution rights or App Store approval.

## Required before changing the existing Render URLs

1. Rotate previously exposed paper keys; never copy them into the source or chat.
2. Review the staged Blueprint resource prices. Create the new stack without replacing old services first.
3. Verify PostgreSQL startup, database backup availability, process readiness, one-worker ownership and restart recovery in the actual Render environment.
4. Keep paper execution disabled. During an open session, observe a liquid symbol in both web and native clients. Check event timestamps, tape entries, candle changes, intervals and fresh quotes against Alpaca. Confirm the intended SIP/IEX feed explicitly.
5. Interrupt/reconnect the market stream. Ensure the UI says polling/stale/error accurately and resumes without repeated prints. Check error 406/409 handling. Stop old competing streams when necessary.
6. Use a controlled dedicated paper account to validate no-fill rejection, partial entry, protective legs, partial exit, cancellation race, response loss, restart and account reconciliation. Do not share position ownership with the old trader. Reconcile any unknown positions/orders manually first.
7. Verify the persisted daily halt through a restart and ensure shadow research remains active without new paper entries. Keep the 3% protection intact.
8. Verify scheduled run timestamps and the “insufficient evidence” state. Import only valid point-in-time recorded sessions; do not relax gates merely to turn a badge green.
9. Review an eligible immutable candidate, explicitly approve paper use and only then enable the worker's global paper switch. Monitor actual statement results before increasing any scope.
10. After successful staging checks, choose a cutover window and update the old service configuration/domains deliberately. Preserve the old disk and exports; do not automatically reset or import the old paper balance/positions as new-engine trades.

## Rollback

Disable **new entries** first: dashboard Pause or worker `PAPER_TRADING_ENABLED=false`. Existing orders and positions still require inspection in Alpaca; disabling the process is not a guaranteed flatten. The normal pause leaves protective/managed exits active. Preserve PostgreSQL and the audit/intent ledger. Deploy the previous known-good new-platform commit or return only the read-only web traffic to a previous UI. Never restart the old trading engine against positions owned by the new one. Never clear persisted risk state merely as a rollback technique.

## iPhone/App Store gate

Use the native guide for Apple Team/bundle ID, real identity-provider sign-in, token revocation, support/privacy metadata, icon, account deletion, data licensing, subscriptions where applicable, accessibility and physical-device/battery/network tests. The unsigned simulator application is not an installable TestFlight build. No signing certificate or review account was fabricated.

## Evidence record

The root handoff should record the final test counts, commit/PR links, validation date and screenshot paths. Keep synthetic screenshots labeled preview. If a live check has not been run with authorized replacement credentials, report **not verified**, not “working in production.”
