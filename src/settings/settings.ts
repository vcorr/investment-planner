import { createHash } from "node:crypto";
import { z } from "zod";

// Settings live in the database as versioned, hashed snapshots (amendment A11).
// M1 holds only the universe; later milestones add sections.

const listingRefSchema = z.object({
  market: z.enum(["HEL", "STO", "CPH"]),
  symbol: z.string().min(1),
  orderbookId: z.string().min(1),
});

export const settingsSchema = z.object({
  universe: z.object({
    /** "sample": a fixed list for development. "full" arrives with the screen (M2). */
    mode: z.literal("sample"),
    listings: z.array(listingRefSchema).min(1),
  }),
});

export type Settings = z.infer<typeof settingsSchema>;
export type ListingRef = z.infer<typeof listingRefSchema>;

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

export function hashSettings(settings: Settings): string {
  return createHash("sha256").update(canonicalJson(settings)).digest("hex");
}
