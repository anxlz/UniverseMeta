/**
 * Team command family (§6, Phase 1 direct-registration path).
 * Handlers validate input and delegate; no domain logic lives here (§9).
 */

import {
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import { canActOnTeam, hasManagerPermission } from "../lib/permissions";
import { buildEmbed, field, replyError, successEmbed } from "../lib/embeds";
import {
  REGIONS,
  TeamServiceError,
  addPlayer,
  findTeamByName,
  findTeamsForMember,
  getRoster,
  getTeam,
  registerTeam,
  removePlayer,
  searchTeams,
  type Region,
} from "../teams/team.service";
import type { CommandModule } from "./types";

const teamRegister = new SlashCommandBuilder()
  .setName("teamregister")
  .setDescription("Register a team and claim captaincy of it")
  .addStringOption((o) =>
    o.setName("name").setDescription("Team name").setRequired(true).setMaxLength(64),
  )
  .addStringOption((o) =>
    o.setName("captain_ign").setDescription("Your in-game name").setRequired(true).setMaxLength(32),
  )
  .addStringOption((o) => o.setName("tag").setDescription("Short team tag").setMaxLength(8))
  .addStringOption((o) =>
    o
      .setName("region")
      .setDescription("Competitive region")
      .addChoices(...REGIONS.map((r) => ({ name: r, value: r }))),
  )
  .addStringOption((o) => o.setName("tier").setDescription("Tier or division").setMaxLength(32))
  .addStringOption((o) => o.setName("captain_uid").setDescription("Your CODM UID").setMaxLength(32))
  .addStringOption((o) => o.setName("logo_url").setDescription("Direct link to the team logo"));

const teamAddPlayer = new SlashCommandBuilder()
  .setName("teamaddplayer")
  .setDescription("Add a player to your roster")
  .addStringOption((o) =>
    o.setName("ign").setDescription("In-game name as it appears on the scoreboard").setRequired(true).setMaxLength(32),
  )
  .addUserOption((o) => o.setName("user").setDescription("Their Discord account"))
  .addStringOption((o) => o.setName("uid").setDescription("Their CODM UID").setMaxLength(32))
  .addStringOption((o) =>
    o
      .setName("role")
      .setDescription("Roster role")
      .addChoices({ name: "Player", value: "PLAYER" }, { name: "Substitute", value: "SUB" }),
  )
  .addStringOption((o) =>
    o
      .setName("team")
      .setDescription("Team to add to (staff only — defaults to your own)")
      .setAutocomplete(true),
  );

const teamRemovePlayer = new SlashCommandBuilder()
  .setName("teamremoveplayer")
  .setDescription("Remove a player from your roster")
  .addStringOption((o) =>
    o.setName("ign").setDescription("In-game name to remove").setRequired(true).setMaxLength(32),
  )
  .addStringOption((o) =>
    o
      .setName("team")
      .setDescription("Team to remove from (staff only — defaults to your own)")
      .setAutocomplete(true),
  );

const teamRoster = new SlashCommandBuilder()
  .setName("teamroster")
  .setDescription("Show a team's roster")
  .addStringOption((o) =>
    o.setName("team").setDescription("Team name — defaults to your own").setAutocomplete(true),
  );

/**
 * Resolves which team a command applies to: an explicit name if given (staff, or the
 * captain's own), otherwise the caller's single team. Ambiguity is surfaced, never guessed.
 */
function resolveTeamForMember(
  member: GuildMember,
  explicitName: string | null,
): { teamId: string } | { error: string } {
  if (explicitName) {
    const team = findTeamByName(member.guild.id, explicitName);
    if (!team) return { error: `No team named "${explicitName}" is registered.` };
    if (!canActOnTeam(member, team.id)) {
      return { error: `You are not the captain of ${team.name}.` };
    }
    return { teamId: team.id };
  }

  const owned = findTeamsForMember(member.guild.id, member.id);
  if (owned.length === 0) {
    return { error: "You are not on a registered team. Run /teamregister first." };
  }
  if (owned.length > 1) {
    return {
      error: `You are associated with several teams (${owned
        .map((t) => t.name)
        .join(", ")}). Name the one you mean with the team option.`,
    };
  }
  return { teamId: owned[0]!.id };
}

async function autocompleteTeam(interaction: AutocompleteInteraction): Promise<void> {
  if (!interaction.guildId) return void interaction.respond([]);
  const focused = interaction.options.getFocused();
  const results = searchTeams(interaction.guildId, focused, 25);
  await interaction.respond(
    results.map((team) => ({ name: team.tag ? `${team.name} [${team.tag}]` : team.name, value: team.name })),
  );
}

export const teamCommands: CommandModule[] = [
  {
    data: teamRegister,
    async execute(interaction: ChatInputCommandInteraction) {
      const member = interaction.member as GuildMember;
      try {
        const team = registerTeam({
          guildId: interaction.guildId!,
          name: interaction.options.getString("name", true),
          tag: interaction.options.getString("tag"),
          region: interaction.options.getString("region") as Region | null,
          tier: interaction.options.getString("tier"),
          logoUrl: interaction.options.getString("logo_url"),
          captainDiscordId: member.id,
          captainIgn: interaction.options.getString("captain_ign", true),
          captainUid: interaction.options.getString("captain_uid"),
          actorDiscordId: member.id,
        });

        await interaction.reply({
          embeds: [
            buildEmbed({
              title: "Team Registered",
              description: `${team.name} is registered and you are its captain.`,
              fields: [
                field("Team", team.name),
                field("Tag", team.tag ?? "—"),
                field("Region", team.region ?? "Not set"),
                field("Next step", "Add your roster with /teamaddplayer", false),
              ],
              thumbnail: team.logoUrl,
            }),
          ],
        });
      } catch (error) {
        if (error instanceof TeamServiceError) return replyError(interaction, error.message);
        throw error;
      }
    },
  },

  {
    data: teamAddPlayer,
    autocomplete: autocompleteTeam,
    async execute(interaction: ChatInputCommandInteraction) {
      const member = interaction.member as GuildMember;
      const resolved = resolveTeamForMember(member, interaction.options.getString("team"));
      if ("error" in resolved) return replyError(interaction, resolved.error);

      try {
        const user = interaction.options.getUser("user");
        const player = addPlayer({
          guildId: interaction.guildId!,
          teamId: resolved.teamId,
          discordId: user?.id ?? null,
          ign: interaction.options.getString("ign", true),
          uid: interaction.options.getString("uid"),
          role: (interaction.options.getString("role") as "PLAYER" | "SUB" | null) ?? "PLAYER",
          actorDiscordId: member.id,
        });

        const team = getTeam(resolved.teamId)!;
        await interaction.reply({
          embeds: [
            successEmbed(
              "Player Added",
              `${player.ign} joined ${team.name} as ${player.role.toLowerCase()}.`,
            ),
          ],
        });
      } catch (error) {
        if (error instanceof TeamServiceError) return replyError(interaction, error.message);
        throw error;
      }
    },
  },

  {
    data: teamRemovePlayer,
    autocomplete: autocompleteTeam,
    async execute(interaction: ChatInputCommandInteraction) {
      const member = interaction.member as GuildMember;
      const resolved = resolveTeamForMember(member, interaction.options.getString("team"));
      if ("error" in resolved) return replyError(interaction, resolved.error);

      try {
        const player = removePlayer(
          interaction.guildId!,
          resolved.teamId,
          interaction.options.getString("ign", true),
          member.id,
        );
        await interaction.reply({
          embeds: [successEmbed("Player Removed", `${player.ign} was removed from the roster.`)],
        });
      } catch (error) {
        if (error instanceof TeamServiceError) return replyError(interaction, error.message);
        throw error;
      }
    },
  },

  {
    data: teamRoster,
    autocomplete: autocompleteTeam,
    async execute(interaction: ChatInputCommandInteraction) {
      const member = interaction.member as GuildMember;
      const explicit = interaction.options.getString("team");

      let teamId: string;
      if (explicit) {
        // Rosters are readable by anyone — opponents need to see who they are playing.
        const team = findTeamByName(interaction.guildId!, explicit);
        if (!team) return replyError(interaction, `No team named "${explicit}" is registered.`);
        teamId = team.id;
      } else {
        const resolved = resolveTeamForMember(member, null);
        if ("error" in resolved) return replyError(interaction, resolved.error);
        teamId = resolved.teamId;
      }

      const team = getTeam(teamId)!;
      const roster = getRoster(teamId);

      const lines = roster.map((p) => {
        const mention = p.discordId ? `<@${p.discordId}>` : "no Discord link";
        const uid = p.uid ? ` • UID ${p.uid}` : "";
        return `${p.role === "CAPTAIN" ? "★" : "•"} ${p.ign} — ${mention}${uid}`;
      });

      await interaction.reply({
        embeds: [
          buildEmbed({
            title: `${team.name} — Roster`,
            description: lines.length > 0 ? lines.join("\n") : "No players on this roster yet.",
            fields: [
              field("Region", team.region ?? "Not set"),
              field("Tier", team.tier ?? "Not set"),
              field("Players", `${roster.length}`),
            ],
            thumbnail: team.logoUrl,
          }),
        ],
        flags: hasManagerPermission(member) ? undefined : MessageFlags.Ephemeral,
      });
    },
  },
];
