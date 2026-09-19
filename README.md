# Warrant Desk v3

Personal HSI warrant desk. A GitHub Actions job makes **one decision per trading day** before the HK open,
scores it against the actual close after the session, and commits both to `data/`. The web app
(`index.html`, a PWA on GitHub Pages) is a **viewer** of those files plus the simulator, portfolio and watchlist.

```
engine/engine.js      the whole decision logic — pure, shared by pipeline, backtest and browser
engine/decide.js      08:45 MYT: inputs → decision → vehicle → plan → data/decisions/<date>.json + data/latest.json
engine/score.js       16:35 MYT: actual OHLC → outcome → data/scorecard.json
engine/backtest.js    replays v3 AND the v2.4.0 baseline over data/history (2y) — CI gate
engine/diagnose.js    the signal research that shaped v3 (per-signal hit rates, both halves)
engine/legacy_v24.js  verbatim port of the v2.4.0 decision logic, kept only as the baseline
engine/test.js        unit tests incl. the mirror-symmetry test (mirrored prices → mirrored calls)
data/history/         2y daily HSI OHLC, external series, calendar, a warrant-universe sample
data/decisions/       one JSON per trading day (files flagged backfill:true were replayed offline, not live)
data/latest.json      what the app shows on the Desk tab
data/scorecard.json   the honest scorecard: called days only, paper P&L from decision price to exit
index_v2.html         the previous app (v2.4.0), untouched, for reference/rollback
```

## What the 2-year research said (engine/diagnose.js, Oct 2024 → Sep 2026, each half tested separately)

- Following 5-day momentum — the core of v2.4.0 — **lost in both halves** at 1–5 session horizons.
- What held in **both** halves is contrarian at a 1–3 session horizon: fade a close stretched > 2 ATR from its
  10-day mean; fade a prior-day move > 1 ATR; fade an opening gap > 0.5 ATR over 3 sessions; lean long when VIX > 25.
- S&P direction, China ETF direction and 20-day momentum showed **no consistent edge** → shown as context, weight 0.

## Backtest (engine/backtest.js, synthetic 11× warrant, RM5,000 per trade, spread + theta included)

| | v2.4.0 baseline | v3 |
|---|---|---|
| Called days (2y) | 156 | 63 |
| Direction hit, decision price → exit | 47% | 54% (H1 50%, H2 60%) |
| Paper P&L, 2y | −RM7,448 | +RM4,521 (H1 +3,190 · H2 +1,331) |
| Payoff (avg win / avg loss) | – | 1.55 |
| Max drawdown | – | −RM3,868 |

Caveats, in order of importance: 63 trades is a small sample; signal thresholds were chosen on this same history
(round numbers, not optimised, but still in-sample); the vehicle is synthetic; the pre-open level is approximated by
the cash open; when stop and target are both touched in a session the stop is assumed first. **Treat it as an edge
worth paper-trading through the live scorecard, not as proven.** The scorecard is the only number that matters from here.

## Rules the engine follows

- Direction comes only from HSI-native signals. Event risk (rollover, holiday) sets size (1 / 0.5 / 0), never direction.
- Plan: enter at the pre-open futures level; stop = nearer of 1×ATR(10) or −15% of premium; target 1.5×ATR;
  flat at the 3rd close at the latest. One position at a time.
- Vehicle: same direction, ≥4 weeks to expiry, sensitivity ≤ 40, spread ≤ 1.5%, gearing 8–14×, most responsive first,
  locked for the week once chosen.
- Scoring: NO-TRADE days are recorded, never scored as wins. Direction is judged from the decision price, so an
  overnight gap can't count as a hit. Level "accuracy" is gone.

## Running it

```
node engine/test.js                 # unit tests
node engine/backtest.js             # v3 vs baseline; --gate fails the build if v3 doesn't beat it
node engine/decide.js --offline     # decide from stored history (no network) — for local testing
node tools/serve.js                 # preview the app at http://127.0.0.1:8080
```

GitHub Actions (`.github/workflows/decide.yml`) runs decide at 08:45 MYT and score at 16:35 MYT on weekdays and
commits `data/`. Pages serves the repo root, so the app reads the files same-origin. `ci.yml` runs the tests and the
backtest gate on every push that touches the engine.

## Rollback

Tag `v2.4.0` is the last release before v3. `index_v2.html` is that app, unchanged. To roll the site back:
`git checkout v2.4.0 -- index.html sw.js manifest.json` and commit, or open `index_v2.html` directly.
