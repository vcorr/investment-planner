import { sql } from "drizzle-orm";
import { check, date, pgTable, serial, timestamp } from "drizzle-orm/pg-core";

/**
 * Scored months (brief §11, decision D4). Settings are locked from `starts_on` to `ends_on` inclusive
 * (Helsinki calendar dates) unless the month was ended early; see `settingsLocked` in
 * supabase/functions/_shared/settings.ts. Any settings change inside a month voids it.
 */
export const scoredMonths = pgTable(
  "scored_months",
  {
    id: serial("id").primaryKey(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    /** When the month was announced to Vasco, in advance of `starts_on` (D4). */
    announcedAt: timestamp("announced_at", { withTimezone: true }).notNull(),
    /** Set only when Vasco ends the month deliberately; the month then no longer locks settings. */
    endedEarlyAt: timestamp("ended_early_at", { withTimezone: true }),
  },
  (t) => [check("scored_months_dates_check", sql`${t.endsOn} >= ${t.startsOn}`)],
).enableRLS();
