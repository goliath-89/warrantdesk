/* Network fetchers for the pipeline (Node 18+, global fetch). Every function returns null on failure and
   records why in `errors`, so the decision file always says which inputs were missing. */
'use strict';
const MQ = 'https://www.malaysiawarrants.com.my/apimqmy/';
const YH = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const UA = 'Mozilla/5.0 (Warrant Desk personal pipeline; 2 runs/day)';
const errors = [];

async function getJSON(url, ms) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms || 20000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json,text/plain,*/*' }, signal: ac.signal });
    if (!r.ok) throw new Error('http ' + r.status);
    return await r.json();
  } catch (e) { errors.push(url.split('?')[0].replace(/^https?:\/\//, '') + ': ' + e.message); return null; }
  finally { clearTimeout(t); }
}
const pn = s => { if (s == null) return null; const n = parseFloat(('' + s).replace(/[,%]/g, '')); return isNaN(n) ? null : n; };
function parseMQDate(s) {
  if (!s) return null; const m = ('' + s).match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})/); if (!m) return null;
  const mo = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }[m[2].toLowerCase()];
  if (mo == null) return null; let y = +m[3]; if (y < 100) y += 2000;
  return new Date(Date.UTC(y, mo, +m[1])).toISOString().slice(0, 10);
}

/* Yahoo daily chart → [{d,o,h,l,c}] (dates in the exchange's local time) */
async function yahooDaily(symbol, range) {
  const j = await getJSON(YH + encodeURIComponent(symbol) + '?range=' + (range || '1y') + '&interval=1d');
  if (!j || !j.chart || !j.chart.result) return null;
  const q = j.chart.result[0], ts = q.timestamp || [], Q = q.indicators.quote[0], off = (q.meta && q.meta.gmtoffset) || 0;
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    if (Q.close[i] == null || Q.open[i] == null) continue;
    rows.push({ d: new Date((ts[i] + off) * 1000).toISOString().slice(0, 10), o: +Q.open[i].toFixed(2), h: +Q.high[i].toFixed(2), l: +Q.low[i].toFixed(2), c: +Q.close[i].toFixed(2) });
  }
  return rows;
}
/* Macquarie live HSI futures quote (the level the warrants are priced off) */
async function mqIndex() {
  const j = await getJSON(MQ + 'LiveIndexJSON?ric=HSI&qid=' + Date.now(), 15000);
  if (!j) return null; const px = pn(j.last); if (!px) { errors.push('LiveIndexJSON: no last price'); return null; }
  return { px, chg: pn(j.chng), time: j.stime || null, source: 'macquarie LiveIndexJSON' };
}
/* Macquarie HSI warrant universe (same mapping as the app) */
async function mqUniverse() {
  const j = await getJSON(MQ + 'ScreenerJSONServlet?underlying=HSI&qid=' + Date.now(), 25000);
  if (!j || !Array.isArray(j.data)) return null;
  const out = j.data.filter(w => w.underlyingSymbol === 'HSI' && (!w.issuer || /macquarie/i.test(w.issuer))).map(w => {
    const bid = pn(w.bid || w.BID || w.bidPrice), ask = pn(w.ask || w.askPrice);
    return { code: w.ticker || w.dwSymbol || '', sym: w.dwSymbol || '', ric: w.ric || '', type: ('' + (w.type || '')).toUpperCase().startsWith('C') ? 'C' : 'P',
      strike: pn(w.exercisePrice), expiry: parseMQDate(w.ltDate || w.maturity), bid, ask: ask || (bid != null ? +(bid + 0.005).toFixed(3) : null),
      eg: pn(w.effectiveGearing), sens: pn(w.sensitivity), iv: pn(w.impliedVolalitiy || w.impliedVolatility), theta: pn(w.theta),
      ratio: pn(w.conv_ratio), moneypc: pn(w.moneyness_percent) };
  }).filter(w => w.strike > 0);
  return out.length ? out : null;
}
/* Macquarie HK holiday + HSI futures rollover calendar */
async function mqCalendar() {
  const j = await getJSON(MQ + 'calendar?type=my&qid=' + Date.now(), 15000);
  if (!j || !Array.isArray(j.dateGroups)) return null;
  const ev = [];
  j.dateGroups.forEach(g => (g.items || []).forEach(it => {
    if (it.market_code === 'HKG') ev.push({ date: g.date, type: 'holiday', name: it.public_text || it.market_name || 'HK market holiday' });
    if (it.market_code === 'ROLL') ev.push({ date: g.date, type: 'rollover', name: 'HSI futures rollover' });
  }));
  return ev;
}
/* Macquarie live matrix quote for one warrant → {bid, ask, sens, eg, iv, theta, underlying} */
async function mqMatrix(ric) {
  if (!ric) return null;
  const j = await getJSON(MQ + 'LiveMatrixJSON?ric=' + encodeURIComponent(ric) + '&mode=0&qid=' + Date.now(), 15000);
  if (!j || !j.ric_data) return null; const d = j.ric_data;
  return { bid: pn(d.BID), ask: pn(d.ASK || d.offer), sens: pn(d.sensitivity), eg: pn(d.effective_gearing), iv: pn(d.implied_volatility), theta: pn(d.theta), underlying: pn(d.underlying_price), time: j.last_update || null };
}
/* External modifiers as known before the HK open on `date`: latest US / FX close strictly before that date */
async function externals(date) {
  const out = { spxChgPct: null, vix: null, fxiChgPct: null, cnhChgPct: null, asOf: {} };
  const last2 = (rows, key) => { const r = (rows || []).filter(x => x.d < date); if (r.length < 2) return null; out.asOf[key] = r[r.length - 1].d; return [r[r.length - 2].c, r[r.length - 1].c]; };
  const spx = last2(await yahooDaily('^GSPC', '1mo'), 'spx'); if (spx) out.spxChgPct = +((spx[1] / spx[0] - 1) * 100).toFixed(2);
  const vix = last2(await yahooDaily('^VIX', '1mo'), 'vix'); if (vix) out.vix = vix[1];
  const fxi = last2(await yahooDaily('FXI', '1mo'), 'fxi'); if (fxi) out.fxiChgPct = +((fxi[1] / fxi[0] - 1) * 100).toFixed(2);
  const cny = last2(await yahooDaily('CNY=X', '1mo'), 'cny'); if (cny) out.cnhChgPct = +((cny[1] / cny[0] - 1) * 100).toFixed(2);
  return out;
}
module.exports = { yahooDaily, mqIndex, mqUniverse, mqCalendar, mqMatrix, externals, errors, parseMQDate };
