/**
 * §7.6 manual match management — independent of the OCR flow.
 *
 * `/matchadd` exists for matches that were never scheduled through the normal
 * register → confirm path: a backfill, a tournament game played off-platform, a correction.
 * It creates the match, the result and the scoring in one staff action, and — per §7.6 —
 * generates and returns the ID itself rather than asking staff to supply one.
 *
 * The output still lands in PENDING_APPROVAL, not COMPLETED: §26 admits no exception for
 * staff-entered results.
 */

import {
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { auditLog, matchPlayers, matches, pointTransactions, unresolvedSlots } from "../db/schema";
import { createApproval } from "../approvals/approval.service";
import { buildResultEmbed } from "../discord/result-embed.service";
import { buildApprovalButtons } from "../discord/result-embed.service";
import { DateTimeParseError, parseSchedule } from "../lib/datetime";
import { buildEmbed, field, replyError, successEmbed } from "../lib/embeds";
import { fixturePairKey, newId, nextPublicMatchId } from "../lib/ids";
import { getConfig } from "../lib/automation-config";
import { hasManagerPermission } from "../lib/permissions";
import {
  MATCH_CATEGORIES,
  MatchServiceError,
  getMatchByPublicId,
  type MatchCategory,
} from "../matches/match.service";
import { reverseMatchPoints } from "../points/point-transaction.service";
import { calculateTeamPoints } from "../scoring/team-scoring.service";
import { findTeamByName, getTeam, searchTeams } from "../teams/team.service";
import type { OcrGameMode } from "../ocr/ocr.types";
import type { CommandModule } from "./types";

const MODE_CHOICES = [
  { name: "Hardpoint", value: "hardpoint" },
  { name: "Search and Destroy", value: "search_and_destroy" },
  { name: "Control", value: "control" },
];

const CATEGORY_CHOICES = MATCH_CATEGORIES.map((c) => ({
  name: c.charAt(0) + c.slice(1).toLowerCase(),
  value: c,
}));

const matchAdd = new SlashCommandBuilder()
  .setName("matchadd")
  .setDescription("Record a completed match that was never scheduled (staff)")
  .addStringOption((o) =>
    o.setName("home_team").setDescription("Home team").setRequired(true).setAutocomplete(true),
  )
  .addStringOption((o) =>
    o.setName("away_team").setDescription("Away team").setRequired(true).setAutocomplete(true),
  )
  .addStringOption((o) =>
    o.setName("mode").setDescription("Game mode").setRequired(true).addChoices(...MODE_CHOICES),
  )
  .addIntegerOption((o) =>
    o.setName("home_score").setDescription("Home team score").setRequired(true).setMinValue(0),
  )
  .addIntegerOption((o) =>
    o.setName("away_score").setDescription("Away team score").setRequired(true).setMinValue(0),
  )
  .addStringOption((o) =>
    o.setName("category").setDescription("Match category").addChoices(...CATEGORY_CHOICES),
  )
  .addStringOption((o) => o.setName("map").setDescription("Map name"))
  .addStringOption((o) => o.setName("date").setDescription("Date played, YYYY-MM-DD"))
  .addStringOption((o) => o.setName("time").setDescription("Time played, HH:mm"));

const matchEdit = new SlashCommandBuilder()
  .setName("matchedit")
  .setDescription("Edit the recorded score or map of a match (staff)")
  .addStringOption((o) => o.setName("game_id").setDescription("Match ID").setRequired(true))
  .addIntegerOption((o) => o.setName("home_score").setDescription("Corrected home score").setMinValue(0))
  .addIntegerOption((o) => o.setName("away_score").setDescription("Corrected away score").setMinValue(0))
  .addStringOption((o) => o.setName("mode").setDescription("Corrected mode").addChoices(...MODE_CHOICES))
  .addStringOption((o) => o.setName("map").setDescription("Corrected map"))
  .addStringOption((o) =>
    o.setName("reason").setDescription("Why the correction is being made").setMaxLength(200),
  );

const matchDelete = new SlashCommandBuilder()
  .setName("matchdelete")
  .setDescription("Delete a match record (staff)")
  .addStringOption((o) => o.setName("game_id").setDescription("Match ID").setRequired(true))
  .addStringOption((o) =>
    o.setName("reason").setDescription("Why").setRequired(true).setMaxLength(200),
  );

async function autocompleteTeam(interaction: AutocompleteInteraction): Promise<void> {
  if (!interaction.guildId) return void interaction.respond([]);
  const results = searchTeams(interaction.guildId, interaction.options.getFocused(), 25);
  await interaction.respond(
    results.map((t) => ({ name: t.tag ? `${t.name} [${t.tag}]` : t.name, value: t.name })),
  );
}

export const manualMatchCommands: CommandModule[] = [
  {
    data: matchAdd,
    autocomplete: autocompleteTeam,
    async execute(interaction: ChatInputCommandInteraction) {
      const member = interaction.member as GuildMember;
      if (!hasManagerPermission(member)) {
        return replyError(interaction, "Manual match entry is restricted to league staff.");
      }

      const guildId = interaction.guildId!;
      const homeTeam = findTeamByName(guildId, interaction.options.getString("home_team", true));
      const awayTeam = findTeamByName(guildId, interaction.options.getString("away_team", true));
      if (!homeTeam || !awayTeam) return replyError(interaction, "One of those teams is not registered.");
      if (homeTeam.id === awayTeam.id) {
        return replyError(interaction, "A team cannot play itself.");
      }

      const mode = interaction.options.getString("mode", true) as OcrGameMode;
      const homeScore = interaction.options.getInteger("home_score", true);
      const awayScore = interaction.options.getInteger("away_score", true);

      let playedAt = new Date();
      const date = interaction.options.getString("date");
      const time = interaction.options.getString("time");
      if (date || time) {
        try {
          const timeZone = getConfig(guildId, "league_timezone");
          const now = new Intl.DateTimeFormat("en-CA", {
            timeZone,
            hourCycle: "h23",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          }).formatToParts(new Date());
          const part = (t: string) => now.find((p) => p.type === t)?.value ?? "00";
          playedAt = parseSchedule(
            date ?? `${part("year")}-${part("month")}-${part("day")}`,
            time ?? `${part("hour")}:${part("minute")}`,
            timeZone,
          ).utc;
        } catch (error) {
          if (error instanceof DateTimeParseError) return replyError(interaction, error.message);
          throw error;
        }
      }

      let scoring;
      try {
        scoring = calculateTeamPoints({
          mode,
          leftScore: homeScore,
          rightScore: awayScore,
          leftTeamId: homeTeam.id,
          rightTeamId: awayTeam.id,
        });
      } catch (error) {
        return replyError(interaction, error instanceof Error ? error.message : String(error));
      }

      const db = getDb();
      const matchId = newId();
      let publicMatchId = "";

      db.transaction((tx) => {
        publicMatchId = nextPublicMatchId(guildId, new Date());
        tx.insert(matches)
          .values({
            id: matchId,
            publicMatchId,
            guildId,
            mode,
            map: interaction.options.getString("map"),
            category:
              (interaction.options.getString("category") as MatchCategory | null) ?? "SCRIM",
            homeTeamId: homeTeam.id,
            awayTeamId: awayTeam.id,
            leftTeamId: homeTeam.id,
            rightTeamId: awayTeam.id,
            leftScore: homeScore,
            rightScore: awayScore,
            winnerTeamId: scoring.winnerTeamId,
            loserTeamId: scoring.loserTeamId,
            scheduledAt: playedAt,
            scheduledTimezone: getConfig(guildId, "league_timezone"),
            pairKey: fixturePairKey(homeTeam.id, awayTeam.id),
            // Backfilled matches never occupy a live fixture slot.
            activeFixtureKey: null,
            scheduleStatus: "CONFIRMED",
            resultStatus: "PENDING_APPROVAL",
            advanceNoticeHours: 0,
            advanceNoticeMet: true,
            registeredBy: member.id,
            confirmedBy: member.id,
            confirmedAt: new Date(),
            submittedBy: member.id,
            submittedAt: new Date(),
            streamerModeEnabled: false,
            scoringVersion: scoring.scoringVersion,
            calibrationConfidence: scoring.confidence,
            teamPointsBreakdown: scoring,
          })
          .run();
      });

      const created = getMatchByPublicId(guildId, publicMatchId)!;
      createApproval(matchId, "MATCH_RESULT", { scoring, source: "matchadd" });

      db.insert(auditLog)
        .values({
          id: newId(),
          guildId,
          matchId,
          subjectType: "MATCH",
          subjectId: matchId,
          action: "match_added_manually",
          newValue: { publicMatchId, homeScore, awayScore, mode },
          reason: "staff_backfill",
          scoringVersion: scoring.scoringVersion,
          actorDiscordId: member.id,
        })
        .run();

      await interaction.reply({
        content: `Match ID: ${publicMatchId}`,
        embeds: [
          buildResultEmbed({
            match: created,
            homeTeam,
            awayTeam,
            scoring,
            pendingSlots: [],
            warnings: [
              "Recorded manually. Player statistics were not captured — approve to award team points only, or add player stats first.",
              ...scoring.notes,
            ],
          }),
        ],
        components: buildApprovalButtons(matchId),
      });
    },
  },

  {
    data: matchEdit,
    async execute(interaction: ChatInputCommandInteraction) {
      const member = interaction.member as GuildMember;
      if (!hasManagerPermission(member)) {
        return replyError(interaction, "Editing a match is restricted to league staff.");
      }

      const guildId = interaction.guildId!;
      const match = getMatchByPublicId(guildId, interaction.options.getString("game_id", true));
      if (!match) return replyError(interaction, "No match with that ID.");

      /**
       * §40: a completed match has already awarded points, and editing it in place would
       * silently change history. Reverse first, then edit.
       */
      if (match.resultStatus === "COMPLETED") {
        return replyError(
          interaction,
          `${match.publicMatchId} is completed and has awarded points. Run /matchreverse ${match.publicMatchId} first, then edit.`,
        );
      }

      const homeScore = interaction.options.getInteger("home_score") ?? match.leftScore;
      const awayScore = interaction.options.getInteger("away_score") ?? match.rightScore;
      const mode = (interaction.options.getString("mode") as OcrGameMode | null) ?? match.mode;
      const map = interaction.options.getString("map") ?? match.map;

      if (homeScore === null || awayScore === null || !mode) {
        return replyError(
          interaction,
          "This match has no recorded score yet — supply mode, home_score and away_score.",
        );
      }

      let scoring;
      try {
        scoring = calculateTeamPoints({
          mode,
          leftScore: homeScore,
          rightScore: awayScore,
          leftTeamId: match.leftTeamId ?? match.homeTeamId,
          rightTeamId: match.rightTeamId ?? match.awayTeamId,
        });
      } catch (error) {
        return replyError(interaction, error instanceof Error ? error.message : String(error));
      }

      const db = getDb();
      db.update(matches)
        .set({
          mode,
          map,
          leftScore: homeScore,
          rightScore: awayScore,
          winnerTeamId: scoring.winnerTeamId,
          loserTeamId: scoring.loserTeamId,
          scoringVersion: scoring.scoringVersion,
          calibrationConfidence: scoring.confidence,
          teamPointsBreakdown: scoring,
          resultStatus: "PENDING_APPROVAL",
          updatedAt: new Date(),
        })
        .where(eq(matches.id, match.id))
        .run();

      db.insert(auditLog)
        .values({
          id: newId(),
          guildId,
          matchId: match.id,
          subjectType: "MATCH",
          subjectId: match.id,
          action: "match_edited",
          oldValue: { leftScore: match.leftScore, rightScore: match.rightScore, mode: match.mode },
          newValue: { leftScore: homeScore, rightScore: awayScore, mode },
          reason: interaction.options.getString("reason") ?? "staff_correction",
          scoringVersion: scoring.scoringVersion,
          actorDiscordId: member.id,
        })
        .run();

      const updated = getMatchByPublicId(guildId, match.publicMatchId)!;
      await interaction.reply({
        embeds: [
          buildResultEmbed({
            match: updated,
            homeTeam: getTeam(match.homeTeamId)!,
            awayTeam: getTeam(match.awayTeamId)!,
            scoring,
            pendingSlots: [],
            warnings: ["Corrected by staff — re-approve to award the revised points.", ...scoring.notes],
          }),
        ],
        components: buildApprovalButtons(match.id),
      });
    },
  },

  {
    data: matchDelete,
    async execute(interaction: ChatInputCommandInteraction) {
      const member = interaction.member as GuildMember;
      if (!hasManagerPermission(member)) {
        return replyError(interaction, "Deleting a match is restricted to league staff.");
      }

      const guildId = interaction.guildId!;
      const match = getMatchByPublicId(guildId, interaction.options.getString("game_id", true));
      if (!match) return replyError(interaction, "No match with that ID.");

      const reason = interaction.options.getString("reason", true);
      const db = getDb();

      /**
       * Awarded points are reversed rather than deleted — the ledger keeps both the award
       * and its withdrawal (§40), so a deleted match still has a traceable history.
       */
      const awarded = db
        .select({ id: pointTransactions.id })
        .from(pointTransactions)
        .where(eq(pointTransactions.matchId, match.id))
        .all();
      if (awarded.length > 0) {
        try {
          reverseMatchPoints(guildId, match.id, member.id, `match_deleted: ${reason}`);
        } catch (error) {
          return replyError(
            interaction,
            error instanceof Error ? error.message : "Could not reverse this match's points.",
          );
        }
      }

      db.insert(auditLog)
        .values({
          id: newId(),
          guildId,
          matchId: match.id,
          subjectType: "MATCH",
          subjectId: match.id,
          action: "match_deleted",
          oldValue: {
            publicMatchId: match.publicMatchId,
            leftScore: match.leftScore,
            rightScore: match.rightScore,
            resultStatus: match.resultStatus,
          },
          newValue: null,
          reason,
          actorDiscordId: member.id,
        })
        .run();

      db.transaction((tx) => {
        tx.delete(matchPlayers).where(eq(matchPlayers.matchId, match.id)).run();
        tx.delete(unresolvedSlots).where(eq(unresolvedSlots.matchId, match.id)).run();
        tx.update(matches)
          .set({
            scheduleStatus: "CANCELLED",
            resultStatus: "REJECTED",
            activeFixtureKey: null,
            cancelledBy: member.id,
            cancelledAt: new Date(),
            cancelReason: `deleted: ${reason}`,
            updatedAt: new Date(),
          })
          .where(eq(matches.id, match.id))
          .run();
      });

      await interaction.reply({
        embeds: [
          successEmbed(
            "Match Deleted",
            `${match.publicMatchId} was removed from active records.${awarded.length > 0 ? " Its points were reversed." : ""} The audit trail and point ledger are retained.`,
          ),
        ],
      });
    },
  },
];

export function manualMatchHelp() {
  return buildEmbed({
    title: "Manual Match Management",
    description:
      "These commands operate independently of the OCR flow. /matchadd generates the match ID for you.",
    fields: [
      field("Add", "/matchadd — record a match that was never scheduled", false),
      field("Edit", "/matchedit — correct a recorded score", false),
      field("Delete", "/matchdelete — remove a match, reversing any points", false),
    ],
  });
}
