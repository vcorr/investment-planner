# Task: M3 — news event extraction with Claude Haiku

Cloud agent task. **Read `docs/tasks/README.md` first**: its rules on shared files, fixtures and hand-back apply.

## Goal

For each announcement, Claude Haiku returns a strict, validated JSON description of the event: what happened, which companies it affects and in which direction. This feeds the decision packet. The spillover links, meaning effects on peers, customers and suppliers, are the hypothesis Vasco most wants tested (brief §8.4).

## Read

- `BRIEF.md`: §4 (the LLM never originates a figure), §5 (stack: Anthropic TypeScript SDK, zod), §8.4 (the exact output schema), §17 (`llm_calls`)
- `docs/decisions.md`: A10 (model IDs: extraction `claude-haiku-4-5-20251001`, pinned)
- `docs/verification.md`: V19 (structured output: `client.messages.parse()` with `output_config.format` and `zodOutputFormat()`), V20 (spend estimate)
- Fixture: `nasdaq-company-news.json`. Only headlines and metadata are stored today, not the full text.

## Build

Put the code in `src/extraction/` and the tests in `test/extraction.test.ts`. Tables go in `src/db/tables/llm.ts`.

1. **Output schema.** A zod schema exactly as brief §8.4:
   - `event_type`: one of the listed values
   - `affected[]`: each with `isin`, `relation` (direct, peer, customer, supplier or competitor), `direction`, `magnitude` and `horizon_days` (1 or 5)
   - `novelty_note`
   - `evidence_quote`: 15 words or fewer, and it **must occur verbatim in the input**. Validate that in code.
2. **Prompt.**
   - A versioned system prompt in `src/extraction/prompt.ts`, with a version constant.
   - Input: headline, company, market, category, release time, and the list of candidate companies. Candidates are the linked share plus up to N peers from the same sector, taken from the share lists. The model may only use ISINs from this list.
   - The model gets no web access and no prices.
   - Instruct it to answer "other" with an empty `affected` list rather than guess.
3. **Client wrapper.** Use the official Anthropic TypeScript SDK and the structured-output method in V19.
   - **Verify the current API** against the SDK's own documentation or types before you use it. Record what you checked in the PR.
   - One retry on a validation failure, then record "no extraction".
   - A 30 s timeout.
   - Every call is logged: model ID, parameters, input and output tokens, cost, raw output, validation result and latency.
4. **Cost.** Compute it from token counts and a **sourced** price table for the model. Record the URL and access date. If you cannot source the price, mark it ASSUMED and say so.
5. **Table** `llm_calls` in `src/db/tables/llm.ts`: the brief §17 columns, plus prompt version and purpose (`extraction` or `decision`), with `.enableRLS()`. Also a table `news_events`: disclosure ID, event JSON, `llm_call` ID and prompt version. Write no migrations.
6. **A batch function** that takes admissible, linked announcements and returns events. Inject the client, so tests use a fake.

## Tests

No API key is available. Use a fake client that returns recorded responses.
- Schema acceptance and rejection, including an `evidence_quote` that is not in the input, an ISIN outside the candidate list, and too many words.
- The retry path, then "no extraction".
- Cost arithmetic from token counts.
- The prompt snapshot, so any prompt change is visible in review.

## For the main session

A live check on Vasco's Mac: run the extraction on 20 fixture announcements with the real API. Record the spend and the validation pass rate, and compare with V20's estimate.
