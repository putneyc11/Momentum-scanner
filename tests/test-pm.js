/* Premarket discovery — reproduces the original failure and proves the fix.
   Clock pinned to 07:30 ET. Alpaca is mocked the way it really behaves before
   the open: 1Day bars have NO bar for today (only prior days), so the old
   daily-bar sweep found nothing and the list sat empty all premarket.
   The new snapshot sweep must populate the list from the premarket tape:
   - GAPPY  +50% vs prior close, heavy premarket tape  → listed
   - THINY  +100% but ~4k premarket shares             → volume-gated OUT
   - SPLITR raw +900% (reverse split); adjusted 0%     → split-guarded OUT
   Also: tapping the row opens the Advanced view directly (no preview card). */
let chromium; try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright')); }
const nowD = new Date();
const et = new Date(nowD.toLocaleString('en-US', { timeZone: 'America/New_York' }));
const diff = nowD.getTime() - et.getTime();
const tgt = new Date(et); tgt.setHours(7, 30, 0, 0);
const TARGET = tgt.getTime() + diff;
const OFFSET = TARGET - Date.now();
const iso = (ms) => new Date(ms).toISOString();
const dayISO = (o) => iso(TARGET + o * 864e5 - 90000);

const PREV = { GAPPY: 3.0, THINY: 1.0, SPLITR: 10.0 };  // split-ADJUSTED prior closes
const LIVE = { GAPPY: 4.5, THINY: 2.0, SPLITR: 10.0 };  // live premarket prints
function snapshots(syms) {
  const out = {};
  for (const s of syms) {
    const rawPrev = s === 'SPLITR' ? 1.0 : PREV[s]; // snapshots are RAW: pre-split close for SPLITR
    out[s] = {
      latestTrade: { p: LIVE[s], s: 200, t: iso(TARGET - 30000) },
      dailyBar: { t: dayISO(-1), o: rawPrev, h: rawPrev, l: rawPrev, c: rawPrev, v: 8e6 }, // yesterday — no today bar premarket
      prevDailyBar: { t: dayISO(-2), o: rawPrev, h: rawPrev, l: rawPrev, c: rawPrev, v: 7e6 },
      minuteBar: { t: iso(TARGET - 60000), o: LIVE[s], h: LIVE[s], l: LIVE[s], c: LIVE[s], v: 5000 },
    };
  }
  return out;
}
function daily(sym) { // split-adjusted history, NOTHING for today (it's premarket)
  const out = [];
  for (let i = 5; i >= 1; i--) out.push({ t: dayISO(-i), o: PREV[sym], h: PREV[sym] * 1.05, l: PREV[sym] * 0.95, c: PREV[sym], v: 4e5 });
  return out;
}
function bars5(sym) { // 4:00 ET → now, 5-min candles; GAPPY heavy, THINY ~4k total
  const start = TARGET - 210 * 60000; // 4:00 AM ET
  const a = [];
  for (let i = 0; i < 42; i++) {
    const c = LIVE[sym] * (0.9 + i * 0.0025);
    a.push({ t: iso(start + i * 5 * 60000), o: c - 0.01, h: c + 0.02, l: c - 0.03, c, v: sym === 'THINY' ? 100 : 50000 });
  }
  return a;
}
function bars1(sym, n) {
  const a = [];
  for (let i = 0; i < n; i++) {
    const c = LIVE[sym] * (0.99 + i * 0.0002);
    a.push({ t: iso(TARGET - (n - i) * 60000 - 5000), o: c - 0.005, h: c + 0.01, l: c - 0.01, c, v: 16000 });
  }
  return a;
}
(async () => {
  const browser = await chromium.launch(process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {});
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; const reqs = []; let syncedSyms = null;
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(([off]) => {
    const R = Date;
    class F extends R { constructor(...a) { a.length ? super(...a) : super(R.now() + off); } static now() { return R.now() + off; } }
    window.Date = F;
  }, [OFFSET]);
  await page.addInitScript(() => localStorage.setItem('alpaca-keys', JSON.stringify({ id: 'K', secret: 'S', feed: 'sip', maxPrice: 100, minDayVol: 5000000, ver: 3 })));
  const SY = ['GAPPY', 'THINY', 'SPLITR'];
  await page.route('**/push/**', (r) => r.fulfill({ json: { ok: true, key: 'x' } }));
  await page.route('**/push/watchlist', (r) => { syncedSyms = JSON.parse(r.request().postData() || '{}').symbols || []; r.fulfill({ json: { ok: true } }); });
  await page.route('**/settings', (r) => r.fulfill({ json: {} }));
  await page.route('**/float/**', (r) => r.fulfill({ json: { float: null } }));
  await page.route('**/trading/v2/assets?**', (r) => r.fulfill({ json: SY.map((s) => ({ symbol: s, tradable: true, status: 'active', exchange: 'NASDAQ' })) }));
  await page.route('**/alpaca/v1beta1/**', (r) => r.fulfill({ json: { gainers: [], losers: [] } }));
  await page.route('**/alpaca/v2/stocks/snapshots**', (route) => {
    const u = new URL(route.request().url(), 'http://x');
    const syms = (u.searchParams.get('symbols') || '').split(',').filter(Boolean);
    route.fulfill({ json: snapshots(syms) });
  });
  await page.route('**/alpaca/v2/stocks/trades/latest**', (r) => r.fulfill({ json: { trades: { GAPPY: { p: 4.5, s: 100, t: iso(TARGET) } } } }));
  await page.route('**/alpaca/v2/stocks/bars**', (route) => {
    const u = new URL(route.request().url(), 'http://x');
    const tf = u.searchParams.get('timeframe');
    const syms = (u.searchParams.get('symbols') || '').split(',').filter(Boolean);
    const bars = {};
    for (const s of syms) bars[s] = tf === '1Day' ? daily(s) : tf === '5Min' ? bars5(s) : bars1(s, syms.length === 1 ? 90 : 20);
    route.fulfill({ json: { bars } });
  });
  await page.route('**/alpaca/v2/stocks/*/trades/latest**', (r) => r.fulfill({ json: { trade: { p: 4.5, s: 100, t: iso(TARGET) } } }));
  await page.route('**/alpaca/v2/stocks/*/quotes/latest**', (r) => r.fulfill({ json: { quote: { bp: 4.49, bs: 3, ap: 4.51, as: 2, t: iso(TARGET) } } }));
  page.on('request', (r) => { if (r.url().includes('localhost')) reqs.push(r.url().replace('http://localhost:8787', '').slice(0, 90)); });
  await page.goto('http://localhost:8787/', { waitUntil: 'domcontentloaded' });

  // ---- 1) THE FIX: the list populates during premarket ----
  try { await page.waitForSelector('span:has-text("GAPPY")', { timeout: 15000 }); }
  catch (e) {
    console.log('✗ PREMARKET LIST STILL EMPTY. requests:', JSON.stringify(reqs.slice(0, 14), null, 0));
    console.log('body:', JSON.stringify((await page.textContent('#root')).slice(0, 400)));
    process.exit(1);
  }
  console.log('✓ premarket gapper listed at 7:30 AM ET (no daily bar for today existed)');
  await page.waitForTimeout(1500);
  const body = await page.textContent('#root');
  const listSlice = body.slice(0, body.indexOf('Ranked by setup score:') > -1 ? body.indexOf('Ranked by setup score:') : undefined);

  // ---- 2) priced off the premarket tape vs the ADJUSTED prior close ----
  console.log(/\+50\.\d\d%/.test(listSlice) ? '✓ gap priced vs prior close (+50% on the row)' : '✗ wrong % on the row: ' + listSlice.slice(0, 200));
  console.log(listSlice.includes('2.10M') ? '✓ row volume = cumulative PREMARKET shares (2.10M)' : '✗ premarket volume missing from the row');

  // ---- 3) premarket gates: thin tape and phantom splits stay off the list ----
  console.log(!listSlice.includes('THINY') ? '✓ thin premarket tape (~4k shares) volume-gated off the list' : '✗ THINY leaked through the volume gate');
  console.log(!listSlice.includes('SPLITR') ? '✓ reverse-split phantom (+900% raw) split-guarded off the list' : '✗ SPLITR phantom listed');

  // ---- 4) header advertises the premarket session gates ----
  console.log(body.includes('PREMARKET') ? '✓ header shows PREMARKET session gates' : '✗ header not session-aware');

  // ---- 5) server monitor synced with the premarket watchlist ----
  console.log(syncedSyms && syncedSyms.includes('GAPPY') ? '✓ premarket watchlist synced to the push monitor' : '✗ monitor not synced: ' + JSON.stringify(syncedSyms));

  // ---- 6) tap → Advanced view directly (preview card removed) ----
  await page.click('span:has-text("GAPPY")');
  await page.waitForSelector('text=Confluence tracker', { timeout: 15000 });
  const adv = await page.textContent('#root');
  console.log(!adv.includes('Advanced view') ? '✓ row tap opens the Advanced view directly — no preview step' : '✗ preview card still in the flow');
  console.log('JS errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
