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

**A news poller** (Supabase Cron and an Edge Function) collects company announcements hourly. The daily job fetches once more just before the 09:15 cut-off, so every item published before it can enter that day's packet.

**A web interface on Firebase Hosting,** reading Supabase directly, visible only to you:
- performance against the benchmark;
- the prediction scorecard;
- today's report;
- settings, locked during the scored month.

**Postgres on Supabase (free plan)** holds everything: prices, news, packets, trades, predictions and versioned settings. Where each part runs: `docs/architecture.md` (decision D9, amendment A12).

## 3. Milestones and dates

Dates assume keys and network access are in place by Monday 28 September. Each milestone ends with a summary to you, labelled with provenance.

| | Milestone | Deliverables | Dates (working days) |
|---|---|---|---|
| M0 | Verification | `docs/verification.md`, decisions log | **done** |
| M1 | Data foundation | Repo and tooling; full database schema with migrations; versioned settings in the database; Nasdaq Nordic and ECB loaders; one year of price backfill; dividend and split source; exchange calendars; universe and liquidity filter; **news collection starts** | Mon 28 Sep – Fri 2 Oct (5) |
| M4 | Simulator and costs | Nordnet cost model (Taso 4, FX 0.25 %, slippage); fill rules; golden and fill tests | Mon 5 – Tue 6 Oct (2) |
| M2 | Ethical screen | Your rules in settings; industry first pass; Claude reads segment reports with quoted sources; overrides; **review list for you** | Wed 7 – Fri 9 Oct (3); your review by Wed 14 Oct |
| M3 | News pipeline | Nasdaq feeds (main and First North) and press headlines; dedupe; company linking; event extraction; novelty check; admissibility rule | Mon 12 – Thu 15 Oct (4) |
| M5 | Decision layer | Signals; shortlist; frozen packet; Sonnet call with schema and number checks; rules engine; leakage and provenance tests | Fri 16 – Wed 21 Oct (4) |
| M6a | Reports and scorecard | Daily report; scoring with the four baselines and overlap-robust errors; deployment on Cloud Run and Scheduler; spend alert | Thu 22 – Fri 23 Oct (2) |
| M7 | Shakedown | One unscored week of real runs; fix problems; **freeze settings** on Fri 30 Oct | Mon 26 – Fri 30 Oct |
| M6b | Web interface | Four pages, Google sign-in; built alongside the shakedown and finished by Wed 4 Nov. It only reads experiment data and cannot alter the run | Mon 26 Oct – Wed 4 Nov (3) |
| M8 | Scored month | Hands off. 21 decision days, no exchange holidays | Mon 2 – Mon 30 Nov |
| M9 | Verdict and post-mortem | Last 5-day calls mature Fri 4 Dec; verdict against the pre-registered criteria; ten most confident wrong calls; cost attribution | by Fri 11 Dec |

The build window from 28 September to 23 October is **20 working days** (COMPUTED), with no slack. M4 is placed before M2 because it depends on nothing else.

**If it slips past 23 October,** the scored month moves to **December 2026**: 20 decision days, closed on 24, 25 and 31 December (COMPUTED), and thin trading at the end of the month. January is the cleaner alternative. Either way, the month is announced before it starts.

**Approval gates.** The brief asks for approval of each milestone's plan. To keep you out of the loop, I propose that approving this document approves M1–M6 as described. I would stop only for the decisions listed in §5 and for anything that changes the design.

## 4. Pre-registered verdict (fixed before M8)

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
| 2 | Nordnet Taso 4 fees for Sweden and Denmark (logged-in price list) | M4 |
| 3 | LLM spend alert at $5 per day | M6a |
| 4 | Screen rules, including natural-gas consumers, and review of borderline cases | M2 |
| 5 | Optional: a design from Claude Design for the web interface | M6b |

## 6. Running costs (per month)

| Item | Cost | Basis |
|---|---|---|
| Price data (Nasdaq Nordic website API) | €0 | D10, A13; fallback EODHD €19.99 only if it breaks |
| Claude API | ≈ $30 | COMPUTED from ASSUMED volumes (verification V20) |
| Supabase Free | €0 | SOURCED, supabase.com/pricing; 500 MB database limit |
| Cloud Run job, Scheduler, Secret Manager, Firebase Hosting | expected €0, inside free allowances | COMPUTED from ASSUMED run times (A12); budget alert at €1 |

## 7. Main risks

1. **Very little trading.** At Taso 4, the hurdle is 4.2 % for Helsinki and 5.7 % for SEK and DKK names (COMPUTED). The portfolio may rarely trade. That is acceptable, because the verdict rests on predictions, not on P&L.
2. **Schedule.** 20 working days and no slack. The fallback is December or January.
3. **Unofficial price source.** The Nasdaq API has no published terms or uptime promise. The loader is swappable; EODHD is the paid fallback. Prices are unadjusted, so a dividend and split source is needed in M1.
4. **Nasdaq auction migration** (INET) on 28 September and 5 October. Opening times will be rechecked before the shakedown.
