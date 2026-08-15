/**
 * Ticket command family (§8). Closure is staff-only and hard-enforced in the service.
 */

import {
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import { CONFIG_KEYS, getConfig, setConfig } from "../lib/automation-config";
import { buildEmbed, field, replyError, successEmbed } from "../lib/embeds";
import {
  PLACEHOLDERS,
  SAMPLE_CONTEXT,
  renderTemplate,
  slugifyChannelName,
  validateTemplate,
} from "../lib/templates";
import { hasManagerPermission } from "../lib/permissions";
import { getMatchByPublicId } from "../matches/match.service";
import {
  TicketError,
  buildTicketContext,
  buildTicketPing,
  closeMatchTicket,
  createMatchTicket,
} from "../tickets/ticket.service";
import { getTeam } from "../teams/team.service";
import type { CommandModule } from "./types";

const categoryLabel = (id: string) => (id ? `<#${id}>` : "Not set");
const roleLabel = (id: string) => (id ? `<@&${id}>` : "Not set");

const ticketConfig = new SlashCommandBuilder()
  .setName("ticketconfig")
  .setDescription("Configure match ticket channels")
  .addSubcommand((s) => s.setName("show").setDescription("Show every ticket setting"))
  .addSubcommand((s) =>
    s.setName("preview").setDescription("Preview the channel name, topic and welcome message"),
  )
  .addSubcommand((s) =>
    s.setName("placeholders").setDescription("List every placeholder templates can use"),
  )
  .addSubcommand((s) =>
    s
      .setName("name")
      .setDescription("Channel naming template")
      .addStringOption((o) =>
        o
          .setName("template")
          .setDescription("e.g. match-{home}-vs-{away}")
          .setRequired(true)
          .setMaxLength(100),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("topic")
      .setDescription("Channel topic template")
      .addStringOption((o) =>
        o
          .setName("template")
          .setDescription("e.g. {id} — {home} vs {away}")
          .setRequired(true)
          .setMaxLength(500),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("category")
      .setDescription("Discord category new tickets are created in")
      .addChannelOption((o) =>
        o
          .setName("category")
          .setDescription("Category channel")
          .addChannelTypes(ChannelType.GuildCategory)
          .setRequired(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("welcome")
      .setDescription("Welcome message posted in each new ticket")
      .addStringOption((o) =>
        o
          .setName("message")
          .setDescription("Supports placeholders and \\n for line breaks")
          .setRequired(true)
          .setMaxLength(1000),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("staffrole")
      .setDescription("Role granted access to every match ticket")
      .addRoleOption((o) => o.setName("role").setDescription("Staff role").setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName("ping")
      .setDescription("Who gets mentioned when a ticket opens")
      .addStringOption((o) =>
        o
          .setName("who")
          .setDescription("Mention target")
          .setRequired(true)
          .addChoices(
            { name: "Both captains", value: "captains" },
            { name: "Staff role", value: "staff" },
            { name: "Captains and staff", value: "both" },
            { name: "Nobody", value: "none" },
          ),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("close")
      .setDescription("What /ticketclose does to the channel")
      .addStringOption((o) =>
        o
          .setName("behavior")
          .setDescription("Delete or archive")
          .setRequired(true)
          .addChoices(
            { name: "Delete the channel", value: "delete" },
            { name: "Archive as a read-only record", value: "archive" },
          ),
      )
      .addChannelOption((o) =>
        o
          .setName("archive_category")
          .setDescription("Category archived tickets move to")
          .addChannelTypes(ChannelType.GuildCategory),
      ),
  )
  .addSubcommand((s) =>
    s.setName("reset").setDescription("Reset ticket templates to their defaults"),
  );

const ticketOpen = new SlashCommandBuilder()
  .setName("ticketopen")
  .setDescription("Manually open the match ticket for a confirmed match")
  .addStringOption((o) => o.setName("match_id").setDescription("Match ID").setRequired(true));

const ticketClose = new SlashCommandBuilder()
  .setName("ticketclose")
  .setDescription("Close a match ticket (staff only)")
  .addStringOption((o) => o.setName("match_id").setDescription("Match ID").setRequired(true))
  .addStringOption((o) => o.setName("reason").setDescription("Reason").setMaxLength(200));

export const ticketCommands: CommandModule[] = [
  {
    data: ticketConfig,
    async execute(interaction: ChatInputCommandInteraction) {
      const member = interaction.member as GuildMember;
      if (!hasManagerPermission(member)) {
        return replyError(interaction, "This command is restricted to league staff.");
      }

      const guildId = interaction.guildId!;
      const actor = member.id;
      const sub = interaction.options.getSubcommand();

      /**
       * Every template goes through here before it is stored. A typo caught now is a
       * one-line error message; the same typo stored is a live channel called
       * `match-{hoem}-vs-brv` that nobody can explain.
       */
      const storeTemplate = async (
        key: "ticket_name_template" | "ticket_topic_template" | "ticket_welcome_message",
        raw: string,
        title: string,
        renderPreview: (rendered: string) => string,
      ): Promise<void> => {
        const template = raw.replaceAll("\\n", "\n");
        const validation = validateTemplate(template);

        if (!validation.valid) {
          await replyError(
            interaction,
            `Unknown placeholder(s): ${validation.unknown
              .map((u) => `{${u}}`)
              .join(", ")}. Run /ticketconfig placeholders to see the valid list.`,
          );
          return;
        }

        setConfig(guildId, key, template as never, actor);
        await interaction.reply({
          embeds: [
            buildEmbed({
              title,
              description: "Saved. This is how it renders with sample data.",
              tone: "confirmed",
              guildId,
              fields: [
                field("Template", template, false),
                field("Preview", renderPreview(renderTemplate(template, SAMPLE_CONTEXT)), false),
                field(
                  "Placeholders used",
                  validation.used.length > 0
                    ? validation.used.map((u) => `{${u}}`).join(", ")
                    : "none",
                  false,
                ),
              ],
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
      };

      if (sub === "placeholders") {
        return void (await interaction.reply({
          embeds: [
            buildEmbed({
              title: "Template Placeholders",
              description:
                "Usable in the ticket name, topic and welcome message. Anything else is rejected when you save.",
              tone: "brand",
              guildId,
              fields: Object.entries(PLACEHOLDERS).map(([key, description]) =>
                field(`{${key}}`, description, false),
              ),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        }));
      }

      if (sub === "show") {
        const behavior = getConfig(guildId, "ticket_close_behavior");
        const archiveCategory = getConfig(guildId, "ticket_archive_category_id");
        return void (await interaction.reply({
          embeds: [
            buildEmbed({
              title: "Ticket Settings",
              tone: "brand",
              guildId,
              fields: [
                field("Name template", getConfig(guildId, "ticket_name_template"), false),
                field("Topic template", getConfig(guildId, "ticket_topic_template"), false),
                field("Category", categoryLabel(getConfig(guildId, "ticket_category_id"))),
                field("Staff role", roleLabel(getConfig(guildId, "ticket_staff_role_id"))),
                field("Ping on open", getConfig(guildId, "ticket_ping")),
                field(
                  "On close",
                  behavior === "archive"
                    ? `Archive to ${categoryLabel(archiveCategory)}`
                    : "Delete the channel",
                ),
                field("Welcome", getConfig(guildId, "ticket_welcome_message"), false),
              ],
            }),
          ],
          flags: MessageFlags.Ephemeral,
        }));
      }

      if (sub === "preview") {
        const nameTemplate = getConfig(guildId, "ticket_name_template");
        const topicTemplate = getConfig(guildId, "ticket_topic_template");
        const welcomeTemplate = getConfig(guildId, "ticket_welcome_message");

        // Renders through the same helpers the real ticket uses, so the preview cannot
        // drift from what actually gets created.
        return void (await interaction.reply({
          embeds: [
            buildEmbed({
              title: "Ticket Preview",
              description: "Exactly what the next confirmed match would produce.",
              tone: "brand",
              guildId,
              fields: [
                field("Channel name", `#${slugifyChannelName(renderTemplate(nameTemplate, SAMPLE_CONTEXT))}`, false),
                field("Topic", renderTemplate(topicTemplate, SAMPLE_CONTEXT), false),
              ],
            }),
            buildEmbed({
              title: `Match Ticket — ${SAMPLE_CONTEXT.id}`,
              description: renderTemplate(welcomeTemplate, SAMPLE_CONTEXT),
              tone: "brand",
              guildId,
              fields: [
                field("Fixture", `${SAMPLE_CONTEXT.home} vs ${SAMPLE_CONTEXT.away}`, false),
                field("Match ID", SAMPLE_CONTEXT.id),
                field("Category", SAMPLE_CONTEXT.category),
              ],
            }),
          ],
          flags: MessageFlags.Ephemeral,
        }));
      }

      if (sub === "name") {
        return void (await storeTemplate(
          "ticket_name_template",
          interaction.options.getString("template", true),
          "Ticket Naming Updated",
          (rendered) => `#${slugifyChannelName(rendered)}`,
        ));
      }

      if (sub === "topic") {
        return void (await storeTemplate(
          "ticket_topic_template",
          interaction.options.getString("template", true),
          "Ticket Topic Updated",
          (rendered) => rendered.slice(0, 1024),
        ));
      }

      if (sub === "welcome") {
        return void (await storeTemplate(
          "ticket_welcome_message",
          interaction.options.getString("message", true),
          "Welcome Message Updated",
          (rendered) => rendered,
        ));
      }

      if (sub === "category") {
        const channel = interaction.options.getChannel("category", true);
        setConfig(guildId, "ticket_category_id", channel.id as never, actor);
        return void (await interaction.reply({
          embeds: [
            successEmbed("Ticket Category Updated", `Tickets will be created in ${channel.name}.`, guildId),
          ],
          flags: MessageFlags.Ephemeral,
        }));
      }

      if (sub === "staffrole") {
        const role = interaction.options.getRole("role", true);
        setConfig(guildId, "ticket_staff_role_id", role.id as never, actor);
        return void (await interaction.reply({
          embeds: [
            successEmbed(
              "Ticket Staff Role Updated",
              `<@&${role.id}> will be added to every ticket.`,
              guildId,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        }));
      }

      if (sub === "ping") {
        const who = interaction.options.getString("who", true);
        setConfig(guildId, "ticket_ping", who as never, actor);
        const label: Record<string, string> = {
          captains: "Both captains are mentioned when a ticket opens.",
          staff: "The staff role is mentioned when a ticket opens.",
          both: "Both captains and the staff role are mentioned when a ticket opens.",
          none: "Nobody is mentioned when a ticket opens.",
        };
        return void (await interaction.reply({
          embeds: [successEmbed("Ticket Ping Updated", label[who]!, guildId)],
          flags: MessageFlags.Ephemeral,
        }));
      }

      if (sub === "close") {
        const behavior = interaction.options.getString("behavior", true);
        const archiveCategory = interaction.options.getChannel("archive_category");

        setConfig(guildId, "ticket_close_behavior", behavior as never, actor);
        if (archiveCategory) {
          setConfig(guildId, "ticket_archive_category_id", archiveCategory.id as never, actor);
        }

        if (behavior === "archive" && !archiveCategory && !getConfig(guildId, "ticket_archive_category_id")) {
          return void (await interaction.reply({
            embeds: [
              buildEmbed({
                title: "Close Behaviour Updated",
                description:
                  "Tickets will be archived rather than deleted. No archive category is set, so they will stay where they are — locked read-only but still in the active category. Set one with the archive_category option.",
                tone: "pending",
                guildId,
              }),
            ],
            flags: MessageFlags.Ephemeral,
          }));
        }

        return void (await interaction.reply({
          embeds: [
            successEmbed(
              "Close Behaviour Updated",
              behavior === "archive"
                ? "Closed tickets become read-only records instead of being deleted."
                : "Closed tickets are deleted.",
              guildId,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        }));
      }

      // reset
      for (const key of ["ticket_name_template", "ticket_topic_template", "ticket_welcome_message"] as const) {
        setConfig(guildId, key, CONFIG_KEYS[key].default as never, actor);
      }
      await interaction.reply({
        embeds: [
          successEmbed(
            "Ticket Templates Reset",
            "Name, topic and welcome message are back to their defaults. Category, staff role and close behaviour were left alone.",
            guildId,
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },

  {
    data: ticketOpen,
    async execute(interaction: ChatInputCommandInteraction) {
      const member = interaction.member as GuildMember;
      const match = getMatchByPublicId(
        interaction.guildId!,
        interaction.options.getString("match_id", true),
      );
      if (!match) return replyError(interaction, "Match not found.");

      const homeTeam = getTeam(match.homeTeamId)!;
      const awayTeam = getTeam(match.awayTeamId)!;
      const participant =
        homeTeam.captainDiscordId === member.id || awayTeam.captainDiscordId === member.id;
      if (!participant && !hasManagerPermission(member)) {
        return replyError(interaction, "Only a participating captain or staff can open this ticket.");
      }
      if (match.scheduleStatus !== "CONFIRMED") {
        return replyError(interaction, "Tickets open once the match is confirmed by both teams.");
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const channel = await createMatchTicket({
          guild: interaction.guild!,
          match,
          homeTeam,
          awayTeam,
          actorDiscordId: member.id,
        });
        const context = buildTicketContext(interaction.guildId!, match, homeTeam, awayTeam);
        await channel.send({
          content: buildTicketPing(interaction.guildId!, homeTeam, awayTeam),
          embeds: [
            buildEmbed({
              title: `Match Ticket — ${match.publicMatchId}`,
              description: renderTemplate(
                getConfig(interaction.guildId!, "ticket_welcome_message"),
                context,
              ),
              tone: "brand",
              guildId: interaction.guildId!,
              fields: [
                field("Fixture", `${homeTeam.name} vs ${awayTeam.name}`, false),
                field("Match ID", match.publicMatchId),
                field("Category", match.category),
              ],
            }),
          ],
        });
        await interaction.editReply({
          embeds: [successEmbed("Ticket Opened", `Match ticket created: <#${channel.id}>`)],
        });
      } catch (error) {
        if (error instanceof TicketError) {
          return void (await interaction.editReply({ content: error.message }));
        }
        throw error;
      }
    },
  },

  {
    data: ticketClose,
    async execute(interaction: ChatInputCommandInteraction) {
      const member = interaction.member as GuildMember;
      const match = getMatchByPublicId(
        interaction.guildId!,
        interaction.options.getString("match_id", true),
      );
      if (!match) return replyError(interaction, "Match not found.");

      try {
        // Staff-only is enforced inside the service, not by this check alone.
        const behavior = await closeMatchTicket(
          member,
          match,
          hasManagerPermission(member),
          interaction.options.getString("reason"),
        );
        await interaction.reply({
          embeds: [
            successEmbed(
              "Ticket Closed",
              behavior === "archive"
                ? `The ticket for ${match.publicMatchId} was archived as a read-only record.`
                : `The ticket for ${match.publicMatchId} was deleted.`,
              interaction.guildId,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
      } catch (error) {
        if (error instanceof TicketError) return replyError(interaction, error.message);
        throw error;
      }
    },
  },
];
