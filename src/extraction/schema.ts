import { z } from "zod";

// The event extracted from one announcement (brief §8.4). The model returns JSON in this shape; code then
// checks what the schema cannot express on its own: the quote is verbatim, the ISINs come from the candidate
// list, and "direct" is used for the announcing company only.

export const EVENT_TYPES = [
  "guidance_change",
  "profit_warning",
  "results",
  "order_win",
  "m_and_a",
  "capital_raise",
  "insider_trade",
  "management_change",
  "regulatory",
  "legal",
  "product",
  "macro",
  "sector",
  "other",
] as const;
export const RELATIONS = ["direct", "peer", "customer", "supplier", "competitor"] as const;
export const DIRECTIONS = ["pos", "neg", "unclear"] as const;
export const MAGNITUDES = ["low", "med", "high"] as const;
export const HORIZONS = [1, 5] as const;
/** Brief §8.4. */
export const MAX_QUOTE_WORDS = 15;

const ISIN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w !== "").length;
}

export const affectedSchema = z.object({
  isin: z.string().regex(ISIN).describe("ISIN copied exactly from the candidate list"),
  relation: z.enum(RELATIONS).describe("direct for the announcing company; otherwise how this company is linked to it"),
  direction: z.enum(DIRECTIONS),
  magnitude: z.enum(MAGNITUDES),
  horizon_days: z.literal(HORIZONS),
});

/**
 * Checks everything that does not depend on the input. Passed to the SDK's `zodOutputFormat()`, which turns
 * it into the JSON schema sent with the request and validates the reply against it.
 */
export const extractionSchema = z.object({
  event_type: z.enum(EVENT_TYPES),
  affected: z.array(affectedSchema).describe("Empty when event_type is other"),
  novelty_note: z.string().min(1).describe("Why this is or is not new information"),
  evidence_quote: z
    .string()
    .min(1)
    .refine((q) => wordCount(q) <= MAX_QUOTE_WORDS, { message: `evidence_quote has more than ${MAX_QUOTE_WORDS} words` })
    .describe(`At most ${MAX_QUOTE_WORDS} words copied verbatim from the headline or text`),
});

export type Extraction = z.infer<typeof extractionSchema>;
export type Affected = z.infer<typeof affectedSchema>;

export interface ValidationContext {
  /** The announcement text the model saw: headline, then body when there is one. The quote must come from it. */
  sourceText: string;
  /** Every ISIN the model may name. */
  candidateIsins: ReadonlySet<string>;
  /** The announcing company's ISINs, the only ones that may be (and must be) "direct". */
  linkedIsins: ReadonlySet<string>;
}

/**
 * Whitespace runs become one space and text is NFC-normalised, so a quote that differs only in line breaks
 * or in how "ä" is encoded still counts as verbatim. Nothing else is forgiven: case and punctuation must match.
 */
export function normaliseForQuote(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Returns the problems with an extraction that already passed `extractionSchema`; empty means valid. */
export function checkExtraction(extraction: Extraction, context: ValidationContext): string[] {
  const errors: string[] = [];
  const quote = normaliseForQuote(extraction.evidence_quote);
  if (quote === "" || !normaliseForQuote(context.sourceText).includes(quote)) {
    errors.push("evidence_quote does not occur verbatim in the announcement");
  }
  if (extraction.event_type === "other" && extraction.affected.length > 0) {
    errors.push('event_type "other" must have an empty affected list');
  }
  const seen = new Set<string>();
  for (const [i, a] of extraction.affected.entries()) {
    if (!context.candidateIsins.has(a.isin)) errors.push(`affected[${i}]: ISIN ${a.isin} is not in the candidate list`);
    const linked = context.linkedIsins.has(a.isin);
    if (linked && a.relation !== "direct") errors.push(`affected[${i}]: ${a.isin} is the announcing company, so relation must be direct`);
    if (!linked && a.relation === "direct") errors.push(`affected[${i}]: ${a.isin} is not the announcing company, so relation cannot be direct`);
    const key = `${a.isin}/${a.horizon_days}`;
    if (seen.has(key)) errors.push(`affected[${i}]: ${a.isin} appears twice for horizon ${a.horizon_days}`);
    seen.add(key);
  }
  return errors;
}
