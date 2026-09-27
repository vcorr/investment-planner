// Wall-clock time in a named time zone to a UTC instant, correct across daylight-saving changes.

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{2}):(\d{2})$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Milliseconds to add to UTC to get wall-clock time in `timeZone` at `instantMs`. */
function offsetMs(instantMs: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(instantMs))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const wall = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return wall - Math.floor(instantMs / 1000) * 1000;
}

/** Checks "YYYY-MM-DD" is a real calendar date and returns its parts. */
export function parseIsoDate(date: string): [number, number, number] {
  const m = DATE.exec(date);
  if (!m) throw new Error(`Date "${date}" is not YYYY-MM-DD`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (new Date(Date.UTC(y, mo - 1, d)).toISOString().slice(0, 10) !== date) throw new Error(`Date "${date}" is not a real date`);
  return [y, mo, d];
}

/**
 * The UTC instant at which clocks in `timeZone` show `date` and `time` ("HH:MM").
 * Throws for a wall-clock time that does not exist (skipped when clocks go forward) or happens twice
 * (when clocks go back), rather than picking one.
 */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const [y, mo, d] = parseIsoDate(date);
  const t = TIME.exec(time);
  if (!t || Number(t[1]) > 23 || Number(t[2]) > 59) throw new Error(`Time "${time}" is not HH:MM`);
  const wall = Date.UTC(y, mo - 1, d, Number(t[1]), Number(t[2]));
  // The zone's offset a day either side covers both offsets around any change on this date.
  const offsets = new Set([offsetMs(wall - 86_400_000, timeZone), offsetMs(wall + 86_400_000, timeZone)]);
  const instants = [...offsets].map((o) => wall - o).filter((i) => i + offsetMs(i, timeZone) === wall);
  const unique = [...new Set(instants)];
  if (unique.length === 0) throw new Error(`${date} ${time} does not exist in ${timeZone} (clocks go forward)`);
  if (unique.length > 1) throw new Error(`${date} ${time} happens twice in ${timeZone} (clocks go back)`);
  return new Date(unique[0]!);
}
