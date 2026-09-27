// Anthropic API prices, used to cost every call from its token counts (brief §5, §17).
// SOURCED: https://platform.claude.com/docs/en/about-claude/pricing, accessed 2026-09-27 ("Model pricing" table,
// USD per million tokens; standard API, no batch discount). Cache reads are 0.1× the input price for both models.

export const PRICE_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing, accessed 2026-09-27";

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWrite5mPerMTok: number;
  cacheWrite1hPerMTok: number;
  cacheReadPerMTok: number;
}

/** Keyed by the exact model ID sent in the request. A model not listed here cannot be costed and throws. */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  // Claude Haiku 4.5; the dated ID is the pinned extraction model (A10).
  "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5, cacheWrite5mPerMTok: 1.25, cacheWrite1hPerMTok: 2, cacheReadPerMTok: 0.1 },
  // Claude Sonnet 5, the decision model (A10). The page states $2 / $10 is now the standard price.
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10, cacheWrite5mPerMTok: 2.5, cacheWrite1hPerMTok: 4, cacheReadPerMTok: 0.2 },
};

/** The token counts in a Messages API `usage` object that affect the price. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null;
}

/** Cost in USD, rounded to 1e-8 (the precision of `llm_calls.cost_usd`). */
export function callCostUsd(model: string, usage: TokenUsage): number {
  const price = MODEL_PRICES[model];
  if (!price) throw new Error(`Pricing: no sourced price for model "${model}"`);
  const counts = [usage.input_tokens, usage.output_tokens, usage.cache_creation_input_tokens ?? 0, usage.cache_read_input_tokens ?? 0];
  if (counts.some((n) => !Number.isInteger(n) || n < 0)) throw new Error(`Pricing: bad token counts ${JSON.stringify(usage)}`);
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  let write5m = 0;
  let write1h = 0;
  if (cacheWrite > 0) {
    // The two TTLs are priced differently; without the split the cost is unknown, so do not guess.
    if (!usage.cache_creation) throw new Error("Pricing: cache writes reported without the 5-minute / 1-hour split");
    write5m = usage.cache_creation.ephemeral_5m_input_tokens;
    write1h = usage.cache_creation.ephemeral_1h_input_tokens;
    if (write5m + write1h !== cacheWrite) throw new Error(`Pricing: cache write split ${write5m} + ${write1h} does not add up to ${cacheWrite}`);
  }
  // Price per MTok × tokens gives micro-dollars.
  const micro =
    usage.input_tokens * price.inputPerMTok +
    usage.output_tokens * price.outputPerMTok +
    write5m * price.cacheWrite5mPerMTok +
    write1h * price.cacheWrite1hPerMTok +
    (usage.cache_read_input_tokens ?? 0) * price.cacheReadPerMTok;
  return Math.round(micro * 100) / 1e8;
}
