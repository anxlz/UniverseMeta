/**
 * bun:sqlite + Drizzle. No Prisma (no query-engine subprocess), per §2.
 */

import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

export type Db = BunSQLiteDatabase<typeof schema>;

let sqlite: Database | null = null;
let dbInstance: Db | null = null;

export function openDatabase(path: string): Db {
  const conn = new Database(path, { create: true });

  // WAL keeps reads from blocking the interaction handlers while a write is in flight.
  conn.exec("PRAGMA journal_mode = WAL;");
  conn.exec("PRAGMA foreign_keys = ON;");
  conn.exec("PRAGMA busy_timeout = 5000;");
  conn.exec("PRAGMA synchronous = NORMAL;");

  sqlite = conn;
  dbInstance = drizzle(conn, { schema });
  return dbInstance;
}

export function getDb(): Db {
  if (!dbInstance) throw new Error("Database not initialised — call openDatabase() first.");
  return dbInstance;
}

export function getRawConnection(): Database {
  if (!sqlite) throw new Error("Database not initialised — call openDatabase() first.");
  return sqlite;
}

export function closeDatabase(): void {
  sqlite?.close();
  sqlite = null;
  dbInstance = null;
}
