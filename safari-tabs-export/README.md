# Safari + Chrome Tabs Export

Exports every open Safari and Google Chrome tab (all windows of both
browsers) into a clean, self-contained HTML page and a Markdown file, with
an AI-written 1–2 sentence description of what each page is — perfect for
AirDropping your whole browsing session to another machine. Browsers that
aren't installed or running are skipped automatically.

## What you get

Two files on your Desktop, e.g.:

- `Open Tabs 2026-08-23 14.30.html` — a styled, clickable list grouped by
  browser and window (light/dark mode aware, fully self-contained). Open it
  on any device.
- `Open Tabs 2026-08-23 14.30.md` — the same list as Markdown for notes apps.

When it finishes, the script reveals the HTML file in Finder so you can
right-click → **Share** → **AirDrop** immediately.

## Requirements

- macOS with Safari and/or Google Chrome (the tool reads tabs via
  AppleScript — nothing to install; it uses only the Python 3 that ships
  with macOS developer tools).
- Optional but recommended: an Anthropic API key for AI descriptions.
  Without one, the tool falls back to each page's own meta description.

## Setup

1. Copy the `safari-tabs-export` folder to your Mac (or clone this repo).
2. (Optional, for AI summaries) Save your API key either way:
   ```sh
   export ANTHROPIC_API_KEY=sk-ant-...        # in your shell / ~/.zshrc
   # or
   echo "sk-ant-..." > ~/.anthropic_key       # picked up by the .command launcher
   ```

## Run it

Double-click **Export Safari Tabs.command** in Finder, or from Terminal:

```sh
python3 export_safari_tabs.py
```

The first run triggers a macOS permission prompt to let your terminal control
each browser — click **Allow** (it's under System Settings → Privacy &
Security → Automation if you need to change it later).

## Options

| Flag | Effect |
|---|---|
| `--browsers LIST` | Which browsers to read: `safari`, `chrome`, or both (default `safari,chrome`) |
| `--no-ai` | Skip Claude; use each page's own metadata as the description |
| `--no-fetch` | Don't download pages (faster; descriptions rely on titles/URLs) |
| `--model ID` | Claude model to use (default `claude-opus-5`) |
| `--output-dir DIR` | Where to write the files (default `~/Desktop`) |
| `--no-reveal` | Don't open Finder at the export when done |

## How it works

1. Asks Safari and Chrome (via `osascript` / JXA) for the URL and title of
   every tab in every window, skipping any browser that isn't installed or
   running.
2. Fetches each page in parallel to grab its title, meta description, and a
   short text sample.
3. Sends the tabs to the Claude API in batches of 15 and asks for a concise
   description of each. Server-side refusal fallbacks are enabled, and any
   tab Claude can't describe falls back to the page's own metadata.
4. Writes the HTML + Markdown exports and reveals them in Finder.

Notes: pages behind logins or bot protection may only have their title and
URL to go on — the summary says so. Costs are small: one API call per 15
tabs, run at low effort.
