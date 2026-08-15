/**
 * Result submission and staff review (Phase 3).
 *
 * `/matchresult` routes through OCR when the toggle is on and the service is reachable,
 * and falls back to manual entry otherwise — the bot never fails closed on OCR
 * availability (§3, §7.2).
 */

import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import { getToggle } from "../lib/automation-config";
import { buildEmbed, field, replyError, successEmbed } from "../lib/embeds";
import { hasManagerPermission } from "../lib/permissions";
import { getMatchByPublicId } from "../matches/match.service";
import {
  ResultProcessingError,
  listMatchPlayers,
  processOcrResult,
  recalculateWithResolvedSlots,
} from "../matches/result.service";
import { OcrUnavailableError, extractScoreboard, isOcrConfigured } from "../ocr/paddleocr.service";
import { listPendingSlots } from "../players/pending-player.service";
import { ApprovalError, approveMatchResult, createApproval, rejectMatchResult } from "../approvals/approval.service";
import { reverseMatchPoints } from "../points/point-transaction.service";
import { calculateTeamPoints } from "../scoring/team-scoring.service";
import { getRoster, getTeam } from "../teams/team.service";
import {
  buildApprovalButtons,
  buildApprovalEmbed,
  buildResultEmbed,
  buildSlotResolutionComponents,
  buildSlotResolutionEmbed,
} from "../discord/result-embed.service";
import type { OcrGameMode } from "../ocr/ocr.types";
import type { CommandModule } from "./types";

const MODE_CHOICES = [
  { name: "Hardpoint", value: "hardpoint" },
  { name: "Search and Destroy", value: "search_and_destroy" },
  { name: "Control", value: "control" },
];

const matchResult = new SlashCommandBuilder()
  .setName("matchresult")
  .setDescription("Submit a scoreboard screenshot for a confirmed match")
  .addStringOption((o) => o.setName("match_id").setDescription("Match ID").setRequired(true))
  .addAttachmentOption((o) =>
    o.setName("screenshot").setDescription("Scoreboard screenshot").setRequired(true),
  )
  .addStringOption((o) =>
    o.setName("mode").setDescription("Game mode hint (optional)").addChoices(...MODE_CHOICES),
  );

const matchScore = new SlashCommandBuilder()
  .setName("matchscore")
  .setDescription("Enter a match score manually (staff — no OCR)")
  .addStringOption((o) => o.setName("match_id").setDescription("Match ID").setRequired(true))
  .addStringOption((o) =>
    o.setName("mode").setDescription("Game mode").setRequired(true).addChoices(...MODE_CHOICES),
  )
  .addIntegerOption((o) =>
    o.setName("home_score").setDescription("Home team score").setRequired(true).setMinValue(0),
  )
  .addIntegerOption((o) =>
    o.setName("away_score").setDescription("Away team score").setRequired(true).setMinValue(0),
  )
  .addStringOption((o) => o.setName("map").setDescription("Map name"));

const matchPending = new SlashCommandBuilder()
  .setName("matchpending")
  .setDescription("Show and resolve pending player slots for a match (staff)")
  .addStringOption((o) => o.setName("match_id").setDescription("Match ID").setRequired(true));

const matchApprove = new SlashCommandBuilder()
  .setName("matchapprove")
  .setDescription("Open the approval card for a match result (staff)")
  .addStringOption((o) => o.setName("match_id").setDescription("Match ID").setRequired(true));

const matchReverse = new SlashCommandBuilder()
  .setName("matchreverse")
  .setDescription("Reverse the points awarded for a completed match (staff)")
  .addStringOption((o) => o.setName("match_id").setDescription("Match ID").setRequired(true))
  .addStringOption((o) => o.setName("reason").setDescription("Why").setRequired(true).setMaxLength(200));

export const reviewCommands: CommandModule[] = [
  {
    data: matchResult,
    async execute(interaction: ChatInputCommandInteraction) {
      const member = interaction.member as GuildMember;
      const match = getMatchByPublicId(
        interaction.guildId!,
        interaction.options.getString("match_id", true),
      );
      if (!match) return replyError(interaction, "Match not found.");
      if (match.scheduleStatus !== "CONFIRMED") {
        return replyError(interaction, "Only confirmed matches can have results submitted.");
      }
      if (match.resultStatus === "COMPLETED") {
        return replyError(interaction, "This match is already completed.");
      }

      const homeTeam = getTeam(match.homeTeamId)!;
      const awayTeam = getTeam(match.awayTeamId)!;
      const participant =
        homeTeam.captainDiscordId === member.id || awayTeam.captainDiscordId === member.id;
      if (!participant && !hasManagerPermission(member)) {
        return replyError(
          interaction,
          "Only a participating captain or staff can submit a result for this match.",
        );
      }

      const attachment = interaction.options.getAttachment("screenshot", true);
      await interaction.deferReply();

      const ocrEnabled = getToggle(interaction.guildId!, "screenshot_ocr_pipeline");
      if (!ocrEnabled || !isOcrConfigured()) {
        return void (await interaction.editReply({
          embeds: [
            buildEmbed({
              title: "Screenshot Received",
              description:
                "OCR is not enabled on this server, so this result needs manual entry. Staff can record it with /matchscore.",
              fields: [
                field("Match", match.publicMatchId),
                field("Submitted by", `<@${member.id}>`),
              ],
            }),
          ],
        }));
      }

      try {
        const ocr = await extractScoreboard({
          imageUrl: attachment.url,
          matchId: match.publicMatchId,
          expectedMode: interaction.options.getString("mode"),
        });

        // §7.8: sides come from the match record on file, never from the model.
        const result = processOcrResult({
          match,
          ocr,
          leftTeamId: match.homeTeamId,
          rightTeamId: match.awayTeamId,
          submittedBy: member.id,
          screenshotUrl: attachment.url,
        });

        const pending = listPendingSlots(match.id);
        await interaction.editReply({
          embeds: [
            buildResultEmbed({
              match: result.match,
              homeTeam,
              awayTeam,
              scoring: result.teamScoring,
              pendingSlots: pending,
              warnings: result.warnings,
            }),
          ],
        });

        // §10: staff are alerted immediately, not at approval time.
        if (pending.length > 0) {
          await interaction.followUp({
            embeds: [buildSlotResolutionEmbed(result.match, pending)],
            components: buildSlotResolutionComponents(
              pending[0]!,
              getRoster(pending[0]!.teamId ?? match.homeTeamId),
            ),
          });
        }
      } catch (error) {
        if (error instanceof OcrUnavailableError) {
          return void (await interaction.editReply({
            embeds: [
              buildEmbed({
                title: "OCR Unavailable",
                description:
                  "The OCR service could not be reached, so this result falls back to manual entry. Staff can record it with /matchscore. The screenshot is still attached to this match.",
                fields: [field("Match", match.publicMatchId)],
              }),
            ],
          }));
        }
        if (error instanceof ResultProcessingError) {
          return void (await interaction.editReply({ content: error.message }));
        }
        throw error;
      }
    },
  },

  {
    data: matchScore,
    async execute(interaction: ChatInputCommandInteraction) {
      const member = interaction.member as GuildMember;
      if (!hasManagerPermission(member)) {
        return replyError(interaction, "Manual score entry is restricted to league staff.");
      }

      const match = getMatchByPublicId(
        interaction.guildId!,
        interaction.options.getString("match_id", true),
      );
      if (!match) return replyError(interaction, "Match not found.");
      if (match.resultStatus === "COMPLETED") {
        return replyError(interaction, "This match is already completed.");
      }

      const homeTeam = getTeam(match.homeTeamId)!;
      const awayTeam = getTeam(match.awayTeamId)!;
      const mode = interaction.options.getString("mode", true) as OcrGameMode;
      const homeScore = interaction.options.getInteger("home_score", true);
      const awayScore = interaction.options.getInteger("away_score", true);

      let scoring;
      try {
        scoring = calculateTeamPoints({
          mode,
          leftScore: homeScore,
          rightScore: awayScore,
          leftTeamId: match.homeTeamId,
          rightTeamId: match.awayTeamId,
        });
      } catch (error) {
        return replyError(interaction, error instanceof Error ? error.message : String(error));
      }

      const { getDb } = await import("../db/client");
      const { matches } = await import("../db/schema");
      const { eq } = await import("drizzle-orm");

      getDb()
        .update(matches)
        .set({
          mode,
          map: interaction.options.getString("map"),
          leftTeamId: match.homeTeamId,
          rightTeamId: match.awayTeamId,
          leftScore: homeScore,
          rightScore: awayScore,
          winnerTeamId: scoring.winnerTeamId,
          loserTeamId: scoring.loserTeamId,
          scoringVersion: scoring.scoringVersion,
          calibrationConfidence: scoring.confidence,
          teamPointsBreakdown: scoring,
          resultStatus: "PENDING_APPROVAL",
          submittedBy: member.id,
          submittedAt: new Date(),
          streamerModeEnabled: false,
          updatedAt: new Date(),
        })
        .where(eq(matches.id, match.id))
        .run();

      const updated = getMatchByPublicId(interaction.guildId!, match.publicMatchId)!;
      createApproval(match.id, "MATCH_RESULT", { scoring, source: "manual" });

      await interaction.reply({
        embeds: [
          buildResultEmbed({
            match: updated,
            homeTeam,
            awayTeam,
            scoring,
            pendingSlots: listPendingSlots(match.id),
            warnings: scoring.notes,
          }),
        ],
        components: buildApprovalButtons(match.id),
      });
    },
  },

  {
    data: matchPending,
    async execute(interaction: ChatInputCommandInteraction) {
      const member = interaction.member as GuildMember;
      if (!hasManagerPermission(member)) {
        return replyError(interaction, "Slot resolution is restricted to league staff.");
      }

      const match = getMatchByPublicId(
        interaction.guildId!,
        interaction.options.getString("match_id", true),
      );
      if (!match) return replyError(interaction, "Match not found.");

      const pending = listPendingSlots(match.id);
      if (pending.length === 0) {
        return void (await interaction.reply({
          embeds: [
            successEmbed("Nothing Pending", `Every player slot for ${match.publicMatchId} is resolved.`),
          ],
          flags: MessageFlags.Ephemeral,
        }));
      }

      const slot = pending[0]!;
      await interaction.reply({
        embeds: [buildSlotResolutionEmbed(match, pending)],
        components: buildSlotResolutionComponents(slot, getRoster(slot.teamId ?? match.homeTeamId)),
      });
    },
  },

  {
    data: matchApprove,
    async execute(interaction: ChatInputCommandInteraction) {
      const member = interaction.member as GuildMember;
      if (!hasManagerPermission(member)) {
        return replyError(interaction, "Approval is restricted to league staff.");
      }

      const match = getMatchByPublicId(
        interaction.guildId!,
        interaction.options.getString("match_id", true),
      );
      if (!match) return replyError(interaction, "Match not found.");
      if (!match.teamPointsBreakdown) {
        return replyError(interaction, "This match has no calculated result to approve yet.");
      }

      const pending = listPendingSlots(match.id);
      if (pending.length > 0) {
        return replyError(
          interaction,
          `${pending.length} player slot(s) still need resolving. Run /matchpending ${match.publicMatchId} first.`,
        );
      }

      recalculateWithResolvedSlots(match.id, member.id);
      const refreshed = getMatchByPublicId(interaction.guildId!, match.publicMatchId)!;
      const scoredPlayers = listMatchPlayers(match.id);
      const breakdown = refreshed.teamPointsBreakdown as ReturnType<typeof calculateTeamPoints>;
      createApproval(match.id, "MATCH_RESULT", { scoring: breakdown });

      const homeTeam = getTeam(match.homeTeamId)!;
      const awayTeam = getTeam(match.awayTeamId)!;
      const winner = breakdown.winnerTeamId === homeTeam.id ? homeTeam : awayTeam;
      const loser = breakdown.winnerTeamId === homeTeam.id ? awayTeam : homeTeam;

      await interaction.reply({
        embeds: [
          buildApprovalEmbed(
            refreshed,
            {
              players: scoredPlayers.length,
              teamPoints: `${winner.name} +${breakdown.winnerPoints} / ${loser.name} ${breakdown.loserPoints}`,
            },
            Boolean(refreshed.streamerModeEnabled),
          ),
        ],
        components: buildApprovalButtons(match.id),
      });
    },
  },

  {
    data: matchReverse,
    async execute(interaction: ChatInputCommandInteraction) {
      const member = interaction.member as GuildMember;
      if (!hasManagerPermission(member)) {
        return replyError(interaction, "Reversing points is restricted to league staff.");
      }

      const match = getMatchByPublicId(
        interaction.guildId!,
        interaction.options.getString("match_id", true),
      );
      if (!match) return replyError(interaction, "Match not found.");

      try {
        const count = reverseMatchPoints(
          interaction.guildId!,
          match.id,
          member.id,
          interaction.options.getString("reason", true),
        );
        await interaction.reply({
          embeds: [
            successEmbed(
              "Points Reversed",
              `${count} transaction(s) were reversed for ${match.publicMatchId}. The original award remains in the ledger for audit.`,
            ),
          ],
        });
      } catch (error) {
        if (error instanceof ApprovalError || error instanceof Error) {
          return replyError(interaction, error.message);
        }
        throw error;
      }
    },
  },
];

export { approveMatchResult, rejectMatchResult };
