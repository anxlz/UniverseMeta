/**
 * §22/§42 matching order: exact → normalized → fuzzy (suggestion only) → staff.
 *
 * The hard rule is that an ambiguous name is never assigned automatically. Fuzzy matching
 * exists to give staff a ranked suggestion, not to make the decision.
 */

import { normalizeKey } from "../lib/ids";
import type { Player } from "../db/schema";

export type MatchMethod = "EXACT" | "NORMALIZED" | "FUZZY_SUGGESTION" | "NONE";

export interface MatchCandidate {
  player: Player;
  score: number;
}

export interface PlayerMatchResult {
  method: MatchMethod;
  /** Populated only for EXACT and NORMALIZED — never for a fuzzy result. */
  player: Player | null;
  /** Ranked suggestions for staff when the match is not certain. */
  candidates: MatchCandidate[];
  ambiguous: boolean;
}

/** Levenshtein distance, iterative two-row form. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

/** Below this a suggestion is too weak to be worth showing staff. */
const FUZZY_FLOOR = 0.62;

export function matchPlayerName(ocrName: string | null, roster: Player[]): PlayerMatchResult {
  if (!ocrName || ocrName.trim() === "") {
    return { method: "NONE", player: null, candidates: [], ambiguous: false };
  }

  const raw = ocrName.trim();
  const key = normalizeKey(raw);

  // 1. Exact match on the displayed name.
  const exact = roster.filter((p) => p.ign.trim() === raw);
  if (exact.length === 1) {
    return { method: "EXACT", player: exact[0]!, candidates: [], ambiguous: false };
  }
  if (exact.length > 1) {
    return {
      method: "NONE",
      player: null,
      candidates: exact.map((p) => ({ player: p, score: 1 })),
      ambiguous: true,
    };
  }

  // 2. Normalized match — case, spacing and punctuation removed.
  const normalized = roster.filter((p) => p.ignKey === key);
  if (normalized.length === 1) {
    return { method: "NORMALIZED", player: normalized[0]!, candidates: [], ambiguous: false };
  }
  if (normalized.length > 1) {
    return {
      method: "NONE",
      player: null,
      candidates: normalized.map((p) => ({ player: p, score: 1 })),
      ambiguous: true,
    };
  }

  // 3. Fuzzy — suggestion only. Never auto-applied, however confident it looks.
  const candidates = roster
    .map((p) => ({ player: p, score: similarity(key, p.ignKey) }))
    .filter((c) => c.score >= FUZZY_FLOOR)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (candidates.length === 0) {
    return { method: "NONE", player: null, candidates: [], ambiguous: false };
  }

  // Two near-identical candidates is exactly the case §42 forbids resolving automatically.
  const ambiguous =
    candidates.length > 1 && Math.abs(candidates[0]!.score - candidates[1]!.score) < 0.05;

  return { method: "FUZZY_SUGGESTION", player: null, candidates, ambiguous };
}
