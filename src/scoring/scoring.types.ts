export type GameMode = "hardpoint" | "search_and_destroy" | "control";

export type OutOfRangePolicy = "CLAMP" | "EXTRAPOLATE";

export interface CalibrationPoint {
  gapPercentage: number;
  points: number;
}

export interface ScoringProfile {
  referenceScore: number;
  winnerCurve: CalibrationPoint[];
  loserCurve: CalibrationPoint[];
}

export interface PlayerWeights {
  objective: number;
  kd: number;
  assists: number;
}

/**
 * How much the supplied calibration data actually supports a given result. Anything other
 * than CALIBRATED or INTERPOLATED means the number came from a fallback policy, not from
 * the client's data, and staff are told so before they approve.
 */
export type CalibrationConfidence =
  | "CALIBRATED"
  | "INTERPOLATED"
  | "CLAMPED_LOW"
  | "CLAMPED_HIGH"
  | "EXTRAPOLATED"
  | "INSUFFICIENT_CALIBRATION";

export interface CurveResult {
  points: number;
  exactPoints: number;
  confidence: CalibrationConfidence;
}

export interface TeamScoringInput {
  mode: GameMode;
  leftScore: number;
  rightScore: number;
  leftTeamId: string;
  rightTeamId: string;
}

export interface TeamScoringResult {
  winnerTeamId: string;
  loserTeamId: string;
  winnerPoints: number;
  loserPoints: number;
  winnerExactPoints: number;
  loserExactPoints: number;
  scoreGap: number;
  gapPercentage: number;
  referenceScore: number;
  confidence: CalibrationConfidence;
  requiresCalibrationReview: boolean;
  scoringVersion: string;
  notes: string[];
}

export interface PlayerRawStats {
  playerKey: string;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  objectiveTimeSeconds: number | null;
}

export interface PlayerNormalizedStats {
  kd: number | null;
  objective: number | null;
  assists: number | null;
}

export interface PlayerScoringResult {
  playerKey: string;
  raw: PlayerRawStats;
  normalized: PlayerNormalizedStats;
  performanceScore: number;
  matchPoints: number;
  /** True while any slot in the match is unresolved (§27). */
  provisional: boolean;
  notes: string[];
}
