ALTER TABLE `requests` ADD `deleted_at` integer;
--> statement-breakpoint
ALTER TABLE `requests` ADD `deleted_by` text;
