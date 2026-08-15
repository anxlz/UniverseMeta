/**
 * The §7.5 / §40 pipeline, in one place:
 *
 *   submit → OCR → validate → resolve teams from Discord context → match players →
 *   team points → visible player performance → find missing → pending records →
 *   staff resolution → approval → point transactions → COMPLETED
 *
 * Two invariants run through all of it. Points exist only after staff approval (§26), and
 * OCR output is never authoritative — every number that lands in the database is computed
 * here, in TypeScript (§11, rule 4).
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import {
  auditLog,
  matchPlayers,
  matches,
  players,
  unresolvedSlots,
  type Match,
} from "../db/schema";
import { newId } from "../lib/ids";
import { logger } from "../lib/logger";
import { validateOcrResponse } from "../ocr/ocr-validator";
import type { OcrPlayer, OcrResponse } from "../ocr/ocr.types";
import { matchPlayerName } from "../players/player-matching.service";
import {
  createUnresolvedSlot,
  hasPendingSlots,
  listPendingSlots,
} from "../players/pending-player.service";
import { calculatePlayerPoints } from "../scoring/player-scoring.service";
import { calculateTeamPoints } from "../scoring/team-scoring.service";
import type { PlayerRawStats, TeamScoringResult } from "../scoring/scoring.types";
import { getRoster } from "../teams/team.service";

export class ResultProcessingError extends Error {}

export interface ProcessResultInput {
  match: Match;
  ocr: OcrResponse;
  /** Which registered team each scoreboard side maps to — from the Discord match record. */
  leftTeamId: string;
  rightTeamId: string;
  submittedBy: string;
  screenshotUrl: string | null;
}

export interface ProcessResultOutput {
  match: Match;
  teamScoring: TeamScoringResult;
  identifiedCount: number;
  pendingSlotCount: number;
  warnings: string[];
}

/**
 * §7.8 / §43: OCR reports LEFT and RIGHT only. Which real team each side is comes from the
 * match record created at registration — never from anything the model guessed.
 */
export function processOcrResult(input: ProcessResultInput): ProcessResultOutput {
  const db = getDb();
  const { match, ocr } = input;

  const validation = validateOcrResponse(ocr);
  if (!validation.valid || !ocr.match) {
    db.update(matches)
      .set({
        resultStatus: "VALIDATION_FAILED",
        rawOcrResponse: ocr,
        submittedBy: input.submittedBy,
        submittedAt: new Date(),
        screenshotUrl: input.screenshotUrl,
        updatedAt: new Date(),
      })
      .where(eq(matches.id, match.id))
      .run();

    throw new ResultProcessingError(
      `The scoreboard could not be read reliably: ${validation.issues.join("; ")}`,
    );
  }

  const ocrMatch = ocr.match;
  if (ocrMatch.leftScore === null || ocrMatch.rightScore === null || !ocrMatch.mode) {
    throw new ResultProcessingError("Validation passed but the score or mode is missing.");
  }

  // Team points are computed from the score alone, so Streamer Mode never affects them (§13).
  const teamScoring = calculateTeamPoints({
    mode: ocrMatch.mode,
    leftScore: ocrMatch.leftScore,
    rightScore: ocrMatch.rightScore,
    leftTeamId: input.leftTeamId,
    rightTeamId: input.rightTeamId,
  });

  const rosters = {
    left: getRoster(input.leftTeamId),
    right: getRoster(input.rightTeamId),
  };

  const matchedPlayerIds = { left: new Set<string>(), right: new Set<string>() };
  const identifiedRows: Array<{ ocr: OcrPlayer; playerId: string; teamId: string }> = [];

  // Clear any prior attempt so a resubmission does not double up rows.
  db.delete(matchPlayers).where(eq(matchPlayers.matchId, match.id)).run();
  db.delete(unresolvedSlots).where(eq(unresolvedSlots.matchId, match.id)).run();

  for (const side of ["left", "right"] as const) {
    const teamId = side === "left" ? input.leftTeamId : input.rightTeamId;
    const roster = rosters[side];

    for (const row of ocr.teams[side].players) {
      if (!row.rowPresent) continue;

      /**
       * §8/§18: a Streamer Mode row is never mapped to a registered player and never
       * scored automatically, even though its statistics are fully visible. The stats are
       * held against the slot until staff assign an identity.
       */
      if (row.identityStatus === "STREAMER_MODE_ANONYMOUS") {
        createUnresolvedSlot({
          matchId: match.id,
          teamId,
          reason: "STREAMER_MODE",
          side,
          slot: row.slot,
          ocrName: row.name,
          heldKills: row.kills,
          heldDeaths: row.deaths,
          heldAssists: row.assists,
          heldObjectiveTimeSeconds: row.objectiveTimeSeconds,
        });
        continue;
      }

      if (row.identityStatus === "OCR_UNREADABLE" || row.name === null) {
        createUnresolvedSlot({
          matchId: match.id,
          teamId,
          reason: "OCR_UNREADABLE",
          side,
          slot: row.slot,
          ocrName: row.name,
          heldKills: row.kills,
          heldDeaths: row.deaths,
          heldAssists: row.assists,
          heldObjectiveTimeSeconds: row.objectiveTimeSeconds,
        });
        continue;
      }

      const matched = matchPlayerName(row.name, roster);

      // §42: an ambiguous or merely-fuzzy name goes to staff, never to the closest guess.
      if (matched.player === null) {
        createUnresolvedSlot({
          matchId: match.id,
          teamId,
          reason: matched.ambiguous || matched.candidates.length > 0 ? "AMBIGUOUS" : "MISSING",
          side,
          slot: row.slot,
          ocrName: row.name,
          heldKills: row.kills,
          heldDeaths: row.deaths,
          heldAssists: row.assists,
          heldObjectiveTimeSeconds: row.objectiveTimeSeconds,
        });
        continue;
      }

      matchedPlayerIds[side].add(matched.player.id);
      identifiedRows.push({ ocr: row, playerId: matched.player.id, teamId });
    }

    // §22: roster members who never appeared on the scoreboard become pending records.
    for (const rosterPlayer of roster) {
      if (matchedPlayerIds[side].has(rosterPlayer.id)) continue;
      const alreadyPending = listPendingSlots(match.id).some(
        (s) => s.teamId === teamId && s.reason === "MISSING" && s.ocrName === rosterPlayer.ign,
      );
      if (alreadyPending) continue;

      createUnresolvedSlot({
        matchId: match.id,
        teamId,
        reason: "MISSING",
        side,
        slot: null,
        ocrName: rosterPlayer.ign,
      });
    }
  }

  /**
   * §27: population-relative normalization depends on the whole match population, so while
   * any slot is unresolved every player score is provisional and gets recalculated once
   * the population is complete.
   */
  const provisional = hasPendingSlots(match.id);

  const population: PlayerRawStats[] = identifiedRows.map((r) => ({
    playerKey: r.playerId,
    kills: r.ocr.kills,
    deaths: r.ocr.deaths,
    assists: r.ocr.assists,
    objectiveTimeSeconds: r.ocr.objectiveTimeSeconds,
  }));

  const scored = calculatePlayerPoints(population, provisional);
  const scoredByKey = new Map(scored.map((s) => [s.playerKey, s]));

  for (const row of identifiedRows) {
    const result = scoredByKey.get(row.playerId)!;
    db.insert(matchPlayers)
      .values({
        id: newId(),
        matchId: match.id,
        playerId: row.playerId,
        teamId: row.teamId,
        scoreboardSide: row.ocr.side,
        scoreboardPosition: row.ocr.slot,
        ocrName: row.ocr.name,
        identityStatus: "IDENTIFIED",
        kills: row.ocr.kills,
        deaths: row.ocr.deaths,
        assists: row.ocr.assists,
        objectiveTimeSeconds: row.ocr.objectiveTimeSeconds,
        contribution: row.ocr.contribution,
        rawScore: row.ocr.score,
        normalizedStats: result.normalized,
        performanceScore: Math.round(result.performanceScore),
        matchPoints: result.matchPoints,
        status: "OCR_CONFIRMED",
        isProvisional: provisional,
        statsSource: "OCR",
        objectiveStats: row.ocr.additionalStats ?? {},
      })
      .run();
  }

  const pendingCount = listPendingSlots(match.id).length;
  const resultStatus = ocrMatch.streamer_mode_enabled
    ? "PENDING_STREAMER_MODE_RESOLUTION"
    : pendingCount > 0
      ? "PENDING_MANUAL_STATS"
      : "PENDING_APPROVAL";

  const now = new Date();
  db.update(matches)
    .set({
      mode: ocrMatch.mode,
      map: ocrMatch.map,
      leftTeamId: input.leftTeamId,
      rightTeamId: input.rightTeamId,
      leftScore: ocrMatch.leftScore,
      rightScore: ocrMatch.rightScore,
      winnerTeamId: teamScoring.winnerTeamId,
      loserTeamId: teamScoring.loserTeamId,
      scoringVersion: teamScoring.scoringVersion,
      resultStatus,
      streamerModeEnabled: ocrMatch.streamer_mode_enabled,
      calibrationConfidence: teamScoring.confidence,
      // §29: raw, normalized and calculated data are kept as distinct records.
      rawOcrResponse: ocr,
      normalizedOcrData: { population, provisional },
      calculatedData: { players: scored },
      teamPointsBreakdown: teamScoring,
      submittedBy: input.submittedBy,
      submittedAt: now,
      screenshotUrl: input.screenshotUrl,
      updatedAt: now,
    })
    .where(eq(matches.id, match.id))
    .run();

  db.insert(auditLog)
    .values({
      id: newId(),
      guildId: match.guildId,
      matchId: match.id,
      subjectType: "MATCH",
      subjectId: match.id,
      action: "result_processed",
      newValue: {
        resultStatus,
        teamScoring,
        identified: identifiedRows.length,
        pending: pendingCount,
      },
      scoringVersion: teamScoring.scoringVersion,
      actorDiscordId: input.submittedBy,
    })
    .run();

  logger.info("result processed", {
    matchId: match.publicMatchId,
    resultStatus,
    identified: identifiedRows.length,
    pending: pendingCount,
    confidence: teamScoring.confidence,
  });

  return {
    match: db.select().from(matches).where(eq(matches.id, match.id)).get()!,
    teamScoring,
    identifiedCount: identifiedRows.length,
    pendingSlotCount: pendingCount,
    warnings: [...validation.warnings, ...teamScoring.notes],
  };
}

/**
 * §27: once every slot is resolved, the full population is rescored and the recalculation
 * is logged. Previously-awarded points are never silently altered — this runs before
 * approval, while nothing has been awarded yet.
 */
export function recalculateWithResolvedSlots(matchId: string, actorDiscordId: string): void {
  const db = getDb();
  const match = db.select().from(matches).where(eq(matches.id, matchId)).get();
  if (!match) throw new ResultProcessingError("Match not found.");

  const existing = db.select().from(matchPlayers).where(eq(matchPlayers.matchId, matchId)).all();
  const resolved = db
    .select()
    .from(unresolvedSlots)
    .where(and(eq(unresolvedSlots.matchId, matchId), eq(unresolvedSlots.status, "RESOLVED")))
    .all();

  const population: PlayerRawStats[] = [
    ...existing.map((row) => ({
      playerKey: row.playerId!,
      kills: row.kills,
      deaths: row.deaths,
      assists: row.assists,
      objectiveTimeSeconds: row.objectiveTimeSeconds,
    })),
    ...resolved.map((slot) => ({
      playerKey: slot.resolvedPlayerId!,
      kills: slot.heldKills,
      deaths: slot.heldDeaths,
      assists: slot.heldAssists,
      objectiveTimeSeconds: slot.heldObjectiveTimeSeconds,
    })),
  ];

  const stillPending = hasPendingSlots(matchId);
  const scored = calculatePlayerPoints(population, stillPending);
  const byKey = new Map(scored.map((s) => [s.playerKey, s]));

  for (const row of existing) {
    const result = byKey.get(row.playerId!);
    if (!result) continue;
    db.update(matchPlayers)
      .set({
        normalizedStats: result.normalized,
        performanceScore: Math.round(result.performanceScore),
        matchPoints: result.matchPoints,
        isProvisional: stillPending,
      })
      .where(eq(matchPlayers.id, row.id))
      .run();
  }

  // Materialise resolved slots as real match_player rows.
  for (const slot of resolved) {
    const result = byKey.get(slot.resolvedPlayerId!);
    if (!result) continue;

    const alreadyPresent = db
      .select({ id: matchPlayers.id })
      .from(matchPlayers)
      .where(
        and(eq(matchPlayers.matchId, matchId), eq(matchPlayers.playerId, slot.resolvedPlayerId!)),
      )
      .get();
    if (alreadyPresent) continue;

    db.insert(matchPlayers)
      .values({
        id: newId(),
        matchId,
        playerId: slot.resolvedPlayerId,
        teamId: slot.teamId,
        scoreboardSide: slot.side,
        scoreboardPosition: slot.slot,
        ocrName: slot.ocrName,
        identityStatus:
          slot.reason === "STREAMER_MODE" ? "STREAMER_MODE_ANONYMOUS" : "MISSING",
        kills: slot.heldKills,
        deaths: slot.heldDeaths,
        assists: slot.heldAssists,
        objectiveTimeSeconds: slot.heldObjectiveTimeSeconds,
        normalizedStats: result.normalized,
        performanceScore: Math.round(result.performanceScore),
        matchPoints: result.matchPoints,
        status: "PENDING_APPROVAL",
        isProvisional: stillPending,
        statsSource: "MANUAL",
        objectiveStats: {},
      })
      .run();
  }

  db.update(matches)
    .set({
      resultStatus: stillPending ? "PENDING_MANUAL_STATS" : "PENDING_APPROVAL",
      calculatedData: { players: scored },
      updatedAt: new Date(),
    })
    .where(eq(matches.id, matchId))
    .run();

  db.insert(auditLog)
    .values({
      id: newId(),
      guildId: match.guildId,
      matchId,
      subjectType: "MATCH",
      subjectId: matchId,
      action: "player_scores_recalculated",
      newValue: { populationSize: population.length, stillPending },
      reason: "slot_resolution_changed_population",
      scoringVersion: match.scoringVersion,
      actorDiscordId,
    })
    .run();
}

export function listMatchPlayers(matchId: string) {
  return getDb()
    .select({
      row: matchPlayers,
      ign: players.ign,
    })
    .from(matchPlayers)
    .leftJoin(players, eq(matchPlayers.playerId, players.id))
    .where(eq(matchPlayers.matchId, matchId))
    .all();
}
