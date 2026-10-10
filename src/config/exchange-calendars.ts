import type { Market } from "../sources/nasdaq.js";

// Exchange holiday calendars for Nasdaq Helsinki, Stockholm and Copenhagen (equities).
// Only exceptions are listed: weekends are always closed, and every other weekday in the covered range trades.
// Every date is copied from Nasdaq's published holiday schedule; none is computed from holiday rules.

export type CalendarDayKind = "closed" | "early_close";

export interface CalendarSource {
  url: string;
  /** Date we read the page, YYYY-MM-DD. */
  accessed: string;
}

export interface CalendarException {
  market: Market;
  /** YYYY-MM-DD, a weekday. */
  date: string;
  kind: CalendarDayKind;
  /** Local close time "HH:MM"; early closes only. */
  closesAt?: string;
  /** The label as published. The source gives no holiday names. */
  note: string;
  source: CalendarSource;
}

export interface MarketCoverage {
  /** First and last date the calendar vouches for, inclusive. */
  from: string;
  to: string;
  /** Source per calendar year inside the range. */
  sources: Readonly<Record<string, CalendarSource>>;
}

export interface ExchangeCalendar {
  markets: Readonly<Partial<Record<Market, MarketCoverage>>>;
  exceptions: ReadonlyArray<CalendarException>;
}

/**
 * Nasdaq European Markets Trading Hours and Holiday Schedule: tables "Exchange Holiday Schedule 2025/2026/2027",
 * column "Equity/Equity derivatives". Half-day hours for equities are given on the same page as 09.00-13.00.
 */
export const NASDAQ_NORDIC_HOLIDAYS: CalendarSource = Object.freeze({
  url: "https://www.nasdaq.com/european-market-activity/trading-hours",
  accessed: "2026-09-27",
});

const HALF_DAY_CLOSE = "13:00";

function closed(market: Market, year: number, dates: string[]): CalendarException[] {
  return dates.map((d) => ({
    market,
    date: `${year}-${d}`,
    kind: "closed",
    note: `Closed (Exchange Holiday Schedule ${year})`,
    source: NASDAQ_NORDIC_HOLIDAYS,
  }));
}

function halfDay(market: Market, year: number, dates: string[]): CalendarException[] {
  return dates.map((d) => ({
    market,
    date: `${year}-${d}`,
    kind: "early_close",
    closesAt: HALF_DAY_CLOSE,
    note: `Half trading day (Exchange Holiday Schedule ${year})`,
    source: NASDAQ_NORDIC_HOLIDAYS,
  }));
}

const COVERAGE: MarketCoverage = {
  from: "2025-09-01",
  to: "2027-12-31",
  sources: { "2025": NASDAQ_NORDIC_HOLIDAYS, "2026": NASDAQ_NORDIC_HOLIDAYS, "2027": NASDAQ_NORDIC_HOLIDAYS },
};

// 2025 lists only the dates from 1 September, where coverage starts.
const EXCEPTIONS: CalendarException[] = [
  // Helsinki: no half trading days published.
  ...closed("HEL", 2025, ["12-24", "12-25", "12-26", "12-31"]),
  ...closed("HEL", 2026, ["01-01", "01-06", "04-03", "04-06", "05-01", "05-14", "06-19", "12-24", "12-25", "12-31"]),
  ...closed("HEL", 2027, ["01-01", "01-06", "03-26", "03-29", "05-06", "06-25", "12-06", "12-24", "12-31"]),

  // Stockholm. The fixed-income column lists more half days (e.g. 23 and 30 Dec); those do not apply to equities.
  ...closed("STO", 2025, ["12-24", "12-25", "12-26", "12-31"]),
  ...halfDay("STO", 2025, ["10-31"]),
  ...closed("STO", 2026, ["01-01", "01-06", "04-03", "04-06", "05-01", "05-14", "06-19", "12-24", "12-25", "12-31"]),
  ...halfDay("STO", 2026, ["01-05", "04-02", "04-30", "05-13", "10-30"]),
  ...closed("STO", 2027, ["01-01", "01-06", "03-26", "03-29", "05-06", "06-25", "12-24", "12-31"]),
  ...halfDay("STO", 2027, ["01-05", "03-25", "04-30", "05-05", "11-05"]),

  // Copenhagen: no half trading days published.
  ...closed("CPH", 2025, ["12-24", "12-25", "12-26", "12-31"]),
  ...closed("CPH", 2026, [
    "01-01", "04-02", "04-03", "04-06", "05-14", "05-15", "05-25", "06-05", "12-24", "12-25", "12-31",
  ]),
  ...closed("CPH", 2027, ["01-01", "03-25", "03-26", "03-29", "05-06", "05-07", "05-17", "12-24", "12-31"]),
];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

export const EXCHANGE_CALENDARS: ExchangeCalendar = deepFreeze({
  markets: { HEL: COVERAGE, STO: COVERAGE, CPH: COVERAGE },
  exceptions: EXCEPTIONS,
});
