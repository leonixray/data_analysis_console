DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE series_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  series_key TEXT NOT NULL,
  date TEXT NOT NULL,
  value REAL NOT NULL,
  volume REAL
);
--> statement-breakpoint
CREATE UNIQUE INDEX series_points_key_date ON series_points (series_key, date);
--> statement-breakpoint
CREATE TABLE refresh_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finished_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
