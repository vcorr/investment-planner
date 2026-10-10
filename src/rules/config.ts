import { z } from "zod";
import type { SizingRules } from "../sim/fills.js";

// Portfolio rules (brief §11) and the formulas that turn volatility and confidence into trade numbers (A1).
// Held here with defaults; they are not yet part of the versioned settings (A11). The hurdle multiplier
// lives in the cost config (`CostConfig.hurdleMultiplier`), so it is not repeated here.

export const tradeNumbersSchema = z.object({
  /**
   * κ in the expected move E = κ × (2c − 1) × σ × √h (A1). 1 is A1's formula as written. ASSUMED.
   * √(2/π) ≈ 0.80 would be the mean absolute move of a normal distribution; see the pull request.
   */
  expectedMoveMultiplier: z.number().positive(),
  /** Stop distance = this × σ × √h, as a fraction of the entry-day open. ASSUMED. */
  stopMultiplier: z.number().positive(),
  /** Target distance = this × σ × √h, as a fraction of the entry-day open. ASSUMED. */
  targetMultiplier: z.number().positive(),
  /** Time stop = ceil(this × h) trading sessions, the entry session included. ASSUMED. */
  timeStopMultiplier: z.number().positive(),
  /** A BUY whose stop would be wider than this is rejected rather than clamped. ASSUMED. */
  maxStopPct: z.number().gt(0).lt(1),
});

export const rulesConfigSchema = z
  .object({
    maxPositions: z.number().int().positive(),
    targetPositionEur: z.number().positive(),
    /** Smallest position allowed at entry, after whole-share rounding. */
    minPositionEur: z.number().positive(),
    maxPositionsPerSector: z.number().int().positive(),
    /** Cash that must remain after entries, fees included. */
    cashFloorEur: z.number().nonnegative(),
    maxNewPositionsPerDay: z.number().int().nonnegative(),
    /** Counted as entries in the calendar month of the decision date (see `evaluateRules`). */
    maxRoundTripsPerMonth: z.number().int().nonnegative(),
    tradeNumbers: tradeNumbersSchema,
  })
  .refine((c) => c.minPositionEur <= c.targetPositionEur, { message: "minPositionEur must not exceed targetPositionEur" });

export type RulesConfig = z.infer<typeof rulesConfigSchema>;
export type TradeNumbersConfig = z.infer<typeof tradeNumbersSchema>;

export const DEFAULT_RULES_CONFIG: RulesConfig = rulesConfigSchema.parse({
  // Brief §11: all ASSUMED defaults.
  maxPositions: 3,
  targetPositionEur: 1_500,
  minPositionEur: 1_250,
  maxPositionsPerSector: 2,
  cashFloorEur: 250,
  maxNewPositionsPerDay: 1,
  maxRoundTripsPerMonth: 8,
  // A1 fixes only the shape; every multiplier here is ASSUMED and awaits Vasco's choice.
  tradeNumbers: {
    expectedMoveMultiplier: 1,
    stopMultiplier: 2,
    targetMultiplier: 3,
    timeStopMultiplier: 1,
    maxStopPct: 0.5,
  },
});

/** The minimum-position and cash-floor rules in the form `simulateEntry` takes, so both use the same figures. */
export function sizingRulesFrom(config: RulesConfig): SizingRules {
  return { minPositionEur: config.minPositionEur, cashFloorEur: config.cashFloorEur };
}
