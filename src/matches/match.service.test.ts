import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { closeDatabase, getDb, openDatabase } from "../db/client";
import { auditLog } from "../db/schema";
import { migrate } from "../db/migrate";
import { getConfig, getToggle, setConfig, setToggle } from "../lib/automation-config";
import { parseSchedule, zonedWallClockToUtc } from "../lib/datetime";
import { fixturePairKey, nextPublicMatchId, normalizeKey } from "../lib/ids";
import { registerTeam } from "../teams/team.service";
import {
  MatchServiceError,
  cancelMatch,
  confirmMatch,
  getMatchByPublicId,
  queryMatchHistory,
  registerMatch,
  updateMatch,
} from "./match.service";

const TEST_DIR = "./.test-tmp";
const GUILD = "guild-1";
const ALPHA_CAPTAIN = "captain-alpha";
const BRAVO_CAPTAIN = "captain-bravo";
const STAFF = "staff-1";

let dbPath: string;

function futureDate(daysAhead: number): string {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function seedTeams(): { alphaId: string; bravoId: string } {
  const alpha = registerTeam({
    guildId: GUILD,
    name: "Team Alpha",
    tag: "ALP",
    region: "ME",
    captainDiscordId: ALPHA_CAPTAIN,
    captainIgn: "7Suro",
    actorDiscordId: ALPHA_CAPTAIN,
  });
  const bravo = registerTeam({
    guildId: GUILD,
    name: "Team Bravo",
    tag: "BRV",
    region: "EU",
    captainDiscordId: BRAVO_CAPTAIN,
    captainIgn: "_reza1391",
    actorDiscordId: BRAVO_CAPTAIN,
  });
  return { alphaId: alpha.id, bravoId: bravo.id };
}

function register(alphaId: string, bravoId: string, date = futureDate(7), time = "20:30") {
  return registerMatch({
    guildId: GUILD,
    homeTeamId: alphaId,
    awayTeamId: bravoId,
    category: "SCRIM",
    date,
    time,
    registeredBy: ALPHA_CAPTAIN,
  });
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

describe("public match id", () => {
  test("is sequential per guild per day and zero-padded to six digits", () => {
    const at = new Date("2026-08-14T10:00:00Z");
    expect(nextPublicMatchId(GUILD, at)).toBe("CODM-20260814-000001");
    expect(nextPublicMatchId(GUILD, at)).toBe("CODM-20260814-000002");
    expect(nextPublicMatchId("guild-2", at)).toBe("CODM-20260814-000001");
    expect(nextPublicMatchId(GUILD, new Date("2026-08-15T10:00:00Z"))).toBe("CODM-20260815-000001");
  });

  test("does not reuse a sequence number after a match is deleted", () => {
    const at = new Date("2026-08-14T10:00:00Z");
    nextPublicMatchId(GUILD, at);
    nextPublicMatchId(GUILD, at);
    // A row count would return ...000001 again here; the persisted counter does not.
    expect(nextPublicMatchId(GUILD, at)).toBe("CODM-20260814-000003");
  });
});

describe("fixture keys", () => {
  test("are order-independent", () => {
    expect(fixturePairKey("a", "b")).toBe(fixturePairKey("b", "a"));
  });

  test("normalizeKey strips case, spacing and punctuation", () => {
    expect(normalizeKey("Team  Alpha!")).toBe("teamalpha");
    expect(normalizeKey("xxALHAJE[7jj]")).toBe("xxalhaje7jj");
  });
});

describe("timezone handling", () => {
  test("interprets wall-clock time in the named zone, not the host zone", () => {
    const utc = zonedWallClockToUtc(2026, 8, 22, 20, 30, "Africa/Casablanca");
    expect(utc.toISOString()).toBe("2026-08-22T19:30:00.000Z");
  });

  test("resolves times correctly on the far side of a DST transition", () => {
    // New York is UTC-4 in July, UTC-5 in January.
    expect(zonedWallClockToUtc(2026, 7, 1, 12, 0, "America/New_York").toISOString()).toBe(
      "2026-07-01T16:00:00.000Z",
    );
    expect(zonedWallClockToUtc(2026, 1, 15, 12, 0, "America/New_York").toISOString()).toBe(
      "2026-01-15T17:00:00.000Z",
    );
  });

  test("rejects calendar dates that do not exist", () => {
    expect(() => parseSchedule("2026-02-31", "20:00", "UTC")).toThrow(/not a real calendar date/);
  });

  test("rejects malformed input rather than guessing", () => {
    expect(() => parseSchedule("22-08-2026", "20:00", "UTC")).toThrow(/YYYY-MM-DD/);
    expect(() => parseSchedule("2026-08-22", "8pm", "UTC")).toThrow(/HH:mm/);
    expect(() => parseSchedule("2026-08-22", "25:00", "UTC")).toThrow(/Hour/);
  });
});

describe("match registration", () => {
  test("creates a match pending confirmation", () => {
    const { alphaId, bravoId } = seedTeams();
    const { match } = register(alphaId, bravoId);

    expect(match.scheduleStatus).toBe("PENDING_CONFIRMATION");
    expect(match.resultStatus).toBe("AWAITING_SUBMISSION");
    expect(match.publicMatchId).toMatch(/^CODM-\d{8}-\d{6}$/);
  });

  test("rejects a second registration of the same fixture", () => {
    const { alphaId, bravoId } = seedTeams();
    const date = futureDate(7);
    register(alphaId, bravoId, date);

    // The opposing captain registering the mirror fixture must not create a duplicate.
    expect(() =>
      registerMatch({
        guildId: GUILD,
        homeTeamId: bravoId,
        awayTeamId: alphaId,
        category: "SCRIM",
        date,
        time: "20:30",
        registeredBy: BRAVO_CAPTAIN,
      }),
    ).toThrow(/already registered/);
  });

  test("allows re-registration after the fixture is cancelled", () => {
    const { alphaId, bravoId } = seedTeams();
    const date = futureDate(7);
    const first = register(alphaId, bravoId, date);
    cancelMatch(GUILD, first.match.id, ALPHA_CAPTAIN, "double booked");

    expect(() => register(alphaId, bravoId, date)).not.toThrow();
  });

  test("refuses a team playing itself", () => {
    const { alphaId } = seedTeams();
    expect(() => register(alphaId, alphaId)).toThrow(MatchServiceError);
  });

  test("refuses a kickoff in the past", () => {
    const { alphaId, bravoId } = seedTeams();
    expect(() => register(alphaId, bravoId, futureDate(-1))).toThrow(/already in the past/);
  });

  test("flags short notice without blocking registration", () => {
    const { alphaId, bravoId } = seedTeams();
    const soon = new Date(Date.now() + 3 * 3_600_000);
    const date = `${soon.getUTCFullYear()}-${String(soon.getUTCMonth() + 1).padStart(2, "0")}-${String(soon.getUTCDate()).padStart(2, "0")}`;
    const time = `${String(soon.getUTCHours()).padStart(2, "0")}:${String(soon.getUTCMinutes()).padStart(2, "0")}`;

    const result = register(alphaId, bravoId, date, time);

    expect(result.match.advanceNoticeMet).toBe(false);
    expect(result.advanceNoticeWarning).toContain("24h");
    expect(result.match.scheduleStatus).toBe("PENDING_CONFIRMATION"); // not blocked
  });
});

describe("confirmation gate", () => {
  test("only the opposing captain can confirm", () => {
    const { alphaId, bravoId } = seedTeams();
    const { match } = register(alphaId, bravoId);

    expect(() => confirmMatch(GUILD, match.id, ALPHA_CAPTAIN, false)).toThrow(
      /Only the captain of Team Bravo/,
    );

    const confirmed = confirmMatch(GUILD, match.id, BRAVO_CAPTAIN, false);
    expect(confirmed.scheduleStatus).toBe("CONFIRMED");
    expect(confirmed.confirmedBy).toBe(BRAVO_CAPTAIN);
  });

  test("staff can confirm on the opponent's behalf", () => {
    const { alphaId, bravoId } = seedTeams();
    const { match } = register(alphaId, bravoId);
    expect(confirmMatch(GUILD, match.id, STAFF, true).scheduleStatus).toBe("CONFIRMED");
  });

  test("cannot confirm twice", () => {
    const { alphaId, bravoId } = seedTeams();
    const { match } = register(alphaId, bravoId);
    confirmMatch(GUILD, match.id, BRAVO_CAPTAIN, false);
    expect(() => confirmMatch(GUILD, match.id, BRAVO_CAPTAIN, false)).toThrow(/already confirmed/);
  });

  test("cannot confirm a cancelled match", () => {
    const { alphaId, bravoId } = seedTeams();
    const { match } = register(alphaId, bravoId);
    cancelMatch(GUILD, match.id, ALPHA_CAPTAIN, null);
    expect(() => confirmMatch(GUILD, match.id, BRAVO_CAPTAIN, false)).toThrow(/cancelled/);
  });
});

describe("match update", () => {
  test("rescheduling a confirmed match clears the confirmation", () => {
    const { alphaId, bravoId } = seedTeams();
    const { match } = register(alphaId, bravoId);
    confirmMatch(GUILD, match.id, BRAVO_CAPTAIN, false);

    const { match: updated, requiresReconfirmation } = updateMatch({
      guildId: GUILD,
      matchId: match.id,
      date: futureDate(9),
      actorDiscordId: ALPHA_CAPTAIN,
    });

    expect(requiresReconfirmation).toBe(true);
    expect(updated.scheduleStatus).toBe("PENDING_CONFIRMATION");
    expect(updated.confirmedBy).toBeNull();
  });

  test("changing only the category leaves the confirmation intact", () => {
    const { alphaId, bravoId } = seedTeams();
    const { match } = register(alphaId, bravoId);
    confirmMatch(GUILD, match.id, BRAVO_CAPTAIN, false);

    const { match: updated, requiresReconfirmation } = updateMatch({
      guildId: GUILD,
      matchId: match.id,
      category: "OFFICIAL",
      actorDiscordId: ALPHA_CAPTAIN,
    });

    expect(requiresReconfirmation).toBe(false);
    expect(updated.scheduleStatus).toBe("CONFIRMED");
    expect(updated.category).toBe("OFFICIAL");
  });

  test("rejects an update that changes nothing", () => {
    const { alphaId, bravoId } = seedTeams();
    const { match } = register(alphaId, bravoId);
    expect(() => updateMatch({ guildId: GUILD, matchId: match.id, actorDiscordId: ALPHA_CAPTAIN })).toThrow(
      /Nothing to change/,
    );
  });
});

describe("match history", () => {
  test("filters by team and paginates", () => {
    const { alphaId, bravoId } = seedTeams();
    const charlie = registerTeam({
      guildId: GUILD,
      name: "Team Charlie",
      captainDiscordId: "captain-charlie",
      captainIgn: "charlie",
      actorDiscordId: "captain-charlie",
    });

    register(alphaId, bravoId, futureDate(3));
    register(alphaId, bravoId, futureDate(4));
    registerMatch({
      guildId: GUILD,
      homeTeamId: bravoId,
      awayTeamId: charlie.id,
      category: "OFFICIAL",
      date: futureDate(5),
      time: "18:00",
      registeredBy: BRAVO_CAPTAIN,
    });

    const alphaOnly = queryMatchHistory({ guildId: GUILD, teamId: alphaId, limit: 10, offset: 0 });
    expect(alphaOnly.total).toBe(2);

    const firstPage = queryMatchHistory({ guildId: GUILD, limit: 2, offset: 0 });
    expect(firstPage.total).toBe(3);
    expect(firstPage.rows).toHaveLength(2);

    const secondPage = queryMatchHistory({ guildId: GUILD, limit: 2, offset: 2 });
    expect(secondPage.rows).toHaveLength(1);
  });

  test("public ids resolve case-insensitively", () => {
    const { alphaId, bravoId } = seedTeams();
    const { match } = register(alphaId, bravoId);
    expect(getMatchByPublicId(GUILD, match.publicMatchId.toLowerCase())?.id).toBe(match.id);
  });
});

/**
 * §12 toggle persistence, and the specific PTB bug §11 calls out: set a flag, drop the
 * process, bring it back, confirm the value held.
 */
describe("toggle persistence across restart", () => {
  test("every configured flag survives closing and reopening the database", () => {
    setToggle(GUILD, "auto_ticket_creation", false, STAFF);
    setToggle(GUILD, "screenshot_ocr_pipeline", true, STAFF);
    setConfig(GUILD, "advance_notice_hours", 48 as never, STAFF);
    setConfig(GUILD, "league_timezone", "Africa/Casablanca" as never, STAFF);

    closeDatabase();
    openDatabase(dbPath); // same file, fresh connection — simulates a systemd restart
    migrate();

    expect(getToggle(GUILD, "auto_ticket_creation")).toBe(false);
    expect(getToggle(GUILD, "screenshot_ocr_pipeline")).toBe(true);
    expect(getConfig(GUILD, "advance_notice_hours")).toBe(48);
    expect(getConfig(GUILD, "league_timezone")).toBe("Africa/Casablanca");
  });

  test("unset flags fall back to their declared defaults", () => {
    expect(getToggle(GUILD, "auto_match_logging")).toBe(true);
    expect(getToggle(GUILD, "compliance_flagging")).toBe(false); // Phase 4, off by default
    expect(getConfig(GUILD, "advance_notice_hours")).toBe(24);
  });

  test("config is scoped per guild", () => {
    setToggle(GUILD, "auto_ticket_creation", false, STAFF);
    expect(getToggle("other-guild", "auto_ticket_creation")).toBe(true);
  });
});

describe("roster integrity", () => {
  test("a captain cannot lead two teams", () => {
    seedTeams();
    expect(() =>
      registerTeam({
        guildId: GUILD,
        name: "Team Delta",
        captainDiscordId: ALPHA_CAPTAIN,
        captainIgn: "7Suro",
        actorDiscordId: ALPHA_CAPTAIN,
      }),
    ).toThrow(/already the captain/);
  });

  test("team names collide on their normalized form", () => {
    seedTeams();
    expect(() =>
      registerTeam({
        guildId: GUILD,
        name: "team  alpha",
        captainDiscordId: "someone-else",
        captainIgn: "x",
        actorDiscordId: "someone-else",
      }),
    ).toThrow(/already registered/);
  });

  test("the audit log records every state change", () => {
    const { alphaId, bravoId } = seedTeams();
    const { match } = register(alphaId, bravoId);
    confirmMatch(GUILD, match.id, BRAVO_CAPTAIN, false);
    cancelMatch(GUILD, match.id, STAFF, "weather");

    const actions = getDb()
      .select({ action: auditLog.action })
      .from(auditLog)
      .all()
      .map((r) => r.action);

    expect(actions).toContain("team_registered");
    expect(actions).toContain("match_registered");
    expect(actions).toContain("match_confirmed");
    expect(actions).toContain("match_cancelled");
  });
});
