# Rules for task agents

Several cloud agents work in parallel, one task file each. These rules keep their branches from colliding. Your task file adds the specifics. Where the two differ, the task file wins.

## Start

1. Read `CLAUDE.md` (project summary and working agreement), `docs/decisions.md` (decisions win over `BRIEF.md`), and the brief sections your task names.
2. Branch from `claude/wizardly-goodall-0d01y8`.
3. Match the existing code style: strict TypeScript, zod for anything external, pure functions where possible, short comments, British English. Good examples: `src/sources/nasdaq.ts`, `src/costs/costs.ts`, `src/sim/fills.ts`.

## Data rules

- **Never invent data.** Every figure comes from a named source, a config value marked `ASSUMED`, or a computation in code. Validate inputs, and **throw rather than guess** on missing or odd values.
- There is **no database, no `.env` and possibly no route to Nasdaq** in your environment. Build and test against the fixtures in `test/fixtures/`:

| Fixture | Contents |
|---|---|
| `sample-prices.json` | 10 sample shares: listings, a year of daily bars (unadjusted), ECB SEK and DKK rates |
| `nasdaq-share-lists.json` | All 1,082 shares on HEL, STO and CPH: name, symbol, ISIN, orderbook ID, sector, market, segment |
| `nasdaq-company-news.json` | 200 real company announcements (Nasdaq news API) |
| `trading-dates.json` | Dates each market traded, 2025-09-01 to 2026-09-25 |
| `nasdaq-chart-download-nokia.json`, `ecb-exr.csv` | Raw API responses |

## Files you must not change

These are shared, and the main session keeps them consistent after merging:

| File | Instead |
|---|---|
| `CLAUDE.md` | Put your notes in the PR description |
| `docs/verification.md` | Propose V-rows in the PR description |
| `docs/decisions.md` | Propose decisions in the PR description |
| `docs/PLAN.md` | Propose plan changes in the PR description |
| `migrations/` | **Never run `pnpm db:generate`.** Parallel branches would clash on migration numbers |
| `src/db/schema.ts` | Define new tables in your own file under `src/db/tables/` (e.g. `src/db/tables/calendars.ts`), with `.enableRLS()`. The main session generates the migrations after merging |
| `src/settings/settings.ts` | Only the settings-page task may change it |

`package.json` and `pnpm-lock.yaml`: add dependencies or scripts only if your task needs them. The main session resolves lockfile conflicts.

## Checks before you finish

- `pnpm install`, `pnpm typecheck` and `pnpm test` pass, and every existing test still passes.
- Follow sections 1 and 2 of `.claude/skills/verify/SKILL.md`.
- Only the files your task allows have changed (`git diff --stat`).

## Hand back

1. Commit with plain English messages, and no model identifiers in commits or code. End each message with `Co-Authored-By: Claude <noreply@anthropic.com>`.
2. Push your branch and open a **draft** pull request into `claude/wizardly-goodall-0d01y8`. The description should contain:
   - **Built:** what, where, and the test count.
   - **For the main session:** new tables, scripts, dependencies, proposed V-rows, and anything that must run on Vasco's Mac, such as migrations, deploys or live checks.
   - **Deviations** from the task file.
   - **Questions for Vasco:** anything in the brief or decisions that looks wrong, or a figure that does not reconcile. Do not silently fix these.
