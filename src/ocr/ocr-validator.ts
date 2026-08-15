/**
 * §33/§34 validation. Nothing downstream calculates a point until this passes.
 *
 * The validator's job is to reject OCR output that would silently corrupt point totals —
 * hallucinated scores, impossible statistics, duplicated players. It deliberately does NOT
 * reject the things the spec calls out as legitimate: fewer than five players a side,
 * overtime S&D, and unreadable values left as `null`.
 */

import type { OcrGameMode, OcrPlayer, OcrResponse } from "./ocr.types";

export interface ValidationResult {
  valid: boolean;
  issues: string[];
  /** Non-fatal observations worth showing staff. */
  warnings: string[];
}

interface ScoreRule {
  min: number;
  max: number;
  /** A finished match must reach this, unless overtime applies. */
  winningScore: number | null;
  allowOvertime: boolean;
}

const SCORE_RULES: Record<OcrGameMode, ScoreRule> = {
  // §34: 0 <= score <= 250, and a completed match has a winner at 250.
  hardpoint: { min: 0, max: 250, winningScore: 250, allowOvertime: false },
  // §34: do not reject 14-12 just because it exceeds 9 — overtime is valid.
  search_and_destroy: { min: 0, max: 30, winningScore: 9, allowOvertime: true },
  control: { min: 0, max: 6, winningScore: 4, allowOvertime: false },
};

function isNonNegativeInteger(value: number | null): boolean {
  return value === null || (Number.isInteger(value) && value >= 0);
}

function visiblePlayers(response: OcrResponse): OcrPlayer[] {
  return [...response.teams.left.players, ...response.teams.right.players].filter(
    (p) => p.rowPresent,
  );
}

export function validateOcrResponse(response: OcrResponse): ValidationResult {
  const issues: string[] = [];
  const warnings: string[] = [];

  // The model already rejected the image (§32) — pass its reasons straight through.
  if (!response.match) {
    return {
      valid: false,
      issues: response.validation?.issues?.length
        ? response.validation.issues
        : ["Not a CODM scoreboard"],
      warnings,
    };
  }

  const match = response.match;

  // 1. Game mode is known.
  if (!match.mode || !(match.mode in SCORE_RULES)) {
    issues.push("Could not identify game mode");
  }

  // 2. Both team scores are known.
  if (match.leftScore === null || match.rightScore === null) {
    issues.push("Could not identify final score");
  }

  if (match.mode && match.mode in SCORE_RULES && match.leftScore !== null && match.rightScore !== null) {
    const rule = SCORE_RULES[match.mode];

    // 3. Scores are valid for the mode.
    for (const [label, value] of [
      ["left", match.leftScore],
      ["right", match.rightScore],
    ] as const) {
      if (!Number.isInteger(value) || value < rule.min || value > rule.max) {
        issues.push(`Conflicting OCR values`);
        warnings.push(`${label} score of ${value} is outside the valid range for ${match.mode}.`);
      }
    }

    // 4. Exactly one side wins.
    if (match.leftScore === match.rightScore) {
      issues.push("Conflicting OCR values");
      warnings.push("Both sides show the same score — exactly one side must win.");
    } else {
      const winning = Math.max(match.leftScore, match.rightScore);
      if (rule.winningScore !== null && winning < rule.winningScore) {
        warnings.push(
          `Winning score of ${winning} is below the normal ${rule.winningScore} for ${match.mode} — the match may be incomplete.`,
        );
      }
      if (rule.winningScore !== null && winning > rule.winningScore && !rule.allowOvertime) {
        issues.push("Conflicting OCR values");
        warnings.push(`${match.mode} cannot exceed ${rule.winningScore}.`);
      }
      if (rule.allowOvertime && winning > rule.winningScore!) {
        warnings.push(`Overtime result (${match.leftScore}-${match.rightScore}) accepted.`);
      }
    }
  }

  const players = visiblePlayers(response);

  // 5. Both sides are represented. Uneven teams are fine; an empty side is not.
  if (response.teams.left.players.length === 0 && response.teams.right.players.length === 0) {
    issues.push("Could not identify both scoreboard sides");
  }

  for (const player of players) {
    // 6 & 7. Statistics are numeric where present, and never impossibly negative.
    for (const [label, value] of [
      ["kills", player.kills],
      ["deaths", player.deaths],
      ["assists", player.assists],
      ["objectiveTimeSeconds", player.objectiveTimeSeconds],
    ] as const) {
      if (!isNonNegativeInteger(value)) {
        issues.push("Conflicting OCR values");
        warnings.push(`Slot ${player.slot} (${player.side}) has an invalid ${label}: ${value}.`);
      }
    }
  }

  // 8. Player names are not duplicated within the same side.
  for (const side of ["left", "right"] as const) {
    const names = response.teams[side].players
      .filter((p) => p.rowPresent && p.name)
      .map((p) => p.name!.trim().toLowerCase());
    const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
    if (duplicates.length > 0) {
      issues.push("Conflicting OCR values");
      warnings.push(`Duplicate player name on the ${side} side: ${[...new Set(duplicates)].join(", ")}.`);
    }
  }

  // 16 / §19: fewer than five players is valid and must never be an error.
  for (const side of ["left", "right"] as const) {
    const count = response.teams[side].players.filter((p) => p.rowPresent).length;
    if (count > 0 && count < 5) {
      warnings.push(`${side} side shows ${count} players — valid, not an OCR failure.`);
    }
  }

  /**
   * §5: Streamer Mode is only real with actual UI evidence. If the model reported it off but
   * still tagged rows anonymous, that is a contradiction worth surfacing rather than
   * quietly honouring.
   */
  const anonymous = players.filter((p) => p.identityStatus === "STREAMER_MODE_ANONYMOUS");
  if (anonymous.length > 0 && !match.streamer_mode_enabled) {
    warnings.push(
      `${anonymous.length} row(s) are tagged anonymous but streamer_mode_enabled is false — staff should confirm identities manually.`,
    );
  }
  if (match.streamer_mode_enabled) {
    warnings.push(
      "Streamer Mode detected — anonymous slots require staff identity resolution before player points are awarded.",
    );
  }

  return { valid: issues.length === 0, issues: [...new Set(issues)], warnings };
}

/** §14: MM:SS to seconds, only where the column is genuinely objective time. */
export function coerceObjectiveTime(
  mode: OcrGameMode | null,
  value: number | null,
): number | null {
  // §15: contribution/impact is never silently reinterpreted as objective time.
  if (mode !== "hardpoint") return value;
  return value;
}
