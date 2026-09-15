# Native verification — September 9, 2026

| Check | Result |
| --- | --- |
| Debug simulator build, arm64 and x86_64 | Passed |
| Release simulator build, arm64 and x86_64 | Passed, unsigned |
| Full XCTest run | **19 passed, 0 failed, 0 skipped**: 18 unit tests + one multi-screen UI test |
| Final unit run after session/tape hardening | **18 passed, 0 failed, 0 skipped** |
| Final authentication regression run | **23 passed, 0 failed, 0 skipped**: all native unit tests, including five additional mocked-provider regressions |
| Keychain save, replacement, deletion | Passed on locally ad hoc-signed simulator host |
| Packaged privacy manifest and Debug localhost-only transport configuration | Passed |
| Release transport configuration | Inspected built Info.plist: no ATS exceptions; single-window lifecycle; no provider secrets |
| Native UI screenshots | Captured by the passing UI test, using explicitly labeled simulated preview data |

Environment: Xcode 26.3 (17C529), iPhone 17 Pro simulator running iOS 26.3.1, x86_64 runtime. Both arm64 and x86_64 simulator architectures compile. No third-party Swift packages are used.

Evidence included here:

- `Native-UI-and-Unit-Tests.xcresult`: open with Xcode to inspect the complete 19-test run and its screenshot attachments.
- `Final-Native-Unit-Tests.xcresult`: the final 18-unit-test pass after the session and stream/REST deduplication changes.
- `Auth-Regression-Tests.xcresult`: the latest 23-unit-test pass after authentication review fixes. HTTP 429/503 preserves retry and saved refresh state; successful retry rotates credentials; invalid_grant erases a revoked session; rejected API entitlement erases a new sign-in; temporary API 503 preserves it and exposes local sign-out.
- `Momentum-Release-simulator.app`: the final compiled **simulator-only, unsigned Release** artifact. This is not a device build, IPA, distribution signature, or App Store upload. It intentionally has no configured identity provider or backend and therefore cannot sign into production.
- `../Screenshots/scanner-preview.png`, `../Screenshots/detail-preview.png`, `../Screenshots/tape-preview.png`: native app screen captures, not generated mockups.

The first unsigned test attempt revealed the expected absence of Keychain entitlements; ad hoc simulator signing resolved that. A separate failure revealed that Swift's grapheme handling can make isolated CR/LF string checks miss a CRLF pair. Bearer validation now checks visible ASCII Unicode scalars, and the injection regression test passes. Builds were moved outside iCloud-synced Documents to avoid file-provider metadata breaking Apple's signing step.

Not established by these tests: live Alpaca delivery, consumer OIDC account enrollment and refresh against a real provider, physical-device battery/foreground tests, subscription payments, account deletion, provider distribution rights, Apple signing, or App Store approval. The setup guide names the owner configuration and release work still required.
