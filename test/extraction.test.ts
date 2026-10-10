import { readFileSync } from "node:fs";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { utcIso } from "../supabase/functions/_shared/nasdaq-news.js";
import { buildCandidates, shareRowSchema, type ShareRow } from "../src/extraction/candidates.js";
import { CHECK_SET } from "../src/extraction/check-set.js";
import {
  EXTRACTION_MODEL,
  MAX_ATTEMPTS,
  TIMEOUT_MS,
  extractEvents,
  extractOne,
  newsEventRow,
  type ExtractionDeps,
  type ExtractionItem,
  type LlmCallRecord,
  type MessagesClient,
} from "../src/extraction/extract.js";
import { MODEL_PRICES, callCostUsd } from "../src/extraction/pricing.js";
import { PROMPT_VERSION, SYSTEM_PROMPT, buildRetryMessage, buildUserMessage, sourceText } from "../src/extraction/prompt.js";
import { checkExtraction, extractionSchema, type Extraction, type ValidationContext } from "../src/extraction/schema.js";

// ---- Fixtures ---------------------------------------------------------------------------------------------

const shares: ShareRow[] = z
  .object({ shares: z.array(shareRowSchema) })
  .parse(JSON.parse(readFileSync("test/fixtures/nasdaq-share-lists.json", "utf8"))).shares;

const newsItemSchema = z.object({
  disclosureId: z.number(),
  company: z.string().nullable(),
  market: z.string(),
  cnsCategory: z.string().nullable(),
  headline: z.string(),
  releaseTime: z.string(),
});
const news = z
  .object({ results: z.object({ item: z.array(newsItemSchema) }) })
  .parse(JSON.parse(readFileSync("test/fixtures/nasdaq-company-news.json", "utf8"))).results.item;

function fixtureItem(disclosureId: number, linkedIsins: string[]): ExtractionItem {
  const n = news.find((x) => x.disclosureId === disclosureId);
  if (!n) throw new Error(`fixture has no ${disclosureId}`);
  return {
    disclosureId,
    company: n.company,
    market: n.market,
    category: n.cnsCategory,
    headline: n.headline,
    body: null,
    releasedAt: utcIso(n.releaseTime),
    linkedIsins,
  };
}

const PIHLAJALINNA = "FI4000092556";
const TROPHY = "DK0061537206";
const PARADOX = "SE0008294953";
/** "Inside information: Pihlajalinna negotiating an acquisition to expand its operations into Central Uusimaa" */
const pihlajalinna = fixtureItem(1465331, [PIHLAJALINNA]);
/** "Trophy Games Acquires Playrion SASU from Paradox Interactive and Upgrades Full-Year 2026 Guidance" */
const trophy = fixtureItem(1465278, [TROPHY]);

const validPihlajalinna: Extraction = {
  event_type: "m_and_a",
  affected: [{ isin: PIHLAJALINNA, relation: "direct", direction: "pos", magnitude: "low", horizon_days: 5 }],
  novelty_note: "Negotiations were not announced before.",
  evidence_quote: "Pihlajalinna negotiating an acquisition to expand its operations into Central Uusimaa",
};

// ---- Fake client: hand-written replies in the Messages API shape (no API key in this environment) ---------

function reply(text: string, overrides: Partial<Pick<Message, "stop_reason">> & { input?: number; output?: number } = {}): Message {
  return {
    id: `msg_fake_${text.length}`,
    type: "message",
    role: "assistant",
    model: EXTRACTION_MODEL,
    container: null,
    content: [{ type: "text", text, citations: null }],
    stop_reason: overrides.stop_reason ?? "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: overrides.input ?? 1_500,
      output_tokens: overrides.output ?? 300,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: "standard",
    },
  } as Message;
}

class FakeClient implements MessagesClient {
  readonly requests: Array<{ params: Omit<MessageCreateParamsNonStreaming, "output_config">; formatType: string | undefined; options: { timeout: number } }> = [];
  constructor(private readonly replies: Array<Message | Error>) {}
  async create(params: MessageCreateParamsNonStreaming, options: { timeout: number }): Promise<Message> {
    // The output format carries a parse function, which structuredClone cannot copy.
    const { output_config, ...rest } = params;
    this.requests.push({ params: structuredClone(rest), formatType: output_config?.format?.type, options });
    const next = this.replies.shift();
    if (!next) throw new Error("FakeClient: no reply left");
    if (next instanceof Error) throw next;
    return next;
  }
}

function harness(replies: Array<Message | Error>, extra: Partial<ExtractionDeps> = {}) {
  const client = new FakeClient(replies);
  const records: LlmCallRecord[] = [];
  let t = 1_000_000;
  const deps: ExtractionDeps = {
    client,
    recordCall: async (r) => {
      records.push(r);
      return records.length;
    },
    shares,
    clock: () => (t += 250),
    ...extra,
  };
  return { client, records, deps };
}

const contextFor = (item: ExtractionItem, candidateIsins: string[]): ValidationContext => ({
  sourceText: sourceText(item),
  candidateIsins: new Set(candidateIsins),
  linkedIsins: new Set(item.linkedIsins),
});

// ---- Output schema ----------------------------------------------------------------------------------------

describe("extraction schema (brief §8.4)", () => {
  it("accepts a well-formed event", () => {
    expect(extractionSchema.parse(validPihlajalinna)).toEqual(validPihlajalinna);
  });

  it.each([
    ["an unknown event type", { event_type: "rumour" }],
    ["an unknown relation", { affected: [{ ...validPihlajalinna.affected[0], relation: "partner" }] }],
    ["a direction outside pos, neg, unclear", { affected: [{ ...validPihlajalinna.affected[0], direction: "up" }] }],
    ["magnitude spelt out", { affected: [{ ...validPihlajalinna.affected[0], magnitude: "medium" }] }],
    ["a horizon other than 1 or 5", { affected: [{ ...validPihlajalinna.affected[0], horizon_days: 3 }] }],
    ["a malformed ISIN", { affected: [{ ...validPihlajalinna.affected[0], isin: "FI400009255" }] }],
    ["an empty novelty note", { novelty_note: "" }],
    ["an empty quote", { evidence_quote: "" }],
  ])("rejects %s", (_, change) => {
    expect(extractionSchema.safeParse({ ...validPihlajalinna, ...change }).success).toBe(false);
  });

  it("rejects a missing field", () => {
    const { novelty_note: _, ...rest } = validPihlajalinna;
    expect(extractionSchema.safeParse(rest).success).toBe(false);
  });

  it("allows 15 words in the quote but not 16", () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    expect(extractionSchema.safeParse({ ...validPihlajalinna, evidence_quote: words(15) }).success).toBe(true);
    const sixteen = extractionSchema.safeParse({ ...validPihlajalinna, evidence_quote: words(16) });
    expect(sixteen.success).toBe(false);
    expect(sixteen.error?.issues[0]?.message).toBe("evidence_quote has more than 15 words");
  });
});

describe("checks against the input", () => {
  const context = contextFor(pihlajalinna, [PIHLAJALINNA, "FI0009013403"]);

  it("passes a valid event", () => {
    expect(checkExtraction(validPihlajalinna, context)).toEqual([]);
  });

  it("rejects a quote that is not in the announcement", () => {
    const e = { ...validPihlajalinna, evidence_quote: "Pihlajalinna agrees to acquire a clinic" };
    expect(checkExtraction(e, context)).toEqual(["evidence_quote does not occur verbatim in the announcement"]);
  });

  it("rejects a quote with different case, but forgives whitespace and Unicode composition", () => {
    expect(checkExtraction({ ...validPihlajalinna, evidence_quote: "pihlajalinna negotiating an acquisition" }, context)).toHaveLength(1);
    expect(checkExtraction({ ...validPihlajalinna, evidence_quote: "  negotiating an\nacquisition   to expand " }, context)).toEqual([]);
    const finnish = { ...pihlajalinna, headline: "Sisäpiiritieto: Pihlajalinna neuvottelee yrityskaupasta" };
    const decomposed = "Sisäpiiritieto: Pihlajalinna"; // "ä" as a plus combining diaeresis
    expect(checkExtraction({ ...validPihlajalinna, evidence_quote: decomposed }, contextFor(finnish, [PIHLAJALINNA]))).toEqual([]);
  });

  it("does not accept a quote taken from the metadata or the candidate list", () => {
    // "Pihlajalinna Oyj" is the share list name, not text of the announcement.
    expect(checkExtraction({ ...validPihlajalinna, evidence_quote: "Pihlajalinna Oyj" }, context)).toHaveLength(1);
    expect(checkExtraction({ ...validPihlajalinna, evidence_quote: "Inside information" }, context)).toEqual([]);
  });

  it("rejects an ISIN outside the candidate list", () => {
    const outside = "SE0000108656"; // a real share, but not offered as a candidate
    const e = { ...validPihlajalinna, affected: [...validPihlajalinna.affected, { ...validPihlajalinna.affected[0]!, isin: outside, relation: "peer" as const }] };
    expect(checkExtraction(e, context)).toEqual([`affected[1]: ISIN ${outside} is not in the candidate list`]);
  });

  it('keeps "direct" for the announcing company only', () => {
    const peerAsDirect = { ...validPihlajalinna, affected: [...validPihlajalinna.affected, { ...validPihlajalinna.affected[0]!, isin: "FI0009013403" }] };
    expect(checkExtraction(peerAsDirect, context)).toEqual(["affected[1]: FI0009013403 is not the announcing company, so relation cannot be direct"]);
    const announcerAsPeer = { ...validPihlajalinna, affected: [{ ...validPihlajalinna.affected[0]!, relation: "peer" as const }] };
    expect(checkExtraction(announcerAsPeer, context)).toEqual([`affected[0]: ${PIHLAJALINNA} is the announcing company, so relation must be direct`]);
  });

  it('requires an empty affected list with "other"', () => {
    expect(checkExtraction({ ...validPihlajalinna, event_type: "other" }, context)).toEqual(['event_type "other" must have an empty affected list']);
    expect(checkExtraction({ ...validPihlajalinna, event_type: "other", affected: [] }, context)).toEqual([]);
  });

  it("allows one entry per company and horizon", () => {
    const a = validPihlajalinna.affected[0]!;
    expect(checkExtraction({ ...validPihlajalinna, affected: [a, { ...a, horizon_days: 1 }] }, context)).toEqual([]);
    expect(checkExtraction({ ...validPihlajalinna, affected: [a, a] }, context)).toEqual([`affected[1]: ${PIHLAJALINNA} appears twice for horizon 5`]);
  });
});

// ---- Candidates -------------------------------------------------------------------------------------------

describe("candidate companies", () => {
  it("puts the announcer first, then up to N peers from the same sector, each ISIN once", () => {
    const c = buildCandidates([PIHLAJALINNA], shares, { maxPeers: 5 });
    expect(c).toHaveLength(6);
    expect(c[0]).toMatchObject({ isin: PIHLAJALINNA, role: "announcer", sector: "Health Care", markets: ["HEL"] });
    expect(c.slice(1).every((x) => x.role === "peer" && x.sector === "Health Care")).toBe(true);
    expect(new Set(c.map((x) => x.isin)).size).toBe(6);
    // Without liquidity figures, peers on the announcer's market come first.
    expect(c.slice(1).every((x) => x.markets.includes("HEL"))).toBe(true);
  });

  it("lists a share traded on several markets once, with all its markets", () => {
    const nordea = buildCandidates(["FI4000297767"], shares, { maxPeers: 0 });
    expect(nordea).toEqual([
      { isin: "FI4000297767", name: "Nordea Bank Abp", markets: ["HEL", "STO", "CPH"], segment: "MAIN_MARKET", sector: "Financials", role: "announcer" },
    ]);
  });

  it("ranks peers by liquidity when figures are given, missing figures last", () => {
    const liquidityEur = new Map([
      [PARADOX, 9_000_000],
      ["SE0012673267", 50_000_000], // Evolution
    ]);
    const c = buildCandidates([TROPHY], shares, { maxPeers: 3, liquidityEur });
    expect(c.map((x) => x.isin).slice(0, 3)).toEqual([TROPHY, "SE0012673267", PARADOX]);
    expect(c[3]?.markets).toContain("CPH");
  });

  it("links every class of a multi-class company as announcer", () => {
    const c = buildCandidates(["FI0009007900", "FI0009000202"], shares, { maxPeers: 2 });
    expect(c.filter((x) => x.role === "announcer").map((x) => x.name)).toEqual(["Kesko Oyj A", "Kesko Oyj B"]);
  });

  it("throws on an unknown or missing linked share", () => {
    expect(() => buildCandidates(["FI0000000000"], shares)).toThrow("not in the share lists");
    expect(() => buildCandidates([], shares)).toThrow("at least one linked share");
  });
});

// ---- Prompt snapshot --------------------------------------------------------------------------------------

describe("prompt", () => {
  it("matches the reviewed snapshot (bump PROMPT_VERSION when it changes)", async () => {
    const candidates = buildCandidates(trophy.linkedIsins, shares, { maxPeers: 3, liquidityEur: new Map([[PARADOX, 9_000_000]]) });
    const text = [
      `PROMPT_VERSION: ${PROMPT_VERSION}`,
      "",
      "=== system ===",
      SYSTEM_PROMPT,
      "",
      "=== user ===",
      buildUserMessage(trophy, candidates),
      "",
      "=== retry ===",
      buildRetryMessage(["evidence_quote does not occur verbatim in the announcement"]),
      "",
      "=== output schema sent to the API (from zodOutputFormat) ===",
      JSON.stringify(zodOutputFormat(extractionSchema).schema, null, 2),
      "",
    ].join("\n");
    await expect(text).toMatchFileSnapshot("./snapshots/extraction-prompt.txt");
  });

  it("gives the model the announcement fields and no prices", () => {
    const msg = buildUserMessage(pihlajalinna, buildCandidates([PIHLAJALINNA], shares, { maxPeers: 1 }));
    expect(msg).toContain("Company: Pihlajalinna Oyj");
    expect(msg).toContain("Market: Main Market, Helsinki");
    expect(msg).toContain("Category: Inside information");
    expect(msg).toContain(`Released: ${pihlajalinna.releasedAt.slice(0, 10)} `);
    expect(msg).toContain(`1. ${PIHLAJALINNA} | Pihlajalinna Oyj | HEL Main Market | Health Care | ANNOUNCER`);
    expect(msg).not.toMatch(/€|EUR|price|close/i);
  });

  it("refuses a release time that is not UTC", () => {
    expect(() => buildUserMessage({ ...pihlajalinna, releasedAt: "2026-09-25 06:30:00" }, [])).toThrow("not a UTC ISO timestamp");
  });
});

// ---- Client wrapper ---------------------------------------------------------------------------------------

describe("extraction call", () => {
  it("sends one pinned, tool-free request with a 30 s timeout and logs it", async () => {
    const { client, records, deps } = harness([reply(JSON.stringify(validPihlajalinna))]);
    const result = await extractOne(pihlajalinna, deps);

    expect(result).toEqual({ disclosureId: 1465331, status: "extracted", event: validPihlajalinna, llmCallId: 1, promptVersion: PROMPT_VERSION, attempts: 1 });
    expect(client.requests).toHaveLength(1);
    const { params, formatType, options } = client.requests[0]!;
    expect(options).toEqual({ timeout: TIMEOUT_MS });
    expect(formatType).toBe("json_schema");
    expect(params.model).toBe("claude-haiku-4-5-20251001");
    expect(params.temperature).toBe(0);
    expect(params.system).toBe(SYSTEM_PROMPT);
    expect(params).not.toHaveProperty("tools");
    expect(params.messages).toHaveLength(1);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      purpose: "extraction",
      model: "claude-haiku-4-5-20251001",
      promptVersion: PROMPT_VERSION,
      subject: "news:1465331",
      attempt: 1,
      latencyMs: 250,
      responseId: expect.stringMatching(/^msg_/),
      stopReason: "end_turn",
      inputTokens: 1_500,
      outputTokens: 300,
      costUsd: 0.003,
      rawOutput: JSON.stringify(validPihlajalinna),
      validation: "valid",
      errors: [],
    });
    expect(records[0]!.params).toMatchObject({ max_tokens: 2048, temperature: 0, output_format: "json_schema", timeout_ms: 30_000 });
    expect(records[0]!.params.schema_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("retries once with the validation errors, then succeeds", async () => {
    const bad = { ...validPihlajalinna, evidence_quote: "Pihlajalinna buys a clinic" };
    const { client, records, deps } = harness([reply(JSON.stringify(bad)), reply(JSON.stringify(validPihlajalinna), { input: 1_800, output: 280 })]);
    const result = await extractOne(pihlajalinna, deps);

    expect(result).toMatchObject({ status: "extracted", attempts: 2, llmCallId: 2 });
    expect(records.map((r) => [r.attempt, r.validation])).toEqual([
      [1, "invalid"],
      [2, "valid"],
    ]);
    expect(records[0]!.errors).toEqual(["evidence_quote does not occur verbatim in the announcement"]);
    const retry = client.requests[1]!.params.messages;
    expect(retry).toHaveLength(3);
    expect(retry[1]).toEqual({ role: "assistant", content: JSON.stringify(bad) });
    expect(retry[2]).toEqual({ role: "user", content: buildRetryMessage(["evidence_quote does not occur verbatim in the announcement"]) });
    // The first request's logged input is not changed by the retry.
    expect(records[0]!.input).toHaveLength(1);
    expect(records[1]!.costUsd).toBe(0.0032);
  });

  it('records "no extraction" after two invalid replies', async () => {
    const outside = { ...validPihlajalinna, affected: [{ ...validPihlajalinna.affected[0]!, isin: "SE0000108656", relation: "peer" }] };
    const { client, records, deps } = harness([reply(JSON.stringify(outside)), reply("{not json")]);
    const result = await extractOne(pihlajalinna, deps);

    expect(result).toEqual({
      disclosureId: 1465331,
      status: "no_extraction",
      reason: "invalid",
      llmCallIds: [1, 2],
      promptVersion: PROMPT_VERSION,
      errors: ["reply is not valid JSON"],
    });
    expect(client.requests).toHaveLength(MAX_ATTEMPTS);
    expect(records.map((r) => r.validation)).toEqual(["invalid", "invalid"]);
    expect(records[0]!.errors[0]).toMatch(/ISIN SE0000108656 is not in the candidate list/);
  });

  it("treats a refusal or a cut-off reply as invalid, even if the JSON parses", async () => {
    const { records, deps } = harness([
      reply(JSON.stringify(validPihlajalinna), { stop_reason: "max_tokens" }),
      reply("", { stop_reason: "refusal" }),
    ]);
    const result = await extractOne(pihlajalinna, deps);
    expect(result).toMatchObject({ status: "no_extraction", reason: "invalid", errors: ["stop_reason is refusal, not end_turn"] });
    expect(records[0]!.errors).toEqual(["stop_reason is max_tokens, not end_turn"]);
  });

  it("does not retry an API error, and logs it without tokens or cost", async () => {
    const { client, records, deps } = harness([new Error("529 overloaded")]);
    const result = await extractOne(pihlajalinna, deps);
    expect(result).toMatchObject({ status: "no_extraction", reason: "api_error", llmCallIds: [1], errors: ["Error: 529 overloaded"] });
    expect(client.requests).toHaveLength(1);
    expect(records[0]).toMatchObject({ validation: "api_error", responseId: null, inputTokens: null, costUsd: null, rawOutput: null });
  });

  it("extracts a spillover link to a candidate peer", async () => {
    const event: Extraction = {
      event_type: "m_and_a",
      affected: [
        { isin: TROPHY, relation: "direct", direction: "pos", magnitude: "high", horizon_days: 1 },
        { isin: PARADOX, relation: "competitor", direction: "unclear", magnitude: "low", horizon_days: 5 },
      ],
      novelty_note: "The guidance upgrade is new information.",
      evidence_quote: "Acquires Playrion SASU from Paradox Interactive and Upgrades Full-Year 2026 Guidance",
    };
    const { deps } = harness([reply(JSON.stringify(event))], { candidateOptions: { maxPeers: 3, liquidityEur: new Map([[PARADOX, 9_000_000]]) } });
    const result = await extractOne(trophy, deps);
    expect(result.status).toBe("extracted");
    if (result.status === "extracted") expect(newsEventRow(result)).toEqual({ disclosureId: 1465278, event, llmCallId: 1, promptVersion: PROMPT_VERSION });
  });
});

describe("batch", () => {
  it("returns one result per announcement, in order", async () => {
    const other: Extraction = { event_type: "other", affected: [], novelty_note: "Routine.", evidence_quote: "Trophy Games Acquires Playrion SASU" };
    const { deps } = harness([reply(JSON.stringify(validPihlajalinna)), reply(JSON.stringify(other))]);
    const results = await extractEvents([pihlajalinna, trophy], deps);
    expect(results.map((r) => [r.disclosureId, r.status])).toEqual([
      [1465331, "extracted"],
      [1465278, "extracted"],
    ]);
  });

  it("refuses duplicates and models without a sourced price", async () => {
    await expect(extractEvents([pihlajalinna, pihlajalinna], harness([]).deps)).rejects.toThrow("appears twice");
    await expect(extractEvents([pihlajalinna], harness([], { model: "claude-haiku-4-5" }).deps)).rejects.toThrow("no sourced price");
  });
});

// ---- Cost -------------------------------------------------------------------------------------------------

describe("cost from token counts (SOURCED prices)", () => {
  it("prices the extraction model at $1 / $5 per million tokens", () => {
    expect(MODEL_PRICES["claude-haiku-4-5-20251001"]).toMatchObject({ inputPerMTok: 1, outputPerMTok: 5 });
    expect(callCostUsd(EXTRACTION_MODEL, { input_tokens: 1, output_tokens: 0 })).toBe(0.000001);
    expect(callCostUsd(EXTRACTION_MODEL, { input_tokens: 0, output_tokens: 1 })).toBe(0.000005);
  });

  it("reconciles with V20: 400 items × (1,500 in + 300 out) = $1.20 a day", () => {
    const perItem = callCostUsd(EXTRACTION_MODEL, { input_tokens: 1_500, output_tokens: 300 });
    expect(perItem).toBe(0.003);
    expect(Math.round(400 * perItem * 100) / 100).toBe(1.2);
  });

  it("reconciles with V20's decision line: (30,000 in + 6,000 out) × 2 = $0.24", () => {
    expect(2 * callCostUsd("claude-sonnet-5", { input_tokens: 30_000, output_tokens: 6_000 })).toBe(0.24);
  });

  it("prices cache writes by TTL and cache reads at 0.1×", () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 100,
      cache_creation_input_tokens: 3_000,
      cache_creation: { ephemeral_5m_input_tokens: 2_000, ephemeral_1h_input_tokens: 1_000 },
      cache_read_input_tokens: 10_000,
    };
    // 100×1 + 100×5 + 2,000×1.25 + 1,000×2 + 10,000×0.1 = 6,100 micro-dollars
    expect(callCostUsd(EXTRACTION_MODEL, usage)).toBe(0.0061);
  });

  it("throws rather than guess", () => {
    expect(() => callCostUsd("claude-unknown", { input_tokens: 1, output_tokens: 1 })).toThrow("no sourced price");
    expect(() => callCostUsd(EXTRACTION_MODEL, { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 5 })).toThrow("without the 5-minute / 1-hour split");
    expect(() => callCostUsd(EXTRACTION_MODEL, { input_tokens: -1, output_tokens: 1 })).toThrow("bad token counts");
  });
});

// ---- Live check set ---------------------------------------------------------------------------------------

describe("live check set", () => {
  it("has 20 distinct, in-scope fixture announcements linked to real shares", () => {
    expect(CHECK_SET).toHaveLength(20);
    expect(new Set(CHECK_SET.map((c) => c.disclosureId)).size).toBe(20);
    const isins = new Set(shares.map((s) => s.isin));
    for (const c of CHECK_SET) {
      const n = news.find((x) => x.disclosureId === c.disclosureId);
      expect(n, String(c.disclosureId)).toBeDefined();
      expect(n!.market).toMatch(/^(Main Market, (Helsinki|Stockholm|Copenhagen)|First North (Finland|Sweden|Denmark))$/);
      for (const isin of c.linkedIsins) expect(isins.has(isin), isin).toBe(true);
      expect(() => buildCandidates(c.linkedIsins, shares)).not.toThrow();
    }
  });
});
