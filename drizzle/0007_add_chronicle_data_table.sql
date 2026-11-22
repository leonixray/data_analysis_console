CREATE TABLE IF NOT EXISTS `chronicle_data` (
  `key` text PRIMARY KEY NOT NULL,
  `payload` text NOT NULL DEFAULT '',
  `updated_at` text NOT NULL DEFAULT ''
);
