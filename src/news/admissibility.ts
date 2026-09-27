import { zonedTimeToUtc } from "./time.js";

// Leakage rule (brief §8.6, §19): an item may enter the decision packet for cut-off T only if it was both
// released and fetched strictly before T. `fetched_at` guards against back-dated release times.
// The API's separate `published` time, when present, must also be before T (it equalled `releaseTime` on all
// 200 fixture items, V24, so this costs nothing and closes a gap if the two ever differ).

export interface TimedItem {
  releasedAt: Date;
  /** Our own clock: when the poller first stored the item. */
  fetchedAt: Date;
  publishedAt?: Date | null;
}

/** The daily decision cut-off, Helsinki wall-clock time (brief §18). */
export const DECISION_CUTOFF_HELSINKI = "09:15";

/**
 * True only if `releasedAt < cutoff`, `fetchedAt < cutoff` and, when set, `publishedAt < cutoff`.
 * An item stamped exactly at the cut-off is out.
 */
export function isAdmissible(item: TimedItem, cutoff: Date): boolean {
  const t = instant(cutoff, "cutoff");
  const published = item.publishedAt ?? null;
  return (
    instant(item.releasedAt, "releasedAt") < t &&
    instant(item.fetchedAt, "fetchedAt") < t &&
    (published === null || instant(published, "publishedAt") < t)
  );
}

/** The admissible items, in their original order. */
export function admissibleItems<T extends TimedItem>(items: readonly T[], cutoff: Date): T[] {
  return items.filter((item) => isAdmissible(item, cutoff));
}

/** Cut-off for a decision day: `helsinkiDate` at `time` ("HH:MM") in Europe/Helsinki, as a UTC instant. */
export function decisionCutoff(helsinkiDate: string, time: string = DECISION_CUTOFF_HELSINKI): Date {
  return zonedTimeToUtc(helsinkiDate, time, "Europe/Helsinki");
}

function instant(value: Date, name: string): number {
  const ms = value instanceof Date ? value.getTime() : Number.NaN;
  if (Number.isNaN(ms)) throw new Error(`Admissibility: ${name} is not a valid Date`);
  return ms;
}
