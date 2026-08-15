/**
 * §17: raw statistics sit on incompatible scales, so each is normalized to 0-1 before the
 * weights are applied.
 *
 * `null` means unknown and stays `null` all the way through — it is never coerced to 0
 * (§21). A player with unknown assists is not a player with zero assists.
 */

import { FIXED_BASELINES, NORMALIZATION_MODE } from "./scoring-config";
import type { PlayerNormalizedStats, PlayerRawStats } from "./scoring.types";

/** §17: never divide by zero — a player with 0 deaths is treated as having 1. */
export function computeKd(kills: number | null, deaths: number | null): number | null {
  if (kills === null) return null;
  return kills / Math.max(deaths ?? 1, 1);
}

function ratio(value: number | null, max: number): number | null {
  if (value === null) return null;
  if (max <= 0) return 0;
  return Math.min(1, Math.max(0, value / max));
}

/**
 * Scale each stat against the best value present in the same match.
 *
 * This is what makes §27 necessary: adding a missing player later can raise a maximum and
 * therefore change everyone's normalized value, so scores stay provisional until every slot
 * is resolved, and any recalculation is logged.
 */
export function normalizePopulation(population: PlayerRawStats[]): Map<string, PlayerNormalizedStats> {
  const kds = population.map((p) => computeKd(p.kills, p.deaths)).filter((v): v is number => v !== null);
  const objectives = population
    .map((p) => p.objectiveTimeSeconds)
    .filter((v): v is number => v !== null);
  const assists = population.map((p) => p.assists).filter((v): v is number => v !== null);

  const maxKd = kds.length > 0 ? Math.max(...kds) : 0;
  const maxObjective = objectives.length > 0 ? Math.max(...objectives) : 0;
  const maxAssists = assists.length > 0 ? Math.max(...assists) : 0;

  const result = new Map<string, PlayerNormalizedStats>();
  for (const player of population) {
    result.set(player.playerKey, {
      kd: ratio(computeKd(player.kills, player.deaths), maxKd),
      objective: ratio(player.objectiveTimeSeconds, maxObjective),
      assists: ratio(player.assists, maxAssists),
    });
  }
  return result;
}

export function normalizeFixed(player: PlayerRawStats): PlayerNormalizedStats {
  return {
    kd: ratio(computeKd(player.kills, player.deaths), FIXED_BASELINES.kd),
    objective: ratio(player.objectiveTimeSeconds, FIXED_BASELINES.objectiveTimeSeconds),
    assists: ratio(player.assists, FIXED_BASELINES.assists),
  };
}

export function normalize(population: PlayerRawStats[]): Map<string, PlayerNormalizedStats> {
  if (NORMALIZATION_MODE === "POPULATION_RELATIVE") return normalizePopulation(population);
  return new Map(population.map((p) => [p.playerKey, normalizeFixed(p)]));
}

/** §14: Hardpoint objective time is MM:SS on the scoreboard, seconds everywhere else. */
export function parseObjectiveTime(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;

  const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (match) {
    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    if (seconds > 59) return null;
    return minutes * 60 + seconds;
  }

  const asNumber = Number(trimmed);
  return Number.isInteger(asNumber) && asNumber >= 0 ? asNumber : null;
}
