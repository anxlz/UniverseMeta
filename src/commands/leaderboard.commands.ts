/**
 * Leaderboard commands (§7.5). Team and player views, region filter, sortable, with a
 * gray button to switch between views.
 */

import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import { getConfig, setConfig } from "../lib/automation-config";
import { buildEmbed, field, replyError, successEmbed } from "../lib/embeds";
import { hasManagerPermission } from "../lib/permissions";
import {
  PLAYER_SORTS,
  TEAM_SORTS,
  getPlayerStandings,
  getTeamStandings,
  type PlayerSort,
  type TeamSort,
} from "../leaderboard/standings.service";
import {
  renderPlayerLeaderboard,
  renderPlayerLeaderboardAnimated,
  renderTeamLeaderboard,
  renderTeamLeaderboardAnimated,
  type LeaderboardStyle,
} from "../leaderboard/render.service";
import { REGIONS, type Region } from "../teams/team.service";
import type { CommandModule } from "./types";

export const LEADERBOARD_BUTTONS = {
  switchView: "lb:switch",
} as const;

const leaderboard = new SlashCommandBuilder()
  .setName("leaderboard")
  .setDescription("Show the team or player leaderboard")
  .addStringOption((o) =>
    o
      .setName("view")
      .setDescription("Team or player standings")
      .addChoices({ name: "Teams", value: "team" }, { name: "Players", value: "player" }),
  )
  .addStringOption((o) =>
    o
      .setName("sort")
      .setDescription("Sort column")
      .addChoices(
        ...[...new Set([...TEAM_SORTS, ...PLAYER_SORTS])].map((s) => ({ name: s, value: s })),
      ),
  )
  .addStringOption((o) =>
    o
      .setName("region")
      .setDescription("Filter by region")
      .addChoices(...REGIONS.map((r) => ({ name: r, value: r }))),
  );

const leaderboardChannel = new SlashCommandBuilder()
  .setName("setleaderboardchannel")
  .setDescription("Set where leaderboards are posted (staff)")
  .addChannelOption((o) => o.setName("channel").setDescription("Channel").setRequired(true));

export interface RenderOptions {
  view: "team" | "player";
  sort: string;
  region: Region | null;
  guildId: string;
  /** Omitted means "use the guild's configured style". */
  style?: LeaderboardStyle;
}

/** Shared by the slash command and the view-switch button so both render identically. */
export async function renderLeaderboard(options: RenderOptions): Promise<{
  attachment: AttachmentBuilder;
  components: ActionRowBuilder<ButtonBuilder>[];
  empty: boolean;
}> {
  const regionLabel = options.region ?? "All regions";
  const style: LeaderboardStyle =
    options.style ??
    ((getConfig(options.guildId, "leaderboard_style") as LeaderboardStyle) === "animated"
      ? "animated"
      : "static");

  let buffer: Buffer;
  let empty: boolean;

  if (options.view === "team") {
    const sort = (TEAM_SORTS as readonly string[]).includes(options.sort)
      ? (options.sort as TeamSort)
      : "points";
    const standings = getTeamStandings({ guildId: options.guildId, region: options.region }, sort);
    empty = standings.length === 0;
    const args = { standings, sortLabel: sort, regionLabel };
    buffer =
      style === "animated"
        ? await renderTeamLeaderboardAnimated(args)
        : await renderTeamLeaderboard(args);
  } else {
    const sort = (PLAYER_SORTS as readonly string[]).includes(options.sort)
      ? (options.sort as PlayerSort)
      : "points";
    const standings = getPlayerStandings({ guildId: options.guildId, region: options.region }, sort);
    empty = standings.length === 0;
    const args = { standings, sortLabel: sort, regionLabel };
    buffer =
      style === "animated"
        ? await renderPlayerLeaderboardAnimated(args)
        : await renderPlayerLeaderboard(args);
  }

  const extension = style === "animated" ? "gif" : "png";

  const nextView = options.view === "team" ? "player" : "team";
  const components = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(
          `${LEADERBOARD_BUTTONS.switchView}:${nextView}:${options.sort}:${options.region ?? "*"}`,
        )
        .setLabel(nextView === "team" ? "Team View" : "Player View")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];

  return {
    attachment: new AttachmentBuilder(buffer, {
      name: `leaderboard-${options.view}.${extension}`,
    }),
    components,
    empty,
  };
}

const leaderboardStyle = new SlashCommandBuilder()
  .setName("leaderboardstyle")
  .setDescription("Switch leaderboards between static images and animated GIFs (staff)")
  .addStringOption((o) =>
    o
      .setName("style")
      .setDescription("Rendering style")
      .setRequired(true)
      .addChoices(
        { name: "Static image (PNG)", value: "static" },
        { name: "Animated (GIF)", value: "animated" },
      ),
  );

export const leaderboardCommands: CommandModule[] = [
  {
    data: leaderboardStyle,
    async execute(interaction: ChatInputCommandInteraction) {
      const member = interaction.member as GuildMember;
      if (!hasManagerPermission(member)) {
        return replyError(interaction, "This command is restricted to league staff.");
      }
      const style = interaction.options.getString("style", true);
      setConfig(interaction.guildId!, "leaderboard_style", style as never, member.id);
      await interaction.reply({
        embeds: [
          successEmbed(
            "Leaderboard Style Updated",
            style === "animated"
              ? "Leaderboards will render as animated GIFs. They take a little longer to generate and are capped at 10 rows to stay under Discord's upload limit."
              : "Leaderboards will render as static PNG images.",
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },

  {
    data: leaderboard,
    async execute(interaction: ChatInputCommandInteraction) {
      await interaction.deferReply();

      const rendered = await renderLeaderboard({
        view: (interaction.options.getString("view") as "team" | "player") ?? "team",
        sort: interaction.options.getString("sort") ?? "points",
        region: interaction.options.getString("region") as Region | null,
        guildId: interaction.guildId!,
      });

      await interaction.editReply({
        files: [rendered.attachment],
        components: rendered.components,
      });
    },
  },

  {
    data: leaderboardChannel,
    async execute(interaction: ChatInputCommandInteraction) {
      const member = interaction.member as GuildMember;
      if (!hasManagerPermission(member)) {
        return replyError(interaction, "This command is restricted to league staff.");
      }
      const channel = interaction.options.getChannel("channel", true);
      setConfig(interaction.guildId!, "match_log_channel_id", channel.id as never, member.id);
      await interaction.reply({
        embeds: [
          successEmbed("Leaderboard Channel Set", `Leaderboards will be posted in <#${channel.id}>.`),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
];

export function leaderboardSettingsEmbed(guildId: string) {
  return buildEmbed({
    title: "Leaderboard Settings",
    fields: [field("Channel", getConfig(guildId, "match_log_channel_id") || "Not set")],
  });
}
