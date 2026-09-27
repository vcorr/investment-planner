import { date, pgEnum, pgTable, primaryKey, text, time, timestamp } from "drizzle-orm/pg-core";
import { marketEnum } from "../schema.js";

export const calendarDayKindEnum = pgEnum("calendar_day_kind", ["closed", "early_close"]);

/**
 * Exchange calendar exceptions, loaded from src/config/exchange-calendars.ts by `pnpm job:load-calendars`.
 * Weekends are always closed and are not stored; any other weekday in the covered range without a row trades.
 * The covered range lives in the config file, not here.
 */
export const exchangeCalendars = pgTable(
  "exchange_calendars",
  {
    market: marketEnum("market").notNull(),
    date: date("date").notNull(),
    kind: calendarDayKindEnum("kind").notNull(),
    /** Local close time on an early-close day; null when closed. */
    closesAt: time("closes_at"),
    /** The label as published. */
    note: text("note").notNull(),
    /** Source URL and access date, e.g. "https://… (accessed 2026-09-27)". */
    source: text("source").notNull(),
    loadedAt: timestamp("loaded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.market, t.date] })],
).enableRLS();
