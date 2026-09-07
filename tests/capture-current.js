/* Captures the CURRENT app at every screen used in the redesign set, with the
   same mocked market data the suites use. Output: <outdir>/cap/NN-name.png
   (390x844 @3x). Not a test. Server on :8787. Run from tests/. */
let chromium; try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright')); }
const fs = require('fs'); const path = require('path');
const OUT = path.join(process.argv[2], 'cap'); fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function pin(h, m) {
  const nowD = new Date();
  const et = new Date(nowD.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const diff = nowD.getTime() - et.getTime();
  const tgt = new Date(et); tgt.setHours(h, m, 0, 0);
  const TARGET = tgt.getTime() + diff;
  return { TARGET, OFFSET: TARGET - Date.now() };
}
const JOURNAL = { stats: { n: 41, green15: 58.4, avg15: 1.9, avgMaxUp30: 3.4, tier2: { n: 29, green15: 52 }, tier3: { n: 12, green15: 67 } }, recent: [] };
const ACCOUNT = { provider: 'apple', email: '', plan: 'pro', createdAt: 0 };

async function ctx(browser, T, opts = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 790 }, deviceScaleFactor: 3, hasTouch: true });
  await page.addInitScript(([off]) => {
    const R = Date;
    class F extends R { constructor(...a) { a.length ? super(...a) : super(R.now() + off); } static now() { return R.now() + off; } }
    window.Date = F;
  }, [T.OFFSET]);
  if (opts.keys !== false) await page.addInitScript(([acct]) => {
    localStorage.setItem('alpaca-keys', JSON.stringify({ id: 'K', secret: 'S', feed: 'sip', maxPrice: 100, minDayVol: 5000000, alertsOn: true, ver: 3 }));
    localStorage.setItem('onboard-seen', '1');
    localStorage.setItem('account', JSON.stringify(acct));
  }, [ACCOUNT]);
  await page.route('**/float/**', (r) => r.fulfill({ json: { float: 12400000 } }));
  await page.route('**/push/**', (r) => r.fulfill({ json: { ok: true, key: 'x', devices: 1, lastError: null } }));
  await page.route('**/settings', (r) => r.fulfill({ json: {} }));
  await page.route('**/journal**', (r) => r.fulfill({ json: JOURNAL }));
  await page.route('**/auth/**', (r) => r.fulfill({ json: { ok: true } }));
  await page.route('**/config', (r) => r.fulfill({ json: { serverKeys: !!opts.serverKeys, invite: !!opts.serverKeys, feed: 'sip', plans: true, planModel: 'claude-opus-5', apns: false } }));
  await page.route('**/news/**', (r) => r.fulfill({ json: { headline: 'NVNI receives FDA fast-track designation for lead candidate', at: T.TARGET - 2520e3, url: 'https://example.com', dilution: false } }));
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + '.png') });

/* regular-hours market: one mover, GOODA (same shape as test26) */
function regularRoutes(page, T) {
  const dayISO = (o) => new Date(T.TARGET + (o || 0) * 864e5 - 90000).toISOString();
  const dailySet = () => { const out = []; for (let i = 5; i >= 1; i--) out.push({ t: dayISO(-i), o: 1, h: 1.1, l: .9, c: 1, v: 4e5 }); out.push({ t: dayISO(0), o: 1.05, h: 1.45, l: 1, c: 1.4, v: 15e6 }); return out; };
  const bars5 = () => { const a = []; for (let i = 0; i < 48; i++) { const c = 0.9 + i * 0.0105; const o = i ? a[i - 1].c : c - .01; const t = T.TARGET - (48 - i) * 5 * 60000; a.push({ t: new Date(t).toISOString(), o, h: c + .02, l: o - .02, c, v: 2e5 }); } return a; };
  const bars1 = (n) => { const a = []; for (let i = 0; i < n; i++) { const c = 1 + i * .004 + Math.sin(i / 3) * 0.006; a.push({ t: new Date(T.TARGET - (n - i) * 60000 - 5000).toISOString(), o: c - .005, h: c + .01, l: c - .01, c, v: 16000 + (i % 7) * 4000 }); } return a; };
  const SY = ['GOODA', 'CDTG', 'SOBR', 'HOLO', 'MLGO', 'XTIA', 'BNZI'];
  return Promise.all([
    page.route('**/trading/v2/assets?**', (r) => r.fulfill({ json: SY.map((s) => ({ symbol: s, tradable: true, status: 'active', exchange: 'NASDAQ' })) })),
    page.route('**/alpaca/v1beta1/**', (r) => r.fulfill({ json: { gainers: [], losers: [] } })),
    page.route('**/alpaca/v2/stocks/snapshots**', (route) => {
      const u = new URL(route.request().url(), 'http://x'); const syms = (u.searchParams.get('symbols') || '').split(',').filter(Boolean); const out = {};
      for (const s of syms) out[s] = { latestTrade: { p: 1.42, s: 500, t: new Date(T.TARGET).toISOString() }, dailyBar: { t: dayISO(0), o: 1.05, h: 1.45, l: 1, c: 1.4, v: 15e6 }, prevDailyBar: { t: dayISO(-1), o: 1, h: 1.1, l: .9, c: 1, v: 4e5 } };
      route.fulfill({ json: out });
    }),
    page.route('**/alpaca/v2/stocks/trades/latest**', (r) => r.fulfill({ json: { trades: Object.fromEntries(SY.map((s, i) => [s, { p: 1.42 + i * 0.003, s: 100, t: new Date(T.TARGET).toISOString() }])) } })),
    page.route('**/alpaca/v2/stocks/bars**', (route) => {
      const u = new URL(route.request().url(), 'http://x'); const tf = u.searchParams.get('timeframe'); const syms = (u.searchParams.get('symbols') || '').split(',').filter(Boolean); const bars = {};
      for (const s of syms) bars[s] = tf === '1Day' ? dailySet() : tf === '5Min' ? bars5() : bars1(syms.length === 1 ? 90 : 20);
      route.fulfill({ json: { bars } });
    }),
    page.route('**/alpaca/v2/stocks/*/trades/latest**', (r) => r.fulfill({ json: { trade: { p: 1.42, s: 100, t: new Date(T.TARGET).toISOString() } } })),
    page.route('**/alpaca/v2/stocks/*/quotes/latest**', (r) => r.fulfill({ json: { quote: { bp: 1.41, bs: 3, ap: 1.43, as: 2, t: new Date(T.TARGET).toISOString() } } })),
    page.route('**/plan', (r) => r.fulfill({ json: { cached: false, t: Date.now(), plan: {
      bias: 'bullish', summary: 'Holding VWAP with a rising tape; the dip to 1.24 is the trade.',
      levels: [{ price: 1.15, kind: 'support', label: 'VWAP', strength: 2 }, { price: 1.24, kind: 'support', label: 'EMA 8', strength: 3 }, { price: 1.50, kind: 'resistance', label: 'PMH', strength: 2 }],
      scenarios: [
        { name: 'Long continuation', stance: 'long', trigger: 'hold 1.24 and push through 1.31', entry_lo: 1.25, entry_hi: 1.28, stop: 1.19, targets: [1.34, 1.50], invalidation: 'loses 1.19 on a 1-min close', note: 'partials at T1' },
        { name: 'Dip buy', stance: 'long', trigger: 'pullback to VWAP that holds', entry_lo: 1.15, entry_hi: 1.18, stop: 1.10, targets: [1.28], invalidation: 'no bounce inside 3 bars', note: '' },
        { name: 'Stand aside', stance: 'wait', trigger: 'below 1.10 there is no long', entry_lo: 0, entry_hi: 0, stop: 0, targets: [], invalidation: '', note: 'reclaim of 1.15 reopens the dip buy' },
      ], must_hold: 1.19, must_fail: 1.10, risk_notes: 'Size small; halts likely above 1.50.', model: 'claude-opus-5' } } })),
  ]);
}

(async () => {
  const browser = await chromium.launch(process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {});

  /* ---- A) onboarding → account → plan → connect (fresh device, server-keys connect) ---- */
  {
    const T = pin(13, 0); const page = await ctx(browser, T, { keys: false, serverKeys: true }); await regularRoutes(page, T);
    await page.goto('http://localhost:8787/', { waitUntil: 'domcontentloaded' }); await wait(900);
    await shot(page, '01-onboarding');
    for (let i = 0; i < 5; i++) { await page.click('button:has-text("Next →")'); await wait(150); }
    await page.click('button:has-text("Create account")'); await wait(400); await shot(page, '02-create-account');
    await page.click('button:has-text("Continue with email")'); await wait(200);
    await page.fill('input[type="email"]', 'corey@example.com'); await wait(200); await shot(page, '03-email');
    await page.click('button:has-text("Continue")'); await wait(300); await shot(page, '04-plan');
    await page.click('button:has-text("Continue with Free")'); await wait(500); await shot(page, '04b-connect');
    await page.close();
  }
  /* ---- B) regular hours: home, advanced (chart / tape / level 2 / plan), alerts sheet, replay, feed down, about, settings ---- */
  {
    const T = pin(10, 42); const page = await ctx(browser, T); await regularRoutes(page, T);
    await page.goto('http://localhost:8787/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('span:has-text("GOODA")', { timeout: 20000 }); await wait(2500);
    await shot(page, '05-home');
    await page.click('button[aria-label="how this works and disclosures"]'); await wait(400); await shot(page, '16-about');
    await page.click('button:has-text("←")'); await wait(300);
    await page.click('span:has-text("GOODA")');
    await page.waitForSelector('text=Confluence tracker', { timeout: 15000 }); await wait(2500);
    await shot(page, '09-advanced-chart');
    const scrollTo = async (txt) => { await page.evaluate((t) => { const el = [...document.querySelectorAll('div,span')].find((e) => e.childElementCount === 0 && e.textContent.trim() === t); if (el) el.scrollIntoView({ block: 'start' }); }, txt); await wait(500); };
    await scrollTo('Time & Sales'); await shot(page, '10-advanced-tape');
    await scrollTo('Level 2'); await shot(page, '11-level2');
    await page.click('button[aria-label="analyze"]'); await wait(800);
    await scrollTo('AI trade plan'); await shot(page, '12-ai-plan');
    await page.evaluate(() => { const s = [...document.querySelectorAll('div')].find((d) => d.scrollHeight > d.clientHeight + 50 && getComputedStyle(d).overflowY !== 'visible'); if (s) s.scrollTop = 0; window.scrollTo(0, 0); }); await wait(300);
    await page.click('button[aria-label="alerts for GOODA"]'); await wait(500); await shot(page, '13-alerts-sheet');
    await page.click('button[aria-label="close alerts"]'); await wait(300);
    await page.click('button[aria-label="replay"]'); await wait(600); await shot(page, '17-replay');
    await page.click('button[aria-label="replay"]'); await wait(300);
    const deny = (r) => r.fulfill({ status: 403, json: { message: 'subscription does not permit querying recent SIP data' } });
    await page.route('**/alpaca/v2/stocks/*/trades/latest**', deny); await page.route('**/alpaca/v2/stocks/*/quotes/latest**', deny); await page.route('**/alpaca/v2/stocks/trades/latest**', deny);
    await page.click('button:has-text("←")'); await wait(13500); await shot(page, '08-feed-down');
    await page.click('button:has-text("Settings")'); await wait(500); await shot(page, '15-settings');
    await page.close();
  }
  /* ---- C) premarket ---- */
  {
    const T = pin(7, 30); const page = await ctx(browser, T);
    const iso = (t) => new Date(t).toISOString(); const dayISO = (o) => iso(T.TARGET + o * 864e5 - 90000);
    const PREV = { DILU: 1.67, NVNI: 2.66, AAME: 1.17, SOBR: 0.82, PRFX: 1.85, GRI: 0.72 }; const LIVE = { DILU: 3.14, NVNI: 4.10, AAME: 1.62, SOBR: 1.04, PRFX: 2.28, GRI: 0.88 };
    const SY = Object.keys(PREV);
    await page.route('**/trading/v2/assets?**', (r) => r.fulfill({ json: SY.map((s) => ({ symbol: s, tradable: true, status: 'active', exchange: 'NASDAQ' })) }));
    await page.route('**/alpaca/v1beta1/**', (r) => r.fulfill({ json: { gainers: [], losers: [] } }));
    await page.route('**/alpaca/v2/stocks/snapshots**', (route) => {
      const u = new URL(route.request().url(), 'http://x'); const syms = (u.searchParams.get('symbols') || '').split(',').filter(Boolean); const out = {};
      for (const s of syms) if (PREV[s]) out[s] = { latestTrade: { p: LIVE[s], s: 200, t: iso(T.TARGET - 30000) }, dailyBar: { t: dayISO(-1), o: PREV[s], h: PREV[s], l: PREV[s], c: PREV[s], v: 8e6 }, prevDailyBar: { t: dayISO(-2), o: PREV[s], h: PREV[s], l: PREV[s], c: PREV[s], v: 7e6 }, minuteBar: { t: iso(T.TARGET - 60000), o: LIVE[s], h: LIVE[s], l: LIVE[s], c: LIVE[s], v: 5000 } };
      route.fulfill({ json: out });
    });
    await page.route('**/alpaca/v2/stocks/trades/latest**', (r) => r.fulfill({ json: { trades: Object.fromEntries(SY.map((s) => [s, { p: LIVE[s], s: 100, t: iso(T.TARGET) }])) } }));
    await page.route('**/alpaca/v2/stocks/bars**', (route) => {
      const u = new URL(route.request().url(), 'http://x'); const tf = u.searchParams.get('timeframe'); const syms = (u.searchParams.get('symbols') || '').split(',').filter(Boolean); const bars = {};
      for (const s of syms) {
        if (!PREV[s]) continue;
        if (tf === '1Day') { const out = []; for (let i = 5; i >= 1; i--) out.push({ t: dayISO(-i), o: PREV[s], h: PREV[s] * 1.05, l: PREV[s] * 0.95, c: PREV[s], v: 4e5 }); bars[s] = out; }
        else if (tf === '5Min') { const a = []; const start = T.TARGET - 210 * 60000; for (let i = 0; i < 42; i++) { const c = LIVE[s] * (0.9 + i * 0.0025); a.push({ t: iso(start + i * 5 * 60000), o: c - 0.01, h: c + 0.02, l: c - 0.03, c, v: 50000 }); } bars[s] = a; }
        else { const a = []; const n = syms.length === 1 ? 90 : 20; for (let i = 0; i < n; i++) { const c = LIVE[s] * (0.99 + i * 0.0002); a.push({ t: iso(T.TARGET - (n - i) * 60000 - 5000), o: c - 0.005, h: c + 0.01, l: c - 0.01, c, v: 16000 }); } bars[s] = a; }
      }
      route.fulfill({ json: { bars } });
    });
    await page.route('**/alpaca/v2/stocks/*/trades/latest**', (r) => r.fulfill({ json: { trade: { p: 4.1, s: 100, t: iso(T.TARGET) } } }));
    await page.route('**/alpaca/v2/stocks/*/quotes/latest**', (r) => r.fulfill({ json: { quote: { bp: 4.09, bs: 3, ap: 4.11, as: 2, t: iso(T.TARGET) } } }));
    await page.goto('http://localhost:8787/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('span:has-text("DILU")', { timeout: 20000 }); await wait(2500); await shot(page, '06-premarket');
    await page.close();
  }
  /* ---- D) after hours + alert center ---- */
  {
    const T = pin(17, 30); const page = await ctx(browser, T);
    const dayISO = (o) => new Date(T.TARGET + (o || 0) * 864e5 - 90000).toISOString();
    const SY = ['MLGO', 'XTIA', 'BNZI', 'HOLO', 'CDTG'];
    const AHP = { MLGO: 3.98, XTIA: 7.05, BNZI: 1.55, HOLO: 0.99, CDTG: 2.30 }; const CLOSE = { MLGO: 3.36, XTIA: 6.23, BNZI: 1.41, HOLO: 0.92, CDTG: 2.19 };
    await page.route('**/trading/v2/assets?**', (r) => r.fulfill({ json: SY.map((s) => ({ symbol: s, tradable: true, status: 'active', exchange: 'NASDAQ' })) }));
    await page.route('**/alpaca/v1beta1/**', (r) => r.fulfill({ json: { gainers: [], losers: [] } }));
    await page.route('**/alpaca/v2/stocks/snapshots**', (route) => {
      const u = new URL(route.request().url(), 'http://x'); const syms = (u.searchParams.get('symbols') || '').split(',').filter(Boolean); const out = {};
      for (const s of syms) if (AHP[s]) out[s] = { latestTrade: { p: AHP[s], s: 500, t: new Date(T.TARGET).toISOString() }, dailyBar: { t: dayISO(0), o: CLOSE[s] * 0.8, h: CLOSE[s] * 1.05, l: CLOSE[s] * 0.78, c: CLOSE[s], v: 15e6 }, prevDailyBar: { t: dayISO(-1), o: 1, h: 1.1, l: .9, c: CLOSE[s] * 0.75, v: 4e5 } };
      route.fulfill({ json: out });
    });
    await page.route('**/alpaca/v2/stocks/trades/latest**', (r) => r.fulfill({ json: { trades: Object.fromEntries(SY.map((s) => [s, { p: AHP[s], s: 300, t: new Date(T.TARGET).toISOString() }])) } }));
    await page.route('**/alpaca/v2/stocks/bars**', (route) => {
      const u = new URL(route.request().url(), 'http://x'); const tf = u.searchParams.get('timeframe'); const syms = (u.searchParams.get('symbols') || '').split(',').filter(Boolean); const bars = {};
      for (const s of syms) {
        if (!AHP[s]) continue;
        if (tf === '1Day') { const out = []; for (let i = 5; i >= 1; i--) out.push({ t: dayISO(-i), o: 1, h: 1.1, l: .9, c: CLOSE[s] * 0.75, v: 4e5 }); out.push({ t: dayISO(0), o: CLOSE[s] * 0.8, h: CLOSE[s] * 1.05, l: CLOSE[s] * 0.78, c: CLOSE[s], v: 15e6 }); bars[s] = out; }
        else if (tf === '5Min') { const a = []; for (let i = 0; i < 48; i++) { const c = CLOSE[s] * (0.85 + i * 0.004); const t = T.TARGET - (48 - i) * 5 * 60000; a.push({ t: new Date(t).toISOString(), o: c - 0.01, h: c + .02, l: c - .03, c, v: 2e5 }); } bars[s] = a; }
        else { const a = []; const n = 120; for (let i = 0; i < n; i++) { const t = T.TARGET - (n - i) * 60000 - 5000; const em = new Date(new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York' })); const m2 = em.getHours() * 60 + em.getMinutes(); const o = m2 < 960 ? CLOSE[s] : CLOSE[s] + (AHP[s] - CLOSE[s]) * Math.min(1, (m2 - 960) / 60); a.push({ t: new Date(t).toISOString(), o, h: o + .01, l: o - .01, c: o + 0.004, v: m2 < 960 ? 30000 : 20000 }); } bars[s] = a; }
      }
      route.fulfill({ json: { bars } });
    });
    await page.route('**/alpaca/v2/stocks/*/trades/latest**', (r) => r.fulfill({ json: { trade: { p: 3.98, s: 100, t: new Date(T.TARGET).toISOString() } } }));
    await page.route('**/alpaca/v2/stocks/*/quotes/latest**', (r) => r.fulfill({ json: { quote: { bp: 3.97, bs: 3, ap: 3.99, as: 2, t: new Date(T.TARGET).toISOString() } } }));
    await page.goto('http://localhost:8787/', { waitUntil: 'domcontentloaded' });
    try { await page.waitForSelector('span:has-text("MLGO")', { timeout: 30000 }); } catch (e) { console.log('AH list did not populate'); }
    await wait(3000); await shot(page, '07-afterhours');
    await page.click('button:has-text("HIT")'); await wait(500); await shot(page, '14-alert-center');
    await page.close();
  }
  await browser.close();
  console.log('captured', fs.readdirSync(OUT).length);
})();
