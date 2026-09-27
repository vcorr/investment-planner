import { z } from "zod";
import type { Currency } from "../costs/config.js";
import type { DailyBar, Market } from "../sources/nasdaq.js";

// Inputs shared by the signal functions (brief §9): one share's daily bars, validated, cut at the as-of date,
// and optionally adjusted for dividends and splits (amendment A13). Prices are in local currency.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The fields of a Nasdaq daily bar that the signals use. A `DailyBar` fits as it is. */
export type SignalBar = Pick<DailyBar, "tradeDate" | "close" | "volume" | "turnover">;

export interface PriceSeries {
  orderbookId: string;
  market: Market;
  currency: Currency;
  /** Oldest first, one bar per trading date. */
  bars: readonly SignalBar[];
}

export function assertIsoDate(date: string, what: string): void {
  if (!ISO_DATE.test(date)) throw new Error(`${what} must be a YYYY-MM-DD date, got "${date}"`);
}

/** Throws on unsorted or repeated dates, bad date strings and impossible values. */
export function assertValidSeries(series: PriceSeries): void {
  const { orderbookId, bars } = series;
  bars.forEach((bar, i) => {
    const where = `${orderbookId} ${bar.tradeDate}`;
    assertIsoDate(bar.tradeDate, `${orderbookId} bar date`);
    const previous = bars[i - 1];
    if (previous !== undefined && previous.tradeDate >= bar.tradeDate) {
      throw new Error(`${where}: bars must be in strictly ascending date order`);
    }
    if (bar.close !== null && !(Number.isFinite(bar.close) && bar.close > 0)) throw new Error(`${where}: close ${bar.close} is not a positive number`);
    for (const [name, v] of [["volume", bar.volume], ["turnover", bar.turnover]] as const) {
      if (v !== null && !(Number.isFinite(v) && v >= 0)) throw new Error(`${where}: ${name} ${v} is not a non-negative number`);
    }
  });
}

/** Bars dated on or before `asOf`: the only ones a signal for that date may see. */
export function barsUpTo(bars: readonly SignalBar[], asOf: string): SignalBar[] {
  return bars.filter((b) => b.tradeDate <= asOf);
}

// ---- Dividends and splits (A13) ---------------------------------------------------------------------------

/**
 * A corporate action that changes the price series. No source exists yet (CLAUDE.md, M1 item 3), so none are
 * ever invented: the list is an input, and without it signals run on raw prices and say so.
 */
export const adjustmentEventSchema = z.discriminatedUnion("type", [
  z.object({
    orderbookId: z.string().min(1),
    type: z.literal("CASH_DIVIDEND"),
    exDate: z.string().regex(ISO_DATE),
    /** Per share, in the share's trading currency. */
    amount: z.number().positive(),
  }),
  z.object({
    orderbookId: z.string().min(1),
    type: z.literal("SPLIT"),
    exDate: z.string().regex(ISO_DATE),
    /** New shares per old share: 2 for a 2-for-1 split, 0.1 for a 1-for-10 reverse split. */
    ratio: z.number().positive(),
  }),
]);

export type AdjustmentEvent = z.infer<typeof adjustmentEventSchema>;

/** RAW_UNADJUSTED: no adjustment list was given, so ex-dividend days look like price drops. */
export type PriceBasis = "RAW_UNADJUSTED" | "ADJUSTED";

export interface AdjustedBars {
  bars: SignalBar[];
  priceBasis: PriceBasis;
  /** Events that changed at least one bar. */
  eventsApplied: number;
}

/**
 * Backward adjustment: every bar before an ex-date is scaled so that returns across it reflect the total
 * return. A dividend multiplies earlier closes by (1 − amount ÷ the last raw close before the ex-date); a split
 * divides earlier closes by the ratio and multiplies earlier volumes by it. Turnover, a money amount, is
 * unchanged. Factors come from raw prices, so several events on one share compound correctly.
 *
 * Only events with an ex-date on or before `asOf` are used: a later event would rescale history with
 * knowledge the as-of date did not have. `events` undefined means no source; an empty list means a source
 * that reports no events.
 */
export function adjustBars(
  orderbookId: string,
  bars: readonly SignalBar[],
  asOf: string,
  events: readonly AdjustmentEvent[] | undefined,
): AdjustedBars {
  if (events === undefined) return { bars: [...bars], priceBasis: "RAW_UNADJUSTED", eventsApplied: 0 };
  const own = events
    .map((e) => adjustmentEventSchema.parse(e))
    .filter((e) => e.orderbookId === orderbookId && e.exDate <= asOf);
  const priceFactor = bars.map(() => 1);
  const volumeFactor = bars.map(() => 1);
  let eventsApplied = 0;
  for (const event of own) {
    const firstAffected = bars.findIndex((b) => b.tradeDate >= event.exDate);
    const lastBefore = (firstAffected < 0 ? bars.length : firstAffected) - 1;
    if (lastBefore < 0) continue; // every bar is on or after the ex-date: nothing to rescale
    let p = 1;
    let v = 1;
    if (event.type === "CASH_DIVIDEND") {
      const previousClose = bars[lastBefore]!.close;
      if (previousClose === null) throw new Error(`${orderbookId}: no close before the ${event.exDate} dividend to size it against`);
      p = 1 - event.amount / previousClose;
      if (!(p > 0)) throw new Error(`${orderbookId}: dividend ${event.amount} on ${event.exDate} is not below the previous close ${previousClose}`);
    } else {
      p = 1 / event.ratio;
      v = event.ratio;
    }
    for (let i = 0; i <= lastBefore; i++) {
      priceFactor[i]! *= p;
      volumeFactor[i]! *= v;
    }
    eventsApplied++;
  }
  const adjusted = bars.map((b, i) => ({
    tradeDate: b.tradeDate,
    close: b.close === null ? null : b.close * priceFactor[i]!,
    volume: b.volume === null ? null : b.volume * volumeFactor[i]!,
    turnover: b.turnover,
  }));
  return { bars: adjusted, priceBasis: "ADJUSTED", eventsApplied };
}
