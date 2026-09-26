import type { Market } from "../sources/nasdaq.js";

/**
 * Development sample: ten widely held, liquid shares across the three exchanges and currencies.
 * Chosen by popularity only, ignoring the ethical screen, which does not exist yet (M2).
 * Replaced by the screened, liquidity-filtered universe once M2 is done.
 */
export const SAMPLE_SHARES: ReadonlyArray<{ market: Market; symbol: string }> = [
  { market: "HEL", symbol: "NOKIA" },
  { market: "HEL", symbol: "NDA FI" },
  { market: "HEL", symbol: "SAMPO" },
  { market: "HEL", symbol: "KNEBV" },
  { market: "STO", symbol: "ERIC B" },
  { market: "STO", symbol: "VOLV B" },
  { market: "STO", symbol: "HM B" },
  { market: "CPH", symbol: "NOVO B" },
  { market: "CPH", symbol: "VWS" },
  { market: "CPH", symbol: "DSV" },
];

/**
 * About 270 trading days before the build starts: enough for 250-day signals such as the 52-week high.
 * Kept out of the hashed settings, because it is a development parameter, not a rule of the experiment.
 */
export const BACKFILL_FROM = "2025-09-01";
