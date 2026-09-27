import { z } from "zod";
import { compareWithBaseline, hitRateEstimate, NEWEY_WEST_LAGS, type Comparison, type Estimate } from "./inference.js";
import type { PredictionResult, Scored } from "./outcome.js";

// Pre-registered verdict (brief §16 as amended by A2 and A5; docs/PLAN.md §4). Pure. These figures are fixed
// before the scored month and must not change during it.

export const VERDICT_RULES = {
  /** The verdict reads the 5-day calls only. */
  horizon: 5,
  /** Pass: at least this many matured, decided calls (A2). Ties are neither hits nor misses and do not count. */
  minCalls: 200,
  /** Pass: 5-day hit rate at least this (A2, §16). */
  passHitRate: 0.6,
  /** Pass: the lower 95 % bound of the hit rate strictly above this (A2). */
  hitRateLowerBoundAbove: 0.5,
  /** Pass: the lower 95 % bound of model minus baseline strictly above this, for momentum and majority (A2, A3). */
  differenceLowerBoundAbove: 0,
  /** Pass: portfolio excess return not below −k standard errors (A5). */
  portfolioSeMultiple: 2,
  /** Stop: 5-day hit rate strictly below this (§16). */
  stopHitRate: 0.55,
  /**
   * Stop applies only with at least this many matured, decided 5-day calls (Vasco's choice, 2026-09-27), so an
   * outage or a short run cannot trigger it on a handful of calls. Below it, a low hit rate extends.
   */
  stopMinCalls: 100,
} as const;

const finite = z.number().refine(Number.isFinite, "must be finite");

const comparisonInput = z.object({
  modelHitRate: finite,
  baselineHitRate: finite,
  difference: finite,
  differenceLower: finite,
});

export const verdictInputSchema = z.object({
  fiveDay: z.object({
    /** Matured, decided 5-day calls (hits plus misses). */
    calls: z.number().int().nonnegative(),
    hitRate: z.number().min(0).max(1),
    lower: finite,
    upper: finite,
  }),
  momentum: comparisonInput,
  majority: comparisonInput,
  /** Portfolio net of trading costs minus the primary benchmark over the month, and its standard error (A5). */
  portfolio: z.object({ excessReturn: finite, se: z.number().positive() }),
});

export type VerdictInput = z.infer<typeof verdictInputSchema>;

export interface Condition {
  rule: string;
  passed: boolean;
  values: Record<string, number>;
}

export interface Verdict {
  verdict: "PASS" | "STOP" | "EXTEND";
  /** All must pass for PASS. */
  pass: Condition[];
  /** Passing this means STOP. */
  stop: Condition;
}

/** Applies the pre-registered rules to computed statistics. */
export function decideVerdict(raw: VerdictInput): Verdict {
  const input = verdictInputSchema.parse(raw);
  const r = VERDICT_RULES;
  const { fiveDay, portfolio } = input;

  const beats = (name: string, c: VerdictInput["momentum"]): Condition => ({
    rule: `hit rate above the ${name} baseline, and the lower 95 % bound of the difference > ${r.differenceLowerBoundAbove}`,
    passed: c.modelHitRate > c.baselineHitRate && c.differenceLower > r.differenceLowerBoundAbove,
    values: { ...c },
  });

  const pass: Condition[] = [
    { rule: `at least ${r.minCalls} matured 5-day calls`, passed: fiveDay.calls >= r.minCalls, values: { calls: fiveDay.calls } },
    { rule: `5-day hit rate ≥ ${r.passHitRate}`, passed: fiveDay.hitRate >= r.passHitRate, values: { hitRate: fiveDay.hitRate } },
    {
      rule: `lower 95 % bound of the 5-day hit rate > ${r.hitRateLowerBoundAbove}`,
      passed: fiveDay.lower > r.hitRateLowerBoundAbove,
      values: { lower: fiveDay.lower, upper: fiveDay.upper },
    },
    beats("momentum", input.momentum),
    beats("majority-direction", input.majority),
    {
      rule: `portfolio net of trading costs not below the benchmark by more than ${r.portfolioSeMultiple} standard errors`,
      passed: portfolio.excessReturn >= -r.portfolioSeMultiple * portfolio.se,
      values: { excessReturn: portfolio.excessReturn, se: portfolio.se, floor: -r.portfolioSeMultiple * portfolio.se },
    },
  ];
  const stop: Condition = {
    rule: `5-day hit rate < ${r.stopHitRate}, with at least ${r.stopMinCalls} matured 5-day calls`,
    passed: fiveDay.hitRate < r.stopHitRate && fiveDay.calls >= r.stopMinCalls,
    values: { hitRate: fiveDay.hitRate, calls: fiveDay.calls },
  };

  const verdict = pass.every((c) => c.passed) ? "PASS" : stop.passed ? "STOP" : "EXTEND";
  return { verdict, pass, stop };
}

export interface VerdictReport extends Verdict {
  hitRate: Estimate;
  momentum: Comparison;
  majority: Comparison;
  /** 5-day predictions excluded from scoring (ex-dates, A13). */
  excluded: number;
  ties: number;
}

/**
 * The verdict from the month's prediction results. Throws while any 5-day call is still pending, because the
 * verdict date is the day the last one matures (A4).
 */
export function verdictFromResults(
  results: readonly PredictionResult[],
  portfolio: VerdictInput["portfolio"],
  lags: number = NEWEY_WEST_LAGS,
): VerdictReport {
  const fiveDay = results.filter((r) => r.prediction.horizon === VERDICT_RULES.horizon);
  const pending = fiveDay.filter((r) => r.status === "PENDING").length;
  if (pending > 0) throw new Error(`${pending} 5-day calls have not matured; the verdict waits for them (A4)`);
  const scored = fiveDay.filter((r): r is Scored => r.status === "SCORED");
  const decided = scored.filter((s) => s.hit !== null);
  if (decided.length === 0) throw new Error("No matured, decided 5-day calls");

  const hitRate = hitRateEstimate(scored, lags);
  const momentum = compareWithBaseline(scored, "MOMENTUM", lags);
  const majority = compareWithBaseline(scored, "MAJORITY", lags);
  const asInput = (c: Comparison) => ({
    modelHitRate: c.modelHitRate,
    baselineHitRate: c.baselineHitRate,
    difference: c.difference.mean,
    differenceLower: c.difference.ci95.lower,
  });

  const verdict = decideVerdict({
    fiveDay: { calls: hitRate.n, hitRate: hitRate.mean, lower: hitRate.ci95.lower, upper: hitRate.ci95.upper },
    momentum: asInput(momentum),
    majority: asInput(majority),
    portfolio,
  });
  return {
    ...verdict,
    hitRate,
    momentum,
    majority,
    excluded: fiveDay.filter((r) => r.status === "EXCLUDED").length,
    ties: scored.length - decided.length,
  };
}
