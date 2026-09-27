import type { Market } from "../sources/nasdaq.js";
import { assertIsoDate, type PriceSeries } from "./series.js";

// Equal-weight market series per exchange (brief §9): the benchmark for relative momentum.

export interface MarketReturn {
  date: string;
  /** Mean of the members' close-to-close returns from the previous market date to this one. */
  return: number;
  /** Members with a close on both dates. */
  memberCount: number;
}

/**
 * Daily returns of an equal-weight portfolio of `members`, all on `market`, for dates up to and including
 * `upTo`. The market dates are every date on which any member has a bar; the first has no return. A member
 * counts on a date only if it has a close on that date and on the previous market date. Throws on a date where
 * no member counts, and on an empty or mixed member list.
 */
export function equalWeightMarketSeries(market: Market, members: readonly PriceSeries[], upTo: string): MarketReturn[] {
  assertIsoDate(upTo, "upTo");
  if (members.length === 0) throw new Error(`${market}: the equal-weight series needs at least one member`);
  const closes = members.map((m) => {
    if (m.market !== market) throw new Error(`${m.orderbookId} is on ${m.market}, not ${market}`);
    return new Map(m.bars.filter((b) => b.tradeDate <= upTo).map((b) => [b.tradeDate, b.close]));
  });
  const dates = [...new Set(closes.flatMap((c) => [...c.keys()]))].sort();
  const series: MarketReturn[] = [];
  for (let i = 1; i < dates.length; i++) {
    const date = dates[i]!;
    const previous = dates[i - 1]!;
    let sum = 0;
    let memberCount = 0;
    for (const c of closes) {
      const now = c.get(date);
      const before = c.get(previous);
      if (now == null || before == null) continue;
      sum += now / before - 1;
      memberCount++;
    }
    if (memberCount === 0) throw new Error(`${market} ${date}: no member has a close on both ${previous} and ${date}`);
    series.push({ date, return: sum / memberCount, memberCount });
  }
  return series;
}

/**
 * Compounded market return over the dates after `fromDate` up to and including `toDate`. Throws if any of
 * `requiredDates` (the share's own dates in that span) has no market return, since the benchmark would then
 * cover fewer days than the share.
 */
export function compoundedMarketReturn(
  series: readonly MarketReturn[],
  fromDate: string,
  toDate: string,
  requiredDates: readonly string[],
): number {
  const inSpan = series.filter((r) => r.date > fromDate && r.date <= toDate);
  const covered = new Set(inSpan.map((r) => r.date));
  const missing = requiredDates.find((d) => !covered.has(d));
  if (missing !== undefined) throw new Error(`The market series has no return for ${missing}`);
  return inSpan.reduce((growth, r) => growth * (1 + r.return), 1) - 1;
}
