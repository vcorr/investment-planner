# Task: M5 — deterministic market signals

Cloud agent task. **Read `docs/tasks/README.md` first**: its rules on shared files, fixtures and hand-back apply.

## Goal

Compute the daily signals in brief §9 from end-of-day data. These are pure functions. Claude sees the signals in the daily decision packet, and code uses them to pick the shortlist and to size positions. Claude never computes a number itself (brief §4).

## Read

- `BRIEF.md`: §4 (principle), §9 (signals and shortlist), §10.1 (the packet)
- `docs/decisions.md`: A1 (code sets stops and sizes from 20-day realised volatility), A13 (prices are unadjusted)
- Input data shapes: `src/sources/nasdaq.ts` (`DailyBar`) and `test/fixtures/sample-prices.json`

## Build

Put the code in `src/signals/` and the tests in `test/signals.test.ts`.

1. **Equal-weight market series per exchange.** For a given exchange and date, the daily return of an equal-weight portfolio of the given universe. Use the average of the members' close-to-close returns, counting only members with valid closes on both days. Report the member count per day, and **throw if it is zero**. The universe is an input list of orderbook IDs; for now it is the sample.
2. **Per share and date,** using only bars up to and including that date (leakage):
   - **Relative momentum** over 20, 60 and 120 trading days: the share's compounded close-to-close return minus the compounded return of its exchange's equal-weight series over the same days.
   - **Distance from the 52-week high:** close ÷ highest close over the last 250 trading days, minus 1.
   - **Volume anomaly:** the day's volume ÷ the median volume of the previous 60 trading days.
   - **Realised volatility:** the standard deviation of daily log returns over 20 trading days. Also give an annualised value, marked √252 (ASSUMED convention).
   - **Median daily turnover in EUR over 60 trading days:** convert with the ECB rate of each day. On days without an ECB rate, use the latest earlier rate, and flag how many days needed it. The cost model's slippage bands and the liquidity filter (≥ 1,000,000 €, brief §7.1) use this value.
3. **Insufficient history:** return `null` for that signal, with a reason, never a partial-window value. For example, 120-day momentum needs 121 closes.
4. **Dividends and splits (A13):** prices are unadjusted, so an ex-dividend day looks like a price drop. There is no dividend data yet. Take an optional list of adjustment events as input, and apply it if given. With none, compute on raw prices and set a flag on the output saying so. Do not invent adjustments.
5. **A snapshot function:** all signals for all shares on one date, as one typed object ready to go into the decision packet.

## Tests

- Hand-computed values on small synthetic series for every signal, including momentum relative to the market.
- Leakage: changing any bar after the date must not change that date's signals.
- Null and insufficient-history cases, a zero-member day that throws, and the ECB gap-fill counter.
- On the real fixture, for Nokia (TX50063) on 2026-09-25: assert the 20-day volatility and the 60-day median turnover against values you compute independently in the test from the raw fixture. Do not paste in precomputed numbers.

## Out of scope

- Days to the next report and the post-results window, which need a results calendar that does not exist yet.
- Insider purchases.
- Choosing the shortlist.

Note these in the PR under "For the main session".
