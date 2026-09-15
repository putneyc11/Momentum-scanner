# Architecture, data contracts and operating limits

## Three products, one market connection

```text
Alpaca market feed ──► one market/paper worker ──► PostgreSQL + event notifications
                                   │                         │
                       isolated research thread      ┌──────┴──────┐
                                   │                 │             │
                            challenger ledger     Algo API     Scanner API
                                                     │             ├── web scanner
                                                Algo web app       └── native SwiftUI app
```

The worker owns broker credentials and the upstream WebSocket. Neither web process needs those credentials. PostgreSQL stores account snapshots, order intents, fills/trades, halt/baseline state, research reports, discovery snapshots and recorded bar-days. API processes fan out authenticated named SSE events. A worker advisory lease blocks concurrent owners; loss of the lease stops order authority. Entry/exit IDs are journaled before broker calls and reconciled after uncertain responses.

Web deployment separation is controlled by `WEB_PRODUCT=trader|scanner`. Each API uses its own HTTPS origin/cookie. The native client uses the scanner API with an expiring bearer identity. Sharing the same API contract does not make the iPhone UI a wrapper.

## Authentication and credential boundaries

- Public health endpoints expose only process/database readiness and mode.
- Private operators sign in with a separate long `ADMIN_TOKEN`, then use HttpOnly, Secure, SameSite=Strict cookies. Mutating browser requests require the exact configured Origin and JSON. Invalid Authorization headers cannot fall back to a privileged cookie.
- Production admin/session secrets must be different and at least 32 characters. A configured private preview viewer token must also be long and distinct. This preview token is not public consumer auth.
- Consumer JWTs use HTTPS JWKS, restricted asymmetric algorithms, issuer/audience checks, required expiry/issued-at/subject and an entitlement claim. Viewer identities cannot access account data, research controls or broker actions.
- SSE is capped per identity and closes at the identity's expiry or 30 minutes, whichever is sooner. Slow consumers are disconnected and can recover from snapshots. Immediate provider revocation still depends on short token lifetime/provider policy; JWTs are not introspected on every event.
- Native Release builds use OAuth authorization code with PKCE and lock the backend origin. Access/refresh credentials live in device-only Keychain storage. No native/client broker key, WebView, client secret, token URL parameter or arbitrary proxy endpoint exists.
- API errors never return upstream raw broker bodies. The replacement `/settings` and legacy arbitrary proxy routes return 410. Secrets must be rotated if previously exposed; removing an endpoint is not revocation.

## Research lifecycle

1. Record real, completed minute bars and the universe actually admitted at that time, including first-discovery time and a snapshot ID.
2. Every evening at 21:00 New York, enqueue one durable run for that session date. An interrupted run is marked failed and can be retried.
3. A separate worker thread performs bounded deterministic parameter search inside eight registered strategy families. Risk limits are not optimizer dimensions.
4. Split by exchange-session **date**, not ticker-days. Rank on training. Evaluate the selected challenger and baseline on later validation/holdout with embargo. The training-only expanding-window audit is reported separately.
5. Retain all decisions and rejection reasons, including synthetic data, too few real sessions/trades, missing point-in-time provenance, incomplete sessions, poor cost-adjusted results and consumed holdout dates.
6. Store candidate versions for subsequent forward shadow observation. Up to three most recently retained shadow candidates per strategy are replayed separately. Manual candidates do not replace the baseline.
7. Paper approval is explicit and rechecked server-side against the exact version: complete qualifying research, matching immutable parameters, at least 20 subsequent finalized shadow trades across five sessions, positive cost-adjusted P&L, profit factor ≥1.2 and bounded simulated drawdown. A global environment switch must separately enable paper execution.

No automatic live-money promotion exists. New code families, news-based hypotheses, neural model training, external research ingestion and arbitrary generated-code execution are not implemented. Here “train/tune” means reproducible parameter optimization, not a claim that a neural model learns to be profitable.

The archived files contain no qualifying historical dataset. Missing evidence is a visible blocked result, not a reason to fill in imagined backtests. Recorded data can accumulate forward; use the normalized historical import tool for independently retained real point-in-time observations. Historical winner-only backfills must not be relabeled as contemporaneous discovery.

## Execution policy

The new engine is long-only US equities, paper only. It uses the broker's actual regular-session calendar for entries, verifies active/tradable assets, spread and quote freshness, sizes with conservative cash/risk/exposure reservations, and attaches an initial protective stop. It begins closing owned positions before the broker's session close. Unknown positions, inconsistent quantities, replaced orders or unresolved submissions block further automation.

The daily baseline and 3% maximum configured loss threshold are durable. A halt cannot be cleared through Resume or redeployment. Protective orders and managed exits continue after a manual entry pause. Shadow observation and research continue after a paper loss halt; a temporary account failure blocks paper entries without intentionally disabling market recording/research.

Managed trailing/time exits use completed bars and fresh quotes, checked roughly every 15 seconds, then wait for broker cancellation confirmation before flattening. The initial broker stop remains a backstop. This latency is not equivalent to the minute-bar simulator's idealized execution and can change realized outcomes. Gaps, halts and slippage can exceed planned stop loss. Brokerage statements remain the authoritative fee/position record.

## Interpreting the dashboard

| Record                | What it means                                                           | Do not infer                                             |
| --------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------- |
| Account equity        | Broker paper-account mark; includes account-wide positions/cash         | Sum of every strategy simulation                         |
| Baseline strategy P&L | One baseline simulation per symbol/session/strategy                     | Shared-capital portfolio performance                     |
| Candidate P&L         | A separate alternative parameter experiment                             | Additional profit earned alongside its baseline          |
| Paper trade P&L       | Confirmed fills; gross/provisional until fees are reconciled            | Zero fees just because a statement has not been imported |
| Hit rate              | Closed wins divided by closed trades, with a Wilson confidence interval | Probability the next trade will win                      |
| Strategy drawdown     | Realized closed-trade drawdown                                          | Full intraday marked-to-market loss or portfolio maximum |
| MFE/MAE               | Known dollar excursions; unavailable when not recorded reliably         | Invented perfect knowledge within an OHLC candle         |
| Market score          | Transparent deterministic indicator/ranking heuristic                   | A calibrated forecast of profit                          |

The current scanner's relative-volume field is cumulative volume versus the prior full day's volume, not a time-of-day-adjusted RVOL estimate. Feed state and last-event age must be read together. SSE “workspace connected” describes the app connection, not proof of fresh market prints. The REST fallback returns latest snapshots, not a complete historical tape. Candles may be corrected by authoritative broker bars; trade conditions, corrections and cancelled prints are not a full institutional tick-normalization service.

## Scaling and operational work before wider distribution

This is a small-deployment foundation, not a claim of million-user capacity. API processes can share the database; the worker intentionally remains single-leader. Event batches respect PostgreSQL notification size and consumers have bounded tape buffers. User distribution must be load-tested against the selected feed and infrastructure plan.

The current ledger uses indexed JSONB state plus bar-day/audit tables. No hidden 2,000-record truncation may discard order ownership. Before substantial history/concurrency, add measured server-side pagination, retention/archival, schema migrations, a dedicated durable streaming bus, execution-event ingestion, portfolio replay, fee-statement reconciliation, backup/restore drills, alerting and provider-rate-limit capacity tests. LISTEN/NOTIFY is transient delivery; reconnecting clients must reload snapshots.

The web API is not a multi-tenant brokerage platform: one private operator controls one paper book. Viewer identity isolation protects that book, but per-user billing/account deletion, support operations, data redistribution licensing, App Store entitlements and a production identity provider remain release requirements.
