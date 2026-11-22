CREATE TABLE `fib_anchors` (
	`key` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`high` real NOT NULL,
	`high_date` text NOT NULL,
	`low` real NOT NULL,
	`low_date` text NOT NULL,
	`close` real NOT NULL,
	`close_date` text NOT NULL,
	`verified` integer DEFAULT 0 NOT NULL,
	`verify_source` text DEFAULT '' NOT NULL,
	`verify_high` real,
	`verify_high_date` text DEFAULT '' NOT NULL,
	`verify_low` real,
	`verify_low_date` text DEFAULT '' NOT NULL,
	`updated_at` text DEFAULT '' NOT NULL
);
