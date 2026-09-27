# Task: M4 — cost model and fill simulator

> **Done (PR #1).** Kept as the record of what was asked. Superseded in part on 2026-09-27: V2 is sourced, so SEK and DKK names use the Nordic schedule (0.25 %, minimum 10 €) and `UNVERIFIED_FEE` no longer exists; entry orders take `stopPct` and `targetPct`.

Self-contained task for a cloud agent. Everything needed is in this repository. No keys, no database and no network access are required.

## Before you start

1. Read `CLAUDE.md` (project summary and working agreement), then these sources, which this task implements:
   - `BRIEF.md` §11 (rules that touch costs), §12 (execution simulator and cost model), §19 (mandatory tests)
   - `docs/decisions.md`: D1 (Taso 4), A1 (code computes sizes), A6 (timing rules), A8 (Taso 4 figures), A9 (FX fee). Decisions win over the brief.
   - `docs/verification.md`: V1 (fee schedule and computed Taso 4 figures), V2 (Stockholm and Copenhagen fees still open), V3 (FX fee)
2. Look at existing code for style: `src/sources/nasdaq.ts`, `src/settings/settings.ts`, `test/nasdaq.test.ts`. Strict TypeScript, validate inputs, **throw rather than guess**, short comments, British English in comments and docs.
3. Branch: create `claude/m4-cost-simulator` from `claude/wizardly-goodall-0d01y8`.

## Scope

Pure functions only, with no database access and no I/O. Later milestones (M5 rules engine, M6 reports) call them.

Put the code in `src/costs/` and `src/sim/`, and the tests in `test/costs.test.ts` and `test/fills.test.ts`. Choose the file names within those folders.

### 1. Cost configuration

A typed `CostConfig` with defaults, plus a zod schema for it. Later it will move into the versioned settings (amendment A11). Do not change `src/settings/settings.ts` in this task, because that would require a database run to save a new settings version.

- **Nordnet tiers** (V1, SOURCED): Taso 1 0.06 %, min 3 €; Taso 2 0.10 %, min 5 €; Taso 3 0.15 %, min 7 €; Taso 4 0.20 %, min 9 €. The selected tier is **Taso 4** (D1).
- **Fee per order** = `max(rate × notional_eur, minimum)`.
- **Stockholm and Copenhagen** fees are unverified (V2). Use the Helsinki schedule, and mark every fee on a SEK or DKK trade with the status `UNVERIFIED_FEE`. Helsinki fees have the status `SOURCED`.
- **FX fee** 0.25 % per conversion (V3, SOURCED), on both entry and exit for SEK and DKK names. Sale proceeds are converted to EUR immediately (A6).
- **Slippage** (ASSUMED, brief §12.2), chosen by the 60-day median daily turnover in EUR:
  - 10 bps per side if the turnover is at least 5,000,000 €
  - 25 bps per side from 1,000,000 € up to, but not including, 5,000,000 €
  - below 1,000,000 €: throw, because such names are outside the universe
  - slippage is always adverse
- **Money rounding:** round each fee and each FX fee to 0.01 € (ASSUMED; note it in a comment).

### 2. Cost functions

- `orderFee(notionalEur, currency, config)`: returns the amount and a provenance status.
- `fxFee(notionalEur, currency, config)`: 0 for EUR.
- `roundTripCostPct(notionalEur, currency, medianTurnoverEur, config)`: fees on both sides, plus FX on both sides, plus slippage on both sides, as a percentage of the notional. This feeds the cost hurdle (brief §11: a BUY needs an expected move of at least 3 × this).
- `hurdlePct(...)` = 3 × `roundTripCostPct`. Make the multiplier part of the config.

### 3. Fill simulator

Inputs are an order and one daily bar in local currency: date, open, high, low, close. Bars can have null fields, and nulls must be handled explicitly, never guessed. Follow brief §12.3 and A6:

- **Entries and discretionary exits** fill at the official **open** of the decision day, with adverse slippage: a buy at `open × (1 + s)`, a sell at `open × (1 − s)`.
- **Stops:** if `low ≤ stop`, fill at `min(open, stop) × (1 − s)`. A gap down fills at the open.
- **Targets:** if `high ≥ target`, fill at `max(open, target) × (1 − s)`.
- **Stop and target on the same day:** assume the stop filled first.
- **Entry day:** stops and targets are also checked on the entry day itself, after the open fill (A6).
- **Closed exchange:** no fill. Return a "queued to the next open day" result. Pass the calendar in as data, for example a set of open dates, so the function stays pure.
- **Missing open on a trading day:** throw. No trades means no fill price, and none may be invented.
- **Whole shares:**
  - quantity = `floor(targetLocal / fillPrice)`
  - after rounding, re-check the minimum position at entry, 1,250 € (brief §11, ASSUMED), and the cash floor, 250 €
  - return a rejection with the reason, rather than a smaller trade
- **Currency:** convert with the ECB rate of the fill date, passed in as input in units per EUR. Add the FX fee on top.
- **Output:** a fill record with shares, raw price, fill price, slippage amount, fee, FX fee, net cash change in EUR, and provenance tags (`SOURCED`, `ASSUMED` or `UNVERIFIED_FEE`) for each cost component.

### 4. Tests (mandatory, brief §19 and V1)

Golden cost tests. Each must hit these exact figures:

| Case | Expected |
|---|---|
| 1,000 € Helsinki round trip, Taso 3, fees only | 14.00 € (1.40 %) |
| 1,500 €, Taso 3, fees only | 14.00 € (0.93 %) |
| 5,000 €, Taso 3, fees only | 15.00 € (0.30 %) |
| 1,000 €, Taso 1, fees only | 6.00 € (0.60 %) |
| Taso 3 minimum stops binding at | 4,666.67 € |
| 1,000 €, Taso 4, fees only | 18.00 € (1.80 %) |
| 1,500 €, Taso 4, fees only | 18.00 € (1.20 %) |
| 5,000 €, Taso 4, fees only | 20.00 € (0.40 %) |
| Taso 4 minimum stops binding at | 4,500.00 € |
| 1,500 € Helsinki, Taso 4, with 10 bps slippage per side | round trip 1.40 %, hurdle 4.20 % |
| 1,500 € SEK or DKK name, Taso 4, 10 bps, FX 0.25 % per side | round trip 1.90 %, hurdle 5.70 % |

Fill tests:
- a gap down through a stop fills at the open
- stop and target touched on the same day: the stop wins
- an exchange holiday queues the order
- whole-share rounding, including a rejection when rounding drops below 1,250 €
- a stop on the entry day itself
- adverse slippage direction for buys and sells
- a missing open throws
- turnover below 1 M€ throws
- the `UNVERIFIED_FEE` tag on SEK and DKK trades

## Checks

- `pnpm install`, `pnpm typecheck` and `pnpm test` must all pass. All existing tests must still pass.
- Do not run migrations or jobs, and do not touch `.env`. There is no database in this task.
- Do not modify files outside `src/costs/`, `src/sim/`, `test/` and the two doc updates below.
- Ignore the untracked files under `docs/` that belong to another project.

## Finish

1. Update `CLAUDE.md` in two or three lines: M4 done, where the code is, and anything left open.
2. If you find something the brief or the decisions get wrong, or a figure that does not reconcile, **do not silently fix it**. Note it in the PR description under "Questions for Vasco".
3. Commit with plain English messages, and no model identifiers in commits or code. End each message with `Co-Authored-By: Claude <noreply@anthropic.com>`.
4. Push the branch and open a **draft** pull request into `claude/wizardly-goodall-0d01y8`. The description should list what was built, the test count, deviations from this task, and open questions.
