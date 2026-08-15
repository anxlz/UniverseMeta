import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { closeDatabase, openDatabase } from "../db/client";
import { migrate } from "../db/migrate";
import { getConfig, setConfig } from "./automation-config";
import { COLORS, formatHexColor, parseHexColor, resolveTheme } from "./embeds";
import {
  PLACEHOLDER_KEYS,
  SAMPLE_CONTEXT,
  renderTemplate,
  slugifyChannelName,
  validateTemplate,
} from "./templates";

const TEST_DIR = "./.test-tmp-custom";
const GUILD = "guild-custom";
const STAFF = "staff-1";
let dbPath: string;

beforeEach(() => {
  if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  dbPath = `${TEST_DIR}/${crypto.randomUUID()}.sqlite`;
  openDatabase(dbPath);
  migrate();
});

afterEach(() => {
  closeDatabase();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("template validation", () => {
  test("accepts every documented placeholder", () => {
    const template = PLACEHOLDER_KEYS.map((k) => `{${k}}`).join(" ");
    const result = validateTemplate(template);
    expect(result.valid).toBe(true);
    expect(result.unknown).toHaveLength(0);
    expect(result.used).toHaveLength(PLACEHOLDER_KEYS.length);
  });

  test("rejects a typo instead of storing it", () => {
    // The whole point: {hoem} must fail at set time, not become a live channel name.
    const result = validateTemplate("match-{hoem}-vs-{away}");
    expect(result.valid).toBe(false);
    expect(result.unknown).toEqual(["hoem"]);
  });

  test("a template with no placeholders is valid", () => {
    expect(validateTemplate("scrim-channel").valid).toBe(true);
  });

  test("renders every placeholder it declares", () => {
    const rendered = renderTemplate("{home} vs {away} — {id} ({category})", SAMPLE_CONTEXT);
    expect(rendered).toBe("ALP vs BRV — CODM-20260814-000127 (scrim)");
    expect(rendered).not.toContain("{");
  });

  test("leaves an unknown token visible rather than blanking it", () => {
    expect(renderTemplate("a-{nope}-b", SAMPLE_CONTEXT)).toBe("a-{nope}-b");
  });
});

describe("channel name slugification", () => {
  test("produces a legal Discord channel name", () => {
    expect(slugifyChannelName("Match: ALP vs BRV!")).toBe("match-alp-vs-brv");
    expect(slugifyChannelName("  spaced   out  ")).toBe("spaced-out");
  });

  test("keeps non-Latin team tags instead of slugging them to nothing", () => {
    // An ASCII-only slugifier would return "match" for both of these.
    expect(slugifyChannelName("فريق")).toBe("فريق");
    expect(slugifyChannelName("チーム-brv")).toBe("チーム-brv");
  });

  test("never returns an empty name", () => {
    expect(slugifyChannelName("!!!")).toBe("match");
    expect(slugifyChannelName("")).toBe("match");
  });

  test("stays within Discord's length limit", () => {
    expect(slugifyChannelName("a".repeat(300)).length).toBeLessThanOrEqual(90);
  });
});

describe("embed theming", () => {
  test("an unconfigured guild gets the built-in defaults", () => {
    const theme = resolveTheme(GUILD);
    expect(theme.colors.pending).toBe(COLORS.pending);
    expect(theme.colors.confirmed).toBe(COLORS.confirmed);
    expect(theme.footerText).toBeNull();
    expect(theme.timestamps).toBe(true);
  });

  test("configured colours override the defaults", () => {
    setConfig(GUILD, "embed_color_confirmed", "00FF88" as never, STAFF);
    expect(resolveTheme(GUILD).colors.confirmed).toBe(0x00ff88);
  });

  test("an invalid stored colour falls back rather than throwing", () => {
    setConfig(GUILD, "embed_color_pending", "nonsense" as never, STAFF);
    expect(resolveTheme(GUILD).colors.pending).toBe(COLORS.pending);
  });

  test("theming is per guild", () => {
    setConfig(GUILD, "embed_color_brand", "112233" as never, STAFF);
    expect(resolveTheme("other-guild").colors.brand).toBe(COLORS.brand);
  });

  test("resetting to an empty value restores the default", () => {
    setConfig(GUILD, "embed_color_danger", "123456" as never, STAFF);
    expect(resolveTheme(GUILD).colors.danger).toBe(0x123456);
    setConfig(GUILD, "embed_color_danger", "" as never, STAFF);
    expect(resolveTheme(GUILD).colors.danger).toBe(COLORS.danger);
  });

  test("theme survives a restart", () => {
    setConfig(GUILD, "embed_color_brand", "ABCDEF" as never, STAFF);
    setConfig(GUILD, "embed_footer_text", "UM League" as never, STAFF);

    closeDatabase();
    openDatabase(dbPath);
    migrate();

    const theme = resolveTheme(GUILD);
    expect(theme.colors.brand).toBe(0xabcdef);
    expect(theme.footerText).toBe("UM League");
  });
});

describe("hex colour parsing", () => {
  test("accepts the forms staff actually type", () => {
    for (const input of ["#5865F2", "5865F2", "0x5865f2", " #5865f2 "]) {
      expect(parseHexColor(input)).toBe(0x5865f2);
    }
  });

  test("rejects anything else", () => {
    for (const input of ["", "#FFF", "red", "#GGGGGG", "12345678"]) {
      expect(parseHexColor(input)).toBeNull();
    }
  });

  test("round-trips through the display format", () => {
    expect(formatHexColor(0x5865f2)).toBe("#5865F2");
    expect(parseHexColor(formatHexColor(0x001122))).toBe(0x001122);
  });
});

describe("ticket configuration", () => {
  test("defaults are usable without any setup", () => {
    const name = getConfig(GUILD, "ticket_name_template");
    const topic = getConfig(GUILD, "ticket_topic_template");
    const welcome = getConfig(GUILD, "ticket_welcome_message");

    for (const template of [name, topic, welcome]) {
      expect(validateTemplate(template).valid).toBe(true);
      expect(renderTemplate(template, SAMPLE_CONTEXT)).not.toContain("{");
    }
    expect(slugifyChannelName(renderTemplate(name, SAMPLE_CONTEXT))).toBe("match-alp-vs-brv");
  });

  test("close behaviour and ping persist", () => {
    setConfig(GUILD, "ticket_close_behavior", "archive" as never, STAFF);
    setConfig(GUILD, "ticket_ping", "both" as never, STAFF);

    closeDatabase();
    openDatabase(dbPath);
    migrate();

    expect(getConfig(GUILD, "ticket_close_behavior")).toBe("archive");
    expect(getConfig(GUILD, "ticket_ping")).toBe("both");
  });

  test("multi-line welcome messages survive storage", () => {
    const welcome = "Line one.\nLine two with {home}.";
    setConfig(GUILD, "ticket_welcome_message", welcome as never, STAFF);
    const stored = getConfig(GUILD, "ticket_welcome_message");
    expect(stored.split("\n")).toHaveLength(2);
    expect(renderTemplate(stored, SAMPLE_CONTEXT)).toContain("ALP");
  });
});
