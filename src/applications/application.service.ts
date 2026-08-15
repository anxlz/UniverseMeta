/**
 * §6: the application path into the league. Same underlying data as `/teamregister`, but
 * collected from an applicant and gated behind staff approval.
 *
 * Approval is what writes to the live database (§6). A rejected application never creates a
 * team, and a pending one holds its roster in application tables rather than in `teams`.
 */

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import {
  applicationPlayers,
  applications,
  auditLog,
  type Application,
  type ApplicationPlayer,
} from "../db/schema";
import { newId, normalizeKey } from "../lib/ids";
import { findTeamByName, registerTeam, addPlayer, type Region } from "../teams/team.service";

export class ApplicationError extends Error {}

const MAX_APPLICATION_PLAYERS = 10;

function nextPublicRef(guildId: string): string {
  const count =
    getDb()
      .select({ count: sql<number>`count(*)` })
      .from(applications)
      .where(eq(applications.guildId, guildId))
      .get()?.count ?? 0;
  return `APP-${String(count + 1).padStart(5, "0")}`;
}

export interface StartApplicationInput {
  guildId: string;
  applicantDiscordId: string;
  teamName: string;
  region?: string | null;
  tier?: string | null;
  logoUrl?: string | null;
}

export function startApplication(input: StartApplicationInput): Application {
  const db = getDb();

  if (normalizeKey(input.teamName).length < 2) {
    throw new ApplicationError("Team name must contain at least two alphanumeric characters.");
  }
  if (findTeamByName(input.guildId, input.teamName)) {
    throw new ApplicationError(`A team named "${input.teamName}" is already registered.`);
  }

  const open = db
    .select()
    .from(applications)
    .where(
      and(
        eq(applications.guildId, input.guildId),
        eq(applications.applicantDiscordId, input.applicantDiscordId),
        sql`${applications.status} in ('DRAFT','SUBMITTED')`,
      ),
    )
    .get();
  if (open) {
    throw new ApplicationError(
      `You already have an open application (${open.publicRef}) for "${open.teamName}". Finish or withdraw it first.`,
    );
  }

  const id = newId();
  db.insert(applications)
    .values({
      id,
      guildId: input.guildId,
      publicRef: nextPublicRef(input.guildId),
      applicantDiscordId: input.applicantDiscordId,
      teamName: input.teamName.trim(),
      region: input.region ?? null,
      tier: input.tier ?? null,
      logoUrl: input.logoUrl ?? null,
      status: "DRAFT",
    })
    .run();

  return db.select().from(applications).where(eq(applications.id, id)).get()!;
}

export function addApplicationPlayer(
  applicationId: string,
  ign: string,
  uid: string | null,
  discordId: string | null,
  isCaptain: boolean,
): ApplicationPlayer {
  const db = getDb();
  const application = getApplication(applicationId);
  if (!application) throw new ApplicationError("Application not found.");
  if (application.status !== "DRAFT") {
    throw new ApplicationError("This application has already been submitted.");
  }

  const existing = listApplicationPlayers(applicationId);
  if (existing.length >= MAX_APPLICATION_PLAYERS) {
    throw new ApplicationError(`Applications are capped at ${MAX_APPLICATION_PLAYERS} players.`);
  }
  if (existing.some((p) => normalizeKey(p.ign) === normalizeKey(ign))) {
    throw new ApplicationError(`"${ign}" is already listed on this application.`);
  }
  if (isCaptain && existing.some((p) => p.isCaptain)) {
    throw new ApplicationError("This application already names a captain.");
  }

  const id = newId();
  db.insert(applicationPlayers)
    .values({
      id,
      applicationId,
      slot: existing.length + 1,
      ign: ign.trim(),
      uid: uid?.trim() || null,
      discordId,
      isCaptain,
    })
    .run();

  return db.select().from(applicationPlayers).where(eq(applicationPlayers.id, id)).get()!;
}

export function getApplication(id: string): Application | undefined {
  return getDb().select().from(applications).where(eq(applications.id, id)).get();
}

export function getApplicationByRef(guildId: string, ref: string): Application | undefined {
  return getDb()
    .select()
    .from(applications)
    .where(
      and(eq(applications.guildId, guildId), eq(applications.publicRef, ref.trim().toUpperCase())),
    )
    .get();
}

export function listApplicationPlayers(applicationId: string): ApplicationPlayer[] {
  return getDb()
    .select()
    .from(applicationPlayers)
    .where(eq(applicationPlayers.applicationId, applicationId))
    .orderBy(applicationPlayers.slot)
    .all();
}

export function submitApplication(applicationId: string): Application {
  const db = getDb();
  const application = getApplication(applicationId);
  if (!application) throw new ApplicationError("Application not found.");
  if (application.status !== "DRAFT") {
    throw new ApplicationError("This application has already been submitted.");
  }

  const roster = listApplicationPlayers(applicationId);
  if (roster.length === 0) {
    throw new ApplicationError("Add at least one player before submitting.");
  }
  if (!roster.some((p) => p.isCaptain)) {
    throw new ApplicationError("One player must be marked as captain.");
  }

  db.update(applications)
    .set({ status: "SUBMITTED", submittedAt: new Date() })
    .where(eq(applications.id, applicationId))
    .run();

  return getApplication(applicationId)!;
}

export function recordReviewMessage(applicationId: string, channelId: string, messageId: string): void {
  getDb()
    .update(applications)
    .set({ reviewChannelId: channelId, reviewMessageId: messageId })
    .where(eq(applications.id, applicationId))
    .run();
}

/**
 * §6: approval is what inserts the team and roster into the live database. Everything up to
 * this point lives only in the application tables.
 */
export function approveApplication(
  applicationId: string,
  staffDiscordId: string,
): { application: Application; teamId: string } {
  const db = getDb();
  const application = getApplication(applicationId);
  if (!application) throw new ApplicationError("Application not found.");
  if (application.status !== "SUBMITTED") {
    throw new ApplicationError(`This application is ${application.status.toLowerCase()}.`);
  }
  if (findTeamByName(application.guildId, application.teamName)) {
    throw new ApplicationError(
      `A team named "${application.teamName}" was registered while this application was pending.`,
    );
  }

  const roster = listApplicationPlayers(applicationId);
  const captain = roster.find((p) => p.isCaptain);
  if (!captain) throw new ApplicationError("This application has no captain.");

  const team = registerTeam({
    guildId: application.guildId,
    name: application.teamName,
    region: (application.region as Region | null) ?? null,
    tier: application.tier,
    logoUrl: application.logoUrl,
    captainDiscordId: captain.discordId ?? application.applicantDiscordId,
    captainIgn: captain.ign,
    captainUid: captain.uid,
    actorDiscordId: staffDiscordId,
  });

  for (const player of roster) {
    if (player.id === captain.id) continue;
    addPlayer({
      guildId: application.guildId,
      teamId: team.id,
      discordId: player.discordId,
      ign: player.ign,
      uid: player.uid,
      actorDiscordId: staffDiscordId,
    });
  }

  const reviewedAt = new Date();
  db.update(applications)
    .set({ status: "APPROVED", reviewedBy: staffDiscordId, reviewedAt, createdTeamId: team.id })
    .where(eq(applications.id, applicationId))
    .run();

  db.insert(auditLog)
    .values({
      id: newId(),
      guildId: application.guildId,
      subjectType: "TEAM",
      subjectId: team.id,
      action: "application_approved",
      newValue: { applicationRef: application.publicRef, teamId: team.id, roster: roster.length },
      actorDiscordId: staffDiscordId,
    })
    .run();

  return { application: getApplication(applicationId)!, teamId: team.id };
}

/** §13 open item 4 — rejection carries a reason so the DM can explain itself. */
export function rejectApplication(
  applicationId: string,
  staffDiscordId: string,
  reason: string | null,
): Application {
  const db = getDb();
  const application = getApplication(applicationId);
  if (!application) throw new ApplicationError("Application not found.");
  if (application.status !== "SUBMITTED") {
    throw new ApplicationError(`This application is ${application.status.toLowerCase()}.`);
  }

  db.update(applications)
    .set({
      status: "REJECTED",
      reviewedBy: staffDiscordId,
      reviewedAt: new Date(),
      rejectionReason: reason,
    })
    .where(eq(applications.id, applicationId))
    .run();

  db.insert(auditLog)
    .values({
      id: newId(),
      guildId: application.guildId,
      subjectType: "TEAM",
      subjectId: applicationId,
      action: "application_rejected",
      newValue: { status: "REJECTED" },
      reason,
      actorDiscordId: staffDiscordId,
    })
    .run();

  return getApplication(applicationId)!;
}
