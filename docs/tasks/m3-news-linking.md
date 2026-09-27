# Task: M3 — news deduplication, company linking, admissibility and novelty

Cloud agent task. **Read `docs/tasks/README.md` first**: its rules on shared files, fixtures and hand-back apply.

## Goal

The news poller already stores Nasdaq company announcements in `news_items`. Build the deterministic steps that turn them into clean, share-linked, leakage-safe input. There is no language model in this task: event extraction with Haiku is a separate task.

## Read

- `BRIEF.md`: §8 (news pipeline, steps 2, 3, 5 and 6), §19 (leakage tests)
- `docs/decisions.md`: D11, D12. `docs/verification.md`: V23 and V24 (the API has no ISIN, only company name and market).
- The stored shape: the `newsItems` table in `src/db/schema.ts`, and the parser in `supabase/functions/_shared/nasdaq-news.ts`.
- Fixtures: `nasdaq-company-news.json` (200 announcements), `nasdaq-share-lists.json` (1,082 shares with names), `sample-prices.json`.

## Build

Put the code in `src/news/` and the tests in `test/news-linking.test.ts`. Tables go in `src/db/tables/news-links.ts`.

1. **Company linking.** Map each announcement to listings using the `company` and `market` fields. There is no ISIN.
   - Normalise the names: case, punctuation, legal suffixes (Oyj, Abp, AB, AB (publ), A/S, ASA, plc and so on) and share classes.
   - Match against `fullName` in the share lists. A company with several share classes (Volvo A and B, Ericsson A and B) links to **all** its listings on that market.
   - Return every link with a method (`exact`, `normalised`, `alias`) and the matched name.
   - Unmatched announcements are kept and reported. Never force a match. They matter later for sector and macro use (brief §8.3).
   - Keep a small, committed alias list for names the rules cannot match, and give each alias a comment on why.
   - Report the match rate on the fixture in the PR. List the unmatched names, split into Main Market and First North.
2. **Deduplication (§8.2).** Flag near-duplicates: the same company and a near-identical headline within a short window. Examples are corrected reissues, or the same release in two languages that got two disclosure IDs. Flag them rather than delete, and keep the earliest item as the primary. Make the thresholds explicit (ASSUMED) and test them on fixture examples.
3. **Admissibility (§8.6).** An item may enter the decision packet for cut-off time T only if **both** `released_at < T` **and** `fetched_at < T`. It is a pure function over rows, with the cut-off passed in as a UTC instant. Also give a helper that builds T from a Helsinki date and "09:15" in Europe/Helsinki, correct across daylight-saving changes.
4. **Novelty check (§8.5).** For a linked share, compute the market-adjusted price move between the announcement and the latest available close before the cut-off: the share's return minus its exchange's equal-weight return over the same window. The input is bars only, so the function stays pure.
   - An announcement released after the close uses the next day's close.
   - If no close exists yet after the release, return `null` with a reason.
   - Document the exact window rule in code and in the PR.
5. **Table** `news_links` in `src/db/tables/news-links.ts`: disclosure ID, orderbook ID, method, matched name, duplicate-of (nullable), created at. Give it `.enableRLS()`. Write no migration.

## Tests

- Linking on the real fixture, with a minimum match rate for Main Market Helsinki, Stockholm and Copenhagen that you choose from the data and justify in the PR.
- Multi-class companies, and unmatched items kept.
- Admissibility at the boundary: exactly at T is inadmissible, including a `fetched_at` after T with a `released_at` before it.
- The cut-off helper on a daylight-saving date.
- Novelty on synthetic bars with a hand-computed answer.
