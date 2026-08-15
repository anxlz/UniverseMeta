/**
 * Publishes the slash-command definitions to Discord. Run once after changing any command
 * shape: `bun run deploy`.
 *
 * DEV_GUILD_ID registers to a single guild (instant). Without it, commands are registered
 * globally, which Discord propagates over roughly an hour.
 */

import { REST, Routes } from "discord.js";
import { allCommands } from "./commands";
import { loadEnv } from "./lib/env";
import { logger } from "./lib/logger";

async function deploy(): Promise<void> {
  const env = loadEnv();
  const body = allCommands.map((command) => command.data.toJSON());
  const rest = new REST({ version: "10" }).setToken(env.discordToken);

  const route = env.devGuildId
    ? Routes.applicationGuildCommands(env.discordClientId, env.devGuildId)
    : Routes.applicationCommands(env.discordClientId);

  await rest.put(route, { body });
  logger.info("commands deployed", {
    count: body.length,
    scope: env.devGuildId ? `guild:${env.devGuildId}` : "global",
    names: body.map((c) => c.name),
  });
}

deploy().catch((error) => {
  logger.error("command deployment failed", { error: String(error) });
  process.exit(1);
});
