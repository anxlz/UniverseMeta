/**
 * §6-§10: team points from the score gap. Winner and loser curves are evaluated
 * independently and are *not* assumed zero-sum (§9) — the supplied Hardpoint data
 * (+20/-5) is plainly asymmetric.
 *
 * Pure function of its inputs. No database, no Discord, no clock (§42, §43).
 */

import { evaluateCurve } from "./interpolation";
import { CURRENT_SCORING_VERSION, OUT_OF_RANGE_POLICY, getProfile } from "./scoring-config";
import type {
  CalibrationConfidence,
  TeamScoringInput,
  TeamScoringResult,
} from "./scoring.types";

export class TeamScoringError extends Error {}

const TRUSTED: CalibrationConfidence[] = ["CALIBRATED", "INTERPOLATED"];

/** Reports the weaker of the two confidences, so one shaky curve taints the result. */
function weakest(a: CalibrationConfidence, b: CalibrationConfidence): CalibrationConfidence {
  const rank: Record<CalibrationConfidence, number> = {
    CALIBRATED: 0,
    INTERPOLATED: 1,
    CLAMPED_LOW: 2,
    CLAMPED_HIGH: 2,
    EXTRAPOLATED: 3,
    INSUFFICIENT_CALIBRATION: 4,
  };
  return rank[a] >= rank[b] ? a : b;
}

export function calculateTeamPoints(input: TeamScoringInput): TeamScoringResult {
  const profile = getProfile(input.mode);
  const notes: string[] = [];

  if (!Number.isInteger(input.leftScore) || !Number.isInteger(input.rightScore)) {
    throw new TeamScoringError("Team scores must be integers.");
  }
  if (input.leftScore < 0 || input.rightScore < 0) {
    throw new TeamScoringError("Team scores cannot be negative.");
  }
  // §33 rule 4: exactly one side wins. A draw has no defined point outcome.
  if (input.leftScore === input.rightScore) {
    throw new TeamScoringError(
      "Scores are level — exactly one side must win before points can be calculated.",
    );
  }

  const leftWon = input.leftScore > input.rightScore;
  const winnerTeamId = leftWon ? input.leftTeamId : input.rightTeamId;
  const loserTeamId = leftWon ? input.rightTeamId : input.leftTeamId;

  const scoreGap = Math.abs(input.leftScore - input.rightScore);
  const gapPercentage = scoreGap / profile.referenceScore;

  const winner = evaluateCurve(profile.winnerCurve, gapPercentage, OUT_OF_RANGE_POLICY);
  const loser = evaluateCurve(profile.loserCurve, gapPercentage, OUT_OF_RANGE_POLICY);

  const confidence = weakest(winner.confidence, loser.confidence);
  const requiresCalibrationReview = !TRUSTED.includes(confidence);

  if (confidence === "INSUFFICIENT_CALIBRATION") {
    notes.push(
      `The ${input.mode} curve has only one calibration point, so a ${input.leftScore}-${input.rightScore} result cannot be interpolated. The value shown is a fallback — add more calibration points before trusting it.`,
    );
  } else if (confidence === "CLAMPED_LOW") {
    notes.push(
      `A gap of ${(gapPercentage * 100).toFixed(1)}% is below the lowest calibrated gap for ${input.mode}; the nearest calibrated value was used.`,
    );
  } else if (confidence === "CLAMPED_HIGH") {
    notes.push(
      `A gap of ${(gapPercentage * 100).toFixed(1)}% is above the highest calibrated gap for ${input.mode}; the nearest calibrated value was used.`,
    );
  } else if (confidence === "EXTRAPOLATED") {
    notes.push(
      `A gap of ${(gapPercentage * 100).toFixed(1)}% sits outside the calibrated range for ${input.mode} and was extrapolated.`,
    );
  }

  return {
    winnerTeamId,
    loserTeamId,
    winnerPoints: winner.points,
    loserPoints: loser.points,
    winnerExactPoints: winner.exactPoints,
    loserExactPoints: loser.exactPoints,
    scoreGap,
    gapPercentage,
    referenceScore: profile.referenceScore,
    confidence,
    requiresCalibrationReview,
    scoringVersion: CURRENT_SCORING_VERSION,
    notes,
  };
}
