import { baselineScores, canonical, type BaselineKind } from "./metrics.js";
import type { Scored } from "./outcome.js";

// Overlap-robust inference (amendment A2; brief §13 correlation caveat). Pure.
//
// Calls made on the same day share the market, and 5-day windows overlap, so calls are not independent.
// Scores are summed within each decision day (clustering by day) and the day sums get a Newey–West
// long-run variance with Bartlett weights over 4 lags. When every day has the same number of calls, this is
// exactly Newey–West on the series of daily mean hits; with unequal days it weights each call equally, so the
// interval is centred on the pooled hit rate that the ≥ 60 % rule reads.

/** A2: lags for the Newey–West estimator (5-day windows overlap on up to 4 later days). */
export const NEWEY_WEST_LAGS = 4;

/** 97.5 % quantile of the standard normal, for two-sided 95 % intervals (COMPUTED, Φ⁻¹(0.975)). */
export const Z_95 = 1.959963984540054;

/** Bartlett weight for lag l of L. */
function bartlett(lag: number, lags: number): number {
  return 1 - lag / (lags + 1);
}

function assertLags(lags: number): void {
  if (!Number.isInteger(lags) || lags < 0) throw new Error(`Lags must be a non-negative integer, got ${lags}`);
}

/**
 * Newey–West variance of the mean of a time series: (γ₀ + 2 Σₗ wₗ γₗ) ÷ T, with γₗ = (1/T) Σₜ (xₜ − x̄)(xₜ₋ₗ − x̄)
 * and Bartlett weights wₗ = 1 − l/(L+1). No small-sample correction.
 */
export function neweyWestVarianceOfMean(series: readonly number[], lags: number = NEWEY_WEST_LAGS): number {
  assertLags(lags);
  const T = series.length;
  if (T === 0) throw new Error("Newey–West needs at least one observation");
  const m = series.reduce((a, b) => a + b, 0) / T;
  const dev = series.map((x) => x - m);
  let s = 0;
  for (let l = 0; l <= Math.min(lags, T - 1); l++) {
    let gamma = 0;
    for (let t = l; t < T; t++) gamma += dev[t]! * dev[t - l]!;
    gamma /= T;
    s += l === 0 ? gamma : 2 * bartlett(l, lags) * gamma;
  }
  return s / T;
}

export interface Observation {
  /** Decision day, YYYY-MM-DD: the cluster. */
  date: string;
  value: number;
}

export interface Estimate {
  /** Observations (calls). */
  n: number;
  /** Decision days with at least one observation. */
  days: number;
  mean: number;
  variance: number;
  se: number;
  ci95: { lower: number; upper: number };
  /**
   * The number of independent observations that would give the same variance:
   * n × (variance if independent) ÷ (robust variance). null when the robust variance is zero.
   */
  effectiveN: number | null;
}

/**
 * Mean of observations clustered by decision day, with a Newey–West variance over the day sums:
 * Var = (1/n²) [Σₜ uₜ² + 2 Σₗ wₗ Σₜ uₜ uₜ₋ₗ], where uₜ = Σ over day t of (value − mean). Lags count decision days
 * that have observations, in date order.
 */
export function clusteredMean(observations: readonly Observation[], lags: number = NEWEY_WEST_LAGS): Estimate {
  assertLags(lags);
  const n = observations.length;
  if (n === 0) throw new Error("No observations to estimate from");
  // Sorted, so the input order cannot change a floating-point sum.
  const sorted = [...observations].sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.value - b.value));
  const byDay = new Map<string, { sum: number; count: number }>();
  for (const o of sorted) {
    if (!Number.isFinite(o.value)) throw new Error(`${o.date}: value is not finite`);
    const d = byDay.get(o.date) ?? { sum: 0, count: 0 };
    d.sum += o.value;
    d.count++;
    byDay.set(o.date, d);
  }
  const days = [...byDay.keys()].sort().map((k) => byDay.get(k)!);
  const total = days.reduce((a, d) => a + d.sum, 0);
  const mean = total / n;
  const u = days.map((d) => d.sum - d.count * mean);

  let s = 0;
  for (let l = 0; l <= Math.min(lags, u.length - 1); l++) {
    let c = 0;
    for (let t = l; t < u.length; t++) c += u[t]! * u[t - l]!;
    s += l === 0 ? c : 2 * bartlett(l, lags) * c;
  }
  // Bartlett weights keep s ≥ 0 in exact arithmetic; clear rounding noise around zero.
  const variance = Math.max(0, s) / n ** 2;
  const se = Math.sqrt(variance);

  const naiveVariance = sorted.reduce((a, o) => a + (o.value - mean) ** 2, 0) / n / n;
  return {
    n,
    days: days.length,
    mean,
    variance,
    se,
    ci95: { lower: mean - Z_95 * se, upper: mean + Z_95 * se },
    effectiveN: variance === 0 ? null : (n * naiveVariance) / variance,
  };
}

/** Hit rate over the decided calls of a set (ties dropped), with its overlap-robust interval. */
export function hitRateEstimate(scored: readonly Scored[], lags: number = NEWEY_WEST_LAGS): Estimate {
  const observations = canonical(scored)
    .filter((s) => s.hit !== null)
    .map((s) => ({ date: s.prediction.decisionDate, value: s.hit ? 1 : 0 }));
  return clusteredMean(observations, lags);
}

export interface Comparison {
  baseline: BaselineKind;
  /** Paired calls: decided outcomes on which the baseline made a call. */
  n: number;
  modelHitRate: number;
  baselineHitRate: number;
  /** Model minus baseline on the paired calls, with its interval from the paired daily differences. */
  difference: Estimate;
}

/** Model against a baseline on the same share-days: per call, model score minus baseline score. */
export function compareWithBaseline(scored: readonly Scored[], baseline: BaselineKind, lags: number = NEWEY_WEST_LAGS): Comparison {
  const ordered = canonical(scored);
  const base = baselineScores(ordered, baseline);
  const pairs: { date: string; model: number; base: number }[] = [];
  ordered.forEach((s, i) => {
    const b = base[i];
    if (s.hit === null || b === null || b === undefined) return;
    pairs.push({ date: s.prediction.decisionDate, model: s.hit ? 1 : 0, base: b });
  });
  if (pairs.length === 0) throw new Error(`No paired calls against the ${baseline} baseline`);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    baseline,
    n: pairs.length,
    modelHitRate: sum(pairs.map((p) => p.model)) / pairs.length,
    baselineHitRate: sum(pairs.map((p) => p.base)) / pairs.length,
    difference: clusteredMean(
      pairs.map((p) => ({ date: p.date, value: p.model - p.base })),
      lags,
    ),
  };
}
