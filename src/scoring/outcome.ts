import { z } from "zod";

// Outcome of one prediction (brief §13, §10.2; amendments A3, A4, A13). Pure: the bars, the exchange's
// trading days and the as-of date arrive as inputs. Missing or contradictory data throws; nothing is guessed.

/**
 * Horizon convention. Brief §13: "from the decision-day open to the close at horizon h".
 * true: h = 1 ends at the close of the decision day itself, so a call at horizon h covers the h sessions
 * D, D+1, …, D+h−1. false would end h = 1 at the next trading day's close (h + 1 sessions).
 * Open question for Vasco; change it only before the scored month.
 */
export const H1_ENDS_AT_DECISION_DAY_CLOSE = true;

/** Momentum baseline look-back in trading days (brief §13(b): "the 20-day market-adjusted return"). */
export const MOMENTUM_DAYS = 20;

/**
 * A market-adjusted return closer to zero than this is a tie. Compounding in floating point leaves noise of
 * about 1e-16 where the true value is exactly zero (a share that moves with the market); a real move is far
 * larger: one tick of 0.0001 on a price of 1,000 is 1e-7 (COMPUTED).
 */
export const TIE_TOLERANCE = 1e-12;

export const HORIZONS = [1, 5] as const;
export type Horizon = (typeof HORIZONS)[number];
export type Direction = "UP" | "DOWN";
export type Outcome = Direction | "TIE";
export type Relation = "DIRECT" | "SPILLOVER";

/** Trading days after the decision day at whose close horizon h ends. */
export function horizonEndOffset(horizon: Horizon): number {
  return H1_ENDS_AT_DECISION_DAY_CLOSE ? horizon - 1 : horizon;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const predictionSchema = z
  .object({
    id: z.string().min(1),
    /** Decision day D: the day the call is made, before the open. */
    decisionDate: isoDate,
    orderbookId: z.string().min(1),
    horizon: z.union([z.literal(1), z.literal(5)]),
    /** Sign of the market-adjusted return the model expects (brief §10.2). */
    direction: z.enum(["UP", "DOWN"]),
    confidence: z.number().min(0.5).max(1),
    /** Event types of the basis events; a call may rest on several. Empty for a no-news call. */
    eventTypes: z.array(z.string().min(1)),
    /** Whether the basis news is about the company itself or spills over from a peer; null without news. */
    relation: z.enum(["DIRECT", "SPILLOVER"]).nullable(),
    hasNews: z.boolean(),
  })
  .refine((p) => p.hasNews || (p.eventTypes.length === 0 && p.relation === null), {
    message: "a no-news prediction cannot carry event types or a relation",
  });

export type Prediction = z.infer<typeof predictionSchema>;

/** The fields of a daily bar that scoring uses; `DailyBar` from `src/sources/nasdaq.ts` fits. */
export interface PriceBar {
  tradeDate: string;
  open: number | null;
  close: number | null;
}

export interface ExchangeData {
  /** Every trading day of the exchange, ascending, covering the look-back and the horizons being scored. */
  tradingDays: readonly string[];
  /** Orderbook IDs of the same-exchange equal-weight universe. */
  universe: readonly string[];
  /** Bars per orderbook ID, for the universe and every predicted share. */
  bars: ReadonlyMap<string, readonly PriceBar[]>;
  /**
   * Ex-dividend and split dates per orderbook ID. Prices are unadjusted (A13), so a prediction whose window
   * contains one of these dates for its own share is excluded from scoring. An empty map means none are known.
   */
  exDates: ReadonlyMap<string, ReadonlySet<string>>;
  /** Bars are complete up to and including this date. Horizons ending later are pending. */
  asOf: string;
}

export interface BaselineCalls {
  /** Sign of the 20-day market-adjusted return to the close before D; null if zero (within TIE_TOLERANCE). */
  momentum: Direction | null;
  /** Opposite of the sign of the previous day's market-adjusted return; null if zero (within TIE_TOLERANCE). */
  reversal: Direction | null;
}

export interface Pending {
  status: "PENDING";
  prediction: Prediction;
  /** Close that ends the horizon, or null if the calendar given does not reach it yet. */
  endDate: string | null;
}

export interface Excluded {
  status: "EXCLUDED";
  prediction: Prediction;
  endDate: string;
  reason: string;
}

export interface Scored {
  status: "SCORED";
  prediction: Prediction;
  endDate: string;
  /** close(end) ÷ open(D) − 1, in local currency. */
  shareReturn: number;
  /** Equal-weight universe return over the same window: open(D) to close(D), then close-to-close, compounded. */
  marketReturn: number;
  adjustedReturn: number;
  outcome: Outcome;
  /** null on a tie: neither a hit nor a miss. */
  hit: boolean | null;
  baselines: BaselineCalls;
}

export type PredictionResult = Pending | Excluded | Scored;

// ---- Prepared exchange data ---------------------------------------------------------------------------------

/** Exchange data checked and indexed once, then shared by every prediction on that exchange. */
export interface PreparedExchange {
  readonly asOf: string;
  readonly tradingDays: readonly string[];
  readonly dayIndex: ReadonlyMap<string, number>;
  readonly universe: readonly string[];
  readonly bars: ReadonlyMap<string, ReadonlyMap<string, PriceBar>>;
  readonly exDates: ReadonlyMap<string, ReadonlySet<string>>;
  /** Memoised equal-weight returns by trading-day index. */
  readonly openToClose: Map<number, number>;
  readonly closeToClose: Map<number, number>;
}

export function prepareExchange(data: ExchangeData): PreparedExchange {
  isoDate.parse(data.asOf);
  const dayIndex = new Map<string, number>();
  data.tradingDays.forEach((d, i) => {
    isoDate.parse(d);
    if (i > 0 && d <= data.tradingDays[i - 1]!) throw new Error(`Trading days must be strictly ascending: ${data.tradingDays[i - 1]} then ${d}`);
    dayIndex.set(d, i);
  });
  if (data.universe.length === 0) throw new Error("The universe is empty");
  if (new Set(data.universe).size !== data.universe.length) throw new Error("The universe lists a share twice");

  const bars = new Map<string, Map<string, PriceBar>>();
  for (const [id, list] of data.bars) {
    const byDate = new Map<string, PriceBar>();
    for (const bar of list) {
      if (byDate.has(bar.tradeDate)) throw new Error(`${id}: two bars dated ${bar.tradeDate}`);
      if (!dayIndex.has(bar.tradeDate)) throw new Error(`${id}: bar dated ${bar.tradeDate}, which is not a trading day`);
      byDate.set(bar.tradeDate, bar);
    }
    bars.set(id, byDate);
  }
  for (const id of data.universe) if (!bars.has(id)) throw new Error(`Universe member ${id} has no bars`);

  return {
    asOf: data.asOf,
    tradingDays: data.tradingDays,
    dayIndex,
    universe: data.universe,
    bars,
    exDates: data.exDates,
    openToClose: new Map(),
    closeToClose: new Map(),
  };
}

// ---- Prices and market returns ------------------------------------------------------------------------------

function price(ex: PreparedExchange, id: string, dayIdx: number, field: "open" | "close"): number {
  const date = ex.tradingDays[dayIdx];
  if (date === undefined) throw new Error(`${id}: trading day index ${dayIdx} is outside the calendar`);
  const bar = ex.bars.get(id)?.get(date);
  if (bar === undefined) throw new Error(`${id}: no bar for ${date}`);
  const value = bar[field];
  if (value === null || !Number.isFinite(value) || value <= 0) throw new Error(`${id}: no valid ${field} on ${date}`);
  return value;
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Equal-weight universe return from the open to the close of one day. */
function marketOpenToClose(ex: PreparedExchange, dayIdx: number): number {
  let r = ex.openToClose.get(dayIdx);
  if (r === undefined) {
    r = mean(ex.universe.map((id) => price(ex, id, dayIdx, "close") / price(ex, id, dayIdx, "open") - 1));
    ex.openToClose.set(dayIdx, r);
  }
  return r;
}

/** Equal-weight universe return from the previous trading day's close to this day's close. */
function marketCloseToClose(ex: PreparedExchange, dayIdx: number): number {
  let r = ex.closeToClose.get(dayIdx);
  if (r === undefined) {
    r = mean(ex.universe.map((id) => price(ex, id, dayIdx, "close") / price(ex, id, dayIdx - 1, "close") - 1));
    ex.closeToClose.set(dayIdx, r);
  }
  return r;
}

function signOf(x: number): Outcome {
  if (!Number.isFinite(x)) throw new Error(`Return is not a finite number: ${x}`);
  return x > TIE_TOLERANCE ? "UP" : x < -TIE_TOLERANCE ? "DOWN" : "TIE";
}

const opposite = (d: Direction): Direction => (d === "UP" ? "DOWN" : "UP");

/** Baseline calls (b) and (c) for a share on decision day D, from closes before D only. */
export function baselineCalls(ex: PreparedExchange, orderbookId: string, decisionDate: string): BaselineCalls {
  const d = ex.dayIndex.get(decisionDate);
  if (d === undefined) throw new Error(`${decisionDate} is not a trading day`);
  if (d - MOMENTUM_DAYS - 1 < 0) throw new Error(`${orderbookId}: fewer than ${MOMENTUM_DAYS + 1} trading days before ${decisionDate}`);

  let market = 1;
  for (let t = d - MOMENTUM_DAYS; t <= d - 1; t++) market *= 1 + marketCloseToClose(ex, t);
  const shareMomentum = price(ex, orderbookId, d - 1, "close") / price(ex, orderbookId, d - MOMENTUM_DAYS - 1, "close") - 1;
  const momentum = signOf(shareMomentum - (market - 1));

  const sharePrevDay = price(ex, orderbookId, d - 1, "close") / price(ex, orderbookId, d - 2, "close") - 1;
  const prevDay = signOf(sharePrevDay - marketCloseToClose(ex, d - 1));

  return {
    momentum: momentum === "TIE" ? null : momentum,
    reversal: prevDay === "TIE" ? null : opposite(prevDay),
  };
}

// ---- Scoring ------------------------------------------------------------------------------------------------

/** Scores one prediction against its exchange's data, or reports it pending or excluded. */
export function scorePrediction(input: Prediction, ex: PreparedExchange): PredictionResult {
  const prediction = predictionSchema.parse(input);
  const d = ex.dayIndex.get(prediction.decisionDate);
  if (d === undefined) throw new Error(`${prediction.id}: decision day ${prediction.decisionDate} is not a trading day`);
  if (!ex.bars.has(prediction.orderbookId)) throw new Error(`${prediction.id}: no bars for ${prediction.orderbookId}`);

  const e = d + horizonEndOffset(prediction.horizon);
  const endDate = ex.tradingDays[e] ?? null;
  if (endDate === null || endDate > ex.asOf) return { status: "PENDING", prediction, endDate };

  const exDate = [...(ex.exDates.get(prediction.orderbookId) ?? [])].sort().find((x) => x > prediction.decisionDate && x <= endDate);
  if (exDate !== undefined) {
    return { status: "EXCLUDED", prediction, endDate, reason: `ex-date ${exDate} inside ${prediction.decisionDate}..${endDate} (unadjusted prices, A13)` };
  }

  const shareReturn = price(ex, prediction.orderbookId, e, "close") / price(ex, prediction.orderbookId, d, "open") - 1;
  let market = 1 + marketOpenToClose(ex, d);
  for (let t = d + 1; t <= e; t++) market *= 1 + marketCloseToClose(ex, t);
  const marketReturn = market - 1;
  const adjustedReturn = shareReturn - marketReturn;
  const outcome = signOf(adjustedReturn);

  return {
    status: "SCORED",
    prediction,
    endDate,
    shareReturn,
    marketReturn,
    adjustedReturn,
    outcome,
    hit: outcome === "TIE" ? null : outcome === prediction.direction,
    baselines: baselineCalls(ex, prediction.orderbookId, prediction.decisionDate),
  };
}
