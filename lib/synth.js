/* Seeded synthetic gapper generator.

   Purpose: (1) validate the engine's mechanics end-to-end before any real
   keys exist, and (2) give the tuner a working demo library. It mimics the
   microstructure of scanner-class small-cap gappers with four archetypes:

     gapAndGo     gaps up premarket, breaks PMH/ORB and trends — the
                  strategy's bread and butter
     morningFade  gaps up, pops at the open, then bleeds all day — where
                  stops/vwap exits earn their keep
     chopPop      rangebound chop with a mid-morning pop that fails
     lateRunner   quiet open, real breakout after 10:30

   Deterministic: same seed -> same library, so tuner runs are reproducible.
   Synthetic results are for MECHANICS + relative parameter comparison only —
   never treat them as a forecast of real-market performance. The engine
   replaces this library with real recorded days as soon as it trades. */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ARCHES = ["gapAndGo", "morningFade", "chopPop", "lateRunner"];

function genSymbolDay(rng, arch, date) {
  const prevClose = 0.8 + rng() * 12;
  const gap = 0.12 + rng() * 0.6;              // +12%..+72% premarket gap
  const bars = [];
  let p = prevClose * (1 + gap * 0.35);        // 4:00 starts partway into the gap
  /* even "good" setups fail often in the real tape — a gapAndGo has a ~45%
     chance of rolling over mid-morning, and a lateRunner can fizzle */
  const fails = rng() < 0.45;
  const failAt = 620 + Math.floor(rng() * 90);
  const drift = {
    gapAndGo: (m) => (m < 570 ? 0.0006 : fails && m >= failAt ? -0.0012 : m < 700 ? 0.0009 : 0.0001),
    morningFade: (m) => (m < 570 ? 0.0007 : m < 590 ? 0.0012 : -0.0011),
    chopPop: (m) => (m >= 620 && m < 645 ? 0.0016 : m >= 645 && m < 680 ? -0.0014 : 0),
    lateRunner: (m) => (m < 630 ? -0.0001 : fails ? 0 : m < 750 ? 0.001 : 0.0002),
  }[arch];
  const baseVol = 3000 + rng() * 25000;
  for (let m = 4 * 60; m < 16 * 60; m++) {
    const rth = m >= 570;
    const vol = Math.round(baseVol * (rth ? 1 : 0.12) * (m >= 570 && m < 600 ? 3.5 : 1) * (0.4 + rng() * 1.6));
    const noise = (rng() - 0.5) * p * (rth ? 0.013 : 0.005);
    const o = p;
    p = Math.max(0.05, p * (1 + drift(m)) + noise);
    const hi = Math.max(o, p) * (1 + rng() * 0.007);
    const lo = Math.min(o, p) * (1 - rng() * 0.007);
    bars.push({ t: Date.parse(date + "T09:00:00Z") + m * 60000, o: r4(o), h: r4(hi), l: r4(lo), c: r4(p), v: vol, m });
  }
  return bars;
}
const r4 = (v) => +v.toFixed(4);

function makeLibrary(nDays, seed = 42) {
  const rng = mulberry32(seed);
  const days = [];
  for (let d = 0; d < nDays; d++) {
    const date = `S${String(d + 1).padStart(3, "0")}`; // synthetic day label
    const symbols = {};
    const n = 2 + Math.floor(rng() * 3);
    for (let k = 0; k < n; k++) {
      const arch = ARCHES[Math.floor(rng() * ARCHES.length)];
      symbols[`SY${d}${String.fromCharCode(65 + k)}`] = genSymbolDay(rng, arch, "2026-01-05");
    }
    days.push({ date, symbols, synthetic: true });
  }
  return days;
}

module.exports = { makeLibrary, mulberry32 };
