# Recorded verification — 9 September 2026

| Check                                                    | Observed result                                              |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| `npm run build`                                          | Engine/API TypeScript and web Vite production builds passed  |
| `npm run typecheck`                                      | Passed; web/engine are also typechecked by their build steps |
| `npm run format:check`                                   | Passed                                                       |
| `npm test` on Node 22.23.2                               | **58 passed:** API 35, web 9, engine 14                      |
| Native auth/unit regression suite                        | **23 passed**, no failures or skipped tests                  |
| Native navigation UI test                                | Passed in the recorded native UI/unit result bundle          |
| Native Release simulator                                 | Built for arm64 and x86_64; not signed for distribution      |
| Current official Render JSON schema                      | Blueprint passed; account-side creation/deploy not performed |
| Dependency audit after patched development-tool upgrades | Zero reported vulnerabilities at verification time           |
| Separate legacy settings hotfix                          | **7 passed**; published for review, not merged/deployed      |

The exact Render runtime target, Node 22.23.2 LTS, was downloaded from Node's official release host into an isolated temporary directory and its archive SHA-256 matched the [official release manifest](https://nodejs.org/dist/v22.23.2/SHASUMS256.txt). The user's installed Node version was not changed. The final build and complete JavaScript/TypeScript suite were rerun on that runtime.

## Browser observations

The running local API/web build was used to check strategy drilldowns, creating a candidate without changing the active version, viewing blocked candidate evidence, paper/simulation switching, a research run transitioning to an explicit insufficient-data result, automatic scanner analysis, Time & Sales, 1m-to-5m aggregation, zoom/pan and a 390-pixel mobile layout. Console errors were absent during these checks. These used explicitly labeled deterministic fixtures, not provider credentials.

Screenshots are in `apps/web/Screenshots/`. Native preview screenshots are in `apps/ios/Screenshots/`; native result bundles and the unsigned simulator build are in the local deliverable's `apps/ios/Verification/`. Generated Apple result bundles/binaries are excluded from the source-control branch but included in the local package.

## Not verified / not performed

- No live deployment or App Store/TestFlight upload.
- No new Alpaca keys were entered or used; no real broker orders were sent.
- No credentialed SIP/IEX feed test, Render PostgreSQL integration/soak test or real-device production-auth test.
- No verified profitable research dataset or profitable strategy. The archive has source material, not sufficient real point-in-time training observations.
- No new paid Render infrastructure was provisioned. Review the Blueprint and actual displayed costs first.

After explicit user approval on 9 September 2026, both review branches were pushed to `putneyc11/Momentum-scanner`: [settings hotfix PR #4](https://github.com/putneyc11/Momentum-scanner/pull/4) and [platform rebuild draft PR #5](https://github.com/putneyc11/Momentum-scanner/pull/5). The legacy hotfix commit is `009f6ca`; the initial rebuild commit is `b44e913`. Neither pull request was merged or deployed. The new source lives under `platform/`; deployment steps are in `RENDER_SETUP.md`.

The remaining credential/account/infrastructure gates are listed in `RELEASE_CHECKLIST.md`. Passing local tests is not a claim that those deployment gates have passed.
