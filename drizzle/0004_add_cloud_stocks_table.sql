CREATE TABLE IF NOT EXISTS `cloud_stocks` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `market` text NOT NULL,
  `code` text NOT NULL,
  `name` text NOT NULL,
  `sector` text NOT NULL,
  `industry` text NOT NULL DEFAULT '',
  `weight_pct` real NOT NULL DEFAULT 0,
  `price` real NOT NULL DEFAULT 0,
  `date` text NOT NULL DEFAULT '',
  `d1` real NOT NULL DEFAULT 0,
  `w1` real,
  `m1` real,
  `m3` real,
  `m6` real,
  `ytd` real,
  `y1` real,
  `ma50_diff` real,
  `ma200_diff` real,
  `from_high` real NOT NULL DEFAULT 0,
  `size_basis` text NOT NULL DEFAULT 'cap'
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `cloud_stocks_market_code` ON `cloud_stocks` (`market`, `code`);
