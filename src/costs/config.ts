import { z } from "zod";

// Cost model inputs (brief §12, decisions D1, A8, A9). Held here with defaults until they move into the
// versioned settings (amendment A11). Rates are in basis points: 20 bps = 0.20 %.

export type Currency = "EUR" | "SEK" | "DKK";
/** Provenance of a cost component, as reported beside every simulated fill. */
export type CostProvenance = "SOURCED" | "ASSUMED" | "UNVERIFIED_FEE";

export const TIERS = ["taso1", "taso2", "taso3", "taso4"] as const;
export type Tier = (typeof TIERS)[number];

const tierFeeSchema = z.object({
  rateBps: z.number().positive(),
  minimumEur: z.number().nonnegative(),
});

const slippageBandSchema = z.object({
  /** The band applies when the 60-day median daily turnover is at least this much. */
  minTurnoverEur: z.number().positive(),
  bps: z.number().nonnegative(),
});

export const costConfigSchema = z.object({
  tiers: z.object({ taso1: tierFeeSchema, taso2: tierFeeSchema, taso3: tierFeeSchema, taso4: tierFeeSchema }),
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
  // SOURCED: https://www.nordnet.fi/palvelut/hinnasto, accessed 2026-09-26 (verification V1). Helsinki schedule;
  // Stockholm and Copenhagen use it too until V2 is resolved, tagged UNVERIFIED_FEE.
  tiers: {
    taso1: { rateBps: 6, minimumEur: 3 },
    taso2: { rateBps: 10, minimumEur: 5 },
    taso3: { rateBps: 15, minimumEur: 7 },
    taso4: { rateBps: 20, minimumEur: 9 },
  },
  tier: "taso4", // D1: fixed for the whole simulation.
  // SOURCED: https://www.nordnet.fi/koulu/valuutanvaihto, accessed 2026-09-26 (V3, A9). Automatic conversion.
  fxFeeBps: 25,
  // ASSUMED placeholders (brief §12.2), to be calibrated later.
  slippageBands: [
    { minTurnoverEur: 5_000_000, bps: 10 },
    { minTurnoverEur: 1_000_000, bps: 25 },
  ],
  hurdleMultiplier: 3, // Brief §11.
});

/** Fees on the Helsinki schedule are sourced; Stockholm and Copenhagen reuse it unverified (V2). */
export function feeProvenance(currency: Currency): CostProvenance {
  return currency === "EUR" ? "SOURCED" : "UNVERIFIED_FEE";
}
