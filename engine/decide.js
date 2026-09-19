#!/usr/bin/env node
/* Morning run (08:45 MYT, GitHub Actions): fetch inputs → decide → select vehicle → plan → write
     data/decisions/<date>.json, data/latest.json, data/history/{hsi,ext}.json
   The browser app only READS these files. Run it by hand with:
     node engine/decide.js                      # today (MYT), live data
     node engine/decide.js --date 2026-09-18    # a specific date, live data
     node engine/decide.js --offline            # no network: data/history + warrants-sample (for testing the app) */
'use strict';
const fs = require('fs'), path = require('path');
const E = require('./engine.js'), D = require('./data.js');
const ROOT = path.join(__dirname, '..'), DATA = path.join(ROOT, 'data'), DEC = path.join(DATA, 'decisions'), HIST = path.join(DATA, 'history');
const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OFFLINE = args.includes('--offline'), FORCE = args.includes('--force');
const rd = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };
const wr = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 1)); };
const todayMYT = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const log = m => console.log('[decide] ' + m);

(async () => {
  const date = opt('--date', todayMYT());
  const dow = new Date(date + 'T12:00:00Z').getUTCDay();
  // ---- inputs
  const hsiFile = rd(path.join(HIST, 'hsi.json'), { rows: [] });
  let rows = hsiFile.rows || [];
  let calendar = rd(path.join(HIST, 'calendar.json'), []);
  let warrants = null, live = null, ext = null;
  const sources = {};
  if (!OFFLINE) {
    const fresh = await D.yahooDaily('^HSI', '1y');
    if (fresh) { const m = new Map(rows.map(r => [r.d, r])); fresh.forEach(r => m.set(r.d, r)); rows = [...m.values()].sort((a, b) => a.d < b.d ? -1 : 1); sources.hsi = 'yahoo ^HSI (merged into data/history/hsi.json)'; }
    else sources.hsi = 'data/history/hsi.json (Yahoo unavailable)';
    const cal = await D.mqCalendar(); if (cal) { calendar = cal; wr(path.join(HIST, 'calendar.json'), cal); sources.calendar = 'macquarie'; }
    live = await D.mqIndex(); sources.preOpen = live ? live.source : 'last close (LiveIndexJSON unavailable → gap = 0)';
    warrants = await D.mqUniverse(); sources.warrants = warrants ? 'macquarie ScreenerJSONServlet (' + warrants.length + ')' : 'unavailable';
    ext = await D.externals(date); sources.ext = ext;
  } else {
    warrants = rd(path.join(HIST, 'warrants-sample.json'), { rows: null }).rows; sources.note = 'OFFLINE: history + warrants-sample.json';
    const ex = rd(path.join(HIST, 'ext.json'), { rows: {} }).rows || {}; ext = ex[date] || null;
  }
  wr(path.join(HIST, 'hsi.json'), { symbol: '^HSI', source: 'Yahoo Finance daily (merged by engine/decide.js)', updated: date, rows });
  if (ext && !OFFLINE) { const exf = rd(path.join(HIST, 'ext.json'), { rows: {} }); exf.rows = exf.rows || {}; exf.rows[date] = ext; wr(path.join(HIST, 'ext.json'), exf); }

  const isHoliday = calendar.some(e => e.type === 'holiday' && e.date === date);
  if ((dow === 0 || dow === 6 || isHoliday) && !FORCE) { log(date + ' is not an HK trading day — nothing to decide'); return; }
  const completed = rows.filter(r => r.d < date);
  const lastClose = completed.length ? completed[completed.length - 1].c : null;
  const todayRow = rows.find(r => r.d === date);
  const preOpen = live && live.px ? live.px : (OFFLINE && todayRow ? todayRow.o : lastClose);
  if (OFFLINE && todayRow) sources.preOpen = 'OFFLINE: actual cash open used as pre-open level';

  // ---- decide
  const decision = E.decide({ date, ohlc: completed, preOpen, ext, calendar });
  // ---- open position from an earlier decision inside its hold window? then no new entry today
  const prior = fs.existsSync(DEC) ? fs.readdirSync(DEC).filter(f => f.endsWith('.json') && f < date + '.json').sort().slice(-E.RISK.holdDays).map(f => rd(path.join(DEC, f), null)).filter(Boolean) : [];
  const openPos = prior.find(p => p.plan && p.plan.units > 0 && (!p.result || p.result.outcome === 'OPEN') && completed.filter(r => r.d >= p.decision.date).length < E.RISK.holdDays);
  // ---- vehicle (locked for the week if an earlier decision this week picked one in the same direction)
  const wk = E.mondayOf(date);
  const lockRec = prior.slice().reverse().find(p => p.decision && p.decision.dir === decision.dir && p.vehicle && E.mondayOf(p.decision.date) === wk);
  const sel = E.selectVehicle(warrants || [], decision.dir, date, lockRec ? lockRec.vehicle.sym : null);
  if (sel.vehicle && warrants) { const w = warrants.find(x => x.sym === sel.vehicle.sym); if (w && w.ric) sel.vehicle.ric = w.ric; }
  const plan = openPos ? null : E.plan(decision, sel.vehicle);
  const rec = { generatedAt: new Date().toISOString(), engine: E.VERSION, date, backfill: OFFLINE, decision, vehicle: sel.vehicle, vehicleSelection: { reasons: sel.reasons, locked: !!sel.locked, candidates: sel.candidates, rejected: (sel.rejected || []).slice(0, 12) },
    plan, ext, sources, inputErrors: D.errors.slice(),
    openPosition: openPos ? { from: openPos.decision.date, dir: openPos.decision.dir, vehicle: openPos.vehicle && openPos.vehicle.sym, plan: openPos.plan, note: 'position opened ' + openPos.decision.date + ' is still inside its ' + E.RISK.holdDays + '-session window — manage it per its plan; no new entry today' } : null,
    stance: openPos ? 'HOLD' : decision.dir ? (plan && plan.units ? 'ENTER' : 'STAND ASIDE') : 'STAND ASIDE' };
  wr(path.join(DEC, date + '.json'), rec);
  wr(path.join(DATA, 'latest.json'), rec);
  log(date + ' → ' + decision.label + ' (' + decision.conviction + ') · stance ' + rec.stance + (sel.vehicle ? ' · ' + sel.vehicle.sym : '') + (plan ? ' · entry ' + plan.entry + ' stop ' + plan.stop + ' target ' + plan.target + ' units ' + plan.units : '') + (D.errors.length ? ' · input errors: ' + D.errors.length : ''));
  D.errors.forEach(e => log('  ! ' + e));
})().catch(e => { console.error(e); process.exit(1); });
