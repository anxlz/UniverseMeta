/**
 * §5 global rules, enforced here rather than left to each command:
 *   - every embed's body text is bold;
 *   - every clickable action edits the existing message in place.
 *
 * Commands build embeds through these helpers, so "remembered to bold it" is not a thing
 * anyone has to remember.
 */

import { getConfig, type ConfigKey } from "./automation-config";
import {
  EmbedBuilder,
  MessageFlags,
  type APIEmbedField,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type InteractionReplyOptions,
  type InteractionUpdateOptions,
  type StringSelectMenuInteraction,
} from "discord.js";

/** Built-in defaults. A guild that never runs /embedconfig gets exactly these. */
export const COLORS = {
  pending: 0xf1c40f,
  confirmed: 0x2ecc71,
  cancelled: 0x992d22,
  info: 0x5865f2,
  brand: 0x5865f2,
  danger: 0xed4245,
} as const;

/**
 * Semantic role rather than a raw colour. Callers say what an embed *means*; the theme
 * decides what it looks like. That is what makes /embedconfig work at all — a caller that
 * hardcoded `color: 0xf1c40f` would silently opt out of every guild's branding.
 */
export type EmbedTone = keyof typeof COLORS;

export interface EmbedTheme {
  colors: Record<EmbedTone, number>;
  footerText: string | null;
  logoUrl: string | null;
  timestamps: boolean;
  leagueName: string | null;
}

const DEFAULT_THEME: EmbedTheme = {
  colors: { ...COLORS },
  footerText: null,
  logoUrl: null,
  timestamps: true,
  leagueName: null,
};

/** Accepts "5865F2", "#5865F2" or "0x5865F2". Returns null when unparseable. */
export function parseHexColor(value: string): number | null {
  const cleaned = value.trim().replace(/^#/, "").replace(/^0x/i, "");
  if (!/^[0-9a-f]{6}$/i.test(cleaned)) return null;
  return Number.parseInt(cleaned, 16);
}

export function formatHexColor(value: number): string {
  return `#${value.toString(16).padStart(6, "0").toUpperCase()}`;
}

/**
 * Reads the guild's theme. Every lookup hits the DB-backed config path (§5) — there is no
 * cache, for the same reason toggles have none.
 */
export function resolveTheme(guildId: string | null | undefined): EmbedTheme {
  if (!guildId) return DEFAULT_THEME;

  const color = (key: ConfigKey, fallback: number): number => {
    const raw = getConfig(guildId, key) as string;
    if (!raw) return fallback;
    return parseHexColor(raw) ?? fallback;
  };

  return {
    colors: {
      pending: color("embed_color_pending", COLORS.pending),
      confirmed: color("embed_color_confirmed", COLORS.confirmed),
      cancelled: color("embed_color_cancelled", COLORS.cancelled),
      danger: color("embed_color_danger", COLORS.danger),
      brand: color("embed_color_brand", COLORS.brand),
      info: color("embed_color_brand", COLORS.info),
    },
    footerText: (getConfig(guildId, "embed_footer_text") as string) || null,
    logoUrl: (getConfig(guildId, "embed_logo_url") as string) || null,
    timestamps: getConfig(guildId, "embed_timestamps") as boolean,
    leagueName: (getConfig(guildId, "league_name") as string) || null,
  };
}

/**
 * Wraps text in bold without producing `****` on empty input and without double-bolding
 * text that is already bold.
 */
export function b(text: string | number | null | undefined): string {
  const value = String(text ?? "").trim();
  if (value === "") return "—";
  if (value.startsWith("**") && value.endsWith("**")) return value;
  // Bold markers do not survive across newlines in Discord — bold each line separately.
  return value
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : `**${line}**`))
    .join("\n");
}

export function field(name: string, value: string | number | null | undefined, inline = true): APIEmbedField {
  return { name, value: b(value), inline };
}

export interface BuildEmbedOptions {
  title: string;
  description?: string;
  /** Semantic role — preferred over `color`, because it respects the guild's theme. */
  tone?: EmbedTone;
  /** Explicit override. Use only where a colour is genuinely not a semantic state. */
  color?: number;
  /** Enables theming. Omit only where no guild context exists (a DM, a boot-time render). */
  guildId?: string | null;
  fields?: APIEmbedField[];
  footer?: string;
  thumbnail?: string | null;
  timestamp?: boolean;
}

export function buildEmbed(options: BuildEmbedOptions): EmbedBuilder {
  const theme = resolveTheme(options.guildId);
  const tone = options.tone ?? "info";

  const embed = new EmbedBuilder()
    .setTitle(options.title)
    .setColor(options.color ?? theme.colors[tone]);

  if (options.description) embed.setDescription(b(options.description));
  if (options.fields?.length) embed.addFields(options.fields);

  /**
   * Footer precedence: an explicit footer (usually the match ID) wins, because it is
   * load-bearing information rather than decoration. The configured footer is appended
   * after it rather than replacing it.
   */
  const footerParts = [options.footer, theme.footerText].filter(
    (part): part is string => Boolean(part),
  );
  if (footerParts.length > 0) embed.setFooter({ text: footerParts.join(" • ") });

  const thumbnail = options.thumbnail ?? theme.logoUrl;
  if (thumbnail) embed.setThumbnail(thumbnail);

  if (options.timestamp ?? theme.timestamps) embed.setTimestamp(new Date());

  return embed;
}

export function errorEmbed(message: string, guildId?: string | null): EmbedBuilder {
  return buildEmbed({ title: "Unable to continue", description: message, tone: "danger", guildId });
}

export function successEmbed(title: string, message: string, guildId?: string | null): EmbedBuilder {
  return buildEmbed({ title, description: message, tone: "confirmed", guildId });
}

/** Ephemeral error reply — works whether or not the interaction was already deferred. */
export async function replyError(
  interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction,
  message: string,
): Promise<void> {
  const payload: InteractionReplyOptions = {
    embeds: [errorEmbed(message, interaction.guildId)],
    flags: MessageFlags.Ephemeral,
  };
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload);
  } else {
    await interaction.reply(payload);
  }
}

/**
 * §5: a button never posts a second message. This is the only sanctioned way to respond to
 * a component interaction that changes state on the message it came from.
 */
export async function updateInPlace(
  interaction: ButtonInteraction,
  options: InteractionUpdateOptions,
): Promise<void> {
  await interaction.update(options);
}
