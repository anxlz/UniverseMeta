/**
 * Application commands (§6): the persistent Apply Now embed, an on-demand copy, and the
 * staff review queue. Approval is what writes a team into the live database.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import { getConfig, setConfig } from "../lib/automation-config";
import { COLORS, buildEmbed, field, replyError, successEmbed } from "../lib/embeds";
import { hasManagerPermission } from "../lib/permissions";
import {
  getApplicationByRef,
  listApplicationPlayers,
} from "../applications/application.service";
import { REGIONS } from "../teams/team.service";
import type { CommandModule } from "./types";

export const APPLICATION_BUTTONS = {
  start: "app:start",
  approve: "app:approve",
  reject: "app:reject",
} as const;

export function buildApplyEmbed(imageUrl: string | null) {
  return buildEmbed({
    title: "Team Applications Are Open",
    description:
      "Apply to join the league. You will be asked for your team name, region, tier, logo, and each player's name and UID. Staff review every application before a team goes live.",
    color: COLORS.info,
    fields: [
      field("Roster", "Up to 10 players", true),
      field("Review", "Staff approval required", true),
    ],
    thumbnail: imageUrl,
  });
}

export function buildApplyButton(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(APPLICATION_BUTTONS.start)
        .setLabel("Apply Now")
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

const setApply = new SlashCommandBuilder()
  .setName("setapply")
  .setDescription("Post the persistent Apply Now embed in a channel (staff)")
  .addChannelOption((o) => o.setName("channel").setDescription("Channel").setRequired(true))
  .addStringOption((o) => o.setName("image_url").setDescription("Embed image"));

const postApply = new SlashCommandBuilder()
  .setName("postapply")
  .setDescription("Post the Apply Now embed here on demand (staff)")
  .addStringOption((o) => o.setName("image_url").setDescription("Embed image"));

const applicationReviewChannel = new SlashCommandBuilder()
  .setName("setapplicationchannel")
  .setDescription("Set where submitted applications are sent for review (staff)")
  .addChannelOption((o) => o.setName("channel").setDescription("Channel").setRequired(true));

const applicationShow = new SlashCommandBuilder()
  .setName("application")
  .setDescription("Show an application by reference (staff)")
  .addStringOption((o) =>
    o.setName("ref").setDescription("Application reference, e.g. APP-00001").setRequired(true),
  );

export const applicationCommands: CommandModule[] = [
  {
    data: setApply,
    async execute(interaction: ChatInputCommandInteraction) {
      const member = interaction.member as GuildMember;
      if (!hasManagerPermission(member)) {
        return replyError(interaction, "This command is restricted to league staff.");
      }

      const channel = interaction.options.getChannel("channel", true);
      const resolved = await interaction.guild!.channels.fetch(channel.id);
      if (!resolved?.isTextBased()) {
        return replyError(interaction, "Pick a text channel.");
      }

      await resolved.send({
        embeds: [buildApplyEmbed(interaction.options.getString("image_url"))],
        components: buildApplyButton(),
      });
      setConfig(interaction.guildId!, "application_channel_id", channel.id as never, member.id);

      await interaction.reply({
        embeds: [successEmbed("Apply Embed Posted", `The Apply Now embed is live in <#${channel.id}>.`)],
        flags: MessageFlags.Ephemeral,
      });
    },
  },

  {
    data: postApply,
    async execute(interaction: ChatInputCommandInteraction) {
      const member = interaction.member as GuildMember;
      if (!hasManagerPermission(member)) {
        return replyError(interaction, "This command is restricted to league staff.");
      }
      await interaction.reply({
        embeds: [buildApplyEmbed(interaction.options.getString("image_url"))],
        components: buildApplyButton(),
      });
    },
  },

  {
    data: applicationReviewChannel,
    async execute(interaction: ChatInputCommandInteraction) {
      const member = interaction.member as GuildMember;
      if (!hasManagerPermission(member)) {
        return replyError(interaction, "This command is restricted to league staff.");
      }
      const channel = interaction.options.getChannel("channel", true);
      setConfig(interaction.guildId!, "application_review_channel_id", channel.id as never, member.id);
      await interaction.reply({
        embeds: [
          successEmbed("Review Channel Set", `Applications will be sent to <#${channel.id}>.`),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },

  {
    data: applicationShow,
    async execute(interaction: ChatInputCommandInteraction) {
      const member = interaction.member as GuildMember;
      if (!hasManagerPermission(member)) {
        return replyError(interaction, "This command is restricted to league staff.");
      }

      const application = getApplicationByRef(
        interaction.guildId!,
        interaction.options.getString("ref", true),
      );
      if (!application) return replyError(interaction, "No application with that reference.");

      const roster = listApplicationPlayers(application.id);
      await interaction.reply({
        embeds: [
          buildEmbed({
            title: `Application ${application.publicRef}`,
            description: `${application.teamName} — ${application.status.toLowerCase()}`,
            fields: [
              field("Applicant", `<@${application.applicantDiscordId}>`),
              field("Region", application.region ?? "Not set"),
              field("Tier", application.tier ?? "Not set"),
              field(
                "Roster",
                roster.map((p) => `${p.isCaptain ? "★" : "•"} ${p.ign}${p.uid ? ` (${p.uid})` : ""}`).join("\n") ||
                  "No players listed",
                false,
              ),
            ],
            thumbnail: application.logoUrl,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
];

export { REGIONS };
