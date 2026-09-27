import { bigint, index, integer, jsonb, numeric, pgEnum, pgTable, primaryKey, serial, text, timestamp } from "drizzle-orm/pg-core";
import { newsItems } from "../schema.js";

// Language-model calls and the events extracted from announcements (brief §8.4, §17). Migrations are generated
// by the main session after merging (docs/tasks/README.md).

export const llmPurposeEnum = pgEnum("llm_purpose", ["extraction", "decision"]);
export const llmValidationEnum = pgEnum("llm_validation", ["valid", "invalid", "api_error"]);

/** One row per API request, including retries and failures, so spend and pass rates can be audited. */
export const llmCalls = pgTable(
  "llm_calls",
  {
    id: serial("id").primaryKey(),
    purpose: llmPurposeEnum("purpose").notNull(),
    /** The exact model ID sent, e.g. the pinned dated snapshot. */
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    /** What the call was about, e.g. "news:1465331" or a decision packet hash. */
    subject: text("subject").notNull(),
    /** 1 for the first try, 2 for the retry after a validation failure. */
    attempt: integer("attempt").notNull(),
    /** max_tokens, temperature, effort, output schema hash, timeout and so on. */
    params: jsonb("params").notNull(),
    /** Messages sent after the system prompt (which prompt_version identifies). */
    input: jsonb("input").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    latencyMs: integer("latency_ms").notNull(),
    /** Null when the request failed before a reply. */
    responseId: text("response_id"),
    stopReason: text("stop_reason"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheCreationInputTokens: integer("cache_creation_input_tokens"),
    cacheReadInputTokens: integer("cache_read_input_tokens"),
    /** COMPUTED from the token counts and the price table named in price_source. */
    costUsd: numeric("cost_usd", { precision: 12, scale: 8, mode: "number" }),
    priceSource: text("price_source").notNull(),
    rawOutput: text("raw_output"),
    validation: llmValidationEnum("validation").notNull(),
    /** Validation problems, or the API error message; empty when valid. */
    errors: jsonb("errors").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("llm_calls_subject_idx").on(t.subject), index("llm_calls_started_at_idx").on(t.startedAt)],
).enableRLS();

/** One extracted event per announcement and prompt version. Announcements with no extraction have no row. */
export const newsEvents = pgTable(
  "news_events",
  {
    disclosureId: bigint("disclosure_id", { mode: "number" })
      .notNull()
      .references(() => newsItems.disclosureId),
    promptVersion: text("prompt_version").notNull(),
    /** The validated event JSON (brief §8.4). */
    event: jsonb("event").notNull(),
    /** The successful call. */
    llmCallId: integer("llm_call_id")
      .notNull()
      .references(() => llmCalls.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.disclosureId, t.promptVersion] })],
).enableRLS();
