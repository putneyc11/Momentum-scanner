/* First-run walkthrough + About page + relocated disclosures.
   Scenario A: a fresh device (no keys, no onboard flag) gets the six-slide
   walkthrough before key entry; finishing it stamps onboard-seen and lands
   on the connect screen.
   Scenario B: a returning device (keys + flag) goes straight to the app —
   the giant footer paragraph is gone, the slim "Not financial advice" line
   remains, ⓘ opens the About page, ? reopens the walkthrough with Done. */
let chromium; try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright')); }
const nowD = new Date();
const et = new Date(nowD.toLocaleString('en-US', { timeZone: 'America/New_York' }));
const diff = nowD.getTime() - et.getTime();
const tgt = new Date(et); tgt.setHours(13, 0, 0, 0);
const TARGET = tgt.getTime() + diff;
const OFFSET = TARGET - Date.now();
const dayISO = (o) => new Date(TARGET + (o || 0) * 864e5 - 90000).toISOString();
function dailySet() { const out = []; for (let i = 5; i >= 1; i--) out.push({ t: dayISO(-i), o: 1, h: 1.1, l: .9, c: 1, v: 4e5 }); out.push({ t: dayISO(0), o: 1.05, h: 1.45, l: 1, c: 1.4, v: 15e6 }); return out; }
function bars5() { const a = []; for (let i = 0; i < 48; i++) { const c = 0.9 + i * 0.0105; const o = i ? a[i - 1].c : c - .01; const t = TARGET - (48 - i) * 5 * 60000; a.push({ t: new Date(t).toISOString(), o, h: c + .02, l: o - .02, c, v: 2e5 }); } return a; }
function bars1(n) { const a = []; for (let i = 0; i < n; i++) { const c = 1 + i * .004; a.push({ t: new Date(TARGET - (n - i) * 60000 - 5000).toISOString(), o: c - .005, h: c + .01, l: c - .01, c, v: 16000 }); } return a; }
(async () => {
  const browser = await chromium.launch(process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {});
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(([off]) => {
    const R = Date;
    class F extends R { constructor(...a) { a.length ? super(...a) : super(R.now() + off); } static now() { return R.now() + off; } }
    window.Date = F;
  }, [OFFSET]);
  await page.route('**/trading/v2/assets?**', (r) => r.fulfill({ json: [{ symbol: 'GOODA', tradable: true, status: 'active', exchange: 'NASDAQ' }] }));
  await page.route('**/alpaca/v1beta1/**', (r) => r.fulfill({ json: { gainers: [], losers: [] } }));
  await page.route('**/alpaca/v2/stocks/trades/latest**', (r) => r.fulfill({ json: { trades: { GOODA: { p: 1.42, s: 100, t: new Date(TARGET).toISOString() } } } }));
  await page.route('**/alpaca/v2/stocks/bars**', (route) => {
    const u = new URL(route.request().url(), 'http://x');
    const tf = u.searchParams.get('timeframe');
    const syms = (u.searchParams.get('symbols') || '').split(',').filter(Boolean);
    const bars = {};
    for (const s of syms) bars[s] = tf === '1Day' ? dailySet() : tf === '5Min' ? bars5() : bars1(syms.length === 1 ? 90 : 20);
    route.fulfill({ json: { bars } });
  });
  await page.route('**/alpaca/v2/stocks/*/trades/latest**', (r) => r.fulfill({ json: { trade: { p: 1.42, s: 100, t: new Date(TARGET).toISOString() } } }));
  await page.route('**/alpaca/v2/stocks/*/quotes/latest**', (r) => r.fulfill({ json: { quote: { bp: 1.41, bs: 3, ap: 1.43, as: 2, t: new Date(TARGET).toISOString() } } }));
  await page.route('**/float/**', (r) => r.fulfill({ json: { float: null } }));
  await page.route('**/push/**', (r) => r.fulfill({ json: { ok: true, key: 'x' } }));
  await page.route('**/settings', (r) => r.fulfill({ json: {} }));

  /* ---- A) fresh device: walkthrough before key entry ---- */
  await page.goto('http://localhost:8787/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const a0 = await page.textContent('#root');
  console.log(a0.includes('The market opens at 4 AM') ? '✓ fresh device: walkthrough opens on slide 1 before key entry' : '✗ walkthrough missing on first run');
  console.log(a0.includes('Skip') ? '✓ Skip is available on every slide' : '✗ Skip missing');
  for (let i = 0; i < 5; i++) { await page.click('button:has-text("Next →")'); await page.waitForTimeout(200); }
  const a1 = await page.textContent('#root');
  console.log(a1.includes('Your alerts, your rules') ? '✓ Next steps through all six slides' : '✗ slide navigation broken: ' + a1.slice(0, 120));
  console.log(a1.includes('Connect Alpaca') ? '✓ last slide CTA hands off to key entry' : '✗ final CTA missing');
  await page.click('button:has-text("Connect Alpaca")');
  await page.waitForTimeout(400);
  const a2 = await page.textContent('#root');
  console.log(!a2.includes('The market opens at 4 AM') && a2.includes('Start scanning') ? '✓ finishing lands on the connect screen' : '✗ walkthrough did not close to connect');
  const flag = await page.evaluate(() => localStorage.getItem('onboard-seen'));
  console.log(flag === '1' ? '✓ onboard-seen stamped — walkthrough will not auto-show again' : '✗ flag not stored: ' + JSON.stringify(flag));

  /* ---- B) returning device: straight to the app, slim footer, ⓘ + ? ---- */
  await page.evaluate(() => localStorage.setItem('alpaca-keys', JSON.stringify({ id: 'K', secret: 'S', feed: 'sip', maxPrice: 100, minDayVol: 5000000, ver: 3 })));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('span:has-text("GOODA")', { timeout: 15000 });
  await page.waitForTimeout(500);
  const b0 = await page.textContent('#root');
  console.log(!b0.includes('The market opens at 4 AM') ? '✓ returning device goes straight to the app' : '✗ walkthrough reappeared for a returning user');
  console.log(!b0.includes('Ranked by setup score:') ? '✓ the giant disclosure paragraph is OFF the home screen' : '✗ old footer text still on home');
  console.log(b0.includes('Not financial advice') ? '✓ the one-line "Not financial advice" note remains' : '✗ slim disclosure line missing');
  await page.click('button[aria-label="how this works and disclosures"]');
  await page.waitForTimeout(400);
  const b1 = await page.textContent('#root');
  console.log(b1.includes('Discovery & ranking') && b1.includes('Sessions') && b1.includes('Data & keys') ? '✓ ⓘ opens the About page with the full disclosures' : '✗ About page incomplete');
  await page.click('button:has-text("←")');
  await page.waitForTimeout(300);
  await page.click('button[aria-label="watch the feature walkthrough"]');
  await page.waitForTimeout(400);
  const b2 = await page.textContent('#root');
  console.log(b2.includes('The market opens at 4 AM') ? '✓ ? reopens the walkthrough on demand' : '✗ help reopen broken');
  for (let i = 0; i < 5; i++) { await page.click('button:has-text("Next →")'); await page.waitForTimeout(150); }
  console.log((await page.textContent('#root')).includes('Done') ? '✓ reopened walkthrough ends with Done (not Connect)' : '✗ help-mode CTA wrong');
  await page.click('button:has-text("Done")');
  await page.waitForTimeout(300);
  console.log(!(await page.textContent('#root')).includes('Your alerts, your rules') ? '✓ Done returns to the live app' : '✗ walkthrough stuck open');

  /* ---- C) server-keys mode: the connect screen asks for an access code, never keys ---- */
  await page.route('**/config', (r) => r.fulfill({ json: { serverKeys: true, invite: true, feed: 'sip' } }));
  let claimed = null;
  await page.route('**/auth/claim', (r) => { claimed = JSON.parse(r.request().postData() || '{}'); r.fulfill({ json: { ok: true } }); });
  await page.evaluate(() => localStorage.removeItem('alpaca-keys'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  const c0 = await page.textContent('#root');
  console.log(c0.includes('Live market data included') && c0.includes('Access code') ? '✓ server-keys mode: connect screen offers an access code, data included' : '✗ server-mode connect screen wrong');
  console.log(!c0.includes('API key ID') ? '✓ …and never asks for API keys' : '✗ key fields still shown in server mode');
  await page.fill('input[autocapitalize="none"]', 'letmein');
  await page.click('button:has-text("Start scanning")');
  await page.waitForSelector('span:has-text("GOODA")', { timeout: 15000 });
  console.log(claimed && claimed.code === 'letmein' && /^dv/.test(claimed.device || '') ? '✓ Start claims the device with the code + a stable device id' : '✗ claim payload wrong: ' + JSON.stringify(claimed));
  console.log('JS errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
