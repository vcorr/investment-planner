import { and, eq } from "drizzle-orm";
import { validateCalendar } from "../calendar/trading-days.js";
import { EXCHANGE_CALENDARS } from "../config/exchange-calendars.js";
import { connect } from "../db/client.js";
import { exchangeCalendars } from "../db/tables/calendars.js";
import { excludedSet } from "../db/upsert.js";

// Upserts the exchange calendar exceptions from the config file, and deletes rows the file no longer lists,
// so the table always mirrors the file. Safe to re-run.

validateCalendar(EXCHANGE_CALENDARS);

const rows = EXCHANGE_CALENDARS.exceptions.map((e) => ({
  market: e.market,
  date: e.date,
  kind: e.kind,
  closesAt: e.closesAt ?? null,
  note: e.note,
  source: `${e.source.url} (accessed ${e.source.accessed})`,
}));
const keep = new Set(rows.map((r) => `${r.market} ${r.date}`));

const { db, close } = connect();
try {
  await db.transaction(async (tx) => {
    await tx
      .insert(exchangeCalendars)
      .values(rows)
      .onConflictDoUpdate({
        target: [exchangeCalendars.market, exchangeCalendars.date],
        set: excludedSet(exchangeCalendars, ["market", "date"]),
      });

    const existing = await tx.select({ market: exchangeCalendars.market, date: exchangeCalendars.date }).from(exchangeCalendars);
    const stale = existing.filter((r) => !keep.has(`${r.market} ${r.date}`));
    for (const r of stale) {
      await tx.delete(exchangeCalendars).where(and(eq(exchangeCalendars.market, r.market), eq(exchangeCalendars.date, r.date)));
    }
    if (stale.length > 0) console.log(`Deleted ${stale.length} rows no longer in the file: ${stale.map((r) => `${r.market} ${r.date}`).join(", ")}`);
  });

  for (const [market, cov] of Object.entries(EXCHANGE_CALENDARS.markets)) {
    const n = rows.filter((r) => r.market === market).length;
    console.log(`${market}: ${n} exceptions, covered ${cov?.from} to ${cov?.to}`);
  }
} finally {
  await close();
}
