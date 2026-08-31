#!/usr/bin/env python3
"""
Momentum Scanner build script.
  src/momentum-dashboard.jsx  (canonical source — edit THIS file)
  src/server.template.js      (server source with __ICON_B64__ placeholder)
      │
      ▼  python3 build/build.py
  deploy/index.html           (bundled single-file client)
  deploy/server.js            (icon-injected server)

Requirements: node >= 18, esbuild, react, react-dom on the npm path.
  npm i -g esbuild && npm i react react-dom   (or point ESBUILD below at a local install)

The canonical JSX targets the claude.ai artifact runtime (window.storage,
absolute Alpaca URLs). This script rewrites it for standalone deployment:
localStorage, same-origin proxy paths, and a createRoot mount. If you edit
the storage-load/save blocks in the JSX, update the matching REPS pair here —
every pair asserts, so a drifted anchor fails loudly instead of silently
shipping a half-transformed build.
"""
import os, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src", "momentum-dashboard.jsx")
TPL = os.path.join(ROOT, "src", "server.template.js")
ICON = os.path.join(ROOT, "build", "icon.b64")
OUT = os.path.join(ROOT, "deploy")
ESBUILD = os.environ.get("ESBUILD", "esbuild")

REPS = [
    ('import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";',
     'import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";\nimport { createRoot } from "react-dom/client";'),
    ('const DATA_URL = "https://data.alpaca.markets";', 'const DATA_URL = "/alpaca"; // proxied'),
    ('const TRADING_URL = "https://paper-api.alpaca.markets";', 'const TRADING_URL = "/trading"; // proxied'),
    ('''      try {
        const r = await window.storage.get("alpaca-keys");
        if (r && r.value) v = JSON.parse(r.value);
      } catch {}''',
     '''      try {
        const raw = localStorage.getItem("alpaca-keys");
        if (raw) v = JSON.parse(raw);
      } catch {}'''),
    ('try { await window.storage.set("alpaca-keys", JSON.stringify({ ...sv, ver: 3 })); } catch {}',
     'try { localStorage.setItem("alpaca-keys", JSON.stringify({ ...sv, ver: 3 })); } catch {}'),
    ('''        const r0 = await window.storage.get("alpaca-keys");
        const v0 = r0 && r0.value ? JSON.parse(r0.value) : {};
        await window.storage.set("alpaca-keys", JSON.stringify({ ...v0, alertsOn }));''',
     '''        const raw0 = localStorage.getItem("alpaca-keys");
        const v0 = raw0 ? JSON.parse(raw0) : {};
        localStorage.setItem("alpaca-keys", JSON.stringify({ ...v0, alertsOn }));'''),
    ('''          const uc = await window.storage.get("uni-cache");
          if (uc && uc.value) {
            const v = JSON.parse(uc.value);''',
     '''          const ucraw = localStorage.getItem("uni-cache");
          if (ucraw) {
            const v = JSON.parse(ucraw);'''),
    ('try { await window.storage.set("uni-cache", JSON.stringify({ t: Date.now(), symbols: universeRef.current })); } catch (e) {}',
     'try { localStorage.setItem("uni-cache", JSON.stringify({ t: Date.now(), symbols: universeRef.current })); } catch (e) {}'),
    ('try { await window.storage.set("alpaca-keys", JSON.stringify({ ...keys, maxPrice, feed, minDayVol, ver: 3 })); } catch {}',
     'try { localStorage.setItem("alpaca-keys", JSON.stringify({ ...keys, maxPrice, feed, minDayVol, ver: 3 })); } catch {}'),
    ('try { window.storage.set("muted-syms", JSON.stringify({ day: etDay(Date.now()), syms: [...set] })); } catch (e) {}',
     'try { localStorage.setItem("muted-syms", JSON.stringify({ day: etDay(Date.now()), syms: [...set] })); } catch (e) {}'),
    ('''      try {
        const mr = await window.storage.get("muted-syms");
        if (mr && mr.value) restoreMuted(JSON.parse(mr.value));
      } catch {}''',
     '''      try {
        const mraw = localStorage.getItem("muted-syms");
        if (mraw) restoreMuted(JSON.parse(mraw));
      } catch {}'''),
    ('''      let seen = false, hasKeys = false;
      try {
        const os = await window.storage.get("onboard-seen");
        seen = !!(os && os.value);
      } catch {}
      try {
        const kr = await window.storage.get("alpaca-keys");
        hasKeys = !!(kr && kr.value);
      } catch {}''',
     '''      let seen = false, hasKeys = false;
      try { seen = !!localStorage.getItem("onboard-seen"); } catch {}
      try { hasKeys = !!localStorage.getItem("alpaca-keys"); } catch {}'''),
    ('try { window.storage.set("onboard-seen", "1"); } catch (e) {}',
     'try { localStorage.setItem("onboard-seen", "1"); } catch (e) {}'),
    ('export default function App()', 'function App()'),
]

HTML_SHELL = """<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#0A0E13">
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icon.png">
<title>Momentum Scanner</title>
<style>
html,body{margin:0;padding:0;background:#0A0E13;color:#E8ECF1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;overscroll-behavior:none}
#errbox{display:none;position:fixed;inset:0;background:#0A0E13;color:#F6465D;padding:24px;font-family:monospace;font-size:12px;z-index:999;white-space:pre-wrap;overflow:auto}
</style>
<script>
window.addEventListener('error',function(e){var b=document.getElementById('errbox');if(b){b.style.display='block';b.textContent='JS error:\\n'+(e.message||e)+'\\n'+(e.filename||'')+':'+(e.lineno||'');}});
</script>
</head>
<body>
<div id="errbox"></div>
<div id="root"><div id="boot" style="padding:40px;font-family:monospace;color:#5A6472">booting…</div></div>
</script>
<script>
</script>
</body>
</html>
"""

def main():
    src = open(SRC).read()
    for a, b in REPS:
        assert a in src, "BUILD ANCHOR DRIFTED: " + a[:70]
        src = src.replace(a, b)
    src += '\ncreateRoot(document.getElementById("root")).render(<App />);\n'
    entry = os.path.join(ROOT, "build", "app.entry.jsx")
    open(entry, "w").write(src)

    bundle = os.path.join(ROOT, "build", "bundle.js")
    subprocess.check_call([ESBUILD, entry, "--bundle", "--minify", "--target=es2019",
                           '--define:process.env.NODE_ENV="production"', "--outfile=" + bundle])
    js = open(bundle).read().replace("</script", "<\\/script")
    # splice: everything between the two adjacent script tags in the shell
    pre, sep, _ = HTML_SHELL.partition("</script>\n<script>\n")
    html = pre + sep + js + "\n</script>\n</body>\n</html>\n"
    open(os.path.join(OUT, "index.html"), "w").write(html)

    tpl = open(TPL).read()
    icon = open(ICON).read().strip()
    open(os.path.join(OUT, "server.js"), "w").write(tpl.replace("__ICON_B64__", icon))
    subprocess.check_call(["node", "--check", os.path.join(OUT, "server.js")])
    # Render serves from the repo root (render.yaml: `node server.js`) — keep
    # the root copies in lockstep with deploy/ so a push always ships the build.
    shutil.copyfile(os.path.join(OUT, "index.html"), os.path.join(ROOT, "index.html"))
    shutil.copyfile(os.path.join(OUT, "server.js"), os.path.join(ROOT, "server.js"))
    print("built deploy/index.html + deploy/server.js (+ copies at repo root)")

if __name__ == "__main__":
    sys.exit(main())
