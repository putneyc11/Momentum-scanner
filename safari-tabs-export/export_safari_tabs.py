#!/usr/bin/env python3
"""Export all open Safari and Chrome tabs to an AirDrop-friendly HTML +
Markdown list, with an AI-generated one-line description of each page.

Runs on a stock Mac: standard library only (the Claude API is called over
raw HTTPS with urllib, so no pip install is required).

Usage:
    export ANTHROPIC_API_KEY=sk-ant-...   # optional but recommended
    python3 export_safari_tabs.py

    python3 export_safari_tabs.py --no-ai          # skip Claude, use page metadata
    python3 export_safari_tabs.py --no-fetch       # don't download pages (titles only)
    python3 export_safari_tabs.py --browsers safari         # Safari only
    python3 export_safari_tabs.py --browsers chrome         # Chrome only
    python3 export_safari_tabs.py --output-dir ~/Downloads
    python3 export_safari_tabs.py --model claude-opus-5

The first run will ask for permission to control each browser
(System Settings > Privacy & Security > Automation).
"""

import argparse
import concurrent.futures
import datetime
import html
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from html.parser import HTMLParser

API_URL = "https://api.anthropic.com/v1/messages"
DEFAULT_MODEL = "claude-opus-5"
ANTHROPIC_VERSION = "2023-06-01"
# Server-side refusal fallbacks: if a request is declined by safety filters the
# API transparently retries it on a fallback model within the same call.
FALLBACK_BETA = "server-side-fallback-2026-07-01"

PAGE_FETCH_TIMEOUT = 12
PAGE_TEXT_LIMIT = 1200        # chars of page text sent to the model per tab
TABS_PER_API_CALL = 15
USER_AGENT = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15")

# Safari calls a tab's title "name"; Chromium browsers call it "title".
BROWSERS = {
    "safari": {"app": "Safari", "title_prop": "name", "label": "Safari"},
    "chrome": {"app": "Google Chrome", "title_prop": "title", "label": "Chrome"},
}

JXA_LIST_TABS = r"""
(function (appName, titleProp) {
  var result = {status: 'ok', windows: []};
  var app;
  try { app = Application(appName); } catch (e) {
    return JSON.stringify({status: 'not_installed', windows: []});
  }
  try {
    if (!app.running()) return JSON.stringify({status: 'not_running', windows: []});
    var windows = app.windows();
    for (var w = 0; w < windows.length; w++) {
      var tabs;
      try { tabs = windows[w].tabs(); } catch (e) { continue; }
      var entry = {window: w + 1, tabs: []};
      for (var t = 0; t < tabs.length; t++) {
        var url = null, title = null;
        try { url = tabs[t].url(); } catch (e) {}
        try { title = tabs[t][titleProp](); } catch (e) {}
        if (url) entry.tabs.push({url: url, title: title || url});
      }
      if (entry.tabs.length) result.windows.push(entry);
    }
  } catch (e) {
    var msg = String(e && e.message || e);
    var status = (msg.indexOf('1743') !== -1 || msg.toLowerCase().indexOf('not allowed') !== -1)
      ? 'not_allowed' : 'error';
    return JSON.stringify({status: status, message: msg, windows: []});
  }
  return JSON.stringify(result);
})
"""


def read_browser(key):
    """Return {'status': ..., 'windows': [{window, tabs: [{url, title}]}]} for one browser."""
    cfg = BROWSERS[key]
    script = JXA_LIST_TABS + f"({json.dumps(cfg['app'])}, {json.dumps(cfg['title_prop'])});"
    try:
        proc = subprocess.run(
            ["osascript", "-l", "JavaScript", "-e", script],
            capture_output=True, text=True, timeout=60,
        )
    except FileNotFoundError:
        sys.exit("osascript not found — this tool must be run on macOS.")
    if proc.returncode != 0:
        err = proc.stderr.strip()
        status = "not_allowed" if ("-1743" in err or "not allowed" in err.lower()) else "error"
        return {"status": status, "message": err, "windows": []}
    return json.loads(proc.stdout.strip())


def get_all_tabs(browser_keys):
    """Read every requested browser. Returns [{browser, window, tabs}, ...]."""
    groups = []
    for key in browser_keys:
        label = BROWSERS[key]["label"]
        info = read_browser(key)
        status = info.get("status")
        if status == "ok":
            n = sum(len(w["tabs"]) for w in info["windows"])
            print(f"  {label}: {n} tabs in {len(info['windows'])} window(s).")
            for w in info["windows"]:
                groups.append({"browser": label, "window": w["window"], "tabs": w["tabs"]})
        elif status == "not_running":
            print(f"  {label}: not running — skipped.")
        elif status == "not_installed":
            print(f"  {label}: not installed — skipped.")
        elif status == "not_allowed":
            print(f"  ! {label}: macOS blocked access. Allow it under System Settings >\n"
                  f"    Privacy & Security > Automation > (your terminal) > {BROWSERS[key]['app']}.",
                  file=sys.stderr)
        else:
            print(f"  ! {label}: could not read tabs "
                  f"({info.get('message', 'unknown error')}).", file=sys.stderr)
    return groups


class _PageParser(HTMLParser):
    """Grabs <title>, meta description, and a plain-text sample of the body."""

    SKIP = {"script", "style", "noscript", "svg", "template"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.description = ""
        self._in_title = False
        self._skip_depth = 0
        self._text = []
        self._text_len = 0

    def handle_starttag(self, tag, attrs):
        if tag == "title":
            self._in_title = True
        elif tag in self.SKIP:
            self._skip_depth += 1
        elif tag == "meta":
            a = dict(attrs)
            key = (a.get("name") or a.get("property") or "").lower()
            if key in ("description", "og:description") and not self.description:
                self.description = (a.get("content") or "").strip()

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        elif tag in self.SKIP and self._skip_depth:
            self._skip_depth -= 1

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skip_depth and self._text_len < PAGE_TEXT_LIMIT * 2:
            chunk = data.strip()
            if chunk:
                self._text.append(chunk)
                self._text_len += len(chunk)

    def text_sample(self):
        return re.sub(r"\s+", " ", " ".join(self._text))[:PAGE_TEXT_LIMIT]


def fetch_page(url):
    """Best-effort fetch of a page's title / description / text sample."""
    info = {"page_title": "", "description": "", "text": ""}
    if not url.startswith(("http://", "https://")):
        return info
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                               "Accept-Language": "en"})
    try:
        with urllib.request.urlopen(req, timeout=PAGE_FETCH_TIMEOUT) as resp:
            ctype = resp.headers.get("Content-Type", "")
            if "html" not in ctype and ctype:
                info["description"] = f"File / non-HTML resource ({ctype.split(';')[0]})"
                return info
            raw = resp.read(600_000)
    except Exception:
        return info
    charset = "utf-8"
    m = re.search(rb'charset=["\']?([\w.-]+)', raw[:2048])
    if m:
        charset = m.group(1).decode("ascii", "ignore") or "utf-8"
    try:
        text = raw.decode(charset, errors="replace")
    except LookupError:
        text = raw.decode("utf-8", errors="replace")
    parser = _PageParser()
    try:
        parser.feed(text)
    except Exception:
        pass
    info["page_title"] = re.sub(r"\s+", " ", parser.title).strip()
    info["description"] = parser.description
    info["text"] = parser.text_sample()
    return info


def call_claude(api_key, model, tabs_batch):
    """Ask Claude for a 1-2 sentence description of each tab in the batch.

    Returns {index_in_batch: summary}. Raises urllib.error.HTTPError on
    non-retryable API errors so the caller can decide what to do.
    """
    lines = []
    for i, tab in enumerate(tabs_batch):
        lines.append(json.dumps({
            "id": i,
            "url": tab["url"],
            "tab_title": tab["title"],
            "page_title": tab.get("page_title", ""),
            "meta_description": tab.get("description", ""),
            "page_text_sample": tab.get("text", ""),
        }, ensure_ascii=False))
    prompt = (
        "Here is a list of browser tabs, one JSON object per line. For each one, "
        "write a concise, concrete 1-2 sentence description of what the page is and "
        "what it's for, based on the URL, titles, and text sample. If there is almost "
        "no information, infer what you can from the URL and say so briefly. Do not "
        "start every summary the same way.\n\n"
        + "\n".join(lines)
        + '\n\nRespond with ONLY a JSON array like '
        '[{"id": 0, "summary": "..."}, ...] covering every id exactly once.'
    )
    body = {
        "model": model,
        "max_tokens": 8000,
        "output_config": {"effort": "low"},
        "fallbacks": "default",
        "messages": [{"role": "user", "content": prompt}],
    }
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "x-api-key": api_key,
            "anthropic-version": ANTHROPIC_VERSION,
            "anthropic-beta": FALLBACK_BETA,
            "content-type": "application/json",
        },
        method="POST",
    )
    last_err = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 529) and attempt < 3:
                time.sleep(2 ** (attempt + 1))
                last_err = e
                continue
            raise
        except urllib.error.URLError as e:
            if attempt < 3:
                time.sleep(2 ** (attempt + 1))
                last_err = e
                continue
            raise
    else:
        raise last_err  # pragma: no cover

    if data.get("stop_reason") == "refusal":
        return {}
    text = "".join(b.get("text", "") for b in data.get("content", [])
                   if b.get("type") == "text")
    m = re.search(r"\[.*\]", text, re.DOTALL)
    if not m:
        return {}
    try:
        items = json.loads(m.group(0))
    except json.JSONDecodeError:
        return {}
    return {int(it["id"]): str(it["summary"]).strip()
            for it in items
            if isinstance(it, dict) and "id" in it and it.get("summary")}


def summarize_with_ai(api_key, model, all_tabs):
    """Fill tab['summary'] for every tab, batching API calls. Returns True on success."""
    ok = True
    for start in range(0, len(all_tabs), TABS_PER_API_CALL):
        batch = all_tabs[start:start + TABS_PER_API_CALL]
        n_batches = (len(all_tabs) + TABS_PER_API_CALL - 1) // TABS_PER_API_CALL
        print(f"  Summarizing with Claude ({start // TABS_PER_API_CALL + 1}/{n_batches})...")
        try:
            summaries = call_claude(api_key, model, batch)
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = json.loads(e.read().decode("utf-8"))["error"]["message"]
            except Exception:
                pass
            print(f"  ! Claude API error {e.code}: {detail or e.reason}", file=sys.stderr)
            if e.code == 401:
                print("  ! Check your ANTHROPIC_API_KEY. Falling back to page metadata.",
                      file=sys.stderr)
                return False
            summaries = {}
            ok = False
        except Exception as e:
            print(f"  ! Claude API request failed: {e}", file=sys.stderr)
            summaries = {}
            ok = False
        for i, tab in enumerate(batch):
            if i in summaries:
                tab["summary"] = summaries[i]
    return ok


def fallback_summary(tab):
    desc = tab.get("description") or ""
    if desc:
        return desc if len(desc) <= 300 else desc[:297] + "..."
    return "No description available — see the page title and link."


def domain_of(url):
    m = re.match(r"https?://([^/]+)", url)
    return m.group(1).replace("www.", "") if m else url


def build_markdown(groups, generated_at):
    total = sum(len(w["tabs"]) for w in groups)
    lines = [f"# Open Tabs — {generated_at:%B %-d, %Y at %-I:%M %p}",
             "", f"{total} tabs across {len(groups)} window(s).", ""]
    for w in groups:
        lines.append(f"## {w['browser']} — Window {w['window']} ({len(w['tabs'])} tabs)")
        lines.append("")
        for tab in w["tabs"]:
            title = tab.get("page_title") or tab["title"]
            lines.append(f"- **[{title}]({tab['url']})**")
            lines.append(f"  {tab['summary']}")
        lines.append("")
    return "\n".join(lines)


def build_html(groups, generated_at, ai_used):
    total = sum(len(w["tabs"]) for w in groups)
    e = html.escape
    sections = []
    for w in groups:
        cards = []
        for tab in w["tabs"]:
            title = tab.get("page_title") or tab["title"]
            cards.append(f"""
      <div class="card">
        <div class="dom">{e(domain_of(tab['url']))}</div>
        <a class="title" href="{e(tab['url'], quote=True)}">{e(title)}</a>
        <p class="sum">{e(tab['summary'])}</p>
        <a class="url" href="{e(tab['url'], quote=True)}">{e(tab['url'])}</a>
      </div>""")
        sections.append(f"""
    <section>
      <h2>{e(w['browser'])} — Window {w['window']} <span class="count">{len(w['tabs'])} tabs</span></h2>
      {''.join(cards)}
    </section>""")
    note = ("Descriptions generated by Claude." if ai_used
            else "Descriptions taken from each page's own metadata.")
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Open Tabs — {generated_at:%Y-%m-%d %H:%M}</title>
<style>
  :root {{
    --bg: #f6f6f8; --card: #ffffff; --ink: #1c1c22; --muted: #6b6b76;
    --accent: #0a68d6; --line: #e4e4ea;
  }}
  @media (prefers-color-scheme: dark) {{
    :root {{ --bg: #141418; --card: #1e1e24; --ink: #ececf1; --muted: #9a9aa6;
            --accent: #5aa2ff; --line: #2c2c34; }}
  }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; background: var(--bg); color: var(--ink);
         font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
  main {{ max-width: 760px; margin: 0 auto; padding: 40px 20px 80px; }}
  header h1 {{ font-size: 28px; margin: 0 0 4px; }}
  header p {{ color: var(--muted); margin: 0 0 8px; }}
  h2 {{ font-size: 15px; text-transform: uppercase; letter-spacing: .06em;
       color: var(--muted); margin: 36px 0 12px; }}
  .count {{ font-weight: 400; }}
  .card {{ background: var(--card); border: 1px solid var(--line);
          border-radius: 12px; padding: 16px 18px; margin-bottom: 12px; }}
  .dom {{ font-size: 12px; color: var(--muted); letter-spacing: .02em; }}
  .title {{ display: block; font-weight: 600; font-size: 17px; color: var(--ink);
           text-decoration: none; margin: 2px 0 6px; overflow-wrap: anywhere; }}
  .title:hover {{ color: var(--accent); }}
  .sum {{ margin: 0 0 8px; }}
  .url {{ font-size: 12.5px; color: var(--accent); text-decoration: none;
         overflow-wrap: anywhere; }}
  footer {{ margin-top: 40px; font-size: 13px; color: var(--muted); }}
</style>
</head>
<body>
<main>
  <header>
    <h1>Open Tabs</h1>
    <p>{generated_at:%A, %B %-d, %Y at %-I:%M %p} &middot; {total} tabs
       across {len(groups)} window(s)</p>
  </header>
  {''.join(sections)}
  <footer>{note} Exported with export_safari_tabs.py.</footer>
</main>
</body>
</html>
"""


def main():
    ap = argparse.ArgumentParser(
        description="Export Safari and Chrome tabs with AI descriptions.")
    ap.add_argument("--browsers", default="safari,chrome",
                    help="comma-separated browsers to read: safari, chrome "
                         "(default: safari,chrome)")
    ap.add_argument("--no-ai", action="store_true",
                    help="skip Claude; use each page's own metadata as the description")
    ap.add_argument("--no-fetch", action="store_true",
                    help="don't download pages (faster; descriptions rely on titles/URLs)")
    ap.add_argument("--model", default=DEFAULT_MODEL,
                    help=f"Claude model ID (default: {DEFAULT_MODEL})")
    ap.add_argument("--output-dir", default="~/Desktop",
                    help="where to write the export files (default: ~/Desktop)")
    ap.add_argument("--no-reveal", action="store_true",
                    help="don't open the export location in Finder when done")
    args = ap.parse_args()

    browser_keys = [b.strip().lower() for b in args.browsers.split(",") if b.strip()]
    unknown = [b for b in browser_keys if b not in BROWSERS]
    if unknown:
        sys.exit(f"Unknown browser(s): {', '.join(unknown)}. "
                 f"Choose from: {', '.join(BROWSERS)}.")

    print("Reading browser tabs...")
    groups = get_all_tabs(browser_keys)
    all_tabs = [tab for w in groups for tab in w["tabs"]]
    if not all_tabs:
        sys.exit("No open tabs found — make sure Safari and/or Chrome is running "
                 "with the tabs you want.")
    print(f"  Total: {len(all_tabs)} tabs in {len(groups)} window(s).")

    if not args.no_fetch:
        print("Fetching page details (this can take a minute)...")
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            for tab, info in zip(all_tabs, pool.map(fetch_page,
                                                    [t["url"] for t in all_tabs])):
                tab.update(info)

    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    ai_used = False
    if not args.no_ai and api_key:
        ai_used = summarize_with_ai(api_key, args.model, all_tabs)
    elif not args.no_ai:
        print("  No ANTHROPIC_API_KEY set — using page metadata for descriptions.\n"
              "  (export ANTHROPIC_API_KEY=... to enable AI summaries)")
    for tab in all_tabs:
        if not tab.get("summary"):
            tab["summary"] = fallback_summary(tab)

    now = datetime.datetime.now()
    out_dir = os.path.expanduser(args.output_dir)
    os.makedirs(out_dir, exist_ok=True)
    stem = f"Open Tabs {now:%Y-%m-%d %H.%M}"
    html_path = os.path.join(out_dir, stem + ".html")
    md_path = os.path.join(out_dir, stem + ".md")
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(build_html(groups, now, ai_used))
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(build_markdown(groups, now))

    print(f"\nDone — {len(all_tabs)} tabs exported:")
    print(f"  {html_path}")
    print(f"  {md_path}")
    print("\nTo AirDrop: right-click the .html file in Finder > Share > AirDrop.")
    if not args.no_reveal:
        subprocess.run(["open", "-R", html_path], check=False)


if __name__ == "__main__":
    main()
