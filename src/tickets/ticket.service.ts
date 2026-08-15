/**
 * §8: private match tickets.
 *
 * Privacy comes from explicit PermissionOverwrites rather than from the channel merely
 * being tucked inside a category — a category-level permission change would otherwise
 * silently expose every past match ticket.
 *
 * Closure is staff-only and hard-enforced in code (§5). It is not a toggle and there is no
 * configuration path that makes it one.
 */

import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type TextChannel,
} from "discord.js";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { auditLog, matches, type Match, type Team } from "../db/schema";
import { getConfig } from "../lib/automation-config";
import { discordTimestamp } from "../lib/datetime";
import { newId } from "../lib/ids";
import { logger } from "../lib/logger";
import {
  renderTemplate,
  slugifyChannelName,
  type TemplateContext,
} from "../lib/templates";
import { getRoster } from "../teams/team.service";

export class TicketError extends Error {}

/**
 * Everything a configurable string can interpolate. Built once per ticket so the name,
 * topic and welcome message can never disagree about which match they describe.
 */
export function buildTicketContext(
  guildId: string,
  match: Match,
  homeTeam: Team,
  awayTeam: Team,
): TemplateContext {
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: match.scheduledTimezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(match.scheduledAt);
  const part = (type: string) => local.find((p) => p.type === type)?.value ?? "00";

  return {
    home: homeTeam.tag || homeTeam.name,
    away: awayTeam.tag || awayTeam.name,
    id: match.publicMatchId,
    category: match.category.toLowerCase(),
    mode: match.mode ?? "tbd",
    kickoff: discordTimestamp(match.scheduledAt, "F"),
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
    captain_home: `<@${homeTeam.captainDiscordId}>`,
    captain_away: `<@${awayTeam.captainDiscordId}>`,
    league: getConfig(guildId, "league_name") || "the league",
  };
}

export function buildTicketName(template: string, context: TemplateContext): string {
  return slugifyChannelName(renderTemplate(template, context));
}

export function buildTicketTopic(template: string, context: TemplateContext): string {
  // Discord caps channel topics at 1024 characters.
  return renderTemplate(template, context).slice(0, 1024);
}

/** Who the opening message mentions. */
export function buildTicketPing(
  guildId: string,
  homeTeam: Team,
  awayTeam: Team,
): string | undefined {
  const mode = getConfig(guildId, "ticket_ping");
  const staffRoleId = getConfig(guildId, "ticket_staff_role_id");

  const captains = `<@${homeTeam.captainDiscordId}> <@${awayTeam.captainDiscordId}>`;
  const staff = staffRoleId ? `<@&${staffRoleId}>` : "";

  if (mode === "none") return undefined;
  if (mode === "staff") return staff || undefined;
  if (mode === "both") return [captains, staff].filter(Boolean).join(" ");
  return captains;
}

/**
 * Everyone who should see the ticket: both captains, both rosters (where a Discord account
 * is linked), the configured staff role, and the bot. @everyone is denied.
 */
function buildOverwrites(guild: Guild, homeTeam: Team, awayTeam: Team) {
  const overwrites: Array<{ id: string; allow?: bigint[]; deny?: bigint[] }> = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
  ];

  const memberAllow = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks,
  ];

  const discordIds = new Set<string>([homeTeam.captainDiscordId, awayTeam.captainDiscordId]);
  for (const team of [homeTeam, awayTeam]) {
    for (const player of getRoster(team.id)) {
      if (player.discordId) discordIds.add(player.discordId);
    }
  }
  for (const id of discordIds) overwrites.push({ id, allow: memberAllow });

  const staffRoleId = getConfig(guild.id, "ticket_staff_role_id");
  if (staffRoleId) {
    overwrites.push({
      id: staffRoleId,
      allow: [...memberAllow, PermissionFlagsBits.ManageMessages],
    });
  }

  if (guild.members.me) {
    overwrites.push({
      id: guild.members.me.id,
      allow: [...memberAllow, PermissionFlagsBits.ManageChannels],
    });
  }

  return overwrites;
}

export interface CreateTicketInput {
  guild: Guild;
  match: Match;
  homeTeam: Team;
  awayTeam: Team;
  actorDiscordId: string;
}

export async function createMatchTicket(input: CreateTicketInput): Promise<TextChannel> {
  const { guild, match, homeTeam, awayTeam } = input;

  if (match.ticketChannelId) {
    const existing = guild.channels.cache.get(match.ticketChannelId);
    if (existing) throw new TicketError("This match already has a ticket channel.");
  }

  const categoryId = getConfig(guild.id, "ticket_category_id");
  const context = buildTicketContext(guild.id, match, homeTeam, awayTeam);

  const channel = await guild.channels.create({
    name: buildTicketName(getConfig(guild.id, "ticket_name_template"), context),
    type: ChannelType.GuildText,
    parent: categoryId || undefined,
    topic: buildTicketTopic(getConfig(guild.id, "ticket_topic_template"), context),
    permissionOverwrites: buildOverwrites(guild, homeTeam, awayTeam),
    reason: `Match ticket for ${match.publicMatchId}`,
  });

  getDb()
    .update(matches)
    .set({ ticketChannelId: channel.id, updatedAt: new Date() })
    .where(eq(matches.id, match.id))
    .run();

  getDb()
    .insert(auditLog)
    .values({
      id: newId(),
      guildId: guild.id,
      matchId: match.id,
      subjectType: "MATCH",
      subjectId: match.id,
      action: "ticket_created",
      newValue: { channelId: channel.id },
      actorDiscordId: input.actorDiscordId,
    })
    .run();

  logger.info("ticket created", { matchId: match.publicMatchId, channelId: channel.id });
  return channel;
}

export type CloseBehavior = "delete" | "archive";

/**
 * §5/§8: staff-only, enforced here, never behind a toggle. *How* a ticket closes is
 * configurable; *who* may close it is not.
 */
export async function closeMatchTicket(
  member: GuildMember,
  match: Match,
  isStaff: boolean,
  reason: string | null,
  behaviorOverride?: CloseBehavior,
): Promise<CloseBehavior> {
  if (!isStaff) {
    throw new TicketError("Only league staff can close a match ticket.");
  }
  if (!match.ticketChannelId) throw new TicketError("This match has no open ticket.");

  const guild = member.guild;
  const behavior =
    behaviorOverride ??
    ((getConfig(guild.id, "ticket_close_behavior") as CloseBehavior) === "archive"
      ? "archive"
      : "delete");

  const channel = guild.channels.cache.get(match.ticketChannelId);
  const auditReason = reason ?? `Ticket closed by ${member.user.tag}`;

  getDb()
    .update(matches)
    .set({ ticketChannelId: null, updatedAt: new Date() })
    .where(eq(matches.id, match.id))
    .run();

  getDb()
    .insert(auditLog)
    .values({
      id: newId(),
      guildId: guild.id,
      matchId: match.id,
      subjectType: "MATCH",
      subjectId: match.id,
      action: "ticket_closed",
      oldValue: { channelId: match.ticketChannelId },
      newValue: { channelId: null, behavior },
      reason,
      actorDiscordId: member.id,
    })
    .run();

  if (!channel) return behavior;

  if (behavior === "delete") {
    await channel.delete(auditReason);
    return "delete";
  }

  /**
   * Archive: strip send access from everyone who had it, keep read access for staff, and
   * move it out of the active category. The channel survives as evidence if the result is
   * ever disputed.
   */
  if (channel.isTextBased() && "permissionOverwrites" in channel) {
    const archiveCategoryId = getConfig(guild.id, "ticket_archive_category_id");
    const staffRoleId = getConfig(guild.id, "ticket_staff_role_id");

    for (const overwrite of channel.permissionOverwrites.cache.values()) {
      await channel.permissionOverwrites.edit(overwrite.id, { SendMessages: false });
    }
    if (staffRoleId) {
      await channel.permissionOverwrites.edit(staffRoleId, {
        ViewChannel: true,
        SendMessages: false,
      });
    }
    if (archiveCategoryId) {
      await channel.setParent(archiveCategoryId, { lockPermissions: false });
    }
    await channel.setName(`closed-${channel.name}`.slice(0, 100)).catch(() => undefined);
  }

  return "archive";
}
