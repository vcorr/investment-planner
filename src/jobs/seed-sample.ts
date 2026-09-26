import { sql } from "drizzle-orm";
import { SAMPLE_SHARES } from "../config/sample.js";
import { connect } from "../db/client.js";
import { instruments, listings } from "../db/schema.js";
import type { ListingRef } from "../settings/settings.js";
import { saveSettings } from "../settings/store.js";
import { fetchShareList, pause, type Market, type ScreenerRow } from "../sources/nasdaq.js";

// Resolves the development sample against Nasdaq's share list, stores the instruments and listings,
// and saves the sample as a settings version.

const { db, close } = connect();
try {
  const markets = [...new Set(SAMPLE_SHARES.map((s) => s.market))];
  const lists = new Map<Market, ScreenerRow[]>();
  for (const market of markets) {
    lists.set(market, await fetchShareList(market, "MAIN_MARKET"));
    await pause();
  }

  const refs: ListingRef[] = [];
  for (const share of SAMPLE_SHARES) {
    const row = lists.get(share.market)?.find((r) => r.symbol === share.symbol);
    if (!row) throw new Error(`${share.market} ${share.symbol} not found in Nasdaq's share list`);

    await db
      .insert(instruments)
      .values({ isin: row.isin, name: row.fullName, sector: row.sector || null })
      .onConflictDoUpdate({
        target: instruments.isin,
        set: { name: row.fullName, sector: row.sector || null, updatedAt: sql`now()` },
      });
    await db
      .insert(listings)
      .values({
        orderbookId: row.orderbookId,
        isin: row.isin,
        market: share.market,
        segment: "MAIN_MARKET",
        symbol: row.symbol,
        currency: row.currency,
      })
      .onConflictDoUpdate({
        target: listings.orderbookId,
        set: { symbol: row.symbol, currency: row.currency, updatedAt: sql`now()` },
      });

    refs.push({ market: share.market, symbol: row.symbol, orderbookId: row.orderbookId });
    console.log(`${share.market} ${row.symbol.padEnd(7)} ${row.orderbookId.padEnd(8)} ${row.isin} ${row.currency} ${row.sector}`);
  }

  const version = await saveSettings(
    db,
    { universe: { mode: "sample", listings: refs } },
    "Development sample of 10 shares (M1)",
  );
  console.log(`Settings version ${version.id} (${version.hash.slice(0, 12)})${version.created ? ", new" : ", unchanged"}`);
} finally {
  await close();
}
