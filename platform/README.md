# Momentum Platform · rebuilt development release

Three separate deliverables: an Algo Trader web dashboard, a Momentum Scanner web app, and a genuinely native SwiftUI iPhone/iPad app. The two web deployments and the native app share an authenticated market API, not a UI or a browser-side broker connection.

**This is an implemented, locally tested development release.** It is not yet a verified live deployment, profitable trading system, or App Store submission. Demo screens are deliberately labeled. New paper execution starts **disabled**, and the code has no live-money broker endpoint.

## Start here

1. [Render and API-key setup, step by step](docs/RENDER_SETUP.md)
2. [What changed, why the old trader halted, and archive findings](docs/legacy-findings.md)
3. [Architecture and operating limits](docs/ARCHITECTURE.md)
4. [Native iPhone setup and release requirements](apps/ios/README.md)
5. [Verification and safe cutover checklist](docs/RELEASE_CHECKLIST.md)
6. [Final test evidence and remaining release gates](docs/VERIFICATION.md)

## Run on this Mac

Install the maintained Node 22 LTS release (22.23.2 or newer within major 22), then open a terminal in this folder:

```sh
npm ci
npm run build
npm test
npm run dev
```

Open `http://localhost:5173`. No keys are needed for the clearly labeled offline demo. The API runs on port 4100. `npm run dev` uses synthetic fixtures; it does not place orders or prove that the live feed works.

For the built web app, run:

```sh
PUBLIC_ORIGIN=http://localhost:4100 npm start
```

Then open `http://localhost:4100`. Production deployments must set HTTPS, authenticated sessions and PostgreSQL. The `.env.example` is a template, not a place to commit real secrets. Put local values in an ignored `.env` file. The development JSON store is single-process only.

## Included functionality

- Account equity, risk budget, explicit halt reasons, heartbeat and data health.
- Zoomable/pannable equity charts, multiple ranges and custom time windows, hover inspection and trade markers.
- Eight documented strategy families; rules, bounded tuning controls, candidate versions, trade journals, hit rate, confidence intervals, profit factor, expectancy, R, fees, holding time and drawdown.
- Separate broker-paper, baseline simulation and candidate simulation records. Alternative parameter worlds are never added together into account equity.
- Nightly discovery/search within registered strategy families, chronological train/validation/holdout splits, embargo, walk-forward audit and rejection reasons. No arbitrary generated code is executed.
- Actual trade/quote gateway, reconnects, explicit connection-limit/entitlement errors, deduplicated tape, live candle updates and visibly slower REST fallback.
- Paper-order intent journal, stable client IDs, fill reconciliation, confirmed-cancellation waits, risk reservations, restart-persistent daily halt and one-worker database lease.
- Independent SwiftUI native app with Keychain, OAuth PKCE, URLSession streaming, native charts and simulator tests. No WebView or Capacitor.

## Layout

```text
apps/api/          authenticated API, market gateway, broker worker, research jobs
apps/web/          React/TypeScript web scanner and Algo Trader dashboard
apps/ios/          independent SwiftUI application and Xcode project
packages/engine/   pure strategy, risk, simulation, metrics and research code
docs/             deployment, evidence, operating and release guides
render.yaml       proposed new Render stack; requires cost review before creating
```

The Render manifest expects this directory to live at `platform/` in the existing `Momentum-scanner` GitHub repository. If creating a separate repository from this folder, remove the three `rootDir: platform` entries before deploying.

## Important boundaries

The supplied archive contains useful strategy and execution code but not a validated training dataset. The first real nightly cycle will report insufficient evidence until recorded data qualifies. Default promotion requires at least 60 real sessions, research sample/quality gates, untouched holdout and subsequent forward shadow observations. New manual candidates can be inspected and shadow-tested immediately but are not silently promoted to paper.

The new paper engine deliberately starts with regular-session entries using Alpaca's clock/calendar. It still records extended-hours market data. Extended-hours execution, news ingestion, machine-learning models, options, shorts, notifications, subscriptions/payments and automatic arbitrary strategy-code generation are **not** implemented in this release. Profitability is not guaranteed by a backtest or a high hit rate.
