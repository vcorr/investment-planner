# CLAUDE.md — start here

This file carries a planning conversation held in a Claude Code web session on 2026-09-26 into any later session. Read it first, then the files it points to.

## The project in one paragraph

**Nordic Paper Trader.** A one-month, forward-only paper experiment. A simulated 5,000 € portfolio of Nasdaq Nordic shares (Helsinki, Stockholm, Copenhagen, including First North; Oslo dropped in D10) is managed every weekday by Claude, reading company news and deterministic market signals, within fixed rules and Nordnet's real Taso 4 costs. No real money and no broker. The primary verdict comes from the prediction log (market-adjusted 1- and 5-day directional calls against baselines), not from portfolio P&L.

## Files, in order of authority

1. `docs/decisions.md` — decisions and amendments agreed with Vasco. **Wins over the brief** wherever they differ.
2. `docs/PLAN.md` — the full plan: how it works, milestones with dates, verdict rules, costs, risks, open items.
3. `docs/verification.md` — verification findings (V1–V22), each with its source and status.
4. `BRIEF.md` — the original build brief, verbatim. Background and detail; read it through the amendments.
5. `docs/tasks/` — self-contained task files for cloud agents. If you were started on one, follow it.

## Working agreement (from the brief, §0)

- **Plan before code**, and wait for approval. A proposal is pending (PLAN.md §3) that approving PLAN.md approves M1–M6; Vasco has **not yet** confirmed it.
- **Never invent data.** Every figure comes from a named source, config or code. If unknown, stop and ask.
- **Label provenance:** `SOURCED` (URL + access date), `COMPUTED`, `ASSUMED`, `UNVERIFIED`.
- **Push back** plainly when something is wrong or statistically naive.
- Code and identifiers in English; **documentation and reports in British English**.
- Do not put model identifiers in commits, PRs or code comments.

## About Vasco

Preferences stated for this work:
- Reply in Finnish when written to in Finnish. In English, reply in refined, concise British English; gently correct grammar slips.
- Check the web for anything recent. State every figure with its basis. Compute decisive numbers rather than recalling them, and name the figure a conclusion depends on most.
- Vasco wants Claude to **work as independently as possible**, stopping only for real decisions.

## Status (updated 2026-09-26)

**Done:** M0 verification. M1 started on Vasco's go (see "M1 progress").

**Decisions already made** (details in `docs/decisions.md`):
- Nordnet tier **Taso 4** (0.20 %, minimum 9 €), fixed for the whole simulation.
- **First North included.** **Oslo dropped** (D10): the free price source covers Nasdaq Helsinki, Stockholm and Copenhagen only.
- Start the scored month **as soon as possible**. Target November 2026; fallback December or January.
- **Vasco sets the ethical screen rules**, including natural-gas consumers.
- All amendments A1–A13 accepted. Headlines: code computes stops, sizes and the cost hurdle; overlap-robust inference; majority-direction baseline; FX fee 0.25 % (SOURCED); settings versioned in the database; Supabase plus Google hosting (A12); Nasdaq Nordic website API for prices and sectors, no paid data (A13).
- **Web interface: build it in M6b**, after the shakedown starts. Pages: performance, predictions, today's report, settings. Google sign-in, Vasco only. Settings are editable from the page and lock during the scored month.

**Architecture agreed in discussion:**
- The experiment runs as **deterministic code on Cloud Run** (job at 08:30 Helsinki). Claude is called only through the API, with a frozen packet and no web access.
- **Hosting split (D9, A12):** Supabase Free (project `nordic-trader`, ref `mzuapexiltbhuebgyowe`, https://mzuapexiltbhuebgyowe.supabase.co) for the database, sign-in, report files and the news poller (every 4 hours); Google Cloud for the daily job, Scheduler, Secret Manager (read-only, three keys), backups and Firebase Hosting. Diagram: `docs/architecture.md`. Vasco is cost-sensitive: stay inside free allowances.
- **Claude sessions, Routines and Cowork scheduled tasks must not run the experiment itself,** because they can browse (leakage) and are not reproducible. They may sit around it as an interface: for example, a Cowork scheduled task that summarises the daily report for Vasco and takes instructions. Whether Cowork can read this private repo is UNVERIFIED.
- Any settings change during the scored month voids the month. The job must refuse to run on changed settings in that month unless Vasco explicitly ends the month.

## M1 progress (2026-09-26)

**Scope change (Vasco):** develop against a **10-share sample** (`src/config/sample.ts`), not the full universe, until the screen and settings page exist. The sample ignores the ethical screen on purpose.

**Done:**
- Scaffold: TypeScript strict, pnpm, vitest, zod, Drizzle. Migrations `0000` (M1 tables), `0001` (RLS on every table, no policies yet, so the Data API sees nothing), `0002` (settings hash no longer unique) applied to Supabase.
- Sample stored as settings version 2 (v1 still held `backfillFrom`, now a code constant). Current settings = highest id; saving settings equal to the current version is a no-op, reverting creates a new version.
- `verification_log` loaded (V1–V22).
- 268–269 daily bars per share from 2025-09-01, and ECB SEK/DKK rates, backfilled in about 12 s. Parsers reject wrong instruments, out-of-range dates, duplicate dates, non-positive prices and open/close outside [low, high]; the real data passes.
- Reviewed by a second agent before the first commit; its must-fix items are fixed.
- **News poller live since 2026-09-26 16:30 UTC.** Table `news_items` (migration `0003`), parser and paging rule in `supabase/functions/_shared/nasdaq-news.ts`, Edge Function `supabase/functions/news-poller` (deploy: `supabase functions deploy news-poller --project-ref mzuapexiltbhuebgyowe --use-api`), Supabase Cron every 4 hours (`0 */4 * * *`, UTC) calling it with the default secret key from Vault (`news_poller_url`, `news_poller_key`; set up by `pnpm job:schedule-news-poller`). Each run pages back while every in-scope item is new, up to 5 pages, and reports a gap if it never meets stored items. First run stored 893 items (16-25 Sep). **M5 requirement:** the daily job must trigger one more poll just before the 09:15 cut-off, so items published after the last scheduled run still count. Volume (16-25 Sep): about 105-125 announcements per weekday, 1-2 per weekend day; about 10 % "Inside information" or interim reports. Every run writes a row to `news_poll_runs` (migration `0004`; trigger `schedule`, `cutoff` or `manual` from the request body `{"trigger": ...}`), and rows older than 90 days are deleted (D12). Older announcements are not backfilled (D12). Supabase's own logs: `cron.job_run_details`, `net._http_response`. Pass JSON to Postgres as `${JSON.stringify(x)}::text::jsonb`; a bare `::jsonb` or `sql.json` breaks in postgres.js.

**Commands:** `pnpm db:generate`, `pnpm db:migrate`, `pnpm job:seed-sample`, `pnpm job:load-verification`, `pnpm job:backfill`, `pnpm test`, `pnpm typecheck`.

**Sandbox notes:** commands that read `.env` or reach Postgres, ECB or `mmdc` must run outside the sandbox. `vitest` also needs it (it writes `.vitest-secret-token`). `api.nasdaq.com` works inside with `allowed_domains`. Deleting files is not permitted, and `.env*` files cannot be written (so no `.env.example` yet); ask Vasco.

**Still to do in M1:**
1. Daily incremental load, with a check that the latest bar is the expected last trading day.
2. Exchange holiday calendars.
3. Free dividend and split source. Also check whether Nasdaq's history is adjusted: find a known ex-dividend or split date and record the result as a V-row.
4. Resolve: what time yesterday's bar is complete in the Nasdaq API. Announcements carry no ISIN (V23), so M3 links them to shares by company name.

**Deferred review items (not yet done):** verify Supabase's TLS certificate instead of `ssl: "require"`; for the scored month, insert new price dates only or log changed values (point-in-time audit); update `segment`, `market` and `isin` in the listings upsert when the full-universe loader arrives; `load-verification` never deletes rows removed from the markdown; the RLS-policy test promised in A12.

## M4 progress (2026-09-26)

**Done:** cost model in `src/costs/` (Taso 4 by default, FX 0.25 %, slippage bands, 3× hurdle) and fill simulator in `src/sim/fills.ts` (open fills, stops before targets, entry-day stops, whole shares, holiday queue). Pure functions; tests in `test/costs.test.ts` and `test/fills.test.ts`. Open: Stockholm and Copenhagen fees (V2, tagged `UNVERIFIED_FEE`); `CostConfig` moves into the versioned settings later (A11).

**Review changes (2026-09-27, Vasco):** entry orders carry `stopPct` and `targetPct`, and the stop and target are fixed from the entry day's actual open, so a gap down at the open can no longer buy and stop out at once. Each fill's cash change is rounded to 0.01 €.

**M5 requirements from the M4 review:** test the cost hurdle on the estimated whole-share size (from the previous close), not the intended 1,500 €. Whether Nordnet charges Swedish and Danish fees in SEK or DKK (so the fee itself pays FX) is open with V2.

**Checks:** `.claude/skills/verify/SKILL.md` (added by the M4 agent) lists measurable checks, including a mutation spot-check for cost and fill logic. Use it for cost, fill and scoring changes; it is not required for every commit.

## Waiting on Vasco

| # | Item | Needed for |
|---|---|---|
| 1 | GCP project with billing and a €1 budget alert (Supabase and Anthropic keys are in `.env`) | M6a |
| 2 | Nordnet Taso 4 fees for Sweden and Denmark (logged-in price list, Välityspalkkiot) | M4 |
| 3 | Confirm the LLM spend alert at $5 per day (estimate ≈ $1.44 per day) | M6a |
| 4 | Screen rules, including natural-gas consumers; later, the borderline review | M2 |
| 5 | Report delivery channel (web interface, possibly plus a Cowork summary) | M6 |
| 6 | Optional: a Claude Design mock-up for the web interface | M6b |
| 7 | Confirm that approving PLAN.md approves M1–M6 | now |
| 8 | `chmod 600 .env` (it is currently readable by other users on the Mac) | now |

## Useful facts

- Build window 28 Sep – 23 Oct 2026 is 20 working days, with no slack (COMPUTED).
- Taso 4 hurdle: 4.20 % for Helsinki, 5.70 % for SEK and DKK names, at 1,500 € with ASSUMED 10 bps slippage per side (COMPUTED).
- November 2026 has 21 decision days and no exchange closures (SOURCED, Nasdaq calendars).
- Nasdaq's Nordic auction migration (INET): Helsinki 28 Sep, Copenhagen and Stockholm 5 Oct 2026. Recheck opening times before the shakedown.
