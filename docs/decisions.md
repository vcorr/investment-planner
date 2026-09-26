# Decisions and amendments to the brief

Decisions only Vasco can make (brief §21), and amendments to the brief agreed before any code was written. Where this file and `BRIEF.md` disagree, **this file wins**. Changes after the config freeze void the scored month (brief §11).

## Decisions (2026-09-26)

| # | Question | Decision |
|---|---|---|
| D1 | Nordnet fee tier (§21.1) | **Taso 4** (0.20 %, minimum 9 €), the most expensive, fixed for the whole simulation |
| D2 | LLM spend ceiling (§21.5) | Estimate first. M0 estimate ≈ $1.44 per day; proposed alert at $5 per day (see `docs/verification.md` V20). Awaiting confirmation |
| D3 | First North (§21.6) | **Included.** Liquidity filter and ethical screen apply as for main markets |
| D4 | Timeline | Start as soon as possible. The scored month is the first full calendar month after a completed shakedown week, announced in advance |
| D5 | Ethical screen | **Vasco sets the exclusion rules.** The screen is driven by a user-edited rules file, not by rules hard-coded in the repo (see A7) |
| D6 | Natural-gas consumers (§21.2) | Covered by D5: Vasco sets it in the rules file |
| D7 | Report delivery (§21.4) | Open; needed before M6. Leaning: web interface (D8), possibly with a Cowork scheduled task for a morning summary |
| D8 | Web interface (§22) | **Build in M6.** A second Cloud Run service reading the same database, with pages for performance, predictions, today's report and settings. Google sign-in restricted to Vasco. Plain design unless Vasco supplies one from Claude Design |

## Amendments accepted

**A1 — Code computes all trade numbers.** Stops, targets, position size and time stop are set by code from 20-day realised volatility. The cost hurdle tests a code-computed expected move derived from the model's confidence, roughly `(2c − 1) × σ × √h`; the exact mapping will be fixed in the M5 plan. The LLM supplies direction, confidence, thesis, catalyst and falsification condition only. `expected_move_pct`, `stop_pct`, `target_pct`, `time_stop_days` and `target_eur` are removed from the LLM output schema (§10.2).

**A2 — Overlap-robust inference.** The 5-day hit rate is reported with overlap-robust standard errors (Newey–West or Hansen–Hodrick, 4 lags), clustered by day. **Pass** requires all of:
- the 5-day hit rate ≥ 60 % over ≥ 200 matured calls;
- the lower bound of its 95 % interval above 50 %;
- the hit rate above the momentum baseline and above the majority-direction baseline (A3), with the lower bound of the 95 % interval for the difference above zero.

The Stop and Extend rules in §16 are otherwise unchanged.

**A3 — Majority-direction baseline.** A fourth baseline always predicts the direction that turned out more common in the realised outcomes for that horizon. The LLM must beat it.

**A4 — Scoring after maturity.** Predictions made during the scored month are scored once they mature, even if that falls after the month ends. The verdict date is the day the last 5-day call matures, about one week after the month ends.

**A5 — Portfolio test.** §16's condition "portfolio net of trading costs ≥ primary benchmark" becomes "portfolio net of trading costs is not below the primary benchmark by more than two standard errors of the monthly excess return". The raw comparison is still reported.

**A6 — Timing rules.**
- Stops and targets are evaluated on the entry day itself, after the open fill.
- The decision must be recorded before the earliest open (10:00 Helsinki). If it is not, the day is "no decision". This is added to the leakage tests.
- Proceeds from SEK, NOK and DKK sales are converted to EUR immediately, paying the FX fee.

**A7 — User-owned screen rules.** `screen/rules.yaml` (committed) is where Vasco defines excluded activities, the test for each (e.g. revenue-share threshold, any-involvement, or a role such as "extracts or sells"), and borderline handling. `screen/overrides.yaml` keeps per-company verdicts and always wins. The code ships the brief's five excluded categories as the starting content of `rules.yaml`, clearly marked as Vasco's to edit. Changing either file during the scored month voids the month, as for any config change.

**A8 — Taso 4 cost figures.** The hurdle illustration in §11 becomes: a 1,500 € Helsinki round trip costs 1.40 % including ASSUMED slippage, so the hurdle is 4.20 %; for SEK, NOK or DKK names, 1.90 % and 5.70 % (COMPUTED, `docs/verification.md` V1). The golden tests in §19 are kept and Taso 4 cases are added.

**A9 — FX fee.** 0.25 % per automatic conversion, now SOURCED from Nordnet (`docs/verification.md` V3).

**A10 — Model IDs.** `decisionModel: "claude-sonnet-5"`, `extractionModel: "claude-haiku-4-5-20251001"` (dated snapshot, pinned for reproducibility). Sonnet 5 has no temperature control; `effort` is logged instead.

**A11 — Settings in the database, edited from the web interface.** Because the interface (D8) must change preferences, not only show them, settings and screen rules live in the database as versioned, hashed snapshots. Each save creates a new version; the daily job records which version it used. The settings form is read-only during the scored month, and the only way to change anything then is to end the month deliberately. The YAML files in A7 become the initial seed and an export format, not the live source.
