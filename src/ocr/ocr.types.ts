/**
 * The OCR JSON contract (§7.3.2 / §31). This mirrors what the microservice returns; the
 * validator in ocr-validator.ts is what decides whether any of it can be trusted.
 *
 * Every numeric field is `number | null` on purpose: `null` is unknown/unreadable, `0` is
 * an explicitly displayed zero, and the two are never interchangeable (§21).
 */

export type OcrGameMode = "hardpoint" | "search_and_destroy" | "control";

export type IdentityStatus =
  | "IDENTIFIED"
  | "STREAMER_MODE_ANONYMOUS"
  | "OCR_UNREADABLE"
  | "AMBIGUOUS";

export interface OcrPlayer {
  side: "left" | "right";
  slot: number;
  rowPresent: boolean;
  name: string | null;
  identityStatus: IdentityStatus;
  score: number | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  objectiveTimeSeconds: number | null;
  contribution: number | null;
  additionalStats: Record<string, unknown>;
  confidence?: Record<string, number | null>;
}

export interface OcrMatch {
  mode: OcrGameMode | null;
  map: string | null;
  streamer_mode_enabled: boolean;
  leftScore: number | null;
  rightScore: number | null;
  leftResult: "win" | "loss" | null;
  rightResult: "win" | "loss" | null;
  scoreGap: number | null;
  gapPercentage: number | null;
  dateTime: string | null;
}

export interface OcrSide {
  teamName: string | null;
  players: OcrPlayer[];
}

export interface OcrResponse {
  match: OcrMatch | null;
  teams: { left: OcrSide; right: OcrSide };
  teamPointsPreview: { left: number | null; right: number | null; authoritative: boolean };
  validation: { valid: boolean; issues: string[] };
}

/** §32 — the fixed vocabulary of rejection reasons. */
export const OCR_ISSUE_CODES = [
  "Could not identify game mode",
  "Could not identify final score",
  "Could not identify both scoreboard sides",
  "Scoreboard is cropped",
  "Image is too blurry",
  "Conflicting OCR values",
  "Not a CODM scoreboard",
] as const;
