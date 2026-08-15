/**
 * §5: staff-only actions are hard-enforced in code, never behind a toggle. *Which* role
 * counts as staff is configuration; *that* an action is staff-only is not.
 */

import { and, eq } from "drizzle-orm";
import { PermissionFlagsBits, type GuildMember } from "discord.js";
import { getDb } from "../db/client";
import { staffRoles, teams } from "../db/schema";

export function listStaffRoles(guildId: string): string[] {
  return getDb()
    .select({ roleId: staffRoles.roleId })
    .from(staffRoles)
    .where(eq(staffRoles.guildId, guildId))
    .all()
    .map((r) => r.roleId);
}

export function addStaffRole(guildId: string, roleId: string, addedBy: string): void {
  getDb().insert(staffRoles).values({ guildId, roleId, addedBy }).onConflictDoNothing().run();
}

export function removeStaffRole(guildId: string, roleId: string): void {
  getDb()
    .delete(staffRoles)
    .where(and(eq(staffRoles.guildId, guildId), eq(staffRoles.roleId, roleId)))
    .run();
}

/**
 * Server administrators always qualify — otherwise a fresh install has nobody able to run
 * `/staffrole add` and the bot is bricked on first boot.
 */
export function hasManagerPermission(member: GuildMember): boolean {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const configured = listStaffRoles(member.guild.id);
  if (configured.length === 0) return false;
  return member.roles.cache.hasAny(...configured);
}

/** Captains act on their own team only. Staff act on any team. */
export function isCaptainOf(teamId: string, discordId: string): boolean {
  const team = getDb()
    .select({ captainDiscordId: teams.captainDiscordId })
    .from(teams)
    .where(eq(teams.id, teamId))
    .get();
  return team?.captainDiscordId === discordId;
}

export function canActOnTeam(member: GuildMember, teamId: string): boolean {
  return isCaptainOf(teamId, member.id) || hasManagerPermission(member);
}
