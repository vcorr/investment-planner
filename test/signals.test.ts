import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Currency } from "../src/costs/config.js";
import type { FxRate } from "../src/sources/ecb.js";
import type { Market } from "../src/sources/nasdaq.js";
import { compoundedMarketReturn, equalWeightMarketSeries, type MarketReturn } from "../src/signals/market.js";
import { adjustBars, type AdjustmentEvent, type PriceSeries, type SignalBar } from "../src/signals/series.js";
import {
  distanceFromHigh,
  eurRateLookup,
  median,
  medianTurnoverEur,
  realisedVolatility,
  relativeMomentum,
  volumeAnomaly,
} from "../src/signals/signals.js";
import { signalSnapshot, type SnapshotInput } from "../src/signals/snapshot.js";

// ---- Synthetic helpers -------------------------------------------------------------------------------------

/** `n` consecutive weekdays from `start` (a Monday is easiest to reason about). */
function weekdays(start: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  while (out.length < n) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const bars = (closes: ReadonlyArray<number | null>, dates = weekdays("2026-01-05", closes.length), volume = 1_000, turnover = 1_000_000): SignalBar[] =>
  closes.map((close, i) => ({ tradeDate: dates[i]!, close, volume, turnover }));

const series = (orderbookId: string, b: SignalBar[], market: Market = "HEL", currency: Currency = "EUR"): PriceSeries => ({
  orderbookId,
  market,
  currency,
  bars: b,
});

const geometric = (n: number, start: number, dailyReturn: number) => Array.from({ length: n }, (_, i) => start * (1 + dailyReturn) ** i);

// ---- Real fixture ------------------------------------------------------------------------------------------

interface FixtureBar {
  date: string;
  close: number | null;
  volume: number | null;
  turnover: number | null;
}
interface Fixture {
  listings: Array<{ orderbookId: string; market: Market; currency: Currency }>;
  bars: Record<string, FixtureBar[]>;
  fx: Record<string, Array<{ date: string; unitsPerEur: number }>>;
}

const fixture: Fixture = JSON.parse(readFileSync("test/fixtures/sample-prices.json", "utf8"));
const fixtureSeries: PriceSeries[] = fixture.listings.map((l) =>
  series(
    l.orderbookId,
    fixture.bars[l.orderbookId]!.map((b) => ({ tradeDate: b.date, close: b.close, volume: b.volume, turnover: b.turnover })),
    l.market,
    l.currency,
  ),
);
const fixtureFx: FxRate[] = Object.entries(fixture.fx).flatMap(([currency, rows]) =>
  rows.map((r) => ({ currency, rateDate: r.date, unitsPerEur: r.unitsPerEur })),
);
const fixtureInput = (asOf: string): SnapshotInput => ({
  asOf,
  universe: fixture.listings.map((l) => l.orderbookId),
  series: fixtureSeries,
  fxRates: fixtureFx,
});

// ---- Equal-weight market series ----------------------------------------------------------------------------

describe("equal-weight market series", () => {
  it("averages the members' close-to-close returns and counts them", () => {
    const a = series("A", bars([100, 110, 99]));
    const b = series("B", bars([50, 50, 55]));
    const [d1, d2] = weekdays("2026-01-05", 3).slice(1);
    // Day 2: (+10 % + 0 %) / 2 = +5 %. Day 3: (−10 % + 10 %) / 2 = 0.
    expect(equalWeightMarketSeries("HEL", [a, b], "2026-12-31")).toEqual([
      { date: d1, return: expect.closeTo(0.05, 12), memberCount: 2 },
      { date: d2, return: expect.closeTo(0, 12), memberCount: 2 },
    ]);
  });

  it("counts a member only with valid closes on both days", () => {
    const a = series("A", bars([100, null, 99]));
    const b = series("B", bars([50, 50, 55]));
    const out = equalWeightMarketSeries("HEL", [a, b], "2026-12-31");
    // A has no close on day 2, so it is out of day 2 (no close today) and day 3 (no close yesterday).
    expect(out.map((r) => r.memberCount)).toEqual([1, 1]);
    expect(out[0]!.return).toBeCloseTo(0, 12);
    expect(out[1]!.return).toBeCloseTo(0.1, 12);
  });

  it("uses the previous market date, so a member missing a day drops out around it", () => {
    const dates = weekdays("2026-01-05", 3);
    const a = series("A", bars([100, 99], [dates[0]!, dates[2]!])); // no bar on day 2
    const b = series("B", bars([50, 51, 52], dates));
    const out = equalWeightMarketSeries("HEL", [a, b], "2026-12-31");
    expect(out.map((r) => r.memberCount)).toEqual([1, 1]);
    expect(out[1]!.return).toBeCloseTo(52 / 51 - 1, 12);
  });

  it("throws on a day with no members", () => {
    const a = series("A", bars([100, null, 99]));
    expect(() => equalWeightMarketSeries("HEL", [a], "2026-12-31")).toThrow(/no member has a close/);
  });

  it("throws with no members, or a member from another exchange", () => {
    expect(() => equalWeightMarketSeries("HEL", [], "2026-12-31")).toThrow(/at least one member/);
    expect(() => equalWeightMarketSeries("HEL", [series("A", bars([1, 2]), "STO")], "2026-12-31")).toThrow(/not HEL/);
  });

  it("ignores bars after upTo", () => {
    const a = series("A", bars([100, 110, 1]));
    const out = equalWeightMarketSeries("HEL", [a], weekdays("2026-01-05", 2)[1]!);
    expect(out).toHaveLength(1);
  });
});

// ---- Relative momentum -------------------------------------------------------------------------------------

describe("relative momentum", () => {
  it("is the share's compounded return minus the market's over the same dates", () => {
    const dates = weekdays("2026-01-05", 3);
    const market: MarketReturn[] = [
      { date: dates[1]!, return: 0.01, memberCount: 3 },
      { date: dates[2]!, return: 0.02, memberCount: 3 },
    ];
    const m = relativeMomentum(bars([100, 103, 106.09], dates), market, 2);
    // Share: 106.09 / 100 − 1 = 6.09 %. Market: 1.01 × 1.02 − 1 = 3.02 %. Relative: 3.07 %.
    expect(m.shareReturn).toBeCloseTo(0.0609, 12);
    expect(m.marketReturn).toBeCloseTo(0.0302, 12);
    expect(m.relative.value).toBeCloseTo(0.0307, 12);
  });

  it("compounds the market over a day the share did not trade", () => {
    const dates = weekdays("2026-01-05", 3);
    const market: MarketReturn[] = [
      { date: dates[1]!, return: 0.01, memberCount: 3 },
      { date: dates[2]!, return: 0.02, memberCount: 3 },
    ];
    const m = relativeMomentum(bars([100, 110], [dates[0]!, dates[2]!]), market, 1);
    expect(m.relative.value).toBeCloseTo(0.1 - 0.0302, 12);
  });

  it("excludes the market return on the window's start date", () => {
    const dates = weekdays("2026-01-05", 3);
    const market: MarketReturn[] = [
      { date: dates[0]!, return: 0.5, memberCount: 3 },
      { date: dates[1]!, return: 0.5, memberCount: 3 },
      { date: dates[2]!, return: 0.02, memberCount: 3 },
    ];
    const m = relativeMomentum(bars([100, 103, 106.09], dates), market, 1);
    expect(m.marketReturn).toBeCloseTo(0.02, 12);
    expect(m.relative.value).toBeCloseTo(106.09 / 103 - 1 - 0.02, 12);
  });

  it("throws if the market series lacks one of the share's dates", () => {
    const dates = weekdays("2026-01-05", 3);
    const market: MarketReturn[] = [{ date: dates[2]!, return: 0.02, memberCount: 3 }];
    expect(() => relativeMomentum(bars([100, 103, 106], dates), market, 2)).toThrow(/no return for/);
    expect(() => compoundedMarketReturn(market, dates[0]!, dates[2]!, [dates[1]!])).toThrow(/no return for/);
  });

  it("20-day momentum against an equal-weight market of the share and a flat peer", () => {
    // S rises 1 % a day and T is flat, so the market returns 0.5 % a day.
    const s = series("S", bars(geometric(21, 100, 0.01)));
    const t = series("T", bars(geometric(21, 50, 0)));
    const snap = signalSnapshot({ asOf: "2026-12-31", universe: ["S", "T"], series: [s, t], fxRates: [] });
    const d20 = snap.shares[0]!.momentum.d20;
    expect(d20.shareReturn).toBeCloseTo(1.01 ** 20 - 1, 12);
    expect(d20.marketReturn).toBeCloseTo(1.005 ** 20 - 1, 12);
    expect(d20.relative.value).toBeCloseTo(1.01 ** 20 - 1.005 ** 20, 12);
    expect(snap.shares[1]!.momentum.d20.relative.value).toBeCloseTo(0 - (1.005 ** 20 - 1), 12);
    expect(snap.markets).toEqual([{ market: "HEL", members: 2, latest: { date: s.bars.at(-1)!.tradeDate, return: expect.closeTo(0.005, 12), memberCount: 2 } }]);
  });

  it("needs days + 1 closes: 120-day momentum is null with 120 and set with 121", () => {
    const run = (n: number) => {
      const s = series("S", bars(geometric(n, 100, 0.001)));
      return relativeMomentum(s.bars, equalWeightMarketSeries("HEL", [s], "2026-12-31"), 120);
    };
    expect(run(120)).toEqual({
      days: 120,
      relative: { value: null, reason: "INSUFFICIENT_HISTORY", detail: "120-day momentum needs 121 bars, has 120" },
      shareReturn: null,
      marketReturn: null,
    });
    // The share is the whole market, so its relative momentum is zero.
    expect(run(121).relative.value).toBeCloseTo(0, 12);
  });

  it("is null, not partial, when a close in the window is missing", () => {
    const closes = geometric(21, 100, 0.01) as Array<number | null>;
    closes[5] = null;
    const s = series("S", bars(closes));
    const peer = series("P", bars(geometric(21, 10, 0)));
    const m = relativeMomentum(s.bars, equalWeightMarketSeries("HEL", [s, peer], "2026-12-31"), 20);
    expect(m.relative.reason).toBe("MISSING_DATA");
  });
});

// ---- Distance from the 52-week high ------------------------------------------------------------------------

describe("distance from the 52-week high", () => {
  it("is close ÷ highest close in the last 250 days − 1, ignoring older highs", () => {
    const closes = Array.from({ length: 251 }, () => 100);
    closes[0] = 1_000; // 250 days before today: just outside the window
    closes[1] = 200; // 249 days before today: the oldest close inside it
    closes[250] = 150;
    expect(distanceFromHigh(bars(closes)).value).toBeCloseTo(150 / 200 - 1, 12);
  });

  it("is zero at a new high", () => {
    expect(distanceFromHigh(bars(geometric(250, 10, 0.001))).value).toBe(0);
  });

  it("needs 250 closes", () => {
    expect(distanceFromHigh(bars(geometric(249, 10, 0)))).toMatchObject({ value: null, reason: "INSUFFICIENT_HISTORY" });
  });
});

// ---- Volume anomaly ----------------------------------------------------------------------------------------

describe("volume anomaly", () => {
  const withVolumes = (volumes: ReadonlyArray<number | null>): SignalBar[] =>
    bars(volumes.map(() => 10)).map((b, i) => ({ ...b, volume: volumes[i]! }));

  it("is today's volume ÷ the median of the previous 60 days", () => {
    // Previous volumes 1..60: median (30 + 31) / 2 = 30.5. Today 61: 61 / 30.5 = 2.
    const volumes = Array.from({ length: 61 }, (_, i) => i + 1);
    expect(volumeAnomaly(withVolumes(volumes)).value).toBe(2);
  });

  it("excludes today from the baseline", () => {
    // If today (1,000) were in the median, it would shift; with 60 days of 100 the anomaly is exactly 10.
    expect(volumeAnomaly(withVolumes([...Array.from({ length: 60 }, () => 100), 1_000])).value).toBe(10);
  });

  it("needs 61 bars, and is null on a zero median or a missing volume", () => {
    expect(volumeAnomaly(withVolumes(Array.from({ length: 60 }, () => 5)))).toMatchObject({ value: null, reason: "INSUFFICIENT_HISTORY" });
    expect(volumeAnomaly(withVolumes([...Array.from({ length: 60 }, () => 0), 5]))).toMatchObject({ value: null, reason: "ZERO_DENOMINATOR" });
    const gap: Array<number | null> = Array.from({ length: 61 }, () => 5);
    gap[3] = null;
    expect(volumeAnomaly(withVolumes(gap))).toMatchObject({ value: null, reason: "MISSING_DATA" });
  });
});

// ---- Realised volatility -----------------------------------------------------------------------------------

describe("realised volatility", () => {
  it("is the sample standard deviation of 20 daily log returns, annualised with √252", () => {
    // 21 closes alternating 100, 110: ten log returns of +ln 1.1 and ten of −ln 1.1, mean 0.
    // Sample variance = 20 × (ln 1.1)² / 19.
    const closes = Array.from({ length: 21 }, (_, i) => (i % 2 === 0 ? 100 : 110));
    const expected = Math.log(1.1) * Math.sqrt(20 / 19);
    const v = realisedVolatility(bars(closes));
    expect(v.daily.value).toBeCloseTo(expected, 12);
    expect(v.annualised.value).toBeCloseTo(expected * Math.sqrt(252), 12);
    expect(v.annualisation).toBe("SQRT_252_ASSUMED");
  });

  it("is zero for a constant daily return, and uses only the last 21 closes", () => {
    const closes = [5, 500, ...geometric(21, 100, 0.02)];
    expect(realisedVolatility(bars(closes)).daily.value).toBeCloseTo(0, 12);
  });

  it("needs 21 closes", () => {
    const v = realisedVolatility(bars(geometric(20, 100, 0.01)));
    expect(v.daily).toMatchObject({ value: null, reason: "INSUFFICIENT_HISTORY", detail: "20-day realised volatility needs 21 bars, has 20" });
    expect(v.annualised.value).toBeNull();
  });
});

// ---- Median turnover in EUR --------------------------------------------------------------------------------

describe("60-day median turnover in EUR", () => {
  const withTurnover = (turnovers: ReadonlyArray<number | null>, dates = weekdays("2026-01-05", turnovers.length)): SignalBar[] =>
    turnovers.map((turnover, i) => ({ tradeDate: dates[i]!, close: 10, volume: 1, turnover }));

  it("takes the median of the last 60 days, today included, for a EUR share", () => {
    // 61 days: the first (1,000,000) falls outside; 1..60 remain, median 30.5.
    const t = [1_000_000, ...Array.from({ length: 60 }, (_, i) => i + 1)];
    expect(medianTurnoverEur(withTurnover(t), eurRateLookup("EUR", []))).toEqual({
      eur: { value: 30.5, reason: null, detail: null },
      fxFilledDays: 0,
    });
  });

  it("converts each day at its own ECB rate", () => {
    const dates = weekdays("2026-01-05", 60);
    // First 30 days: 1,100 SEK at 11 SEK/EUR = 100 €. Last 30 days: 2,000 SEK at 10 SEK/EUR = 200 €.
    const turnover = dates.map((_, i) => (i < 30 ? 1_100 : 2_000));
    const rates: FxRate[] = dates.map((d, i) => ({ currency: "SEK", rateDate: d, unitsPerEur: i < 30 ? 11 : 10 }));
    // 30 values of 100 € and 30 of 200 €: median (100 + 200) / 2 = 150.
    const out = medianTurnoverEur(withTurnover(turnover, dates), eurRateLookup("SEK", rates));
    expect(out.eur.value).toBeCloseTo(150, 12);
    expect(out.fxFilledDays).toBe(0);
  });

  it("uses the latest earlier ECB rate on a day without one, and counts those days", () => {
    const dates = weekdays("2026-01-05", 60);
    const missing = new Set([dates[10], dates[40], dates[41]]);
    const rates: FxRate[] = dates.filter((d) => !missing.has(d)).map((d) => ({ currency: "DKK", rateDate: d, unitsPerEur: 7.5 }));
    const out = medianTurnoverEur(withTurnover(dates.map(() => 750), dates), eurRateLookup("DKK", rates));
    expect(out.eur.value).toBeCloseTo(100, 12);
    expect(out.fxFilledDays).toBe(3);
  });

  it("prices a filled day at the earlier day's rate", () => {
    const lookup = eurRateLookup("SEK", [
      { currency: "SEK", rateDate: "2026-04-02", unitsPerEur: 11 },
      { currency: "SEK", rateDate: "2026-04-07", unitsPerEur: 12 },
    ]);
    // Good Friday 3 April to Easter Monday 6 April 2026: 4 days, the ASSUMED limit.
    expect(lookup("2026-04-06")).toEqual({ unitsPerEur: 11, rateDate: "2026-04-02", filled: true });
    expect(lookup("2026-04-07")).toEqual({ unitsPerEur: 12, rateDate: "2026-04-07", filled: false });
  });

  it("throws when the rate is too old or there is none", () => {
    const lookup = eurRateLookup("SEK", [{ currency: "SEK", rateDate: "2026-04-01", unitsPerEur: 11 }]);
    expect(() => lookup("2026-04-06")).toThrow(/5 days earlier/);
    expect(() => lookup("2026-03-31")).toThrow(/No ECB SEK rate/);
  });

  it("throws on a repeated or non-positive rate", () => {
    const r = { currency: "SEK", rateDate: "2026-04-01", unitsPerEur: 11 };
    expect(() => eurRateLookup("SEK", [r, r])).toThrow(/appears twice/);
    expect(() => eurRateLookup("SEK", [{ ...r, unitsPerEur: 0 }])).toThrow(/bad rate/);
  });

  it("needs 60 days, and is null on a missing turnover", () => {
    expect(medianTurnoverEur(withTurnover(Array.from({ length: 59 }, () => 1)), eurRateLookup("EUR", [])).eur).toMatchObject({
      value: null,
      reason: "INSUFFICIENT_HISTORY",
    });
    const t: Array<number | null> = Array.from({ length: 60 }, () => 1);
    t[0] = null;
    expect(medianTurnoverEur(withTurnover(t), eurRateLookup("EUR", [])).eur).toMatchObject({ value: null, reason: "MISSING_DATA" });
  });

  it("median averages the two middle values of an even count", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
  });
});

// ---- Dividends and splits ----------------------------------------------------------------------------------

describe("dividend and split adjustment", () => {
  const dates = weekdays("2026-01-05", 3);
  const dividend: AdjustmentEvent = { orderbookId: "S", type: "CASH_DIVIDEND", exDate: dates[2]!, amount: 5 };

  it("without an event list, leaves prices raw and says so", () => {
    const raw = bars([100, 100, 95]);
    expect(adjustBars("S", raw, "2026-12-31", undefined)).toEqual({ bars: raw, priceBasis: "RAW_UNADJUSTED", eventsApplied: 0 });
  });

  it("scales closes before the ex-date by 1 − dividend ÷ previous close", () => {
    // 5 € on a 100 € close: earlier closes × 0.95, so the ex-day drop to 95 is no longer a return.
    const out = adjustBars("S", bars([100, 100, 95]), "2026-12-31", [dividend]);
    expect(out.priceBasis).toBe("ADJUSTED");
    expect(out.eventsApplied).toBe(1);
    expect(out.bars.map((b) => b.close)).toEqual([95, 95, 95]);
  });

  it("divides earlier prices and multiplies earlier volumes by a split ratio", () => {
    const split: AdjustmentEvent = { orderbookId: "S", type: "SPLIT", exDate: dates[2]!, ratio: 2 };
    const raw = bars([100, 100, 50]).map((b, i) => ({ ...b, volume: i < 2 ? 10 : 20 }));
    const out = adjustBars("S", raw, "2026-12-31", [split]);
    expect(out.bars.map((b) => [b.close, b.volume, b.turnover])).toEqual([
      [50, 20, 1_000_000],
      [50, 20, 1_000_000],
      [50, 20, 1_000_000],
    ]);
  });

  it("ignores events after the as-of date and events for other shares", () => {
    const raw = bars([100, 100, 95]);
    const out = adjustBars("S", raw, dates[1]!, [dividend, { ...dividend, orderbookId: "X", exDate: dates[1]! }]);
    expect(out).toEqual({ bars: raw, priceBasis: "ADJUSTED", eventsApplied: 0 });
  });

  it("throws on a dividend not below the previous close", () => {
    expect(() => adjustBars("S", bars([100, 100, 95]), "2026-12-31", [{ ...dividend, amount: 100 }])).toThrow(/not below the previous close/);
  });

  it("flags the price basis on the snapshot and on each share", () => {
    const s = series("S", bars(geometric(30, 100, 0.001)));
    const raw = signalSnapshot({ asOf: "2026-12-31", universe: ["S"], series: [s], fxRates: [] });
    expect(raw.priceBasis).toBe("RAW_UNADJUSTED");
    expect(raw.shares[0]!.priceBasis).toBe("RAW_UNADJUSTED");
    const adjusted = signalSnapshot({ asOf: "2026-12-31", universe: ["S"], series: [s], fxRates: [], adjustments: [] });
    expect(adjusted.priceBasis).toBe("ADJUSTED");
    expect(adjusted.shares[0]!.adjustmentsApplied).toBe(0);
  });

  it("removes a dividend drop from the volatility when the event is given", () => {
    const closes = Array.from({ length: 21 }, (_, i) => (i < 20 ? 100 : 95));
    const s = series("S", bars(closes));
    const exDate = s.bars[20]!.tradeDate;
    const events: AdjustmentEvent[] = [{ orderbookId: "S", type: "CASH_DIVIDEND", exDate, amount: 5 }];
    const raw = signalSnapshot({ asOf: "2026-12-31", universe: ["S"], series: [s], fxRates: [] });
    const adjusted = signalSnapshot({ asOf: "2026-12-31", universe: ["S"], series: [s], fxRates: [], adjustments: events });
    expect(raw.shares[0]!.realisedVolatility20.daily.value).toBeGreaterThan(0.01);
    expect(adjusted.shares[0]!.realisedVolatility20.daily.value).toBeCloseTo(0, 12);
    expect(adjusted.shares[0]!.adjustmentsApplied).toBe(1);
  });
});

// ---- Snapshot, leakage and the real fixture ----------------------------------------------------------------

describe("signal snapshot", () => {
  it("does not change when any bar, rate or event after the as-of date changes", () => {
    const asOf = "2026-06-15";
    const before = signalSnapshot({ ...fixtureInput(asOf), adjustments: [] });
    const mutated: PriceSeries[] = fixtureSeries.map((s) => ({
      ...s,
      bars: s.bars.map((b) =>
        b.tradeDate > asOf ? { ...b, close: b.close! * 3, volume: b.volume! * 7 + 1, turnover: b.turnover! * 5 + 1 } : b,
      ),
    }));
    const later: AdjustmentEvent[] = fixture.listings.map((l) => ({ orderbookId: l.orderbookId, type: "SPLIT", exDate: "2026-06-16", ratio: 4 }));
    const after = signalSnapshot({
      asOf,
      universe: fixtureInput(asOf).universe,
      series: mutated,
      fxRates: fixtureFx.map((r) => (r.rateDate > asOf ? { ...r, unitsPerEur: r.unitsPerEur * 2 } : r)),
      adjustments: later,
    });
    expect(after).toEqual(before);
  });

  it("uses each share's latest bar on or before the as-of date", () => {
    // 2026-05-01: Copenhagen traded; Helsinki and Stockholm did not.
    const snap = signalSnapshot(fixtureInput("2026-05-01"));
    const barDate = (id: string) => snap.shares.find((s) => s.orderbookId === id)!.barDate;
    expect(barDate("TX2178")).toBe("2026-05-01");
    expect(barDate("TX50063")).toBe("2026-04-30");
  });

  it("throws on a zero-member market day", () => {
    const a = series("A", bars([100, null, 99]));
    expect(() => signalSnapshot({ asOf: "2026-12-31", universe: ["A"], series: [a], fxRates: [] })).toThrow(/no member has a close/);
  });

  it("throws on a universe share without prices, or unsorted bars", () => {
    expect(() => signalSnapshot({ asOf: "2026-12-31", universe: ["A"], series: [], fxRates: [] })).toThrow(/no price series/);
    const unsorted = series("A", bars([1, 2]).reverse());
    expect(() => signalSnapshot({ asOf: "2026-12-31", universe: ["A"], series: [unsorted], fxRates: [] })).toThrow(/ascending/);
  });

  it("returns every signal for the real sample on 2026-09-25", () => {
    const snap = signalSnapshot(fixtureInput("2026-09-25"));
    expect(snap.priceBasis).toBe("RAW_UNADJUSTED");
    expect(snap.markets.map((m) => [m.market, m.members, m.latest?.date, m.latest?.memberCount])).toEqual([
      ["HEL", 4, "2026-09-25", 4],
      ["STO", 3, "2026-09-25", 3],
      ["CPH", 3, "2026-09-25", 3],
    ]);
    for (const s of snap.shares) {
      const signals = [
        s.momentum.d20.relative,
        s.momentum.d60.relative,
        s.momentum.d120.relative,
        s.distanceFrom52WeekHigh,
        s.volumeAnomaly,
        s.realisedVolatility20.daily,
        s.medianTurnover60.eur,
      ];
      expect(signals.every((sig) => sig.value !== null && Number.isFinite(sig.value)), s.orderbookId).toBe(true);
      expect(s.distanceFrom52WeekHigh.value!).toBeLessThanOrEqual(0);
    }
  });

  it("matches an independent computation for Nokia (TX50063) on 2026-09-25", () => {
    const raw = fixture.bars["TX50063"]!.filter((b) => b.date <= "2026-09-25");
    expect(raw.at(-1)!.date).toBe("2026-09-25");

    // 20-day volatility: last 21 closes, 20 log returns, sample standard deviation.
    const c = raw.slice(-21).map((b) => b.close as number);
    const r: number[] = [];
    for (let i = 1; i < c.length; i++) r.push(Math.log(c[i]! / c[i - 1]!));
    const mean = r.reduce((a, b) => a + b, 0) / r.length;
    const vol = Math.sqrt(r.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (r.length - 1));

    // 60-day median turnover: Nokia trades in EUR, so no conversion. Even count: mean of the 30th and 31st.
    const t = raw.slice(-60).map((b) => b.turnover as number).sort((a, b) => a - b);
    const medianTurnover = (t[29]! + t[30]!) / 2;

    const nokia = signalSnapshot(fixtureInput("2026-09-25")).shares.find((s) => s.orderbookId === "TX50063")!;
    expect(nokia.currency).toBe("EUR");
    expect(nokia.realisedVolatility20.daily.value).toBeCloseTo(vol, 12);
    expect(nokia.realisedVolatility20.annualised.value).toBeCloseTo(vol * Math.sqrt(252), 12);
    expect(nokia.medianTurnover60.eur.value).toBeCloseTo(medianTurnover, 6);
    expect(nokia.medianTurnover60.fxFilledDays).toBe(0);
  });

  it("counts Copenhagen's 1 May 2026, which had no ECB rate, as a filled FX day", () => {
    const asOf = "2026-06-15";
    const dkkDates = new Set(fixture.fx["DKK"]!.map((r) => r.date));
    const snap = signalSnapshot(fixtureInput(asOf));
    for (const id of ["TX2319", "TX2178", "TX2214"]) {
      const window = fixture.bars[id]!.filter((b) => b.date <= asOf).slice(-60);
      const expected = window.filter((b) => !dkkDates.has(b.date)).length;
      expect(window.some((b) => b.date === "2026-05-01")).toBe(true);
      expect(expected).toBe(1);
      expect(snap.shares.find((s) => s.orderbookId === id)!.medianTurnover60.fxFilledDays).toBe(expected);
    }
  });
});
