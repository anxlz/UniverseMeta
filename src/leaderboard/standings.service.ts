/**
 * §7.5 leaderboards.
 *
 * Every total is derived by aggregating point_transactions and match_players rather than
 * kept in a counter column, so a standing can never disagree with the audit trail. At league
 * scale this is a millisecond-range query against a local SQLite file.
 */

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { matchPlayers, matches, players, pointTransactions, teams } from "../db/schema";
import { REGIONS, type Region } from "../teams/team.service";

export const TEAM_SORTS = ["points", "kd", "kills", "objective", "wins", "winRate"] as const;
export type TeamSort = (typeof TEAM_SORTS)[number];

export const PLAYER_SORTS = [
  "points",
  "kills",
  "deaths",
  "kd",
  "objective",
  "assists",
  "impact",
  "mvp",
] as const;
export type PlayerSort = (typeof PLAYER_SORTS)[number];

export interface TeamStanding {
  teamId: string;
  name: string;
  tag: string | null;
  region: Region | null;
  logoUrl: string | null;
  points: number;
  wins: number;
  losses: number;
  winRate: number;
  kills: number;
  deaths: number;
  kd: number;
  objectiveSeconds: number;
}

export interface PlayerStanding {
  playerId: string;
  ign: string;
  discordId: string | null;
  teamName: string;
  region: Region | null;
  points: number;
  kills: number;
  deaths: number;
  assists: number;
  kd: number;
  objectiveSeconds: number;
  impact: number;
  matchesPlayed: number;
  /** Completed matches in which this player had the highest performance score. */
  mvps: number;
}

export interface StandingsQuery {
  guildId: string;
  region?: Region | null;
  limit?: number;
}

/** Only COMPLETED matches count — nothing pending approval reaches a leaderboard. */
const COMPLETED = sql`${matches.resultStatus} = 'COMPLETED'`;

export function getTeamStandings(query: StandingsQuery, sort: TeamSort = "points"): TeamStanding[] {
  const db = getDb();
  const limit = query.limit ?? 25;

  const teamRows = db
    .select()
    .from(teams)
    .where(
      query.region
        ? and(eq(teams.guildId, query.guildId), eq(teams.active, true), eq(teams.region, query.region))
        : and(eq(teams.guildId, query.guildId), eq(teams.active, true)),
    )
    .all();

  const standings: TeamStanding[] = teamRows.map((team) => {
    const points =
      db
        .select({ total: sql<number>`coalesce(sum(${pointTransactions.points}), 0)` })
        .from(pointTransactions)
        .where(
          and(eq(pointTransactions.teamId, team.id), eq(pointTransactions.pointType, "TEAM")),
        )
        .get()?.total ?? 0;

    const wins =
      db
        .select({ count: sql<number>`count(*)` })
        .from(matches)
        .where(and(eq(matches.winnerTeamId, team.id), COMPLETED))
        .get()?.count ?? 0;

    const losses =
      db
        .select({ count: sql<number>`count(*)` })
        .from(matches)
        .where(and(eq(matches.loserTeamId, team.id), COMPLETED))
        .get()?.count ?? 0;

    const stats = db
      .select({
        kills: sql<number>`coalesce(sum(${matchPlayers.kills}), 0)`,
        deaths: sql<number>`coalesce(sum(${matchPlayers.deaths}), 0)`,
        objective: sql<number>`coalesce(sum(${matchPlayers.objectiveTimeSeconds}), 0)`,
      })
      .from(matchPlayers)
      .innerJoin(matches, eq(matchPlayers.matchId, matches.id))
      .where(and(eq(matchPlayers.teamId, team.id), COMPLETED))
      .get();

    const played = wins + losses;
    const kills = stats?.kills ?? 0;
    const deaths = stats?.deaths ?? 0;

    return {
      teamId: team.id,
      name: team.name,
      tag: team.tag,
      region: team.region as Region | null,
      logoUrl: team.logoUrl,
      points,
      wins,
      losses,
      winRate: played === 0 ? 0 : wins / played,
      kills,
      deaths,
      kd: kills / Math.max(deaths, 1),
      objectiveSeconds: stats?.objective ?? 0,
    };
  });

  return sortTeams(standings, sort).slice(0, limit);
}

function sortTeams(rows: TeamStanding[], sort: TeamSort): TeamStanding[] {
  const key: Record<TeamSort, (t: TeamStanding) => number> = {
    points: (t) => t.points,
    kd: (t) => t.kd,
    kills: (t) => t.kills,
    objective: (t) => t.objectiveSeconds,
    wins: (t) => t.wins,
    winRate: (t) => t.winRate,
  };
  // Points break every tie, then name for a stable, deterministic order.
  return [...rows].sort(
    (a, b) => key[sort](b) - key[sort](a) || b.points - a.points || a.name.localeCompare(b.name),
  );
}

/**
 * MVP is not a stat the scoreboard reports, so it is derived: the player with the highest
 * performance score in a completed match earns one. Ties award nobody, which avoids
 * inflating the count on matches where scoring could not distinguish players.
 */
function countMvps(guildId: string): Map<string, number> {
  const db = getDb();
  const rows = db
    .select({
      matchId: matchPlayers.matchId,
      playerId: matchPlayers.playerId,
      performanceScore: matchPlayers.performanceScore,
    })
    .from(matchPlayers)
    .innerJoin(matches, eq(matchPlayers.matchId, matches.id))
    .where(and(eq(matches.guildId, guildId), COMPLETED))
    .all();

  const byMatch = new Map<string, Array<{ playerId: string; score: number }>>();
  for (const row of rows) {
    if (!row.playerId || row.performanceScore === null) continue;
    const list = byMatch.get(row.matchId) ?? [];
    list.push({ playerId: row.playerId, score: row.performanceScore });
    byMatch.set(row.matchId, list);
  }

  const counts = new Map<string, number>();
  for (const contenders of byMatch.values()) {
    if (contenders.length === 0) continue;
    const best = Math.max(...contenders.map((c) => c.score));
    const winners = contenders.filter((c) => c.score === best);
    if (winners.length !== 1) continue; // tie — no MVP awarded
    const winner = winners[0]!;
    counts.set(winner.playerId, (counts.get(winner.playerId) ?? 0) + 1);
  }
  return counts;
}

export function getPlayerStandings(
  query: StandingsQuery,
  sort: PlayerSort = "points",
): PlayerStanding[] {
  const db = getDb();
  const limit = query.limit ?? 25;
  const mvpCounts = countMvps(query.guildId);

  const rows = db
    .select({
      playerId: players.id,
      ign: players.ign,
      discordId: players.discordId,
      teamName: teams.name,
      region: teams.region,
      kills: sql<number>`coalesce(sum(${matchPlayers.kills}), 0)`,
      deaths: sql<number>`coalesce(sum(${matchPlayers.deaths}), 0)`,
      assists: sql<number>`coalesce(sum(${matchPlayers.assists}), 0)`,
      objective: sql<number>`coalesce(sum(${matchPlayers.objectiveTimeSeconds}), 0)`,
      impact: sql<number>`coalesce(sum(${matchPlayers.contribution}), 0)`,
      matchesPlayed: sql<number>`count(distinct ${matchPlayers.matchId})`,
    })
    .from(players)
    .innerJoin(teams, eq(players.teamId, teams.id))
    .leftJoin(matchPlayers, eq(matchPlayers.playerId, players.id))
    .leftJoin(matches, and(eq(matchPlayers.matchId, matches.id), COMPLETED))
    .where(
      query.region
        ? and(eq(players.guildId, query.guildId), eq(players.active, true), eq(teams.region, query.region))
        : and(eq(players.guildId, query.guildId), eq(players.active, true)),
    )
    .groupBy(players.id)
    .all();

  const standings: PlayerStanding[] = rows.map((row) => {
    const points =
      db
        .select({ total: sql<number>`coalesce(sum(${pointTransactions.points}), 0)` })
        .from(pointTransactions)
        .where(eq(pointTransactions.playerId, row.playerId))
        .get()?.total ?? 0;

    return {
      playerId: row.playerId,
      ign: row.ign,
      discordId: row.discordId,
      teamName: row.teamName,
      region: row.region as Region | null,
      points,
      kills: row.kills,
      deaths: row.deaths,
      assists: row.assists,
      kd: row.kills / Math.max(row.deaths, 1),
      objectiveSeconds: row.objective,
      impact: row.impact,
      matchesPlayed: row.matchesPlayed,
      mvps: mvpCounts.get(row.playerId) ?? 0,
    };
  });

  const key: Record<PlayerSort, (p: PlayerStanding) => number> = {
    points: (p) => p.points,
    kills: (p) => p.kills,
    deaths: (p) => p.deaths,
    kd: (p) => p.kd,
    objective: (p) => p.objectiveSeconds,
    assists: (p) => p.assists,
    impact: (p) => p.impact,
    mvp: (p) => p.mvps,
  };

  return [...standings]
    .sort((a, b) => key[sort](b) - key[sort](a) || b.points - a.points || a.ign.localeCompare(b.ign))
    .slice(0, limit);
}

export { REGIONS };
