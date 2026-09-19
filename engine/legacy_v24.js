/* Verbatim port of the Warrant Desk v2.4.0 decision logic (index_v2.html) — kept ONLY as the
   backtest baseline. Replayable factors: tech, flow, event (calendar + mid-month rule).
   Keyword factors (china, sect) and US are supplied by the caller; the July log showed china=0, sect=0. */
'use strict';
const W = { china: 25, us: 20, tech: 20, sect: 15, flow: 10, event: 10 };
const FK = Object.keys(W);

function autoTech(ohlc, today) {
  const c = ohlc.map(r => r.c); const n = c.length; if (n < 10) return null;
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const last = c[n - 1], sma5 = avg(c.slice(-5)), sma10 = avg(c.slice(-10));
  const mom5 = (last - c[n - 6]) / c[n - 6] * 100;
  let s = 0;
  s += last > sma5 ? 0.7 : -0.7;
  s += sma5 > sma10 ? 0.6 : -0.6;
  if (mom5 > 1.5) s += 0.7; else if (mom5 > 0.3) s += 0.3; else if (mom5 < -1.5) s -= 0.7; else if (mom5 < -0.3) s -= 0.3;
  let comp = ohlc; if (comp.length && comp[comp.length - 1].d === today) comp = comp.slice(0, -1);
  if (comp.length >= 15) {
    const win = comp.slice(-15);
    const hi = Math.max(...win.map(r => r.h)), lo = Math.min(...win.map(r => r.l));
    const cc = comp.map(r => r.c); const close = cc[cc.length - 1];
    const pos = hi > lo ? (close - lo) / (hi - lo) : 0.5;
    const mNow = (cc[cc.length - 1] - cc[cc.length - 6]) / cc[cc.length - 6] * 100;
    const mPrev = (cc[cc.length - 6] - cc[cc.length - 11]) / cc[cc.length - 11] * 100;
    let advNow = 0, advPrev = 0;
    for (let i = cc.length - 5; i < cc.length; i++) if (cc[i] > cc[i - 1]) advNow++;
    for (let i = cc.length - 10; i < cc.length - 5; i++) if (cc[i] > cc[i - 1]) advPrev++;
    if (pos >= 0.9 && mNow < mPrev) s -= 1;
    else if (pos <= 0.1 && advNow > advPrev) s += 1;
  }
  return Math.max(-2, Math.min(2, Math.round(s)));
}
function autoFlows(ohlc, today) {
  let rows = ohlc; if (rows.length && rows[rows.length - 1].d === today) rows = rows.slice(0, -1);
  const c = rows.map(r => r.c); const n = c.length; if (n < 6) return null;
  let adv = 0; for (let i = n - 5; i < n; i++) if (c[i] > c[i - 1]) adv++;
  return Math.max(-2, Math.min(2, adv - 2));
}
function autoEvent(dateISO, calendar) {
  const now = new Date(dateISO + 'T09:00:00+08:00').getTime();
  let s = 0;
  if ((calendar || []).find(e => e.type === 'rollover' && (new Date(e.date) - now) / 864e5 >= -0.5 && (new Date(e.date) - now) / 864e5 <= 4)) s -= 1;
  const dom = +dateISO.slice(8, 10);
  if (dom >= 9 && dom <= 17) s -= 1;
  return Math.max(-2, Math.min(0, s));
}
function conviction(f) { let s = 0, tw = 0; FK.forEach(k => { s += (f[k] || 0) * W[k]; tw += W[k]; }); return +(s / tw * 5).toFixed(1); }
function pivots(h, today) {
  if (h.length < 6) return null;
  let idx = h.length - 1; if (h[idx].d === today && idx >= 6) idx--;
  const day = h[idx]; const wk = h.slice(Math.max(0, idx - 4), idx + 1);
  const wH = Math.max(...wk.map(r => r.h)), wL = Math.min(...wk.map(r => r.l)), wC = wk[wk.length - 1].c;
  const dP = (day.h + day.l + day.c) / 3, wP = (wH + wL + wC) / 3;
  const swingH = Math.max(...h.slice(-10).map(r => r.h)), swingL = Math.min(...h.slice(-10).map(r => r.l));
  return { dayR1: 2 * dP - day.l, dayS1: 2 * dP - day.h, dayR2: dP + (day.h - day.l), dayS2: dP - (day.h - day.l), wkP: wP, wkR1: 2 * wP - wL, swingH, swingL, wH, wL };
}
function levels(h, today, px) {
  const p = pivots(h, today); if (!p) return null;
  const res = [p.swingH, p.dayR2, p.dayR1, p.wkR1, p.wH].filter(x => x > px).sort((a, b) => a - b);
  const sup = [p.swingL, p.dayS2, p.dayS1, p.wkP, p.wL].filter(x => x < px).sort((a, b) => b - a);
  return { upper: res[0] || null, lower: sup[0] || null };
}
/* ctx = { date, ohlc (completed, excluding today), preOpen, calendar, fixed:{china,us,sect} } */
function decide(ctx) {
  const hist = ctx.ohlc.concat([{ d: ctx.date, o: ctx.preOpen, h: ctx.preOpen, l: ctx.preOpen, c: ctx.preOpen }]);
  const fx = ctx.fixed || {};
  const f = { china: fx.china || 0, us: fx.us || 0, tech: autoTech(hist, ctx.date), sect: fx.sect || 0, flow: autoFlows(hist, ctx.date), event: autoEvent(ctx.date, ctx.calendar) };
  const c = conviction(f);
  const dir = Math.abs(c) < 3 ? null : c > 0 ? 'C' : 'P';
  const lv = levels(hist, ctx.date, ctx.preOpen);
  let plan = null;
  if (dir && lv) {
    const isC = dir === 'C';
    const e = isC ? lv.lower : lv.upper, t = isC ? lv.upper : lv.lower;
    if (e) plan = { entry: Math.round(e), stop: Math.round(isC ? e - 150 : e + 150), target: t ? Math.round(t) : null };
  }
  return { version: '2.4.0', date: ctx.date, dir, conviction: c, factors: f, plan };
}
/* legacy plan scoring: pullback limit entry; if never filled, no trade */
function score(decision, day, vehicle, units, brk, warrantAt) {
  const out = { date: decision.date, dir: decision.dir, conviction: decision.conviction };
  if (!decision.dir) { out.kind = 'stood-aside'; out.hsiChgOpenClosePct = (day.c - day.o) / day.o * 100; return out; }
  out.kind = 'called';
  const isC = decision.dir === 'C', dirn = isC ? 1 : -1;
  out.dirCorrect = isC ? day.c > day.o : day.c < day.o;
  const p = decision.plan;
  if (!p) { out.outcome = 'no level'; out.pnlRM = 0; return out; }
  const filled = isC ? day.l <= p.entry : day.h >= p.entry;
  if (!filled) { out.outcome = 'no fill'; out.pnlRM = 0; return out; }
  const stopHit = isC ? day.l <= p.stop : day.h >= p.stop;
  const tgtHit = p.target != null && (isC ? day.h >= p.target : day.l <= p.target);
  let exitIdx; if (stopHit) { out.outcome = 'STOP'; exitIdx = p.stop; } else if (tgtHit) { out.outcome = 'TARGET'; exitIdx = p.target; } else { out.outcome = 'CLOSE'; exitIdx = day.c; }
  const exitPx = warrantAt(vehicle, vehicle.bid, exitIdx - p.entry, 1);   // raw index change; warrantAt applies the put/call direction
  out.pnlRM = Math.round(units * (exitPx - vehicle.ask) - 2 * brk);
  return out;
}
module.exports = { decide, score, conviction, W };
