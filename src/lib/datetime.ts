/**
 * Wall-clock ⇄ UTC conversion for match scheduling.
 *
 * `/matchregister` takes a date and a time but no offset, so those are wall-clock values in
 * some zone. The zone comes from `league_timezone` in AutomationConfig (or a per-command
 * override). Everything is stored as UTC; the originating zone is stored alongside so the
 * embed can render the time the captain actually typed.
 *
 * Conversion is done with Intl rather than a tz library — the algorithm is small, has no
 * dependency to keep current, and the two-pass form below is correct across DST boundaries.
 */

export class DateTimeParseError extends Error {}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{1,2}):(\d{2})$/;

/** Offset of `timeZone` from UTC, in ms, at the instant `date`. */
function offsetMsAt(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const f: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") f[part.type] = Number(part.value);
  }

  const asIfUtc = Date.UTC(f.year!, f.month! - 1, f.day!, f.hour!, f.minute!, f.second!);
  return asIfUtc - date.getTime();
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * Interpret a wall-clock date/time in `timeZone` and return the UTC instant.
 *
 * Two passes: the first guesses the offset using the naive instant, the second corrects it
 * using the guess. This resolves times near a DST transition, where the offset that applies
 * depends on the answer you are trying to compute.
 */
export function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstPass = naive - offsetMsAt(new Date(naive), timeZone);
  const secondPass = naive - offsetMsAt(new Date(firstPass), timeZone);
  return new Date(secondPass);
}

export interface ParsedSchedule {
  utc: Date;
  timeZone: string;
}

/**
 * @param date `YYYY-MM-DD`
 * @param time `HH:mm` (24-hour)
 */
export function parseSchedule(date: string, time: string, timeZone: string): ParsedSchedule {
  if (!isValidTimeZone(timeZone)) {
    throw new DateTimeParseError(`Unknown timezone: ${timeZone}`);
  }

  const dateMatch = DATE_PATTERN.exec(date.trim());
  if (!dateMatch) {
    throw new DateTimeParseError("Date must be in YYYY-MM-DD format, e.g. 2026-08-22.");
  }
  const timeMatch = TIME_PATTERN.exec(time.trim());
  if (!timeMatch) {
    throw new DateTimeParseError("Time must be in 24-hour HH:mm format, e.g. 20:30.");
  }

  const [, y, mo, d] = dateMatch.map(Number) as [unknown, number, number, number];
  const [, h, mi] = timeMatch.map(Number) as [unknown, number, number];

  if (mo < 1 || mo > 12) throw new DateTimeParseError("Month must be between 01 and 12.");
  if (d < 1 || d > 31) throw new DateTimeParseError("Day must be between 01 and 31.");
  if (h > 23) throw new DateTimeParseError("Hour must be between 00 and 23.");
  if (mi > 59) throw new DateTimeParseError("Minute must be between 00 and 59.");

  const utc = zonedWallClockToUtc(y, mo, d, h, mi, timeZone);

  // Guards against 2026-02-31 silently rolling into March.
  const roundTrip = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(utc);
  if (roundTrip !== `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`) {
    throw new DateTimeParseError(`${date} is not a real calendar date.`);
  }

  return { utc, timeZone };
}

/** Discord's own timestamp markup — renders in each viewer's local zone automatically. */
export function discordTimestamp(date: Date, style: "f" | "F" | "R" | "t" = "F"): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

export function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 3_600_000;
}

/** Monday 00:00 UTC of the week containing `reference` — the weekly-series boundary. */
export function startOfIsoWeekUtc(reference: Date): Date {
  const d = new Date(
    Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate()),
  );
  const dayOfWeek = d.getUTCDay(); // 0 = Sunday
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  return d;
}
