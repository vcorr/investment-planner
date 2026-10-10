import type { Direction, Horizon, Relation, Scored } from "./outcome.js";

// Metrics over any set of scored predictions (brief §13; amendment A3). Pure. Ties are counted apart and
// are neither hits nor misses. Every function sorts its input first, so the order of predictions never
// changes a result, not even in the last bit of a floating-point sum.

/** Calibration buckets by confidence: [0.50, 0.60), …, [0.80, 0.90), and [0.90, 1.00] closed. */
export const CALIBRATION_BUCKETS = [
  { lower: 0.5, upper: 0.6 },
  { lower: 0.6, upper: 0.7 },
  { lower: 0.7, upper: 0.8 },
  { lower: 0.8, upper: 0.9 },
  { lower: 0.9, upper: 1.0 },
] as const;

export interface CalibrationBucket {
  lower: number;
  upper: number;
  /** Hits plus misses. */
  n: number;
  hits: number;
  ties: number;
  /** null when the bucket has no hits or misses. */
  hitRate: number | null;
  meanConfidence: number | null;
}

export interface HitStats {
  /** Every scored prediction, ties included. */
  calls: number;
  hits: number;
  misses: number;
  ties: number;
  /** hits ÷ (hits + misses); null when there are none. */
  hitRate: number | null;
  /** Mean of (p − y)², with p the stated probability of "up" and y = 1 for an up outcome; ties excluded. */
  brier: number | null;
  calibration: CalibrationBucket[];
}

/** Canonical order: decision day, share, horizon, id. */
export function canonical<T extends { prediction: Scored["prediction"] }>(items: readonly T[]): T[] {
  const key = (x: T) => x.prediction;
  return [...items].sort((a, b) => {
    const p = key(a);
    const q = key(b);
    if (p.decisionDate !== q.decisionDate) return p.decisionDate < q.decisionDate ? -1 : 1;
    if (p.orderbookId !== q.orderbookId) return p.orderbookId < q.orderbookId ? -1 : 1;
    if (p.horizon !== q.horizon) return p.horizon - q.horizon;
    return p.id < q.id ? -1 : p.id > q.id ? 1 : 0;
  });
}

/** Brier term for one decided call: (1 − c)² on a hit, c² on a miss. */
function brierTerm(confidence: number, hit: boolean): number {
  return hit ? (1 - confidence) ** 2 : confidence ** 2;
}

export function hitStats(input: readonly Scored[]): HitStats {
  const scored = canonical(input);
  let hits = 0;
  let misses = 0;
  let brierSum = 0;
  const buckets = CALIBRATION_BUCKETS.map((b) => ({ ...b, n: 0, hits: 0, ties: 0, confidenceSum: 0 }));

  for (const s of scored) {
    const c = s.prediction.confidence;
    const bucket = buckets.find((b, i) => c >= b.lower && (c < b.upper || i === buckets.length - 1));
    if (bucket === undefined) throw new Error(`${s.prediction.id}: confidence ${c} is outside [0.5, 1]`);
    if (s.hit === null) {
      bucket.ties++;
      continue;
    }
    if (s.hit) hits++;
    else misses++;
    brierSum += brierTerm(c, s.hit);
    bucket.n++;
    if (s.hit) bucket.hits++;
    bucket.confidenceSum += c;
  }

  const decided = hits + misses;
  return {
    calls: scored.length,
    hits,
    misses,
    ties: scored.length - decided,
    hitRate: decided === 0 ? null : hits / decided,
    brier: decided === 0 ? null : brierSum / decided,
    calibration: buckets.map(({ confidenceSum, ...b }) => ({
      ...b,
      hitRate: b.n === 0 ? null : b.hits / b.n,
      meanConfidence: b.n === 0 ? null : confidenceSum / b.n,
    })),
  };
}

// ---- Filters and breakdowns ---------------------------------------------------------------------------------

export interface ScoreFilter {
  horizon?: Horizon;
  /** Keeps predictions whose basis includes this event type. */
  eventType?: string;
  /** "NONE" keeps predictions without news. */
  relation?: Relation | "NONE";
  hasNews?: boolean;
}

export function filterScored(scored: readonly Scored[], filter: ScoreFilter): Scored[] {
  return scored.filter(({ prediction: p }) => {
    if (filter.horizon !== undefined && p.horizon !== filter.horizon) return false;
    if (filter.eventType !== undefined && !p.eventTypes.includes(filter.eventType)) return false;
    if (filter.relation !== undefined && (p.relation ?? "NONE") !== filter.relation) return false;
    if (filter.hasNews !== undefined && p.hasNews !== filter.hasNews) return false;
    return true;
  });
}

export type Dimension = "horizon" | "eventType" | "relation" | "news";

/** Keys a prediction falls under. A call resting on several event types counts under each of them. */
function keysOf(s: Scored, dimension: Dimension): string[] {
  const p = s.prediction;
  switch (dimension) {
    case "horizon":
      return [String(p.horizon)];
    case "eventType":
      return p.eventTypes.length === 0 ? ["NONE"] : [...new Set(p.eventTypes)];
    case "relation":
      return [p.relation ?? "NONE"];
    case "news":
      return [p.hasNews ? "NEWS" : "NO_NEWS"];
  }
}

/** Hit statistics per key of one dimension, sorted by key. */
export function breakdown(scored: readonly Scored[], dimension: Dimension): { key: string; stats: HitStats }[] {
  const groups = new Map<string, Scored[]>();
  for (const s of scored) for (const k of keysOf(s, dimension)) groups.set(k, [...(groups.get(k) ?? []), s]);
  return [...groups.keys()].sort().map((key) => ({ key, stats: hitStats(groups.get(key)!) }));
}

// ---- Baselines ----------------------------------------------------------------------------------------------

export type BaselineKind = "COIN_FLIP" | "MOMENTUM" | "REVERSAL" | "MAJORITY";
export const BASELINES: readonly BaselineKind[] = ["COIN_FLIP", "MOMENTUM", "REVERSAL", "MAJORITY"];

/**
 * A3: the direction that turned out more common among the decided outcomes of each horizon in this set.
 * On an exact tie of counts it is "UP"; the hit rate is 50 % either way. null for a horizon with no outcomes.
 */
export function majorityDirections(scored: readonly Scored[]): Map<Horizon, Direction | null> {
  const counts = new Map<Horizon, { up: number; down: number }>();
  for (const s of scored) {
    const c = counts.get(s.prediction.horizon) ?? { up: 0, down: 0 };
    if (s.outcome === "UP") c.up++;
    if (s.outcome === "DOWN") c.down++;
    counts.set(s.prediction.horizon, c);
  }
  const result = new Map<Horizon, Direction | null>();
  for (const [h, c] of counts) result.set(h, c.up + c.down === 0 ? null : c.up >= c.down ? "UP" : "DOWN");
  return result;
}

/**
 * The baseline's score on each prediction of the set: 1 for a hit, 0 for a miss, 0.5 for the analytic coin
 * flip, and null where the outcome is a tie or the baseline makes no call (a signal of exactly zero).
 */
export function baselineScores(scored: readonly Scored[], kind: BaselineKind): (number | null)[] {
  const majority = kind === "MAJORITY" ? majorityDirections(scored) : null;
  return scored.map((s) => {
    if (s.outcome === "TIE") return null;
    let call: Direction | null;
    switch (kind) {
      case "COIN_FLIP":
        return 0.5;
      case "MOMENTUM":
        call = s.baselines.momentum;
        break;
      case "REVERSAL":
        call = s.baselines.reversal;
        break;
      case "MAJORITY":
        call = majority!.get(s.prediction.horizon) ?? null;
        break;
    }
    return call === null ? null : call === s.outcome ? 1 : 0;
  });
}

export interface BaselineStats {
  kind: BaselineKind;
  /** Decided outcomes on which the baseline made a call. */
  n: number;
  /** Decided outcomes on which it made none. */
  noCall: number;
  /** Expected hits for the coin flip (n ÷ 2). */
  hits: number;
  hitRate: number | null;
}

export function baselineStats(scored: readonly Scored[], kind: BaselineKind): BaselineStats {
  const scores = baselineScores(canonical(scored), kind);
  const decided = scored.filter((s) => s.outcome !== "TIE").length;
  const called = scores.filter((x): x is number => x !== null);
  const hits = called.reduce((a, b) => a + b, 0);
  return { kind, n: called.length, noCall: decided - called.length, hits, hitRate: called.length === 0 ? null : hits / called.length };
}
