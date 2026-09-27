import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_COST_CONFIG as COSTS } from "../src/costs/config.js";
import { parseDailyBars } from "../src/sources/nasdaq.js";
import {
  DEFAULT_SIZING_RULES as RULES,
  simulateEntry,
  simulateExit,
  simulateStopsAndTargets,
  type Bar,
  type EntryOrder,
  type MarketDay,
  type Position,
} from "../src/sim/fills.js";

// Nasdaq Helsinki trading days around the Nokia fixture; 2026-09-26 and 27 are a weekend.
const OPEN_DATES = new Set(["2026-09-24", "2026-09-25", "2026-09-28", "2026-09-29"]);
const LIQUID = 5_000_000; // 10 bps band
const MID = 2_000_000; // 25 bps band

const bar = (tradeDate: string, open: number | null, high: number | null, low: number | null, close: number | null = null): Bar => ({
  tradeDate,
  open,
  high,
  low,
  close,
});
const day = (b: Bar | null, date = b?.tradeDate ?? "2026-09-26", eurRate = 1): MarketDay => ({ date, openDates: OPEN_DATES, bar: b, eurRate });

// With an open of 100, these give a stop at 90 and a target at 120, matching `position()` below.
const entry = (change: Partial<EntryOrder> = {}): EntryOrder => ({
  currency: "EUR",
  sizeEur: 1_500,
  stopPct: 0.1,
  targetPct: 0.2,
  medianTurnoverEur: LIQUID,
  ...change,
});
const position = (change: Partial<Position> = {}): Position => ({
  currency: "EUR",
  shares: 15,
  stopPrice: 90,
  targetPrice: 120,
  medianTurnoverEur: LIQUID,
  ...change,
});

function filledEntry(result: ReturnType<typeof simulateEntry>) {
  if (result.status !== "FILLED") throw new Error(`expected a fill, got ${JSON.stringify(result)}`);
  return result;
}
function filledExit(result: ReturnType<typeof simulateStopsAndTargets>) {
  if (result.status !== "FILLED") throw new Error(`expected a fill, got ${JSON.stringify(result)}`);
  return result.exit;
}

describe("entries at the open", () => {
  // Real Nokia bar for 2026-09-25 (open 9.25, high 9.466, low 9.118).
  const nokia = parseDailyBars(JSON.parse(readFileSync("test/fixtures/nasdaq-chart-download-nokia.json", "utf8")), {
    orderbookId: "TX50063",
    fromDate: "2026-09-21",
    toDate: "2026-09-25",
  }).at(-1);

  it("buys whole shares at open × (1 + s) and books every cost", () => {
    const result = filledEntry(simulateEntry(entry(), day(nokia!), 5_000, COSTS, RULES));
    expect(result.entry).toMatchObject({ side: "BUY", reason: "ENTRY", shares: 162, rawPrice: 9.25, feeEur: 9, fxFeeEur: 0 });
    expect(result.entry.fillPrice).toBeCloseTo(9.25925, 10);
    expect(result.entry.grossEur).toBeCloseTo(1_499.9985, 8);
    expect(result.entry.slippageEur).toBeCloseTo(1.4985, 8);
    expect(result.entry.cashChangeEur).toBe(-1_509);
    expect(result.entry.provenance).toEqual({ fee: "SOURCED", fxFee: null, slippage: "ASSUMED" });
    expect(result.sameDayExit).toBeNull();
  });

  it("converts a SEK entry at the day's ECB rate and adds the FX fee, on the Nordic fee schedule", () => {
    const result = filledEntry(
      simulateEntry(entry({ currency: "SEK", medianTurnoverEur: MID }), day(bar("2026-09-25", 150, 152, 149), undefined, 11), 5_000, COSTS, RULES),
    );
    expect(result.entry).toMatchObject({ currency: "SEK", shares: 109, eurRate: 11, feeEur: 10, fxFeeEur: 3.73 });
    expect(result.entry.fillPrice).toBeCloseTo(150.375, 10);
    expect(result.entry.grossEur).toBeCloseTo((109 * 150.375) / 11, 8);
    // (109 × 150.375) / 11 + 10 + 3.73 = 1,503.8095… €, booked as 1,503.81 €.
    expect(result.entry.cashChangeEur).toBe(-1_503.81);
    expect(result.entry.provenance).toEqual({ fee: "SOURCED", fxFee: "SOURCED", slippage: "ASSUMED" });
  });

  it("charges DKK names the Nordic minimum of 10 €", () => {
    const result = filledEntry(simulateEntry(entry({ currency: "DKK" }), day(bar("2026-09-25", 100, 101, 99), undefined, 7.46), 5_000, COSTS, RULES));
    expect(result.entry.feeEur).toBe(10);
  });
});

describe("adverse slippage", () => {
  const b = bar("2026-09-25", 100, 101, 99);

  it("makes buys dearer", () => {
    expect(filledEntry(simulateEntry(entry(), day(b), 5_000, COSTS, RULES)).entry.fillPrice).toBeCloseTo(100.1, 10);
    expect(filledEntry(simulateEntry(entry({ medianTurnoverEur: MID }), day(b), 5_000, COSTS, RULES)).entry.fillPrice).toBeCloseTo(100.25, 10);
  });

  it("makes discretionary sells cheaper", () => {
    const result = simulateExit(position(), day(b), COSTS);
    if (result.status !== "FILLED") throw new Error("expected a fill");
    expect(result.exit).toMatchObject({ side: "SELL", reason: "EXIT", rawPrice: 100 });
    expect(result.exit.fillPrice).toBeCloseTo(99.9, 10);
    expect(result.exit.cashChangeEur).toBe(1_489.5);
  });

  it("makes stop and target sells cheaper", () => {
    expect(filledExit(simulateStopsAndTargets(position(), day(bar("2026-09-25", 95, 96, 89)), COSTS)).fillPrice).toBeCloseTo(90 * 0.999, 10);
    expect(filledExit(simulateStopsAndTargets(position(), day(bar("2026-09-25", 115, 121, 114)), COSTS)).fillPrice).toBeCloseTo(120 * 0.999, 10);
  });
});

describe("stops and targets", () => {
  it("fills a gap down through the stop at the open, not the stop", () => {
    const exit = filledExit(simulateStopsAndTargets(position(), day(bar("2026-09-25", 85, 87, 80)), COSTS));
    expect(exit).toMatchObject({ reason: "STOP", rawPrice: 85 });
    expect(exit.fillPrice).toBeCloseTo(85 * 0.999, 10);
  });

  it("fills a gap up through the target at the open", () => {
    const exit = filledExit(simulateStopsAndTargets(position(), day(bar("2026-09-25", 125, 126, 124)), COSTS));
    expect(exit).toMatchObject({ reason: "TARGET", rawPrice: 125 });
  });

  it("assumes the stop filled first when both are touched on the same day", () => {
    const exit = filledExit(simulateStopsAndTargets(position(), day(bar("2026-09-25", 100, 125, 85)), COSTS));
    expect(exit).toMatchObject({ reason: "STOP", rawPrice: 90 });
  });

  it("does nothing when neither is touched", () => {
    expect(simulateStopsAndTargets(position(), day(bar("2026-09-25", 100, 110, 95)), COSTS)).toEqual({ status: "NO_FILL", date: "2026-09-25" });
  });

  it("triggers at exactly the stop and exactly the target", () => {
    expect(filledExit(simulateStopsAndTargets(position(), day(bar("2026-09-25", 100, 110, 90)), COSTS)).reason).toBe("STOP");
    expect(filledExit(simulateStopsAndTargets(position(), day(bar("2026-09-25", 100, 120, 95)), COSTS)).reason).toBe("TARGET");
  });

  it("checks the stop on the entry day itself, after the open fill (A6)", () => {
    const result = filledEntry(simulateEntry(entry(), day(bar("2026-09-25", 100, 101, 88)), 5_000, COSTS, RULES));
    expect(result.entry.shares).toBe(14);
    expect(result.sameDayExit).toMatchObject({ side: "SELL", reason: "STOP", shares: 14, rawPrice: 90 });
  });

  it("sets the stop and target from the actual open, so a gap down at the open is not stopped out at once", () => {
    // The share closed at 100 the day before but opens at 80: the stop is 72, not 90, and the entry stands.
    const result = filledEntry(simulateEntry(entry(), day(bar("2026-09-25", 80, 82, 78)), 5_000, COSTS, RULES));
    expect(result.position.stopPrice).toBeCloseTo(72, 10);
    expect(result.position.targetPrice).toBeCloseTo(96, 10);
    expect(result.sameDayExit).toBeNull();
  });

  it("checks the target on the entry day too", () => {
    const result = filledEntry(simulateEntry(entry(), day(bar("2026-09-25", 100, 121, 99)), 5_000, COSTS, RULES));
    expect(result.sameDayExit).toMatchObject({ reason: "TARGET", rawPrice: 120 });
  });

  it("throws if low or high is missing, since the stop cannot be checked", () => {
    expect(() => simulateStopsAndTargets(position(), day(bar("2026-09-25", 100, 110, null)), COSTS)).toThrow(/low or high missing/);
    expect(() => simulateStopsAndTargets(position(), day(bar("2026-09-25", 100, null, 95)), COSTS)).toThrow(/low or high missing/);
  });
});

describe("closed exchanges and missing data", () => {
  it("queues an order on an exchange holiday or weekend to the next open day", () => {
    expect(simulateEntry(entry(), day(null, "2026-09-26"), 5_000, COSTS, RULES)).toEqual({
      status: "QUEUED",
      date: "2026-09-26",
      nextOpenDate: "2026-09-28",
    });
    expect(simulateExit(position(), day(null, "2026-09-27"), COSTS)).toMatchObject({ status: "QUEUED", nextOpenDate: "2026-09-28" });
    expect(simulateStopsAndTargets(position(), day(null, "2026-09-26"), COSTS)).toMatchObject({ status: "QUEUED" });
  });

  it("reports no next open day when the calendar given ends first", () => {
    expect(simulateExit(position(), day(null, "2026-09-30"), COSTS)).toMatchObject({ status: "QUEUED", nextOpenDate: null });
  });

  it("throws on a missing open on a trading day", () => {
    expect(() => simulateEntry(entry(), day(bar("2026-09-25", null, 101, 99)), 5_000, COSTS, RULES)).toThrow(/no official open/);
    expect(() => simulateExit(position(), day(bar("2026-09-25", null, 101, 99)), COSTS)).toThrow(/no official open/);
    expect(() => simulateStopsAndTargets(position(), day(bar("2026-09-25", null, 101, 99)), COSTS)).toThrow(/no official open/);
  });

  it("throws on a missing bar on a trading day, and on a bar for a closed day", () => {
    expect(() => simulateExit(position(), day(null, "2026-09-25"), COSTS)).toThrow(/no bar/);
    expect(() => simulateExit(position(), day(bar("2026-09-26", 100, 101, 99)), COSTS)).toThrow(/closed/);
  });

  it("never fills against a bar from another day (leakage, brief §19)", () => {
    expect(() => simulateExit(position(), day(bar("2026-09-24", 100, 101, 99), "2026-09-25"), COSTS)).toThrow(/dated 2026-09-24/);
  });

  it("throws on turnover below 1 M€", () => {
    expect(() => simulateEntry(entry({ medianTurnoverEur: 900_000 }), day(bar("2026-09-25", 100, 101, 99)), 5_000, COSTS, RULES)).toThrow(
      /outside the universe/,
    );
    expect(() => simulateExit(position({ medianTurnoverEur: 900_000 }), day(bar("2026-09-25", 100, 101, 99)), COSTS)).toThrow(/outside the universe/);
  });

  it("throws on inconsistent inputs rather than guessing", () => {
    const b = day(bar("2026-09-25", 100, 101, 99));
    expect(() => simulateEntry(entry({ stopPct: 0 }), b, 5_000, COSTS, RULES)).toThrow(/between 0 and 1/);
    expect(() => simulateEntry(entry({ stopPct: 1 }), b, 5_000, COSTS, RULES)).toThrow(/between 0 and 1/);
    expect(() => simulateEntry(entry({ targetPct: 0 }), b, 5_000, COSTS, RULES)).toThrow(/Target fraction/);
    expect(() => simulateExit(position({ shares: 1.5 }), b, COSTS)).toThrow(/whole number/);
    expect(() => simulateExit(position(), { ...b, eurRate: 11 }, COSTS)).toThrow(/EUR rate must be 1/);
    expect(() => simulateExit(position({ currency: "SEK" }), { ...b, eurRate: 0 }, COSTS)).toThrow(/SEK rate/);
  });
});

describe("cash in whole cents", () => {
  it("rounds every fill's cash change to 0.01 €", () => {
    const b = day(bar("2026-09-25", 100.123, 101, 99));
    const { entry: e } = filledEntry(simulateEntry(entry(), b, 5_000, COSTS, RULES));
    expect(Math.round(e.cashChangeEur * 100) / 100).toBe(e.cashChangeEur);
    expect(Math.abs(e.cashChangeEur + e.grossEur + e.feeEur + e.fxFeeEur)).toBeLessThanOrEqual(0.005);
  });
});

describe("whole shares and sizing rules", () => {
  it("rounds the share count down", () => {
    // 1,500 / 100.1 = 14.99, so 14 shares for 1,401.40 €.
    const result = filledEntry(simulateEntry(entry(), day(bar("2026-09-25", 100, 101, 99)), 5_000, COSTS, RULES));
    expect(result.entry.shares).toBe(14);
    expect(result.entry.grossEur).toBeCloseTo(1_401.4, 8);
  });

  it("rejects an entry that rounding drops below 1,250 €, rather than trading smaller", () => {
    // 1,500 / 760.76 = 1.97, so one share for 760.76 €.
    const result = simulateEntry(entry(), day(bar("2026-09-25", 760, 770, 750)), 5_000, COSTS, RULES);
    expect(result).toMatchObject({ status: "REJECTED", reason: "BELOW_MIN_POSITION" });
  });

  it("rejects an entry when a single share costs more than the position size", () => {
    const result = simulateEntry(entry(), day(bar("2026-09-25", 1_600, 1_610, 1_590)), 5_000, COSTS, RULES);
    expect(result).toMatchObject({ status: "REJECTED", reason: "ZERO_SHARES" });
  });

  it("rejects an entry that would leave less than the 250 € cash floor, fees included", () => {
    // 14 shares cost 1,401.40 € plus a 9 € fee: 1,660 € of cash leaves 249.60 €.
    const b = day(bar("2026-09-25", 100, 101, 99));
    expect(simulateEntry(entry(), b, 1_660, COSTS, RULES)).toMatchObject({ status: "REJECTED", reason: "CASH_FLOOR" });
    expect(simulateEntry(entry(), b, 1_660.4, COSTS, RULES)).toMatchObject({ status: "FILLED" });
  });
});
