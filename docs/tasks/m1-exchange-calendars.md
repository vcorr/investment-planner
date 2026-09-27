# Task: M1 — exchange holiday calendars

Self-contained task for a cloud agent. No keys and no database are needed. You need web access to read the exchanges' published holiday pages.

## Why

Three parts of the system depend on knowing which days each exchange trades:
- The daily job checks that yesterday's price bar has arrived.
- The fill simulator (`src/sim/fills.ts`) queues orders on closed days. It takes a set of open dates as input.
- Scoring counts 1- and 5-day horizons in trading days.

Helsinki, Stockholm and Copenhagen close on different days, so each market needs its own calendar.

## Before you start

1. Read `CLAUDE.md` (project summary and working agreement), then `docs/decisions.md` D10 and A13 (markets HEL, STO and CPH; Oslo dropped).
2. Look at existing code for style: `src/sources/nasdaq.ts`, `src/db/schema.ts`, `src/sim/fills.ts`. Strict TypeScript, validate inputs, **throw rather than guess**, short comments, British English.
3. Branch from `claude/wizardly-goodall-0d01y8`.

## Data rule (the most important part)

Every closed date and early close must come from an **official published source**: Nasdaq's own trading-calendar or holiday pages for the Nordic markets. Record the URL and your access date for each market and year.

- Do **not** fill in dates from memory, and do not compute them from holiday rules such as "Easter Monday". If you cannot reach an official source for a market or year, leave that range out, and say so in the PR under "Questions for Vasco". A calendar that says it doesn't know is safe. One that guesses is not.
- Secondary sources (news, broker pages, Wikipedia) may help you find the official page, but are not sources themselves.

## Real data to check against

`test/fixtures/trading-dates.json` lists, for HEL, STO and CPH, every date from 2025-09-01 to 2026-09-25 on which our sample shares traded. It comes from Nasdaq's price API, loaded on 2026-09-26. Any weekday in that range missing from the list had no trading. These are the weekdays without trading:

| Market | Weekdays without trading, 2025-09-01 to 2026-09-25 |
|---|---|
| HEL | 2025-12-24, 12-25, 12-26, 12-31, 2026-01-01, 01-06, 04-03, 04-06, 05-01, 05-14, 06-19 |
| STO | same as HEL |
| CPH | 2025-12-24, 12-25, 12-26, 12-31, 2026-01-01, 04-02, 04-03, 04-06, 05-14, 05-15, 05-25, 06-05 |

Your sourced calendar must agree with this fixture exactly for that range, and a test must prove it. If they disagree, do not bend either one. Report the difference.

## What to build

1. **Coverage:** HEL, STO and CPH, from **2025-09-01 to 2027-12-31**. That spans the price history, the scored month (November 2026), the fallback months and a possible extension. The earlier plan records November 2026 as having **no closures and 21 trading days** on each exchange (CLAUDE.md, "Useful facts"). Confirm it from your source and test it.
2. **Data file** `src/config/exchange-calendars.ts`: a typed, frozen constant that lists only the exceptions. Weekends are always closed. Each entry has:
   - `market`: "HEL", "STO" or "CPH"
   - `date`: YYYY-MM-DD
   - `kind`: "closed" or "early_close"
   - `closesAt`: local time "HH:MM", for early closes only
   - `note`: the holiday name as published
   - `source`: URL and access date

   Also record the covered range per market, so code can refuse dates outside it.
3. **Pure functions** in `src/calendar/trading-days.ts`, all taking the calendar as a parameter so tests can use small calendars:
   - `isTradingDay(market, date)`: an early-close day counts as a trading day
   - `tradingDays(market, from, to)`: returns a `Set<string>`, usable directly as `MarketDay.openDates` in the fill simulator
   - `previousTradingDay(market, date)` and `nextTradingDay(market, date)`
   - `expectedLatestBar(market, date)`: the last trading day strictly before `date`. The 08:30 daily job uses it to check that yesterday's bar arrived.
   - Every function **throws** for a date outside the covered range, and for a malformed date or an unknown market.
4. **Table and loader**
   - A table `exchange_calendars` in `src/db/schema.ts`: primary key (market, date), plus `kind`, `closes_at`, `note`, `source` and `loaded_at`, with `.enableRLS()`. Generate its migration with `pnpm db:generate --name exchange_calendars`.
   - A job `src/jobs/load-calendars.ts` that upserts the data file into the table, with a `job:load-calendars` script in `package.json`.
   - You cannot run the job or the migration: there is no database in your environment. The main session will run them.
5. **Tests** in `test/calendar.test.ts`:
   - The fixture cross-check. For each market and every weekday from 2025-09-01 to 2026-09-25: `isTradingDay` is true exactly when the fixture has the date.
   - November 2026: 21 trading days for each market, and no closures.
   - Weekends, early closes, previous and next trading day across a holiday run (e.g. Christmas 2026), and `expectedLatestBar` on a Monday and after a holiday.
   - Errors: an out-of-range date, a malformed date, an unknown market.
6. **Docs.** Add row V25 to `docs/verification.md` with the sources and what they confirm. Then update the "M1 progress" section of `CLAUDE.md` in two or three lines: calendars done, and anything left open.

## Checks

- `pnpm install`, `pnpm typecheck` and `pnpm test` must pass. All existing tests must still pass.
- Follow sections 1 and 2 of `.claude/skills/verify/SKILL.md`.
- Do not modify files outside those named above, apart from `package.json` (the script) and the generated migration files.
- Ignore the untracked files under `docs/` that belong to another project.

## Finish

1. Commit with plain English messages, and no model identifiers in commits or code. End each message with `Co-Authored-By: Claude <noreply@anthropic.com>`.
2. Push the branch and open a **draft** pull request into `claude/wizardly-goodall-0d01y8`. The description lists:
   - what was built, and the test count
   - the sources used, with access dates
   - any range you could not source
   - deviations from this task
   - questions for Vasco
