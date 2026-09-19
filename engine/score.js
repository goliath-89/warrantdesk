#!/usr/bin/env node
/* Evening run (16:35 MYT, GitHub Actions): score every decision whose hold window has (partly) elapsed,
   using actual HSI OHLC; for a time-stop exit on the run day, use the vehicle's live closing bid.
   Rebuilds data/scorecard.json. Run: node engine/score.js [--offline] [--date YYYY-MM-DD] */
'use strict';
const fs = require('fs'), path = require('path');
const E = require('./engine.js'), D = require('./data.js');
const ROOT = path.join(__dirname, '..'), DATA = path.join(ROOT, 'data'), DEC = path.join(DATA, 'decisions'), HIST = path.join(DATA, 'history');
const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OFFLINE = args.includes('--offline');
const rd = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };
const wr = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 1)); };
const todayMYT = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const log = m => console.log('[score] ' + m);

(async () => {
  const today = opt('--date', todayMYT());
  const hsiFile = rd(path.join(HIST, 'hsi.json'), { rows: [] });
  let rows = hsiFile.rows || [];
  if (!OFFLINE) {
    const fresh = await D.yahooDaily('^HSI', '1mo');
    if (fresh) { const m = new Map(rows.map(r => [r.d, r])); fresh.forEach(r => m.set(r.d, r)); rows = [...m.values()].sort((a, b) => a.d < b.d ? -1 : 1); wr(path.join(HIST, 'hsi.json'), Object.assign(hsiFile, { rows, updated: today })); }
  }
  const files = fs.existsSync(DEC) ? fs.readdirSync(DEC).filter(f => f.endsWith('.json')).sort() : [];
  let n = 0;
  for (const f of files) {
    const p = path.join(DEC, f), rec = rd(p, null); if (!rec || !rec.decision) continue;
    if (rec.result && rec.result.outcome !== 'OPEN' && rec.result.kind) continue;          // final
    const days = rows.filter(r => r.d >= rec.date).slice(0, E.RISK.holdDays);
    if (!days.length || days[0].d !== rec.date) continue;                                    // no actual for that date yet
    let closeBid = null;
    // HOLD days (an earlier position still open) are neither called nor stood-aside — record the index move only
    const prelim = rec.stance === 'HOLD' ? Object.assign(E.score(Object.assign({}, rec.decision, { dir: null }), null, null, days, null), { kind: 'hold', dir: rec.decision.dir }) : E.score(rec.decision, rec.plan, rec.vehicle, days, null);
    if (!OFFLINE && prelim.outcome === 'TIME' && prelim.exitDate === today && rec.vehicle && rec.vehicle.ric) {
      const q = await D.mqMatrix(rec.vehicle.ric); if (q && q.bid) closeBid = q.bid;
    }
    rec.result = closeBid ? E.score(rec.decision, rec.plan, rec.vehicle, days, closeBid) : prelim;
    rec.scoredAt = new Date().toISOString();
    wr(p, rec); n++;
    log(rec.date + ' → ' + (rec.result.kind === 'called' ? rec.result.outcome + ' ' + (rec.result.pnlRM != null ? 'RM' + rec.result.pnlRM : '') : 'stood aside, HSI ' + rec.result.hsiChgOpenClosePct + '%'));
  }
  // ---- scorecard (all decisions with results)
  const recs = files.map(f => rd(path.join(DEC, f), null)).filter(r => r && r.decision && r.result);
  const card = E.scorecard(recs);
  card.updatedAt = new Date().toISOString();
  card.backfilled = recs.filter(r => r.backfill).length; card.live = recs.filter(r => !r.backfill).length;
  card.history = recs.slice().reverse().map(r => ({ date: r.date, backfill: !!r.backfill, stance: r.stance, dir: r.decision.dir, label: r.decision.label, conviction: r.decision.conviction, vehicle: r.vehicle ? r.vehicle.sym : null,
    entry: r.plan ? r.plan.entry : null, stop: r.plan ? r.plan.stop : null, target: r.plan ? r.plan.target : null, units: r.plan ? r.plan.units : null,
    outcome: r.result.outcome || r.result.kind, exitDate: r.result.exitDate || null, daysHeld: r.result.daysHeld || null, pnlRM: r.result.pnlRM ?? null, pnlPct: r.result.pnlPct ?? null,
    hsiOpenClosePct: r.result.hsiChgOpenClosePct, dirCorrect: r.result.dirCorrect ?? null, estimated: r.result.exitEstimated ?? null }));
  wr(path.join(DATA, 'scorecard.json'), card);
  // keep latest.json's result in sync
  const latest = rd(path.join(DATA, 'latest.json'), null);
  if (latest) { const same = recs.find(r => r.date === latest.date); if (same) { latest.result = same.result; wr(path.join(DATA, 'latest.json'), latest); } }
  log('scored ' + n + ' · scorecard: ' + card.called.n + ' called, ' + card.called.hits + ' hits, RM' + card.called.pnlRM + ', ' + card.stoodAside.n + ' stood aside');
  D.errors.forEach(e => log('  ! ' + e));
})().catch(e => { console.error(e); process.exit(1); });
