// Cloud map （云图） actions, split out of actions.ts by domain in the
// 2026-11-19 cloud split: the cloud snapshot read (getCloud), the
// per-stock detail drawer fetch (getStockDetail) and the tile PE
// percentile batch (getCloudPeHist), with their response schemas.
// Shared fetch/PE helpers stay in actions.ts and are imported from
// there; behaviour and response shapes are unchanged.
import { defineAction, z } from "@hatch/space-sdk";
import { desc, eq } from "drizzle-orm";
import * as schema from "./schema";
import {
US_ZH_NAMES,
computePeValuation,
dateInTz,
fetchCnPePoints,
fetchCnProfile,
fetchIntraday,
fetchUsPePoints,
fetchYahoo,
fetchYahooNews,
fetchYahooQuote,
fetchYahooQuoteBatch,
fetchYahooQuoteSummary,
mapPool,
peHistoryStats,
} from "./actions";
import type { Pt, StockNewsItem } from "./actions";

const cloudStockZ = z.object({
  code: z.string(),
  name: z.string(),
  zh: z.string().nullable(), // common Chinese name (US/NDX only); null → the tile headlines the ticker
  sector: z.string(),
  industry: z.string(),
  weight: z.number(), // index weight % (US: market-cap share of the universe)
  cap: z.number().nullable(), // absolute market cap, local currency; null when unknown
  price: z.number(),
  date: z.string(),
  d1: z.number(),
  w1: z.number().nullable(),
  m1: z.number().nullable(),
  m3: z.number().nullable(),
  m6: z.number().nullable(),
  ytd: z.number().nullable(),
  y1: z.number().nullable(),
  ma50: z.number().nullable(), // % above (+) / below (−) the 50-day mean
  ma200: z.number().nullable(),
  fromHigh: z.number(), // % below the 52-week high (≤ 0)
  pre: z.number().nullable(), // premarket change % captured with the snapshot (US only)
});

const cloudMarketZ = z.object({
  asOf: z.string(), // latest close date among constituents
  sizeBasis: z.string(), // cap | weight | turnover
  unit: z.string(),
  stocks: z.array(cloudStockZ),
});

const cloudZ = z.object({
  us: cloudMarketZ,
  ndx: cloudMarketZ,
  dow: cloudMarketZ,
  rut: cloudMarketZ,
  cn: cloudMarketZ,
  // Official index day moves for the two indices that have no dashboard
  // instrument series (道指 ^DJI / 罗素 2000 ^RUT), derived in getCloud
  // from the closes their cloud stages store. Null when the series has
  // not landed yet — the selector then uses the labelled estimate.
  official: z.object({
    dow: z.object({ pct: z.number(), date: z.string() }).nullable(),
    rut: z.object({ pct: z.number(), date: z.string() }).nullable(),
  }),
});

const stockDetailZ = z.object({
  ok: z.boolean(),
  open: z.number().nullable(),
  high: z.number().nullable(),
  low: z.number().nullable(),
  volume: z.number().nullable(),
  avgVolume: z.number().nullable(),
  prevClose: z.number().nullable(),
  postPrice: z.number().nullable(),
  postPct: z.number().nullable(),
  prePrice: z.number().nullable(),
  prePct: z.number().nullable(),
  divRateTtm: z.number().nullable(), // trailing 12-month dividend per share (quote's trailingAnnualDividendRate)
  divDate: z.string(), // Yahoo's dividendDate (ex-dividend date), exchange-local YYYY-MM-DD; "" when absent
  cap: z.number().nullable(),
  peTtm: z.number().nullable(),
  peFwd: z.number().nullable(),
  divYieldPct: z.number().nullable(),
  epsTtm: z.number().nullable(),
  beta: z.number().nullable(),
  ps: z.number().nullable(),
  pb: z.number().nullable(),
  roePct: z.number().nullable(),
  high52: z.number().nullable(),
  low52: z.number().nullable(),
  nextEarnings: z.string(),
  earningsEst: z.boolean(),
  intraday: z.array(z.object({ t: z.string(), p: z.number(), v: z.number() })),
  intraPrevClose: z.number().nullable(),
  peHist: z.object({ current: z.number(), median: z.number(), percentile: z.number(), n: z.number() }).nullable(),
  // Company profile excerpt (publisher's own wording, trimmed only):
  // Yahoo assetProfile for US names, Eastmoney F10 公司简介 for
  // A-shares. "" = the source carried none and the drawer hides the
  // block entirely; profileSource is its provenance label ("" too).
  profile: z.string(),
  profileSource: z.string(),
  // Up to 3 recent Yahoo Finance headlines (US names only — the feed
  // is empty for A-share symbols, so CN drawers get an empty array).
  news: z.array(z.object({ title: z.string(), publisher: z.string(), date: z.string(), link: z.string() })),
});

const getCloudAction = defineAction({
    description: "读取云图快照（标普 500、纳斯达克 100、道琼斯工业平均全成分股，罗素 2000 前 200 大成分（IWM 持仓口径、非全量），与沪深 300 全成分股），附道指/罗素 2000 的官方指数当日涨跌。与 getDashboard 分开：只有打开云图页才拉，首屏不背它。",
    request: z.object({}),
    response: z.object({ cloud: cloudZ }),
    async handler(ctx): Promise<{ cloud: z.infer<typeof cloudZ> }> {
      const db = ctx.db<typeof schema>();
      const cloud: z.infer<typeof cloudZ> = {
        us: { asOf: "", sizeBasis: "cap", unit: "美元", stocks: [] },
        ndx: { asOf: "", sizeBasis: "cap", unit: "美元", stocks: [] },
        dow: { asOf: "", sizeBasis: "cap", unit: "美元", stocks: [] },
        rut: { asOf: "", sizeBasis: "weight", unit: "美元", stocks: [] },
        cn: { asOf: "", sizeBasis: "weight", unit: "元", stocks: [] },
        official: { dow: null, rut: null },
      };
      const rows = await db.select().from(schema.cloudStocks).orderBy(desc(schema.cloudStocks.weightPct));
      for (const r of rows) {
        const mkt =
          r.market === "cn"
            ? cloud.cn
            : r.market === "ndx"
              ? cloud.ndx
              : r.market === "dow"
                ? cloud.dow
                : r.market === "rut"
                  ? cloud.rut
                  : cloud.us;
        mkt.stocks.push({
          code: r.code,
          name: r.name,
          zh: r.market === "cn" ? null : (US_ZH_NAMES[r.code] ?? null),
          sector: r.sector,
          industry: r.industry,
          weight: r.weightPct,
          cap: r.capValue,
          price: r.price,
          date: r.date,
          d1: r.d1,
          w1: r.w1,
          m1: r.m1,
          m3: r.m3,
          m6: r.m6,
          ytd: r.ytd,
          y1: r.y1,
          ma50: r.ma50Diff,
          ma200: r.ma200Diff,
          fromHigh: r.fromHigh,
          pre: r.prePct,
        });
        if (r.date > mkt.asOf) mkt.asOf = r.date;
        mkt.sizeBasis = r.sizeBasis;
      }
      // Official day moves for 道指 / 罗素 2000 from the index closes
      // their cloud stages store (last two points; fewer than two →
      // null and the selector falls back to the labelled estimate).
      for (const [slot, key] of [
        ["dow", "dji"],
        ["rut", "rut"],
      ] as const) {
        const pts = await db
          .select()
          .from(schema.seriesPoints)
          .where(eq(schema.seriesPoints.seriesKey, key))
          .orderBy(desc(schema.seriesPoints.date))
          .limit(2);
        const last = pts[0];
        const prev = pts[1];
        if (last && prev && prev.value > 0) {
          cloud.official[slot] = {
            pct: Math.round(((last.value / prev.value - 1) * 100 + Number.EPSILON) * 100) / 100,
            date: last.date,
          };
        }
      }
      return { cloud };
    },
});

const getStockDetailAction = defineAction({
    description: "按需拉取云图单只成分股的详情：Yahoo 报价（开高低量/市盈率/股息率/盘后/下次财报）、quoteSummary（贝塔/市销率/市净率/ROE）、日内 5 分钟分时，由 SEC EDGAR（美股）或东财财报 EPS（A股）算出的 5 年市盈率历史百分位，公司简介（美股 Yahoo assetProfile、A股东财 F10 公司简介，原文摘录不改写、无则为空），以及美股的 Yahoo Finance 近期新闻标题（≤3 条，带发布方与日期；A股该源为空、不接替代源）。点开个股时才调用，取不到的字段返回空、不估算。",
    request: z.object({
      market: z.enum(["us", "ndx", "dow", "rut", "cn"]),
      code: z.string().min(1).max(12),
    }),
    response: z.object({ detail: stockDetailZ }),
    async handler(ctx, args): Promise<{ detail: z.infer<typeof stockDetailZ> }> {
      void ctx;
      const isCn = args.market === "cn";
      const symbol = isCn ? `${args.code}.${/^[69]/.test(args.code) ? "SS" : "SZ"}` : args.code;
      const tz = isCn ? "Asia/Shanghai" : "America/New_York";
      const [quote, qs, intra, closes, cnProfile, news] = await Promise.all([
        fetchYahooQuote(symbol),
        fetchYahooQuoteSummary(symbol),
        fetchIntraday(symbol),
        fetchYahoo({
          key: `detail_${symbol}`,
          name: symbol,
          sub: symbol,
          symbol,
          asset: isCn ? "cn" : "us",
          unit: isCn ? "元" : "美元",
          decimals: 2,
          years: 5,
        }).catch(() => [] as Pt[]),
        // Profile & news ride along with the same on-demand fetch;
        // each leg degrades to empty on its own.
        isCn ? fetchCnProfile(args.code) : Promise.resolve(""),
        isCn ? Promise.resolve([] as StockNewsItem[]) : fetchYahooNews(symbol),
      ]);
      const profile = isCn ? cnProfile : (qs?.profile ?? "");
      const qn = (k: string): number | null => {
        const v = quote?.[k];
        return typeof v === "number" && Number.isFinite(v) ? v : null;
      };
      // 52-week range: the quote's own fields first, the 5y closes as
      // the fallback (last 252 trading days).
      let high52 = qn("fiftyTwoWeekHigh");
      let low52 = qn("fiftyTwoWeekLow");
      if ((high52 == null || low52 == null) && closes.length >= 30) {
        const win = closes.slice(-252).map((p) => p.value);
        if (high52 == null) high52 = Math.max(...win);
        if (low52 == null) low52 = Math.min(...win);
      }
      // Next earnings: only a genuinely upcoming timestamp counts —
      // a stale past print is not "next", so it stays blank.
      let nextEarnings = "";
      let earningsEst = false;
      const nowSec = Date.now() / 1000;
      const cand = [qn("earningsTimestampStart"), qn("earningsTimestamp"), qn("earningsTimestampEnd")]
        .filter((v): v is number => v != null && v > nowSec - 86400)
        .sort((a, b) => a - b);
      if (cand.length > 0) {
        nextEarnings = dateInTz(cand[0]!, tz);
        earningsEst = quote?.["isEarningsDateEstimate"] === true;
      }
      const divRaw = qn("dividendYield");
      const divTrail = qn("trailingAnnualDividendYield");
      // Shared PE pipeline (computePeValuation): the watchlist cards
      // and this drawer read the same numbers by construction.
      const peVal = await computePeValuation(isCn, args.code, quote, closes);
      const peTtm = peVal.peTtm;
      const detail: z.infer<typeof stockDetailZ> = {
        ok: quote != null || intra != null,
        open: qn("regularMarketOpen"),
        high: qn("regularMarketDayHigh"),
        low: qn("regularMarketDayLow"),
        volume: qn("regularMarketVolume"),
        avgVolume: qn("averageDailyVolume3Month"),
        prevClose: qn("regularMarketPreviousClose") ?? intra?.prevClose ?? null,
        postPrice: qn("postMarketPrice"),
        postPct: qn("postMarketChangePercent"),
        prePrice: qn("preMarketPrice"),
        prePct: qn("preMarketChangePercent"),
        divRateTtm: qn("trailingAnnualDividendRate"),
        divDate: (() => {
          const ts = qn("dividendDate");
          return ts != null && ts > 0 ? dateInTz(ts, tz) : "";
        })(),
        cap: qn("marketCap"),
        peTtm,
        peFwd: peVal.peFwd,
        divYieldPct: divRaw != null ? Math.round(divRaw * 100) / 100 : divTrail != null ? Math.round(divTrail * 10000) / 100 : null,
        epsTtm: qn("epsTrailingTwelveMonths"),
        beta: qs?.beta ?? null,
        ps: qs?.ps ?? null,
        pb: qs?.pb ?? qn("priceToBook"),
        roePct: qs?.roePct ?? null,
        high52,
        low52,
        nextEarnings,
        earningsEst,
        intraday: intra?.points ?? [],
        intraPrevClose: intra?.prevClose ?? null,
        peHist: peVal.peHist,
        profile,
        profileSource: profile ? (isCn ? "东方财富 F10 公司概况" : "Yahoo Finance 公司资料") : "",
        news,
      };
      return { detail };
    },
});

const getCloudPeHistAction = defineAction({
    description:
      "批量计算云图大砖/中砖上的一行估值标注：当前市盈率（Yahoo 报价 TTM PE，与个股详情面板同口径）与它在自身近 5 年各季末市盈率中的百分位（美股 SEC EDGAR、A 股东财财报 EPS 推导，与详情面板共用同一套函数）。只为当前视图里放得下这行字的砖调用；历史 EPS 不足或报价缺失的股票返回空，砖上不显示这一行、不估算。",
    request: z.object({
      market: z.enum(["us", "ndx", "dow", "rut", "cn"]),
      codes: z.array(z.string().min(1).max(12)).min(1).max(40),
    }),
    response: z.object({
      items: z.array(z.object({ code: z.string(), pe: z.number().nullable(), percentile: z.number().nullable() })),
    }),
    async handler(ctx, args): Promise<{ items: { code: string; pe: number | null; percentile: number | null }[] }> {
      void ctx;
      const isCn = args.market === "cn";
      const codes = [...new Set(args.codes)];
      const symbolOf = (code: string): string => (isCn ? `${code}.${/^[69]/.test(code) ? "SS" : "SZ"}` : code);
      const quotes = await fetchYahooQuoteBatch(codes.map(symbolOf));
      const items = await mapPool(codes, 6, async (code) => {
        const empty = { code, pe: null, percentile: null };
        try {
          const symbol = symbolOf(code);
          const q = quotes.get(symbol);
          // Same current-PE definition as getStockDetail: the quote's
          // trailing PE, falling back to price ÷ EPS TTM.
          const curPe = q?.peTtm ?? (q?.epsTtm != null && q?.price != null ? q.price / q.epsTtm : null);
          if (curPe == null || !(curPe > 0)) return empty;
          const closes = await fetchYahoo({
            key: `detail_${symbol}`,
            name: symbol,
            sub: symbol,
            symbol,
            asset: isCn ? "cn" : "us",
            unit: isCn ? "元" : "美元",
            decimals: 2,
            years: 5,
          }).catch(() => [] as Pt[]);
          if (closes.length < 60) return empty;
          const points = isCn ? await fetchCnPePoints(code, closes) : await fetchUsPePoints(code, closes);
          const hist = peHistoryStats(points, curPe);
          return hist ? { code, pe: hist.current, percentile: hist.percentile } : empty;
        } catch {
          return empty;
        }
      });
      return { items };
    },
});

export const cloudActions = {
  getCloud: getCloudAction,
  getStockDetail: getStockDetailAction,
  getCloudPeHist: getCloudPeHistAction,
};
