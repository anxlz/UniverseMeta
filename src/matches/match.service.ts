/**
 * Match scheduling lifecycle: register → confirm → (update | cancel).
 *
 * Confirmation is a hard gate (§4, §7.1): a match is not CONFIRMED until the *opposing*
 * captain confirms it. There is no toggle that skips this.
 */

import { and, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { auditLog, matches, teams, type Match, type Team } from "../db/schema";
import { getConfig } from "../lib/automation-config";
import { hoursBetween, parseSchedule } from "../lib/datetime";
import { fixturePairKey, newId, nextPublicMatchId } from "../lib/ids";
import { evaluateMatchCompliance } from "../compliance/compliance.service";
import type { ComplianceFlag } from "../db/schema";

export class MatchServiceError extends Error {}

export const MATCH_CATEGORIES = ["SCRIM", "OFFICIAL", "TOURNAMENT", "PRACTICE"] as const;
export type MatchCategory = (typeof MATCH_CATEGORIES)[number];

export interface RegisterMatchInput {
  guildId: string;
  homeTeamId: string;
  awayTeamId: string;
  category: MatchCategory;
  date: string;
  time: string;
  timeZoneOverride?: string | null;
  registeredBy: string;
}

export interface RegisteredMatch {
  match: Match;
  homeTeam: Team;
  awayTeam: Team;
  advanceNoticeWarning: string | null;
  /** Phase 4 — advisory only. Never empty-blocks registration. */
  complianceFlags: ComplianceFlag[];
}

function audit(
  guildId: string,
  matchId: string,
  action: string,
  actorDiscordId: string,
  newValue: unknown,
  oldValue: unknown = null,
): void {
  getDb()
    .insert(auditLog)
    .values({
      id: newId(),
      guildId,
      matchId,
      subjectType: "MATCH",
      subjectId: matchId,
      action,
      oldValue,
      newValue,
      actorDiscordId,
    })
    .run();
}

export function getMatchByPublicId(guildId: string, publicMatchId: string): Match | undefined {
  return getDb()
    .select()
    .from(matches)
    .where(
      and(eq(matches.guildId, guildId), eq(matches.publicMatchId, publicMatchId.trim().toUpperCase())),
    )
    .get();
}

export function getMatch(matchId: string): Match | undefined {
  return getDb().select().from(matches).where(eq(matches.id, matchId)).get();
}

export function registerMatch(input: RegisterMatchInput): RegisteredMatch {
  const db = getDb();

  if (input.homeTeamId === input.awayTeamId) {
    throw new MatchServiceError("A team cannot be scheduled against itself.");
  }

  const homeTeam = db.select().from(teams).where(eq(teams.id, input.homeTeamId)).get();
  const awayTeam = db.select().from(teams).where(eq(teams.id, input.awayTeamId)).get();
  if (!homeTeam || !awayTeam) throw new MatchServiceError("One of the teams could not be found.");
  if (!homeTeam.active || !awayTeam.active) {
    throw new MatchServiceError("Both teams must be active to schedule a match.");
  }

  const timeZone = input.timeZoneOverride?.trim() || getConfig(input.guildId, "league_timezone");
  const { utc } = parseSchedule(input.date, input.time, timeZone);

  const now = new Date();
  if (utc.getTime() <= now.getTime()) {
    throw new MatchServiceError("That kickoff time is already in the past.");
  }
  if (hoursBetween(now, utc) > 24 * 120) {
    throw new MatchServiceError("Matches cannot be scheduled more than 120 days ahead.");
  }

  /**
   * §7.1 / open item #3: the 24h rule flags staff, it does not block. Changing this to a
   * hard block is a one-line change here — throw instead of collecting a warning.
   */
  const noticeHours = getConfig(input.guildId, "advance_notice_hours");
  const noticeEnabled = getConfig(input.guildId, "advance_notice_enabled");
  const actualNotice = hoursBetween(now, utc);
  const noticeMet = !noticeEnabled || actualNotice >= noticeHours;
  const advanceNoticeWarning = noticeMet
    ? null
    : `Scheduled with ${actualNotice.toFixed(1)}h notice — the league minimum is ${noticeHours}h. Staff have been flagged; the match is still valid.`;

  const pairKey = fixturePairKey(input.homeTeamId, input.awayTeamId);
  const activeFixtureKey = `${pairKey}:${utc.getTime()}`;

  const duplicate = db
    .select({ publicMatchId: matches.publicMatchId })
    .from(matches)
    .where(and(eq(matches.guildId, input.guildId), eq(matches.activeFixtureKey, activeFixtureKey)))
    .get();
  if (duplicate) {
    throw new MatchServiceError(
      `That fixture is already registered as ${duplicate.publicMatchId}. Confirm or cancel it instead of registering a second copy.`,
    );
  }

  const matchId = newId();
  let publicMatchId = "";

  db.transaction((tx) => {
    publicMatchId = nextPublicMatchId(input.guildId, now);
    tx.insert(matches)
      .values({
        id: matchId,
        publicMatchId,
        guildId: input.guildId,
        category: input.category,
        homeTeamId: input.homeTeamId,
        awayTeamId: input.awayTeamId,
        scheduledAt: utc,
        scheduledTimezone: timeZone,
        pairKey,
        activeFixtureKey,
        scheduleStatus: "PENDING_CONFIRMATION",
        resultStatus: "AWAITING_SUBMISSION",
        advanceNoticeHours: noticeHours,
        advanceNoticeMet: noticeMet,
        registeredBy: input.registeredBy,
      })
      .run();
  });

  audit(input.guildId, matchId, "match_registered", input.registeredBy, {
    publicMatchId,
    homeTeamId: input.homeTeamId,
    awayTeamId: input.awayTeamId,
    scheduledAt: utc.toISOString(),
    advanceNoticeMet: noticeMet,
  });

  /**
   * Phase 4 runs after the match exists and cannot prevent it — flags are recorded for
   * staff and surfaced on the embed, never used to reject a registration (§4).
   */
  const complianceFlags = evaluateMatchCompliance({
    guildId: input.guildId,
    matchId,
    homeTeamId: input.homeTeamId,
    awayTeamId: input.awayTeamId,
    scheduledAt: utc,
  });

  return { match: getMatch(matchId)!, homeTeam, awayTeam, advanceNoticeWarning, complianceFlags };
}

/**
 * The hard gate. Only the away captain (or staff) may confirm, and only a match that is
 * still PENDING_CONFIRMATION.
 */
export function confirmMatch(
  guildId: string,
  matchId: string,
  actorDiscordId: string,
  actorIsStaff: boolean,
): Match {
  const db = getDb();
  const match = getMatch(matchId);
  if (!match || match.guildId !== guildId) throw new MatchServiceError("Match not found.");

  if (match.scheduleStatus === "CONFIRMED") {
    throw new MatchServiceError(`${match.publicMatchId} is already confirmed.`);
  }
  if (match.scheduleStatus !== "PENDING_CONFIRMATION") {
    throw new MatchServiceError(
      `${match.publicMatchId} is ${match.scheduleStatus.toLowerCase()} and can no longer be confirmed.`,
    );
  }
  if (match.scheduledAt.getTime() <= Date.now()) {
    throw new MatchServiceError(
      `${match.publicMatchId} was scheduled for a time that has already passed. Update the time or cancel it.`,
    );
  }

  const opponent = db.select().from(teams).where(eq(teams.id, match.awayTeamId)).get();
  if (!opponent) throw new MatchServiceError("Opposing team not found.");

  if (!actorIsStaff && opponent.captainDiscordId !== actorDiscordId) {
    throw new MatchServiceError(
      `Only the captain of ${opponent.name} can confirm this match. Staff can confirm on their behalf.`,
    );
  }

  const confirmedAt = new Date();
  db.update(matches)
    .set({ scheduleStatus: "CONFIRMED", confirmedBy: actorDiscordId, confirmedAt, updatedAt: confirmedAt })
    .where(eq(matches.id, matchId))
    .run();

  audit(guildId, matchId, "match_confirmed", actorDiscordId, {
    scheduleStatus: "CONFIRMED",
    onBehalfOfStaff: actorIsStaff && opponent.captainDiscordId !== actorDiscordId,
  }, { scheduleStatus: "PENDING_CONFIRMATION" });

  return getMatch(matchId)!;
}

export interface UpdateMatchInput {
  guildId: string;
  matchId: string;
  date?: string | null;
  time?: string | null;
  category?: MatchCategory | null;
  timeZoneOverride?: string | null;
  actorDiscordId: string;
}

export interface UpdatedMatch {
  match: Match;
  requiresReconfirmation: boolean;
}

/**
 * §7.1: allowed before ticket lock. Editing a CONFIRMED match drops it back to
 * PENDING_CONFIRMATION — otherwise one captain could move an agreed fixture unilaterally
 * and the confirmation on file would attest to a time nobody agreed to.
 */
export function updateMatch(input: UpdateMatchInput): UpdatedMatch {
  const db = getDb();
  const match = getMatch(input.matchId);
  if (!match || match.guildId !== input.guildId) throw new MatchServiceError("Match not found.");

  if (match.scheduleStatus === "CANCELLED") {
    throw new MatchServiceError(`${match.publicMatchId} is cancelled and cannot be edited.`);
  }
  if (match.ticketChannelId) {
    throw new MatchServiceError(
      `${match.publicMatchId} already has an open match ticket and is locked. Staff must cancel it to reschedule.`,
    );
  }
  if (match.resultStatus !== "AWAITING_SUBMISSION") {
    throw new MatchServiceError(
      `${match.publicMatchId} already has a result in progress and cannot be rescheduled.`,
    );
  }

  const changes: Partial<typeof matches.$inferInsert> = { updatedAt: new Date() };
  const before: Record<string, unknown> = {};
  let scheduleChanged = false;

  if (input.category && input.category !== match.category) {
    before.category = match.category;
    changes.category = input.category;
  }

  if (input.date || input.time) {
    const timeZone =
      input.timeZoneOverride?.trim() ||
      match.scheduledTimezone ||
      getConfig(input.guildId, "league_timezone");

    const currentLocal = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(match.scheduledAt);
    const part = (type: string) => currentLocal.find((p) => p.type === type)?.value ?? "00";

    const date = input.date ?? `${part("year")}-${part("month")}-${part("day")}`;
    const time = input.time ?? `${part("hour")}:${part("minute")}`;
    const { utc } = parseSchedule(date, time, timeZone);

    if (utc.getTime() <= Date.now()) {
      throw new MatchServiceError("That kickoff time is already in the past.");
    }

    if (utc.getTime() !== match.scheduledAt.getTime()) {
      const pairKey = match.pairKey;
      const nextFixtureKey = `${pairKey}:${utc.getTime()}`;
      const clash = db
        .select({ publicMatchId: matches.publicMatchId })
        .from(matches)
        .where(
          and(eq(matches.guildId, input.guildId), eq(matches.activeFixtureKey, nextFixtureKey)),
        )
        .get();
      if (clash) {
        throw new MatchServiceError(
          `These teams already have ${clash.publicMatchId} scheduled at that time.`,
        );
      }

      before.scheduledAt = match.scheduledAt.toISOString();
      changes.scheduledAt = utc;
      changes.scheduledTimezone = timeZone;
      changes.activeFixtureKey = nextFixtureKey;
      scheduleChanged = true;

      const noticeHours = getConfig(input.guildId, "advance_notice_hours");
      const noticeEnabled = getConfig(input.guildId, "advance_notice_enabled");
      changes.advanceNoticeHours = noticeHours;
      changes.advanceNoticeMet = !noticeEnabled || hoursBetween(new Date(), utc) >= noticeHours;
    }
  }

  if (Object.keys(before).length === 0) {
    throw new MatchServiceError("Nothing to change — supply a new date, time, or category.");
  }

  const reconfirm =
    scheduleChanged &&
    match.scheduleStatus === "CONFIRMED" &&
    getConfig(input.guildId, "reconfirm_after_update");

  if (reconfirm) {
    changes.scheduleStatus = "PENDING_CONFIRMATION";
    changes.confirmedBy = null;
    changes.confirmedAt = null;
  }

  db.update(matches).set(changes).where(eq(matches.id, input.matchId)).run();
  audit(input.guildId, input.matchId, "match_updated", input.actorDiscordId, changes, before);

  return { match: getMatch(input.matchId)!, requiresReconfirmation: reconfirm };
}

export function cancelMatch(
  guildId: string,
  matchId: string,
  actorDiscordId: string,
  reason: string | null,
): Match {
  const db = getDb();
  const match = getMatch(matchId);
  if (!match || match.guildId !== guildId) throw new MatchServiceError("Match not found.");
  if (match.scheduleStatus === "CANCELLED") {
    throw new MatchServiceError(`${match.publicMatchId} is already cancelled.`);
  }
  if (match.resultStatus === "COMPLETED") {
    throw new MatchServiceError(
      `${match.publicMatchId} is completed and has awarded points. Staff must reverse the result before cancelling.`,
    );
  }

  const cancelledAt = new Date();
  db.update(matches)
    .set({
      scheduleStatus: "CANCELLED",
      cancelledBy: actorDiscordId,
      cancelledAt,
      cancelReason: reason,
      // Frees the fixture slot so the teams can re-register the same date and time.
      activeFixtureKey: null,
      updatedAt: cancelledAt,
    })
    .where(eq(matches.id, matchId))
    .run();

  audit(guildId, matchId, "match_cancelled", actorDiscordId, {
    scheduleStatus: "CANCELLED",
    reason,
  }, { scheduleStatus: match.scheduleStatus });

  return getMatch(matchId)!;
}

export interface MatchHistoryRow {
  match: Match;
  homeTeam: Team;
  awayTeam: Team;
}

export interface MatchHistoryQuery {
  guildId: string;
  teamId?: string | null;
  statuses?: readonly Match["scheduleStatus"][];
  from?: Date | null;
  to?: Date | null;
  limit: number;
  offset: number;
}

export function queryMatchHistory(query: MatchHistoryQuery): {
  rows: MatchHistoryRow[];
  total: number;
} {
  const db = getDb();
  const conditions = [eq(matches.guildId, query.guildId)];
  if (query.teamId) {
    conditions.push(or(eq(matches.homeTeamId, query.teamId), eq(matches.awayTeamId, query.teamId))!);
  }
  if (query.statuses?.length) {
    conditions.push(inArray(matches.scheduleStatus, [...query.statuses]));
  }
  if (query.from) conditions.push(gte(matches.scheduledAt, query.from));
  if (query.to) conditions.push(lte(matches.scheduledAt, query.to));

  const where = and(...conditions);

  const total =
    db.select({ count: sql<number>`count(*)` }).from(matches).where(where).get()?.count ?? 0;

  const matchRows = db
    .select()
    .from(matches)
    .where(where)
    .orderBy(desc(matches.scheduledAt))
    .limit(query.limit)
    .offset(query.offset)
    .all();

  const teamIds = new Set<string>();
  for (const m of matchRows) {
    teamIds.add(m.homeTeamId);
    teamIds.add(m.awayTeamId);
  }
  const teamById = new Map<string, Team>();
  if (teamIds.size > 0) {
    for (const team of db.select().from(teams).where(inArray(teams.id, [...teamIds])).all()) {
      teamById.set(team.id, team);
    }
  }

  const rows = matchRows.flatMap((match) => {
    const homeTeam = teamById.get(match.homeTeamId);
    const awayTeam = teamById.get(match.awayTeamId);
    return homeTeam && awayTeam ? [{ match, homeTeam, awayTeam }] : [];
  });

  return { rows, total };
}

export function recordAnnouncement(
  matchId: string,
  channelId: string,
  messageId: string,
): void {
  getDb()
    .update(matches)
    .set({ announceChannelId: channelId, announceMessageId: messageId })
    .where(eq(matches.id, matchId))
    .run();
}
