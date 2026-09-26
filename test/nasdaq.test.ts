import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDailyBars, parseNasdaqNumber, type BarRequest } from "../src/sources/nasdaq.js";

const fixture = (name: string): any => JSON.parse(readFileSync(`test/fixtures/${name}`, "utf8"));

// Real response for Nokia (TX50063), 21-25 September 2026, saved on 2026-09-26.
const NOKIA = "nasdaq-chart-download-nokia.json";
const REQUEST: BarRequest = { orderbookId: "TX50063", fromDate: "2026-09-21", toDate: "2026-09-25" };

/** The Nokia fixture with its newest row (25 September) changed. */
function withNewestRow(change: Record<string, string>): unknown {
  const body = fixture(NOKIA);
  Object.assign(body.data.charts.rows[0], change);
  return body;
}

describe("parseNasdaqNumber", () => {
  it("strips comma thousand separators", () => {
    expect(parseNasdaqNumber("14,639,094")).toBe(14_639_094);
    expect(parseNasdaqNumber("134,991,407.22")).toBe(134_991_407.22);
  });

  it("keeps decimals", () => {
    expect(parseNasdaqNumber("9.128")).toBe(9.128);
    expect(parseNasdaqNumber("1182")).toBe(1182);
  });

  it("treats empty as missing", () => {
    expect(parseNasdaqNumber("")).toBeNull();
    expect(parseNasdaqNumber("  ")).toBeNull();
  });

  it.each(["n/a", "0x10", "1e3", "1.234,50", "1,23", "-5", "12,3456"])("rejects %s instead of guessing", (raw) => {
    expect(() => parseNasdaqNumber(raw)).toThrow(/Unparseable/);
  });
});

describe("parseDailyBars", () => {
  const bars = parseDailyBars(fixture(NOKIA), REQUEST);

  it("returns one bar per trading day, oldest first", () => {
    expect(bars.map((b) => b.tradeDate)).toEqual(["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25"]);
  });

  it("maps the official opening price and the other fields", () => {
    expect(bars.at(-1)).toEqual({
      tradeDate: "2026-09-25",
      open: 9.25,
      high: 9.466,
      low: 9.118,
      close: 9.128,
      average: 9.2183,
      bid: 9.136,
      ask: 9.148,
      volume: 14_639_094,
      turnover: 134_991_407.22,
      trades: 15_822,
    });
  });

  it("turns empty fields into null", () => {
    const [bar] = parseDailyBars(withNewestRow({ open: "", bid: "", trades: "" }), REQUEST).slice(-1);
    expect(bar).toMatchObject({ open: null, bid: null, trades: null, close: 9.128 });
  });

  it("rejects an error response", () => {
    expect(() => parseDailyBars(fixture("nasdaq-chart-download-error.json"), REQUEST)).toThrow();
  });

  it("rejects a response for another instrument", () => {
    expect(() => parseDailyBars(fixture(NOKIA), { ...REQUEST, orderbookId: "TX50064" })).toThrow(/asked for TX50064/);
  });

  it("rejects bars outside the requested dates", () => {
    expect(() => parseDailyBars(fixture(NOKIA), { ...REQUEST, toDate: "2026-09-24" })).toThrow(/outside the requested range/);
  });

  it("rejects a repeated date", () => {
    expect(() => parseDailyBars(withNewestRow({ dateTime: "2026-09-24" }), REQUEST)).toThrow(/appears twice/);
  });

  it("rejects impossible bars", () => {
    expect(() => parseDailyBars(withNewestRow({ low: "0" }), REQUEST)).toThrow(/non-positive/);
    expect(() => parseDailyBars(withNewestRow({ high: "9.0" }), REQUEST)).toThrow(/high below low/);
    expect(() => parseDailyBars(withNewestRow({ open: "9.5" }), REQUEST)).toThrow(/open 9.5 is outside/);
  });
});
