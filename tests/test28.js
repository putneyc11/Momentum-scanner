let chromium; try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright')); }
const nowD = new Date();
const et = new Date(nowD.toLocaleString('en-US', { timeZone: 'America/New_York' }));
const diff = nowD.getTime() - et.getTime();
const tgt = new Date(et); tgt.setHours(17, 30, 0, 0);
const TARGET = tgt.getTime() + diff;
const OFFSET = TARGET - Date.now();
const dayISO=(o)=>new Date(TARGET+(o||0)*864e5-90000).toISOString();
// 18 qualifying movers (≥25%, ≥5M). WKLO scores WORST (fader shape) → ranked ~18th, off the display list
function dailySet(sym){const out=[];for(let i=5;i>=1;i--)out.push({t:dayISO(-i),o:1,h:1.1,l:.9,c:1,v:4e5});
  const m = sym==='WKLO' ? 1.9 : 1.3 + 'ABCDEFGHIJKLMNOPQ'.indexOf(sym[1] || 'A') * 0.01;
  out.push({t:dayISO(0),o:1.05,h:m+.05,l:1,c:m,v:15e6});return out;}
function bars5(sym){const a=[];for(let i=0;i<48;i++){
  // WKLO: below-VWAP fader (weak score); others: clean risers
  const c = sym==='WKLO' ? 2.4 - i*0.01 : 0.9+i*0.0105;
  const t=TARGET-(48-i)*5*60000;a.push({t:new Date(t).toISOString(),o:c+(sym==='WKLO'?0.01:-0.01),h:c+.02,l:c-.03,c,v:2e5});}return a;}
let scanN = 0;
function barsAH(sym, n){
  const a=[];
  for(let i=0;i<n;i++){
    const t = TARGET - (n - i) * 60000 - 5000;
    const em = new Date(new Date(t).toLocaleString('en-US',{timeZone:'America/New_York'}));
    const m2 = em.getHours()*60+em.getMinutes();
    // GOODA: red chop, then on scan #2+ the last three bars turn green (fresh streak)
    let o = 2.00, c = 1.99;
    if (sym === 'GOODA' && scanN >= 2 && i >= n - 3) { o = 2.00 + (i - (n - 3)) * 0.03; c = o + 0.03; }
    a.push({t:new Date(t).toISOString(),o,h:Math.max(o,c)+.01,l:Math.min(o,c)-.01,c,v:m2<960?30000:20000});
  }
  return a;
}
(async () => {
  const browser = await chromium.launch(process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {});
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const errors = []; let syncedSyms = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(([off]) => {
    const R = Date;
    class F extends R { constructor(...a){ a.length ? super(...a) : super(R.now() + off); } static now(){ return R.now() + off; } }
    window.Date = F;
  }, [OFFSET]);
  await page.addInitScript(() => localStorage.setItem('alpaca-keys', JSON.stringify({ id:'K',secret:'S',feed:'sip',maxPrice:100,minDayVol:5000000,alertsOn:true,ver:3 })));
  const SY = ['GOODA', ...Array.from({length:16},(_,i)=>'S'+String.fromCharCode(65+i)+'X'), 'WKLO'];
  await page.route('**/trading/v2/assets?**', (r) => r.fulfill({ json: SY.map(s => ({ symbol: s, tradable: true, status: 'active', exchange: 'NASDAQ' })) }));
  await page.route('**/alpaca/v1beta1/**', (r) => r.fulfill({ json: { gainers: [], losers: [] } }));
  await page.route('**/alpaca/v2/stocks/trades/latest**', (r) => r.fulfill({ json: { trades: {} } }));
  await page.route('**/alpaca/v2/stocks/bars**', (route) => {
    const u = new URL(route.request().url(), 'http://x');
    const tf = u.searchParams.get('timeframe');
    const syms = (u.searchParams.get('symbols') || '').split(',').filter(Boolean);
    if (tf === '1Min' && syms.length > 1) scanN++;
    const bars = {};
    for (const s of syms) bars[s] = tf==='1Day' ? dailySet(s) : tf==='5Min' ? bars5(s) : barsAH(s, 40);
    route.fulfill({ json: { bars } });
  });
  await page.route('**/alpaca/v2/stocks/*/trades/latest**', (r) => r.fulfill({ json: { trade: { p: 2.0, s: 100, t: new Date(TARGET).toISOString() } } }));
  await page.route('**/alpaca/v2/stocks/*/quotes/latest**', (r) => r.fulfill({ json: { quote: { bp: 1.99, bs: 3, ap: 2.01, as: 2, t: new Date(TARGET).toISOString() } } }));
  await page.route('**/float/**', (r) => r.fulfill({ json: { float: null } }));
  await page.route('**/push/**', (r) => r.fulfill({ json: { ok: true, key: 'x' } }));
  await page.route('**/push/status', (r) => r.fulfill({ json: { devices: 1, lastError: null } }));
  await page.route('**/push/watchlist', (r) => { syncedSyms = JSON.parse(r.request().postData() || '{}').symbols || []; r.fulfill({ json: { ok: true } }); });
  await page.route('**/settings', (r) => r.fulfill({ json: {} }));
  await page.goto('http://localhost:8787/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('span:has-text("GOODA")', { timeout: 20000 });
  await page.waitForTimeout(2000);

  // ---- 1) coverage: WKLO (+90%, worst score, off the top-15) is still synced to the monitor ----
  const body0 = await page.textContent('#root');
  const wkloDisplayed = body0.slice(0, body0.indexOf('After hours') > -1 ? body0.indexOf('After hours') : undefined).includes('WKLO');
  console.log(syncedSyms.length > 15 ? `✓ monitor watch expanded beyond the display list (${syncedSyms.length} symbols)` : '✗ watch still capped: ' + syncedSyms.length);
  console.log(syncedSyms.includes('WKLO') ? '✓ WETO-class runner (worst score, off the top-15) IS monitored for alerts' : '✗ WKLO not synced — WETO would be missed again');

  // ---- 2) in-app alert fires (mom3) → banner appears ----
  await page.waitForSelector('text=3 green candles', { timeout: 40000 });
  console.log('✓ mom3 alert fired in-app (3 consecutive green 1-min candles)');

  // ---- 3) tap banner → alert center modal ----
  const banner = await page.$('div:has-text("swipe ←: clear")');
  await page.click('text=3 green candles');
  await page.waitForSelector('text=Clear all', { timeout: 5000 });
  const modal = await page.textContent('#root');
  console.log(modal.includes('Alerts') && modal.includes('Clear all') ? '✓ tapping the banner opens the alert-center modal' : '✗ modal missing');
  await page.click('button:has-text("Close")');
  await page.waitForTimeout(400);

  // ---- 4) swipe LEFT on the banner clears it ----
  const bb = await (await page.$('div:has-text("swipe ←: clear")')).boundingBox();
  await page.evaluate(([x, y]) => {
    const el = [...document.querySelectorAll('div')].find(d => d.textContent.includes('swipe ←: clear') && d.getAttribute('style') && d.getAttribute('style').includes('cursor: pointer'));
    const mk = (type, xx) => new TouchEvent(type, { bubbles: true, cancelable: true,
      touches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target: el, clientX: xx, clientY: y })] });
    el.dispatchEvent(mk('touchstart', x));
    el.dispatchEvent(mk('touchmove', x - 50));
    el.dispatchEvent(mk('touchmove', x - 110));
    el.dispatchEvent(mk('touchend', 0));
  }, [bb.x + bb.width / 2, bb.y + bb.height / 2]);
  await page.waitForTimeout(500);
  const after = await page.textContent('#root');
  console.log(!after.includes('swipe ←: clear') ? '✓ swipe-left clears the banner (tap no longer clears)' : '✗ banner still present after swipe');

  // ---- 5) per-symbol bell: mute GOODA → dropped from the push-monitor sync ----
  const muteClicked = await page.evaluate(() => {
    const sym = [...document.querySelectorAll('span')].find(s => s.textContent === 'GOODA');
    const bell = sym && [...sym.closest('div').querySelectorAll('span')].find(s => s.textContent === '🔔');
    if (!bell) return false;
    bell.click();
    return true;
  });
  if (!muteClicked) console.log('✗ no bell found on the GOODA row');
  await page.waitForTimeout(800);
  const rowTxt = await page.evaluate(() => {
    const sym = [...document.querySelectorAll('span')].find(s => s.textContent === 'GOODA');
    return sym ? sym.closest('div').textContent : '';
  });
  console.log(rowTxt.includes('🔕') ? '✓ row bell flips to muted (🔕)' : '✗ bell did not toggle: ' + JSON.stringify(rowTxt.slice(0, 80)));
  console.log(!syncedSyms.includes('GOODA') ? '✓ muted stock removed from the push-monitor watchlist' : '✗ GOODA still synced while muted');
  console.log(syncedSyms.includes('WKLO') ? '✓ other stocks stay on the monitor while one is muted' : '✗ mute clobbered the rest of the watchlist');

  // ---- 6) unmute → the stock rejoins the monitor immediately ----
  await page.evaluate(() => {
    const sym = [...document.querySelectorAll('span')].find(s => s.textContent === 'GOODA');
    const bell = sym && [...sym.closest('div').querySelectorAll('span')].find(s => s.textContent === '🔕');
    if (bell) bell.click();
  });
  await page.waitForTimeout(800);
  console.log(syncedSyms.includes('GOODA') ? '✓ unmute restores the stock to the push monitor' : '✗ GOODA not restored after unmute');
  console.log('JS errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
