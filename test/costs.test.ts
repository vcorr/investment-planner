import { describe, expect, it } from "vitest";
import { costConfigSchema, DEFAULT_COST_CONFIG, type CostConfig, type Tier } from "../src/costs/config.js";
import {
  fxFee,
  hurdlePct,
  minimumBindingNotionalEur,
  orderFee,
  roundCents,
  roundTripCost,
  roundTripCostPct,
  slippageBps,
} from "../src/costs/costs.js";

const atTier = (tier: Tier): CostConfig => ({ ...DEFAULT_COST_CONFIG, tier });
/** Brokerage fees for buying and selling the same notional, nothing else. */
const feesOnly = (notionalEur: number, tier: Tier) => 2 * orderFee(notionalEur, "EUR", atTier(tier)).amountEur;
const pctOf = (eur: number, notionalEur: number) => (eur / notionalEur) * 100;

const LIQUID = 5_000_000; // 10 bps band
const MID = 2_000_000; // 25 bps band

describe("golden cost tests (brief §19, verification V1)", () => {
  it.each([
    // notional, tier, round-trip fees €, as % of notional (to the 2 dp quoted)
    [1_000, "taso3", 14.0, 1.4],
    [1_500, "taso3", 14.0, 0.93],
    [5_000, "taso3", 15.0, 0.3],
    [1_000, "taso1", 6.0, 0.6],
    [1_000, "taso4", 18.0, 1.8],
    [1_500, "taso4", 18.0, 1.2],
    [5_000, "taso4", 20.0, 0.4],
  ] as const)("%d € Helsinki round trip at %s, fees only: %d €", (notional, tier, eur, pct) => {
    expect(feesOnly(notional, tier)).toBe(eur);
    expect(pctOf(feesOnly(notional, tier), notional)).toBeCloseTo(pct, 2);
  });

  it("the Taso 3 minimum stops binding at 4,666.67 €", () => {
    expect(roundCents(minimumBindingNotionalEur("taso3", DEFAULT_COST_CONFIG))).toBe(4_666.67);
  });

  it("the Taso 4 minimum stops binding at 4,500.00 €", () => {
    expect(roundCents(minimumBindingNotionalEur("taso4", DEFAULT_COST_CONFIG))).toBe(4_500);
  });

  it("1,500 € Helsinki at Taso 4 with 10 bps slippage: round trip 1.40 %, hurdle 4.20 % (A8)", () => {
    const cost = roundTripCost(1_500, "EUR", LIQUID, DEFAULT_COST_CONFIG);
    expect(cost).toMatchObject({ feesEur: 18, fxFeesEur: 0 });
    expect(cost.slippageEur).toBeCloseTo(3, 10);
    expect(cost.pct).toBeCloseTo(1.4, 10);
    expect(hurdlePct(1_500, "EUR", LIQUID, DEFAULT_COST_CONFIG)).toBeCloseTo(4.2, 10);
  });

  it.each(["SEK", "DKK"] as const)("1,500 € %s name at Taso 4 (0.25 %, min 10 €), 10 bps, FX 0.25 % per side: 2.03 %, hurdle 6.10 % (V2)", (currency) => {
    // Fees 2 × 10 € + FX 2 × 3.75 € + slippage 2 × 1.50 € = 30.50 € on 1,500 €.
    const cost = roundTripCost(1_500, currency, LIQUID, DEFAULT_COST_CONFIG);
    expect(cost).toMatchObject({ feesEur: 20, fxFeesEur: 7.5 });
    expect(cost.totalEur).toBeCloseTo(30.5, 10);
    expect(cost.pct).toBeCloseTo(2.0333, 4);
    expect(hurdlePct(1_500, currency, LIQUID, DEFAULT_COST_CONFIG)).toBeCloseTo(6.1, 10);
  });

  it("the Nordic Taso 4 minimum stops binding at 4,000.00 € (10 € / 0.25 %)", () => {
    expect(roundCents(minimumBindingNotionalEur("taso4", DEFAULT_COST_CONFIG, "nordic"))).toBe(4_000);
  });

  it("reproduces the brief's Taso 3 Helsinki illustration in §11 (about 1.13 %)", () => {
    // The brief's 1.63 % for SEK names assumed Helsinki fees; the sourced Nordic schedule (V2) gives 2.03 %.
    expect(roundTripCostPct(1_500, "EUR", LIQUID, atTier("taso3"))).toBeCloseTo(1.13, 2);
    expect(roundTripCostPct(1_500, "SEK", LIQUID, atTier("taso3"))).toBeCloseTo(2.03, 2);
  });
});

describe("orderFee", () => {
  it("charges the percentage once it exceeds the minimum", () => {
    expect(orderFee(10_000, "EUR", DEFAULT_COST_CONFIG).amountEur).toBe(20);
  });

  it("rounds to the cent", () => {
    expect(orderFee(4_567.891, "EUR", DEFAULT_COST_CONFIG).amountEur).toBe(9.14);
  });

  it("uses the Nordic schedule for SEK and DKK names: 0.25 %, minimum 10 € (V2)", () => {
    expect(orderFee(1_500, "SEK", DEFAULT_COST_CONFIG)).toEqual({ amountEur: 10, provenance: "SOURCED" });
    expect(orderFee(1_500, "DKK", DEFAULT_COST_CONFIG).amountEur).toBe(10);
    expect(orderFee(10_000, "SEK", DEFAULT_COST_CONFIG).amountEur).toBe(25);
    expect(orderFee(1_500, "EUR", DEFAULT_COST_CONFIG)).toEqual({ amountEur: 9, provenance: "SOURCED" });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects a notional of %d", (notional) => {
    expect(() => orderFee(notional, "EUR", DEFAULT_COST_CONFIG)).toThrow(/positive/);
  });
});

describe("fxFee", () => {
  it("is nothing for EUR names", () => {
    expect(fxFee(1_500, "EUR", DEFAULT_COST_CONFIG).amountEur).toBe(0);
  });

  it("is 0.25 % per conversion for SEK and DKK names, rounded to the cent", () => {
    expect(fxFee(1_500, "SEK", DEFAULT_COST_CONFIG)).toEqual({ amountEur: 3.75, provenance: "SOURCED" });
    expect(fxFee(1_234.56, "DKK", DEFAULT_COST_CONFIG).amountEur).toBe(3.09);
  });
});

describe("slippageBps", () => {
  it("is 10 bps from 5 M€ and 25 bps from 1 M€", () => {
    expect(slippageBps(5_000_000, DEFAULT_COST_CONFIG)).toBe(10);
    expect(slippageBps(80_000_000, DEFAULT_COST_CONFIG)).toBe(10);
    expect(slippageBps(4_999_999.99, DEFAULT_COST_CONFIG)).toBe(25);
    expect(slippageBps(1_000_000, DEFAULT_COST_CONFIG)).toBe(25);
  });

  it("throws below 1 M€, because such names are outside the universe", () => {
    expect(() => slippageBps(999_999.99, DEFAULT_COST_CONFIG)).toThrow(/outside the universe/);
    expect(() => roundTripCostPct(1_500, "EUR", 500_000, DEFAULT_COST_CONFIG)).toThrow(/outside the universe/);
  });

  it("throws on a missing or negative turnover", () => {
    expect(() => slippageBps(Number.NaN, DEFAULT_COST_CONFIG)).toThrow(/non-negative/);
    expect(() => slippageBps(-1, DEFAULT_COST_CONFIG)).toThrow(/non-negative/);
  });

  it("uses the 25 bps band in the round trip", () => {
    expect(roundTripCost(1_500, "EUR", MID, DEFAULT_COST_CONFIG).slippageEur).toBeCloseTo(7.5, 10);
  });
});

describe("roundCents", () => {
  it("rounds halves away from zero despite binary noise", () => {
    expect(roundCents(7.005)).toBe(7.01);
    expect(roundCents(1.005)).toBe(1.01);
    expect(roundCents(2.675)).toBe(2.68);
    expect(roundCents(-7.005)).toBe(-7.01);
    expect(roundCents(3.004)).toBe(3);
  });
});

describe("costConfigSchema", () => {
  it("accepts the defaults, which select Taso 4 (D1)", () => {
    expect(costConfigSchema.parse(DEFAULT_COST_CONFIG).tier).toBe("taso4");
  });

  it("rejects slippage bands that are not in descending order", () => {
    const bad = { ...DEFAULT_COST_CONFIG, slippageBands: [...DEFAULT_COST_CONFIG.slippageBands].reverse() };
    expect(costConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown tier", () => {
    expect(costConfigSchema.safeParse({ ...DEFAULT_COST_CONFIG, tier: "taso5" }).success).toBe(false);
  });
});
