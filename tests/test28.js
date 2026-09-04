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
  if (sym==='QUIET'){out.push({t:dayISO(0),o:1,h:1.05,l:.98,c:1.02,v:1e5});return out;} // +2% day, thin — NOT a day mover
  if (sym==='THINAH'){out.push({t:dayISO(0),o:1,h:1.02,l:.98,c:1.0,v:5e4});return out;} // flat day, illiquid AH pop
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
    if (sym === 'QUIET') { o = m2 < 960 ? 1.00 : 1.40; c = o + 0.005; } // flat all day, +39% AH gap
    if (sym === 'GOODA' && scanN >= 2 && i >= n - 3) { o = 2.00 + (i - (n - 3)) * 0.03; c = o + 0.03; }
    a.push({t:new Date(t).toISOString(),o,h:Math.max(o,c)+.01,l:Math.min(o,c)-.01,c,v:sym==='THINAH'?50:(m2<960?30000:20000)});
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
  const SY = ['GOODA', ...Array.from({length:16},(_,i)=>'S'+String.fromCharCode(65+i)+'X'), 'WKLO', 'QUIET', 'THINAH'];
  await page.route('**/trading/v2/assets?**', (r) => r.fulfill({ json: SY.map(s => ({ symbol: s, tradable: true, status: 'active', exchange: 'NASDAQ' })) }));
  await page.route('**/alpaca/v1beta1/**', (r) => r.fulfill({ json: { gainers: [], losers: [] } }));
  await page.route('**/alpaca/v2/stocks/snapshots**', (route) => {
    const u = new URL(route.request().url(), 'http://x');
    const syms = (u.searchParams.get('symbols') || '').split(',').filter(Boolean);
    const out = {};
    for (const s of syms) out[s] = {
      latestTrade: { p: s==='QUIET' ? 1.41 : s==='THINAH' ? 1.25 : 2.0, s: 500, t: new Date(TARGET).toISOString() },
      dailyBar: { t: dayISO(0), o: 1, h: 2, l: 1, c: s==='QUIET' ? 1.02 : s==='THINAH' ? 1.0 : 2.0, v: s==='QUIET' ? 1e5 : 15e6 },
      prevDailyBar: { t: dayISO(-1), o: 1, h: 1.1, l: .9, c: 1, v: 4e5 },
    };
    route.fulfill({ json: out });
  });
  let tickP = null; // when set, the batched 3s latest-trades tick prints QUIET at this price
  await page.route('**/alpaca/v2/stocks/trades/latest**', (r) => r.fulfill({ json: { trades: tickP ? { QUIET: { p: tickP, s: 300, t: new Date(TARGET).toISOString() } } : {} } }));
  await page.route('**/alpaca/v2/stocks/bars**', (route) => {
    const u = new URL(route.request().url(), 'http://x');
    const tf = u.searchParams.get('timeframe');
    const syms = (u.searchParams.get('symbols') || '').split(',').filter(Boolean);
    if (tf === '1Min' && syms.length > 1) scanN++;
    const bars = {};
    for (const s of syms) bars[s] = tf==='1Day' ? dailySet(s) : tf==='5Min' ? bars5(s) : barsAH(s, s==='QUIET' ? 120 : 40);
    route.fulfill({ json: { bars } });
  });
  await page.route('**/alpaca/v2/stocks/*/trades/latest**', (r) => r.fulfill({ json: { trade: { p: 2.0, s: 100, t: new Date(TARGET).toISOString() } } }));
  await page.route('**/alpaca/v2/stocks/*/quotes/latest**', (r) => r.fulfill({ json: { quote: { bp: 1.99, bs: 3, ap: 2.01, as: 2, t: new Date(TARGET).toISOString() } } }));
  await page.route('**/float/**', (r) => r.fulfill({ json: { float: null } }));
  await page.route('**/push/**', (r) => r.fulfill({ json: { ok: true, key: 'x' } }));
  await page.route('**/push/status', (r) => r.fulfill({ json: { devices: 1, lastError: null } }));
  await page.route('**/push/watchlist', (r) => { syncedSyms = JSON.parse(r.request().postData() || '{}').symbols || []; r.fulfill({ json: { ok: true } }); });
  await page.route('**/journal', (r) => r.fulfill({ json: { stats: { n: 23, green15: 61.5, avg15: 1.42, avgMaxUp30: 3.24,
    tier2: { n: 15, green15: 56.2 }, tier3: { n: 8, green15: 71.4 } }, recent: [], policy: {} } }));
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
  /* push follow-through: reachable with NO alert banner on screen. Before the
     header chip existed the stats could only be opened from the banner, so on a
     quiet day they could not be reached at all. */
  const hitChip = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /^HIT/.test(x.textContent.trim()));
    if (!b) return null;
    const bell = [...document.querySelectorAll('button')].find(x => /Lock-screen|^On$|^Off$/.test(x.textContent.trim()));
    return { text: b.textContent.trim(), banner: document.querySelector('#root').textContent.includes('tap: history'),
             h: Math.round(b.getBoundingClientRect().height), bellH: bell ? Math.round(bell.getBoundingClientRect().height) : null };
  });
  console.log(hitChip && hitChip.text === 'HIT62%' && !hitChip.banner
    ? '✓ hit-rate chip sits in the header with no alert banner needed'
    : '✗ hit chip missing or banner-dependent: ' + JSON.stringify(hitChip));
  console.log(hitChip && hitChip.h === hitChip.bellH ? `✓ chip matches the control-row height (${hitChip.h}px)` : '✗ chip height off: ' + JSON.stringify(hitChip));
  await page.click('button:has-text("HIT")');
  await page.waitForTimeout(500);
  const jPanel = await page.evaluate(() => {
    const t = document.querySelector('#root').textContent;
    const vals = [...document.querySelectorAll('div')].filter(d => /^(62%|\+1\.4%|\+3\.2%)$/.test(d.textContent.trim())).length;
    return { open: t.includes('Push follow-through'), vals, tiers: /Setup\s*56%/.test(t.replace(/\s+/g, ' ')) && /Breakout\s*71%/.test(t.replace(/\s+/g, ' ')), chain: t.includes('\u00b7 20D \u00b7') };
  });
  console.log(jPanel.open && jPanel.vals === 3 && jPanel.tiers && !jPanel.chain
    ? '✓ stats panel shows three measures plus the setup/breakout split'
    : '✗ stats panel wrong: ' + JSON.stringify(jPanel));
  await page.click('button:has-text("Close")');
  await page.waitForTimeout(300);

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

  // ---- 4.5) FULL-MARKET AH: QUIET (flat all day) gaps +39% after the close ----
  await page.waitForSelector('span:has-text("QUIET")', { timeout: 45000 });
  const bodyAH = await page.textContent('#root');
  const ahIdx = bodyAH.indexOf('After hours');
  console.log(ahIdx > -1 && bodyAH.slice(ahIdx).includes('QUIET') ? '✓ full-market AH discovery lists a quiet-all-day 5 PM gapper' : '✗ QUIET missing from the After hours table');
  console.log(!bodyAH.slice(0, ahIdx).includes('QUIET') ? '✓ …and it stays OFF the day list (only +2% on the day)' : '✗ QUIET leaked into the day list');
  const ahRowCount = await page.evaluate(() => {
    const moon = [...document.querySelectorAll('span')].find(sp => (sp.textContent || '').trim() === '🌙 After hours');
    if (!moon) return -1;
    let card = moon.parentElement;
    while (card && !/border-radius: 10px/.test(card.getAttribute('style') || '')) card = card.parentElement;
    if (!card) return -2;
    return card.querySelectorAll('span[aria-label]').length; // one bell per row
  });
  console.log(ahRowCount === 10 ? '✓ After Hours shows a full 10 rows of liquid names' : '✗ AH row count: ' + ahRowCount);
  console.log(!bodyAH.slice(ahIdx).includes('THINAH') ? '✓ illiquid AH pop (+25% on ~2k shares) is filtered OUT' : '✗ THINAH (illiquid) leaked into the AH table');
  console.log(/QUIET1\.40\+39\.80%1\.\d\dM/.test(bodyAH.slice(ahIdx)) ? '✓ VOL column shows true cumulative AH volume (~1.8M), never a dash' : '✗ QUIET AH volume missing from the table');

  // ---- 4.6) every AH row draws a Trend sparkline (verified AH tape feeds it) ----
  const ahSparks = await page.evaluate(() => {
    const moon = [...document.querySelectorAll('span')].find(sp => (sp.textContent || '').trim() === '🌙 After hours');
    let card = moon && moon.parentElement;
    while (card && !/border-radius: 10px/.test(card.getAttribute('style') || '')) card = card.parentElement;
    return card ? card.querySelectorAll('canvas').length : -1;
  });
  console.log(ahSparks === 10 ? '✓ every AH row draws a Trend sparkline (10/10 canvases)' : '✗ AH sparklines rendered: ' + ahSparks);

  // ---- 4.7) AH rows re-price on the same 3s live tick as the main list ----
  tickP = 1.55; // QUIET prints 1.55; 4:00 PM close 1.005 → +54.23% must appear within a tick or two
  try {
    await page.waitForFunction(() => document.getElementById('root').textContent.includes('+54.2'), { timeout: 12000 });
    console.log('✓ AH row re-priced by the 3s latest-trades tick (1.55 vs the 4 PM close → +54.2%)');
  } catch (e) {
    console.log('✗ AH row never re-priced from the live 3s tick');
  }

  // ---- 5) per-symbol bell: mute GOODA → dropped from the push-monitor sync ----
  const muteClicked = await page.evaluate(() => {
    const sym = [...document.querySelectorAll('span')].find(s => s.textContent === 'GOODA');
    const bell = sym && sym.closest('div').querySelector('span[aria-label="mute alerts for this stock"]');
    if (!bell) return false;
    bell.click();
    return true;
  });
  if (!muteClicked) console.log('✗ no bell found on the GOODA row');
  await page.waitForTimeout(800);
  const bellState = await page.evaluate(() => {
    const sym = [...document.querySelectorAll('span')].find(s => s.textContent === 'GOODA');
    const bell = sym && sym.closest('div').querySelector('span[aria-label]');
    return bell ? bell.getAttribute('aria-label') : '';
  });
  console.log(bellState === 'unmute alerts for this stock' ? '✓ row bell flips to muted (outline bell-off)' : '✗ bell did not toggle: ' + JSON.stringify(bellState));
  console.log(!syncedSyms.includes('GOODA') ? '✓ muted stock removed from the push-monitor watchlist' : '✗ GOODA still synced while muted');
  console.log(syncedSyms.includes('WKLO') ? '✓ other stocks stay on the monitor while one is muted' : '✗ mute clobbered the rest of the watchlist');

  // ---- 6) unmute → the stock rejoins the monitor immediately ----
  await page.evaluate(() => {
    const sym = [...document.querySelectorAll('span')].find(s => s.textContent === 'GOODA');
    const bell = sym && sym.closest('div').querySelector('span[aria-label="unmute alerts for this stock"]');
    if (bell) bell.click();
  });
  await page.waitForTimeout(800);
  console.log(syncedSyms.includes('GOODA') ? '✓ unmute restores the stock to the push monitor' : '✗ GOODA not restored after unmute');
  console.log('JS errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
