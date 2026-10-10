// Settings schema, canonical JSON, hash and lock rule, shared by Node (src/settings/settings.ts re-exports it),
// the `settings` Edge Function (Deno) and the web page (Vite). Its only import is zod, which each runtime
// resolves itself: Node and Vite from node_modules, Deno through the function's deno.json.
// Settings live in the database as versioned, hashed snapshots (amendment A11).

import { z } from "zod";

// ---- Universe -----------------------------------------------------------------------------------------------

export const listingRefSchema = z.strictObject({
  market: z.enum(["HEL", "STO", "CPH"]),
  symbol: z.string().min(1),
  orderbookId: z.string().min(1),
});

// ---- Ethical screen (brief §7.2, decisions D5, D6, A7) ------------------------------------------------------

/** Text that is not empty or only whitespace. */
const text = () => z.string().regex(/\S/, "Must not be empty");

/** A company's role in an activity. `consumes` lets a rule cover consumers, e.g. of natural gas (D6). */
export const SCREEN_ROLES = ["extracts", "produces", "sells", "distributes", "services", "consumes"] as const;
export const screenRoleSchema = z.enum(SCREEN_ROLES);

export const screenTestSchema = z.discriminatedUnion("kind", [
  /** Any involvement at all excludes the company. */
  z.strictObject({ kind: z.literal("any_involvement") }),
  /** Excluded when the activity's share of revenue is more than `maxPct` per cent. */
  z.strictObject({
    kind: z.literal("revenue_share"),
    maxPct: z.number().min(0, "Must be 0 or more").lt(100, "Must be below 100"),
  }),
  /** Excluded when the company has any of these roles in the activity. */
  z.strictObject({
    kind: z.literal("role"),
    roles: z
      .array(screenRoleSchema)
      .min(1, "Choose at least one role")
      .refine((roles) => new Set(roles).size === roles.length, "Each role only once"),
  }),
]);

export const screenRuleSchema = z.strictObject({
  /** Stable key, e.g. "fossil-fuels". Lower-case letters, digits and hyphens. */
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lower-case letters, digits and single hyphens"),
  activity: text(),
  description: text(),
  test: screenTestSchema,
  notes: text().optional(),
});

/** ISO 6166: two letters, nine letters or digits, one check digit. */
export const ISIN_PATTERN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

/** True when `isin` has the ISIN format and a correct check digit (Luhn over the letters expanded to 10-35). */
export function isValidIsin(isin: string): boolean {
  if (!ISIN_PATTERN.test(isin)) return false;
  const digits = [...isin.slice(0, 11)].map((c) => (c >= "0" && c <= "9" ? c : String(c.charCodeAt(0) - 55))).join("");
  let sum = 0;
  // Double every second digit counting from the right of the payload (the check digit is excluded).
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10 === Number(isin[11]);
}

const isoDate = z.string().refine((s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}, "Must be a date as YYYY-MM-DD");

export const screenOverrideSchema = z.strictObject({
  isin: z
    .string()
    .regex(ISIN_PATTERN, "Must be an ISIN: 2 letters, 9 letters or digits, 1 digit")
    .refine(isValidIsin, "ISIN check digit is wrong"),
  verdict: z.enum(["include", "exclude"]),
  reason: text(),
  decidedOn: isoDate,
});

export const screenSchema = z.strictObject({
  rules: z.array(screenRuleSchema).superRefine((rules, ctx) => {
    const seen = new Set<string>();
    rules.forEach((rule, i) => {
      if (seen.has(rule.id)) ctx.addIssue({ code: "custom", path: [i, "id"], message: `Rule id "${rule.id}" is used twice` });
      seen.add(rule.id);
    });
  }),
  /** Brief §7.2: unreviewed borderline cases are excluded until reviewed. Not a choice, so a literal. */
  borderline: z.literal("exclude_until_reviewed"),
  /** Per-company verdicts. They always win over the rules (A7). */
  overrides: z.array(screenOverrideSchema).superRefine((overrides, ctx) => {
    const seen = new Set<string>();
    overrides.forEach((o, i) => {
      if (seen.has(o.isin)) ctx.addIssue({ code: "custom", path: [i, "isin"], message: `ISIN ${o.isin} has two overrides` });
      seen.add(o.isin);
    });
  }),
});

// ---- Settings -----------------------------------------------------------------------------------------------

export const settingsSchema = z.strictObject({
  universe: z.strictObject({
    /** "sample": a fixed list for development. "full" arrives once the screen runs. */
    mode: z.literal("sample"),
    listings: z.array(listingRefSchema).min(1),
  }),
  screen: screenSchema,
});

export type Settings = z.infer<typeof settingsSchema>;
export type ListingRef = z.infer<typeof listingRefSchema>;
export type Screen = z.infer<typeof screenSchema>;
export type ScreenRule = z.infer<typeof screenRuleSchema>;
export type ScreenTest = z.infer<typeof screenTestSchema>;
export type ScreenRole = z.infer<typeof screenRoleSchema>;
export type ScreenOverride = z.infer<typeof screenOverrideSchema>;

const UNREVIEWED = "Placeholder from brief §7.2. Vasco has not reviewed this rule or its test yet.";

const placeholderRule = (id: string, activity: string): ScreenRule => ({
  id,
  activity,
  description: `Excluded activity listed in brief §7.2: ${activity.toLowerCase()}.`,
  test: { kind: "any_involvement" },
  notes: UNREVIEWED,
});

/**
 * Starting screen: the brief's five excluded activities (§7.2), each with `any_involvement` as a placeholder
 * test. There is deliberately no rule for natural-gas consumers: Vasco decides that in the page (D6).
 */
export const DEFAULT_SCREEN: Screen = {
  rules: [
    placeholderRule("fossil-fuels", "Fossil fuels"),
    placeholderRule("weapons-defence", "Weapons and defence"),
    placeholderRule("mining", "Mining"),
    placeholderRule("pesticides", "Pesticides"),
    placeholderRule("tobacco", "Tobacco"),
  ],
  borderline: "exclude_until_reviewed",
  overrides: [],
};

// ---- Canonical JSON and hash --------------------------------------------------------------------------------

/** JSON with object keys sorted at every level, so equal settings always hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * SHA-256 of the canonical JSON, hex. Web Crypto, so it runs in Deno and browsers; Node's synchronous
 * `hashSettings` in src/settings/settings.ts must give the same result (tested).
 */
export async function settingsHash(settings: Settings): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(settings)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- Lock during a scored month (brief §11, A11) ------------------------------------------------------------

export interface ScoredMonth {
  /** First and last calendar day of the month, YYYY-MM-DD, both inclusive. */
  startsOn: string;
  endsOn: string;
  /** Set when Vasco ended the month deliberately; from then on it no longer locks settings. */
  endedEarlyAt: string | Date | null;
}

/**
 * True when `todayHelsinki` (YYYY-MM-DD, Helsinki calendar date) falls inside a scored month that has not
 * been ended early. With no months, nothing is locked. Throws on malformed dates rather than guessing.
 */
export function settingsLocked(months: readonly ScoredMonth[], todayHelsinki: string): boolean {
  if (!isoDate.safeParse(todayHelsinki).success) throw new Error(`settingsLocked: bad date "${todayHelsinki}"`);
  return months.some((m) => {
    if (!isoDate.safeParse(m.startsOn).success || !isoDate.safeParse(m.endsOn).success || m.endsOn < m.startsOn) {
      throw new Error(`settingsLocked: bad scored month ${m.startsOn} to ${m.endsOn}`);
    }
    return m.endedEarlyAt === null && m.startsOn <= todayHelsinki && todayHelsinki <= m.endsOn;
  });
}

/** Calendar date (YYYY-MM-DD) in Helsinki at `now`. */
export function helsinkiToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Helsinki" }).format(now);
}
