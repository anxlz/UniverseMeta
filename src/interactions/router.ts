/**
 * Single entry point for every interaction. Button handling is here so the §5
 * edit-in-place rule is enforced in one place rather than per command family.
 */

import {
  MessageFlags,
  type ButtonInteraction,
  type Interaction,
  type GuildMember,
} from "discord.js";
import { commandsByName } from "../commands";
import {
  HISTORY_PAGE_SIZE,
  decodeHistoryScope,
  encodeHistoryScope,
  historyScopeLabel,
} from "../commands/match.commands";
import {
  BUTTON_IDS,
  buildHistoryButtons,
  buildHistoryEmbed,
  buildMatchButtons,
  buildMatchEmbed,
} from "../discord/discord-match-embed.service";
import { replyError, updateInPlace } from "../lib/embeds";
import {
  handleApplicationModal,
  handlePhase234Button,
  handleSelectMenu,
} from "./phase234-router";
import { logger } from "../lib/logger";
import { hasManagerPermission } from "../lib/permissions";
import {
  MatchServiceError,
  cancelMatch,
  confirmMatch,
  getMatch,
  queryMatchHistory,
} from "../matches/match.service";
import { runPostConfirmationAutomation } from "../matches/post-confirmation.service";
import { getTeam } from "../teams/team.service";

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  // Phase 2-4 controls claim their own custom ids first; anything else falls through.
  if (await handlePhase234Button(interaction)) return;

  const [namespace, action, ...rest] = interaction.customId.split(":");
  const prefix = `${namespace}:${action}`;
  const member = interaction.member as GuildMember;

  if (prefix === BUTTON_IDS.confirm || prefix === BUTTON_IDS.decline) {
    const matchId = rest[0]!;
    const match = getMatch(matchId);
    if (!match || match.guildId !== interaction.guildId) {
      return replyError(interaction, "That match no longer exists.");
    }

    const homeTeam = getTeam(match.homeTeamId)!;
    const awayTeam = getTeam(match.awayTeamId)!;

    try {
      if (prefix === BUTTON_IDS.confirm) {
        const confirmed = confirmMatch(
          interaction.guildId!,
          matchId,
          member.id,
          hasManagerPermission(member),
        );

        // §5: edits the original registration message, never posts a second one. Deferred
        // first because ticket creation is a round trip to Discord.
        await interaction.deferUpdate();

        const automation = await runPostConfirmationAutomation(
          interaction.guild!,
          confirmed,
          homeTeam,
          awayTeam,
          member.id,
        );

        const notes = ["Both teams are locked in."];
        if (automation.ticketChannelId) notes.push(`Ticket: <#${automation.ticketChannelId}>`);
        notes.push(...automation.warnings);

        const refreshed = getMatch(matchId)!;
        await interaction.editReply({
          content: "",
          embeds: [
            buildMatchEmbed({
              match: refreshed,
              homeTeam,
              awayTeam,
              note: notes.join(" "),
            }),
          ],
          components: buildMatchButtons(refreshed),
        });
        return;
      }

      const isParticipantCaptain =
        homeTeam.captainDiscordId === member.id || awayTeam.captainDiscordId === member.id;
      if (!isParticipantCaptain && !hasManagerPermission(member)) {
        return replyError(
          interaction,
          "Only a participating captain or staff can decline this match.",
        );
      }

      const cancelled = cancelMatch(
        interaction.guildId!,
        matchId,
        member.id,
        "Declined by the opposing team",
      );
      return updateInPlace(interaction, {
        content: "",
        embeds: [buildMatchEmbed({ match: cancelled, homeTeam, awayTeam })],
        components: [],
      });
    } catch (error) {
      if (error instanceof MatchServiceError) return replyError(interaction, error.message);
      throw error;
    }
  }

  if (prefix === BUTTON_IDS.historyPrev || prefix === BUTTON_IDS.historyNext) {
    const offset = Math.max(0, Number(rest[0] ?? 0));
    const scopeToken = rest.slice(1).join(":");
    const { teamId, status } = decodeHistoryScope(scopeToken);

    const { rows, total } = queryMatchHistory({
      guildId: interaction.guildId!,
      teamId,
      statuses: status ? [status as never] : undefined,
      limit: HISTORY_PAGE_SIZE,
      offset,
    });

    return updateInPlace(interaction, {
      embeds: [
        buildHistoryEmbed({
          guildId: interaction.guildId!,
          rows,
          total,
          offset,
          pageSize: HISTORY_PAGE_SIZE,
          scopeLabel: historyScopeLabel(teamId, status),
        }),
      ],
      components: buildHistoryButtons(
        offset,
        HISTORY_PAGE_SIZE,
        total,
        encodeHistoryScope(teamId, status),
      ),
    });
  }

  logger.warn("unhandled button", { customId: interaction.customId });
  await interaction.reply({
    content: "That control is no longer active.",
    flags: MessageFlags.Ephemeral,
  });
}

export async function routeInteraction(interaction: Interaction): Promise<void> {
  // Every command in Phase 1 is guild-scoped: teams, matches and config are per-server.
  if (!interaction.guildId && !interaction.isAutocomplete()) {
    if (interaction.isRepliable()) {
      await interaction.reply({
        content: "These commands only work inside a server.",
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  try {
    if (interaction.isAutocomplete()) {
      const command = commandsByName.get(interaction.commandName);
      if (command?.autocomplete) await command.autocomplete(interaction);
      else await interaction.respond([]);
      return;
    }

    if (interaction.isChatInputCommand()) {
      const command = commandsByName.get(interaction.commandName);
      if (!command) {
        logger.warn("unknown command", { name: interaction.commandName });
        return;
      }
      logger.info("command", {
        name: interaction.commandName,
        guildId: interaction.guildId,
        userId: interaction.user.id,
      });
      await command.execute(interaction);
      return;
    }

    if (interaction.isButton()) {
      await handleButton(interaction);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      await handleSelectMenu(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      await handleApplicationModal(interaction);
    }
  } catch (error) {
    logger.error("interaction failed", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      customId: interaction.isButton() ? interaction.customId : undefined,
      command: interaction.isChatInputCommand() ? interaction.commandName : undefined,
    });

    if (interaction.isRepliable()) {
      const payload = {
        content: "Something went wrong handling that. Staff have it in the logs.",
        flags: MessageFlags.Ephemeral as const,
      };
      try {
        if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
        else await interaction.reply(payload);
      } catch {
        // The interaction token expired — nothing useful left to do.
      }
    }
  }
}
