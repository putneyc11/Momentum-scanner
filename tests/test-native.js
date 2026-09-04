/* App Store (Capacitor) mode — Playwright UI test.
   Installs a fake window.Capacitor bridge with a PushNotifications plugin and
   checks: sign-up hides the simulated Apple/Google providers and pretend Pro
   billing (email + Free only, legal links present); the bell registers an
   APNs token with the server instead of a Web Push subscription; a denied
   permission explains itself; Delete account posts /auth/forget and signs
   out; the About page links Terms / Privacy / Support.
   Server on :8787. Run from tests/: `node test-native.js` */
let chromium; try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright')); }
const nowD = new Date();
const et = new Date(nowD.toLocaleString('en-US', { timeZone: 'America/New_York' }));
const diff = nowD.getTime() - et.getTime();
const tgt = new Date(et); tgt.setHours(13, 0, 0, 0);
const TARGET = tgt.getTime() + diff;
const OFFSET = TARGET - Date.now();
const dayISO = (o) => new Date(TARGET + (o || 0) * 864e5 - 90000).toISOString();
function dailySet() { const out = []; for (let i = 5; i >= 1; i--) out.push({ t: dayISO(-i), o: 1, h: 1.1, l: .9, c: 1, v: 4e5 }); out.push({ t: dayISO(0), o: 1.05, h: 1.45, l: 1, c: 1.4, v: 15e6 }); return out; }
function bars1(n) { const a = []; for (let i = 0; i < n; i++) { const c = 1 + i * .004; a.push({ t: new Date(TARGET - (n - i) * 60000 - 5000).toISOString(), o: c - .005, h: c + .01, l: c - .01, c, v: 16000 }); } return a; }
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✓', m); } else { fail++; console.log('✗', m); } };
(async () => {
  const browser = await chromium.launch(process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {});
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.addInitScript(([off]) => {
    const R = Date;
    class F extends R { constructor(...a) { a.length ? super(...a) : super(R.now() + off); } static now() { return R.now() + off; } }
    window.Date = F;
    /* fake Capacitor bridge */
    window.__pn = { perm: 'prompt', registered: 0, listeners: {} };
    const PN = {
      checkPermissions: async () => ({ receive: window.__pn.perm }),
      requestPermissions: async () => { window.__pn.perm = window.__pn.grant === false ? 'denied' : 'granted'; return { receive: window.__pn.perm }; },
      addListener: (ev, fn) => { (window.__pn.listeners[ev] = window.__pn.listeners[ev] || []).push(fn); return { remove: () => {} }; },
      register: async () => { window.__pn.registered++; setTimeout(() => (window.__pn.listeners.registration || []).forEach((f) => f({ value: 'ABCDEF' + '0123456789abcdef'.repeat(4).slice(0, 58) })), 20); },
    };
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: { PushNotifications: PN } };
  }, [OFFSET]);
  const posts = [];
  await page.route('**/trading/v2/assets?**', (r) => r.fulfill({ json: [{ symbol: 'GOODA', tradable: true, status: 'active', exchange: 'NASDAQ' }] }));
  await page.route('**/alpaca/v1beta1/**', (r) => r.fulfill({ json: { gainers: [], losers: [] } }));
  await page.route('**/alpaca/v2/stocks/trades/latest**', (r) => r.fulfill({ json: { trades: { GOODA: { p: 1.42, s: 100, t: new Date(TARGET).toISOString() } } } }));
  await page.route('**/alpaca/v2/stocks/bars**', (route) => {
    const u = new URL(route.request().url(), 'http://x'); const tf = u.searchParams.get('timeframe');
    const bars = {}; for (const s of (u.searchParams.get('symbols') || '').split(',').filter(Boolean)) bars[s] = tf === '1Day' ? dailySet() : bars1(20);
    route.fulfill({ json: { bars } });
  });
  await page.route('**/alpaca/v2/stocks/*/**', (r) => r.fulfill({ json: { trade: { p: 1.42, s: 100, t: new Date(TARGET).toISOString() }, quote: { bp: 1.41, bs: 3, ap: 1.43, as: 2, t: new Date(TARGET).toISOString() } } }));
  await page.route('**/float/**', (r) => r.fulfill({ json: { float: null } }));
  await page.route('**/push/**', (r) => { if (r.request().method() === 'POST') posts.push({ u: r.request().url().replace(/^.*:8787/, ''), b: r.request().postDataJSON() }); r.fulfill({ json: { ok: true, key: 'x' } }); });
  await page.route('**/auth/**', (r) => { posts.push({ u: r.request().url().replace(/^.*:8787/, ''), b: r.request().postDataJSON() }); r.fulfill({ json: { ok: true } }); });
  await page.route('**/settings', (r) => r.fulfill({ json: {} }));
  await page.route('**/journal**', (r) => r.fulfill({ json: { n: 0 } }));

  /* A) store-mode sign-up */
  await page.goto('http://localhost:8787/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  for (let i = 0; i < 5; i++) { await page.click('button:has-text("Next →")'); await page.waitForTimeout(120); }
  await page.click('button:has-text("Create account")');
  await page.waitForTimeout(300);
  let t = await page.textContent('#root');
  ok(t.includes('Create your account') && !t.includes('Continue with Apple') && !t.includes('Continue with Google') && t.includes('Continue with email'), 'store build: simulated Apple/Google providers hidden, email offered');
  ok(!t.includes('simulated'), 'no "preview build" copy on the review path');
  ok(await page.$('a[href="/terms"]') && await page.$('a[href="/privacy"]'), 'sign-up links Terms of Use and Privacy Policy');
  await page.click('button:has-text("Continue with email")'); await page.waitForTimeout(150);
  await page.fill('input[type="email"]', 'review@example.com'); await page.click('button:has-text("Continue")'); await page.waitForTimeout(250);
  t = await page.textContent('#root');
  ok(t.includes('Choose your plan') && !t.includes('$9.99') && !t.includes('Start Pro') && t.includes('coming soon'), 'plan screen: no pretend billing — Pro marked coming soon, no price, no Start Pro button');
  ok(t.includes('Continue with Free'), 'Free is the only selectable plan');
  await page.click('button:has-text("Continue with Free")'); await page.waitForTimeout(300);
  const acct = await page.evaluate(() => JSON.parse(localStorage.getItem('account') || 'null'));
  ok(acct && acct.plan === 'free' && acct.provider === 'email', 'account stored on the Free plan');

  /* B) native push registration through the bell */
  await page.evaluate(() => localStorage.setItem('alpaca-keys', JSON.stringify({ id: 'K', secret: 'S', feed: 'sip', maxPrice: 100, minDayVol: 5000000, ver: 3 })));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('span:has-text("GOODA")', { timeout: 15000 });
  await page.waitForTimeout(400);
  const bell = await page.$('button[aria-label*="alert" i], button[title*="alert" i]');
  ok(!!bell, 'alerts bell present');
  await bell.click(); await page.waitForTimeout(600);
  const reg = posts.find((p) => p.u === '/push/register');
  ok(reg && /^abcdef[0-9a-f]+$/i.test(reg.b.apns || '') && !reg.b.subscription, 'bell registers the APNs token (no Web Push subscription) with the server');
  ok((await page.evaluate(() => window.__pn.registered)) === 1 && (await page.evaluate(() => window.__pn.perm)) === 'granted', 'plugin asked for permission then registered');
  t = await page.textContent('#root');
  ok(t.includes('Lock-screen alerts armed'), 'banner confirms lock-screen alerts armed');
  /* foreground push → in-app banner */
  await page.evaluate(() => (window.__pn.listeners.pushNotificationReceived || []).forEach((f) => f({ title: '🚀 GOODA breakout', body: '4/5 signals' })));
  await page.waitForTimeout(200);
  t = await page.textContent('#root');
  ok(t.includes('GOODA breakout'), 'a push received in the foreground shows as the in-app banner');

  /* C) denied permission explains itself */
  posts.length = 0;
  await bell.click(); await page.waitForTimeout(300); /* off */
  ok(posts.some((p) => p.u === '/push/unregister'), 'turning the bell off unregisters');
  await page.evaluate(() => { window.__pn.perm = 'prompt'; window.__pn.grant = false; });
  await bell.click(); await page.waitForTimeout(500);
  t = await page.textContent('#root');
  ok(t.includes('Allow notifications for Momentum Scanner in iOS Settings') && !posts.some((p) => p.u === '/push/register'), 'denied permission: iOS Settings hint, nothing registered');

  /* D) About page legal links */
  await page.click('button[aria-label="how this works and disclosures"]'); await page.waitForTimeout(250);
  t = await page.textContent('#root');
  ok(t.includes('Legal & support') && await page.$('a[href="/terms"]') && await page.$('a[href="/privacy"]') && await page.$('a[href="/support"]'), 'About page links Terms, Privacy and Support');
  await page.click('button:has-text("←")'); await page.waitForTimeout(200);

  /* E) delete account from Settings */
  posts.length = 0;
  await page.click('button:has-text("Settings")'); await page.waitForTimeout(300);
  t = await page.textContent('#root');
  ok(t.includes('review@example.com') && t.includes('Delete account'), 'Settings shows the account with a Delete account action');
  await page.click('text=Delete account'); await page.waitForTimeout(400);
  const forget = posts.find((p) => p.u === '/auth/forget');
  ok(forget && typeof forget.b.device === 'string' && forget.b.device.length >= 8, 'Delete account posts /auth/forget with the device id');
  t = await page.textContent('#root');
  const acct2 = await page.evaluate(() => localStorage.getItem('account'));
  ok(!acct2 && t.includes('Account deleted'), 'account cleared locally, user signed out, confirmation shown');

  ok(errors.length === 0, 'no JS errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
