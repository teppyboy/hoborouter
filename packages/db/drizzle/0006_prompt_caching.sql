CREATE TABLE `instance_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `models` ADD `prompt_caching` text DEFAULT 'inherit' NOT NULL CONSTRAINT `models_prompt_caching` CHECK(`prompt_caching` IN ('inherit','on','off'));
