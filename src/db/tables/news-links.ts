import { bigint, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { listings, newsItems } from "../schema.js";

/**
 * Links from company announcements to listings (M3, src/news/linking.ts). One row per announcement and
 * listing; an unmatched announcement has no rows and stays in `news_items` for sector and macro use.
 * `duplicate_of` repeats the announcement's near-duplicate flag (src/news/dedup.ts) on each of its links.
 */
export const newsLinks = pgTable(
  "news_links",
  {
    disclosureId: bigint("disclosure_id", { mode: "number" })
      .notNull()
      .references(() => newsItems.disclosureId),
    orderbookId: text("orderbook_id")
      .notNull()
      .references(() => listings.orderbookId),
    /** "exact", "normalised" or "alias". */
    method: text("method").notNull(),
    /** The listing's full name in the Nasdaq share list that matched. */
    matchedName: text("matched_name").notNull(),
    /** "market" (the exchange the announcement names) or "same_isin" (the same share cross-listed elsewhere). */
    via: text("via").notNull(),
    /** The primary announcement's disclosure ID when this one is a near-duplicate; null otherwise. */
    duplicateOf: bigint("duplicate_of", { mode: "number" }).references(() => newsItems.disclosureId),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.disclosureId, t.orderbookId] }), index("news_links_orderbook_id_idx").on(t.orderbookId)],
).enableRLS();
