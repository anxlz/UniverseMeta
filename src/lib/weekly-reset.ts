/**
 * §11: nothing that must survive a restart may depend on setInterval alone. The boundary
 * is a persisted timestamp, checked on boot and then on a coarse interval. If the process
 * is down across a Monday, the missed reset runs at the next boot.
 */

import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { scheduledJobs } from "../db/schema";
import { startOfIsoWeekUtc } from "./datetime";
import { logger } from "./logger";

const JOB_NAME = "weekly_reset";
const CHECK_INTERVAL_MS = 15 * 60 * 1000;

export type WeeklyResetHandler = (windowStart: Date) => void | Promise<void>;

function currentWindowStart(now: Date): Date {
  return startOfIsoWeekUtc(now);
}

export async function runWeeklyResetIfDue(
  handler: WeeklyResetHandler,
  now: Date = new Date(),
): Promise<boolean> {
  const db = getDb();
  const windowStart = currentWindowStart(now);

  const job = db.select().from(scheduledJobs).where(eq(scheduledJobs.name, JOB_NAME)).get();
  if (job?.lastRunAt && job.lastRunAt.getTime() >= windowStart.getTime()) {
    return false; // already ran for this week
  }

  await handler(windowStart);

  const nextRunAt = new Date(windowStart.getTime() + 7 * 24 * 3_600_000);
  db.insert(scheduledJobs)
    .values({ name: JOB_NAME, lastRunAt: now, nextRunAt })
    .onConflictDoUpdate({
      target: scheduledJobs.name,
      set: { lastRunAt: now, nextRunAt },
    })
    .run();

  logger.info("weekly reset executed", { windowStart: windowStart.toISOString() });
  return true;
}

export function startWeeklyResetWatcher(handler: WeeklyResetHandler): Timer {
  void runWeeklyResetIfDue(handler).catch((error) =>
    logger.error("weekly reset failed on boot", { error: String(error) }),
  );

  return setInterval(() => {
    void runWeeklyResetIfDue(handler).catch((error) =>
      logger.error("weekly reset failed", { error: String(error) }),
    );
  }, CHECK_INTERVAL_MS);
}
