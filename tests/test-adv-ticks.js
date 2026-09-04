let chromium; try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright')); }
/* Advanced-view last-trade path. Clock pinned to 13:00 ET so discovery
   stays on the regular-hours sweep. WebSocket is forced to hang in
   CONNECTING — the production freeze — and last prints come only from
   mocked Alpaca latest-trade payloads. */
const nowD = new Date();
const et = new Date(nowD.toLocaleString('en-US', { timeZone: 'America/New_York' }));
const diff = nowD.getTime() - et.getTime();
const tgt = new Date(et); tgt.setHours(13, 0, 0, 0);
const TARGET = tgt.getTime() + diff;
const OFFSET = TARGET - Date.now();
const dayISO = (o) => new Date(TARGET + (o || 0) * 864e5 - 90000).toISOString();
function dailySet() {
  const out = [];
  for (let i = 5; i >= 1; i--) out.push({ t: dayISO(-i), o: 1, h: 1.1, l: .9, c: 1, v: 4e5 });
  out.push({ t: dayISO(0), o: 1.05, h: 1.45, l: 1, c: 1.4, v: 15e6 });
  return out;
}
function bars5() {
  const a = [];
  for (let i = 0; i < 48; i++) {
    const c = 0.9 + i * 0.0105, o = i ? a[i - 1].c : c - .01;
    a.push({ t: new Date(TARGET - (48 - i) * 5 * 60000).toISOString(), o, h: c + .02, l: o - .02, c, v: 2e5 });
  }
  return a;
}
function bars1(n) {
  const a = [];
  for (let i = 0; i < n; i++) {
    const c = 1 + i * .004;
    a.push({ t: new Date(TARGET - (n - i) * 60000 - 5000).toISOString(), o: c - .005, h: c + .01, l: c - .01, c, v: 16000 });
  }
  return a;
}

const HANG_WS = () => {
  class HangSocket {
    constructor() { this.readyState = 0; this.bufferedAmount = 0; this.url = ""; }
    send() {}
    close() { this.readyState = 3; }
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() { return false; }
  }
  HangSocket.CONNECTING = 0; HangSocket.OPEN = 1; HangSocket.CLOSING = 2; HangSocket.CLOSED = 3;
  window.WebSocket = HangSocket;
};

async function openAdvanced(page, extraInit) {
  await page.addInitScript(([off]) => {
    const R = Date;
    class F extends R { constructor(...a) { a.length ? super(...a) : super(R.now() + off); } static now() { return R.now() + off; } }
    window.Date = F;
  }, [OFFSET]);
  await page.addInitScript(() => localStorage.setItem('alpaca-keys', JSON.stringify({ id: 'K', secret: 'S', feed: 'sip', maxPrice: 100, minDayVol: 5000000, ver: 3 })));
  await page.addInitScript(HANG_WS);
  if (extraInit) await extraInit(page);
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
  await page.route('**/float/**', (r) => r.fulfill({ json: { float: null } }));
  await page.route('**/push/**', (r) => r.fulfill({ json: { ok: true, key: 'x' } }));
  await page.route('**/settings', (r) => r.fulfill({ json: {} }));
  await page.route('**/config', (r) => r.fulfill({ json: { serverKeys: false, invite: false, feed: 'sip', plans: false } }));
  await page.goto('http://localhost:8787/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('span:has-text("GOODA")', { timeout: 12000 });
  await page.click('span:has-text("GOODA")');
  await page.waitForSelector('text=Time & sales', { timeout: 15000 });
}

(async () => {
  const browser = await chromium.launch(process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {});
  let pass = 0, fail = 0;
  const ok = (c, m) => { if (c) { pass++; console.log('✓', m); } else { fail++; console.log('✗', m); } };
  const errors = [];

  /* 1 · hung socket + successive mocked last prints */
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => errors.push(e.message));
  let print = { p: 1.42, s: 100, t: new Date(TARGET).toISOString() };
  await page.route('**/alpaca/v2/stocks/*/trades/latest**', (r) => r.fulfill({ json: { trade: print } }));
  await page.route('**/alpaca/v2/stocks/*/quotes/latest**', (r) => r.fulfill({ json: { quote: { bp: 1.41, bs: 3, ap: 1.43, as: 2, t: new Date(TARGET).toISOString() } } }));
  await openAdvanced(page);
  await page.waitForFunction(() => document.querySelector('#root').textContent.includes('1.42'), { timeout: 8000 });
  const t1 = await page.evaluate(() => document.querySelector('#root').textContent);
  ok(t1.includes('1.42') && !/Waiting for trades/.test(t1), 'hung WebSocket still paints the mocked last print in Time & Sales');
  ok(/2s POLL/.test(t1), 'chart badge admits it is polling, not a live socket');
  const onScreen = await page.evaluate(() => {
    const ts = [...document.querySelectorAll('span')].find(s => s.textContent === 'Time & sales');
    const box = ts && ts.getBoundingClientRect();
    return !!(box && box.top < window.innerHeight && box.bottom > 0);
  });
  ok(onScreen, 'Time & Sales is on the first Advanced screen under the chart');
  print = { p: 1.55, s: 250, t: new Date(TARGET + 4000).toISOString() };
  await page.waitForFunction(() => document.querySelector('#root').textContent.includes('1.55'), { timeout: 8000 });
  const t2 = await page.evaluate(() => document.querySelector('#root').textContent);
  ok(t2.includes('1.55') && t2.includes('1.42'), 'a newer mocked last print is appended — the tape is not frozen on the first REST hit');
  await page.close();

  /* 2 · hung socket + 403 latest-trade — must say unavailable, not invent a print */
  const page2 = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page2.on('pageerror', (e) => errors.push(e.message));
  await page2.route('**/alpaca/v2/stocks/*/trades/latest**', (r) => r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'subscription required' }) }));
  await page2.route('**/alpaca/v2/stocks/*/quotes/latest**', (r) => r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'subscription required' }) }));
  await openAdvanced(page2);
  await page2.waitForFunction(() => /last trade unavailable|No last print/.test(document.querySelector('#root').textContent), { timeout: 8000 });
  const t3 = await page2.evaluate(() => document.querySelector('#root').textContent);
  ok(/last trade unavailable/.test(t3) && /subscription required|403/.test(t3), '403 latest-trade is shown on the tape, not swallowed');
  ok(/No last print on this feed/.test(t3), 'Time & Sales says the print is missing instead of waiting forever');
  ok(!/Waiting for trades/.test(t3), 'the frozen wait copy is gone once the feed has failed');
  await page2.close();

  console.log('JS errors:', errors.length ? errors : 'none');
  console.log(fail ? `FAILED ${fail} / ${pass + fail}` : `ALL ${pass} ADVANCED-TICK TESTS PASS`);
  await browser.close();
  process.exit(errors.length || fail ? 1 : 0);
})();
