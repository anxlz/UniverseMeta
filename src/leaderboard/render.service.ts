/**
 * Leaderboard image composition (§7.5). Uses `@napi-rs/canvas`, which was spiked on Bun
 * before this file was written (§13 item 2): gradients, clipping, roundRect, text metrics
 * and PNG encoding all work, rendering a full board in roughly 30ms.
 *
 * The spike also turned up the non-obvious part. Team names in this league arrive in
 * Arabic and Japanese (§34), and the default font stack renders both as tofu boxes. Fonts
 * are therefore registered explicitly at startup and the renderer reports which scripts it
 * can actually draw, rather than silently shipping a board full of squares.
 */

import { createCanvas, GlobalFonts, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import { GIFEncoder, applyPalette, quantize } from "gifenc";
import { logger } from "../lib/logger";
import type { PlayerStanding, TeamStanding } from "./standings.service";

export type LeaderboardStyle = "static" | "animated";

const WIDTH = 900;
const HEADER_HEIGHT = 120;
const ROW_HEIGHT = 72;
const FOOTER_HEIGHT = 46;

const PALETTE = {
  background: "#0f1115",
  panel: "#171a21",
  panelAlt: "#1c2029",
  text: "#f5f6f8",
  muted: "#9aa3b2",
  accent: "#5865f2",
};

/** Top-4 team frames: red, gold, silver, bronze (§7.5). */
const TEAM_MEDALS = ["#e63946", "#f1c40f", "#c0c8d4", "#cd7f32"];
/** Top-3 player frames. */
const PLAYER_MEDALS = ["#f1c40f", "#c0c8d4", "#cd7f32"];

/**
 * Candidate font files by script. The first that exists on the host wins. Debian/Ubuntu
 * paths are listed first since that is what the Oracle A1 target runs.
 */
const FONT_CANDIDATES: Array<{ family: string; paths: string[] }> = [
  {
    family: "UMLArabic",
    paths: [
      "/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf",
      "/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf",
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ],
  },
  {
    family: "UMLCjk",
    paths: [
      "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
      "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
      "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    ],
  },
];

let fontsReady = false;
const registeredFamilies: string[] = [];

/**
 * Call once at boot. Missing scripts are logged loudly — a leaderboard of empty boxes is
 * the kind of failure that survives to production precisely because nothing errors.
 */
export function registerLeaderboardFonts(): { registered: string[]; missing: string[] } {
  if (fontsReady) return { registered: registeredFamilies, missing: [] };

  const missing: string[] = [];
  for (const candidate of FONT_CANDIDATES) {
    const found = candidate.paths.find((path) => {
      try {
        return GlobalFonts.registerFromPath(path, candidate.family) !== undefined;
      } catch {
        return false;
      }
    });
    if (found) registeredFamilies.push(candidate.family);
    else missing.push(candidate.family);
  }

  fontsReady = true;
  if (missing.length > 0) {
    logger.warn("leaderboard fonts missing — some team names will render as boxes", {
      missing,
      fix: "apt-get install fonts-noto-core fonts-noto-cjk",
    });
  } else {
    logger.info("leaderboard fonts registered", { families: registeredFamilies });
  }
  return { registered: registeredFamilies, missing };
}

/** Latin first, then the script-specific families as fallbacks. */
function fontStack(size: number, weight: "normal" | "bold" = "normal"): string {
  const families = ["sans-serif", ...registeredFamilies.map((f) => `"${f}"`)].join(", ");
  return `${weight === "bold" ? "bold " : ""}${size}px ${families}`;
}

function truncate(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

function formatObjective(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function drawHeader(ctx: SKRSContext2D, title: string, subtitle: string): void {
  ctx.fillStyle = PALETTE.background;
  ctx.fillRect(0, 0, WIDTH, HEADER_HEIGHT);

  const stripe = ctx.createLinearGradient(0, 0, WIDTH, 0);
  stripe.addColorStop(0, "#e63946");
  stripe.addColorStop(0.5, "#f1c40f");
  stripe.addColorStop(1, PALETTE.accent);
  ctx.fillStyle = stripe;
  ctx.fillRect(0, 0, WIDTH, 5);

  ctx.fillStyle = PALETTE.text;
  ctx.font = fontStack(34, "bold");
  ctx.fillText(title, 36, 62);

  ctx.fillStyle = PALETTE.muted;
  ctx.font = fontStack(17);
  ctx.fillText(subtitle, 36, 92);
}

function drawFooter(ctx: SKRSContext2D, y: number, note: string): void {
  ctx.fillStyle = PALETTE.background;
  ctx.fillRect(0, y, WIDTH, FOOTER_HEIGHT);
  ctx.fillStyle = PALETTE.muted;
  ctx.font = fontStack(14);
  ctx.fillText(note, 36, y + 28);
}

async function drawBadge(
  ctx: SKRSContext2D,
  imageUrl: string | null,
  x: number,
  y: number,
  size: number,
  shape: "circle" | "square",
  medalColor: string | null,
  fallbackText: string,
): Promise<void> {
  const cx = x + size / 2;
  const cy = y + size / 2;

  ctx.save();
  ctx.beginPath();
  if (shape === "circle") ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
  else ctx.roundRect(x, y, size, size, 10);
  ctx.clip();

  let drawn = false;
  if (imageUrl) {
    try {
      const image = await loadImage(imageUrl);
      ctx.drawImage(image, x, y, size, size);
      drawn = true;
    } catch {
      // A dead logo URL must not take the whole leaderboard down.
      drawn = false;
    }
  }
  if (!drawn) {
    ctx.fillStyle = PALETTE.panelAlt;
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = PALETTE.muted;
    ctx.font = fontStack(Math.round(size * 0.4), "bold");
    const initials = fallbackText.slice(0, 2).toUpperCase();
    const metrics = ctx.measureText(initials);
    ctx.fillText(initials, cx - metrics.width / 2, cy + size * 0.14);
  }
  ctx.restore();

  if (medalColor) {
    ctx.strokeStyle = medalColor;
    ctx.lineWidth = 3;
    ctx.beginPath();
    if (shape === "circle") ctx.arc(cx, cy, size / 2 + 2, 0, Math.PI * 2);
    else ctx.roundRect(x - 2, y - 2, size + 4, size + 4, 12);
    ctx.stroke();
  }
}

export interface TeamBoardOptions {
  standings: TeamStanding[];
  sortLabel: string;
  regionLabel: string;
}

export async function renderTeamLeaderboard(options: TeamBoardOptions): Promise<Buffer> {
  registerLeaderboardFonts();

  const rows = options.standings.slice(0, 10);
  const height = HEADER_HEIGHT + Math.max(1, rows.length) * ROW_HEIGHT + FOOTER_HEIGHT;
  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = PALETTE.background;
  ctx.fillRect(0, 0, WIDTH, height);
  drawHeader(ctx, "TEAM LEADERBOARD", `${options.regionLabel} • sorted by ${options.sortLabel}`);

  if (rows.length === 0) {
    ctx.fillStyle = PALETTE.muted;
    ctx.font = fontStack(18);
    ctx.fillText("No completed matches yet.", 36, HEADER_HEIGHT + 44);
  }

  for (const [index, team] of rows.entries()) {
    const y = HEADER_HEIGHT + index * ROW_HEIGHT;

    ctx.fillStyle = index % 2 === 0 ? PALETTE.panel : PALETTE.panelAlt;
    ctx.fillRect(0, y, WIDTH, ROW_HEIGHT);

    ctx.fillStyle = index < 4 ? TEAM_MEDALS[index]! : PALETTE.muted;
    ctx.font = fontStack(24, "bold");
    ctx.fillText(String(index + 1), 30, y + 46);

    // Team view uses square icons (§7.5).
    await drawBadge(
      ctx,
      team.logoUrl,
      78,
      y + 10,
      52,
      "square",
      index < 4 ? TEAM_MEDALS[index]! : null,
      team.tag ?? team.name,
    );

    ctx.fillStyle = PALETTE.text;
    ctx.font = fontStack(20, "bold");
    const label = team.tag ? `${team.name} [${team.tag}]` : team.name;
    ctx.fillText(truncate(ctx, label, 320), 150, y + 34);

    ctx.fillStyle = PALETTE.muted;
    ctx.font = fontStack(14);
    ctx.fillText(
      `${team.region ?? "—"} • ${team.wins}W ${team.losses}L • ${(team.winRate * 100).toFixed(0)}%`,
      150,
      y + 56,
    );

    const columns: Array<[string, string]> = [
      ["PTS", String(team.points)],
      ["K/D", team.kd.toFixed(2)],
      ["KILLS", String(team.kills)],
      ["OBJ", formatObjective(team.objectiveSeconds)],
    ];
    columns.forEach(([heading, value], i) => {
      const x = 520 + i * 95;
      ctx.fillStyle = PALETTE.muted;
      ctx.font = fontStack(12);
      ctx.fillText(heading, x, y + 28);
      ctx.fillStyle = PALETTE.text;
      ctx.font = fontStack(19, "bold");
      ctx.fillText(value, x, y + 52);
    });
  }

  drawFooter(ctx, height - FOOTER_HEIGHT, "Totals include approved matches only.");
  return canvas.toBuffer("image/png");
}

export interface PlayerBoardOptions {
  standings: PlayerStanding[];
  sortLabel: string;
  regionLabel: string;
}

export async function renderPlayerLeaderboard(options: PlayerBoardOptions): Promise<Buffer> {
  registerLeaderboardFonts();

  const rows = options.standings.slice(0, 10);
  const height = HEADER_HEIGHT + Math.max(1, rows.length) * ROW_HEIGHT + FOOTER_HEIGHT;
  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = PALETTE.background;
  ctx.fillRect(0, 0, WIDTH, height);
  drawHeader(ctx, "PLAYER LEADERBOARD", `${options.regionLabel} • sorted by ${options.sortLabel}`);

  if (rows.length === 0) {
    ctx.fillStyle = PALETTE.muted;
    ctx.font = fontStack(18);
    ctx.fillText("No completed matches yet.", 36, HEADER_HEIGHT + 44);
  }

  for (const [index, player] of rows.entries()) {
    const y = HEADER_HEIGHT + index * ROW_HEIGHT;

    ctx.fillStyle = index % 2 === 0 ? PALETTE.panel : PALETTE.panelAlt;
    ctx.fillRect(0, y, WIDTH, ROW_HEIGHT);

    ctx.fillStyle = index < 3 ? PLAYER_MEDALS[index]! : PALETTE.muted;
    ctx.font = fontStack(24, "bold");
    ctx.fillText(String(index + 1), 30, y + 46);

    // Player view uses circular avatars (§7.5).
    await drawBadge(
      ctx,
      null,
      78,
      y + 10,
      52,
      "circle",
      index < 3 ? PLAYER_MEDALS[index]! : null,
      player.ign,
    );

    ctx.fillStyle = PALETTE.text;
    ctx.font = fontStack(20, "bold");
    ctx.fillText(truncate(ctx, player.ign, 300), 150, y + 34);

    ctx.fillStyle = PALETTE.muted;
    ctx.font = fontStack(14);
    ctx.fillText(
      truncate(ctx, `${player.teamName} • ${player.matchesPlayed} matches`, 300),
      150,
      y + 56,
    );

    const columns: Array<[string, string]> = [
      ["PTS", String(player.points)],
      ["K/D", player.kd.toFixed(2)],
      ["KILLS", String(player.kills)],
      ["MVP", String(player.mvps)],
    ];
    columns.forEach(([heading, value], i) => {
      const x = 520 + i * 95;
      ctx.fillStyle = PALETTE.muted;
      ctx.font = fontStack(12);
      ctx.fillText(heading, x, y + 28);
      ctx.fillStyle = PALETTE.text;
      ctx.font = fontStack(19, "bold");
      ctx.fillText(value, x, y + 52);
    });
  }

  drawFooter(ctx, height - FOOTER_HEIGHT, "Totals include approved matches only.");
  return canvas.toBuffer("image/png");
}


/* ------------------------------------------------------------------ *
 * Animated variant (§7.5 /leaderboardstyle)
 * ------------------------------------------------------------------ */

const GIF_FRAMES = 12;
const GIF_FRAME_DELAY_MS = 90;

/**
 * Rows sweep in from the left, staggered by rank, then hold.
 *
 * `gifenc` was spiked on Bun before this was written (§11): pure JavaScript, no native
 * binding, ~180ms for a short clip. That matters — the obvious alternative, `gifencoder`,
 * pulls in node-canvas and reintroduces exactly the node-gyp/Cairo build risk §2 rejected.
 *
 * Capped at 10 rows and 12 frames deliberately. A full board at more frames pushes the file
 * past Discord's upload ceiling for non-boosted servers.
 */
async function renderAnimated(
  drawFrame: (ctx: SKRSContext2D, progress: number) => Promise<void>,
  width: number,
  height: number,
): Promise<Buffer> {
  const encoder = GIFEncoder();

  for (let frame = 0; frame < GIF_FRAMES; frame += 1) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    // easeOutCubic — fast entry, gentle settle.
    const linear = frame / (GIF_FRAMES - 1);
    const progress = 1 - Math.pow(1 - linear, 3);

    await drawFrame(ctx, progress);

    const { data } = ctx.getImageData(0, 0, width, height);
    const palette = quantize(data, 256);
    encoder.writeFrame(applyPalette(data, palette), width, height, {
      palette,
      // Hold the final frame so the finished board is readable before it loops.
      delay: frame === GIF_FRAMES - 1 ? 2000 : GIF_FRAME_DELAY_MS,
    });
  }

  encoder.finish();
  return Buffer.from(encoder.bytes());
}

export async function renderTeamLeaderboardAnimated(options: TeamBoardOptions): Promise<Buffer> {
  registerLeaderboardFonts();
  const rows = options.standings.slice(0, 10);
  const height = HEADER_HEIGHT + Math.max(1, rows.length) * ROW_HEIGHT + FOOTER_HEIGHT;

  return renderAnimated(
    async (ctx, progress) => {
      ctx.fillStyle = PALETTE.background;
      ctx.fillRect(0, 0, WIDTH, height);
      drawHeader(ctx, "TEAM LEADERBOARD", `${options.regionLabel} • sorted by ${options.sortLabel}`);

      for (const [index, team] of rows.entries()) {
        // Each row starts a little after the one above it.
        const stagger = Math.min(1, Math.max(0, progress * 1.6 - index * 0.08));
        if (stagger <= 0) continue;

        const y = HEADER_HEIGHT + index * ROW_HEIGHT;
        const offsetX = (1 - stagger) * -220;

        ctx.save();
        ctx.translate(offsetX, 0);
        ctx.globalAlpha = stagger;

        ctx.fillStyle = index % 2 === 0 ? PALETTE.panel : PALETTE.panelAlt;
        ctx.fillRect(0, y, WIDTH, ROW_HEIGHT);

        ctx.fillStyle = index < 4 ? TEAM_MEDALS[index]! : PALETTE.muted;
        ctx.font = fontStack(24, "bold");
        ctx.fillText(String(index + 1), 30, y + 46);

        await drawBadge(
          ctx,
          team.logoUrl,
          78,
          y + 10,
          52,
          "square",
          index < 4 ? TEAM_MEDALS[index]! : null,
          team.tag ?? team.name,
        );

        ctx.fillStyle = PALETTE.text;
        ctx.font = fontStack(20, "bold");
        const label = team.tag ? `${team.name} [${team.tag}]` : team.name;
        ctx.fillText(truncate(ctx, label, 320), 150, y + 34);

        ctx.fillStyle = PALETTE.muted;
        ctx.font = fontStack(14);
        ctx.fillText(
          `${team.region ?? "—"} • ${team.wins}W ${team.losses}L • ${(team.winRate * 100).toFixed(0)}%`,
          150,
          y + 56,
        );

        const columns: Array<[string, string]> = [
          ["PTS", String(team.points)],
          ["K/D", team.kd.toFixed(2)],
          ["KILLS", String(team.kills)],
          ["OBJ", formatObjective(team.objectiveSeconds)],
        ];
        columns.forEach(([heading, value], i) => {
          const x = 520 + i * 95;
          ctx.fillStyle = PALETTE.muted;
          ctx.font = fontStack(12);
          ctx.fillText(heading, x, y + 28);
          ctx.fillStyle = PALETTE.text;
          ctx.font = fontStack(19, "bold");
          ctx.fillText(value, x, y + 52);
        });

        ctx.restore();
      }

      drawFooter(ctx, height - FOOTER_HEIGHT, "Totals include approved matches only.");
    },
    WIDTH,
    height,
  );
}

export async function renderPlayerLeaderboardAnimated(options: PlayerBoardOptions): Promise<Buffer> {
  registerLeaderboardFonts();
  const rows = options.standings.slice(0, 10);
  const height = HEADER_HEIGHT + Math.max(1, rows.length) * ROW_HEIGHT + FOOTER_HEIGHT;

  return renderAnimated(
    async (ctx, progress) => {
      ctx.fillStyle = PALETTE.background;
      ctx.fillRect(0, 0, WIDTH, height);
      drawHeader(ctx, "PLAYER LEADERBOARD", `${options.regionLabel} • sorted by ${options.sortLabel}`);

      for (const [index, player] of rows.entries()) {
        const stagger = Math.min(1, Math.max(0, progress * 1.6 - index * 0.08));
        if (stagger <= 0) continue;

        const y = HEADER_HEIGHT + index * ROW_HEIGHT;
        ctx.save();
        ctx.translate((1 - stagger) * -220, 0);
        ctx.globalAlpha = stagger;

        ctx.fillStyle = index % 2 === 0 ? PALETTE.panel : PALETTE.panelAlt;
        ctx.fillRect(0, y, WIDTH, ROW_HEIGHT);

        ctx.fillStyle = index < 3 ? PLAYER_MEDALS[index]! : PALETTE.muted;
        ctx.font = fontStack(24, "bold");
        ctx.fillText(String(index + 1), 30, y + 46);

        await drawBadge(ctx, null, 78, y + 10, 52, "circle", index < 3 ? PLAYER_MEDALS[index]! : null, player.ign);

        ctx.fillStyle = PALETTE.text;
        ctx.font = fontStack(20, "bold");
        ctx.fillText(truncate(ctx, player.ign, 300), 150, y + 34);

        ctx.fillStyle = PALETTE.muted;
        ctx.font = fontStack(14);
        ctx.fillText(
          truncate(ctx, `${player.teamName} • ${player.matchesPlayed} matches`, 300),
          150,
          y + 56,
        );

        const columns: Array<[string, string]> = [
          ["PTS", String(player.points)],
          ["K/D", player.kd.toFixed(2)],
          ["KILLS", String(player.kills)],
          ["MVP", String(player.mvps)],
        ];
        columns.forEach(([heading, value], i) => {
          const x = 520 + i * 95;
          ctx.fillStyle = PALETTE.muted;
          ctx.font = fontStack(12);
          ctx.fillText(heading, x, y + 28);
          ctx.fillStyle = PALETTE.text;
          ctx.font = fontStack(19, "bold");
          ctx.fillText(value, x, y + 52);
        });

        ctx.restore();
      }

      drawFooter(ctx, height - FOOTER_HEIGHT, "Totals include approved matches only.");
    },
    WIDTH,
    height,
  );
}
