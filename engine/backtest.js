#!/usr/bin/env node
/* Backtest harness — replays the v3 engine (multi-session hold) AND the v2.4.0 baseline (1 day) over the same daily history.
   Pre-open futures level is approximated by the cash open. Vehicle is a synthetic 11× warrant
   (P&L ≈ 11 × index %, 1-tick spread, 0.5%/day theta) so both engines are judged on the same terms.

   node engine/backtest.js                 # report both engines
   node engine/backtest.js --gate          # exit 1 unless v3 beats the baseline on paper P&L AND hit rate
   node engine/backtest.js --history data/history/hsi.json --ext data/history/ext.json --from 2026-07-13
   --ext: optional {"YYYY-MM-DD":{spxChgPct,vix,fxiChgPct,cnhChgPct}} keyed by HSI decision date (values as known pre-open). */
'use strict';
const fs = require('fs'), path = require('path');
const E = require('./engine.js'), L = require('./legacy_v24.js');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ROOT = path.join(__dirname, '..');
const hist = JSON.parse(fs.readFileSync(opt('--history', path.join(ROOT, 'data/history/hsi.json')), 'utf8')).rows;
const cal = fs.existsSync(path.join(ROOT, 'data/history/calendar.json')) ? JSON.parse(fs.readFileSync(path.join(ROOT, 'data/history/calendar.json'), 'utf8')) : [];
const extPath = opt('--ext', path.join(ROOT, 'data/history/ext.json'));
const extRaw = fs.existsSync(extPath) ? JSON.parse(fs.readFileSync(extPath, 'utf8')) : {}; const ext = extRaw.rows || extRaw;
const from = opt('--from', null), to = opt('--to', null);
const CAP = E.RISK.capital, BRK = E.RISK.brokerage;
const OV = {}; ['stopATR','targetATR','holdDays','premiumStopPct'].forEach(k => { const v = opt('--' + k.replace('ATR','').replace('Days','').replace('iumStopPct','').toLowerCase(), null); if (v != null) OV[k] = +v; });
const HOLD = OV.holdDays || E.RISK.holdDays;

const v3 = [], v2 = [];
for (let i = 16; i < hist.length; i++) {
  if (i + HOLD > hist.length) break;   // v3 needs the full hold window to score
  const day = hist[i];
  if (from && day.d < from) continue; if (to && day.d > to) continue;
  const ohlc = hist.slice(0, i), preOpen = day.o, x = ext[day.d] || null;
  // ---- v3
  const d3 = E.decide({ date: day.d, ohlc, preOpen, ext: x, calendar: cal });
  const veh = d3.dir ? E.syntheticVehicle(d3.dir, preOpen) : null;
  const p3 = E.plan(d3, veh, OV);
  v3.push({ decision: d3, plan: p3, vehicle: veh, result: E.score(d3, p3, veh, hist.slice(i, i + HOLD)) });
  // ---- v2.4.0 baseline (us from ext if present, else 0; keyword factors 0 as observed)
  const us = x && x.spxChgPct != null ? (x.spxChgPct > 1 ? 2 : x.spxChgPct > 0.2 ? 1 : x.spxChgPct < -1 ? -2 : x.spxChgPct < -0.2 ? -1 : 0) : 0;
  const d2 = L.decide({ date: day.d, ohlc, preOpen, calendar: cal, fixed: { us } });
  const veh2 = d2.dir ? E.syntheticVehicle(d2.dir, preOpen) : null;
  const units2 = veh2 ? Math.floor((CAP - BRK) / (veh2.ask * E.LOT)) * E.LOT : 0;
  v2.push({ decision: d2, result: L.score(d2, day, veh2, units2, BRK, E.warrantAt) });
}
const S3 = E.scorecard(v3);
function legacyCard(recs) {
  const called = recs.filter(r => r.result.kind === 'called');
  const traded = called.filter(r => r.result.outcome !== 'no fill' && r.result.outcome !== 'no level');
  const pnl = traded.map(r => r.result.pnlRM);
  return { tradingDays: recs.length, called: { n: called.length, hits: called.filter(r => r.result.dirCorrect).length, filled: traded.length, winners: pnl.filter(x => x > 0).length, pnlRM: pnl.reduce((a, b) => a + b, 0) },
    noTrade: recs.length - called.length, outcomes: called.reduce((m, r) => { m[r.result.outcome] = (m[r.result.outcome] || 0) + 1; return m; }, {}) };
}
const S2 = legacyCard(v2);
const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '–';

if (args.includes('--verbose')) {
  console.log('date        v3 call   conv   v2 call   conv   HSI o→c%   v3 outcome  v3 P&L');
  v3.forEach((r, i) => { const q = v2[i]; console.log(r.decision.date + '  ' + (r.decision.label || '').padEnd(12) + String(r.decision.conviction).padStart(5) + '   ' + (q.decision.dir === 'C' ? 'LONG' : q.decision.dir === 'P' ? 'SHORT' : 'NO-TRADE').padEnd(9) + String(q.decision.conviction).padStart(5) + '   ' + String(r.result.hsiChgOpenClosePct).padStart(6) + '   ' + (r.result.outcome || '').padEnd(12) + (r.result.pnlRM != null ? 'RM' + r.result.pnlRM : '')); });
  console.log('');
}
console.log('Period ' + v3[0].decision.date + ' → ' + v3[v3.length - 1].decision.date + ' · ' + v3.length + ' trading days · synthetic 11× vehicle, RM' + CAP + ' per trade' + (Object.keys(ext).length ? ' · external modifiers from ' + path.basename(extPath) : ' · external modifiers NEUTRAL (no ext file)'));
console.log('');
console.log('                         v2.4.0 baseline        v3 engine');
console.log('Called days              ' + String(S2.called.n).padEnd(24) + S3.called.n + '  (LONG ' + S3.byDir.LONG.n + ' / SHORT ' + S3.byDir.SHORT.n + ')');
console.log('Stood aside              ' + String(S2.noTrade).padEnd(24) + S3.stoodAside.n + '  (missed ≥1% moves: ' + S3.stoodAside.bigMovesMissed + ')');
console.log('Direction hit (o→c)      ' + (S2.called.hits + '/' + S2.called.n + ' = ' + pct(S2.called.hits, S2.called.n)).padEnd(24) + S3.called.hits + '/' + S3.called.n + ' = ' + pct(S3.called.hits, S3.called.n));
console.log('Trades actually taken    ' + (S2.called.filled + ' (pullback fills)').padEnd(24) + S3.called.n + ' (at open, ≤' + HOLD + ' sessions, stop ' + (OV.stopATR||E.RISK.stopATR) + '×ATR, target ' + (OV.targetATR||E.RISK.targetATR) + '×ATR)');
console.log('Winning trades           ' + String(S2.called.winners).padEnd(24) + S3.called.winners);
console.log('Paper P&L                ' + ('RM' + S2.called.pnlRM).padEnd(24) + 'RM' + S3.called.pnlRM + '  (avg RM' + S3.called.avgRM + '/trade, payoff ' + (S3.payoff ?? '–') + ', max DD RM' + S3.maxDrawdownRM + ')');
console.log('Outcomes                 ' + JSON.stringify(S2.outcomes).padEnd(24) + JSON.stringify(S3.outcomes));
console.log('By conviction band (v3)  ' + Object.entries(S3.byBand).map(([b, a]) => b + ': ' + a.n + 'd ' + pct(a.hits, a.n) + ' RM' + a.pnlRM).join(' · '));
console.log('');
// legacy P&L is on filled trades only; compare on the honest basis: total paper P&L and hit rate on called days
const better = S3.called.pnlRM > S2.called.pnlRM && (S3.called.n === 0 || S3.called.hits / S3.called.n >= (S2.called.n ? S2.called.hits / S2.called.n : 0));
console.log(better ? 'GATE: v3 beats the v2.4.0 baseline on this history.' : 'GATE: v3 does NOT beat the baseline on this history.');
if (args.includes('--json')) fs.writeFileSync(opt('--json', 'backtest.json') === '--json' ? 'backtest.json' : opt('--json'), JSON.stringify({ period: [v3[0].decision.date, v3[v3.length - 1].decision.date], baseline: S2, v3: S3 }, null, 1));
if (args.includes('--gate') && !better) process.exit(1);
