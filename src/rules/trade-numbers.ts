import { feeSchedule, type CostConfig, type Currency } from "../costs/config.js";
import { fxFee, orderFee, roundCents, slippageBps } from "../costs/costs.js";
import type { TradeNumbersConfig } from "./config.js";

// Trade numbers set by code, not by Claude (A1). Pure functions. Percentages are in % (4.2 means 4.2 %),
// fractions are named as such (stopPct in `EntryOrder` is a fraction), and σ is the daily 20-day realised
// volatility of log returns as a fraction (0.02 = 2 % a day).

const BPS = 10_000;

export type Direction = "up" | "down";

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got ${value}`);
}

function assertHorizon(horizonDays: number): void {
  if (!Number.isInteger(horizonDays) || horizonDays < 1) throw new Error(`Horizon must be a whole number of days ≥ 1, got ${horizonDays}`);
}

function assertConfidence(confidence: number): void {
  if (!(confidence >= 0.5 && confidence <= 1)) throw new Error(`Confidence must be between 0.5 and 1, got ${confidence}`);
}

/** σ × √h: the volatility scaled to the horizon, as a fraction. */
export function horizonVolatility(sigmaDaily: number, horizonDays: number): number {
  assertPositive("Volatility", sigmaDaily);
  assertHorizon(horizonDays);
  return sigmaDaily * Math.sqrt(horizonDays);
}

/**
 * Expected move in %, signed: E = 100 × κ × (2p − 1) × σ × √h, where p is the probability of an up move,
 * i.e. the confidence for an "up" call and 1 − confidence for a "down" call (A1).
 */
export function expectedMovePct(
  direction: Direction,
  confidence: number,
  sigmaDaily: number,
  horizonDays: number,
  config: TradeNumbersConfig,
): number {
  assertConfidence(confidence);
  const pUp = direction === "up" ? confidence : 1 - confidence;
  return 100 * config.expectedMoveMultiplier * (2 * pUp - 1) * horizonVolatility(sigmaDaily, horizonDays);
}

export interface ExitLevels {
  /** Fraction below the entry-day open (0.1 = 10 %), for `EntryOrder.stopPct`. */
  stopPct: number;
  /** Fraction above the entry-day open, for `EntryOrder.targetPct`. */
  targetPct: number;
  /** Sessions the position may be held, the entry session included, before it is sold at the next open. */
  timeStopSessions: number;
}

/** Stop, target and time stop from σ and the horizon (A1): k × σ × √h, and ceil(k × h) sessions. */
export function exitLevels(sigmaDaily: number, horizonDays: number, config: TradeNumbersConfig): ExitLevels {
  const scaled = horizonVolatility(sigmaDaily, horizonDays);
  return {
    stopPct: config.stopMultiplier * scaled,
    targetPct: config.targetMultiplier * scaled,
    // The 12-digit step keeps 1.2 × 5 = 6.000000000000001 from becoming 7.
    timeStopSessions: Math.ceil(Number((config.timeStopMultiplier * horizonDays).toPrecision(12))),
  };
}

export interface EntryEstimate {
  shares: number;
  /** shares × price × (1 + slippage) ÷ rate, in EUR: what `simulateEntry` would book at that price. */
  notionalEur: number;
  /** Entry fee plus FX fee at that notional, in EUR (0 when no shares). */
  entryCostsEur: number;
}

/**
 * Whole-share estimate of an entry, mirroring `simulateEntry` but at a reference price known before the
 * open (the previous close). Used to test the hurdle on the size that will really be bought (M4 review).
 */
export function estimateEntry(
  sizeEur: number,
  priceLocal: number,
  eurRate: number,
  currency: Currency,
  medianTurnoverEur: number,
  costs: CostConfig,
): EntryEstimate {
  assertPositive("Size", sizeEur);
  assertPositive("Price", priceLocal);
  assertPositive("Rate", eurRate);
  const unit = (priceLocal * (1 + slippageBps(medianTurnoverEur, costs) / BPS)) / eurRate;
  const shares = Math.floor(sizeEur / unit);
  if (shares < 1) return { shares: 0, notionalEur: 0, entryCostsEur: 0 };
  const notionalEur = shares * unit;
  return { shares, notionalEur, entryCostsEur: orderFee(notionalEur, currency, costs).amountEur + fxFee(notionalEur, currency, costs).amountEur };
}

/**
 * Largest gross entry, in EUR, whose cost with the entry fee and FX fee fits in `availableEur`:
 * n + max(r × n, minimum) + f × n ≤ available. Returns 0 if not even the minimum fee fits.
 */
export function affordableGrossEur(availableEur: number, currency: Currency, costs: CostConfig): number {
  if (!Number.isFinite(availableEur)) throw new Error(`Available cash must be a number, got ${availableEur}`);
  const { rateBps, minimumEur } = costs.schedules[feeSchedule(currency)][costs.tier];
  const r = rateBps / BPS;
  const f = currency === "EUR" ? 0 : costs.fxFeeBps / BPS;
  const minimumBinds = (availableEur - minimumEur) / (1 + f);
  const gross = r * minimumBinds <= minimumEur ? minimumBinds : availableEur / (1 + r + f);
  return Math.max(0, gross);
}

export interface ExitEstimate {
  /** Market value at the reference price, before costs, in EUR. */
  valueEur: number;
  /** Slippage, fee and FX fee of selling the whole position, in EUR. */
  costEur: number;
  /** valueEur − costEur. */
  proceedsEur: number;
}

/** Estimated sale of a whole position at a reference price, mirroring `simulateExit`. */
export function estimateExit(
  shares: number,
  priceLocal: number,
  eurRate: number,
  currency: Currency,
  medianTurnoverEur: number,
  costs: CostConfig,
): ExitEstimate {
  if (!Number.isInteger(shares) || shares < 1) throw new Error(`Shares must be a positive whole number, got ${shares}`);
  assertPositive("Price", priceLocal);
  assertPositive("Rate", eurRate);
  const valueEur = (shares * priceLocal) / eurRate;
  const slippageEur = valueEur * (slippageBps(medianTurnoverEur, costs) / BPS);
  const grossEur = valueEur - slippageEur;
  const costEur = slippageEur + orderFee(grossEur, currency, costs).amountEur + fxFee(grossEur, currency, costs).amountEur;
  return { valueEur, costEur, proceedsEur: roundCents(valueEur - costEur) };
}

/**
 * Sessions held before the decision date: open days of the share's exchange from the entry date (included)
 * to the decision date (excluded). Throws if the entry date was not an open day.
 */
export function sessionsHeld(entryDate: string, decisionDate: string, openDates: ReadonlySet<string>): number {
  if (!openDates.has(entryDate)) throw new Error(`Entry date ${entryDate} is not an open day in the calendar given`);
  if (entryDate >= decisionDate) throw new Error(`Entry date ${entryDate} must be before the decision date ${decisionDate}`);
  let n = 0;
  for (const d of openDates) if (d >= entryDate && d < decisionDate) n += 1;
  return n;
}
