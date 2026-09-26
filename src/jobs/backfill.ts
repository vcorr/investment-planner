import { BACKFILL_FROM } from "../config/sample.js";
import { connect } from "../db/client.js";
import { fxRates, pricesEod } from "../db/schema.js";
import { excludedSet } from "../db/upsert.js";
import { latestSettings } from "../settings/store.js";
import * as ecb from "../sources/ecb.js";
import * as nasdaq from "../sources/nasdaq.js";
import { helsinkiDate } from "../util/dates.js";

// Loads daily bars and FX rates for the current universe, from BACKFILL_FROM to yesterday (Helsinki).
// Safe to re-run: rows are upserted on their natural keys.

const { db, close } = connect();
try {
  const { id, settings } = await latestSettings(db);
  const from = BACKFILL_FROM;
  const to = helsinkiDate(-1);
  console.log(`Settings version ${id}: ${settings.universe.listings.length} listings, ${from} to ${to}`);

  for (const ref of settings.universe.listings) {
    const bars = await nasdaq.fetchDailyBars(ref.orderbookId, from, to);
    if (bars.length === 0) throw new Error(`${ref.market} ${ref.symbol}: no bars between ${from} and ${to}`);
    await db
      .insert(pricesEod)
      .values(bars.map((bar) => ({ ...bar, orderbookId: ref.orderbookId, source: nasdaq.SOURCE })))
      .onConflictDoUpdate({
        target: [pricesEod.orderbookId, pricesEod.tradeDate],
        set: excludedSet(pricesEod, ["orderbookId", "tradeDate"]),
      });
    console.log(`${ref.market} ${ref.symbol.padEnd(7)} ${bars.length} bars (${bars[0]?.tradeDate} to ${bars.at(-1)?.tradeDate})`);
    await nasdaq.pause();
  }

  const orderbookIds = settings.universe.listings.map((l) => l.orderbookId);
  const rows = await db.query.listings.findMany({ where: (l, { inArray }) => inArray(l.orderbookId, orderbookIds) });
  const currencies = [...new Set(rows.map((r) => r.currency))].filter((c) => c !== "EUR").sort();
  if (currencies.length > 0) {
    const rates = await ecb.fetchRates(currencies, from, to);
    await db
      .insert(fxRates)
      .values(rates.map((rate) => ({ ...rate, source: ecb.SOURCE })))
      .onConflictDoUpdate({
        target: [fxRates.currency, fxRates.rateDate],
        set: excludedSet(fxRates, ["currency", "rateDate"]),
      });
    console.log(`FX ${currencies.join(", ")}: ${rates.length} rates`);
  }
} finally {
  await close();
}
