/* Warrant Desk engine v3 — one pure module, shared by the GitHub Actions pipeline,
   the backtest harness and the browser app. No I/O, no globals, no Date.now().

   WHY THIS SHAPE (engine/diagnose.js over 2y of HSI, both halves separately):
   - Following 5-day momentum LOST in both halves at 1–5 day horizons. The v2.4.0 "tech" factor was this.
   - What held in BOTH halves is contrarian at a 1–3 session horizon:
       stretch  : close > 2 ATR from its 10d mean → fade          (65%/60% 1d, 60%/70% 5d)
       prevDay  : prior close-to-close move > 1 ATR → fade        (67%/63% 1d)
       gap      : opening gap > 0.5 ATR → fade over 3 sessions    (59%/57% 3d)
       fear     : VIX > 25 → long over 3–5 sessions               (65%/75% 3d, 94%/69% 5d)
   - S&P direction, FXI direction and 20-day momentum showed no consistent edge → context only (weight 0).
   - Every HSI-native scorer is an odd function → a mirrored price series gives a mirrored call (tested).
   - Event risk never votes on direction; it only sets the size multiplier (1 / 0.5 / 0).
   - Plan: entry at the pre-open futures level, stop = nearer of 1×ATR(10) or −15% premium, target 1.5×ATR,
     time-stop at the 3rd close. Vehicle by fixed rules, locked for the week.
   - Scoring: paper P&L from decision price to exit on called days only. NO-TRADE days are recorded, never scored as wins. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WDEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const VERSION = '3.0.0';
  const TICK = 0.005, LOT = 100;
  const WEIGHTS = { stretch: 35, prevDay: 25, gap: 20, fear: 20, us: 0, china: 0 };
  const LABELS = { stretch: 'Stretch vs 10d mean (fade)', prevDay: 'Prior-day move (fade)', gap: 'Opening gap (fade)', fear: 'Fear (VIX) — buy panic', us: 'US context (no weight)', china: 'China context (no weight)' };
  const BANDS = { noTrade: 1.5, full: 4 };        // ±10 scale: one validated signal at its base threshold ≈ 1.75–2.5 → trade; two agreeing → full
  const VEHICLE = { minWeeks: 4, maxSens: 40, maxSpreadPct: 1.5, egMin: 8, egMax: 14 };
  const RISK = { atrLen: 10, stopATR: 1.0, targetATR: 1.5, premiumStopPct: 15, holdDays: 3, capital: 5000, brokerage: 10 };

  const sign = x => (x > 0 ? 1 : x < 0 ? -1 : 0);
  const rS = (x, p) => sign(x) * Math.round(Math.abs(x) * p) / p;   // symmetric rounding: f(−x) = −f(x) exactly
  const r2 = x => rS(x, 100);
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;

  // ---------- features ----------
  function atr(rows, n) {
    n = n || RISK.atrLen;
    if (rows.length < n + 1) return null;
    let s = 0;
    for (let i = rows.length - n; i < rows.length; i++) {
      const r = rows[i], pc = rows[i - 1].c;
      s += Math.max(r.h - r.l, Math.abs(r.h - pc), Math.abs(r.l - pc));
    }
    return s / n;
  }
  /* ctx = { date:'YYYY-MM-DD', ohlc:[completed sessions, oldest first, EXCLUDING today], preOpen:number,
            ext:{ spxChgPct, vix, fxiChgPct, cnhChgPct } | null, calendar:[{date,type}] } */
  function features(ctx) {
    const rows = ctx.ohlc;
    if (!rows || rows.length < 16) return null;
    const c = rows.map(r => r.c), n = c.length;
    const a = atr(rows);
    if (!a) return null;
    return {
      atr: r2(a), lastClose: c[n - 1],
      z: r2((c[n - 1] - avg(c.slice(-10))) / a),   // stretch from 10d mean, ATR units
      prev: r2((c[n - 1] - c[n - 2]) / a),          // prior close-to-close move, ATR units
      gap: ctx.preOpen ? r2((ctx.preOpen - c[n - 1]) / a) : 0,
      mom: r2((c[n - 1] - c[n - 6]) / a),           // shown as context only
    };
  }

  // ---------- factors ----------
  const fmtA = x => (x >= 0 ? '+' : '') + x + ' ATR';
  function fStretch(F) {
    const z = F.z; const s = -sign(z) * (Math.abs(z) > 3 ? 2 : Math.abs(z) > 2 ? 1 : 0);
    return { score: s, ev: ['close ' + fmtA(z) + ' from 10d mean' + (s ? ' → stretched, fade it' : ' → normal range')] };
  }
  function fPrevDay(F) {
    const p = F.prev; const s = -sign(p) * (Math.abs(p) > 2 ? 2 : Math.abs(p) > 1 ? 1 : 0);
    return { score: s, ev: ['prior session ' + fmtA(p) + (s ? ' → outsized, fade it' : ' → ordinary')] };
  }
  function fGap(F) {
    const g = F.gap; const s = -sign(g) * (Math.abs(g) > 1 ? 2 : Math.abs(g) > 0.5 ? 1 : 0);
    return { score: s, ev: ['opening gap ' + fmtA(g) + (s ? ' → fade over the hold' : ' → negligible')] };
  }
  function fFear(ext) {
    if (!ext || ext.vix == null) return { score: 0, ev: ['no VIX data → neutral'], missing: true };
    const v = ext.vix; const s = v > 30 ? 2 : v > 25 ? 1 : 0;
    return { score: s, ev: ['VIX ' + r2(v) + (s ? ' → panic regime, lean long over the hold' : ' → calm')] };
  }
  function fUS(ext) {
    if (!ext || ext.spxChgPct == null) return { score: 0, ev: ['no US data'], missing: true };
    const c = ext.spxChgPct; return { score: c > 0.5 ? 1 : c < -0.5 ? -1 : 0, ev: ['S&P 500 ' + (c >= 0 ? '+' : '') + r2(c) + '% (context only — no consistent edge in the 2y test)'] };
  }
  function fChina(ext) {
    if (!ext || (ext.fxiChgPct == null && ext.cnhChgPct == null)) return { score: 0, ev: ['no China data'], missing: true };
    let s = 0; const ev = [];
    if (ext.fxiChgPct != null) { s += ext.fxiChgPct > 0.75 ? 1 : ext.fxiChgPct < -0.75 ? -1 : 0; ev.push('FXI ' + (ext.fxiChgPct >= 0 ? '+' : '') + r2(ext.fxiChgPct) + '%'); }
    if (ext.cnhChgPct != null) { s += ext.cnhChgPct > 0.3 ? -1 : ext.cnhChgPct < -0.3 ? 1 : 0; ev.push('USDCNY ' + (ext.cnhChgPct >= 0 ? '+' : '') + r2(ext.cnhChgPct) + '%'); }
    ev.push('context only — no consistent edge in the 2y test');
    return { score: clamp(s, -1, 1), ev };
  }

  function conviction(scores) {
    let s = 0, tw = 0;
    Object.keys(WEIGHTS).forEach(k => { s += ((scores[k] || 0) / 2) * WEIGHTS[k]; tw += WEIGHTS[k]; });
    return rS((s / tw) * 10, 10);                    // ±10 scale, one decimal, symmetric
  }

  // ---------- event risk → size multiplier (never direction) ----------
  function daysBetween(a, b) { return (new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5; }
  function sizeMultiplier(ctx, conv) {
    let m = Math.abs(conv) >= BANDS.full ? 1 : 0.5;
    const reasons = [Math.abs(conv) >= BANDS.full ? 'two or more signals agree → full size' : 'single signal → half size'];
    (ctx.calendar || []).forEach(e => {
      const d = daysBetween(ctx.date, e.date);
      if (e.type === 'rollover' && d >= 0 && d <= 1) { m = 0; reasons.push('HSI futures rollover ' + e.date + ' → no new entries'); }
      if (e.type === 'holiday' && d >= 1 && d <= 1.5) { m = Math.min(m, 0.5); reasons.push('HK holiday tomorrow → half size'); }
    });
    return { multiplier: m, reasons };
  }

  // ---------- decision ----------
  function decide(ctx) {
    const F = features(ctx);
    if (!F) return { version: VERSION, date: ctx.date, dir: null, conviction: 0, error: 'need ≥16 completed sessions', factors: {}, size: { multiplier: 0, reasons: ['insufficient history'] }, label: 'NO-TRADE' };
    const raw = { stretch: fStretch(F), prevDay: fPrevDay(F), gap: fGap(F), fear: fFear(ctx.ext), us: fUS(ctx.ext), china: fChina(ctx.ext) };
    const scores = {}, factors = {};
    Object.keys(raw).forEach(k => { scores[k] = raw[k].score; factors[k] = { label: LABELS[k], score: raw[k].score, weight: WEIGHTS[k], evidence: raw[k].ev, missing: !!raw[k].missing }; });
    const conv = conviction(scores);
    const dir = Math.abs(conv) < BANDS.noTrade ? null : conv > 0 ? 'C' : 'P';
    const size = sizeMultiplier(ctx, conv);
    return { version: VERSION, date: ctx.date, preOpen: ctx.preOpen || null, lastClose: F.lastClose, atr: F.atr, features: F, factors, conviction: conv, dir, size,
      holdDays: RISK.holdDays, label: dir === 'C' ? 'LONG · CALLS' : dir === 'P' ? 'SHORT · PUTS' : 'NO-TRADE' };
  }

  // ---------- vehicle selection ----------
  function weeksTo(expiryISO, dateISO) { if (!expiryISO) return 0; return daysBetween(dateISO, expiryISO) / 7; }
  function spreadPct(w) { const a = w.ask || (w.bid != null ? w.bid + TICK : null); if (!a || w.bid == null) return null; return (a - w.bid) / a * 100; }
  function passes(w, dir, dateISO) {
    const rs = [];
    if (w.type !== dir) return null;
    const wk = weeksTo(w.expiry, dateISO), sp = spreadPct(w);
    if (!(w.bid > 0) || !w.eg || !w.sens) rs.push('no usable quote/terms');
    if (wk < VEHICLE.minWeeks) rs.push('only ' + wk.toFixed(1) + ' wks to expiry');
    if (w.sens > VEHICLE.maxSens) rs.push('sensitivity ' + w.sens + ' > ' + VEHICLE.maxSens);
    if (sp == null || sp > VEHICLE.maxSpreadPct) rs.push('spread ' + (sp == null ? '?' : sp.toFixed(1)) + '% > ' + VEHICLE.maxSpreadPct + '%');
    if (w.eg < VEHICLE.egMin || w.eg > VEHICLE.egMax) rs.push('gearing ' + w.eg + 'x outside ' + VEHICLE.egMin + '–' + VEHICLE.egMax + 'x');
    return rs;
  }
  /* returns {vehicle, reasons, locked, candidates, rejected:[{sym,why}]} — lockedSym is this week's earlier pick in the same direction */
  function selectVehicle(warrants, dir, dateISO, lockedSym) {
    if (!dir) return { vehicle: null, reasons: ['no direction'], candidates: 0, rejected: [] };
    const ok = [], rejected = [];
    (warrants || []).forEach(w => { const rs = passes(w, dir, dateISO); if (rs === null) return; if (rs.length) rejected.push({ sym: w.sym, why: rs.join('; ') }); else ok.push(w); });
    if (lockedSym) { const L = ok.find(w => w.sym === lockedSym); if (L) return { vehicle: pack(L, dateISO), reasons: ['locked for the week (chosen earlier this week, still passes all filters)'], locked: true, candidates: ok.length, rejected }; }
    if (!ok.length) return { vehicle: null, reasons: ['no ' + (dir === 'C' ? 'call' : 'put') + ' passes: ≥' + VEHICLE.minWeeks + ' wks, sens ≤' + VEHICLE.maxSens + ', spread ≤' + VEHICLE.maxSpreadPct + '%, gearing ' + VEHICLE.egMin + '–' + VEHICLE.egMax + 'x'], candidates: 0, rejected };
    ok.sort((a, b) => (a.sens - b.sens) || (spreadPct(a) - spreadPct(b)) || (weeksTo(b.expiry, dateISO) - weeksTo(a.expiry, dateISO)));
    const v = ok[0];
    return { vehicle: pack(v, dateISO), reasons: ['most responsive of ' + ok.length + ' passing ' + (dir === 'C' ? 'calls' : 'puts') + ' (sens ' + v.sens + ', spread ' + spreadPct(v).toFixed(1) + '%, ' + weeksTo(v.expiry, dateISO).toFixed(1) + ' wks, ' + v.eg + 'x)'], locked: false, candidates: ok.length, rejected };
  }
  function pack(w, dateISO) { return { sym: w.sym, code: w.code || '', type: w.type, strike: w.strike, expiry: w.expiry, bid: w.bid, ask: w.ask || +(w.bid + TICK).toFixed(3), eg: w.eg, sens: w.sens, theta: w.theta == null ? -0.5 : w.theta, iv: w.iv || null, weeks: r2(weeksTo(w.expiry, dateISO)) }; }

  // ---------- warrant pricing (issuer-matrix linear sensitivity) ----------
  function warrantAt(v, refBid, dIdx, days) {
    const dirn = v.type === 'C' ? 1 : -1;
    let px = refBid + dirn * (dIdx / v.sens) * TICK;
    px -= Math.abs(v.theta || 0.5) / 100 * refBid * Math.max(0, days || 0);
    return Math.max(TICK, Math.floor(px / TICK + 1e-9) * TICK);
  }

  // ---------- plan ----------
  function plan(decision, vehicle, opts) {
    const R = Object.assign({}, RISK, opts || {});
    if (!decision.dir || !vehicle) return null;
    const isC = decision.dir === 'C', dirn = isC ? 1 : -1;
    const entry = decision.preOpen || decision.lastClose, atrPts = decision.atr;
    const atrStopPts = R.stopATR * atrPts;
    const premStopPts = (R.premiumStopPct / 100) * vehicle.ask / TICK * vehicle.sens;
    const stopPts = Math.min(atrStopPts, premStopPts);
    const stop = Math.round(entry - dirn * stopPts), target = Math.round(entry + dirn * R.targetATR * atrPts);
    const cap = R.capital * (decision.size.multiplier || 0), brk = R.brokerage;
    const units = cap > 0 ? Math.floor((cap - brk) / (vehicle.ask * LOT)) * LOT : 0;
    // warrantAt() applies the warrant's own direction — pass the RAW index change, never pre-signed
    const exitAtTarget = warrantAt(vehicle, vehicle.bid, target - entry, R.holdDays);
    const exitAtStop = warrantAt(vehicle, vehicle.bid, stop - entry, 1);
    const winRM = units ? Math.round(units * (exitAtTarget - vehicle.ask) - 2 * brk) : 0;
    const lossRM = units ? Math.round(units * (exitAtStop - vehicle.ask) - 2 * brk) : 0;
    return { entry: Math.round(entry), stop, target, stopPts: Math.round(stopPts), stopBasis: premStopPts < atrStopPts ? 'premium −' + R.premiumStopPct + '%' : R.stopATR + '×ATR', targetPts: Math.round(R.targetATR * atrPts),
      holdDays: R.holdDays, units, capitalRM: Math.round(cap), buyAt: vehicle.ask, exitAtTarget, exitAtStop, winRM, lossRM, rr: lossRM < 0 ? r2(winRM / -lossRM) : null,
      timeStop: 'flat at the close of session ' + R.holdDays + ' at the latest', note: units ? null : 'size multiplier 0 → no new entries today' };
  }

  // ---------- scoring ----------
  /* days = [{o,h,l,c}, ...] starting with the decision date, up to holdDays sessions (fewer if not yet elapsed).
     closeBid optional: actual bid of the vehicle at the final exit. Conservative: stop counted first when both touched. */
  function score(decision, planObj, vehicle, days, closeBid) {
    const d0 = days[0];
    const out = { date: decision.date, dir: decision.dir, conviction: decision.conviction, hsiOpen: d0.o, hsiClose: d0.c, hsiChgOpenClosePct: r2((d0.c - d0.o) / d0.o * 100), hsiChgPrevClosePct: decision.lastClose ? r2((d0.c - decision.lastClose) / decision.lastClose * 100) : null };
    if (!decision.dir) { out.kind = 'stood-aside'; return out; }
    out.kind = 'called';
    const isC = decision.dir === 'C', dirn = isC ? 1 : -1;
    if (!planObj || !vehicle || !planObj.units) { out.outcome = 'not sized'; out.pnlRM = 0; out.dirCorrect = isC ? d0.c > decision.preOpen : d0.c < decision.preOpen; return out; }
    const entry = planObj.entry, hold = Math.min(days.length, planObj.holdDays || RISK.holdDays);
    let exitIdx = null, outcome = null, daysHeld = hold;
    for (let k = 0; k < hold; k++) {
      const d = days[k];
      const stopHit = isC ? d.l <= planObj.stop : d.h >= planObj.stop;
      const tgtHit = isC ? d.h >= planObj.target : d.l <= planObj.target;
      if (stopHit) { outcome = tgtHit ? 'STOP (both touched, stop assumed first)' : 'STOP'; exitIdx = planObj.stop; daysHeld = k + 1; break; }
      if (tgtHit) { outcome = 'TARGET'; exitIdx = planObj.target; daysHeld = k + 1; break; }
    }
    if (outcome == null) { exitIdx = days[hold - 1].c; outcome = hold >= (planObj.holdDays || RISK.holdDays) ? 'TIME' : 'OPEN'; }
    out.exitDate = days[daysHeld - 1].d || null;
    let exitPx = warrantAt(vehicle, vehicle.bid, exitIdx - entry, daysHeld), est = true;   // raw index change; warrantAt applies direction
    if ((outcome === 'TIME' || outcome === 'OPEN') && closeBid > 0) { exitPx = closeBid; est = false; }
    out.dirCorrect = dirn * (exitIdx - entry) > 0;
    out.outcome = outcome; out.daysHeld = daysHeld; out.exitIdx = exitIdx; out.exitPx = exitPx; out.exitEstimated = est;
    out.pnlRM = Math.round(planObj.units * (exitPx - planObj.buyAt) - 2 * RISK.brokerage);
    out.pnlPct = r2((exitPx - planObj.buyAt) / planObj.buyAt * 100);
    return out;
  }

  function band(c) { const a = Math.abs(c); return a < BANDS.full ? 'single signal' : a < 6 ? 'two signals' : 'three+'; }
  /* records = [{decision, plan, vehicle, result}] */
  function scorecard(records) {
    const called = records.filter(r => r.result && r.result.kind === 'called' && r.result.outcome && r.result.outcome !== 'not sized' && r.result.outcome !== 'OPEN');
    const open = records.filter(r => r.result && r.result.outcome === 'OPEN');
    const aside = records.filter(r => r.result && r.result.kind === 'stood-aside');
    const sum = a => a.reduce((x, y) => x + y, 0);
    const pnl = called.map(r => r.result.pnlRM);
    const agg = list => { const p = list.map(r => r.result.pnlRM); return { n: list.length, hits: list.filter(r => r.result.dirCorrect).length, winners: p.filter(x => x > 0).length, pnlRM: sum(p), avgRM: list.length ? Math.round(sum(p) / list.length) : 0 }; };
    const byBand = {}; ['single signal', 'two signals', 'three+'].forEach(b => byBand[b] = agg(called.filter(r => band(r.decision.conviction) === b)));
    const byDir = { LONG: agg(called.filter(r => r.decision.dir === 'C')), SHORT: agg(called.filter(r => r.decision.dir === 'P')) };
    let peak = 0, eq = 0, mdd = 0; pnl.forEach(x => { eq += x; peak = Math.max(peak, eq); mdd = Math.min(mdd, eq - peak); });
    const wins = pnl.filter(x => x > 0), losses = pnl.filter(x => x <= 0);
    return { version: VERSION, tradingDays: records.length, called: agg(called), open: open.length, byBand, byDir,
      payoff: wins.length && losses.length ? r2((sum(wins) / wins.length) / (-sum(losses) / losses.length)) : null,
      maxDrawdownRM: Math.round(mdd),
      stoodAside: { n: aside.length, avgAbsMovePct: aside.length ? r2(sum(aside.map(r => Math.abs(r.result.hsiChgOpenClosePct))) / aside.length) : null, bigMovesMissed: aside.filter(r => Math.abs(r.result.hsiChgOpenClosePct) >= 1).length },
      outcomes: called.reduce((m, r) => { const k = r.result.outcome.split(' ')[0]; m[k] = (m[k] || 0) + 1; return m; }, {}) };
  }

  // ---------- helpers for callers ----------
  function mondayOf(iso) { const d = new Date(iso + 'T12:00:00Z'); const wd = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - wd); return d.toISOString().slice(0, 10); }
  /* synthetic vehicle for backtests: eg-consistent sensitivity so P&L ≈ eg × index % */
  function syntheticVehicle(dir, px, eg, ask) { eg = eg || 11; ask = ask || 0.30; return { sym: 'SYN-' + (dir === 'C' ? 'CALL' : 'PUT'), code: '', type: dir, strike: null, expiry: null, bid: +(ask - TICK).toFixed(3), ask, eg, sens: r2(TICK * px / (eg * ask)), theta: -0.5, weeks: 8 }; }

  return { VERSION, TICK, LOT, WEIGHTS, LABELS, BANDS, VEHICLE, RISK, features, decide, conviction, sizeMultiplier, selectVehicle, plan, score, scorecard, warrantAt, mondayOf, syntheticVehicle, band };
});
