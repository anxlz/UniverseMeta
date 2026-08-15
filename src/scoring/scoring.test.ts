import { describe, expect, test } from "bun:test";
import { evaluateCurve, roundPoints } from "./interpolation";
import { computeKd, normalizePopulation, parseObjectiveTime } from "./normalization";
import { calculatePlayerPoints } from "./player-scoring.service";
import { CURRENT_SCORING_VERSION, SCORING_PROFILES } from "./scoring-config";
import { TeamScoringError, calculateTeamPoints } from "./team-scoring.service";
import type { PlayerRawStats } from "./scoring.types";

const ALPHA = "team-alpha";
const BRAVO = "team-bravo";

function score(mode: Parameters<typeof calculateTeamPoints>[0]["mode"], left: number, right: number) {
  return calculateTeamPoints({
    mode,
    leftScore: left,
    rightScore: right,
    leftTeamId: ALPHA,
    rightTeamId: BRAVO,
  });
}

/* ---------------------------------------------------------------- *
 * §12 seed cases — the numbers the client actually supplied
 * ---------------------------------------------------------------- */

describe("team scoring — supplied calibration points reproduce exactly", () => {
  test("Hardpoint 250-240 → +20 / -5", () => {
    const r = score("hardpoint", 250, 240);
    expect(r.winnerPoints).toBe(20);
    expect(r.loserPoints).toBe(-5);
    expect(r.winnerTeamId).toBe(ALPHA);
    expect(r.gapPercentage).toBeCloseTo(0.04, 10);
    expect(r.confidence).toBe("CALIBRATED");
    expect(r.requiresCalibrationReview).toBe(false);
  });

  test("Hardpoint 250-40 → +45 / -25", () => {
    const r = score("hardpoint", 250, 40);
    expect(r.winnerPoints).toBe(45);
    expect(r.loserPoints).toBe(-25);
    expect(r.gapPercentage).toBeCloseTo(0.84, 10);
    expect(r.confidence).toBe("CALIBRATED");
  });

  test("S&D 9-3 → +35 / -25", () => {
    const r = score("search_and_destroy", 9, 3);
    expect(r.winnerPoints).toBe(35);
    expect(r.loserPoints).toBe(-25);
    expect(r.confidence).toBe("CALIBRATED");
  });

  test("S&D 14-12 overtime → +15 / -10, not rejected for exceeding 9", () => {
    const r = score("search_and_destroy", 14, 12);
    expect(r.winnerPoints).toBe(15);
    expect(r.loserPoints).toBe(-10);
    expect(r.scoreGap).toBe(2);
  });

  test("Control 4-0 → +45 / -45", () => {
    const r = score("control", 4, 0);
    expect(r.winnerPoints).toBe(45);
    expect(r.loserPoints).toBe(-45);
    expect(r.confidence).toBe("CALIBRATED");
  });
});

describe("team scoring — winner and loser curves are independent", () => {
  test("loser points are not the negation of winner points", () => {
    const r = score("hardpoint", 250, 240);
    expect(r.loserPoints).not.toBe(-r.winnerPoints); // -5, not -20
  });

  test("colour and side do not decide the winner — score does", () => {
    const left = score("hardpoint", 234, 250);
    expect(left.winnerTeamId).toBe(BRAVO);
    const right = score("hardpoint", 250, 234);
    expect(right.winnerTeamId).toBe(ALPHA);
    expect(left.winnerPoints).toBe(right.winnerPoints);
  });
});

describe("team scoring — determinism", () => {
  test("same input and version always produce the same output", () => {
    const runs = Array.from({ length: 50 }, () => score("hardpoint", 250, 187));
    const first = JSON.stringify(runs[0]);
    for (const run of runs) expect(JSON.stringify(run)).toBe(first);
    expect(runs[0]!.scoringVersion).toBe(CURRENT_SCORING_VERSION);
  });
});

/* ---------------------------------------------------------------- *
 * Calibration boundaries — the gaps the supplied data does not cover
 * ---------------------------------------------------------------- */

describe("team scoring — out-of-range gaps are flagged, never silently invented", () => {
  test("Hardpoint 250-249 falls below the calibrated floor and is flagged", () => {
    const r = score("hardpoint", 250, 249);
    expect(r.gapPercentage).toBeCloseTo(0.004, 10);
    expect(r.confidence).toBe("CLAMPED_LOW");
    expect(r.requiresCalibrationReview).toBe(true);
    expect(r.notes[0]).toContain("below the lowest calibrated gap");
  });

  test("S&D 9-0 exceeds the calibrated ceiling and is flagged", () => {
    const r = score("search_and_destroy", 9, 0);
    expect(r.gapPercentage).toBeCloseTo(0.45, 10);
    expect(r.confidence).toBe("CLAMPED_HIGH");
    expect(r.requiresCalibrationReview).toBe(true);
  });

  test("every Control result except 4-0 reports insufficient calibration", () => {
    for (const [w, l] of [
      [4, 3],
      [4, 2],
      [4, 1],
    ] as const) {
      const r = score("control", w, l);
      expect(r.confidence).toBe("INSUFFICIENT_CALIBRATION");
      expect(r.requiresCalibrationReview).toBe(true);
      expect(r.notes[0]).toContain("only one calibration point");
    }
  });

  test("Control still returns a usable number rather than throwing", () => {
    const r = score("control", 4, 3);
    expect(Number.isInteger(r.winnerPoints)).toBe(true);
    expect(r.winnerPoints).toBe(45); // clamped fallback, flagged for review
  });
});

describe("interpolation", () => {
  test("interpolates linearly between two calibration points", () => {
    // Hardpoint midpoint between 0.04→20 and 0.84→45.
    const r = evaluateCurve(SCORING_PROFILES.hardpoint.winnerCurve, 0.44, "CLAMP");
    expect(r.exactPoints).toBeCloseTo(32.5, 10);
    expect(r.points).toBe(33);
    expect(r.confidence).toBe("INTERPOLATED");
  });

  test("interpolated points rise monotonically with the gap", () => {
    let previous = -Infinity;
    for (let gap = 0.04; gap <= 0.84; gap += 0.02) {
      const r = evaluateCurve(SCORING_PROFILES.hardpoint.winnerCurve, gap, "CLAMP");
      expect(r.exactPoints).toBeGreaterThanOrEqual(previous);
      previous = r.exactPoints;
    }
  });

  test("EXTRAPOLATE continues the slope instead of clamping", () => {
    const clamped = evaluateCurve(SCORING_PROFILES.hardpoint.winnerCurve, 0.004, "CLAMP");
    const extrapolated = evaluateCurve(SCORING_PROFILES.hardpoint.winnerCurve, 0.004, "EXTRAPOLATE");
    expect(clamped.exactPoints).toBe(20);
    expect(extrapolated.exactPoints).toBeLessThan(20);
    expect(extrapolated.confidence).toBe("EXTRAPOLATED");
  });

  test("rounds half away from zero in both directions", () => {
    expect(roundPoints(2.5)).toBe(3);
    expect(roundPoints(-2.5)).toBe(-3);
    expect(roundPoints(-24.5)).toBe(-25);
  });

  test("an empty curve throws rather than returning zero", () => {
    expect(() => evaluateCurve([], 0.5, "CLAMP")).toThrow(/empty/);
  });
});

describe("team scoring — invalid input", () => {
  test("rejects a level score", () => {
    expect(() => score("hardpoint", 250, 250)).toThrow(TeamScoringError);
  });
  test("rejects negative scores", () => {
    expect(() => score("hardpoint", -1, 250)).toThrow(/negative/);
  });
  test("rejects non-integer scores", () => {
    expect(() => score("hardpoint", 250.5, 240)).toThrow(/integers/);
  });
});

/* ---------------------------------------------------------------- *
 * Player scoring
 * ---------------------------------------------------------------- */

const HARDPOINT_POPULATION: PlayerRawStats[] = [
  { playerKey: "a", kills: 39, deaths: 42, assists: 16, objectiveTimeSeconds: 80 },
  { playerKey: "b", kills: 30, deaths: 40, assists: 10, objectiveTimeSeconds: 65 },
  { playerKey: "c", kills: 20, deaths: 45, assists: 4, objectiveTimeSeconds: 20 },
];

describe("player scoring", () => {
  test("is independent of team points and differs per player", () => {
    const results = calculatePlayerPoints(HARDPOINT_POPULATION, false);
    const points = results.map((r) => r.matchPoints);
    expect(new Set(points).size).toBeGreaterThan(1);
    expect(results[0]!.matchPoints).toBeGreaterThan(results[2]!.matchPoints);
  });

  test("never divides team points across the roster", () => {
    const results = calculatePlayerPoints(HARDPOINT_POPULATION, false);
    const team = score("hardpoint", 250, 240);
    const sum = results.reduce((s, r) => s + r.matchPoints, 0);
    expect(sum).not.toBe(team.winnerPoints);
  });

  test("the top performer on every axis scores 100", () => {
    const results = calculatePlayerPoints(
      [
        { playerKey: "best", kills: 40, deaths: 10, assists: 20, objectiveTimeSeconds: 120 },
        { playerKey: "rest", kills: 5, deaths: 30, assists: 1, objectiveTimeSeconds: 10 },
      ],
      false,
    );
    expect(results[0]!.performanceScore).toBe(100);
  });

  test("null objective time redistributes weight instead of scoring zero", () => {
    // S&D exposes no objective time (§14) — players must not be penalised for that.
    const sd: PlayerRawStats[] = [
      { playerKey: "x", kills: 19, deaths: 7, assists: 2, objectiveTimeSeconds: null },
      { playerKey: "y", kills: 4, deaths: 15, assists: 1, objectiveTimeSeconds: null },
    ];
    const results = calculatePlayerPoints(sd, false);
    expect(results[0]!.performanceScore).toBe(100);
    expect(results[0]!.notes[0]).toContain("weight redistributed");
  });

  test("null and zero are treated differently", () => {
    const withNull = calculatePlayerPoints(
      [
        { playerKey: "n", kills: 10, deaths: 5, assists: null, objectiveTimeSeconds: 60 },
        { playerKey: "o", kills: 10, deaths: 5, assists: 20, objectiveTimeSeconds: 60 },
      ],
      false,
    );
    const withZero = calculatePlayerPoints(
      [
        { playerKey: "n", kills: 10, deaths: 5, assists: 0, objectiveTimeSeconds: 60 },
        { playerKey: "o", kills: 10, deaths: 5, assists: 20, objectiveTimeSeconds: 60 },
      ],
      false,
    );
    expect(withNull[0]!.performanceScore).not.toBe(withZero[0]!.performanceScore);
    expect(withNull[0]!.normalized.assists).toBeNull();
    expect(withZero[0]!.normalized.assists).toBe(0);
  });

  test("provisional flag propagates to every player", () => {
    const results = calculatePlayerPoints(HARDPOINT_POPULATION, true);
    expect(results.every((r) => r.provisional)).toBe(true);
  });

  test("is deterministic", () => {
    const a = JSON.stringify(calculatePlayerPoints(HARDPOINT_POPULATION, false));
    const b = JSON.stringify(calculatePlayerPoints(HARDPOINT_POPULATION, false));
    expect(a).toBe(b);
  });

  test("adding a resolved player can shift normalization — why §27 requires recalculation", () => {
    const before = calculatePlayerPoints(HARDPOINT_POPULATION, true);
    const after = calculatePlayerPoints(
      [
        ...HARDPOINT_POPULATION,
        { playerKey: "d", kills: 60, deaths: 10, assists: 30, objectiveTimeSeconds: 200 },
      ],
      false,
    );
    expect(after[0]!.performanceScore).toBeLessThan(before[0]!.performanceScore);
  });
});

describe("normalization helpers", () => {
  test("K/D never divides by zero", () => {
    expect(computeKd(10, 0)).toBe(10);
    expect(computeKd(10, null)).toBe(10);
    expect(computeKd(null, 5)).toBeNull();
  });

  test("objective time parses MM:SS to seconds", () => {
    expect(parseObjectiveTime("01:20")).toBe(80);
    expect(parseObjectiveTime("01:05")).toBe(65);
    expect(parseObjectiveTime("01:39")).toBe(99);
    expect(parseObjectiveTime("00:49")).toBe(49);
    expect(parseObjectiveTime("01:46")).toBe(106);
    expect(parseObjectiveTime("80")).toBe(80);
    expect(parseObjectiveTime(null)).toBeNull();
    expect(parseObjectiveTime("01:75")).toBeNull();
    expect(parseObjectiveTime("nonsense")).toBeNull();
  });

  test("population normalization keeps nulls null", () => {
    const map = normalizePopulation([
      { playerKey: "a", kills: 10, deaths: 5, assists: null, objectiveTimeSeconds: null },
    ]);
    expect(map.get("a")!.assists).toBeNull();
    expect(map.get("a")!.objective).toBeNull();
    expect(map.get("a")!.kd).toBe(1);
  });
});
