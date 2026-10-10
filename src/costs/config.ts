import { z } from "zod";

// Cost model inputs (brief §12, decisions D1, A8, A9). Held here with defaults until they move into the
// versioned settings (amendment A11). Rates are in basis points: 20 bps = 0.20 %.

export type Currency = "EUR" | "SEK" | "DKK";
/** Provenance of a cost component, as reported beside every simulated fill. */
export type CostProvenance = "SOURCED" | "ASSUMED";

export const TIERS = ["taso1", "taso2", "taso3", "taso4"] as const;
export type Tier = (typeof TIERS)[number];

const tierFeeSchema = z.object({
  rateBps: z.number().positive(),
  minimumEur: z.number().nonnegative(),
});

const tierScheduleSchema = z.object({ taso1: tierFeeSchema, taso2: tierFeeSchema, taso3: tierFeeSchema, taso4: tierFeeSchema });

/** "helsinki" for EUR names on Nasdaq Helsinki; "nordic" for SEK and DKK names (Nordnet's "Ruotsi, Norja ja Tanska" row). */
export type FeeSchedule = "helsinki" | "nordic";

const slippageBandSchema = z.object({
  /** The band applies when the 60-day median daily turnover is at least this much. */
  minTurnoverEur: z.number().positive(),
  bps: z.number().nonnegative(),
});

export const costConfigSchema = z.object({
  schedules: z.object({ helsinki: tierScheduleSchema, nordic: tierScheduleSchema }),
  tier: z.enum(TIERS),
  fxFeeBps: z.number().nonnegative(),
  /** Highest threshold first. Turnover below the last band is outside the universe and throws. */
  slippageBands: z
    .array(slippageBandSchema)
    .min(1)
    .refine((bands) => bands.every((b, i) => i === 0 || b.minTurnoverEur < bands[i - 1]!.minTurnoverEur), {
      message: "slippage bands must be ordered by strictly descending minTurnoverEur",
    }),
  /** A BUY needs an expected move of at least this multiple of the round-trip cost (brief §11). */
  hurdleMultiplier: z.number().positive(),
});

export type CostConfig = z.infer<typeof costConfigSchema>;
export type TierFee = z.infer<typeof tierFeeSchema>;

export const DEFAULT_COST_CONFIG: CostConfig = costConfigSchema.parse({
  // SOURCED: https://www.nordnet.fi/palvelut/hinnasto. Helsinki accessed 2026-09-26 (V1); Sweden, Norway and
  // Denmark accessed 2026-09-27 (V2), where the minimum is stated in euros for every tier.
  schedules: {
    helsinki: {
      taso1: { rateBps: 6, minimumEur: 3 },
      taso2: { rateBps: 10, minimumEur: 5 },
      taso3: { rateBps: 15, minimumEur: 7 },
      taso4: { rateBps: 20, minimumEur: 9 },
    },
    nordic: {
      taso1: { rateBps: 8, minimumEur: 10 },
      taso2: { rateBps: 12, minimumEur: 10 },
      taso3: { rateBps: 18, minimumEur: 10 },
      taso4: { rateBps: 25, minimumEur: 10 },
    },
  },
  tier: "taso4", // D1: fixed for the whole simulation.
  // SOURCED: https://www.nordnet.fi/koulu/valuutanvaihto, accessed 2026-09-26 (V3, A9). Automatic conversion.
  fxFeeBps: 25,
  // ASSUMED placeholders (brief §12.2), to be calibrated later.
  slippageBands: [
    { minTurnoverEur: 5_000_000, bps: 10 },
    { minTurnoverEur: 1_000_000, bps: 25 },
  ],
  hurdleMultiplier: 2, // Brief §11 said 3; lowered to 2 by Vasco on 2026-09-27 (D13).
});

/** The fee schedule that applies to a share, by its trading currency. */
export function feeSchedule(currency: Currency): FeeSchedule {
  return currency === "EUR" ? "helsinki" : "nordic";
}
