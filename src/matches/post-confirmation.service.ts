/**
 * §7.1 post-confirmation automation: create the private ticket, then log the match to the
 * configured channel. Both are toggle-gated and default on.
 *
 * This lives outside `match.service.ts` because it needs a Discord `Guild`, and §9 keeps
 * the scheduling service free of Discord objects so it stays callable from tests and any
 * future REST API. Both commands and the confirm button call in here, so confirming by
 * button and confirming by slash command produce identical side effects.
 *
 * Neither step can fail a confirmation. A missing permission or a deleted log channel is
 * reported to the confirming user and logged; the match stays confirmed regardless.
 */

import type { Guild, TextChannel } from "discord.js";
import type { Match, Team } from "../db/schema";
import { getConfig, getToggle } from "../lib/automation-config";
import { buildEmbed, field } from "../lib/embeds";
import { logger } from "../lib/logger";
import { discordTimestamp } from "../lib/datetime";
import { buildMatchEmbed } from "../discord/discord-match-embed.service";
import { renderTemplate } from "../lib/templates";
import { buildTicketContext, buildTicketPing, createMatchTicket } from "../tickets/ticket.service";

export interface PostConfirmationResult {
  ticketChannelId: string | null;
  loggedToChannelId: string | null;
  warnings: string[];
}

export async function runPostConfirmationAutomation(
  guild: Guild,
  match: Match,
  homeTeam: Team,
  awayTeam: Team,
  actorDiscordId: string,
): Promise<PostConfirmationResult> {
  const warnings: string[] = [];
  let ticketChannelId: string | null = null;
  let loggedToChannelId: string | null = null;

  if (getToggle(guild.id, "auto_ticket_creation") && !match.ticketChannelId) {
    try {
      const channel = await createMatchTicket({
        guild,
        match,
        homeTeam,
        awayTeam,
        actorDiscordId,
      });
      ticketChannelId = channel.id;

      const context = buildTicketContext(guild.id, match, homeTeam, awayTeam);

      await channel.send({
        content: buildTicketPing(guild.id, homeTeam, awayTeam),
        embeds: [
          buildEmbed({
            title: `Match Ticket — ${match.publicMatchId}`,
            description: renderTemplate(getConfig(guild.id, "ticket_welcome_message"), context),
            tone: "brand",
            guildId: guild.id,
            fields: [
              field("Fixture", `${homeTeam.name} vs ${awayTeam.name}`, false),
              field("Kickoff", discordTimestamp(match.scheduledAt, "F"), false),
              field("Match ID", match.publicMatchId),
              field("Category", match.category),
            ],
          }),
        ],
      });
    } catch (error) {
      // Most likely cause is a missing Manage Channels permission — say so plainly.
      warnings.push(
        "The match ticket could not be created automatically. Staff can open it with /ticketopen.",
      );
      logger.warn("auto ticket creation failed", {
        matchId: match.publicMatchId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (getToggle(guild.id, "auto_match_logging")) {
    const logChannelId = getConfig(guild.id, "match_announce_channel_id");
    if (logChannelId) {
      try {
        const channel = await guild.channels.fetch(logChannelId);
        if (channel?.isTextBased()) {
          await (channel as TextChannel).send({
            embeds: [
              buildMatchEmbed({
                match,
                homeTeam,
                awayTeam,
                note: ticketChannelId
                  ? `Confirmed. Ticket: <#${ticketChannelId}>`
                  : "Confirmed.",
              }),
            ],
          });
          loggedToChannelId = channel.id;
        } else {
          warnings.push("The configured match log channel is not a text channel.");
        }
      } catch (error) {
        warnings.push("The match could not be logged to the configured channel.");
        logger.warn("auto match logging failed", {
          matchId: match.publicMatchId,
          channelId: logChannelId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { ticketChannelId, loggedToChannelId, warnings };
}
