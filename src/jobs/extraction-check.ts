import { readFileSync } from "node:fs";
import { z } from "zod";
import { loadEnv } from "../config/env.js";
import { shareRowSchema } from "../extraction/candidates.js";
import { EXTRACTION_MODEL, anthropicMessagesClient, extractEvents, type ExtractionItem, type LlmCallRecord } from "../extraction/extract.js";
import { MODEL_PRICES } from "../extraction/pricing.js";
import { CHECK_SET, CHECK_SET_SOURCE } from "../extraction/check-set.js";
import { utcIso } from "../../supabase/functions/_shared/nasdaq-news.js";

// Live check of event extraction on 20 fixture announcements with the real API (task M3, "For the main
// session"). Spends real money: about 20-40 calls to the extraction model. Writes nothing to the database;
// the output goes to stdout as JSON lines, then a summary.

const env = loadEnv();
if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");

const newsSchema = z.object({
  results: z.object({
    item: z.array(
      z.object({
        disclosureId: z.number(),
        company: z.string().nullable(),
        market: z.string(),
        cnsCategory: z.string().nullable(),
        headline: z.string(),
        releaseTime: z.string(),
      }),
    ),
  }),
});
const news = newsSchema.parse(JSON.parse(readFileSync(CHECK_SET_SOURCE.news, "utf8"))).results.item;
const shares = z.object({ shares: z.array(shareRowSchema) }).parse(JSON.parse(readFileSync(CHECK_SET_SOURCE.shares, "utf8"))).shares;

const items: ExtractionItem[] = CHECK_SET.map(({ disclosureId, linkedIsins }) => {
  const n = news.find((x) => x.disclosureId === disclosureId);
  if (!n) throw new Error(`Check set: ${disclosureId} is not in the fixture`);
  return {
    disclosureId,
    company: n.company,
    market: n.market,
    category: n.cnsCategory,
    headline: n.headline,
    body: null,
    releasedAt: utcIso(n.releaseTime),
    linkedIsins: [...linkedIsins],
  };
});

const calls: LlmCallRecord[] = [];
const results = await extractEvents(items, {
  client: anthropicMessagesClient(env.ANTHROPIC_API_KEY),
  recordCall: async (record) => {
    calls.push(record);
    console.log(JSON.stringify({ call: calls.length, ...record }));
    return calls.length;
  },
  shares,
});
for (const r of results) console.log(JSON.stringify({ result: r }));

const sum = (f: (c: LlmCallRecord) => number | null) => calls.reduce((s, c) => s + (f(c) ?? 0), 0);
const price = MODEL_PRICES[EXTRACTION_MODEL]!;
// V20: 1,500 input and 300 output tokens per item (ASSUMED there).
const v20PerItem = (1_500 * price.inputPerMTok + 300 * price.outputPerMTok) / 1e6;
const totalCost = sum((c) => c.costUsd);
console.log(
  JSON.stringify(
    {
      summary: {
        model: EXTRACTION_MODEL,
        items: items.length,
        extractedFirstTry: results.filter((r) => r.status === "extracted" && r.attempts === 1).length,
        extractedOnRetry: results.filter((r) => r.status === "extracted" && r.attempts === 2).length,
        noExtraction: results.filter((r) => r.status === "no_extraction").length,
        calls: calls.length,
        callsValid: calls.filter((c) => c.validation === "valid").length,
        inputTokensPerItem: sum((c) => c.inputTokens) / items.length,
        outputTokensPerItem: sum((c) => c.outputTokens) / items.length,
        costUsd: totalCost,
        costPerItemUsd: totalCost / items.length,
        v20CostPerItemUsd: v20PerItem,
        meanLatencyMs: sum((c) => c.latencyMs) / calls.length,
      },
    },
    null,
    2,
  ),
);
