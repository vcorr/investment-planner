import { z } from "zod";
import { EXCHANGE_CALENDARS, type ExchangeCalendar } from "../config/exchange-calendars.js";
import type { Market } from "../sources/nasdaq.js";

// Trading-day arithmetic per exchange. Pure: the calendar is a parameter (the sourced one by default).
// Every function throws for a malformed date, an unknown market, or a date outside the covered range:
// a calendar that does not know must not guess.

const DAY_MS = 86_400_000;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const ms = Date.parse(`${s}T00:00:00Z`);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s;
  }, "not a calendar date");

const sourceSchema = z.object({ url: z.url(), accessed: isoDate });

const calendarSchema = z.object({
  markets: z.record(
    z.string(),
    z.object({ from: isoDate, to: isoDate, sources: z.record(z.string().regex(/^\d{4}$/), sourceSchema) }),
  ),
  exceptions: z.array(
    z.discriminatedUnion("kind", [
      z.object({
        market: z.string(),
        date: isoDate,
        kind: z.literal("closed"),
        closesAt: z.undefined().optional(),
        note: z.string().min(1),
        source: sourceSchema,
      }),
      z.object({
        market: z.string(),
        date: isoDate,
        kind: z.literal("early_close"),
        closesAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        note: z.string().min(1),
        source: sourceSchema,
      }),
    ]),
  ),
});

interface MarketIndex {
  from: number;
  to: number;
  fromDate: string;
  toDate: string;
  closed: ReadonlySet<string>;
  earlyClose: ReadonlyMap<string, string>;
}

/** Days since 1970-01-01 (UTC) for a YYYY-MM-DD string; throws if malformed. */
function dayNumber(date: string): number {
  const parsed = isoDate.safeParse(date);
  if (!parsed.success) throw new Error(`Malformed date ${JSON.stringify(date)}: expected YYYY-MM-DD`);
  return Date.parse(`${date}T00:00:00Z`) / DAY_MS;
}

function isoFromDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function isWeekend(day: number): boolean {
  const weekday = new Date(day * DAY_MS).getUTCDay();
  return weekday === 0 || weekday === 6;
}

const indexCache = new WeakMap<ExchangeCalendar, ReadonlyMap<string, MarketIndex>>();

/** Validates a calendar and indexes it by market. Throws on anything inconsistent. */
function buildIndex(calendar: ExchangeCalendar): ReadonlyMap<string, MarketIndex> {
  const parsed = calendarSchema.parse(calendar);
  const index = new Map<string, MarketIndex>();

  for (const [market, cov] of Object.entries(parsed.markets)) {
    const from = dayNumber(cov.from);
    const to = dayNumber(cov.to);
    if (from > to) throw new Error(`${market}: coverage starts ${cov.from}, after it ends ${cov.to}`);
    for (let y = Number(cov.from.slice(0, 4)); y <= Number(cov.to.slice(0, 4)); y++) {
      if (!cov.sources[String(y)]) throw new Error(`${market}: no source recorded for ${y}`);
    }
    index.set(market, { from, to, fromDate: cov.from, toDate: cov.to, closed: new Set(), earlyClose: new Map() });
  }

  for (const e of parsed.exceptions) {
    const m = index.get(e.market);
    if (!m) throw new Error(`${e.market} ${e.date}: exception for a market without coverage`);
    const day = dayNumber(e.date);
    if (day < m.from || day > m.to) throw new Error(`${e.market} ${e.date}: exception outside ${m.fromDate} to ${m.toDate}`);
    if (isWeekend(day)) throw new Error(`${e.market} ${e.date}: exception on a weekend`);
    if (m.closed.has(e.date) || m.earlyClose.has(e.date)) throw new Error(`${e.market} ${e.date}: duplicate exception`);
    if (e.kind === "closed") (m.closed as Set<string>).add(e.date);
    else (m.earlyClose as Map<string, string>).set(e.date, e.closesAt);
  }
  return index;
}

function indexOf(calendar: ExchangeCalendar): ReadonlyMap<string, MarketIndex> {
  let index = indexCache.get(calendar);
  if (!index) {
    index = buildIndex(calendar);
    indexCache.set(calendar, index);
  }
  return index;
}

/** Throws if the calendar is malformed or inconsistent (bad dates, weekend or duplicate exceptions, missing sources). */
export function validateCalendar(calendar: ExchangeCalendar): void {
  indexOf(calendar);
}

function marketIndex(calendar: ExchangeCalendar, market: Market): MarketIndex {
  const m = indexOf(calendar).get(market);
  if (!m) throw new Error(`Unknown market ${JSON.stringify(market)}: not in the calendar`);
  return m;
}

function inRange(m: MarketIndex, market: Market, date: string): number {
  const day = dayNumber(date);
  if (day < m.from || day > m.to) {
    throw new Error(`${market} ${date}: outside the calendar's covered range ${m.fromDate} to ${m.toDate}`);
  }
  return day;
}

function tradesOn(m: MarketIndex, day: number): boolean {
  return !isWeekend(day) && !m.closed.has(isoFromDay(day));
}

/** True when the exchange trades on `date`. An early-close day is a trading day. */
export function isTradingDay(market: Market, date: string, calendar: ExchangeCalendar = EXCHANGE_CALENDARS): boolean {
  const m = marketIndex(calendar, market);
  return tradesOn(m, inRange(m, market, date));
}

/** Local close time ("HH:MM") on an early-close day; null on any other date. */
export function earlyCloseAt(market: Market, date: string, calendar: ExchangeCalendar = EXCHANGE_CALENDARS): string | null {
  const m = marketIndex(calendar, market);
  inRange(m, market, date);
  return m.earlyClose.get(date) ?? null;
}

/** Trading days from `from` to `to`, both inclusive. Usable as `MarketDay.openDates` in the fill simulator. */
export function tradingDays(
  market: Market,
  from: string,
  to: string,
  calendar: ExchangeCalendar = EXCHANGE_CALENDARS,
): Set<string> {
  const m = marketIndex(calendar, market);
  const start = inRange(m, market, from);
  const end = inRange(m, market, to);
  if (start > end) throw new Error(`${market}: range starts ${from}, after it ends ${to}`);
  const days = new Set<string>();
  for (let d = start; d <= end; d++) if (tradesOn(m, d)) days.add(isoFromDay(d));
  return days;
}

function step(market: Market, date: string, calendar: ExchangeCalendar, direction: -1 | 1): string {
  const m = marketIndex(calendar, market);
  for (let d = inRange(m, market, date) + direction; d >= m.from && d <= m.to; d += direction) {
    if (tradesOn(m, d)) return isoFromDay(d);
  }
  throw new Error(
    `${market} ${date}: no trading day ${direction < 0 ? "before" : "after"} it within the covered range ${m.fromDate} to ${m.toDate}`,
  );
}

/** The last trading day strictly before `date`. */
export function previousTradingDay(market: Market, date: string, calendar: ExchangeCalendar = EXCHANGE_CALENDARS): string {
  return step(market, date, calendar, -1);
}

/** The first trading day strictly after `date`. */
export function nextTradingDay(market: Market, date: string, calendar: ExchangeCalendar = EXCHANGE_CALENDARS): string {
  return step(market, date, calendar, 1);
}

/**
 * The newest daily bar that should exist when the job runs on `date` (the 08:30 job checks yesterday's bar):
 * the last trading day strictly before `date`.
 */
export function expectedLatestBar(market: Market, date: string, calendar: ExchangeCalendar = EXCHANGE_CALENDARS): string {
  return previousTradingDay(market, date, calendar);
}
