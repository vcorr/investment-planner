import { feeSchedule, type CostConfig, type CostProvenance, type Currency, type FeeSchedule, type Tier } from "./config.js";

// Pure cost functions (brief §12). Amounts are in EUR unless a name says otherwise.

const BPS = 10_000;

export interface CostAmount {
  amountEur: number;
  provenance: CostProvenance;
}

/**
 * Rounds money to 0.01 €, half away from zero. ASSUMED: Nordnet's own rounding rule is not published.
 * The 12-significant-digit step removes binary noise first, so 7.005 (stored as 7.00499…) becomes 7.01.
 */
export function roundCents(eur: number): number {
  const cents = Number((eur * 100).toPrecision(12));
  return (Math.sign(cents) * Math.round(Math.abs(cents))) / 100;
}

function assertNotional(notionalEur: number): void {
  if (!Number.isFinite(notionalEur) || notionalEur <= 0) throw new Error(`Notional must be a positive number of euros, got ${notionalEur}`);
}

/**
 * Brokerage fee for one executed order: max(rate × notional, minimum), at the configured tier, on the schedule
 * for the share's market. Nordnet states the Swedish and Danish minimum in euros, so the fee is taken to be
 * charged in euros and pays no FX fee itself (V2).
 */
export function orderFee(notionalEur: number, currency: Currency, config: CostConfig): CostAmount {
  assertNotional(notionalEur);
  const { rateBps, minimumEur } = config.schedules[feeSchedule(currency)][config.tier];
  return {
    amountEur: roundCents(Math.max((rateBps / BPS) * notionalEur, minimumEur)),
    provenance: "SOURCED",
  };
}

/** FX conversion fee for one conversion; nothing for EUR names. */
export function fxFee(notionalEur: number, currency: Currency, config: CostConfig): CostAmount {
  assertNotional(notionalEur);
  if (currency === "EUR") return { amountEur: 0, provenance: "SOURCED" };
  return { amountEur: roundCents((config.fxFeeBps / BPS) * notionalEur), provenance: "SOURCED" };
}

/** Slippage per side, in bps, from the 60-day median daily turnover. Throws below the lowest band. */
export function slippageBps(medianTurnoverEur: number, config: CostConfig): number {
  if (!Number.isFinite(medianTurnoverEur) || medianTurnoverEur < 0) {
    throw new Error(`Median turnover must be a non-negative number of euros, got ${medianTurnoverEur}`);
  }
  const band = config.slippageBands.find((b) => medianTurnoverEur >= b.minTurnoverEur);
  if (band === undefined) {
    const floor = config.slippageBands.at(-1)!.minTurnoverEur;
    throw new Error(`Median turnover ${medianTurnoverEur} € is below ${floor} €, so the name is outside the universe`);
  }
  return band.bps;
}

/** Notional at which the percentage fee equals the minimum; below it the minimum binds. */
export function minimumBindingNotionalEur(tier: Tier, config: CostConfig, schedule: FeeSchedule = "helsinki"): number {
  const { rateBps, minimumEur } = config.schedules[schedule][tier];
  return minimumEur / (rateBps / BPS);
}

export interface RoundTripCost {
  feesEur: number;
  fxFeesEur: number;
  slippageEur: number;
  totalEur: number;
  pct: number;
  provenance: { fee: CostProvenance; fxFee: CostProvenance | null; slippage: "ASSUMED" };
}

/**
 * Estimated cost of buying and later selling `notionalEur`: fees, FX and slippage on both sides.
 * The exit is costed at the entry notional, since the exit price is unknown when the hurdle is tested.
 */
export function roundTripCost(notionalEur: number, currency: Currency, medianTurnoverEur: number, config: CostConfig): RoundTripCost {
  const fee = orderFee(notionalEur, currency, config);
  const fx = fxFee(notionalEur, currency, config);
  const feesEur = 2 * fee.amountEur;
  const fxFeesEur = 2 * fx.amountEur;
  const slippageEur = 2 * (slippageBps(medianTurnoverEur, config) / BPS) * notionalEur;
  const totalEur = feesEur + fxFeesEur + slippageEur;
  return {
    feesEur,
    fxFeesEur,
    slippageEur,
    totalEur,
    pct: (totalEur / notionalEur) * 100,
    provenance: { fee: fee.provenance, fxFee: currency === "EUR" ? null : fx.provenance, slippage: "ASSUMED" },
  };
}

export function roundTripCostPct(notionalEur: number, currency: Currency, medianTurnoverEur: number, config: CostConfig): number {
  return roundTripCost(notionalEur, currency, medianTurnoverEur, config).pct;
}

/** Minimum expected move, in %, for a BUY to be admissible (brief §11). */
export function hurdlePct(notionalEur: number, currency: Currency, medianTurnoverEur: number, config: CostConfig): number {
  return config.hurdleMultiplier * roundTripCostPct(notionalEur, currency, medianTurnoverEur, config);
}
