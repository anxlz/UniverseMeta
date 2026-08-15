CREATE TABLE `application_players` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`slot` integer NOT NULL,
	`ign` text NOT NULL,
	`uid` text,
	`discord_id` text,
	`is_captain` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `application_players_app_idx` ON `application_players` (`application_id`);--> statement-breakpoint
CREATE TABLE `applications` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`public_ref` text NOT NULL,
	`applicant_discord_id` text NOT NULL,
	`team_name` text NOT NULL,
	`region` text,
	`tier` text,
	`logo_url` text,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`created_team_id` text,
	`reviewed_by` text,
	`reviewed_at` integer,
	`rejection_reason` text,
	`review_channel_id` text,
	`review_message_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`submitted_at` integer,
	FOREIGN KEY (`created_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `applications_public_ref_key` ON `applications` (`public_ref`);--> statement-breakpoint
CREATE INDEX `applications_guild_status_idx` ON `applications` (`guild_id`,`status`);--> statement-breakpoint
CREATE INDEX `applications_applicant_idx` ON `applications` (`applicant_discord_id`);--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`match_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`decision_note` text,
	`channel_id` text,
	`message_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `approvals_match_status_idx` ON `approvals` (`match_id`,`status`);--> statement-breakpoint
CREATE TABLE `compliance_flags` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`match_id` text,
	`team_id` text,
	`rule` text NOT NULL,
	`severity` text DEFAULT 'WARN' NOT NULL,
	`detail` text NOT NULL,
	`week_start` integer,
	`acknowledged_by` text,
	`acknowledged_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `compliance_guild_week_idx` ON `compliance_flags` (`guild_id`,`week_start`);--> statement-breakpoint
CREATE TABLE `unresolved_slots` (
	`id` text PRIMARY KEY NOT NULL,
	`match_id` text NOT NULL,
	`team_id` text,
	`reason` text NOT NULL,
	`side` text,
	`slot` integer,
	`ocr_name` text,
	`held_kills` integer,
	`held_deaths` integer,
	`held_assists` integer,
	`held_objective_time_seconds` integer,
	`resolved_player_id` text,
	`resolved_by` text,
	`resolved_at` integer,
	`status` text DEFAULT 'PENDING' NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolved_player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `unresolved_slots_match_idx` ON `unresolved_slots` (`match_id`,`status`);--> statement-breakpoint
ALTER TABLE `match_players` ADD `is_provisional` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `match_players` ADD `stats_source` text;--> statement-breakpoint
ALTER TABLE `matches` ADD `calculated_data` text;--> statement-breakpoint
ALTER TABLE `matches` ADD `team_points_breakdown` text;--> statement-breakpoint
ALTER TABLE `matches` ADD `submitted_by` text;--> statement-breakpoint
ALTER TABLE `matches` ADD `submitted_at` integer;--> statement-breakpoint
ALTER TABLE `matches` ADD `screenshot_url` text;--> statement-breakpoint
ALTER TABLE `matches` ADD `streamer_mode_enabled` integer;--> statement-breakpoint
ALTER TABLE `matches` ADD `calibration_confidence` text;