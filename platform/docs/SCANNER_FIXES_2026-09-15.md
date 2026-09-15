# Scanner chart and qualification fixes — 15 September 2026

## Corrected behavior

- Default chart ranges/reset leave 15% of the plot to the right of the latest record. The entire newest candle is visible.
- Zooming in while following live data centers the latest record. New bars remain centered; manual panning and date selections preserve historical position. **Follow latest** resumes centered tracking without discarding the zoom level.
- Empty future chart space contains no fabricated candles, repeated timestamps, or hover prices.
- Market movers must be strictly **greater than +25% versus the previous close**, including when watchlist-only is selected. Exactly +25% does not qualify. This is explicitly labeled in the UI.
- Price and daily percentage update together on incoming ticks. Tracked symbols leave/reenter the visible list when crossing the threshold; a selected chart remains available below the cutoff.

The old list exposed the worker's broader tracking universe and sorted it by momentum score without a gain threshold. Former gainers were retained for research, so even negative names appeared. The browser also updated price without recomputing percentage. The fix separates visible qualification from continued worker tracking.

## API and safety

`GET /api/v1/scanner` defaults to qualified movers. Authenticated clients may explicitly request `?scope=tracked`; the web uses this cache to process threshold crossings immediately for already-discovered symbols. Newly discovered symbols arrive with the next list refresh. Responses include an inferred previous-close anchor from the worker's consistent price/change pair. Explicit detail requests for tracked symbols remain available.

Worker subscriptions, research inputs, broker execution, risk limits, and persisted account data are unchanged. This patch requires no worker deployment and does not enable paper execution.

## Verification

Node 22.23.2: production build passed; **79 tests passed** (37 API, 28 web, 14 engine). Tests include strict threshold boundaries, live removal/reentry, stale ticks, stable percentage calculation, authenticated API scope, preserved stored universe, default padding, centered zoom, append/rolling history, manual pan, empty future hover, and equity-chart compatibility.

Local demo browser checks confirmed the visible +25% rule, filtered list, default right gap, centered zoom, historical panning, and **Follow latest**. These visual checks used labeled deterministic fixtures, not production credentials or orders. Production verification follows deployment.

## Apply the published update

In Render, use **Manual Deploy → Deploy latest commit** on both web services:

1. [momentum-scanner-v2](https://dashboard.render.com/web/srv-dakp3v8u01pc73fv4ulg)
2. [momentum-algo-v2](https://dashboard.render.com/web/srv-dakp3v8u01pc73fv4ukg) — includes the same scanner/chart UI when opened through the Algo navigation.

Both services track `codex/momentum-platform-rebuild` with Root Directory `platform`. Wait for the new deployment to show **Live**, then reload the website. No environment-variable changes, Blueprint recreation, database reset, or `momentum-market-v2` restart are needed.
