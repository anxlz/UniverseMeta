/**
 * Bootstrap only — client, health server, watchers (§9). No domain logic here.
 */

import { Client, Events, GatewayIntentBits } from "discord.js";
import { migrate } from "./db/migrate";
import { closeDatabase, openDatabase } from "./db/client";
import { routeInteraction } from "./interactions/router";
import { loadEnv } from "./lib/env";
import { startHealthServer } from "./lib/health";
import { logger } from "./lib/logger";
import { startWeeklyResetWatcher } from "./lib/weekly-reset";
import { registerLeaderboardFonts } from "./leaderboard/render.service";

async function main(): Promise<void> {
  const env = loadEnv();

  openDatabase(env.databasePath);
  migrate();
  logger.info("database ready", { path: env.databasePath });

  // Warns loudly if Arabic/CJK fonts are absent — otherwise those team names render as
  // empty boxes on every leaderboard and nothing errors.
  registerLeaderboardFonts();

  const client = new Client({
    // Guilds alone is enough: everything runs through interactions, so the bot never needs
    // to read message content and does not require a privileged intent.
    intents: [GatewayIntentBits.Guilds],
  });

  const health = startHealthServer(env.healthPort, {
    ready: () => client.isReady(),
    wsPing: () => Math.round(client.ws.ping),
  });

  client.once(Events.ClientReady, (ready) => {
    logger.info("gateway ready", { tag: ready.user.tag, guilds: ready.guilds.cache.size });
  });

  client.on(Events.InteractionCreate, (interaction) => void routeInteraction(interaction));
  client.on(Events.Error, (error) => logger.error("client error", { error: String(error) }));

  const weeklyTimer = startWeeklyResetWatcher((windowStart) => {
    // Phase 4 hangs weekly-series compliance counters off this boundary.
    logger.info("weekly window rolled", { windowStart: windowStart.toISOString() });
  });

  const shutdown = (signal: string) => {
    logger.info("shutting down", { signal });
    clearInterval(weeklyTimer);
    void health.stop(true);
    void client.destroy();
    closeDatabase();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await client.login(env.discordToken);
}

main().catch((error) => {
  logger.error("fatal boot error", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
