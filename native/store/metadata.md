# App Store Connect — copy-paste metadata

**Name:** Momentum Scanner
**Subtitle (30):** Small-cap momentum, live
**Bundle ID:** com.momentumscanner.app
**SKU:** momentum-scanner-ios
**Primary category:** Finance · **Secondary:** Utilities
**Age rating:** 4+ (no objectionable content; answer "No" to gambling/contests; it is not a trading platform — no unrestricted web access)
**Price:** Free
**Privacy Policy URL:** https://momentum-scanner.onrender.com/privacy
**Support URL:** https://momentum-scanner.onrender.com/support
**Marketing URL:** (optional) same as support
**Copyright:** © 2026 Corey Putney

## Promotional text (170)
Ranked small-cap gappers from 4 AM, live tape, confluence-gated lock-screen alerts, and AI-built trade plans.

## Description
Momentum Scanner finds the small-cap stocks that are moving right now and tells you when they are actually breaking out.

• Premarket discovery from 4:00 AM ET — gappers ranked by float rotation, VWAP, EMA stack, Supertrend and volume surge
• Regular-hours top movers refreshed every few seconds, plus a separate after-hours table
• Advanced view: full chart, live time & sales, big prints, Level 2 style traded depth, estimated LULD halt bands, and session replay
• Lock-screen alerts that fire on confluence, not noise — at least three signals lining up on the same bar, capped per stock and per hour
• Every alert is journaled with its 5 / 15 / 30-minute follow-through so you can see the real hit rate
• AI trade plans: support and resistance plus three long-only scenarios built from today's tape (generated text, never a recommendation)
• Catalyst headlines and dilution flags on every row

Momentum Scanner is market information for active traders. Nothing in the app is investment advice. Small-cap momentum stocks are extremely volatile; most gaps fade. Trade at your own risk.

## Keywords (100)
stock scanner,momentum,premarket,gappers,day trading,small cap,alerts,level 2,tape,VWAP,breakout,halts

## What's New (v2.0.0)
First App Store release.

## App Privacy (nutrition label answers)
- Data collected: **Contact Info → Email Address** (linked to user, App Functionality). **Identifiers → Device ID** (linked, App Functionality). **User Content → Other User Content** (watchlist & alert rules; linked, App Functionality).
- Tracking: **No**.
- Data not collected: purchases, location, contacts, browsing, health, financial info, diagnostics beyond server logs.

## App Review notes (paste into "Notes")
The app requires an access code on first launch. Reviewer code: `<INVITE_CODE>` (the value of the INVITE_CODE env var on Render — never commit it here).
Sign-in is by email only in this build; any email address works, no password or verification is required. Choose "Continue with Free".
Market discovery runs 4:00 AM – 8:00 PM US Eastern on trading days. Outside those hours the watchlist is empty by design. To see a populated Advanced view at any time, open any symbol from the watchlist during market hours, or use the ▶ Replay control which scrubs a past session.
Lock-screen alerts need notification permission; the server sends them via APNs when a watched symbol meets the confluence rule.
The Pro plan is displayed as "coming soon" and cannot be purchased in this build.

## Screenshots needed
- iPhone 6.9" (1320 × 2868) — required: 3 to 10. Suggested: watchlist during market hours, Advanced view with chart + tape, Level 2, AI plan card, alerts sheet, onboarding slide.
- iPhone 6.5" — optional (Apple scales the 6.9" set).
- No iPad set is needed because the app is iPhone-only (ios-setup.sh sets TARGETED_DEVICE_FAMILY = 1).
Capture with the simulator: Xcode → Simulator "iPhone 16 Pro Max" → ⌘S.
