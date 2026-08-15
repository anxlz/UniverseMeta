/**
 * Phase 2-4 interaction handlers: application flow, slot resolution modals, approval
 * buttons, and the leaderboard view switch.
 *
 * Kept separate from router.ts so the Phase 1 dispatch stays readable, but every handler
 * here obeys the same §5 rule — a component interaction edits the message it came from.
 */

import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type GuildMember,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { getConfig } from "../lib/automation-config";
import { buildEmbed, field, replyError, successEmbed, updateInPlace } from "../lib/embeds";
import { hasManagerPermission } from "../lib/permissions";
import {
  ApplicationError,
  addApplicationPlayer,
  approveApplication,
  getApplication,
  listApplicationPlayers,
  recordReviewMessage,
  rejectApplication,
  startApplication,
  submitApplication,
} from "../applications/application.service";
import { APPLICATION_BUTTONS } from "../commands/application.commands";
import { LEADERBOARD_BUTTONS, renderLeaderboard } from "../commands/leaderboard.commands";
import {
  RESULT_BUTTONS,
  buildResultEmbed,
  buildSlotResolutionComponents,
  buildSlotResolutionEmbed,
} from "../discord/result-embed.service";
import { ApprovalError, approveMatchResult, rejectMatchResult } from "../approvals/approval.service";
import { getMatch } from "../matches/match.service";
import { recalculateWithResolvedSlots } from "../matches/result.service";
import { listPendingSlots, resolveSlot } from "../players/pending-player.service";
import { getRoster, getTeam } from "../teams/team.service";
import type { Region } from "../teams/team.service";
import type { TeamScoringResult } from "../scoring/scoring.types";
import { logger } from "../lib/logger";

/* ------------------------------------------------------------------ *
 * Applications
 * ------------------------------------------------------------------ */

const APPLY_MODAL = "app:modal";
const APPLY_PLAYER_MODAL = "app:playermodal";

function applicationModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(APPLY_MODAL)
    .setTitle("Team Application")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("team_name")
          .setLabel("Team name")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(64),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("region")
          .setLabel("Region (NA, SA, EU, ME, AFRICA, INDIA...)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(10),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("tier")
          .setLabel("Tier or division")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(32),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("logo_url")
          .setLabel("Logo image URL")
          .setStyle(TextInputStyle.Short)
          .setRequired(false),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("captain_ign")
          .setLabel("Your in-game name (captain)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(32),
      ),
    );
}

/** Roster entry: one modal collects up to four players, since Discord caps rows at five. */
function playerModal(applicationId: string): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`${APPLY_PLAYER_MODAL}:${applicationId}`)
    .setTitle("Add Roster Players");

  for (let i = 1; i <= 4; i += 1) {
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(`player_${i}`)
          .setLabel(`Player ${i} — IGN and UID`)
          .setPlaceholder("7Suro, 1234567890")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(80),
      ),
    );
  }
  return modal;
}

async function handleApplicationButton(interaction: ButtonInteraction): Promise<void> {
  const [namespace, action, ...rest] = interaction.customId.split(":");
  const prefix = `${namespace}:${action}`;
  const member = interaction.member as GuildMember;

  if (prefix === APPLICATION_BUTTONS.start) {
    return interaction.showModal(applicationModal());
  }

  if (prefix === APPLICATION_BUTTONS.approve || prefix === APPLICATION_BUTTONS.reject) {
    if (!hasManagerPermission(member)) {
      return replyError(interaction, "Only league staff can review applications.");
    }

    const applicationId = rest[0]!;
    try {
      if (prefix === APPLICATION_BUTTONS.approve) {
        const { application, teamId } = approveApplication(applicationId, member.id);
        const team = getTeam(teamId)!;

        await updateInPlace(interaction, {
          embeds: [
            successEmbed(
              `Application ${application.publicRef} Approved`,
              `${team.name} is now registered with ${getRoster(teamId).length} players.`,
            ),
          ],
          components: [],
        });

        // §13 open item 4: applicants are told the outcome rather than left guessing.
        try {
          const user = await interaction.client.users.fetch(application.applicantDiscordId);
          await user.send({
            embeds: [
              successEmbed(
                "Application Approved",
                `Your team "${application.teamName}" has been approved and is now registered.`,
              ),
            ],
          });
        } catch {
          logger.info("applicant has DMs closed", { applicationId });
        }
        return;
      }

      const application = rejectApplication(applicationId, member.id, "Rejected by staff");
      await updateInPlace(interaction, {
        embeds: [
          buildEmbed({
            title: `Application ${application.publicRef} Rejected`,
            description: `${application.teamName} was not approved.`,
          }),
        ],
        components: [],
      });

      try {
        const user = await interaction.client.users.fetch(application.applicantDiscordId);
        await user.send({
          embeds: [
            buildEmbed({
              title: "Application Not Approved",
              description: `Your application for "${application.teamName}" was not approved. Contact league staff if you would like to know more.`,
            }),
          ],
        });
      } catch {
        logger.info("applicant has DMs closed", { applicationId });
      }
    } catch (error) {
      if (error instanceof ApplicationError) return replyError(interaction, error.message);
      throw error;
    }
  }
}

export async function handleApplicationModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (interaction.customId === APPLY_MODAL) {
    try {
      const application = startApplication({
        guildId: interaction.guildId!,
        applicantDiscordId: interaction.user.id,
        teamName: interaction.fields.getTextInputValue("team_name"),
        region: interaction.fields.getTextInputValue("region")?.toUpperCase() || null,
        tier: interaction.fields.getTextInputValue("tier") || null,
        logoUrl: interaction.fields.getTextInputValue("logo_url") || null,
      });

      addApplicationPlayer(
        application.id,
        interaction.fields.getTextInputValue("captain_ign"),
        null,
        interaction.user.id,
        true,
      );

      await interaction.reply({
        embeds: [
          buildEmbed({
            title: `Application ${application.publicRef} Started`,
            description:
              "Your details are saved. Add the rest of your roster next — you can list up to four players at a time.",
            fields: [field("Team", application.teamName), field("Captain", "Recorded")],
          }),
        ],
        components: [
          new ActionRowBuilder<import("discord.js").ButtonBuilder>().addComponents(
            new (await import("discord.js")).ButtonBuilder()
              .setCustomId(`app:addplayers:${application.id}`)
              .setLabel("Add Players")
              .setStyle(1),
            new (await import("discord.js")).ButtonBuilder()
              .setCustomId(`app:submit:${application.id}`)
              .setLabel("Submit Application")
              .setStyle(3),
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      if (error instanceof ApplicationError) {
        return void (await interaction.reply({
          content: error.message,
          flags: MessageFlags.Ephemeral,
        }));
      }
      throw error;
    }
    return;
  }

  if (interaction.customId.startsWith(APPLY_PLAYER_MODAL)) {
    const applicationId = interaction.customId.split(":")[2]!;
    const added: string[] = [];
    const skipped: string[] = [];

    for (let i = 1; i <= 4; i += 1) {
      const raw = interaction.fields.getTextInputValue(`player_${i}`)?.trim();
      if (!raw) continue;
      const [ign, uid] = raw.split(",").map((part) => part.trim());
      if (!ign) continue;
      try {
        addApplicationPlayer(applicationId, ign, uid ?? null, null, false);
        added.push(ign);
      } catch (error) {
        skipped.push(`${ign} (${error instanceof Error ? error.message : "error"})`);
      }
    }

    const roster = listApplicationPlayers(applicationId);
    await interaction.reply({
      embeds: [
        buildEmbed({
          title: "Roster Updated",
          description: added.length > 0 ? `Added: ${added.join(", ")}` : "No players were added.",
          fields: [
            field("Roster size", String(roster.length)),
            ...(skipped.length > 0 ? [field("Skipped", skipped.join("\n"), false)] : []),
          ],
        }),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Slot resolution statistics (§25).
  if (interaction.customId.startsWith("slot:stats")) {
    const slotId = interaction.customId.split(":")[2]!;
    const playerId = interaction.customId.split(":")[3]!;

    const parse = (key: string): number => {
      const value = Number(interaction.fields.getTextInputValue(key).trim());
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${key} must be a whole number of zero or more.`);
      }
      return value;
    };

    try {
      const stats = {
        objectiveTimeSeconds: parse("obj"),
        kills: parse("kills"),
        deaths: parse("deaths"),
        assists: parse("assists"),
      };
      const slot = resolveSlot(slotId, playerId, interaction.user.id, stats);
      recalculateWithResolvedSlots(slot.matchId, interaction.user.id);

      const remaining = listPendingSlots(slot.matchId);
      const match = getMatch(slot.matchId)!;

      await interaction.reply({
        embeds: [
          successEmbed(
            "Slot Resolved",
            remaining.length > 0
              ? `${remaining.length} slot(s) still pending for ${match.publicMatchId}. Points are awarded only after every slot is resolved and staff approve.`
              : `Every slot for ${match.publicMatchId} is resolved. Run /matchapprove ${match.publicMatchId} to review and award points.`,
          ),
        ],
        components:
          remaining.length > 0
            ? buildSlotResolutionComponents(
                remaining[0]!,
                getRoster(remaining[0]!.teamId ?? match.homeTeamId),
              )
            : [],
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      await interaction.reply({
        content: error instanceof Error ? error.message : String(error),
        flags: MessageFlags.Ephemeral,
      });
    }
  }
}

/* ------------------------------------------------------------------ *
 * Slot resolution select menu
 * ------------------------------------------------------------------ */

export async function handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
  const member = interaction.member as GuildMember;

  if (interaction.customId.startsWith(RESULT_BUTTONS.selectPlayer)) {
    if (!hasManagerPermission(member)) {
      return replyError(interaction, "Only league staff can resolve player identities.");
    }

    const slotId = interaction.customId.split(":")[2]!;
    const playerId = interaction.values[0]!;

    // §25: identity first, then statistics, then approval. Never all at once.
    const modal = new ModalBuilder()
      .setCustomId(`slot:stats:${slotId}:${playerId}`)
      .setTitle("Enter Player Statistics")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("obj")
            .setLabel("Objective time (seconds)")
            .setPlaceholder("80")
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("kills")
            .setLabel("Kills")
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("deaths")
            .setLabel("Deaths")
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("assists")
            .setLabel("Assists")
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
      );

    await interaction.showModal(modal);
  }
}

/* ------------------------------------------------------------------ *
 * Result approval + leaderboard switching
 * ------------------------------------------------------------------ */

export async function handlePhase234Button(interaction: ButtonInteraction): Promise<boolean> {
  const [namespace, action, ...rest] = interaction.customId.split(":");
  const prefix = `${namespace}:${action}`;
  const member = interaction.member as GuildMember;

  if (namespace === "app") {
    if (action === "addplayers") {
      await interaction.showModal(playerModal(rest[0]!));
      return true;
    }
    if (action === "submit") {
      try {
        const application = submitApplication(rest[0]!);
        const roster = listApplicationPlayers(application.id);

        const reviewChannelId = getConfig(interaction.guildId!, "application_review_channel_id");
        if (reviewChannelId) {
          const channel = await interaction.client.channels.fetch(reviewChannelId).catch(() => null);
          if (channel?.isTextBased() && "send" in channel) {
            const { ButtonBuilder, ButtonStyle } = await import("discord.js");
            const sent = await channel.send({
              embeds: [
                buildEmbed({
                  title: `New Application — ${application.publicRef}`,
                  description: `${application.teamName} applied to join the league.`,
                  fields: [
                    field("Applicant", `<@${application.applicantDiscordId}>`),
                    field("Region", application.region ?? "Not set"),
                    field("Tier", application.tier ?? "Not set"),
                    field(
                      "Roster",
                      roster.map((p) => `${p.isCaptain ? "★" : "•"} ${p.ign}`).join("\n"),
                      false,
                    ),
                  ],
                  thumbnail: application.logoUrl,
                }),
              ],
              components: [
                new ActionRowBuilder<import("discord.js").ButtonBuilder>().addComponents(
                  new ButtonBuilder()
                    .setCustomId(`${APPLICATION_BUTTONS.approve}:${application.id}`)
                    .setLabel("Approve")
                    .setStyle(ButtonStyle.Success),
                  new ButtonBuilder()
                    .setCustomId(`${APPLICATION_BUTTONS.reject}:${application.id}`)
                    .setLabel("Reject")
                    .setStyle(ButtonStyle.Danger),
                ),
              ],
            });
            recordReviewMessage(application.id, sent.channelId, sent.id);
          }
        }

        await updateInPlace(interaction, {
          embeds: [
            successEmbed(
              `Application ${application.publicRef} Submitted`,
              "Staff will review it shortly. You will be notified of the outcome.",
            ),
          ],
          components: [],
        });
      } catch (error) {
        if (error instanceof ApplicationError) {
          await replyError(interaction, error.message);
          return true;
        }
        throw error;
      }
      return true;
    }

    await handleApplicationButton(interaction);
    return true;
  }

  if (prefix === RESULT_BUTTONS.approve || prefix === RESULT_BUTTONS.reject) {
    if (!hasManagerPermission(member)) {
      await replyError(interaction, "Only league staff can approve or reject a result.");
      return true;
    }

    const matchId = rest[0]!;
    try {
      if (prefix === RESULT_BUTTONS.approve) {
        const result = approveMatchResult(interaction.guildId!, matchId, member.id);
        const homeTeam = getTeam(result.match.homeTeamId)!;
        const awayTeam = getTeam(result.match.awayTeamId)!;
        const breakdown = result.match.teamPointsBreakdown as TeamScoringResult;

        await updateInPlace(interaction, {
          embeds: [
            buildResultEmbed({
              match: result.match,
              homeTeam,
              awayTeam,
              scoring: breakdown,
              pendingSlots: [],
              warnings: [`Approved by <@${member.id}> — ${result.playerRows} player transaction(s) created.`],
            }),
          ],
          components: [],
        });
      } else {
        const match = rejectMatchResult(interaction.guildId!, matchId, member.id, "Rejected by staff");
        await updateInPlace(interaction, {
          embeds: [
            buildEmbed({
              title: "Result Rejected",
              description: `${match.publicMatchId} was rejected. No points were awarded.`,
            }),
          ],
          components: [],
        });
      }
    } catch (error) {
      if (error instanceof ApprovalError) {
        await replyError(interaction, error.message);
        return true;
      }
      throw error;
    }
    return true;
  }

  if (prefix === LEADERBOARD_BUTTONS.switchView) {
    const [view, sort, region] = rest;
    await interaction.deferUpdate();
    const rendered = await renderLeaderboard({
      view: (view as "team" | "player") ?? "team",
      sort: sort ?? "points",
      region: region === "*" ? null : ((region ?? null) as Region | null),
      guildId: interaction.guildId!,
    });
    await interaction.editReply({ files: [rendered.attachment], components: rendered.components });
    return true;
  }

  if (prefix === `${RESULT_BUTTONS.resolveSlot}`) {
    const matchId = rest[0]!;
    const match = getMatch(matchId);
    if (!match) {
      await replyError(interaction, "Match not found.");
      return true;
    }
    const pending = listPendingSlots(matchId);
    if (pending.length === 0) {
      await replyError(interaction, "Nothing left to resolve.");
      return true;
    }
    await updateInPlace(interaction, {
      embeds: [buildSlotResolutionEmbed(match, pending)],
      components: buildSlotResolutionComponents(
        pending[0]!,
        getRoster(pending[0]!.teamId ?? match.homeTeamId),
      ),
    });
    return true;
  }

  return false;
}
