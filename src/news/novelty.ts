import type { Exchange } from "./names.js";
import { parseIsoDate, zonedTimeToUtc } from "./time.js";

// Novelty check (brief §8.5): how far a linked share has already moved, relative to its exchange, between an
// announcement and the decision cut-off. Pure: the caller supplies the bars.
//
// Window rule:
//   base = the share's last close whose session ended at or before `releasedAt`;
//   end  = the share's last close whose session ended strictly before `cutoff`.
// So an item released during a session is measured from the previous close to (at least) that day's close,
// and one released after the close, or on a day without trading, from that close to the next session's close.
// If `end` is not later than `base` (no session has closed since the release), the result is null.
// Share return = close(end) / close(base) - 1. Exchange return = the equal-weight mean of the same return,
// between the same two trade dates, over every other share supplied for the exchange that has a close on
// both dates (the share itself is left out). Adjusted return = share return - exchange return.
// Bars with a null close (no trades that day) are not closes and are skipped.

/** Regular close of equity trading, local time (SOURCED: nasdaq.com/european-market-activity/trading-hours, accessed 2026-09-27). */
export const EXCHANGE_SESSIONS: Readonly<Record<Exchange, { timeZone: string; close: string; halfDayClose: string | null }>> = {
  HEL: { timeZone: "Europe/Helsinki", close: "18:30", halfDayClose: null },
  STO: { timeZone: "Europe/Stockholm", close: "17:30", halfDayClose: "13:00" },
  CPH: { timeZone: "Europe/Copenhagen", close: "17:00", halfDayClose: null },
};

/** When the session on `tradeDate` closed, as a UTC instant. */
export function sessionCloseUtc(exchange: Exchange, tradeDate: string, halfDays: ReadonlySet<string>): Date {
  const session = EXCHANGE_SESSIONS[exchange];
  if (halfDays.has(tradeDate)) {
    if (session.halfDayClose === null) throw new Error(`Novelty: ${exchange} has no half trading days, but ${tradeDate} is given as one`);
    return zonedTimeToUtc(tradeDate, session.halfDayClose, session.timeZone);
  }
  return zonedTimeToUtc(tradeDate, session.close, session.timeZone);
}

export interface CloseBar {
  tradeDate: string;
  close: number | null;
}

export interface NoveltyInput {
  exchange: Exchange;
  orderbookId: string;
  releasedAt: Date;
  cutoff: Date;
  /** The share's daily bars. */
  bars: readonly CloseBar[];
  /** Daily bars for the exchange's shares, by orderbook ID. The share itself may be included; it is skipped. */
  exchangeBars: ReadonlyMap<string, readonly CloseBar[]>;
  /** The exchange's half trading days (YYYY-MM-DD) in the bars' range; pass an empty set if there are none. */
  halfDays: ReadonlySet<string>;
}

export type Novelty =
  | {
      adjustedReturn: number;
      shareReturn: number;
      exchangeReturn: number;
      baseDate: string;
      endDate: string;
      /** Shares in the exchange mean. */
      peers: number;
    }
  | { adjustedReturn: null; reason: string };

export function noveltyMove(input: NoveltyInput): Novelty {
  const { exchange, orderbookId, releasedAt, cutoff, halfDays } = input;
  const release = validInstant(releasedAt, "releasedAt");
  const cut = validInstant(cutoff, "cutoff");
  if (release >= cut) throw new Error(`Novelty: ${orderbookId} released at or after the cut-off, so it is not admissible`);

  const closes = closeSeries(input.bars, orderbookId).map((b) => ({ ...b, closeAt: sessionCloseUtc(exchange, b.tradeDate, halfDays).getTime() }));
  const base = closes.filter((b) => b.closeAt <= release).at(-1);
  if (base === undefined) return { adjustedReturn: null, reason: "no close at or before the release in the bars supplied" };
  const end = closes.filter((b) => b.closeAt < cut).at(-1)!;
  if (end.closeAt <= base.closeAt) return { adjustedReturn: null, reason: "no session has closed since the release" };

  const peerReturns: number[] = [];
  for (const [id, bars] of input.exchangeBars) {
    if (id === orderbookId) continue;
    const series = closeSeries(bars, id);
    const from = series.find((b) => b.tradeDate === base.tradeDate);
    const to = series.find((b) => b.tradeDate === end.tradeDate);
    if (from !== undefined && to !== undefined) peerReturns.push(to.close / from.close - 1);
  }
  if (peerReturns.length === 0) return { adjustedReturn: null, reason: `no other ${exchange} share has closes on ${base.tradeDate} and ${end.tradeDate}` };

  const shareReturn = end.close / base.close - 1;
  const exchangeReturn = peerReturns.reduce((s, r) => s + r, 0) / peerReturns.length;
  return {
    adjustedReturn: shareReturn - exchangeReturn,
    shareReturn,
    exchangeReturn,
    baseDate: base.tradeDate,
    endDate: end.tradeDate,
    peers: peerReturns.length,
  };
}

/** Bars with a close, sorted by date. Throws on a bad date, a repeated date or a non-positive close. */
function closeSeries(bars: readonly CloseBar[], orderbookId: string): { tradeDate: string; close: number }[] {
  const seen = new Set<string>();
  const out: { tradeDate: string; close: number }[] = [];
  for (const bar of bars) {
    parseIsoDate(bar.tradeDate);
    if (seen.has(bar.tradeDate)) throw new Error(`Novelty: ${orderbookId} has two bars on ${bar.tradeDate}`);
    seen.add(bar.tradeDate);
    if (bar.close === null) continue;
    if (!Number.isFinite(bar.close) || bar.close <= 0) throw new Error(`Novelty: ${orderbookId} has close ${bar.close} on ${bar.tradeDate}`);
    out.push({ tradeDate: bar.tradeDate, close: bar.close });
  }
  return out.sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : a.tradeDate > b.tradeDate ? 1 : 0));
}

function validInstant(value: Date, name: string): number {
  const ms = value instanceof Date ? value.getTime() : Number.NaN;
  if (Number.isNaN(ms)) throw new Error(`Novelty: ${name} is not a valid Date`);
  return ms;
}
