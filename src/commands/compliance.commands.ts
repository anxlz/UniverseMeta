/**
 * Phase 4 compliance commands. Flag-only and off by default (§4) — nothing here can block
 * a match, only surface an observation for staff.
 */

import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import { getConfig, getToggle, setConfig } from "../lib/automation-config";
import { buildEmbed, field, replyError, successEmbed } from "../lib/embeds";
import { hasManagerPermission } from "../lib/permissions";
import { acknowledgeFlag, listOpenFlags } from "../compliance/compliance.service";
import type { CommandModule } from "./types";

const compliance = new SlashCommandBuilder()
  .setName("compliance")
  .setDescription("League compliance flags (advisory only)")
  .addSubcommand((s) => s.setName("list").setDescription("Show open compliance flags"))
  .addSubcommand((s) =>
    s
      .setName("ack")
      .setDescription("Acknowledge a flag")
      .addStringOption((o) => o.setName("flag_id").setDescription("Flag ID").setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName("limits")
      .setDescription("Set compliance thresholds")
      .addIntegerOption((o) =>
        o.setName("opponent_limit").setDescription("Max meetings vs one opponent per week").setMinValue(0),
      )
      .addIntegerOption((o) =>
        o.setName("weekly_min").setDescription("Minimum matches per week").setMinValue(0),
      )
      .addIntegerOption((o) =>
        o.setName("weekly_max").setDescription("Maximum matches per week").setMinValue(0),
      ),
  );

export const complianceCommands: CommandModule[] = [
  {
    data: compliance,
    async execute(interaction: ChatInputCommandInteraction) {
      const member = interaction.member as GuildMember;
      if (!hasManagerPermission(member)) {
        return replyError(interaction, "This command is restricted to league staff.");
      }

      const guildId = interaction.guildId!;
      const sub = interaction.options.getSubcommand();

      if (sub === "list") {
        const flags = listOpenFlags(guildId);
        const enabled = getToggle(guildId, "compliance_flagging");
        return void (await interaction.reply({
          embeds: [
            buildEmbed({
              title: "Compliance Flags",
              description: enabled
                ? flags.length > 0
                  ? flags.map((f) => `• [${f.id.slice(0, 8)}] ${f.rule}: ${f.detail}`).join("\n")
                  : "No open flags."
                : "Compliance flagging is off. Turn it on with /config toggle compliance_flagging. Flags never block a match either way.",
              fields: [
                field("Opponent limit", String(getConfig(guildId, "compliance_opponent_limit"))),
                field("Weekly min", String(getConfig(guildId, "compliance_weekly_series_min"))),
                field("Weekly max", String(getConfig(guildId, "compliance_weekly_series_max"))),
              ],
            }),
          ],
          flags: MessageFlags.Ephemeral,
        }));
      }

      if (sub === "ack") {
        acknowledgeFlag(interaction.options.getString("flag_id", true), member.id);
        return void (await interaction.reply({
          embeds: [successEmbed("Flag Acknowledged", "It will no longer appear in the open list.")],
          flags: MessageFlags.Ephemeral,
        }));
      }

      const opponentLimit = interaction.options.getInteger("opponent_limit");
      const weeklyMin = interaction.options.getInteger("weekly_min");
      const weeklyMax = interaction.options.getInteger("weekly_max");

      if (opponentLimit === null && weeklyMin === null && weeklyMax === null) {
        return replyError(interaction, "Supply at least one threshold to change.");
      }
      if (opponentLimit !== null) {
        setConfig(guildId, "compliance_opponent_limit", opponentLimit as never, member.id);
      }
      if (weeklyMin !== null) {
        setConfig(guildId, "compliance_weekly_series_min", weeklyMin as never, member.id);
      }
      if (weeklyMax !== null) {
        setConfig(guildId, "compliance_weekly_series_max", weeklyMax as never, member.id);
      }

      await interaction.reply({
        embeds: [
          successEmbed(
            "Compliance Thresholds Updated",
            "These are advisory guidelines. Matches outside them are flagged for staff, never blocked.",
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
];
