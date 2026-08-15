/**
 * Team and roster operations. Command handlers call into here; none of this logic lives in
 * a slash-command handler (§9).
 */

import { and, asc, eq, like, or } from "drizzle-orm";
import { getDb } from "../db/client";
import { auditLog, players, teams, type Player, type Team } from "../db/schema";
import { newId, normalizeKey } from "../lib/ids";

export class TeamServiceError extends Error {}

export const REGIONS = [
  "NA",
  "SA",
  "EU",
  "ME",
  "AFRICA",
  "INDIA",
  "GARENA",
  "JAPAN",
  "CHINA",
] as const;
export type Region = (typeof REGIONS)[number];

export interface RegisterTeamInput {
  guildId: string;
  name: string;
  tag?: string | null;
  region?: Region | null;
  tier?: string | null;
  logoUrl?: string | null;
  captainDiscordId: string;
  captainIgn: string;
  captainUid?: string | null;
  actorDiscordId: string;
}

const MAX_ROSTER_SIZE = 10;

function audit(
  guildId: string,
  action: string,
  subjectType: "TEAM" | "PLAYER",
  subjectId: string,
  actorDiscordId: string,
  newValue: unknown,
  oldValue: unknown = null,
): void {
  getDb()
    .insert(auditLog)
    .values({
      id: newId(),
      guildId,
      subjectType,
      subjectId,
      action,
      oldValue,
      newValue,
      actorDiscordId,
    })
    .run();
}

export function findTeamByName(guildId: string, name: string): Team | undefined {
  return getDb()
    .select()
    .from(teams)
    .where(and(eq(teams.guildId, guildId), eq(teams.nameKey, normalizeKey(name))))
    .get();
}

export function getTeam(teamId: string): Team | undefined {
  return getDb().select().from(teams).where(eq(teams.id, teamId)).get();
}

export function findTeamsForMember(guildId: string, discordId: string): Team[] {
  const db = getDb();
  const captained = db
    .select()
    .from(teams)
    .where(
      and(
        eq(teams.guildId, guildId),
        eq(teams.captainDiscordId, discordId),
        eq(teams.active, true),
      ),
    )
    .all();

  const viaRoster = db
    .select({ team: teams })
    .from(players)
    .innerJoin(teams, eq(players.teamId, teams.id))
    .where(
      and(
        eq(players.guildId, guildId),
        eq(players.discordId, discordId),
        eq(players.active, true),
        eq(teams.active, true),
      ),
    )
    .all()
    .map((r) => r.team);

  const byId = new Map<string, Team>();
  for (const team of [...captained, ...viaRoster]) byId.set(team.id, team);
  return [...byId.values()];
}

/** Autocomplete source for the `opponent` option on `/matchregister`. */
export function searchTeams(guildId: string, query: string, limit = 25): Team[] {
  const db = getDb();
  const trimmed = query.trim();
  if (trimmed === "") {
    return db
      .select()
      .from(teams)
      .where(and(eq(teams.guildId, guildId), eq(teams.active, true)))
      .orderBy(asc(teams.name))
      .limit(limit)
      .all();
  }
  const key = `%${normalizeKey(trimmed)}%`;
  return db
    .select()
    .from(teams)
    .where(
      and(
        eq(teams.guildId, guildId),
        eq(teams.active, true),
        or(like(teams.nameKey, key), like(teams.tag, `%${trimmed}%`)),
      ),
    )
    .orderBy(asc(teams.name))
    .limit(limit)
    .all();
}

export function registerTeam(input: RegisterTeamInput): Team {
  const db = getDb();
  const nameKey = normalizeKey(input.name);

  if (nameKey.length < 2) {
    throw new TeamServiceError("Team name must contain at least two alphanumeric characters.");
  }
  if (input.name.length > 64) {
    throw new TeamServiceError("Team name must be 64 characters or fewer.");
  }
  if (findTeamByName(input.guildId, input.name)) {
    throw new TeamServiceError(`A team named "${input.name}" is already registered.`);
  }

  const existing = db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(
      and(
        eq(teams.guildId, input.guildId),
        eq(teams.captainDiscordId, input.captainDiscordId),
        eq(teams.active, true),
      ),
    )
    .get();
  if (existing) {
    throw new TeamServiceError(
      `You are already the captain of "${existing.name}". A captain may only lead one team.`,
    );
  }

  const teamId = newId();

  db.transaction((tx) => {
    tx.insert(teams)
      .values({
        id: teamId,
        guildId: input.guildId,
        name: input.name.trim(),
        nameKey,
        tag: input.tag?.trim() || null,
        region: input.region ?? null,
        tier: input.tier?.trim() || null,
        logoUrl: input.logoUrl?.trim() || null,
        captainDiscordId: input.captainDiscordId,
        registeredBy: input.actorDiscordId,
      })
      .run();

    tx.insert(players)
      .values({
        id: newId(),
        guildId: input.guildId,
        teamId,
        discordId: input.captainDiscordId,
        ign: input.captainIgn.trim(),
        ignKey: normalizeKey(input.captainIgn),
        uid: input.captainUid?.trim() || null,
        role: "CAPTAIN",
      })
      .run();
  });

  audit(input.guildId, "team_registered", "TEAM", teamId, input.actorDiscordId, {
    name: input.name,
    region: input.region ?? null,
  });

  return getTeam(teamId)!;
}

export interface AddPlayerInput {
  guildId: string;
  teamId: string;
  discordId?: string | null;
  ign: string;
  uid?: string | null;
  role?: "PLAYER" | "SUB";
  actorDiscordId: string;
}

export function addPlayer(input: AddPlayerInput): Player {
  const db = getDb();
  const ignKey = normalizeKey(input.ign);

  if (ignKey.length < 1) {
    throw new TeamServiceError("In-game name must contain at least one alphanumeric character.");
  }

  const roster = getRoster(input.teamId);
  if (roster.length >= MAX_ROSTER_SIZE) {
    throw new TeamServiceError(`Rosters are capped at ${MAX_ROSTER_SIZE} players.`);
  }
  if (roster.some((p) => p.ignKey === ignKey)) {
    throw new TeamServiceError(`"${input.ign}" is already on this roster.`);
  }
  if (input.discordId && roster.some((p) => p.discordId === input.discordId)) {
    throw new TeamServiceError("That Discord user is already on this roster.");
  }

  if (input.discordId) {
    const elsewhere = db
      .select({ teamName: teams.name })
      .from(players)
      .innerJoin(teams, eq(players.teamId, teams.id))
      .where(
        and(
          eq(players.guildId, input.guildId),
          eq(players.discordId, input.discordId),
          eq(players.active, true),
          eq(teams.active, true),
        ),
      )
      .get();
    if (elsewhere) {
      throw new TeamServiceError(
        `That player is already rostered on "${elsewhere.teamName}". Remove them there first.`,
      );
    }
  }

  const playerId = newId();
  db.insert(players)
    .values({
      id: playerId,
      guildId: input.guildId,
      teamId: input.teamId,
      discordId: input.discordId ?? null,
      ign: input.ign.trim(),
      ignKey,
      uid: input.uid?.trim() || null,
      role: input.role ?? "PLAYER",
    })
    .run();

  audit(input.guildId, "player_added", "PLAYER", playerId, input.actorDiscordId, {
    teamId: input.teamId,
    ign: input.ign,
  });

  return db.select().from(players).where(eq(players.id, playerId)).get()!;
}

export function removePlayer(
  guildId: string,
  teamId: string,
  ign: string,
  actorDiscordId: string,
): Player {
  const db = getDb();
  const ignKey = normalizeKey(ign);

  const player = db
    .select()
    .from(players)
    .where(and(eq(players.teamId, teamId), eq(players.ignKey, ignKey), eq(players.active, true)))
    .get();

  if (!player) throw new TeamServiceError(`"${ign}" is not on this roster.`);
  if (player.role === "CAPTAIN") {
    throw new TeamServiceError(
      "The captain cannot be removed from the roster. Transfer captaincy first.",
    );
  }

  // Soft delete: Phase 3 match_players rows reference this id and must stay resolvable.
  db.update(players).set({ active: false }).where(eq(players.id, player.id)).run();
  audit(guildId, "player_removed", "PLAYER", player.id, actorDiscordId, { active: false }, {
    active: true,
  });

  return player;
}

export function getRoster(teamId: string): Player[] {
  return getDb()
    .select()
    .from(players)
    .where(and(eq(players.teamId, teamId), eq(players.active, true)))
    .orderBy(asc(players.role), asc(players.ign))
    .all();
}
