# Premarket Momentum Scanner — hosted deploy

Live top-10 small-cap gainers dashboard (Alpaca data) with VWAP, EMAs,
support/resistance targets, and a full-screen advanced chart with live ticks.

## Deploy on Render (free) — works entirely from a phone

1. **Put this folder on GitHub**
   - Go to github.com → New repository → name it `momentum-scanner` → Create
   - On the repo page: Add file → Upload files → upload all 5 files → Commit
   - (In mobile Safari, use "Request Desktop Website" if the upload button is hidden)

2. **Deploy it**
   - Go to render.com → sign up with your GitHub account
   - New → Web Service → select the `momentum-scanner` repo
   - Render auto-detects Node. Instance type: **Free**. Click Deploy.

3. **Open your URL**
   - You get a link like `https://momentum-scanner.onrender.com`
   - Open it on your iPhone, enter your Alpaca keys, tap Start scanning
   - Add to Home Screen in Safari for an app-like icon

## Notes

- **Free tier sleeps** after ~15 min idle. First open of the morning takes
  ~30-60 s to wake, then it's instant. Open it a minute before 4:00 AM ET.
- **Keep the URL to yourself.** Your API keys live only in your phone's
  browser storage, never on the server — but the proxy itself is public,
  so don't share the link.
- **Run locally instead:** `node server.js` then open http://localhost:8787

## Files

- `server.js` — serves the app + proxies Alpaca REST calls past CORS
- `index.html` — the entire dashboard (React, single file)
- `package.json`, `render.yaml` — deploy config

## Development

`index.html` and `server.js` are BUILD OUTPUTS — don't edit them by hand.

- `src/momentum-dashboard.jsx` — canonical client source (edit this)
- `src/server.template.js` — server source (edit this)
- `build/build.py` — bundles both into `deploy/` and copies them to the
  repo root (what Render serves): `npm i && python3 build/build.py`
- `tests/` — server unit tests + Playwright UI tests (see `tests/README.md`)
- `docs/PROJECT_HANDOFF.md` — full architecture + hard-won API facts; read
  it before changing discovery, alerts, or the build

The scanner is session-aware: premarket (4:00–9:30 AM ET) discovery runs on
Alpaca snapshots vs the prior close (≥10% gap, ≥25k premarket shares) and the
watchlist auto-populates fresh from the 4:00 AM open each day; regular hours
use the full-day sweep (≥25% day, min day volume). Tapping a row opens the
Advanced chart directly.
