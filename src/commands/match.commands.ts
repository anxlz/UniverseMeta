/**
 * Match command family (Phase 1). Every handler resolves permissions, calls the service,
 * and renders — nothing else.
 */

import {
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import { DateTimeParseError } from "../lib/datetime";
import { replyError } from "../lib/embeds";
import { hasManagerPermission } from "../lib/permissions";
import {
  MATCH_CATEGORIES,
  MatchServiceError,
  cancelMatch,
  confirmMatch,
  getMatchByPublicId,
  queryMatchHistory,
  recordAnnouncement,
  registerMatch,
  updateMatch,
  type MatchCategory,
} from "../matches/match.service";
import {
  buildHistoryButtons,
  buildHistoryEmbed,
  buildMatchButtons,
  buildMatchEmbed,
} from "../discord/discord-match-embed.service";
import { runPostConfirmationAutomation } from "../matches/post-confirmation.service";
import { findTeamByName, findTeamsForMember, getTeam, searchTeams } from "../teams/team.service";
import type { CommandModule } from "./types";

export const HISTORY_PAGE_SIZE = 5;

const CATEGORY_CHOICES = MATCH_CATEGORIES.map((c) => ({
  name: c.charAt(0) + c.slice(1).toLowerCase(),
  value: c,
}));

const matchRegister = new SlashCommandBuilder()
  .setName("matchregister")
  .setDescription("Register a match against another team")
  .addStringOption((o) =>
    o.setName("opponent").setDescription("Opposing team").setRequired(true).setAutocomplete(true),
  )
  .addStringOption((o) =>
    o
      .setName("category")
      .setDescription("Match category")
      .setRequired(true)
      .addChoices(...CATEGORY_CHOICES),
  )
  .addStringOption((o) =>
    o.setName("date").setDescription("Date as YYYY-MM-DD, e.g. 2026-08-22").setRequired(true),
  )
  .addStringOption((o) =>
    o.setName("time").setDescription("24-hour time as HH:mm, e.g. 20:30").setRequired(true),
  )
  .addStringOption((o) =>
    o.setName("timezone").setDescription("IANA timezone override, e.g. Africa/Casablanca"),
  )
  .addStringOption((o) =>
    o.setName("team").setDescription("Your team (only needed if you captain more than one)").setAutocomplete(true),
  );

const matchConfirm = new SlashCommandBuilder()
  .setName("matchconfirm")
  .setDescription("Confirm a match your team has been challenged to")
  .addStringOption((o) =>
    o.setName("match_id").setDescription("Match ID, e.g. CODM-20260814-000127").setRequired(true),
  );

const matchUpdate = new SlashCommandBuilder()
  .setName("matchupdate")
  .setDescription("Change the date, time, or category of a match")
  .addStringOption((o) => o.setName("match_id").setDescription("Match ID").setRequired(true))
  .addStringOption((o) => o.setName("date").setDescription("New date as YYYY-MM-DD"))
  .addStringOption((o) => o.setName("time").setDescription("New 24-hour time as HH:mm"))
  .addStringOption((o) =>
    o.setName("category").setDescription("New category").addChoices(...CATEGORY_CHOICES),
  )
  .addStringOption((o) => o.setName("timezone").setDescription("IANA timezone override"));

const matchCancel = new SlashCommandBuilder()
  .setName("matchcancel")
  .setDescription("Cancel a scheduled match")
  .addStringOption((o) => o.setName("match_id").setDescription("Match ID").setRequired(true))
  .addStringOption((o) => o.setName("reason").setDescription("Why it is being cancelled").setMaxLength(200));

const matchHistory = new SlashCommandBuilder()
  .setName("matchhistory")
  .setDescription("Browse registered matches")
  .addStringOption((o) =>
    o.setName("team").setDescription("Filter to one team").setAutocomplete(true),
  )
  .addStringOption((o) =>
    o
      .setName("status")
      .setDescription("Filter by status")
      .addChoices(
        { name: "Pending confirmation", value: "PENDING_CONFIRMATION" },
        { name: "Confirmed", value: "CONFIRMED" },
        { name: "Cancelled", value: "CANCELLED" },
      ),
  );

async function autocompleteTeam(interaction: AutocompleteInteraction): Promise<void> {
  if (!interaction.guildId) return void interaction.respond([]);
  const results = searchTeams(interaction.guildId, interaction.options.getFocused(), 25);
  await interaction.respond(
    results.map((t) => ({ name: t.tag ? `${t.name} [${t.tag}]` : t.name, value: t.name })),
  );
}

/** Which of the caller's teams is registering. Ambiguity is reported, never guessed. */
function resolveOwnTeam(
  member: GuildMember,
  explicitName: string | null,
): { teamId: string } | { error: string } {
  const owned = findTeamsForMember(member.guild.id, member.id).filter(
    (t) => t.captainDiscordId === member.id,
  );

  if (explicitName) {
    const team = findTeamByName(member.guild.id, explicitName);
    if (!team) return { error: `No team named "${explicitName}" is registered.` };
    if (team.captainDiscordId !== member.id && !hasManagerPermission(member)) {
      return { error: `Only the captain of ${team.name} can register its matches.` };
    }
    return { teamId: team.id };
  }

  if (owned.length === 0) {
    return { error: "Only team captains can register matches. Run /teamregister first." };
  }
  if (owned.length > 1) {
    return { error: "You captain several teams — name the one you are registering for." };
  }
  return { teamId: owned[0]!.id };
}

/** Encodes the history filter into a button custom id so pagination survives a restart. */
export function encodeHistoryScope(teamId: string | null, status: string | null): string {
  return `${teamId ?? "*"}~${status ?? "*"}`;
}

export function decodeHistoryScope(token: string): { teamId: string | null; status: string | null } {
  const [teamId, status] = token.split("~");
  return {
    teamId: !teamId || teamId === "*" ? null : teamId,
    status: !status || status === "*" ? null : status,
  };
}

export function historyScopeLabel(teamId: string | null, status: string | null): string {
  const team = teamId ? (getTeam(teamId)?.name ?? "Unknown team") : "All teams";
  return status ? `${team} • ${status.replace(/_/g, " ").toLowerCase()}` : team;
}

export const matchCommands: CommandModule[] = [
  {
    data: matchRegister,
    autocomplete: autocompleteTeam,
    async execute(interaction: ChatInputCommandInteraction) {
      const member = interaction.member as GuildMember;
      const own = resolveOwnTeam(member, interaction.options.getString("team"));
      if ("error" in own) return replyError(interaction, own.error);

      const opponentName = interaction.options.getString("opponent", true);
      const opponent = findTeamByName(interaction.guildId!, opponentName);
      if (!opponent) {
        return replyError(interaction, `No team named "${opponentName}" is registered.`);
      }

      try {
        const result = registerMatch({
          guildId: interaction.guildId!,
          homeTeamId: own.teamId,
          awayTeamId: opponent.id,
          category: interaction.options.getString("category", true) as MatchCategory,
          date: interaction.options.getString("date", true),
          time: interaction.options.getString("time", true),
          timeZoneOverride: interaction.options.getString("timezone"),
          registeredBy: member.id,
        });

        const message = await interaction.reply({
          content: `<@${result.awayTeam.captainDiscordId}>`,
          embeds: [
            buildMatchEmbed({
              match: result.match,
              homeTeam: result.homeTeam,
              awayTeam: result.awayTeam,
              advanceNoticeWarning: result.advanceNoticeWarning,
              complianceNotes: result.complianceFlags.map((f) => f.detail),
            }),
          ],
          components: buildMatchButtons(result.match),
          withResponse: true,
        });

        const sent = message.resource?.message;
        if (sent) recordAnnouncement(result.match.id, sent.channelId, sent.id);
      } catch (error) {
        if (error instanceof MatchServiceError || error instanceof DateTimeParseError) {
          return replyError(interaction, error.message);
        }
        throw error;
      }
    },
  },

  {
    data: matchConfirm,
    async execute(interaction: ChatInputCommandInteraction) {
      const member = interaction.member as GuildMember;
      const publicId = interaction.options.getString("match_id", true);
      const match = getMatchByPublicId(interaction.guildId!, publicId);
      if (!match) return replyError(interaction, `No match found with ID ${publicId}.`);

      try {
        const confirmed = confirmMatch(
          interaction.guildId!,
          match.id,
          member.id,
          hasManagerPermission(member),
        );
        const homeTeam = getTeam(confirmed.homeTeamId)!;
        const awayTeam = getTeam(confirmed.awayTeamId)!;

        await interaction.deferReply();

        // §7.1: ticket + log happen on confirmation, toggle-gated, and never fail it.
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

        await interaction.editReply({
          embeds: [
            buildMatchEmbed({
              match: getMatchByPublicId(interaction.guildId!, confirmed.publicMatchId)!,
              homeTeam,
              awayTeam,
              note: notes.join(" "),
            }),
          ],
        });
      } catch (error) {
        if (error instanceof MatchServiceError) return replyError(interaction, error.message);
        throw error;
      }
    },
  },

  {
    data: matchUpdate,
    async execute(interaction: ChatInputCommandInteraction) {
      const member = interaction.member as GuildMember;
      const publicId = interaction.options.getString("match_id", true);
      const match = getMatchByPublicId(interaction.guildId!, publicId);
      if (!match) return replyError(interaction, `No match found with ID ${publicId}.`);

      const home = getTeam(match.homeTeamId)!;
      const away = getTeam(match.awayTeamId)!;
      const isParticipant =
        home.captainDiscordId === member.id || away.captainDiscordId === member.id;
      if (!isParticipant && !hasManagerPermission(member)) {
        return replyError(interaction, "Only a participating captain or staff can edit this match.");
      }

      try {
        const { match: updated, requiresReconfirmation } = updateMatch({
          guildId: interaction.guildId!,
          matchId: match.id,
          date: interaction.options.getString("date"),
          time: interaction.options.getString("time"),
          category: interaction.options.getString("category") as MatchCategory | null,
          timeZoneOverride: interaction.options.getString("timezone"),
          actorDiscordId: member.id,
        });

        await interaction.reply({
          content: requiresReconfirmation ? `<@${away.captainDiscordId}>` : undefined,
          embeds: [
            buildMatchEmbed({
              match: updated,
              homeTeam: home,
              awayTeam: away,
              note: requiresReconfirmation
                ? "The schedule changed, so the previous confirmation was cleared. The opposing captain must confirm again."
                : "Match updated.",
            }),
          ],
          components: buildMatchButtons(updated),
        });
      } catch (error) {
        if (error instanceof MatchServiceError || error instanceof DateTimeParseError) {
          return replyError(interaction, error.message);
        }
        throw error;
      }
    },
  },

  {
    data: matchCancel,
    async execute(interaction: ChatInputCommandInteraction) {
      const member = interaction.member as GuildMember;
      const publicId = interaction.options.getString("match_id", true);
      const match = getMatchByPublicId(interaction.guildId!, publicId);
      if (!match) return replyError(interaction, `No match found with ID ${publicId}.`);

      const home = getTeam(match.homeTeamId)!;
      const away = getTeam(match.awayTeamId)!;
      const isParticipant =
        home.captainDiscordId === member.id || away.captainDiscordId === member.id;
      if (!isParticipant && !hasManagerPermission(member)) {
        return replyError(
          interaction,
          "Only a participating captain or staff can cancel this match.",
        );
      }

      try {
        const cancelled = cancelMatch(
          interaction.guildId!,
          match.id,
          member.id,
          interaction.options.getString("reason"),
        );
        await interaction.reply({
          embeds: [buildMatchEmbed({ match: cancelled, homeTeam: home, awayTeam: away })],
        });
      } catch (error) {
        if (error instanceof MatchServiceError) return replyError(interaction, error.message);
        throw error;
      }
    },
  },

  {
    data: matchHistory,
    autocomplete: autocompleteTeam,
    async execute(interaction: ChatInputCommandInteraction) {
      const teamName = interaction.options.getString("team");
      const status = interaction.options.getString("status");

      let teamId: string | null = null;
      if (teamName) {
        const team = findTeamByName(interaction.guildId!, teamName);
        if (!team) return replyError(interaction, `No team named "${teamName}" is registered.`);
        teamId = team.id;
      }

      const { rows, total } = queryMatchHistory({
        guildId: interaction.guildId!,
        teamId,
        statuses: status ? [status as never] : undefined,
        limit: HISTORY_PAGE_SIZE,
        offset: 0,
      });

      await interaction.reply({
        embeds: [
          buildHistoryEmbed({
            guildId: interaction.guildId!,
            rows,
            total,
            offset: 0,
            pageSize: HISTORY_PAGE_SIZE,
            scopeLabel: historyScopeLabel(teamId, status),
          }),
        ],
        components: buildHistoryButtons(
          0,
          HISTORY_PAGE_SIZE,
          total,
          encodeHistoryScope(teamId, status),
        ),
        flags: MessageFlags.Ephemeral,
      });
    },
  },
];
