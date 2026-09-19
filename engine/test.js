#!/usr/bin/env node
/* Unit tests for the v3 engine. Run: node engine/test.js */
'use strict';
const assert = require('assert');
const fs = require('fs'), path = require('path');
const E = require('./engine.js');
const hist = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/history/hsi.json'), 'utf8')).rows;
const cal = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/history/calendar.json'), 'utf8'));
const warrants = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/history/warrants-sample.json'), 'utf8')).rows;
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

// 1 · mirror symmetry: flip the price series around a pivot → every call flips, conviction negates
t('mirror symmetry of the HSI-native core (no external data)', () => {
  const K = 50000;
  const mirror = rows => rows.map(r => ({ d: r.d, o: K - r.o, h: K - r.l, l: K - r.h, c: K - r.c }));
  let calls = 0, flips = 0;
  for (let i = 16; i < hist.length; i++) {
    const a = E.decide({ date: hist[i].d, ohlc: hist.slice(0, i), preOpen: hist[i].o, ext: null, calendar: [] });
    const b = E.decide({ date: hist[i].d, ohlc: mirror(hist.slice(0, i)), preOpen: K - hist[i].o, ext: null, calendar: [] });
    assert.strictEqual(a.conviction + b.conviction, 0, hist[i].d + ' conviction not negated: ' + a.conviction + ' vs ' + b.conviction);
    assert.strictEqual(a.dir, a.dir === null ? b.dir : (a.dir === 'C' ? 'P' : 'C') === b.dir ? a.dir : 'MISMATCH', hist[i].d + ' direction not mirrored');
    if (a.dir) { calls++; if (b.dir && b.dir !== a.dir) flips++; }
  }
  assert.ok(calls > 0, 'engine never called a direction on the sample history');
  assert.strictEqual(flips, calls);
});
// 2 · external modifiers are odd too
t('US and China modifiers negate under sign flip', () => {
  const ctx = { date: hist[40].d, ohlc: hist.slice(0, 40), preOpen: hist[40].o, calendar: [] };
  const a = E.decide(Object.assign({}, ctx, { ext: { spxChgPct: 1.2, vix: 15, fxiChgPct: 1.5, cnhChgPct: -0.5 } }));
  const b = E.decide(Object.assign({}, ctx, { ext: { spxChgPct: -1.2, vix: 15, fxiChgPct: -1.5, cnhChgPct: 0.5 } }));
  assert.strictEqual(a.factors.us.score, -b.factors.us.score);
  assert.strictEqual(a.factors.china.score, -b.factors.china.score);
});
// 3 · modifiers alone can never reach the trade threshold; the core alone can
t('context factors carry no weight: US+China maxed out with a flat core stays NO-TRADE; one validated HSI signal alone can trade', () => {
  const flat = []; for (let i = 0; i < 30; i++) flat.push({ d: '2026-01-' + String(i + 1).padStart(2, '0'), o: 25000, h: 25010, l: 24990, c: 25000 });
  const d = E.decide({ date: '2026-02-01', ohlc: flat, preOpen: 25000, ext: { spxChgPct: 3, vix: 12, fxiChgPct: 3, cnhChgPct: -1 }, calendar: [] });
  assert.strictEqual(d.dir, null); assert.ok(Math.abs(d.conviction) < E.BANDS.noTrade);
  // a 2.5-ATR drop on the last session: prevDay fires (−1 → fade → +1) and stretch fires (z < −2 → +1) → LONG
  const dn = flat.slice(); dn[dn.length - 1] = { d: dn[dn.length - 1].d, o: 25000, h: 25000, l: 24920, c: 24930 };
  const d2 = E.decide({ date: '2026-02-01', ohlc: dn, preOpen: 24930, ext: null, calendar: [] });
  assert.ok(d2.factors.prevDay.score > 0 && d2.factors.stretch.score > 0, JSON.stringify(d2.features)); assert.strictEqual(d2.dir, 'C');
});
// 4 · event risk changes size, never direction
t('rollover day → size 0, direction unchanged', () => {
  const ctx = { date: hist[40].d, ohlc: hist.slice(0, 40), preOpen: hist[40].o, ext: null };
  const a = E.decide(Object.assign({}, ctx, { calendar: [] }));
  const b = E.decide(Object.assign({}, ctx, { calendar: [{ date: hist[40].d, type: 'rollover' }] }));
  assert.strictEqual(a.dir, b.dir); assert.strictEqual(a.conviction, b.conviction);
  assert.strictEqual(b.size.multiplier, 0);
  if (b.dir) assert.strictEqual(E.plan(b, E.syntheticVehicle(b.dir, b.preOpen)).units, 0);
});
// 5 · vehicle rules: filters, ranking, week lock
t('vehicle selection applies all filters and honours the week lock', () => {
  const r = E.selectVehicle(warrants, 'P', '2026-09-18', null);
  assert.ok(r.vehicle, 'expected a put to pass on the 18 Sep universe');
  const v = r.vehicle;
  assert.strictEqual(v.type, 'P'); assert.ok(v.weeks >= E.VEHICLE.minWeeks); assert.ok(v.sens <= E.VEHICLE.maxSens);
  assert.ok(v.eg >= E.VEHICLE.egMin && v.eg <= E.VEHICLE.egMax);
  assert.ok((v.ask - v.bid) / v.ask * 100 <= E.VEHICLE.maxSpreadPct);
  const other = warrants.find(w => w.type === 'P' && w.sym !== v.sym && E.selectVehicle([w], 'P', '2026-09-18').vehicle);
  const locked = E.selectVehicle(warrants, 'P', '2026-09-18', other.sym);
  assert.strictEqual(locked.vehicle.sym, other.sym); assert.strictEqual(locked.locked, true);
  const stale = E.selectVehicle(warrants, 'P', '2026-09-18', 'HSI-PWT3'); // 1 week to expiry → lock must NOT hold
  assert.notStrictEqual(stale.vehicle.sym, 'HSI-PWT3');
});
// 6 · plan arithmetic: stop is the nearer of ATR and premium rule, R:R computed, units sized on the multiplier
t('plan: stop basis, target, units and P&L at stop/target', () => {
  const d = { dir: 'C', preOpen: 25000, lastClose: 24950, atr: 400, conviction: 4, size: { multiplier: 0.5, reasons: [] } };
  const v = { type: 'C', sym: 'X', bid: 0.295, ask: 0.30, sens: 30, eg: 11, theta: -0.5 };
  const p = E.plan(d, v);
  // premium stop: 15% of 0.30 = 0.045 = 9 ticks × 30 pts = 270 pts < 400 ATR → premium basis
  assert.strictEqual(p.stopPts, 270); assert.strictEqual(p.stopBasis, 'premium −15%');
  assert.strictEqual(p.stop, 24730); assert.strictEqual(p.target, 25600);
  assert.strictEqual(p.capitalRM, 2500); assert.strictEqual(p.units, Math.floor((2500 - 10) / (0.30 * 100)) * 100);
  assert.ok(p.winRM > 0 && p.lossRM < 0 && p.rr > 1);
  const put = E.plan(Object.assign({}, d, { dir: 'P' }), Object.assign({}, v, { type: 'P' }));
  assert.strictEqual(put.stop, 25270); assert.strictEqual(put.target, 24400);
  assert.ok(put.winRM > 0 && put.lossRM < 0, 'put plan must profit at its target and lose at its stop: ' + put.winRM + ' / ' + put.lossRM);
  assert.strictEqual(put.winRM, p.winRM); assert.strictEqual(put.lossRM, p.lossRM);   // mirror of the call plan
});
// 6b · puts are priced the right way round through the whole score path
t('put scoring: target → profit, stop → loss, symmetric with the call', () => {
  const dc = { date: '2026-01-02', dir: 'C', preOpen: 25000, lastClose: 25000, atr: 400, conviction: 4, size: { multiplier: 1, reasons: [] } };
  const dp = Object.assign({}, dc, { dir: 'P' });
  const vc = E.syntheticVehicle('C', 25000), vp = E.syntheticVehicle('P', 25000);
  const pc = E.plan(dc, vc), pp = E.plan(dp, vp);
  const upDays = [{ o: 25000, h: 25650, l: 24950, c: 25600 }], dnDays = [{ o: 25000, h: 25050, l: 24350, c: 24400 }];
  const callWin = E.score(dc, pc, vc, upDays), putWin = E.score(dp, pp, vp, dnDays);
  assert.strictEqual(callWin.outcome, 'TARGET'); assert.strictEqual(putWin.outcome, 'TARGET');
  assert.ok(putWin.pnlRM > 0, 'put at target must profit, got ' + putWin.pnlRM); assert.strictEqual(putWin.pnlRM, callWin.pnlRM);
  const putLoss = E.score(dp, pp, vp, upDays), callLoss = E.score(dc, pc, vc, dnDays);
  assert.strictEqual(putLoss.outcome, 'STOP'); assert.ok(putLoss.pnlRM < 0); assert.strictEqual(putLoss.pnlRM, callLoss.pnlRM);
  assert.strictEqual(putWin.dirCorrect, true); assert.strictEqual(putLoss.dirCorrect, false);
});
// 7 · scoring: stop-first when both touched; NO-TRADE never scored as a win; hit measured from decision price
t('scoring semantics', () => {
  const d = { date: '2026-01-02', dir: 'C', preOpen: 25000, lastClose: 24900, atr: 400, conviction: 4, size: { multiplier: 1, reasons: [] } };
  const v = E.syntheticVehicle('C', 25000); const p = E.plan(d, v);
  const both = E.score(d, p, v, [{ o: 25000, h: 26000, l: 24000, c: 25500 }]);
  assert.ok(both.outcome.startsWith('STOP')); assert.ok(both.pnlRM < 0);
  const tgt = E.score(d, p, v, [{ o: 25000, h: 25200, l: 24900, c: 25100 }, { o: 25100, h: 25700, l: 25050, c: 25600 }]);
  assert.strictEqual(tgt.outcome, 'TARGET'); assert.strictEqual(tgt.daysHeld, 2); assert.ok(tgt.pnlRM > 0);
  const time = E.score(d, p, v, [{ o: 25000, h: 25100, l: 24900, c: 25050 }, { o: 25050, h: 25100, l: 24950, c: 25000 }, { o: 25000, h: 25150, l: 24980, c: 25120 }]);
  assert.strictEqual(time.outcome, 'TIME'); assert.strictEqual(time.exitIdx, 25120);
  const open = E.score(d, p, v, [{ o: 25000, h: 25100, l: 24900, c: 25050 }]);
  assert.strictEqual(open.outcome, 'OPEN');
  const gapWin = E.score(Object.assign({}, d, { lastClose: 24000 }), p, v, [{ o: 25000, h: 25050, l: 24850, c: 24900 }, { o: 24900, h: 24950, l: 24800, c: 24850 }, { o: 24850, h: 24900, l: 24700, c: 24800 }]);
  assert.strictEqual(gapWin.dirCorrect, false, 'overnight gap must not count as a hit');
  const aside = E.score({ date: '2026-01-02', dir: null, conviction: 1, lastClose: 25000 }, null, null, [{ o: 25000, h: 25100, l: 24990, c: 25050 }]);
  assert.strictEqual(aside.kind, 'stood-aside'); assert.strictEqual(aside.pnlRM, undefined);
  const card = E.scorecard([{ decision: d, plan: p, vehicle: v, result: tgt }, { decision: { dir: null, conviction: 1 }, result: aside }]);
  assert.strictEqual(card.called.n, 1); assert.strictEqual(card.stoodAside.n, 1); assert.strictEqual(card.called.hits, 1);
});
// 8 · determinism and no reliance on wall clock
t('decide() is deterministic', () => {
  const ctx = { date: hist[50].d, ohlc: hist.slice(0, 50), preOpen: hist[50].o, ext: { spxChgPct: 0.3, vix: 18 }, calendar: cal };
  assert.deepStrictEqual(E.decide(ctx), E.decide(ctx));
});
console.log('\n' + n + ' tests passed');
