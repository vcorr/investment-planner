import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCsv, parseEcbCsv } from "../src/sources/ecb.js";

const HEADER = "KEY,CURRENCY,TIME_PERIOD,OBS_VALUE";

describe("parseCsv", () => {
  it("keeps commas inside quoted fields", () => {
    expect(parseCsv('a,"b, c",d\n')).toEqual([["a", "b, c", "d"]]);
  });

  it("unescapes doubled quotes", () => {
    expect(parseCsv('"say ""hi"""\n')).toEqual([['say "hi"']]);
  });

  it("handles CRLF and a missing final newline", () => {
    expect(parseCsv("a,b\r\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("parseEcbCsv", () => {
  // Real response for SEK and DKK, 23-25 September 2026, saved on 2026-09-26.
  const rates = parseEcbCsv(readFileSync("test/fixtures/ecb-exr.csv", "utf8"));

  it("returns one rate per currency and day", () => {
    expect(rates).toHaveLength(6);
    expect(new Set(rates.map((r) => r.currency))).toEqual(new Set(["DKK", "SEK"]));
  });

  it("reads units per euro", () => {
    expect(rates.find((r) => r.currency === "DKK" && r.rateDate === "2026-09-23")?.unitsPerEur).toBe(7.4756);
  });

  it("rejects a missing column", () => {
    expect(() => parseEcbCsv("KEY,CURRENCY,TIME_PERIOD\nx,SEK,2026-09-25\n")).toThrow(/OBS_VALUE missing/);
  });

  it("rejects a short row instead of inventing values", () => {
    expect(() => parseEcbCsv(`${HEADER}\nx,SEK\n`)).toThrow(/short/);
  });

  it.each([
    ["x,SEK,2026-09-25,", /bad rate/],
    ["x,SEK,2026-09-25,NaN", /bad rate/],
    ["x,SEK,2026-09-25,0", /bad rate/],
    ["x,sek,2026-09-25,11.1", /bad currency/],
    ["x,SEK,25.09.2026,11.1", /bad date/],
  ])("rejects %s", (row, error) => {
    expect(() => parseEcbCsv(`${HEADER}\n${row}\n`)).toThrow(error);
  });
});
