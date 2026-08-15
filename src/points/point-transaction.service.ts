/**
 * §26/§32/§37: points exist only as transactions, only after staff approval, and every
 * change is traceable.
 *
 * Nothing else in the codebase writes to point_transactions. Totals are always derived by
 * summing transactions rather than kept as a mutable counter, so a leaderboard can never
 * drift from the audit trail.
 */

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { auditLog, pointTransactions, matchPlayers, matches } from "../db/schema";
import { newId } from "../lib/ids";

export class PointTransactionError extends Error {}

export interface AwardInput {
  guildId: string;
  matchId: string;
  scoringVersion: string;
  approvedBy: string;
  team: { winnerTeamId: string; winnerPoints: number; loserTeamId: string; loserPoints: number };
}

/** Idempotency: a match's points may be written exactly once. */
function assertNotAlreadyAwarded(matchId: string): void {
  const existing = getDb()
    .select({ count: sql<number>`count(*)` })
    .from(pointTransactions)
    .where(eq(pointTransactions.matchId, matchId))
    .get();
  if ((existing?.count ?? 0) > 0) {
    throw new PointTransactionError(
      "Points have already been awarded for this match. Reverse them before re-awarding.",
    );
  }
}

export function awardMatchPoints(input: AwardInput): { teamRows: number; playerRows: number } {
  const db = getDb();
  assertNotAlreadyAwarded(input.matchId);

  const playerRows = db
    .select()
    .from(matchPlayers)
    .where(eq(matchPlayers.matchId, input.matchId))
    .all();

  if (playerRows.some((r) => r.isProvisional)) {
    throw new PointTransactionError(
      "Player scores are still provisional — resolve every pending slot before awarding points.",
    );
  }

  db.transaction((tx) => {
    for (const [teamId, points] of [
      [input.team.winnerTeamId, input.team.winnerPoints],
      [input.team.loserTeamId, input.team.loserPoints],
    ] as const) {
      tx.insert(pointTransactions)
        .values({
          id: newId(),
          matchId: input.matchId,
          teamId,
          points,
          pointType: "TEAM",
          scoringVersion: input.scoringVersion,
          reason: "match_result_approved",
        })
        .run();
    }

    for (const row of playerRows) {
      if (row.playerId === null || row.matchPoints === null) continue;
      tx.insert(pointTransactions)
        .values({
          id: newId(),
          matchId: input.matchId,
          playerId: row.playerId,
          teamId: row.teamId,
          points: row.matchPoints,
          pointType: "PLAYER",
          scoringVersion: input.scoringVersion,
          reason:
            row.statsSource === "MANUAL"
              ? "manual_missing_player_stats_approved"
              : "ocr_player_stats_approved",
        })
        .run();

      tx.update(matchPlayers)
        .set({ status: "APPROVED", approvedBy: input.approvedBy, approvedAt: new Date() })
        .where(eq(matchPlayers.id, row.id))
        .run();

      // §37: old → new, with the reason, version and staff member attached.
      tx.insert(auditLog)
        .values({
          id: newId(),
          guildId: input.guildId,
          matchId: input.matchId,
          subjectType: "PLAYER",
          subjectId: row.playerId,
          action: "points_awarded",
          oldValue: { points: null },
          newValue: { points: row.matchPoints },
          reason:
            row.statsSource === "MANUAL"
              ? "manual_missing_player_stats_approved"
              : "ocr_player_stats_approved",
          scoringVersion: input.scoringVersion,
          actorDiscordId: input.approvedBy,
        })
        .run();
    }
  });

  return { teamRows: 2, playerRows: playerRows.length };
}

/**
 * §40: historical results are never edited in place. A reversal writes compensating
 * transactions, so the ledger keeps both the original award and its withdrawal.
 */
export function reverseMatchPoints(
  guildId: string,
  matchId: string,
  actorDiscordId: string,
  reason: string,
): number {
  const db = getDb();
  const existing = db
    .select()
    .from(pointTransactions)
    .where(eq(pointTransactions.matchId, matchId))
    .all();

  const forward = existing.filter((t) => !t.reason.startsWith("reversal:"));
  const alreadyReversed = existing.filter((t) => t.reason.startsWith("reversal:"));
  if (forward.length === 0) throw new PointTransactionError("No points to reverse.");
  if (alreadyReversed.length > 0) {
    throw new PointTransactionError("These points have already been reversed.");
  }

  db.transaction((tx) => {
    for (const t of forward) {
      tx.insert(pointTransactions)
        .values({
          id: newId(),
          matchId,
          playerId: t.playerId,
          teamId: t.teamId,
          points: -t.points,
          pointType: t.pointType,
          scoringVersion: t.scoringVersion,
          reason: `reversal:${reason}`,
        })
        .run();
    }
    tx.insert(auditLog)
      .values({
        id: newId(),
        guildId,
        matchId,
        subjectType: "MATCH",
        subjectId: matchId,
        action: "points_reversed",
        oldValue: { transactions: forward.length },
        newValue: { reversed: forward.length },
        reason,
        actorDiscordId,
      })
      .run();
    tx.update(matches).set({ resultStatus: "REJECTED" }).where(eq(matches.id, matchId)).run();
  });

  return forward.length;
}

export function getTeamTotal(teamId: string): number {
  return (
    getDb()
      .select({ total: sql<number>`coalesce(sum(${pointTransactions.points}), 0)` })
      .from(pointTransactions)
      .where(and(eq(pointTransactions.teamId, teamId), eq(pointTransactions.pointType, "TEAM")))
      .get()?.total ?? 0
  );
}

export function getPlayerTotal(playerId: string): number {
  return (
    getDb()
      .select({ total: sql<number>`coalesce(sum(${pointTransactions.points}), 0)` })
      .from(pointTransactions)
      .where(eq(pointTransactions.playerId, playerId))
      .get()?.total ?? 0
  );
}
