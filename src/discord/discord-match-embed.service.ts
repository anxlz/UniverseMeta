/**
 * Every match-facing embed and its buttons. Built through the §5 helpers, so bold body text
 * is structural rather than something each caller applies by hand.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type EmbedBuilder,
} from "discord.js";
import type { Match, Team } from "../db/schema";
import { discordTimestamp } from "../lib/datetime";
import { buildEmbed, field, type EmbedTone } from "../lib/embeds";
import type { MatchHistoryRow } from "../matches/match.service";

export const BUTTON_IDS = {
  confirm: "match:confirm",
  decline: "match:decline",
  historyPrev: "history:prev",
  historyNext: "history:next",
} as const;

const STATUS_LABEL: Record<Match["scheduleStatus"], string> = {
  PENDING_CONFIRMATION: "Awaiting opponent confirmation",
  CONFIRMED: "Confirmed",
  CANCELLED: "Cancelled",
  FORFEITED: "Forfeited",
};

const STATUS_TONE: Record<Match["scheduleStatus"], EmbedTone> = {
  PENDING_CONFIRMATION: "pending",
  CONFIRMED: "confirmed",
  CANCELLED: "cancelled",
  FORFEITED: "cancelled",
};

function teamLabel(team: Team): string {
  return team.tag ? `${team.name} [${team.tag}]` : team.name;
}

export interface MatchEmbedOptions {
  match: Match;
  homeTeam: Team;
  awayTeam: Team;
  advanceNoticeWarning?: string | null;
  note?: string | null;
  /** Phase 4 advisories. Shown to staff; they never change the match state. */
  complianceNotes?: string[];
}

export function buildMatchEmbed(options: MatchEmbedOptions): EmbedBuilder {
  const { match, homeTeam, awayTeam } = options;

  const descriptionLines = [`${teamLabel(homeTeam)} vs ${teamLabel(awayTeam)}`];
  if (options.note) descriptionLines.push(options.note);
  if (options.advanceNoticeWarning) {
    descriptionLines.push(`⚠️ ${options.advanceNoticeWarning}`);
  }
  for (const note of options.complianceNotes ?? []) {
    descriptionLines.push(`ℹ️ ${note}`);
  }
  if (match.scheduleStatus === "PENDING_CONFIRMATION") {
    descriptionLines.push(
      `Waiting on the captain of ${awayTeam.name} to run /matchconfirm ${match.publicMatchId} or press Confirm below.`,
    );
  }
  if (match.scheduleStatus === "CANCELLED" && match.cancelReason) {
    descriptionLines.push(`Reason: ${match.cancelReason}`);
  }

  const fields = [
    field("Match ID", match.publicMatchId, true),
    field("Category", match.category, true),
    field("Status", STATUS_LABEL[match.scheduleStatus], true),
    field("Kickoff", discordTimestamp(match.scheduledAt, "F"), false),
    field("Starts", discordTimestamp(match.scheduledAt, "R"), true),
    field("Timezone", match.scheduledTimezone, true),
  ];

  if (match.confirmedAt) {
    fields.push(field("Confirmed", discordTimestamp(match.confirmedAt, "f"), true));
  }

  return buildEmbed({
    title: "Match Registration",
    description: descriptionLines.join("\n"),
    tone: STATUS_TONE[match.scheduleStatus],
    guildId: match.guildId,
    fields,
    footer: `${match.publicMatchId} • ${match.advanceNoticeMet ? "Notice OK" : "Short notice"}`,
    thumbnail: homeTeam.logoUrl,
  });
}

/**
 * §5: pressing these edits the message they are attached to. The match id rides in the
 * custom id so the handler never has to guess which match a click belongs to.
 */
export function buildMatchButtons(match: Match): ActionRowBuilder<ButtonBuilder>[] {
  if (match.scheduleStatus !== "PENDING_CONFIRMATION") return [];

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${BUTTON_IDS.confirm}:${match.id}`)
        .setLabel("Confirm Match")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${BUTTON_IDS.decline}:${match.id}`)
        .setLabel("Decline")
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

export interface HistoryEmbedOptions {
  guildId: string;
  rows: MatchHistoryRow[];
  total: number;
  offset: number;
  pageSize: number;
  scopeLabel: string;
}

export function buildHistoryEmbed(options: HistoryEmbedOptions): EmbedBuilder {
  const { rows, total, offset, pageSize } = options;

  if (rows.length === 0) {
    return buildEmbed({
      title: "Match History",
      description: `No matches found for ${options.scopeLabel}.`,
      tone: "brand",
      guildId: options.guildId,
    });
  }

  const lines = rows.map((row) => {
    const status = STATUS_LABEL[row.match.scheduleStatus];
    return [
      `${row.match.publicMatchId} — ${row.match.category}`,
      `${teamLabel(row.homeTeam)} vs ${teamLabel(row.awayTeam)}`,
      `${discordTimestamp(row.match.scheduledAt, "f")} — ${status}`,
    ].join("\n");
  });

  const page = Math.floor(offset / pageSize) + 1;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return buildEmbed({
    title: "Match History",
    description: `${options.scopeLabel}\n\n${lines.join("\n\n")}`,
    tone: "brand",
    guildId: options.guildId,
    footer: `Page ${page} of ${pages} • ${total} match${total === 1 ? "" : "es"}`,
  });
}

export function buildHistoryButtons(
  offset: number,
  pageSize: number,
  total: number,
  scopeToken: string,
): ActionRowBuilder<ButtonBuilder>[] {
  if (total <= pageSize) return [];

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${BUTTON_IDS.historyPrev}:${Math.max(0, offset - pageSize)}:${scopeToken}`)
        .setLabel("Previous")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(offset === 0),
      new ButtonBuilder()
        .setCustomId(`${BUTTON_IDS.historyNext}:${offset + pageSize}:${scopeToken}`)
        .setLabel("Next")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(offset + pageSize >= total),
    ),
  ];
}
