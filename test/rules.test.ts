import { describe, expect, it } from "vitest";
import { costConfigSchema, DEFAULT_COST_CONFIG, type CostConfig } from "../src/costs/config.js";

// The scenarios below were built as edge cases at the brief's 3× hurdle. The engine's logic does not depend on
// the multiplier, so they pin 3× explicitly; the default is 2× (D13), tested in "the default 2× hurdle".
const COSTS: CostConfig = costConfigSchema.parse({ ...DEFAULT_COST_CONFIG, hurdleMultiplier: 3 });
import { roundCents } from "../src/costs/costs.js";
import { DEFAULT_RULES_CONFIG as RULES, rulesConfigSchema, sizingRulesFrom, type RulesConfig } from "../src/rules/config.js";
import {
  evaluateRules,
  type Decision,
  type HeldPosition,
  type Prediction,
  type RulesInput,
  type RulesResult,
  type ShortlistedName,
} from "../src/rules/engine.js";
import {
  affordableGrossEur,
  estimateEntry,
  estimateExit,
  exitLevels,
  expectedMovePct,
  sessionsHeld,
} from "../src/rules/trade-numbers.js";
import { simulateEntry, simulateExit } from "../src/sim/fills.js";

const TN = RULES.tradeNumbers;
const SQRT5 = Math.sqrt(5);
const DATE = "2026-09-28";
const LIQUID = 5_000_000; // 10 bps slippage band

// Costs with no slippage, so whole-share sizes land exactly on round euro figures.
const NO_SLIP: CostConfig = costConfigSchema.parse({ ...COSTS, slippageBands: [{ minTurnoverEur: 1_000_000, bps: 0 }] });

const isin = (n: number, country = "FI"): string => `${country}${String(n).padStart(10, "0")}`;
const Y = isin(1); // the name Claude wants to buy in most tests
const Z = isin(2);

const name = (id: string, change: Partial<ShortlistedName> = {}): ShortlistedName => ({
  isin: id,
  sector: `Sector of ${id}`,
  currency: "EUR",
  screenPassed: true,
  previousClose: 10,
  eurRate: 1,
  volatility20d: 0.04,
  medianTurnoverEur: LIQUID,
  ...change,
});

const held = (id: string, change: Partial<HeldPosition> = {}): HeldPosition => ({
  isin: id,
  currency: "EUR",
  shares: 150,
  stopPrice: 8,
  targetPrice: 13,
  medianTurnoverEur: LIQUID,
  entryDate: "2026-09-21",
  sessionsHeld: 2,
  timeStopSessions: 5,
  falsificationMet: false,
  ...change,
});

/** Held names H1, H2, … on the shortlist, each in its own sector. */
const holdings = (count: number): { positions: HeldPosition[]; names: ShortlistedName[] } => {
  const ids = Array.from({ length: count }, (_, i) => isin(100 + i));
  return { positions: ids.map((id) => held(id)), names: ids.map((id) => name(id)) };
};

const up = (id: string, confidence = 0.9, horizonDays = 5): Prediction => ({ isin: id, horizonDays, direction: "up", confidence });
const down = (id: string, confidence = 0.9, horizonDays = 5): Prediction => ({ isin: id, horizonDays, direction: "down", confidence });
const buy = (id: string, horizonDays = 5) => ({ type: "BUY" as const, isin: id, horizonDays });

const input = (change: Partial<RulesInput> = {}): RulesInput => ({
  date: DATE,
  cashEur: 5_000,
  positions: [],
  entriesToday: 0,
  entriesThisMonth: 0,
  shortlist: [name(Y)],
  predictions: [up(Y)],
  actions: [buy(Y)],
  ...change,
});

const run = (i: RulesInput, rules: RulesConfig = RULES, costs: CostConfig = COSTS): RulesResult => evaluateRules(i, rules, costs);
const decisionFor = (r: RulesResult, id: string, action: Decision["action"]): Decision => {
  const found = r.decisions.filter((d) => d.isin === id && d.action === action);
  if (found.length !== 1) throw new Error(`expected one ${action} decision for ${id}, got ${found.length}`);
  return found[0]!;
};
const check = (d: Decision, rule: string) => d.checks.find((c) => c.rule === rule)!;

// ---- Config and trade numbers -----------------------------------------------------------------------------

describe("rules config", () => {
  it("holds the brief §11 defaults", () => {
    expect(RULES).toMatchObject({
      maxPositions: 3,
      targetPositionEur: 1_500,
      minPositionEur: 1_250,
      maxPositionsPerSector: 2,
      cashFloorEur: 250,
      maxNewPositionsPerDay: 1,
      maxRoundTripsPerMonth: 8,
    });
    expect(sizingRulesFrom(RULES)).toEqual({ minPositionEur: 1_250, cashFloorEur: 250 });
  });

  it("rejects a minimum position above the target, and a stop cap of 100 % or more", () => {
    expect(() => rulesConfigSchema.parse({ ...RULES, minPositionEur: 1_600 })).toThrow(/minPositionEur/);
    expect(() => rulesConfigSchema.parse({ ...RULES, tradeNumbers: { ...TN, maxStopPct: 1 } })).toThrow();
  });
});

describe("trade numbers (A1)", () => {
  it("computes E = 100 × κ × (2c − 1) × σ × √h, signed by direction", () => {
    // 100 × (2 × 0.75 − 1) × 0.02 × √5 = √5 ≈ 2.2361 %
    expect(expectedMovePct("up", 0.75, 0.02, 5, TN)).toBeCloseTo(SQRT5, 12);
    expect(expectedMovePct("down", 0.75, 0.02, 5, TN)).toBeCloseTo(-SQRT5, 12);
    expect(expectedMovePct("up", 0.5, 0.02, 5, TN)).toBe(0);
    expect(expectedMovePct("up", 1, 0.03, 1, { ...TN, expectedMoveMultiplier: 0.8 })).toBeCloseTo(2.4, 12);
    expect(() => expectedMovePct("up", 0.49, 0.02, 5, TN)).toThrow(/Confidence/);
    expect(() => expectedMovePct("up", 0.7, 0, 5, TN)).toThrow(/Volatility/);
    expect(() => expectedMovePct("up", 0.7, 0.02, 0, TN)).toThrow(/Horizon/);
  });

  it("sets stop, target and time stop from σ√h", () => {
    const levels = exitLevels(0.02, 5, TN);
    expect(levels.stopPct).toBeCloseTo(2 * 0.02 * SQRT5, 12);
    expect(levels.targetPct).toBeCloseTo(3 * 0.02 * SQRT5, 12);
    expect(levels.timeStopSessions).toBe(5);
    expect(exitLevels(0.02, 5, { ...TN, timeStopMultiplier: 1.2 }).timeStopSessions).toBe(6);
    expect(exitLevels(0.02, 1, { ...TN, timeStopMultiplier: 1.5 }).timeStopSessions).toBe(2);
  });

  it("estimates the whole-share entry exactly as simulateEntry books it at the same price", () => {
    for (const [currency, price, rate] of [
      ["EUR", 9.128, 1],
      ["SEK", 94.96, 10.9785],
      ["DKK", 1_215.5, 7.4636],
    ] as const) {
      const estimate = estimateEntry(1_500, price, rate, currency, LIQUID, COSTS);
      const bar = { tradeDate: DATE, open: price, high: price, low: price, close: price };
      const fill = simulateEntry(
        { currency, sizeEur: 1_500, stopPct: 0.1, targetPct: 0.2, medianTurnoverEur: LIQUID },
        { date: DATE, openDates: new Set([DATE]), bar, eurRate: rate },
        5_000,
        COSTS,
        sizingRulesFrom(RULES),
      );
      if (fill.status !== "FILLED") throw new Error(JSON.stringify(fill));
      expect(estimate.shares).toBe(fill.entry.shares);
      expect(estimate.notionalEur).toBeCloseTo(fill.entry.grossEur, 9);
      expect(estimate.entryCostsEur).toBeCloseTo(fill.entry.feeEur + fill.entry.fxFeeEur, 9);
    }
    expect(estimateEntry(1_500, 1_600, 1, "EUR", LIQUID, COSTS)).toEqual({ shares: 0, notionalEur: 0, entryCostsEur: 0 });
  });

  it("estimates the exit exactly as simulateExit books it at the same price", () => {
    const estimate = estimateExit(164, 94.96, 10.9785, "SEK", LIQUID, COSTS);
    const bar = { tradeDate: DATE, open: 94.96, high: 94.96, low: 94.96, close: 94.96 };
    const fill = simulateExit(
      { currency: "SEK", shares: 164, stopPrice: 80, targetPrice: 120, medianTurnoverEur: LIQUID },
      { date: DATE, openDates: new Set([DATE]), bar, eurRate: 10.9785 },
      COSTS,
    );
    if (fill.status !== "FILLED") throw new Error(JSON.stringify(fill));
    expect(estimate.proceedsEur).toBe(fill.exit.cashChangeEur);
    expect(estimate.costEur).toBeCloseTo(fill.exit.slippageEur + fill.exit.feeEur + fill.exit.fxFeeEur, 9);
  });

  it("finds the largest gross entry that fits the cash, fees included", () => {
    // Minimum fee binds: n + 9 = 1,000.
    expect(affordableGrossEur(1_000, "EUR", COSTS)).toBe(991);
    // Rate binds: n × 1.002 = 10,000.
    expect(affordableGrossEur(10_000, "EUR", COSTS)).toBeCloseTo(10_000 / 1.002, 9);
    // SEK: n + 10 + 0.25 % × n = 1,500 (Nordic minimum, FX fee on the notional).
    const sek = affordableGrossEur(1_500, "SEK", COSTS);
    expect(sek).toBeCloseTo(1_490 / 1.0025, 9);
    expect(sek + 10 + 0.0025 * sek).toBeCloseTo(1_500, 9);
    expect(affordableGrossEur(5, "EUR", COSTS)).toBe(0);
    expect(affordableGrossEur(-100, "EUR", COSTS)).toBe(0);
  });

  it("counts sessions held from the entry session to the day before the decision", () => {
    const open = new Set(["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-28"]);
    expect(sessionsHeld("2026-09-21", "2026-09-22", open)).toBe(1);
    expect(sessionsHeld("2026-09-21", "2026-09-28", open)).toBe(5);
    expect(() => sessionsHeld("2026-09-26", "2026-09-28", open)).toThrow(/not an open day/);
    expect(() => sessionsHeld("2026-09-28", "2026-09-28", open)).toThrow(/before/);
  });
});

// ---- Engine ----------------------------------------------------------------------------------------------

describe("an admissible BUY", () => {
  it("returns an EntryOrder with code-set stop, target, size and time stop", () => {
    const r = run(input());
    // σ = 4 %, h = 5, c = 0.9: E = 0.8 × 0.04 × √5 = 7.155 %. 149 shares at 10.01 € = 1,491.49 €.
    expect(r.entries).toHaveLength(1);
    const entry = r.entries[0]!;
    expect(entry.order).toEqual({
      currency: "EUR",
      sizeEur: 1_500,
      stopPct: 2 * 0.04 * SQRT5,
      targetPct: 3 * 0.04 * SQRT5,
      medianTurnoverEur: LIQUID,
    });
    expect(entry).toMatchObject({ isin: Y, horizonDays: 5, timeStopSessions: 5, estimatedShares: 149, replaces: null });
    expect(entry.estimatedNotionalEur).toBeCloseTo(1_491.49, 9);
    expect(entry.expectedMovePct).toBeCloseTo(80 * 0.04 * SQRT5, 12);
    // Independent: 3 × (2 × 9 € + 2 × 0.10 % × 1,491.49 €) ÷ 1,491.49 € = 4.2206 %.
    expect(entry.hurdlePct).toBeCloseTo((3 * (18 + 0.002 * 1_491.49) * 100) / 1_491.49, 9);

    const d = decisionFor(r, Y, "BUY");
    expect(d).toMatchObject({ step: 3, origin: "PROPOSED", accepted: true, reasons: ["ALL_CHECKS_PASSED"] });
    expect(d.checks.map((c) => c.rule)).toEqual([
      "POSITION_CAP",
      "SECTOR_CAP",
      "OPENING_PACE",
      "TURNOVER_CAP",
      "CASH_FLOOR",
      "MIN_POSITION",
      "HURDLE",
      "STOP_WIDTH",
    ]);
    expect(d.checks.every((c) => c.passed)).toBe(true);
    expect(r.exits).toEqual([]);
    expect(r.keeps).toEqual([]);
  });

  it("produces an order that simulateEntry fills at the estimated size when the open equals the previous close", () => {
    const r = run(input());
    const bar = { tradeDate: DATE, open: 10, high: 10.2, low: 9.9, close: 10 };
    const fill = simulateEntry(r.entries[0]!.order, { date: DATE, openDates: new Set([DATE]), bar, eurRate: 1 }, 5_000, COSTS, sizingRulesFrom(RULES));
    if (fill.status !== "FILLED") throw new Error(JSON.stringify(fill));
    expect(fill.entry.shares).toBe(r.entries[0]!.estimatedShares);
    expect(fill.position.stopPrice).toBeCloseTo(10 * (1 - 2 * 0.04 * SQRT5), 12);
  });
});

describe("step 1: the screen", () => {
  it("rejects names that are not shortlisted or failed the screen", () => {
    const r = run(input({ shortlist: [name(Y, { screenPassed: false })], actions: [buy(Y), buy(Z)], predictions: [up(Y)] }));
    expect(decisionFor(r, Y, "BUY")).toMatchObject({ step: 1, accepted: false, reasons: ["SCREEN_FAILED"] });
    expect(decisionFor(r, Z, "BUY")).toMatchObject({ step: 1, accepted: false, reasons: ["NOT_SHORTLISTED"] });
    expect(r.entries).toEqual([]);
  });

  it("rejects a SELL or KEEP of a name not held, a BUY of a held one, and more than one action per name", () => {
    const h = holdings(1);
    const H = h.positions[0]!.isin;
    const r = run(
      input({
        positions: h.positions,
        shortlist: [name(Y), name(Z), ...h.names],
        predictions: [up(Y), up(Z)],
        actions: [{ type: "SELL", isin: Y }, buy(H), buy(Z), { type: "KEEP", isin: Z }],
      }),
    );
    expect(decisionFor(r, Y, "SELL").reasons).toEqual(["NOT_HELD"]);
    expect(decisionFor(r, H, "BUY").reasons).toEqual(["ALREADY_HELD"]);
    expect(decisionFor(r, Z, "BUY")).toMatchObject({ accepted: false, reasons: ["DUPLICATE_ACTION"] });
    expect(decisionFor(r, Z, "KEEP")).toMatchObject({ accepted: false, reasons: ["DUPLICATE_ACTION"] });
    expect(decisionFor(r, H, "KEEP")).toMatchObject({ step: 4, origin: "RULE", accepted: true });
    expect(r.entries).toEqual([]);
  });

  it("validates Claude's proposals with zod, and throws on inconsistent inputs from code", () => {
    expect(() => run(input({ actions: [{ type: "BUY", isin: Y }] }))).toThrow(/horizonDays/);
    expect(() => run(input({ predictions: [{ ...up(Y), confidence: 0.4 }] }))).toThrow();
    expect(() => run(input({ positions: [held(Z)] }))).toThrow(/not on the shortlist/);
    expect(() => run(input({ shortlist: [name(Y), name(Y)] }))).toThrow(/Duplicate/);
    expect(() => run(input({ shortlist: [name(Y, { currency: "SEK", eurRate: 1, sector: " " })] }))).toThrow(/sector/);
    expect(() => run(input({ shortlist: [name(Y, { eurRate: 1.1 })] }))).toThrow(/EUR rate/);
    expect(() => run(input({ entriesToday: -1 }))).toThrow(/Entries today/);
  });
});

describe("step 2: SELL triggers", () => {
  const one = (change: Partial<HeldPosition>, nameChange: Partial<ShortlistedName> = {}, actions: RulesInput["actions"] = []) => {
    const H = isin(100);
    return { H, r: run(input({ positions: [held(H, change)], shortlist: [name(H, nameChange)], predictions: [], actions })) };
  };

  it("sells on falsification, whether or not Claude proposed the sale", () => {
    const { H, r } = one({ falsificationMet: true });
    expect(decisionFor(r, H, "SELL")).toMatchObject({ step: 2, origin: "RULE", accepted: true, reasons: ["FALSIFIED"] });
    expect(r.exits).toEqual([{ isin: H, position: { currency: "EUR", shares: 150, stopPrice: 8, targetPrice: 13, medianTurnoverEur: LIQUID }, reasons: ["FALSIFIED"] }]);
    const proposed = one({ falsificationMet: true }, {}, [{ type: "SELL", isin: isin(100) }]);
    expect(decisionFor(proposed.r, proposed.H, "SELL").origin).toBe("PROPOSED");
  });

  it.each([
    [8.01, false],
    [8, true],
    [7.99, true],
  ])("stop at 8: previous close %s → sold %s", (close, sold) => {
    const { H, r } = one({}, { previousClose: close });
    expect(r.exits.map((e) => e.isin)).toEqual(sold ? [H] : []);
    if (sold) expect(decisionFor(r, H, "SELL").reasons).toEqual(["STOP_HIT"]);
  });

  it.each([
    [4, false],
    [5, true],
    [6, true],
  ])("time stop of 5 sessions: %s held → sold %s", (n, sold) => {
    const { H, r } = one({ sessionsHeld: n });
    expect(r.exits.map((e) => e.isin)).toEqual(sold ? [H] : []);
    expect(decisionFor(r, H, sold ? "SELL" : "KEEP").triggers.find((t) => t.trigger === "TIME_STOP")).toEqual({
      trigger: "TIME_STOP",
      met: sold,
      figures: { sessionsHeld: n, timeStopSessions: 5 },
    });
  });

  it("sells a held name that fails the screen, and lists every trigger met", () => {
    const { H, r } = one({ falsificationMet: true, sessionsHeld: 5 }, { screenPassed: false });
    expect(decisionFor(r, H, "SELL").reasons).toEqual(["FALSIFIED", "TIME_STOP", "SCREEN_FAILED"]);
  });

  it("keeps a position when Claude proposes a SELL without a trigger and no better use of the slot", () => {
    const { H, r } = one({}, {}, [{ type: "SELL", isin: isin(100) }]);
    expect(decisionFor(r, H, "SELL")).toMatchObject({ step: 3, accepted: false, reasons: ["NO_SELL_TRIGGER"] });
    expect(decisionFor(r, H, "KEEP")).toMatchObject({ step: 4, origin: "RULE", accepted: true, reasons: ["NO_TRIGGER"] });
    expect(r.exits).toEqual([]);
    expect(r.keeps.map((k) => k.isin)).toEqual([H]);
  });

  it("counts the estimated sale proceeds towards the cash for a BUY on the same day", () => {
    // Cash 1,000 € alone cannot fund 1,250 €; the forced sale of 150 × 10 € adds 1,489.50 € (1,500 − 1.50 − 9).
    const H = isin(100);
    const r = run(
      input({
        cashEur: 1_000,
        positions: [held(H, { falsificationMet: true })],
        shortlist: [name(Y), name(H)],
        predictions: [up(Y)],
      }),
    );
    expect(decisionFor(r, H, "SELL").figures.estimatedProceedsEur).toBe(1_489.5);
    expect(check(decisionFor(r, Y, "BUY"), "CASH_FLOOR").figures.cashEur).toBe(2_489.5);
    expect(r.entries).toHaveLength(1);
  });
});

describe("step 3: BUY checks, each at, just under and just over its limit", () => {
  it.each([
    [2, true],
    [3, false],
    [4, false],
  ])("position cap of 3: %s held → accepted %s", (count, accepted) => {
    const h = holdings(count);
    const r = run(input({ positions: h.positions, shortlist: [name(Y), ...h.names], cashEur: 20_000 }));
    const d = decisionFor(r, Y, "BUY");
    expect(d.accepted).toBe(accepted);
    expect(check(d, "POSITION_CAP")).toEqual({ rule: "POSITION_CAP", passed: accepted, figures: { positions: count, max: 3 } });
    if (!accepted) expect(d.reasons).toEqual(["POSITION_CAP"]);
  });

  it.each([
    [1, true],
    [2, false],
    [3, false],
  ])("sector cap of 2: %s held in the sector → accepted %s", (count, accepted) => {
    const h = holdings(count);
    const rules = { ...RULES, maxPositions: 10 };
    const r = run(
      input({ positions: h.positions, shortlist: [name(Y, { sector: "Industrials" }), ...h.names.map((n) => ({ ...n, sector: "Industrials" }))], cashEur: 20_000 }),
      rules,
    );
    const d = decisionFor(r, Y, "BUY");
    expect(d.accepted).toBe(accepted);
    expect(check(d, "SECTOR_CAP").figures).toEqual({ sector: "Industrials", inSector: count, max: 2 });
    if (!accepted) expect(d.reasons).toEqual(["SECTOR_CAP"]);
  });

  it.each([
    [0, true],
    [1, false],
    [2, false],
  ])("opening pace of 1: %s entries already today → accepted %s", (today, accepted) => {
    const d = decisionFor(run(input({ entriesToday: today })), Y, "BUY");
    expect(d.accepted).toBe(accepted);
    if (!accepted) expect(d.reasons).toEqual(["OPENING_PACE"]);
  });

  it("opens only the best of two admissible BUYs under the pace of 1, and both under a pace of 2", () => {
    // Z is listed first but has the lower confidence, so Y ranks first.
    const i = input({ shortlist: [name(Z), name(Y)], predictions: [up(Z, 0.85), up(Y, 0.9)], actions: [buy(Z), buy(Y)] });
    const r = run(i);
    expect(r.entries.map((e) => e.isin)).toEqual([Y]);
    expect(decisionFor(r, Z, "BUY").reasons).toEqual(["OPENING_PACE"]);
    const both = run(i, { ...RULES, maxNewPositionsPerDay: 2 });
    expect(both.entries.map((e) => e.isin)).toEqual([Y, Z]);
    // The second entry sees the first one's cost committed: 1,491.49 € + 9 € fee.
    expect(check(decisionFor(both, Z, "BUY"), "CASH_FLOOR").figures.committedEur).toBeCloseTo(1_500.49, 9);
  });

  it.each([
    [7, true],
    [8, false],
    [9, false],
  ])("turnover cap of 8 a month: %s entries so far → accepted %s", (month, accepted) => {
    const d = decisionFor(run(input({ entriesThisMonth: month })), Y, "BUY");
    expect(d.accepted).toBe(accepted);
    if (!accepted) expect(d.reasons).toEqual(["TURNOVER_CAP"]);
  });

  // No slippage and a 10 € share: 1,250 € buys exactly 125 shares for 1,259 € with the 9 € fee.
  it.each([
    [1_508.99, false],
    [1_509, true],
    [1_509.01, true],
  ])("cash floor of 250 €: cash %s → accepted %s", (cash, accepted) => {
    const d = decisionFor(run(input({ cashEur: cash }), RULES, NO_SLIP), Y, "BUY");
    expect(d.accepted).toBe(accepted);
    expect(check(d, "CASH_FLOOR").figures.availableEur).toBeCloseTo(cash - 250, 9);
    if (!accepted) expect(d.reasons[0]).toBe("CASH_FLOOR");
  });

  it("agrees with simulateEntry at the cash-floor limit", () => {
    const r = run(input({ cashEur: 1_509 }), RULES, NO_SLIP);
    expect(r.entries[0]!.order.sizeEur).toBe(1_250);
    const bar = { tradeDate: DATE, open: 10, high: 10, low: 10, close: 10 };
    const fill = simulateEntry(r.entries[0]!.order, { date: DATE, openDates: new Set([DATE]), bar, eurRate: 1 }, 1_509, NO_SLIP, sizingRulesFrom(RULES));
    expect(fill.status).toBe("FILLED");
    if (fill.status === "FILLED") expect(roundCents(1_509 + fill.entry.cashChangeEur)).toBe(250);
  });

  // No slippage: 1,500 € buys 2 shares at these prices.
  it.each([
    [624.99, false],
    [625, true],
    [625.01, true],
  ])("minimum position of 1,250 € after rounding: price %s → accepted %s", (price, accepted) => {
    const d = decisionFor(run(input({ shortlist: [name(Y, { previousClose: price })] }), RULES, NO_SLIP), Y, "BUY");
    expect(d.accepted).toBe(accepted);
    expect(check(d, "MIN_POSITION").figures.estimatedShares).toBe(2);
    if (!accepted) expect(d.reasons).toEqual(["MIN_POSITION"]);
  });

  it("rejects a share whose single unit is dearer than the target size", () => {
    const d = decisionFor(run(input({ shortlist: [name(Y, { previousClose: 1_600 })] })), Y, "BUY");
    expect(d.reasons).toEqual(["MIN_POSITION", "HURDLE"]);
    expect(check(d, "HURDLE").figures.hurdlePct).toBeNull();
  });

  it("tests the hurdle on the rounded size: passes at the intended 1,500 €, fails at the whole-share size", () => {
    // 700 € share: 2 shares × 700.70 € = 1,401.40 €. Hurdle at 1,500 €: 3 × (18 + 3) ÷ 1,500 = 4.20 % (A8).
    // At 1,401.40 €: 3 × (18 + 2.8028) ÷ 1,401.40 = 4.4533 %. E = 0.64 × 0.03 × √5 = 4.2933 %.
    const r = run(input({ shortlist: [name(Y, { previousClose: 700, volatility20d: 0.03 })], predictions: [up(Y, 0.82)] }));
    const d = decisionFor(r, Y, "BUY");
    const hurdle = check(d, "HURDLE");
    expect(hurdle.figures.hurdlePctAtIntendedSize).toBeCloseTo(4.2, 12);
    expect(hurdle.figures.expectedMovePct).toBeCloseTo(64 * 0.03 * SQRT5, 12);
    expect(hurdle.figures.atNotionalEur).toBeCloseTo(1_401.4, 9);
    expect(hurdle.figures.hurdlePct).toBeCloseTo((3 * (18 + 0.002 * 1_401.4) * 100) / 1_401.4, 9);
    expect(d).toMatchObject({ accepted: false, reasons: ["HURDLE"] });
  });

  it("the default 2× hurdle (D13) accepts the same BUY that 3× rejects", () => {
    // Same case as above. At 1,401.40 €: 2 × (18 + 2.8028) ÷ 1,401.40 = 2.9689 % < E = 4.2933 %.
    expect(DEFAULT_COST_CONFIG.hurdleMultiplier).toBe(2);
    const r = run(input({ shortlist: [name(Y, { previousClose: 700, volatility20d: 0.03 })], predictions: [up(Y, 0.82)] }), RULES, DEFAULT_COST_CONFIG);
    const d = decisionFor(r, Y, "BUY");
    expect(check(d, "HURDLE").figures.hurdlePct).toBeCloseTo((2 * (18 + 0.002 * 1_401.4) * 100) / 1_401.4, 9);
    expect(d.accepted).toBe(true);
  });

  it.each([
    [-1e-6, false],
    [0, true],
    [1e-6, true],
  ])("hurdle: expected move of hurdle %s → accepted %s", (offset, accepted) => {
    // Choose the confidence so that E equals the hurdle at the estimated size, plus the offset.
    const hurdle = (3 * (18 + 0.002 * 1_491.49) * 100) / 1_491.49;
    const sigma = 0.04;
    const c = (1 + (hurdle + offset) / (100 * sigma * SQRT5)) / 2;
    const d = decisionFor(run(input({ predictions: [up(Y, c)] })), Y, "BUY");
    const fig = check(d, "HURDLE").figures;
    // At offset 0 the two agree only to floating-point noise, so the outcome is compared to the figures.
    if (offset === 0) expect(d.accepted).toBe((fig.expectedMovePct as number) >= (fig.hurdlePct as number));
    else expect(d.accepted).toBe(accepted);
  });

  it.each([
    [0.11, true],
    [0.25 / SQRT5, true],
    [0.12, false],
  ])("stop width of at most 50 %%: σ %s → accepted %s", (sigma, accepted) => {
    const d = decisionFor(run(input({ shortlist: [name(Y, { volatility20d: sigma })], predictions: [up(Y, 0.6)] })), Y, "BUY");
    expect(check(d, "STOP_WIDTH").passed).toBe(accepted);
  });

  it("rejects a BUY without a prediction at its horizon, or against a down call", () => {
    expect(decisionFor(run(input({ actions: [buy(Y, 1)] })), Y, "BUY").reasons).toEqual(["NO_PREDICTION"]);
    expect(decisionFor(run(input({ predictions: [down(Y)] })), Y, "BUY").reasons).toEqual(["DIRECTION_NOT_UP"]);
  });

  it("reports every failing rule, in evaluation order", () => {
    const h = holdings(3);
    const d = decisionFor(run(input({ positions: h.positions, shortlist: [name(Y), ...h.names], entriesToday: 1, predictions: [up(Y, 0.6)] })), Y, "BUY");
    expect(d.reasons).toEqual(["POSITION_CAP", "OPENING_PACE", "HURDLE"]);
  });
});

describe("a SELL for a better use of the slot", () => {
  const H = isin(100);
  const others = holdings(3).positions.slice(1);
  const otherNames = holdings(3).names.slice(1);
  // Cash 500 € is what three 1,500 € positions leave of 5,000 €.
  const swap = (buyConfidence: number, heldPrediction: Prediction, cashEur = 500) =>
    run(
      input({
        cashEur,
        positions: [held(H), ...others],
        shortlist: [name(Y), name(H), ...otherNames],
        predictions: [up(Y, buyConfidence), heldPrediction],
        actions: [buy(Y), { type: "SELL", isin: H }],
      }),
    );
  // Exit of 150 × 10 €: slippage 1.50 € + fee 9 € = 10.50 €, i.e. 0.704 % of the new 1,491.49 € position.
  const exitCostPct = (10.5 * 100) / 1_491.49;

  it("sells and buys when the expected move clears the hurdle net of the exit cost", () => {
    const r = swap(0.9, down(H));
    const sell = decisionFor(r, H, "SELL");
    expect(sell).toMatchObject({ step: 3, origin: "PROPOSED", accepted: true, reasons: ["BETTER_USE_OF_SLOT"] });
    expect(sell.figures.exitCostEur).toBeCloseTo(10.5, 9);
    expect(sell.figures.netMovePct).toBeCloseTo(80 * 0.04 * SQRT5 - exitCostPct, 9);
    expect(sell.figures.heldExpectedMovePct).toBeLessThan(0);
    expect(decisionFor(r, Y, "BUY")).toMatchObject({ accepted: true, reasons: ["BETTER_USE_OF_SLOT"] });
    expect(r.exits.map((e) => [e.isin, e.reasons])).toEqual([[H, ["BETTER_USE_OF_SLOT"]]]);
    expect(r.entries[0]).toMatchObject({ isin: Y, replaces: H });
    expect(r.keeps.map((k) => k.isin)).toEqual(others.map((p) => p.isin));
  });

  it("refuses when the move clears the hurdle alone but not after the exit cost", () => {
    // c = 0.76: E = 0.52 × 0.04 × √5 = 4.651 %, above the 4.2206 % hurdle, but 4.651 − 0.704 = 3.947 % is below it.
    // Ample cash, so the base BUY fails on the position cap alone.
    const r = swap(0.76, down(H), 5_000);
    const buyDecision = decisionFor(r, Y, "BUY");
    expect(buyDecision).toMatchObject({ accepted: false, reasons: ["POSITION_CAP"] });
    expect(check(buyDecision, "HURDLE").passed).toBe(true);
    expect(buyDecision.swapAttempts).toHaveLength(1);
    expect(buyDecision.swapAttempts[0]).toMatchObject({ sellIsin: H, passed: false, failed: ["HURDLE"] });
    expect(buyDecision.swapAttempts[0]!.figures.netMovePct).toBeCloseTo(52 * 0.04 * SQRT5 - exitCostPct, 9);
    expect(decisionFor(r, H, "SELL")).toMatchObject({ accepted: false, reasons: ["NO_SELL_TRIGGER"] });
    expect(r.exits).toEqual([]);
    expect(r.entries).toEqual([]);
  });

  it("also subtracts the held name's own expected gain", () => {
    // Held name: σ 4 %, up at 0.7 → 0.4 × 0.04 × √5 = 3.578 %. Net 7.155 − 0.704 − 3.578 = 2.873 % < 4.2206 %.
    const r = swap(0.9, up(H, 0.7));
    const attempt = decisionFor(r, Y, "BUY").swapAttempts[0]!;
    expect(attempt.figures.heldExpectedMovePct).toBeCloseTo(40 * 0.04 * SQRT5, 9);
    expect(attempt).toMatchObject({ passed: false, failed: ["HURDLE"] });
  });

  it("chooses the candidate with the larger net move", () => {
    const H2 = others[0]!.isin;
    const r = run(
      input({
        cashEur: 500,
        positions: [held(H), ...others],
        shortlist: [name(Y), name(H), ...otherNames],
        predictions: [up(Y, 0.95), up(H, 0.55), down(H2)],
        actions: [buy(Y), { type: "SELL", isin: H }, { type: "SELL", isin: H2 }],
      }),
    );
    expect(r.entries[0]!.replaces).toBe(H2);
    expect(decisionFor(r, H, "SELL").reasons).toEqual(["NO_SELL_TRIGGER"]);
  });
});

describe("a SEK name on the Nordic fee schedule", () => {
  it("tests the hurdle with the 10 € minimum and the FX fee on both sides", () => {
    // 100 SEK at 11 SEK/EUR, 10 bps: floor(1,500 × 11 ÷ 100.1) = 164 shares = 1,492.40 €.
    const S = isin(3, "SE");
    const r = run(
      input({
        shortlist: [name(S, { currency: "SEK", eurRate: 11, previousClose: 100 })],
        predictions: [up(S, 0.95)],
        actions: [buy(S)],
      }),
    );
    const n = (164 * 100.1) / 11;
    const fx = roundCents(0.0025 * n);
    // Independent: fees 2 × 10 € (0.25 % of n is 3.73 €, below the minimum), FX 2 × 3.73 €, slippage 2 × 0.10 %.
    const expected = (3 * (20 + 2 * fx + 0.002 * n) * 100) / n;
    const helsinki = (3 * (18 + 0.002 * n) * 100) / n;
    const d = decisionFor(r, S, "BUY");
    expect(check(d, "MIN_POSITION").figures.estimatedShares).toBe(164);
    expect(check(d, "HURDLE").figures.hurdlePct).toBeCloseTo(expected, 9);
    expect(expected).toBeCloseTo(6.12, 2);
    expect(expected - helsinki).toBeGreaterThan(1.8);
    // E = 0.9 × 0.04 × √5 = 8.05 % clears it.
    expect(r.entries[0]).toMatchObject({ isin: S, estimatedShares: 164, order: { currency: "SEK", sizeEur: 1_500 } });
  });

  it("sizes a SEK entry down to the cash available after the Nordic minimum and the FX fee", () => {
    const S = isin(3, "SE");
    const r = run(
      input({
        cashEur: 1_700,
        shortlist: [name(S, { currency: "SEK", eurRate: 11, previousClose: 100 })],
        predictions: [up(S, 0.95)],
        actions: [buy(S)],
      }),
    );
    // Available 1,450 €: n + 10 + 0.25 % × n = 1,450.
    expect(r.entries[0]!.order.sizeEur).toBeCloseTo(1_440 / 1.0025, 9);
  });
});

describe("determinism", () => {
  const h = holdings(3);
  const full = input({
    cashEur: 900,
    positions: [held(h.positions[0]!.isin, { sessionsHeld: 5 }), ...h.positions.slice(1)],
    shortlist: [name(Y), name(Z), name(isin(9), { screenPassed: false }), ...h.names],
    predictions: [up(Y, 0.9), up(Z, 0.95), ...h.names.map((n) => down(n.isin))],
    actions: [buy(Z), buy(Y), { type: "SELL", isin: h.positions[2]!.isin }, buy(isin(9)), { type: "KEEP", isin: h.positions[1]!.isin }],
  });

  it("gives the same output, in the same order, for the same inputs", () => {
    const a = run(full);
    const b = run(structuredClone(full));
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("does not depend on the order of the input lists", () => {
    const reversed: RulesInput = {
      ...full,
      positions: [...full.positions].reverse(),
      shortlist: [...full.shortlist].reverse(),
      predictions: [...full.predictions].reverse(),
      actions: [...full.actions].reverse(),
    };
    expect(JSON.stringify(run(reversed))).toBe(JSON.stringify(run(full)));
  });

  it("records a decision for every proposal and every held position", () => {
    const r = run(full);
    // H100 hits its time stop; Z outranks Y and takes the day's only opening; the SELL of H102 frees nothing
    // Y could use, because the opening pace still binds.
    expect(r.decisions.map((d) => [d.step, d.action, d.isin, d.accepted, d.reasons.join("+")])).toEqual([
      [1, "BUY", isin(9), false, "SCREEN_FAILED"],
      [2, "SELL", isin(100), true, "TIME_STOP"],
      [3, "BUY", Z, true, "ALL_CHECKS_PASSED"],
      [3, "BUY", Y, false, "POSITION_CAP+OPENING_PACE+CASH_FLOOR+MIN_POSITION+HURDLE"],
      [3, "SELL", isin(102), false, "NO_SELL_TRIGGER"],
      [4, "KEEP", isin(101), true, "NO_TRIGGER"],
      [4, "KEEP", isin(102), true, "NO_TRIGGER"],
    ]);
    expect(decisionFor(r, isin(101), "KEEP").origin).toBe("PROPOSED");
    expect(decisionFor(r, isin(102), "KEEP").origin).toBe("RULE");
    expect(r.decisions.every((d) => d.reasons.length > 0)).toBe(true);
  });
});
