/**
 * Applies the generated SQL migrations in ./drizzle at boot.
 *
 * Migrations are committed to the repo rather than pushed from the schema at runtime, so a
 * deploy can never silently alter the production database shape.
 * Regenerate after editing schema.ts: `bun run db:generate`.
 */

import { migrate as drizzleMigrate } from "drizzle-orm/bun-sqlite/migrator";
import { getDb } from "./client";

export function migrate(migrationsFolder = "./drizzle"): void {
  drizzleMigrate(getDb(), { migrationsFolder });
}
