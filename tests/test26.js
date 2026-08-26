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
  console.log(b1.includes('Fit all') ? '✓ full chart controls present on the detail page' : '✗ detail controls missing');
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
