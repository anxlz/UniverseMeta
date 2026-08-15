/**
 * §11-§18: player points, calculated entirely independently of team points.
 *
 * Never `teamPoints / numberOfPlayers` and never the same value for every player (§11):
 * a team can win with one player performing badly, or lose with one playing exceptionally.
 */

import { roundPoints } from "./interpolation";
import { normalize } from "./normalization";
import { PLAYER_POINT_SCALE, PLAYER_WEIGHTS } from "./scoring-config";
import type { PlayerRawStats, PlayerScoringResult } from "./scoring.types";

export class PlayerScoringError extends Error {}

function assertWeightsValid(): void {
  const sum = PLAYER_WEIGHTS.objective + PLAYER_WEIGHTS.kd + PLAYER_WEIGHTS.assists;
  if (Math.abs(sum - 1) > 1e-9) {
    throw new PlayerScoringError(`Player weights must sum to 1 — currently ${sum}.`);
  }
}

/**
 * Scores every player in one match together, because population-relative normalization
 * needs the whole set at once.
 *
 * @param provisional true while any slot in the match is still unresolved (§27). Passed
 *   through onto every result so nothing gets finalised on a partial population.
 */
export function calculatePlayerPoints(
  population: PlayerRawStats[],
  provisional: boolean,
): PlayerScoringResult[] {
  assertWeightsValid();

  const normalized = normalize(population);

  return population.map((raw) => {
    const norm = normalized.get(raw.playerKey) ?? { kd: null, objective: null, assists: null };
    const notes: string[] = [];

    /**
     * Unknown components are dropped and the remaining weights renormalized, rather than
     * being scored as zero (§21). S&D and Control usually expose no objective time at all
     * (§14), so without this every S&D player would lose 50% of their score for a stat the
     * game never showed.
     */
    const components: Array<{ value: number; weight: number }> = [];
    if (norm.objective !== null) {
      components.push({ value: norm.objective, weight: PLAYER_WEIGHTS.objective });
    } else {
      notes.push("No objective time available for this mode — weight redistributed.");
    }
    if (norm.kd !== null) components.push({ value: norm.kd, weight: PLAYER_WEIGHTS.kd });
    if (norm.assists !== null) {
      components.push({ value: norm.assists, weight: PLAYER_WEIGHTS.assists });
    }

    const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);

    let performanceScore = 0;
    if (totalWeight === 0) {
      notes.push("No usable statistics — performance score is 0 and requires staff review.");
    } else {
      const weighted = components.reduce((sum, c) => sum + c.value * c.weight, 0);
      performanceScore = (weighted / totalWeight) * 100;
    }

    return {
      playerKey: raw.playerKey,
      raw,
      normalized: norm,
      // Two decimals keeps the §26 worked example (73.42) reproducible exactly.
      performanceScore: Math.round(performanceScore * 100) / 100,
      matchPoints: roundPoints(performanceScore * PLAYER_POINT_SCALE),
      provisional,
      notes,
    };
  });
}
