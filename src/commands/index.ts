/**
 * Command registry. One module per command family (§9) — this file only assembles them.
 */

import { applicationCommands } from "./application.commands";
import { automationCommands } from "./automation.commands";
import { complianceCommands } from "./compliance.commands";
import { embedConfigCommands } from "./embed-config.commands";
import { leaderboardCommands } from "./leaderboard.commands";
import { manualMatchCommands } from "./manual-match.commands";
import { matchCommands } from "./match.commands";
import { reviewCommands } from "./review.commands";
import { teamCommands } from "./team.commands";
import { ticketCommands } from "./ticket.commands";
import type { CommandModule } from "./types";

export const allCommands: CommandModule[] = [
  ...teamCommands,
  ...matchCommands,
  ...manualMatchCommands,
  ...ticketCommands,
  ...applicationCommands,
  ...reviewCommands,
  ...leaderboardCommands,
  ...complianceCommands,
  ...embedConfigCommands,
  ...automationCommands,
];

export const commandsByName = new Map<string, CommandModule>(
  allCommands.map((command) => [command.data.name, command]),
);

export type { CommandModule };
