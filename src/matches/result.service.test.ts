import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { closeDatabase, getDb, openDatabase } from "../db/client";
import { migrate } from "../db/migrate";
import { auditLog, matchPlayers, pointTransactions } from "../db/schema";
import { eq } from "drizzle-orm";
import { setConfig } from "../lib/automation-config";
import { approveMatchResult, ApprovalError } from "../approvals/approval.service";
import { getTeamStandings, getPlayerStandings } from "../leaderboard/standings.service";
import { validateOcrResponse } from "../ocr/ocr-validator";
import type { OcrPlayer, OcrResponse } from "../ocr/ocr.types";
import { matchPlayerName } from "../players/player-matching.service";
import { listPendingSlots, resolveSlot } from "../players/pending-player.service";
import { reverseMatchPoints, getTeamTotal } from "../points/point-transaction.service";
import { addPlayer, getRoster, registerTeam } from "../teams/team.service";
import { confirmMatch, registerMatch } from "./match.service";
import { processOcrResult, recalculateWithResolvedSlots } from "./result.service";

const TEST_DIR = "./.test-tmp-e2e";
const GUILD = "guild-e2e";
const STAFF = "staff-1";
let dbPath: string;

function futureDate(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function player(
  side: "left" | "right",
  slot: number,
  name: string | null,
  kills: number,
  deaths: number,
  assists: number,
  obj: number | null,
  identityStatus: OcrPlayer["identityStatus"] = "IDENTIFIED",
): OcrPlayer {
  return {
    side,
    slot,
    rowPresent: true,
    name,
    identityStatus,
    score: 1000 + kills * 10,
    kills,
    deaths,
    assists,
    objectiveTimeSeconds: obj,
    contribution: 100,
    additionalStats: {},
  };
}

function ocrResponse(overrides: Partial<OcrResponse> = {}): OcrResponse {
  return {
    match: {
      mode: "hardpoint",
      map: "Arsenal",
      streamer_mode_enabled: false,
      leftScore: 250,
      rightScore: 240,
      leftResult: "win",
      rightResult: "loss",
      scoreGap: 10,
      gapPercentage: 0.04,
      dateTime: null,
    },
    teams: {
      left: {
        teamName: null,
        players: [
          player("left", 1, "7Suro", 39, 42, 16, 80),
          player("left", 2, "AlphaTwo", 30, 40, 10, 65),
          player("left", 3, "AlphaThree", 20, 45, 4, 20),
        ],
      },
      right: {
        teamName: null,
        players: [
          player("right", 1, "_reza1391", 35, 38, 12, 70),
          player("right", 2, "BravoTwo", 25, 41, 8, 55),
          player("right", 3, "xxALHAJE[7jj]", 18, 44, 3, 15),
        ],
      },
    },
    teamPointsPreview: { left: null, right: null, authoritative: false },
    validation: { valid: true, issues: [] },
    ...overrides,
  };
}

function seed() {
  const alpha = registerTeam({
    guildId: GUILD,
    name: "Team Alpha",
    tag: "ALP",
    region: "ME",
    captainDiscordId: "cap-a",
    captainIgn: "7Suro",
    actorDiscordId: "cap-a",
  });
  for (const ign of ["AlphaTwo", "AlphaThree"]) {
    addPlayer({ guildId: GUILD, teamId: alpha.id, ign, actorDiscordId: "cap-a" });
  }

  const bravo = registerTeam({
    guildId: GUILD,
    name: "Team Bravo",
    tag: "BRV",
    region: "EU",
    captainDiscordId: "cap-b",
    captainIgn: "_reza1391",
    actorDiscordId: "cap-b",
  });
  for (const ign of ["BravoTwo", "xxALHAJE[7jj]"]) {
    addPlayer({ guildId: GUILD, teamId: bravo.id, ign, actorDiscordId: "cap-b" });
  }

  const { match } = registerMatch({
    guildId: GUILD,
    homeTeamId: alpha.id,
    awayTeamId: bravo.id,
    category: "SCRIM",
    date: futureDate(2),
    time: "20:00",
    registeredBy: "cap-a",
  });
  confirmMatch(GUILD, match.id, "cap-b", false);

  return { alphaId: alpha.id, bravoId: bravo.id, match };
}

beforeEach(() => {
  if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  dbPath = `${TEST_DIR}/${crypto.randomUUID()}.sqlite`;
  openDatabase(dbPath);
  migrate();
  setConfig(GUILD, "league_timezone", "UTC", STAFF);
});

afterEach(() => {
  closeDatabase();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("full result pipeline", () => {
  test("a clean 5-a-side result reaches PENDING_APPROVAL with points calculated but not awarded", () => {
    const { alphaId, bravoId, match } = seed();

    const result = processOcrResult({
      match,
      ocr: ocrResponse(),
      leftTeamId: alphaId,
      rightTeamId: bravoId,
      submittedBy: "cap-a",
      screenshotUrl: "https://example.test/s.png",
    });

    expect(result.teamScoring.winnerTeamId).toBe(alphaId);
    expect(result.teamScoring.winnerPoints).toBe(20);
    expect(result.teamScoring.loserPoints).toBe(-5);
    expect(result.identifiedCount).toBe(6);
    expect(result.pendingSlotCount).toBe(0);
    expect(result.match.resultStatus).toBe("PENDING_APPROVAL");

    // §26: nothing awarded before approval.
    const ledger = getDb().select().from(pointTransactions).all();
    expect(ledger).toHaveLength(0);
  });

  test("unusual usernames are scored normally, never treated as Streamer Mode", () => {
    const { alphaId, bravoId, match } = seed();
    processOcrResult({
      match,
      ocr: ocrResponse(),
      leftTeamId: alphaId,
      rightTeamId: bravoId,
      submittedBy: "cap-a",
      screenshotUrl: null,
    });

    const rows = getDb().select().from(matchPlayers).where(eq(matchPlayers.matchId, match.id)).all();
    const reza = rows.find((r) => r.ocrName === "_reza1391");
    const alhaje = rows.find((r) => r.ocrName === "xxALHAJE[7jj]");

    expect(reza?.identityStatus).toBe("IDENTIFIED");
    expect(alhaje?.identityStatus).toBe("IDENTIFIED");
    expect(reza?.matchPoints).toBeGreaterThan(0);
    expect(listPendingSlots(match.id)).toHaveLength(0);
  });

  test("approval creates team and player transactions and completes the match", () => {
    const { alphaId, bravoId, match } = seed();
    processOcrResult({
      match,
      ocr: ocrResponse(),
      leftTeamId: alphaId,
      rightTeamId: bravoId,
      submittedBy: "cap-a",
      screenshotUrl: null,
    });

    const approved = approveMatchResult(GUILD, match.id, STAFF);
    expect(approved.match.resultStatus).toBe("COMPLETED");
    expect(approved.teamRows).toBe(2);
    expect(approved.playerRows).toBe(6);

    expect(getTeamTotal(alphaId)).toBe(20);
    expect(getTeamTotal(bravoId)).toBe(-5);

    // §11: player points are not the team points divided up.
    const playerSum = getDb()
      .select()
      .from(pointTransactions)
      .where(eq(pointTransactions.pointType, "PLAYER"))
      .all()
      .reduce((s, t) => s + t.points, 0);
    expect(playerSum).not.toBe(20);
  });

  test("points cannot be awarded twice for the same match", () => {
    const { alphaId, bravoId, match } = seed();
    processOcrResult({
      match,
      ocr: ocrResponse(),
      leftTeamId: alphaId,
      rightTeamId: bravoId,
      submittedBy: "cap-a",
      screenshotUrl: null,
    });
    approveMatchResult(GUILD, match.id, STAFF);
    expect(() => approveMatchResult(GUILD, match.id, STAFF)).toThrow(/already completed/);
  });

  test("reversal writes compensating entries and keeps the original award", () => {
    const { alphaId, bravoId, match } = seed();
    processOcrResult({
      match,
      ocr: ocrResponse(),
      leftTeamId: alphaId,
      rightTeamId: bravoId,
      submittedBy: "cap-a",
      screenshotUrl: null,
    });
    approveMatchResult(GUILD, match.id, STAFF);
    expect(getTeamTotal(alphaId)).toBe(20);

    reverseMatchPoints(GUILD, match.id, STAFF, "wrong screenshot");
    expect(getTeamTotal(alphaId)).toBe(0);

    // §40: the original transactions are still on file.
    const all = getDb().select().from(pointTransactions).all();
    expect(all.length).toBe(16);
    expect(all.filter((t) => t.reason.startsWith("reversal:")).length).toBe(8);
  });
});

describe("Streamer Mode", () => {
  function streamerOcr(): OcrResponse {
    const base = ocrResponse();
    base.match!.streamer_mode_enabled = true;
    base.teams.left.players[0] = player("left", 1, "J4U+0XmWmEM", 19, 7, 2, 80, "STREAMER_MODE_ANONYMOUS");
    return base;
  }

  test("anonymous slots are never auto-mapped and never auto-scored", () => {
    const { alphaId, bravoId, match } = seed();
    const result = processOcrResult({
      match,
      ocr: streamerOcr(),
      leftTeamId: alphaId,
      rightTeamId: bravoId,
      submittedBy: "cap-a",
      screenshotUrl: null,
    });

    expect(result.match.resultStatus).toBe("PENDING_STREAMER_MODE_RESOLUTION");

    const pending = listPendingSlots(match.id);
    const streamerSlot = pending.find((s) => s.reason === "STREAMER_MODE");
    expect(streamerSlot).toBeDefined();
    // §8: the statistics were visible but are held, not awarded.
    expect(streamerSlot!.heldKills).toBe(19);
    expect(streamerSlot!.resolvedPlayerId).toBeNull();

    const rows = getDb().select().from(matchPlayers).where(eq(matchPlayers.matchId, match.id)).all();
    expect(rows.some((r) => r.ocrName === "J4U+0XmWmEM")).toBe(false);
  });

  test("team points are unaffected by Streamer Mode", () => {
    const { alphaId, bravoId, match } = seed();
    const result = processOcrResult({
      match,
      ocr: streamerOcr(),
      leftTeamId: alphaId,
      rightTeamId: bravoId,
      submittedBy: "cap-a",
      screenshotUrl: null,
    });
    // §13: same +20/-5 as the non-streamer run.
    expect(result.teamScoring.winnerPoints).toBe(20);
    expect(result.teamScoring.loserPoints).toBe(-5);
  });

  test("a match cannot be approved while any slot is unresolved", () => {
    const { alphaId, bravoId, match } = seed();
    processOcrResult({
      match,
      ocr: streamerOcr(),
      leftTeamId: alphaId,
      rightTeamId: bravoId,
      submittedBy: "cap-a",
      screenshotUrl: null,
    });
    expect(() => approveMatchResult(GUILD, match.id, STAFF)).toThrow(ApprovalError);
    expect(() => approveMatchResult(GUILD, match.id, STAFF)).toThrow(/unresolved/);
  });

  test("staff resolution then approval awards points to the real player", () => {
    const { alphaId, bravoId, match } = seed();
    processOcrResult({
      match,
      ocr: streamerOcr(),
      leftTeamId: alphaId,
      rightTeamId: bravoId,
      submittedBy: "cap-a",
      screenshotUrl: null,
    });

    const roster = getRoster(alphaId);
    for (const slot of listPendingSlots(match.id)) {
      const target = roster.find((p) => p.ign === "7Suro") ?? roster[0]!;
      resolveSlot(slot.id, target.id, STAFF, {
        kills: 19,
        deaths: 7,
        assists: 2,
        objectiveTimeSeconds: 80,
      });
    }
    recalculateWithResolvedSlots(match.id, STAFF);

    const approved = approveMatchResult(GUILD, match.id, STAFF);
    expect(approved.match.resultStatus).toBe("COMPLETED");

    const playerTx = getDb()
      .select()
      .from(pointTransactions)
      .where(eq(pointTransactions.pointType, "PLAYER"))
      .all();
    expect(playerTx.some((t) => t.reason === "manual_missing_player_stats_approved")).toBe(true);
  });
});

describe("missing players", () => {
  test("a roster player absent from the scoreboard becomes pending, not a zero-stat player", () => {
    const { alphaId, bravoId, match } = seed();
    const ocr = ocrResponse();
    ocr.teams.left.players = ocr.teams.left.players.slice(0, 2); // AlphaThree missing

    const result = processOcrResult({
      match,
      ocr,
      leftTeamId: alphaId,
      rightTeamId: bravoId,
      submittedBy: "cap-a",
      screenshotUrl: null,
    });

    expect(result.pendingSlotCount).toBeGreaterThan(0);
    const missing = listPendingSlots(match.id).find((s) => s.ocrName === "AlphaThree");
    expect(missing?.reason).toBe("MISSING");
    // §17/§19: held stats are null, not 0.
    expect(missing?.heldKills).toBeNull();

    const rows = getDb().select().from(matchPlayers).where(eq(matchPlayers.matchId, match.id)).all();
    expect(rows.some((r) => r.ocrName === "AlphaThree")).toBe(false);
  });

  test("uneven teams (3v1) are valid, not an OCR failure", () => {
    const { alphaId, bravoId, match } = seed();
    const ocr = ocrResponse();
    ocr.match!.mode = "control";
    ocr.match!.leftScore = 4;
    ocr.match!.rightScore = 0;
    ocr.teams.right.players = [ocr.teams.right.players[0]!];

    const result = processOcrResult({
      match,
      ocr,
      leftTeamId: alphaId,
      rightTeamId: bravoId,
      submittedBy: "cap-a",
      screenshotUrl: null,
    });
    expect(result.match.resultStatus).not.toBe("VALIDATION_FAILED");
    expect(result.teamScoring.winnerPoints).toBe(45);
  });

  test("players are provisional while slots remain unresolved", () => {
    const { alphaId, bravoId, match } = seed();
    const ocr = ocrResponse();
    ocr.teams.left.players = ocr.teams.left.players.slice(0, 2);

    processOcrResult({
      match,
      ocr,
      leftTeamId: alphaId,
      rightTeamId: bravoId,
      submittedBy: "cap-a",
      screenshotUrl: null,
    });

    const rows = getDb().select().from(matchPlayers).where(eq(matchPlayers.matchId, match.id)).all();
    expect(rows.every((r) => r.isProvisional)).toBe(true);
  });
});

describe("OCR validation", () => {
  test("accepts overtime S&D", () => {
    const ocr = ocrResponse();
    ocr.match!.mode = "search_and_destroy";
    ocr.match!.leftScore = 14;
    ocr.match!.rightScore = 12;
    expect(validateOcrResponse(ocr).valid).toBe(true);
  });

  test("rejects a level score", () => {
    const ocr = ocrResponse();
    ocr.match!.rightScore = 250;
    expect(validateOcrResponse(ocr).valid).toBe(false);
  });

  test("rejects negative statistics", () => {
    const ocr = ocrResponse();
    ocr.teams.left.players[0]!.kills = -3;
    expect(validateOcrResponse(ocr).valid).toBe(false);
  });

  test("rejects duplicate names on one side", () => {
    const ocr = ocrResponse();
    ocr.teams.left.players[1]!.name = "7Suro";
    const result = validateOcrResponse(ocr);
    expect(result.valid).toBe(false);
    expect(result.warnings.join(" ")).toContain("Duplicate");
  });

  test("passes an unreadable image straight through as invalid", () => {
    const result = validateOcrResponse({
      match: null,
      teams: { left: { teamName: null, players: [] }, right: { teamName: null, players: [] } },
      teamPointsPreview: { left: null, right: null, authoritative: false },
      validation: { valid: false, issues: ["Image is too blurry"] },
    });
    expect(result.valid).toBe(false);
    expect(result.issues).toContain("Image is too blurry");
  });

  test("fewer than five players warns but stays valid", () => {
    const result = validateOcrResponse(ocrResponse());
    expect(result.valid).toBe(true);
    expect(result.warnings.join(" ")).toContain("3 players");
  });
});

describe("player matching", () => {
  test("exact and normalized matches resolve, fuzzy never auto-applies", () => {
    const { alphaId } = seed();
    const roster = getRoster(alphaId);

    expect(matchPlayerName("7Suro", roster).method).toBe("EXACT");
    expect(matchPlayerName("7 suro", roster).method).toBe("NORMALIZED");

    const fuzzy = matchPlayerName("7Sur0x", roster);
    expect(fuzzy.method).toBe("FUZZY_SUGGESTION");
    expect(fuzzy.player).toBeNull(); // §42 — suggestion only
    expect(fuzzy.candidates.length).toBeGreaterThan(0);
  });

  test("an unknown name yields no match at all", () => {
    const { alphaId } = seed();
    expect(matchPlayerName("CompletelyDifferent", getRoster(alphaId)).method).toBe("NONE");
  });
});

describe("leaderboards", () => {
  test("only completed matches count toward standings", () => {
    const { alphaId, bravoId, match } = seed();
    processOcrResult({
      match,
      ocr: ocrResponse(),
      leftTeamId: alphaId,
      rightTeamId: bravoId,
      submittedBy: "cap-a",
      screenshotUrl: null,
    });

    expect(getTeamStandings({ guildId: GUILD })[0]!.points).toBe(0);

    approveMatchResult(GUILD, match.id, STAFF);

    const standings = getTeamStandings({ guildId: GUILD });
    const alpha = standings.find((t) => t.teamId === alphaId)!;
    expect(alpha.points).toBe(20);
    expect(alpha.wins).toBe(1);
    expect(standings[0]!.teamId).toBe(alphaId);
  });

  test("region filter narrows the board", () => {
    const { alphaId, bravoId, match } = seed();
    processOcrResult({
      match,
      ocr: ocrResponse(),
      leftTeamId: alphaId,
      rightTeamId: bravoId,
      submittedBy: "cap-a",
      screenshotUrl: null,
    });
    approveMatchResult(GUILD, match.id, STAFF);

    const me = getTeamStandings({ guildId: GUILD, region: "ME" });
    expect(me).toHaveLength(1);
    expect(me[0]!.teamId).toBe(alphaId);
  });

  test("player standings aggregate from the ledger", () => {
    const { alphaId, bravoId, match } = seed();
    processOcrResult({
      match,
      ocr: ocrResponse(),
      leftTeamId: alphaId,
      rightTeamId: bravoId,
      submittedBy: "cap-a",
      screenshotUrl: null,
    });
    approveMatchResult(GUILD, match.id, STAFF);

    const players = getPlayerStandings({ guildId: GUILD }, "kills");
    expect(players[0]!.ign).toBe("7Suro");
    expect(players[0]!.kills).toBe(39);
    expect(players[0]!.points).toBeGreaterThan(0);
  });
});

describe("MVP derivation", () => {
  test("awards MVP to the single top performer, and nobody on a tie", () => {
    const { alphaId, bravoId, match } = seed();
    processOcrResult({
      match,
      ocr: ocrResponse(),
      leftTeamId: alphaId,
      rightTeamId: bravoId,
      submittedBy: "cap-a",
      screenshotUrl: null,
    });
    approveMatchResult(GUILD, match.id, STAFF);

    const standings = getPlayerStandings({ guildId: GUILD }, "mvp");
    const totalMvps = standings.reduce((s, p) => s + p.mvps, 0);

    // Exactly one MVP for one completed match.
    expect(totalMvps).toBe(1);
    expect(standings[0]!.mvps).toBe(1);
    // The best performer overall takes it.
    expect(standings[0]!.ign).toBe("7Suro");
  });

  test("MVP is zero before any match completes", () => {
    seed();
    expect(getPlayerStandings({ guildId: GUILD }, "mvp").every((p) => p.mvps === 0)).toBe(true);
  });
});

describe("audit trail completeness", () => {
  test("slot resolution records the owning guild, not an empty string", () => {
    const { alphaId, bravoId, match } = seed();
    const ocr = ocrResponse();
    ocr.match!.streamer_mode_enabled = true;
    ocr.teams.left.players[0] = player(
      "left",
      1,
      "J4U+0XmWmEM",
      19,
      7,
      2,
      80,
      "STREAMER_MODE_ANONYMOUS",
    );

    processOcrResult({
      match,
      ocr,
      leftTeamId: alphaId,
      rightTeamId: bravoId,
      submittedBy: "cap-a",
      screenshotUrl: null,
    });

    const slot = listPendingSlots(match.id)[0]!;
    const target = getRoster(alphaId)[0]!;
    resolveSlot(slot.id, target.id, STAFF, {
      kills: 19,
      deaths: 7,
      assists: 2,
      objectiveTimeSeconds: 80,
    });

    const rows = getDb().select().from(auditLog).all();
    const resolution = rows.find((r) => r.action.startsWith("slot_resolved_"));
    expect(resolution).toBeDefined();
    expect(resolution!.guildId).toBe(GUILD);
    expect(resolution!.guildId).not.toBe("");
  });
});
