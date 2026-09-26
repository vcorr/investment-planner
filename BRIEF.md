# Nordic Paper Trader — build brief for Claude Code

> Amendments agreed on 2026-09-26 are in `docs/decisions.md` and take precedence over this file. M0 findings are in `docs/verification.md`.

> Paste this whole file into Claude Code as the opening prompt, or commit it to the repo as `BRIEF.md` and point Claude Code at it. It is written to be read by an agent, so it is explicit where a human colleague would need less.

---

## 0. Working agreement (read first)

You are building a **paper-trading recommendation assistant** for me (Vasco). It simulates a 5,000 € portfolio of Nordic equities, checks the market every weekday, may or may not trade, and is scored honestly after one month. **No real orders are ever placed. There is no broker integration.**

How I want you to work:

1. **Plan before code.** Produce a written plan for each milestone (§20) and wait for my approval before implementing it.
2. **Never invent data.** Every figure the system uses (prices, fees, FX, thresholds) comes from a named source, a config value, or a computation in code. If something is unknown, stop and ask. Do not fill it with a plausible guess.
3. **Mark provenance.** In docs, reports and your own summaries, label each key claim as `SOURCED` (with URL and access date), `COMPUTED` (by code in this repo), `ASSUMED` (a config placeholder awaiting calibration) or `UNVERIFIED`.
4. **Verify before relying.** Items marked `VERIFY` in this brief are unconfirmed. Resolve each in Milestone 0 and record what you found.
5. **Blockers are mine.** Items in §21 are decisions only I can make. Ask; do not default them silently.
6. **Push back.** If part of this brief is wrong, contradictory or statistically naive, say so plainly before building it.
7. **Language.** Code, comments and identifiers in English. Documentation and reports in British English.

---

## 1. Objective and non-goals

**Objective.** Run a forward, out-of-sample, one-month paper experiment answering one question: *does an LLM reading Nordic news plus deterministic market signals make market-adjusted directional predictions better than chance and better than a naive baseline, and can a cost-aware simulated portfolio built on them keep pace with a passive benchmark after realistic trading costs?*

**Non-goals.**
- Placing real trades, or connecting to Nordnet or any broker.
- Intraday trading, leverage, short selling, derivatives, warrants or certificates.
- Backtesting the LLM layer on historical data. It is invalid because of look-ahead and memorisation bias (see §3), so do not build it, even as a "quick sanity check".
- Tax simulation. Results are pre-tax; the OST-versus-AOT question is deferred.
- A polished UI. See §22: it is optional and comes last.

---

## 2. Fixed parameters

| Parameter | Value | Status |
|---|---|---|
| Notional starting capital | 5,000 € cash | fixed |
| Base currency | EUR | fixed |
| Direction | long-only, cash allowed | fixed |
| Cadence | one decision run every weekday on which at least one universe exchange is open | fixed |
| Trading obligation | none; "no change" is a normal, frequent outcome | fixed |
| Costs | always simulated, on every simulated order (§12) | fixed |
| Universe exchanges | Nasdaq Helsinki, Nasdaq Stockholm, Nasdaq Copenhagen (Main Market), Oslo Børs | fixed; First North off by default (config flag) |
| Timezone | Europe/Helsinki for scheduling; all stored timestamps in UTC | fixed |
| Shakedown | one week, unscored | fixed |
| Scored period | Monday 2 November – Monday 30 November 2026 (21 weekdays, COMPUTED) | proposed; adjust if the build slips, but the scored period must be a full calendar month announced in advance |

---

## 3. Evidence constraints that shape the design

These are why the system looks the way it does. Do not optimise them away.

- **Backtests of LLM decisions are contaminated.** Models recall historical prices and outcomes within their training window. Only forward testing is credible. SOURCED: arXiv 2601.13770; arXiv 2603.23300.
- **News edge is in the drift, not the reaction.** Lopez-Lira & Tang (rev. Oct 2025) find GPT-4 captures the initial market reaction to headlines (about 90 % portfolio-day hit rate), but that reaction is not tradable. The model's scores also predict the subsequent drift, most strongly for small stocks and negative news, and strategy returns decline as LLM adoption rises. The drift lasts roughly one to two trading days. SOURCED: https://arxiv.org/abs/2304.07619.
  - Implication: a morning batch job cannot beat the headline. It can only exploit slow digestion.
  - Implication: in a long-only book, negative news is used mainly for SELL and avoid decisions.
- **One month cannot judge portfolio P&L.** With an ASSUMED daily tracking error of 0.8–1.6 %, 21 days can only distinguish a monthly excess return of about 7.3–14.7 % from luck (COMPUTED, two standard errors). The primary verdict therefore rests on the **prediction log** (§13), which yields about 210 calls per horizon.

---

## 4. Architecture overview

```
                ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
 sources  ───▶  │ price/FX     │   │ news ingest  │   │ calendars    │
                │ ingest (EOD) │   │ (RSS etc.)   │   │ (exch./macro)│
                └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
                       ▼                  ▼                  ▼
                ┌─────────────────────────────────────────────────┐
                │ Postgres: instruments, prices, fx, news, events │
                └──────┬──────────────────┬───────────────────────┘
                       ▼                  ▼
            ┌───────────────────┐  ┌──────────────────────────┐
            │ universe + screen │  │ news event extraction    │
            │ (deterministic +  │  │ (LLM, per item, cheap)   │
            │  manual overrides)│  └────────────┬─────────────┘
            └─────────┬─────────┘               │
                      ▼                         ▼
            ┌──────────────────────────────────────────────┐
            │ deterministic signals → shortlist (N names)  │
            └─────────────────────┬────────────────────────┘
                                  ▼
            ┌──────────────────────────────────────────────┐
            │ decision packet (frozen, hashed, cut-off)    │
            └─────────────────────┬────────────────────────┘
                                  ▼
            ┌──────────────────────────────────────────────┐
            │ decision LLM → predictions + proposed actions│
            │ (strict JSON; numeric provenance check)      │
            └─────────────────────┬────────────────────────┘
                                  ▼
            ┌──────────────────────────────────────────────┐
            │ rules engine (caps, cost hurdle, stops)      │
            └─────────────────────┬────────────────────────┘
                                  ▼
            ┌──────────────────────────────────────────────┐
            │ execution simulator + Nordnet cost model     │
            └─────────────────────┬────────────────────────┘
                                  ▼
            ┌──────────────────────────────────────────────┐
            │ ledger, scoring, benchmarks → daily report   │
            └──────────────────────────────────────────────┘
```

**Principle:** code computes every number; the LLM reads, classifies, reasons and writes theses. The LLM never originates a figure, and it never sees information not in the frozen packet. **The decision call has no web access.**

---

## 5. Stack

This is my usual stack; propose deviations with reasons.

- TypeScript (strict), Node LTS, pnpm.
- Postgres on Neon. Choose Drizzle or Kysely and justify the choice. Migrations must be in the repo.
- Jobs: a Cloud Run Job triggered by Cloud Scheduler, one container with sub-commands. It must also run locally via `pnpm job:<name>`.
- Secrets: GCP Secret Manager in cloud, `.env` locally (git-ignored).
- LLM: Anthropic API via the official TypeScript SDK. Model IDs live in config with these defaults:
  - `decisionModel: "claude-sonnet-5"`
  - `extractionModel: "claude-haiku-4-5-20251001"`
  - **VERIFY** the current model IDs and the recommended approach to structured/JSON output at https://docs.claude.com before implementing. Log the model ID, parameters, token counts and cost on every call.
- Validation: zod schemas for every external payload and every LLM output.
- Tests: vitest. Golden tests for the cost model and leakage tests are mandatory (§19).
- Optional read-only web view: Hono + React/Vite, but only in Milestone 6 and only if I ask for it (§22).

---

## 6. Data sources

### 6.1 Prices, FX and calendars
- **Primary candidate: EODHD "EOD Historical Data — All World", listed at €19.99/month.** SOURCED: https://eodhd.com/pricing (accessed 2026-09-26). It is a personal-use licence.
  - **VERIFY**: coverage and ticker suffixes for all four exchanges.
  - **VERIFY**: that OHLCV includes the official open; adjusted versus raw fields; corporate-action handling; what time EOD bars become available for Nordic venues.
  - **VERIFY**: whether exchange holiday calendars are included in this tier.
- **Alternative: Börsdata.** It is Nordic-native, but the REST API has moved to the Pro+ tier and prices update once a day with no intraday data. SOURCED: https://borsdata.se/en/info/api/api_page. Consider it only if EODHD's coverage fails.
- **FX: ECB euro reference rates**, daily, for SEK, NOK and DKK. VERIFY the endpoint and publication time. The cost model's FX *fee* is separate (§12).
- **Earnings and report dates:** derive them from company releases and financial calendars (§8). If this proves unreliable, propose a paid calendar source with its price and let me decide.
- **Data cost as drag:** report it on its own line. €19.99 on 5,000 € is about 0.4 % per month (COMPUTED). It is shown alongside the trading-cost figures, not inside them.

### 6.2 News (§8 covers processing)
- **Nasdaq Nordic company announcements via RSS.** Main Markets notices cover Copenhagen, Stockholm, Helsinki and Iceland; polling must be no more often than every 30 s. The feeds carry only messages filed with Nasdaq. SOURCED: https://subscribe.news.eu.nasdaq.com/rss. VERIFY the exact feed URLs per market and category.
- **Oslo Børs announcements (Newsweb).** UNVERIFIED: find an official machine-readable feed and check its terms.
- **Business press headlines** (Finnish, Swedish, Norwegian, Danish, English).
  - Candidates: Kauppalehti, Yle talous, Inderes, Dagens industri, E24, Børsen, plus one international wire, if a lawful feed exists.
  - VERIFY RSS availability and terms of use for each. Headlines plus summary only; **no paywall circumvention, no full-text scraping of paywalled articles.**
- **Macro calendar:** ECB, Riksbank, Norges Bank and Danmarks Nationalbank decisions; euro-area, Swedish and Norwegian CPI; the major US releases. These are risk flags, not predictions. VERIFY sources.

---

## 7. Universe and ethical screen

### 7.1 Universe
- All common shares on the four exchanges (config flag for First North).
- **Liquidity filter:** median daily turnover over 60 trading days ≥ 1,000,000 € equivalent. ASSUMED; configurable.
- Recompute weekly. Freeze the universe for the scored month at its start and log any delistings or suspensions.

### 7.2 Ethical screen (absolute; applies to real and paper money alike)
- **Excluded activities:** fossil fuels, weapons/defence, mining, pesticides, tobacco.
- **Rules:**
  - The screen is applied to the company's **underlying business operations**, not to secondary-market activity.
  - An SFDR label (e.g. Article 8) is **not** evidence of compliance.
  - Unreviewed borderline cases are **excluded** until reviewed.
- **Pipeline:**
  1. First pass from industry classification.
  2. LLM-assisted read of segment reporting for anything not clearly clean. It outputs a verdict, rationale, the revenue-share figures it relied on (quoted from the source), and the source URL.
  3. Manual overrides in `screen/overrides.yaml` (committed), which always win.
- **Storage:** a `screen_verdicts` row per instrument holding verdict, category, rationale, sources, reviewer (`auto` | `llm` | `vasco`) and date.
- **BLOCKER (§21):** companies that *consume* natural gas, as opposed to extracting or selling it. Ask me before the screen is finalised.
- The screen gates everything: excluded names never enter a packet, a shortlist or a benchmark.

---

## 8. News pipeline

1. **Ingest.** For each item store: `source`, `url`, `title`, `summary`, `language`, `published_at` (UTC, from the source), `fetched_at` (UTC, our clock) and a raw payload hash.
2. **Deduplicate** across sources: near-duplicate titles, same URL, same release syndicated.
3. **Entity-link** each item to instruments, using ISIN, official names, common short names and names in fi/sv/no/da. Unlinked items are kept for macro and sector use.
4. **Extract events** with `extractionModel`. The strict JSON output per item is:
   - `event_type`: one of `guidance_change | profit_warning | results | order_win | m_and_a | capital_raise | insider_trade | management_change | regulatory | legal | product | macro | sector | other`;
   - `affected`: a list of `{isin, relation: direct|peer|customer|supplier|competitor, direction: pos|neg|unclear, magnitude: low|med|high, horizon_days: 1|5}`;
   - `novelty_note`: why this is or is not new information;
   - `evidence_quote`: 15 words or fewer, taken from the item.
   Second-order (spillover) links are allowed and should be labelled as such. **This spillover mapping is the hypothesis I most want tested.**
5. **Novelty check (deterministic).** For each affected instrument, compute the market-adjusted price move between `published_at` and the latest available close. Attach it to the event so the decision model can see whether the news appears already priced.
6. **Admissibility rule.** An item may enter a decision packet only if **both** `published_at < cutoff` **and** `fetched_at < cutoff`. The second condition guards against back-dated timestamps.

---

## 9. Deterministic signals and shortlist

Compute daily from EOD data, in local currency:

- relative momentum over 20, 60 and 120 days versus the equal-weight screened universe of the same exchange;
- distance from the 52-week high;
- volume anomaly: today's volume against the 60-day median;
- days to the next scheduled report;
- post-results drift window (the first 5 trading days after results);
- insider purchases, if a lawful source exists (VERIFY; otherwise omit);
- realised 20-day volatility, used for stops and sizing.

**Shortlist:** each day select N = 10 names (configurable) for the prediction log.
- Current holdings are always included.
- The rest are chosen from names carrying admissible news events, then topped up by signal rank.
- The selection logic is deterministic and logged, so the shortlist itself can be audited.

---

## 10. Decision layer (LLM)

### 10.1 Input: the decision packet
One JSON document per day, frozen at the cut-off, stored in full, with its SHA-256 recorded. It contains:

- run date, cut-off time, config snapshot hash;
- the portfolio: cash, positions (quantity, cost basis, current price, unrealised P&L net of costs), days held, and each position's stored thesis, falsification condition and exit rules;
- per shortlisted name: identifiers, exchange, currency, screen verdict, all §9 signals, admissible news events with their novelty checks, and the estimated round-trip cost % from the cost model;
- the macro calendar for the next 5 trading days;
- the rules (§11), stated so the model can reason within them.

### 10.2 Output (strict JSON, zod-validated)

```jsonc
{
  "predictions": [
    { "isin": "...", "horizon_days": 1, "direction": "up|down",
      "confidence": 0.50-1.00, "basis_event_ids": ["..."], "basis_signals": ["..."],
      "rationale": "≤60 words" }
    // exactly one per shortlisted name per horizon (1 and 5)
  ],
  "actions": [
    { "type": "BUY|SELL|KEEP", "isin": "...", "target_eur": 0,
      "thesis": "≤80 words", "catalyst": "...",
      "falsification": "a concrete, observable condition",
      "exit": { "stop_pct": -0.0, "target_pct": 0.0, "time_stop_days": 0 },
      "expected_move_pct": 0.0, "horizon_days": 0,
      "screen_concerns": "none|..." }
  ],
  "no_action_reason": "required if actions contain no BUY/SELL"
}
```

The meaning of **direction** is the sign of the *market-adjusted* return (the stock's return minus the same-exchange equal-weight universe return) over the horizon.

### 10.3 Validation (reject and log on failure; retry once, then record "no decision")
- The JSON conforms to the schema, with exactly one prediction per shortlisted name per horizon.
- **Numeric provenance:** every number appearing in any `rationale`, `thesis` or `catalyst` must match a number in the packet within 0.5 % relative. Otherwise the output is rejected with a list of the offending numbers.
- Every `basis_event_id` exists in the packet.
- Actions reference only shortlisted, screen-passed names.
- The rules engine (§11) has the final word. The LLM proposes; code disposes.

---

## 11. Rules engine and portfolio constraints

All values are configurable. The defaults below are ASSUMED unless marked otherwise.

- **Positions:** at most 3 concurrent positions. The target position is 1,500 € and the minimum at entry is 1,250 €. Up to 2 positions per sector.
- **Cash:** keep a floor of 250 €.
- **Opening pace:** at most 1 new position per day.
- **Turnover cap:** at most 8 round trips per calendar month.
- **Cost hurdle:** a BUY is admissible only if `expected_move_pct ≥ 3 × estimated_round_trip_cost_pct`, where the cost includes fees, FX and slippage on both sides (§12).
  - Illustrative figures (COMPUTED, at Taso 3): a 1,500 € Helsinki position costs about 1.13 %, so the hurdle is about 3.4 %. A 1,500 € SEK, NOK or DKK position costs about 1.63 % including the UNVERIFIED FX fee, so the hurdle is about 4.9 %.
- **SELL triggers:**
  - the falsification condition is met (evaluated by the LLM, but only against packet facts);
  - the stop is hit;
  - the time stop expires;
  - the screen fails;
  - a better use of the slot clears the hurdle *net of the exit cost*.
- **KEEP** is the default and needs no justification beyond "no trigger".
- **Pre-registration:** the config is snapshotted and hashed at the start of the scored month. **Any change during the scored month voids the month.** Log the change and restart the clock.

---

## 12. Execution simulator and cost model

### 12.1 Nordnet fees
The Helsinki schedule is SOURCED from https://www.nordnet.fi/palvelut/hinnasto (accessed 2026-09-26).

| Tier | Rate | Minimum | Earned by (previous calendar month, all portfolios combined) |
|---|---|---|---|
| Taso 1 | 0.06 % | 3 € | ≥ 51 executed orders |
| Taso 2 | 0.10 % | 5 € | 11–50 |
| Taso 3 | 0.15 % | 7 € | 1–10 |
| Taso 4 | 0.20 % | 9 € | 0 |

- The fee per order is `max(rate × notional_eur, minimum)`.
- **The tier is fixed in config for the whole simulation** and equals my real current tier (BLOCKER, §21), because simulated orders do not change my real tier.
- **Stockholm, Copenhagen and Oslo:** VERIFY the rates and minimums from Nordnet's own price list and store them with source URL and date.
  - Until verified, use the Helsinki schedule and mark every such trade `UNVERIFIED_FEE` in reports.
- **FX conversion fee:** placeholder 0.25 % per conversion. UNVERIFIED; the only source is secondary (https://sijoitusopas.com/oppaat/nordnet-hinnat-2025-kulut-selitettyna/). VERIFY it against Nordnet. It applies on both entry and exit for SEK, NOK and DKK names.

### 12.2 Slippage (ASSUMED placeholders; calibrate later)
- 10 bps per side where the median daily turnover is ≥ 5 M€.
- 25 bps per side between 1 and 5 M€.
- Slippage is always applied adversely.

### 12.3 Fill rules
- **Entries and discretionary exits:** filled at the official **open** of the decision day, with slippage applied.
  - A fill is known only once that day's EOD bar arrives, so it is settled in the next run.
- **Stops:** if the day's low is at or below the stop, fill at `min(open, stop) × (1 − slippage)`. This is conservative, since a gap-down fills at the open.
- **Targets:** if the day's high is at or above the target, fill at `max(open, target) × (1 − slippage)`.
  - If both stop and target are touched on the same day, **assume the stop filled first.**
- **Share quantities:** whole shares only. Round down, and re-check the minimum-position and cash-floor rules after rounding.
- **Closed exchanges:** no fills on exchange holidays. Queue the order to the next open and log it.
- **Currency:** FX for a fill uses the ECB rate of the fill date (VERIFY timing); the FX fee is added on top.

---

## 13. Prediction log and scoring (the primary verdict)

- Every shortlisted name gets a prediction at horizons 1 and 5 every day. That is about 21 × 10 = 210 calls per horizon in the scored month (COMPUTED).
- **Outcome:** the sign of the market-adjusted return from the decision-day open to the close at horizon *h*, in local currency.
- **Metrics:**
  - hit rate overall, by horizon, by event type, by relation (direct versus spillover) and by news versus no-news;
  - calibration by confidence bucket;
  - Brier score.
- **Baselines, scored identically:**
  - (a) coin flip (the analytic 50 %);
  - (b) momentum sign: the direction of the 20-day market-adjusted return;
  - (c) previous-day reversal.
  - The LLM must beat (b) as well as (a) to count as adding anything.
- **Correlation caveat:** calls made on the same day are not independent. Report hit rates with a day-clustered standard error, and state the effective sample size.

---

## 14. Benchmarks

- **Primary:** an equal-weight portfolio of the screened, liquidity-filtered universe, held for the month at zero cost. It is computed from our own data, so it is always available.
- **Secondary:** a published Nordic index series, if the data provider has one (VERIFY which).
- **Reported portfolio figures:**
  - gross return;
  - net of trading costs;
  - net of trading and data costs;
  - costs as a share of gross P&L.

---

## 15. Daily report

Generate `reports/YYYY-MM-DD.md`, stored in the DB and object storage. It is a delivery channel only (see §21 for where it goes). Contents, in this order:

1. **Header:** date, run status, config hash, packet hash, and the result of the leakage checks.
2. **Settled since the last run:** fills, with price, fees, FX fee, slippage and net amount.
3. **Portfolio:** cash, positions, mark-to-market, P&L net of costs, and days held.
4. **Today's actions,** or the no-action reason. Each action shows its thesis, falsification condition, exit rules, the hurdle calculation and every cost component.
5. **Predictions table:** name, 1-day and 5-day direction, confidence, and the basis (event links).
6. **News digest:** the top events with source links, novelty checks, and whether each was spillover-derived.
7. **Scorecard to date:** hit rates against the baselines, calibration, portfolio against the benchmarks, cumulative costs, data-cost drag.
8. **Provenance footer:** every figure tagged SOURCED, COMPUTED, ASSUMED or UNVERIFIED, plus any rejected LLM outputs and the reasons.

There is also a **month-end post-mortem** containing the pre-registered verdict (§16), the ten most confident wrong calls with the packets that produced them, and cost attribution.

---

## 16. Pre-registered success criteria

These are written before the scored month and must not change during it.

- **Pass:**
  - the market-adjusted 5-day hit rate is **≥ 60 %** across **≥ 200** calls;
  - it beats the momentum baseline;
  - the portfolio, net of trading costs, is **≥** the primary benchmark.
  - A pass licenses **a second paper month**, not real money.
- **Stop:** the 5-day hit rate is **< 55 %**.
- **In between:** extend by exactly one month with an unchanged config.
- **Context (COMPUTED):** with about 210 independent calls, 2 SE ≈ 57 % hit rate; if the effective sample halves through correlation, 2 SE ≈ 60 %. Hence the 60 % bar.

---

## 17. Data model (minimum; adjust with justification)

`instruments`, `listings`, `prices_eod`, `fx_rates`, `exchange_calendars`, `screen_verdicts`, `news_items`, `news_events`, `event_links`, `signals_daily`, `shortlists`, `decision_packets` (full JSON + hash), `llm_calls` (model, params, tokens, cost, raw output, validation result), `recommendations`, `orders_sim`, `fills_sim`, `positions`, `cash_ledger`, `predictions`, `prediction_outcomes`, `benchmark_series`, `daily_reports`, `config_snapshots`, `verification_log` (each VERIFY item: finding, source, date).

---

## 18. Scheduling and operations

There is **one daily job**, run at 08:30 Europe/Helsinki on weekdays. It executes these steps in order:

1. Ingest yesterday's EOD bars and FX.
2. Settle yesterday's simulated orders at yesterday's open, and evaluate stops and targets.
3. Score matured predictions.
4. Ingest news up to the cut-off.
5. Extract events and run the novelty checks.
6. Compute signals and the shortlist.
7. **Cut-off at 09:15** (config): freeze and hash the packet.
8. Make the decision call, validate it, and apply the rules engine.
9. Create orders to fill at today's open.
10. Write the report.

VERIFY that the cut-off precedes the opening auction on all four exchanges, and that yesterday's EOD bars are reliably available by 08:30.

- **Idempotency:** the job is safe to re-run for a given date. Re-running must not duplicate orders or change a frozen packet.
- **Failure mode:** if any step fails before the cut-off, record the day as "no decision". **Never make up a missed day retroactively.**
- **Budget alerting:** log LLM spend per day, and alert if it exceeds a configured ceiling.

---

## 19. Mandatory tests

**Golden cost tests (COMPUTED values):**
- A 1,000 € Helsinki round trip at Taso 3 costs 14.00 € (1.40 %).
- 1,500 € at Taso 3 costs 14.00 € (0.93 %).
- 5,000 € at Taso 3 costs 15.00 € (0.30 %).
- 1,000 € at Taso 1 costs 6.00 € (0.60 %).
- The Taso 3 minimum stops binding at 4,666.67 €.

**Fill tests:** gap-down through a stop, stop and target touched on the same day, an exchange holiday, and whole-share rounding.

**Leakage tests:**
- No packet contains a news item with `published_at` or `fetched_at` at or after the cut-off.
- No packet contains a price bar dated on or after the decision date.
- A fill never uses a bar dated before the decision date.

**Provenance test:** an LLM output with an injected unprovenanced number is rejected.

**Screen test:** an excluded instrument can never reach a shortlist, an order or a benchmark.

---

## 20. Milestones

Plan each milestone, wait for my approval, implement it, then summarise with provenance labels.

- **M0 — Verification and decisions (1–2 days).** Resolve every VERIFY item, record the findings in `verification_log` and `docs/verification.md`, and bring me the §21 blockers.
- **M1 — Data foundation.** Instruments, prices, FX, calendars, the universe and the liquidity filter.
- **M2 — Ethical screen.** Automatic, LLM-assisted and manual layers; a review list for me.
- **M3 — News pipeline.** Ingest, dedupe, entity linking, event extraction, novelty checks.
- **M4 — Simulator and cost model,** with the golden tests passing.
- **M5 — Signals, shortlist, decision layer and rules engine,** with the provenance and leakage tests passing.
- **M6 — Reports and scorecard.** The optional UI is discussed here and nowhere earlier.
- **M7 — Shakedown week (unscored).** Late October; fix plumbing and freeze the config.
- **M8 — Scored month.** 2–30 November 2026, hands off.
- **M9 — Post-mortem.**

---

## 21. Blockers — decisions only Vasco can make

1. **My current Nordnet tier,** used for the fixed fee tier.
2. **Natural-gas consumers:** excluded or included by the screen, and on what test.
3. **Review of borderline screen verdicts** produced in M2.
4. **Report delivery channel:** a file in the repo, email, or a read-only web page.
5. **LLM spend ceiling** per day.
6. **Whether to include First North.** Default: no.
7. **Any paid data** beyond the EODHD EOD tier, once M0 shows whether it is needed.

---

## 22. UI (optional, last)

No UI is needed for the paper month; the daily markdown report is the product. If I ask for one in M6, keep it read-only, with these screens:

- today's report;
- a portfolio and equity curve against the benchmarks;
- a prediction scorecard with calibration;
- a news event explorer linked to predictions.

I may design it in Claude Design first. If so, build to that design rather than inventing one.

---

## Appendix — sources used in this brief (accessed 2026-09-26)

| What | Source | Status |
|---|---|---|
| Nordnet Helsinki fee tiers and tier rules | https://www.nordnet.fi/palvelut/hinnasto | SOURCED |
| Nordnet FX conversion fee 0.25 % | https://sijoitusopas.com/oppaat/nordnet-hinnat-2025-kulut-selitettyna/ | UNVERIFIED (secondary) |
| EODHD plan pricing | https://eodhd.com/pricing | SOURCED |
| Börsdata API tier and update frequency | https://borsdata.se/en/info/api/api_page ; https://github.com/Borsdata-Sweden/API/wiki | SOURCED |
| Nasdaq Nordic RSS feeds and polling limit | https://subscribe.news.eu.nasdaq.com/rss | SOURCED |
| LLM news predictability, drift, decay | https://arxiv.org/abs/2304.07619 | SOURCED |
| LLM backtest memorisation / look-ahead | https://arxiv.org/pdf/2601.13770 ; https://arxiv.org/pdf/2603.23300 | SOURCED |
| Cost percentages, hurdles, power thresholds, weekday counts | computed in conversation; to be recomputed by the repo's own tests | COMPUTED |
| Liquidity threshold, slippage, position sizes, tracking error | placeholders | ASSUMED |
