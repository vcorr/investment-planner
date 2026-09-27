import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  clusteredMean,
  compareWithBaseline,
  hitRateEstimate,
  NEWEY_WEST_LAGS,
  neweyWestVarianceOfMean,
  Z_95,
} from "../src/scoring/inference.js";
import { baselineStats, breakdown, CALIBRATION_BUCKETS, filterScored, hitStats, majorityDirections } from "../src/scoring/metrics.js";
import {
  baselineCalls,
  H1_ENDS_AT_DECISION_DAY_CLOSE,
  horizonEndOffset,
  MOMENTUM_DAYS,
  prepareExchange,
  scorePrediction,
  TIE_TOLERANCE,
  type Direction,
  type ExchangeData,
  type Horizon,
  type Outcome,
  type Prediction,
  type PredictionResult,
  type PriceBar,
  type Relation,
  type Scored,
} from "../src/scoring/outcome.js";
import { decideVerdict, VERDICT_RULES, verdictFromResults, type VerdictInput } from "../src/scoring/verdict.js";

// ---- Helpers ------------------------------------------------------------------------------------------------

/** Consecutive calendar dates from 2026-01-01, all treated as trading days in the synthetic exchange. */
const DAYS = Array.from({ length: 40 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));
const D_IDX = 25; // decision day: 25 trading days of history before it
const D = DAYS[D_IDX]!;
const dayAt = (offset: number) => DAYS[D_IDX + offset]!;

/** Flat bars at `level` for every day, then the overrides by offset from D. */
function series(level: number, overrides: Record<number, Partial<PriceBar>> = {}): PriceBar[] {
  return DAYS.map((tradeDate, i) => ({ tradeDate, open: level, close: level, ...overrides[i - D_IDX] }));
}

function exchange(bars: Record<string, PriceBar[]>, change: Partial<ExchangeData> = {}): ExchangeData {
  return {
    tradingDays: DAYS,
    universe: Object.keys(bars),
    bars: new Map(Object.entries(bars)),
    exDates: new Map(),
    asOf: DAYS.at(-1)!,
    ...change,
  };
}

const prediction = (change: Partial<Prediction> = {}): Prediction => ({
  id: "p1",
  decisionDate: D,
  orderbookId: "A",
  horizon: 5,
  direction: "UP",
  confidence: 0.7,
  eventTypes: [],
  relation: null,
  hasNews: false,
  ...change,
});

function scoredOf(result: PredictionResult): Scored {
  if (result.status !== "SCORED") throw new Error(`expected SCORED, got ${JSON.stringify(result)}`);
  return result;
}

/** A scored prediction built directly, for metric tests. */
function mk(o: {
  id?: string;
  date?: string;
  share?: string;
  horizon?: Horizon;
  direction: Direction;
  outcome: Outcome;
  confidence?: number;
  momentum?: Direction | null;
  reversal?: Direction | null;
  eventTypes?: string[];
  relation?: Relation | null;
  hasNews?: boolean;
}): Scored {
  const adjustedReturn = o.outcome === "UP" ? 0.01 : o.outcome === "DOWN" ? -0.01 : 0;
  const hasNews = o.hasNews ?? (o.eventTypes ?? []).length > 0;
  return {
    status: "SCORED",
    prediction: {
      id: o.id ?? `${o.date ?? D}-${o.share ?? "A"}-${o.horizon ?? 5}`,
      decisionDate: o.date ?? D,
      orderbookId: o.share ?? "A",
      horizon: o.horizon ?? 5,
      direction: o.direction,
      confidence: o.confidence ?? 0.7,
      eventTypes: o.eventTypes ?? [],
      relation: o.relation ?? null,
      hasNews,
    },
    endDate: o.date ?? D,
    shareReturn: adjustedReturn,
    marketReturn: 0,
    adjustedReturn,
    outcome: o.outcome,
    hit: o.outcome === "TIE" ? null : o.outcome === o.direction,
    baselines: { momentum: o.momentum ?? null, reversal: o.reversal ?? null },
  };
}

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ---- Outcome ------------------------------------------------------------------------------------------------

describe("horizon convention", () => {
  it("h = 1 ends at the close of the decision day itself (brief §13 wording)", () => {
    expect(H1_ENDS_AT_DECISION_DAY_CLOSE).toBe(true);
    expect(horizonEndOffset(1)).toBe(0);
    expect(horizonEndOffset(5)).toBe(4);
  });

  it("a 1-day call is scored open to close of D, a 5-day call to the close of D+4", () => {
    // A: open 100 on D, closes 104 on D and 90 on D+1; B is flat at 50.
    const ex = prepareExchange(exchange({ A: series(100, { 0: { open: 100, close: 104 }, 1: { open: 104, close: 90 } }), B: series(50) }));
    const one = scoredOf(scorePrediction(prediction({ horizon: 1 }), ex));
    expect(one.endDate).toBe(D);
    expect(one.shareReturn).toBeCloseTo(0.04, 15);
    expect(one.marketReturn).toBeCloseTo(0.02, 15); // mean(0.04, 0)
    expect(one.adjustedReturn).toBeCloseTo(0.02, 15);
    expect(one.outcome).toBe("UP");
    expect(one.hit).toBe(true);
  });
});

describe("market-adjusted 5-day outcome", () => {
  // A: open 100 on D, close 110 on D, close 99 from D+1 on. B flat at 50.
  const a = series(100, { 0: { open: 100, close: 110 }, 1: { close: 99 }, 2: { close: 99 }, 3: { close: 99 }, 4: { close: 99 }, 5: { close: 99 } });
  const ex = () => prepareExchange(exchange({ A: a, B: series(50) }));

  it("uses the equal-weight series: open to close on D, then close to close, compounded", () => {
    const s = scoredOf(scorePrediction(prediction(), ex()));
    expect(s.endDate).toBe(dayAt(4));
    // Share: 99 / 100 − 1 = −0.01.
    expect(s.shareReturn).toBeCloseTo(-0.01, 15);
    // Market: D open→close mean(0.10, 0) = 0.05; D+1 close→close mean(99/110 − 1, 0) = −0.05; then 0.
    // (1.05 × 0.95) − 1 = −0.0025.
    expect(s.marketReturn).toBeCloseTo(-0.0025, 15);
    expect(s.adjustedReturn).toBeCloseTo(-0.0075, 15);
    expect(s.outcome).toBe("DOWN");
    expect(s.hit).toBe(false);
    expect(scoredOf(scorePrediction(prediction({ direction: "DOWN" }), ex())).hit).toBe(true);
  });

  it("a zero market-adjusted return is a tie, neither hit nor miss", () => {
    const same = series(100, { 0: { close: 105 } });
    const tie = scoredOf(scorePrediction(prediction({ horizon: 1 }), prepareExchange(exchange({ A: same, B: same }))));
    // Floating-point compounding leaves noise near 1e-17; anything within TIE_TOLERANCE is a tie.
    expect(Math.abs(tie.adjustedReturn)).toBeLessThan(TIE_TOLERANCE);
    expect(tie.outcome).toBe("TIE");
    expect(tie.hit).toBeNull();
    // A universe of the share alone always ties.
    const alone = scoredOf(scorePrediction(prediction(), prepareExchange(exchange({ A: a }))));
    expect(alone.outcome).toBe("TIE");
  });

  it("is pending until the horizon's close is on or before the as-of date", () => {
    const early = prepareExchange(exchange({ A: a, B: series(50) }, { asOf: dayAt(3) }));
    expect(scorePrediction(prediction(), early)).toEqual({ status: "PENDING", prediction: prediction(), endDate: dayAt(4) });
    expect(scorePrediction(prediction({ horizon: 1 }), early).status).toBe("SCORED");
    const before = prepareExchange(exchange({ A: a, B: series(50) }, { asOf: dayAt(-1) }));
    expect(scorePrediction(prediction({ horizon: 1 }), before).status).toBe("PENDING");
    const onDay = prepareExchange(exchange({ A: a, B: series(50) }, { asOf: dayAt(4) }));
    expect(scorePrediction(prediction(), onDay).status).toBe("SCORED");
  });

  it("is pending with no end date when the calendar does not reach the horizon", () => {
    const short = DAYS.slice(0, D_IDX + 3);
    const cut = (bars: PriceBar[]) => bars.filter((b) => short.includes(b.tradeDate));
    const ex2 = prepareExchange(exchange({ A: cut(a), B: cut(series(50)) }, { tradingDays: short, asOf: "2026-12-31" }));
    expect(scorePrediction(prediction(), ex2)).toMatchObject({ status: "PENDING", endDate: null });
  });

  it("excludes a call whose window contains its share's ex-date, but not one on D itself (A13)", () => {
    const withEx = (date: string) => prepareExchange(exchange({ A: a, B: series(50) }, { exDates: new Map([["A", new Set([date])]]) }));
    expect(scorePrediction(prediction(), withEx(dayAt(2)))).toMatchObject({ status: "EXCLUDED", endDate: dayAt(4) });
    expect(scorePrediction(prediction(), withEx(dayAt(4))).status).toBe("EXCLUDED");
    expect(scorePrediction(prediction(), withEx(D)).status).toBe("SCORED");
    expect(scorePrediction(prediction(), withEx(dayAt(5))).status).toBe("SCORED");
    expect(scorePrediction(prediction({ horizon: 1 }), withEx(dayAt(1))).status).toBe("SCORED");
  });

  it("does not look at bars after the horizon's close", () => {
    const base = scoredOf(scorePrediction(prediction(), ex()));
    const later = { ...a[D_IDX + 6]!, open: 1, close: 1000 };
    const changed = a.map((b, i) => (i === D_IDX + 6 ? later : b));
    const after = scoredOf(scorePrediction(prediction(), prepareExchange(exchange({ A: changed, B: series(50) }))));
    expect(after).toEqual(base);
  });
});

describe("missing or contradictory data throws", () => {
  const ok = () => ({ A: series(100, { 0: { close: 101 } }), B: series(50) });

  it("a missing universe bar inside the window", () => {
    const b = series(50).filter((x) => x.tradeDate !== dayAt(2));
    expect(() => scorePrediction(prediction(), prepareExchange(exchange({ ...ok(), B: b })))).toThrow(/B: no bar for/);
  });

  it("a null or non-positive open on D", () => {
    const a = series(100, { 0: { open: null } });
    expect(() => scorePrediction(prediction(), prepareExchange(exchange({ ...ok(), A: a })))).toThrow(/no valid open/);
    const z = series(100, { 0: { open: 0 } });
    expect(() => scorePrediction(prediction(), prepareExchange(exchange({ ...ok(), A: z })))).toThrow(/no valid open/);
  });

  it("a decision day that is not a trading day, or a share without bars", () => {
    const ex = prepareExchange(exchange(ok()));
    expect(() => scorePrediction(prediction({ decisionDate: "2027-01-01" }), ex)).toThrow(/not a trading day/);
    expect(() => scorePrediction(prediction({ orderbookId: "X" }), ex)).toThrow(/no bars for X/);
  });

  it("bars on a non-trading day, duplicate bars, an unordered calendar, a member without bars", () => {
    expect(() => prepareExchange(exchange({ ...ok(), A: [...series(100), { tradeDate: "2027-01-01", open: 1, close: 1 }] }))).toThrow(/not a trading day/);
    expect(() => prepareExchange(exchange({ ...ok(), A: [...series(100), series(100)[0]!] }))).toThrow(/two bars/);
    expect(() => prepareExchange(exchange(ok(), { tradingDays: [...DAYS].reverse() }))).toThrow(/ascending/);
    expect(() => prepareExchange(exchange(ok(), { universe: ["A", "B", "C"] }))).toThrow(/C has no bars/);
  });

  it("too little history for the momentum baseline", () => {
    const ex = prepareExchange(exchange(ok()));
    expect(() => scorePrediction(prediction({ decisionDate: DAYS[MOMENTUM_DAYS]!, horizon: 1 }), ex)).toThrow(/fewer than 21/);
    expect(scorePrediction(prediction({ decisionDate: DAYS[MOMENTUM_DAYS + 1]!, horizon: 1 }), ex).status).toBe("SCORED");
  });

  it("an invalid prediction", () => {
    const ex = prepareExchange(exchange(ok()));
    expect(() => scorePrediction(prediction({ confidence: 0.49 }), ex)).toThrow();
    expect(() => scorePrediction(prediction({ confidence: 1.01 }), ex)).toThrow();
    expect(() => scorePrediction(prediction({ horizon: 2 as Horizon }), ex)).toThrow();
    expect(() => scorePrediction(prediction({ hasNews: false, eventTypes: ["EARNINGS"] }), ex)).toThrow(/no-news/);
  });
});

describe("baseline calls known at D", () => {
  it("momentum is the sign of the 20-day market-adjusted return to the close before D", () => {
    // A jumps from 100 to 105 at the close of D−5 and stays there; B is flat.
    const up: Record<number, Partial<PriceBar>> = {};
    for (let o = -5; o <= 10; o++) up[o] = { open: 105, close: 105 };
    const ex = prepareExchange(exchange({ A: series(100, up), B: series(50) }));
    // Share +5 %, market (1 + 0.05/2) − 1 = +2.5 %, so momentum is UP. D−1 was flat for both: no reversal call.
    expect(baselineCalls(ex, "A", D)).toEqual({ momentum: "UP", reversal: null });
    expect(baselineCalls(ex, "B", D)).toEqual({ momentum: "DOWN", reversal: null });
  });

  it("the move 21 closes back is outside the window, the move 20 closes back is inside", () => {
    const at = (offset: number) => {
      const o: Record<number, Partial<PriceBar>> = {};
      for (let k = offset; k <= 10; k++) o[k] = { open: 110, close: 110 };
      return baselineCalls(prepareExchange(exchange({ A: series(100, o), B: series(50) })), "A", D).momentum;
    };
    expect(at(-MOMENTUM_DAYS)).toBe("UP"); // close of D−20 vs D−21: inside
    expect(at(-MOMENTUM_DAYS - 1)).toBeNull(); // already at 110 on D−21: no change inside the window
  });

  it("reversal is the opposite of the previous day's market-adjusted move", () => {
    const o: Record<number, Partial<PriceBar>> = {};
    for (let k = -1; k <= 10; k++) o[k] = { open: 90, close: 90 };
    const ex = prepareExchange(exchange({ A: series(100, o), B: series(50) }));
    // D−1: A −10 %, market −5 %: adjusted DOWN, so reversal says UP. Momentum is DOWN.
    expect(baselineCalls(ex, "A", D)).toEqual({ momentum: "DOWN", reversal: "UP" });
  });

  it("is unchanged by the decision day's own bar and later bars", () => {
    const a = series(100, { [-3]: { close: 103 }, [-2]: { close: 101 }, [-1]: { close: 102 } });
    const b = a.map((x, i) => (i >= D_IDX ? { ...x, open: 7, close: 700 } : x));
    const before = baselineCalls(prepareExchange(exchange({ A: a, B: series(50) })), "A", D);
    const after = baselineCalls(prepareExchange(exchange({ A: b, B: series(50) })), "A", D);
    expect(after).toEqual(before);
  });
});

describe("real sample data (Helsinki, 4 shares)", () => {
  const fixture = JSON.parse(readFileSync("test/fixtures/sample-prices.json", "utf8")) as {
    listings: { orderbookId: string; market: string }[];
    bars: Record<string, { date: string; open: number; close: number }[]>;
  };
  const calendar = JSON.parse(readFileSync("test/fixtures/trading-dates.json", "utf8")) as {
    markets: Record<string, { tradingDates: string[] }>;
  };
  const hel = fixture.listings.filter((l) => l.market === "HEL").map((l) => l.orderbookId);
  const days = calendar.markets.HEL!.tradingDates;
  const bars = new Map(hel.map((id) => [id, fixture.bars[id]!.map((b) => ({ tradeDate: b.date, open: b.open, close: b.close }))]));
  const ex = prepareExchange({ tradingDays: days, universe: hel, bars, exDates: new Map(), asOf: "2026-09-25" });

  // Independent check, straight from the raw fixture.
  const raw = (id: string, date: string) => fixture.bars[id]!.find((b) => b.date === date)!;
  const d = "2026-09-15";
  const i = days.indexOf(d);

  it("Nokia 5-day outcome from 2026-09-15 matches a direct computation", () => {
    const end = days[i + 4]!;
    const share = raw("TX50063", end).close / raw("TX50063", d).open - 1;
    let market = 1 + hel.reduce((s, id) => s + raw(id, d).close / raw(id, d).open - 1, 0) / hel.length;
    for (let t = i + 1; t <= i + 4; t++) {
      market *= 1 + hel.reduce((s, id) => s + raw(id, days[t]!).close / raw(id, days[t - 1]!).close - 1, 0) / hel.length;
    }
    const s = scoredOf(scorePrediction(prediction({ decisionDate: d, orderbookId: "TX50063" }), ex));
    expect(s.endDate).toBe(end);
    expect(s.shareReturn).toBeCloseTo(share, 12);
    expect(s.marketReturn).toBeCloseTo(market - 1, 12);
    expect(s.adjustedReturn).toBeCloseTo(share - (market - 1), 12);
    expect(s.outcome).toBe(share - (market - 1) > 0 ? "UP" : "DOWN");
  });

  it("Nokia momentum and reversal on 2026-09-15 match a direct computation", () => {
    let market = 1;
    for (let t = i - 20; t <= i - 1; t++) {
      market *= 1 + hel.reduce((s, id) => s + raw(id, days[t]!).close / raw(id, days[t - 1]!).close - 1, 0) / hel.length;
    }
    const mom = raw("TX50063", days[i - 1]!).close / raw("TX50063", days[i - 21]!).close - 1 - (market - 1);
    const prevMarket = hel.reduce((s, id) => s + raw(id, days[i - 1]!).close / raw(id, days[i - 2]!).close - 1, 0) / hel.length;
    const prev = raw("TX50063", days[i - 1]!).close / raw("TX50063", days[i - 2]!).close - 1 - prevMarket;
    expect(baselineCalls(ex, "TX50063", d)).toEqual({ momentum: mom > 0 ? "UP" : "DOWN", reversal: prev > 0 ? "DOWN" : "UP" });
  });

  it("a 5-day call from 2026-09-21 is pending as of 2026-09-25", () => {
    expect(scorePrediction(prediction({ decisionDate: "2026-09-21", orderbookId: "TX50063" }), ex).status).toBe("SCORED");
    expect(scorePrediction(prediction({ decisionDate: "2026-09-22", orderbookId: "TX50063" }), ex)).toMatchObject({ status: "PENDING", endDate: null });
  });
});

// ---- Metrics ------------------------------------------------------------------------------------------------

describe("hit rate, Brier score and calibration", () => {
  const set = [
    mk({ id: "a", direction: "UP", outcome: "UP", confidence: 0.55 }),
    mk({ id: "b", direction: "UP", outcome: "DOWN", confidence: 0.65 }),
    mk({ id: "c", direction: "DOWN", outcome: "DOWN", confidence: 0.75 }),
    mk({ id: "d", direction: "UP", outcome: "UP", confidence: 0.95 }),
    mk({ id: "e", direction: "UP", outcome: "TIE", confidence: 0.6 }),
  ];

  it("counts ties apart and computes the hit rate over hits and misses", () => {
    const s = hitStats(set);
    expect(s).toMatchObject({ calls: 5, hits: 3, misses: 1, ties: 1, hitRate: 0.75 });
  });

  it("Brier score: (0.45² + 0.65² + 0.25² + 0.05²) ÷ 4 = 0.1725", () => {
    expect(hitStats(set).brier).toBeCloseTo((0.2025 + 0.4225 + 0.0625 + 0.0025) / 4, 15);
    expect(hitStats(set).brier).toBeCloseTo(0.1725, 15);
  });

  it("puts each confidence in its bucket, lower bound inclusive, 1.0 in the top bucket", () => {
    const cal = hitStats([...set, mk({ id: "f", direction: "UP", outcome: "DOWN", confidence: 1 })]).calibration;
    expect(cal.map((b) => [b.lower, b.n, b.hits, b.ties])).toEqual([
      [0.5, 1, 1, 0],
      [0.6, 1, 0, 1], // 0.65 miss; 0.6 tie
      [0.7, 1, 1, 0],
      [0.8, 0, 0, 0],
      [0.9, 2, 1, 0], // 0.95 hit; 1.0 miss
    ]);
    expect(cal[4]!.meanConfidence).toBeCloseTo(0.975, 15);
    expect(cal[3]!.hitRate).toBeNull();
    expect(CALIBRATION_BUCKETS).toHaveLength(5);
  });

  it("an empty or all-tie set has no hit rate or Brier score", () => {
    expect(hitStats([])).toMatchObject({ calls: 0, hitRate: null, brier: null });
    expect(hitStats([set[4]!])).toMatchObject({ calls: 1, ties: 1, hitRate: null, brier: null });
  });
});

describe("filters and breakdowns", () => {
  const set = [
    mk({ id: "1", horizon: 1, direction: "UP", outcome: "UP", eventTypes: ["EARNINGS"], relation: "DIRECT" }),
    mk({ id: "2", horizon: 5, direction: "UP", outcome: "DOWN", eventTypes: ["EARNINGS", "GUIDANCE"], relation: "DIRECT" }),
    mk({ id: "3", horizon: 5, direction: "DOWN", outcome: "DOWN", eventTypes: ["ORDER"], relation: "SPILLOVER" }),
    mk({ id: "4", horizon: 1, direction: "DOWN", outcome: "UP" }),
    mk({ id: "5", horizon: 5, direction: "UP", outcome: "UP", hasNews: true }),
  ];

  it("filters by horizon, event type, relation and news", () => {
    const ids = (xs: Scored[]) => xs.map((s) => s.prediction.id);
    expect(ids(filterScored(set, { horizon: 1 }))).toEqual(["1", "4"]);
    expect(ids(filterScored(set, { eventType: "EARNINGS" }))).toEqual(["1", "2"]);
    expect(ids(filterScored(set, { relation: "SPILLOVER" }))).toEqual(["3"]);
    expect(ids(filterScored(set, { relation: "NONE" }))).toEqual(["4", "5"]);
    expect(ids(filterScored(set, { hasNews: false }))).toEqual(["4"]);
    expect(ids(filterScored(set, { horizon: 5, hasNews: true, relation: "DIRECT" }))).toEqual(["2"]);
  });

  it("breaks down by each dimension; a call with two event types counts under both", () => {
    const rate = (dim: Parameters<typeof breakdown>[1]) => breakdown(set, dim).map((g) => [g.key, g.stats.hits, g.stats.misses]);
    expect(rate("horizon")).toEqual([
      ["1", 1, 1],
      ["5", 2, 1],
    ]);
    expect(rate("eventType")).toEqual([
      ["EARNINGS", 1, 1],
      ["GUIDANCE", 0, 1],
      ["NONE", 1, 1],
      ["ORDER", 1, 0],
    ]);
    expect(rate("relation")).toEqual([
      ["DIRECT", 1, 1],
      ["NONE", 1, 1],
      ["SPILLOVER", 1, 0],
    ]);
    expect(rate("news")).toEqual([
      ["NEWS", 3, 1],
      ["NO_NEWS", 0, 1],
    ]);
  });
});

describe("baselines on the same share-days", () => {
  const set = [
    mk({ id: "1", direction: "UP", outcome: "UP", momentum: "UP", reversal: "DOWN" }),
    mk({ id: "2", direction: "UP", outcome: "UP", momentum: "DOWN", reversal: "UP" }),
    mk({ id: "3", direction: "DOWN", outcome: "DOWN", momentum: "DOWN", reversal: null }),
    mk({ id: "4", direction: "DOWN", outcome: "TIE", momentum: "UP", reversal: "UP" }),
    mk({ id: "5", horizon: 1, direction: "UP", outcome: "DOWN", momentum: null, reversal: "DOWN" }),
  ];

  it("coin flip is the analytic 50 % on every decided call", () => {
    expect(baselineStats(set, "COIN_FLIP")).toEqual({ kind: "COIN_FLIP", n: 4, noCall: 0, hits: 2, hitRate: 0.5 });
  });

  it("momentum and reversal use the calls known at D; a zero signal is no call", () => {
    expect(baselineStats(set, "MOMENTUM")).toEqual({ kind: "MOMENTUM", n: 3, noCall: 1, hits: 2, hitRate: 2 / 3 });
    expect(baselineStats(set, "REVERSAL")).toEqual({ kind: "REVERSAL", n: 3, noCall: 1, hits: 2, hitRate: 2 / 3 });
  });

  it("majority direction is the more common realised outcome per horizon, ties of outcomes excluded (A3)", () => {
    expect(majorityDirections(set)).toEqual(
      new Map<Horizon, Direction>([
        [5, "UP"],
        [1, "DOWN"],
      ]),
    );
    // 5-day: UP, UP, DOWN → UP hits 2 of 3; 1-day: DOWN → hits 1 of 1.
    expect(baselineStats(set, "MAJORITY")).toEqual({ kind: "MAJORITY", n: 4, noCall: 0, hits: 3, hitRate: 0.75 });
  });

  it("an even split of outcomes picks UP, which scores 50 % either way", () => {
    const even = [mk({ id: "1", direction: "UP", outcome: "UP" }), mk({ id: "2", direction: "UP", outcome: "DOWN" })];
    expect(majorityDirections(even).get(5)).toBe("UP");
    expect(baselineStats(even, "MAJORITY").hitRate).toBe(0.5);
  });
});

// ---- Inference ----------------------------------------------------------------------------------------------

describe("Newey–West variance of a mean", () => {
  it("[1, 1, 0, 0] with 1 lag, by hand", () => {
    // Deviations ±0.5. γ0 = 4 × 0.25 / 4 = 0.25. γ1 = (0.25 − 0.25 + 0.25) / 4 = 0.0625. w1 = 1 − 1/2.
    const s = 0.25 + 2 * 0.5 * 0.0625;
    expect(neweyWestVarianceOfMean([1, 1, 0, 0], 1)).toBeCloseTo(s / 4, 15);
    expect(neweyWestVarianceOfMean([1, 1, 0, 0], 1)).toBeCloseTo(0.078125, 15);
  });

  it("positive autocorrelation (two blocks of five) raises the variance, 4 lags, by hand", () => {
    // Deviations ±0.5; at lag l, 10 − 2l same-block pairs (+0.25) and l cross-block pairs (−0.25).
    // γl = 0.25 (10 − 3l) / 10: 0.25, 0.175, 0.1, 0.025, −0.05. Weights 0.8, 0.6, 0.4, 0.2.
    const s = 0.25 + 2 * (0.8 * 0.175 + 0.6 * 0.1 + 0.4 * 0.025 + 0.2 * -0.05);
    expect(s).toBeCloseTo(0.65, 15);
    const blocks = [1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
    expect(neweyWestVarianceOfMean(blocks, 4)).toBeCloseTo(0.065, 15);
    expect(neweyWestVarianceOfMean(blocks, 4)).toBeGreaterThan(0.25 / 10); // independent: p(1 − p) / T
  });

  it("negative autocorrelation (alternating) lowers it, 4 lags, by hand", () => {
    // γl = (−1)^l × 0.25 (10 − l) / 10: 0.25, −0.225, 0.2, −0.175, 0.15.
    const s = 0.25 + 2 * (0.8 * -0.225 + 0.6 * 0.2 + 0.4 * -0.175 + 0.2 * 0.15);
    expect(s).toBeCloseTo(0.05, 15);
    expect(neweyWestVarianceOfMean([1, 0, 1, 0, 1, 0, 1, 0, 1, 0], 4)).toBeCloseTo(0.005, 15);
  });

  it("with no lags it is the independent variance, and lags beyond the series are ignored", () => {
    expect(neweyWestVarianceOfMean([1, 0, 0, 1, 1], 0)).toBeCloseTo((0.6 * 0.4) / 5, 15);
    // [1, 0], 4 lags: only lag 1 exists. γ0 = 0.25, γ1 = −0.25 / 2, w1 = 0.8: (0.25 − 0.2) / 2.
    expect(neweyWestVarianceOfMean([1, 0], 4)).toBeCloseTo(0.025, 15);
    expect(() => neweyWestVarianceOfMean([], 4)).toThrow();
    expect(() => neweyWestVarianceOfMean([1], -1)).toThrow();
    expect(NEWEY_WEST_LAGS).toBe(4);
  });
});

describe("hit rate clustered by decision day", () => {
  const obs = (date: string, values: number[]) => values.map((value) => ({ date, value }));

  it("unequal days, by hand: day sums of (hit − p), then Newey–West over days", () => {
    // Day 1: 1, 1, 0; day 2: 0; day 3: 1, 0. p = 3/6. u = (0.5, −0.5, 0).
    // Σu² = 0.5; lag 1: (−0.25 + 0) × 0.8; lag 2: 0. Var = (0.5 − 0.4) / 36.
    const e = clusteredMean([...obs("2026-01-01", [1, 1, 0]), ...obs("2026-01-02", [0]), ...obs("2026-01-03", [1, 0])], 4);
    expect(e.mean).toBe(0.5);
    expect(e.n).toBe(6);
    expect(e.days).toBe(3);
    expect(e.variance).toBeCloseTo(0.1 / 36, 15);
    expect(e.se).toBeCloseTo(Math.sqrt(0.1 / 36), 15);
    expect(e.ci95.lower).toBeCloseTo(0.5 - Z_95 * Math.sqrt(0.1 / 36), 15);
    expect(e.ci95.upper).toBeCloseTo(0.5 + Z_95 * Math.sqrt(0.1 / 36), 15);
    // Independent variance 0.25 / 6; effective n = 6 × (0.25/6) ÷ (0.1/36) = 90. It exceeds n here because
    // the day sums are negatively correlated at lag 1.
    expect(e.effectiveN).toBeCloseTo(90, 10);
  });

  it("with equal calls per day it equals Newey–West on the daily mean hits", () => {
    const random = rng(7);
    const days = Array.from({ length: 30 }, (_, t) => DAYS[t]!);
    const all = days.flatMap((d) => obs(d, Array.from({ length: 10 }, () => (random() < 0.6 ? 1 : 0))));
    const daily = days.map((d) => all.filter((o) => o.date === d).reduce((a, o) => a + o.value, 0) / 10);
    const e = clusteredMean(all, 4);
    expect(e.variance).toBeCloseTo(neweyWestVarianceOfMean(daily, 4), 15);
    expect(e.mean).toBeCloseTo(daily.reduce((a, b) => a + b, 0) / 30, 15);
  });

  it("same-day correlation shrinks the effective sample size", () => {
    // Blocks of days where all 10 calls hit or all miss: 50 calls behave like 5.
    const days = [1, 1, 0, 0, 1].map((v, t) => obs(DAYS[t]!, Array(10).fill(v)));
    const e = clusteredMean(days.flat(), 0);
    expect(e.effectiveN).toBeCloseTo(5, 12);
  });

  it("the Z value is the 97.5 % normal quantile", () => {
    expect(Z_95).toBeCloseTo(1.96, 2);
  });
});

describe("model against a baseline, paired by call", () => {
  it("coin flip: the difference has the hit rate's standard error, shifted by 0.5", () => {
    const set = [
      mk({ id: "1", date: DAYS[0]!, direction: "UP", outcome: "UP" }),
      mk({ id: "2", date: DAYS[0]!, direction: "UP", outcome: "DOWN" }),
      mk({ id: "3", date: DAYS[1]!, direction: "UP", outcome: "UP" }),
      mk({ id: "4", date: DAYS[2]!, direction: "DOWN", outcome: "DOWN" }),
      mk({ id: "5", date: DAYS[2]!, direction: "DOWN", outcome: "TIE" }),
    ];
    const hr = hitRateEstimate(set);
    const c = compareWithBaseline(set, "COIN_FLIP");
    expect(hr.mean).toBe(0.75);
    expect(c.n).toBe(4);
    expect(c.difference.mean).toBe(0.25);
    expect(c.difference.se).toBeCloseTo(hr.se, 15);
  });

  it("momentum, by hand: pairs drop ties and no-calls, then day sums of (d − mean)", () => {
    // Day 0: model hit, momentum miss (d = 1); model miss, momentum miss (d = 0).
    // Day 1: model hit, momentum hit (d = 0); a no-call (dropped).
    // Day 2: model miss, momentum hit (d = −1).
    const set = [
      mk({ id: "1", date: DAYS[0]!, direction: "UP", outcome: "UP", momentum: "DOWN" }),
      mk({ id: "2", date: DAYS[0]!, direction: "UP", outcome: "DOWN", momentum: "UP" }),
      mk({ id: "3", date: DAYS[1]!, direction: "UP", outcome: "UP", momentum: "UP" }),
      mk({ id: "4", date: DAYS[1]!, direction: "UP", outcome: "UP", momentum: null }),
      mk({ id: "5", date: DAYS[2]!, direction: "UP", outcome: "DOWN", momentum: "DOWN" }),
    ];
    const c = compareWithBaseline(set, "MOMENTUM", 4);
    expect(c.n).toBe(4);
    expect(c.modelHitRate).toBe(0.5);
    expect(c.baselineHitRate).toBe(0.5);
    // Mean 0. u = (1, 0, −1). Σu² = 2; lag 1: (0 + 0) ; lag 2: −1 × w2 = −0.6. Var = (2 + 2 × (−0.6)) / 16.
    expect(c.difference.mean).toBe(0);
    expect(c.difference.variance).toBeCloseTo((2 - 1.2) / 16, 15);
  });

  it("throws when nothing pairs", () => {
    expect(() => compareWithBaseline([mk({ direction: "UP", outcome: "UP", momentum: null })], "MOMENTUM")).toThrow(/No paired/);
  });
});

// ---- Verdict ------------------------------------------------------------------------------------------------

describe("verdict thresholds (A2, A5, PLAN §4)", () => {
  const passing: VerdictInput = {
    fiveDay: { calls: 210, hitRate: 0.62, lower: 0.54, upper: 0.7 },
    momentum: { modelHitRate: 0.62, baselineHitRate: 0.52, difference: 0.1, differenceLower: 0.02 },
    majority: { modelHitRate: 0.62, baselineHitRate: 0.53, difference: 0.09, differenceLower: 0.01 },
    portfolio: { excessReturn: -0.01, se: 0.02 },
  };
  const withFive = (c: Partial<VerdictInput["fiveDay"]>): VerdictInput => ({ ...passing, fiveDay: { ...passing.fiveDay, ...c } });

  it("passes when every condition holds", () => {
    const v = decideVerdict(passing);
    expect(v.verdict).toBe("PASS");
    expect(v.pass).toHaveLength(6);
    expect(v.pass.every((c) => c.passed)).toBe(true);
  });

  it("exactly 60 % passes; just under extends", () => {
    expect(VERDICT_RULES.passHitRate).toBe(0.6);
    expect(decideVerdict(withFive({ hitRate: 120 / 200, calls: 200 })).verdict).toBe("PASS");
    expect(decideVerdict(withFive({ hitRate: 0.6 })).verdict).toBe("PASS");
    expect(decideVerdict(withFive({ hitRate: 0.5999 })).verdict).toBe("EXTEND");
  });

  it("exactly 200 calls passes; 199 extends", () => {
    expect(decideVerdict(withFive({ calls: 200 })).verdict).toBe("PASS");
    const v = decideVerdict(withFive({ calls: 199 }));
    expect(v.verdict).toBe("EXTEND");
    expect(v.pass.filter((c) => !c.passed).map((c) => c.rule)).toEqual(["at least 200 matured 5-day calls"]);
  });

  it("a lower bound of exactly 50 % fails: it must be above", () => {
    expect(decideVerdict(withFive({ lower: 0.5 })).verdict).toBe("EXTEND");
    expect(decideVerdict(withFive({ lower: 0.5000001 })).verdict).toBe("PASS");
  });

  it("stops below 55 %, at any number of calls; 55 % itself extends", () => {
    expect(decideVerdict(withFive({ hitRate: 0.5499, lower: 0.45 })).verdict).toBe("STOP");
    expect(decideVerdict(withFive({ hitRate: 0.5499, calls: 40, lower: 0.4 })).verdict).toBe("STOP");
    expect(decideVerdict(withFive({ hitRate: 0.55, lower: 0.47 })).verdict).toBe("EXTEND");
    expect(decideVerdict(withFive({ hitRate: 0.55, lower: 0.47 })).stop.passed).toBe(false);
  });

  it("must beat momentum and majority with a difference whose lower bound is above zero", () => {
    expect(decideVerdict({ ...passing, momentum: { ...passing.momentum, differenceLower: 0 } }).verdict).toBe("EXTEND");
    expect(decideVerdict({ ...passing, majority: { ...passing.majority, differenceLower: -0.01 } }).verdict).toBe("EXTEND");
    expect(
      decideVerdict({ ...passing, momentum: { modelHitRate: 0.62, baselineHitRate: 0.62, difference: 0, differenceLower: 0.001 } }).verdict,
    ).toBe("EXTEND");
  });

  it("portfolio: exactly −2 SE passes (not below by more than 2 SE); lower extends (A5)", () => {
    expect(decideVerdict({ ...passing, portfolio: { excessReturn: -0.5, se: 0.25 } }).verdict).toBe("PASS");
    expect(decideVerdict({ ...passing, portfolio: { excessReturn: -0.5000001, se: 0.25 } }).verdict).toBe("EXTEND");
    expect(() => decideVerdict({ ...passing, portfolio: { excessReturn: 0, se: 0 } })).toThrow();
  });
});

describe("verdict from prediction results", () => {
  /** 22 days × 10 shares of 5-day calls, with hits and baselines set by a seeded generator. */
  function month(seed: number, pHit: number): Scored[] {
    const random = rng(seed);
    return Array.from({ length: 22 * 10 }, (_, k) => {
      const outcome: Direction = random() < 0.5 ? "UP" : "DOWN";
      const hit = random() < pHit;
      const other = (d: Direction): Direction => (d === "UP" ? "DOWN" : "UP");
      return mk({
        date: DAYS[Math.floor(k / 10)]!,
        share: `S${k % 10}`,
        direction: hit ? outcome : other(outcome),
        outcome,
        confidence: 0.5 + random() / 2,
        momentum: random() < 0.5 ? outcome : other(outcome),
        reversal: random() < 0.5 ? outcome : other(outcome),
      });
    });
  }

  it("reads only 5-day calls and reports its statistics", () => {
    const scored = month(1, 0.7);
    const oneDay = mk({ horizon: 1, direction: "UP", outcome: "DOWN" });
    const r = verdictFromResults([...scored, oneDay], { excessReturn: 0, se: 0.02 });
    expect(r.hitRate.n).toBe(220);
    expect(r.hitRate.mean).toBe(scored.filter((s) => s.hit).length / 220);
    expect(r.majority.baseline).toBe("MAJORITY");
    expect(r.hitRate.days).toBe(22);
    expect(["PASS", "EXTEND", "STOP"]).toContain(r.verdict);
  });

  it("throws while any 5-day call is pending (A4)", () => {
    const pending: PredictionResult = { status: "PENDING", prediction: prediction(), endDate: null };
    expect(() => verdictFromResults([...month(2, 0.6), pending], { excessReturn: 0, se: 0.02 })).toThrow(/not matured/);
  });

  it("counts excluded calls and ties apart", () => {
    const excluded: PredictionResult = { status: "EXCLUDED", prediction: prediction({ id: "x" }), endDate: D, reason: "ex-date" };
    const tie = mk({ id: "t", direction: "UP", outcome: "TIE" });
    const r = verdictFromResults([...month(3, 0.6), excluded, tie], { excessReturn: 0, se: 0.02 });
    expect(r.excluded).toBe(1);
    expect(r.ties).toBe(1);
    expect(r.hitRate.n).toBe(220);
  });

  it("shuffling the order of predictions changes nothing", () => {
    const random = rng(99);
    const scored = [
      ...month(4, 0.62),
      ...month(5, 0.55).map((s) => ({ ...s, prediction: { ...s.prediction, horizon: 1 as Horizon, id: `${s.prediction.id}-h1` } })),
      mk({ id: "tie", direction: "UP", outcome: "TIE" }),
    ];
    const everything = (xs: Scored[]) => ({
      stats: hitStats(xs),
      byHorizon: breakdown(xs, "horizon"),
      baselines: (["COIN_FLIP", "MOMENTUM", "REVERSAL", "MAJORITY"] as const).map((k) => baselineStats(xs, k)),
      estimate: hitRateEstimate(xs),
      comparisons: (["COIN_FLIP", "MOMENTUM", "REVERSAL", "MAJORITY"] as const).map((k) => compareWithBaseline(xs, k)),
      verdict: verdictFromResults(xs, { excessReturn: -0.01, se: 0.02 }),
    });
    const reference = everything(scored);
    for (let k = 0; k < 5; k++) expect(everything(shuffle(scored, random))).toEqual(reference);
  });

  it("scoring predictions in any order gives the same results", () => {
    const a = series(100, { [-2]: { close: 99 }, [-1]: { close: 102 }, 0: { open: 101, close: 104 }, 1: { close: 97 }, 2: { close: 103 } });
    const data = exchange({ A: a, B: series(50, { 1: { close: 51 } }), C: series(20, { 0: { close: 19 } }) });
    const preds = ["A", "B", "C"].flatMap((id) =>
      ([1, 5] as const).flatMap((horizon) => [-1, 0, 1].map((o) => prediction({ id: `${id}${horizon}${o}`, orderbookId: id, horizon, decisionDate: dayAt(o) }))),
    );
    const byId = (ps: Prediction[]) => {
      const ex = prepareExchange(data);
      const results = ps.map((p) => [p.id, scorePrediction(p, ex)] as const);
      return Object.fromEntries(results.sort(([x], [y]) => (x < y ? -1 : 1)));
    };
    const reference = byId(preds);
    const random = rng(3);
    for (let k = 0; k < 3; k++) expect(byId(shuffle(preds, random))).toEqual(reference);
  });
});
