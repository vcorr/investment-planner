---
name: verify
description: Checks a change in this repository against measurable evidence before it is committed or reported as done. Use after any code change, before every commit, and whenever a task file says the checks must pass. Covers the TypeScript checks, cost and fill logic, data loaders, the news poller and, later, the web interface.
---

# Verify a change

Passing the type check and tests shows the code is consistent with itself. It does not show the change does what was meant. Run every section that applies to the change, record the evidence, and fix and re-run before reporting. Report which checks ran, which were skipped and why, and the figures they produced.

## 1. Always

| Check | Command | Passes when |
|---|---|---|
| Types | `pnpm typecheck` | exit code 0 |
| Tests | `pnpm test` | exit code 0, and the test count is not lower than before the change |
| Scope | `git status --short`, `git diff --stat` | only the files the task allows have changed; no `.env*` file is staged |
| Commit text | read the message | plain English, no model identifiers, the co-author line the task asks for |

## 2. Figures a decision rests on (costs, hurdles, sizing, scoring)

- Every golden figure in `docs/verification.md` and brief §19 has a test that asserts it, **exactly** for euro amounts, and to the decimals quoted for percentages.
- **Mutation spot-check.** Copy the file to the scratchpad, make one deliberate wrong change, run only the relevant test files, and restore it with `cmp` to prove the restore. Each mutant must fail at least one test. Minimum set for `src/sim/fills.ts` and `src/costs/`:
  - target checked before stop;
  - stop fills at the stop even on a gap down;
  - slippage in the favourable direction;
  - no stop check on the entry day;
  - `Math.round` instead of `Math.floor` for shares;
  - FX fee charged on one side only;
  - cash floor ignoring fees;
  - every fee tagged `SOURCED`.
- A figure that does not reconcile with the docs is **not** fixed silently: it goes under "Questions for Vasco" in the pull request.

## 3. Data loaders and jobs (Vasco's Mac only)

These need `.env` and a route to Postgres, so they run outside the sandbox and cannot run in a cloud container (V21).

- After a price load, the newest `prices_eod.trade_date` per `orderbook_id` equals the expected last trading day for its exchange, and no share is missing.
- After an ECB load, `fx_rates` has a row for every ECB publication day in the range for SEK and DKK.
- After a news poll: the newest `news_poll_runs` row has `error` null and `gap` false, and its `inserted` count is plausible for the weekday (about 105–125 announcements on a weekday, CLAUDE.md). Supabase's own record: `cron.job_run_details` shows `succeeded`, and `net._http_response` shows status 200.
- Real data must pass the same parser checks as the fixtures; a rejection is a finding, not something to work around.

## 4. Web interface (from M6b)

Chromium is pre-installed in cloud containers (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`; never run `playwright install`).

- Start the dev server, open each page (performance, predictions, today's report, settings), and take a screenshot of each.
- The browser console has no errors on any page.
- During a scored month, the settings form is read-only: trying to save must fail, and the settings version must be unchanged afterwards.
- Pages work at phone width with no horizontal scroll.

## When a check fails

Fix the cause and run the whole section again. Never skip, disable or loosen a test to get green, and never change a golden figure to match the code.
