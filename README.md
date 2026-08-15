# UM League — CODM Scrim Bot

All four phases: teams and scheduling, tickets and applications, the OCR result pipeline
with scoring and approval, and compliance flagging.

Stack is as decided in §2 and not re-litigated: Bun, plain TypeScript, discord.js v14,
Drizzle + `bun:sqlite`, systemd. No NestJS, no Prisma, no `node-fetch`, no PM2. The OCR
model runs as a separate Python service.

## Setup

```bash
bun install
cp .env.example .env          # fill in DISCORD_TOKEN and DISCORD_CLIENT_ID
bun run deploy                # publish slash commands to Discord
bun run start
```

Set `DEV_GUILD_ID` while developing — commands appear in that one server immediately
instead of taking up to an hour to propagate globally.

**Install fonts on the host.** The leaderboard renderer needs them:

```bash
sudo apt-get install fonts-noto-core fonts-noto-cjk
```

Without them the renderer still succeeds and still produces a valid PNG — every Arabic and
Japanese team name is just a row of empty boxes. It warns at boot and CI fails on it, but
it is worth doing before the first leaderboard is posted rather than after.

| Script | Does |
|---|---|
| `bun run start` | Run the bot |
| `bun run dev` | Run with file watching |
| `bun run deploy` | Publish slash-command definitions |
| `bun run db:generate` | Regenerate SQL migrations after editing `schema.ts` |
| `bun run typecheck` | `tsc --noEmit` |
| `bun test` | Test suite |

Migrations are committed to `drizzle/` and applied on boot. Regenerate whenever
`src/db/schema.ts` changes; the app never pushes a schema at runtime.

## Commands

**Teams** — `/teamregister`, `/teamaddplayer`, `/teamremoveplayer`, `/teamroster`

**Matches** — `/matchregister`, `/matchconfirm`, `/matchupdate`, `/matchcancel`,
`/matchhistory`

**Manual match management (staff, independent of OCR)** — `/matchadd` (generates and returns
the match ID itself), `/matchedit`, `/matchdelete`

**Tickets** — `/ticketopen`, `/ticketclose` (staff),
`/ticketconfig show|preview|placeholders|name|topic|category|welcome|staffrole|ping|close|reset`

**Embed branding (staff)** — `/embedconfig show|preview|name|color|footer|logo|timestamps|reset`

**Applications** — `/setapply`, `/postapply`, `/setapplicationchannel`, `/application`

**Results** — `/matchresult` (screenshot), `/matchscore` (manual, staff), `/matchpending`,
`/matchapprove`, `/matchreverse`

**Leaderboards** — `/leaderboard`, `/leaderboardstyle` (static PNG or animated GIF),
`/setleaderboardchannel`

**Compliance** — `/compliance list|ack|limits`

**Config (staff)** — `/config show|toggle|timezone|announcechannel|advancenotice`,
`/staffrole add|remove|list`

Server administrators always count as staff, so a fresh install is never locked out.

## Customizing tickets and embeds

Both are staff slash commands, both persist in the database, and both are previewable before
they go live.

`/ticketconfig` drives the channel name, topic and welcome message through templates with
`{placeholders}` — `{home}`, `{away}`, `{id}`, `{category}`, `{kickoff}`, `{captain_home}`
and so on. `/ticketconfig placeholders` lists them all.

Templates are **validated when you save them**, not when a match opens. A typo like
`match-{hoem}-vs-{away}` is rejected immediately with the valid list, rather than becoming a
live channel nobody can explain. `/ticketconfig preview` renders the name, topic and welcome
message against sample data using the same code path a real ticket uses, so the preview
cannot drift from reality.

`/ticketconfig ping` chooses who gets mentioned on open (captains, staff, both, nobody), and
`/ticketconfig close` chooses whether `/ticketclose` deletes the channel or archives it as a
read-only dispute record.

`/embedconfig` sets league name, per-state colours, footer, default logo and timestamps.
Colours are addressed by **role** — pending, confirmed, cancelled, error, brand — rather than
by embed, so a state you never customize still reads correctly. `/embedconfig preview` shows
the whole palette in context. Any value can be reset to the built-in default.

## Enabling OCR

`OCR_SERVICE_URL` and `OCR_SERVICE_KEY` are not issued by a provider — the key is a random
string you generate and set on both sides, and the URL is wherever you deploy
`ocr-service/`. **`ocr-service/SETUP.md` is the step-by-step guide**, including hosting
options and costs, verification with `curl`, and what each failure message means.

The short version:

```bash
openssl rand -hex 32                      # this is OCR_SERVICE_KEY
# deploy ocr-service/ with that key in its environment
# its public URL is OCR_SERVICE_URL
```

```dotenv
OCR_SERVICE_URL=https://your-ocr-host
OCR_SERVICE_KEY=<the same key the service has>
```

then `/config toggle screenshot_ocr_pipeline true`.

With OCR off or unreachable, `/matchresult` accepts the screenshot and tells the submitter
that staff will record the result manually with `/matchscore`. The bot never fails a
submission because OCR is down.

## Rules this build enforces

- **Confirmation is a hard gate.** Only the opposing captain confirms; staff can confirm on
  their behalf. No toggle skips it.
- **Points exist only after staff approval,** and only as transactions. Totals are always
  derived by summing the ledger, never stored in a counter, so a leaderboard cannot drift
  from the audit trail. Reversals write compensating entries rather than editing history.
- **OCR is advisory.** Every authoritative number is calculated in TypeScript.
  `teamPointsPreview.authoritative` is always `false`.
- **Streamer Mode rows are never auto-mapped and never auto-scored,** even when their
  statistics are fully visible. Team points are unaffected, since they come from the score.
- **Unusual usernames are not Streamer Mode.** `_reza1391` and `xxALHAJE[7jj]` are ordinary
  names; there are tests on both sides of this in TypeScript and Python.
- **A fuzzy name match is a suggestion, never an assignment.**
- **Unknown is not zero.** A missing player is a pending slot, not a player with 0 kills.
- **Every toggle lives in the database.** `src/lib/automation-config.ts` is the only path to
  a flag. A test sets flags, closes the database, reopens it, and asserts the values held —
  the PTB `autoRecordEnabled` bug in reverse.
- **Every embed body is bold, every button edits in place.** Enforced in
  `src/lib/embeds.ts`.
- **Ticket privacy is explicit `PermissionOverwrites`,** not category inheritance. Closure
  is staff-only, hard-enforced in the service.
- **Compliance is flag-only and off by default.** It cannot block a registration.
- **Confirmation triggers the ticket and the match log,** both toggle-gated and default on
  (`auto_ticket_creation`, `auto_match_logging`). Neither can fail a confirmation: a missing
  permission or deleted log channel is reported and logged, and the match stays confirmed.
- **Secrets never enter the repo.** `.gitignore` covers `credentials/` and `.env*`, and CI
  fails if either is tracked.

## Scoring, and where the supplied calibration runs out

Team points come from the score gap against per-mode calibration curves in
`src/scoring/scoring-config.ts`. Only the points the client actually supplied are encoded —
nothing was invented to make a curve look complete.

That leaves real gaps, so every calculation carries a `CalibrationConfidence`:

| Confidence | Meaning |
|---|---|
| `CALIBRATED` | Gap sits exactly on a supplied point |
| `INTERPOLATED` | Between two supplied points |
| `CLAMPED_LOW` / `CLAMPED_HIGH` | Outside the calibrated range; nearest value used |
| `EXTRAPOLATED` | Outside the range, slope continued (non-default policy) |
| `INSUFFICIENT_CALIBRATION` | Curve has fewer than two points — cannot interpolate at all |

Anything other than the first two sets `requiresCalibrationReview` and prints a
plain-English warning on the result embed before staff approve.

**Three things need client input before Control scoring can be trusted:**

1. **Control has one calibration point** (`4-0 → +45/-45`). Interpolation needs two, so
   4-3, 4-2 and 4-1 are undefined. They currently return the clamped fallback and flag every
   time. Supplying those three points fixes it with no code change.
2. **Out-of-range policy.** Default is `CLAMP`. This affects ordinary matches, not edge
   cases: Hardpoint 250-249 is a gap of 0.004, below the lowest calibrated point of 0.04,
   and S&D 9-0 is 0.45, above the highest of 0.30.
3. **S&D reference score of 20.** With a regulation max of 9, every realistic S&D gap
   compresses into 5-45% of the curve, and 14-12 overtime scores identically to a regulation
   9-7. Kept as given, but worth confirming.

Player points are independent of team points (§11): never the team total divided up, never
the same value for everyone. Objective/K-D/assists weighted 50/30/20, normalized relative to
the match population, calibrated so the §26 worked example (73.42 → +18) reproduces exactly.
Unknown components drop out and the remaining weights renormalize, so S&D players are not
penalised 50% for objective time the game never displays.

Because normalization is population-relative, scores stay **provisional** until every slot
is resolved, then get recalculated and logged (§27). Approval is blocked while anything is
pending.

## Leaderboard rendering

Static PNG by default. `/leaderboardstyle animated` switches to GIF: rows sweep in staggered
by rank, then hold on the finished board.

`gifenc` was chosen after spiking it on Bun (§11 requires this before committing to any
GIF dependency). It is pure JavaScript — the obvious alternative, `gifencoder`, pulls in
node-canvas and reintroduces exactly the node-gyp/Cairo build risk §2 rejected. A 10-row
animated board encodes to roughly 215KB, well under Discord's 8MB attachment limit; the
smoke test fails the build if that ever stops being true.

Team boards sort by points, K/D, kills, objective time, wins or win rate. Player boards add
MVP, which is derived rather than read from a scoreboard: the single highest performance
score in a completed match earns one, and a tie awards nobody.

## Decisions made during the build

**Two status columns, not one.** `scheduleStatus` is separate from `resultStatus` — a match
can be CONFIRMED and OCR_PROCESSING simultaneously, which the §9.2 union cannot express.
`resultStatus` also carries `STREAMER_MODE_DETECTED` and
`PENDING_STREAMER_MODE_RESOLUTION`, which §12 requires but §9.2 omits.

**Duplicate fixtures are blocked** via `activeFixtureKey` (sorted team pair + kickoff) under
a unique index. Cancelling nulls it, freeing the slot for legitimate re-registration.

**Editing a confirmed match clears the confirmation,** or one captain could move an agreed
fixture unilaterally. Controlled by `reconfirm_after_update`.

**Timezones are explicit.** `league_timezone` config, per-command override, UTC storage,
Intl-based conversion with a DST test.

**`category` is match type** (SCRIM/OFFICIAL/TOURNAMENT/PRACTICE), since mode comes off the
scoreboard in Phase 3. **Worth confirming** — §7.1 does not say which was meant.

**24h notice flags, does not block,** per §7.1. One `throw` in `registerMatch` changes it.

**Soft deletes on players,** since `match_players` rows must stay resolvable.

**A captain leads one team; a player is rostered on one team.** Both enforced.

**`/matchedit` refuses to edit a completed match.** Points are already awarded, and editing
in place would silently rewrite history (§40). Reverse first with `/matchreverse`, then edit.
`/matchdelete` reverses points rather than deleting the ledger rows, so a deleted match still
has a traceable history.

**`normalizeKey` is Unicode-aware.** An ASCII-only filter reduced a purely Arabic or
Japanese team name to an empty string, which then failed the minimum-length check — the
league would have been unusable for exactly the scripts §34 requires. Caught by the
multilingual render test, not by review.

## Known gaps

Two things in the spec are deliberately not built, both because they need a client decision
rather than more code:

- **Multiple / per-map screenshots.** `/matchresult` takes one attachment. §10 mentions
  modals for per-map score entry, but the match model has one score per match — supporting a
  best-of-N series means deciding whether a series is one match record or several.
- **DM-based result submission.** §7.2 allows "DM or ticket"; only the in-server command path
  is built. The DM route needs a way to identify which match a loose screenshot belongs to.

§13 item 5 (an embed-picker replacing the typed `/matchregister`) was listed as an open item
in the brief and is likewise not built.

## Still open

1. Control calibration points for 4-3, 4-2, 4-1 (blocks trustworthy Control scoring).
2. Out-of-range policy: clamp or extrapolate.
3. S&D reference score of 20 — confirm intended.
4. `category` — match type or game mode?
5. Advance-notice rule: flag (current) or hard block.
6. OCR microservice hosting and budget.
7. Who may submit a result — currently a participating captain or staff.
8. Application rejection UX — currently DMs the applicant with a generic reason.

## Deployment

```bash
sudo cp deploy/uml-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now uml-bot
journalctl -u uml-bot -f
```

The unit restarts on failure with a burst limit, so a bad deploy stops rather than hammering
the Discord gateway. `MemoryMax=768M` leaves headroom on an Oracle Ampere A1 free-tier
instance. Logs are single-line JSON — `journalctl -u uml-bot -f | jq` reads well.

Health check on `:8080/health`, reporting gateway readiness rather than process liveness: a
bot that is running but disconnected returns 503.

## Testing

```bash
bun test                                    # 107 tests
bun run src/leaderboard/render.smoke.ts     # canvas + font coverage
cd ocr-service && python -m unittest discover -p 'test_*.py'
```

Coverage is deliberately weighted toward the things that corrupt point totals silently:
every supplied calibration point reproduces exactly, loser points are not the negation of
winner points, Streamer Mode rows are never auto-scored, missing players are not zero-stat
players, points cannot be awarded twice, reversals preserve the original ledger entries, and
toggles survive a restart.

## Project layout

```
src/
  db/           schema.ts (single source of truth), client.ts, migrate.ts
  lib/          automation-config, permissions, embeds, datetime, ids, http, health,
                weekly-reset, env, logger
  teams/        team.service.ts
  matches/      match.service.ts (scheduling), result.service.ts (§7.5 pipeline)
  scoring/      scoring-config, interpolation, normalization, team-scoring, player-scoring
  ocr/          ocr.types, ocr-validator, paddleocr.service
  players/      player-matching, pending-player
  approvals/    approval.service.ts
  points/       point-transaction.service.ts
  tickets/      ticket.service.ts
  applications/ application.service.ts
  compliance/   compliance.service.ts
  leaderboard/  standings.service, render.service, render.smoke
  discord/      discord-match-embed, result-embed
  commands/     team, match, ticket, application, review, leaderboard, compliance, automation
  interactions/ router.ts, phase234-router.ts
  main.ts, deploy-commands.ts
ocr-service/    FastAPI + PaddleOCR-VL (separate deployment)
deploy/         systemd unit
drizzle/        committed SQL migrations
```
