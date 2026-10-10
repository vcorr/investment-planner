import type { Currency } from "../costs/config.js";
import type { FxRate } from "../sources/ecb.js";
import { compoundedMarketReturn, type MarketReturn } from "./market.js";
import type { SignalBar } from "./series.js";

// Per-share signals (brief §9, amendment A1). Pure functions over bars already cut at the as-of date: the last
// bar is the as-of bar. A signal without a full window is null with a reason, never a partial-window value.

/** Window lengths in trading days. Brief §9 and the M5 task file; the 250-day year is the task's definition. */
export const WINDOWS = {
  momentum: [20, 60, 120],
  high: 250,
  volumeBaseline: 60,
  volatility: 20,
  turnover: 60,
} as const;

/** ASSUMED convention: trading days per year for annualising daily volatility (√252). */
export const TRADING_DAYS_PER_YEAR = 252;

/**
 * ASSUMED guard: the oldest ECB rate, in calendar days, that may stand in for a day without one. ECB does not
 * publish on TARGET holidays (Good Friday to Easter Monday is 4 days) while a Nordic exchange may trade.
 * An older rate means a missing load, so it throws.
 */
export const MAX_FX_RATE_AGE_DAYS = 4;

export type NullReason = "INSUFFICIENT_HISTORY" | "MISSING_DATA" | "ZERO_DENOMINATOR";

export type Signal = { value: number; reason: null; detail: null } | { value: null; reason: NullReason; detail: string };

const ok = (value: number): Signal => ({ value, reason: null, detail: null });
const none = (reason: NullReason, detail: string): Signal => ({ value: null, reason, detail });

/** The last `count` bars, or the reason they are not available. */
function window(bars: readonly SignalBar[], count: number, what: string): SignalBar[] | Signal {
  if (bars.length < count) return none("INSUFFICIENT_HISTORY", `${what} needs ${count} bars, has ${bars.length}`);
  return bars.slice(bars.length - count);
}

/** Closes of the last `count` bars, or the reason they are not available. */
function closes(bars: readonly SignalBar[], count: number, what: string): number[] | Signal {
  const w = window(bars, count, what);
  if (!Array.isArray(w)) return w;
  const missing = w.find((b) => b.close === null);
  if (missing !== undefined) return none("MISSING_DATA", `${what}: no close on ${missing.tradeDate}`);
  return w.map((b) => b.close!);
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median of no values");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Sample standard deviation (n − 1 denominator). */
export function sampleStdDev(values: readonly number[]): number {
  if (values.length < 2) throw new Error("standard deviation needs at least two values");
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1));
}

// ---- Relative momentum -------------------------------------------------------------------------------------

export interface RelativeMomentum {
  days: number;
  /** Share return minus market return. */
  relative: Signal;
  shareReturn: number | null;
  marketReturn: number | null;
}

/**
 * The share's compounded close-to-close return over `days` trading days (its own bars, so `days + 1` closes)
 * minus the compounded return of its exchange's equal-weight series over the same dates.
 */
export function relativeMomentum(bars: readonly SignalBar[], market: readonly MarketReturn[], days: number): RelativeMomentum {
  const what = `${days}-day momentum`;
  const c = closes(bars, days + 1, what);
  if (!Array.isArray(c)) return { days, relative: c, shareReturn: null, marketReturn: null };
  const span = bars.slice(bars.length - days - 1);
  const shareReturn = c.at(-1)! / c[0]! - 1;
  const marketReturn = compoundedMarketReturn(
    market,
    span[0]!.tradeDate,
    span.at(-1)!.tradeDate,
    span.slice(1).map((b) => b.tradeDate),
  );
  return { days, relative: ok(shareReturn - marketReturn), shareReturn, marketReturn };
}

// ---- Level, volume and volatility --------------------------------------------------------------------------

/** Close ÷ highest close over the last 250 trading days (today included), minus 1. Zero or negative. */
export function distanceFromHigh(bars: readonly SignalBar[]): Signal {
  const c = closes(bars, WINDOWS.high, "Distance from the 52-week high");
  if (!Array.isArray(c)) return c;
  return ok(c.at(-1)! / Math.max(...c) - 1);
}

/** The day's volume ÷ the median volume of the previous 60 trading days (today excluded). */
export function volumeAnomaly(bars: readonly SignalBar[]): Signal {
  const what = "Volume anomaly";
  const w = window(bars, WINDOWS.volumeBaseline + 1, what);
  if (!Array.isArray(w)) return w;
  const missing = w.find((b) => b.volume === null);
  if (missing !== undefined) return none("MISSING_DATA", `${what}: no volume on ${missing.tradeDate}`);
  const baseline = median(w.slice(0, -1).map((b) => b.volume!));
  if (baseline === 0) return none("ZERO_DENOMINATOR", `${what}: the 60-day median volume is 0`);
  return ok(w.at(-1)!.volume! / baseline);
}

export interface RealisedVolatility {
  /** Sample standard deviation of the last 20 daily log returns (21 closes). */
  daily: Signal;
  /** daily × √252. */
  annualised: Signal;
  annualisation: "SQRT_252_ASSUMED";
}

export function realisedVolatility(bars: readonly SignalBar[]): RealisedVolatility {
  const c = closes(bars, WINDOWS.volatility + 1, "20-day realised volatility");
  if (!Array.isArray(c)) return { daily: c, annualised: c, annualisation: "SQRT_252_ASSUMED" };
  const logReturns = c.slice(1).map((close, i) => Math.log(close / c[i]!));
  const daily = sampleStdDev(logReturns);
  return { daily: ok(daily), annualised: ok(daily * Math.sqrt(TRADING_DAYS_PER_YEAR)), annualisation: "SQRT_252_ASSUMED" };
}

// ---- Turnover in EUR ---------------------------------------------------------------------------------------

export interface EurRate {
  unitsPerEur: number;
  /** The ECB date used; earlier than the trade date when that day had no rate. */
  rateDate: string;
  filled: boolean;
}

const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;

/**
 * ECB rate lookup for one currency: the rate of the day, or else the latest earlier one. EUR is exactly 1.
 * Throws if there is no earlier rate, or if it is older than MAX_FX_RATE_AGE_DAYS.
 */
export function eurRateLookup(currency: Currency, fxRates: readonly FxRate[]): (date: string) => EurRate {
  if (currency === "EUR") return () => ({ unitsPerEur: 1, rateDate: "", filled: false });
  const rates = fxRates.filter((r) => r.currency === currency).sort((a, b) => a.rateDate.localeCompare(b.rateDate));
  rates.forEach((r, i) => {
    if (!(Number.isFinite(r.unitsPerEur) && r.unitsPerEur > 0)) throw new Error(`ECB ${currency} ${r.rateDate}: bad rate ${r.unitsPerEur}`);
    if (i > 0 && rates[i - 1]!.rateDate === r.rateDate) throw new Error(`ECB ${currency} ${r.rateDate}: appears twice`);
  });
  return (date) => {
    let found: FxRate | undefined;
    for (const r of rates) {
      if (r.rateDate > date) break;
      found = r;
    }
    if (found === undefined) throw new Error(`No ECB ${currency} rate on or before ${date}`);
    const age = dayNumber(date) - dayNumber(found.rateDate);
    if (age > MAX_FX_RATE_AGE_DAYS) throw new Error(`The latest ECB ${currency} rate before ${date} is from ${found.rateDate}, ${age} days earlier`);
    return { unitsPerEur: found.unitsPerEur, rateDate: found.rateDate, filled: age > 0 };
  };
}

export interface MedianTurnover {
  /** Median of the last 60 daily turnovers (today included), each converted at its own day's ECB rate. */
  eur: Signal;
  /** Days in the window priced at an earlier day's ECB rate because their own day had none. */
  fxFilledDays: number;
}

/** Feeds the liquidity filter (≥ 1,000,000 €, brief §7.1) and the cost model's slippage bands. */
export function medianTurnoverEur(bars: readonly SignalBar[], rate: (date: string) => EurRate): MedianTurnover {
  const what = "60-day median turnover";
  const w = window(bars, WINDOWS.turnover, what);
  if (!Array.isArray(w)) return { eur: w, fxFilledDays: 0 };
  const missing = w.find((b) => b.turnover === null);
  if (missing !== undefined) return { eur: none("MISSING_DATA", `${what}: no turnover on ${missing.tradeDate}`), fxFilledDays: 0 };
  let fxFilledDays = 0;
  const eur = w.map((b) => {
    const r = rate(b.tradeDate);
    if (r.filled) fxFilledDays++;
    return b.turnover! / r.unitsPerEur;
  });
  return { eur: ok(median(eur)), fxFilledDays };
}
