CREATE TABLE IF NOT EXISTS `ai_news` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `url` text NOT NULL,
  `title` text NOT NULL,
  `source` text NOT NULL DEFAULT '',
  `published_date` text NOT NULL DEFAULT '',
  `fetched_at` text NOT NULL DEFAULT ''
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ai_news_url` ON `ai_news` (`url`);
