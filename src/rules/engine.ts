import { z } from "zod";
import type { CostConfig, Currency } from "../costs/config.js";
import { hurdlePct, roundCents, roundTripCostPct } from "../costs/costs.js";
import type { EntryOrder, Position } from "../sim/fills.js";
import type { RulesConfig } from "./config.js";
import { affordableGrossEur, estimateEntry, estimateExit, exitLevels, expectedMovePct, type EntryEstimate } from "./trade-numbers.js";

// Rules engine (brief §11, amendment A1): Claude proposes, code disposes. Pure: the portfolio, the shortlist
// with its market data, and Claude's predictions and actions arrive as inputs; nothing is fetched or stored.
//
// Evaluation order, fixed:
//   1. Screen. Each proposal must name a single action for a name that is held, or shortlisted and
//      screen-passed. A BUY for a held name, or a SELL or KEEP for a name not held, is rejected.
//   2. SELL triggers, per held position, in ISIN order: falsification met, stop hit, time stop expired,
//      screen failed. Any trigger sells, whether or not Claude proposed it. A proposed SELL with none of these
//      waits for step 3 as a candidate for a better use of the slot.
//   3. BUYs, ranked by expected move minus hurdle at the target size (ties by ISIN). Each is checked for
//      position cap, sector cap, opening pace, monthly turnover cap, cash floor after costs, minimum position
//      after rounding, the hurdle on the rounded size, and stop width. A BUY that fails may free a slot by
//      selling a candidate from step 2, if it then passes every check and its expected move, net of the
//      exit cost and of the held name's own expected move, still clears its hurdle. Unused candidates are
//      rejected.
//   4. KEEP, the default, for every position not sold.
//
// Money is estimated at the previous close and the latest ECB rate; `simulateEntry` re-checks the minimum
// position and cash floor at the real open. The caller must simulate exits before entries on the same day.

// ---- Claude's proposals (external, so validated) ----------------------------------------------------------

export const predictionSchema = z.object({
  isin: z.string().length(12),
  horizonDays: z.number().int().positive(),
  direction: z.enum(["up", "down"]),
  confidence: z.number().min(0.5).max(1),
});

export const proposedActionSchema = z
  .object({
    type: z.enum(["BUY", "SELL", "KEEP"]),
    isin: z.string().length(12),
    /** Required for a BUY: the horizon whose prediction supplies the confidence. */
    horizonDays: z.number().int().positive().optional(),
  })
  .refine((a) => a.type !== "BUY" || a.horizonDays !== undefined, { message: "a BUY needs horizonDays" });

export type Prediction = z.infer<typeof predictionSchema>;
export type ProposedAction = z.infer<typeof proposedActionSchema>;

// ---- Inputs from code -------------------------------------------------------------------------------------

/** One shortlisted name, with the market data known at the cut-off. Holdings are always on the shortlist. */
export interface ShortlistedName {
  isin: string;
  sector: string;
  currency: Currency;
  screenPassed: boolean;
  /** Close of the last completed session, in local currency. */
  previousClose: number;
  /** Latest ECB rate known at the cut-off, local units per 1 EUR; exactly 1 for EUR. */
  eurRate: number;
  /** 20-day realised volatility of daily log returns, as a fraction. */
  volatility20d: number;
  medianTurnoverEur: number;
}

/** A held position: the simulator's `Position` plus what the rules need. */
export interface HeldPosition extends Position {
  isin: string;
  entryDate: string;
  /** Sessions held before the decision date, the entry session included (`sessionsHeld`). */
  sessionsHeld: number;
  /** Set by code at entry. */
  timeStopSessions: number;
  /** Whether the position's falsification condition is met, evaluated elsewhere. */
  falsificationMet: boolean;
}

export interface RulesInput {
  /** Decision date, YYYY-MM-DD. */
  date: string;
  cashEur: number;
  positions: readonly HeldPosition[];
  /** Entries already made on the decision date, e.g. by an earlier run. */
  entriesToday: number;
  /** Entries made in the calendar month of the decision date, before this run. */
  entriesThisMonth: number;
  shortlist: readonly ShortlistedName[];
  predictions: readonly z.input<typeof predictionSchema>[];
  actions: readonly z.input<typeof proposedActionSchema>[];
}

// ---- Output -----------------------------------------------------------------------------------------------

export type ReasonCode =
  // Step 1
  | "DUPLICATE_ACTION"
  | "NOT_SHORTLISTED"
  | "SCREEN_FAILED"
  | "NOT_HELD"
  | "ALREADY_HELD"
  // Step 2
  | "FALSIFIED"
  | "STOP_HIT"
  | "TIME_STOP"
  | "BETTER_USE_OF_SLOT"
  | "NO_SELL_TRIGGER"
  // Step 3
  | "NO_PREDICTION"
  | "DIRECTION_NOT_UP"
  | BuyRule
  | "ALL_CHECKS_PASSED"
  // Step 4
  | "NO_TRIGGER";

export const BUY_RULES = [
  "POSITION_CAP",
  "SECTOR_CAP",
  "OPENING_PACE",
  "TURNOVER_CAP",
  "CASH_FLOOR",
  "MIN_POSITION",
  "HURDLE",
  "STOP_WIDTH",
] as const;
export type BuyRule = (typeof BUY_RULES)[number];

export type SellTrigger = "FALSIFIED" | "STOP_HIT" | "TIME_STOP" | "SCREEN_FAILED";

export type Figures = Record<string, number | string | boolean | null>;

export interface Check {
  rule: BuyRule;
  passed: boolean;
  figures: Figures;
}

export interface Trigger {
  trigger: SellTrigger;
  met: boolean;
  figures: Figures;
}

export interface SwapAttempt {
  /** The held position that would be sold to make room. */
  sellIsin: string;
  passed: boolean;
  /** Failing rules, or "HURDLE" when the swap test itself fails. Empty when passed. */
  failed: BuyRule[];
  figures: Figures;
}

export interface Decision {
  step: 1 | 2 | 3 | 4;
  action: "BUY" | "SELL" | "KEEP";
  isin: string;
  /** PROPOSED: Claude asked for it. RULE: code acted on its own (a forced sell or the default keep). */
  origin: "PROPOSED" | "RULE";
  accepted: boolean;
  /** Why: the trigger(s) met, the failing rules in evaluation order, or a single code. Never empty. */
  reasons: ReasonCode[];
  checks: Check[];
  triggers: Trigger[];
  swapAttempts: SwapAttempt[];
  figures: Figures;
}

export interface EntryInstruction {
  isin: string;
  /** Ready for `simulateEntry`. */
  order: EntryOrder;
  horizonDays: number;
  /** Store with the position; step 2 compares `sessionsHeld` with it. */
  timeStopSessions: number;
  expectedMovePct: number;
  hurdlePct: number;
  estimatedShares: number;
  estimatedNotionalEur: number;
  /** The position sold to make room for this one, or null. */
  replaces: string | null;
}

export interface ExitInstruction {
  isin: string;
  /** Ready for `simulateExit`. */
  position: Position;
  reasons: ReasonCode[];
}

export interface KeepInstruction {
  isin: string;
  /** Ready for `simulateStopsAndTargets`. */
  position: Position;
}

export interface RulesResult {
  date: string;
  exits: ExitInstruction[];
  entries: EntryInstruction[];
  keeps: KeepInstruction[];
  /** Every decision, accepted and rejected, in evaluation order. */
  decisions: Decision[];
}

// ---- Input checks -----------------------------------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got ${value}`);
}

function assertCount(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number ≥ 0, got ${value}`);
}

function assertName(n: ShortlistedName): void {
  if (n.sector.trim() === "") throw new Error(`${n.isin}: sector missing`);
  assertPositive(`${n.isin} previous close`, n.previousClose);
  assertPositive(`${n.isin} rate`, n.eurRate);
  if (n.currency === "EUR" && n.eurRate !== 1) throw new Error(`${n.isin}: EUR rate must be 1, got ${n.eurRate}`);
  assertPositive(`${n.isin} volatility`, n.volatility20d);
  assertPositive(`${n.isin} median turnover`, n.medianTurnoverEur);
}

function assertPosition(p: HeldPosition, date: string, name: ShortlistedName | undefined): asserts name is ShortlistedName {
  if (name === undefined) throw new Error(`${p.isin} is held but not on the shortlist; holdings are always shortlisted (brief §9)`);
  if (name.currency !== p.currency) throw new Error(`${p.isin}: position currency ${p.currency} differs from the shortlist's ${name.currency}`);
  if (!Number.isInteger(p.shares) || p.shares < 1) throw new Error(`${p.isin}: shares must be a positive whole number, got ${p.shares}`);
  assertPositive(`${p.isin} stop price`, p.stopPrice);
  if (!(p.stopPrice < p.targetPrice)) throw new Error(`${p.isin}: stop ${p.stopPrice} must be below target ${p.targetPrice}`);
  if (!DATE.test(p.entryDate) || p.entryDate >= date) throw new Error(`${p.isin}: entry date ${p.entryDate} must be before ${date}`);
  assertCount(`${p.isin} sessions held`, p.sessionsHeld);
  if (!Number.isInteger(p.timeStopSessions) || p.timeStopSessions < 1) {
    throw new Error(`${p.isin}: time stop must be a whole number of sessions ≥ 1, got ${p.timeStopSessions}`);
  }
}

function indexUnique<T>(items: readonly T[], key: (item: T) => string, what: string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    const k = key(item);
    if (map.has(k)) throw new Error(`Duplicate ${what}: ${k}`);
    map.set(k, item);
  }
  return map;
}

const byIsin = (a: { isin: string }, b: { isin: string }): number => (a.isin < b.isin ? -1 : a.isin > b.isin ? 1 : 0);

function toPosition(p: HeldPosition): Position {
  return { currency: p.currency, shares: p.shares, stopPrice: p.stopPrice, targetPrice: p.targetPrice, medianTurnoverEur: p.medianTurnoverEur };
}

// ---- Steps ------------------------------------------------------------------------------------------------

function sellTriggers(p: HeldPosition, name: ShortlistedName): Trigger[] {
  return [
    { trigger: "FALSIFIED", met: p.falsificationMet, figures: { falsificationMet: p.falsificationMet } },
    // A backstop: settlement should already have filled a touched stop through `simulateStopsAndTargets`.
    { trigger: "STOP_HIT", met: name.previousClose <= p.stopPrice, figures: { previousClose: name.previousClose, stopPrice: p.stopPrice } },
    {
      trigger: "TIME_STOP",
      met: p.sessionsHeld >= p.timeStopSessions,
      figures: { sessionsHeld: p.sessionsHeld, timeStopSessions: p.timeStopSessions },
    },
    { trigger: "SCREEN_FAILED", met: !name.screenPassed, figures: { screenPassed: name.screenPassed } },
  ];
}

interface BuyPlan {
  isin: string;
  name: ShortlistedName;
  horizonDays: number;
  confidence: number;
  expectedMovePct: number;
  stopPct: number;
  targetPct: number;
  timeStopSessions: number;
  /** Expected move minus the hurdle at the whole-share size of the target position; ranks the BUYs. */
  edgePct: number;
  figures: Figures;
}

/** What the BUY checks see: the portfolio after this run's decisions so far. */
interface BuyState {
  holdings: { isin: string; sector: string }[];
  cashEur: number;
  committedEur: number;
  accepted: number;
}

interface CheckOutcome {
  checks: Check[];
  failed: BuyRule[];
  intendedEur: number;
  estimate: EntryEstimate;
  hurdlePct: number | null;
}

function buyChecks(plan: BuyPlan, state: BuyState, input: RulesInput, rules: RulesConfig, costs: CostConfig): CheckOutcome {
  const { name } = plan;
  const inSector = state.holdings.filter((h) => h.sector === name.sector).length;
  const opened = input.entriesToday + state.accepted;
  const entries = input.entriesThisMonth + state.accepted;
  const availableEur = state.cashEur - state.committedEur - rules.cashFloorEur;
  const intendedEur = Math.min(rules.targetPositionEur, affordableGrossEur(availableEur, name.currency, costs));
  const estimate =
    intendedEur > 0
      ? estimateEntry(intendedEur, name.previousClose, name.eurRate, name.currency, name.medianTurnoverEur, costs)
      : { shares: 0, notionalEur: 0, entryCostsEur: 0 };
  const hurdle = estimate.shares > 0 ? hurdlePct(estimate.notionalEur, name.currency, name.medianTurnoverEur, costs) : null;
  const checks: Check[] = [
    { rule: "POSITION_CAP", passed: state.holdings.length < rules.maxPositions, figures: { positions: state.holdings.length, max: rules.maxPositions } },
    { rule: "SECTOR_CAP", passed: inSector < rules.maxPositionsPerSector, figures: { sector: name.sector, inSector, max: rules.maxPositionsPerSector } },
    { rule: "OPENING_PACE", passed: opened < rules.maxNewPositionsPerDay, figures: { openedToday: opened, max: rules.maxNewPositionsPerDay } },
    { rule: "TURNOVER_CAP", passed: entries < rules.maxRoundTripsPerMonth, figures: { entriesThisMonth: entries, max: rules.maxRoundTripsPerMonth } },
    {
      rule: "CASH_FLOOR",
      passed: intendedEur >= rules.minPositionEur,
      figures: {
        cashEur: state.cashEur,
        committedEur: state.committedEur,
        cashFloorEur: rules.cashFloorEur,
        availableEur,
        intendedEur,
        minPositionEur: rules.minPositionEur,
      },
    },
    {
      rule: "MIN_POSITION",
      // To the cent, as in `simulateEntry`.
      passed: roundCents(estimate.notionalEur) >= rules.minPositionEur,
      figures: {
        previousClose: name.previousClose,
        eurRate: name.eurRate,
        estimatedShares: estimate.shares,
        estimatedNotionalEur: estimate.notionalEur,
        minPositionEur: rules.minPositionEur,
      },
    },
    {
      rule: "HURDLE",
      passed: hurdle !== null && plan.expectedMovePct >= hurdle,
      figures: {
        expectedMovePct: plan.expectedMovePct,
        hurdlePct: hurdle,
        roundTripCostPct: estimate.shares > 0 ? roundTripCostPct(estimate.notionalEur, name.currency, name.medianTurnoverEur, costs) : null,
        atNotionalEur: estimate.notionalEur,
        // For the audit: the hurdle had the unrounded intended size been bought.
        hurdlePctAtIntendedSize: intendedEur > 0 ? hurdlePct(intendedEur, name.currency, name.medianTurnoverEur, costs) : null,
      },
    },
    { rule: "STOP_WIDTH", passed: plan.stopPct <= rules.tradeNumbers.maxStopPct, figures: { stopPct: plan.stopPct, maxStopPct: rules.tradeNumbers.maxStopPct } },
  ];
  return { checks, failed: checks.filter((c) => !c.passed).map((c) => c.rule), intendedEur, estimate, hurdlePct: hurdle };
}

function planBuy(
  action: ProposedAction,
  name: ShortlistedName,
  predictions: Map<string, Prediction>,
  rules: RulesConfig,
  costs: CostConfig,
): BuyPlan | { reason: "NO_PREDICTION" | "DIRECTION_NOT_UP"; figures: Figures } {
  const horizonDays = action.horizonDays!;
  const prediction = predictions.get(predictionKey(name.isin, horizonDays));
  if (prediction === undefined) return { reason: "NO_PREDICTION", figures: { horizonDays } };
  if (prediction.direction !== "up") return { reason: "DIRECTION_NOT_UP", figures: { horizonDays, direction: prediction.direction } };
  const tn = rules.tradeNumbers;
  const move = expectedMovePct("up", prediction.confidence, name.volatility20d, horizonDays, tn);
  const levels = exitLevels(name.volatility20d, horizonDays, tn);
  const atTarget = estimateEntry(rules.targetPositionEur, name.previousClose, name.eurRate, name.currency, name.medianTurnoverEur, costs);
  const hurdleAtTarget = atTarget.shares > 0 ? hurdlePct(atTarget.notionalEur, name.currency, name.medianTurnoverEur, costs) : null;
  return {
    isin: name.isin,
    name,
    horizonDays,
    confidence: prediction.confidence,
    expectedMovePct: move,
    ...levels,
    edgePct: hurdleAtTarget === null ? -Infinity : move - hurdleAtTarget,
    figures: {
      currency: name.currency,
      horizonDays,
      confidence: prediction.confidence,
      volatility20d: name.volatility20d,
      expectedMovePct: move,
      stopPct: levels.stopPct,
      targetPct: levels.targetPct,
      timeStopSessions: levels.timeStopSessions,
      medianTurnoverEur: name.medianTurnoverEur,
      // Expected move minus the hurdle at the whole-share size of the target position: the ranking key.
      rankEdgePct: hurdleAtTarget === null ? null : move - hurdleAtTarget,
    },
  };
}

const predictionKey = (isin: string, horizonDays: number): string => `${isin}|${horizonDays}`;

// ---- Public API -------------------------------------------------------------------------------------------

export function evaluateRules(input: RulesInput, rules: RulesConfig, costs: CostConfig): RulesResult {
  if (!DATE.test(input.date)) throw new Error(`Date must be YYYY-MM-DD, got ${input.date}`);
  if (!Number.isFinite(input.cashEur)) throw new Error(`Cash must be a number, got ${input.cashEur}`);
  assertCount("Entries today", input.entriesToday);
  assertCount("Entries this month", input.entriesThisMonth);
  const predictions = indexUnique(z.array(predictionSchema).parse(input.predictions), (p) => predictionKey(p.isin, p.horizonDays), "prediction");
  const actions = z.array(proposedActionSchema).parse(input.actions);
  const names = indexUnique(input.shortlist, (n) => n.isin, "shortlisted name");
  for (const n of names.values()) assertName(n);
  const held = indexUnique(input.positions, (p) => p.isin, "position");
  for (const p of held.values()) assertPosition(p, input.date, names.get(p.isin));

  const decisions: Decision[] = [];
  const decide = (d: Omit<Decision, "checks" | "triggers" | "swapAttempts" | "figures"> & Partial<Decision>): void => {
    decisions.push({ checks: [], triggers: [], swapAttempts: [], figures: {}, ...d });
  };

  // Step 1: the screen, and one action per name.
  const grouped = new Map<string, ProposedAction[]>();
  for (const a of actions) grouped.set(a.isin, [...(grouped.get(a.isin) ?? []), a]);
  const buys: ProposedAction[] = [];
  const proposedSells = new Set<string>();
  const proposedKeeps = new Set<string>();
  for (const isin of [...grouped.keys()].sort()) {
    const group = grouped.get(isin)!;
    const reject = (a: ProposedAction, reason: ReasonCode, figures: Figures = {}): void =>
      decide({ step: 1, action: a.type, isin, origin: "PROPOSED", accepted: false, reasons: [reason], figures });
    if (group.length > 1) {
      const types = group.map((a) => a.type).sort();
      for (const type of types) reject({ type, isin }, "DUPLICATE_ACTION", { actions: types.join(",") });
      continue;
    }
    const action = group[0]!;
    const name = names.get(isin);
    if (held.has(isin)) {
      if (action.type === "BUY") reject(action, "ALREADY_HELD");
      else (action.type === "SELL" ? proposedSells : proposedKeeps).add(isin);
    } else if (name === undefined) reject(action, "NOT_SHORTLISTED");
    else if (!name.screenPassed) reject(action, "SCREEN_FAILED", { screenPassed: false });
    else if (action.type !== "BUY") reject(action, "NOT_HELD");
    else buys.push(action);
  }

  // Step 2: SELL triggers.
  const exits: ExitInstruction[] = [];
  const candidates: HeldPosition[] = [];
  const kept: HeldPosition[] = [];
  let cashEur = input.cashEur;
  const exitEstimate = (p: HeldPosition) => {
    const n = names.get(p.isin)!;
    return estimateExit(p.shares, n.previousClose, n.eurRate, p.currency, p.medianTurnoverEur, costs);
  };
  for (const p of [...held.values()].sort(byIsin)) {
    const triggers = sellTriggers(p, names.get(p.isin)!);
    const met = triggers.filter((t) => t.met).map((t) => t.trigger);
    if (met.length > 0) {
      const estimate = exitEstimate(p);
      cashEur += estimate.proceedsEur;
      exits.push({ isin: p.isin, position: toPosition(p), reasons: met });
      decide({
        step: 2,
        action: "SELL",
        isin: p.isin,
        origin: proposedSells.has(p.isin) ? "PROPOSED" : "RULE",
        accepted: true,
        reasons: met,
        triggers,
        figures: { estimatedValueEur: estimate.valueEur, estimatedExitCostEur: estimate.costEur, estimatedProceedsEur: estimate.proceedsEur },
      });
    } else if (proposedSells.has(p.isin)) candidates.push(p);
    else kept.push(p);
  }

  // Step 3: BUYs, best edge first.
  const plans: BuyPlan[] = [];
  for (const action of buys) {
    const plan = planBuy(action, names.get(action.isin)!, predictions, rules, costs);
    if ("reason" in plan) decide({ step: 3, action: "BUY", isin: action.isin, origin: "PROPOSED", accepted: false, reasons: [plan.reason], figures: plan.figures });
    else plans.push(plan);
  }
  plans.sort((a, b) => (a.edgePct !== b.edgePct ? (b.edgePct > a.edgePct ? 1 : -1) : byIsin(a, b)));

  const sectorOf = (isin: string): string => names.get(isin)!.sector;
  const state: BuyState = {
    holdings: [...candidates, ...kept].map((p) => ({ isin: p.isin, sector: sectorOf(p.isin) })).sort(byIsin),
    cashEur,
    committedEur: 0,
    accepted: 0,
  };
  const entries: EntryInstruction[] = [];
  const used = new Set<string>();

  for (const plan of plans) {
    const base = buyChecks(plan, state, input, rules, costs);
    let chosen: { outcome: CheckOutcome; sell: HeldPosition; attempt: SwapAttempt; netPct: number } | null = null;
    const swapAttempts: SwapAttempt[] = [];
    if (base.failed.length > 0) {
      for (const sell of candidates.filter((c) => !used.has(c.isin))) {
        const exit = exitEstimate(sell);
        const swapState: BuyState = { ...state, holdings: state.holdings.filter((h) => h.isin !== sell.isin), cashEur: state.cashEur + exit.proceedsEur };
        const outcome = buyChecks(plan, swapState, input, rules, costs);
        const heldPrediction = predictions.get(predictionKey(sell.isin, plan.horizonDays));
        if (heldPrediction === undefined) throw new Error(`${sell.isin}: no ${plan.horizonDays}-day prediction for a held name`);
        const heldName = names.get(sell.isin)!;
        const heldMovePct = expectedMovePct(heldPrediction.direction, heldPrediction.confidence, heldName.volatility20d, plan.horizonDays, rules.tradeNumbers);
        const exitCostPct = outcome.estimate.notionalEur > 0 ? (exit.costEur / outcome.estimate.notionalEur) * 100 : null;
        // A predicted fall in the held name earns no credit: only its expected gain counts against the swap.
        const netPct = exitCostPct === null ? null : plan.expectedMovePct - exitCostPct - Math.max(0, heldMovePct);
        const swapClears = netPct !== null && outcome.hurdlePct !== null && netPct >= outcome.hurdlePct;
        const failed: BuyRule[] = [...outcome.failed, ...(swapClears || outcome.failed.includes("HURDLE") ? [] : (["HURDLE"] as const))];
        const attempt: SwapAttempt = {
          sellIsin: sell.isin,
          passed: failed.length === 0,
          failed,
          figures: {
            buyExpectedMovePct: plan.expectedMovePct,
            heldExpectedMovePct: heldMovePct,
            exitCostEur: exit.costEur,
            exitCostPct,
            netMovePct: netPct,
            hurdlePct: outcome.hurdlePct,
          },
        };
        swapAttempts.push(attempt);
        if (attempt.passed && netPct !== null && (chosen === null || netPct > chosen.netPct)) chosen = { outcome, sell, attempt, netPct };
      }
    }

    if (base.failed.length > 0 && chosen === null) {
      decide({
        step: 3,
        action: "BUY",
        isin: plan.isin,
        origin: "PROPOSED",
        accepted: false,
        reasons: base.failed,
        checks: base.checks,
        swapAttempts,
        figures: plan.figures,
      });
      continue;
    }

    const outcome = chosen?.outcome ?? base;
    if (chosen !== null) {
      const sell = chosen.sell;
      used.add(sell.isin);
      const exit = exitEstimate(sell);
      state.holdings = state.holdings.filter((h) => h.isin !== sell.isin);
      state.cashEur += exit.proceedsEur;
      exits.push({ isin: sell.isin, position: toPosition(sell), reasons: ["BETTER_USE_OF_SLOT"] });
      decide({
        step: 3,
        action: "SELL",
        isin: sell.isin,
        origin: "PROPOSED",
        accepted: true,
        reasons: ["BETTER_USE_OF_SLOT"],
        triggers: sellTriggers(sell, names.get(sell.isin)!),
        figures: { replacedBy: plan.isin, ...chosen.attempt.figures, estimatedProceedsEur: exit.proceedsEur },
      });
    }
    state.holdings = [...state.holdings, { isin: plan.isin, sector: plan.name.sector }].sort(byIsin);
    state.committedEur += outcome.estimate.notionalEur + outcome.estimate.entryCostsEur;
    state.accepted += 1;
    entries.push({
      isin: plan.isin,
      order: {
        currency: plan.name.currency,
        sizeEur: outcome.intendedEur,
        stopPct: plan.stopPct,
        targetPct: plan.targetPct,
        medianTurnoverEur: plan.name.medianTurnoverEur,
      },
      horizonDays: plan.horizonDays,
      timeStopSessions: plan.timeStopSessions,
      expectedMovePct: plan.expectedMovePct,
      hurdlePct: outcome.hurdlePct!,
      estimatedShares: outcome.estimate.shares,
      estimatedNotionalEur: outcome.estimate.notionalEur,
      replaces: chosen?.sell.isin ?? null,
    });
    decide({
      step: 3,
      action: "BUY",
      isin: plan.isin,
      origin: "PROPOSED",
      accepted: true,
      reasons: chosen === null ? ["ALL_CHECKS_PASSED"] : ["BETTER_USE_OF_SLOT"],
      checks: outcome.checks,
      swapAttempts,
      figures: plan.figures,
    });
  }

  for (const c of candidates) {
    if (used.has(c.isin)) continue;
    decide({
      step: 3,
      action: "SELL",
      isin: c.isin,
      origin: "PROPOSED",
      accepted: false,
      reasons: ["NO_SELL_TRIGGER"],
      triggers: sellTriggers(c, names.get(c.isin)!),
    });
    kept.push(c);
  }

  // Step 4: KEEP is the default.
  kept.sort(byIsin);
  for (const p of kept) {
    decide({
      step: 4,
      action: "KEEP",
      isin: p.isin,
      origin: proposedKeeps.has(p.isin) ? "PROPOSED" : "RULE",
      accepted: true,
      reasons: ["NO_TRIGGER"],
      triggers: sellTriggers(p, names.get(p.isin)!),
    });
  }

  return { date: input.date, exits, entries, keeps: kept.map((p) => ({ isin: p.isin, position: toPosition(p) })), decisions };
}
