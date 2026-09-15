# Momentum web workspace

React, TypeScript, Vite, and a responsive CSS token system. This is the web interface; the separate SwiftUI application lives in `apps/ios` and does not embed this UI.

## Run

From the repository root, install dependencies and run the API on port 4100. Run `npm run dev --workspace=@momentum/web` for Vite on port 5173. The development proxy forwards `/api` to the API. Set the API's `PUBLIC_ORIGIN` to the exact browser origin, such as `http://localhost:5173`; authenticated JSON mutations require an origin match.

For a production build, run `npm run build --workspace=@momentum/web`. The API serves `dist`. Render's `WEB_PRODUCT=scanner` selects the scanner landing screen; `WEB_PRODUCT=trader` selects the trading overview.

## Data and permissions

- No Alpaca credentials, broker URLs, or access tokens are persisted in browser storage. Sign-in uses `ADMIN_TOKEN` or the separately scoped viewer token and receives an HTTP-only session cookie.
- Viewer sessions only open scanner functionality and never request trading or administrative endpoints.
- Demo mode comes only from the API session. There is no client-side random data generator or silent mock fallback. Demo account curves and shadow records are explicitly illustrative, and are separate from paper broker fills.
- Watchlist symbols alone are kept in local storage. Session tokens are not.
- SSE trade bursts are buffered for 50 ms and every received print is processed. Invalid and delayed trades cannot corrupt the current candle. Daily buckets and date filters use New York time with daylight-saving changes.
- Network errors remain visible. The UI does not imply that reconnecting transport means the upstream market feed is current.

## Functional screens

- Overview: account value, previous-close day result, shadow summary, open positions, risk stop, heartbeat and feed status.
- Strategies: metrics, confidence interval, day-specific trades, paper/shadow book selection, documented rules and bounded candidate levers.
- Candidate versions: differences against the selected base, subsequent shadow evidence, blocked promotion reasons, and explicit exact-version paper approval only when the server's gates allow it. Approved paper entries can be disabled while protective exits remain managed.
- Research: asynchronous run creation, stage results, blocked and rejected evidence, and filters for candidate names and decisions.
- Trade journal: symbol/strategy/outcome/book/date filters, CSV export, and entry/exit inspection with R, MFE, MAE and cost labels. Paper fees remain marked pending reconciliation.
- Scanner: ranking filters, a watchlist, automatic symbol analysis, configurable candlestick intervals, technical context, quote spread and Time & Sales.
- Charts: keyboard and pointer zoom/pan, 1H/4H/1D/1W/1M/ALL windows, custom Eastern dates, trade markers and drawdown overlays. User-selected windows remain anchored when fresh candles arrive.

## Verification

`npm test --workspace=@momentum/web` runs focused chart navigation and tick aggregation tests. Browser checks covered candidate creation without activation, blocked candidate evidence, paper/shadow separation, research queue-to-blocked behavior, automatic scanner analysis, the 1m to 5m interval change, and a 390px mobile layout with no horizontal page overflow. Production build and browser console checks passed. Real provider streaming, paper fills and App Store behavior require the connected environments described in the repository's setup guide.

`Screenshots/` contains screenshots of the running local demo. They are not evidence of live trading or profitability.
