CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`match_id` text,
	`subject_type` text NOT NULL,
	`subject_id` text,
	`action` text NOT NULL,
	`old_value` text,
	`new_value` text,
	`reason` text,
	`scoring_version` text,
	`actor_discord_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_guild_created_idx` ON `audit_log` (`guild_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `automation_config` (
	`guild_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_by` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_config_pk` ON `automation_config` (`guild_id`,`key`);--> statement-breakpoint
CREATE TABLE `match_id_counters` (
	`guild_id` text NOT NULL,
	`day` text NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `match_id_counters_pk` ON `match_id_counters` (`guild_id`,`day`);--> statement-breakpoint
CREATE TABLE `match_players` (
	`id` text PRIMARY KEY NOT NULL,
	`match_id` text NOT NULL,
	`player_id` text,
	`team_id` text,
	`scoreboard_side` text,
	`scoreboard_position` integer,
	`ocr_name` text,
	`identity_status` text,
	`kills` integer,
	`deaths` integer,
	`assists` integer,
	`objective_time_seconds` integer,
	`objective_stats` text,
	`contribution` integer,
	`raw_score` integer,
	`normalized_stats` text,
	`performance_score` integer,
	`match_points` integer,
	`status` text,
	`approved_by` text,
	`approved_at` integer,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `match_players_match_idx` ON `match_players` (`match_id`);--> statement-breakpoint
CREATE TABLE `matches` (
	`id` text PRIMARY KEY NOT NULL,
	`public_match_id` text NOT NULL,
	`guild_id` text NOT NULL,
	`mode` text,
	`map` text,
	`category` text NOT NULL,
	`home_team_id` text NOT NULL,
	`away_team_id` text NOT NULL,
	`left_team_id` text,
	`right_team_id` text,
	`left_score` integer,
	`right_score` integer,
	`winner_team_id` text,
	`loser_team_id` text,
	`scheduled_at` integer NOT NULL,
	`scheduled_timezone` text NOT NULL,
	`pair_key` text NOT NULL,
	`active_fixture_key` text,
	`schedule_status` text DEFAULT 'PENDING_CONFIRMATION' NOT NULL,
	`result_status` text DEFAULT 'AWAITING_SUBMISSION' NOT NULL,
	`advance_notice_hours` integer NOT NULL,
	`advance_notice_met` integer NOT NULL,
	`registered_by` text NOT NULL,
	`confirmed_by` text,
	`confirmed_at` integer,
	`cancelled_by` text,
	`cancelled_at` integer,
	`cancel_reason` text,
	`announce_channel_id` text,
	`announce_message_id` text,
	`ticket_channel_id` text,
	`scoring_version` text,
	`raw_ocr_response` text,
	`normalized_ocr_data` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`processed_at` integer,
	FOREIGN KEY (`home_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`away_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`left_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`right_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`winner_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`loser_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `matches_public_id_key` ON `matches` (`public_match_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `matches_active_fixture_key` ON `matches` (`guild_id`,`active_fixture_key`);--> statement-breakpoint
CREATE INDEX `matches_guild_status_idx` ON `matches` (`guild_id`,`schedule_status`);--> statement-breakpoint
CREATE INDEX `matches_home_idx` ON `matches` (`home_team_id`);--> statement-breakpoint
CREATE INDEX `matches_away_idx` ON `matches` (`away_team_id`);--> statement-breakpoint
CREATE TABLE `players` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`team_id` text NOT NULL,
	`discord_id` text,
	`ign` text NOT NULL,
	`ign_key` text NOT NULL,
	`uid` text,
	`role` text DEFAULT 'PLAYER' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `players_team_ign_key` ON `players` (`team_id`,`ign_key`);--> statement-breakpoint
CREATE INDEX `players_guild_discord_idx` ON `players` (`guild_id`,`discord_id`);--> statement-breakpoint
CREATE INDEX `players_team_idx` ON `players` (`team_id`);--> statement-breakpoint
CREATE TABLE `point_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`match_id` text NOT NULL,
	`player_id` text,
	`team_id` text,
	`points` integer NOT NULL,
	`point_type` text NOT NULL,
	`scoring_version` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `point_tx_match_idx` ON `point_transactions` (`match_id`);--> statement-breakpoint
CREATE TABLE `scheduled_jobs` (
	`name` text PRIMARY KEY NOT NULL,
	`last_run_at` integer,
	`next_run_at` integer
);
--> statement-breakpoint
CREATE TABLE `staff_roles` (
	`guild_id` text NOT NULL,
	`role_id` text NOT NULL,
	`added_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `staff_roles_pk` ON `staff_roles` (`guild_id`,`role_id`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`tag` text,
	`region` text,
	`tier` text,
	`logo_url` text,
	`captain_discord_id` text NOT NULL,
	`registered_by` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_guild_name_key` ON `teams` (`guild_id`,`name_key`);--> statement-breakpoint
CREATE INDEX `teams_guild_captain_idx` ON `teams` (`guild_id`,`captain_discord_id`);