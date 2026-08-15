/**
 * §19 / §9 of the source spec: missing slots, Streamer Mode slots, unreadable names and
 * ambiguous names all converge on one UNRESOLVED_PLAYER_SLOT concept with a reason.
 *
 * They share a workflow because they share a constraint: none of them may receive player
 * points automatically, even when the scoreboard row carries complete statistics (§8).
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import {
  auditLog,
  matches,
  players,
  unresolvedSlots,
  type Player,
  type UnresolvedReason,
  type UnresolvedSlot,
} from "../db/schema";
import { newId } from "../lib/ids";

export interface CreateSlotInput {
  matchId: string;
  teamId: string | null;
  reason: UnresolvedReason;
  side?: "left" | "right" | null;
  slot?: number | null;
  ocrName?: string | null;
  /** Statistics visible on the scoreboard, held against the slot until identity resolves. */
  heldKills?: number | null;
  heldDeaths?: number | null;
  heldAssists?: number | null;
  heldObjectiveTimeSeconds?: number | null;
}

export function createUnresolvedSlot(input: CreateSlotInput): UnresolvedSlot {
  const id = newId();
  getDb()
    .insert(unresolvedSlots)
    .values({
      id,
      matchId: input.matchId,
      teamId: input.teamId ?? null,
      reason: input.reason,
      side: input.side ?? null,
      slot: input.slot ?? null,
      ocrName: input.ocrName ?? null,
      heldKills: input.heldKills ?? null,
      heldDeaths: input.heldDeaths ?? null,
      heldAssists: input.heldAssists ?? null,
      heldObjectiveTimeSeconds: input.heldObjectiveTimeSeconds ?? null,
      status: "PENDING",
    })
    .run();

  return getDb().select().from(unresolvedSlots).where(eq(unresolvedSlots.id, id)).get()!;
}

export function listPendingSlots(matchId: string): UnresolvedSlot[] {
  return getDb()
    .select()
    .from(unresolvedSlots)
    .where(and(eq(unresolvedSlots.matchId, matchId), eq(unresolvedSlots.status, "PENDING")))
    .all();
}

export function listAllSlots(matchId: string): UnresolvedSlot[] {
  return getDb().select().from(unresolvedSlots).where(eq(unresolvedSlots.matchId, matchId)).all();
}

export function hasPendingSlots(matchId: string): boolean {
  return listPendingSlots(matchId).length > 0;
}

/**
 * Staff assign a registered player to a slot. This records the identity only — statistics
 * still go through the approval flow before any points exist (§25, §26).
 */
export function resolveSlot(
  slotId: string,
  playerId: string,
  staffDiscordId: string,
  stats: {
    kills: number;
    deaths: number;
    assists: number;
    objectiveTimeSeconds: number;
  },
): UnresolvedSlot {
  const db = getDb();
  const slot = db.select().from(unresolvedSlots).where(eq(unresolvedSlots.id, slotId)).get();
  if (!slot) throw new Error("Unresolved slot not found.");
  if (slot.status !== "PENDING") throw new Error("That slot has already been resolved.");

  const player = db.select().from(players).where(eq(players.id, playerId)).get();
  if (!player) throw new Error("Selected player is not registered.");

  for (const [label, value] of Object.entries(stats)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${label} must be a whole number of zero or more.`);
    }
  }

  // The slot only knows its match; the audit row needs the guild that match belongs to.
  const owningMatch = db
    .select({ guildId: matches.guildId })
    .from(matches)
    .where(eq(matches.id, slot.matchId))
    .get();

  const resolvedAt = new Date();
  db.update(unresolvedSlots)
    .set({
      resolvedPlayerId: playerId,
      resolvedBy: staffDiscordId,
      resolvedAt,
      status: "RESOLVED",
      heldKills: stats.kills,
      heldDeaths: stats.deaths,
      heldAssists: stats.assists,
      heldObjectiveTimeSeconds: stats.objectiveTimeSeconds,
    })
    .where(eq(unresolvedSlots.id, slotId))
    .run();

  db.insert(auditLog)
    .values({
      id: newId(),
      guildId: owningMatch?.guildId ?? "",
      matchId: slot.matchId,
      subjectType: "PLAYER",
      subjectId: playerId,
      action: `slot_resolved_${slot.reason.toLowerCase()}`,
      oldValue: { status: "PENDING", ocrName: slot.ocrName },
      newValue: { status: "RESOLVED", playerId, ...stats },
      actorDiscordId: staffDiscordId,
    })
    .run();

  return db.select().from(unresolvedSlots).where(eq(unresolvedSlots.id, slotId)).get()!;
}

/** Roster members not seen on the scoreboard — §22's "missing" case. */
export function findMissingRosterPlayers(roster: Player[], matchedPlayerIds: Set<string>): Player[] {
  return roster.filter((p) => !matchedPlayerIds.has(p.id));
}
