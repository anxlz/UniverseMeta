/**
 * §26: nothing is awarded on staff entering statistics. Entry creates a pending approval;
 * a second, explicit staff action approves it. That two-step is the only path to points.
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { approvals, auditLog, matches, type Approval, type Match } from "../db/schema";
import { newId } from "../lib/ids";
import { hasPendingSlots } from "../players/pending-player.service";
import { awardMatchPoints } from "../points/point-transaction.service";
import type { TeamScoringResult } from "../scoring/scoring.types";

export class ApprovalError extends Error {}

export function createApproval(
  matchId: string,
  kind: Approval["kind"],
  payload: unknown,
): Approval {
  const db = getDb();

  const open = db
    .select()
    .from(approvals)
    .where(and(eq(approvals.matchId, matchId), eq(approvals.status, "PENDING")))
    .get();
  if (open) return open;

  const id = newId();
  db.insert(approvals).values({ id, matchId, kind, payload, status: "PENDING" }).run();
  return db.select().from(approvals).where(eq(approvals.id, id)).get()!;
}

export function getPendingApproval(matchId: string): Approval | undefined {
  return getDb()
    .select()
    .from(approvals)
    .where(and(eq(approvals.matchId, matchId), eq(approvals.status, "PENDING")))
    .get();
}

export function recordApprovalMessage(approvalId: string, channelId: string, messageId: string): void {
  getDb().update(approvals).set({ channelId, messageId }).where(eq(approvals.id, approvalId)).run();
}

export interface ApproveResult {
  match: Match;
  teamRows: number;
  playerRows: number;
}

/**
 * The one place a match becomes COMPLETED. §12 and rule 28 both forbid it while any
 * required statistic or identity is unresolved, so that is checked here rather than trusted
 * from the caller.
 */
export function approveMatchResult(
  guildId: string,
  matchId: string,
  staffDiscordId: string,
): ApproveResult {
  const db = getDb();

  const match = db.select().from(matches).where(eq(matches.id, matchId)).get();
  if (!match) throw new ApprovalError("Match not found.");
  if (match.resultStatus === "COMPLETED") throw new ApprovalError("This match is already completed.");

  if (hasPendingSlots(matchId)) {
    throw new ApprovalError(
      "Some player identities or statistics are still unresolved. Resolve every pending slot before approving.",
    );
  }

  const breakdown = match.teamPointsBreakdown as TeamScoringResult | null;
  if (!breakdown || !match.scoringVersion) {
    throw new ApprovalError("This match has no calculated team scoring to approve.");
  }

  const approval = getPendingApproval(matchId);

  const counts = awardMatchPoints({
    guildId,
    matchId,
    scoringVersion: match.scoringVersion,
    approvedBy: staffDiscordId,
    team: {
      winnerTeamId: breakdown.winnerTeamId,
      winnerPoints: breakdown.winnerPoints,
      loserTeamId: breakdown.loserTeamId,
      loserPoints: breakdown.loserPoints,
    },
  });

  const now = new Date();
  db.transaction((tx) => {
    if (approval) {
      tx.update(approvals)
        .set({ status: "APPROVED", decidedBy: staffDiscordId, decidedAt: now })
        .where(eq(approvals.id, approval.id))
        .run();
    }
    tx.update(matches)
      .set({ resultStatus: "COMPLETED", processedAt: now, updatedAt: now })
      .where(eq(matches.id, matchId))
      .run();
    tx.insert(auditLog)
      .values({
        id: newId(),
        guildId,
        matchId,
        subjectType: "MATCH",
        subjectId: matchId,
        action: "match_approved",
        oldValue: { resultStatus: match.resultStatus },
        newValue: { resultStatus: "COMPLETED", ...counts },
        reason: "staff_approved_result",
        scoringVersion: match.scoringVersion,
        actorDiscordId: staffDiscordId,
      })
      .run();
  });

  return {
    match: db.select().from(matches).where(eq(matches.id, matchId)).get()!,
    ...counts,
  };
}

export function rejectMatchResult(
  guildId: string,
  matchId: string,
  staffDiscordId: string,
  note: string | null,
): Match {
  const db = getDb();
  const match = db.select().from(matches).where(eq(matches.id, matchId)).get();
  if (!match) throw new ApprovalError("Match not found.");
  if (match.resultStatus === "COMPLETED") {
    throw new ApprovalError(
      "This match is completed and has awarded points. Reverse the points instead of rejecting.",
    );
  }

  const approval = getPendingApproval(matchId);
  const now = new Date();

  db.transaction((tx) => {
    if (approval) {
      tx.update(approvals)
        .set({ status: "REJECTED", decidedBy: staffDiscordId, decidedAt: now, decisionNote: note })
        .where(eq(approvals.id, approval.id))
        .run();
    }
    tx.update(matches)
      .set({ resultStatus: "REJECTED", updatedAt: now })
      .where(eq(matches.id, matchId))
      .run();
    tx.insert(auditLog)
      .values({
        id: newId(),
        guildId,
        matchId,
        subjectType: "MATCH",
        subjectId: matchId,
        action: "match_rejected",
        oldValue: { resultStatus: match.resultStatus },
        newValue: { resultStatus: "REJECTED" },
        reason: note ?? "staff_rejected_result",
        actorDiscordId: staffDiscordId,
      })
      .run();
  });

  return db.select().from(matches).where(eq(matches.id, matchId)).get()!;
}
