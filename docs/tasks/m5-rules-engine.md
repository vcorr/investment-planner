# Task: M5 — rules engine

Cloud agent task. **Read `docs/tasks/README.md` first**: its rules on shared files, fixtures and hand-back apply.

## Goal

Claude proposes, and code disposes (brief §10.3). Build the pure rules engine. It takes Claude's proposed actions, the portfolio and the market data, and returns the orders that are allowed, each rejection with its reason, and the stop, target, size and time stop that code sets for every entry.

## Read

- `BRIEF.md`: §10.2 (Claude's output), §11 (rules), §12.3 (fills)
- `docs/decisions.md`: A1 (code computes every trade number), A6 (timing), A8 (Taso 4 figures)
- `CLAUDE.md`: "M4 progress", in particular the M5 requirements from the M4 review
- The code this engine uses: `src/costs/` (`roundTripCostPct`, `hurdlePct`) and `src/sim/fills.ts` (`EntryOrder` takes `stopPct` and `targetPct`)

## Build

Put the code in `src/rules/` and the tests in `test/rules.test.ts`.

1. **`RulesConfig`** with defaults and a zod schema, in the style of `src/costs/config.ts`. Every default is ASSUMED unless the brief says otherwise:
   - at most 3 positions; target position 1,500 €; minimum at entry 1,250 €
   - at most 2 positions per sector; cash floor 250 €
   - at most 1 new position per day; at most 8 round trips per calendar month
   - hurdle multiplier: from the cost config
   - Do not put it into the versioned settings. The settings-page task owns `src/settings/settings.ts`.
2. **Trade numbers set by code (A1).**
   - From 20-day realised volatility σ (daily) and horizon h, set `stopPct`, `targetPct` and the time stop in trading days.
   - The expected move comes from Claude's confidence c, roughly `(2c − 1) × σ × √h` (A1).
   - The exact mapping is not fixed yet. Implement it as named, configurable formulas with ASSUMED multipliers, and **list your proposed multipliers under "Questions for Vasco"**, with a worked example.
3. **Hurdle on the real size** (M4 review requirement):
   - Estimate the whole-share quantity from the previous close and the ECB rate.
   - Test the hurdle on that estimated notional, not on the intended 1,500 €.
   - Reject if the expected move is below `hurdlePct` at that size.
4. **Evaluation order**, applied to the proposed actions in a fixed, documented order:
   1. The screen: only shortlisted, screen-passed names.
   2. SELL triggers (§11): falsification met (a boolean input, evaluated elsewhere), stop hit, time stop expired, screen failed, and a better use of the slot that clears the hurdle **net of the exit cost**.
   3. BUY checks: position cap, sector cap, opening pace, monthly turnover cap, cash floor after costs, minimum position after rounding, and the hurdle.
   4. KEEP is the default.

   Return every decision with a machine-readable reason code and the figures it used.
5. **Output:** `EntryOrder` values ready for `simulateEntry`, exit instructions for `simulateExit`, and a full audit list (accepted and rejected, with reasons).

## Tests

- Each rule on its own: at the limit, just over and just under.
- The hurdle on the rounded size: a case where the intended size passes and the rounded size fails.
- A SELL for a better use of the slot, net of the exit cost.
- Determinism: the same inputs always give the same output and order.
- A SEK case that uses the Nordic fee schedule.

## Out of scope

Calling Claude, the decision packet, and the database.
