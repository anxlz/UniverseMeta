/**
 * Calibration curves and weights. Versioned (§10 of the source spec): every match stores
 * the `scoringVersion` it was scored under, and old matches are never silently rescored.
 *
 * IMPORTANT — the supplied calibration points do not uniquely determine a formula (§45).
 * Only the points the client actually gave are encoded below. Nothing is invented to make
 * a curve look complete; where the data runs out, the engine says so (see
 * `CalibrationConfidence` in scoring.types.ts) rather than guessing a plausible number.
 */

import type { GameMode, ScoringProfile, PlayerWeights, OutOfRangePolicy } from "./scoring.types";

export const CURRENT_SCORING_VERSION = "v1.0";

/**
 * Reference scores per §8. Note S&D uses 20 rather than 9: with a regulation max of 9, all
 * realistic S&D gaps land between 0.05 and 0.45 of the curve. That is the client's stated
 * figure, kept as given — flagged in the README as worth confirming.
 */
export const SCORING_PROFILES: Record<GameMode, ScoringProfile> = {
  hardpoint: {
    referenceScore: 250,
    // 250-240 → gap 10 → 0.04 ; 250-40 → gap 210 → 0.84
    winnerCurve: [
      { gapPercentage: 0.04, points: 20 },
      { gapPercentage: 0.84, points: 45 },
    ],
    loserCurve: [
      { gapPercentage: 0.04, points: -5 },
      { gapPercentage: 0.84, points: -25 },
    ],
  },

  search_and_destroy: {
    referenceScore: 20,
    // 14-12 OT → gap 2 → 0.10 ; 9-3 → gap 6 → 0.30
    winnerCurve: [
      { gapPercentage: 0.1, points: 15 },
      { gapPercentage: 0.3, points: 35 },
    ],
    loserCurve: [
      { gapPercentage: 0.1, points: -10 },
      { gapPercentage: 0.3, points: -25 },
    ],
  },

  /**
   * Only one calibration point was supplied (4-0 → +45/-45), and interpolation needs two.
   * Every other Control result — 4-3, 4-2, 4-1 — therefore falls outside the calibrated
   * range and is reported as INSUFFICIENT_CALIBRATION. The engine still returns a usable
   * number under the configured out-of-range policy, but flags the match for staff so
   * nobody mistakes a fallback for a calibrated result.
   *
   * Fix: get 4-3, 4-2 and 4-1 from the client and add them here.
   */
  control: {
    referenceScore: 4,
    winnerCurve: [{ gapPercentage: 1.0, points: 45 }],
    loserCurve: [{ gapPercentage: 1.0, points: -45 }],
  },
};

/**
 * What to do when a score gap falls outside the calibrated range.
 *
 * CLAMP holds the nearest calibrated value. EXTRAPOLATE continues the slope of the nearest
 * segment, which for Hardpoint 250-249 would run points *below* the +20 floor and is
 * usually not what a league wants. CLAMP is the default because it fails toward a known
 * number rather than an invented one; either way the result is flagged.
 */
export const OUT_OF_RANGE_POLICY: OutOfRangePolicy = "CLAMP";

/** §12 — Objective > K/D > Assists. Configurable, must sum to 1. */
export const PLAYER_WEIGHTS: PlayerWeights = {
  objective: 0.5,
  kd: 0.3,
  assists: 0.2,
};

/**
 * Performance score (0-100) → player match points.
 * Calibrated against the worked example in §26: performance 73.42 → +18.
 */
export const PLAYER_POINT_SCALE = 0.25;

/**
 * §17: raw values sit on wildly different scales (a K/D of 2.1 vs 80 objective seconds), so
 * they are normalized before weighting.
 *
 * POPULATION_RELATIVE scales each stat against the best value in the same match, which is
 * what §27 anticipates when it warns that adding a missing player can shift everyone's
 * normalization and must trigger a flagged recalculation.
 */
export const NORMALIZATION_MODE = "POPULATION_RELATIVE" as const;

/** Used only when NORMALIZATION_MODE is FIXED_BASELINE. */
export const FIXED_BASELINES = {
  objectiveTimeSeconds: 120,
  kd: 2.0,
  assists: 15,
};

export function getProfile(mode: GameMode): ScoringProfile {
  const profile = SCORING_PROFILES[mode];
  if (!profile) throw new Error(`No scoring profile configured for mode: ${mode}`);
  return profile;
}
