#!/usr/bin/env node
/* Signal diagnostic: for each candidate signal, what is the hit rate and mean HSI move over 1, 3 and 5
   sessions, in the first and second half of the history separately? A signal only counts if it holds in both. */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const hist = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/history/hsi.json'), 'utf8')).rows;
const ext = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/history/ext.json'), 'utf8')).rows;
const atr = (rows, n) => { let s = 0; for (let i = rows.length - n; i < rows.length; i++) { const r = rows[i], pc = rows[i - 1].c; s += Math.max(r.h - r.l, Math.abs(r.h - pc), Math.abs(r.l - pc)); } return s / n; };
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
const days = [];
for (let i = 21; i < hist.length - 5; i++) {
  const p = hist.slice(0, i), c = p.map(r => r.c), n = c.length, a = atr(p, 10), d = hist[i], x = ext[d.d] || {};
  const sma10 = avg(c.slice(-10)), sma20 = avg(c.slice(-20));
  days.push({
    d: d.d, half: d.d < '2025-10-01' ? 'H1' : 'H2',
    mom5: (c[n - 1] - c[n - 6]) / a, mom20: (c[n - 1] - c[n - 21]) / a, z10: (c[n - 1] - sma10) / a, z20: (c[n - 1] - sma20) / a,
    gap: (d.o - c[n - 1]) / a, prev1: (c[n - 1] - c[n - 2]) / a, prevOC: (p[n - 1].c - p[n - 1].o) / a,
    spx: x.spxChgPct ?? 0, fxi: x.fxiChgPct ?? 0, vix: x.vix ?? 18, dow: new Date(d.d + 'T12:00:00Z').getUTCDay(),
    r1: (d.c - d.o) / d.o * 100, r3: (hist[i + 2].c - d.o) / d.o * 100, r5: (hist[i + 4].c - d.o) / d.o * 100,
    r1cc: (d.c - c[n - 1]) / c[n - 1] * 100,
  });
}
const SIG = {
  'follow mom5 (|m|>1.5)': r => Math.abs(r.mom5) > 1.5 ? Math.sign(r.mom5) : 0,
  'fade mom5 (|m|>1.5)': r => Math.abs(r.mom5) > 1.5 ? -Math.sign(r.mom5) : 0,
  'follow mom20 (|m|>3)': r => Math.abs(r.mom20) > 3 ? Math.sign(r.mom20) : 0,
  'fade stretch z10 (|z|>2)': r => Math.abs(r.z10) > 2 ? -Math.sign(r.z10) : 0,
  'fade stretch z20 (|z|>2.5)': r => Math.abs(r.z20) > 2.5 ? -Math.sign(r.z20) : 0,
  'follow gap (|g|>0.5)': r => Math.abs(r.gap) > 0.5 ? Math.sign(r.gap) : 0,
  'fade gap (|g|>0.5)': r => Math.abs(r.gap) > 0.5 ? -Math.sign(r.gap) : 0,
  'fade gap (|g|>1.0)': r => Math.abs(r.gap) > 1.0 ? -Math.sign(r.gap) : 0,
  'follow prev day c→c (|p|>1)': r => Math.abs(r.prev1) > 1 ? Math.sign(r.prev1) : 0,
  'fade prev day c→c (|p|>1)': r => Math.abs(r.prev1) > 1 ? -Math.sign(r.prev1) : 0,
  'fade prev day o→c (|p|>1)': r => Math.abs(r.prevOC) > 1 ? -Math.sign(r.prevOC) : 0,
  'follow S&P (|s|>0.5%)': r => Math.abs(r.spx) > 0.5 ? Math.sign(r.spx) : 0,
  'fade S&P (|s|>0.5%)': r => Math.abs(r.spx) > 0.5 ? -Math.sign(r.spx) : 0,
  'follow FXI (|f|>1%)': r => Math.abs(r.fxi) > 1 ? Math.sign(r.fxi) : 0,
  'fade FXI (|f|>1%)': r => Math.abs(r.fxi) > 1 ? -Math.sign(r.fxi) : 0,
  'long when VIX>25': r => r.vix > 25 ? 1 : 0,
  'always long': () => 1,
};
function stat(list, sigFn, key) {
  const hits = [], moves = [];
  list.forEach(r => { const s = sigFn(r); if (!s) return; const m = s * r[key]; moves.push(m); hits.push(m > 0 ? 1 : 0); });
  if (!hits.length) return { n: 0 };
  return { n: hits.length, hit: Math.round(avg(hits) * 100), mean: +avg(moves).toFixed(2) };
}
const fmt = s => s.n ? (String(s.n).padStart(3) + 'd ' + String(s.hit).padStart(3) + '% ' + (s.mean >= 0 ? '+' : '') + s.mean.toFixed(2) + '%') : '   –          ';
console.log('HSI ' + days[0].d + ' → ' + days[days.length - 1].d + ' · ' + days.length + ' days · H1 = before 2025-10-01, H2 = after. Columns: n, hit rate, mean signed move (before costs; an 11x warrant costs ≈0.2% of index per round trip).');
console.log('Base rates: open→close up ' + Math.round(avg(days.map(r => r.r1 > 0 ? 1 : 0)) * 100) + '%, mean ' + avg(days.map(r => r.r1)).toFixed(2) + '% · 5-day mean ' + avg(days.map(r => r.r5)).toFixed(2) + '%');
console.log('');
console.log('signal'.padEnd(30) + '| 1-day o→c  H1        H2        | 3-day  H1        H2        | 5-day  H1        H2');
for (const [name, fn] of Object.entries(SIG)) {
  const H1 = days.filter(r => r.half === 'H1'), H2 = days.filter(r => r.half === 'H2');
  console.log(name.padEnd(30) + '| ' + fmt(stat(H1, fn, 'r1')) + ' ' + fmt(stat(H2, fn, 'r1')) + ' | ' + fmt(stat(H1, fn, 'r3')) + ' ' + fmt(stat(H2, fn, 'r3')) + ' | ' + fmt(stat(H1, fn, 'r5')) + ' ' + fmt(stat(H2, fn, 'r5')));
}
console.log('\nDay of week (1-day o→c, all): ' + [1, 2, 3, 4, 5].map(w => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'][w - 1] + ' ' + fmt(stat(days.filter(r => r.dow === w), () => 1, 'r1'))).join(' · '));
