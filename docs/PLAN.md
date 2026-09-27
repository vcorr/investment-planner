# Nordic Paper Trader — plan

Status as of 2026-09-26. Sources: `BRIEF.md` (the brief), `docs/decisions.md` (decisions and amendments, which take precedence) and `docs/verification.md` (M0 findings).

## 1. What it is

A one-month, forward-only paper experiment. A simulated 5,000 € portfolio of Nasdaq Nordic shares (Helsinki, Stockholm, Copenhagen) is managed every weekday by Claude, reading company news and market signals, within fixed rules and Nordnet's real Taso 4 costs. No real money and no broker.

The question it answers: are Claude's market-adjusted 5-day predictions better than chance and better than simple baselines, and can the portfolio keep pace with the market after costs?

## 2. How it works

**Every weekday at 08:30 Helsinki time, a job on Cloud Run:**
1. loads yesterday's prices (Nasdaq Nordic, free) and ECB exchange rates;
2. settles yesterday's simulated trades and scores predictions that have matured;
3. collects news up to the 09:15 cut-off and extracts events (Claude Haiku);
4. computes signals and picks 10 names to predict;
5. freezes a decision packet and fingerprints it;
6. asks Claude Sonnet for predictions and trade proposals, with no web access;
7. applies the rules (code sets stops, sizes and the cost hurdle) and simulates the orders;
8. writes the daily report.

**A news poller** (Supabase Cron and an Edge Function) collects company announcements every 4 hours. The daily job fetches once more just before the 09:15 cut-off, so every item published before it can enter that day's packet.

**A web interface on Firebase Hosting,** reading Supabase directly, visible only to you:
- performance against the benchmark;
- the prediction scorecard;
- today's report;
- settings, locked during the scored month.

**Postgres on Supabase (free plan)** holds everything: prices, news, packets, trades, predictions and versioned settings. Where each part runs: `docs/architecture.md` (decision D9, amendment A12).

## 3. Milestones and order

No fixed dates (Vasco, 2026-09-27). The milestones keep their order. The scored month is the first full calendar month after a completed shakedown week, announced before it starts (D4). Each milestone ends with a summary to Vasco, labelled with provenance. Development uses the 10-share sample until the screen and settings page exist.

| | Milestone | Deliverables | Status (2026-09-27) |
|---|---|---|---|
| M0 | Verification | `docs/verification.md`, decisions log | Done |
| M1 | Data foundation | Repo and tooling; schema and migrations; versioned settings; Nasdaq Nordic and ECB loaders; price backfill; news collection; exchange calendars; daily price load; dividend and split source; universe and liquidity filter | Mostly done; calendars are a cloud task |
| M2 | Ethical screen | **Settings page for Vasco's rules** (moved forward from M6b); industry first pass; Claude reads segment reports with quoted sources; overrides; review list | Settings page is a cloud task |
| M3 | News pipeline | Collection (live); dedupe; company linking; admissibility; novelty check; event extraction; press headlines | Collection live; two cloud tasks |
| M4 | Simulator and costs | Nordnet cost model (Taso 4, sourced Nordic fees, FX 0.25 %, slippage); fill rules; golden and fill tests | Done |
| M5 | Decision layer | Signals; shortlist; frozen packet; Sonnet call with schema and number checks; rules engine; scoring; leakage and provenance tests | Signals, rules engine and scoring are cloud tasks |
| M6a | Reports and deployment | Daily report; scorecard; Cloud Run and Scheduler; spend alert | Needs the GCP project |
| M6b | Web interface | Performance, predictions, today's report, in the same app as the settings page | Later |
| M7 | Shakedown | One unscored week of real runs; fix problems; freeze settings | — |
| M8 | Scored month | Hands off; one full calendar month | — |
| M9 | Verdict and post-mortem | When the last 5-day calls mature; verdict against the pre-registered criteria; ten most confident wrong calls; cost attribution | — |

**Parallel work.** Independent tasks for cloud agents are in `docs/tasks/`, with shared rules in `docs/tasks/README.md`:

| Task file | Milestone | Depends on |
|---|---|---|
| `m1-exchange-calendars.md` | M1 | — |
| `m2-settings-page.md` | M2 | — |
| `m3-news-linking.md` | M3 | — |
| `m3-event-extraction.md` | M3 | — (uses a fake client; the live check runs on Vasco's Mac) |
| `m5-signals.md` | M5 | — |
| `m5-rules-engine.md` | M5 | M4 (merged) |
| `m5-scoring.md` | M5 | — |

After these are merged: the shortlist, the frozen decision packet and the Sonnet decision call (M5), which join the pieces together.

**Approval gates.** The brief asks for approval of each milestone's plan. To keep you out of the loop, I propose that approving this document approves M1–M6 as described. I would stop only for the decisions listed in §5 and for anything that changes the design.

## 4. Pre-registered verdict (fixed before the scored month)

- **Pass:** all of the following.
  - The 5-day hit rate is ≥ 60 % over ≥ 200 matured calls.
  - The lower 95 % bound of the hit rate is above 50 %.
  - It beats the momentum and majority-direction baselines.
  - The portfolio, net of costs, is not below the benchmark by more than 2 SE.
  - A pass earns a second paper month, not real money.
- **Stop:** the 5-day hit rate is below 55 %.
- **Otherwise:** one more month with the same settings.

## 5. Waiting on you

| # | Item | Needed by |
|---|---|---|
| 1 | GCP project with billing and a €1 budget alert (Supabase and Anthropic are done) | M6a |
| 2 | LLM spend alert at $5 per day | M6a |
| 3 | Screen rules, including natural-gas consumers, and review of borderline cases | M2 |
| 4 | Optional: a design from Claude Design for the web interface | M6b |

## 6. Running costs (per month)

| Item | Cost | Basis |
|---|---|---|
| Price data (Nasdaq Nordic website API) | €0 | D10, A13; fallback EODHD €19.99 only if it breaks |
| Claude API | ≈ $30 | COMPUTED from ASSUMED volumes (verification V20) |
| Supabase Free | €0 | SOURCED, supabase.com/pricing; 500 MB database limit |
| Cloud Run job, Scheduler, Secret Manager, Firebase Hosting | expected €0, inside free allowances | COMPUTED from ASSUMED run times (A12); budget alert at €1 |

## 7. Main risks

1. **Very little trading.** At Taso 4, the hurdle is 4.2 % for Helsinki and 6.1 % for SEK and DKK names (COMPUTED, V2). The portfolio may rarely trade. That is acceptable, because the verdict rests on predictions, not on P&L.
2. **Unofficial price source.** The Nasdaq API has no published terms or uptime promise. The loader is swappable; EODHD is the paid fallback. Prices are unadjusted, so a dividend and split source is needed in M1.
3. **Nasdaq auction migration** (INET) on 28 September and 5 October. Opening times will be rechecked before the shakedown.
