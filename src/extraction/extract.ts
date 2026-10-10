import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Message, MessageCreateParamsNonStreaming, MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { buildCandidates, type CandidateOptions, type ShareRow } from "./candidates.js";
import { MODEL_PRICES, PRICE_SOURCE, callCostUsd } from "./pricing.js";
import { PROMPT_VERSION, SYSTEM_PROMPT, buildRetryMessage, buildUserMessage, sourceText, type ExtractionInput } from "./prompt.js";
import { checkExtraction, extractionSchema, type Extraction, type ValidationContext } from "./schema.js";

// Event extraction with the pinned extraction model (brief §8.4, amendment A10). One call per announcement,
// no tools and no web access; the model sees only the announcement and the candidate list.

/** Decision A10: the dated snapshot, pinned for reproducibility. */
export const EXTRACTION_MODEL = "claude-haiku-4-5-20251001";
/** ASSUMED: V20 expects about 300 output tokens; this leaves room for a long affected list. */
export const MAX_TOKENS = 2048;
/** Task file: 30 s per request. */
export const TIMEOUT_MS = 30_000;
/** Transport retries inside the SDK (408, 409, 429, 5xx, connection errors), each with its own 30 s timeout. */
export const SDK_MAX_RETRIES = 2;
/** Validation failures get one retry, then the announcement is recorded as "no extraction" (brief §10.3). */
export const MAX_ATTEMPTS = 2;

/** The part of the SDK client the extractor uses, so tests can inject a fake that returns recorded replies. */
export interface MessagesClient {
  create(params: MessageCreateParamsNonStreaming, options: { timeout: number }): Promise<Message>;
}

export function anthropicMessagesClient(apiKey: string): MessagesClient {
  const client = new Anthropic({ apiKey, maxRetries: SDK_MAX_RETRIES });
  return { create: (params, options) => client.messages.create(params, options) };
}

/** One row for `llm_calls`, written for every attempt, including failed ones. */
export interface LlmCallRecord {
  purpose: "extraction" | "decision";
  model: string;
  promptVersion: string;
  /** What the call was about, e.g. "news:1465331". */
  subject: string;
  attempt: number;
  params: Record<string, unknown>;
  /** The messages sent after the system prompt, which PROMPT_VERSION identifies. */
  input: MessageParam[];
  startedAt: Date;
  latencyMs: number;
  responseId: string | null;
  stopReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  costUsd: number | null;
  priceSource: string;
  rawOutput: string | null;
  validation: "valid" | "invalid" | "api_error";
  /** Validation problems, or the API error message. */
  errors: string[];
}

export interface ExtractionItem extends ExtractionInput {
  /** ISINs of the announcing company's shares, from the company linking step (several for A and B shares). */
  linkedIsins: string[];
}

export interface ExtractionDeps {
  client: MessagesClient;
  /** Stores one call and returns its `llm_calls.id`. */
  recordCall(record: LlmCallRecord): Promise<number>;
  /** The Nasdaq share lists, for the candidate companies. */
  shares: readonly ShareRow[];
  candidateOptions?: CandidateOptions;
  model?: string;
  /** Milliseconds, for latency and start times; injectable for tests. */
  clock?: () => number;
}

export type ExtractionResult =
  | { disclosureId: number; status: "extracted"; event: Extraction; llmCallId: number; promptVersion: string; attempts: number }
  | {
      disclosureId: number;
      status: "no_extraction";
      reason: "invalid" | "api_error";
      llmCallIds: number[];
      promptVersion: string;
      errors: string[];
    };

/** The request parameters worth logging: everything except the messages and the full schema, which is hashed. */
function loggedParams(params: MessageCreateParamsNonStreaming, schema: unknown): Record<string, unknown> {
  return {
    model: params.model,
    max_tokens: params.max_tokens,
    temperature: params.temperature,
    output_format: "json_schema",
    schema_sha256: createHash("sha256").update(JSON.stringify(schema)).digest("hex"),
    timeout_ms: TIMEOUT_MS,
    sdk_max_retries: SDK_MAX_RETRIES,
  };
}

/** Joins the reply's text blocks; structured output puts the JSON in the first one. */
function replyText(message: Message): string {
  return message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
}

/** All problems with a reply, from the stop reason to the checks against the input. */
export function validateReply(
  raw: string,
  stopReason: string | null,
  context: ValidationContext,
): { extraction: Extraction; errors: [] } | { extraction: null; errors: string[] } {
  // A refusal or a cut-off reply may not match the schema even with structured output.
  if (stopReason !== "end_turn") return { extraction: null, errors: [`stop_reason is ${stopReason ?? "missing"}, not end_turn`] };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { extraction: null, errors: ["reply is not valid JSON"] };
  }
  const parsed = extractionSchema.safeParse(json);
  if (!parsed.success) {
    return { extraction: null, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  const errors = checkExtraction(parsed.data, context);
  return errors.length === 0 ? { extraction: parsed.data, errors: [] } : { extraction: null, errors };
}

/**
 * Extracts one announcement: up to two attempts, the second told why the first failed. Every attempt is
 * recorded through `deps.recordCall`, whatever its outcome.
 */
export async function extractOne(item: ExtractionItem, deps: ExtractionDeps): Promise<ExtractionResult> {
  const model = deps.model ?? EXTRACTION_MODEL;
  const clock = deps.clock ?? Date.now;
  const candidates = buildCandidates(item.linkedIsins, deps.shares, deps.candidateOptions);
  const context: ValidationContext = {
    sourceText: sourceText(item),
    candidateIsins: new Set(candidates.map((c) => c.isin)),
    linkedIsins: new Set(item.linkedIsins),
  };
  // The SDK's structured-output helper (V19): the zod schema becomes the request's JSON schema.
  const format = zodOutputFormat(extractionSchema);
  const messages: MessageParam[] = [{ role: "user", content: buildUserMessage(item, candidates) }];
  const callIds: number[] = [];
  let errors: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const params: MessageCreateParamsNonStreaming = {
      model,
      max_tokens: MAX_TOKENS,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [...messages],
      output_config: { format },
    };
    const base = {
      purpose: "extraction" as const,
      model,
      promptVersion: PROMPT_VERSION,
      subject: `news:${item.disclosureId}`,
      attempt,
      params: loggedParams(params, format.schema),
      input: params.messages,
      priceSource: PRICE_SOURCE,
    };
    const started = clock();
    let message: Message;
    try {
      message = await deps.client.create(params, { timeout: TIMEOUT_MS });
    } catch (error) {
      const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      callIds.push(
        await deps.recordCall({
          ...base,
          startedAt: new Date(started),
          latencyMs: clock() - started,
          responseId: null,
          stopReason: null,
          inputTokens: null,
          outputTokens: null,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: null,
          costUsd: null,
          rawOutput: null,
          validation: "api_error",
          errors: [text],
        }),
      );
      // The SDK has already retried transport errors; a validation retry would not help.
      return { disclosureId: item.disclosureId, status: "no_extraction", reason: "api_error", llmCallIds: callIds, promptVersion: PROMPT_VERSION, errors: [text] };
    }
    const latencyMs = clock() - started;
    const raw = replyText(message);
    const result = validateReply(raw, message.stop_reason, context);
    errors = result.errors;
    const id = await deps.recordCall({
      ...base,
      startedAt: new Date(started),
      latencyMs,
      responseId: message.id,
      stopReason: message.stop_reason,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? null,
      cacheReadInputTokens: message.usage.cache_read_input_tokens ?? null,
      costUsd: callCostUsd(model, message.usage),
      rawOutput: raw,
      validation: result.extraction ? "valid" : "invalid",
      errors,
    });
    callIds.push(id);
    if (result.extraction) {
      return { disclosureId: item.disclosureId, status: "extracted", event: result.extraction, llmCallId: id, promptVersion: PROMPT_VERSION, attempts: attempt };
    }
    // An empty assistant turn is not allowed, so a reply without text is retried without feedback.
    if (raw.trim() !== "") messages.push({ role: "assistant", content: raw }, { role: "user", content: buildRetryMessage(errors) });
  }
  return { disclosureId: item.disclosureId, status: "no_extraction", reason: "invalid", llmCallIds: callIds, promptVersion: PROMPT_VERSION, errors };
}

/**
 * Extracts events for admissible, linked announcements, one at a time in the order given. Admissibility and
 * company linking happen before this step. Returns one result per item; nothing is dropped silently.
 */
export async function extractEvents(items: readonly ExtractionItem[], deps: ExtractionDeps): Promise<ExtractionResult[]> {
  const model = deps.model ?? EXTRACTION_MODEL;
  if (!MODEL_PRICES[model]) throw new Error(`Extraction: no sourced price for model "${model}", so calls could not be costed`);
  const ids = new Set<number>();
  for (const item of items) {
    if (ids.has(item.disclosureId)) throw new Error(`Extraction: disclosureId ${item.disclosureId} appears twice in the batch`);
    ids.add(item.disclosureId);
  }
  const results: ExtractionResult[] = [];
  for (const item of items) results.push(await extractOne(item, deps));
  return results;
}

/** The `news_events` row for a successful extraction. */
export function newsEventRow(result: Extract<ExtractionResult, { status: "extracted" }>) {
  return { disclosureId: result.disclosureId, event: result.event, llmCallId: result.llmCallId, promptVersion: result.promptVersion };
}
