CREATE TABLE `oq_products` (
	`slug` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `oq_docs` ADD `product` text DEFAULT 'hr-helper' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_oq_docs_product` ON `oq_docs` (`collection`,`product`,`updated_at`,`version`);--> statement-breakpoint
ALTER TABLE `oq_events` ADD `product` text;--> statement-breakpoint
ALTER TABLE `oq_tokens` ADD `products` text DEFAULT '["hr-helper"]' NOT NULL;--> statement-breakpoint
ALTER TABLE `oq_tokens` ADD `expires_at` integer;