const helsinkiDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Helsinki" });

/**
 * Calendar date (YYYY-MM-DD) in Helsinki, shifted by `offsetDays` calendar days.
 * Takes the Helsinki date first and then shifts in UTC, so daylight-saving changes cannot skip or repeat a day.
 */
export function helsinkiDate(offsetDays = 0, now = new Date()): string {
  const [y, m, d] = helsinkiDay.format(now).split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10);
}
