/* Run: node tests/test-push-recovery.js
   Exercises the actual client recovery functions with browser/HTTP stubs.
   No browser, live network, credentials, or generated bundle required. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/momentum-dashboard.jsx'), 'utf8');
const helpers = source.slice(source.indexOf('const NATIVE ='), source.indexOf('async function req('));
const key = (n) => Uint8Array.from({ length: 65 }, (_, i) => i ? n : 4);
const encode = (k) => Buffer.from(k).toString('base64url');
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function fixture(options = {}) {
  const calls = [], states = [], listeners = new Map();
  const f = { calls, states, permissionRequests: 0, subscriptions: 0, removals: 0, nativeRegistrations: 0, listenerRemovals: 0, serverSub: null, watch: null, failures: {}, holds: {} };
  f.currentKey = key(2);
  const subscription = (k) => ({
    endpoint: `https://push.test/sub-${++f.subscriptions}`,
    options: { applicationServerKey: k.buffer },
    toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'stub', auth: 'stub' } }; },
    async unsubscribe() { f.removals++; if (f.sub === this) f.sub = null; return true; },
  });
  f.sub = options.noSubscription ? null : subscription(options.oldKey ? key(1) : f.currentKey);
  const registration = { pushManager: {
    getSubscription: async () => f.sub,
    subscribe: async ({ applicationServerKey }) => (f.sub = subscription(applicationServerKey)),
  } };
  const Notification = {
    permission: options.permission || 'granted',
    requestPermission() { f.permissionRequests++; this.permission = 'granted'; return Promise.resolve('granted'); },
  };
  const nativePN = {
    checkPermissions: async () => ({ receive: Notification.permission === 'default' ? 'prompt' : Notification.permission }),
    requestPermissions: async () => { f.permissionRequests++; Notification.permission = 'granted'; return { receive: 'granted' }; },
    addListener: async (event, fn) => { listeners.set(event, fn); return { remove() { listeners.delete(event); f.listenerRemovals++; } }; },
    register: async () => { f.nativeRegistrations++; listeners.get('registration')({ value: 'abc123' }); },
  };
  const context = {
    keys: options.serverKeys ? { id: 'server', secret: 'server', code: 'saved-invite' } : { id: 'test-key', secret: 'test-secret' },
    feed: 'sip', device: 'dv-test-device', watchReady: true,
    watchlist: { device: 'dv-test-device', symbols: ['GCDT', 'NUR'], prefs: { NUR: { off: ['rot'], lv: [] } }, mode: 'all' },
  };
  f.context = context;
  const sandbox = {
    Uint8Array, ArrayBuffer, AbortController, setTimeout, clearTimeout,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    Notification,
    window: { Notification, PushManager: {}, ...(options.native ? { Capacitor: { isNativePlatform: () => true, Plugins: { PushNotifications: nativePN } } } : {}) },
    navigator: { serviceWorker: { register: async () => registration, getRegistration: async () => registration } },
    fetch: async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url, body });
      const failure = f.failures[url];
      if (!failure) {
        if (url === '/push/register') f.serverSub = body;
        if (url === '/push/unregister') f.serverSub = null;
        if (url === '/push/watchlist') f.watch = body;
      }
      const hold = f.holds[url];
      if (hold) { hold.arrived.resolve(); await hold.release.promise; }
      return { ok: !failure || failure.status === 200, status: failure ? failure.status : 200,
        json: async () => failure ? { error: failure.error, ok: false } : url === '/push/pubkey' ? { key: encode(f.currentKey) } : { ok: true } };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(helpers + '\nthis.create = createPushRecovery;', sandbox);
  f.recovery = sandbox.create({ getContext: () => context, onState: (s) => states.push(s) });
  f.hold = (url) => (f.holds[url] = { arrived: deferred(), release: deferred() });
  f.armed = () => states.at(-1)?.armed || false;
  return f;
}
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('✓ ' + name); }
(async () => {
  await test('reload stays unarmed until both registration and watchlist are accepted, then restores a lost server record', async () => {
    const f = fixture();
    f.recovery.enable();
    assert.equal(f.armed(), false);
    const hold = f.hold('/push/watchlist');
    const pending = f.recovery.reconcile();
    await hold.arrived.promise;
    assert.ok(f.serverSub);
    assert.equal(f.armed(), false);
    hold.release.resolve();
    assert.equal(await pending, true);
    assert.equal(f.armed(), true);
    assert.equal(f.subscriptions, 1);
    f.serverSub = null; f.watch = null;
    assert.equal(await f.recovery.reconcile(), true);
    assert.ok(f.serverSub);
    assert.deepEqual(f.watch, f.context.watchlist);
    assert.equal(f.permissionRequests, 0);
    assert.equal(f.subscriptions, 1);
  });
  await test('rotated VAPID key replaces the stale browser subscription before registration', async () => {
    const f = fixture({ oldKey: true });
    const oldEndpoint = f.sub.endpoint;
    f.recovery.enable();
    assert.equal(await f.recovery.reconcile(), true);
    assert.equal(f.removals, 1);
    assert.equal(f.subscriptions, 2);
    assert.notEqual(f.serverSub.subscription.endpoint, oldEndpoint);
    assert.deepEqual(new Uint8Array(f.sub.options.applicationServerKey), f.currentKey);
  });
  await test('startup before discovery preserves the server watchlist, then accepts discovered targets or an explicit empty list', async () => {
    const f = fixture();
    f.context.watchReady = false;
    f.context.watchlist.symbols = [];
    f.watch = { symbols: ['GCDT'], mode: 'all' };
    f.recovery.enable();
    assert.equal(await f.recovery.reconcile(), false);
    assert.equal(f.armed(), false);
    assert.equal(f.calls.some((c) => c.url === '/push/watchlist'), false);
    assert.deepEqual(f.watch.symbols, ['GCDT']);
    assert.match(f.states.at(-1).error, /Waiting for scanner watchlist/);
    f.context.watchReady = true;
    f.context.watchlist.symbols = ['NUR'];
    assert.equal(await f.recovery.syncWatch(), true);
    assert.deepEqual(f.watch.symbols, ['NUR']);
    f.context.watchlist.symbols = [];
    assert.equal(await f.recovery.syncWatch(), true);
    assert.deepEqual(f.watch.symbols, []);
  });
  for (const [url, status, serverKeys] of [
    ['/push/pubkey', 503, false], ['/push/register', 403, false],
    ['/push/watchlist', 500, false], ['/auth/claim', 403, true], ['/push/register', 200, false],
  ]) await test(`${url} rejects ${status} failure without claiming lock-screen readiness`, async () => {
    const f = fixture({ serverKeys });
    f.failures[url] = { status, error: 'test refusal' };
    f.recovery.enable();
    assert.equal(await f.recovery.reconcile(), false);
    assert.equal(f.armed(), false);
    assert.match(f.states.at(-1).error, /test refusal/);
    assert.equal(f.states.some((s) => s.armed), false);
    if (url === '/auth/claim') assert.equal(f.calls.length, 1);
    if (url === '/push/register') assert.equal(f.watch, null);
  });
  await test('a later watchlist HTTP failure removes readiness and full recovery restores it', async () => {
    const f = fixture();
    f.recovery.enable(); await f.recovery.reconcile();
    f.failures['/push/watchlist'] = { status: 503, error: 'storage unavailable' };
    assert.equal(await f.recovery.syncWatch(), false);
    assert.equal(f.armed(), false);
    delete f.failures['/push/watchlist'];
    assert.equal(await f.recovery.syncWatch(), true);
    assert.equal(f.armed(), true);
  });
  await test('automatic recovery never prompts; manual enable requests permission immediately', async () => {
    const f = fixture({ permission: 'default', noSubscription: true });
    f.recovery.enable();
    assert.equal(await f.recovery.reconcile(), false);
    assert.equal(f.permissionRequests, 0);
    const manual = f.recovery.reconcile({ requestPermission: true });
    assert.equal(f.permissionRequests, 1);
    assert.equal(await manual, true);
  });
  await test('simultaneous recovery calls share one registration and watch sync does not re-register', async () => {
    const f = fixture(); f.recovery.enable();
    const hold = f.hold('/push/register');
    const first = f.recovery.reconcile();
    await hold.arrived.promise;
    const second = f.recovery.reconcile();
    assert.equal(first, second);
    hold.release.resolve(); await first;
    f.context.watchlist.symbols.push('ARBE');
    await f.recovery.syncWatch();
    assert.equal(f.calls.filter((c) => c.url === '/push/register').length, 1);
    assert.deepEqual(f.watch.symbols, ['GCDT', 'NUR', 'ARBE']);
  });
  for (const standalone of [false, true]) await test(`watch edits during ${standalone ? 'watch sync' : 'reconciliation'} drain the latest mode and symbols before completion`, async () => {
    const f = fixture(); f.recovery.enable();
    if (standalone) await f.recovery.reconcile();
    const before = f.calls.filter((c) => c.url === '/push/watchlist').length;
    const hold = f.hold('/push/watchlist');
    f.context.watchlist.mode = 'rec';
    const pending = standalone ? f.recovery.syncWatch() : f.recovery.reconcile();
    await hold.arrived.promise;
    f.context.watchlist.mode = 'all';
    f.context.watchlist.symbols = ['NUR'];
    const updated = f.recovery.syncWatch();
    hold.release.resolve();
    assert.equal(await pending, true);
    assert.equal(await updated, true);
    assert.equal(f.watch.mode, 'all');
    assert.deepEqual(f.watch.symbols, ['NUR']);
    assert.equal(f.calls.filter((c) => c.url === '/push/watchlist').length - before, 2);
  });
  for (const heldPath of ['/push/register', '/push/watchlist']) await test(`a newly validated connection during ${heldPath} is registered before readiness resolves`, async () => {
    const f = fixture(); f.recovery.enable();
    const hold = f.hold(heldPath);
    const pending = f.recovery.reconcile();
    await hold.arrived.promise;
    f.context.keys = { id: 'new-validated-key', secret: 'new-validated-secret' };
    f.context.feed = 'iex';
    const updated = f.recovery.reconcile();
    assert.equal(f.armed(), false);
    hold.release.resolve();
    assert.equal(await pending, true);
    assert.equal(await updated, true);
    assert.equal(f.serverSub.keys.id, 'new-validated-key');
    assert.equal(f.serverSub.feed, 'iex');
    assert.equal(f.calls.filter((c) => c.url === '/push/register').length, 2);
    assert.equal(f.states.filter((state) => state.armed).length, 1);
    assert.equal(f.removals, 0);
  });
  await test('bell-off during registration cannot re-arm and unregisters after the in-flight request', async () => {
    const f = fixture(); f.recovery.enable();
    const hold = f.hold('/push/register');
    const pending = f.recovery.reconcile();
    await hold.arrived.promise;
    const disabled = f.recovery.disable();
    assert.equal(f.armed(), false);
    hold.release.resolve();
    assert.equal(await pending, false); await disabled;
    assert.equal(f.serverSub, null);
    assert.equal(f.sub, null);
    assert.equal(f.watch, null);
    assert.equal(f.states.some((s) => s.armed), false);
    assert.equal(f.calls.at(-1).url, '/push/unregister');
    assert.equal(await f.recovery.reconcile(), false);
  });
  await test('off then immediately on serializes cleanup before the new registration', async () => {
    const f = fixture(); f.recovery.enable();
    const hold = f.hold('/push/register');
    const old = f.recovery.reconcile(); await hold.arrived.promise;
    const disabled = f.recovery.disable(); f.recovery.enable();
    const newer = f.recovery.reconcile();
    delete f.holds['/push/register']; hold.release.resolve();
    await old; await disabled;
    assert.equal(await newer, true);
    assert.equal(f.armed(), true);
    assert.ok(f.serverSub);
    assert.deepEqual(f.calls.filter((c) => ['/push/register', '/push/unregister'].includes(c.url)).map((c) => c.url), ['/push/register', '/push/unregister', '/push/register']);
  });
  await test('native recovery preserves the saved invite, sends BYOK credentials, and cleans up token listeners', async () => {
    const f = fixture({ native: true, serverKeys: true }); f.recovery.enable();
    assert.equal(await f.recovery.reconcile(), true);
    assert.equal(f.calls[0].url, '/auth/claim');
    assert.equal(f.calls[0].body.code, 'saved-invite');
    assert.equal(f.serverSub.apns, 'abc123');
    assert.equal(f.permissionRequests, 0);
    assert.equal(f.listenerRemovals, 2);
    const byok = fixture({ native: true }); byok.recovery.enable();
    await byok.recovery.reconcile();
    assert.deepEqual(byok.serverSub.keys, byok.context.keys);
    assert.equal(byok.serverSub.feed, 'sip');
  });
  await test('native recovery without permission does not show a prompt', async () => {
    const f = fixture({ native: true, permission: 'default' }); f.recovery.enable();
    assert.equal(await f.recovery.reconcile(), false);
    assert.equal(f.permissionRequests, 0);
    assert.equal(f.nativeRegistrations, 0);
    assert.equal(await f.recovery.reconcile({ requestPermission: true }), true);
    assert.equal(f.permissionRequests, 1);
  });
  await test('Settings drafts and failed Connect cannot replace the last connected push credentials', async () => {
    let connected = { keys: { id: 'working', secret: 'working-secret' }, feed: 'sip' };
    const sandbox = {
      keys: { id: 'partial-edit', secret: '' }, feed: 'iex', remember: false,
      maxPrice: 100, minDayVol: 2000000,
      setErr() {}, setRunning() {}, setPushConnection: (v) => { connected = v; },
      barParams: (_f, x) => x, daysAgoISO: () => '2026-09-01',
      alpaca: async () => { throw new Error('invalid credentials'); },
    };
    vm.createContext(sandbox);
    const connectBlock = source.slice(source.indexOf('  const connect = async () => {'), source.indexOf('  /* rows go straight to the Advanced'));
    vm.runInContext(connectBlock + '\nthis.attempt = connect;', sandbox);
    await sandbox.attempt();
    assert.equal(connected.keys.id, 'working');
    sandbox.keys = { id: 'bad-key', secret: 'bad-secret' };
    await sandbox.attempt();
    assert.equal(connected.keys.id, 'working');
    const assignment = source.match(/  pushContextRef\.current = [^\n]+;/)[0];
    sandbox.pushConnection = connected; sandbox.pushContextRef = { current: null };
    vm.runInContext(assignment, sandbox);
    assert.equal(sandbox.pushContextRef.current.keys.id, 'working');
    assert.equal(sandbox.pushContextRef.current.feed, 'sip');
    sandbox.keys = { id: 'verified-new', secret: 'verified-secret' };
    sandbox.alpaca = async () => ({ bars: {} });
    await sandbox.attempt();
    sandbox.pushConnection = connected;
    vm.runInContext(assignment, sandbox);
    assert.equal(sandbox.pushContextRef.current.keys.id, 'verified-new');
    assert.equal(sandbox.pushContextRef.current.feed, 'iex');
  });
  for (const scenario of ['no candidates', 'filtered candidates', 'unfinished sweep', 'unfinished premarket', 'movers error', 'bars error'])
    await test(`refresh handles ${scenario} without mistaking failed discovery for an empty watchlist`, async () => {
      const synced = [];
      const sandbox = {
        useCallback: (fn) => fn, keys: { id: 'test', secret: 'test' }, feed: 'sip', maxPrice: 100, minDayVol: 2000000,
        busy: { current: false }, hotRef: { current: scenario === 'filtered candidates' || scenario === 'bars error' ? ['NUR'] : [] },
        uniSetRef: { current: null }, moversRef: { current: [] }, candRef: { current: {} },
        sweepReadyRef: { current: !['unfinished sweep', 'unfinished premarket'].includes(scenario) }, watchAllRef: { current: ['OLD'] },
        watchPoolRef: { current: ['OLD'] }, watchReadyRef: { current: false }, gainersRef: { current: [] },
        ahRef: { current: [] }, ignScanRef: { current: null }, alertsOnRef: { current: false },
        inPremarket: () => scenario === 'unfinished premarket', inAfterHours: () => false, etDay: () => '2026-09-08',
        barParams: (_f, x) => x, daysAgoISO: () => '2026-09-01', PM_PCT_FLOOR: 10,
        getFloat() {}, alertOnce() {}, prefOff() {}, setGainers() {}, setBarsMap() {}, setPmMap() {}, setUpdated() {}, setErr() {}, setPushWarn() {},
        fetch: async () => ({ json: async () => ({ devices: 1 }) }),
        alpaca: async (url) => {
          if (url.includes('/movers')) {
            if (scenario === 'movers error') throw new Error('offline');
            return { gainers: scenario === 'unfinished premarket' ? [{ symbol: 'NUR' }] : [] };
          }
          if (scenario === 'bars error') throw new Error('offline');
          return { bars: { NUR: [{ t: '2026-09-07', c: 1, v: 1000000 }, { t: '2026-09-08', c: 1.05, v: 1000000 }] } };
        },
      };
      sandbox.syncWatch = () => { synced.push([...sandbox.watchPoolRef.current]); };
      const refreshBlock = source.slice(source.indexOf('  const refresh = useCallback(async () => {'), source.indexOf('  useEffect(() => { refreshRef.current = refresh;'));
      vm.runInNewContext(refreshBlock + '\nthis.refreshAttempt = refresh;', sandbox);
      await sandbox.refreshAttempt();
      const success = scenario === 'no candidates' || scenario === 'filtered candidates';
      assert.equal(sandbox.watchReadyRef.current, success);
      assert.deepEqual(synced, success ? [[]] : []);
      assert.deepEqual([...sandbox.watchPoolRef.current], success ? [] : ['OLD']);
    });
  await test('saved-settings restoration retains the invite and does not trust an existing local subscription', async () => {
    const loaded = deferred();
    let keys, connection, alerts = false, armed = false;
    const block = source.slice(source.indexOf('  /* load saved settings:'), source.indexOf('  useEffect(() => { alertsOnRef.current = alertsOn;'));
    const stored = { id: 'server', secret: 'server', code: 'saved-invite', feed: 'sip', alertsOn: true, ver: 4, minDayVol: 2000000 };
    const sandbox = {
      useEffect: (fn) => fn(), window: { storage: { get: async (k) => k === 'alpaca-keys' ? { value: JSON.stringify(stored) } : null } },
      navigator: { serviceWorker: { getRegistration: async () => ({ pushManager: { getSubscription: async () => ({ endpoint: 'old' }) } }) } },
      FEED_MODES: { sip: {} }, alertsOnRef: { current: false }, alertModeRef: { current: 'rec' },
      setKeys: (v) => { keys = v; }, setAlertsOn: (v) => { alerts = v; }, setPushArmed: (v) => { armed = v; },
      setPushConnection: (v) => { connection = v; }, setSettingsLoaded: () => loaded.resolve(), setFeed() {}, setMaxPrice() {}, setMinDayVol() {}, setRunning() {}, restoreMuted() {}, setAlertModeState() {},
    };
    vm.runInNewContext(block, sandbox); await loaded.promise;
    assert.equal(keys.code, 'saved-invite');
    assert.equal(connection.keys.code, 'saved-invite');
    assert.equal(connection.feed, 'sip');
    assert.equal(alerts, true);
    assert.equal(armed, false);
  });
  console.log(`\n${passed} push recovery tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
