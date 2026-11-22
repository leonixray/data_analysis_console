CREATE TABLE calendar_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  time_text TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  impact TEXT NOT NULL DEFAULT '',
  forecast TEXT NOT NULL DEFAULT '',
  previous TEXT NOT NULL DEFAULT '',
  explain TEXT NOT NULL DEFAULT '',
  watch TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT ''
);
--> statement-breakpoint
CREATE INDEX calendar_events_date ON calendar_events (date);
