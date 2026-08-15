/**
 * Configuration commands. Every value written here goes through the DB-backed
 * AutomationConfig path (§5) — there is no other way to set a flag in this codebase.
 */

import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import { CONFIG_KEYS, getConfig, listConfig, setConfig, type ConfigKey } from "../lib/automation-config";
import { isValidTimeZone } from "../lib/datetime";
import { buildEmbed, field, replyError, successEmbed } from "../lib/embeds";
import { addStaffRole, hasManagerPermission, listStaffRoles, removeStaffRole } from "../lib/permissions";
import type { CommandModule } from "./types";

const BOOLEAN_KEYS = (Object.keys(CONFIG_KEYS) as ConfigKey[]).filter(
  (k) => CONFIG_KEYS[k].type === "boolean",
);

const config = new SlashCommandBuilder()
  .setName("config")
  .setDescription("View or change league configuration")
  .addSubcommand((s) => s.setName("show").setDescription("Show every configuration value"))
  .addSubcommand((s) =>
    s
      .setName("toggle")
      .setDescription("Turn a feature flag on or off")
      .addStringOption((o) =>
        o
          .setName("key")
          .setDescription("Flag to change")
          .setRequired(true)
          .addChoices(...BOOLEAN_KEYS.map((k) => ({ name: k, value: k }))),
      )
      .addBooleanOption((o) =>
        o.setName("value").setDescription("On or off").setRequired(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("timezone")
      .setDescription("Set the timezone bare match times are read in")
      .addStringOption((o) =>
        o.setName("zone").setDescription("IANA zone, e.g. Africa/Casablanca").setRequired(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("announcechannel")
      .setDescription("Channel confirmed matches are logged to")
      .addChannelOption((o) =>
        o.setName("channel").setDescription("Channel").setRequired(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("advancenotice")
      .setDescription("Set the minimum advance-notice window (flag only, never a block)")
      .addIntegerOption((o) =>
        o
          .setName("hours")
          .setDescription("Hours of notice expected")
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(336),
      ),
  );

const staffRole = new SlashCommandBuilder()
  .setName("staffrole")
  .setDescription("Manage which roles count as league staff")
  .addSubcommand((s) =>
    s
      .setName("add")
      .setDescription("Grant staff powers to a role")
      .addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName("remove")
      .setDescription("Revoke staff powers from a role")
      .addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true)),
  )
  .addSubcommand((s) => s.setName("list").setDescription("List configured staff roles"));

function requireStaff(interaction: ChatInputCommandInteraction): boolean {
  return hasManagerPermission(interaction.member as GuildMember);
}

export const automationCommands: CommandModule[] = [
  {
    data: config,
    async execute(interaction: ChatInputCommandInteraction) {
      if (!requireStaff(interaction)) {
        return replyError(interaction, "This command is restricted to league staff.");
      }

      const guildId = interaction.guildId!;
      const actor = interaction.user.id;
      const sub = interaction.options.getSubcommand();

      if (sub === "show") {
        const rows = listConfig(guildId).map(
          (c) => `${c.key} = ${c.value === "" ? "(unset)" : c.value}${c.isDefault ? " (default)" : ""}`,
        );
        return void (await interaction.reply({
          embeds: [
            buildEmbed({
              title: "League Configuration",
              description: rows.join("\n"),
              footer: "Values marked (default) have never been set and fall back to code defaults.",
            }),
          ],
          flags: MessageFlags.Ephemeral,
        }));
      }

      if (sub === "toggle") {
        const key = interaction.options.getString("key", true) as ConfigKey;
        const value = interaction.options.getBoolean("value", true);
        setConfig(guildId, key, value as never, actor);
        return void (await interaction.reply({
          embeds: [successEmbed("Configuration Updated", `${key} is now ${value ? "on" : "off"}.`)],
          flags: MessageFlags.Ephemeral,
        }));
      }

      if (sub === "timezone") {
        const zone = interaction.options.getString("zone", true).trim();
        if (!isValidTimeZone(zone)) {
          return replyError(
            interaction,
            `"${zone}" is not a recognised IANA timezone. Try a name like Africa/Casablanca or Asia/Riyadh.`,
          );
        }
        setConfig(guildId, "league_timezone", zone as never, actor);
        return void (await interaction.reply({
          embeds: [
            successEmbed(
              "Timezone Updated",
              `Match times entered without a timezone are now read as ${zone}.`,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        }));
      }

      if (sub === "announcechannel") {
        const channel = interaction.options.getChannel("channel", true);
        setConfig(guildId, "match_announce_channel_id", channel.id as never, actor);
        return void (await interaction.reply({
          embeds: [
            successEmbed(
              "Announce Channel Set",
              `Confirmed matches will be logged to <#${channel.id}> while auto_match_logging is on.`,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        }));
      }

      if (sub === "advancenotice") {
        const hours = interaction.options.getInteger("hours", true);
        setConfig(guildId, "advance_notice_hours", hours as never, actor);
        return void (await interaction.reply({
          embeds: [
            buildEmbed({
              title: "Advance Notice Updated",
              description: `Matches registered with less than ${hours}h notice will be flagged for staff. Registration is still allowed.`,
              fields: [
                field("Window", `${hours}h`),
                field("Enforcement", getConfig(guildId, "advance_notice_enabled") ? "Flag" : "Off"),
              ],
            }),
          ],
          flags: MessageFlags.Ephemeral,
        }));
      }
    },
  },

  {
    data: staffRole,
    async execute(interaction: ChatInputCommandInteraction) {
      if (!requireStaff(interaction)) {
        return replyError(interaction, "This command is restricted to league staff.");
      }

      const guildId = interaction.guildId!;
      const sub = interaction.options.getSubcommand();

      if (sub === "list") {
        const roles = listStaffRoles(guildId);
        return void (await interaction.reply({
          embeds: [
            buildEmbed({
              title: "Staff Roles",
              description:
                roles.length > 0
                  ? roles.map((id) => `<@&${id}>`).join("\n")
                  : "No staff roles configured. Only server administrators have staff powers.",
            }),
          ],
          flags: MessageFlags.Ephemeral,
        }));
      }

      const role = interaction.options.getRole("role", true);

      if (sub === "add") {
        addStaffRole(guildId, role.id, interaction.user.id);
        return void (await interaction.reply({
          embeds: [successEmbed("Staff Role Added", `Members of <@&${role.id}> now have staff powers.`)],
          flags: MessageFlags.Ephemeral,
        }));
      }

      removeStaffRole(guildId, role.id);
      await interaction.reply({
        embeds: [successEmbed("Staff Role Removed", `<@&${role.id}> no longer has staff powers.`)],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
];
