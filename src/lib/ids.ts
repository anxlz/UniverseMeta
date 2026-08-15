/**
 * §5 of the source spec: a UUID for the internal key, a human-readable public ID for
 * Discord. The public ID is what appears in embeds, logs, point transactions and audit
 * records, so it must be unique and stable.
 */

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { matchIdCounters } from "../db/schema";

export function newId(): string {
  return crypto.randomUUID();
}

function utcDayKey(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("");
}

/**
 * CODM-YYYYMMDD-NNNNNN. The sequence is a persisted per-guild, per-day counter rather than
 * a row count, so deleting a match never causes a later match to reuse its ID.
 *
 * Must be called inside the same transaction as the match insert.
 */
export function nextPublicMatchId(guildId: string, at: Date = new Date()): string {
  const day = utcDayKey(at);
  const db = getDb();

  db.insert(matchIdCounters)
    .values({ guildId, day, seq: 1 })
    .onConflictDoUpdate({
      target: [matchIdCounters.guildId, matchIdCounters.day],
      set: { seq: sql`${matchIdCounters.seq} + 1` },
    })
    .run();

  const row = db
    .select({ seq: matchIdCounters.seq })
    .from(matchIdCounters)
    .where(and(eq(matchIdCounters.guildId, guildId), eq(matchIdCounters.day, day)))
    .get();

  return `CODM-${day}-${String(row?.seq ?? 1).padStart(6, "0")}`;
}

/**
 * Lowercase and strip punctuation, spacing and diacritics — used for team-name uniqueness
 * and the §7.6 normalized-name match step.
 *
 * Unicode-aware on purpose. An ASCII-only filter (`[^a-z0-9]`) reduces a purely Arabic or
 * Japanese team name to an empty string, which then fails the minimum-length check and
 * makes the league unusable for exactly the scripts §34 requires supporting. `\p{L}` and
 * `\p{N}` keep letters and digits in any script while still dropping brackets, spaces and
 * punctuation, so `xxALHAJE[7jj]` and `فريق الأسود` both normalize sensibly.
 */
export function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** Order-independent fixture key, so A-vs-B and B-vs-A collide as they should. */
export function fixturePairKey(teamIdA: string, teamIdB: string): string {
  return [teamIdA, teamIdB].sort().join("|");
}
