import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// One row per (series, trading day). series_key covers both price series
// (Yahoo symbols, e.g. "spx", "csi300", "gold") and yield series
// (Eastmoney tenors, e.g. "cn10y", "us2y"). value = close price or yield %.
export const seriesPoints = sqliteTable(
  "series_points",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    seriesKey: text("series_key").notNull(),
    date: text("date").notNull(), // YYYY-MM-DD (exchange local date)
    value: real("value").notNull(),
    volume: real("volume"),
    // 1 when this point is an intraday snapshot rather than the day's
    // final close (HK series fetched before the 16:00 HK close). The
    // next post-close refresh overwrites the row via the overlap window
    // and the flag clears. All other markets store 0.
    partial: integer("partial").notNull().default(0),
  },
  (t) => [uniqueIndex("series_points_key_date").on(t.seriesKey, t.date)],
);

// Forward-looking market events (next ~3 months), rebuilt on every refresh
// from programmatic sources: Faireconomy calendar JSON (near-term macro
// releases with forecast/previous), the Federal Reserve's published FOMC
// schedule page, and Nasdaq's earnings calendar for a watchlist of giants.
export const calendarEvents = sqliteTable("calendar_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(), // YYYY-MM-DD, Beijing date of the event
  timeText: text("time_text").notNull().default(""), // Beijing time label
  title: text("title").notNull(),
  category: text("category").notNull(), // 美联储 | 美国数据 | 中国数据 | 财报 | 市场事件
  impact: text("impact").notNull().default(""), // High | Medium | ""
  forecast: text("forecast").notNull().default(""),
  previous: text("previous").notNull().default(""),
  explain: text("explain").notNull().default(""),
  watch: text("watch").notNull().default(""),
  source: text("source").notNull().default(""),
});

// Full index-universe snapshot for the cloud map （云图）: one row per index
// constituent (S&P 500 / CSI 300), replaced per market on every refresh.
// Period returns / MA distances / 52-week-high distance are computed at
// refresh time from 1y of daily closes; the raw history is not kept.
export const cloudStocks = sqliteTable(
  "cloud_stocks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    market: text("market").notNull(), // "us" | "cn"
    code: text("code").notNull(), // display ticker (AAPL / 600519)
    name: text("name").notNull(),
    sector: text("sector").notNull(),
    industry: text("industry").notNull().default(""),
    weightPct: real("weight_pct").notNull().default(0), // index weight %
    capValue: real("cap_value"), // absolute market cap, local currency (USD / CNY); null when the cap leg failed
    price: real("price").notNull().default(0),
    date: text("date").notNull().default(""), // last close date
    d1: real("d1").notNull().default(0),
    w1: real("w1"),
    m1: real("m1"),
    m3: real("m3"),
    m6: real("m6"),
    ytd: real("ytd"),
    y1: real("y1"),
    ma50Diff: real("ma50_diff"), // % above (+) / below (−) the 50-day mean
    ma200Diff: real("ma200_diff"),
    fromHigh: real("from_high").notNull().default(0), // % below the 52w high (≤ 0)
    // Premarket change % from the same Yahoo quote leg that supplies
    // market caps, captured at snapshot time (US markets only; null for
    // A-shares and whenever the quote carried no premarket field). The
    // cloud map's 盘前 toggle recolours tiles from this column alone —
    // it never mixes with the close-based d1.
    prePct: real("pre_pct"),
    sizeBasis: text("size_basis").notNull().default("cap"), // cap | weight | turnover
  },
  (t) => [uniqueIndex("cloud_stocks_market_code").on(t.market, t.code)],
);

// 美股编年史 module: one row per historyofmarket.com dataset (trimmed /
// downsampled JSON payload), plus a "_manifest" row with the source's
// generation timestamp. Data is CC BY 4.0 with attribution on the page.
export const chronicleData = sqliteTable("chronicle_data", {
  key: text("key").primaryKey(),
  payload: text("payload").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(""),
});

// Fibonacci 52-week anchors for the US majors (QQQ / VOO): the
// trailing-252-session intraday high & low with their dates, derived at
// refresh time from Yahoo daily OHLC and cross-validated against a
// second source (Nasdaq official historical API, falling back to
// Eastmoney push2his US klines). Levels are computed
// at read time from these anchors; a failed validation keeps the row
// with verified = 0 so the card can say so honestly.
export const fibAnchors = sqliteTable("fib_anchors", {
  key: text("key").primaryKey(), // series key: qqq | voo | ndx
  name: text("name").notNull(),
  high: real("high").notNull(),
  highDate: text("high_date").notNull(), // YYYY-MM-DD of the 52w intraday high
  low: real("low").notNull(),
  lowDate: text("low_date").notNull(), // YYYY-MM-DD of the 52w intraday low
  close: real("close").notNull(), // latest close at anchor computation time
  closeDate: text("close_date").notNull(),
  verified: integer("verified").notNull().default(0), // 1 = second source agrees on both anchors (dates + values)
  verifySource: text("verify_source").notNull().default(""),
  verifyHigh: real("verify_high"),
  verifyHighDate: text("verify_high_date").notNull().default(""),
  verifyLow: real("verify_low"),
  verifyLowDate: text("verify_low_date").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(""),
});

// Forward 12-month PE, MANUALLY recorded (no stable programmatic
// source exists — see DATA-PLAN v48): one row per (index, edition
// date). S&P 500 values come from FactSet Earnings Insight (weekly
// PDF, "The forward 12-month P/E ratio for the S&P 500 is X.X");
// Nasdaq-100 values come from Siblis Research's monthly page
// (forward column, month-end). avg5/avg10 are the 5y/10y averages
// printed in the same FactSet edition (null when the source does
// not publish them — Siblis publishes none). Percentiles are
// computed at read time from these rows with the same 5y /
// 8-point-floor rule as TTM PE; below 8 rows the card shows
// 积累中, never an estimate. dollarliquidity's Nasdaq forward PE
// (18.25×, 2026-11-18) is a cross-check only and is NEVER stored
// here (no public API; history lives in an RSC payload).
// Since v123 the same FactSet edition's sector table (p.26
// "Forward 12M P/E Ratio: Sector Level") is recorded under
// fwd_xlb…fwd_xly — S&P 500 GICS sector-index forward P/Es, the
// indices the SPDR sector ETFs track; each edition also prints
// sector 5y/10y averages, stored alongside like the index rows.
export const forwardPe = sqliteTable(
  "forward_pe",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    key: text("key").notNull(), // "fwd_spx" | "fwd_ndx"
    date: text("date").notNull(), // YYYY-MM-DD (edition / month-end date)
    value: real("value").notNull(), // forward 12M PE (×)
    avg5: real("avg5"), // 5y average printed by the same source edition
    avg10: real("avg10"), // 10y average printed by the same source edition
    source: text("source").notNull().default(""), // e.g. "FactSet Earnings Insight 2026-11-13"
  },
  (t) => [uniqueIndex("forward_pe_key_date").on(t.key, t.date)],
);

// Server-only secrets (e.g. the FRED API key), written exclusively by
// the setFredApiKey action and read only inside server actions. No
// action ever returns a value from this table, and nothing from it is
// written to refresh_log, page copy, or any client payload — the key
// lives in the artifact's database, never in shipped source or bundles.
export const serverSecrets = sqliteTable("server_secrets", {
  name: text("name").primaryKey(), // e.g. "fred_api_key"
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(""),
});

export const refreshLog = sqliteTable("refresh_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  status: text("status").notNull(), // "ok" | "partial" | "error"
  detail: text("detail").notNull().default(""),
  // Which refresh stage wrote this row ("" = legacy full refresh). The
  // dashboard reads the newest row per stage to show per-module 数据更新于
  // times, so the user can tell cached blocks from freshly refreshed ones.
  stage: text("stage").notNull().default(""),
});
