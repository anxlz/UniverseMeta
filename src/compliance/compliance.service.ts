/**
 * Phase 4 (§4): compliance flagging only. Flag-only, never blocking, off by default.
 *
 * Every function here records an observation for staff. None of them can prevent a match
 * being registered, confirmed, or completed — that is the whole point of the phase.
 */

import { and, eq, gte, lt, ne, or, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { complianceFlags, matches, type ComplianceFlag } from "../db/schema";
import { getConfig, getToggle } from "../lib/automation-config";
import { startOfIsoWeekUtc } from "../lib/datetime";
import { newId } from "../lib/ids";
import { logger } from "../lib/logger";

export interface ComplianceContext {
  guildId: string;
  matchId: string;
  homeTeamId: string;
  awayTeamId: string;
  scheduledAt: Date;
}

function raise(
  guildId: string,
  matchId: string | null,
  teamId: string | null,
  rule: ComplianceFlag["rule"],
  detail: string,
  weekStart: Date | null,
  severity: ComplianceFlag["severity"] = "WARN",
): ComplianceFlag {
  const id = newId();
  getDb()
    .insert(complianceFlags)
    .values({ id, guildId, matchId, teamId, rule, severity, detail, weekStart })
    .run();
  logger.info("compliance flag raised", { rule, matchId, teamId, detail });
  return getDb().select().from(complianceFlags).where(eq(complianceFlags.id, id)).get()!;
}

/** Confirmed, non-cancelled matches between two teams inside one ISO week. */
function countMeetingsThisWeek(
  guildId: string,
  teamA: string,
  teamB: string,
  weekStart: Date,
  excludeMatchId: string,
): number {
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 3_600_000);
  const pair = [teamA, teamB].sort().join("|");

  return (
    getDb()
      .select({ count: sql<number>`count(*)` })
      .from(matches)
      .where(
        and(
          eq(matches.guildId, guildId),
          eq(matches.pairKey, pair),
          ne(matches.id, excludeMatchId),
          ne(matches.scheduleStatus, "CANCELLED"),
          gte(matches.scheduledAt, weekStart),
          lt(matches.scheduledAt, weekEnd),
        ),
      )
      .get()?.count ?? 0
  );
}

function countTeamMatchesThisWeek(guildId: string, teamId: string, weekStart: Date): number {
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 3_600_000);
  return (
    getDb()
      .select({ count: sql<number>`count(*)` })
      .from(matches)
      .where(
        and(
          eq(matches.guildId, guildId),
          or(eq(matches.homeTeamId, teamId), eq(matches.awayTeamId, teamId)),
          ne(matches.scheduleStatus, "CANCELLED"),
          gte(matches.scheduledAt, weekStart),
          lt(matches.scheduledAt, weekEnd),
        ),
      )
      .get()?.count ?? 0
  );
}

/**
 * Runs at registration. Returns the flags raised so the embed can show them; returns an
 * empty array when the feature is off, which is the default.
 */
export function evaluateMatchCompliance(context: ComplianceContext): ComplianceFlag[] {
  if (!getToggle(context.guildId, "compliance_flagging")) return [];

  const weekStart = startOfIsoWeekUtc(context.scheduledAt);
  const raised: ComplianceFlag[] = [];

  const opponentLimit = getConfig(context.guildId, "compliance_opponent_limit");
  const meetings = countMeetingsThisWeek(
    context.guildId,
    context.homeTeamId,
    context.awayTeamId,
    weekStart,
    context.matchId,
  );
  if (opponentLimit > 0 && meetings + 1 > opponentLimit) {
    raised.push(
      raise(
        context.guildId,
        context.matchId,
        context.homeTeamId,
        "OPPONENT_LIMIT",
        `These teams are scheduled to meet ${meetings + 1} times this week; the league guideline is ${opponentLimit}.`,
        weekStart,
      ),
    );
  }

  const weeklyMax = getConfig(context.guildId, "compliance_weekly_series_max");
  for (const teamId of [context.homeTeamId, context.awayTeamId]) {
    const played = countTeamMatchesThisWeek(context.guildId, teamId, weekStart);
    if (weeklyMax > 0 && played > weeklyMax) {
      raised.push(
        raise(
          context.guildId,
          context.matchId,
          teamId,
          "WEEKLY_SERIES_MAX",
          `This team now has ${played} matches this week; the league guideline is ${weeklyMax}.`,
          weekStart,
        ),
      );
    }
  }

  return raised;
}

/** Run at the weekly boundary, when the minimum can finally be judged. */
export function evaluateWeeklyMinimums(guildId: string, weekStart: Date, teamIds: string[]): ComplianceFlag[] {
  if (!getToggle(guildId, "compliance_flagging")) return [];

  const minimum = getConfig(guildId, "compliance_weekly_series_min");
  if (minimum <= 0) return [];

  const raised: ComplianceFlag[] = [];
  for (const teamId of teamIds) {
    const played = countTeamMatchesThisWeek(guildId, teamId, weekStart);
    if (played < minimum) {
      raised.push(
        raise(
          guildId,
          null,
          teamId,
          "WEEKLY_SERIES_MIN",
          `This team played ${played} matches in the week starting ${weekStart.toISOString().slice(0, 10)}; the league guideline is at least ${minimum}.`,
          weekStart,
          "INFO",
        ),
      );
    }
  }
  return raised;
}

export function listOpenFlags(guildId: string, limit = 25): ComplianceFlag[] {
  return getDb()
    .select()
    .from(complianceFlags)
    .where(and(eq(complianceFlags.guildId, guildId), sql`${complianceFlags.acknowledgedAt} is null`))
    .orderBy(sql`${complianceFlags.createdAt} desc`)
    .limit(limit)
    .all();
}

export function acknowledgeFlag(flagId: string, staffDiscordId: string): void {
  getDb()
    .update(complianceFlags)
    .set({ acknowledgedBy: staffDiscordId, acknowledgedAt: new Date() })
    .where(eq(complianceFlags.id, flagId))
    .run();
}
