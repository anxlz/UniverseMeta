/**
 * The only path to any toggle or configurable value (§5, §11).
 *
 * Every read hits the database. There is deliberately no in-memory cache: a cache is a
 * second copy of the truth, and a second copy is exactly how PTB's `autoRecordEnabled`
 * ended up silently reverting on restart. bun:sqlite is an in-process read against a local
 * file — the cost of not caching is negligible compared to the cost of the bug.
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { automationConfig } from "../db/schema";

/**
 * Every configurable value in the system, with its default. Adding a key here is the only
 * way to add a toggle — there is no ad-hoc setter.
 */
export const CONFIG_KEYS = {
  /** Phase 2. Declared now so the key namespace is stable. */
  auto_ticket_creation: { type: "boolean", default: true },
  auto_match_logging: { type: "boolean", default: true },
  /** Phase 3. */
  screenshot_ocr_pipeline: { type: "boolean", default: false },
  /** Phase 4 — flag-only, off by default (§4). */
  compliance_flagging: { type: "boolean", default: false },

  /** Phase 1. */
  advance_notice_enabled: { type: "boolean", default: true },
  advance_notice_hours: { type: "number", default: 24 },
  /** IANA zone that bare `/matchregister` times are interpreted in. */
  league_timezone: { type: "string", default: "UTC" },
  match_log_channel_id: { type: "string", default: "" },
  /** §7.5 — "static" or "animated" leaderboards. */
  leaderboard_style: { type: "string", default: "static" },
  match_announce_channel_id: { type: "string", default: "" },
  /** Confirming a match that was edited after confirmation must happen again. */
  reconfirm_after_update: { type: "boolean", default: true },

  /** Phase 2 — ticket customization (§8). Every template accepts {placeholders}. */
  ticket_name_template: { type: "string", default: "match-{home}-vs-{away}" },
  ticket_topic_template: { type: "string", default: "{id} — {home} vs {away} ({category})" },
  ticket_category_id: { type: "string", default: "" },
  ticket_welcome_message: {
    type: "string",
    default:
      "Welcome to your {category} match, {home} vs {away}.\nKickoff is {kickoff}.\nAgree lobby details here, then post your scoreboard screenshot when you finish.",
  },
  ticket_staff_role_id: { type: "string", default: "" },
  /** Who the opening message mentions: captains | staff | both | none. */
  ticket_ping: { type: "string", default: "captains" },
  /**
   * What /ticketclose does. "archive" keeps the channel as a read-only dispute record;
   * "delete" removes it. Archiving is the safer default for a league that adjudicates
   * results, but it costs a channel slot per match, so it is opt-in.
   */
  ticket_close_behavior: { type: "string", default: "delete" },
  ticket_archive_category_id: { type: "string", default: "" },
  application_channel_id: { type: "string", default: "" },
  application_review_channel_id: { type: "string", default: "" },

  /**
   * Embed theming. Colours are stored as hex without the leading #; an empty value means
   * "use the built-in default", so a guild that never touches these still looks right.
   */
  league_name: { type: "string", default: "" },
  embed_color_brand: { type: "string", default: "" },
  embed_color_pending: { type: "string", default: "" },
  embed_color_confirmed: { type: "string", default: "" },
  embed_color_cancelled: { type: "string", default: "" },
  embed_color_danger: { type: "string", default: "" },
  embed_footer_text: { type: "string", default: "" },
  embed_logo_url: { type: "string", default: "" },
  embed_timestamps: { type: "boolean", default: true },

  /** Phase 4 — compliance thresholds. Flag-only, never blocking. */
  compliance_opponent_limit: { type: "number", default: 2 },
  compliance_weekly_series_min: { type: "number", default: 0 },
  compliance_weekly_series_max: { type: "number", default: 10 },
} as const;

export type ConfigKey = keyof typeof CONFIG_KEYS;

type ValueOf<K extends ConfigKey> = (typeof CONFIG_KEYS)[K]["type"] extends "boolean"
  ? boolean
  : (typeof CONFIG_KEYS)[K]["type"] extends "number"
    ? number
    : string;

function decode<K extends ConfigKey>(key: K, raw: string): ValueOf<K> {
  const kind = CONFIG_KEYS[key].type;
  if (kind === "boolean") return (raw === "true") as ValueOf<K>;
  if (kind === "number") {
    const n = Number(raw);
    return (Number.isFinite(n) ? n : CONFIG_KEYS[key].default) as ValueOf<K>;
  }
  return raw as ValueOf<K>;
}

function encode(value: boolean | number | string): string {
  return typeof value === "string" ? value : String(value);
}

export function getConfig<K extends ConfigKey>(guildId: string, key: K): ValueOf<K> {
  const row = getDb()
    .select({ value: automationConfig.value })
    .from(automationConfig)
    .where(and(eq(automationConfig.guildId, guildId), eq(automationConfig.key, key)))
    .get();

  if (!row) return CONFIG_KEYS[key].default as ValueOf<K>;
  return decode(key, row.value);
}

export function setConfig<K extends ConfigKey>(
  guildId: string,
  key: K,
  value: ValueOf<K>,
  updatedBy: string,
): void {
  getDb()
    .insert(automationConfig)
    .values({ guildId, key, value: encode(value), updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [automationConfig.guildId, automationConfig.key],
      set: { value: encode(value), updatedBy, updatedAt: new Date() },
    })
    .run();
}

/** Only the keys declared as booleans — a non-boolean key will not typecheck here. */
export type BooleanConfigKey = {
  [K in ConfigKey]: (typeof CONFIG_KEYS)[K]["type"] extends "boolean" ? K : never;
}[ConfigKey];

/** Convenience wrappers matching the `getToggle`/`setToggle` names used in §9. */
export function getToggle(guildId: string, key: BooleanConfigKey): boolean {
  return getConfig(guildId, key) as unknown as boolean;
}

export function setToggle(
  guildId: string,
  key: BooleanConfigKey,
  value: boolean,
  updatedBy: string,
): void {
  setConfig(guildId, key, value as never, updatedBy);
}

export function listConfig(guildId: string): Array<{ key: ConfigKey; value: string; isDefault: boolean }> {
  return (Object.keys(CONFIG_KEYS) as ConfigKey[]).map((key) => {
    const row = getDb()
      .select({ value: automationConfig.value })
      .from(automationConfig)
      .where(and(eq(automationConfig.guildId, guildId), eq(automationConfig.key, key)))
      .get();
    return {
      key,
      value: row?.value ?? encode(CONFIG_KEYS[key].default),
      isDefault: !row,
    };
  });
}
