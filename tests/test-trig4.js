const { computeTriggers } = require('./server.js') /* copy deploy/server.js beside this file */;
const now = Date.now();
let pass = 0, fail = 0;
const ck = (n, c) => { c ? pass++ : fail++; console.log((c ? '✓ ' : '✗ ') + n); };
function mkSess(spec) {
  // spec: array of {h, m, o, c, v} in ET; returns bars with epoch ts
  const nowD = new Date();
  const et = new Date(nowD.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const diff = nowD.getTime() - et.getTime();
  return spec.map((b) => {
    const d = new Date(et); d.setHours(b.h, b.m, 0, 0);
    return { t: d.getTime() + diff, o: b.o, h: Math.max(b.o, b.c) + .01, l: Math.min(b.o, b.c) - .01, c: b.c, v: b.v };
  });
}
function base(px) {
  const out = [];
  for (let m = 0; m < 25; m++) out.push({ h: 9, m, o: px, c: px, v: 30000 });
  return out;
}

// ---- 1) opening drive uses the LARGEST of the first TEN candles ----
// 9:30 candle small (40k) but 9:36 was the monster (180k); old logic (9:30/31 only, <100k) would never arm
let spec = base(2);
for (let m = 30; m < 40; m++) spec.push({ h: 9, m, o: 2, c: 2.01, v: m === 36 ? 180000 : 40000 });
for (let m = 40; m < 58; m++) spec.push({ h: 9, m, o: 2.01, c: 2.01, v: 30000 });
let st = {};
computeTriggers('W', mkSess(spec), st, now); // baseline
spec.push({ h: 9, m: 58, o: 2.02, c: 2.05, v: 190000 }); // ≥ the 9:36 monster
let bars = mkSess(spec); bars[bars.length - 1].t = now - 30000;
let out = computeTriggers('W', bars, st, now);
ck('opening drive keys off the LARGEST of the first ten candles (180k @ 9:36)', out.some((t) => t.key.includes('-vol') && t.body.includes('opening drive')));

// smaller bar (150k < 180k) must NOT match
st = {};
spec = base(2);
for (let m = 30; m < 40; m++) spec.push({ h: 9, m, o: 2, c: 2.01, v: m === 36 ? 180000 : 40000 });
for (let m = 40; m < 58; m++) spec.push({ h: 9, m, o: 2.01, c: 2.01, v: 30000 });
computeTriggers('W2', mkSess(spec), st, now);
spec.push({ h: 9, m: 58, o: 2.02, c: 2.03, v: 150000 });
bars = mkSess(spec); bars[bars.length - 1].t = now - 30000;
out = computeTriggers('W2', bars, st, now);
ck('150k bar vs a 180k opening max stays silent', !out.some((t) => t.body && t.body.includes('opening drive')));

// ---- 2) mom3: 3 consecutive green candles ----
st = {};
spec = base(2);
for (let m = 30; m < 55; m++) spec.push({ h: 9, m, o: 2, c: 1.99, v: 30000 }); // red chop
computeTriggers('M', mkSess(spec), st, now); // baseline
spec.push({ h: 9, m: 55, o: 2.00, c: 2.03, v: 25000 });
spec.push({ h: 9, m: 56, o: 2.03, c: 2.07, v: 25000 });
spec.push({ h: 9, m: 57, o: 2.07, c: 2.12, v: 25000 });
bars = mkSess(spec); bars[bars.length - 1].t = now - 20000;
out = computeTriggers('M', bars, st, now);
const momA = out.filter((t) => t.key.includes('-mom3'));
ck('streak hitting 3 greens fires exactly ONE alert', momA.length === 1);
ck('...alert shows the run ($2.00 → $2.12)', momA[0] && momA[0].body.includes('2.00') && momA[0].body.includes('2.12'));

// 4th green: no re-fire
spec.push({ h: 9, m: 58, o: 2.12, c: 2.15, v: 25000 });
bars = mkSess(spec); bars[bars.length - 1].t = now - 20000;
out = computeTriggers('M', bars, st, now + 60000);
ck('4th green candle does NOT re-fire (once per streak)', out.filter((t) => t.key.includes('-mom3')).length === 0);

// new streak inside the 15-min cooldown: silent
spec.push({ h: 9, m: 59, o: 2.15, c: 2.10, v: 25000 }); // red
spec.push({ h: 10, m: 0, o: 2.10, c: 2.12, v: 25000 });
spec.push({ h: 10, m: 1, o: 2.12, c: 2.14, v: 25000 });
spec.push({ h: 10, m: 2, o: 2.14, c: 2.16, v: 25000 });
bars = mkSess(spec); bars[bars.length - 1].t = now - 20000;
out = computeTriggers('M', bars, st, now + 5 * 60000);
ck('new streak within the 15-min cooldown stays silent', out.filter((t) => t.key.includes('-mom3')).length === 0);

// mid-streak first sight = baseline, no replay
st = {};
out = computeTriggers('M2', bars, st, now + 5 * 60000);
ck('symbol first seen mid-streak fires nothing (silent baseline)', out.length === 0);

console.log(fail === 0 ? 'ALL TRIGGER TESTS PASS' : fail + ' FAILURES');
process.exit(fail ? 1 : 0);
