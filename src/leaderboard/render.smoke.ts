/**
 * Render smoke test. Verifies the canvas pipeline produces a valid PNG and that the fonts
 * needed for Arabic and CJK team names are actually present.
 *
 * This exists because a missing font is a silent failure: the renderer succeeds, the PNG is
 * valid, and every non-Latin name is a row of empty boxes. CI fails here instead.
 */

import {
  registerLeaderboardFonts,
  renderTeamLeaderboard,
  renderTeamLeaderboardAnimated,
} from "./render.service";
import type { TeamStanding } from "./standings.service";

const fonts = registerLeaderboardFonts();
if (fonts.missing.length > 0) {
  console.error(
    `Missing fonts for: ${fonts.missing.join(", ")}. Install fonts-noto-core and fonts-noto-cjk.`,
  );
  process.exit(1);
}

const standings: TeamStanding[] = [
  {
    teamId: "1",
    name: "فريق الأسود",
    tag: "ASD",
    region: "ME",
    logoUrl: null,
    points: 27,
    wins: 1,
    losses: 0,
    winRate: 1,
    kills: 89,
    deaths: 127,
    kd: 0.7,
    objectiveSeconds: 165,
  },
  {
    teamId: "2",
    name: "チームブラボー",
    tag: "BRV",
    region: "JAPAN",
    logoUrl: null,
    points: -10,
    wins: 0,
    losses: 1,
    winRate: 0,
    kills: 78,
    deaths: 123,
    kd: 0.63,
    objectiveSeconds: 140,
  },
];

const png = await renderTeamLeaderboard({
  standings,
  sortLabel: "points",
  regionLabel: "All regions",
});

if (png.length < 1000 || png[0] !== 0x89 || png[1] !== 0x50) {
  console.error("Renderer did not produce a valid PNG.");
  process.exit(1);
}

// Animated path too — a GIF that encodes to an invalid file is a silent failure the same
// way a missing font is.
const gif = await renderTeamLeaderboardAnimated({
  standings,
  sortLabel: "points",
  regionLabel: "All regions",
});

const gifMagic = String.fromCharCode(gif[0]!, gif[1]!, gif[2]!) === "GIF";
if (!gifMagic || gif.length < 1000) {
  console.error("Animated renderer did not produce a valid GIF.");
  process.exit(1);
}

// Discord rejects attachments over 8MB on non-boosted servers.
if (gif.length > 8_000_000) {
  console.error(`Animated leaderboard is ${gif.length} bytes — over Discord's 8MB limit.`);
  process.exit(1);
}

console.log(
  JSON.stringify({
    ok: true,
    pngBytes: png.length,
    gifBytes: gif.length,
    fonts: fonts.registered,
  }),
);
