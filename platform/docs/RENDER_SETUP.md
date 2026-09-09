# Render setup — one small step at a time

Confirmed for this build: **Alpaca Algo Trader Plus / real-time SIP**, and Apple Developer Team **66HLLH4YED**. The worker Blueprint uses `ALPACA_DATA_FEED=sip`. Team selection is recorded in the Xcode project; it does not create signing certificates or prove bundle-ID ownership.

## First: replace the old keys

The old scanner's public `/settings` response exposed stored Alpaca credentials. Treat those old credentials as compromised. Do not send keys through chat, put them in an iPhone app, or commit them to GitHub.

1. Sign in to Alpaca yourself.
2. Select your **paper** account. Replace/regenerate its API key and secret using Alpaca's API-key controls. Save the new pair in your password manager.
3. Do not use the old pair again. Key replacement can interrupt the old services until you update them.
4. Keep the replacement secret private. I do not need to see it: you can paste it directly into Render.

## A. Put replacement keys into the existing scanner

This is for the **old** deployed scanner while the new stack is being staged. The variable names differ slightly between old and new code.

1. Open [your scanner in Render](https://dashboard.render.com/web/srv-d975j23tqb8s73c0dqbg).
2. Click **Environment** on the left.
3. Click **Add Environment Variable**.
4. Add these rows. Paste only the value in the value box—no quotes, spaces or extra lines.

| Name box              | Value box                                 |
| --------------------- | ----------------------------------------- |
| `APCA_API_KEY_ID`     | Your **new paper** API key ID             |
| `APCA_API_SECRET_KEY` | The matching **new paper** secret         |
| `SERVER_FEED`         | `sip` — your confirmed real-time SIP plan |

5. Click **Save, rebuild, and deploy** (Render's label can vary slightly).
6. Wait until the deployment is marked **Live**.
7. Close old scanner browser tabs and reopen one. Do not paste the keys into the browser settings.

Setting environment variables does not revoke already exposed keys or fix every defect in the old code. Deploy the included legacy settings hotfix as well, and then migrate to the authenticated v2 gateway. Do not resume the old trader merely to clear its daily loss halt.

[Render's environment-variable instructions](https://render.com/docs/configure-environment-variables) describe the same Environment screen and save/deploy choices.

## B. Create the new stack without overwriting the old apps

The proposed `render.yaml` contains **two web services, one always-on market/engine worker, and one PostgreSQL database**. These are additional paid resources. Review Render's displayed total before clicking Create. Nothing in the source requires you to buy services automatically.

The existing Algo Trader is a **web** service running `node engine.js trade`. Do not convert it to a worker in place; service types are immutable. The new architecture splits that responsibility deliberately.

1. Make sure the rebuilt source has been pushed to a GitHub branch with this directory at `platform/`.
2. In Render, click **New → Blueprint**, select `putneyc11/Momentum-scanner`, and choose the rebuild branch.
3. Set the **Blueprint Path** to `platform/render.yaml`.
4. Review the proposed resource names and prices. The names are `momentum-algo-v2`, `momentum-scanner-v2`, `momentum-market-v2`, and `momentum-state-v2`.
5. Enter the requested replacement Alpaca keys for **momentum-market-v2 only**. Neither web service nor the iPhone app needs broker credentials.
6. Enter each web app's exact HTTPS URL for its `PUBLIC_ORIGIN`. If Render chooses a suffixed URL, copy the URL from that service's page and correct Environment → `PUBLIC_ORIGIN`, then redeploy. Do not include a trailing slash or `/scanner` path.
7. Leave `PAPER_TRADING_ENABLED=false`.
8. Once created, open the Algo service's **Environment** page. Render generates an `ADMIN_TOKEN`. Copy it into your password manager, then use it to sign into the new web dashboard. It is the dashboard password, **not** your Alpaca key.

The Blueprint disables automatic deployments so an unrelated push cannot restart trading. It links PostgreSQL internally and blocks public database access. The worker records data and runs nightly research; a second cron job is unnecessary.

### New worker variables

| Name                    | Initial value / purpose                                      |
| ----------------------- | ------------------------------------------------------------ |
| `APP_MODE`              | `paper` — live market observations, paper account only       |
| `SERVICE_ROLE`          | `worker`                                                     |
| `DATABASE_URL`          | Filled automatically by the Blueprint                        |
| `APCA_API_KEY_ID`       | Replacement paper key                                        |
| `APCA_API_SECRET_KEY`   | Replacement paper secret                                     |
| `ALPACA_DATA_FEED`      | `sip` — your confirmed Algo Trader Plus entitlement          |
| `PAPER_TRADING_ENABLED` | Keep `false` during verification                             |
| `DAILY_LOSS_LIMIT_PCT`  | `3`; code rejects values above 3                             |
| `RISK_PER_TRADE_PCT`    | `0.25`; isolated planned risk, not a guaranteed maximum loss |
| `MAX_OPEN_POSITIONS`    | `4`                                                          |
| `RESEARCH_HOUR_ET`      | `21` — 9pm New York, DST-aware                               |

There is intentionally no broker “live URL” setting. `sip` and `iex` are not interchangeable quality tiers: IEX is a limited exchange feed, not a promise of consolidated tick coverage. A polling state means latest-print snapshots about every three seconds, not every market trade.

### Connection-limit warning

The new stack opens one upstream market stream and shares it with web/iOS. Your old services or other programs may still consume the same Alpaca account's stream allowance. Stop their streams during cutover, or use an independently authorized account/entitlement. Generating a second key for the same account does not prove a separate connection allowance. Error 406 is shown explicitly; it is not hidden behind a green “connected” label. [Alpaca stream errors](https://docs.alpaca.markets/us/docs/streaming-market-data)

## C. Connect an iPhone privately

For a **Debug-only** test, set a separate random `VIEWER_TOKEN` on the new scanner web service and redeploy. In the native app's Settings, enter the scanner service's HTTPS URL and that viewer token. Do not use `ADMIN_TOKEN` on the phone. See the [native setup guide](../apps/ios/README.md).

For a consumer Release/App Store build, configure a real OIDC provider instead. All three server fields must be set together on the scanner API:

| Server field    | Meaning                                        |
| --------------- | ---------------------------------------------- |
| `OIDC_ISSUER`   | Exact HTTPS issuer from your identity provider |
| `OIDC_AUDIENCE` | API identifier for Momentum Scanner            |
| `OIDC_JWKS_URL` | Provider's HTTPS signing-key endpoint          |

The native build also needs the public `OIDC_CLIENT_ID`, issuer, audience and API URL. Register the exact callback `com.momentumscanner.app://auth/callback`. The provider must issue expiring access JWTs with `sub`, `iat`, `exp`, the correct issuer/audience and `momentum_scanner: true` for entitled users. Never embed a client secret in a native application. Provider setup, market-data display rights and account deletion must be completed before public distribution.

## D. Before allowing paper entries

1. Use the [release checklist](RELEASE_CHECKLIST.md) during an actual open market session.
2. Ensure old and new engines are not controlling the same account simultaneously. Existing unknown positions/orders block the new engine intentionally; reconcile them in Alpaca rather than pretending they belong to the new ledger.
3. Observe fresh prices/tape, restart recovery, feed interruption, partial fills and cancellations in a controlled Alpaca **paper** test.
4. Let actual historical/forward evidence accumulate. In a strategy's Versions view, review the exact candidate and every blocked eligibility reason.
5. Explicitly approve only an eligible version for **paper** execution. The endpoint rechecks the gates; UI state alone cannot approve it.
6. Only after that testing, change the **worker's** `PAPER_TRADING_ENABLED` to `true` and deploy it.

“Resume” only clears an operator pause. It never clears a same-day loss halt. Restarting or redeploying also does not reset that day's persisted baseline or halt.

## What I still need from you

- Replacement keys entered privately into Render and confirmation whether your market-data entitlement is SIP or IEX.
- Approval of Render's displayed cost and choice of when to cut over the existing URLs.
- Apple Developer Team and confirmation that you own `com.momentumscanner.app` (or your desired owned bundle ID).
- Your production identity-provider account/configuration, support/privacy URLs, app icon and market-data distribution rights.

Do not share passwords or API secrets in chat. Share only public identifiers, account choices and confirmation that setup steps are complete.
