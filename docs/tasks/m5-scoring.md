# Task: M5 — prediction scoring and baselines

Cloud agent task. **Read `docs/tasks/README.md` first**: its rules on shared files, fixtures and hand-back apply.

## Goal

The primary verdict of the experiment comes from the prediction log, not from portfolio P&L. Build the pure statistics that score predictions against outcomes and against baselines, with honest standard errors. This module decides pass or fail, so correctness matters more than anything else here.

## Read

- `BRIEF.md`: §3 (why predictions, not P&L), §10.2 (prediction shape), §13 (scoring), §16 (success criteria)
- `docs/decisions.md`: A2 (overlap-robust inference), A3 (majority-direction baseline), A4 (scoring after maturity), and the verdict in `docs/PLAN.md` §4

## Build

Put the code in `src/scoring/` and the tests in `test/scoring.test.ts`.

1. **Outcome of a prediction.** A prediction is made on decision day D for share S, horizon h ∈ {1, 5}, with a direction (up or down) and a confidence in [0.5, 1].
   - The outcome is the sign of the **market-adjusted** return: the share's return from D's official open to the close of the h-th trading day, minus the same-exchange equal-weight universe return over the same window.
   - Inputs are the bars and a list of trading days, so the function stays pure.
   - **Ambiguity to resolve and report:** does h = 1 mean the close of D itself, or of the next trading day? Implement the brief's wording ("from the decision-day open to the close at horizon h") with h = 1 as the close of D. Make it one clearly named constant, and raise it under "Questions for Vasco".
   - A zero market-adjusted return is a tie. Count it separately; it is neither a hit nor a miss.
   - An immature prediction (horizon not yet reached) returns "pending".
   - Missing data throws.
2. **Metrics**, over any filtered set of scored predictions:
   - hit rate, and Brier score
   - calibration by confidence bucket (0.50–0.60, 0.60–0.70 and so on)
   - breakdowns by horizon, event type, relation (direct or spillover) and news or no-news. The filters are inputs.
3. **Baselines**, scored identically on the same share-days:
   - (a) coin flip: the analytic 50 %
   - (b) momentum sign: the direction of the 20-day market-adjusted return known at D
   - (c) previous-day reversal
   - (d) majority direction (A3): always the direction that turned out more common in the realised outcomes for that horizon
4. **Standard errors (A2).** For the 5-day hit rate, use overlap-robust standard errors: Newey–West with 4 lags on the daily mean hit series, clustering by decision day, meaning average within a day first. Give the 95 % interval, and the same for the **difference** between the model and each baseline, computed on paired daily differences. Report the effective sample size.
5. **Verdict function.** It applies the pre-registered rules from `docs/PLAN.md` §4 and A2 exactly and returns "PASS", "STOP" or "EXTEND", with each condition and its numbers. The portfolio condition (A5) takes the portfolio's excess return and its standard error as inputs.

## Tests

- Hand-computed small cases for every metric.
- Newey–West against a worked example you compute by hand in the test, including a series with known autocorrelation.
- Ties, pending predictions, and the h = 1 constant.
- Verdict cases around each threshold: exactly 60 %, 200 calls, a lower bound exactly 50 %, and the Stop rule below 55 %.
- A property test: shuffling the order of predictions changes nothing.

## Out of scope

Storing predictions, database tables and reports. This task delivers pure functions only.
