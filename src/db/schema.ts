import {
  bigint,
  char,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// M1 tables only. Later milestones add their tables through new migrations.

export const marketEnum = pgEnum("market", ["HEL", "STO", "CPH"]);
export const segmentEnum = pgEnum("segment", ["MAIN_MARKET", "FIRST_NORTH"]);

const price = (name: string) => numeric(name, { precision: 18, scale: 6, mode: "number" });

/** One row per company share, keyed by ISIN. */
export const instruments = pgTable("instruments", {
  isin: char("isin", { length: 12 }).primaryKey(),
  name: text("name").notNull(),
  /** ICB industry as reported by the Nasdaq screener. */
  sector: text("sector"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

/** One row per order book. A share can trade on several markets (e.g. Nokia in EUR and SEK). */
export const listings = pgTable("listings", {
  orderbookId: text("orderbook_id").primaryKey(),
  isin: char("isin", { length: 12 })
    .notNull()
    .references(() => instruments.isin),
  market: marketEnum("market").notNull(),
  segment: segmentEnum("segment").notNull(),
  symbol: text("symbol").notNull(),
  currency: char("currency", { length: 3 }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

/** Daily bars in local currency, unadjusted for dividends and splits. */
export const pricesEod = pgTable(
  "prices_eod",
  {
    orderbookId: text("orderbook_id")
      .notNull()
      .references(() => listings.orderbookId),
    tradeDate: date("trade_date").notNull(),
    open: price("open"),
    high: price("high"),
    low: price("low"),
    close: price("close"),
    average: price("average"),
    /** Closing bid and ask, kept for calibrating slippage. */
    bid: price("bid"),
    ask: price("ask"),
    volume: bigint("volume", { mode: "number" }),
    turnover: numeric("turnover", { precision: 20, scale: 2, mode: "number" }),
    trades: integer("trades"),
    source: text("source").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orderbookId, t.tradeDate] })],
).enableRLS();

/** ECB euro reference rates: units of `currency` per 1 EUR. */
export const fxRates = pgTable(
  "fx_rates",
  {
    currency: char("currency", { length: 3 }).notNull(),
    rateDate: date("rate_date").notNull(),
    unitsPerEur: numeric("units_per_eur", { precision: 18, scale: 6, mode: "number" }).notNull(),
    source: text("source").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.currency, t.rateDate] })],
).enableRLS();

/**
 * Versioned, hashed settings (amendment A11). Each change is a new row and the highest id is current;
 * runs record the version they used. The hash is not unique, so reverting to earlier settings is a new version.
 */
export const settingsVersions = pgTable("settings_versions", {
  id: serial("id").primaryKey(),
  hash: char("hash", { length: 64 }).notNull(),
  payload: jsonb("payload").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

/**
 * Nasdaq Nordic company announcements for HEL, STO and CPH, Main Market and First North (decision D11).
 * Written by the news-poller Edge Function; rows are never updated, so `fetched_at` is when we first saw the item.
 */
export const newsItems = pgTable(
  "news_items",
  {
    disclosureId: bigint("disclosure_id", { mode: "number" }).primaryKey(),
    company: text("company"),
    market: text("market").notNull(),
    /** Nasdaq's `cnsCategory`, e.g. "Inside information". */
    category: text("category"),
    categoryId: integer("category_id"),
    headline: text("headline").notNull(),
    language: text("language"),
    languages: text("languages").array(),
    messageUrl: text("message_url"),
    releasedAt: timestamp("released_at", { withTimezone: true }).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /** Our own clock. The leakage rule admits only items with `fetched_at` before the decision cutoff. */
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    /** SHA-256 of the raw item's canonical JSON. */
    rawHash: char("raw_hash", { length: 64 }).notNull(),
    source: text("source").notNull(),
  },
  (t) => [index("news_items_released_at_idx").on(t.releasedAt)],
).enableRLS();

/** Findings from docs/verification.md, one row per V-item. */
export const verificationLog = pgTable("verification_log", {
  id: text("id").primaryKey(),
  item: text("item").notNull(),
  finding: text("finding").notNull(),
  status: text("status").notNull(),
  source: text("source").notNull(),
  loadedAt: timestamp("loaded_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();
