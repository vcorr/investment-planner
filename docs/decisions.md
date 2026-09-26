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
| D8 | Web interface (§22) | **Build in M6.** Pages for performance, predictions, today's report and settings. Google sign-in restricted to Vasco. Plain design unless Vasco supplies one from Claude Design. Hosting and sign-in changed by D9 |
| D9 | Hosting split (2026-09-26) | **Supabase Free plus Google Cloud, instead of Neon** (brief §5). Aim: stay inside free allowances. See A12 and `docs/architecture.md` |
| D10 | Price source and exchanges (2026-09-26) | **Nasdaq Nordic's public website API instead of EODHD; Oslo dropped.** Universe: Nasdaq Helsinki, Stockholm and Copenhagen, Main Market and First North. No paid data. See A13 |
| D11 | News storage (2026-09-26) | **Store all company announcements for Helsinki, Stockholm and Copenhagen (Main Market and First North)** from now on, not only the development sample: about 70-85 a day, headlines and metadata only, about 5 MB over two months (ASSUMED 0.5 KB per item). Reason: the source keeps only its latest ~10,000 items (V23), so history cannot be refetched later, and the scored month needs news for the full universe and its peers |

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

**A12 — Where each part runs (D9).** Diagram in `docs/architecture.md`.
- **Supabase Free:** Postgres; Supabase Auth with Google sign-in; the Data API, with Row Level Security allowing only Vasco's user ID; Storage for report files; Supabase Cron plus an Edge Function that polls company announcements every 4 hours (changed on 2026-09-26 from every 5 minutes: a page holds about 1.5-2 weekdays and runs page back after a gap, so nothing is missed; the daily job fetches once more just before the cut-off). A test fails if any table lacks an access policy. New sign-ups are turned off after Vasco's first sign-in. The settings lock during the scored month is enforced by a database rule, not by the web page.
- **Google Cloud:** one Cloud Run job for the daily run (it starts, runs and exits; no always-on service), triggered by Cloud Scheduler; Artifact Registry for the image; Secret Manager for three keys set by hand (Anthropic, database URL, Supabase key), with the job's service account limited to `roles/secretmanager.secretAccessor` so code can never add secret versions; a Cloud Storage bucket for nightly database dumps; Firebase Hosting for the static web pages; an OAuth client for Google sign-in; a project budget alert at €1 per month.
- **Why not Neon:** its free plan gives 100 compute-hours a month and a 5-minute news poll keeps it awake, about 182 compute-hours (COMPUTED, 0.25 × 730 h). With the later 4-hourly poll Neon would fit, but Supabase stays: it also provides sign-in, storage and the scheduler. **Why not Cloud SQL:** about $9.40 a month for the smallest instance (SOURCED, cloud.google.com/sql/pricing, 2026-09-26). **Why the daily job is not an Edge Function:** 150 s wall clock and 2 s CPU per call on the free plan (SOURCED, supabase.com/docs/guides/functions/limits, 2026-09-26), and the run must finish before 10:00.
- **Limits to watch:** 500 MB database on the free plan; estimated use about 250 MB (ASSUMED), measured after the M1 backfill. No backups on the free plan, hence the nightly dump.
- **Identity-Aware Proxy is dropped;** Supabase Auth replaces it.

**A13 — Nasdaq Nordic as the price source (D10).** Replaces EODHD (brief §6.1) and the fundamentals plan.
- **Endpoints** (the API behind nasdaq.com's own pages, tested 2026-09-26, `docs/verification.md` V22): `api.nasdaq.com/api/nordic/screener/shares` lists shares per market with ISIN, orderbook ID and ICB sector; `api.nasdaq.com/api/nordic/instruments/{orderbookId}/chart/download` returns daily opening price, high, low, close, average, volume, turnover and trades for a date range.
- **Universe size** (SOURCED, same test): Helsinki 147 + 47 First North; Stockholm 411 + 333; Copenhagen 117 + 27; total 1,082 before the liquidity filter and screen.
- **Oslo dropped,** because Euronext is not in this API. This removes NOK, Oslo Newsweb (open item 5) and Oslo fees.
- **Sector** comes from the screener's ICB sector field, so the EODHD fundamentals plan (open item 4) is no longer needed. ICB is coarse (e.g. "Basic Materials" mixes mining and chemicals), so the screen still relies on its LLM-assisted pass.
- **Risks.** The API is unofficial, with no published terms or uptime promise (UNVERIFIED). The loader sits behind an interface so a paid source (EODHD) can replace it within hours if it breaks. Prices are raw, not adjusted for dividends or splits, so M1 must find a dividend and split source; until then ex-dividend days are flagged and excluded from scoring. Requests are paced politely (about 2 per second; about 9 minutes for the full universe each morning, COMPUTED).
