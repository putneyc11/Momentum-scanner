const http = require('http');
const { computeTriggers } = require('./server.js') /* copy deploy/server.js beside this file */;
const now = Date.now();
let pass = 0, fail = 0;
const ck = (n, c) => { c ? pass++ : fail++; console.log((c ? '✓ ' : '✗ ') + n); };

// helper: session with ET-timed open candles
function sess({ openVol, lastVol, lastMove, lastAgoSec }) {
  const nowD = new Date();
  const et = new Date(nowD.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const diff = nowD.getTime() - et.getTime();
  const mk = (h, m, p, v, mv) => { const d = new Date(et); d.setHours(h, m, 0, 0);
    const o = p, c = p * (1 + (mv || 0) / 100);
    return { t: d.getTime() + diff, o, h: Math.max(o, c) + .01, l: Math.min(o, c) - .01, c, v }; };
  const out = [];
  for (let m = 0; m < 25; m++) out.push(mk(9, m, 2, 30000, 0));
  out.push(mk(9, 30, 2.02, openVol, 0.3));
  out.push(mk(9, 31, 2.03, Math.round(openVol * 0.8), 0.2));
  for (let m = 32; m < 55; m++) out.push(mk(9, m, 2.03, 30000, 0));
  const lastBar = mk(9, 55, 2.05, lastVol, lastMove);
  lastBar.t = now - (lastAgoSec || 30) * 1000;
  out.push(lastBar);
  return out;
}

// 1) his exact bug: BOTH "opening drive" and "spike" qualify → ONE alert, not two
let st = {};
computeTriggers('X', sess({ openVol: 150000, lastVol: 30000, lastMove: 0 }), st, now); // baseline, quiet
let out = computeTriggers('X', sess({ openVol: 150000, lastVol: 210000, lastMove: 1.6 }), st, now);
const volAlerts = out.filter((t) => t.key.includes('-vol'));
ck('spike + opening-drive on one bar = exactly ONE notification', volAlerts.length === 1);
ck('...and the single message mentions the opening drive', volAlerts[0] && volAlerts[0].body.includes('opening drive'));

// 2) same bar seen on the next 45s tick → zero
out = computeTriggers('X', sess({ openVol: 150000, lastVol: 210000, lastMove: 1.6 }), st, now + 45000);
ck('same qualifying bar on the next tick fires NOTHING', out.filter((t) => t.key.includes('-vol')).length === 0);

// 3) another qualifying bar 5 min later, inside the 30-min cooldown → zero
const s2 = sess({ openVol: 150000, lastVol: 260000, lastMove: 2.1 });
s2[s2.length - 1].t = now + 5 * 60000;
out = computeTriggers('X', s2, st, now + 5 * 60000 + 30000);
ck('second spike within the 30-min cooldown stays silent', out.filter((t) => t.key.includes('-vol')).length === 0);

// 4) the bogus "matched market open": QUIET open (9:30 = 8k shares) → 60k bar must NOT match
st = {};
computeTriggers('Y', sess({ openVol: 8000, lastVol: 20000, lastMove: 0 }), st, now);
out = computeTriggers('Y', sess({ openVol: 8000, lastVol: 60000, lastMove: 0.4 }), st, now);
ck('a 60k bar vs a QUIET 8k open fires nothing (weak-baseline match killed)', out.filter((t) => t.key.includes('-vol')).length === 0);

// 5) new list entrant already mid-spike → baseline consumes it, silent
st = {};
out = computeTriggers('Z', sess({ openVol: 150000, lastVol: 300000, lastMove: 2.5 }), st, now);
ck('symbol that pops onto the list mid-spike fires nothing (baseline consumes the bar)', out.length === 0);
out = computeTriggers('Z', sess({ openVol: 150000, lastVol: 300000, lastMove: 2.5 }), st, now + 45000);
ck('...and stays silent on the following tick', out.filter((t) => t.key.includes('-vol')).length === 0);

// 6) registration replaces: two registers → 1 device
const post = (path, body) => new Promise((res) => {
  const data = JSON.stringify(body);
  const rq = http.request({ host: 'localhost', port: 8793, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (r) => {
    let b = ''; r.on('data', (c) => b += c); r.on('end', () => res(JSON.parse(b)));
  });
  rq.end(data);
});
(async () => {
  await post('/push/register', { subscription: { endpoint: 'https://push.example/safari', keys: { p256dh: 'x', auth: 'y' } }, keys: { id: 'K', secret: 'S' }, feed: 'sip' });
  const r2 = await post('/push/register', { subscription: { endpoint: 'https://push.example/pwa', keys: { p256dh: 'x', auth: 'y' } }, keys: { id: 'K', secret: 'S' }, feed: 'sip' });
  ck('second registration REPLACES the first (devices=1, no double delivery)', r2.devices === 1);
  console.log(fail === 0 ? 'ALL DUPLICATE-SCENARIO TESTS PASS' : fail + ' FAILURES');
  process.exit(fail ? 1 : 0);
})();
