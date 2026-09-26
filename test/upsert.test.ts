import { drizzle } from "drizzle-orm/postgres-js";
import { describe, expect, it } from "vitest";
import { pricesEod } from "../src/db/schema.js";
import { excludedSet } from "../src/db/upsert.js";

// No connection is made: drizzle only renders the SQL.
const db = drizzle.mock();

describe("excludedSet", () => {
  const set = excludedSet(pricesEod, ["orderbookId", "tradeDate"]);

  it("updates every non-key column from the proposed row", () => {
    const { sql } = db
      .insert(pricesEod)
      .values({ orderbookId: "TX1", tradeDate: "2026-09-25", close: 1, source: "test" })
      .onConflictDoUpdate({ target: [pricesEod.orderbookId, pricesEod.tradeDate], set })
      .toSQL();
    expect(sql).toContain('"close" = excluded."close"');
    expect(sql).toContain('"fetched_at" = excluded."fetched_at"');
  });

  it("leaves the conflict keys alone", () => {
    expect(Object.keys(set)).not.toContain("orderbookId");
    expect(Object.keys(set)).not.toContain("tradeDate");
    expect(Object.keys(set)).toHaveLength(12);
  });
});
