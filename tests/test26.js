let chromium; try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright')); }
/* Pin the clock to 13:00 ET (regular hours) — discovery is session-aware now,
   so an unpinned clock would exercise the premarket path when run before 9:30. */
const nowD = new Date();
const et = new Date(nowD.toLocaleString('en-US', { timeZone: 'America/New_York' }));
const diff = nowD.getTime() - et.getTime();
const tgt = new Date(et); tgt.setHours(13, 0, 0, 0);
const TARGET = tgt.getTime() + diff;
const OFFSET = TARGET - Date.now();
const dayISO=(o)=>new Date(TARGET+(o||0)*864e5-90000).toISOString(); // relative stamps: ET-day-safe at any hour
function dailySet(){const out=[];for(let i=5;i>=1;i--)out.push({t:dayISO(-i),o:1,h:1.1,l:.9,c:1,v:4e5});out.push({t:dayISO(0),o:1.05,h:1.45,l:1,c:1.4,v:15e6});return out;}
function bars5(){const a=[];for(let i=0;i<48;i++){const c=0.9+i*0.0105;const o=i?a[i-1].c:c-.01;const t=TARGET-(48-i)*5*60000;a.push({t:new Date(t).toISOString(),o,h:c+.02,l:o-.02,c,v:2e5});}return a;}
function bars1(n){const a=[];for(let i=0;i<n;i++){const c=1+i*.004;a.push({t:new Date(TARGET-(n-i)*60000-5000).toISOString(),o:c-.005,h:c+.01,l:c-.01,c,v:16000});}return a;}
(async () => {
  const browser = await chromium.launch(process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {});
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(([off]) => {
    const R = Date;
    class F extends R { constructor(...a){ a.length ? super(...a) : super(R.now() + off); } static now(){ return R.now() + off; } }
    window.Date = F;
  }, [OFFSET]);
  await page.addInitScript(() => localStorage.setItem('alpaca-keys', JSON.stringify({ id:'K',secret:'S',feed:'sip',maxPrice:100,minDayVol:5000000,ver:3 })));
  await page.route('**/trading/v2/assets?**', (r) => r.fulfill({ json: [{ symbol:'GOODA', tradable:true, status:'active', exchange:'NASDAQ' }] }));
  await page.route('**/alpaca/v1beta1/**', (r) => r.fulfill({ json: { gainers: [], losers: [] } }));
  await page.route('**/alpaca/v2/stocks/trades/latest**', (r) => r.fulfill({ json: { trades: { GOODA: { p: 1.42, s: 100, t: new Date(TARGET).toISOString() } } } }));
  await page.route('**/alpaca/v2/stocks/bars**', (route) => {
    const u = new URL(route.request().url(), 'http://x');
    const tf = u.searchParams.get('timeframe');
    const syms = (u.searchParams.get('symbols') || '').split(',').filter(Boolean);
    const bars = {};
    for (const s of syms) bars[s] = tf==='1Day' ? dailySet() : tf==='5Min' ? bars5() : bars1(syms.length===1?90:20);
    route.fulfill({ json: { bars } });
  });
  await page.route('**/alpaca/v2/stocks/*/trades/latest**', (r) => r.fulfill({ json: { trade: { p: 1.42, s: 100, t: new Date(TARGET).toISOString() } } }));
  await page.route('**/alpaca/v2/stocks/*/quotes/latest**', (r) => r.fulfill({ json: { quote: { bp: 1.41, bs: 3, ap: 1.43, as: 2, t: new Date(TARGET).toISOString() } } }));
  await page.route('**/float/**', (r) => r.fulfill({ json: { float: null } }));
  await page.route('**/push/**', (r) => r.fulfill({ json: { ok: true, key: 'x' } }));
  await page.route('**/settings', (r) => r.fulfill({ json: {} }));
  await page.route('**/config', (r) => r.fulfill({ json: { serverKeys: false, invite: false, feed: 'sip', plans: true, planModel: 'claude-opus-5' } }));
  let planReq = null;
  await page.route('**/plan', (r) => {
    planReq = JSON.parse(r.request().postData() || '{}');
    r.fulfill({ json: { cached: false, t: Date.now(), plan: {
      bias: 'bullish', summary: 'Holding VWAP with a rising tape; the dip to 1.24 is the trade.',
      levels: [{ price: 1.15, kind: 'support', label: 'VWAP', strength: 2 }, { price: 1.24, kind: 'support', label: 'EMA 8', strength: 3 }, { price: 1.50, kind: 'resistance', label: 'PMH', strength: 2 }],
      scenarios: [
        { name: 'Long continuation', stance: 'long', trigger: 'hold 1.24 and push through 1.31', entry_lo: 1.25, entry_hi: 1.28, stop: 1.19, targets: [1.34, 1.50], invalidation: 'loses 1.19 on a 1-min close', note: 'partials at T1' },
        { name: 'Dip buy', stance: 'long', trigger: 'pullback to VWAP that holds', entry_lo: 1.15, entry_hi: 1.18, stop: 1.10, targets: [1.28], invalidation: 'no bounce inside 3 bars', note: '' },
        { name: 'Stand aside', stance: 'wait', trigger: 'below 1.10 there is no long', entry_lo: 0, entry_hi: 0, stop: 0, targets: [], invalidation: '', note: 'reclaim of 1.15 reopens the dip buy' },
      ],
      must_hold: 1.19, must_fail: 1.10, risk_notes: 'Size small; halts likely above 1.50.', model: 'claude-opus-5',
    } } });
  });
  const reqs = [];
  page.on('request', (r) => { if (r.url().includes('localhost')) reqs.push(r.url().replace('http://localhost:8787','').slice(0,80)); });
  await page.goto('http://localhost:8787/', { waitUntil: 'domcontentloaded' });
  try { await page.waitForSelector('span:has-text("GOODA")', { timeout: 12000 }); }
  catch (e) {
    console.log('TIMEOUT. requests:', JSON.stringify(reqs.slice(0, 12), null, 0));
    console.log('body:', JSON.stringify((await page.textContent('#root')).slice(0, 400)));
    process.exit(1);
  }
  await page.waitForTimeout(600);

  // sparkline layout: the spark must sit fully INSIDE the row with a real
  // right-side gap (a rigid 72px spark used to overflow phone rows and get
  // clipped flush against the edge)
  const sp = await page.evaluate(() => {
    const sym = [...document.querySelectorAll('span')].find(s => s.textContent === 'GOODA');
    if (!sym) return null;
    let row = sym.parentElement;
    while (row && !(row.getAttribute('style') || '').includes('cursor: pointer')) row = row.parentElement;
    const canvas = row && row.querySelector('canvas');
    if (!row || !canvas) return { missing: true };
    const r = row.getBoundingClientRect(), c = canvas.getBoundingClientRect();
    return { gap: r.right - c.right, width: c.width };
  });
  console.log(sp && !sp.missing && sp.gap >= 16 && sp.width >= 14
    ? `✓ spark inside the row with a right gap (${Math.round(sp.gap)}px gap, ${Math.round(sp.width)}px spark)`
    : '✗ spark crammed against the row edge: ' + JSON.stringify(sp));

  // tap → the Advanced detail view opens DIRECTLY (the preview card is gone)
  const b0 = await page.textContent('#root');
  console.log(!b0.includes('Advanced view') ? '✓ no preview card markup on the list' : '✗ preview card still rendered');
  await page.click('span:has-text("GOODA")');
  await page.waitForSelector('text=Confluence tracker', { timeout: 15000 });
  const b1 = await page.textContent('#root');
  console.log(b1.includes('Confluence tracker') ? '✓ tapping a row opens the Advanced view directly' : '✗ Advanced view did not open');
  console.log(b1.includes('⟲') ? '✓ icon-only fit-all control present' : '✗ fit-all control missing');
  console.log(b1.includes('LULD') ? '✓ estimated LULD halt bands shown in the stats strip' : '✗ LULD estimate missing');
  await page.waitForSelector('text=Best bid', { timeout: 8000 });
  const l2 = await page.evaluate(() => {
    const root = document.querySelector('#root').textContent;
    const cv = [...document.querySelectorAll('canvas')].find(c => c.clientHeight === 64 || c.clientHeight === 120);
    const ts = [...document.querySelectorAll('span')].find(s => s.textContent === 'Time & sales');
    const l2h = [...document.querySelectorAll('span')].find(s => s.textContent === 'Level 2');
    const box = ts && ts.getBoundingClientRect();
    const l2box = l2h && l2h.getBoundingClientRect();
    return {
      hdr: root.includes('Level 2') && root.includes('Best bid') && root.includes('Best ask'),
      bid: root.includes('$1.41'), ask: root.includes('$1.43'), ladder: root.includes('Row 1 = live NBBO'),
      chart: !!cv && cv.width > 0,
      tapeOnScreen: !!(box && box.top < window.innerHeight && box.bottom > 0),
      l2OnScreen: !!(l2box && l2box.top < window.innerHeight && l2box.bottom > 0),
    };
  });
  console.log(l2.hdr && l2.bid && l2.ask && l2.ladder && l2.chart ? '✓ Level 2: best bid/ask block, depth chart, and Size·Bid·Ask·Size ladder from the NBBO' : '✗ Level 2 panel wrong: ' + JSON.stringify(l2));
  const tape = await page.evaluate(() => {
    const root = document.querySelector('#root').textContent;
    return { last: root.includes('1.42'), waiting: /Waiting for trades/.test(root) };
  });
  console.log(tape.last && !tape.waiting ? '✓ Time & Sales shows the mocked last trade (1.42) instead of a frozen wait' : '✗ Advanced ticks missing: ' + JSON.stringify(tape));
  console.log(l2.tapeOnScreen && l2.l2OnScreen ? '✓ Time & Sales and Level 2 sit on the first Advanced screen (under the chart)' : '✗ tape/L2 off-screen: ' + JSON.stringify(l2));
  const replayBtn = await page.evaluate(() => { const b = document.querySelector('button[aria-label="replay"]'); return b ? b.textContent.trim() : null; });
  console.log(replayBtn === '▶' ? '✓ icon-only replay control sits in the view-controls row' : '✗ replay control wrong: ' + JSON.stringify(replayBtn));
  // the four top bars must never spill past the phone's edge — and the price line is ONE line
  const bars = await page.evaluate(() => {
    const back = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '←');
    const hdr = back && back.parentElement;
    if (!hdr) return null;
    const rows = [hdr, hdr.nextElementSibling, hdr.nextElementSibling.nextElementSibling, hdr.nextElementSibling.nextElementSibling.nextElementSibling];
    const vw = window.innerWidth;
    const kids = [...hdr.children].map(k => Math.round(k.getBoundingClientRect().top));
    const replay = document.querySelector('button[aria-label="replay"]').getBoundingClientRect();
    const save = document.querySelector('button[aria-label="save chart snapshot"]').getBoundingClientRect();
    return {
      spill: rows.map(r => r.scrollWidth - r.clientWidth),
      right: rows.map(r => Math.round(r.getBoundingClientRect().right)), vw,
      oneLine: Math.max(...kids) - Math.min(...kids) < 12,
      left: Math.round(hdr.firstElementChild.getBoundingClientRect().left),
      replayRightGap: Math.round(vw - replay.right), saveRightGap: Math.round(vw - save.right),
    };
  });
  console.log(bars && bars.spill.every(x => x <= 0) && bars.oneLine ? `✓ header/news/timeframe/toggle bars fit the 390px screen with no overflow (one-line price row)` : '✗ top bars overflow: ' + JSON.stringify(bars));
  console.log(bars && bars.left === 16 && bars.replayRightGap === 16 && bars.saveRightGap === 16 ? '✓ left groups hug the left edge, right groups (Save · replay) hug the right edge' : '✗ group alignment off: ' + JSON.stringify(bars));
  console.log(b1.includes("Today's numbers") ? '✓ stats section carries its title' : '✗ stats title missing');
  console.log(!b1.includes('Alerts for GOODA') ? '✓ alert rules no longer occupy a persistent section' : '✗ alerts section still inline');
  const dayHi = await page.evaluate(() => { const l = [...document.querySelectorAll('div')].find(d => d.textContent === 'Day high'); return l ? l.nextElementSibling.textContent.trim() : null; });
  console.log(dayHi && /^\d+\.\d+$/.test(dayHi) ? `✓ stat cells show the level only — no up/down % tags (${dayHi})` : '✗ % tag still on stat cell: ' + JSON.stringify(dayHi));
  await page.click('button[aria-label="alerts for GOODA"]');
  await page.waitForTimeout(300);
  console.log((await page.textContent('#root')).includes('Alerts for GOODA') ? '✓ outline bell opens the per-ticker alerts sheet' : '✗ alerts sheet did not open');
  console.log(b1.includes('Copy') && b1.includes('Save') ? '✓ chart snapshot Copy/Save live in the news bar' : '✗ snapshot buttons missing');
  await page.fill('input[placeholder="price"]', '2.50');
  await page.click('button:has-text("+ Add level")');
  await page.waitForTimeout(400);
  const bLvl = await page.textContent('#root');
  console.log(bLvl.includes('$2.50') ? '✓ price-cross alert level added (chip shown, max 15)' : '✗ level chip missing');
  const storedPrefs = await page.evaluate(() => localStorage.getItem('alert-prefs'));
  console.log(storedPrefs && storedPrefs.includes('2.5') ? '✓ level persisted to alert-prefs storage' : '✗ prefs not persisted: ' + JSON.stringify(storedPrefs));
  // switch one alert category off for this ticker
  await page.click('button:has-text("VWAP reclaim")');
  await page.waitForTimeout(300);
  const storedPrefs2 = await page.evaluate(() => JSON.parse(localStorage.getItem('alert-prefs') || '{}'));
  console.log(storedPrefs2.GOODA && storedPrefs2.GOODA.off && storedPrefs2.GOODA.off.includes('vwap') ? '✓ per-ticker category toggle persists (vwap off for GOODA)' : '✗ category toggle not stored');
  await page.click('button[aria-label="close alerts"]');
  await page.waitForTimeout(200);
  console.log(!(await page.textContent('#root')).includes('Alerts for GOODA') ? '✓ sheet closes and gives the screen back' : '✗ alerts sheet stuck open');
  const tf = await page.evaluate(() => {
    const segs = [...document.querySelectorAll('button')].filter(b => /^(1m|5m|15m|1h|1D|5D|1M|3M|6M|1Y|5Y)$/.test(b.textContent.trim())).map(b => b.getBoundingClientRect());
    const save = document.querySelector('button[aria-label="save chart snapshot"]');
    return { n: segs.length, minH: Math.min(...segs.map(r => r.height)), minW: Math.min(...segs.map(r => r.width)), saveSvg: !!(save && save.querySelector('svg')), saveGlyph: save ? /⬇/.test(save.textContent) : null };
  });
  console.log(tf.n === 12 && tf.minH >= 32 && tf.minW >= 26 ? `✓ timeframe buttons are real tap targets (${Math.round(tf.minW)}×${Math.round(tf.minH)}px minimum)` : '✗ timeframe tap targets too small: ' + JSON.stringify(tf));
  console.log(tf.saveSvg && !tf.saveGlyph ? '✓ Save uses an outline icon' : '✗ Save icon wrong: ' + JSON.stringify(tf));
  await page.click('button:has-text("15m")');
  await page.waitForTimeout(500);
  const tfSel = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '15m'); return b && getComputedStyle(b).fontWeight; });
  console.log(String(tfSel) === '700' ? '✓ tapping a timeframe selects it' : '✗ timeframe tap ignored: ' + tfSel);
  await page.click('button:has-text("1m")');
  await page.waitForTimeout(500);
  await page.click('button[aria-label="copy chart snapshot"]');
  await page.waitForTimeout(500);
  const toast = await page.evaluate(() => { const t = document.querySelector('[role="status"]'); return t ? t.textContent : null; });
  console.log(toast && /Copied|Copy|copy/.test(toast) ? `✓ Copy reports its outcome in a bottom toast (${JSON.stringify(toast)})` : '✗ no toast after Copy: ' + JSON.stringify(toast));
  // AI trade plan card: idle → Analyze → levels, three scenarios, must-hold / must-fail, disclaimer
  const bP = await page.textContent('#root');
  console.log(bP.includes('AI trade plan') && bP.includes('Nothing is sent until you tap Analyze') ? '✓ AI plan card is idle until asked (nothing sent on open)' : '✗ plan card missing or eager');
  await page.click('button[aria-label="analyze"]');
  await page.waitForTimeout(600);
  const bQ = await page.textContent('#root');
  console.log(planReq && planReq.symbol === 'GOODA' && planReq.fresh === false ? '✓ Analyze posts the symbol to /plan' : '✗ plan request wrong: ' + JSON.stringify(planReq));
  console.log(bQ.includes('Long continuation') && bQ.includes('Dip buy') && bQ.includes('Stand aside') && bQ.includes('MUST HOLD') && bQ.includes('$1.19') ? '✓ plan renders three scenarios with must-hold / must-fail' : '✗ plan scenarios missing');
  console.log(bQ.includes('S $1.24') && bQ.includes('R $1.50') && bQ.includes('EMA 8') ? '✓ support / resistance chips render with their anchors' : '✗ level chips missing');
  console.log(bQ.includes('BULLISH') && bQ.includes('not financial advice') && bQ.includes('claude-opus-5') ? '✓ bias pill, disclaimer and serving model shown' : '✗ plan footer missing');
  await page.click('button[title="EMA 8"]');
  await page.waitForTimeout(300);
  const prefsL = await page.evaluate(() => JSON.parse(localStorage.getItem('alert-prefs') || '{}'));
  console.log(prefsL.GOODA && prefsL.GOODA.lv && prefsL.GOODA.lv.includes(1.24) ? '✓ tapping a level chip sets a price-cross alert at that level' : '✗ level → alert failed: ' + JSON.stringify(prefsL));
  const lvlBtn = await page.evaluate(() => { const b = document.querySelector('button[aria-label="toggle plan levels on chart"]'); return b ? b.textContent : null; });
  console.log(lvlBtn && /levels on/.test(lvlBtn) ? '✓ plan levels are drawn on the chart by default (toggle present)' : '✗ levels toggle missing: ' + lvlBtn);
  // add a price-cross level
  await page.click('button[aria-label="replay"]');
  await page.waitForTimeout(400);
  const hasSlider = await page.evaluate(() => !!document.querySelector('input[type="range"]'));
  console.log(hasSlider ? '✓ replay scrubber appears when Replay is toggled on' : '✗ replay scrubber missing');
  await page.click('button[aria-label="replay"]');
  await page.waitForTimeout(300);
  console.log(!b1.includes('Advanced view') ? '✓ no intermediate preview step' : '✗ preview card leaked into the flow');

  // back button returns to the list
  await page.click('button:has-text("←")');
  await page.waitForTimeout(500);
  const b2 = await page.textContent('#root');
  console.log(!b2.includes('Confluence tracker') && b2.includes('GOODA') ? '✓ back button returns to the watchlist' : '✗ back navigation broken');
  console.log('JS errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
