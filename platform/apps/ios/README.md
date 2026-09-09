# Momentum for iPhone and iPad

A separate, native SwiftUI application targeting iOS 17+. There is no web view, JavaScript runtime, Capacitor, or embedded website. The scanner and iOS app share a versioned API, not a user interface.

Apple Developer Team **66HLLH4YED** is configured from the owner's confirmation. The current bundle ID remains **com.momentumscanner.app**, pending confirmation of ownership. No Apple signing credentials have been used or generated. APNs push delivery is not implemented in this release; an APNs Key ID is unnecessary for live prices. If adding push later, keep the `.p8` signing key in protected server storage, never the native bundle or chat.

## Open the app

1. Open **Momentum.xcodeproj** in this folder with Xcode.
2. At the top of Xcode, choose **Momentum**, then an iPhone simulator.
3. Press the triangle **Run** button.
4. Tap **Explore a simulated preview**. Preview values are clearly labeled and deliberately frozen.
5. Tap a stock. The chart supports **1m, 5m, 15m, 1h, and 1D** candles. Drag to pan, pinch to zoom, or tap a candle to inspect it. The crosshair button switches dragging from panning to inspection. **Latest** returns to the newest bar.
6. Open **Time & Sales** for individual prints. Open **Analysis** for indicators and definitions. Analysis loads automatically, without an Analyze button.
7. Tap a star to save a symbol to **Watchlist**. Pull down to refresh.

The preview is an interface demonstration, not evidence of a working market feed or a profitable strategy. It is never silently substituted for an unavailable live API.

## Connect your private development build

Run the backend from the repository root using its setup guide. In this iOS app's **Settings**:

1. Paste the new Momentum API's full HTTPS address in **Your server**.
2. Paste your backend's **VIEWER_TOKEN** into **App access token**.
3. Tap **Connect private preview token**.

Do not put an Alpaca API key, Alpaca secret, or an operator/admin token in this app. Private viewer tokens are a Debug-only setup tool. Release builds remove the manual-token control and require account sign-in.

For a simulator and API running on the same Mac, a Debug build permits `http://localhost:4100`. Check the backend's actual port. Physical iPhones cannot reach the Mac through the phone's own localhost address; use a deployed HTTPS server. HTTP to other hosts is rejected even in Debug.

## Consumer sign-in configuration

The native OAuth client is implemented with `ASWebAuthenticationSession`, authorization code flow, a cryptographically random state and verifier, and PKCE S256. It uses HTTPS OpenID discovery from the configured issuer, validates the callback, exchanges the code without a client secret, and saves access/refresh credentials in device-only Keychain storage. Refresh requests are coalesced and refreshed tokens replace old tokens. The app does not derive identity from unverified ID-token claims. The backend must verify the access JWT's signature, issuer, audience, expiry, and the `momentum_scanner: true` entitlement before returning data.

An identity provider account and its production configuration still need to be supplied. No real provider or account has been created by this build.

Configure these public build settings in `project.yml` (or pass them as Xcode build settings), then run `xcodegen generate`:

| Build setting | What belongs here |
| --- | --- |
| `MOMENTUM_SERVER_URL` | The deployed API's HTTPS origin; Release builds lock the server to this value. |
| `OIDC_ISSUER` | Your provider's HTTPS issuer, exactly matching the backend `OIDC_ISSUER`. |
| `OIDC_CLIENT_ID` | The provider's **native/public client** identifier, never a client secret. |
| `OIDC_AUDIENCE` | The API identifier, exactly matching the backend `OIDC_AUDIENCE`. |

Register the exact callback **`com.momentumscanner.app://auth/callback`** with the provider. Enable authorization code + PKCE, the `openid profile offline_access` scopes, and rotating refresh tokens for this public native client. Have the provider add `momentum_scanner: true` only for users entitled to market data. Configure the corresponding issuer, audience, and HTTPS JWKS URL on the backend. Use a test account to verify sign-in, refresh, revoked access, sign-out, and account deletion before a release.

The provider's profile is not stored or displayed in this client. No API key, client secret, bearer token, or refresh token should be placed in any build setting, Info.plist, URL, source file, or screenshot. The settings above are public identifiers, not secrets.

## What is built

- Native scanner search, rankings, sort controls, context menus and persisted watchlist.
- Native candlestick and volume rendering with pan, pinch zoom, inspect mode, reset, and accessibility descriptions and buttons.
- Automatic detail/analysis loading; a request for the same symbol and interval is coalesced while it is in flight.
- Time & Sales with deduplicated prints, integer/string trade IDs, subsecond ISO timestamps, uptick/downtick colors, and bounded storage.
- One live server event stream per app store, automatically cancelled in the background and reopened in the foreground with exponential retry and jitter.
- REST refresh resilience, explicit live/stale/offline/paused/preview status, upstream error visibility, and no claim that polling is tick-by-tick.
- Keychain `WhenUnlockedThisDeviceOnly` credentials, ephemeral network sessions, no cookie persistence, no redirects, no token query strings, and HTTPS validation.
- Native account sign-in, provider discovery, PKCE, state/callback validation, synchronized token refresh, and local sign-out.
- XCTest coverage of URL/token validation, SSE frames, decoder contracts, candle updates, out-of-order events, NY daily boundaries/DST, PKCE vectors/callbacks, and Keychain round trips; UI tests navigate the scanner, chart, tape, watchlist, and settings.

## API contract

The app sends `Authorization: Bearer …` to the same server for all requests:

- `GET /api/v1/session` must return `{ "authenticated": true }`; HTTP 200 by itself is not considered authenticated.
- `GET /api/v1/scanner` returns `{asOf, feed, stocks}`.
- `GET /api/v1/scanner/{symbol}?timeframe=1Min` returns `{symbol,bars,trades,analysis,quote,feed}`. Bars use Unix seconds. Tape timestamps use ISO 8601 strings. `1Min`, `5Min`, `15Min`, `1Hour`, and `1Day` are supported.
- `GET /api/v1/events` emits named SSE events: `tick` with `{symbol,price,size,time,id}`, `feed` with `{state,feed,lastEventAt,error}`, and optional `snapshot` with the scanner response.

Native daily candles use America/New_York midnight, including daylight saving time. REST and native updates must use the same grouping. Interval choices change candle aggregation, not the amount of history available on the server. The server determines data coverage and market-data entitlements. Current analysis is refreshed on selection, interval change, and pull-to-refresh; candles and tape update on each received tick.

## Build and test

There are no third-party Swift package dependencies. XcodeGen is only needed when changing `project.yml`; the generated Xcode project is included.

```sh
xcodegen generate
xcodebuild -project Momentum.xcodeproj -scheme Momentum \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -configuration Debug -derivedDataPath /private/tmp/momentum-ios-build \
  CODE_SIGNING_ALLOWED=NO build
```

For tests, choose an installed simulator using `xcrun simctl list devices available`, then:

```sh
xcodebuild -project Momentum.xcodeproj -scheme Momentum \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -configuration Debug -derivedDataPath /private/tmp/momentum-ios-tests \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- test
```

Simulator-only ad hoc signing is necessary to exercise Keychain entitlements. It does not sign for a physical device or App Store distribution. Use a derived-data directory outside iCloud Drive: file-provider metadata in synced Documents folders can cause Apple's `resource fork, Finder information, or similar detritus not allowed` signing error. UI test launch argument `--preview` opens the explicitly simulated dataset and requires no account.

## Put it on your own iPhone

1. Connect the iPhone to the Mac and unlock it.
2. In Xcode, click the blue **Momentum** project icon, then the **Momentum** app target.
3. Open **Signing & Capabilities**, select your Apple developer **Team**, and enable **Automatically manage signing**.
4. Use your owned bundle identifier. The current identifier is `com.momentumscanner.app`; confirm ownership before using it. If changing it, update the OAuth callback scheme in the project and `OAuthConfiguration` and re-register the provider callback.
5. Choose your iPhone at the top, then press **Run**. Follow Apple's Developer Mode prompt if shown.

## Before TestFlight or App Store submission

This is an implemented and testable native development build, not a claim of App Store approval or production readiness. Remaining release work requires the owner's accounts and choices:

- Supply the Apple Developer team, confirm the bundle ID, and provision signing. Nothing has been signed for distribution or uploaded.
- Supply and verify the production identity-provider settings and a correctly entitled account, including an account deletion route. A static shared token is not a consumer authentication system.
- Confirm market-data redistribution/display rights with the provider for the intended users, feed and subscription model. A personal Alpaca plan is not evidence of permission to redistribute data.
- Add the owned final app icon, support URL, privacy-policy URL, contact details, app description, age rating, review account/instructions and screenshots. These are not fabricated in the project.
- Review App Privacy answers and `PrivacyInfo.xcprivacy` against the final backend, identity provider, telemetry, payments and any later SDKs. The included manifest declares app-local UserDefaults use and no tracking for the current client; it is not a certification of future server practices.
- Confirm Apple's current payment and account rules for the final subscription model, including Sign in with Apple where applicable. No payment system or purchasable entitlement has been implemented here.
- Run physical-device tests for stream interruption, background/foreground, expiry/revocation, slow connections, VoiceOver, large type, landscape, and battery usage during an active market session. Validate real feed movement with authorized credentials; the local fixture cannot establish that.

Useful primary references: [Apple authentication sessions](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession), [URLSession asynchronous bytes](https://developer.apple.com/documentation/foundation/urlsession/bytes(for:delegate:)), [Apple required-reason privacy APIs](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype), and [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/).
