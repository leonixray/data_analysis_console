CREATE TABLE `forward_pe` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `key` text NOT NULL,
  `date` text NOT NULL,
  `value` real NOT NULL,
  `avg5` real,
  `avg10` real,
  `source` text NOT NULL DEFAULT ''
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forward_pe_key_date` ON `forward_pe` (`key`, `date`);
