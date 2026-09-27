import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  earlyCloseAt,
  expectedLatestBar,
  isTradingDay,
  nextTradingDay,
  previousTradingDay,
  tradingDays,
  validateCalendar,
} from "../src/calendar/trading-days.js";
import {
  EXCHANGE_CALENDARS,
  NASDAQ_NORDIC_HOLIDAYS,
  type CalendarException,
  type ExchangeCalendar,
} from "../src/config/exchange-calendars.js";
import type { Market } from "../src/sources/nasdaq.js";

const MARKETS: Market[] = ["HEL", "STO", "CPH"];

interface TradingDatesFixture {
  markets: Record<Market, { from: string; to: string; tradingDates: string[] }>;
}
const fixture = JSON.parse(readFileSync("test/fixtures/trading-dates.json", "utf8")) as TradingDatesFixture;

function* weekdays(from: string, to: string): Generator<string> {
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) yield d.toISOString().slice(0, 10);
  }
}

describe("sourced calendar against the price fixture (2025-09-01 to 2026-09-25)", () => {
  it.each(MARKETS)("%s trades exactly on the fixture's dates", (market) => {
    const { from, to, tradingDates } = fixture.markets[market];
    expect([from, to]).toEqual(["2025-09-01", "2026-09-25"]);
    const traded = new Set(tradingDates);
    const mismatches: string[] = [];
    let checked = 0;
    for (const date of weekdays(from, to)) {
      checked++;
      if (isTradingDay(market, date) !== traded.has(date)) mismatches.push(date);
    }
    expect(mismatches).toEqual([]);
    // 261 weekdays from 2025-09-01 to 2026-08-31, plus 19 in September 2026.
    expect(checked).toBe(280);
    // And the fixture holds no weekend dates, so the set of trading days is identical.
    expect([...tradingDays(market, from, to)]).toEqual(tradingDates);
  });

  it("gives the closed weekdays listed in the task file", () => {
    const closedIn = (market: Market) =>
      [...weekdays("2025-09-01", "2026-09-25")].filter((d) => !isTradingDay(market, d));
    const nordic = [
      "2025-12-24", "2025-12-25", "2025-12-26", "2025-12-31", "2026-01-01", "2026-01-06",
      "2026-04-03", "2026-04-06", "2026-05-01", "2026-05-14", "2026-06-19",
    ];
    expect(closedIn("HEL")).toEqual(nordic);
    expect(closedIn("STO")).toEqual(nordic);
    expect(closedIn("CPH")).toEqual([
      "2025-12-24", "2025-12-25", "2025-12-26", "2025-12-31", "2026-01-01", "2026-04-02",
      "2026-04-03", "2026-04-06", "2026-05-14", "2026-05-15", "2026-05-25", "2026-06-05",
    ]);
  });
});

describe("the sourced data file", () => {
  it("is valid and frozen", () => {
    expect(() => validateCalendar(EXCHANGE_CALENDARS)).not.toThrow();
    expect(Object.isFrozen(EXCHANGE_CALENDARS.exceptions)).toBe(true);
    expect(Object.isFrozen(EXCHANGE_CALENDARS.exceptions[0])).toBe(true);
  });

  it("covers HEL, STO and CPH from 2025-09-01 to 2027-12-31, with a source for each year", () => {
    for (const market of MARKETS) {
      const cov = EXCHANGE_CALENDARS.markets[market];
      expect(cov?.from).toBe("2025-09-01");
      expect(cov?.to).toBe("2027-12-31");
      expect(Object.keys(cov?.sources ?? {}).sort()).toEqual(["2025", "2026", "2027"]);
    }
  });

  it("cites Nasdaq's own holiday page for every exception", () => {
    for (const e of EXCHANGE_CALENDARS.exceptions) expect(e.source).toEqual(NASDAQ_NORDIC_HOLIDAYS);
    expect(NASDAQ_NORDIC_HOLIDAYS.url).toBe("https://www.nasdaq.com/european-market-activity/trading-hours");
  });

  it("counts the published exceptions per market", () => {
    const count = (market: Market, kind: CalendarException["kind"]) =>
      EXCHANGE_CALENDARS.exceptions.filter((e) => e.market === market && e.kind === kind).length;
    // 2025 from September, then all of 2026 and 2027.
    expect(count("HEL", "closed")).toBe(4 + 10 + 9);
    expect(count("STO", "closed")).toBe(4 + 10 + 8);
    expect(count("CPH", "closed")).toBe(4 + 11 + 9);
    expect(count("STO", "early_close")).toBe(1 + 5 + 5);
    expect(count("HEL", "early_close")).toBe(0);
    expect(count("CPH", "early_close")).toBe(0);
  });
});

describe("November 2026 (the planned scored month)", () => {
  it.each(MARKETS)("%s has 21 trading days and no closures or early closes", (market) => {
    expect(tradingDays(market, "2026-11-01", "2026-11-30").size).toBe(21);
    const inNovember = EXCHANGE_CALENDARS.exceptions.filter((e) => e.market === market && e.date.startsWith("2026-11"));
    expect(inNovember).toEqual([]);
  });
});

describe("isTradingDay", () => {
  it("is false at weekends", () => {
    expect(isTradingDay("HEL", "2026-11-07")).toBe(false); // Saturday
    expect(isTradingDay("STO", "2026-11-08")).toBe(false); // Sunday
    expect(isTradingDay("CPH", "2026-11-09")).toBe(true); // Monday
  });

  it("counts an early close as a trading day", () => {
    expect(isTradingDay("STO", "2026-10-30")).toBe(true);
    expect(earlyCloseAt("STO", "2026-10-30")).toBe("13:00");
    expect(earlyCloseAt("STO", "2026-01-05")).toBe("13:00");
    expect(earlyCloseAt("HEL", "2026-10-30")).toBeNull();
    expect(earlyCloseAt("STO", "2026-11-02")).toBeNull();
  });

  it("differs between markets on the same day", () => {
    expect(isTradingDay("HEL", "2026-04-02")).toBe(true);
    expect(isTradingDay("STO", "2026-04-02")).toBe(true); // half day
    expect(isTradingDay("CPH", "2026-04-02")).toBe(false);
    expect(isTradingDay("HEL", "2027-12-06")).toBe(false); // Helsinki only
    expect(isTradingDay("STO", "2027-12-06")).toBe(true);
  });
});

describe("previous and next trading day", () => {
  it("steps over Christmas 2026", () => {
    // 24-25 Dec closed (Thu-Fri), 26-27 weekend.
    expect(nextTradingDay("HEL", "2026-12-23")).toBe("2026-12-28");
    expect(previousTradingDay("HEL", "2026-12-28")).toBe("2026-12-23");
    expect(previousTradingDay("CPH", "2026-12-26")).toBe("2026-12-23");
  });

  it("steps over New Year and Epiphany 2027", () => {
    // 31 Dec and 1 Jan closed, 2-3 Jan weekend; 6 Jan closed in HEL and STO but not CPH.
    expect(nextTradingDay("HEL", "2026-12-30")).toBe("2027-01-04");
    expect(nextTradingDay("HEL", "2027-01-05")).toBe("2027-01-07");
    expect(nextTradingDay("CPH", "2027-01-05")).toBe("2027-01-06");
  });

  it("is strict: a trading day is not its own neighbour", () => {
    expect(previousTradingDay("STO", "2026-11-11")).toBe("2026-11-10");
    expect(nextTradingDay("STO", "2026-11-11")).toBe("2026-11-12");
  });

  it("throws when the answer would fall outside the covered range", () => {
    expect(() => previousTradingDay("HEL", "2025-09-01")).toThrow(/no trading day before/);
    expect(() => nextTradingDay("HEL", "2027-12-30")).toThrow(/no trading day after/);
  });
});

describe("expectedLatestBar", () => {
  it("is Friday's bar on a Monday", () => {
    expect(expectedLatestBar("HEL", "2026-11-09")).toBe("2026-11-06");
  });

  it("skips a holiday, per market", () => {
    // Tuesday after Easter 2026: HEL closed Fri 3 and Mon 6 Apr; CPH also closed Thu 2 Apr.
    expect(expectedLatestBar("HEL", "2026-04-07")).toBe("2026-04-02");
    expect(expectedLatestBar("CPH", "2026-04-07")).toBe("2026-04-01");
  });

  it("returns a half day's bar", () => {
    // STO: 5 Jan 2026 half day, 6 Jan closed.
    expect(expectedLatestBar("STO", "2026-01-07")).toBe("2026-01-05");
  });

  it("accepts a weekend run date", () => {
    expect(expectedLatestBar("STO", "2026-11-08")).toBe("2026-11-06");
  });
});

describe("errors", () => {
  it("throws for a date outside the covered range", () => {
    expect(() => isTradingDay("HEL", "2025-08-29")).toThrow(/outside the calendar's covered range/);
    expect(() => isTradingDay("CPH", "2028-01-03")).toThrow(/outside the calendar's covered range/);
    expect(() => tradingDays("STO", "2027-12-01", "2028-01-31")).toThrow(/outside/);
    expect(() => expectedLatestBar("HEL", "2028-01-03")).toThrow(/outside/);
    expect(() => earlyCloseAt("STO", "2024-12-23")).toThrow(/outside/);
  });

  it("throws for a malformed date", () => {
    for (const bad of ["2026-11-31", "2026-02-29", "2026-1-5", "05.01.2026", "", "2026-11-02T00:00:00Z"]) {
      expect(() => isTradingDay("HEL", bad)).toThrow(/Malformed date/);
    }
    expect(() => nextTradingDay("STO", "2026-13-01")).toThrow(/Malformed date/);
  });

  it("throws for an unknown market", () => {
    expect(() => isTradingDay("OSL" as Market, "2026-11-02")).toThrow(/Unknown market/);
    expect(() => tradingDays("hel" as Market, "2026-11-02", "2026-11-06")).toThrow(/Unknown market/);
  });

  it("throws for a reversed range", () => {
    expect(() => tradingDays("HEL", "2026-11-06", "2026-11-02")).toThrow(/after it ends/);
  });
});

describe("with a small calendar", () => {
  const source = { url: "https://example.com/holidays", accessed: "2026-09-27" };
  const small: ExchangeCalendar = {
    markets: { HEL: { from: "2026-12-21", to: "2027-01-08", sources: { "2026": source, "2027": source } } },
    exceptions: [
      { market: "HEL", date: "2026-12-24", kind: "closed", note: "Test", source },
      { market: "HEL", date: "2026-12-23", kind: "early_close", closesAt: "14:00", note: "Test", source },
    ],
  };

  it("uses the calendar given, not the sourced one", () => {
    expect(isTradingDay("HEL", "2026-12-25", small)).toBe(true);
    expect(earlyCloseAt("HEL", "2026-12-23", small)).toBe("14:00");
    expect([...tradingDays("HEL", "2026-12-21", "2026-12-25", small)]).toEqual([
      "2026-12-21", "2026-12-22", "2026-12-23", "2026-12-25",
    ]);
    expect(() => isTradingDay("STO", "2026-12-21", small)).toThrow(/Unknown market/);
    expect(() => isTradingDay("HEL", "2026-12-20", small)).toThrow(/outside/);
  });

  const withException = (e: Record<string, unknown>): ExchangeCalendar => ({
    ...small,
    exceptions: [...small.exceptions, e as unknown as CalendarException],
  });

  it("rejects inconsistent calendars", () => {
    expect(() => validateCalendar(withException({ market: "HEL", date: "2026-12-26", kind: "closed", note: "x", source }))).toThrow(/weekend/);
    expect(() => validateCalendar(withException({ market: "HEL", date: "2026-12-24", kind: "closed", note: "x", source }))).toThrow(/duplicate/);
    expect(() => validateCalendar(withException({ market: "HEL", date: "2027-01-11", kind: "closed", note: "x", source }))).toThrow(/outside/);
    expect(() => validateCalendar(withException({ market: "STO", date: "2026-12-28", kind: "closed", note: "x", source }))).toThrow(/without coverage/);
    expect(() => validateCalendar(withException({ market: "HEL", date: "2026-12-28", kind: "early_close", note: "x", source }))).toThrow();
    expect(() =>
      validateCalendar(withException({ market: "HEL", date: "2026-12-28", kind: "closed", closesAt: "13:00", note: "x", source })),
    ).toThrow();
    expect(() =>
      validateCalendar({ ...small, markets: { HEL: { from: "2026-12-21", to: "2027-01-08", sources: { "2026": source } } } }),
    ).toThrow(/no source recorded for 2027/);
  });
});
