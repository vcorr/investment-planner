import { z } from "zod";
import type { CostConfig, CostProvenance, Currency } from "../costs/config.js";
import { fxFee, orderFee, roundCents, slippageBps } from "../costs/costs.js";

// Fill simulator (brief §12.3, amendment A6). Pure: the calendar, bar, FX rate and cash arrive as inputs.
// Prices are in the share's local currency; money is in EUR. Missing data throws; nothing is guessed.

export const sizingRulesSchema = z.object({
  /** Smallest position allowed at entry, after whole-share rounding (brief §11, ASSUMED). */
  minPositionEur: z.number().positive(),
  /** Cash that must remain after an entry, fees included (brief §11, ASSUMED). */
  cashFloorEur: z.number().nonnegative(),
});

export type SizingRules = z.infer<typeof sizingRulesSchema>;

export const DEFAULT_SIZING_RULES: SizingRules = sizingRulesSchema.parse({ minPositionEur: 1_250, cashFloorEur: 250 });

export interface Bar {
  tradeDate: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
}

export interface MarketDay {
  /** The decision day, YYYY-MM-DD. */
  date: string;
  /** Trading days of the share's exchange. Must cover `date` and, ideally, the days after it. */
  openDates: ReadonlySet<string>;
  /** That day's bar; null only when the exchange is closed. */
  bar: Bar | null;
  /** ECB reference rate for `date`, in units of the local currency per 1 EUR; exactly 1 for EUR. */
  eurRate: number;
}

export type FillReason = "ENTRY" | "EXIT" | "STOP" | "TARGET";

export interface Fill {
  date: string;
  side: "BUY" | "SELL";
  reason: FillReason;
  currency: Currency;
  shares: number;
  /** Price before slippage: the open, or the stop or target level where that is worse for us. */
  rawPrice: number;
  fillPrice: number;
  eurRate: number;
  /** shares × fillPrice, in EUR. */
  grossEur: number;
  slippageEur: number;
  feeEur: number;
  fxFeeEur: number;
  /** Negative for a buy (gross plus costs), positive for a sale (gross less costs). Rounded to 0.01 €, as in a real account. */
  cashChangeEur: number;
  provenance: { fee: CostProvenance; fxFee: CostProvenance | null; slippage: "ASSUMED" };
}

export interface Queued {
  status: "QUEUED";
  date: string;
  /** First open day after `date` in the calendar given, or null if the calendar ends first. */
  nextOpenDate: string | null;
}

export type RejectionReason = "ZERO_SHARES" | "BELOW_MIN_POSITION" | "CASH_FLOOR";

export interface Rejected {
  status: "REJECTED";
  date: string;
  reason: RejectionReason;
  detail: string;
}

export interface EntryFilled {
  status: "FILLED";
  entry: Fill;
  /** The position opened, with its stop and target fixed from the actual open. */
  position: Position;
  /** A stop or target hit later on the entry day (A6), or null. */
  sameDayExit: Fill | null;
}

export interface ExitFilled {
  status: "FILLED";
  exit: Fill;
}

export interface NoFill {
  status: "NO_FILL";
  date: string;
}

export interface EntryOrder {
  currency: Currency;
  /** Position size to aim for, in EUR, before whole-share rounding. */
  sizeEur: number;
  /**
   * Stop and target as fractions of the entry day's official open (0.10 = 10 %), set by code (A1).
   * Fixing them from the actual open, not from an earlier close, keeps the stop below the entry price,
   * so a share that gaps down at the open is never bought and stopped out at the same price.
   */
  stopPct: number;
  targetPct: number;
  medianTurnoverEur: number;
}

export interface Position {
  currency: Currency;
  shares: number;
  stopPrice: number;
  targetPrice: number;
  medianTurnoverEur: number;
}

// ---- Checks -----------------------------------------------------------------------------------------------

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got ${value}`);
}

function assertLevels(stopPrice: number, targetPrice: number): void {
  assertPositive("Stop price", stopPrice);
  assertPositive("Target price", targetPrice);
  if (stopPrice >= targetPrice) throw new Error(`Stop ${stopPrice} must be below target ${targetPrice}`);
}

function assertRate(currency: Currency, eurRate: number): void {
  assertPositive(`${currency} rate`, eurRate);
  if (currency === "EUR" && eurRate !== 1) throw new Error(`EUR rate must be 1, got ${eurRate}`);
}

function nextOpenDate(date: string, openDates: ReadonlySet<string>): string | null {
  let next: string | null = null;
  for (const d of openDates) if (d > date && (next === null || d < next)) next = d;
  return next;
}

/** The bar to fill against, or a queue result if the exchange is closed. Throws on contradictory input. */
function tradingBar(day: MarketDay): Bar | Queued {
  if (!day.openDates.has(day.date)) {
    if (day.bar !== null) throw new Error(`${day.date}: the calendar says closed, but a bar was given`);
    return { status: "QUEUED", date: day.date, nextOpenDate: nextOpenDate(day.date, day.openDates) };
  }
  if (day.bar === null) throw new Error(`${day.date}: the exchange is open, but no bar was given`);
  // A fill may use only the decision day's own bar (brief §19 leakage test).
  if (day.bar.tradeDate !== day.date) throw new Error(`${day.date}: the bar is dated ${day.bar.tradeDate}`);
  return day.bar;
}

function requireOpen(bar: Bar): number {
  if (bar.open === null) throw new Error(`${bar.tradeDate}: no official open, so there is no fill price`);
  assertPositive(`${bar.tradeDate} open`, bar.open);
  return bar.open;
}

// ---- Fill arithmetic --------------------------------------------------------------------------------------

function makeFill(
  side: "BUY" | "SELL",
  reason: FillReason,
  shares: number,
  rawPrice: number,
  currency: Currency,
  medianTurnoverEur: number,
  day: MarketDay,
  config: CostConfig,
): Fill {
  const s = slippageBps(medianTurnoverEur, config) / 10_000;
  // Slippage is always adverse: buys pay more, sells receive less.
  const fillPrice = side === "BUY" ? rawPrice * (1 + s) : rawPrice * (1 - s);
  const grossEur = (shares * fillPrice) / day.eurRate;
  const slippageEur = (shares * Math.abs(fillPrice - rawPrice)) / day.eurRate;
  const fee = orderFee(grossEur, currency, config);
  const fx = fxFee(grossEur, currency, config);
  const costsEur = fee.amountEur + fx.amountEur;
  return {
    date: day.date,
    side,
    reason,
    currency,
    shares,
    rawPrice,
    fillPrice,
    eurRate: day.eurRate,
    grossEur,
    slippageEur,
    feeEur: fee.amountEur,
    fxFeeEur: fx.amountEur,
    cashChangeEur: roundCents(side === "BUY" ? -(grossEur + costsEur) : grossEur - costsEur),
    provenance: { fee: fee.provenance, fxFee: currency === "EUR" ? null : fx.provenance, slippage: "ASSUMED" },
  };
}

/**
 * Stop or target exit against one bar, or null. If both are touched, the stop is assumed to fill first.
 * Stop: min(open, stop) × (1 − s), so a gap down fills at the open. Target: max(open, target) × (1 − s).
 */
function stopOrTarget(position: Position, bar: Bar, day: MarketDay, config: CostConfig): Fill | null {
  const open = requireOpen(bar);
  if (bar.low === null || bar.high === null) throw new Error(`${bar.tradeDate}: low or high missing, so stops cannot be checked`);
  const sell = (reason: FillReason, raw: number) =>
    makeFill("SELL", reason, position.shares, raw, position.currency, position.medianTurnoverEur, day, config);
  if (bar.low <= position.stopPrice) return sell("STOP", Math.min(open, position.stopPrice));
  if (bar.high >= position.targetPrice) return sell("TARGET", Math.max(open, position.targetPrice));
  return null;
}

// ---- Public API -------------------------------------------------------------------------------------------

/**
 * Buys at the decision day's open with adverse slippage, in whole shares, then checks the stop and target on
 * the same bar (A6). Rejects, rather than shrinks, an entry that rounding pushes below the minimum position
 * or that would breach the cash floor.
 */
export function simulateEntry(
  order: EntryOrder,
  day: MarketDay,
  cashEur: number,
  config: CostConfig,
  rules: SizingRules,
): EntryFilled | Queued | Rejected {
  assertPositive("Position size", order.sizeEur);
  if (!(order.stopPct > 0 && order.stopPct < 1)) throw new Error(`Stop must be a fraction between 0 and 1, got ${order.stopPct}`);
  assertPositive("Target fraction", order.targetPct);
  assertRate(order.currency, day.eurRate);
  if (!Number.isFinite(cashEur)) throw new Error(`Cash must be a number, got ${cashEur}`);
  const bar = tradingBar(day);
  if ("status" in bar) return bar;

  const open = requireOpen(bar);
  const s = slippageBps(order.medianTurnoverEur, config) / 10_000;
  const shares = Math.floor((order.sizeEur * day.eurRate) / (open * (1 + s)));
  const reject = (reason: RejectionReason, detail: string): Rejected => ({ status: "REJECTED", date: day.date, reason, detail });
  if (shares < 1) return reject("ZERO_SHARES", `one share costs more than ${order.sizeEur} €`);

  const entry = makeFill("BUY", "ENTRY", shares, open, order.currency, order.medianTurnoverEur, day, config);
  // Limits are compared to the cent, so binary noise cannot reject an entry that lands exactly on one.
  if (roundCents(entry.grossEur) < rules.minPositionEur) {
    return reject("BELOW_MIN_POSITION", `${shares} shares make ${entry.grossEur.toFixed(2)} €, below ${rules.minPositionEur} €`);
  }
  const cashAfter = roundCents(cashEur + entry.cashChangeEur);
  if (cashAfter < rules.cashFloorEur) {
    return reject("CASH_FLOOR", `cash after entry would be ${cashAfter.toFixed(2)} €, below ${rules.cashFloorEur} €`);
  }
  const position: Position = {
    currency: order.currency,
    shares,
    stopPrice: open * (1 - order.stopPct),
    targetPrice: open * (1 + order.targetPct),
    medianTurnoverEur: order.medianTurnoverEur,
  };
  return { status: "FILLED", entry, position, sameDayExit: stopOrTarget(position, bar, day, config) };
}

/** Checks a held position's stop and target against the day's bar. */
export function simulateStopsAndTargets(position: Position, day: MarketDay, config: CostConfig): ExitFilled | NoFill | Queued {
  assertPosition(position);
  assertRate(position.currency, day.eurRate);
  const bar = tradingBar(day);
  if ("status" in bar) return bar;
  const exit = stopOrTarget(position, bar, day, config);
  return exit === null ? { status: "NO_FILL", date: day.date } : { status: "FILLED", exit };
}

/** Sells the whole position at the decision day's open with adverse slippage. */
export function simulateExit(position: Position, day: MarketDay, config: CostConfig): ExitFilled | Queued {
  assertPosition(position);
  assertRate(position.currency, day.eurRate);
  const bar = tradingBar(day);
  if ("status" in bar) return bar;
  const exit = makeFill("SELL", "EXIT", position.shares, requireOpen(bar), position.currency, position.medianTurnoverEur, day, config);
  return { status: "FILLED", exit };
}

function assertPosition(position: Position): void {
  if (!Number.isInteger(position.shares) || position.shares < 1) throw new Error(`Shares must be a positive whole number, got ${position.shares}`);
  assertLevels(position.stopPrice, position.targetPrice);
}
