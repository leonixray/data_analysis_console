// 数据分析管控台 — server actions.
//
// Refresh path is pure program: fetch two public JSON APIs (Yahoo Finance
// chart API for prices, Eastmoney datacenter for CN/US treasury yields),
// store daily series in SQLite, and compute every indicator with plain
// arithmetic. No model inference anywhere in the refresh path, so a daily
// refresh costs no tokens while the upstream structures stay unchanged.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { privileged } from "@space/privileged";
import { cloudActions } from "./cloud-actions";
import { WATCHLIST } from "./watchlist";
import { and, asc, count, desc, eq, gte, inArray, lt, max, sql } from "drizzle-orm";
import * as schema from "./schema";

// ---------------------------------------------------------------------------
// Source configuration
// ---------------------------------------------------------------------------

type PriceCfg = {
  key: string;
  name: string;
  sub: string;
  symbol: string;
  asset: "us" | "cn" | "hk" | "gold" | "macro" | "ussec" | "cnsec" | "credit" | "bondetf" | "usdiv" | "uswatch" | "cnstyle";
  unit: string;
  decimals: number;
  benchmark?: string; // series key used for relative strength
  years?: number; // history window to fetch (default 10; long indices get 20 for drawdown archaeology)
};

const PRICE_SERIES: PriceCfg[] = [
  { key: "spx", name: "标普 500", sub: "S&P 500 · ^GSPC", symbol: "^GSPC", asset: "us", unit: "点", decimals: 2, years: 20 },
  { key: "ndx", name: "纳斯达克 100", sub: "Nasdaq-100 · ^NDX", symbol: "^NDX", asset: "us", unit: "点", decimals: 2, benchmark: "spx", years: 20 },
  { key: "qqq", name: "QQQ", sub: "纳指100 ETF · QQQ", symbol: "QQQ", asset: "us", unit: "美元", decimals: 2, benchmark: "spx", years: 20 },
  { key: "voo", name: "VOO", sub: "标普500 ETF · VOO", symbol: "VOO", asset: "us", unit: "美元", decimals: 2, benchmark: "spx", years: 15 },
  { key: "sse", name: "上证指数", sub: "000001 · 上海", symbol: "000001.SS", asset: "cn", unit: "点", decimals: 2, years: 20 },
  { key: "csi300", name: "沪深 300（510300）", sub: "华泰柏瑞沪深300 ETF · 510300.SS（指数代理）", symbol: "510300.SS", asset: "cn", unit: "元", decimals: 3, benchmark: "sse" },
  { key: "szcomp", name: "深证成指", sub: "399001 · 深圳", symbol: "399001.SZ", asset: "cn", unit: "点", decimals: 2, benchmark: "sse", years: 20 },
  { key: "hsi", name: "恒生指数", sub: "HSI · 香港大盘", symbol: "^HSI", asset: "hk", unit: "点", decimals: 2, years: 20 },
  { key: "hsce", name: "恒生国企指数", sub: "HSCE · H股指数（内地国企）", symbol: "^HSCE", asset: "hk", unit: "点", decimals: 2, years: 20 },
  { key: "hstech3033", name: "恒生科技（3033）", sub: "南方恒生科技 ETF · 3033.HK", symbol: "3033.HK", asset: "hk", unit: "港元", decimals: 3, benchmark: "hsi" },
  { key: "hstech3067", name: "恒生科技（3067）", sub: "安硕恒生科技 ETF · 3067.HK", symbol: "3067.HK", asset: "hk", unit: "港元", decimals: 3, benchmark: "hsi" },
  { key: "gold", name: "黄金期货", sub: "COMEX 黄金 · GC=F", symbol: "GC=F", asset: "gold", unit: "美元/盎司", decimals: 1, years: 20 },
  { key: "gld", name: "黄金 ETF（GLD）", sub: "SPDR Gold · GLD", symbol: "GLD", asset: "gold", unit: "美元", decimals: 2, benchmark: "gold", years: 20 },
  { key: "silver", name: "白银期货", sub: "COMEX 白银 · SI=F", symbol: "SI=F", asset: "gold", unit: "美元/盎司", decimals: 2, years: 20 },
  { key: "oil", name: "原油期货（WTI）", sub: "NYMEX · CL=F", symbol: "CL=F", asset: "macro", unit: "美元/桶", decimals: 2, years: 20 },
  { key: "vix", name: "VIX 恐慌指数", sub: "CBOE · ^VIX", symbol: "^VIX", asset: "macro", unit: "点", decimals: 2, years: 20 },
  { key: "vix9d", name: "VIX9D（9天恐慌）", sub: "CBOE 9 天波动率 · ^VIX9D（期限结构短端）", symbol: "^VIX9D", asset: "macro", unit: "点", decimals: 2 },
  { key: "vix3m", name: "VIX3M（3月恐慌）", sub: "CBOE 3 个月波动率 · ^VIX3M（期限结构长端）", symbol: "^VIX3M", asset: "macro", unit: "点", decimals: 2 },
  { key: "gdx", name: "金矿股 ETF（GDX）", sub: "VanEck Gold Miners · GDX（黄金股，对金价有杠杆）", symbol: "GDX", asset: "gold", unit: "美元", decimals: 2, benchmark: "gold", years: 20 },
  { key: "cs500", name: "中证 500（510500）", sub: "南方中证500 ETF · 510500.SS（中盘代理）", symbol: "510500.SS", asset: "cn", unit: "元", decimals: 3, benchmark: "sse" },
  { key: "cs1000", name: "中证 1000（512100）", sub: "南方中证1000 ETF · 512100.SS（小盘代理）", symbol: "512100.SS", asset: "cn", unit: "元", decimals: 3, benchmark: "sse" },
  { key: "dxy", name: "美元指数", sub: "DXY · ICE", symbol: "DX-Y.NYB", asset: "macro", unit: "点", decimals: 2, years: 20 },
  { key: "usdcny", name: "美元 / 人民币", sub: "USD/CNY 离岸参考", symbol: "CNY=X", asset: "macro", unit: "元", decimals: 4 },
  // --- Drill-down additions (v2) ---
  // US: long Treasuries proxy (user watchlist staple)
  { key: "tlt", name: "美债 20 年+ ETF（TLT）", sub: "iShares 20+ Year Treasury · TLT", symbol: "TLT", asset: "us", unit: "美元", decimals: 2 },
  { key: "ief", name: "美债 7-10 年 ETF（IEF）", sub: "iShares 7-10 Year Treasury · IEF（信用代理的国债腿）", symbol: "IEF", asset: "us", unit: "美元", decimals: 2 },
  { key: "hyg", name: "高收益债 ETF（HYG）", sub: "iShares iBoxx 高收益公司债 · HYG（信用风险胃口的市场代理）", symbol: "HYG", asset: "us", unit: "美元", decimals: 2 },
  // US watchlist: 自选个股行（见 server/src/watchlist.ts，改那里即可），
  // 与指数行同一条 Yahoo  pipeline、同一套卡片口径。USO 是原油 ETF，
  // 补上期货 CL=F 没有的可交易原油敞口。
  ...WATCHLIST,
  // CN broad: growth boards
  { key: "chinext", name: "创业板（159915）", sub: "易方达创业板 ETF · 159915.SZ", symbol: "159915.SZ", asset: "cn", unit: "元", decimals: 3, benchmark: "sse" },
  { key: "star50", name: "科创 50（588000）", sub: "华夏科创50 ETF · 588000.SS", symbol: "588000.SS", asset: "cn", unit: "元", decimals: 3, benchmark: "sse" },
  // CN rates-bond ETFs (tradable shadows of the yield curve)
  { key: "bond5y", name: "5 年国债 ETF（511010）", sub: "博时上证5年期国债 ETF · 511010.SS", symbol: "511010.SS", asset: "bondetf", unit: "元", decimals: 2 },
  { key: "bond10y", name: "10 年国债 ETF（511260）", sub: "国泰上证10年期国债 ETF · 511260.SS", symbol: "511260.SS", asset: "bondetf", unit: "元", decimals: 2 },
  { key: "polbond", name: "7-10 年政金债 ETF（511520）", sub: "富国中债7-10年政策性金融债 ETF · 511520.SS（国开债等政金债代理）", symbol: "511520.SS", asset: "bondetf", unit: "元", decimals: 3, benchmark: "bond10y" },
  // US dividend ETFs (v3 deep-dive: quality / high-yield / growth flavours)
  { key: "schd", name: "红利质量（SCHD）", sub: "Schwab 美国红利股票 ETF · SCHD（现金流+分红质量筛选）", symbol: "SCHD", asset: "usdiv", unit: "美元", decimals: 2, benchmark: "spx", years: 15 },
  { key: "vym", name: "高股息（VYM）", sub: "Vanguard 高股息率 ETF · VYM", symbol: "VYM", asset: "usdiv", unit: "美元", decimals: 2, benchmark: "spx", years: 15 },
  { key: "vig", name: "分红增长（VIG）", sub: "Vanguard 分红增值 ETF · VIG（连续增分红公司）", symbol: "VIG", asset: "usdiv", unit: "美元", decimals: 2, benchmark: "spx", years: 15 },
  { key: "dgro", name: "红利成长（DGRO）", sub: "iShares 核心分红增长 ETF · DGRO", symbol: "DGRO", asset: "usdiv", unit: "美元", decimals: 2, benchmark: "spx", years: 12 },
  { key: "spyd", name: "高息精选（SPYD）", sub: "SPDR 标普500高股息 ETF · SPYD（等权高息，波动大）", symbol: "SPYD", asset: "usdiv", unit: "美元", decimals: 2, benchmark: "spx", years: 10 },
  { key: "hdv", name: "高股息低波（HDV）", sub: "iShares 核心高股息 ETF · HDV", symbol: "HDV", asset: "usdiv", unit: "美元", decimals: 2, benchmark: "spx", years: 15 },
  // CN credit-bond ETFs (tradable shadows of credit risk appetite)
  { key: "chengtou", name: "城投债 ETF（511220）", sub: "海富通上证城投债 ETF · 511220.SS", symbol: "511220.SS", asset: "credit", unit: "元", decimals: 2, benchmark: "bond10y" },
  { key: "corpbond", name: "公司债 ETF（511030）", sub: "上证公司债 ETF · 511030.SS", symbol: "511030.SS", asset: "credit", unit: "元", decimals: 2, benchmark: "bond10y" },
  { key: "convbond", name: "可转债 ETF（511380）", sub: "博时可转债 ETF · 511380.SS", symbol: "511380.SS", asset: "credit", unit: "元", decimals: 2, benchmark: "bond10y" },
  // US sectors: the 11 Select Sector SPDRs
  { key: "sec_xlk", name: "科技（XLK）", sub: "Technology Select Sector SPDR", symbol: "XLK", asset: "ussec", unit: "美元", decimals: 2, benchmark: "spx" },
  { key: "sec_xlc", name: "通信服务（XLC）", sub: "Communication Services Select Sector SPDR", symbol: "XLC", asset: "ussec", unit: "美元", decimals: 2, benchmark: "spx" },
  { key: "sec_xly", name: "可选消费（XLY）", sub: "Consumer Discretionary Select Sector SPDR", symbol: "XLY", asset: "ussec", unit: "美元", decimals: 2, benchmark: "spx" },
  { key: "sec_xlp", name: "必需消费（XLP）", sub: "Consumer Staples Select Sector SPDR", symbol: "XLP", asset: "ussec", unit: "美元", decimals: 2, benchmark: "spx" },
  { key: "sec_xlf", name: "金融（XLF）", sub: "Financial Select Sector SPDR", symbol: "XLF", asset: "ussec", unit: "美元", decimals: 2, benchmark: "spx" },
  { key: "sec_xlv", name: "医疗健康（XLV）", sub: "Health Care Select Sector SPDR", symbol: "XLV", asset: "ussec", unit: "美元", decimals: 2, benchmark: "spx" },
  { key: "sec_xli", name: "工业（XLI）", sub: "Industrial Select Sector SPDR", symbol: "XLI", asset: "ussec", unit: "美元", decimals: 2, benchmark: "spx" },
  { key: "sec_xle", name: "能源（XLE）", sub: "Energy Select Sector SPDR", symbol: "XLE", asset: "ussec", unit: "美元", decimals: 2, benchmark: "spx" },
  { key: "sec_xlb", name: "原材料（XLB）", sub: "Materials Select Sector SPDR", symbol: "XLB", asset: "ussec", unit: "美元", decimals: 2, benchmark: "spx" },
  { key: "sec_xlu", name: "公用事业（XLU）", sub: "Utilities Select Sector SPDR", symbol: "XLU", asset: "ussec", unit: "美元", decimals: 2, benchmark: "spx" },
  { key: "sec_xlre", name: "房地产（XLRE）", sub: "Real Estate Select Sector SPDR", symbol: "XLRE", asset: "ussec", unit: "美元", decimals: 2, benchmark: "spx" },
  // A-share sectors (listed ETFs as sector shadows)
  { key: "sec_divlow", name: "红利低波（512890）", sub: "华泰柏瑞红利低波 ETF · 512890.SS", symbol: "512890.SS", asset: "cnsec", unit: "元", decimals: 3, benchmark: "csi300" },
  { key: "sec_div", name: "红利（510880）", sub: "华泰柏瑞上证红利 ETF · 510880.SS", symbol: "510880.SS", asset: "cnsec", unit: "元", decimals: 3, benchmark: "csi300" },
  { key: "sec_cons", name: "消费（159928）", sub: "汇添富中证主要消费 ETF · 159928.SZ", symbol: "159928.SZ", asset: "cnsec", unit: "元", decimals: 3, benchmark: "csi300" },
  { key: "sec_med", name: "医药·沪深300（512010）", sub: "易方达沪深300医药 ETF · 512010.SS", symbol: "512010.SS", asset: "cnsec", unit: "元", decimals: 3, benchmark: "csi300" },
  { key: "sec_bank", name: "银行（512800）", sub: "华宝中证银行 ETF · 512800.SS", symbol: "512800.SS", asset: "cnsec", unit: "元", decimals: 3, benchmark: "csi300" },
  { key: "sec_broker", name: "证券（512880）", sub: "国泰中证全指证券公司 ETF · 512880.SS", symbol: "512880.SS", asset: "cnsec", unit: "元", decimals: 3, benchmark: "csi300" },
  { key: "sec_power", name: "电力（159611）", sub: "广发中证全指电力 ETF · 159611.SZ", symbol: "159611.SZ", asset: "cnsec", unit: "元", decimals: 3, benchmark: "csi300" },
  { key: "sec_semi", name: "半导体（512480）", sub: "国联安中证半导体 ETF · 512480.SS", symbol: "512480.SS", asset: "cnsec", unit: "元", decimals: 3, benchmark: "csi300" },
  { key: "sec_pv", name: "光伏（515790）", sub: "华泰柏瑞中证光伏产业 ETF · 515790.SS", symbol: "515790.SS", asset: "cnsec", unit: "元", decimals: 3, benchmark: "csi300" },
  { key: "sec_game", name: "游戏（159869）", sub: "华夏中证动漫游戏 ETF · 159869.SZ", symbol: "159869.SZ", asset: "cnsec", unit: "元", decimals: 3, benchmark: "csi300" },
  // A-share style-factor legs (A-P2-2): fetched and stored exactly like
  // every other price series (same Yahoo chart pipeline, same prices
  // stage, same manual refresh), but rendered nowhere as instrument
  // cards — they exist so the style-factor area can pair each factor
  // leg against its same-universe broad benchmark. All four symbols
  // probe-verified on Yahoo 2026-11-19 (chart API HTTP 200 with full
  // daily history): 159967 = 华夏创业板动量成长 ETF (ChinaAMC ChiNext
  // Momentum Growth, listed 2019-06), 512260 = 华安中证500行业中性低
  // 波动 ETF (listed 2018-11), 562320 = 银华沪深300价值 ETF and
  // 159656 = 万家沪深300成长 ETF (both listed 2022-12, so the
  // value/growth pair's relative-strength history starts 2023-01 —
  // its percentile sample is younger than the older pairs' and the
  // card's sample count says so).
  { key: "momgrowth", name: "创业板动量成长（159967）", sub: "华夏创业板动量成长 ETF · 159967.SZ（风格因子腿）", symbol: "159967.SZ", asset: "cnstyle", unit: "元", decimals: 3, benchmark: "chinext" },
  { key: "lowvol500", name: "中证500低波（512260）", sub: "华安中证500行业中性低波动 ETF · 512260.SS（风格因子腿）", symbol: "512260.SS", asset: "cnstyle", unit: "元", decimals: 3, benchmark: "cs500" },
  { key: "csi300value", name: "沪深300价值（562320）", sub: "银华沪深300价值 ETF · 562320.SS（风格因子腿）", symbol: "562320.SS", asset: "cnstyle", unit: "元", decimals: 3, benchmark: "csi300" },
  { key: "csi300growth", name: "沪深300成长（159656）", sub: "万家沪深300成长 ETF · 159656.SZ（风格因子腿）", symbol: "159656.SZ", asset: "cnstyle", unit: "元", decimals: 3, benchmark: "csi300" },
];

// ---------------------------------------------------------------------------
// Cloud map （云图） v10 — FULL index universes, rebuilt to mirror the
// reference heatmap app （美股编年史）:
//   US = S&P 500 constituents parsed from Wikipedia's list (GICS sector +
//   sub-industry columns), market caps from Yahoo's quote API (cookie +
//   crumb handshake, 100 symbols per call) — tile area is real market cap
//   and weight_pct is the cap share of the fetched universe (≈ index
//   weight). Sub-industries are grouped into Chinese industry buckets
//   (semiconductors + semi equipment merge into 半导体， as in the
//   reference); tickers without a common Chinese name fall back to the
//   English security name from the same table.
//   CN = CSI 300 constituents + official index weights from China
//   Securities Index Co. files (000300cons.xls / 000300closeweight.xls,
//   BIFF8 — parsed with the in-process reader further below; weight
//   column verified to sum to 99.99), industries from Sina Finance's
//   industry classification (node dictionary transcribed from the live
//   newSinaHy.php list on 2026-11-19; membership via its JSON node API).
// Per-stock stats come from the same Yahoo chart API as the rest of the
// console: 1.1y of daily closes → 1d/1w/1m/3m/6m/YTD/1y returns, distance
// to MA50/MA200, distance below the 52-week high — stored as one snapshot
// row per stock in cloud_stocks (no raw history kept). Every leg degrades
// independently: no market caps → tiles sized by 63d average turnover; no
// Sina industries → CN stocks group under 综合； a market whose fetch
// fails keeps its previous snapshot instead of being wiped.
// v27 (U-P2-5): two more selector indices. DOW = Dow Jones Industrial
// Average, all 30 constituents from Wikipedia's list page (GICS sector
// column; industry buckets shared with the S&P map), same cap-weighted
// treatment as us/ndx. RUT = Russell 2000 TOP 200 holdings by published
// weight from BlackRock's IWM holdings file — explicitly NOT the full
// ~2,000-name index, labelled 前 200 大成分 · 非全量 wherever it appears;
// the file is bot-walled from this network today, so the rut stage
// fails honestly and the selector shows 待成分源 until a source lands
// (see fetchIwmTopMembers). Both new indices store their official
// index closes (^DJI / ^RUT) in series_points from their cloud stages
// so the selector keeps the official-first day-move rule.
// ---------------------------------------------------------------------------

const GICS_SECTOR_CN: Record<string, string> = {
  "Information Technology": "科技",
  "Health Care": "医疗保健",
  Financials: "金融",
  "Consumer Discretionary": "周期消费",
  "Communication Services": "通信服务",
  Industrials: "工业",
  "Consumer Staples": "防御性消费",
  Energy: "能源",
  Utilities: "公用事业",
  "Real Estate": "房地产",
  Materials: "原材料",
};

// GICS sub-industry → Chinese industry bucket (all 126 sub-industries in
// the current Wikipedia table are covered; unknown ones fall back to the
// English sub-industry name).
const GICS_SUB_CN: Record<string, string> = {
  Semiconductors: "半导体",
  "Semiconductor Materials & Equipment": "半导体",
  "Application Software": "应用软件",
  "Systems Software": "基础软件",
  "Consumer Electronics": "消费电子",
  "Technology Hardware, Storage & Peripherals": "硬件",
  "Electronic Equipment & Instruments": "硬件与设备",
  "Electronic Components": "硬件与设备",
  "Electronic Manufacturing Services": "硬件与设备",
  "Technology Distributors": "硬件与设备",
  "Communications Equipment": "通信设备",
  "IT Consulting & Other Services": "IT 服务",
  "Internet Services & Infrastructure": "互联网服务",
  "Data Processing & Outsourced Services": "数据处理",
  "Health Care Equipment": "医疗设备",
  "Health Care Supplies": "医疗设备",
  "Life Sciences Tools & Services": "生命科学",
  Biotechnology: "生物科技",
  Pharmaceuticals: "制药",
  "Health Care Services": "医疗服务",
  "Health Care Distributors": "医疗服务",
  "Health Care Facilities": "医疗服务",
  "Managed Health Care": "健康保险",
  "Health Care Technology": "医疗科技",
  "Asset Management & Custody Banks": "资产管理",
  "Transaction & Payment Processing Services": "支付",
  "Financial Exchanges & Data": "交易所与数据",
  "Property & Casualty Insurance": "财产保险",
  "Life & Health Insurance": "寿险健康险",
  "Multi-line Insurance": "综合保险",
  Reinsurance: "再保险",
  "Insurance Brokers": "保险经纪",
  "Diversified Banks": "大型银行",
  "Regional Banks": "区域银行",
  "Investment Banking & Brokerage": "投行券商",
  "Consumer Finance": "消费金融",
  "Multi-Sector Holdings": "多元金融",
  "Interactive Media & Services": "互联网传媒",
  "Movies & Entertainment": "影视娱乐",
  Broadcasting: "广播电视",
  "Cable & Satellite": "有线电视",
  Publishing: "出版",
  Advertising: "广告",
  "Integrated Telecommunication Services": "电信运营",
  "Wireless Telecommunication Services": "电信运营",
  "Interactive Home Entertainment": "游戏",
  "Industrial Machinery & Supplies & Components": "工业机械",
  "Aerospace & Defense": "航空国防",
  "Building Products": "建筑产品",
  "Air Freight & Logistics": "物流",
  "Construction Machinery & Heavy Transportation Equipment": "工程机械",
  "Agricultural & Farm Machinery": "工程机械",
  "Construction & Engineering": "建筑工程",
  "Electrical Components & Equipment": "电气设备",
  "Heavy Electrical Equipment": "电气设备",
  "Environmental & Facilities Services": "环保与设施服务",
  "Industrial Conglomerates": "综合工业",
  "Rail Transportation": "铁路运输",
  "Cargo Ground Transportation": "公路货运",
  "Passenger Ground Transportation": "公路客运",
  "Passenger Airlines": "航空客运",
  "Trading Companies & Distributors": "贸易分销",
  Distributors: "贸易分销",
  "Diversified Support Services": "综合服务",
  "Human Resource & Employment Services": "人力资源",
  "Research & Consulting Services": "咨询服务",
  "Hotels, Resorts & Cruise Lines": "酒店邮轮",
  Restaurants: "餐饮",
  Homebuilding: "住宅建筑",
  "Apparel, Accessories & Luxury Goods": "服装奢侈品",
  "Apparel Retail": "服装零售",
  Footwear: "鞋类",
  "Automotive Retail": "汽车零售",
  "Automobile Manufacturers": "汽车制造",
  "Automotive Parts & Equipment": "汽车零部件",
  "Broadline Retail": "综合零售",
  "Other Specialty Retail": "专业零售",
  "Home Improvement Retail": "家装零售",
  "Homefurnishing Retail": "家居零售",
  "Computer & Electronics Retail": "电子零售",
  "Casinos & Gaming": "博彩",
  "Leisure Products": "休闲用品",
  "Specialized Consumer Services": "消费服务",
  "Packaged Foods & Meats": "包装食品",
  "Consumer Staples Merchandise Retail": "日用零售",
  "Household Products": "家居用品",
  "Personal Care Products": "个人护理",
  "Soft Drinks & Non-alcoholic Beverages": "饮料",
  "Distillers & Vintners": "烈酒葡萄酒",
  "Food Retail": "食品零售",
  "Food Distributors": "食品分销",
  Tobacco: "烟草",
  "Agricultural Products & Services": "农产品",
  "Oil & Gas Exploration & Production": "油气勘探",
  "Oil & Gas Storage & Transportation": "油气储运",
  "Oil & Gas Equipment & Services": "油服设备",
  "Oil & Gas Refining & Marketing": "炼油销售",
  "Integrated Oil & Gas": "综合油气",
  "Electric Utilities": "电力",
  "Multi-Utilities": "综合公用",
  "Independent Power Producers & Energy Traders": "独立电力",
  "Water Utilities": "水务",
  "Gas Utilities": "燃气",
  "Multi-Family Residential REITs": "住宅 REITs",
  "Single-Family Residential REITs": "住宅 REITs",
  "Retail REITs": "零售 REITs",
  "Office REITs": "办公 REITs",
  "Industrial REITs": "工业 REITs",
  "Hotel & Resort REITs": "酒店 REITs",
  "Health Care REITs": "医疗 REITs",
  "Data Center REITs": "数据中心 REITs",
  "Telecom Tower REITs": "铁塔 REITs",
  "Self-Storage REITs": "仓储 REITs",
  "Timber REITs": "林业 REITs",
  "Other Specialized REITs": "其他 REITs",
  "Real Estate Services": "地产服务",
  "Specialty Chemicals": "特种化工",
  "Commodity Chemicals": "大宗化工",
  "Fertilizers & Agricultural Chemicals": "化肥农化",
  "Paper & Plastic Packaging Products & Materials": "包装材料",
  "Metal, Glass & Plastic Containers": "包装材料",
  "Construction Materials": "建材",
  "Industrial Gases": "工业气体",
  Steel: "钢铁",
  Copper: "铜",
  Gold: "黄金矿业",
};

// Common Chinese names for the S&P 500 names a reader is most likely to
// meet on a big tile; anything not listed shows its English security name.
export const US_ZH_NAMES: Record<string, string> = {
  AAPL: "苹果", MSFT: "微软", NVDA: "英伟达", AVGO: "博通", ORCL: "甲骨文",
  GOOGL: "谷歌 A", GOOG: "谷歌 C", META: "Meta", NFLX: "奈飞", DIS: "迪士尼",
  T: "AT&T", AMZN: "亚马逊", TSLA: "特斯拉", HD: "家得宝", MCD: "麦当劳",
  NKE: "耐克", WMT: "沃尔玛", COST: "好市多", PG: "宝洁", KO: "可口可乐",
  PEP: "百事", JPM: "摩根大通", "BRK-B": "伯克希尔 B", V: "维萨", MA: "万事达",
  BAC: "美国银行", LLY: "礼来", UNH: "联合健康", JNJ: "强生", ABBV: "艾伯维",
  MRK: "默沙东", CAT: "卡特彼勒", GE: "通用电气", HON: "霍尼韦尔", UNP: "联合太平洋",
  RTX: "雷神技术", XOM: "埃克森美孚", CVX: "雪佛龙", COP: "康菲石油", SLB: "斯伦贝谢",
  EOG: "EOG 能源", LIN: "林德", SHW: "宣伟", FCX: "自由港", NEM: "纽蒙特",
  DOW: "陶氏", NEE: "新纪元能源", SO: "南方公司", DUK: "杜克能源", AEP: "美国电力",
  SRE: "森普拉", PLD: "安博", AMT: "美国电塔", SPG: "西蒙地产",
  AMD: "AMD", INTC: "英特尔", CSCO: "思科", QCOM: "高通", TXN: "德州仪器",
  AMAT: "应用材料", LRCX: "拉姆研究", KLAC: "科磊", MRVL: "美满电子", MU: "美光科技",
  ADI: "亚德诺", PANW: "派拓网络", CRWD: "CrowdStrike", NOW: "ServiceNow", CRM: "赛富时",
  ADBE: "奥多比", INTU: "财捷", AMGN: "安进", GILD: "吉利德", PFE: "辉瑞",
  BMY: "百时美施贵宝", TMO: "赛默飞", DHR: "丹纳赫", SYK: "史赛克", BSX: "波士顿科学",
  MDT: "美敦力", ISRG: "直觉外科", VRTX: "福泰制药", REGN: "再生元", ABT: "雅培",
  WFC: "富国银行", GS: "高盛", MS: "摩根士丹利", C: "花旗", BLK: "贝莱德",
  SCHW: "嘉信理财", AXP: "美国运通", BK: "纽约梅隆", USB: "合众银行", COF: "第一资本",
  BX: "黑石", KKR: "KKR", AIG: "美国国际集团", MET: "大都会人寿", PRU: "保德信",
  SBUX: "星巴克", BKNG: "缤客", MAR: "万豪", HLT: "希尔顿", LOW: "劳氏",
  LULU: "露露乐蒙", CMG: "Chipotle", YUM: "百胜", ABNB: "爱彼迎", UBER: "优步",
  F: "福特", GM: "通用汽车", AAL: "美国航空", DAL: "达美航空", UAL: "联合航空",
  LUV: "西南航空", BA: "波音", LMT: "洛克希德·马丁", NOC: "诺斯洛普·格鲁曼", GD: "通用动力",
  UPS: "联合包裹", FDX: "联邦快递", DE: "迪尔公司", EMR: "艾默生", ETN: "伊顿",
  MMM: "3M", WM: "废物管理", VZ: "威瑞森", CMCSA: "康卡斯特", TMUS: "T-Mobile",
  WBD: "华纳兄弟探索", PM: "菲利普莫里斯", MO: "奥驰亚", CL: "高露洁", EL: "雅诗兰黛",
  KMB: "金佰利", GIS: "通用磨坊", KHC: "卡夫亨氏", KR: "克罗格", DG: "美元通用",
  DLTR: "美元树", ORLY: "奥莱利", NUE: "纽柯钢铁", DD: "杜邦", ECL: "艺康",
  APD: "空气产品", VLO: "瓦莱罗", MPC: "马拉松石油", OXY: "西方石油", HAL: "哈里伯顿",
  BKR: "贝克休斯", KMI: "金德摩根", WMB: "威廉姆斯", CEG: "星座能源", EXC: "爱克斯龙",
  ED: "联合爱迪生", AWK: "美国水务", PSA: "公共存储", DLR: "Digital Realty", CCI: "冠城国际",
  PLTR: "Palantir", APP: "AppLovin", HOOD: "Robinhood", COIN: "Coinbase", MSTR: "MicroStrategy",
  SMCI: "超微电脑", DELL: "戴尔", HPE: "慧与", ANET: "Arista", WDC: "西部数据",
  STX: "希捷", NTAP: "NetApp", CDNS: "Cadence", SNPS: "新思科技", FTNT: "飞塔",
  DDOG: "Datadog", TEAM: "Atlassian", WDAY: "Workday", ADSK: "欧特克", MELI: "MercadoLibre",
  // Nasdaq-100 names not in the S&P 500 (plus a few S&P names the
  // reference app shows in Chinese): added with the NDX cloud (v15).
  ASML: "阿斯麦", AZN: "阿斯利康", ARM: "Arm", PDD: "拼多多", BIDU: "百度",
  NTES: "网易", JD: "京东", BILI: "哔哩哔哩", LI: "理想汽车", XPEV: "小鹏汽车",
  NIO: "蔚来", TCOM: "携程", ACN: "埃森哲", CB: "安达保险", PGR: "前进保险",
  GEV: "GE Vernova", NXPI: "恩智浦", MCHP: "微芯科技", ON: "安森美", CTSH: "高知特",
  GFS: "格芯", IDXX: "爱德士", BIIB: "渤健", ILMN: "因美纳", MRNA: "莫德纳",
  MDLZ: "亿滋", MNST: "怪物饮料", ROST: "罗斯百货", CTAS: "信达思", EA: "艺电",
  TTWO: "Take-Two", CHTR: "特许通信", XEL: "Xcel 能源", PCAR: "帕卡",
  // Dow Jones names not already covered above (v27; MMM already listed).
  IBM: "IBM", TRV: "旅行者保险",
};

// Sina Finance industry nodes (newSinaHy.php, fetched 2026-11-19) mapped
// to a coarse sector for the two-level drill-down. new_stock （次新股） is
// a listing-age board, not an industry, and is skipped.
const SINA_INDUSTRIES: Record<string, { name: string; sector: string }> = {
  new_blhy: { name: "玻璃", sector: "原材料" },
  new_cbzz: { name: "船舶制造", sector: "工业" },
  new_cmyl: { name: "传媒娱乐", sector: "通信服务" },
  new_dlhy: { name: "电力", sector: "公用事业" },
  new_dqhy: { name: "电器", sector: "工业" },
  new_dzqj: { name: "电子器件", sector: "科技" },
  new_dzxx: { name: "电子信息", sector: "科技" },
  new_fdc: { name: "房地产", sector: "房地产" },
  new_fdsb: { name: "发电设备", sector: "工业" },
  new_fjzz: { name: "飞机制造", sector: "工业" },
  new_fzhy: { name: "纺织", sector: "可选消费" },
  new_fzjx: { name: "纺织机械", sector: "工业" },
  new_fzxl: { name: "服装鞋类", sector: "可选消费" },
  new_glql: { name: "公路桥梁", sector: "工业" },
  new_gsgq: { name: "供水供气", sector: "公用事业" },
  new_gthy: { name: "钢铁", sector: "原材料" },
  new_hbhy: { name: "环保", sector: "工业" },
  new_hghy: { name: "化工", sector: "原材料" },
  new_hqhy: { name: "化纤", sector: "原材料" },
  new_jdhy: { name: "家电", sector: "可选消费" },
  new_jdly: { name: "酒店旅游", sector: "可选消费" },
  new_jjhy: { name: "家具", sector: "可选消费" },
  new_jrhy: { name: "金融", sector: "金融" },
  new_jtys: { name: "交通运输", sector: "工业" },
  new_jxhy: { name: "机械", sector: "工业" },
  new_jzjc: { name: "建筑建材", sector: "工业" },
  new_kfq: { name: "开发区", sector: "房地产" },
  new_ljhy: { name: "酿酒", sector: "必需消费" },
  new_mtc: { name: "摩托车", sector: "可选消费" },
  new_mthy: { name: "煤炭", sector: "能源" },
  new_nlmy: { name: "农林牧渔", sector: "必需消费" },
  new_nyhf: { name: "农药化肥", sector: "原材料" },
  new_qczz: { name: "汽车制造", sector: "可选消费" },
  new_qtxy: { name: "其它", sector: "综合" },
  new_slzp: { name: "塑料制品", sector: "原材料" },
  new_snhy: { name: "水泥", sector: "原材料" },
  new_sphy: { name: "食品", sector: "必需消费" },
  new_swzz: { name: "生物制药", sector: "医药" },
  new_sybh: { name: "商业百货", sector: "可选消费" },
  new_syhy: { name: "石油", sector: "能源" },
  new_tchy: { name: "陶瓷", sector: "原材料" },
  new_wzwm: { name: "物资外贸", sector: "工业" },
  new_ylqx: { name: "医疗器械", sector: "医药" },
  new_yqyb: { name: "仪器仪表", sector: "工业" },
  new_ysbz: { name: "印刷包装", sector: "原材料" },
  new_ysjs: { name: "有色金属", sector: "原材料" },
  new_zhhy: { name: "综合", sector: "综合" },
  new_zzhy: { name: "造纸", sector: "原材料" },
};

type CloudUniverseRow = {
  market: "us" | "ndx" | "dow" | "rut" | "cn";
  code: string;
  name: string;
  sector: string;
  industry: string;
  weightPct: number;
  capValue: number | null; // absolute market cap (USD / CNY); null when the cap leg failed
  price: number;
  date: string;
  d1: number;
  w1: number | null;
  m1: number | null;
  m3: number | null;
  m6: number | null;
  ytd: number | null;
  y1: number | null;
  ma50Diff: number | null;
  ma200Diff: number | null;
  fromHigh: number;
  prePct: number | null; // premarket change % at snapshot time (US only)
  sizeBasis: "cap" | "weight" | "turnover";
};

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Run `fn` over `items` with a bounded number of concurrent workers. */
export async function mapPool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length) as R[];
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

type CloudStats = {
  price: number;
  date: string;
  d1: number;
  w1: number | null;
  m1: number | null;
  m3: number | null;
  m6: number | null;
  ytd: number | null;
  y1: number | null;
  ma50Diff: number | null;
  ma200Diff: number | null;
  fromHigh: number;
  turnover63: number;
};

/** Period stats for the cloud map from one stock's daily closes.
 *  The minimum is TWO points (enough for an honest 1-day return): a
 *  hard 30-point floor used to drop newly listed / re-listed members
 *  from the snapshot entirely — SNDK (in both the S&P 500 and the
 *  Nasdaq-100) vanished from both maps because Yahoo's chart for it
 *  currently serves only its two latest daily bars, so both maps ran
 *  one constituent short (502/503 and 100/101) and their
 *  constituent-weighted day averages silently excluded it. Period
 *  returns whose lookback base does not exist stay null (the tile and
 *  popup already render nulls as absent), MA distances stay null
 *  below their windows, and the y1 "since first point" fallback only
 *  applies once there is a real history (≥30 points) to speak of. */
function cloudStatsFromPts(pts: Pt[]): CloudStats | null {
  if (pts.length < 2) return null;
  const closes = pts.map((p) => p.value);
  const n = closes.length;
  const last = closes[n - 1] ?? 0;
  if (!(last > 0)) return null;
  const ret = (back: number): number | null => {
    const base = closes[n - 1 - back];
    return base != null && base > 0 ? round2((last / base - 1) * 100) : null;
  };
  const lastDate = pts[n - 1]?.date ?? "";
  const yr = lastDate.slice(0, 4);
  let ytdBase: number | null = null;
  for (let i = n - 1; i >= 0; i--) {
    if ((pts[i]?.date ?? "").slice(0, 4) < yr) {
      ytdBase = closes[i] ?? null;
      break;
    }
  }
  const ma = (k: number): number | null => {
    if (n < k) return null;
    let s = 0;
    for (let i = n - k; i < n; i++) s += closes[i] ?? 0;
    return s / k;
  };
  const ma50 = ma(50);
  const ma200 = ma(200);
  const win = closes.slice(-252);
  const hi = Math.max(...win);
  let tv = 0;
  let tvn = 0;
  for (const p of pts.slice(-63)) {
    if (p.volume != null && p.volume > 0) {
      tv += p.value * p.volume;
      tvn++;
    }
  }
  return {
    price: last,
    date: lastDate,
    d1: ret(1) ?? 0,
    w1: ret(5),
    m1: ret(21),
    m3: ret(63),
    m6: ret(126),
    ytd: ytdBase != null && ytdBase > 0 ? round2((last / ytdBase - 1) * 100) : null,
    y1: ret(252) ?? (n >= 30 ? ret(n - 1) : null),
    ma50Diff: ma50 != null && ma50 > 0 ? round2((last / ma50 - 1) * 100) : null,
    ma200Diff: ma200 != null && ma200 > 0 ? round2((last / ma200 - 1) * 100) : null,
    fromHigh: hi > 0 ? round2((last / hi - 1) * 100) : 0,
    turnover63: tvn > 0 ? tv / tvn : 0,
  };
}

/** Race a promise against a chunk-level timeout. The cloud refresh works
 *  in chunks of ~60 stocks precisely so one slow chunk times out on its
 *  own (its stocks keep their previous snapshot rows) instead of the
 *  whole ~800-stock round dying on one global budget. */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时（${Math.round(ms / 1000)} 秒）`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One cloud stock's chart → period stats, with one retry. A stock that
 *  fails both attempts returns null and simply keeps its previous
 *  snapshot row — it never fails its chunk, let alone the whole map. */
async function fetchCloudStats(cfg: PriceCfg): Promise<CloudStats | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const pts = await fetchYahoo(cfg);
      const st = cloudStatsFromPts(pts);
      if (st) return st;
    } catch {
      // fall through to the single retry
    }
  }
  return null;
}

/** S&P 500 constituents from Wikipedia's list page (GICS columns). */
async function fetchSpxMembers(): Promise<{ symbol: string; nameEn: string; sector: string; industry: string }[]> {
  const res = await fetch("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies", {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Wikipedia 成分表 HTTP ${res.status}`);
  const html = await res.text();
  const anchor = html.indexOf("GICS Sub-Industry");
  if (anchor < 0) throw new Error("Wikipedia 成分表结构变化（未找到 GICS 列）");
  const tab = html.slice(html.lastIndexOf("<table", anchor), html.indexOf("</table>", anchor));
  const clean = (s: string): string =>
    s
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&#39;|&rsquo;/g, "'")
      .replace(/&quot;/g, '"')
      .trim();
  const members: { symbol: string; nameEn: string; sector: string; industry: string }[] = [];
  for (const rowMatch of tab.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...(rowMatch[1] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => clean(m[1] ?? ""));
    if (cells.length < 4) continue;
    const symbol = cells[0] ?? "";
    const nameEn = cells[1] ?? "";
    const gicsSector = cells[2] ?? "";
    const gicsSub = cells[3] ?? "";
    if (!/^[A-Z][A-Z0-9.\-]*$/.test(symbol)) continue;
    members.push({
      symbol: symbol.replace(/\./g, "-"),
      nameEn,
      sector: GICS_SECTOR_CN[gicsSector] ?? gicsSector,
      industry: GICS_SUB_CN[gicsSub] ?? gicsSub,
    });
  }
  if (members.length < 400) throw new Error(`Wikipedia 成分仅解析到 ${members.length} 只`);
  return members;
}

// Nasdaq-100 list page classifies by ICB (not GICS): industry → the same
// Chinese sector names the S&P map uses. The industry bucket prefers the
// S&P 500 member map when the stock is in both indices (keeps the two US
// maps consistent); ICB subsector is only the fallback for NDX-only names.
const ICB_SECTOR_CN: Record<string, string> = {
  Technology: "科技",
  "Health Care": "医疗保健",
  "Consumer Discretionary": "周期消费",
  "Consumer Staples": "防御性消费",
  Industrials: "工业",
  Energy: "能源",
  Utilities: "公用事业",
  Telecommunications: "通信服务",
  "Basic Materials": "原材料",
  Financials: "金融",
  "Real Estate": "房地产",
};

const ICB_SUB_CN: Record<string, string> = {
  Semiconductors: "半导体",
  Software: "软件",
  "Computer Software": "软件",
  "Computer Services": "IT 服务",
  "Computer Hardware": "硬件",
  "Computer Peripheral Equipment": "硬件与设备",
  "Electronic Components": "硬件与设备",
  "Communication Equipment": "通信设备",
  Biotechnology: "生物科技",
  Pharmaceuticals: "制药",
  Automobiles: "汽车制造",
  "Motor Vehicles": "汽车制造",
  Restaurants: "餐饮",
  Retail: "综合零售",
  "Packaged Foods": "包装食品",
  "Soft Drinks": "饮料",
  Aerospace: "航空国防",
  "Electric Utilities": "电力",
  "Conventional Electricity": "电力",
  "Power Generation": "电力",
  "Telecommunications Services": "电信运营",
  "Oil & Gas Production": "油气勘探",
  "Oil Equipment & Services": "油服设备",
};

/** Nasdaq-100 constituents from Wikipedia's list page (ICB columns). */
async function fetchNdxMembers(): Promise<{ symbol: string; nameEn: string; sector: string; industry: string }[]> {
  const res = await fetch("https://en.wikipedia.org/wiki/List_of_NASDAQ-100_companies", {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Wikipedia 纳指成分表 HTTP ${res.status}`);
  const html = await res.text();
  const anchor = html.indexOf('id="constituents"');
  if (anchor < 0) throw new Error("Wikipedia 纳指成分表结构变化（未找到 constituents 表）");
  const tab = html.slice(html.lastIndexOf("<table", anchor), html.indexOf("</table>", anchor));
  const clean = (s: string): string =>
    s
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&#39;|&rsquo;/g, "'")
      .replace(/&quot;/g, '"')
      .trim();
  // Sector/industry consistency with the S&P map for dual-listed names.
  let spxMap = new Map<string, { sector: string; industry: string }>();
  try {
    const spx = await fetchSpxMembers();
    spxMap = new Map(spx.map((m) => [m.symbol, { sector: m.sector, industry: m.industry }]));
  } catch {
    // ICB fallback below covers every row on its own.
  }
  const members: { symbol: string; nameEn: string; sector: string; industry: string }[] = [];
  for (const rowMatch of tab.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...(rowMatch[1] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => clean(m[1] ?? ""));
    if (cells.length < 5) continue;
    const symbol = cells[0] ?? "";
    const nameEn = cells[1] ?? "";
    const icbIndustry = cells[3] ?? "";
    const icbSub = cells[4] ?? "";
    if (!/^[A-Z][A-Z0-9.\-]*$/.test(symbol)) continue;
    const sym = symbol.replace(/\./g, "-");
    const spx = spxMap.get(sym);
    members.push({
      symbol: sym,
      nameEn,
      sector: spx?.sector ?? ICB_SECTOR_CN[icbIndustry] ?? icbIndustry,
      industry: spx?.industry ?? ICB_SUB_CN[icbSub] ?? icbSub,
    });
  }
  if (members.length < 80) throw new Error(`Wikipedia 纳指成分仅解析到 ${members.length} 只`);
  return members;
}

/** Dow Jones Industrial Average constituents from Wikipedia's list page
 *  (v27, U-P2-5). The table carries Company / Exchange / Symbol / ISIN /
 *  Sector (GICS sector names, no sub-industry column), so the industry
 *  bucket prefers the S&P 500 member map — every Dow name is also an
 *  S&P 500 constituent — exactly like the NDX map keeps dual-listed
 *  names consistent; a name missing from the S&P map keeps its GICS
 *  sector with an empty industry (the drill groups it under 其他）
 *  rather than an invented bucket. Shell-verified 2026-11-19: the list
 *  page's wikitable parses to exactly 30 rows. */
async function fetchDowMembers(): Promise<{ symbol: string; nameEn: string; sector: string; industry: string }[]> {
  const res = await fetch("https://en.wikipedia.org/wiki/List_of_Dow_Jones_Industrial_Average_companies", {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Wikipedia 道指成分表 HTTP ${res.status}`);
  const html = await res.text();
  const anchor = html.indexOf("Date added");
  if (anchor < 0) throw new Error("Wikipedia 道指成分表结构变化（未找到 Date added 列）");
  const tab = html.slice(html.lastIndexOf("<table", anchor), html.indexOf("</table>", anchor));
  const clean = (s: string): string =>
    s
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&#39;|&rsquo;/g, "'")
      .replace(/&quot;/g, '"')
      .trim();
  let spxMap = new Map<string, { sector: string; industry: string }>();
  try {
    const spx = await fetchSpxMembers();
    spxMap = new Map(spx.map((m) => [m.symbol, { sector: m.sector, industry: m.industry }]));
  } catch {
    // Sector from the Dow table itself still covers every row.
  }
  const members: { symbol: string; nameEn: string; sector: string; industry: string }[] = [];
  for (const rowMatch of tab.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...(rowMatch[1] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => clean(m[1] ?? ""));
    if (cells.length < 5) continue;
    const nameEn = (cells[0] ?? "").replace(/\s*\((?:Class [A-Z]|Class [A-Z] shares)\)\s*$/, "").trim();
    const symbol = cells[2] ?? "";
    const gicsSector = cells[4] ?? "";
    if (!/^[A-Z][A-Z0-9.\-]*$/.test(symbol)) continue;
    const sym = symbol.replace(/\./g, "-");
    const spx = spxMap.get(sym);
    members.push({
      symbol: sym,
      nameEn,
      sector: spx?.sector ?? GICS_SECTOR_CN[gicsSector] ?? gicsSector,
      industry: spx?.industry ?? "",
    });
  }
  if (members.length < 25) throw new Error(`Wikipedia 道指成分仅解析到 ${members.length} 只`);
  return members;
}

// ---------------------------------------------------------------------------
// Russell 2000 (v27, U-P2-5): the index has ~2,000 constituents and
// FTSE Russell publishes no free programmatic constituent file. The
// verifiable proxy is the iShares Russell 2000 ETF (IWM) holdings file
// — BlackRock's own daily disclosure of what the index-tracking fund
// holds, with each holding's % weight and GICS sector. The map takes
// the TOP 200 holdings by that published weight and labels itself
// 前 200 大成分 · 非全量 everywhere (stage summary, page copy, method
// library) — it never presents the subset as the full index.
// Runtime caveat (shell-verified 2026-11-19): ishares.com answers this
// egress with its bot-wall HTML portal page instead of the CSV (the
// FRED / ChinaMoney egress-block pattern), and Nasdaq's ETF-holdings
// API returns an empty body. The fetcher therefore validates that the
// response really is the holdings CSV (a "Ticker" header row must be
// present) and throws otherwise: the stage fails honestly, the market
// keeps whatever snapshot it had (none on first run), and the page
// shows 罗素 2000 · 待成分源 instead of any substitute data. If the
// egress ever reaches the file, the map fills with no code change.
// ---------------------------------------------------------------------------

const RUT_TOP_N = 200;
const IWM_HOLDINGS_URL =
  "https://www.ishares.com/us/products/239710/ishares-russell-2000-etf/1467271812596.ajax?tab=all&fileType=csv";

/** Minimal CSV row parser (quoted fields, embedded commas, "" escapes). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? "";
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** IWM holdings → the top RUT_TOP_N equity holdings by published weight. */
async function fetchIwmTopMembers(): Promise<{ symbol: string; nameEn: string; sector: string; weightPct: number }[]> {
  const res = await fetch(IWM_HOLDINGS_URL, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`iShares IWM 持仓文件 HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.split(/\r?\n/);
  const hIdx = lines.findIndex((l) => {
    const t = l.replace(/^"|"$/g, "");
    return t.startsWith("Ticker,") || t.startsWith("Ticker\",\"");
  });
  if (hIdx < 0) {
    throw new Error(
      text.trimStart().startsWith("<")
        ? "iShares IWM 持仓文件被源站拦截（返回网页而非 CSV），罗素 2000 待成分源"
        : "iShares IWM 持仓文件结构变化（未找到 Ticker 表头）",
    );
  }
  const header = parseCsvLine(lines[hIdx] ?? "");
  const iTicker = header.findIndex((h) => h === "Ticker");
  const iName = header.findIndex((h) => h === "Name");
  const iSector = header.findIndex((h) => h === "Sector");
  const iAsset = header.findIndex((h) => h === "Asset Class");
  const iWeight = header.findIndex((h) => h.startsWith("Weight"));
  if (iTicker < 0 || iWeight < 0) throw new Error("iShares IWM 持仓文件列结构变化");
  const rows: { symbol: string; nameEn: string; sector: string; weightPct: number }[] = [];
  for (const line of lines.slice(hIdx + 1)) {
    if (!line.trim()) break; // holdings end at the first blank line (footer/disclaimer follows)
    const cells = parseCsvLine(line);
    const symbol = (cells[iTicker] ?? "").replace(/\./g, "-");
    if (!/^[A-Z][A-Z0-9\-]*$/.test(symbol)) continue;
    if (iAsset >= 0 && cells[iAsset] && cells[iAsset] !== "Equity") continue;
    const weightPct = Number.parseFloat((cells[iWeight] ?? "").replace(/,/g, ""));
    if (!Number.isFinite(weightPct) || weightPct <= 0) continue;
    const sectorEn = iSector >= 0 ? (cells[iSector] ?? "") : "";
    rows.push({
      symbol,
      nameEn: iName >= 0 ? (cells[iName] ?? symbol) : symbol,
      sector: GICS_SECTOR_CN[sectorEn] ?? sectorEn ?? "",
      weightPct,
    });
  }
  rows.sort((a, b) => b.weightPct - a.weightPct);
  if (rows.length < 100) throw new Error(`iShares IWM 持仓仅解析到 ${rows.length} 只有效股票持仓`);
  return rows.slice(0, RUT_TOP_N);
}

/** Market caps for many symbols via Yahoo's quote API (crumb handshake). */
async function fetchYahooMarketCaps(symbols: string[]): Promise<Map<string, number>> {
  return (await fetchYahooCapsPre(symbols)).caps;
}

/** One crumb handshake, two maps: market caps AND premarket change %
 *  (the quote's preMarketChangePercent, already in percent) for the
 *  cloud snapshot. The premarket field exists only when the source has
 *  a premarket print for that symbol at fetch time; symbols without it
 *  stay absent from the pre map and their snapshot pre_pct keeps
 *  whatever the previous round stored (coalesce on upsert) — the map's
 *  盘前 toggle labels itself a snapshot and never mixes the two
 *  sessions' numbers for one stock. Throws only on the caps leg (the
 *  historical contract of fetchYahooMarketCaps). */
async function fetchYahooCapsPre(symbols: string[]): Promise<{ caps: Map<string, number>; pre: Map<string, number> }> {
  const caps = new Map<string, number>();
  const pre = new Map<string, number>();
  const cj = await fetch("https://fc.yahoo.com", {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(15000),
  });
  const cookie = (cj.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const cr = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": "Mozilla/5.0", Cookie: cookie },
    signal: AbortSignal.timeout(15000),
  });
  if (!cr.ok) throw new Error(`Yahoo crumb HTTP ${cr.status}`);
  const crumb = (await cr.text()).trim();
  if (!crumb || crumb.length > 40) throw new Error("Yahoo crumb 返回异常");
  for (let i = 0; i < symbols.length; i += 100) {
    const batch = symbols.slice(i, i + 100);
    const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${batch.map(encodeURIComponent).join(",")}&crumb=${encodeURIComponent(crumb)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Cookie: cookie },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`Yahoo quote HTTP ${res.status}`);
    const j = (await res.json()) as { quoteResponse?: { result?: { symbol?: string; marketCap?: number; preMarketChangePercent?: number }[] } };
    for (const q of j.quoteResponse?.result ?? []) {
      if (!q.symbol) continue;
      if (typeof q.marketCap === "number" && q.marketCap > 0) caps.set(q.symbol, q.marketCap);
      if (typeof q.preMarketChangePercent === "number" && Number.isFinite(q.preMarketChangePercent)) pre.set(q.symbol, Math.round(q.preMarketChangePercent * 100) / 100);
    }
  }
  if (caps.size < symbols.length * 0.5) throw new Error(`Yahoo 市值仅取到 ${caps.size}/${symbols.length}`);
  return { caps, pre };
}

async function fetchUsCloudUniverse(
  market: "us" | "ndx" | "dow",
  onChunk?: (rows: CloudUniverseRow[]) => Promise<void>,
): Promise<{ rows: CloudUniverseRow[]; fresh: number; total: number; memberCodes: string[]; note: string }> {
  const label = market === "ndx" ? "纳指100" : market === "dow" ? "道指" : "美股";
  const members = market === "ndx" ? await fetchNdxMembers() : market === "dow" ? await fetchDowMembers() : await fetchSpxMembers();
  let caps = new Map<string, number>();
  let pre = new Map<string, number>();
  let note = "";
  try {
    const both = await fetchYahooCapsPre(members.map((m) => m.symbol));
    caps = both.caps;
    pre = both.pre;
  } catch (e) {
    note = `${label}市值未取到（${e instanceof Error ? e.message : String(e)}），面积改用近 3 月平均成交额`;
  }
  const buildRows = (stats: Map<string, CloudStats>): CloudUniverseRow[] => {
    let totalCap = 0;
    let totalTv = 0;
    for (const [sym, st] of stats) {
      totalCap += caps.get(sym) ?? 0;
      totalTv += st.turnover63;
    }
    const useCap = totalCap > 0;
    const rows: CloudUniverseRow[] = [];
    for (const m of members) {
      const st = stats.get(m.symbol);
      if (!st) continue;
      const weightPct = useCap
        ? ((caps.get(m.symbol) ?? 0) / totalCap) * 100
        : totalTv > 0
          ? (st.turnover63 / totalTv) * 100
          : 0;
      rows.push({
        market,
        code: m.symbol,
        name: US_ZH_NAMES[m.symbol] ?? m.nameEn,
        sector: m.sector,
        industry: m.industry,
        weightPct: Math.round(weightPct * 10000) / 10000,
        capValue: useCap ? (caps.get(m.symbol) ?? null) : null,
        price: st.price,
        date: st.date,
        d1: st.d1,
        w1: st.w1,
        m1: st.m1,
        m3: st.m3,
        m6: st.m6,
        ytd: st.ytd,
        y1: st.y1,
        ma50Diff: st.ma50Diff,
        ma200Diff: st.ma200Diff,
        fromHigh: st.fromHigh,
        prePct: pre.get(m.symbol) ?? null,
        sizeBasis: useCap ? "cap" : "turnover",
      });
    }
    return rows;
  };
  // Chunked fetch: ~60 stocks per chunk, each chunk with its own timeout
  // and an immediate incremental upsert, so the map fills in block by
  // block and one bad chunk only leaves its own stocks on the previous
  // snapshot instead of blanking the whole market.
  const stats = new Map<string, CloudStats>();
  const CHUNK = 60;
  for (let i = 0; i < members.length; i += CHUNK) {
    const slice = members.slice(i, i + CHUNK);
    let part: (CloudStats | null)[];
    try {
      part = await withTimeout(
        mapPool(slice, 16, (m) =>
          fetchCloudStats({
            key: `cu_${m.symbol}`,
            name: m.symbol,
            sub: m.symbol,
            symbol: m.symbol,
            asset: "us",
            unit: "美元",
            decimals: 2,
            years: 1.1,
          }),
        ),
        90000,
        `云图${label}第 ${Math.floor(i / CHUNK) + 1} 块`,
      );
    } catch {
      part = slice.map(() => null);
    }
    slice.forEach((m, j) => {
      const st = part[j];
      if (st) stats.set(m.symbol, st);
    });
    if (onChunk && stats.size > 0) {
      const fresh = buildRows(stats).filter((r) => slice.some((m) => m.symbol === r.code));
      if (fresh.length > 0) await onChunk(fresh);
    }
  }
  const rows = buildRows(stats);
  // Final pass with exact universe-wide weights (chunk passes used the
  // totals known at their time).
  if (onChunk && rows.length > 0) await onChunk(rows);
  if (rows.length < members.length) {
    note = [note, `${label}云图本次更新 ${rows.length}/${members.length} 只，其余沿用上次快照`].filter(Boolean).join("；");
  }
  return { rows, fresh: rows.length, total: members.length, memberCodes: members.map((m) => m.symbol), note };
}

/** Russell 2000 cloud universe: the top-RUT_TOP_N IWM holdings (see the
 *  source note at fetchIwmTopMembers). Weights are BlackRock's published
 *  holding weights — the stocks' actual index weights, NOT renormalised
 *  over the subset — so tile areas and index contributions stay on the
 *  true index basis; the subset's combined weight is reported in the
 *  note so the coverage is checkable. Market caps ride along for the
 *  tile/popup size labels only (best effort, like the CN map). Sector
 *  comes from the holdings file's GICS sector column; the file has no
 *  sub-industry column, so industry stays empty (drills group under
 *  其他） instead of an invented classification. */
async function fetchRutCloudUniverse(
  onChunk?: (rows: CloudUniverseRow[]) => Promise<void>,
): Promise<{ rows: CloudUniverseRow[]; fresh: number; total: number; memberCodes: string[]; note: string }> {
  const members = await fetchIwmTopMembers();
  const capBySym = new Map<string, number>();
  const preBySym = new Map<string, number>();
  try {
    const both = await fetchYahooCapsPre(members.map((m) => m.symbol));
    for (const [sym, v] of both.caps) capBySym.set(sym, v);
    for (const [sym, v] of both.pre) preBySym.set(sym, v);
  } catch {
    // Weights still carry the size story; nothing is fabricated.
  }
  const toRow = (m: { symbol: string; nameEn: string; sector: string; weightPct: number }, st: CloudStats): CloudUniverseRow => ({
    market: "rut",
    code: m.symbol,
    name: US_ZH_NAMES[m.symbol] ?? m.nameEn,
    sector: m.sector || "综合",
    industry: "",
    weightPct: m.weightPct,
    capValue: capBySym.get(m.symbol) ?? null,
    price: st.price,
    date: st.date,
    d1: st.d1,
    w1: st.w1,
    m1: st.m1,
    m3: st.m3,
    m6: st.m6,
    ytd: st.ytd,
    y1: st.y1,
    ma50Diff: st.ma50Diff,
    ma200Diff: st.ma200Diff,
    fromHigh: st.fromHigh,
    prePct: preBySym.get(m.symbol) ?? null,
    sizeBasis: "weight",
  });
  const rows: CloudUniverseRow[] = [];
  const CHUNK = 60;
  for (let i = 0; i < members.length; i += CHUNK) {
    const slice = members.slice(i, i + CHUNK);
    let part: (CloudStats | null)[];
    try {
      part = await withTimeout(
        mapPool(slice, 16, (m) =>
          fetchCloudStats({
            key: `cu_${m.symbol}`,
            name: m.symbol,
            sub: m.symbol,
            symbol: m.symbol,
            asset: "us",
            unit: "美元",
            decimals: 2,
            years: 1.1,
          }),
        ),
        90000,
        `云图罗素2000第 ${Math.floor(i / CHUNK) + 1} 块`,
      );
    } catch {
      part = slice.map(() => null);
    }
    const chunkRows: CloudUniverseRow[] = [];
    slice.forEach((m, j) => {
      const st = part[j];
      if (st) chunkRows.push(toRow(m, st));
    });
    rows.push(...chunkRows);
    if (onChunk && chunkRows.length > 0) await onChunk(chunkRows);
  }
  const covered = Math.round(rows.reduce((a, r) => a + r.weightPct, 0) * 100) / 100;
  let note = `罗素 2000 前 ${members.length} 大成分（iShares IWM 持仓口径，非全量）：本次更新 ${rows.length} 只，合计约占指数权重 ${covered}%`;
  if (rows.length < members.length) note += `，其余 ${members.length - rows.length} 只沿用上次快照`;
  return { rows, fresh: rows.length, total: members.length, memberCodes: members.map((m) => m.symbol), note };
}

/** CSI 300 constituents + official weights from CSI's BIFF files. */
async function fetchCsi300Members(): Promise<{ code: string; name: string; weightPct: number }[]> {
  const base = "https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/autofile";
  const [consRes, wRes] = await Promise.all([
    fetch(`${base}/cons/000300cons.xls`, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(25000) }),
    fetch(`${base}/closeweight/000300closeweight.xls`, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(25000) }),
  ]);
  if (!consRes.ok) throw new Error(`中证成分文件 HTTP ${consRes.status}`);
  if (!wRes.ok) throw new Error(`中证权重文件 HTTP ${wRes.status}`);
  const consRows = parseBiffTable(new Uint8Array(await consRes.arrayBuffer()));
  const wRows = parseBiffTable(new Uint8Array(await wRes.arrayBuffer()));
  const readTable = (
    rows: (string | number | null)[][],
  ): Map<string, { name: string; weightPct: number }> => {
    const header = (rows[0] ?? []).map((c) => String(c ?? ""));
    const codeIdx = header.findIndex((h) => h.includes("Constituent Code"));
    const nameIdx = header.findIndex((h) => h.includes("Constituent Name") && !h.includes("(Eng)"));
    const wIdx = header.findIndex((h) => h.toLowerCase().includes("weight"));
    if (codeIdx < 0 || nameIdx < 0) throw new Error("中证成分文件列结构变化");
    const out = new Map<string, { name: string; weightPct: number }>();
    for (const r of rows.slice(1)) {
      const raw = r[codeIdx];
      if (raw == null) continue;
      const code = String(typeof raw === "number" ? Math.round(raw) : raw).replace(/\D/g, "").padStart(6, "0");
      if (code.length !== 6) continue;
      const wv = wIdx >= 0 ? r[wIdx] : null;
      out.set(code, {
        name: String(r[nameIdx] ?? code),
        weightPct: typeof wv === "number" && Number.isFinite(wv) ? wv : 0,
      });
    }
    return out;
  };
  const cons = readTable(consRows);
  const weights = readTable(wRows);
  if (cons.size < 250) throw new Error(`中证成分仅解析到 ${cons.size} 只`);
  return [...cons.entries()].map(([code, v]) => ({
    code,
    name: v.name,
    weightPct: weights.get(code)?.weightPct ?? 0,
  }));
}

/** Sina industry membership: stock code → { industry, sector }. The node
 *  API hard-caps each page at 100 rows regardless of `num`, so membership
 *  is paged until a short page comes back (an earlier num=600 single-page
 *  version silently dropped every member past the first 100 of a large
 *  industry — 108 of 300 CSI names lost their industry). */
async function fetchSinaIndustryMap(): Promise<Map<string, { industry: string; sector: string }>> {
  const map = new Map<string, { industry: string; sector: string }>();
  await mapPool(Object.entries(SINA_INDUSTRIES), 8, async ([node, meta]) => {
    try {
      for (let page = 1; page <= 8; page++) {
        const res = await fetch(
          `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${page}&num=100&sort=symbol&asc=1&node=${node}`,
          { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) },
        );
        if (!res.ok) return;
        const arr = (await res.json()) as { code?: string }[];
        for (const it of arr) {
          if (it.code && !map.has(it.code)) map.set(it.code, { industry: meta.name, sector: meta.sector });
        }
        if (arr.length < 100) break;
      }
    } catch {
      // One industry failing only leaves its stocks to the fallback group.
    }
  });
  return map;
}

/** Coarse sector for an Eastmoney F10 industry name （所属行业）. */
function emSectorOf(industry: string): string {
  const has = (...ws: string[]) => ws.some((w) => industry.includes(w));
  if (has("银行", "保险", "券商", "信托", "期货", "金融")) return "金融";
  if (has("石油", "煤炭", "天然气", "油气")) return "能源";
  if (has("通信服务", "传媒", "出版", "影视", "广告", "游戏")) return "通信服务";
  if (has("医疗", "医药", "生物", "中药", "制药")) return "医药";
  if (has("半导体", "电子", "软件", "计算机", "互联网", "元件", "光学")) return "科技";
  if (has("房地产", "物业")) return "房地产";
  if (has("电力", "水务", "燃气", "供水", "热力")) return "公用事业";
  if (has("白酒", "啤酒", "食品", "饮料", "农林", "养殖", "饲料", "调味", "乳")) return "必需消费";
  if (has("汽车", "家电", "家居", "服装", "纺织", "酒店", "旅游", "零售", "百货", "珠宝", "教育")) return "可选消费";
  if (has("钢铁", "金属", "化工", "化纤", "水泥", "玻璃", "造纸", "建材", "塑料", "橡胶", "贵金属")) return "原材料";
  return "工业";
}

/** Eastmoney F10 所属行业 for the codes Sina's lists don't carry (Sina's
 *  industry membership is stale — most STAR-market and newer large caps
 *  are absent). One CompanySurvey call per code; results are cached in
 *  the cloud_stocks snapshot by the caller, so later refreshes only fill
 *  codes that are still unclassified. */
async function fetchEmIndustryFill(codes: string[]): Promise<Map<string, { industry: string; sector: string }>> {
  const map = new Map<string, { industry: string; sector: string }>();
  await mapPool(codes, 12, async (code) => {
    try {
      const pre = /^[69]/.test(code) ? "SH" : "SZ";
      const res = await fetch(
        `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/CompanySurveyAjax?code=${pre}${code}`,
        { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) },
      );
      if (!res.ok) return;
      const j = (await res.json()) as { jbzl?: { sshy?: string } };
      const raw = (j.jbzl?.sshy ?? "").trim();
      if (!raw) return;
      const industry = raw.replace(/行业$/, "");
      map.set(code, { industry, sector: emSectorOf(industry) });
    } catch {
      // A single F10 failure leaves that one stock to the fallback group.
    }
  });
  return map;
}

async function fetchCnCloudUniverse(
  cachedInd: Map<string, { industry: string; sector: string }>,
  onChunk?: (rows: CloudUniverseRow[]) => Promise<void>,
): Promise<{ rows: CloudUniverseRow[]; fresh: number; total: number; memberCodes: string[]; note: string }> {
  const members = await fetchCsi300Members();
  let indMap = new Map<string, { industry: string; sector: string }>();
  let note = "";
  try {
    indMap = await fetchSinaIndustryMap();
    if (indMap.size < 1000) throw new Error(`新浪行业成分仅取到 ${indMap.size} 只`);
  } catch (e) {
    note = `A股行业分类未取到（${e instanceof Error ? e.message : String(e)}），云图暂按综合分组`;
    indMap = new Map();
  }
  // Fill Sina's gaps: previous snapshot's classifications first (free),
  // then Eastmoney F10 for whatever is still missing.
  const missing: string[] = [];
  for (const m of members) {
    if (indMap.has(m.code)) continue;
    const cached = cachedInd.get(m.code);
    if (cached) indMap.set(m.code, cached);
    else missing.push(m.code);
  }
  if (missing.length > 0) {
    const filled = await fetchEmIndustryFill(missing);
    for (const [code, v] of filled) indMap.set(code, v);
    if (filled.size < missing.length) {
      note = note || `A股行业：${missing.length - filled.size} 只暂未分类（新浪名单与东财 F10 均未覆盖），暂归综合`;
    }
  }
  // Absolute market caps for the tile/popup size labels — best effort via
  // the same Yahoo quote leg the US map uses (A-share symbols carry
  // .SS/.SZ suffixes). Display-only: if the leg fails, caps stay null and
  // the tiles fall back to showing the official index weight alone.
  const capByCode = new Map<string, number>();
  try {
    const caps = await fetchYahooMarketCaps(members.map((m) => `${m.code}.${/^[69]/.test(m.code) ? "SS" : "SZ"}`));
    for (const [sym, v] of caps) capByCode.set(sym.split(".")[0] ?? sym, v);
  } catch {
    // weights still carry the size story; nothing is fabricated
  }
  const toRow = (m: { code: string; name: string; weightPct: number }, st: CloudStats): CloudUniverseRow => {
    const ind = indMap.get(m.code);
    return {
      market: "cn",
      code: m.code,
      name: m.name,
      sector: ind?.sector ?? "综合",
      industry: ind?.industry ?? "",
      weightPct: m.weightPct,
      capValue: capByCode.get(m.code) ?? null,
      price: st.price,
      date: st.date,
      d1: st.d1,
      w1: st.w1,
      m1: st.m1,
      m3: st.m3,
      m6: st.m6,
      ytd: st.ytd,
      y1: st.y1,
      ma50Diff: st.ma50Diff,
      ma200Diff: st.ma200Diff,
      fromHigh: st.fromHigh,
      prePct: null, // A-shares have no premarket session in this pipeline
      sizeBasis: "weight",
    };
  };
  // Chunked like the US map: per-chunk timeout + incremental upsert;
  // a failed chunk's stocks keep their previous snapshot rows.
  const rows: CloudUniverseRow[] = [];
  const CHUNK = 60;
  for (let i = 0; i < members.length; i += CHUNK) {
    const slice = members.slice(i, i + CHUNK);
    let part: (CloudStats | null)[];
    try {
      part = await withTimeout(
        mapPool(slice, 16, (m) =>
          fetchCloudStats({
            key: `cu_${m.code}`,
            name: m.name,
            sub: m.code,
            symbol: `${m.code}.${/^[69]/.test(m.code) ? "SS" : "SZ"}`,
            asset: "cn",
            unit: "元",
            decimals: 2,
            years: 1.1,
          }),
        ),
        90000,
        `云图A股第 ${Math.floor(i / CHUNK) + 1} 块`,
      );
    } catch {
      part = slice.map(() => null);
    }
    const chunkRows: CloudUniverseRow[] = [];
    slice.forEach((m, j) => {
      const st = part[j];
      if (st) chunkRows.push(toRow(m, st));
    });
    rows.push(...chunkRows);
    if (onChunk && chunkRows.length > 0) await onChunk(chunkRows);
  }
  if (rows.length < members.length) {
    note = [note, `A股云图本次更新 ${rows.length}/${members.length} 只，其余沿用上次快照`].filter(Boolean).join("；");
  }
  return { rows, fresh: rows.length, total: members.length, memberCodes: members.map((m) => m.code), note };
}

/** Upsert one chunk of cloud rows (called per chunk during a refresh, so
 *  the map fills in progressively and a chunk that lands is never lost
 *  when a later chunk or the platform budget cuts the round short).
 *  Stocks absent from `rows` keep their previous snapshot untouched. */
async function upsertCloudRows(ctx: Ctx, rows: CloudUniverseRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = ctx.db<typeof schema>();
  const CH = 200;
  for (let i = 0; i < rows.length; i += CH) {
    await db
      .insert(schema.cloudStocks)
      .values(
        rows.slice(i, i + CH).map((r) => ({
          market: r.market,
          code: r.code,
          name: r.name,
          sector: r.sector,
          industry: r.industry,
          weightPct: r.weightPct,
          capValue: r.capValue,
          price: r.price,
          date: r.date,
          d1: r.d1,
          w1: r.w1,
          m1: r.m1,
          m3: r.m3,
          m6: r.m6,
          ytd: r.ytd,
          y1: r.y1,
          ma50Diff: r.ma50Diff,
          ma200Diff: r.ma200Diff,
          fromHigh: r.fromHigh,
          prePct: r.prePct,
          sizeBasis: r.sizeBasis,
        })),
      )
      .onConflictDoUpdate({
        target: [schema.cloudStocks.market, schema.cloudStocks.code],
        set: {
          name: sql`excluded.name`,
          sector: sql`excluded.sector`,
          industry: sql`excluded.industry`,
          weightPct: sql`excluded.weight_pct`,
          capValue: sql`coalesce(excluded.cap_value, cloud_stocks.cap_value)`,
          price: sql`excluded.price`,
          date: sql`excluded.date`,
          d1: sql`excluded.d1`,
          w1: sql`excluded.w1`,
          m1: sql`excluded.m1`,
          m3: sql`excluded.m3`,
          m6: sql`excluded.m6`,
          ytd: sql`excluded.ytd`,
          y1: sql`excluded.y1`,
          ma50Diff: sql`excluded.ma50_diff`,
          ma200Diff: sql`excluded.ma200_diff`,
          fromHigh: sql`excluded.from_high`,
          // A round whose quote leg carried no premarket field must not
          // erase the last captured premarket snapshot.
          prePct: sql`coalesce(excluded.pre_pct, cloud_stocks.pre_pct)`,
          sizeBasis: sql`excluded.size_basis`,
        },
      });
  }
}

/** Remove snapshot rows for stocks that left the index — only after a
 *  near-complete refresh (≥90% of members freshly fetched), so a bad
 *  round can never shrink the map by "pruning" stocks it failed to load. */
async function pruneCloudMarket(ctx: Ctx, market: "us" | "ndx" | "dow" | "rut" | "cn", memberCodes: Set<string>): Promise<void> {
  const db = ctx.db<typeof schema>();
  const existing = await db
    .select({ code: schema.cloudStocks.code })
    .from(schema.cloudStocks)
    .where(eq(schema.cloudStocks.market, market));
  const stale = existing.map((r) => r.code).filter((c) => !memberCodes.has(c));
  for (const code of stale) {
    await db
      .delete(schema.cloudStocks)
      .where(and(eq(schema.cloudStocks.market, market), eq(schema.cloudStocks.code, code)));
  }
}

// Eastmoney RPTA_WEB_TREASURYYIELD field mapping (verified against AKShare
// bond_em.py and cross-checked with news prints; spread fields reconcile
// arithmetically: CN 10Y-2Y field = CN10Y - CN2Y).
const YIELD_FIELDS: { key: string; tenor: string; cnField: string; usField: string }[] = [
  { key: "2y", tenor: "2 年", cnField: "EMM00588704", usField: "EMG00001306" },
  { key: "5y", tenor: "5 年", cnField: "EMM00166462", usField: "EMG00001308" },
  { key: "10y", tenor: "10 年", cnField: "EMM00166466", usField: "EMG00001310" },
  { key: "30y", tenor: "30 年", cnField: "EMM00166469", usField: "EMG00001312" },
];

// The plan's six-tenor China government curve (中债国债收益率曲线):
// 1Y / 3Y / 5Y / 7Y / 10Y / 30Y. Eastmoney's TREASURYYIELD report has
// no 1Y/3Y/7Y fields at all, so those three tenors come from ChinaBond
// itself (yield.chinabond.com.cn historyQuery — the curve's primary
// publisher; Eastmoney republishes the same curve and its 5Y/10Y/30Y
// prints match ChinaBond's to the digit). Cross-checked 2026-11-19
// against the 2026-11-17 row: CN 1Y 1.1705 / 3Y 1.2494 / 7Y 1.4385,
// 10Y 1.6055 on both sources, so 10Y−1Y = 43.50bp — the lesson anchor.
const CN_CURVE_TENORS: { key: string; tenor: string }[] = [
  { key: "1y", tenor: "1 年" },
  { key: "3y", tenor: "3 年" },
  { key: "5y", tenor: "5 年" },
  { key: "7y", tenor: "7 年" },
  { key: "10y", tenor: "10 年" },
  { key: "30y", tenor: "30 年" },
];

export type Pt = { date: string; value: number; volume: number | null; partial?: boolean };

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

export function dateInTz(tsSeconds: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(tsSeconds * 1000));
  } catch {
    return new Date(tsSeconds * 1000).toISOString().slice(0, 10);
  }
}

/** Hong Kong session state (Asia/Hong_Kong = Beijing time): today's HK
 *  date and whether the close is final yet. Continuous trading ends at
 *  16:00 but the closing auction runs to a random close between 16:08
 *  and 16:10 — a daily bar obtained before 16:10 can still be a
 *  pre-auction snapshot (Yahoo's 3067.HK bar read 7.695 against the
 *  HKEX auction close 7.685), so "beforeClose" lasts until the auction
 *  is certainly over.
 *
 *  Sample this ONCE per refresh round and pass the snapshot down
 *  (stagePrices does): the flag used to be re-sampled inside every
 *  fetch at its own completion time, so in one round the fetches that
 *  resolved before the boundary flagged their today-bar while a slower
 *  sibling resolving after it stored the same kind of snapshot
 *  unflagged — the 2026-11-19 acceptance run caught exactly that split
 *  (hsi / 3033.HK flagged, 3067.HK not). One snapshot per round keeps
 *  every HK series on the same judgment. */
function hkSession(now = new Date()): { today: string; beforeClose: boolean } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  return { today: `${get("year")}-${get("month")}-${get("day")}`, beforeClose: minutes < 16 * 60 + 10 };
}

export async function fetchYahoo(cfg: PriceCfg, tailFrom?: string | null, hkSnap?: { today: string; beforeClose: boolean }): Promise<Pt[]> {
  const years = cfg.years ?? 10;
  const period2 = Math.floor(Date.now() / 1000) + 86400;
  // Incremental mode: a seeded series only re-fetches from its tail
  // (last stored date minus a small overlap), never its whole history.
  const period1 = tailFrom
    ? Math.floor(Date.parse(`${tailFrom}T00:00:00Z`) / 1000)
    : period2 - Math.round(years * 365.25 * 86400);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(cfg.symbol)}?period1=${period1}&period2=${period2}&interval=1d`;
  // Hard per-request timeout: a single hung Yahoo connection must never
  // stall a whole refresh (the cloud map's ~800 chart fetches ride on
  // this — one stuck socket used to hold the entire round hostage until
  // the platform killed it, and the cloud snapshot never landed).
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Yahoo ${cfg.symbol} HTTP ${res.status}`);
  const json = (await res.json()) as {
    chart?: {
      result?: {
        meta?: { exchangeTimezoneName?: string };
        timestamp?: number[];
        indicators?: { quote?: { close?: (number | null)[]; volume?: (number | null)[] }[] };
      }[];
    };
  };
  const r = json.chart?.result?.[0];
  if (!r?.timestamp || !r.indicators?.quote?.[0]) throw new Error(`Yahoo ${cfg.symbol} 结构变化`);
  const tz = r.meta?.exchangeTimezoneName ?? "UTC";
  const closes = r.indicators.quote[0].close ?? [];
  const volumes = r.indicators.quote[0].volume ?? [];
  const out: Pt[] = [];
  r.timestamp.forEach((ts, i) => {
    const c = closes[i];
    if (typeof c === "number" && Number.isFinite(c)) {
      const v = volumes[i];
      out.push({ date: dateInTz(ts, tz), value: c, volume: typeof v === "number" ? v : null });
    }
  });
  // Futures feeds append an intraday partial bar that maps to the same
  // exchange-local date as the last daily bar — keep the last point per date.
  const byDate = new Map<string, Pt>();
  for (const p of out) byDate.set(p.date, p);
  const sorted = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  // HK scope ONLY (brief 2026-11-19): before the HK close is final
  // (closing auction over, 16:10), the bar Yahoo serves for today is
  // an intraday snapshot — the 15:23 refresh stored 恒指 22836.93 as
  // if it were the close (real close 22818.94). Flag that point
  // partial so the card can say 盘中快照，未收盘； the next post-close
  // refresh re-fetches the same date in its overlap window,
  // overwrites it with the final close, and the flag clears. The
  // session judgment comes from the caller's per-round snapshot
  // (hkSnap) — never re-sampled here, so every HK series in a round
  // is judged by the same clock reading (see hkSession). Other
  // markets keep their existing behaviour.
  if (cfg.asset === "hk") {
    const hk = hkSnap ?? hkSession();
    const lastPt = sorted[sorted.length - 1];
    if (lastPt && hk.beforeClose && lastPt.date === hk.today) lastPt.partial = true;
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// Fibonacci 52-week anchors (QQQ / VOO / NDX)
// ---------------------------------------------------------------------------
// Method (user-fixed; fibonacci_anchor_validation skill): the anchor
// window is the trailing 52 weeks (252 trading sessions); the anchors
// are that window's intraday high and low, each WITH its date, and the
// retracement levels are recomputed from the validated anchors on
// every read — never copied from an earlier quote. The stored
// series_points keep closes only, and the user's verified QQQ anchors
// (high $762.86 @2026-10-06, low $555.60 @2026-03-30) are the intraday
// extremes, so anchors are derived here from Yahoo daily OHLC. Every
// anchor pair is then validated against a second source — the Nasdaq
// official historical API: both anchor dates must match exactly and
// both values must agree within 0.1%, otherwise the row is stored
// with verified = 0 and the card says the second source did not
// confirm it. (Stooq's daily CSV was tested as an alternative second
// source and returns empty from this network; Eastmoney's push2his
// US kline likewise returned nothing from the shell.)

// NDX the index is deliberately NOT a target: Eastmoney's 100.NDX is
// a different caliber (same anchor dates, values ~12% off Yahoo's
// ^NDX — measured 2026-11-19: EM high 27,722.75 vs Yahoo 31,361.37),
// and the Nasdaq API leg is unreachable from the worker egress, so
// no honest second source exists for it. QQQ already carries the
// Nasdaq-100 exposure in tradable form.
const FIB_TARGETS = [
  { key: "qqq", name: "QQQ（纳指 100 ETF）", yahoo: "QQQ", nasdaq: "QQQ", assetClass: "etf", emSecid: "105.QQQ" },
  { key: "voo", name: "VOO（标普 500 ETF）", yahoo: "VOO", nasdaq: "VOO", assetClass: "etf", emSecid: "107.VOO" },
] as const;

type FibAnchorCalc = {
  high: number;
  highDate: string;
  low: number;
  lowDate: string;
  close: number;
  closeDate: string;
  from: string; // first date of the 252-session window
};

async function fibFromYahoo(symbol: string): Promise<FibAnchorCalc> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Yahoo ${symbol} HTTP ${res.status}`);
  const json = (await res.json()) as {
    chart?: {
      result?: {
        meta?: { exchangeTimezoneName?: string };
        timestamp?: number[];
        indicators?: { quote?: { close?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[] }[] };
      }[];
    };
  };
  const r = json.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  if (!r?.timestamp || !q) throw new Error(`Yahoo ${symbol} 结构变化`);
  const tz = r.meta?.exchangeTimezoneName ?? "America/New_York";
  type Bar = { date: string; close: number; high: number; low: number };
  const byDate = new Map<string, Bar>();
  r.timestamp.forEach((ts, i) => {
    const c = q.close?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    if (typeof c === "number" && Number.isFinite(c) && typeof h === "number" && typeof l === "number") {
      const date = dateInTz(ts, tz);
      byDate.set(date, { date, close: c, high: h, low: l });
    }
  });
  const bars = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-252);
  if (bars.length < 200) throw new Error(`Yahoo ${symbol} 52 周窗口仅 ${bars.length} 根日线`);
  let hi = bars[0] as Bar;
  let lo = bars[0] as Bar;
  for (const b of bars) {
    if (b.high > hi.high) hi = b;
    if (b.low < lo.low) lo = b;
  }
  const lastBar = bars[bars.length - 1] as Bar;
  return {
    high: hi.high,
    highDate: hi.date,
    low: lo.low,
    lowDate: lo.date,
    close: lastBar.close,
    closeDate: lastBar.date,
    from: (bars[0] as Bar).date,
  };
}

/** Second source: Nasdaq's official historical API. Returns the same
 *  window's intraday high/low with dates, or null when unreachable. */
async function fibFromNasdaq(
  symbol: string,
  assetClass: string,
  from: string,
  to: string,
): Promise<{ high: number; highDate: string; low: number; lowDate: string } | null> {
  const [y, m, d] = from.split("-");
  const url = `https://api.nasdaq.com/api/quote/${symbol}/historical?assetclass=${assetClass}&fromdate=${m}-${d}-${y}&limit=9999`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const json = (await res.json().catch(() => null)) as {
    data?: { tradesTable?: { rows?: { date?: string; high?: string; low?: string }[] } } | null;
  } | null;
  const rows = json?.data?.tradesTable?.rows ?? [];
  const num = (s: string | undefined): number => Number(String(s ?? "").replace(/[$,]/g, ""));
  let hi: { v: number; date: string } | null = null;
  let lo: { v: number; date: string } | null = null;
  for (const row of rows) {
    const parts = String(row.date ?? "").split("/");
    if (parts.length !== 3) continue;
    const iso = `${parts[2]}-${String(parts[0]).padStart(2, "0")}-${String(parts[1]).padStart(2, "0")}`;
    if (iso < from || iso > to) continue;
    const h = num(row.high);
    const l = num(row.low);
    if (Number.isFinite(h) && h > 0 && (!hi || h > hi.v)) hi = { v: h, date: iso };
    if (Number.isFinite(l) && l > 0 && (!lo || l < lo.v)) lo = { v: l, date: iso };
  }
  if (!hi || !lo) return null;
  return { high: hi.v, highDate: hi.date, low: lo.v, lowDate: lo.date };
}

/** Second source, fallback leg: Eastmoney push2his US daily klines
 *  (the same mirror-host channel the ETF gap fill uses — proven from
 *  the server-action runtime, unlike api.nasdaq.com, which the worker
 *  egress cannot reach). f51..f55 = date, open, close, high, low. */
async function fibFromEastmoney(
  secid: string,
  from: string,
  to: string,
): Promise<{ high: number; highDate: string; low: number; lowDate: string } | null> {
  const hosts = ["push2his.eastmoney.com", "82.push2his.eastmoney.com", "48.push2his.eastmoney.com", "61.push2his.eastmoney.com", "91.push2his.eastmoney.com", "7.push2his.eastmoney.com"];
  const beg = from.replaceAll("-", "");
  for (const host of hosts) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const url = `https://${host}/api/qt/stock/kline/get?secid=${secid}&fields1=f1&fields2=f51,f52,f53,f54,f55&klt=101&fqt=0&beg=${beg}&end=20500101`;
        const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(12000) });
        if (!res.ok) continue;
        const json = (await res.json()) as { data?: { klines?: string[] } };
        const klines = json.data?.klines ?? [];
        let hi: { v: number; date: string } | null = null;
        let lo: { v: number; date: string } | null = null;
        for (const line of klines) {
          const parts = line.split(",");
          const date = parts[0] ?? "";
          if (date < from || date > to) continue;
          const h = parts[3] ? Number.parseFloat(parts[3]) : NaN;
          const l = parts[4] ? Number.parseFloat(parts[4]) : NaN;
          if (Number.isFinite(h) && (!hi || h > hi.v)) hi = { v: h, date };
          if (Number.isFinite(l) && (!lo || l < lo.v)) lo = { v: l, date };
        }
        if (hi && lo) return { high: hi.v, highDate: hi.date, low: lo.v, lowDate: lo.date };
      } catch {
        // next mirror / attempt
      }
    }
  }
  return null;
}

/** Recompute + validate + store the fib anchors. Runs inside the
 *  prices stage; failures are per-target and never touch other data —
 *  a failed target keeps its previous stored anchors. */
async function refreshFibAnchors(ctx: Ctx): Promise<{ errors: string[]; note: string }> {
  const db = ctx.db<typeof schema>();
  // Prune targets that were dropped from FIB_TARGETS (e.g. NDX, whose
  // only reachable second source turned out to be a different index
  // caliber) so a stale unverifiable ladder never lingers on the page.
  const keepKeys = FIB_TARGETS.map((t) => t.key);
  const existing = await db.select({ key: schema.fibAnchors.key }).from(schema.fibAnchors);
  for (const r of existing) {
    if (!keepKeys.includes(r.key as (typeof keepKeys)[number])) {
      await db.delete(schema.fibAnchors).where(eq(schema.fibAnchors.key, r.key));
    }
  }
  const errors: string[] = [];
  const verifiedNames: string[] = [];
  const unverifiedNames: string[] = [];
  for (const t of FIB_TARGETS) {
    try {
      const y = await fibFromYahoo(t.yahoo);
      // Second source: Nasdaq's official API first (shell-verified to
      // the cent); the worker egress cannot reach it today, so fall
      // back to Eastmoney push2his US klines — whichever leg actually
      // answered is the one named on the card.
      let n = await fibFromNasdaq(t.nasdaq, t.assetClass, y.from, y.closeDate);
      let nSource = "Nasdaq 官方历史数据（api.nasdaq.com）";
      if (!n) {
        n = await fibFromEastmoney(t.emSecid, y.from, y.closeDate);
        nSource = "东方财富 push2his 美股日线";
      }
      const verified =
        n != null &&
        n.highDate === y.highDate &&
        n.lowDate === y.lowDate &&
        Math.abs(n.high - y.high) <= Math.max(0.02, y.high * 0.001) &&
        Math.abs(n.low - y.low) <= Math.max(0.02, y.low * 0.001);
      const row = {
        key: t.key,
        name: t.name,
        high: y.high,
        highDate: y.highDate,
        low: y.low,
        lowDate: y.lowDate,
        close: y.close,
        closeDate: y.closeDate,
        verified: verified ? 1 : 0,
        verifySource: n ? nSource : "",
        verifyHigh: n?.high ?? null,
        verifyHighDate: n?.highDate ?? "",
        verifyLow: n?.low ?? null,
        verifyLowDate: n?.lowDate ?? "",
        updatedAt: new Date().toISOString(),
      };
      await db
        .insert(schema.fibAnchors)
        .values(row)
        .onConflictDoUpdate({
          target: schema.fibAnchors.key,
          set: {
            name: row.name,
            high: row.high,
            highDate: row.highDate,
            low: row.low,
            lowDate: row.lowDate,
            close: row.close,
            closeDate: row.closeDate,
            verified: row.verified,
            verifySource: row.verifySource,
            verifyHigh: row.verifyHigh,
            verifyHighDate: row.verifyHighDate,
            verifyLow: row.verifyLow,
            verifyLowDate: row.verifyLowDate,
            updatedAt: row.updatedAt,
          },
        });
      (verified ? verifiedNames : unverifiedNames).push(t.name);
    } catch (e) {
      errors.push(`斐波那契锚点 ${t.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const parts: string[] = [];
  if (verifiedNames.length) parts.push(`斐波那契 52 周锚点已更新并经第二源验证：${verifiedNames.join("、")}`);
  if (unverifiedNames.length) parts.push(`斐波那契锚点已更新但第二源未确认：${unverifiedNames.join("、")}`);
  return { errors, note: parts.join("；") };
}

async function fetchYields(tailFrom?: string | null): Promise<Map<string, Pt[]>> {
  // Seed mode: Eastmoney caps pageSize at ~500 rows per call — page
  // through 5 pages to get roughly ten years of daily yields (以史为镜:
  // the window covers the 2016/2020/2023 rate episodes). Incremental
  // mode: page newest-first with smaller pages and stop as soon as a
  // page reaches back past the stored tail — one page in practice.
  const fetchPage = async (page: number, pageSize: number): Promise<Record<string, unknown>[]> => {
    const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_WEB_TREASURYYIELD&columns=ALL&pageNumber=${page}&pageSize=${pageSize}&sortColumns=SOLAR_DATE&sortTypes=-1&source=WEB&client=WEB`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Eastmoney HTTP ${res.status}`);
    const json = (await res.json()) as { result?: { data?: Record<string, unknown>[] } };
    return json.result?.data ?? [];
  };
  let rows: Record<string, unknown>[] = [];
  if (tailFrom) {
    for (let page = 1; page <= 4; page++) {
      const part = await fetchPage(page, 200);
      rows.push(...part);
      const oldest = part.reduce((a, r) => {
        const d = typeof r["SOLAR_DATE"] === "string" ? (r["SOLAR_DATE"] as string).slice(0, 10) : a;
        return d < a ? d : a;
      }, "9999-12-31");
      if (part.length < 200 || oldest < tailFrom) break;
    }
  } else {
    rows = (await Promise.all([1, 2, 3, 4, 5].map((page) => fetchPage(page, 500)))).flat();
  }
  if (rows.length === 0) throw new Error("Eastmoney 收益率结构变化");
  const map = new Map<string, Pt[]>();
  for (const f of YIELD_FIELDS) {
    map.set(`cn${f.key}`, []);
    map.set(`us${f.key}`, []);
  }
  // API returns newest first; walk backwards for ascending dates.
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row) continue;
    const dateRaw = row["SOLAR_DATE"];
    if (typeof dateRaw !== "string") continue;
    const date = dateRaw.slice(0, 10);
    for (const f of YIELD_FIELDS) {
      const cv = row[f.cnField];
      if (typeof cv === "number") map.get(`cn${f.key}`)?.push({ date, value: cv, volume: null });
      const uv = row[f.usField];
      if (typeof uv === "number") map.get(`us${f.key}`)?.push({ date, value: uv, volume: null });
    }
  }
  return map;
}

/** One ChinaBond historyQuery POST (form-encoded, returns an HTML
 *  table page). Rows for every published curve come back mixed; only
 *  中债国债收益率曲线 rows are kept. Columns after 日期 are
 *  3月 / 6月 / 1年 / 3年 / 5年 / 7年 / 10年 / 30年 — this leg stores
 *  only the three tenors Eastmoney lacks (1Y/3Y/7Y); 5Y/10Y/30Y keep
 *  their Eastmoney writer (identical values, one writer per key).
 *  ChinaBond's server is slow (~20 s for a one-year page) and once
 *  timed out at 30 s from this network, so each chunk gets two
 *  attempts with a 60 s ceiling. */
async function fetchChinaBondCurveChunk(startDate: string, endDate: string): Promise<Map<string, Pt[]>> {
  const body = new URLSearchParams({ startDate, endDate, gjqx: "0", qxId: "ycqx", locale: "cn_ZH" }).toString();
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch("https://yield.chinabond.com.cn/cbweb-pbc-web/pbc/historyQuery", {
        method: "POST",
        headers: { "User-Agent": "Mozilla/5.0", "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) throw new Error(`ChinaBond HTTP ${res.status}`);
      const html = await res.text();
      const map = new Map<string, Pt[]>([
        ["cn1y", []],
        ["cn3y", []],
        ["cn7y", []],
      ]);
      const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
      let m: RegExpExecArray | null;
      while ((m = rowRe.exec(html)) !== null) {
        const cells = [...(m[1] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) =>
          (c[1] ?? "").replace(/<[^>]+>/g, "").trim(),
        );
        if (cells[0] !== "中债国债收益率曲线") continue;
        const date = cells[1] ?? "";
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        const legs: [string, string | undefined][] = [
          ["cn1y", cells[4]],
          ["cn3y", cells[5]],
          ["cn7y", cells[7]],
        ];
        for (const [key, raw] of legs) {
          const v = numOrNull(raw ?? null);
          if (v !== null) map.get(key)?.push({ date, value: v, volume: null });
        }
      }
      for (const pts of map.values()) pts.sort((a, b) => (a.date < b.date ? -1 : 1));
      if ((map.get("cn1y")?.length ?? 0) === 0) throw new Error("ChinaBond 曲线结构变化（未解析到国债曲线行）");
      return map;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** ChinaBond government curve, 1Y/3Y/7Y legs. Seed mode: ~6 years in
 *  yearly chunks, three POSTs in parallel (sequential would take
 *  ~2 minutes at ChinaBond's pace). Incremental mode: one chunk from
 *  the stored tail (already overlap-shifted by the caller). */
async function fetchChinaBondCurve(tailFrom?: string | null): Promise<Map<string, Pt[]>> {
  const today = new Date().toISOString().slice(0, 10);
  if (tailFrom) return fetchChinaBondCurveChunk(tailFrom, today);
  const endYear = Number(today.slice(0, 4));
  const years: [string, string][] = [];
  for (let y = endYear - 5; y <= endYear; y++) {
    years.push([`${y}-01-01`, y === endYear ? today : `${y}-12-31`]);
  }
  const merged = new Map<string, Pt[]>([
    ["cn1y", []],
    ["cn3y", []],
    ["cn7y", []],
  ]);
  for (let i = 0; i < years.length; i += 3) {
    const parts = await Promise.all(years.slice(i, i + 3).map(([s, e]) => fetchChinaBondCurveChunk(s, e)));
    for (const part of parts) {
      for (const [k, pts] of part) merged.get(k)?.push(...pts);
    }
  }
  for (const pts of merged.values()) pts.sort((a, b) => (a.date < b.date ? -1 : 1));
  return merged;
}

// ---------------------------------------------------------------------------
// CDB − government 10Y spread （国开债−国债 10Y 利差）, MONTHLY month-end
// points in bp, stored under series key "cdbgov10y". Both legs are
// ChinaBond's own published curves (yield.chinabond.com.cn, 中央国债
// 登记结算公司）:
//   · government 10Y — the same cbweb-pbc-web historyQuery the curve
//     leg above already uses; its 中债国债收益率曲线 rows carry the
//     10Y column (cells[8]) even though that leg stores only 1Y/3Y/7Y.
//   · CDB 10Y — the pbc endpoint publishes only three curves (no
//     policy-bank curve), so this leg reads the main site's curve
//     detail endpoint (cbweb-mn/yc/ycDetail; curve id taken from
//     cbweb-mn/yc/queryTree: 中债国开债收益率曲线), one POST per
//     month-end date, parsing the standard-tenor table's "10.0y" row.
// Month-end = the last government-curve date inside each calendar
// month (the final month is the latest published date, still open).
// Verified 2026-11-20 against a checked month-end CSV
// (61 points, 2021-11-30 → 2026-11-17): spot-checked legs match to
// the digit — 2026-11-17 CDB 1.6926 / govt 1.6055 (spread 8.7bp),
// 2025-01-27 CDB 1.6526, 2021-12-31 CDB 3.0834, 2022-01-30 govt
// 2.6997 (ChinaBond did publish that Sunday, a CNY working day).
// ---------------------------------------------------------------------------

const CDB_CURVE_ID = "8a8b2ca037a7ca910137bfaa94fa5057";

/** One pbc historyQuery chunk → the government curve's DAILY 10Y
 *  points (cells[8]). Same request shape and retry posture as
 *  fetchChinaBondCurveChunk; only the extracted column differs. */
async function fetchChinaBondGov10Chunk(startDate: string, endDate: string): Promise<Pt[]> {
  const body = new URLSearchParams({ startDate, endDate, gjqx: "0", qxId: "ycqx", locale: "cn_ZH" }).toString();
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch("https://yield.chinabond.com.cn/cbweb-pbc-web/pbc/historyQuery", {
        method: "POST",
        headers: { "User-Agent": "Mozilla/5.0", "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) throw new Error(`ChinaBond HTTP ${res.status}`);
      const html = await res.text();
      const pts: Pt[] = [];
      const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
      let m: RegExpExecArray | null;
      while ((m = rowRe.exec(html)) !== null) {
        const cells = [...(m[1] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) =>
          (c[1] ?? "").replace(/<[^>]+>/g, "").trim(),
        );
        if (cells[0] !== "中债国债收益率曲线") continue;
        const date = cells[1] ?? "";
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        const v = numOrNull(cells[8] ?? null);
        if (v !== null) pts.push({ date, value: v, volume: null });
      }
      pts.sort((a, b) => (a.date < b.date ? -1 : 1));
      if (pts.length === 0) throw new Error("ChinaBond 曲线结构变化（未解析到国债 10 年）");
      return pts;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** CDB （国开债） 10Y on one published date, from the main site's
 *  curve detail page. Two attempts, 30 s ceiling (the detail page is
 *  far lighter than a historyQuery year page). */
async function fetchCdb10yOn(date: string): Promise<number> {
  const url = `https://yield.chinabond.com.cn/cbweb-mn/yc/ycDetail?ycDefIds=${CDB_CURVE_ID}&&zblx=txy&&workTime=${date}&&dxbj=&&qxlx=&&yqqxN=&&yqqxK=&&wrjxCBFlag=0&&locale=zh_CN`;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`ChinaBond 国开债曲线 HTTP ${res.status}`);
      const html = await res.text();
      if (!html.includes("中债国开债收益率曲线")) throw new Error("ChinaBond 国开债曲线结构变化（未找到曲线名）");
      const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
      let m: RegExpExecArray | null;
      while ((m = rowRe.exec(html)) !== null) {
        const cells = [...(m[1] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
          .map((c) => (c[1] ?? "").replace(/<[^>]+>/g, "").trim())
          .filter((c) => c !== "");
        if (cells[0] === "10.0y") {
          const v = numOrNull(cells[1] ?? null);
          if (v !== null) return v;
        }
      }
      throw new Error("ChinaBond 国开债曲线结构变化（未解析到 10 年期）");
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** The monthly CDB−govt 10Y spread series (bp). Seed mode (tailFrom
 *  null): the 61 month-ends of the trailing 5 years — calendar-aligned
 *  from the first of the month 60 months back — with the govt leg in
 *  yearly chunks. Incremental: one govt chunk from the stored tail
 *  (the caller overlaps 40 days, so the previous month-end is always
 *  re-checked and a missed month-end heals on the next round). A
 *  month whose CDB lookup fails is retried once, then skipped —
 *  never estimated; seed mode refuses to store a series with holes,
 *  and a total failure throws so the stage log names it and the
 *  stored history stays untouched. */
async function fetchCdbGovSpreadMonthly(tailFrom?: string | null): Promise<Pt[]> {
  const today = new Date().toISOString().slice(0, 10);
  let govDaily: Pt[] = [];
  if (tailFrom) {
    govDaily = await fetchChinaBondGov10Chunk(tailFrom, today);
  } else {
    const ty = Number(today.slice(0, 4));
    const tm = Number(today.slice(5, 7));
    const startAbs = ty * 12 + (tm - 1) - 60;
    const startYear = Math.floor(startAbs / 12);
    const startMonth = (startAbs % 12) + 1;
    const seedStart = `${startYear}-${String(startMonth).padStart(2, "0")}-01`;
    const years: [string, string][] = [];
    for (let y = startYear; y <= ty; y++) {
      years.push([y === startYear ? seedStart : `${y}-01-01`, y === ty ? today : `${y}-12-31`]);
    }
    for (let i = 0; i < years.length; i += 3) {
      const parts = await Promise.all(years.slice(i, i + 3).map(([s, e]) => fetchChinaBondGov10Chunk(s, e)));
      for (const part of parts) govDaily.push(...part);
    }
    govDaily.sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  // Month-end = last published govt date inside each calendar month.
  const monthEnds = new Map<string, Pt>();
  for (const p of govDaily) monthEnds.set(p.date.slice(0, 7), p);
  const ends = [...monthEnds.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  if (ends.length === 0) throw new Error("中债国债曲线无可用日期");
  const cdbByDate = new Map<string, number>();
  const fetchBatch = async (batch: Pt[]): Promise<void> => {
    await Promise.all(
      batch.map(async (g) => {
        try {
          cdbByDate.set(g.date, await fetchCdb10yOn(g.date));
        } catch {
          // recorded as missing below; retried once, then skipped
        }
      }),
    );
  };
  for (let i = 0; i < ends.length; i += 4) await fetchBatch(ends.slice(i, i + 4));
  const missed = ends.filter((g) => !cdbByDate.has(g.date));
  for (let i = 0; i < missed.length; i += 4) await fetchBatch(missed.slice(i, i + 4));
  const stillMissed = ends.filter((g) => !cdbByDate.has(g.date));
  if (stillMissed.length === ends.length) throw new Error(`国开债曲线 ${ends.length} 个月末全部拉取失败`);
  if (!tailFrom && stillMissed.length > 0)
    throw new Error(`国开债曲线缺 ${stillMissed.length} 个月末（${stillMissed.map((g) => g.date).join("、")}），种子不完整`);
  const out: Pt[] = [];
  for (const g of ends) {
    const cdb = cdbByDate.get(g.date);
    if (cdb === undefined) continue;
    out.push({ date: g.date, value: Math.round((cdb - g.value) * 10000) / 100, volume: null });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

// ---------------------------------------------------------------------------
// ChinaMoney （中国外汇交易中心） — money-market rates: repo fixing rates
// (FR/FDR series, incl. the 7-day FR007 / FDR007 the user asked for) and
// SHIBOR. Both endpoints accept startDate/endDate + paging; we walk back
// year by year to build ~5 years of daily history.
// ---------------------------------------------------------------------------

type CmRecord = Record<string, unknown>;

async function fetchChinaMoney(
  path: string,
  startYear: number,
  endYear: number,
): Promise<CmRecord[]> {
  const all: CmRecord[] = [];
  for (let year = endYear; year >= startYear; year--) {
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;
    for (let page = 1; page <= 6; page++) {
      // pageSize 300 trips ChinaMoney's WAF (HTTP 403 on every call,
      // live and harness alike); pageSize <= 50 passes (verified
      // 2026-11-21: 50 OK on Nov window / full 2025 / full 2026,
      // 100/200/250/300 all 403). The endpoint ignores pageNum AND
      // pageSize for the row count (it returns the whole in-range
      // window: 219 rows for 2026, 248 for 2025), so page 1 already
      // returns the year and the `< 300` break below still ends the
      // loop after one page. Do not raise this back above 50.
      const url = `https://www.chinamoney.com.cn/ags/ms/${path}?lang=CN&pageNum=${page}&pageSize=50&startDate=${startDate}&endDate=${endDate}`;
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "zh-CN,zh;q=0.9",
          Referer: "https://www.chinamoney.com.cn/chinese/mkdatabond/",
        },
      });
      if (!res.ok) throw new Error(`ChinaMoney ${path} HTTP ${res.status}`);
      const json = (await res.json()) as { records?: CmRecord[] };
      const recs = json.records;
      if (!recs || recs.length === 0) break;
      all.push(...recs);
      if (recs.length < 300) break;
    }
  }
  return all;
}

function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Repo fixing rates: FR001/FR007/FR014 (all institutions) and
 *  FDR001/FDR007/FDR014 (deposit-taking institutions only — DR series). */
async function fetchRepoFixing(tailFrom?: string | null): Promise<Map<string, Pt[]>> {
  const now = new Date();
  // Incremental: ChinaMoney is queried year by year — a seeded series
  // only needs its tail year(s), not the whole decade. Year-by-year is
  // mandatory, not just an optimisation: a 10-year span in one call
  // returns 0 records (verified 2026-11-21).
  const startYear = tailFrom ? Number(tailFrom.slice(0, 4)) : now.getFullYear() - 9;
  const recs = await fetchChinaMoney("cm-u-bk-currency/FrrHis", startYear, now.getFullYear());
  if (recs.length === 0) throw new Error("ChinaMoney 回购定盘利率结构变化");
  const keys = ["FR001", "FR007", "FR014", "FDR001", "FDR007", "FDR014"] as const;
  const map = new Map<string, Pt[]>();
  for (const k of keys) map.set(k.toLowerCase(), []);
  const seen = new Set<string>();
  for (const r of recs) {
    const date = typeof r["lfiProducDate"] === "string" ? r["lfiProducDate"] : "";
    const fm = r["frValueMap"];
    if (!date || typeof fm !== "object" || fm === null) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    const m = fm as Record<string, unknown>;
    for (const k of keys) {
      const v = numOrNull(m[k]);
      if (v !== null) map.get(k.toLowerCase())?.push({ date, value: v, volume: null });
    }
  }
  for (const arr of map.values()) arr.sort((a, b) => (a.date < b.date ? -1 : 1));
  return map;
}

/** SHIBOR via Eastmoney datacenter RPT_IMP_INTRESTRATEN (the ChinaMoney
 *  direct API 403s from the server runtime's egress; Eastmoney republishes
 *  the same CFETS values — cross-checked identical: 2026-11-18 ON 1.293,
 *  1M 1.3876). Filter MARKET = 上海银行同业拆借市场. */
async function fetchShibor(tailFrom?: string | null): Promise<Map<string, Pt[]>> {
  const fields: [string, string][] = [
    ["shiboron", "隔夜(O/N)"],
    ["shibor1w", "1周(1W)"],
    ["shibor2w", "2周(2W)"],
    ["shibor1m", "1月(1M)"],
    ["shibor3m", "3月(3M)"],
    ["shibor6m", "6月(6M)"],
    ["shibor9m", "9月(9M)"],
    ["shibor1y", "1年(1Y)"],
  ];
  const map = new Map<string, Pt[]>();
  for (const [k] of fields) map.set(k, []);
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 5);
  const cutoffStr = tailFrom ?? cutoff.toISOString().slice(0, 10);
  const filter = encodeURIComponent(`(MARKET="上海银行同业拆借市场")`);
  let done = false;
  // Pages fetched in parallel batches of 6 — sequential paging was the
  // refresh bottleneck from the server runtime's egress.
  for (let base = 1; base <= 31 && !done; base += 6) {
    const batch = await Promise.all(
      [0, 1, 2, 3, 4, 5].map(async (off) => {
        const page = base + off;
        const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_IMP_INTRESTRATEN&columns=ALL&pageNumber=${page}&pageSize=500&sortColumns=REPORT_DATE&sortTypes=-1&filter=${filter}&source=WEB&client=WEB`;
        const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error(`Eastmoney SHIBOR HTTP ${res.status}`);
        const json = (await res.json()) as { result?: { data?: Record<string, unknown>[] } };
        return json.result?.data ?? [];
      }),
    );
    for (const rows of batch) {
    if (!rows || rows.length === 0) {
      done = true;
      break;
    }
    for (const r of rows) {
      const dateRaw = r["REPORT_DATE"];
      if (typeof dateRaw !== "string") continue;
      const date = dateRaw.slice(0, 10);
      if (date < cutoffStr) {
        done = true;
        continue;
      }
      const period = r["REPORT_PERIOD"];
      const v = numOrNull(r["IR_RATE"]);
      if (typeof period !== "string" || v === null) continue;
      for (const [k, f] of fields) {
        if (period === f) map.get(k)?.push({ date, value: v, volume: null });
      }
    }
    if (rows.length < 500) break;
    }
  }
  if ((map.get("shibor3m") ?? []).length === 0) throw new Error("Eastmoney SHIBOR 结构变化");
  for (const arr of map.values()) arr.sort((a, b) => (a.date < b.date ? -1 : 1));
  return map;
}

/** Exchange pledged repo closing rates from Eastmoney push2his kline:
 *  GC007 (204007, 7-day) and GC001 (204001, overnight). Kline close = the
 *  day's closing repo rate in %. The push2his host occasionally resets
 *  connections from the server runtime's egress, so try the numbered
 *  mirror hosts with retries before giving up. */
async function fetchExchangeRepo(tailFrom?: string | null): Promise<Map<string, Pt[]>> {
  const map = new Map<string, Pt[]>();
  const jobs: [string, string][] = [
    ["gc007", "1.204007"],
    ["gc001", "1.204001"],
  ];
  const beg = new Date();
  beg.setFullYear(beg.getFullYear() - 10);
  const begStr = tailFrom
    ? tailFrom.replace(/-/g, "")
    : `${beg.getFullYear()}${String(beg.getMonth() + 1).padStart(2, "0")}${String(beg.getDate()).padStart(2, "0")}`;
  const hosts = ["push2his.eastmoney.com", "82.push2his.eastmoney.com", "48.push2his.eastmoney.com", "61.push2his.eastmoney.com"];
  for (const [key, secid] of jobs) {
    let lastErr: unknown = null;
    let pts: Pt[] | null = null;
    for (const host of hosts) {
      if (pts) break;
      for (let attempt = 0; attempt < 2 && !pts; attempt++) {
        try {
          const url = `https://${host}/api/qt/stock/kline/get?secid=${secid}&fields1=f1&fields2=f51,f52&klt=101&fqt=0&beg=${begStr}&end=20500101`;
          const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(12000) });
          if (!res.ok) throw new Error(`Eastmoney push2his ${secid} HTTP ${res.status}`);
          const json = (await res.json()) as { data?: { klines?: string[] } };
          const klines = json.data?.klines;
          if (!klines || klines.length === 0) throw new Error(`Eastmoney push2his ${secid} 结构变化`);
          const parsed: Pt[] = [];
          for (const line of klines) {
            const [date, close] = line.split(",");
            const v = close ? Number.parseFloat(close) : NaN;
            if (date && Number.isFinite(v)) parsed.push({ date, value: v, volume: null });
          }
          parsed.sort((a, b) => (a.date < b.date ? -1 : 1));
          pts = parsed;
        } catch (e) {
          lastErr = e;
        }
      }
    }
    if (!pts) throw lastErr instanceof Error ? lastErr : new Error(`Eastmoney push2his ${secid} 拉取失败`);
    map.set(key, pts);
  }
  return map;
}

// ---------------------------------------------------------------------------
// FRED (St. Louis Fed) official API — api.stlouisfed.org/fred/series/
// observations, authenticated with the API key held in the
// server_secrets table (written only by the setFredApiKey action,
// read only inside server actions; never in shipped source or any
// bundle, never logged, never returned by any action), with the
// FRED_API_KEY environment variable as fallback (see loadFredApiKey).
// The old keyless fredgraph.csv channel timed out from this egress on every
// series and is retired. The Wall-Street layer: real rates,
// breakeven inflation, HY/IG credit spreads (OAS), term premium,
// policy rate, financial conditions, consumer sentiment, corporate
// profits.
// ---------------------------------------------------------------------------

// FRED / BEA API key 的读取顺序（两者都没有时返回 null，调用方按
// “密钥未配置”优雅降级——相关卡片诚实消失、失败原因记入刷新日志，
// 不崩溃、不发起无 key 的请求）：
//   1. server_secrets 表（setFredApiKey / setBeaApiKey 动作写入，首选）；
//   2. 环境变量 FRED_API_KEY / BEA_API_KEY（.env，见 .env.example）。
// 密钥永远不进源码、不进日志、不进任何动作返回值。
async function loadFredApiKey(ctx: Ctx): Promise<string | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select({ value: schema.serverSecrets.value })
    .from(schema.serverSecrets)
    .where(eq(schema.serverSecrets.name, "fred_api_key"))
    .limit(1);
  const v = rows[0]?.value.trim();
  if (v) return v;
  const env = process.env.FRED_API_KEY?.trim();
  return env ? env : null;
}

// BEA (Bureau of Economic Analysis) API key — same storage discipline
// as the FRED key: server_secrets table, written only by the
// setBeaApiKey action, read only inside server actions, never in
// shipped source or any bundle, never logged, never returned;
// BEA_API_KEY environment variable is the fallback (see loadBeaApiKey).
async function loadBeaApiKey(ctx: Ctx): Promise<string | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select({ value: schema.serverSecrets.value })
    .from(schema.serverSecrets)
    .where(eq(schema.serverSecrets.name, "bea_api_key"))
    .limit(1);
  const v = rows[0]?.value.trim();
  if (v) return v;
  const env = process.env.BEA_API_KEY?.trim();
  return env ? env : null;
}

const FRED_SERIES: { key: string; id: string; cosd: string }[] = [
  { key: "fredreal10", id: "DFII10", cosd: "2018-01-01" }, // 10Y TIPS real yield %
  { key: "fredbe10", id: "T10YIE", cosd: "2018-01-01" }, // 10Y breakeven inflation %
  { key: "fredbe5", id: "T5YIFR", cosd: "2018-01-01" }, // 5y5y forward inflation %
  { key: "fredhy", id: "BAMLH0A0HYM2", cosd: "2018-01-01" }, // US HY OAS %
  { key: "fredig", id: "BAMLC0A0CM", cosd: "2018-01-01" }, // US IG OAS %
  { key: "fredtp10", id: "THREEFYTP10", cosd: "2018-01-01" }, // 10Y term premium %
  { key: "freddff", id: "DFF", cosd: "2010-01-01" }, // effective fed funds %
  { key: "frednfci", id: "NFCI", cosd: "2010-01-01" }, // Chicago Fed financial conditions (weekly)
  { key: "fredsent", id: "UMCSENT", cosd: "2000-01-01" }, // Michigan sentiment (monthly)
  { key: "fredcp", id: "CP", cosd: "2000-01-01" }, // corporate profits after tax, $bn (quarterly)
  { key: "fredusd", id: "DTWEXBGS", cosd: "2010-01-01" }, // broad trade-weighted USD index
  // Monthly macro data series for the 宏观 page (YoY computed at read time
  // from the stored index levels; the unemployment rate is stored as-is).
  // CPIAUCNS / UNRATE are FRED's republications of BLS series CUUR0000SA0 /
  // LNS14000000 — fetchBlsMacro supplies the same keys from the primary
  // publisher and wins; FRED fills. PCEPILFE (BEA core PCE price index)
  // has no keyless official channel besides FRED.
  { key: "fredcpi", id: "CPIAUCNS", cosd: "2000-01-01" }, // CPI-U NSA index (monthly)
  { key: "fredunrate", id: "UNRATE", cosd: "2000-01-01" }, // unemployment rate % (monthly)
  { key: "fredpce", id: "PCEPILFE", cosd: "2000-01-01" }, // core PCE price index (monthly)
];

async function fetchFredApi(s: (typeof FRED_SERIES)[number], timeoutMs: number, apiKey: string, cosdOverride?: string | null): Promise<Pt[]> {
  // Official FRED API (series/observations, JSON). observation_start
  // keeps the old cosd / fredTails tail semantics: a seeded series only
  // re-pulls its tail window, an unseeded one backfills from cosd.
  // Pages with offset while a full page comes back (limit = 100000 is
  // the API maximum; the longest stored series is ~5.5k points, so in
  // practice one page suffices). Missing observations arrive as "."
  // and are skipped. The key travels in the query string — the FRED
  // API's only supported credential transport (no header auth exists);
  // it is never copied into any error text or log line.
  const start = cosdOverride ?? s.cosd;
  const LIMIT = 100000;
  const pts: Pt[] = [];
  for (let offset = 0; ; offset += LIMIT) {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${s.id}&api_key=${apiKey}&file_type=json&observation_start=${start}&sort_order=asc&limit=${LIMIT}&offset=${offset}`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`FRED API HTTP ${res.status}`);
    const body = (await res.json()) as { observations?: { date?: string; value?: string }[] };
    const obs = body.observations ?? [];
    for (const o of obs) {
      const v = o.value ? Number.parseFloat(o.value) : NaN;
      if (o.date && /^\d{4}-\d{2}-\d{2}$/.test(o.date) && Number.isFinite(v)) {
        pts.push({ date: o.date, value: v, volume: null });
      }
    }
    if (obs.length < LIMIT) break;
  }
  return pts;
}

async function fetchFred(tailByKey: Map<string, string> | undefined, apiKey: string | null): Promise<{ map: Map<string, Pt[]>; failures: string[] }> {
  // FRED's official API with the server-held key (verified live
  // 2026-11-21: all 14 series answer in ~1–2 s each). The two-attempt
  // posture is kept from the fredgraph era so a transient API/network
  // failure still gets a second chance with a longer timeout. All
  // series run in parallel and this fetch starts concurrently with
  // the rest of the refresh, so its latency overlaps instead of
  // starving at the end of the budget. A series that fails both
  // attempts is absent from the map (its card disappears honestly)
  // and its reason is reported to the refresh log — reasons never
  // contain the key or the request URL. With no key configured the
  // whole layer reports the real reason per series instead of
  // attempting keyless calls the API would only reject.
  if (!apiKey) {
    return { map: new Map<string, Pt[]>(), failures: FRED_SERIES.map((s) => `${s.id}（FRED API 密钥未配置）`) };
  }
  const map = new Map<string, Pt[]>();
  const failures: string[] = [];
  const fetchOne = async (s: (typeof FRED_SERIES)[number]): Promise<void> => {
    const errs: string[] = [];
    const tail = tailByKey?.get(s.key) ?? null;
    for (const [attempt, timeoutMs] of [[1, 12000], [2, 20000]] as const) {
      try {
        const pts = await fetchFredApi(s, timeoutMs, apiKey, tail);
        if (pts.length < (tail ? 1 : 20)) throw new Error(`数据点不足（${pts.length}）`);
        pts.sort((a, b) => (a.date < b.date ? -1 : 1));
        map.set(s.key, pts);
        return;
      } catch (e) {
        errs.push(`第${attempt}次: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    failures.push(`${s.id}（${errs.join("，")}）`);
  };
  await Promise.all(FRED_SERIES.map((s) => fetchOne(s)));
  if (map.size === 0) throw new Error(`FRED 全部序列拉取失败（${failures.join("，")}）`);
  return { map, failures };
}

// ---------------------------------------------------------------------------
// BEA direct (apps.bea.gov/api/data) — corporate profits, NIPA Table
// 1.12 (T11200), LineNumber 45 "Profits after tax (without IVA and
// CCAdj)". This is the authoritative publisher of the series FRED
// republishes as CP: verified 2026-11-21 to agree with FRED CP to the
// digit every quarter (2026Q1 3948.352, 2026Q2 4279.937 $bn). Values
// arrive in $ millions with thousands separators → strip commas,
// divide by 1000 → $bn; TimePeriod "2026Q2" maps to the quarter-start
// date, the same convention as FRED CP. Authenticated with the API
// key held in server_secrets (setBeaApiKey); the key travels in the
// query string — the BEA API's only credential transport — and is
// never copied into any error text or log line.
// ---------------------------------------------------------------------------

async function fetchBeaProfitsOnce(fullBackfill: boolean, apiKey: string, timeoutMs: number): Promise<Pt[]> {
  // Year=ALL is accepted (verified 2026-11-21: 318 line-45 points,
  // 1947Q1 → latest) and is what stageWallst uses on every run — one
  // request for the whole history. The comma-list branch (current +
  // previous year, also verified accepted) remains for a tail-only
  // pull if one is ever needed.
  const nowY = new Date().getFullYear();
  const yearParam = fullBackfill ? "ALL" : `${nowY - 1},${nowY}`;
  const url = `https://apps.bea.gov/api/data/?UserID=${apiKey}&method=GetData&datasetname=NIPA&TableName=T11200&Frequency=Q&Year=${yearParam}&ResultFormat=JSON`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`BEA API HTTP ${res.status}`);
  const body = (await res.json()) as {
    BEAAPI?: { Results?: { Data?: { LineNumber?: string; TimePeriod?: string; DataValue?: string }[] } };
  };
  const rows = body.BEAAPI?.Results?.Data ?? [];
  const byDate = new Map<string, number>();
  for (const r of rows) {
    if (r.LineNumber !== "45") continue;
    const m = /^(\d{4})Q([1-4])$/.exec(r.TimePeriod ?? "");
    if (!m) continue;
    const v = Number.parseFloat((r.DataValue ?? "").replace(/,/g, ""));
    if (!Number.isFinite(v)) continue;
    const month = String((Number(m[2] ?? "1") - 1) * 3 + 1).padStart(2, "0");
    byDate.set(`${m[1]}-${month}-01`, v / 1000);
  }
  return [...byDate.entries()]
    .map(([date, value]) => ({ date, value, volume: null }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

async function fetchBeaProfits(fullBackfill: boolean, apiKey: string | null): Promise<Pt[]> {
  // Same two-attempt posture as fetchFred (12 s, then 20 s). Every
  // failure leaves as one styled line that names the leg without the
  // key or the request URL.
  if (!apiKey) throw new Error("BEA 企业利润（NIPA T11200 line 45）（BEA API 密钥未配置）");
  const errs: string[] = [];
  for (const [attempt, timeoutMs] of [[1, 12000], [2, 20000]] as const) {
    try {
      const pts = await fetchBeaProfitsOnce(fullBackfill, apiKey, timeoutMs);
      if (pts.length < (fullBackfill ? 20 : 1)) throw new Error(`数据点不足（${pts.length}）`);
      return pts;
    } catch (e) {
      errs.push(`第${attempt}次: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`BEA 企业利润（NIPA T11200 line 45）（${errs.join("，")}）`);
}

/** Which source actually supplied the stored fredcp series — kept in
 *  the chronicle_data KV under "_cp_source" (same pattern as
 *  "_margin_meta") so the corporate-profits card labels the source
 *  that landed, never a static claim. Defaults to "fred": everything
 *  stored before the BEA leg existed came through FRED. */
async function readCpSource(ctx: Ctx): Promise<"bea" | "fred"> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.chronicleData).where(eq(schema.chronicleData.key, "_cp_source"));
  try {
    const p = JSON.parse(rows[0]?.payload ?? "{}") as { source?: unknown };
    return p.source === "bea" ? "bea" : "fred";
  } catch {
    return "fred";
  }
}

async function writeCpSource(ctx: Ctx, source: "bea" | "fred"): Promise<void> {
  const db = ctx.db<typeof schema>();
  await db.delete(schema.chronicleData).where(eq(schema.chronicleData.key, "_cp_source"));
  await db.insert(schema.chronicleData).values({
    key: "_cp_source",
    payload: JSON.stringify({ source }),
    updatedAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Official-source substitutes for the FRED series the worker egress can't
// reach (user rule, 2026-11-19: when a source is unreachable, switch only
// to authoritative official channels — Treasury / NY Fed / Fed / BLS /
// BEA — and label the actual source on the page; never patch together
// estimates from obscure sites).
//   · Real yields & breakevens: U.S. Treasury's own daily par yield and
//     real yield curve tables (home.treasury.gov TextView, monthly pages).
//     DFII10 is itself a republication of the Treasury real curve, and
//     T10YIE is nominal − real by definition, so these are the primary
//     source, not a proxy.
//   · Policy rate: NY Fed's official EFFR API (markets.newyorkfed.org) —
//     the effective federal funds rate FRED's DFF republishes.
// ---------------------------------------------------------------------------

function parseTreasuryCurvePage(html: string): { date: string; y5: number; y10: number }[] {
  const strip = (s: string) => s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
  const chunk = html.split("<table").find((t) => t.includes("10year-table-column"));
  if (!chunk) throw new Error("财政部页面结构变化（未找到曲线表）");
  const headRow = chunk.split("</thead>")[0] ?? chunk;
  const headers = [...headRow.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => strip(m[1] ?? "").toUpperCase());
  const i5 = headers.indexOf("5 YR");
  const i10 = headers.indexOf("10 YR");
  if (i5 < 0 || i10 < 0) throw new Error("财政部页面结构变化（表头缺 5/10 YR）");
  const out: { date: string; y5: number; y10: number }[] = [];
  for (const tr of chunk.split("<tr").slice(1)) {
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => strip(m[1] ?? ""));
    const m = (cells[0] ?? "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) continue;
    const y5 = Number.parseFloat(cells[i5] ?? "");
    const y10 = Number.parseFloat(cells[i10] ?? "");
    if (Number.isFinite(y5) && Number.isFinite(y10)) out.push({ date: `${m[3]}-${m[1]}-${m[2]}`, y5, y10 });
  }
  return out;
}

async function fetchTreasuryCurves(fullBackfill: boolean): Promise<Map<string, Pt[]>> {
  // Monthly pages from 2019-01 on a first backfill; afterwards only the
  // last two months (stored history is upserted, never wiped).
  const now = new Date();
  const months: string[] = [];
  const start = fullBackfill
    ? { y: 2019, m: 1 }
    : { y: now.getFullYear(), m: now.getMonth() + 1 - 2 };
  let y = start.y;
  let m = start.m;
  if (m <= 0) { y -= 1; m += 12; }
  while (y < now.getFullYear() || (y === now.getFullYear() && m <= now.getMonth() + 1)) {
    months.push(`${y}${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  const nominal = new Map<string, { y5: number; y10: number }>();
  const real = new Map<string, { y5: number; y10: number }>();
  const fetchMonth = async (ym: string, type: "daily_treasury_yield_curve" | "daily_treasury_real_yield_curve", sink: Map<string, { y5: number; y10: number }>) => {
    const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=${type}&field_tdr_date_value_month=${ym}`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`财政部 ${type} ${ym} HTTP ${res.status}`);
    for (const row of parseTreasuryCurvePage(await res.text())) sink.set(row.date, { y5: row.y5, y10: row.y10 });
  };
  const jobs: (() => Promise<void>)[] = [];
  for (const ym of months) {
    jobs.push(() => fetchMonth(ym, "daily_treasury_yield_curve", nominal));
    jobs.push(() => fetchMonth(ym, "daily_treasury_real_yield_curve", real));
  }
  let jobErrors = 0;
  for (let i = 0; i < jobs.length; i += 10) {
    const settled = await Promise.allSettled(jobs.slice(i, i + 10).map((j) => j()));
    jobErrors += settled.filter((r) => r.status === "rejected").length;
  }
  if (real.size < 20) throw new Error(`财政部实际收益率曲线数据不足（${real.size} 天，页面失败 ${jobErrors} 个）`);
  const map = new Map<string, Pt[]>();
  const real10: Pt[] = [];
  const be10: Pt[] = [];
  const be5f: Pt[] = [];
  for (const date of [...real.keys()].sort()) {
    const r = real.get(date);
    const n = nominal.get(date);
    if (!r) continue;
    real10.push({ date, value: r.y10, volume: null });
    if (n) {
      const b10 = n.y10 - r.y10;
      const b5 = n.y5 - r.y5;
      be10.push({ date, value: b10, volume: null });
      // 5y5y forward breakeven from the two spot breakevens.
      const fwd = (Math.pow(Math.pow(1 + b10 / 100, 10) / Math.pow(1 + b5 / 100, 5), 1 / 5) - 1) * 100;
      if (Number.isFinite(fwd)) be5f.push({ date, value: fwd, volume: null });
    }
  }
  map.set("fredreal10", real10);
  if (be10.length >= 20) map.set("fredbe10", be10);
  if (be5f.length >= 20) map.set("fredbe5", be5f);
  return map;
}

async function fetchEffr(tailFrom?: string | null): Promise<Map<string, Pt[]>> {
  const today = new Date();
  const end = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const url = `https://markets.newyorkfed.org/api/rates/unsecured/effr/search.json?startDate=${tailFrom ?? "2016-01-01"}&endDate=${end}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`纽约联储 EFFR HTTP ${res.status}`);
  const json = (await res.json()) as { refRates?: { effectiveDate?: string; percentRate?: number; type?: string }[] };
  const pts: Pt[] = [];
  for (const r of json.refRates ?? []) {
    if (r.type === "EFFR" && r.effectiveDate && typeof r.percentRate === "number") {
      pts.push({ date: r.effectiveDate, value: r.percentRate, volume: null });
    }
  }
  if (pts.length < (tailFrom ? 1 : 20)) throw new Error(`纽约联储 EFFR 数据不足（${pts.length}）`);
  pts.sort((a, b) => (a.date < b.date ? -1 : 1));
  const map = new Map<string, Pt[]>();
  map.set("freddff", pts);
  return map;
}

// ---------------------------------------------------------------------------
// Second wave of official-source switches (2026-11-19, same user rule) for
// the series FRED alone used to carry:
//   · Term premium: NY Fed's own ACM (Adrian–Crump–Moench) estimates file,
//     published only as a legacy .xls (BIFF8) — parsed in-process below.
//   · Financial conditions: Chicago Fed's own NFCI file — the old
//     ~/media/... CSV is a frozen 2016 snapshot, so since 2026-11-21
//     the fetcher reads the Fed's data API host
//     (api.data.chicagofed.org, current through 11/13/2026) and
//     keeps the old URL only as a network-error fallback; the
//     freshness guard still rejects any stale tail (see fetchNfci).
//   · Consumer sentiment: University of Michigan Surveys of Consumers' own
//     ICS table CSV (the primary publisher of UMCSENT).
// Still FRED-only after this wave (no reachable official programmatic
// channel, verified 2026-11-19): HY/IG OAS (ICE BofA proprietary index,
// FRED is its only free distribution), corporate profits (BEA's bulk
// files bounce to the apps.bea.gov homepage from this egress and the BEA
// API needs a registered key), broad USD (the Fed's H.10 summary pages
// expose only the real monthly index as tables; no daily nominal file).
// ---------------------------------------------------------------------------

type OleSeg = { start: number; end: number };

function ole2WorkbookStream(buf: Uint8Array): Uint8Array {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0xe011cfd0) throw new Error("ACM 文件不是 OLE2 格式");
  const sectorSize = 1 << dv.getUint16(30, true);
  const miniCutoff = dv.getUint32(56, true);
  const firstDirSector = dv.getUint32(48, true);
  const numFat = dv.getUint32(44, true);
  const secOff = (sid: number) => (sid + 1) * sectorSize;
  const fatSids: number[] = [];
  for (let i = 0; i < 109 && fatSids.length < numFat; i++) {
    const sid = dv.getUint32(76 + i * 4, true);
    if (sid !== 0xfffffffe && sid !== 0xffffffff) fatSids.push(sid);
  }
  let difatSid = dv.getUint32(68, true);
  while (fatSids.length < numFat && difatSid !== 0xfffffffe && difatSid !== 0xffffffff) {
    const off = secOff(difatSid);
    for (let i = 0; i < sectorSize / 4 - 1 && fatSids.length < numFat; i++) {
      const sid = dv.getUint32(off + i * 4, true);
      if (sid !== 0xfffffffe && sid !== 0xffffffff) fatSids.push(sid);
    }
    difatSid = dv.getUint32(off + sectorSize - 4, true);
  }
  const fat = new Uint32Array(fatSids.length * (sectorSize / 4));
  fatSids.forEach((sid, i) => {
    const off = secOff(sid);
    for (let j = 0; j < sectorSize / 4; j++) fat[i * (sectorSize / 4) + j] = dv.getUint32(off + j * 4, true);
  });
  const readChain = (start: number, size: number): Uint8Array => {
    const out: Uint8Array[] = [];
    let sid = start;
    let guard = 0;
    while (sid !== 0xfffffffe && sid !== 0xffffffff && guard++ < 100000) {
      out.push(buf.subarray(secOff(sid), secOff(sid) + sectorSize));
      sid = fat[sid] ?? 0xfffffffe;
    }
    const joined = new Uint8Array(out.length * sectorSize);
    out.forEach((chunk, i) => joined.set(chunk, i * sectorSize));
    return joined.subarray(0, size);
  };
  const dirChainLen = (() => {
    let n = 0;
    let sid = firstDirSector;
    while (sid !== 0xfffffffe && sid !== 0xffffffff && n < 100000) { n++; sid = fat[sid] ?? 0xfffffffe; }
    return n * sectorSize;
  })();
  const dirBytes = readChain(firstDirSector, dirChainLen);
  const ddv = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);
  let wbEntry: { start: number; size: number } | null = null;
  for (let off = 0; off + 128 <= dirBytes.length; off += 128) {
    const nameLen = ddv.getUint16(off + 64, true);
    if (nameLen < 2) continue;
    let name = "";
    for (let i = 0; i < nameLen - 2; i += 2) name += String.fromCharCode(ddv.getUint16(off + i, true));
    const type = ddv.getUint8(off + 66);
    if (type === 2 && (name === "Workbook" || name === "Book")) {
      wbEntry = { start: ddv.getUint32(off + 116, true), size: ddv.getUint32(off + 120, true) };
    }
  }
  if (!wbEntry) throw new Error("ACM 文件缺少 Workbook 流");
  if (wbEntry.size < miniCutoff) throw new Error("ACM 文件异常小（疑似结构变化）");
  return readChain(wbEntry.start, wbEntry.size);
}

class BiffCursor {
  private segs: OleSeg[] = [];
  private si = 0;
  private pos = 0;
  constructor(private buf: Uint8Array, first: OleSeg, rest: OleSeg[]) {
    this.segs = [first, ...rest];
    this.pos = first.start;
  }
  private remainingInSeg(): number {
    const seg = this.segs[this.si];
    return seg ? seg.end - this.pos : 0;
  }
  private nextSeg(): boolean {
    if (this.si + 1 >= this.segs.length) return false;
    this.si++;
    const seg = this.segs[this.si];
    if (!seg) return false;
    this.pos = seg.start;
    return true;
  }
  readU8(): number {
    while (this.remainingInSeg() <= 0) if (!this.nextSeg()) return 0;
    const v = this.buf[this.pos];
    this.pos++;
    return v ?? 0;
  }
  readU16(): number {
    return this.readU8() | (this.readU8() << 8);
  }
  readU32(): number {
    return (this.readU16() | (this.readU16() << 16)) >>> 0;
  }
  readBytes(n: number): void {
    let left = n;
    while (left > 0) {
      if (this.remainingInSeg() <= 0 && !this.nextSeg()) break;
      const take = Math.min(this.remainingInSeg(), left);
      this.pos += take;
      left -= take;
    }
  }
  // Character runs may span CONTINUE records; at each boundary a fresh
  // flags byte precedes the remainder and its bit0 re-decides the encoding.
  readChars(count: number, wide: boolean): string {
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    let s = "";
    let left = count;
    let w = wide;
    while (left > 0) {
      if (this.remainingInSeg() <= 0) {
        if (!this.nextSeg()) break;
        w = (this.readU8() & 1) === 1;
      }
      const per = w ? 2 : 1;
      const take = Math.min(Math.floor(this.remainingInSeg() / per), left);
      for (let i = 0; i < take; i++) {
        if (w) { s += String.fromCharCode(dv.getUint16(this.pos, true)); this.pos += 2; }
        else { s += String.fromCharCode(this.buf[this.pos] ?? 0); this.pos++; }
      }
      left -= take;
      if (take === 0 && this.remainingInSeg() > 0) {
        if (!this.nextSeg()) break;
        w = (this.readU8() & 1) === 1;
      }
    }
    return s;
  }
}

function parseBiffSst(buf: Uint8Array, first: OleSeg, rest: OleSeg[]): string[] {
  const cur = new BiffCursor(buf, first, rest);
  cur.readU32(); // total string count
  const unique = cur.readU32();
  const strings: string[] = [];
  for (let i = 0; i < unique; i++) {
    const cch = cur.readU16();
    const flags = cur.readU8();
    const runs = (flags & 8) === 8 ? cur.readU16() : 0;
    const extLen = (flags & 4) === 4 ? cur.readU32() : 0;
    strings.push(cur.readChars(cch, (flags & 1) === 1));
    if (runs > 0) cur.readBytes(runs * 4);
    if (extLen > 0) cur.readBytes(extLen);
  }
  return strings;
}

function rkDecode(rk: number, scratch: ArrayBuffer): number {
  const isInt = (rk & 0x02) !== 0;
  const div100 = (rk & 0x01) !== 0;
  let v: number;
  if (isInt) {
    v = (rk | 0) >> 2;
  } else {
    const sdv = new DataView(scratch);
    sdv.setUint32(0, 0, true);
    sdv.setUint32(4, rk & 0xfffffffc, true);
    v = sdv.getFloat64(0, true);
  }
  return div100 ? v / 100 : v;
}

/** Extract one named column (dates in column A) from a BIFF8 workbook. */
function parseBiffColumn(buf: Uint8Array, columnName: string): { date: string; value: number }[] {
  const wb = ole2WorkbookStream(buf);
  const dv = new DataView(wb.buffer, wb.byteOffset, wb.byteLength);
  const sheets: { name: string; offset: number }[] = [];
  let sst: string[] = [];
  let pos = 0;
  while (pos + 4 <= wb.length) {
    const id = dv.getUint16(pos, true);
    const len = dv.getUint16(pos + 2, true);
    if (id === 0x0085) {
      const offset = dv.getUint32(pos + 4, true);
      const nameLen = wb[pos + 10] ?? 0;
      const flags = wb[pos + 11] ?? 0;
      let name = "";
      if ((flags & 1) === 1) {
        for (let i = 0; i < nameLen; i++) name += String.fromCharCode(dv.getUint16(pos + 12 + i * 2, true));
      } else {
        for (let i = 0; i < nameLen; i++) name += String.fromCharCode(wb[pos + 12 + i] ?? 0);
      }
      sheets.push({ name, offset });
    } else if (id === 0x00fc) {
      const segs: OleSeg[] = [{ start: pos + 4, end: pos + 4 + len }];
      let p2 = pos + 4 + len;
      while (p2 + 4 <= wb.length && dv.getUint16(p2, true) === 0x003c) {
        const l2 = dv.getUint16(p2 + 2, true);
        segs.push({ start: p2 + 4, end: p2 + 4 + l2 });
        p2 += 4 + l2;
      }
      const first = segs[0];
      if (first) sst = parseBiffSst(wb, first, segs.slice(1));
    } else if (id === 0x000a) {
      break;
    }
    pos += 4 + len;
  }
  if (sheets.length === 0) throw new Error("BIFF: 无工作表");
  sheets.sort((a, b) => (b.name.includes("Daily") ? 1 : 0) - (a.name.includes("Daily") ? 1 : 0));
  const scratch = new ArrayBuffer(8);
  const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
  for (const sheet of sheets) {
    let sp = sheet.offset;
    const byRow = new Map<number, Map<number, number | string>>();
    const put = (row: number, col: number, v: number | string) => {
      let r = byRow.get(row);
      if (!r) { r = new Map(); byRow.set(row, r); }
      r.set(col, v);
    };
    let guard = 0;
    while (sp + 4 <= wb.length && guard++ < 2_000_000) {
      const id = dv.getUint16(sp, true);
      const len = dv.getUint16(sp + 2, true);
      const base = sp + 4;
      if (id === 0x000a) break;
      if (id === 0x00fd && len >= 10) {
        const s = sst[dv.getUint32(base + 6, true)];
        if (s !== undefined) put(dv.getUint16(base, true), dv.getUint16(base + 2, true), s);
      } else if (id === 0x0203 && len >= 14) {
        put(dv.getUint16(base, true), dv.getUint16(base + 2, true), dv.getFloat64(base + 6, true));
      } else if (id === 0x027e && len >= 10) {
        put(dv.getUint16(base, true), dv.getUint16(base + 2, true), rkDecode(dv.getUint32(base + 6, true), scratch));
      } else if (id === 0x00bd && len >= 6) {
        const row = dv.getUint16(base, true);
        const c0 = dv.getUint16(base + 2, true);
        const n = Math.floor((len - 6) / 6);
        for (let i = 0; i < n; i++) {
          put(row, c0 + i, rkDecode(dv.getUint32(base + 4 + i * 6 + 2, true), scratch));
        }
      } else if (id === 0x0006 && len >= 14) {
        const v = dv.getFloat64(base + 6, true);
        if (Number.isFinite(v)) put(dv.getUint16(base, true), dv.getUint16(base + 2, true), v);
      }
      sp += 4 + len;
    }
    let colIdx = -1;
    let headerRow = -1;
    for (const [row, cells] of byRow) {
      for (const [col, v] of cells) {
        if (typeof v === "string" && v.trim().toUpperCase() === columnName) { colIdx = col; headerRow = row; }
      }
      if (colIdx >= 0) break;
    }
    if (colIdx < 0) continue;
    const out: { date: string; value: number }[] = [];
    for (const [r, cells] of byRow) {
      if (r === headerRow) continue;
      const dcell = cells.get(0);
      const vcell = cells.get(colIdx);
      if (typeof vcell !== "number" || !Number.isFinite(vcell)) continue;
      let date = "";
      if (typeof dcell === "number" && dcell > 20000 && dcell < 80000) {
        const d = new Date(Date.UTC(1899, 11, 30) + Math.round(dcell) * 86400000);
        date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      } else if (typeof dcell === "string") {
        const iso = dcell.match(/^(\d{4})-(\d{2})-(\d{2})/);
        const us = dcell.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        const dmy = dcell.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
        const mon = dmy ? MONTHS[dmy[2]?.toLowerCase() ?? ""] : undefined;
        if (iso) date = iso[0].slice(0, 10);
        else if (us) date = `${us[3]}-${(us[1] ?? "").padStart(2, "0")}-${(us[2] ?? "").padStart(2, "0")}`;
        else if (dmy && mon) date = `${dmy[3]}-${mon}-${(dmy[1] ?? "").padStart(2, "0")}`;
      }
      if (date) out.push({ date, value: vcell });
    }
    out.sort((a, b) => (a.date < b.date ? -1 : 1));
    if (out.length >= 100) return out;
  }
  throw new Error(`BIFF: 未找到列 ${columnName}`);
}

/** Read a whole BIFF8 workbook's first sheet as a cell grid (CSI files). */
function parseBiffTable(buf: Uint8Array, sheetName?: string): (string | number | null)[][] {
  const wb = ole2WorkbookStream(buf);
  const dv = new DataView(wb.buffer, wb.byteOffset, wb.byteLength);
  const sheets: { name: string; offset: number }[] = [];
  let sst: string[] = [];
  let pos = 0;
  while (pos + 4 <= wb.length) {
    const id = dv.getUint16(pos, true);
    const len = dv.getUint16(pos + 2, true);
    if (id === 0x0085) {
      const offset = dv.getUint32(pos + 4, true);
      const nameLen = wb[pos + 10] ?? 0;
      const flags = wb[pos + 11] ?? 0;
      let name = "";
      if ((flags & 1) === 1) {
        for (let i = 0; i < nameLen; i++) name += String.fromCharCode(dv.getUint16(pos + 12 + i * 2, true));
      } else {
        for (let i = 0; i < nameLen; i++) name += String.fromCharCode(wb[pos + 12 + i] ?? 0);
      }
      sheets.push({ name, offset });
    } else if (id === 0x00fc) {
      const segs: OleSeg[] = [{ start: pos + 4, end: pos + 4 + len }];
      let p2 = pos + 4 + len;
      while (p2 + 4 <= wb.length && dv.getUint16(p2, true) === 0x003c) {
        const l2 = dv.getUint16(p2 + 2, true);
        segs.push({ start: p2 + 4, end: p2 + 4 + l2 });
        p2 += 4 + l2;
      }
      const first = segs[0];
      if (first) sst = parseBiffSst(wb, first, segs.slice(1));
    } else if (id === 0x000a) {
      break;
    }
    pos += 4 + len;
  }
  const sheet = sheetName ? sheets.find((s) => s.name === sheetName) : sheets[0];
  if (!sheet) throw new Error("BIFF: 无工作表");
  const byRow = new Map<number, Map<number, number | string>>();
  const put = (row: number, col: number, v: number | string) => {
    let r = byRow.get(row);
    if (!r) {
      r = new Map();
      byRow.set(row, r);
    }
    r.set(col, v);
  };
  const scratch = new ArrayBuffer(8);
  let sp = sheet.offset;
  let guard = 0;
  while (sp + 4 <= wb.length && guard++ < 2_000_000) {
    const id = dv.getUint16(sp, true);
    const len = dv.getUint16(sp + 2, true);
    const base = sp + 4;
    if (id === 0x000a) break;
    if (id === 0x00fd && len >= 10) {
      const s = sst[dv.getUint32(base + 6, true)];
      if (s !== undefined) put(dv.getUint16(base, true), dv.getUint16(base + 2, true), s);
    } else if (id === 0x0203 && len >= 14) {
      put(dv.getUint16(base, true), dv.getUint16(base + 2, true), dv.getFloat64(base + 6, true));
    } else if (id === 0x027e && len >= 10) {
      put(dv.getUint16(base, true), dv.getUint16(base + 2, true), rkDecode(dv.getUint32(base + 6, true), scratch));
    } else if (id === 0x00bd && len >= 6) {
      const row = dv.getUint16(base, true);
      const c0 = dv.getUint16(base + 2, true);
      const n = Math.floor((len - 6) / 6);
      for (let i = 0; i < n; i++) {
        put(row, c0 + i, rkDecode(dv.getUint32(base + 4 + i * 6 + 2, true), scratch));
      }
    } else if (id === 0x0006 && len >= 14) {
      const v = dv.getFloat64(base + 6, true);
      if (Number.isFinite(v)) put(dv.getUint16(base, true), dv.getUint16(base + 2, true), v);
    }
    sp += 4 + len;
  }
  const rows: (string | number | null)[][] = [];
  if (byRow.size === 0) return rows;
  const maxRow = Math.max(...byRow.keys());
  for (let r = 0; r <= maxRow; r++) {
    const cells = byRow.get(r);
    if (!cells) {
      rows.push([]);
      continue;
    }
    const maxCol = Math.max(...cells.keys());
    const arr: (string | number | null)[] = [];
    for (let c = 0; c <= maxCol; c++) arr.push(cells.get(c) ?? null);
    rows.push(arr);
  }
  return rows;
}

async function fetchAcmTermPremium(): Promise<Map<string, Pt[]>> {
  const url = "https://www.newyorkfed.org/medialibrary/media/research/data_indicators/ACMTermPremium.xls";
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`纽约联储 ACM HTTP ${res.status}`);
  const rows = parseBiffColumn(new Uint8Array(await res.arrayBuffer()), "ACMTP10");
  const pts: Pt[] = rows
    .filter((r) => r.date >= "1990-01-01")
    .map((r) => ({ date: r.date, value: Math.round(r.value * 10000) / 10000, volume: null }));
  if (pts.length < 1000) throw new Error(`纽约联储 ACM 期限溢价数据不足（${pts.length}）`);
  const last = pts[pts.length - 1];
  if (!last || Math.abs(last.value) > 6) throw new Error("纽约联储 ACM 期限溢价数值异常");
  if (Date.now() - new Date(`${last.date}T00:00:00Z`).getTime() > 90 * 86400000) {
    throw new Error(`纽约联储 ACM 文件停更于 ${last.date}，弃用`);
  }
  const map = new Map<string, Pt[]>();
  map.set("fredtp10", pts);
  return map;
}

async function fetchNfci(): Promise<Map<string, Pt[]>> {
  // Primary: the Chicago Fed's own data API host. The old ~/media/...
  // static file is a frozen 2016 snapshot (ends 2016-09-16, verified
  // 2026-11-21) — kept only as a network-error fallback; the freshness
  // guard below rejects it either way. Verified 2026-11-21: the new
  // file is current through 11/13/2026 (NFCI -0.478), same CSV schema
  // (Friday_of_Week,NFCI,ANFCI,...); the parser reads the first two
  // columns by position, so the renamed last column
  // (Nonfinancial Leverage -> Nonfinancial_Leverage) is inert.
  const urls = [
    "https://api.data.chicagofed.org/NFCI/nfci-data-series-csv.csv",
    "https://www.chicagofed.org/~/media/others/research/data/nfci/nfci-data-series-csv.csv?la=en",
  ];
  let text = "";
  let lastErr: unknown = null;
  for (const url of urls) {
    for (let attempt = 0; attempt < 2 && !text; attempt++) {
      try {
        const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error(`芝加哥联储 NFCI HTTP ${res.status}`);
        text = await res.text();
      } catch (e) {
        lastErr = e;
      }
    }
    if (text) break;
  }
  if (!text) throw lastErr instanceof Error ? lastErr : new Error("芝加哥联储 NFCI 拉取失败");
  const pts: Pt[] = [];
  for (const line of text.split("\n").slice(1)) {
    const [dRaw, vRaw] = line.split(",");
    const m = (dRaw ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    const v = vRaw ? Number.parseFloat(vRaw) : NaN;
    if (m && Number.isFinite(v)) {
      const date = `${m[3]}-${(m[1] ?? "").padStart(2, "0")}-${(m[2] ?? "").padStart(2, "0")}`;
      if (date >= "2010-01-01") pts.push({ date, value: v, volume: null });
    }
  }
  if (pts.length < 100) throw new Error(`芝加哥联储 NFCI 数据不足（${pts.length}）`);
  pts.sort((a, b) => (a.date < b.date ? -1 : 1));
  // Freshness guard: the Chicago Fed's old static CSV turned out to be
  // a frozen snapshot (it ends 2016-09-16 — verified 2026-11-19).
  // A stale file must never pose as current data, so an old tail
  // rejects the whole series and NFCI falls back to the honest
  // FRED-only gap until either the API file resumes updating or
  // FRED's egress recovers.
  const lastNfci = pts[pts.length - 1];
  if (!lastNfci || Date.now() - new Date(`${lastNfci.date}T00:00:00Z`).getTime() > 45 * 86400000) {
    throw new Error(`芝加哥联储 NFCI 静态文件停更于 ${lastNfci?.date ?? "未知"}，弃用`);
  }
  const map = new Map<string, Pt[]>();
  map.set("frednfci", pts);
  return map;
}

async function fetchUmichSentiment(): Promise<Map<string, Pt[]>> {
  const url = "https://www.sca.isr.umich.edu/files/tbmics.csv";
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`密歇根大学消费者信心 HTTP ${res.status}`);
  const text = await res.text();
  const MONTHS: Record<string, string> = {
    january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
    july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
  };
  const pts: Pt[] = [];
  for (const line of text.split("\n").slice(1)) {
    const [monRaw, yRaw, vRaw] = line.split(",");
    const mon = MONTHS[(monRaw ?? "").trim().toLowerCase()];
    const y = (yRaw ?? "").trim();
    const v = vRaw ? Number.parseFloat(vRaw) : NaN;
    if (mon && /^\d{4}$/.test(y) && Number.isFinite(v)) {
      const date = `${y}-${mon}-01`;
      if (date >= "2000-01-01") pts.push({ date, value: v, volume: null });
    }
  }
  if (pts.length < 100) throw new Error(`密歇根大学消费者信心数据不足（${pts.length}）`);
  pts.sort((a, b) => (a.date < b.date ? -1 : 1));
  const lastSent = pts[pts.length - 1];
  if (!lastSent || Date.now() - new Date(`${lastSent.date}T00:00:00Z`).getTime() > 150 * 86400000) {
    throw new Error(`密歇根大学消费者信心文件停更于 ${lastSent?.date ?? "未知"}，弃用`);
  }
  const map = new Map<string, Pt[]>();
  map.set("fredsent", pts);
  return map;
}

/** The three second-wave official sources, fetched in parallel; each is
 *  independent — one failing never blocks the other two. */
async function fetchOfficialMacroExtras(tailFrom?: string | null): Promise<{ map: Map<string, Pt[]>; failures: string[] }> {
  // The ACM workbook and the Michigan CSV are published only as full
  // files (no tail API), so the network fetch stays whole — but only
  // the tail window is handed to the store, keeping the database write
  // incremental exactly like the windowed fetchers.
  const jobs: [string, () => Promise<Map<string, Pt[]>>][] = [
    ["纽约联储 ACM 期限溢价", fetchAcmTermPremium],
    ["芝加哥联储 NFCI", fetchNfci],
    ["密歇根大学消费者信心", fetchUmichSentiment],
  ];
  const settled = await Promise.allSettled(jobs.map(([, fn]) => fn()));
  const map = new Map<string, Pt[]>();
  const failures: string[] = [];
  settled.forEach((res, i) => {
    const label = jobs[i]?.[0] ?? "官方宏观补充序列";
    if (res.status === "fulfilled") {
      for (const [k, v] of res.value) map.set(k, tailFrom ? v.filter((pt) => pt.date >= tailFrom) : v);
    } else {
      failures.push(`${label}: ${res.reason instanceof Error ? res.reason.message : String(res.reason)}`);
    }
  });
  return { map, failures };
}

/** US Bureau of Labor Statistics public API (no key) — the primary
 *  publisher of the CPI and the unemployment rate (FRED's CPIAUCNS /
 *  UNRATE are republications of these exact BLS series, so this is the
 *  original source, not a proxy). Unregistered queries are capped at a
 *  10-year span per call and silently clamp an over-wide range to its
 *  FIRST 10 years (verified 2026-11-19), so a full seed fetches 10-year
 *  windows from 2000; an incremental run only needs the newest window —
 *  the store replaces just that window and history persists. Points are
 *  dated to the 1st of the data month, matching FRED's convention. */
async function fetchBlsMacro(tailFromDate?: string | null): Promise<Map<string, Pt[]>> {
  const thisYear = new Date().getFullYear();
  const windows: [number, number][] = [];
  if (tailFromDate) {
    windows.push([Math.max(2000, thisYear - 9), thisYear]);
  } else {
    for (let y = 2000; y <= thisYear; y += 10) windows.push([y, Math.min(y + 9, thisYear)]);
  }
  const fetchSeries = async (id: string): Promise<Pt[]> => {
    const byDate = new Map<string, number>();
    for (const [y0, y1] of windows) {
      const url = `https://api.bls.gov/publicAPI/v2/timeseries/data/${id}?startyear=${y0}&endyear=${y1}`;
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`BLS ${id} HTTP ${res.status}`);
      const json = (await res.json()) as {
        status?: string;
        Results?: { series?: { data?: { year?: string; period?: string; value?: string }[] }[] };
      };
      if (json.status !== "REQUEST_SUCCEEDED") throw new Error(`BLS ${id} 返回状态 ${json.status ?? "未知"}`);
      const rows = json.Results?.series?.[0]?.data ?? [];
      for (const r of rows) {
        const m = (r.period ?? "").match(/^M(0[1-9]|1[0-2])$/);
        const v = r.value ? Number.parseFloat(r.value) : NaN;
        if (m && /^\d{4}$/.test(r.year ?? "") && Number.isFinite(v)) {
          byDate.set(`${r.year}-${m[1]}-01`, v);
        }
      }
    }
    return [...byDate.entries()]
      .map(([date, value]) => ({ date, value, volume: null }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  };
  const [cpi, unrate] = await Promise.all([fetchSeries("CUUR0000SA0"), fetchSeries("LNS14000000")]);
  if (cpi.length < 100) throw new Error(`BLS CPI 数据不足（${cpi.length}）`);
  if (unrate.length < 100) throw new Error(`BLS 失业率数据不足（${unrate.length}）`);
  // Freshness guard (same style as the other official fetchers): a
  // frozen or lagging feed must never pose as current monthly data.
  for (const [label, pts] of [["CPI", cpi], ["失业率", unrate]] as const) {
    const last = pts[pts.length - 1];
    if (!last || Date.now() - new Date(`${last.date}T00:00:00Z`).getTime() > 150 * 86400000) {
      throw new Error(`BLS ${label} 数据停更于 ${last?.date ?? "未知"}，弃用`);
    }
  }
  const map = new Map<string, Pt[]>();
  map.set("fredcpi", cpi);
  map.set("fredunrate", unrate);
  return map;
}

/** A-share margin balance （两融） from Eastmoney datacenter RPTA_RZRQ_LSHJ.
 *  RZRQYE = 融资融券余额 (yuan), RZYE = 融资余额. Stored in 亿元. */
async function fetchMargin(tailFrom?: string | null): Promise<Map<string, Pt[]>> {
  const fetchMarginPage = async (page: number): Promise<Record<string, unknown>[]> => {
    const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_RZRQ_LSHJ&columns=ALL&pageNumber=${page}&pageSize=500&sortColumns=DIM_DATE&sortTypes=-1&source=WEB&client=WEB`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Eastmoney 两融 HTTP ${res.status}`);
    const json = (await res.json()) as { result?: { data?: Record<string, unknown>[] } };
    return json.result?.data ?? [];
  };
  let marginPages: Record<string, unknown>[][];
  if (tailFrom) {
    marginPages = [];
    for (let page = 1; page <= 5; page++) {
      const part = await fetchMarginPage(page);
      marginPages.push(part);
      const oldest = part.reduce((a, r) => {
        const d = typeof r["DIM_DATE"] === "string" ? (r["DIM_DATE"] as string).slice(0, 10) : a;
        return d < a ? d : a;
      }, "9999-12-31");
      if (part.length < 500 || oldest < tailFrom) break;
    }
  } else {
    marginPages = await Promise.all([1, 2, 3, 4, 5].map((page) => fetchMarginPage(page)));
  }
  const rows: Record<string, unknown>[] = marginPages.flat();
  if (rows.length === 0) throw new Error("Eastmoney 两融结构变化");
  const total: Pt[] = [];
  const fin: Pt[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (!r) continue;
    const dateRaw = r["DIM_DATE"];
    if (typeof dateRaw !== "string") continue;
    const date = dateRaw.slice(0, 10);
    const t = numOrNull(r["RZRQYE"]);
    if (t !== null) total.push({ date, value: t / 1e8, volume: null });
    const f = numOrNull(r["RZYE"]);
    if (f !== null) fin.push({ date, value: f / 1e8, volume: null });
  }
  const map = new Map<string, Pt[]>();
  map.set("margin", total);
  map.set("marginfin", fin);
  return map;
}

/** Southbound Stock Connect daily net buy （南向资金） from Eastmoney
 *  datacenter RPT_MUTUAL_DEAL_HISTORY, MUTUAL_TYPE "006" = 港股通（沪+深）
 *  合计 ("002" = 沪 leg, "004" = 深 leg). NET_DEAL_AMT is in 百万港元 —
 *  verified 2026-11-19 against the HKEX print carried by press
 *  (2026-11-18: total 2750.54 → 27.51亿港元， 沪 2299.23 → 22.99亿，
 *  深 451.31 → 4.51亿， all exact). Stored in 亿港元. Unlike northbound —
 *  whose daily net buy HKEX stopped disclosing in 2024-08 (the 001/003/005
 *  rows of this same report now carry NET_DEAL_AMT = null) — southbound is
 *  still disclosed by HKEX every trading day; null rows are skipped. */
async function fetchSouthbound(tailFrom?: string | null): Promise<Map<string, Pt[]>> {
  const fetchPage = async (page: number): Promise<Record<string, unknown>[]> => {
    const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_MUTUAL_DEAL_HISTORY&columns=ALL&pageNumber=${page}&pageSize=500&sortColumns=TRADE_DATE&sortTypes=-1&source=WEB&client=WEB&filter=(MUTUAL_TYPE=%22006%22)`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Eastmoney 南向资金 HTTP ${res.status}`);
    const json = (await res.json()) as { result?: { data?: Record<string, unknown>[] } };
    return json.result?.data ?? [];
  };
  let pages: Record<string, unknown>[][];
  if (tailFrom) {
    pages = [];
    for (let page = 1; page <= 5; page++) {
      const part = await fetchPage(page);
      pages.push(part);
      const oldest = part.reduce((a, r) => {
        const d = typeof r["TRADE_DATE"] === "string" ? (r["TRADE_DATE"] as string).slice(0, 10) : a;
        return d < a ? d : a;
      }, "9999-12-31");
      if (part.length < 500 || oldest < tailFrom) break;
    }
  } else {
    pages = await Promise.all([1, 2, 3, 4, 5].map((page) => fetchPage(page)));
  }
  const rows: Record<string, unknown>[] = pages.flat();
  if (rows.length === 0) throw new Error("Eastmoney 南向资金结构变化");
  const pts: Pt[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (!r) continue;
    const dateRaw = r["TRADE_DATE"];
    if (typeof dateRaw !== "string") continue;
    const net = numOrNull(r["NET_DEAL_AMT"]);
    if (net === null) continue;
    pts.push({ date: dateRaw.slice(0, 10), value: Math.round(net) / 100, volume: null });
  }
  if (pts.length === 0) throw new Error("Eastmoney 南向资金无净买入数据");
  const map = new Map<string, Pt[]>();
  map.set("southbound", pts);
  return map;
}

// ---------------------------------------------------------------------------
// Margin balances （融资余额 / 保证金负债） — v108 (2026-11-20).
// CN: SH from the SSE official queryMargin.do (JSONP; Referer required;
// isPagination=false + yyyymmdd dates — the paginated / dashed-date
// forms return empty). One call caps at ~500 rows, so the 5-year seed
// walks ~150-day segments. SZ: the stage tries the SZSE official report
// endpoint first; the exchange's disclosure page 404s and its report
// API returns the 50x maintenance page from this network (verified
// 2026-11-20), so the working fallback is Eastmoney's datacenter
// mirror of the same SZSE disclosure (RPTA_WEB_RZRQ_LSSH, SCDM=001),
// cross-checked item-by-item against Tonghuashun's SZSE table for
// 2026-11-16 / 11-19 and labelled as a mirror wherever it is shown.
// 两市合计 is always SH + SZ summed here — never Eastmoney's
// three-market RPTA_RZRQ_LSHJ total (it folds in the Beijing exchange;
// the legacy `margin` / `marginfin` series keep that older caliber and
// are NOT touched by this module).
// US: FINRA Margin Statistics — monthly, ~1 month lag, $ millions.
// Full history (1997-01 →) comes from the official xlsx, which FINRA
// updates in place at a fixed URL. When the xlsx cannot be fetched and
// nothing is stored yet, the stage seeds the 13 most recent months
// exactly as printed on FINRA's statistics page (verified 2026-11-20)
// and flags the history incomplete: full-history percentiles stay off
// until the xlsx lands. Values are stored in 亿元 (CN) / $ millions
// (FINRA, the source's own unit).
// ---------------------------------------------------------------------------

type MarginRow = { date: string; rzye: number; buy: number; repay: number; rqye: number; rqyl: number };

const ymdOf = (d: string): string => d.replace(/-/g, "");
const ymdToDate = (s: string): string => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const MARGIN_SEED_FLOOR = "2021-11-20"; // trailing 5 years of trading days

async function fetchSseMarginSegmentOnce(beginYmd: string, endYmd: string): Promise<MarginRow[]> {
  const url = `http://query.sse.com.cn/marketdata/tradedata/queryMargin.do?jsonCallBack=jsonpCb&isPagination=false&beginDate=${beginYmd}&endDate=${endYmd}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: "http://www.sse.com.cn/" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`上交所融资融券 HTTP ${res.status}`);
  const text = await res.text();
  const start = text.indexOf("(");
  const end = text.lastIndexOf(")");
  if (start < 0 || end <= start) throw new Error("上交所融资融券返回结构变化（非 JSONP）");
  const json = JSON.parse(text.slice(start + 1, end)) as { pageHelp?: { data?: Record<string, unknown>[] } };
  const rows: MarginRow[] = [];
  for (const r of json.pageHelp?.data ?? []) {
    const op = typeof r["opDate"] === "string" ? (r["opDate"] as string) : "";
    const rzye = numOrNull(r["rzye"]);
    if (op.length !== 8 || rzye === null) continue;
    rows.push({
      date: ymdToDate(op),
      rzye,
      buy: numOrNull(r["rzmre"]) ?? 0,
      repay: numOrNull(r["rzche"]) ?? 0,
      rqye: numOrNull(r["rqylje"]) ?? 0,
      rqyl: numOrNull(r["rqyl"]) ?? 0,
    });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  return rows;
}

/** One SSE segment with retries: the exchange's server resets roughly
 *  one connection in four from this network (ECONNRESET, verified
 *  2026-11-20 — a 13-segment seed walk lost 4 segments to it), so a
 *  bare single attempt silently holes the history. Three attempts
 *  with a short pause make a lost segment a rarity; the stage's
 *  row-count check still names any segment that never lands. */
async function fetchSseMarginSegment(beginYmd: string, endYmd: string): Promise<MarginRow[]> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetchSseMarginSegmentOnce(beginYmd, endYmd);
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** SH margin rows from the SSE official endpoint. Seed mode walks
 *  ~150-day segments back to the 5-year floor (a single call caps at
 *  ~500 rows); a segment that fails contributes nothing and the
 *  caller's row-count check names the shortfall. Tail mode is one
 *  call over the overlap window. */
async function fetchSseMargin(tailFrom: string | null): Promise<MarginRow[]> {
  const todayBj = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  if (tailFrom) return fetchSseMarginSegment(ymdOf(tailFrom), ymdOf(todayBj));
  const segments: [string, string][] = [];
  let end = todayBj;
  while (end > MARGIN_SEED_FLOOR) {
    const start = shiftDateStr(end, -150);
    segments.push([start < MARGIN_SEED_FLOOR ? MARGIN_SEED_FLOOR : start, end]);
    end = shiftDateStr(start, -1);
  }
  const parts = await mapPool(segments, 3, async ([b, e]) =>
    fetchSseMarginSegment(ymdOf(b), ymdOf(e)).catch(() => [] as MarginRow[]),
  );
  const byDate = new Map<string, MarginRow>();
  for (const part of parts) for (const r of part) byDate.set(r.date, r);
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** SZ margin rows from the SZSE official report API. The response is
 *  validated strictly (JSON payload, rows carrying a date plus the
 *  published 融资余额 / 融资买入额 / 融资偿还额 / 融券余额 / 融券余量
 *  columns); anything else — including the exchange's current HTML
 *  maintenance page — throws, and the caller falls back to the
 *  Eastmoney mirror of the same disclosure. */
async function fetchSzseMarginOfficial(tailFrom: string | null): Promise<MarginRow[]> {
  const res = await fetch("https://www.szse.cn/api/report/ShowReport?SHOWTYPE=json&CATALOGID=1837&TABKEY=tab1", {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`深交所官网 HTTP ${res.status}`);
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("深交所官网返回非 JSON（维护页）");
  }
  const findRows = (v: unknown, depth: number): Record<string, unknown>[] | null => {
    if (depth > 4 || v === null || typeof v !== "object") return null;
    if (Array.isArray(v)) {
      const objs = v.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null);
      return objs.length > 0 ? objs : null;
    }
    for (const val of Object.values(v as Record<string, unknown>)) {
      const found = findRows(val, depth + 1);
      if (found) return found;
    }
    return null;
  };
  const raw = findRows(parsed, 0);
  if (!raw) throw new Error("深交所官网返回结构无法识别");
  const pick = (r: Record<string, unknown>, names: string[]): number | null => {
    for (const n of names) {
      const v = numOrNull(r[n]);
      if (v !== null) return v;
    }
    return null;
  };
  const rows: MarginRow[] = [];
  for (const r of raw) {
    let date = "";
    for (const n of ["日期", "交易日期", "date", "TRADE_DATE", "DIM_DATE"]) {
      const v = r[n];
      if (typeof v === "string" && /\d{4}-\d{2}-\d{2}/.test(v)) {
        date = v.slice(0, 10);
        break;
      }
    }
    const rzye = pick(r, ["融资余额", "RZYE"]);
    if (!date || rzye === null) continue;
    if (tailFrom && date < tailFrom) continue;
    rows.push({
      date,
      rzye,
      buy: pick(r, ["融资买入额", "RZMRE"]) ?? 0,
      repay: pick(r, ["融资偿还额", "RZCHE"]) ?? 0,
      rqye: pick(r, ["融券余额", "RQYE"]) ?? 0,
      rqyl: pick(r, ["融券余量", "RQYL"]) ?? 0,
    });
  }
  if (rows.length === 0) throw new Error("深交所官网返回无可识别数据行");
  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  return rows;
}

/** One market's margin rows from Eastmoney's datacenter report
 *  RPTA_WEB_RZRQ_LSSH (SCDM 001 = SZ, 007 = SH). Used for SZ as the
 *  labelled mirror of the SZSE disclosure. Amounts in yuan, share
 *  counts in shares — same field names as the exchange print. */
async function fetchEastmoneyMarginMarket(scdm: string, tailFrom: string | null): Promise<MarginRow[]> {
  const floor = tailFrom ?? MARGIN_SEED_FLOOR;
  const rows: MarginRow[] = [];
  for (let page = 1; page <= 8; page++) {
    const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_WEB_RZRQ_LSSH&columns=ALL&source=WEB&sortColumns=DIM_DATE&sortTypes=-1&pageNumber=${page}&pageSize=240&filter=(SCDM%3D${scdm})`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(25000) });
    if (!res.ok) throw new Error(`Eastmoney 两融分市场 HTTP ${res.status}`);
    const json = (await res.json()) as { result?: { data?: Record<string, unknown>[] } };
    const data = json.result?.data ?? [];
    if (data.length === 0) break;
    let oldest = "9999-12-31";
    for (const r of data) {
      const draw = typeof r["DIM_DATE"] === "string" ? (r["DIM_DATE"] as string).slice(0, 10) : "";
      const rzye = numOrNull(r["RZYE"]);
      if (!draw || rzye === null) continue;
      if (draw < oldest) oldest = draw;
      if (draw < floor) continue;
      rows.push({
        date: draw,
        rzye,
        buy: numOrNull(r["RZMRE"]) ?? 0,
        repay: numOrNull(r["RZCHE"]) ?? 0,
        rqye: numOrNull(r["RQYE"]) ?? 0,
        rqyl: numOrNull(r["RQYL"]) ?? 0,
      });
    }
    if (data.length < 240 || oldest <= floor) break;
  }
  if (rows.length === 0) throw new Error("Eastmoney 两融分市场无数据");
  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  return rows;
}

// --- FINRA margin statistics: the download + xlsx parse need
// node:zlib (zip inflate), so they live in server/src/privileged.ts
// behind the fetchFinraMargin contract; the stage calls
// ctx.executePrivileged and gets plain rows back. ---

type FinraRow = { month: string; debt: number; cash: number | null; marginCredit: number | null };

/** The 13 most recent months exactly as printed in the table on
 *  FINRA's margin statistics page (verified 2026-11-20; $ millions:
 *  debit balances / free credit in cash accounts / free credit in
 *  margin accounts). Seed-only fallback for when the xlsx cannot be
 *  fetched — the dashboard and the U1 signal flag the history as
 *  incomplete and never compute a full-history percentile from it. */
const FINRA_PAGE_SEED: FinraRow[] = [
  { month: "2025-10", debt: 1183654, cash: 197923, marginCredit: 195376 },
  { month: "2025-11", debt: 1214321, cash: 202131, marginCredit: 194418 },
  { month: "2025-12", debt: 1225597, cash: 211720, marginCredit: 199762 },
  { month: "2026-01", debt: 1279042, cash: 203700, marginCredit: 196911 },
  { month: "2026-02", debt: 1253192, cash: 205060, marginCredit: 200047 },
  { month: "2026-03", debt: 1220922, cash: 221860, marginCredit: 205600 },
  { month: "2026-04", debt: 1304281, cash: 217836, marginCredit: 215445 },
  { month: "2026-05", debt: 1415557, cash: 206600, marginCredit: 217256 },
  { month: "2026-06", debt: 1502072, cash: 217441, marginCredit: 223412 },
  { month: "2026-07", debt: 1417225, cash: 205132, marginCredit: 217305 },
  { month: "2026-08", debt: 1453832, cash: 207641, marginCredit: 217499 },
  { month: "2026-09", debt: 1480054, cash: 215328, marginCredit: 218581 },
  { month: "2026-10", debt: 1448360, cash: 210290, marginCredit: 212890 },
];

/** Margin-module provenance marker, kept in the chronicle_data KV
 *  table under a "_" key (same pattern as its "_manifest" row): which
 *  source the SZ leg actually landed from, and whether the FINRA
 *  history on file is the full xlsx history or the page seed. The
 *  dashboard reads it to label sources honestly. */
async function readMarginMeta(ctx: Ctx): Promise<{ szSource: string; finraFull: boolean }> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.chronicleData).where(eq(schema.chronicleData.key, "_margin_meta"));
  try {
    const p = JSON.parse(rows[0]?.payload ?? "{}") as { szSource?: unknown; finraFull?: unknown };
    return {
      szSource: typeof p.szSource === "string" ? p.szSource : "",
      finraFull: p.finraFull === true,
    };
  } catch {
    return { szSource: "", finraFull: false };
  }
}

async function writeMarginMeta(ctx: Ctx, patch: { szSource?: string; finraFull?: boolean }): Promise<void> {
  const cur = await readMarginMeta(ctx);
  const next = {
    szSource: patch.szSource ?? cur.szSource,
    finraFull: patch.finraFull ?? cur.finraFull,
  };
  const db = ctx.db<typeof schema>();
  await db.delete(schema.chronicleData).where(eq(schema.chronicleData.key, "_margin_meta"));
  await db.insert(schema.chronicleData).values({
    key: "_margin_meta",
    payload: JSON.stringify(next),
    updatedAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// CNN Fear & Greed Index (v109, 2026-11-20). Source: CNN's official
// dataviz endpoint https://production.dataviz.cnn.io/index/fearandgreed/graphdata
// — verified live from this server 2026-11-20 (HTTP 200, 178,253 bytes)
// with a browser User-Agent + Referer https://edition.cnn.com/markets/fear-and-greed;
// without those headers the endpoint answers 418 ("I'm a teapot").
// Cross-check anchor (2026-11-20 23:17 Beijing): score 17.23 extreme
// fear, previous close 18.68, 1 week 37.37, 1 month 28.74, 1 year 5.17;
// components 1.80 / 30.20 / 24.60 / 11.60 / 20.39 / 28.20 / 4.20 — all
// reproduced by the fetch below. The endpoint's history covers only
// the trailing year (252 daily points), so every percentile this
// module prints is computed over a trailing-1-year window and labelled
// as such; the stored series accumulates one point per day beyond
// that via the daily snapshots. Storage: the daily history lives in
// series_points under "fear_greed_cnn" (date = the point's UTC date —
// CNN's x timestamps are UTC-midnight aligned); the headline snapshot
// (score / comparisons / 7 component scores / CNN timestamp) lives in
// the chronicle_data KV under "_fear_greed", same pattern as
// "_margin_meta". Rating bands follow CNN's published scale, verified
// against the payload's own per-point ratings: ≤25 extreme fear,
// ≤45 fear, ≤55 neutral, ≤75 greed, above extreme greed.
// ---------------------------------------------------------------------------

/** The 7 CNN component keys, in CNN's display order. The two extra
 *  payload keys (market_momentum_sp125, market_volatility_vix_50) are
 *  the raw comparison series behind momentum / volatility, not scored
 *  components, and are deliberately not stored. */
const FG_COMPONENT_KEYS = [
  "market_momentum_sp500",
  "stock_price_strength",
  "stock_price_breadth",
  "put_call_options",
  "market_volatility_vix",
  "junk_bond_demand",
  "safe_haven_demand",
] as const;

/** Chinese display names for the 7 components (CNN's own naming). */
const FG_COMPONENT_NAMES: Record<string, string> = {
  market_momentum_sp500: "市场动量",
  stock_price_strength: "股价强度",
  stock_price_breadth: "股价广度",
  put_call_options: "看跌/看涨期权比",
  market_volatility_vix: "市场波动率（VIX）",
  junk_bond_demand: "垃圾债需求",
  safe_haven_demand: "避险需求",
};

/** CNN's published rating bands (verified against the payload's own
 *  per-point ratings, 2026-11-20): the Chinese label for a score. */
function fgRatingLabel(score: number): string {
  if (score <= 25) return "极度恐惧";
  if (score <= 45) return "恐惧";
  if (score <= 55) return "中性";
  if (score <= 75) return "贪婪";
  return "极度贪婪";
}

type FearGreedSnapshot = {
  score: number;
  rating: string; // CNN's own rating string ("extreme fear", ...)
  timestamp: string; // CNN's ISO timestamp (UTC)
  prevClose: number;
  prevWeek: number;
  prevMonth: number;
  prevYear: number;
  components: { key: string; score: number }[];
  fetchedAt: string; // ISO, when this server pulled it
};

/** Beijing (Asia/Shanghai) "YYYY-MM-DD HH:mm" for an instant. */
function bjDateTimeText(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

async function fetchFearGreed(): Promise<{ snap: FearGreedSnapshot; history: Pt[] }> {
  const res = await fetch("https://production.dataviz.cnn.io/index/fearandgreed/graphdata", {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Referer: "https://edition.cnn.com/markets/fear-and-greed",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as Record<string, unknown>;
  const fg = j.fear_and_greed as Record<string, unknown> | undefined;
  const hist = j.fear_and_greed_historical as Record<string, unknown> | undefined;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
  const score = num(fg?.score);
  const prevClose = num(fg?.previous_close);
  const prevWeek = num(fg?.previous_1_week);
  const prevMonth = num(fg?.previous_1_month);
  const prevYear = num(fg?.previous_1_year);
  const timestamp = typeof fg?.timestamp === "string" ? fg.timestamp : "";
  if (!fg || !Number.isFinite(score) || !Number.isFinite(prevClose) || !timestamp)
    throw new Error("返回结构不完整（fear_and_greed 缺失或分数不可读）");
  const components: { key: string; score: number }[] = [];
  for (const key of FG_COMPONENT_KEYS) {
    const c = j[key] as Record<string, unknown> | undefined;
    const s = num(c?.score);
    if (!Number.isFinite(s)) throw new Error(`分项 ${key} 缺失或分数不可读`);
    components.push({ key, score: s });
  }
  const rawData = Array.isArray(hist?.data) ? hist.data : [];
  const byDate = new Map<string, number>();
  for (const p of rawData) {
    const pt = p as { x?: unknown; y?: unknown };
    const x = num(pt.x);
    const y = num(pt.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    byDate.set(new Date(x).toISOString().slice(0, 10), y);
  }
  if (byDate.size < 60) throw new Error(`历史点不足（${byDate.size}）`);
  // The headline score is the freshest read of today: the historical
  // array's last point is stamped at UTC midnight and trails the live
  // score by minutes, so today's stored point carries the headline.
  const todayUtc = new Date(timestamp).toISOString().slice(0, 10);
  if (todayUtc && todayUtc !== "Invalid") byDate.set(todayUtc, score);
  const history: Pt[] = [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, value]) => ({ date, value: Math.round(value * 100) / 100, volume: null }));
  return {
    snap: {
      score,
      rating: typeof fg.rating === "string" ? fg.rating : "",
      timestamp,
      prevClose,
      prevWeek,
      prevMonth,
      prevYear,
      components,
      fetchedAt: new Date().toISOString(),
    },
    history,
  };
}

async function readFearGreedMeta(ctx: Ctx): Promise<FearGreedSnapshot | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.chronicleData).where(eq(schema.chronicleData.key, "_fear_greed"));
  try {
    const p = JSON.parse(rows[0]?.payload ?? "null") as FearGreedSnapshot | null;
    if (!p || typeof p.score !== "number" || !Array.isArray(p.components)) return null;
    return p;
  } catch {
    return null;
  }
}

async function writeFearGreedMeta(ctx: Ctx, snap: FearGreedSnapshot): Promise<void> {
  const db = ctx.db<typeof schema>();
  await db.delete(schema.chronicleData).where(eq(schema.chronicleData.key, "_fear_greed"));
  await db.insert(schema.chronicleData).values({
    key: "_fear_greed",
    payload: JSON.stringify(snap),
    updatedAt: new Date().toISOString(),
  });
}

/** Dividend yield of the two dividend indices behind the tracked
 *  dividend ETFs, from CSI's own daily valuation file (中证指数官网，
 *  the index publisher — the same oss-ch.csindex.com.cn host as the
 *  CSI 300 constituent files): <code>indicator.xls carries the last
 *  ~20 trading days of P/E1, P/E2, D/P1 （股息率1，总股本口径） and
 *  D/P2 （计算用股本口径）; this console stores D/P1, the headline
 *  weighting. 512890 tracks 中证红利低波动指数 (H30269) and 510880
 *  tracks 上证红利指数 (000015). Verified 2026-11-19 by parsing the
 *  live files with this module's own BIFF reader: 2026-11-18 prints
 *  H30269 D/P1 = 4.47 (cross-checks Danjuan's same-day snapshot
 *  4.47 exactly) and 000015 D/P1 = 4.43. The file only reaches back
 *  20 trading days, so the stored series is an accumulating one —
 *  storeSeries' windowed replace keeps every landed print and each
 *  refresh extends the history by the new days; the 股债性价比
 *  proxy card in getDashboard labels its sample count accordingly.
 *  A total-return-index derivation was tested and rejected the same
 *  day: Eastmoney push2his has the price indices (1.000015 /
 *  2.H30269) but no total-return secids (rc=100), Danjuan's history
 *  endpoint is login-gated, and Legulegu's API needs a token (its
 *  page weighting also differs: 3.48 vs CSI's 4.43). Freshness guard
 *  (45d) follows the ACM/UMich pattern: a frozen file is rejected
 *  outright rather than shown as current. The tail argument is
 *  ignored — the file is a fixed small window by design. */
async function fetchCsiDivYieldOne(code: string, key: string, label: string): Promise<Map<string, Pt[]>> {
  const url = `https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/autofile/indicator/${code}indicator.xls`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`中证官网 ${label}股息率 HTTP ${res.status}`);
  const rows = parseBiffTable(new Uint8Array(await res.arrayBuffer()));
  const header = rows[0] ?? [];
  const dpCol = header.findIndex((c) => typeof c === "string" && c.includes("D/P1"));
  if (dpCol < 0) throw new Error(`中证官网 ${label}股息率文件结构变化（未找到股息率1列）`);
  const pts: Pt[] = [];
  for (const r of rows.slice(1)) {
    const raw = r[0];
    const dstr = typeof raw === "string" ? raw : typeof raw === "number" ? String(Math.round(raw)) : "";
    if (!/^\d{8}$/.test(dstr)) continue;
    const v = r[dpCol];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v >= 15) continue;
    pts.push({ date: `${dstr.slice(0, 4)}-${dstr.slice(4, 6)}-${dstr.slice(6, 8)}`, value: Math.round(v * 100) / 100, volume: null });
  }
  pts.sort((a, b) => (a.date < b.date ? -1 : 1));
  if (pts.length < 10) throw new Error(`中证官网 ${label}股息率数据不足（${pts.length}）`);
  const last = pts[pts.length - 1];
  if (last && Date.now() - new Date(`${last.date}T00:00:00Z`).getTime() > 45 * 86400000) {
    throw new Error(`中证官网 ${label}股息率文件停更于 ${last.date}，弃用`);
  }
  const map = new Map<string, Pt[]>();
  map.set(key, pts);
  return map;
}

// ---------------------------------------------------------------------------
// Historical index PE percentile pipeline (V-1 step 5, 2026-11-19).
// Targets: the CSI-published indices behind the CSI 300 card and the
// ten tracked A-share sector ETFs. Source = CSI's own site
// (中证指数官网， the index publisher): its index-perf API returns the
// index's daily published PE (the `peg` field) back through the full
// requested window — probe-verified 2026-11-19 from the shell for all
// eleven codes below (e.g. 000300: 1,425 daily rows 2021-01 →
// 2026-11-19, PE 13.09 on the last day; magnitudes cross-checked
// against the publisher's own indicator-file PE1 prints — same series
// family, a few percent apart as the two published calibers differ in
// share basis; episode checks: 2021-02 peak ≈ 19.1, 2024-02 trough
// ≈ 10.2, bank index ≈ 7.7, semiconductor ≈ 46.6 — all PE-shaped, not
// PEG-shaped). The daily prints are downsampled to MONTH-END points
// at fetch time and stored as `pe_<instrumentKey>` series in
// series_points, seeded once from 2020-01 and tail-refreshed with the
// same overlap discipline as every other series (stage `pe`).
// Percentile caliber (same as the detail drawer): TTM PE, trailing
// 5-year window of month-end points, sample floor 8 — below it the
// card shows no percentile and nothing is estimated.
//
// Targets deliberately NOT in this pipeline (no free authoritative
// history exists; their cards carry an honest 暂无历史 PE 数据 note
// and their signals keep the step-3/4 no-valuation-factor state):
//   标普 500 — HAS a pipeline since 2026-11-20 (V-1 step 5, part 1):
//     Multpl's embedded monthly TTM PE series (1871-01 → now, live)
//     is the primary; Shiller's Yale file is the frozen deep-history
//     cross-check (verified 2026-11-20: 1830 overlapping months,
//     mean/median diff 0.00, max |diff| 0.065) and the CAPE history
//     source (ends 2023-09, frozen — history-only, never a current
//     percentile). Rejected as primaries: S&P DJI's official earnings
//     spreadsheet (Akamai-403 from this network); the chronicle's
//     trailing-PE dataset (stops 2026-03, eight months stale —
//     rejected under this console's own freshness discipline, the
//     NFCI precedent); Shiller alone (its earnings column stops
//     2023-06, so it cannot carry a current PE).
//   纳斯达克 100 — HAS a current-value row since 2026-11-20 (V-1
//     step 5, B1): Siblis annual December points + latest month
//     (TTM 32.76 Oct 2026) feed peCurrent only — no 5y percentile,
//     because a 5y window of annual points is 6 < the 8-point
//     floor. Siblis Research's monthly TTM series (1995 → 2026-10)
//     is NOT programmatically exposed — the page HTML carries only
//     the annual December table (11 points, 2016–2026) and
//     pre-rendered chart images, no JSON/CSV endpoint and no
//     Dataset download URL, so a monthly seed cannot be fetched.
//     Nasdaq publishes only a current factsheet PE; the chronicle
//     carries its FORWARD PE only (different caliber). ChartRow's
//     daily rebuilt aggregate (32.5 on 2026-11-19) is a
//     current-value cross-check only — its history is a server-
//     rendered SVG, not a stable source. (The 33.2× figure in the
//     2026-11-20 research note is VRTX's member tile on ChartRow,
//     not the index aggregate — do not quote it as the index PE.)
//   恒生指数 — HAS a current-value row since 2026-11-20 (V-1 step 5,
//     part 2): Siblis annual December points + latest month
//     (TTM 11.71 Oct 2026) feed peCurrent only — no 5y percentile,
//     because a 5y window of annual points is 6 < the 8-point
//     floor. hsi.com.hk itself publishes no programmatic history
//     (its monthly factsheet PDF carries the current PE only,
//     13.04 as at 2026-10-30, a different methodology from Siblis
//     — recorded as a cross-check in DATA-PLAN, never mixed on the
//     card). HSCEI / HSTECH have no Siblis page and stay no-data.
//   11 SPDR sector ETFs & 6 US dividend ETFs — no official history
//     (SPDJI site 403 from this network; GuruFocus Cloudflare-403).
//     Weekly accumulation from Yahoo quote trailingPE started
//     2026-11-20 (part 2, §4): cadence "周度", percentile once the
//     stored sample reaches 8. Until then the cards show 积累中,
//     labelled as Yahoo current prints, not an official series.
//   Danjuan's valuation list was tested as a cross-check (its current
//     prints sit within a few percent of CSI's) but its history
//     endpoint is login-gated, so it cannot feed a stored series.
// ---------------------------------------------------------------------------

type IndexPeTarget = { key: string; csiCode: string; indexName: string };

const INDEX_PE_TARGETS: IndexPeTarget[] = [
  { key: "csi300", csiCode: "000300", indexName: "沪深300指数" },
  { key: "sec_divlow", csiCode: "H30269", indexName: "中证红利低波动指数" },
  { key: "sec_div", csiCode: "000015", indexName: "上证红利指数" },
  { key: "sec_cons", csiCode: "000932", indexName: "中证主要消费指数" },
  { key: "sec_med", csiCode: "000913", indexName: "沪深300医药卫生指数" },
  { key: "sec_bank", csiCode: "399986", indexName: "中证银行指数" },
  { key: "sec_broker", csiCode: "399975", indexName: "中证全指证券公司指数" },
  { key: "sec_power", csiCode: "H30199", indexName: "中证全指电力公用事业指数" },
  { key: "sec_semi", csiCode: "H30184", indexName: "中证全指半导体产品与设备指数" },
  { key: "sec_pv", csiCode: "931151", indexName: "中证光伏产业指数" },
  { key: "sec_game", csiCode: "930901", indexName: "中证动漫游戏指数" },
];

/** Brief targets with no qualifying PE history source (see the block
 *  comment above): their cards label 暂无历史 PE 数据 instead of a PE
 *  row, and no percentile is ever computed for them. */
const PE_NO_DATA_KEYS = new Set([
  "hsce",
  "sec_xlb", "sec_xlc", "sec_xle", "sec_xlf", "sec_xli", "sec_xlk", "sec_xlp", "sec_xlre", "sec_xlu", "sec_xlv", "sec_xly",
  "schd", "vym", "vig", "dgro", "spyd", "hdv",
]);

const peSeriesKey = (key: string) => `pe_${key}`;

/** One CSI index's published PE history as month-end points.
 *  startYmd is the daily window to request (YYYYMMDD); the publisher
 *  returns one row per day (holiday rows repeat the previous print),
 *  so the last row of each calendar month is that month's PE. */
async function fetchCsiIndexPeMonthly(csiCode: string, startYmd: string): Promise<Pt[]> {
  const bj = new Date(Date.now() + 8 * 3600_000);
  const endYmd = `${bj.getUTCFullYear()}${String(bj.getUTCMonth() + 1).padStart(2, "0")}${String(bj.getUTCDate()).padStart(2, "0")}`;
  const url = `https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode=${csiCode}&startDate=${startYmd}&endDate=${endYmd}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`中证官网 ${csiCode} 市盈率 HTTP ${res.status}`);
  const j = (await res.json()) as { data?: { tradeDate?: string; peg?: number }[] };
  const rows = (j.data ?? []).filter(
    (r): r is { tradeDate: string; peg: number } =>
      typeof r.tradeDate === "string" && /^\d{8}$/.test(r.tradeDate) && typeof r.peg === "number" && Number.isFinite(r.peg) && r.peg > 0,
  );
  if (rows.length === 0) throw new Error(`中证官网 ${csiCode} 市盈率结构变化（无可用行）`);
  rows.sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : 1));
  const byMonth = new Map<string, Pt>();
  for (const r of rows) {
    const date = `${r.tradeDate.slice(0, 4)}-${r.tradeDate.slice(4, 6)}-${r.tradeDate.slice(6, 8)}`;
    byMonth.set(date.slice(0, 7), { date, value: Math.round(r.peg * 100) / 100, volume: null });
  }
  return [...byMonth.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** S&P 500 TTM PE, monthly, from Multpl's embedded chart series
 *  (verified 2026-11-20): the page
 *  https://www.multpl.com/s-p-500-pe-ratio embeds
 *  `let pi = [[epochDay, ...], [pe, ...]]` — 1872 month-1st points
 *  1871-01-01 → now plus a live current point dated today (last value
 *  24.46 on 2026-11-19, matching the page's "Current S&P 500 PE Ratio
 *  is 24.46"). Cross-checked against Shiller's Yale file before
 *  landing: 1830 overlapping months, mean/median diff 0.00, max
 *  |diff| 0.065 — the two are the same series; Multpl continues it
 *  live while Shiller's file is frozen at 2023-09. Tail mode filters
 *  the (always full) embedded array to points >= tail, so a refresh
 *  only ever stores the last ~3 months + the live point. */
async function fetchMultplSp500Pe(tail: string | null): Promise<Pt[]> {
  const res = await fetch("https://www.multpl.com/s-p-500-pe-ratio", {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Multpl S&P 500 PE HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/let pi = \[\[([-\d,\s]+)\], \[([\d.,\s]+)\]/);
  if (!m) throw new Error("Multpl S&P 500 PE 结构变化（未找到嵌入序列）");
  const xs = m[1]?.split(",").map((s) => Number(s.trim())) ?? [];
  const ys = m[2]?.split(",").map((s) => Number(s.trim())) ?? [];
  if (xs.length !== ys.length || xs.length < 1000) throw new Error(`Multpl S&P 500 PE 点数异常（${xs.length}）`);
  const pts: Pt[] = [];
  for (let i = 0; i < xs.length; i++) {
    const day = xs[i];
    const pe = ys[i];
    if (day === undefined || pe === undefined || !Number.isFinite(day) || !Number.isFinite(pe)) continue;
    // Upper bound 200 (was 60): the 2008–09 crisis pushed S&P 500 TTM
    // PE above 60 for 9 months (peak ~123 in May 2009) because earnings
    // collapsed — those are real history, not bad data. A 60 cap
    // silently dropped all 9 (seed stored 1863 of Multpl's 1872).
    if (pe < 3 || pe > 200) continue;
    const date = new Date(Date.UTC(1970, 0, 1) + day * 86400000).toISOString().slice(0, 10);
    pts.push({ date, value: Math.round(pe * 100) / 100, volume: null });
  }
  pts.sort((a, b) => (a.date < b.date ? -1 : 1));
  const first = pts[0]?.date;
  const last = pts[pts.length - 1];
  if (first !== "1871-01-01" || !last) throw new Error("Multpl S&P 500 PE 序列起止异常");
  const todayBj = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const ageDays = (Date.parse(`${todayBj}T00:00:00Z`) - Date.parse(`${last.date}T00:00:00Z`)) / 86400000;
  if (ageDays > 45) throw new Error(`Multpl S&P 500 PE 末点过旧（${last.date}）`);
  return tail ? pts.filter((p) => p.date >= tail) : pts;
}

/** S&P 500 CAPE, monthly, from Shiller's Yale file
 *  (http://www.econ.yale.edu/~shiller/data/ie_data.xls, Data sheet:
 *  col A = YYYY.MM float, col M = CAPE). The file is FROZEN — last
 *  saved 2023-09-17, CAPE ends 2023-09-01, earnings 2023-06 — so this
 *  fetcher stores history only: it never throws for staleness, and
 *  the caller labels the frozen tail (see stagePe's capeNote). */
async function fetchShillerCape(tail: string | null): Promise<Pt[]> {
  const res = await fetch("http://www.econ.yale.edu/~shiller/data/ie_data.xls", {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Shiller Yale 文件 HTTP ${res.status}`);
  const pts = parseShillerCape(new Uint8Array(await res.arrayBuffer()));
  return tail ? pts.filter((p) => p.date >= tail) : pts;
}

/** Extract the CAPE column from Shiller's Data sheet. The sheet's
 *  date column is a YYYY.MM float (e.g. 2023.09), which
 *  parseBiffColumn cannot read — this walks the grid returned by
 *  parseBiffTable(buf, "Data") instead. Verified 2026-11-20 against
 *  the live file: the sheet carries 1833 dated rows (1871-01 →
 *  2023-09), of which 1713 have a numeric CAPE — 1881-01-01 →
 *  2023-09-01, last 30.81; 1871–1880 are the string "NA" (CAPE
 *  needs ten years of earnings). The header search is anchored on
 *  the row whose first cell is "Date": the sheet's multi-line title
 *  block contains other "CAPE" strings (e.g. "TR CAPE") in earlier
 *  rows, and taking the first match lands on the wrong column. */
function parseShillerCape(buf: Uint8Array): Pt[] {
  const grid = parseBiffTable(buf, "Data");
  let headerRow = -1;
  let capeCol = -1;
  for (let r = 0; r < grid.length && headerRow < 0; r++) {
    const row = grid[r] ?? [];
    if (typeof row[0] !== "string" || (row[0] as string).trim() !== "Date") continue;
    for (let c = 0; c < row.length; c++) {
      if (typeof row[c] === "string" && (row[c] as string).trim().toUpperCase() === "CAPE") {
        headerRow = r;
        capeCol = c;
        break;
      }
    }
  }
  if (headerRow < 0 || capeCol < 0) throw new Error("Shiller 文件结构变化（未找到 CAPE 列）");
  const pts: Pt[] = [];
  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const ym = row[0];
    const cape = row[capeCol];
    if (typeof ym !== "number" || typeof cape !== "number" || !(cape > 0)) continue;
    const y = Math.floor(ym);
    const mo = Math.round((ym - y) * 100);
    if (y < 1871 || mo < 1 || mo > 12) continue;
    pts.push({ date: `${y}-${String(mo).padStart(2, "0")}-01`, value: Math.round(cape * 100) / 100, volume: null });
  }
  pts.sort((a, b) => (a.date < b.date ? -1 : 1));
  if (pts.length < 1500 || pts[0]?.date !== "1881-01-01") throw new Error(`Shiller CAPE 点数/起止异常（${pts.length} 点）`);
  return pts;
}

/** Hang Seng TTM + forward PE, annual points, from Siblis Research
 *  (verified 2026-11-20): the page
 *  https://siblisresearch.com/data/hang-seng-cape/ carries two HTML
 *  tables — a latest-month comparison (Oct 2026: TTM 11.71 / forward
 *  9.56 / CAPE 9.60) and a year-end history (Dec 2016 → Dec 2025).
 *  The monthly series itself is NOT exposed (paywalled database),
 *  so this returns ANNUAL points only: 11 rows (2016-12-01 →
 *  2025-12-01 + 2026-10-01). NEVER feed these points to
 *  peStatsFromPoints — a 5y window of annual points is 6 < the
 *  8-point floor. `which` selects the column: "ttm" (col 2) or
 *  "forward" (col 3). Cross-check (not mixed in): Hang Seng's own
 *  monthly factsheet PDF prints PE 13.04 as at 2026-10-30 — a
 *  different methodology, ~11% above Siblis 11.71, so the card
 *  shows Siblis only. */
async function fetchSiblisHsiAnnual(which: "ttm" | "forward"): Promise<Pt[]> {
  const res = await fetch("https://siblisresearch.com/data/hang-seng-cape/", {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Siblis 恒生 PE HTTP ${res.status}`);
  const html = await res.text();
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]);
  // The page carries TWO matching tables: a transposed latest-month
  // comparison (Measure × Oct 2026 / Oct 2025) and the year-end
  // history (Month × Trailing P/E / Forward P/E / CAPE). The history
  // table is the one with the most rows — picking the first match
  // lands on the comparison table and parses 0 points (verified
  // 2026-11-20 against the live page).
  const candidates = tables.filter((t) => /Trailing P\/E/i.test(t) && /CAPE/i.test(t));
  const table = candidates.sort((a, b) => (b.match(/<tr/gi)?.length ?? 0) - (a.match(/<tr/gi)?.length ?? 0))[0];
  if (!table) throw new Error("Siblis 恒生 PE 年度表结构变化（未找到历史表）");
  const rows = [...table.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) => m[0]);
  const col = which === "ttm" ? 1 : 2; // 0 = Month, 1 = Trailing P/E, 2 = Forward P/E
  const months: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
  const pts: Pt[] = [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => (m[1] ?? "").replace(/<[^>]+>/g, "").trim());
    if (cells.length < 3) continue;
    const label = cells[0] ?? "";
    const m1 = label.match(/^([A-Za-z]{3}) (\d{4})$/);
    const m2 = label.match(/^(\d{4}) ([A-Za-z]{3})$/);
    const mon = m1 ? months[m1[1] as string] : m2 ? months[m2[2] as string] : undefined;
    const year = m1 ? m1[2] : m2 ? m2[1] : undefined;
    if (!mon || !year) continue;
    const v = Number((cells[col] ?? "").replace(/,/g, ""));
    if (!Number.isFinite(v) || v < 3 || v > 80) continue;
    pts.push({ date: `${year}-${mon}-01`, value: Math.round(v * 100) / 100, volume: null });
  }
  pts.sort((a, b) => (a.date < b.date ? -1 : 1));
  if (pts.length < 8) throw new Error(`Siblis 恒生 PE 年度点不足（${pts.length}）`);
  const last = pts[pts.length - 1];
  if (!last || last.date < "2026-01-01") throw new Error(`Siblis 恒生 PE 末点过旧（${last?.date ?? "无"}）`);
  return pts;
}

/** Nasdaq-100 TTM PE, annual points, from Siblis Research
 *  (verified 2026-11-20, B1): the page
 *  https://siblisresearch.com/data/nasdaq-100-pe-ratio/ carries two
 *  tables — a latest-month comparison (Oct 2026: TTM 32.76 /
 *  forward 21.24 / CAPE 54.12) and a year-end history (Dec 2016 →
 *  Dec 2025 + latest month Oct 2026). The monthly series itself is
 *  NOT exposed (paywalled database), so this returns ANNUAL points
 *  only: 11 rows (2016-12-01 → 2026-10-01). NEVER feed these points
 *  to peStatsFromPoints — a 5y window of annual points is 6 < the
 *  8-point floor. Column 3 (index 2) of the history table is the
 *  NASDAQ 100 TTM; "Negative" appears only in other indices'
 *  columns, and any non-numeric cell is skipped. Validation runs on
 *  the FULL parsed set before tail filtering, so a tail refresh
 *  cannot trip the seed checks. Cross-check (not stored, never
 *  shown on the card): ChartRow's daily rebuilt aggregate 32.5
 *  (2026-11-19 close), -0.8% vs Siblis 32.76 — within 5%. */
async function fetchSiblisNdxAnnual(tail: string | null): Promise<Pt[]> {
  const res = await fetch("https://siblisresearch.com/data/nasdaq-100-pe-ratio/", {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Siblis 纳指 PE HTTP ${res.status}`);
  const html = await res.text();
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]);
  // The history table is the one whose HEADER row names "NASDAQ 100"
  // (Month × U.S. Large Cap × NASDAQ 100 × …); the latest-month
  // comparison table's header does not. Pick the most-rowed match
  // (same rule as the HSI fetcher's two-table fix).
  const candidates = tables.filter((t) => {
    const head = t.match(/<tr[\s\S]*?<\/tr>/i)?.[0] ?? "";
    return /NASDAQ 100/i.test(head);
  });
  const table = candidates.sort((a, b) => (b.match(/<tr/gi)?.length ?? 0) - (a.match(/<tr/gi)?.length ?? 0))[0];
  if (!table) throw new Error("Siblis 纳指 PE 年度表结构变化（未找到历史表）");
  const rows = [...table.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) => m[0]);
  const months: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
  const pts: Pt[] = [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => (m[1] ?? "").replace(/<[^>]+>/g, "").trim());
    if (cells.length < 3) continue;
    const label = cells[0] ?? "";
    const m1 = label.match(/^([A-Za-z]{3}) (\d{4})$/);
    const m2 = label.match(/^(\d{4}) ([A-Za-z]{3})$/);
    const mon = m1 ? months[m1[1] as string] : m2 ? months[m2[2] as string] : undefined;
    const year = m1 ? m1[2] : m2 ? m2[1] : undefined;
    if (!mon || !year) continue;
    const v = Number((cells[2] ?? "").replace(/,/g, ""));
    if (!Number.isFinite(v) || v < 5 || v > 80) continue;
    pts.push({ date: `${year}-${mon}-01`, value: Math.round(v * 100) / 100, volume: null });
  }
  pts.sort((a, b) => (a.date < b.date ? -1 : 1));
  if (pts.length < 8) throw new Error(`Siblis 纳指 PE 年度点不足（${pts.length}）`);
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first?.date !== "2016-12-01" || first?.value !== 23.08 || last?.date !== "2026-10-01" || last?.value !== 32.76) {
    throw new Error(`Siblis 纳指 PE 年度表结构变化（首点 ${first?.date}/${first?.value}，末点 ${last?.date}/${last?.value}）`);
  }
  return tail ? pts.filter((p) => p.date >= tail) : pts;
}

type PeHistStats = { current: number; percentile: number; median: number; n: number; firstDate: string; lastDate: string; cadence: string; source: string };

/** Historical PE percentile over the trailing 5 years of month-end
 *  points, ending at the series' own last point: percentile = share of
 *  window points strictly below the current PE (the peHistoryStats
 *  convention). Null below the 8-point sample floor — callers then
 *  show no PE row rather than an estimate. Shared by the instrument
 *  cards and the decision signals so the two can never disagree. */
function peStatsFromPoints(pts: Pt[]): Omit<PeHistStats, "cadence" | "source"> | null {
  const sorted = [...pts].filter((p) => p.value > 0).sort((a, b) => (a.date < b.date ? -1 : 1));
  const last = sorted[sorted.length - 1];
  if (!last) return null;
  const cutoffDate = new Date(`${last.date}T00:00:00Z`);
  cutoffDate.setUTCFullYear(cutoffDate.getUTCFullYear() - 5);
  const cutoff = cutoffDate.toISOString().slice(0, 10);
  const win = sorted.filter((p) => p.date > cutoff);
  if (win.length < 8) return null;
  const vals = win.map((p) => p.value).sort((a, b) => a - b);
  const mid = Math.floor(vals.length / 2);
  const median = vals.length % 2 === 1 ? (vals[mid] ?? 0) : ((vals[mid - 1] ?? 0) + (vals[mid] ?? 0)) / 2;
  const below = vals.filter((v) => v < last.value).length;
  return {
    current: Math.round(last.value * 100) / 100,
    percentile: Math.round((below / vals.length) * 100),
    median: Math.round(median * 100) / 100,
    n: vals.length,
    firstDate: win[0]?.date ?? "",
    lastDate: last.date,
  };
}

/** Exchange turnover （成交额） from Eastmoney push2his index klines:
 *  fields f51..f57, last field = 成交额 (yuan). Stored in 亿元. Uses the
 *  same mirror-host retry pattern as the repo fetcher. */
async function fetchTurnover(tailFrom?: string | null): Promise<Map<string, Pt[]>> {
  const map = new Map<string, Pt[]>();
  const jobs: [string, string][] = [
    ["sseamt", "1.000001"],
    ["szamt", "0.399001"],
  ];
  const beg = new Date();
  beg.setFullYear(beg.getFullYear() - 10);
  const begStr = tailFrom
    ? tailFrom.replace(/-/g, "")
    : `${beg.getFullYear()}${String(beg.getMonth() + 1).padStart(2, "0")}${String(beg.getDate()).padStart(2, "0")}`;
  const hosts = ["push2his.eastmoney.com", "82.push2his.eastmoney.com", "48.push2his.eastmoney.com", "61.push2his.eastmoney.com", "91.push2his.eastmoney.com", "7.push2his.eastmoney.com"];
  for (const [key, secid] of jobs) {
    let pts: Pt[] | null = null;
    let lastErr: unknown = null;
    for (const host of hosts) {
      if (pts) break;
      for (let attempt = 0; attempt < 3 && !pts; attempt++) {
        try {
          const url = `https://${host}/api/qt/stock/kline/get?secid=${secid}&fields1=f1&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=0&beg=${begStr}&end=20500101`;
          const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(12000) });
          if (!res.ok) throw new Error(`push2his ${secid} HTTP ${res.status}`);
          const json = (await res.json()) as { data?: { klines?: string[] } };
          const klines = json.data?.klines;
          if (!klines || klines.length === 0) throw new Error(`push2his ${secid} 结构变化`);
          const parsed: Pt[] = [];
          for (const line of klines) {
            const parts = line.split(",");
            const date = parts[0] ?? "";
            const amt = parts[6] ? Number.parseFloat(parts[6]) : NaN;
            if (date && Number.isFinite(amt)) parsed.push({ date, value: amt / 1e8, volume: null });
          }
          parsed.sort((a, b) => (a.date < b.date ? -1 : 1));
          pts = parsed;
        } catch (e) {
          lastErr = e;
        }
      }
    }
    if (!pts) throw lastErr instanceof Error ? lastErr : new Error(`push2his ${secid} 拉取失败`);
    map.set(key, pts);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Eastmoney push2his — second source for the Yahoo ETF hole (2026-11-19).
// Yahoo's chart API returned close=null for 2026-11-18 on every listed-ETF
// symbol (.SS / .SZ / .HK) while the index symbols on the same exchanges
// came through fine, so the stored ETF series silently skipped a trading
// day and computeInstrument's "今日" change became a two-day cumulative
// move (510300 showed the 11-17→11-19 change instead of 11-19's own
// +0.05%). The next refresh's overlap window does NOT heal this — Yahoo
// keeps returning null for that date — so stagePrices runs the fill below
// after its Yahoo stores: the same push2his kline channel the repo /
// turnover fetchers already use supplies the missing closes, inserted
// only where the stored series has a hole (existing Yahoo points are
// never overwritten). Dates neither source can supply stay missing on
// purpose: they are reported as 序列缺日 warnings in the stage result
// (→ refresh_log), and computeInstrument marks the day change as missing
// instead of spanning the hole.
// ---------------------------------------------------------------------------

/** Yahoo symbol → Eastmoney secid (1 = Shanghai, 0 = Shenzhen,
 *  116 = Hong Kong, code zero-padded to five digits). */
function emSecidForSymbol(symbol: string): string | null {
  const m = /^(\d+)\.(SS|SZ|HK)$/.exec(symbol);
  if (!m) return null;
  const code = m[1] ?? "";
  if (m[2] === "SS") return `1.${code}`;
  if (m[2] === "SZ") return `0.${code}`;
  return `116.${code.padStart(5, "0")}`;
}

/** ETF-proxy series: a listed ETF tracked through a Yahoo symbol. The
 *  two index series with the same suffix shape (sse = 000001.SS,
 *  szcomp = 399001.SZ) are not ETFs — Yahoo serves their closes fine,
 *  they stay untouched, and they double as the trading calendars the
 *  gap check reads. */
function isEtfProxy(cfg: PriceCfg): boolean {
  return cfg.key !== "sse" && cfg.key !== "szcomp" && emSecidForSymbol(cfg.symbol) != null;
}

/** Daily closes for one ETF from Eastmoney push2his kline (fqt=0,
 *  unadjusted — the same basis as Yahoo's chart closes; verified against
 *  Yahoo on overlapping days: 510300 2026-11-17/19 match to the third
 *  decimal, 588000 likewise). A-share kline volume is in 手 (100-share
 *  lots) and is scaled to shares (510300: EM 27,909,417 手 = Yahoo's
 *  2,790,941,681 shares ✓); HK volume is already shares. Mirror hosts
 *  with retries, same pattern as fetchTurnover — the bare host
 *  intermittently resets connections from this egress. */
async function fetchEmEtfKline(cfg: PriceCfg, begStr: string): Promise<Pt[]> {
  const secid = emSecidForSymbol(cfg.symbol);
  if (!secid) return [];
  const hosts = ["push2his.eastmoney.com", "82.push2his.eastmoney.com", "48.push2his.eastmoney.com", "61.push2his.eastmoney.com", "91.push2his.eastmoney.com", "7.push2his.eastmoney.com"];
  const volScale = cfg.symbol.endsWith(".HK") ? 1 : 100;
  let pts: Pt[] | null = null;
  let lastErr: unknown = null;
  for (const host of hosts) {
    if (pts) break;
    for (let attempt = 0; attempt < 2 && !pts; attempt++) {
      try {
        const url = `https://${host}/api/qt/stock/kline/get?secid=${secid}&fields1=f1&fields2=f51,f53,f56&klt=101&fqt=0&beg=${begStr}&end=20500101`;
        const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(12000) });
        if (!res.ok) throw new Error(`push2his ${secid} HTTP ${res.status}`);
        const json = (await res.json()) as { data?: { klines?: string[] } };
        const klines = json.data?.klines;
        if (!klines || klines.length === 0) throw new Error(`push2his ${secid} 结构变化`);
        const parsed: Pt[] = [];
        for (const line of klines) {
          const parts = line.split(",");
          const date = parts[0] ?? "";
          const close = parts[1] ? Number.parseFloat(parts[1]) : NaN;
          const vol = parts[2] ? Number.parseFloat(parts[2]) : NaN;
          if (date && Number.isFinite(close)) {
            parsed.push({ date, value: close, volume: Number.isFinite(vol) ? vol * volScale : null });
          }
        }
        parsed.sort((a, b) => (a.date < b.date ? -1 : 1));
        pts = parsed;
      } catch (e) {
        lastErr = e;
      }
    }
  }
  if (!pts) throw lastErr instanceof Error ? lastErr : new Error(`push2his ${secid} 拉取失败`);
  return pts;
}

/** Insert points only where the series has no row for that date yet
 *  (the (series_key, date) unique index arbitrates) — a second-source
 *  fill must never overwrite the primary source's values. */
async function insertMissingPoints(ctx: Ctx, key: string, pts: Pt[]): Promise<number> {
  if (pts.length === 0) return 0;
  const db = ctx.db<typeof schema>();
  let inserted = 0;
  const CHUNK = 400;
  for (let i = 0; i < pts.length; i += CHUNK) {
    const chunk = pts.slice(i, i + CHUNK);
    const rows = await db
      .insert(schema.seriesPoints)
      .values(chunk.map((p) => ({ seriesKey: key, date: p.date, value: p.value, volume: p.volume, partial: p.partial ? 1 : 0 })))
      .onConflictDoNothing()
      .returning({ id: schema.seriesPoints.id });
    inserted += rows.length;
  }
  return inserted;
}

/** Fill Yahoo's missing ETF days from Eastmoney and report whatever is
 *  still missing. "Missing" is judged against the exchange's own index
 *  series (sse for A-share ETFs, hsi for HK ETFs), which Yahoo serves
 *  without holes: any index trading day inside the ETF's stored range
 *  that the ETF series lacks is a hole. Only the recent window is
 *  audited (~150 days behind each series' tail) — that is where a hole
 *  corrupts the "今日" change and the short moving averages. Note the
 *  prices stage's Yahoo store replaces its overlap window on every
 *  refresh, which would re-delete a previously filled point (Yahoo
 *  still returns null for it) — running this fill after every store is
 *  what makes the repair stick. */
async function fillEtfGaps(
  ctx: Ctx,
  hkSnap?: { today: string; beforeClose: boolean },
): Promise<{ filled: number; warnings: string[]; hkPartialNames: string[] }> {
  const db = ctx.db<typeof schema>();
  // One HK session judgment for the whole fill, shared with the Yahoo
  // path via the caller's per-round snapshot — re-sampling the clock
  // per ETF job (the old shape) let a job running after the boundary
  // insert today's intraday bar unflagged while its siblings were
  // flagged (the 3067 miss, 2026-11-19).
  const hkShared = hkSnap ?? hkSession();
  const coverage = await seriesCoverage(ctx);
  const calStart = shiftDateStr(new Date().toISOString().slice(0, 10), -220);
  const loadCal = async (key: string): Promise<string[]> => {
    const rows = await db
      .select({ date: schema.seriesPoints.date })
      .from(schema.seriesPoints)
      .where(and(eq(schema.seriesPoints.seriesKey, key), gte(schema.seriesPoints.date, calStart)))
      .orderBy(asc(schema.seriesPoints.date));
    return rows.map((r) => r.date);
  };
  const calendars: Record<string, string[]> = { sse: await loadCal("sse"), hsi: await loadCal("hsi") };
  const jobs = PRICE_SERIES.filter(isEtfProxy).map(async (cfg) => {
    const cal = calendars[cfg.asset === "hk" ? "hsi" : "sse"] ?? [];
    const maxDate = coverage.get(cfg.key)?.maxDate;
    if (!maxDate || cal.length === 0) return { filled: 0, warning: null as string | null, hkPartial: null as string | null };
    const winStart = shiftDateStr(maxDate, -150);
    const rows = await db
      .select()
      .from(schema.seriesPoints)
      .where(and(eq(schema.seriesPoints.seriesKey, cfg.key), gte(schema.seriesPoints.date, winStart)))
      .orderBy(asc(schema.seriesPoints.date));
    if (rows.length === 0) return { filled: 0, warning: null as string | null, hkPartial: null as string | null };
    const have = new Set(rows.map((r) => r.date));
    const firstDate = rows[0]?.date ?? maxDate;
    const calLast = cal[cal.length - 1] ?? maxDate;
    const bound = calLast > maxDate ? calLast : maxDate;
    const holes = cal.filter((d) => d >= firstDate && d <= bound && !have.has(d));
    let filledHere = 0;
    let hkPartial: string | null = null;
    if (holes.length > 0) {
      let emPts: Pt[] = [];
      try {
        emPts = await fetchEmEtfKline(cfg, winStart.replace(/-/g, ""));
      } catch {
        emPts = [];
      }
      const holeSet = new Set(holes);
      // An Eastmoney bar filled in for TODAY before the HK close is
      // final is an intraday snapshot too — same partial flag as the
      // Yahoo path, judged by the round's shared session snapshot.
      const hk = cfg.asset === "hk" ? hkShared : null;
      const fill = emPts
        .filter((p) => holeSet.has(p.date))
        .map((p) => (hk && hk.beforeClose && p.date === hk.today ? { ...p, partial: true } : p));
      if (fill.some((p) => p.partial)) hkPartial = cfg.name;
      filledHere = await insertMissingPoints(ctx, cfg.key, fill);
      for (const p of fill) have.add(p.date);
    }
    const remaining = holes.filter((d) => !have.has(d));
    return {
      filled: filledHere,
      hkPartial,
      warning:
        remaining.length > 0
          ? `${cfg.name}：序列缺 ${remaining.join("、")} 收盘价（Yahoo 缺日、东财 push2his 未补齐），当日涨跌暂缺`
          : null,
    };
  });
  const results = await Promise.all(jobs);
  return {
    filled: results.reduce((a, r) => a + r.filled, 0),
    warnings: results.map((r) => r.warning).filter((w): w is string => w != null),
    hkPartialNames: results.map((r) => r.hkPartial).filter((w): w is string => w != null),
  };
}

// ---------------------------------------------------------------------------
// Calendar sources: Faireconomy weekly JSON (near-term macro releases with
// forecast/previous), Federal Reserve FOMC schedule page, Nasdaq earnings.
// ---------------------------------------------------------------------------

type CalRow = {
  date: string;
  timeText: string;
  title: string;
  category: string;
  impact: string;
  forecast: string;
  previous: string;
  explain: string;
  watch: string;
  source: string;
};

/** Convert an America/New_York wall-clock time to a Beijing label. */
function etToBj(dateStr: string, hh: number, mm: number): { date: string; timeText: string } {
  // EDT (UTC-4) runs from the 2nd Sunday of March to the 1st Sunday of
  // November; otherwise EST (UTC-5). Beijing is UTC+8 year-round.
  const [y = 2026, m = 1, d = 1] = dateStr.split("-").map(Number);
  const nthSunday = (year: number, month: number, n: number) => {
    const first = new Date(Date.UTC(year, month - 1, 1));
    const offset = (7 - first.getUTCDay()) % 7;
    return 1 + offset + (n - 1) * 7;
  };
  const afterStart = m > 3 || (m === 3 && d >= nthSunday(y, 3, 2));
  const beforeEnd = m < 11 || (m === 11 && d < nthSunday(y, 11, 1));
  const etOffset = afterStart && beforeEnd ? -4 : -5;
  const utcMs = Date.UTC(y, m - 1, d, hh - etOffset, mm);
  const bj = new Date(utcMs + 8 * 3600 * 1000);
  const bjDate = bj.toISOString().slice(0, 10);
  const bjTime = `${String(bj.getUTCHours()).padStart(2, "0")}:${String(bj.getUTCMinutes()).padStart(2, "0")}`;
  return { date: bjDate, timeText: `${bjTime}（北京时间）` };
}

function bjToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

// US federal holidays for a year (OPM schedule), as a set of YYYY-MM-DD.
// Fixed-date holidays come with their observed shift (Fri before when the
// date lands on Saturday, Mon after when on Sunday); the floating ones
// are computed by rule (MLK / Washington / Memorial / Labor / Columbus /
// Thanksgiving). Dec 24 is added when Christmas Day falls on a Friday:
// in that configuration the federal government closes on Christmas Eve by
// executive order (2020 precedent) and the Labor Department brings the
// Thursday releases (jobless claims) forward to Wednesday that week.
function usFederalHolidays(year: number): Set<string> {
  const fmt = (m: number, d: number) => `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const shiftDay = (dstr: string, n: number) => new Date(new Date(`${dstr}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
  const out = new Set<string>();
  const addWithObserved = (m: number, d: number) => {
    const ds = fmt(m, d);
    out.add(ds);
    const dow = new Date(`${ds}T00:00:00Z`).getUTCDay();
    if (dow === 6) out.add(shiftDay(ds, -1));
    if (dow === 0) out.add(shiftDay(ds, 1));
  };
  addWithObserved(1, 1); // New Year's Day
  addWithObserved(6, 19); // Juneteenth
  addWithObserved(7, 4); // Independence Day
  addWithObserved(11, 11); // Veterans Day
  addWithObserved(12, 25); // Christmas Day
  const nthDow = (m: number, dow: number, n: number): string => {
    for (let d = 1; d <= 31; d++) {
      const ds = fmt(m, d);
      const dt = new Date(`${ds}T00:00:00Z`);
      if (dt.getUTCMonth() !== m - 1) break;
      if (dt.getUTCDay() === dow) {
        n--;
        if (n === 0) return ds;
      }
    }
    return "";
  };
  const lastDow = (m: number, dow: number): string => {
    let found = "";
    for (let d = 1; d <= 31; d++) {
      const ds = fmt(m, d);
      const dt = new Date(`${ds}T00:00:00Z`);
      if (dt.getUTCMonth() !== m - 1) break;
      if (dt.getUTCDay() === dow) found = ds;
    }
    return found;
  };
  for (const ds of [nthDow(1, 1, 3), nthDow(2, 1, 3), lastDow(5, 1), nthDow(9, 1, 1), nthDow(10, 1, 2), nthDow(11, 4, 4)]) {
    if (ds) out.add(ds);
  }
  if (new Date(`${fmt(12, 25)}T00:00:00Z`).getUTCDay() === 5) out.add(fmt(12, 24));
  return out;
}

// China statutory holidays and 调休 workdays by year, per the State
// Council's published annual schedules (2027 arrangement: 国办发明电
// 〔2026〕10号, issued 2026-11-05, cross-checked against the Xinhua full
// text; 2026 arrangement per the same annual notice series). Ranges are
// inclusive [start, end] MM-DD pairs within the year.
const CN_HOLIDAY_RANGES: Record<number, [string, string][]> = {
  2026: [["01-01", "01-03"], ["02-15", "02-23"], ["04-04", "04-06"], ["05-01", "05-05"], ["06-19", "06-21"], ["09-25", "09-27"], ["10-01", "10-07"]],
  2027: [["01-01", "01-03"], ["02-05", "02-13"], ["04-03", "04-05"], ["05-01", "05-05"], ["06-09", "06-09"], ["09-15", "09-15"], ["10-01", "10-07"]],
};
// 调休上班日： weekend days the State Council designates as workdays.
const CN_EXTRA_WORKDAYS: Record<number, string[]> = {
  2026: ["01-04", "02-14", "02-28", "05-09", "09-20", "10-10"],
  2027: ["01-31", "02-14", "05-08", "09-26", "10-09"],
};

function cnIsWorkday(dstr: string): boolean {
  const year = Number(dstr.slice(0, 4));
  const md = dstr.slice(5);
  if ((CN_EXTRA_WORKDAYS[year] ?? []).includes(md)) return true;
  for (const [s, e] of CN_HOLIDAY_RANGES[year] ?? []) {
    if (md >= s && md <= e) return false;
  }
  const dow = new Date(`${dstr}T00:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6;
}

/** Move a date forward to the next China workday (weekend- and statutory-
 * holiday-aware; 调休 workdays count as workdays). */
function cnShiftToWorkday(dstr: string): string {
  let d = dstr;
  for (let i = 0; i < 15 && !cnIsWorkday(d); i++) {
    d = new Date(new Date(`${d}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);
  }
  return d;
}

// Keyword dictionary: English calendar title → Chinese name + plain-language
// explanation + what to watch. Fixed editorial copy; the dates/values come
// from the feeds. `only` scopes an entry to one feed country: the same
// English title means different releases in the USD and CNY feeds (e.g.
// "Unemployment Rate", "Industrial Production", "CPI y/y"), and matching
// country-blind put China's surveyed unemployment into the US bucket.
type DictEntry = { match: string[]; title: string; category: string; explain: string; watch: string; only?: "USD" | "CNY" };
const EVENT_DICT: DictEntry[] = [
  { match: ["Non-Farm", "Nonfarm", "Employment Change"], title: "美国非农就业报告", category: "美国数据", explain: "美国劳工部每月公布上个月新增了多少工作岗位（不含农业），是判断美国经济冷热最重要的一张表。就业强 = 消费有底气，但也意味着美联储不急着降息。", watch: "看三个数：新增就业 vs 预期、失业率、平均时薪增速。时薪涨太快会推高通胀，美联储最盯这个。" },
  { match: ["Unemployment Rate"], title: "美国失业率", category: "美国数据", only: "USD", explain: "有多少劳动力想工作却没工作。失业率快速上升是衰退的经典信号，美联储降息往往跟着它走。", watch: "看是否连续上升、是否触发“萨姆规则”（3 个月均值比一年低点高 0.5 个百分点）。" },
  { match: ["Unemployment Rate"], title: "中国城镇调查失业率", category: "中国数据", only: "CNY", explain: "统计局调查的城镇失业率，和工业、投资、消费数据同日发布。5.5% 左右是政策合意区间上沿，青年失业率是单列的敏感分项。", watch: "看是否连续高于 5.5%、以及毕业季（6–8 月）的季节性冲高幅度；它和社零、工业一起读，才是完整的中国月度经济图。" },
  { match: ["Fixed Asset Investment"], title: "中国固定资产投资", category: "中国数据", only: "CNY", explain: "基建、房地产开发和制造业设备投资的总和，是中国“投资”这驾马车的月度刻度，和工业增加值、社零同日发布。", watch: "看三个分项谁在拖后腿：房地产开发投资降幅、基建增速、制造业投资（设备更新政策拉动）。民间投资转负是需求不足的强信号。" },
  { match: ["CPI"], title: "美国 CPI 消费者物价", category: "美国数据", only: "USD", explain: "老百姓买东西的价格涨了多少，就是通胀。CPI 超预期 = 美联储难降息，美债收益率和美元通常往上冲，股市承压。", watch: "重点看核心 CPI（去掉食品能源）环比：连续 ≥0.3% 说明通胀黏性强；降到 0.1–0.2% 是降息的绿灯。" },
  { match: ["PPI"], title: "美国 PPI 生产者物价", category: "美国数据", only: "USD", explain: "工厂出厂价格，相当于 CPI 的上游：PPI 先涨，企业成本上升，过几个月可能传导到消费者价格。", watch: "看核心 PPI 环比，以及它对 PCE（美联储更看重的通胀指标）的预示作用。" },
  { match: ["PCE"], title: "美国 PCE 物价 / 个人收入支出", category: "美国数据", explain: "PCE 是美联储官方最看重的通胀指标（目标 2% 就是它）。构成和权重与 CPI 不同，波动通常更小。", watch: "核心 PCE 环比是关键：这是决定降息节奏的头号数字，重要性不亚于 CPI。" },
  { match: ["Retail Sales"], title: "美国零售销售", category: "美国数据", only: "USD", explain: "美国人上个月在商店和网店花了多少钱。消费占美国 GDP 约七成，这个数直接反映经济的主引擎转速。", watch: "看“对照组”零售（剔除汽车、汽油、建材）——它直接进 GDP 核算。超预期强 = 经济韧性，降息预期后移。" },
  { match: ["GDP"], title: "美国 GDP", category: "美国数据", explain: "美国经济上个季度的总成绩单（年化环比）。初值、修正值、终值分三次公布，初值影响最大。", watch: "看消费分项和价格指数（GDP 价格平减）:增长强 + 价格高是最难受的组合（滞胀味道）。" },
  { match: ["ISM Manufacturing"], title: "美国 ISM 制造业 PMI", category: "美国数据", explain: "问卷调查制造业采购经理：订单、生产、库存是变好还是变差。50 是荣枯线，之上扩张、之下收缩。它是领先指标，比 GDP 早知道拐点。", watch: "看新订单分项（最领先）和价格分项（通胀压力）。跌破 48 进入衰退警戒区。" },
  { match: ["ISM Services", "ISM Non-Manufacturing"], title: "美国 ISM 服务业 PMI", category: "美国数据", explain: "服务业占美国经济八成，这个 PMI 才是美国经济的主体温计。同样 50 是荣枯线。", watch: "看商业活动和新订单分项；服务价格分项居高不下 = 服务通胀难降。" },
  { match: ["Jobless Claims", "Unemployment Claims"], title: "美国初请失业金人数", category: "美国数据", explain: "上周有多少人第一次申请失业救济，每周四公布，是频率最高的就业温度计。单周会跳动，看 4 周平均。", watch: "4 周均值是否趋势性爬升；续请人数创新高说明失业的人越来越难找工作。" },
  { match: ["Federal Funds Rate", "Fed Interest Rate", "FOMC Statement", "FOMC Press Conference"], title: "美联储议息决议", category: "美联储", explain: "美联储开会决定美元的“批发价格”（联邦基金利率）。决议本身、声明措辞和主席沃什（Warsh）的发布会，每一句都牵动全球资产。每季度一次的会议还带经济预测和点阵图。", watch: "三件套：①利率决定是否符合预期；②声明里对通胀/就业的措辞变化；③发布会上主席对经济前景与通胀的定调（沃什已取消前瞻指引，不再预告下一次会议的动作）。带点阵图的月份（3/6/9/12 月）多看一层：点阵图中位数往哪挪。" },
  { match: ["Manufacturing PMI", "Services PMI", "Composite PMI"], title: "中国 PMI", category: "中国数据", only: "CNY", explain: "官方 PMI 由统计局调查制造业/服务业采购经理，50 是荣枯线。每月最后一天发布制造业 PMI，是中国经济最早出的月度成绩单。", watch: "看新订单和生产分项、以及小型企业 PMI:订单回升比生产回升更领先；价格分项上行说明需求真的在回暖。" },
  { match: ["Chinese CPI", "China CPI", "CPI y/y"], title: "中国 CPI", category: "中国数据", only: "CNY", explain: "中国居民消费价格涨幅。中国这几年的主要矛盾不是通胀太高，而是需求偏弱、价格低迷，所以 CPI 偏低反而值得警惕（通缩压力）。", watch: "看核心 CPI（去食品能源）和 PPI 的剪刀差；食品里的猪肉价格是短期波动的主要来源。" },
  { match: ["Chinese PPI", "China PPI", "PPI y/y"], title: "中国 PPI", category: "中国数据", only: "CNY", explain: "工业品出厂价格，反映工业企业的定价权和利润空间。PPI 持续为负 = 企业在打价格战、利润被压缩。", watch: "看同比降幅是否收窄——PPI 转正通常对应工业企业利润和名义 GDP 的修复。" },
  { match: ["Money Supply", "M2", "New Loans", "Social Financing", "Aggregate Financing"], title: "中国社融 / M2 / 新增贷款", category: "中国数据", explain: "社会融资规模是“全社会借了多少钱”的总口径，M2 是广义货币供应量。这组数据看的是信用扩张的闸口开多大，是 A 股流动性的源头活水。", watch: "看社融存量同比增速的方向、新增贷款里居民中长期贷款（房贷）的冷热、M1 与 M2 的剪刀差（钱在活期账户躺着还是在花）。" },
  { match: ["Loan Prime Rate", "LPR"], title: "中国 LPR 报价", category: "中国数据", explain: "贷款市场报价利率，每月 20 日公布，房贷和企业贷款的定价锚。LPR 下调 = 借钱变便宜，是宽松政策最直接的落地动作之一。", watch: "看 1 年期和 5 年期是否对称下调：只降 5 年期是定向托房地产；两个都降是全面宽松信号。还要看它和 MLF 利率的先后关系。" },
  { match: ["Industrial Production"], title: "中国工业增加值 / 规模以上工业", category: "中国数据", only: "CNY", explain: "工厂生产的总量增速，和固定资产投资、社会消费品零售一起在每月中旬打包发布，是中国月度经济的“大礼包”。", watch: "和同日发布的投资、消费一起看：三驾马车谁在拖后腿，政策通常就托谁。" },
  { match: ["Industrial Production"], title: "美国工业生产", category: "美国数据", only: "USD", explain: "美联储发布的工厂、矿业和公用事业产出，是美国实体经济的月度体温计，重要性低于就业和通胀，但对周期股和能源需求有直接指引。", watch: "看制造业产出分项和产能利用率：利用率冲到 80% 以上通常伴随通胀压力，持续下滑则是制造业衰退的确认。" },
  { match: ["Retail Sales y/y", "Chinese Retail"], title: "中国社会消费品零售", category: "中国数据", only: "CNY", explain: "老百姓买东西的总金额增速，内需冷暖的直接刻度。", watch: "看餐饮 vs 商品零售、以及以旧换新品类（家电、汽车）的拉动是否在退坡。" },
  { match: ["OPEC"], title: "OPEC / OPEC+ 会议", category: "市场事件", explain: "产油国开会决定增产还是减产，直接定原油价格的方向。减产挺价、增产压价，通胀预期跟着动。", watch: "看产量配额的变化和成员国（尤其沙特、俄罗斯）的实际执行率；会后声明的措辞比决定本身更能预示下一次。" },
  { match: ["Bond Auction", "Note Auction", "Bill Auction"], title: "美国国债拍卖", category: "市场事件", explain: "美国财政部定期卖新国债。拍卖需求强不强（有没有“流拍”味道），直接影响美债收益率，进而影响全球资产定价。", watch: "看投标倍数和间接投标者（外国央行等）占比；10 年和 30 年拍卖疲软常引发收益率跳升和股市波动。" },
  { match: ["Durable Goods"], title: "美国耐用品订单", category: "美国数据", explain: "工厂接到的大件商品订单（飞机、汽车、设备），是企业投资意愿的先行指标，波动大。", watch: "看核心资本品订单（去飞机和国防），它直接对应企业设备投资。" },
  { match: ["Consumer Confidence", "Consumer Sentiment"], title: "美国消费者信心", category: "美国数据", explain: "问老百姓对经济和就业的感受。信心先于消费行动变化，是软数据的代表。", watch: "看预期分项和通胀预期分项；信心与实际消费背离时，以实际消费为准。" },
  { match: ["Trade Balance"], title: "中国进出口 / 贸易帐", category: "中国数据", explain: "出口是中国经济的三驾马车之一，进出口数据看外需冷暖和贸易顺差。", watch: "看出口同比（美元计价）和对美/对东盟/对欧盟的分项结构变化。" },
  { match: ["FOMC Meeting Minutes", "Meeting Minutes"], title: "FOMC 会议纪要", category: "美联储", explain: "议息会议的详细记录，惯例在会后三周发布。声明只有一页，纪要有几十页：委员们对通胀、就业和利率路径的真实分歧都写在里面，是决议之后最重要的校准材料。", watch: "看委员们对下一次会议的倾向分布：有多少人提“再降一次”、多少人担心通胀；纪要偏鹰/偏鸽常直接推动收益率几个基点。" },
  { match: ["Fed Chair", "Warsh", "Speaks", "Speech", "Testifies", "FOMC Member"], title: "美联储官员讲话", category: "美联储", explain: "决议之后，官员讲话是市场校准降息预期的主要材料。主席沃什（Warsh）和纽约联储主席（票委核心）的话最重，地方联储主席的话要看当年有没有投票权。一句话措辞变化就能让收益率跳几个基点。", watch: "听措辞偏鹰还是偏鸽、对通胀与就业的权重怎么摆；同一周多位官员口径一致 = 委员会共识在形成，口径打架 = 内部分歧大。" },
];

function dictFor(title: string, country?: string): DictEntry | null {
  const t = title.toLowerCase();
  for (const e of EVENT_DICT) {
    if (e.only && country && e.only !== country) continue;
    if (e.match.some((m) => t.includes(m.toLowerCase()))) return e;
  }
  return null;
}

async function fetchFaireconomy(): Promise<CalRow[]> {
  const out: CalRow[] = [];
  let filesOk = 0;
  for (const file of ["ff_calendar_thisweek.json", "ff_calendar_nextweek.json"]) {
    const res = await fetch(`https://nfs.faireconomy.media/${file}`, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (!res || !res.ok) continue; // nextweek file 404s in some weeks — not fatal
    filesOk++;
    const rows = (await res.json()) as { title?: string; country?: string; date?: string; impact?: string; forecast?: string; previous?: string }[];
    for (const r of rows) {
      if (!r.title || !r.date) continue;
      if (r.country !== "USD" && r.country !== "CNY") continue;
      const d = dictFor(r.title, r.country);
      const impact = r.impact ?? "";
      // Fed-member speeches are near-daily noise at Low impact; the ones
      // that move markets (the Chair, testimony) print Medium/High.
      if (d && d.title === "美联储官员讲话" && impact === "Low") continue;
      // Keep majors: dictionary-matched, or High impact USD/CNY events.
      if (!d && impact !== "High") continue;
      const when = new Date(r.date);
      if (Number.isNaN(when.getTime())) continue;
      const bjDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(when);
      const bjTime = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(when);
      out.push({
        date: bjDate,
        timeText: `${bjTime}（北京时间）`,
        title: d ? d.title : r.title,
        category: d ? d.category : r.country === "CNY" ? "中国数据" : "美国数据",
        impact,
        forecast: (r.forecast ?? "").trim(),
        previous: (r.previous ?? "").trim(),
        explain: d?.explain ?? "",
        watch: d?.watch ?? "",
        source: "经济日历源（Faireconomy）",
      });
    }
  }
  if (filesOk === 0) throw new Error("Faireconomy 两个周文件均不可达");
  return out;
}

async function fetchFomc(): Promise<CalRow[]> {
  const res = await fetch("https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`美联储官网 HTTP ${res.status}`);
  const html = await res.text();
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const out: CalRow[] = [];
  const months: Record<string, number> = {
    January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
    July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
  };
  const today = bjToday();
  for (const year of [Number(today.slice(0, 4)), Number(today.slice(0, 4)) + 1]) {
    const marker = `${year} FOMC Meetings`;
    const start = text.indexOf(marker);
    if (start < 0) continue;
    // Bound the slice at the NEXT year's section: a fixed 3000-char window
    // overruns into the following year's meeting list (and the page's
    // archive links), stamping next year's dates with this year and
    // producing phantom duplicate meetings (seen live: Dec 10 AND Dec 11).
    const rest = text.slice(start + marker.length);
    const nextMarker = rest.indexOf("FOMC Meetings");
    const section = rest.slice(0, nextMarker >= 0 ? nextMarker : 2400);
    const re = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})-(\d{1,2})/g;
    // Collect every date-range match first: whether a meeting is a normal
    // rate-decision meeting is decided by the text that follows its date
    // range (up to the next meeting's date range), not by the date itself.
    type RawMatch = { month: number; endDay: number; start: number; end: number };
    const rawMatches: RawMatch[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(section)) !== null) {
      rawMatches.push({ month: months[m[1] ?? ""] ?? 1, endDay: Number(m[3] ?? "1"), start: m.index, end: m.index + m[0].length });
    }
    let prevMonth = 0;
    let taken = 0;
    for (let i = 0; i < rawMatches.length; i++) {
      const cur = rawMatches[i];
      if (!cur) continue;
      if (taken >= 8) break; // a year has exactly 8 scheduled meetings
      const month = cur.month;
      if (month < prevMonth) continue; // trailing notes ("a two-day meeting is scheduled for January 25-26, 2028") are not this year's meetings
      prevMonth = month;
      taken++;
      const endDay = cur.endDay;
      const etDate = `${year}-${String(month).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`;
      const conv = etToBj(etDate, 14, 0);
      // The Fed's page can tag a meeting as a "Monetary Policy Strategy
      // Meeting" in the slot right after its date range (verified on the
      // live page for October 26-27, 2027: the marker sits in that
      // meeting's own row, before the next meeting's month). A strategy
      // meeting has NO rate vote, NO statement and NO press conference —
      // it must not become a 议息决议 card, and no +21d minutes card is
      // derived from it (the Fed has published no minutes plan for it).
      const next = rawMatches[i + 1];
      const tail = section.slice(cur.end, next ? next.start : section.length);
      if (/Monetary Policy Strategy Meeting|Strategy Meeting/i.test(tail)) {
        out.push({
          date: conv.date,
          timeText: "全天（美东时间，无决议发布）",
          title: "美联储战略会议（无利率决议、无声明）",
          category: "美联储",
          impact: "",
          forecast: "",
          previous: "",
          explain: "美联储官网把这次会议单列为“货币政策战略会议”（Monetary Policy Strategy Meeting）：只讨论货币政策战略框架，不进行利率投票、不发布决议声明，也没有会后发布会。这一年排了 8 次会议，但只有 7 次是真正的议息会议——这次不在其中。",
          watch: "别按议息会议等它：没有利率决定、没有声明三件套。看点在会后美联储是否发布战略框架相关的说明或文件；下一次真正的利率决议看下一场议息会议。",
          source: "美联储官网议息日程",
        });
        continue;
      }
      const withSep = [3, 6, 9, 12].includes(month);
      out.push({
        date: conv.date,
        timeText: conv.timeText,
        title: withSep ? "美联储议息决议 + 经济预测/点阵图" : "美联储议息决议",
        category: "美联储",
        impact: "High",
        forecast: "",
        previous: "",
        explain: "美联储开会决定美元的“批发价格”（联邦基金利率）。决议本身、声明措辞和美联储主席的发布会，每一句都牵动全球资产。" + (withSep ? "这次会议带经济预测摘要和点阵图——委员们对未来利率路径的集体投票，是全年最重要的利率指引之一。" : ""),
        watch: "三件套：①利率决定是否符合预期；②声明里对通胀/就业的措辞变化；③发布会上主席对经济前景与通胀的定调（沃什已取消前瞻指引，不再预告下一次会议的动作）。" + (withSep ? "点阵图多看一层：今年降息次数的中位数往哪挪。" : ""),
        source: "美联储官网议息日程",
      });
      // Minutes follow exactly three weeks after the meeting (14:00 ET) —
      // a fixed Fed convention, derived here and labelled as derived.
      const minEt = new Date(new Date(`${etDate}T00:00:00Z`).getTime() + 21 * 86400000).toISOString().slice(0, 10);
      const minConv = etToBj(minEt, 14, 0);
      out.push({
        date: minConv.date,
        timeText: minConv.timeText,
        title: "FOMC 会议纪要",
        category: "美联储",
        impact: "High",
        forecast: "",
        previous: "",
        explain: "议息会议的详细记录，惯例在会后三周发布（本条日期按此惯例由议息日推算）。声明只有一页，纪要有几十页：委员们对通胀、就业和利率路径的真实分歧都写在里面。",
        watch: "看委员们对下一次会议的倾向分布：有多少人提“再降一次”、多少人担心通胀；纪要偏鹰/偏鸽常直接推动收益率几个基点。",
        source: "美联储官网议息日程（纪要日期按会后三周惯例推算）",
      });
    }
  }
  return out;
}

// BEA's published release schedule (server-rendered table): exact dates for
// PCE and GDP ~5 weeks out — beyond the Faireconomy feed's 2-week window.
// BLS's own schedule pages return 403 to programmatic access, so CPI/PPI/NFP
// far dates stay convention estimates in getDashboard; PCE/GDP don't have to.
async function fetchBea(): Promise<CalRow[]> {
  const res = await fetch("https://www.bea.gov/news/schedule", { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!res || !res.ok) throw new Error(`BEA 日程页 HTTP ${res?.status ?? "不可达"}`);
  const html = await res.text();
  const out: CalRow[] = [];
  const months: Record<string, number> = {
    January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
    July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
  };
  const re = /release-date">([A-Za-z]+) (\d{1,2})<\/div>\s*<small[^>]*>(\d{1,2}):(\d{2})\s*(AM|PM)<\/small>[\s\S]{0,1500}?release-title[^>]*>([^<]+)<\/td>/g;
  const today = bjToday();
  let year = Number(today.slice(0, 4));
  let prevMonth = Number(today.slice(5, 7));
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const month = months[m[1] ?? ""] ?? 0;
    if (!month) continue;
    if (month < prevMonth) year++;
    prevMonth = month;
    const titleRaw = (m[6] ?? "").trim();
    const isPce = titleRaw.includes("Personal Income and Outlays");
    const isGdp = !isPce && titleRaw.includes("GDP") && !titleRaw.includes("by County");
    if (!isPce && !isGdp) continue;
    let hh = Number(m[3] ?? "8");
    const mins = Number(m[4] ?? "30");
    if (m[5] === "PM" && hh < 12) hh += 12;
    if (m[5] === "AM" && hh === 12) hh = 0;
    const etDate = `${year}-${String(month).padStart(2, "0")}-${String(Number(m[2] ?? "1")).padStart(2, "0")}`;
    const conv = etToBj(etDate, hh, mins);
    const d = dictFor(isPce ? "PCE Price Index" : "GDP");
    out.push({
      date: conv.date,
      timeText: conv.timeText,
      title: isPce ? "美国 PCE 物价 / 个人收入支出" : "美国 GDP",
      category: "美国数据",
      impact: "High",
      forecast: "",
      previous: "",
      explain: d?.explain ?? "",
      watch: d?.watch ?? "",
      source: "美国经济分析局（BEA）发布日程",
    });
  }
  return out;
}

const EARNINGS_WATCH: Record<string, string> = {
  AAPL: "苹果", MSFT: "微软", NVDA: "英伟达", AMZN: "亚马逊", GOOGL: "谷歌 Alphabet",
  META: "Meta", TSLA: "特斯拉", AVGO: "博通", AMD: "AMD", NFLX: "奈飞",
  BABA: "阿里巴巴", PDD: "拼多多", JD: "京东", BIDU: "百度", NTES: "网易",
  TCEHY: "腾讯（美股 OTC）", NIO: "蔚来", LI: "理想汽车", XPEV: "小鹏汽车", BILI: "哔哩哔哩",
};

async function fetchEarnings(): Promise<CalRow[]> {
  const out: CalRow[] = [];
  const days: string[] = [];
  // Start 3 days back: a US after-hours report lands the next Beijing
  // morning, and a scan that only looks forward permanently misses giants
  // that reported 1–2 days ago (NVDA on 2026-11-17 US was invisible to the
  // Nov-19 refresh). The read path keeps stored events back to −10 days,
  // so just-reported earnings still surface in the "已过去" section.
  const cursor = new Date(new Date(`${bjToday()}T00:00:00Z`).getTime() - 3 * 86400000);
  for (let i = 0; i < 66 && days.length < 48; i++) {
    const d = new Date(cursor.getTime() + i * 86400000);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) days.push(d.toISOString().slice(0, 10));
  }
  const fetchDay = async (dateStr: string) => {
    const res = await fetch(`https://api.nasdaq.com/api/calendar/earnings?date=${dateStr}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Accept: "application/json" },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) return;
    const json = (await res.json()) as { data?: { rows?: Record<string, string>[] } };
    for (const row of json.data?.rows ?? []) {
      const sym = row["symbol"] ?? "";
      const cn = EARNINGS_WATCH[sym];
      if (!cn) continue;
      const time = row["time"] ?? "";
      const slot = time.includes("pre") ? "美股盘前（北京当日傍晚—夜间）" : time.includes("after") ? "美股盘后（北京次日清晨）" : "时间待定";
      // Pre-market US date D ≈ Beijing evening D; after-hours ≈ Beijing morning D+1.
      let bjDate = dateStr;
      if (time.includes("after")) {
        bjDate = new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);
      }
      out.push({
        date: bjDate,
        timeText: slot,
        title: `${cn}（${sym}）财报`,
        category: "财报",
        impact: "High",
        forecast: row["epsForecast"] ? `预期 EPS ${row["epsForecast"]}` : "",
        previous: row["lastYearEPS"] ? `去年同期 EPS ${row["lastYearEPS"]}` : "",
        explain: "巨头财报不只是这家公司的成绩单：七巨头占标普权重三成以上，它们的资本开支指引（尤其 AI 投入）直接决定整条产业链的预期。财报季里，个股一夜涨跌 5–10% 是常态。",
        watch: "看四样：营收/EPS 是否超预期、下季度指引（比当季数字更重要）、AI 资本开支计划、盘后股价反应方向。指引下修比当季不及预期杀伤力大得多。",
        source: "Nasdaq 财报日历",
      });
    }
  };
  for (let i = 0; i < days.length; i += 12) {
    await Promise.all(days.slice(i, i + 12).map((d) => fetchDay(d).catch(() => undefined)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Math helpers (pure arithmetic — the whole point of the refresh design)
// ---------------------------------------------------------------------------

function medianOf(vals: number[]): number {
  const s = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[mid] ?? 0;
  return ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

// Position labels are PURE position words (where the value sits in its
// own history) — they never, by themselves, say cheap or expensive.
// Whether a percentile may be read as cheap/expensive at all depends on
// the indicator's direction, carried separately by the `invert` flag:
//   · invert = false: either an asset PRICE percentile — position only
//     (trend / drawdown), NEVER a valuation reading; the client renders
//     these neutral (V-1: no PE data → no cheap/expensive wording) —
//     or a funding/policy rate read as the cost of money itself.
//   · invert = true (bond-valuation lens): the value is a term treasury
//     yield or a spread whose underlying asset is a bond — the yield and
//     the bond price move in opposite directions, so low percentile =
//     yield at a historic low = the bond is EXPENSIVE, and high
//     percentile = the bond is cheap. The client reverses the chip /
//     bar colours for invert stats and prints a 「反向口径」 caption, so
//     a low yield is never shown as green "cheap".
// Money-market & policy rates (FR007 / DR007 / GC007 / SHIBOR / EFFR)
// deliberately stay invert = false: there the number is read as the
// cost of money itself (low rate = money is cheap), which is the plain
// price lens. Term yields and spreads are read as bond valuations.
function labelFor(p: number): string {
  if (p >= 95) return "极端偏高";
  if (p >= 75) return "偏高";
  if (p > 25) return "中性";
  if (p > 5) return "偏低";
  return "极端偏低";
}

type HistStats = {
  percentile: number;
  median: number;
  min: number;
  max: number;
  minDate: string;
  maxDate: string;
  count: number;
  label: string;
  // True for yield / spread indicators read through the bond-valuation
  // lens (see labelFor's comment): low percentile = corresponding bond
  // expensive, high percentile = corresponding bond cheap.
  invert: boolean;
};

function histStats(dates: string[], values: number[], windowDays?: number, invert = false): HistStats | null {
  // Window alignment (user requirement): the percentile / median / range
  // are computed over exactly the window the chart displays, so the two
  // always correspond. windowDays slices the tail of the series; omit it
  // only for full-history consumers (decision signals, drawdowns).
  let d = dates;
  let v = values;
  if (windowDays != null && values.length > windowDays) {
    d = dates.slice(-windowDays);
    v = values.slice(-windowDays);
  }
  dates = d;
  values = v;
  if (values.length < 20) return null;
  const current = values[values.length - 1];
  if (current === undefined) return null;
  let below = 0;
  let min = Infinity;
  let max = -Infinity;
  let minDate = "";
  let maxDate = "";
  values.forEach((v, i) => {
    if (v <= current) below++;
    if (v < min) {
      min = v;
      minDate = dates[i] ?? "";
    }
    if (v > max) {
      max = v;
      maxDate = dates[i] ?? "";
    }
  });
  const percentile = Math.round((below / values.length) * 1000) / 10;
  return {
    percentile,
    median: medianOf(values),
    min,
    max,
    minDate,
    maxDate,
    count: values.length,
    label: labelFor(percentile),
    invert,
  };
}

function smaSeries(vals: number[], n: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i] ?? 0;
    if (i >= n) sum -= vals[i - n] ?? 0;
    out.push(i >= n - 1 ? sum / n : null);
  }
  return out;
}

function emaSeries(vals: number[], n: number): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (n + 1);
  let ema: number | null = null;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i] ?? 0;
    ema = ema === null ? v : v * k + ema * (1 - k);
    out.push(i >= n - 1 ? ema : null);
  }
  return out;
}

function rsiSeries(closes: number[], n = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    if (d > 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / n;
  let avgLoss = loss / n;
  out[n] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = n + 1; i < closes.length; i++) {
    const d = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    avgGain = (avgGain * (n - 1) + Math.max(d, 0)) / n;
    avgLoss = (avgLoss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function macdHistSeries(closes: number[]): (number | null)[] {
  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  const line: number[] = [];
  closes.forEach((_, i) => {
    const f = fast[i];
    const s = slow[i];
    line.push(f != null && s != null ? f - s : 0);
  });
  const signal = emaSeries(line, 9);
  return closes.map((_, i) => {
    const sg = signal[i];
    return sg != null && i >= 33 ? line[i]! - sg : null;
  });
}

function stdev(vals: number[]): number {
  if (vals.length < 2) return 0;
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.sqrt(vals.reduce((a, b) => a + (b - m) * (b - m), 0) / (vals.length - 1));
}

// ---------------------------------------------------------------------------
// Drawdown episodes: split the full history into peak → trough → recovery
// events. Pure arithmetic on the stored closes; every "历史回撤" number on
// the history page comes from here, never from editorial memory.
// ---------------------------------------------------------------------------

function daysBetween(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  return Math.round((tb - ta) / 86400000);
}

type Episode = {
  peakDate: string;
  troughDate: string;
  recoveryDate: string | null; // null = 至今未收复
  depthPct: number; // negative
  daysDown: number; // peak → trough, calendar days
  daysRecover: number | null; // trough → recovery
};

function drawdownEpisodes(dates: string[], closes: number[], minDepthPct = 8): Episode[] {
  const out: Episode[] = [];
  if (closes.length < 2) return out;
  let peakV = closes[0] ?? 0;
  let peakI = 0;
  let troughV = peakV;
  let troughI = 0;
  let active = false;
  for (let i = 1; i < closes.length; i++) {
    const v = closes[i] ?? 0;
    if (v >= peakV) {
      if (active) {
        out.push({
          peakDate: dates[peakI] ?? "",
          troughDate: dates[troughI] ?? "",
          recoveryDate: dates[i] ?? "",
          depthPct: peakV > 0 ? ((troughV - peakV) / peakV) * 100 : 0,
          daysDown: daysBetween(dates[peakI] ?? "", dates[troughI] ?? ""),
          daysRecover: daysBetween(dates[troughI] ?? "", dates[i] ?? ""),
        });
      }
      peakV = v;
      peakI = i;
      troughV = v;
      troughI = i;
      active = false;
    } else {
      if (v < troughV) {
        troughV = v;
        troughI = i;
      }
      if (peakV > 0 && ((v - peakV) / peakV) * 100 <= -minDepthPct) active = true;
    }
  }
  if (active) {
    out.push({
      peakDate: dates[peakI] ?? "",
      troughDate: dates[troughI] ?? "",
      recoveryDate: null,
      depthPct: peakV > 0 ? ((troughV - peakV) / peakV) * 100 : 0,
      daysDown: daysBetween(dates[peakI] ?? "", dates[troughI] ?? ""),
      daysRecover: null,
    });
  }
  return out;
}

/**
 * The single deepest peak→trough drawdown in the window, as one Episode
 * (recovery = first close back at/above the peak after the trough, else
 * null). Fallback for instruments whose whole history never crosses the
 * episode threshold (CN bond ETFs top out under 5%): without it a zero-
 * episode instrument would vanish from the history page entirely, even
 * though its maximum drawdown is exactly what a bond holder needs.
 */
function maxDrawdownEpisode(dates: string[], closes: number[]): Episode | null {
  if (closes.length < 2) return null;
  let peakV = closes[0] ?? 0;
  let peakI = 0;
  let worst = 0;
  let worstPeakI = 0;
  let worstTroughI = 0;
  let worstPeakV = peakV;
  for (let i = 1; i < closes.length; i++) {
    const v = closes[i] ?? 0;
    if (v >= peakV) {
      peakV = v;
      peakI = i;
    } else if (peakV > 0) {
      const dd = ((v - peakV) / peakV) * 100;
      if (dd < worst) {
        worst = dd;
        worstPeakI = peakI;
        worstTroughI = i;
        worstPeakV = peakV;
      }
    }
  }
  if (worst >= 0 || worstPeakV <= 0) return null;
  let recoveryI: number | null = null;
  for (let i = worstTroughI + 1; i < closes.length; i++) {
    if ((closes[i] ?? 0) >= worstPeakV) {
      recoveryI = i;
      break;
    }
  }
  return {
    peakDate: dates[worstPeakI] ?? "",
    troughDate: dates[worstTroughI] ?? "",
    recoveryDate: recoveryI != null ? (dates[recoveryI] ?? null) : null,
    depthPct: worst,
    daysDown: daysBetween(dates[worstPeakI] ?? "", dates[worstTroughI] ?? ""),
    daysRecover:
      recoveryI != null ? daysBetween(dates[worstTroughI] ?? "", dates[recoveryI] ?? "") : null,
  };
}

/** Pair a derived series (with nulls) into dates/values for stats. */
function paired(dates: string[], series: (number | null)[]): { d: string[]; v: number[] } {
  const d: string[] = [];
  const v: number[] = [];
  series.forEach((x, i) => {
    if (x != null && Number.isFinite(x)) {
      d.push(dates[i] ?? "");
      v.push(x);
    }
  });
  return { d, v };
}

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const statsZ = z.object({
  percentile: z.number(),
  median: z.number(),
  min: z.number(),
  max: z.number(),
  minDate: z.string(),
  maxDate: z.string(),
  count: z.number(),
  label: z.string(),
  // Bond-valuation lens flag (see labelFor): true for term yields and
  // spreads — low percentile = corresponding bond expensive.
  invert: z.boolean(),
});

const chartPtZ = z.object({ d: z.string(), v: z.number(), partial: z.boolean().optional() });

const indicatorZ = z.object({
  key: z.string(),
  name: z.string(),
  method: z.string(),
  value: z.number(),
  unit: z.string(),
  decimals: z.number(),
  date: z.string(),
  change: z.number().nullable(),
  state: z.string(),
  note: z.string(),
  stats: statsZ.nullable(),
  // History curve for the card, sliced to exactly the same windowDays
  // tail as `stats` (see makeIndicator's withChart). Empty for cards
  // that carry no time series of their own (e.g. the gold/US-yield
  // correlation scalar) or whose page already charts the same series
  // at section level (yields / money blocks).
  chart: z.array(chartPtZ),
});

const instrumentZ = z.object({
  key: z.string(),
  name: z.string(),
  sub: z.string(),
  asset: z.string(),
  unit: z.string(),
  decimals: z.number(),
  price: z.number(),
  date: z.string(),
  // True when the latest point is an intraday snapshot, not the day's
  // close (HK series refreshed before the 16:00 HK close). The card
  // shows 盘中快照，未收盘； a post-close refresh overwrites the point
  // with the final close and this clears.
  partial: z.boolean(),
  // Null when the stored series skips a trading day right before the
  // latest point (Yahoo hole the Eastmoney fill could not close): the
  // "今日" change would span the gap, so the card shows — plus
  // changeNote instead of a multi-day cumulative number.
  changePct: z.number().nullable(),
  changeNote: z.string(),
  ma20: z.number().nullable(),
  ma60: z.number().nullable(),
  ma120: z.number().nullable(),
  ma250: z.number().nullable(),
  trendState: z.string(),
  crossState: z.string(),
  pos52: z.number(),
  priceStats: statsZ.nullable(),
  // Bond-ETF valuation scale (V-1 step 3/4): for bond ETFs the price
  // percentile is NOT a valuation gauge — the card's valuation block
  // reads the corresponding yield / spread percentile instead (stats
  // carry invert = true: yield percentile high = bond cheap). Attached
  // in getDashboard from the stored yield series; null for every
  // non-bond instrument and whenever the yield series has not landed.
  yieldStats: statsZ.nullable(),
  yieldLabel: z.string(),
  yieldUnit: z.string(), // "%" for yields / spreads; "" for the HYG/IEF ratio proxy
  // Historical PE percentile (V-1 step 5): TTM PE points for the index
  // behind this card, trailing 5-year window — CSI month-end points
  // ("月末") for A-share targets, Multpl monthly points ("月度":
  // month-1st points + live point) for the S&P 500. Attached in
  // getDashboard from the stored pe_<key> series; null when the
  // target has no pipeline or the sample is under 8.
  peHist: z
    .object({
      current: z.number(), // latest TTM PE (×)
      percentile: z.number(), // 0–100, current PE's position in its own 5y history
      median: z.number(),
      n: z.number(), // sample count inside the 5y window
      firstDate: z.string(),
      lastDate: z.string(), // data date of the current PE point
      cadence: z.string(), // "月末" (CSI) | "月度" (Multpl)
      source: z.string(), // publisher label shown on the card
      indexName: z.string(), // the index whose PE this is (ETF cards: the tracked index)
    })
    .nullable(),
  // True for brief targets with no qualifying PE history source: the
  // card prints 暂无历史 PE 数据 instead of a PE row. False for every
  // non-target instrument (no PE annotation at all).
  peNoData: z.boolean(),
  // Current-value-only PE (annual points + latest month, no
  // percentile — a 5y window of annual points is 6 < the 8-point
  // floor, so peStatsFromPoints must NEVER receive these points).
  // Used by HSI (Siblis annual table) and, when approved, NDX (Part 1
  // B1, same table shape). Null for every other instrument.
  peCurrent: z
    .object({
      value: z.number(), // latest TTM PE (×)
      date: z.string(), // data date of the current value (month-1st)
      source: z.string(), // publisher label shown on the card
    })
    .nullable(),
  // True while a weekly/monthly accumulation series exists but its
  // 5y sample is still under 8 points: the card prints 积累中
  // (with the stored point count) instead of 暂无历史 PE 数据.
  peAccumulating: z.boolean(),
  // Stored accumulation point count while peAccumulating (null otherwise):
  // the card's chip prints 积累中 n/8 from this, never a hardcoded count.
  peAccumulatingCount: z.number().nullable(),
  // Forward 12M PE (manually accumulated, forward_pe table): the
  // latest recorded value + the source edition's 5y/10y averages.
  // percentile/n count the stored rows' own 5y window (same
  // 8-point floor as TTM); null below 8 rows — the card then shows
  // 积累中 (n/8). Display-only: NEVER a signal factor (signals
  // score valuation from TTM PE only).
  fwdPe: z
    .object({
      value: z.number(),
      date: z.string(),
      avg5: z.number().nullable(),
      avg10: z.number().nullable(),
      percentile: z.number().nullable(), // null while rows < 8
      n: z.number(), // stored rows inside the 5y window
      source: z.string(),
      // Every stored row (date-ascending) for the card's mini line
      // chart; the client draws the line only at >= 3 points (a 1–2
      // point "line" would mislead). Display-only, like the rest of
      // this block.
      points: z.array(z.object({ d: z.string(), v: z.number() })),
    })
    .nullable(),
  indicators: z.array(indicatorZ),
  // Chart points are NOT in the dashboard payload (they were ~85% of its
  // bytes); the client lazy-loads them per instrument via
  // getInstrumentChart. Only the window's span rides along for captions.
  chartMeta: z.object({ from: z.string(), to: z.string(), count: z.number() }),
});

const episodeZ = z.object({
  peakDate: z.string(),
  troughDate: z.string(),
  recoveryDate: z.string().nullable(),
  depthPct: z.number(),
  daysDown: z.number(),
  daysRecover: z.number().nullable(),
});

const drawdownZ = z.object({
  key: z.string(),
  name: z.string(),
  asset: z.string(),
  windowYears: z.number(),
  currentDd: z.number(),
  peakDate: z.string(), // date of the high the current drawdown is measured from
  daysSincePeak: z.number(),
  deepest: z.number(), // worst episode depth in window (negative)
  count10: z.number(), // episodes deeper than 10%
  count20: z.number(), // episodes deeper than 20%
  medianDepth: z.number().nullable(), // median depth of >=10% episodes
  medianRecoverDays: z.number().nullable(), // median trough→recovery days of recovered >=10% episodes
  deeperThanNow: z.number(), // how many past episodes were deeper than the current drawdown
  thresholdPct: z.number(), // episode depth threshold used for this instrument (8% equities/gold, 2% CN bond ETFs)
  episodeCount: z.number(), // total episodes at that threshold in the window
  episodes: z.array(episodeZ), // top episodes by depth (max 6)
});

const signalZ = z.object({
  key: z.string(),
  name: z.string(),
  group: z.string(),
  verdict: z.string(),
  tone: z.enum(["buy", "add", "hold", "reduce", "avoid"]),
  score: z.number(), // -5..+5 rule score
  headline: z.string(),
  basis: z.array(z.string()),
  // Mini percentile bars under individual basis lines (user directive
  // 2026-11-20, r6 O1): parallel to `basis` — entry i annotates basis
  // line i, or is null when the line carries no percentile reading.
  // `pct` is the very value the line's text prints (same computed
  // stats object), never a second hard-coded copy. `invert` follows
  // the site-wide lens: yields / spreads / real rates render the
  // reversed gradient (low percentile = expensive end); PE and
  // relative-strength percentiles render the plain gradient.
  basisBars: z.array(z.object({ pct: z.number(), invert: z.boolean() }).nullable()),
  // Mini bar under the headline itself, for the two signals whose
  // headline carries the percentile reading （中国国债's 收益率百分位，
  // A股风格's relative-strength percentile). Same value-source rule as
  // basisBars; null everywhere else.
  headlineBar: z.object({ pct: z.number(), invert: z.boolean() }).nullable(),
  caution: z.string(),
  date: z.string(),
  // "" when the signal was computed normally. When the input data for a
  // signal never landed (e.g. FRED timed out, so no HY OAS series), the
  // signal still occupies its slot as a placeholder: verdict "数据未到",
  // score 0, and this field carries the plain-language reason (what is
  // missing, why, and that the next successful refresh restores it).
  missing: z.string(),
});

const fibLevelZ = z.object({
  ratio: z.number(), // 0 = far anchor, 0.236…0.786 retracements, 1 = near anchor, 1.272/1.618 extensions
  label: z.string(),
  price: z.number(),
  kind: z.enum(["anchor", "retracement", "extension"]),
  distPct: z.number(), // (price / close − 1) × 100, signed
  side: z.enum(["below", "above", "at"]), // relative to the current close
});

const fibZ = z.object({
  key: z.string(),
  name: z.string(),
  unit: z.string(),
  decimals: z.number(),
  close: z.number(),
  closeDate: z.string(),
  high: z.number(),
  highDate: z.string(),
  low: z.number(),
  lowDate: z.string(),
  // "up": the low came first, price climbed to the high and is now
  // retracing down from it (levels below the high are supports).
  // "down": the high came first and price fell to the low; levels are
  // the rebound retracements measured up from the low (resistances).
  direction: z.enum(["up", "down"]),
  range: z.number(),
  levels: z.array(fibLevelZ),
  nearest: fibLevelZ,
  support: fibLevelZ.nullable(), // nearest level at or below the close
  resistance: fibLevelZ.nullable(), // nearest level above the close
  verified: z.boolean(),
  verifySource: z.string(),
  verifyNote: z.string(),
  positionText: z.string(),
});

type FibRow = typeof schema.fibAnchors.$inferSelect;

/** Recompute the full level ladder from the stored anchors (pure
 *  arithmetic at read time — levels are never stored, so they can
 *  never drift from the anchors they were derived from). */
function buildFib(row: FibRow): z.infer<typeof fibZ> {
  const cfg = PRICE_SERIES.find((c) => c.key === row.key);
  const dec = cfg?.decimals ?? 2;
  const fp = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const range = row.high - row.low;
  const direction: "up" | "down" = row.lowDate <= row.highDate ? "up" : "down";
  const mk = (ratio: number, kind: "anchor" | "retracement" | "extension", label: string): z.infer<typeof fibLevelZ> => {
    const price =
      kind === "extension"
        ? direction === "up"
          ? row.low - (ratio - 1) * range
          : row.high + (ratio - 1) * range
        : direction === "up"
          ? row.high - ratio * range
          : row.low + ratio * range;
    const distPct = row.close !== 0 ? (price / row.close - 1) * 100 : 0;
    return {
      ratio,
      label,
      price: Math.round(price * 100) / 100,
      kind,
      distPct: Math.round(distPct * 100) / 100,
      side: Math.abs(distPct) <= 0.1 ? "at" : price < row.close ? "below" : "above",
    };
  };
  const levels = [
    mk(0, "anchor", direction === "up" ? "高点（0%）" : "高点（100%）"),
    mk(0.236, "retracement", "23.6% 回撤"),
    mk(0.382, "retracement", "38.2% 回撤"),
    mk(0.5, "retracement", "50% 回撤"),
    mk(0.618, "retracement", "61.8% 回撤"),
    mk(0.786, "retracement", "78.6% 回撤"),
    mk(1, "anchor", direction === "up" ? "低点（100%）" : "低点（0%）"),
    mk(1.272, "extension", "127.2% 扩展"),
    mk(1.618, "extension", "161.8% 扩展"),
  ];
  const nearest = levels.reduce((a, b) => (Math.abs(b.distPct) < Math.abs(a.distPct) ? b : a), levels[0] as z.infer<typeof fibLevelZ>);
  const below = levels.filter((l) => l.price <= row.close).sort((a, b) => b.price - a.price);
  const above = levels.filter((l) => l.price > row.close).sort((a, b) => a.price - b.price);
  const support = below[0] ?? null;
  const resistance = above[0] ?? null;
  const gapPct = nearest.price !== 0 ? (row.close / nearest.price - 1) * 100 : 0;
  const nearText =
    nearest.side === "at"
      ? `现价 ${fp(row.close)} 几乎正贴着 ${nearest.label}位 ${fp(nearest.price)}（现价在该位${gapPct >= 0 ? "上方" : "下方"} ${gapPct >= 0 ? "+" : ""}${gapPct.toFixed(2)}%）`
      : nearest.side === "below"
        ? `现价 ${fp(row.close)} 在 ${nearest.label}位 ${fp(nearest.price)} 上方（${gapPct >= 0 ? "+" : ""}${gapPct.toFixed(2)}%），最近一档已经站回`
        : `现价 ${fp(row.close)} 在 ${nearest.label}位 ${fp(nearest.price)} 下方（${gapPct.toFixed(2)}%），还没摸到最近一档`;
  const positionText =
    `${nearText}；` +
    (support ? `下方最近支撑 ${support.label}位 ${fp(support.price)}（${support.distPct.toFixed(2)}%）` : "下方已跌破全部回撤位，看扩展位") +
    "，" +
    (resistance ? `上方最近压力 ${resistance.label}位 ${fp(resistance.price)}（+${Math.abs(resistance.distPct).toFixed(2)}%）` : "上方已越过全部回撤位，回到锚点高点之上") +
    "。";
  const verifyNote =
    row.verified === 1
      ? `锚点已由第二数据源验证：${row.verifySource} 同窗口高点 ${row.verifyHigh != null ? fp(row.verifyHigh) : "—"}（${row.verifyHighDate}）、低点 ${row.verifyLow != null ? fp(row.verifyLow) : "—"}（${row.verifyLowDate}），与 Yahoo 口径的日期与数值一致`
      : row.verifySource
        ? `第二数据源（${row.verifySource}）本次未确认这两个锚点：其同窗口高点 ${row.verifyHigh != null ? fp(row.verifyHigh) : "—"}（${row.verifyHighDate || "—"}）、低点 ${row.verifyLow != null ? fp(row.verifyLow) : "—"}（${row.verifyLowDate || "—"}），与 Yahoo 口径不完全一致，下单前请再核对`
        : "第二数据源（Nasdaq 官方历史数据 / 东方财富 push2his）本次均未取到，锚点暂为 Yahoo 单源，下单前请再核对";
  return {
    key: row.key,
    name: row.name,
    unit: cfg?.unit ?? "美元",
    decimals: dec,
    close: row.close,
    closeDate: row.closeDate,
    high: row.high,
    highDate: row.highDate,
    low: row.low,
    lowDate: row.lowDate,
    direction,
    range: Math.round(range * 100) / 100,
    levels,
    nearest,
    support,
    resistance,
    verified: row.verified === 1,
    verifySource: row.verifySource,
    verifyNote,
    positionText,
  };
}

const tenorZ = z.object({
  key: z.string(),
  tenor: z.string(),
  yieldPct: z.number(),
  changeBp: z.number(),
  stats: statsZ.nullable(),
});


type Indicator = z.infer<typeof indicatorZ>;

function makeIndicator(args: {
  key: string;
  name: string;
  method: string;
  unit: string;
  decimals: number;
  dates: string[];
  values: number[];
  state: string;
  note: string;
  windowDays?: number;
  // Bond-valuation lens (yields / spreads): forwarded to histStats so
  // the card's percentile chip colours reverse — low is NOT cheap here.
  invert?: boolean;
  // Wall-Street cards carry their own history curve. The curve is the
  // series' tail sliced by the SAME windowDays histStats uses for the
  // percentile, so the visible curve and the percentile sample are the
  // same points by construction — switching the page window moves both.
  withChart?: boolean;
}): Indicator | null {
  const last = args.values[args.values.length - 1];
  const prev = args.values[args.values.length - 2];
  if (last === undefined) return null;
  let chart: z.infer<typeof chartPtZ>[] = [];
  if (args.withChart) {
    const start =
      args.windowDays != null && args.values.length > args.windowDays
        ? args.values.length - args.windowDays
        : 0;
    chart = args.dates.slice(start).map((d, i) => ({ d, v: args.values[start + i] ?? 0 }));
  }
  return {
    key: args.key,
    name: args.name,
    method: args.method,
    value: last,
    unit: args.unit,
    decimals: args.decimals,
    date: args.dates[args.dates.length - 1] ?? "",
    change: prev !== undefined ? last - prev : null,
    state: args.state,
    note: args.note,
    stats: histStats(args.dates, args.values, args.windowDays, args.invert ?? false),
    chart,
  };
}

// ---------------------------------------------------------------------------
// Per-instrument computation
// ---------------------------------------------------------------------------

function computeInstrument(
  cfg: PriceCfg,
  pts: Pt[],
  benchmarkPts: Pt[] | null,
  windowDays = 500,
  calendarDates: string[] | null = null,
): z.infer<typeof instrumentZ> | null {
  if (pts.length < 60) return null;
  const dates = pts.map((p) => p.date);
  const closes = pts.map((p) => p.value);
  const last = closes[closes.length - 1] ?? 0;
  const prevClose = closes[closes.length - 2] ?? last;
  // "今日" must be a single trading day. When the stored series skips a
  // trading day (Yahoo returned close=null for it and the Eastmoney fill
  // could not supply it either), the last-two-points change spans the
  // hole — it is NOT shown: changePct stays null and changeNote names
  // the missing date(s) instead of printing a multi-day cumulative move
  // as if it were one day. The check only fires when both points sit in
  // the exchange calendar (the index series' dates) non-adjacently, so
  // an unverifiable case never masquerades as a gap either way.
  let changePct: number | null = prevClose !== 0 ? ((last - prevClose) / prevClose) * 100 : 0;
  let changeNote = "";
  if (calendarDates) {
    const li = calendarDates.indexOf(dates[dates.length - 1] ?? "");
    const pi = calendarDates.indexOf(dates[dates.length - 2] ?? "");
    if (li > 0 && pi >= 0 && pi < li - 1) {
      changePct = null;
      changeNote = `缺 ${calendarDates.slice(pi + 1, li).join("、")} 收盘价，当日涨跌暂缺`;
    }
  }

  const ma20s = smaSeries(closes, 20);
  const ma60s = smaSeries(closes, 60);
  const ma120s = smaSeries(closes, 120);
  const ma250s = smaSeries(closes, 250);
  const at = (s: (number | null)[], back = 0) => s[s.length - 1 - back] ?? null;
  const ma20 = at(ma20s);
  const ma60 = at(ma60s);
  const ma120 = at(ma120s);
  const ma250 = at(ma250s);

  const aboveCount = [ma20, ma60, ma120, ma250].filter((m) => m != null && last > m).length;
  const knownMas = [ma20, ma60, ma120, ma250].filter((m) => m != null).length;
  const trendState =
    knownMas === 0
      ? "数据不足"
      : aboveCount === knownMas
        ? "多头排列上方（价格在全部均线之上）"
        : aboveCount === 0
          ? "空头压制（价格在全部均线之下）"
          : `混合（价格站上 ${aboveCount}/${knownMas} 条均线）`;

  const crossState = (() => {
    const nowDiff = (ma20 ?? 0) - (ma60 ?? 0);
    const prevMa20 = at(ma20s, 1);
    const prevMa60 = at(ma60s, 1);
    if (ma20 == null || ma60 == null || prevMa20 == null || prevMa60 == null) return "均线数据不足";
    const prevDiff = prevMa20 - prevMa60;
    if (prevDiff <= 0 && nowDiff > 0) return "刚出现金叉（短均线上穿长均线）";
    if (prevDiff >= 0 && nowDiff < 0) return "刚出现死叉（短均线下穿长均线）";
    return nowDiff > 0 ? "金叉状态（短均线在长均线之上）" : "死叉状态（短均线在长均线之下）";
  })();

  const last252 = closes.slice(-252);
  const hi52 = Math.max(...last252);
  const lo52 = Math.min(...last252);
  const pos52 = hi52 > lo52 ? ((last - lo52) / (hi52 - lo52)) * 100 : 50;

  const indicators: Indicator[] = [];
  const mk = (a: Parameters<typeof makeIndicator>[0]) => makeIndicator({ ...a, windowDays });
  const push = (ind: Indicator | null) => {
    if (ind) indicators.push(ind);
  };

  // RSI(14)
  const rsiP = paired(dates, rsiSeries(closes));
  const rsiNow = rsiP.v[rsiP.v.length - 1];
  if (rsiNow !== undefined) {
    push(
      mk({
        key: "rsi",
        name: "RSI(14) 强弱",
        method: "rsi",
        unit: "",
        decimals: 1,
        dates: rsiP.d,
        values: rsiP.v,
        state: rsiNow >= 70 ? "超买区" : rsiNow <= 30 ? "超卖区" : "中性区",
        note:
          rsiNow >= 70
            ? "短线涨得有点急，历史上到这个位置后容易歇一歇。"
            : rsiNow <= 30
              ? "短线跌得有点狠，历史上到这个位置后容易出现反弹，但不等于见底。"
              : "涨跌力度都在正常范围，没有极端情绪。",
      }),
    );
  }

  // MACD histogram
  const macdP = paired(dates, macdHistSeries(closes));
  const macdNow = macdP.v[macdP.v.length - 1];
  const macdPrev = macdP.v[macdP.v.length - 2];
  if (macdNow !== undefined) {
    const rising = macdPrev !== undefined && macdNow > macdPrev;
    push(
      mk({
        key: "macd",
        name: "MACD 柱",
        method: "macd",
        unit: "",
        decimals: 3,
        dates: macdP.d,
        values: macdP.v,
        state: macdNow > 0 ? (rising ? "红柱放大（多头动能增强）" : "红柱缩短（多头动能减弱）") : rising ? "绿柱缩短（空头动能减弱）" : "绿柱放大（空头动能增强）",
        note: "MACD 看的是涨跌的“加速度”：柱子在零轴上方说明短期趋势强于长期，柱子变短说明劲儿在泄。",
      }),
    );
  }

  // Bollinger %B (20, 2)
  const bollVals: (number | null)[] = closes.map((c, i) => {
    if (i < 19) return null;
    const win = closes.slice(i - 19, i + 1);
    const m = win.reduce((a, b) => a + b, 0) / 20;
    const sd = stdev(win);
    if (sd === 0) return null;
    return (c - (m - 2 * sd)) / (4 * sd);
  });
  const bollP = paired(dates, bollVals);
  const bollNow = bollP.v[bollP.v.length - 1];
  if (bollNow !== undefined) {
    push(
      mk({
        key: "boll",
        name: "布林带位置 %B",
        method: "bollinger",
        unit: "",
        decimals: 2,
        dates: bollP.d,
        values: bollP.v,
        state: bollNow >= 1 ? "冲出上轨（短线过热）" : bollNow <= 0 ? "跌破下轨（短线过冷）" : bollNow >= 0.8 ? "贴近上轨" : bollNow <= 0.2 ? "贴近下轨" : "在轨道中间",
        note: "0.5 是中轨（20日均线），1 是上轨，0 是下轨。贴轨不等于马上反转，强趋势里会沿着轨道走。",
      }),
    );
  }

  // Realized volatility (20d, annualized %)
  const volVals: (number | null)[] = closes.map((_, i) => {
    if (i < 20) return null;
    const rets: number[] = [];
    for (let j = i - 19; j <= i; j++) {
      const a = closes[j] ?? 0;
      const b = closes[j - 1] ?? 0;
      if (a > 0 && b > 0) rets.push(Math.log(a / b));
    }
    return stdev(rets) * Math.sqrt(252) * 100;
  });
  const volP = paired(dates, volVals);
  const volNow = volP.v[volP.v.length - 1];
  if (volNow !== undefined) {
    push(
      mk({
        key: "vol",
        name: "20日波动率（年化）",
        method: "volatility",
        unit: "%",
        decimals: 1,
        dates: volP.d,
        values: volP.v,
        state: volNow >= 30 ? "高波动（行情很颠）" : volNow >= 18 ? "中等波动" : "低波动（行情平稳）",
        note: "这个数越大，最近晃得越厉害。波动率冲到历史高位，往往对应恐慌或重大事件，之后常会慢慢回落。",
      }),
    );
  }

  // Drawdown from running high (%)
  let runMax = -Infinity;
  const ddVals = closes.map((c) => {
    runMax = Math.max(runMax, c);
    return runMax > 0 ? ((c - runMax) / runMax) * 100 : 0;
  });
  const ddNow = ddVals[ddVals.length - 1] ?? 0;
  push(
    mk({
      key: "drawdown",
      name: "距历史高点回撤",
      method: "drawdown",
      unit: "%",
      decimals: 1,
      dates,
      values: ddVals,
      state: ddNow <= -20 ? "已进入技术性熊市区间（回撤超 20%）" : ddNow <= -10 ? "明显回调区间" : ddNow <= -3 ? "小幅回调" : "接近历史高点",
      note: `当前价格比窗口内最高点低 ${Math.abs(ddNow).toFixed(1)}%。回撤的百分位越低，说明跌得比历史上绝大多数时候都深。`,
    }),
  );

  // Momentum: rolling 63-day (3M) return, current = last 63d
  const momVals: (number | null)[] = closes.map((c, i) => {
    if (i < 63) return null;
    const base = closes[i - 63] ?? 0;
    return base !== 0 ? ((c - base) / base) * 100 : null;
  });
  const momP = paired(dates, momVals);
  const momNow = momP.v[momP.v.length - 1];
  if (momNow !== undefined) {
    const r1m = closes.length > 21 && (closes[closes.length - 22] ?? 0) !== 0 ? ((last - (closes[closes.length - 22] ?? 0)) / (closes[closes.length - 22] ?? 1)) * 100 : 0;
    const r12m = closes.length > 252 && (closes[closes.length - 253] ?? 0) !== 0 ? ((last - (closes[closes.length - 253] ?? 0)) / (closes[closes.length - 253] ?? 1)) * 100 : 0;
    push(
      mk({
        key: "momentum",
        name: "动量（近3月涨跌）",
        method: "momentum",
        unit: "%",
        decimals: 1,
        dates: momP.d,
        values: momP.v,
        state: momNow > 0 ? "中期动量为正" : "中期动量为负",
        note: `近1月 ${r1m >= 0 ? "+" : ""}${r1m.toFixed(1)}%，近3月 ${momNow >= 0 ? "+" : ""}${momNow.toFixed(1)}%，近1年 ${r12m >= 0 ? "+" : ""}${r12m.toFixed(1)}%。动量看的是“最近这段路走得快不快”。`,
      }),
    );
  }

  // Volume ratio (latest volume vs 20d average)
  const vols = pts.map((p) => p.volume);
  if (vols.every((v) => v != null && v > 0)) {
    const vNums = vols as number[];
    const ratioVals: (number | null)[] = vNums.map((v, i) => {
      if (i < 20) return null;
      const win = vNums.slice(i - 20, i);
      const avg = win.reduce((a, b) => a + b, 0) / 20;
      return avg > 0 ? v / avg : null;
    });
    const ratioP = paired(dates, ratioVals);
    const ratioNow = ratioP.v[ratioP.v.length - 1];
    if (ratioNow !== undefined) {
      push(
        mk({
          key: "volumeratio",
          name: "量比（对20日均量）",
          method: "volume",
          unit: "倍",
          decimals: 2,
          dates: ratioP.d,
          values: ratioP.v,
          state: ratioNow >= 1.5 ? "明显放量" : ratioNow <= 0.7 ? "明显缩量" : "量能正常",
          note: "量比 >1 说明今天比过去 20 天平均更热闹。放量上涨和放量下跌含义相反，要结合涨跌一起看。",
        }),
      );
    }
  }

  // Relative strength vs benchmark (3M excess return)
  if (benchmarkPts && benchmarkPts.length > 70) {
    const bMap = new Map(benchmarkPts.map((p) => [p.date, p.value]));
    const aligned: { d: string; diff: number }[] = [];
    let baseDiff: number | null = null;
    dates.forEach((d, i) => {
      const b = bMap.get(d);
      const c = closes[i];
      if (b !== undefined && c !== undefined && b > 0 && c > 0) {
        const diff = Math.log(c) - Math.log(b);
        if (baseDiff === null) baseDiff = diff;
        aligned.push({ d, diff });
      }
    });
    if (aligned.length > 70) {
      const rsVals = aligned.map((a, i) => {
        if (i < 63) return null;
        const prev = aligned[i - 63];
        return prev ? (a.diff - prev.diff) * 100 : null;
      });
      const rsDates = aligned.map((a) => a.d);
      const rsP = paired(rsDates, rsVals);
      const rsNow = rsP.v[rsP.v.length - 1];
      if (rsNow !== undefined) {
        push(
          mk({
            key: "relstrength",
            name: "相对强弱（近3月跑赢基准）",
            method: "relstrength",
            unit: "%",
            decimals: 1,
            dates: rsP.d,
            values: rsP.v,
            state: rsNow > 0 ? "跑赢基准" : "跑输基准",
            note: "正数 = 这段时间比基准涨得多（或跌得少）；负数 = 落后于基准。挑基金和板块时这是最常用的一把尺。",
          }),
        );
      }
    }
  }

  return {
    key: cfg.key,
    name: cfg.name,
    sub: cfg.sub,
    asset: cfg.asset,
    unit: cfg.unit,
    decimals: cfg.decimals,
    price: last,
    date: dates[dates.length - 1] ?? "",
    partial: pts[pts.length - 1]?.partial === true,
    changePct,
    changeNote,
    ma20,
    ma60,
    ma120,
    ma250,
    trendState,
    crossState,
    pos52,
    priceStats: histStats(dates, closes, windowDays),
    yieldStats: null,
    yieldLabel: "",
    yieldUnit: "%",
    peHist: null,
    peNoData: false,
    peCurrent: null,
    peAccumulating: false,
    peAccumulatingCount: null,
    fwdPe: null,
    indicators,
    chartMeta: (() => {
      const win = pts.slice(-windowDays);
      return { from: win[0]?.date ?? "", to: win[win.length - 1]?.date ?? "", count: win.length };
    })(),
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function loadAllSeries(ctx: Ctx): Promise<Map<string, Pt[]>> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.seriesPoints)
    .orderBy(asc(schema.seriesPoints.seriesKey), asc(schema.seriesPoints.date));
  const map = new Map<string, Pt[]>();
  for (const r of rows) {
    const arr = map.get(r.seriesKey) ?? [];
    arr.push({ date: r.date, value: r.value, volume: r.volume, partial: r.partial === 1 });
    map.set(r.seriesKey, arr);
  }
  return map;
}

async function storeSeries(ctx: Ctx, key: string, pts: Pt[]): Promise<void> {
  if (pts.length === 0) return;
  const db = ctx.db<typeof schema>();
  // Replace only the fetched window: delete stored points at or after the
  // earliest fetched date, then insert the fresh points. Fetchers that
  // return a series' full history behave exactly like a full replace;
  // windowed fetchers (the Treasury curves' steady-state two-month mode)
  // refresh their window without wiping the stored history behind it —
  // a delete-all replace once shrank the Treasury series from ~2000
  // points to ~54 on the second refresh (found 2026-11-19).
  let minDate = pts[0]?.date ?? "9999-12-31";
  for (const p of pts) if (p.date < minDate) minDate = p.date;
  await db
    .delete(schema.seriesPoints)
    .where(and(eq(schema.seriesPoints.seriesKey, key), gte(schema.seriesPoints.date, minDate)));
  const CHUNK = 400;
  for (let i = 0; i < pts.length; i += CHUNK) {
    const chunk = pts.slice(i, i + CHUNK);
    await db.insert(schema.seriesPoints).values(
      chunk.map((p) => ({ seriesKey: key, date: p.date, value: p.value, volume: p.volume, partial: p.partial ? 1 : 0 })),
    );
  }
}

// ---------------------------------------------------------------------------
// Static seed library + incremental tail refresh (user spec, 2026-11-19).
// History is immutable data: a series is seeded ONCE at its full window
// (10–20y for the main indices, 5y+ elsewhere), then every refresh only
// fetches the tail — from the last stored date minus a small overlap
// window (which absorbs source corrections and split adjustments) — and
// appends. A full re-fetch happens only on an explicit rebuild. Every
// stage reports how many points it appended / overlap-refreshed / left
// untouched, so a second refresh visibly re-pulls no history.
// ---------------------------------------------------------------------------

type TailInfo = { minDate: string | null; maxDate: string | null; count: number };

async function seriesCoverage(ctx: Ctx): Promise<Map<string, TailInfo>> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select({
      key: schema.seriesPoints.seriesKey,
      minDate: sql<string | null>`min(${schema.seriesPoints.date})`,
      maxDate: sql<string | null>`max(${schema.seriesPoints.date})`,
      n: sql<number>`count(*)`,
    })
    .from(schema.seriesPoints)
    .groupBy(schema.seriesPoints.seriesKey);
  const map = new Map<string, TailInfo>();
  for (const r of rows) map.set(r.key, { minDate: r.minDate ?? null, maxDate: r.maxDate ?? null, count: Number(r.n) });
  return map;
}

function shiftDateStr(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Tail start for a seeded series (null → seed / rebuild full window). */
function tailFrom(prev: TailInfo | undefined, rebuild: boolean, overlapDays = 14): string | null {
  if (rebuild || !prev?.maxDate || prev.count === 0) return null;
  return shiftDateStr(prev.maxDate, -overlapDays);
}

type StoreCounts = { appended: number; reviewed: number; changed: number; skipped: number };

async function storeSeriesCounted(
  ctx: Ctx,
  key: string,
  pts: Pt[],
  prev: TailInfo | undefined,
): Promise<StoreCounts> {
  if (pts.length === 0) return { appended: 0, reviewed: 0, changed: 0, skipped: prev?.count ?? 0 };
  let minDate = pts[0]?.date ?? "9999-12-31";
  for (const pt of pts) if (pt.date < minDate) minDate = pt.date;
  const db = ctx.db<typeof schema>();
  const before = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.seriesPoints)
    .where(and(eq(schema.seriesPoints.seriesKey, key), lt(schema.seriesPoints.date, minDate)));
  const skipped = Number(before[0]?.n ?? 0);
  const prevMax = prev?.maxDate ?? "";
  const appended = pts.filter((pt) => pt.date > prevMax).length;
  // D-P2-1: the overlap window is re-fetched and rewritten on every
  // refresh, but most of those points come back with the SAME value —
  // calling all of them "修正" (corrections) overstated the churn by
  // orders of magnitude (a steady-state round "corrected" 637 price
  // points and 1504 yield points while appending 0). Snapshot the
  // stored overlap rows BEFORE the replace and count separately:
  // reviewed = overlap points re-fetched; changed = the subset whose
  // stored value actually differs (value, volume, or the partial
  // intraday flag), plus overlap dates that had no stored row at all
  // (a hole the source now fills). A relative epsilon keeps float
  // round-trip noise from masquerading as a source revision.
  const storedRows = await db
    .select({ date: schema.seriesPoints.date, value: schema.seriesPoints.value, volume: schema.seriesPoints.volume, partial: schema.seriesPoints.partial })
    .from(schema.seriesPoints)
    .where(and(eq(schema.seriesPoints.seriesKey, key), gte(schema.seriesPoints.date, minDate)));
  const storedByDate = new Map(storedRows.map((r) => [r.date, r]));
  let reviewed = 0;
  let changed = 0;
  for (const pt of pts) {
    if (pt.date > prevMax) continue;
    reviewed++;
    const old = storedByDate.get(pt.date);
    if (!old) {
      changed++;
      continue;
    }
    const valueChanged = Math.abs(old.value - pt.value) > 1e-9 * Math.max(1, Math.abs(old.value), Math.abs(pt.value));
    const volumeChanged =
      (old.volume == null) !== (pt.volume == null) ||
      (old.volume != null && pt.volume != null && Math.abs(old.volume - pt.volume) > 1e-9 * Math.max(1, Math.abs(old.volume), Math.abs(pt.volume)));
    const partialChanged = (old.partial === 1) !== (pt.partial === true);
    if (valueChanged || volumeChanged || partialChanged) changed++;
  }
  await storeSeries(ctx, key, pts);
  return { appended, reviewed, changed, skipped };
}

function sumCounts(list: StoreCounts[]): StoreCounts {
  return list.reduce<StoreCounts>(
    (a, c) => ({ appended: a.appended + c.appended, reviewed: a.reviewed + c.reviewed, changed: a.changed + c.changed, skipped: a.skipped + c.skipped }),
    { appended: 0, reviewed: 0, changed: 0, skipped: 0 },
  );
}

function countsSummary(label: string, c: StoreCounts, series: number, seededNow: boolean): string {
  return seededNow
    ? `${label}：首次种子入库 ${c.appended + c.reviewed} 点（${series} 条序列）`
    : `${label}：追加 ${c.appended} 点 · 重叠复核 ${c.reviewed} 点（其中数值变化 ${c.changed} 点）· 历史跳过 ${c.skipped} 点（${series} 条序列）`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const dashboardResponse = z.object({
  hasData: z.boolean(),
  windowDays: z.number(),
  // Cloud snapshot moved to getCloud (only fetched when the cloud page
  // opens); the overview card only needs the constituent counts.
  cloudCounts: z.object({ us: z.number(), ndx: z.number(), dow: z.number(), rut: z.number(), cn: z.number() }),
  // Static-library coverage per series: date range + point count, so
  // the seed/increment state of every series is visible on the page.
  coverage: z.array(z.object({ key: z.string(), from: z.string(), to: z.string(), points: z.number() })),
  // Newest refresh_log row per stage: each block of the page shows its
  // own 更新于 time, so cached data and freshly refreshed data are
  // visibly different.
  stages: z.array(
    z.object({ stage: z.string(), finishedAt: z.string(), status: z.string(), detail: z.string() }),
  ),
  updatedAt: z.string().nullable(),
  refreshStatus: z.string(),
  refreshDetail: z.string(),
  hero: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      value: z.number(),
      unit: z.string(),
      decimals: z.number(),
      changePct: z.number().nullable(),
      percentile: z.number().nullable(),
      // Sample size behind the percentile: number of trading days in
      // the selected window, from the same histStats call that produced
      // the percentile (same window, same口径 as the module pages'
      // StatsGrid). Null when the series is missing / too short to
      // compute stats — the card then says 样本天数暂无 instead of
      // inventing a number.
      count: z.number().nullable(),
      label: z.string(),
      // Bond-valuation lens flag for the percentile chip (CN 10Y yield
      // only): true = low percentile means the bond is expensive, so
      // the client reverses the chip / bar colours.
      invert: z.boolean(),
      date: z.string(),
      // Intraday snapshot, not the close (HK hero entry refreshed
      // before the 16:00 HK close) — the strip shows 盘中快照，未收盘.
      partial: z.boolean(),
    }),
  ),
  yields: z
    .object({
      date: z.string(),
      cn: z.array(tenorZ),
      us: z.array(tenorZ),
      curve: z.array(z.object({ tenor: z.string(), cn: z.number(), us: z.number().nullable() })),
      cn10yChart: z.array(chartPtZ),
      us10yChart: z.array(chartPtZ),
    })
    .nullable(),
  // 国开债−国债 10Y 利差 (monthly month-end spread in bp, stored
  // series "cdbgov10y"). Separate from the daily yields block: the
  // cadence and the percentile sample are monthly by design, so its
  // stats are computed over the full stored monthly history, never
  // sliced by the daily statistics window.
  cdbGov: z
    .object({
      date: z.string(),
      valueBp: z.number(),
      prevBp: z.number().nullable(),
      stats: statsZ.nullable(),
      chart: z.array(chartPtZ),
    })
    .nullable(),
  money: z
    .object({
      date: z.string(),
      shibor: z.array(
        z.object({
          key: z.string(),
          tenor: z.string(),
          value: z.number(),
          changeBp: z.number(),
          stats: statsZ.nullable(),
        }),
      ),
      cards: z.array(indicatorZ),
      fr007Chart: z.array(chartPtZ),
      fdr007Chart: z.array(chartPtZ),
      gc007Chart: z.array(chartPtZ),
      gc001Chart: z.array(chartPtZ),
    })
    .nullable(),
  derived: z.array(indicatorZ),
  instruments: z.array(instrumentZ),
  drawdowns: z.array(drawdownZ),
  signals: z.array(signalZ),
  fibs: z.array(fibZ),
  fred: z.array(indicatorZ),
  // Last stored point of the 10Y real-rate series (fredreal10), read
  // straight from the stored points regardless of the fredCard gates
  // (≥20 points / 370-day staleness). The gold page uses it as the
  // fallback when the wallst stage failed and no full real-rate card
  // renders: the last successful date + value stay visible instead of
  // a bare gap note. Null when the series has never landed.
  realRateLast: z.object({ date: z.string(), value: z.number(), points: z.number() }).nullable(),
  macroFred: z.array(indicatorZ),
  cnMoney: z.array(indicatorZ),
  // 融资余额 (v108): SH (SSE official) + SZ (SZSE disclosure; Eastmoney
  // mirror while the exchange site is unreachable from this network),
  // totals summed server-side. stats follow the page window like every
  // other block; statsFull is the trailing-5-year read the headline's
  // 5y percentile bar and the A1 signal share. Null until the margin
  // stage has landed both legs.
  marginCn: z
    .object({
      date: z.string(),
      totalYi: z.number(),
      shYi: z.number(),
      szYi: z.number(),
      buyYi: z.number(), // latest day, SH+SZ 融资买入额 （亿元）
      repayYi: z.number(), // 融资偿还额
      netYi: z.number(), // 融资净买入 = buy − repay
      rqyeYi: z.number(), // 融券余额 （亿元）
      rqylYiGu: z.number(), // 融券余量 （亿股）
      chg5Pct: z.number().nullable(), // 融资余额 5 / 20 交易日变化 %
      chg20Pct: z.number().nullable(),
      highYi: z.number(), // stored-history high of the total
      highDate: z.string(),
      distHighPct: z.number(), // (latest / high − 1) × 100, ≤ 0
      stats: statsZ.nullable(),
      statsFull: statsZ.nullable(),
      chart: z.array(chartPtZ), // window-sliced 融资余额合计
      netChart: z.array(chartPtZ), // window-sliced 融资净买入 (bars)
      points: z.number(), // stored trading days in the total series
      turnoverSharePct: z.number().nullable(), // 融资买入额占两市成交额比， latest aligned day
      szSource: z.string(), // "szse" | "em" | "" (which source the SZ leg landed from)
    })
    .nullable(),
  // FINRA 保证金负债 (v108): monthly, $ millions (the source's unit).
  // stats are FULL-history by design (monthly series; the page window
  // is a trading-day count and does not apply) — except in the
  // seed-only state (xlsx not yet landed, 13 page months), where
  // seedStats flags that the percentile covers only those months.
  marginUs: z
    .object({
      month: z.string(), // "2026-10"
      firstMonth: z.string(), // "1997-01" — the stored series' first month (percentile-window start; NOT stats.minDate, which is the month the minimum VALUE occurred)
      debtM: z.number(), // debit balances, $ millions
      cashM: z.number().nullable(), // free credit balances, cash accounts
      marginCreditM: z.number().nullable(), // free credit balances, margin accounts
      yoyPct: z.number().nullable(),
      highM: z.number(),
      highMonth: z.string(),
      distHighPct: z.number(),
      stats: statsZ.nullable(),
      seedStats: z.boolean(),
      fullHistory: z.boolean(), // true once the official xlsx history is on file
      chart: z.array(z.object({ d: z.string(), debt: z.number(), spx: z.number().nullable() })),
      points: z.number(), // stored months
    })
    .nullable(),
  // CNN Fear & Greed (v109): headline snapshot from the "_fear_greed"
  // KV row + the stored daily history ("fear_greed_cnn"). stats are
  // computed over the trailing-1-year window ONLY — the CNN endpoint's
  // history spans one year, so the percentile is a 1-year percentile
  // and is labelled with its window start (statsFrom) everywhere it
  // prints; it is never a 5-year figure. Null until the feargreed
  // stage has landed once.
  fearGreed: z
    .object({
      score: z.number(),
      updatedBj: z.string(), // CNN timestamp rendered in Beijing time, "2026-11-20 23:17"
      dateBj: z.string(), // Beijing date of the CNN timestamp
      prevClose: z.number(),
      prevWeek: z.number(),
      prevMonth: z.number(),
      prevYear: z.number(),
      components: z.array(z.object({ key: z.string(), score: z.number() })),
      stats: statsZ.nullable(), // trailing-1-year window stats
      statsFrom: z.string(), // first date inside the stats window
      distHigh: z.number(), // score − window max (≤ 0, points)
      distLow: z.number(), // score − window min (≥ 0, points)
      chart: z.array(chartPtZ), // full stored history
      points: z.number(), // stored daily points
    })
    .nullable(),
  // 抄底逃顶指数 (v120, 2026-11-22): server-computed composite of 10
  // bottom + 10 top contrarian signals over STORED series only (no
  // external fetch at read time). Each side's score = triggered share
  // of its AVAILABLE signals × 100, rounded; composite = top − bottom
  // (−100..100); ≤ −50 抄底区 / ≥ +30 逃顶区 (v121: thresholds calibrated
  // by the 2000–2026 episode backtest — see DATA-PLAN v121). Signals whose source is
  // unreachable (AAII 看多， 成分股宽度） or whose percentile is still
  // accumulating (forward PE) or whose latest point is stale carry
  // value/triggered = null and leave both numerator and denominator.
  // history is the trailing-2-year daily recomputation over the 11
  // daily-recomputable signals ONLY (VIX / 纳指·美元 200 日均线 / 标普
  // RSI / 标普回撤 / HY 利差） — a different denominator from today's
  // composite, labelled as such on the page. entries lists the first
  // day of each historical excursion into the bottom / top zone.
  bottomTop: z
    .object({
      bottomScore: z.number().nullable(),
      topScore: z.number().nullable(),
      composite: z.number().nullable(),
      zone: z.enum(["bottom", "neutral", "top"]).nullable(),
      bottomTriggered: z.number(),
      bottomAvailable: z.number(),
      topTriggered: z.number(),
      topAvailable: z.number(),
      asOf: z.string(), // newest stored SPX close — the trading day the composite is as of ("" when none)
      resonance: z.object({ vix: z.boolean(), ndxAbove: z.boolean(), dxyBelow: z.boolean(), all: z.boolean() }),
      signals: z.array(
        z.object({
          id: z.string(), // "B1".."B10" | "T1".."T10"
          side: z.enum(["bottom", "top"]),
          name: z.string(),
          value: z.number().nullable(),
          valueText: z.string(), // formatted current value, or the no-data / accumulating note
          threshold: z.string(),
          triggered: z.boolean().nullable(),
          pct: z.number().nullable(), // percentile signals only (T4/T5) — drives the mini PctBar
          date: z.string(),
          source: z.string(),
        }),
      ),
      history: z.array(z.object({ date: z.string(), composite: z.number(), bottomScore: z.number(), topScore: z.number() })),
      entries: z.array(z.object({ date: z.string(), zone: z.enum(["bottom", "top"]) })),
    })
    .nullable(),
  style: z.array(indicatorZ),
  seasonality: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      months: z.array(z.object({ m: z.number(), avg: z.number(), winRate: z.number(), n: z.number() })),
    }),
  ),
  breadth: z.array(
    z.object({
      label: z.string(),
      total: z.number(),
      // Tracked pools: % above MA250. Full-market (CSI 300) row: % above
      // MA200 — the cloud snapshot stores MA50/MA200, not MA250, and the
      // card labels it as such.
      aboveMaPct: z.number(),
      atHigh: z.number(),
      // Null on the full-market row: the cloud snapshot stores distance
      // below the 52-week HIGH only, so a near-low count cannot be
      // computed honestly from it (farFromHigh carries the deep-drawdown
      // count instead).
      atLow: z.number().nullable(),
      // Full-market row only (null on tracked pools): 1-day up / flat /
      // down counts over the whole constituent snapshot, using the cloud
      // map's own ±0.2% neutral band on d1 — by construction these equal
      // the sum of the cloud map's per-group breadth counts.
      up: z.number().nullable(),
      flat: z.number().nullable(),
      down: z.number().nullable(),
      aboveMa50Pct: z.number().nullable(),
      aboveMa200Pct: z.number().nullable(),
      farFromHigh: z.number().nullable(), // % of constituents >30% below their 52w high (count)
      asOf: z.string(), // full-market row: latest constituent close date; "" on tracked pools
      fullMarket: z.boolean(),
    }),
  ),
  portfolio: z.object({
    corrAssets: z.array(z.object({ key: z.string(), name: z.string() })),
    correlations: z.array(z.object({ a: z.string(), b: z.string(), v: z.number() })),
    sims: z.array(
      z.object({
        name: z.string(),
        desc: z.string(),
        years: z.number(),
        totalReturn: z.number(),
        cagr: z.number(),
        vol: z.number(),
        maxDd: z.number(),
        currentDd: z.number(),
        curve: z.array(chartPtZ),
      }),
    ),
  }),
  calendar: z.object({
    events: z.array(
      z.object({
        date: z.string(),
        timeText: z.string(),
        title: z.string(),
        category: z.string(),
        impact: z.string(),
        forecast: z.string(),
        previous: z.string(),
        explain: z.string(),
        watch: z.string(),
        source: z.string(),
        past: z.boolean(),
        estimated: z.boolean(),
      }),
    ),
  }),
});

// ---------------------------------------------------------------------------
// Refresh stages
// ---------------------------------------------------------------------------
// A refresh is split into independent stages so the client can run them
// one by one in the background: each stage is its own action call with
// its own time budget, stores its data the moment it lands, and writes
// its own refresh_log row (stage column) — the dashboard reads the
// newest row per stage so every block can show its own 更新于 time and
// the user can tell cached blocks from freshly refreshed ones. A failed
// stage never touches its stored data: the previous snapshot keeps
// rendering and the failure reason lands in the stage's log row.

type StageResult = { fetched: number; errors: string[]; summary?: string; ok?: boolean };

// D-P2-4: refresh_log retention — keep only the newest 200 rows AND
// only rows from the last 30 days (whichever bound bites first). A
// full refresh writes ~12 rows, so unbounded growth would bury the
// per-stage newest-row reads under history nobody looks at. Pruning
// runs on every log write; the policy is also stated in the refresh
// panel so the cleanup is never silent.
const REFRESH_LOG_KEEP_ROWS = 200;
const REFRESH_LOG_KEEP_DAYS = 30;

async function pruneRefreshLog(ctx: Ctx): Promise<void> {
  const db = ctx.db<typeof schema>();
  const cutoff = new Date(Date.now() - REFRESH_LOG_KEEP_DAYS * 86_400_000);
  await db.delete(schema.refreshLog).where(lt(schema.refreshLog.finishedAt, cutoff));
  const floorRows = await db
    .select({ id: schema.refreshLog.id })
    .from(schema.refreshLog)
    .orderBy(desc(schema.refreshLog.id))
    .limit(1)
    .offset(REFRESH_LOG_KEEP_ROWS - 1);
  const floorId = floorRows[0]?.id;
  if (floorId !== undefined) {
    await db.delete(schema.refreshLog).where(lt(schema.refreshLog.id, floorId));
  }
}

async function writeStageLog(ctx: Ctx, stage: string, r: StageResult): Promise<void> {
  const db = ctx.db<typeof schema>();
  const status = r.ok === true || r.errors.length === 0 ? "ok" : r.fetched > 0 ? "partial" : "error";
  await db.insert(schema.refreshLog).values({
    stage,
    status,
    detail: r.errors.length ? r.errors.join("；") : (r.summary ?? `成功更新 ${r.fetched} 条序列`),
  });
  await pruneRefreshLog(ctx);
}

// Daily-attempt gate for sources that fail on (nearly) every refresh
// (the iShares IWM holdings file — see
// failing-sources-alternatives-20261121.md §2.4): a known-dead
// source is attempted at most once per Beijing calendar day. Later
// refreshes the same day skip the attempt and report a skip-note in
// the stage summary instead of an error, so the refresh banner stops
// re-listing the same failure every run while the gap stays honestly
// labelled on the page. The gate reads refresh_log (kept 200 rows —
// today's rows are always within it); no new table. `markers` are
// substrings of the failure text the attempt writes into the stage's
// log detail. Returns the Beijing time (HH:MM) of the last attempt
// today, or null when no attempt was recorded today. Callers pass
// rebuild=true to bypass the gate (an explicit rebuild is an
// explicit attempt).
async function attemptedTodayAt(ctx: Ctx, stage: string, markers: string[]): Promise<string | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select({ detail: schema.refreshLog.detail, finishedAt: schema.refreshLog.finishedAt })
    .from(schema.refreshLog)
    .where(eq(schema.refreshLog.stage, stage))
    .orderBy(desc(schema.refreshLog.id))
    .limit(20);
  const bj = (d: Date) => new Date(d.getTime() + 8 * 3600 * 1000).toISOString();
  const today = bj(new Date()).slice(0, 10);
  for (const r of rows) {
    if (bj(r.finishedAt).slice(0, 10) !== today) continue;
    if (markers.some((m) => r.detail.includes(m))) return bj(r.finishedAt).slice(11, 16);
  }
  return null;
}

/** Yahoo price series for every tracked instrument (the heavy history
 *  behind charts, percentiles, drawdowns and signals). Seeded series
 *  only fetch their tail; unseeded ones take the full configured
 *  window once. */
async function stagePrices(ctx: Ctx, rebuild: boolean): Promise<StageResult> {
  const errors: string[] = [];
  let fetched = 0;
  const coverage = await seriesCoverage(ctx);
  const counts: StoreCounts[] = [];
  let seededNow = false;
  const hkPartialNames: string[] = [];
  // One HK session snapshot for the whole prices round: every HK
  // fetch and the gap fill below judge "is today's bar still an
  // intraday snapshot" by this single clock reading, so the three HK
  // series can never split across the close boundary within a round.
  const hkSnap = hkSession();
  await Promise.all(
    PRICE_SERIES.map(async (cfg) => {
      try {
        const prev = coverage.get(cfg.key);
        const tail = tailFrom(prev, rebuild, 14);
        if (!tail) seededNow = true;
        const pts = await fetchYahoo(cfg, tail, hkSnap);
        if (pts.length < (tail ? 1 : 60)) throw new Error(`仅 ${pts.length} 个数据点`);
        if (pts[pts.length - 1]?.partial) hkPartialNames.push(cfg.name);
        counts.push(await storeSeriesCounted(ctx, cfg.key, pts, prev));
        fetched++;
      } catch (e) {
        errors.push(`${cfg.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
  );
  // Second-source fill for Yahoo's ETF holes + explicit missing-day
  // warnings (see fillEtfGaps). Runs after the Yahoo stores so it sees
  // the freshest stored state — and re-fills any point the Yahoo
  // overlap-window replace just deleted again.
  const gap = await fillEtfGaps(ctx, hkSnap);
  errors.push(...gap.warnings);
  // Fibonacci 52-week anchors ride the prices stage: recomputed from
  // Yahoo OHLC and cross-validated against Nasdaq on every round.
  const fib = await refreshFibAnchors(ctx);
  errors.push(...fib.errors);
  const base = countsSummary("行情序列", sumCounts(counts), fetched, seededNow);
  const notes: string[] = [base];
  if (fib.note) notes.push(fib.note);
  if (gap.filled > 0) notes.push(`东财 push2his 补齐 Yahoo 缺日 ${gap.filled} 点`);
  const allHkPartialNames = [...new Set([...hkPartialNames, ...gap.hkPartialNames])];
  if (allHkPartialNames.length > 0)
    notes.push(`港股未收盘（16:10 收盘竞价结束前刷新）：${allHkPartialNames.join("、")} 当日为盘中快照，收盘后刷新将覆写为收盘价`);
  return { fetched, errors, summary: notes.join("；") };
}

/** CN/US treasury yield curves from Eastmoney (seeded once at ~10y,
 *  then tail-paged). */
async function stageYields(ctx: Ctx, rebuild: boolean): Promise<StageResult> {
  const errors: string[] = [];
  let fetched = 0;
  const coverage = await seriesCoverage(ctx);
  const tail = tailFrom(coverage.get("cn10y"), rebuild, 14);
  const counts: StoreCounts[] = [];
  try {
    const yields = await fetchYields(tail);
    for (const [key, pts] of yields) {
      if (pts.length >= (tail ? 1 : 60)) {
        counts.push(await storeSeriesCounted(ctx, key, pts, coverage.get(key)));
        fetched++;
      } else {
        errors.push(`${key}: 收益率数据点不足`);
      }
    }
  } catch (e) {
    errors.push(`国债收益率: ${e instanceof Error ? e.message : String(e)}`);
  }
  // ChinaBond leg: the 1Y/3Y/7Y tenors Eastmoney's report doesn't
  // carry. Its own tail (from cn1y's coverage) and its own failure
  // domain — a ChinaBond outage costs only this leg; stored curve
  // history stays put and the Eastmoney tenors above still refresh.
  let cbSeededNow = false;
  try {
    const cbTail = tailFrom(coverage.get("cn1y"), rebuild, 14);
    if (!cbTail) cbSeededNow = true;
    const curve = await fetchChinaBondCurve(cbTail);
    for (const [key, pts] of curve) {
      if (pts.length >= (cbTail ? 1 : 60)) {
        counts.push(await storeSeriesCounted(ctx, key, pts, coverage.get(key)));
        fetched++;
      } else {
        errors.push(`${key}: 中债曲线数据点不足`);
      }
    }
  } catch (e) {
    errors.push(`中债国债曲线（1/3/7 年）: ${e instanceof Error ? e.message : String(e)}`);
  }
  // CDB−govt 10Y spread leg (monthly month-end points, series
  // "cdbgov10y"): both legs are ChinaBond curves — govt 10Y via the
  // pbc historyQuery, CDB 10Y via the main site's curve detail
  // endpoint (the pbc endpoint carries no policy-bank curve). Its
  // own tail with a 40-day overlap (always covers the previous
  // month-end, so the open month's provisional point is replaced as
  // the month finalises) and its own failure domain.
  let spSeededNow = false;
  try {
    const spTail = tailFrom(coverage.get("cdbgov10y"), rebuild, 40);
    if (!spTail) spSeededNow = true;
    const spPts = await fetchCdbGovSpreadMonthly(spTail);
    if (spPts.length >= (spTail ? 1 : 60)) {
      counts.push(await storeSeriesCounted(ctx, "cdbgov10y", spPts, coverage.get("cdbgov10y")));
      fetched++;
    } else {
      errors.push(`cdbgov10y: 国开债利差月度点不足（${spPts.length}）`);
    }
  } catch (e) {
    errors.push(`国开债−国债 10Y 利差（中债双曲线）: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { fetched, errors, summary: countsSummary("收益率序列", sumCounts(counts), fetched, !tail || cbSeededNow || spSeededNow) };
}

/** A-share margin balance + two-market turnover + southbound net buy (tail-incremental). */
async function stageExtras(ctx: Ctx, rebuild: boolean): Promise<StageResult> {
  const errors: string[] = [];
  let fetched = 0;
  const coverage = await seriesCoverage(ctx);
  const counts: StoreCounts[] = [];
  let seededNow = false;
  const jobs: [string, string, (t: string | null) => Promise<Map<string, Pt[]>>][] = [
    ["两融余额", "margin", (t) => fetchMargin(t)],
    ["两市成交额", "sseamt", (t) => fetchTurnover(t)],
    ["南向资金", "southbound", (t) => fetchSouthbound(t)],
    // CSI dividend yields ignore the tail: the publisher's file is a
    // fixed ~20-trading-day window, and the windowed store accumulates
    // it into a growing history (see fetchCsiDivYieldOne).
    ["红利低波股息率（中证官网）", "divlowdy", () => fetchCsiDivYieldOne("H30269", "divlowdy", "红利低波")],
    ["上证红利股息率（中证官网）", "divdy", () => fetchCsiDivYieldOne("000015", "divdy", "上证红利")],
  ];
  for (const [label, probeKey, job] of jobs) {
    try {
      const tail = tailFrom(coverage.get(probeKey), rebuild, 14);
      if (!tail) seededNow = true;
      const series = await job(tail);
      for (const [key, pts] of series) {
        if (pts.length >= (tail ? 1 : 20)) {
          counts.push(await storeSeriesCounted(ctx, key, pts, coverage.get(key)));
          fetched++;
        } else {
          errors.push(`${label} ${key}: 数据点不足（${pts.length}）`);
        }
      }
    } catch (e) {
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { fetched, errors, summary: countsSummary("两融、成交额、南向资金与红利股息率", sumCounts(counts), fetched, seededNow) };
}

/** Margin balances (v108): SH margin from the SSE official endpoint +
 *  SZ margin (SZSE official first, Eastmoney mirror fallback) with the
 *  SH+SZ totals computed here, plus FINRA monthly margin debt. Each
 *  leg is its own failure domain: a failed leg keeps its stored data
 *  and is named in the stage result; totals only move when BOTH CN
 *  legs landed, so a one-sided failure can never skew the headline. */
async function stageMargin(ctx: Ctx, rebuild: boolean): Promise<StageResult> {
  const errors: string[] = [];
  let fetched = 0;
  const coverage = await seriesCoverage(ctx);
  const counts: StoreCounts[] = [];
  let seededNow = false;
  const yi = (yuan: number): number => Math.round((yuan / 1e8) * 100) / 100;
  const toPts = (rows: MarginRow[], pick: (r: MarginRow) => number): Pt[] =>
    rows.map((r) => ({ date: r.date, value: pick(r), volume: null }));

  let shRows: MarginRow[] | null = null;
  try {
    const tail = tailFrom(coverage.get("margin_sh"), rebuild, 20);
    if (!tail) seededNow = true;
    shRows = await fetchSseMargin(tail);
    if (shRows.length < (tail ? 1 : 1000)) throw new Error(`行数不足（${shRows.length}）`);
  } catch (e) {
    errors.push(`沪市融资融券（上交所官网）: ${e instanceof Error ? e.message : String(e)}`);
  }

  let szRows: MarginRow[] | null = null;
  let szSource = "";
  try {
    const tail = tailFrom(coverage.get("margin_sz"), rebuild, 20);
    if (!tail) seededNow = true;
    try {
      szRows = await fetchSzseMarginOfficial(tail);
      szSource = "szse";
    } catch {
      szRows = await fetchEastmoneyMarginMarket("001", tail);
      szSource = "em";
    }
    if (szRows.length < (tail ? 1 : 1000)) throw new Error(`行数不足（${szRows.length}）`);
  } catch (e) {
    errors.push(`深市融资融券（深交所官网与东财镜像均未取到）: ${e instanceof Error ? e.message : String(e)}`);
    szRows = null;
  }

  if (shRows) {
    counts.push(await storeSeriesCounted(ctx, "margin_sh", toPts(shRows, (r) => yi(r.rzye)), coverage.get("margin_sh")));
    fetched++;
  }
  if (szRows) {
    counts.push(await storeSeriesCounted(ctx, "margin_sz", toPts(szRows, (r) => yi(r.rzye)), coverage.get("margin_sz")));
    fetched++;
  }
  if (shRows && szRows) {
    const szMap = new Map(szRows.map((r) => [r.date, r]));
    const both: MarginRow[] = [];
    for (const s of shRows) {
      const z = szMap.get(s.date);
      if (z) {
        both.push({
          date: s.date,
          rzye: s.rzye + z.rzye,
          buy: s.buy + z.buy,
          repay: s.repay + z.repay,
          rqye: s.rqye + z.rqye,
          rqyl: s.rqyl + z.rqyl,
        });
      }
    }
    if (both.length > 0) {
      const legs: [string, Pt[]][] = [
        ["margin_total", toPts(both, (r) => yi(r.rzye))],
        ["margin_total_buy", toPts(both, (r) => yi(r.buy))],
        ["margin_total_repay", toPts(both, (r) => yi(r.repay))],
        ["margin_total_net", toPts(both, (r) => yi(r.buy - r.repay))],
        ["margin_total_rqye", toPts(both, (r) => yi(r.rqye))],
        ["margin_total_rqyl", toPts(both, (r) => yi(r.rqyl))],
      ];
      for (const [key, pts] of legs) {
        counts.push(await storeSeriesCounted(ctx, key, pts, coverage.get(key)));
        fetched++;
      }
    }
  }

  // FINRA: monthly — the xlsx carries the full history every time, so
  // a landed fetch simply rewrites it; only a NEW month changes the
  // tail. On failure: a stored full history stays untouched (named
  // error), an empty / seed-only store takes the verified page seed.
  let finraFull: boolean | null = null;
  try {
    const { rows } = await ctx.executePrivileged(privileged.fetchFinraMargin, {});
    const prevCount = coverage.get("finra_margin_debt")?.count ?? 0;
    const debtPts: Pt[] = rows.map((r) => ({ date: `${r.month}-01`, value: r.debt, volume: null }));
    const cashPts: Pt[] = rows
      .filter((r) => r.cash !== null)
      .map((r) => ({ date: `${r.month}-01`, value: r.cash as number, volume: null }));
    const mcPts: Pt[] = rows
      .filter((r) => r.marginCredit !== null)
      .map((r) => ({ date: `${r.month}-01`, value: r.marginCredit as number, volume: null }));
    counts.push(await storeSeriesCounted(ctx, "finra_margin_debt", debtPts, coverage.get("finra_margin_debt")));
    if (cashPts.length > 0) counts.push(await storeSeriesCounted(ctx, "finra_credit_cash", cashPts, coverage.get("finra_credit_cash")));
    if (mcPts.length > 0) counts.push(await storeSeriesCounted(ctx, "finra_credit_margin", mcPts, coverage.get("finra_credit_margin")));
    fetched += 3;
    finraFull = prevCount >= 100 || rows.length >= 100;
  } catch (e) {
    const prevCount = coverage.get("finra_margin_debt")?.count ?? 0;
    if (prevCount >= 100) {
      errors.push(`FINRA 保证金负债 xlsx: ${e instanceof Error ? e.message : String(e)}（全历史旧数据保留）`);
      finraFull = true;
    } else {
      const seed = FINRA_PAGE_SEED;
      counts.push(
        await storeSeriesCounted(
          ctx,
          "finra_margin_debt",
          seed.map((r) => ({ date: `${r.month}-01`, value: r.debt, volume: null })),
          coverage.get("finra_margin_debt"),
        ),
      );
      counts.push(
        await storeSeriesCounted(
          ctx,
          "finra_credit_cash",
          seed.map((r) => ({ date: `${r.month}-01`, value: r.cash as number, volume: null })),
          coverage.get("finra_credit_cash"),
        ),
      );
      counts.push(
        await storeSeriesCounted(
          ctx,
          "finra_credit_margin",
          seed.map((r) => ({ date: `${r.month}-01`, value: r.marginCredit as number, volume: null })),
          coverage.get("finra_credit_margin"),
        ),
      );
      fetched += 3;
      finraFull = false;
    }
  }

  if (szSource || finraFull !== null) {
    await writeMarginMeta(ctx, {
      ...(szSource ? { szSource } : {}),
      ...(finraFull !== null ? { finraFull } : {}),
    });
  }
  const summary =
    countsSummary("融资余额（沪深两市）与 FINRA 保证金负债", sumCounts(counts), fetched, seededNow) +
    (szSource === "em"
      ? "；深市来源：东方财富数据中心转引深交所披露（深交所官网接口本机不可达，自动回退镜像，数值与深交所披露逐项交叉核对一致）"
      : szSource === "szse"
        ? "；深市来源：深交所官网"
        : "") +
    (finraFull === false ? "；FINRA 全历史 xlsx 本次未取到：已按 FINRA 官网页面最近 13 个月值入库，全历史百分位暂缺、待 xlsx 接入" : "");
  return { fetched, errors, summary };
}

/** CNN Fear & Greed (v109): one endpoint carries everything — the
 *  headline snapshot (score, the four comparison prints, the 7
 *  component scores, CNN's own timestamp) and the trailing-1-year
 *  daily history. The history is stored through the counted store so
 *  the stored series accumulates past the endpoint's 1-year window
 *  (older points sit before each new fetch's window and are skipped,
 *  never deleted); the snapshot replaces the "_fear_greed" KV row.
 *  A failed fetch stores nothing: the previous snapshot and history
 *  keep rendering and the failure is named in the stage log. */
async function stageFearGreed(ctx: Ctx): Promise<StageResult> {
  try {
    const { snap, history } = await fetchFearGreed();
    const coverage = await seriesCoverage(ctx);
    const counts = await storeSeriesCounted(ctx, "fear_greed_cnn", history, coverage.get("fear_greed_cnn"));
    await writeFearGreedMeta(ctx, snap);
    return {
      fetched: 1,
      errors: [],
      summary: `恐惧与贪婪指数（CNN）：当前 ${snap.score.toFixed(2)}（${snap.rating}，CNN 时间戳 ${bjDateTimeText(new Date(snap.timestamp))} 北京时间）；${countsSummary("历史日度序列", counts, 1, (coverage.get("fear_greed_cnn")?.count ?? 0) === 0)}`,
    };
  } catch (e) {
    return {
      fetched: 0,
      errors: [`CNN 恐惧与贪婪指数: ${e instanceof Error ? e.message : String(e)}（旧数据保留）`],
    };
  }
}

// ---------------------------------------------------------------------------
// CBOE total Put/Call ratio (v120, 2026-11-22). Source: CBOE's official
// daily options statistics JSON on its CDN,
// https://cdn.cboe.com/data/us/options/market_statistics/daily/{YYYY-MM-DD}_daily_options
// — verified live 2026-11-22: the 2026-11-20 file answers HTTP 200 and
// its `ratios` array carries "TOTAL PUT/CALL RATIO": "1.13" (alongside
// INDEX 1.27 / ETP 1.35 / EQUITY 0.77 / VIX 0.80 …). A trading day's
// file appears only after that day's close, so the fetcher walks back
// from today at most 7 calendar days and takes the first file that
// exists; the stored date is the FILE's date, never the fetch date.
// Values are sanity-checked to 0.2–3.0 — outside that the fetch throws
// and nothing is stored (the previous point keeps rendering). Only the
// newest available day is taken per run: the series accumulates one
// point per refresh day, which is all the 抄底逃顶 module needs (the
// P/C ratio is deliberately NOT part of its 2-year history curve —
// backfilling would mean ~500 daily files).
// ---------------------------------------------------------------------------

async function fetchCboeTotalPc(_tail: string | null): Promise<Pt[]> {
  // _tail is accepted for the shared stage signature only: this source
  // publishes one file per day with no range endpoint, so there is no
  // window to fetch — the newest published day IS the increment, and
  // storeSeriesCounted's overlap counting dedupes a same-day re-run.
  void _tail;
  const now = new Date();
  for (let back = 0; back <= 7; back++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - back));
    const ds = d.toISOString().slice(0, 10);
    let res: Response;
    try {
      res = await fetch(`https://cdn.cboe.com/data/us/options/market_statistics/daily/${ds}_daily_options`, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      continue; // transport error on this date — try the previous day
    }
    if (!res.ok) continue; // no file for this date (weekend / holiday / not yet published)
    const j = (await res.json()) as { ratios?: { name?: unknown; value?: unknown }[] };
    const row = (j.ratios ?? []).find((r) => r.name === "TOTAL PUT/CALL RATIO");
    const v = Number(row?.value);
    if (!Number.isFinite(v)) throw new Error(`CBOE ${ds} 文件结构变化（未找到 TOTAL PUT/CALL RATIO）`);
    if (v < 0.2 || v > 3.0) throw new Error(`CBOE 总 Put/Call 值越界（${ds}: ${v}，合理区间 0.2–3.0）`);
    return [{ date: ds, value: Math.round(v * 100) / 100, volume: null }];
  }
  throw new Error("近 7 天内未找到 CBOE 每日期权统计文件");
}

/** CBOE total Put/Call stage (v120): stores the newest published day
 *  under "cboe_total_pcr". Failure isolation matches every other
 *  stage: nothing is written, the stored series keeps rendering, and
 *  the reason lands in the stage log. */
async function stagePcr(ctx: Ctx, rebuild: boolean): Promise<StageResult> {
  try {
    const coverage = await seriesCoverage(ctx);
    const prev = coverage.get("cboe_total_pcr");
    const tail = tailFrom(prev, rebuild, 92);
    const pts = await fetchCboeTotalPc(tail);
    const counts = await storeSeriesCounted(ctx, "cboe_total_pcr", pts, prev);
    const last = pts[pts.length - 1];
    return {
      fetched: 1,
      errors: [],
      summary: `CBOE 总 Put/Call 比率：最新 ${last ? last.value.toFixed(2) : "—"}（${last?.date ?? ""}）；${countsSummary("日度序列", counts, 1, (prev?.count ?? 0) === 0)}`,
    };
  } catch (e) {
    return {
      fetched: 0,
      errors: [`CBOE 总 Put/Call: ${e instanceof Error ? e.message : String(e)}（旧数据保留）`],
    };
  }
}

/** Historical index PE series (V-1 step 5): CSI's published month-end
 *  TTM PE for the eleven pipeline targets. Seeded once from 2020-01;
 *  later rounds only re-request the tail (last stored month-end minus
 *  ~100 days of overlap) and the windowed store appends / re-checks
 *  exactly like every other static series. Each index is its own
 *  failure domain: one index failing keeps its stored history and is
 *  named in the stage log.
 *  Part 1 (2026-11-20) adds two US series to the same stage: the
 *  S&P 500 monthly TTM PE from Multpl (pe_spx, live primary) and
 *  the S&P 500 CAPE history from Shiller (cape_spx, frozen at
 *  2023-09 — history-only, labelled by capeNote, never a current
 *  percentile). NDX is deliberately NOT added here: Siblis exposes
 *  no programmatic monthly series (see the NOT comment above). */
async function stagePe(ctx: Ctx, rebuild: boolean): Promise<StageResult> {
  const errors: string[] = [];
  let fetched = 0;
  const coverage = await seriesCoverage(ctx);
  const counts: StoreCounts[] = [];
  let seededNow = false;
  await mapPool(INDEX_PE_TARGETS, 4, async (t) => {
    const key = peSeriesKey(t.key);
    try {
      const prev = coverage.get(key);
      const tail = tailFrom(prev, rebuild, 100);
      if (!tail) seededNow = true;
      const startYmd = tail ? tail.replace(/-/g, "") : "20200101";
      const pts = await fetchCsiIndexPeMonthly(t.csiCode, startYmd);
      if (pts.length < (tail ? 1 : 24)) throw new Error(`月末点不足（${pts.length}）`);
      counts.push(await storeSeriesCounted(ctx, key, pts, prev));
      fetched++;
    } catch (e) {
      errors.push(`${t.indexName}（${t.csiCode}）: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  // S&P 500 (V-1 step 5, part 1, 2026-11-20): Multpl monthly TTM PE is
  // the live primary (1871-01 → now, 1872 points at seed); Shiller's
  // Yale file is the frozen deep-history cross-check (verified
  // 2026-11-20: 1830 overlapping months, mean/median diff 0.00, max
  // |diff| 0.065) and the CAPE history source (ends 2023-09, frozen
  // — stored history-only, never a current percentile). NDX is
  // annual-points-only (B1, 2026-11-20): Siblis exposes no
  // programmatic monthly series, so pe_ndx_annual stores the 11
  // annual December + latest-month points — current-value material
  // only, never percentile input (see fetchSiblisNdxAnnual).
  let capeNote = "";
  const usJobs: { key: string; label: string; minSeed: number; run: (tail: string | null) => Promise<Pt[]>; overlap?: number }[] = [
    { key: "pe_spx", label: "标普500 TTM PE（Multpl）", minSeed: 1000, run: (t) => fetchMultplSp500Pe(t) },
    { key: "cape_spx", label: "标普500 CAPE（Shiller）", minSeed: 1000, run: (t) => fetchShillerCape(t) },
    { key: "pe_ndx_annual", label: "纳指100 TTM PE（Siblis 年度点）", minSeed: 8, run: (t) => fetchSiblisNdxAnnual(t), overlap: 370 },
  ];
  for (const job of usJobs) {
    try {
      const prev = coverage.get(job.key);
      const tail = tailFrom(prev, rebuild, job.overlap ?? 92);
      if (!tail) seededNow = true;
      const pts = await job.run(tail);
      if (pts.length < (tail ? 1 : job.minSeed)) throw new Error(`点数不足（${pts.length}）`);
      counts.push(await storeSeriesCounted(ctx, job.key, pts, prev));
      fetched++;
      if (job.key === "cape_spx") {
        const newest = pts[pts.length - 1]?.date ?? "";
        const todayBj = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
        const ageDays = newest ? (Date.parse(`${todayBj}T00:00:00Z`) - Date.parse(`${newest}T00:00:00Z`)) / 86400000 : 9999;
        if (ageDays > 400) capeNote = `；CAPE 历史序列截至 ${newest}（Shiller 源站未更新，当前值暂缺）`;
      }
    } catch (e) {
      errors.push(`${job.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Hang Seng (V-1 step 5, part 2, 2026-11-20): Siblis annual points
  // only — the monthly series is paywalled, so these 11 points are
  // current-value + history-note material, never percentile input
  // (see fetchSiblisHsiAnnual). hsi.com.hk itself publishes no
  // programmatic history (factsheet PDF = current month only).
  const hsiJobs: { key: string; label: string; which: "ttm" | "forward" }[] = [
    { key: "pe_hsi_annual", label: "恒生 TTM PE（Siblis 年度点）", which: "ttm" },
    { key: "fwd_hsi_annual", label: "恒生 forward PE（Siblis 年度点）", which: "forward" },
  ];
  for (const job of hsiJobs) {
    try {
      const prev = coverage.get(job.key);
      const tail = tailFrom(prev, rebuild, 370);
      if (!tail) seededNow = true;
      const pts = await fetchSiblisHsiAnnual(job.which);
      const fresh = tail ? pts.filter((p) => p.date >= tail) : pts;
      if (fresh.length < (tail ? 1 : 8)) throw new Error(`年度点不足（${fresh.length}）`);
      counts.push(await storeSeriesCounted(ctx, job.key, fresh, prev));
      fetched++;
    } catch (e) {
      errors.push(`${job.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // SPDR sectors + US dividend ETFs (part 2, 2026-11-20): no official
  // PE history exists (SPDJI 403, GuruFocus Cloudflare-403 from this
  // network), so history is ACCUMULATED from Yahoo's current
  // trailingPE — one point per week, same crumb leg the cloud tiles
  // already use (fetchYahooQuoteBatch). A week with no finite
  // trailingPE stores nothing (never zero-filled); values outside
  // 3–200 are rejected as bad prints. Percentile appears
  // automatically once a series reaches 8 weekly points (~8 weeks);
  // until then the card shows 积累中. Source label (see the
  // getDashboard attach) says plainly this is Yahoo current prints,
  // not an official series. The 6-day throttle reads the series'
  // stored maxDate from the coverage map taken at stage start.
  try {
    const etfSyms = ["XLB", "XLC", "XLE", "XLF", "XLI", "XLK", "XLP", "XLRE", "XLU", "XLV", "XLY", "SCHD", "VYM", "VIG", "DGRO", "SPYD", "HDV"];
    const symToKey: Record<string, string> = { XLB: "sec_xlb", XLC: "sec_xlc", XLE: "sec_xle", XLF: "sec_xlf", XLI: "sec_xli", XLK: "sec_xlk", XLP: "sec_xlp", XLRE: "sec_xlre", XLU: "sec_xlu", XLV: "sec_xlv", XLY: "sec_xly", SCHD: "schd", VYM: "vym", VIG: "vig", DGRO: "dgro", SPYD: "spyd", HDV: "hdv" };
    const quotes = await fetchYahooQuoteBatch(etfSyms);
    const bj = new Date(Date.now() + 8 * 3600_000);
    const today = `${bj.getUTCFullYear()}-${String(bj.getUTCMonth() + 1).padStart(2, "0")}-${String(bj.getUTCDate()).padStart(2, "0")}`;
    for (const sym of etfSyms) {
      const key = symToKey[sym]!;
      const pe = quotes.get(sym)?.peTtm ?? null;
      try {
        if (pe === null || !(pe >= 3 && pe <= 200)) throw new Error(pe === null ? "Yahoo 未返回 trailingPE" : `PE 越界（${pe}）`);
        const prev = coverage.get(peSeriesKey(key));
        const lastDate = prev?.maxDate ?? "";
        if (lastDate) {
          const ageDays = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${lastDate}T00:00:00Z`)) / 86400000;
          if (ageDays < 6) continue; // weekly cadence: at most one point per 6 days
        }
        counts.push(await storeSeriesCounted(ctx, peSeriesKey(key), [{ date: today, value: Math.round(pe * 100) / 100, volume: null }], prev));
        fetched++;
      } catch (e) {
        errors.push(`${sym}（${key}）周度 PE: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    errors.push(`SPDR/红利周度 PE 整腿失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { fetched, errors, summary: countsSummary("指数历史 PE 序列（中证官网月末点 + Multpl 标普 500 月度点 + Shiller CAPE 历史 + Siblis 恒生年度点 + Yahoo ETF 周度 PE 积累）", sumCounts(counts), fetched, seededNow) + capeNote };
}

/** Money-market rates: ChinaMoney repo fixings + SHIBOR, exchange repo
 *  (tail-incremental per source). */
async function stageMoney(ctx: Ctx, rebuild: boolean): Promise<StageResult> {
  const errors: string[] = [];
  let fetched = 0;
  const coverage = await seriesCoverage(ctx);
  const counts: StoreCounts[] = [];
  let seededNow = false;
  const jobs: [string, string, (t: string | null) => Promise<Map<string, Pt[]>>][] = [
    ["回购定盘利率", "fr007", (t) => fetchRepoFixing(t)],
    // shibor2w / shibor9m joined the field list later than the other six
    // tenors: while either lacks a seeded history, ignore the tail and
    // pull the full 5-year window once so their percentiles are real.
    ["SHIBOR", "shibor3m", (t) =>
      fetchShibor(
        (coverage.get("shibor2w")?.count ?? 0) < 60 || (coverage.get("shibor9m")?.count ?? 0) < 60 ? null : t,
      )],
    ["交易所回购", "gc007", (t) => fetchExchangeRepo(t)],
  ];
  for (const [label, probeKey, job] of jobs) {
    try {
      const tail = tailFrom(coverage.get(probeKey), rebuild, 14);
      if (!tail) seededNow = true;
      const series = await job(tail);
      for (const [key, pts] of series) {
        if (pts.length >= (tail ? 1 : 60)) {
          counts.push(await storeSeriesCounted(ctx, key, pts, coverage.get(key)));
          fetched++;
        } else {
          errors.push(`${label} ${key}: 数据点不足（${pts.length}）`);
        }
      }
    } catch (e) {
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { fetched, errors, summary: countsSummary("资金面序列", sumCounts(counts), fetched, seededNow) };
}

/** Wall-Street layer: US Treasury curves + NY Fed EFFR (primary official
 *  publishers) win their keys; NY Fed ACM / Michigan extras fill theirs;
 *  BLS (primary publisher) supplies the CPI / unemployment monthly macro
 *  series; corporate profits come from BEA direct (NIPA T11200 line 45,
 *  the authoritative publisher) with FRED's CP mirror as fallback;
 *  FRED fills whatever remains (HY/IG OAS, broad USD, core PCE) via its
 *  official API with the server-held key — fetched normally on every
 *  run (the fredgraph-era daily gate is retired; the API answers
 *  reliably and the free key's 120 req/min limit is far above this
 *  stage's ~14 calls per refresh). */
async function stageWallst(ctx: Ctx, rebuild: boolean): Promise<StageResult> {
  const errors: string[] = [];
  let fetched = 0;
  const coverage = await seriesCoverage(ctx);
  const existingReal = coverage.get("fredreal10");
  const treasuryBackfill = rebuild || (existingReal?.count ?? 0) < 1000;
  // Per-series tails: daily series overlap two weeks; the weekly NFCI
  // two months; the monthly/quarterly series (sentiment, profits) a
  // long 400 days so a late revision still lands inside the window.
  const fredTails = new Map<string, string>();
  for (const fs of FRED_SERIES) {
    const overlap =
      fs.key === "fredsent" || fs.key === "fredcp" || fs.key === "fredcpi" || fs.key === "fredunrate" || fs.key === "fredpce"
        ? 400
        : fs.key === "frednfci"
          ? 60
          : 14;
    const t = tailFrom(coverage.get(fs.key), rebuild, overlap);
    if (t) fredTails.set(fs.key, t);
  }
  const effrTail = tailFrom(coverage.get("freddff"), rebuild, 14);
  const extrasTail = tailFrom(coverage.get("fredtp10"), rebuild, 200);
  const blsTail = tailFrom(coverage.get("fredcpi"), rebuild, 400);
  const fredApiKey = await loadFredApiKey(ctx);
  const beaApiKey = await loadBeaApiKey(ctx);
  const [treasuryRes, effrRes, extrasRes, fredRes, blsRes, beaRes] = await Promise.allSettled([
    fetchTreasuryCurves(treasuryBackfill),
    fetchEffr(effrTail),
    fetchOfficialMacroExtras(extrasTail),
    fetchFred(fredTails, fredApiKey),
    fetchBlsMacro(blsTail),
    // BEA profits always pull the full history: Year=ALL is a single
    // request, so every run re-verifies all 318 quarters against the
    // authoritative source and any revision anywhere lands.
    fetchBeaProfits(true, beaApiKey),
  ]);
  const map = new Map<string, Pt[]>();
  const failures: string[] = [];
  for (const [label, res] of [["财政部收益率曲线", treasuryRes], ["纽约联储 EFFR", effrRes]] as const) {
    if (res.status === "fulfilled") {
      for (const [k, v] of res.value) map.set(k, v);
    } else {
      failures.push(`${label}: ${res.reason instanceof Error ? res.reason.message : String(res.reason)}`);
    }
  }
  if (extrasRes.status === "fulfilled") {
    for (const [k, v] of extrasRes.value.map) map.set(k, v);
    failures.push(...extrasRes.value.failures);
  } else {
    failures.push(`官方宏观补充序列: ${extrasRes.reason instanceof Error ? extrasRes.reason.message : String(extrasRes.reason)}`);
  }
  // BLS is the primary publisher of CPI / unemployment — its keys win;
  // FRED (merged next, fill-only) supplies the same series when BLS is
  // down, plus core PCE, which has no other keyless official channel.
  if (blsRes.status === "fulfilled") {
    for (const [k, v] of blsRes.value) map.set(k, v);
  } else {
    failures.push(`美国劳工统计局 BLS（CPI/失业率）: ${blsRes.reason instanceof Error ? blsRes.reason.message : String(blsRes.reason)}`);
  }
  // Corporate profits (fredcp): BEA direct wins when it lands fresh
  // points (tail no older than the stored tail); the FRED merge below
  // is fill-only, so a BEA hit is never overwritten by the mirror.
  // When BEA misses, FRED's CP fills and the stage summary says so;
  // the BEA failure text surfaces as an error only when FRED also
  // missed, so a covered fallback never reads as a failure.
  let cpSource: "bea" | "fred" | null = null;
  let cpBeaMiss: string | null = null;
  if (beaRes.status === "fulfilled") {
    const pts = beaRes.value;
    const tailPt = pts[pts.length - 1];
    const storedTail = coverage.get("fredcp")?.maxDate ?? null;
    if (tailPt && (!storedTail || tailPt.date >= storedTail)) {
      map.set("fredcp", pts);
      cpSource = "bea";
    } else {
      cpBeaMiss = `BEA 企业利润（NIPA T11200 line 45）（尾值 ${tailPt?.date ?? "无"} 早于已存尾值 ${storedTail ?? "无"}）`;
    }
  } else {
    cpBeaMiss = beaRes.reason instanceof Error ? beaRes.reason.message : String(beaRes.reason);
  }
  if (fredRes.status === "fulfilled") {
    for (const [k, v] of fredRes.value.map) if (!map.has(k)) map.set(k, v);
    const keyById = new Map(FRED_SERIES.map((s) => [s.id, s.key]));
    for (const f of fredRes.value.failures) {
      const id = f.split("（")[0] ?? "";
      const key = keyById.get(id);
      if (!key || !map.has(key)) failures.push(`FRED ${f}`);
    }
  } else if (!["fredhy", "fredig", "fredcp", "fredusd"].every((k) => map.has(k))) {
    failures.push("FRED 专属序列（HY/IG 利差、企业利润、广义美元）: FRED API 本次未返回，未拉到");
  }
  // fredcp in the map without a BEA hit can only have come from the
  // FRED merge (no other leg supplies that key).
  if (!cpSource && map.has("fredcp")) cpSource = "fred";
  if (!cpSource && cpBeaMiss) failures.push(cpBeaMiss);
  if (map.size === 0) {
    return { fetched: 0, errors: [`华尔街宏观序列: ${failures.join("，") || "全部拉取失败"}`] };
  }
  const counts: StoreCounts[] = [];
  for (const [key, pts] of map) {
    const seeded = (coverage.get(key)?.count ?? 0) > 0;
    if (pts.length >= (seeded ? 1 : 20)) {
      counts.push(await storeSeriesCounted(ctx, key, pts, coverage.get(key)));
      fetched++;
    }
  }
  // Record which source supplied fredcp — only when its points
  // actually met the same store threshold the loop above applied, so
  // the marker never claims a source whose data did not land.
  const cpPts = map.get("fredcp");
  if (cpSource && cpPts && cpPts.length >= ((coverage.get("fredcp")?.count ?? 0) > 0 ? 1 : 20)) {
    await writeCpSource(ctx, cpSource);
  }
  if (failures.length > 0) errors.push(`华尔街部分序列失败: ${failures.join("，")}`);
  const allSeeded = [...map.keys()].every((k) => (coverage.get(k)?.count ?? 0) > 0);
  const summary =
    countsSummary("华尔街序列", sumCounts(counts), fetched, rebuild || !allSeeded) +
    (cpSource === "fred" ? "；企业利润本次取自 FRED 镜像（BEA 直连未命中）" : "");
  return { fetched, errors, summary };
}

/** Forward calendar: Faireconomy + FOMC + BEA + Nasdaq earnings.
 *  Replacement is PER SOURCE, keyed on the rows' `source` label: a
 *  source's stored rows are deleted and re-inserted only when that
 *  source itself delivered fresh rows this run. A source that throws —
 *  or "succeeds" with zero rows, which is indistinguishable from a
 *  silently broken parse — keeps its previous rows untouched, so one
 *  source's transient outage can no longer wipe a whole class of
 *  events (the old delete-all + reinsert did exactly that to the FOMC
 *  block whenever fetchFomc failed while the other three landed).
 *  Cross-source dedupe keeps the old semantics: fresh rows are deduped
 *  globally by date|title in job order (Faireconomy's PCE/GDP titles
 *  are identical to BEA's by design), and a fresh row supersedes a
 *  kept row with the same date|title, so the table never holds two
 *  rows for the same event. */
async function stageCalendar(ctx: Ctx, _rebuild = false): Promise<StageResult> {
  const errors: string[] = [];
  // `sources` = the exact `source` labels this fetcher stamps on its
  // rows (see each fetcher's out.push) — the ownership key for deletes.
  const jobs: { label: string; sources: string[]; job: () => Promise<CalRow[]> }[] = [
    { label: "经济日历", sources: ["经济日历源（Faireconomy）"], job: fetchFaireconomy },
    {
      label: "美联储日程",
      sources: ["美联储官网议息日程", "美联储官网议息日程（纪要日期按会后三周惯例推算）"],
      job: fetchFomc,
    },
    { label: "BEA 日程", sources: ["美国经济分析局（BEA）发布日程"], job: fetchBea },
    { label: "财报日历", sources: ["Nasdaq 财报日历"], job: fetchEarnings },
  ];
  const freshBySource: { label: string; sources: string[]; rows: CalRow[] }[] = [];
  const keptLabels: string[] = [];
  for (const { label, sources, job } of jobs) {
    try {
      const rows = await job();
      if (rows.length === 0) {
        errors.push(`日历-${label}: 本次未返回事件，已保留该来源上次的事件`);
        keptLabels.push(label);
        continue;
      }
      freshBySource.push({ label, sources, rows });
    } catch (e) {
      errors.push(`日历-${label}: ${e instanceof Error ? e.message : String(e)}（已保留该来源上次的事件）`);
      keptLabels.push(label);
    }
  }
  let fetched = 0;
  if (freshBySource.length > 0) {
    // Global date|title dedupe across the fresh rows, first source wins
    // (same order and semantics as the previous full rebuild).
    const seen = new Set<string>();
    const fresh: CalRow[] = [];
    for (const { rows } of freshBySource) {
      for (const r of rows) {
        const k = `${r.date}|${r.title}`;
        if (seen.has(k)) continue;
        seen.add(k);
        fresh.push(r);
      }
    }
    const db0 = ctx.db<typeof schema>();
    const okSources = new Set(freshBySource.flatMap((s) => s.sources));
    const existing = await db0
      .select({ id: schema.calendarEvents.id, date: schema.calendarEvents.date, title: schema.calendarEvents.title, source: schema.calendarEvents.source })
      .from(schema.calendarEvents);
    // Delete exactly: (a) every row owned by a source that delivered
    // fresh rows, and (b) any kept row a fresh row supersedes (same
    // date|title). Rows of failed/empty sources survive otherwise.
    const deleteIds = existing
      .filter((r) => okSources.has(r.source) || seen.has(`${r.date}|${r.title}`))
      .map((r) => r.id);
    const CH = 200;
    for (let i = 0; i < deleteIds.length; i += CH) {
      await db0.delete(schema.calendarEvents).where(inArray(schema.calendarEvents.id, deleteIds.slice(i, i + CH)));
    }
    for (let i = 0; i < fresh.length; i += CH) {
      await db0.insert(schema.calendarEvents).values(fresh.slice(i, i + CH));
    }
    fetched = fresh.length;
  }
  const updatedLabels = freshBySource.map((s) => s.label).join("、");
  const summary =
    keptLabels.length > 0
      ? `更新 ${fetched} 个日历事件（${updatedLabels || "无来源成功"}）；${keptLabels.join("、")}沿用上次数据`
      : `成功更新 ${fetched} 个日历事件`;
  return { fetched, errors, summary };
}

// ---------------------------------------------------------------------------
// Stock detail panel （个股详情） — fetched on demand when a tile is tapped,
// never part of the cloud snapshot. Sources (all probe-verified
// 2026-11-19): Yahoo quote (crumb handshake — open/high/low/volume,
// trailing & forward PE, dividend yield, EPS TTM, price-to-book, 52-week
// range, post-market price, next earnings timestamp), Yahoo quoteSummary
// (beta, price-to-sales, ROE, assetProfile company summary), Yahoo
// search news (US headlines; empty for A-share symbols), Eastmoney F10
// 公司简介 for A-share profiles, Yahoo intraday chart (5-minute bars with
// the previous close), and a 5-year PE history built from primary EPS
// filings — SEC EDGAR diluted EPS for US names, Eastmoney's financial
// report table (BASIC_EPS, cumulative) for A-shares — divided into the
// 5y daily closes from the same Yahoo chart API. Every leg degrades to
// null independently; nothing is estimated or filled in.
// ---------------------------------------------------------------------------

let yahooAuthCache: { cookie: string; crumb: string; at: number } | null = null;

async function yahooAuth(): Promise<{ cookie: string; crumb: string }> {
  if (yahooAuthCache && Date.now() - yahooAuthCache.at < 10 * 60_000) return yahooAuthCache;
  const cj = await fetch("https://fc.yahoo.com", {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(15000),
  });
  const cookie = (cj.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const cr = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": "Mozilla/5.0", Cookie: cookie },
    signal: AbortSignal.timeout(15000),
  });
  if (!cr.ok) throw new Error(`Yahoo crumb HTTP ${cr.status}`);
  const crumb = (await cr.text()).trim();
  if (!crumb || crumb.length > 40) throw new Error("Yahoo crumb 返回异常");
  yahooAuthCache = { cookie, crumb, at: Date.now() };
  return yahooAuthCache;
}

export type YahooQuote = Record<string, unknown>;

export async function fetchYahooQuote(symbol: string): Promise<YahooQuote | null> {
  try {
    const { cookie, crumb } = await yahooAuth();
    const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}&crumb=${encodeURIComponent(crumb)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Cookie: cookie },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { quoteResponse?: { result?: YahooQuote[] } };
    return j.quoteResponse?.result?.[0] ?? null;
  } catch {
    return null;
  }
}

/** Batch Yahoo quote for the cloud tiles' PE line: trailing PE + EPS
 *  TTM + price per symbol behind ONE crumb handshake. These are the
 *  exact fields the detail panel reads from its single-symbol quote,
 *  so a tile's "current PE" and the panel's can never disagree. */
export async function fetchYahooQuoteBatch(
  symbols: string[],
): Promise<Map<string, { peTtm: number | null; epsTtm: number | null; price: number | null }>> {
  const out = new Map<string, { peTtm: number | null; epsTtm: number | null; price: number | null }>();
  try {
    const { cookie, crumb } = await yahooAuth();
    for (let i = 0; i < symbols.length; i += 100) {
      const batch = symbols.slice(i, i + 100);
      const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${batch.map(encodeURIComponent).join(",")}&crumb=${encodeURIComponent(crumb)}`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", Cookie: cookie },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) continue;
      const j = (await res.json()) as { quoteResponse?: { result?: YahooQuote[] } };
      for (const q of j.quoteResponse?.result ?? []) {
        const sym = typeof q["symbol"] === "string" ? q["symbol"] : "";
        if (!sym) continue;
        const num = (k: string): number | null => {
          const v = q[k];
          return typeof v === "number" && Number.isFinite(v) ? v : null;
        };
        out.set(sym, { peTtm: num("trailingPE"), epsTtm: num("epsTrailingTwelveMonths"), price: num("regularMarketPrice") });
      }
    }
  } catch {
    // Whole leg failed: every tile simply shows no PE line.
  }
  return out;
}

/** Excerpt a source-published company profile down to its opening
 *  one-to-two sentences (≈340 chars): the publisher's own wording, only
 *  trimmed at a sentence boundary — never rewritten, summarised or
 *  completed. Returns "" when the source carried no usable text; the
 *  detail drawer then shows no 简介段 at all. */
function excerptProfile(raw: string): string {
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t) return "";
  const sentences = (t.match(/[^。！？.!?]+[。！？.!?]+|[^。！？.!?]+$/g) ?? [t]).map((s) => s.trim()).filter(Boolean);
  const joiner = /[一-鿿]/.test(t.slice(0, 40)) ? "" : " ";
  let out = "";
  for (const s of sentences) {
    if (out && out.length + s.length > 340) break;
    out = out ? out + joiner + s : s;
    if (out.length >= 170 && /[。！？.!?]$/.test(out)) break;
  }
  if (!out) out = sentences[0] ?? t;
  if (out.length > 360) {
    const cut = out.slice(0, 360);
    const end = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf(". "), cut.lastIndexOf("，"), cut.lastIndexOf(", "));
    out = `${(end >= 200 ? cut.slice(0, end + 1) : cut).trim()}…`;
  }
  return out;
}

/** A-share company profile: Eastmoney F10 公司概况's 公司简介 (gsjj) —
 *  the same CompanySurvey endpoint the cloud industry fill already
 *  uses, fetched on demand for the tapped stock only. Excerpted via
 *  excerptProfile, never rewritten; "" when F10 carries no 简介. */
export async function fetchCnProfile(code: string): Promise<string> {
  try {
    const pre = /^[69]/.test(code) ? "SH" : "SZ";
    const res = await fetch(
      `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/CompanySurveyAjax?code=${pre}${code}`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) },
    );
    if (!res.ok) return "";
    const j = (await res.json()) as { jbzl?: { gsjj?: string } };
    return excerptProfile(j.jbzl?.gsjj ?? "");
  } catch {
    return "";
  }
}

export type StockNewsItem = { title: string; publisher: string; date: string; link: string };

/** Recent headlines for a US-listed symbol from Yahoo Finance's own
 *  search news feed (same crumb channel as the quote legs; probe-
 *  verified 2026-11-19). Only items Yahoo itself tags with the symbol
 *  are kept, feed order (newest first), at most 3; title / publisher /
 *  publish time / link pass through verbatim, the date rendered in
 *  Asia/Shanghai. The feed returns an empty list for A-share symbols,
 *  so CN drawers get no news block — no substitute source is stitched
 *  in and nothing is written editorially. */
export async function fetchYahooNews(symbol: string): Promise<StockNewsItem[]> {
  try {
    const { cookie, crumb } = await yahooAuth();
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=6&quotesCount=0&crumb=${encodeURIComponent(crumb)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Cookie: cookie },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return [];
    const j = (await res.json()) as {
      news?: { title?: string; publisher?: string; link?: string; providerPublishTime?: number; relatedTickers?: string[] }[];
    };
    const out: StockNewsItem[] = [];
    for (const n of j.news ?? []) {
      if (out.length >= 3) break;
      const title = (n.title ?? "").trim();
      const link = (n.link ?? "").trim();
      const ts = n.providerPublishTime;
      if (!title || !link.startsWith("https://") || typeof ts !== "number" || !(ts > 0)) continue;
      if (Array.isArray(n.relatedTickers) && n.relatedTickers.length > 0 && !n.relatedTickers.includes(symbol)) continue;
      out.push({ title, publisher: (n.publisher ?? "").trim(), date: dateInTz(ts, "Asia/Shanghai"), link });
    }
    return out;
  } catch {
    return [];
  }
}

export async function fetchYahooQuoteSummary(symbol: string): Promise<{ beta: number | null; ps: number | null; pb: number | null; roePct: number | null; profile: string } | null> {
  try {
    const { cookie, crumb } = await yahooAuth();
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=summaryDetail,defaultKeyStatistics,financialData,assetProfile&crumb=${encodeURIComponent(crumb)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Cookie: cookie },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      quoteSummary?: {
        result?: {
          summaryDetail?: Record<string, { raw?: number }>;
          defaultKeyStatistics?: Record<string, { raw?: number }>;
          financialData?: Record<string, { raw?: number }>;
          assetProfile?: { longBusinessSummary?: string };
        }[];
      };
    };
    const r = j.quoteSummary?.result?.[0];
    if (!r) return null;
    const raw = (mod: Record<string, { raw?: number }> | undefined, key: string): number | null => {
      const v = mod?.[key]?.raw;
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    };
    const roe = raw(r.financialData, "returnOnEquity");
    return {
      beta: raw(r.summaryDetail, "beta") ?? raw(r.defaultKeyStatistics, "beta"),
      ps: raw(r.summaryDetail, "priceToSalesTrailing12Months"),
      pb: raw(r.defaultKeyStatistics, "priceToBook") ?? raw(r.summaryDetail, "priceToBook"),
      roePct: roe != null ? Math.round(roe * 1000) / 10 : null,
      profile: excerptProfile(typeof r.assetProfile?.longBusinessSummary === "string" ? r.assetProfile.longBusinessSummary : ""),
    };
  } catch {
    return null;
  }
}

export async function fetchIntraday(symbol: string): Promise<{ points: { t: string; p: number; v: number }[]; prevClose: number | null } | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m&includePrePost=false`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      chart?: {
        result?: {
          meta?: { exchangeTimezoneName?: string; chartPreviousClose?: number; previousClose?: number };
          timestamp?: number[];
          indicators?: { quote?: { close?: (number | null)[]; volume?: (number | null)[] }[] };
        }[];
      };
    };
    const r = j.chart?.result?.[0];
    if (!r?.timestamp) return null;
    const tz = r.meta?.exchangeTimezoneName ?? "UTC";
    const fmtT = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
    const closes = r.indicators?.quote?.[0]?.close ?? [];
    const vols = r.indicators?.quote?.[0]?.volume ?? [];
    const points: { t: string; p: number; v: number }[] = [];
    r.timestamp.forEach((ts, i) => {
      const c = closes[i];
      if (typeof c === "number" && Number.isFinite(c)) {
        const v = vols[i];
        points.push({ t: fmtT.format(new Date(ts * 1000)), p: Math.round(c * 1000) / 1000, v: typeof v === "number" ? v : 0 });
      }
    });
    if (points.length < 2) return null;
    const pc = r.meta?.chartPreviousClose ?? r.meta?.previousClose;
    return { points, prevClose: typeof pc === "number" && pc > 0 ? pc : null };
  } catch {
    return null;
  }
}

/** Last close on or before `date` in an ascending daily series. */
function priceOnOrBefore(closes: Pt[], date: string): number | null {
  let out: number | null = null;
  for (const p of closes) {
    if (p.date <= date) out = p.value;
    else break;
  }
  return out;
}

export function peHistoryStats(points: { date: string; pe: number }[], current: number): { current: number; median: number; percentile: number; n: number } | null {
  const pes = points.map((p) => p.pe).filter((v) => v > 0 && Number.isFinite(v)).sort((a, b) => a - b);
  if (pes.length < 8 || !(current > 0)) return null;
  const mid = Math.floor(pes.length / 2);
  const median = pes.length % 2 === 1 ? (pes[mid] ?? 0) : ((pes[mid - 1] ?? 0) + (pes[mid] ?? 0)) / 2;
  const below = pes.filter((v) => v < current).length;
  return {
    current: Math.round(current * 10) / 10,
    median: Math.round(median * 10) / 10,
    percentile: Math.round((below / pes.length) * 100),
    n: pes.length,
  };
}

type PeValuation = {
  peTtm: number | null;
  peFwd: number | null;
  peHist: { current: number; median: number; percentile: number; n: number } | null;
};

/** The ONE PE-valuation pipeline, shared by the cloud detail drawer
 *  (getStockDetail), the cloud tile PE helper (getCloudPeHist) and the
 *  US watchlist cards (getWatchlistPe) so the same stock can never show
 *  two different PE percentiles in two places: current PE = the Yahoo
 *  quote's trailing PE, falling back to price ÷ EPS TTM; the history is
 *  quarter-end PEs — SEC EDGAR diluted EPS rolled to TTM × quarter-end
 *  close for US names, Eastmoney report EPS for A-shares — and the
 *  percentile is the current PE's position in the last ~5 years of
 *  quarter-end PEs. peHistoryStats enforces the ≥8-quarter-end-sample
 *  floor: below it peHist is null and callers show no percentile rather
 *  than estimating one. */
export async function computePeValuation(isCn: boolean, code: string, quote: YahooQuote | null, closes: Pt[]): Promise<PeValuation> {
  const qn = (k: string): number | null => {
    const v = quote?.[k];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const peTtm = qn("trailingPE");
  const peFwd = qn("forwardPE");
  const curPe =
    peTtm ??
    (qn("epsTrailingTwelveMonths") != null && qn("regularMarketPrice") != null
      ? qn("regularMarketPrice")! / qn("epsTrailingTwelveMonths")!
      : null);
  const pePoints =
    closes.length >= 60 ? (isCn ? await fetchCnPePoints(code, closes) : await fetchUsPePoints(code, closes)) : [];
  return { peTtm, peFwd, peHist: curPe != null ? peHistoryStats(pePoints, curPe) : null };
}

/** The US watchlist row's eight single stocks (V-2-2a): the only cards
 *  whose headline valuation is the historical PE percentile. USO sits
 *  in the same row but is an oil ETF with no earnings — it gets no PE
 *  entry here at all. Keys match PRICE_SERIES instrument keys. */
const WATCHLIST_PE_TICKERS: { key: string; code: string }[] = [
  { key: "mu", code: "MU" },
  { key: "be", code: "BE" },
  { key: "googl", code: "GOOGL" },
  { key: "avgo", code: "AVGO" },
  { key: "ibkr", code: "IBKR" },
  { key: "aapl", code: "AAPL" },
  { key: "tsla", code: "TSLA" },
  { key: "nvda", code: "NVDA" },
];

let secTickerCache: { map: Map<string, number>; at: number } | null = null;

/** 5y PE series for a US stock: SEC EDGAR diluted EPS (quarterly,
 *  latest filing per period end wins — later filings carry split and
 *  restatement adjustments), TTM = trailing four quarters, PE priced at
 *  each quarter end. */
export async function fetchUsPePoints(ticker: string, closes: Pt[]): Promise<{ date: string; pe: number }[]> {
  try {
    if (!secTickerCache || Date.now() - secTickerCache.at > 24 * 3600_000) {
      const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
        headers: { "User-Agent": "Muse data console research contact@example.com" },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) return [];
      const j = (await res.json()) as Record<string, { cik_str?: number; ticker?: string }>;
      const map = new Map<string, number>();
      for (const row of Object.values(j)) {
        if (row.ticker && typeof row.cik_str === "number") map.set(row.ticker, row.cik_str);
      }
      secTickerCache = { map, at: Date.now() };
    }
    const cik = secTickerCache.map.get(ticker);
    if (!cik) return [];
    const res = await fetch(
      `https://data.sec.gov/api/xbrl/companyconcept/CIK${String(cik).padStart(10, "0")}/us-gaap/EarningsPerShareDiluted.json`,
      { headers: { "User-Agent": "Muse data console research contact@example.com" }, signal: AbortSignal.timeout(20000) },
    );
    if (!res.ok) return [];
    const j = (await res.json()) as {
      units?: Record<string, { start?: string; end?: string; val?: number; filed?: string }[]>;
    };
    const obs = j.units?.["USD/shares"] ?? [];
    // Single-quarter observations (75–100 days) are used directly. Q4 is
    // never filed standalone — the 10-K reports the full year — so Q4 is
    // derived as FY − (Q1+Q2+Q3) whenever all four pieces exist. (The
    // first version kept single quarters only, which made Q4 permanently
    // missing and no TTM could ever be assembled.)
    const latestByEnd = (list: typeof obs) => {
      const m = new Map<string, { val: number; filed: string }>();
      for (const o of list) {
        if (!o.end) continue;
        const prev = m.get(o.end);
        if (!prev || (o.filed ?? "") > prev.filed) m.set(o.end, { val: o.val ?? 0, filed: o.filed ?? "" });
      }
      return m;
    };
    const singles: typeof obs = [];
    const fullYears: typeof obs = [];
    for (const o of obs) {
      if (!o.start || !o.end || typeof o.val !== "number") continue;
      const days = (Date.parse(o.end) - Date.parse(o.start)) / 86400_000;
      if (days >= 75 && days <= 100) singles.push(o);
      else if (days >= 330 && days <= 380) fullYears.push(o);
    }
    const byEnd = new Map<string, { val: number; filed: string }>();
    for (const [end, v] of latestByEnd(singles)) byEnd.set(end, v);
    for (const [fyEnd, fy] of latestByEnd(fullYears)) {
      if (byEnd.has(fyEnd)) continue;
      // The three quarters of this fiscal year are the three latest
      // quarter-ends strictly before fyEnd. (A naive "within 370 days"
      // window also captures the PREVIOUS year's Q4 — Dec 31 sits 365
      // days before the next Dec 31 — making the count 4 and silently
      // skipping the derivation; that was the original bug's sequel.)
      const prior = [...byEnd.keys()].filter((end) => end < fyEnd).sort().slice(-3);
      if (prior.length !== 3) continue;
      const spanToFy = (Date.parse(fyEnd) - Date.parse(prior[0]!)) / 86400_000;
      const spanParts = (Date.parse(prior[2]!) - Date.parse(prior[0]!)) / 86400_000;
      if (spanToFy > 340 || spanParts < 150 || spanParts > 200) continue;
      const sum = prior.reduce((a, end) => a + (byEnd.get(end)?.val ?? 0), 0);
      byEnd.set(fyEnd, { val: fy.val - sum, filed: fy.filed });
    }
    const ends = [...byEnd.keys()].sort();
    const dayDiff = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86400_000;
    const points: { date: string; pe: number }[] = [];
    for (let i = 3; i < ends.length; i++) {
      const e0 = ends[i - 3]!;
      const e1 = ends[i - 2]!;
      const e2 = ends[i - 1]!;
      const e3 = ends[i]!;
      if (dayDiff(e0, e1) < 75 || dayDiff(e0, e1) > 105) continue;
      if (dayDiff(e1, e2) < 75 || dayDiff(e1, e2) > 105) continue;
      if (dayDiff(e2, e3) < 75 || dayDiff(e2, e3) > 105) continue;
      const ttm = (byEnd.get(e0)?.val ?? 0) + (byEnd.get(e1)?.val ?? 0) + (byEnd.get(e2)?.val ?? 0) + (byEnd.get(e3)?.val ?? 0);
      if (!(ttm > 0)) continue;
      const px = priceOnOrBefore(closes, e3);
      if (px != null && px > 0) points.push({ date: e3, pe: px / ttm });
    }
    // Keep the last 5 years of quarter ends.
    const cutoff = ends.length ? `${Number((ends[ends.length - 1] ?? "2026").slice(0, 4)) - 5}${(ends[ends.length - 1] ?? "").slice(4)}` : "";
    return points.filter((p) => p.date >= cutoff);
  } catch {
    return [];
  }
}

/** 5y PE series for an A-share: Eastmoney's report table carries
 *  cumulative BASIC_EPS per report period; TTM at a non-year-end period
 *  = current cumulative + last full year − same period last year. */
export async function fetchCnPePoints(code: string, closes: Pt[]): Promise<{ date: string; pe: number }[]> {
  try {
    const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_LICO_FN_CPD&columns=ALL&pageNumber=1&pageSize=40&sortColumns=REPORTDATE&sortTypes=-1&source=WEB&client=WEB&filter=(SECURITY_CODE%3D%22${encodeURIComponent(code)}%22)`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return [];
    const j = (await res.json()) as { result?: { data?: { REPORTDATE?: string; BASIC_EPS?: number }[] } };
    const rows = j.result?.data ?? [];
    const eps = new Map<string, number>();
    for (const r of rows) {
      const d = (r.REPORTDATE ?? "").slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && typeof r.BASIC_EPS === "number" && r.BASIC_EPS !== 0) eps.set(d, r.BASIC_EPS);
    }
    const points: { date: string; pe: number }[] = [];
    for (const d of [...eps.keys()].sort()) {
      const cur = eps.get(d);
      if (cur == null) continue;
      const mmdd = d.slice(5);
      const yr = Number(d.slice(0, 4));
      let ttm: number | null = null;
      if (mmdd === "12-31") {
        ttm = cur;
      } else {
        const fyPrev = eps.get(`${yr - 1}-12-31`);
        const samePrev = eps.get(`${yr - 1}-${mmdd}`);
        if (fyPrev != null && samePrev != null) ttm = cur + fyPrev - samePrev;
      }
      if (ttm == null || !(ttm > 0)) continue;
      const px = priceOnOrBefore(closes, d);
      if (px != null && px > 0) points.push({ date: d, pe: px / ttm });
    }
    const last = points[points.length - 1]?.date ?? "";
    const cutoff = last ? `${Number(last.slice(0, 4)) - 5}${last.slice(4)}` : "";
    return points.filter((p) => p.date >= cutoff);
  } catch {
    return [];
  }
}


/** One cloud market (~500 / ~300 chart fetches, chunked + incremental —
 *  see fetchUsCloudUniverse / fetchCnCloudUniverse). Stocks a chunk
 *  couldn't fetch keep their previous snapshot rows; delisted codes are
 *  pruned only after a ≥90%-complete round. */
async function stageCloud(ctx: Ctx, market: "us" | "ndx" | "dow" | "rut" | "cn", rebuild = false): Promise<StageResult> {
  const label =
    market === "us" ? "云图美股" : market === "ndx" ? "云图纳指100" : market === "dow" ? "云图道指" : market === "rut" ? "云图罗素2000" : "云图A股";
  try {
    // Official index series for the two new indices (^DJI / ^RUT): the
    // cloud selector's day move follows the same official-first rule as
    // the original three indices, so the stage stores ~1y of the
    // official index closes alongside the constituents and getCloud
    // derives the day change from the last two points. (The original
    // three read theirs from the dashboard's instrument series; these
    // two indices have no instrument card, so their series lives here.)
    // Fetched FIRST and independently: even when the constituent leg
    // fails (the rut market's IWM source is currently walled), the
    // selector button still carries the real official day move next to
    // its 待成分源 tag. Best effort — a failed index fetch never fails
    // the stage; the selector then falls back to the labelled estimate.
    if (market === "dow" || market === "rut") {
      try {
        const sym = market === "dow" ? "^DJI" : "^RUT";
        const key = market === "dow" ? "dji" : "rut";
        const pts = await fetchYahoo({ key, name: sym, sub: sym, symbol: sym, asset: "us", unit: "点", decimals: 2, years: 1 });
        if (pts.length >= 2) await storeSeries(ctx, key, pts);
      } catch {
        // Official day move stays absent this round; nothing fabricated.
      }
    }
    const onChunk = async (rows: CloudUniverseRow[]): Promise<void> => {
      await upsertCloudRows(ctx, rows);
    };
    let res: { rows: CloudUniverseRow[]; fresh: number; total: number; memberCodes: string[]; note: string };
    if (market === "us" || market === "ndx" || market === "dow") {
      res = await fetchUsCloudUniverse(market, onChunk);
    } else if (market === "rut") {
      // IWM daily gate: the iShares holdings file is walled by the
      // source on (nearly) every refresh (verified 2026-11-21) —
      // attempt it at most once per Beijing day. On a skipped day the
      // ^RUT index leg above already landed, so the selector keeps its
      // real official day move and the map stays honestly 待成分源.
      // rebuild=true is an explicit force: it bypasses the gate.
      const iwmSkippedAt = rebuild
        ? null
        : await attemptedTodayAt(ctx, "cloud-rut", ["iShares IWM"]);
      if (iwmSkippedAt) {
        return {
          fetched: 0,
          ok: true,
          errors: [],
          summary: `云图罗素2000：iShares IWM 持仓文件今日 ${iwmSkippedAt} 已尝试，源站仍拦截，明日首次刷新再试；指数日涨跌（^RUT）已更新，成分待源`,
        };
      }
      res = await fetchRutCloudUniverse(onChunk);
    } else {
      const cachedCnInd = new Map<string, { industry: string; sector: string }>();
      try {
        const prev = await ctx
          .db<typeof schema>()
          .select()
          .from(schema.cloudStocks)
          .where(eq(schema.cloudStocks.market, "cn"));
        for (const r of prev) {
          if (r.industry) cachedCnInd.set(r.code, { industry: r.industry, sector: r.sector });
        }
      } catch {
        // First refresh ever: no snapshot to reuse yet.
      }
      res = await fetchCnCloudUniverse(cachedCnInd, onChunk);
    }
    if (res.fresh === 0) {
      return { fetched: 0, errors: [`${label}: 本次一只行情都没拉到（保留上次快照）`] };
    }
    // Name the members that have NO snapshot row at all after this
    // round (neither freshly fetched nor carried over). "其余沿用上次
    // 快照" is only true for stocks that HAVE a previous snapshot; a
    // never-landed member (the SNDK case: Yahoo serves it only two
    // daily bars, and a stats floor silently dropped it) must be
    // visible by code in the refresh log instead of silently leaving
    // the map one constituent short.
    const errors: string[] = res.note ? [res.note] : [];
    try {
      const nowCodes = new Set(
        (
          await ctx
            .db<typeof schema>()
            .select({ code: schema.cloudStocks.code })
            .from(schema.cloudStocks)
            .where(eq(schema.cloudStocks.market, market))
        ).map((r) => r.code),
      );
      const absent = res.memberCodes.filter((c) => !nowCodes.has(c));
      if (absent.length > 0) {
        errors.push(
          `${label}: ${absent.length} 只成分股仍无快照（本次未拉到且无历史快照）：${absent.slice(0, 10).join("、")}${absent.length > 10 ? "…" : ""}`,
        );
      }
    } catch {
      // Diagnostic only — never fail the stage over it.
    }
    if (res.total > 0 && res.fresh >= res.total * 0.9) {
      // Near-complete round: safe to drop codes that left the index
      // (prune compares against the full member list, so a member whose
      // chart merely failed this round keeps its previous row).
      await pruneCloudMarket(ctx, market, new Set(res.memberCodes));
    }
    return {
      fetched: res.fresh,
      errors,
      summary: `${label}已更新 ${res.fresh}/${res.total} 只成分股`,
    };
  } catch (e) {
    return { fetched: 0, errors: [`${label}: ${e instanceof Error ? e.message : String(e)}（保留上次快照）`] };
  }
}


// ---------------------------------------------------------------------------
// 美股编年史 static library — historyofmarket.com open JSON datasets
// (data CC BY 4.0, attribution required and shown on the page). Static
// seed + manifest-hash increment: the manifest publishes a sha256 per
// dataset, so a refresh only downloads datasets whose content actually
// changed; unchanged ones are skipped without a fetch. Long-form
// editorial fields (lede/note/lesson/summary…) are dropped at ingest —
// the console keeps the data and chart conventions, not the prose.
// ---------------------------------------------------------------------------

const HOM_BASE = "https://historyofmarket.com/api";

const HOM_KEYS = [
  "sp500/annual-returns", "sp500/annual-tr", "sp500/return-details", "sp500/century",
  "sp500/pe", "sp500/forward-pe", "sp500/eps", "sp500/roe", "sp500/driver-decomp",
  "sp500/drawdowns", "sp500/intrayear-dd", "sp500/volatility", "sp500/vix", "sp500/monthly",
  "sp500/sectors", "sp500/changes",
  "mag7/index", "mag7/concentration", "mag7/drawdown", "mag7/ai-valuation", "mag7/predecessors",
  "latest/concentration",
  "semi/composition", "semi/annual-returns", "semi/ratios", "semi/memory-valuation", "semi/etf-compare",
  "xlk/holdings", "xlk/reclass-2018", "xlk/annual-returns", "xlk/drawdowns",
  "fin/annual-returns", "fin/crisis-2008", "fin/drawdowns", "fin/holdings", "fin/rates",
  "consumer/ratio", "consumer/companies", "consumer/extinction",
  "consumer/xly-annual-returns", "consumer/xlp-annual-returns", "consumer/xly-holdings", "consumer/xlp-holdings",
] as const;

const HOM_DROP_KEYS = new Set([
  "lede_cn", "lede_en", "note_cn", "note_en", "lesson_cn", "lesson_en",
  "summary_cn", "summary_en", "implication_cn", "implication_en",
  "post_crisis_cn", "post_crisis_en", "methodology_cn", "methodology_en",
  "note", "bio_cn", "peak_cn", "why_cn", "why_en",
  "driver_note_cn", "driver_note_en", "caveat_cn", "caveat_en",
]);

type AnyRec = Record<string, unknown>;

function homDateOf(o: unknown): string {
  if (typeof o !== "object" || o === null) return "";
  const r = o as AnyRec;
  return typeof r["date"] === "string" ? (r["date"] as string) : "";
}

/** Keep the last point of each calendar month (daily series shrink ~20×). */
function homMonthlyLast(v: unknown): unknown {
  if (!Array.isArray(v)) return v;
  const byMonth = new Map<string, unknown>();
  for (const pt of v) {
    const d = homDateOf(pt);
    if (d) byMonth.set(d.slice(0, 7), pt);
  }
  return [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, pt]) => pt);
}

/** Keep the last point of each calendar year. */
function homYearlyLast(v: unknown): unknown {
  if (!Array.isArray(v)) return v;
  const byYear = new Map<string, unknown>();
  for (const pt of v) {
    const d = homDateOf(pt);
    if (d) byYear.set(d.slice(0, 4), pt);
  }
  return [...byYear.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, pt]) => pt);
}

function homStripMeta(raw: AnyRec): AnyRec {
  const out: AnyRec = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("_") || HOM_DROP_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function trimHomDataset(key: string, raw: AnyRec): unknown {
  const d = homStripMeta(raw);
  const mapArr = (field: string, fn: (o: AnyRec) => AnyRec) => {
    const arr = d[field];
    if (Array.isArray(arr)) {
      d[field] = arr.map((o) => (typeof o === "object" && o !== null ? fn(o as AnyRec) : o));
    }
  };
  switch (key) {
    case "sp500/pe":
      d["pe"] = homYearlyLast(d["pe"]);
      d["cape"] = homYearlyLast(d["cape"]);
      break;
    case "sp500/volatility":
    case "sp500/vix":
      d["series"] = homMonthlyLast(d["series"]);
      break;
    case "mag7/index":
      d["indexSeries"] = homMonthlyLast(d["indexSeries"]);
      mapArr("members", (m) => {
        const ser = Array.isArray(m["series"]) ? (m["series"] as AnyRec[]) : [];
        const first = ser.length ? homDateOf(ser[0]) : "";
        const f = ser.length ? (ser[0] as AnyRec)["value"] : null;
        const l = ser.length ? (ser[ser.length - 1] as AnyRec)["value"] : null;
        const mult = typeof f === "number" && typeof l === "number" && f > 0 ? l / f : null;
        void first;
        return { ticker: m["ticker"], name: m["name"], returnMultiple: mult };
      });
      break;
    case "mag7/concentration": {
      const ser = d["series"];
      if (Array.isArray(ser)) {
        d["series"] = ser.map((o) =>
          typeof o === "object" && o !== null ? { date: (o as AnyRec)["date"], weight: (o as AnyRec)["weight"] } : o,
        );
      }
      break;
    }
    case "mag7/drawdown":
      mapArr("members", (m) => ({ ...m, series: homMonthlyLast(m["series"]) }));
      break;
    case "mag7/ai-valuation":
    case "semi/memory-valuation":
      mapArr("members", (m) => ({ ...m, series: homMonthlyLast(m["series"]) }));
      break;
    case "semi/ratios": {
      const series = d["series"];
      if (typeof series === "object" && series !== null) {
        const out: AnyRec = {};
        for (const [k, v] of Object.entries(series as AnyRec)) out[k] = homMonthlyLast(v);
        d["series"] = out;
      }
      break;
    }
    case "fin/rates":
      d["spread"] = homMonthlyLast(d["spread"]);
      d["xlf_yoy"] = homMonthlyLast(d["xlf_yoy"]);
      break;
    case "consumer/ratio":
      d["series"] = homMonthlyLast(d["series"]);
      break;
    case "consumer/companies":
      mapArr("companies", (c) => ({ ...c, series: homMonthlyLast(c["series"]) }));
      break;
    case "sp500/changes":
      mapArr("changes", (c) => ({
        effectiveDate: c["effectiveDate"],
        type: c["type"],
        addition: c["addition"],
        removal: c["removal"],
      }));
      break;
    default:
      break;
  }
  return d;
}

async function upsertChronicleRow(ctx: Ctx, key: string, payload: string): Promise<void> {
  const db = ctx.db<typeof schema>();
  const now = new Date().toISOString();
  await db
    .insert(schema.chronicleData)
    .values({ key, payload, updatedAt: now })
    .onConflictDoUpdate({
      target: schema.chronicleData.key,
      set: { payload: sql`excluded.payload`, updatedAt: sql`excluded.updated_at` },
    });
}

/** 编年史 stage: manifest-hash incremental ingest (see header note). */
async function stageChronicle(ctx: Ctx, rebuild: boolean): Promise<StageResult> {
  try {
    const db = ctx.db<typeof schema>();
    const existing = await db.select().from(schema.chronicleData);
    const storedSha = new Map<string, string>();
    for (const r of existing) {
      try {
        const parsed = JSON.parse(r.payload) as { sha?: string };
        storedSha.set(r.key, typeof parsed.sha === "string" ? parsed.sha : "");
      } catch {
        storedSha.set(r.key, "");
      }
    }
    const mres = await fetch(`${HOM_BASE}/_manifest.json`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(20000),
    });
    if (!mres.ok) throw new Error(`manifest HTTP ${mres.status}`);
    const manifest = (await mres.json()) as {
      generated_at?: string;
      datasets?: { key?: string; sha256?: string }[];
    };
    const shaByKey = new Map<string, string>();
    for (const ds of manifest.datasets ?? []) {
      if (typeof ds.key === "string") shaByKey.set(ds.key, typeof ds.sha256 === "string" ? ds.sha256 : "");
    }
    await upsertChronicleRow(
      ctx,
      "_manifest",
      JSON.stringify({ generated_at: manifest.generated_at ?? "", total: (manifest.datasets ?? []).length }),
    );
    let fetched = 0;
    let skipped = 0;
    const errs: string[] = [];
    await mapPool([...HOM_KEYS], 5, async (key) => {
      const sha = shaByKey.get(key) ?? "";
      if (!rebuild && sha && storedSha.get(key) === sha) {
        skipped++;
        return;
      }
      try {
        const res = await fetch(`${HOM_BASE}/${key}.json`, {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = (await res.json()) as AnyRec;
        const data = trimHomDataset(key, raw);
        const payload = JSON.stringify({
          sha,
          updated: typeof raw["updated"] === "string" ? (raw["updated"] as string) : "",
          data,
        });
        await upsertChronicleRow(ctx, key, payload);
        fetched++;
      } catch (e) {
        errs.push(`${key}: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    if (fetched === 0 && skipped === 0) {
      return { fetched: 0, errors: [`编年史数据集全部拉取失败（旧数据保留）：${errs.slice(0, 3).join("；")}`] };
    }
    return {
      fetched,
      errors: errs.length ? [`编年史 ${errs.length} 个数据集失败（旧数据保留）：${errs.slice(0, 3).join("；")}`] : [],
      summary: `编年史静态库：更新 ${fetched} 个数据集 · 未变跳过 ${skipped} 个（manifest 哈希比对）· 来源生成于 ${manifest.generated_at ?? "—"}`,
    };
  } catch (e) {
    return { fetched: 0, errors: [`编年史: ${e instanceof Error ? e.message : String(e)}（旧数据保留）`] };
  }
}

// D-Lock: at most one refresh run at a time, server-wide. The client
// already pools 5 stage calls per run (runStagePool), so the guard must
// tell "same run" from "another run": callers pass runId + runTotal;
// a call whose runId differs from the active run is refused with a
// skipped result (no fetch, no log row, no banner impact). In-process
// only: the runtime runs a single worker per space; if that ever
// changes, this degrades to per-process and needs a DB lock instead.
type RefreshRunState = { id: string; kind: "full" | "stages"; startedAt: number; total: number; done: number };
let activeRefresh: RefreshRunState | null = null;
// Worst-case full refresh: 15 stages x 90s block timeout / 5 lanes
// ~= 4.5 min; 10 min is >2x that, so a normal run is never stolen,
// and an orphaned lock (tab closed mid-run) clears itself in <=10 min.
const REFRESH_LOCK_STALE_MS = 10 * 60_000;
const refreshLockStale = (now: number): boolean =>
  activeRefresh !== null && now - activeRefresh.startedAt > REFRESH_LOCK_STALE_MS;
/** Claim the lock for run `id`, or join it if this IS that run. False = another run holds it. */
function claimRefreshRun(id: string, kind: "full" | "stages", total: number): boolean {
  const now = Date.now();
  if (activeRefresh === null || refreshLockStale(now)) {
    activeRefresh = { id, kind, startedAt: now, total: Math.max(1, total), done: 0 };
    return true;
  }
  return activeRefresh.id === id;
}
/** Mark one stage of run `id` terminal; release when the whole run is terminal. */
function finishRefreshStage(id: string): void {
  if (activeRefresh === null || activeRefresh.id !== id) return;
  activeRefresh.done += 1;
  if (activeRefresh.done >= activeRefresh.total) activeRefresh = null;
}
/** Release the lock only if `id` still holds it (never clears a successor). */
function releaseRefreshRun(id: string): void {
  if (activeRefresh !== null && activeRefresh.id === id) activeRefresh = null;
}
const newRunId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const STAGE_RUNNERS: Record<string, (ctx: Ctx, rebuild: boolean) => Promise<StageResult>> = {
  prices: stagePrices,
  yields: stageYields,
  extras: stageExtras,
  margin: stageMargin,
  feargreed: (ctx) => stageFearGreed(ctx),
  pcr: stagePcr,
  pe: stagePe,
  money: stageMoney,
  wallst: stageWallst,
  calendar: stageCalendar,
  "cloud-us": (ctx, rebuild) => stageCloud(ctx, "us", rebuild),
  "cloud-ndx": (ctx, rebuild) => stageCloud(ctx, "ndx", rebuild),
  "cloud-dow": (ctx, rebuild) => stageCloud(ctx, "dow", rebuild),
  "cloud-rut": (ctx, rebuild) => stageCloud(ctx, "rut", rebuild),
  "cloud-cn": (ctx, rebuild) => stageCloud(ctx, "cn", rebuild),
  chronicle: (ctx, rebuild) => stageChronicle(ctx, rebuild),
};

// Display names for stage ids (mirrors the client's REFRESH_STAGES
// labels) — used when the dashboard aggregates per-stage refresh
// health into the overview banner, so each failing block is named.
const STAGE_LABELS: Record<string, string> = {
  prices: "行情与历史序列",
  yields: "国债收益率",
  money: "资金面利率",
  extras: "两融、成交额、南向与股息率",
  margin: "融资余额与保证金负债",
  feargreed: "恐惧与贪婪指数（CNN）",
  pcr: "期权 Put/Call（CBOE）",
  pe: "历史 PE（中证官网 + 标普 500 + 恒生年度点 + ETF 周度积累）",
  wallst: "华尔街宏观",
  calendar: "大事日历",
  "cloud-us": "云图 · 美股",
  "cloud-ndx": "云图 · 纳指 100",
  "cloud-dow": "云图 · 道指",
  "cloud-rut": "云图 · 罗素 2000",
  "cloud-cn": "云图 · A股",
  chronicle: "美股编年史",
  all: "全量刷新",
  legacy: "历史刷新",
};

// One-time seed fallback for the cdbgov10y spread series: spread
// points (bp) computed from the user's verified ChinaBond month-end
// CSV (cdb_govt_10y_monthly.csv — 中债国债 / 国开债收益率曲线 10Y
// legs, 61 month-ends 2021-11-30 → 2026-11-17, checked 2026-11-20).
// Used ONLY when the series is still unseeded and the live ChinaBond
// pull fails or comes back short; fetchCdbGovSpreadMonthly is the
// normal seed + refresh path and agrees with these values to the
// digit on every spot-checked month.
const CDB_GOV_SPREAD_CSV_POINTS: { date: string; value: number }[] = [
  { date: "2021-11-30", value: 28.31 }, { date: "2021-12-31", value: 30.8 }, { date: "2022-01-30", value: 23.43 },
  { date: "2022-02-28", value: 26.08 }, { date: "2022-03-31", value: 25.1 }, { date: "2022-04-29", value: 19.39 },
  { date: "2022-05-31", value: 23.08 }, { date: "2022-06-30", value: 23.04 }, { date: "2022-07-29", value: 17.4 },
  { date: "2022-08-31", value: 17.95 }, { date: "2022-09-30", value: 17.37 }, { date: "2022-10-31", value: 12.67 },
  { date: "2022-11-30", value: 12.53 }, { date: "2022-12-31", value: 15.54 }, { date: "2023-01-31", value: 15.02 },
  { date: "2023-02-28", value: 18.24 }, { date: "2023-03-31", value: 16.87 }, { date: "2023-04-28", value: 16.39 },
  { date: "2023-05-31", value: 15.75 }, { date: "2023-06-30", value: 13.76 }, { date: "2023-07-31", value: 10.49 },
  { date: "2023-08-31", value: 13.62 }, { date: "2023-09-28", value: 6.49 }, { date: "2023-10-31", value: 4.16 },
  { date: "2023-11-30", value: 9.77 }, { date: "2023-12-31", value: 12.43 }, { date: "2024-01-31", value: 15.7 },
  { date: "2024-02-29", value: 10.77 }, { date: "2024-03-29", value: 12.05 }, { date: "2024-04-30", value: 9.7 },
  { date: "2024-05-31", value: 9.25 }, { date: "2024-06-28", value: 8.68 }, { date: "2024-07-31", value: 6.64 },
  { date: "2024-08-30", value: 8.97 }, { date: "2024-09-30", value: 9.44 }, { date: "2024-10-31", value: 7.62 },
  { date: "2024-11-29", value: 8.32 }, { date: "2024-12-31", value: 5.11 }, { date: "2025-01-27", value: 2.27 },
  { date: "2025-02-28", value: 2.78 }, { date: "2025-03-31", value: 2.8 }, { date: "2025-04-30", value: 3.48 },
  { date: "2025-05-30", value: 3.78 }, { date: "2025-06-30", value: 4.31 }, { date: "2025-07-31", value: 5.83 },
  { date: "2025-08-29", value: 3.77 }, { date: "2025-09-30", value: 17.67 }, { date: "2025-10-31", value: 13.0 },
  { date: "2025-11-28", value: 13.28 }, { date: "2025-12-31", value: 15.39 }, { date: "2026-01-30", value: 17.53 },
  { date: "2026-02-28", value: 18.72 }, { date: "2026-03-31", value: 12.89 }, { date: "2026-04-30", value: 9.07 },
  { date: "2026-05-29", value: 5.79 }, { date: "2026-06-30", value: 4.55 }, { date: "2026-07-31", value: 6.19 },
  { date: "2026-08-31", value: 7.88 }, { date: "2026-09-30", value: 7.37 }, { date: "2026-10-30", value: 4.31 },
  { date: "2026-11-17", value: 8.71 },
];

const setFredKeyResponse = z.object({
  ok: z.literal(true),
  fetched: z.number(),
  errors: z.array(z.string()),
});

const seedCdbGovResponse = z.object({
  ok: z.literal(true),
  points: z.number(),
  latestDate: z.string(),
  latestBp: z.number().nullable(),
  source: z.string(),
});

// ---------------------------------------------------------------------------
// Read-path memoization (performance pass, 2026-11-20)
//
// The stored data changes ONLY when a refresh stage (or the seed /
// record actions) writes — between writes, getDashboard used to reload
// all ~300k stored points and recompute every statistic from scratch
// on EVERY page entry, so opening the console always cost seconds of
// server CPU for byte-identical output. dataVersion() fingerprints
// every table the read actions depend on with cheap indexed
// aggregates (max id / row count / max updated_at); the computed
// payload is memoized per (action, window) and served verbatim while
// the fingerprint is unchanged. Every write path in the pipeline
// inserts or replaces rows, which moves at least one fingerprint
// component (series_points / cloud_stocks ids are AUTOINCREMENT and
// never go backwards), so a memoized payload can never outlive the
// refresh that supersedes it — the first read after any refresh
// recomputes, exactly as before.
// ---------------------------------------------------------------------------

async function dataVersion(ctx: Ctx): Promise<string> {
  const db = ctx.db<typeof schema>();
  const [rl, sp, fp, ce, cs, ch, fa] = await Promise.all([
    db.select({ m: max(schema.refreshLog.id) }).from(schema.refreshLog),
    db.select({ c: count(), m: max(schema.seriesPoints.id) }).from(schema.seriesPoints),
    db.select({ m: max(schema.forwardPe.id) }).from(schema.forwardPe),
    db.select({ c: count(), m: max(schema.calendarEvents.id) }).from(schema.calendarEvents),
    db.select({ c: count(), m: max(schema.cloudStocks.id) }).from(schema.cloudStocks),
    db.select({ c: count(), m: max(schema.chronicleData.updatedAt) }).from(schema.chronicleData),
    db.select({ c: count(), m: max(schema.fibAnchors.updatedAt) }).from(schema.fibAnchors),
  ]);
  const parts: (string | number | null | undefined)[] = [
    rl[0]?.m,
    sp[0]?.c,
    sp[0]?.m,
    fp[0]?.m,
    ce[0]?.c,
    ce[0]?.m,
    cs[0]?.c,
    cs[0]?.m,
    ch[0]?.c,
    ch[0]?.m,
    fa[0]?.c,
    fa[0]?.m,
  ];
  return parts.map((p) => (p == null ? "" : String(p))).join("|");
}

type DashboardPayload = z.infer<typeof dashboardResponse>;
const dashMemo = new Map<number, { version: string; value: DashboardPayload }>();
type ChroniclePayload = {
  hasData: boolean;
  generatedAt: string;
  storedCount: number;
  siteTotal: number;
  datasets: Record<string, unknown>;
};
let chronMemo: { version: string; value: ChroniclePayload } | null = null;

export const Actions = {
  ...cloudActions,
  refreshData: defineAction({
    description: "从 Yahoo Finance 与东方财富程序化拉取最新行情与中美国债收益率，存入数据库并重算全部指标（纯程序抓取，不消耗 token）。",
    privileged: [privileged.fetchFinraMargin],
    request: z.object({}),
    response: z.object({
      ok: z.boolean(),
      updatedAt: z.string(),
      fetchedSeries: z.number(),
      errors: z.array(z.string()),
      skipped: z.boolean(),
    }),
    async handler(ctx) {
      // D-Lock: a second full refresh while one is running returns
      // skipped instead of re-fetching (no stage runs, no log row).
      const runId = newRunId("full");
      if (!claimRefreshRun(runId, "full", Object.keys(STAGE_RUNNERS).length)) {
        return { ok: true, updatedAt: new Date().toISOString(), fetchedSeries: 0, errors: [], skipped: true };
      }
      try {
      // Full refresh = every stage through a bounded pool of 5 (each stage stores its
      // own data as it lands and never throws). Kept for compatibility;
      // the UI drives refreshStage stage-by-stage so the user watches
      // blocks update one at a time instead of waiting on this call.
      // D-P2-6: each stage's log row is written the moment THAT stage
      // finishes, not in one batch after Promise.all resolves — the
      // batch version stamped all eleven blocks with the same second,
      // so no block's 更新于 could be told apart from any other's. The
      // row's finishedAt defaults to insert time, so writing on
      // completion records the stage's real landing time.
      const names = Object.keys(STAGE_RUNNERS);
      // Bounded pool (5): the old unbounded Promise.all fired all 15
      // stages at once. mapPool is the existing helper (line ~448);
      // per-stage writeStageLog stays inside the worker so each
      // block's log row still lands the moment THAT stage finishes
      // (D-P2-6), and results stay in input order for the aggregation
      // below. Stage runners never throw, so pool behaviour on throw
      // is unchanged from Promise.all.
      const results = await mapPool(names, 5, async (n) => {
        const r = await STAGE_RUNNERS[n]!(ctx, false);
        await writeStageLog(ctx, n, r);
        return r;
      });
      const errors: string[] = [];
      let fetched = 0;
      results.forEach((r, i) => {
        errors.push(...r.errors);
        fetched += names[i]!.startsWith("cloud") ? (r.fetched > 0 ? 1 : 0) : r.fetched;
      });
      const db = ctx.db<typeof schema>();
      const status = errors.length === 0 ? "ok" : fetched > 0 ? "partial" : "error";
      await db.insert(schema.refreshLog).values({
        stage: "all",
        status,
        detail: errors.length ? errors.join("；") : `成功更新 ${fetched} 条序列`,
      });
      await pruneRefreshLog(ctx);
      ctx.invalidateQueries();
        return {
          ok: fetched > 0,
          updatedAt: new Date().toISOString(),
          fetchedSeries: fetched,
          errors,
          skipped: false,
        };
      } finally {
        releaseRefreshRun(runId);
      }
    },
  }),

  refreshStage: defineAction({
    description: "分块刷新一个数据模块（行情/收益率/资金面/两融成交/融资余额/恐惧与贪婪/华尔街/日历/云图/编年史）：只拉这一块、拉到就入库，失败保留旧数据并记录原因。历史序列默认增量刷新（只拉尾巴并回报追加/跳过点数），rebuild=true 时全量重建该分块。前端点刷新时逐块调用，逐块渲染。",
    privileged: [privileged.fetchFinraMargin],
    request: z.object({
      stage: z.enum(["prices", "yields", "extras", "margin", "feargreed", "pcr", "pe", "money", "wallst", "calendar", "cloud-us", "cloud-ndx", "cloud-dow", "cloud-rut", "cloud-cn", "chronicle"]),
      rebuild: z.boolean().optional(),
      // D-Lock: identifies the refresh run this stage belongs to, so the
      // server can tell this run's 5 pooled lanes from another run.
      // Callers that omit it get a fresh single-stage run (total 1).
      runId: z.string().max(64).optional(),
      runTotal: z.number().int().min(1).max(16).optional(),
    }),
    response: z.object({
      ok: z.boolean(),
      stage: z.string(),
      updatedAt: z.string(),
      fetched: z.number(),
      errors: z.array(z.string()),
      summary: z.string(),
      skipped: z.boolean(),
    }),
    async handler(ctx, args) {
      // D-Lock: same-run lanes (one startRefresh pool) share runId and
      // join; any other runId while a run is active gets a skipped
      // result — no fetch, no log row, no banner impact.
      const runId = args.runId ?? newRunId("single");
      const claimed = claimRefreshRun(runId, "stages", args.runTotal ?? 1);
      if (!claimed) {
        return {
          ok: true,
          stage: args.stage,
          updatedAt: new Date().toISOString(),
          fetched: 0,
          errors: [],
          summary: "已有刷新在进行，本次跳过",
          skipped: true,
        };
      }
      try {
        const runner = STAGE_RUNNERS[args.stage]!;
        const r = await runner(ctx, args.rebuild ?? false);
        await writeStageLog(ctx, args.stage, r);
        ctx.invalidateQueries();
        return {
          ok: r.ok === true || r.fetched > 0,
          stage: args.stage,
          updatedAt: new Date().toISOString(),
          fetched: r.fetched,
          errors: r.errors,
          summary: r.summary ?? "",
          skipped: false,
        };
      } finally {
        // One terminal stage of this run; releases the lock when the
        // run's last stage lands (done >= total).
        finishRefreshStage(runId);
      }
    },
  }),

  setFredApiKey: defineAction({
    description: "把 FRED API 密钥写入服务端密钥表（server_secrets，仅服务端动作可读；任何动作都不返回它，它不进日志、页面与构建产物），随后立即刷新一次华尔街分块验证可用。密钥轮换时以新值再调用一次即可覆盖。",
    request: z.object({ key: z.string().trim().min(16).max(128) }),
    response: setFredKeyResponse,
    handler: async (ctx, args): Promise<z.infer<typeof setFredKeyResponse>> => {
      const db = ctx.db<typeof schema>();
      await db
        .insert(schema.serverSecrets)
        .values({ name: "fred_api_key", value: args.key, updatedAt: new Date().toISOString() })
        .onConflictDoUpdate({
          target: schema.serverSecrets.name,
          set: { value: args.key, updatedAt: new Date().toISOString() },
        });
      // Verify immediately with a real wallst run (same refresh-lock
      // discipline as refreshStage; if another refresh is in flight,
      // the key is still saved and the next scheduled refresh uses it).
      const runId = newRunId("single");
      if (!claimRefreshRun(runId, "stages", 1)) {
        return { ok: true, fetched: 0, errors: ["已有刷新在进行：密钥已保存，华尔街分块本次未刷新，下一次刷新自动使用新密钥"] };
      }
      try {
        const r = await stageWallst(ctx, false);
        await writeStageLog(ctx, "wallst", r);
        ctx.invalidateQueries();
        return { ok: true, fetched: r.fetched, errors: r.errors };
      } finally {
        finishRefreshStage(runId);
      }
    },
  }),

  setBeaApiKey: defineAction({
    description: "把 BEA API 密钥写入服务端密钥表（server_secrets，仅服务端动作可读；任何动作都不返回它，它不进日志、页面与构建产物），随后立即刷新一次华尔街分块验证可用（企业利润改走 BEA 直连）。密钥轮换时以新值再调用一次即可覆盖。",
    request: z.object({ key: z.string().trim().min(16).max(128) }),
    response: setFredKeyResponse,
    handler: async (ctx, args): Promise<z.infer<typeof setFredKeyResponse>> => {
      const db = ctx.db<typeof schema>();
      await db
        .insert(schema.serverSecrets)
        .values({ name: "bea_api_key", value: args.key, updatedAt: new Date().toISOString() })
        .onConflictDoUpdate({
          target: schema.serverSecrets.name,
          set: { value: args.key, updatedAt: new Date().toISOString() },
        });
      // Verify immediately with a real wallst run (same refresh-lock
      // discipline as setFredApiKey; if another refresh is in flight,
      // the key is still saved and the next scheduled refresh uses it).
      const runId = newRunId("single");
      if (!claimRefreshRun(runId, "stages", 1)) {
        return { ok: true, fetched: 0, errors: ["已有刷新在进行：密钥已保存，华尔街分块本次未刷新，下一次刷新自动使用新密钥"] };
      }
      try {
        const r = await stageWallst(ctx, false);
        await writeStageLog(ctx, "wallst", r);
        ctx.invalidateQueries();
        return { ok: true, fetched: r.fetched, errors: r.errors };
      } finally {
        finishRefreshStage(runId);
      }
    },
  }),

  seedCdbGovSpread: defineAction({
    description: "国开债−国债 10Y 利差月度序列（cdbgov10y）的一次性种子入库：已存 ≥60 点时直接返回现状、绝不覆盖；否则优先从中债收益率曲线现拉 61 个月末点（国债腿走 pbc historyQuery、国开腿走主站曲线详情页），现拉失败或点数不足时回退到用户 2026-11-20 已核实的中债月末 CSV 利差点（61 点）。日常更新走收益率分块刷新，不经此动作。",
    request: z.object({}),
    response: seedCdbGovResponse,
    handler: async (ctx): Promise<z.infer<typeof seedCdbGovResponse>> => {
      const existing = (await loadAllSeries(ctx)).get("cdbgov10y") ?? [];
      if (existing.length >= 60) {
        const last = existing[existing.length - 1];
        return { ok: true, points: existing.length, latestDate: last?.date ?? "", latestBp: last?.value ?? null, source: "already-seeded" };
      }
      let source = "chinabond-live";
      let pts: Pt[] = [];
      try {
        pts = await fetchCdbGovSpreadMonthly(null);
        if (pts.length < 60) throw new Error(`仅 ${pts.length} 个月末点`);
      } catch {
        source = "user-verified-csv-2026-11-20";
        pts = CDB_GOV_SPREAD_CSV_POINTS.map((p) => ({ date: p.date, value: p.value, volume: null }));
      }
      await storeSeries(ctx, "cdbgov10y", pts);
      ctx.invalidateQueries();
      const last = pts[pts.length - 1];
      return { ok: true, points: pts.length, latestDate: last?.date ?? "", latestBp: last?.value ?? null, source };
    },
  }),

  recordForwardPe: defineAction({
    description: "手工录入一条 forward 12M PE（每周/每月抄数口）：标普 500 与 11 个 GICS 板块取 FactSet Earnings Insight 当期值（连同刊内 5 年/10 年均值，板块 key 为 fwd_xlb…fwd_xly），纳指 100 取 Siblis 当月 forward 值。同一 (key, date) 重复录入会覆盖旧值；value 须在 5–40 之间。积累满 8 笔后卡片自动显示近 5 年百分位。",
    request: z.object({
      key: z.enum(["fwd_spx", "fwd_ndx", "fwd_xlb", "fwd_xlc", "fwd_xle", "fwd_xlf", "fwd_xli", "fwd_xlk", "fwd_xlp", "fwd_xlre", "fwd_xlu", "fwd_xlv", "fwd_xly"]),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      value: z.number().min(5).max(40),
      avg5: z.number().min(5).max(40).optional(),
      avg10: z.number().min(5).max(40).optional(),
      source: z.string().min(1).max(120),
    }),
    response: z.object({
      ok: z.boolean(),
      key: z.string(),
      date: z.string(),
      value: z.number(),
      rows: z.number(), // total stored rows for this key after the write
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await db
        .insert(schema.forwardPe)
        .values({ key: args.key, date: args.date, value: args.value, avg5: args.avg5 ?? null, avg10: args.avg10 ?? null, source: args.source })
        .onConflictDoUpdate({
          target: [schema.forwardPe.key, schema.forwardPe.date],
          set: { value: args.value, avg5: args.avg5 ?? null, avg10: args.avg10 ?? null, source: args.source },
        });
      const rows = await db.select().from(schema.forwardPe).where(eq(schema.forwardPe.key, args.key));
      ctx.invalidateQueries();
      return { ok: true, key: args.key, date: args.date, value: args.value, rows: rows.length };
    },
  }),

  recordForwardPeRows: defineAction({
    description: "批量录入 forward 12M PE（同一期 FactSet Earnings Insight 的整表抄数口：标普 500 + 11 板块一次录入）。每行与 recordForwardPe 同口径校验，同一 (key, date) 覆盖旧值；行数据由调用方在参数里逐行给出，服务端不内置任何数值。",
    request: z.object({
      rows: z
        .array(
          z.object({
            key: z.enum(["fwd_spx", "fwd_ndx", "fwd_xlb", "fwd_xlc", "fwd_xle", "fwd_xlf", "fwd_xli", "fwd_xlk", "fwd_xlp", "fwd_xlre", "fwd_xlu", "fwd_xlv", "fwd_xly"]),
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            value: z.number().min(5).max(40),
            avg5: z.number().min(5).max(40).optional(),
            avg10: z.number().min(5).max(40).optional(),
            source: z.string().min(1).max(120),
          }),
        )
        .min(1)
        .max(60),
    }),
    response: z.object({
      ok: z.boolean(),
      written: z.number(), // rows upserted by this call
      total: z.number(), // total rows now stored in forward_pe
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      for (const r of args.rows) {
        await db
          .insert(schema.forwardPe)
          .values({ key: r.key, date: r.date, value: r.value, avg5: r.avg5 ?? null, avg10: r.avg10 ?? null, source: r.source })
          .onConflictDoUpdate({
            target: [schema.forwardPe.key, schema.forwardPe.date],
            set: { value: r.value, avg5: r.avg5 ?? null, avg10: r.avg10 ?? null, source: r.source },
          });
      }
      const all = await db.select().from(schema.forwardPe);
      ctx.invalidateQueries();
      return { ok: true, written: args.rows.length, total: all.length };
    },
  }),

  getChronicle: defineAction({
    description:
      "读取美股编年史静态库（historyofmarket.com 开放 JSON，CC BY 4.0 署名）：世纪回报、估值锚点、危机节奏、内部骨骼、板块卷五个分卷的数据集。与 getDashboard 分开，只有打开编年史页才拉。",
    request: z.object({}),
    response: z.object({
      hasData: z.boolean(),
      generatedAt: z.string(),
      storedCount: z.number(), // datasets actually ingested into this console
      siteTotal: z.number(), // datasets the source site publishes (manifest length at last refresh; 0 = not yet recorded)
      datasets: z.record(z.string(), z.unknown()),
    }),
    async handler(ctx) {
      // Same memoization as getDashboard: the static library only
      // changes when the chronicle refresh stage rewrites rows, which
      // moves the fingerprint — repeat opens skip re-parsing every
      // stored dataset payload.
      const version = await dataVersion(ctx);
      if (chronMemo && chronMemo.version === version) return chronMemo.value;
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.chronicleData);
      const datasets: Record<string, unknown> = {};
      let generatedAt = "";
      let siteTotal = 0;
      for (const r of rows) {
        try {
          const parsed = JSON.parse(r.payload) as { generated_at?: string; total?: number; data?: unknown };
          if (r.key === "_manifest") {
            generatedAt = typeof parsed.generated_at === "string" ? parsed.generated_at : "";
            siteTotal = typeof parsed.total === "number" ? parsed.total : 0;
          } else if (parsed.data !== undefined) datasets[r.key] = parsed.data;
        } catch {
          // Corrupt row: skip it; the next refresh rewrites it.
        }
      }
      const value: ChroniclePayload = {
        hasData: Object.keys(datasets).length > 0,
        generatedAt,
        storedCount: Object.keys(datasets).length,
        siteTotal,
        datasets,
      };
      chronMemo = { version, value };
      return value;
    },
  }),



  getWatchlistPe: defineAction({
    description:
      "美股自选个股行（MU/BE/GOOGL/AVGO/IBKR/AAPL/TSLA/NVDA 共 8 只）的历史 PE 估值：当前 TTM 与前瞻市盈率（Yahoo 报价）+ 当前 TTM PE 在近 5 年各季末 PE 中的百分位（SEC EDGAR 季度稀释 EPS 滚 TTM × 季末收盘），与云图个股详情面板共用同一套 computePeValuation 管线，两处数值一致。季末样本不足 8 个或 TTM 盈利为负的股票 peHist 为空、不估算；USO 是原油 ETF、无盈利，不在此列。打开美股页时按需调用，不属于手动刷新分块。",
    request: z.object({}),
    response: z.object({
      items: z.array(
        z.object({
          key: z.string(),
          code: z.string(),
          peTtm: z.number().nullable(),
          peFwd: z.number().nullable(),
          peHist: z
            .object({ current: z.number(), median: z.number(), percentile: z.number(), n: z.number() })
            .nullable(),
        }),
      ),
    }),
    async handler(ctx): Promise<{
      items: {
        key: string;
        code: string;
        peTtm: number | null;
        peFwd: number | null;
        peHist: { current: number; median: number; percentile: number; n: number } | null;
      }[];
    }> {
      void ctx;
      const items = await mapPool(WATCHLIST_PE_TICKERS, 4, async ({ key, code }) => {
        try {
          const [quote, closes] = await Promise.all([
            fetchYahooQuote(code),
            fetchYahoo({
              key: `detail_${code}`,
              name: code,
              sub: code,
              symbol: code,
              asset: "us",
              unit: "美元",
              decimals: 2,
              years: 5,
            }).catch(() => [] as Pt[]),
          ]);
          const val = await computePeValuation(false, code, quote, closes);
          return { key, code, peTtm: val.peTtm, peFwd: val.peFwd, peHist: val.peHist };
        } catch {
          return { key, code, peTtm: null, peFwd: null, peHist: null };
        }
      });
      return { items };
    },
  }),


  getInstrumentChart: defineAction({
    description: "按需读取单个标的在统计窗口内的价格走势（图表数据）。与 getDashboard 分开：首屏不背全部标的的图表，打开哪个模块才拉哪个模块的图。",
    request: z.object({
      key: z.string().min(1).max(40),
      windowDays: z.number().int().min(60).max(100000).optional(),
    }),
    response: z.object({ chart: z.array(chartPtZ) }),
    async handler(ctx, args) {
      const windowDays = args.windowDays ?? 500;
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.seriesPoints)
        .where(eq(schema.seriesPoints.seriesKey, args.key))
        .orderBy(asc(schema.seriesPoints.date));
      const pts = rows.slice(-windowDays);
      return { chart: pts.map((p) => ({ d: p.date, v: p.value, ...(p.partial === 1 ? { partial: true } : {}) })) };
    },
  }),

  getDashboard: defineAction({
    description: "读取管控台全部数据：五大资产快照、国债收益率曲线与利差、各指数的技术指标与历史百分位对比。windowDays 是图表与历史百分位共用的统计窗口（交易日数），两者永远同窗口对应。",
    request: z.object({ windowDays: z.number().int().min(60).max(100000).optional() }),
    response: dashboardResponse,
    async handler(ctx, args): Promise<z.infer<typeof dashboardResponse>> {
      const windowDays = args.windowDays ?? 500;
      // Memoized read: while the stored data is unchanged since the
      // last computation for this window, serve that payload verbatim
      // instead of recomputing every statistic from ~300k points.
      const version = await dataVersion(ctx);
      const memoHit = dashMemo.get(windowDays);
      if (memoHit && memoHit.version === version) return memoHit.value;
      const db = ctx.db<typeof schema>();
      const logs = await db
        .select()
        .from(schema.refreshLog)
        .orderBy(desc(schema.refreshLog.id))
        .limit(120);
      const lastLog = logs[0];
      // Newest log row per stage (rows come newest-first). Legacy rows
      // written before staged refresh existed carry stage "" — they are
      // surfaced as "legacy" and feed ONLY the refresh-health fallback
      // below. Per-block 更新于 times never fall back to "all"/"legacy"
      // rows (D-P2-5): a block with no staged row of its own shows
      // 尚未分块刷新 instead of borrowing the full-refresh time.
      const stageSeen = new Set<string>();
      const stages: z.infer<typeof dashboardResponse>["stages"] = [];
      for (const l of logs) {
        const st = l.stage || "legacy";
        if (stageSeen.has(st)) continue;
        stageSeen.add(st);
        stages.push({ stage: st, finishedAt: l.finishedAt.toISOString(), status: l.status, detail: l.detail });
      }
      // Overview refresh health aggregates each stage's NEWEST log row
      // — never just the single newest row overall. Retrying one block
      // successfully writes a fresh "ok" row for that block only; the
      // other blocks' partial/error rows must keep the banner up until
      // they themselves refresh clean. "legacy" rows (pre-staged
      // refresh) only count when no staged rows exist at all, so an old
      // full-refresh failure can't haunt the banner forever.
      const stagedRows = stages.filter((s) => s.stage !== "legacy");
      const healthPool = stagedRows.length > 0 ? stagedRows : stages;
      const unhealthy = healthPool.filter((s) => s.status !== "ok");
      const aggRefreshStatus = unhealthy.some((s) => s.status === "error")
        ? "error"
        : unhealthy.length > 0
          ? "partial"
          : "ok";
      const aggRefreshDetail = unhealthy
        .map((s) => `${STAGE_LABELS[s.stage] ?? s.stage}（${s.status === "error" ? "失败" : "部分失败"}）：${s.detail}`)
        .join("；");
      const covMap = await seriesCoverage(ctx);
      const cloudCountRows = await db
        .select({ market: schema.cloudStocks.market, code: schema.cloudStocks.code })
        .from(schema.cloudStocks);
      const cloudCounts = {
        us: cloudCountRows.filter((r) => r.market === "us").length,
        ndx: cloudCountRows.filter((r) => r.market === "ndx").length,
        dow: cloudCountRows.filter((r) => r.market === "dow").length,
        rut: cloudCountRows.filter((r) => r.market === "rut").length,
        cn: cloudCountRows.filter((r) => r.market === "cn").length,
      };
      const all = await loadAllSeries(ctx);
      // Gold-page fallback anchor: the newest stored real-rate point,
      // however short or stale the series is. fredCard below may drop
      // the full card (too few points / frozen source), but a landed
      // point is still a real last-successful value and the gold page
      // shows it as such when the wallst stage has failed.
      const realPts = all.get("fredreal10");
      const realTail = realPts?.[realPts.length - 1];
      const realRateLast = realTail
        ? { date: realTail.date, value: realTail.value, points: realPts?.length ?? 0 }
        : null;

      if (all.size === 0) {
        const emptyResult: DashboardPayload = {
          hasData: false,
          windowDays,
          cloudCounts,
          coverage: [],
          stages,
          updatedAt: null,
          refreshStatus: "never",
          refreshDetail: "",
          hero: [],
          yields: null,
          cdbGov: null,
          money: null,
          derived: [],
          instruments: [],
          drawdowns: [],
          signals: [],
          fibs: [],
          fred: [],
          realRateLast: null,
          macroFred: [],
          cnMoney: [],
          marginCn: null,
          marginUs: null,
          fearGreed: null,
          bottomTop: null,
          style: [],
          seasonality: [],
          breadth: [],
          portfolio: { corrAssets: [], correlations: [], sims: [] },
          calendar: { events: [] },
        };
        dashMemo.set(windowDays, { version, value: emptyResult });
        return emptyResult;
      }

      // Fibonacci anchors (stored by the prices stage; levels are
      // recomputed here from the anchors on every read).
      const fibRows = await db.select().from(schema.fibAnchors);
      const fibOrder = new Map<string, number>(FIB_TARGETS.map((t, i) => [t.key, i]));
      const fibs = fibRows
        .map((r) => buildFib(r))
        .sort((a, b) => (fibOrder.get(a.key) ?? 99) - (fibOrder.get(b.key) ?? 99));
      const fibMap = new Map(fibs.map((f) => [f.key, f]));

      // Instruments
      const instruments: z.infer<typeof instrumentZ>[] = [];
      const byKey = new Map<string, z.infer<typeof instrumentZ>>();
      for (const cfg of PRICE_SERIES) {
        const pts = all.get(cfg.key);
        if (!pts) continue;
        const bench = cfg.benchmark ? (all.get(cfg.benchmark) ?? null) : null;
        // ETF proxies are checked against their exchange's index series
        // (the trading calendar Yahoo never holes): a skipped day turns
        // the day change into an honest 暂缺 instead of a multi-day
        // cumulative number. Indices and US series keep the plain
        // last-two-points change, untouched.
        const calPts = isEtfProxy(cfg) ? all.get(cfg.asset === "hk" ? "hsi" : "sse") : null;
        const inst = computeInstrument(cfg, pts, bench, windowDays, calPts ? calPts.map((p) => p.date) : null);
        if (inst) {
          instruments.push(inst);
          byKey.set(cfg.key, inst);
        }
      }

      // Historical PE percentile (V-1 step 5): attach each pipeline
      // target's PE stats from its stored series (computed once here
      // and reused by the decision signals below, so card and signal
      // always quote the same percentile). Targets whose series has
      // not landed yet — or whose 5y sample is under 8 points — keep
      // peHist null and show the honest 暂无历史 PE 数据 note
      // instead; no-data targets are flagged from PE_NO_DATA_KEYS
      // regardless of storage.
      const peStatsByKey = new Map<string, PeHistStats>();
      for (const t of INDEX_PE_TARGETS) {
        const pts = all.get(peSeriesKey(t.key));
        if (!pts) continue;
        const st = peStatsFromPoints(pts);
        if (st) peStatsByKey.set(t.key, { ...st, cadence: "月末", source: "中证指数官网（指数公司发布的市盈率序列）" });
      }
      // S&P 500 (part 1): Multpl monthly TTM PE — same 5y percentile
      // rule, cadence "月度" (month-1st points + live point). Attached
      // to both the index card and the VOO tracker card.
      {
        const pts = all.get("pe_spx");
        const st = pts ? peStatsFromPoints(pts) : null;
        if (st) {
          peStatsByKey.set("spx", { ...st, cadence: "月度", source: "Multpl（S&P 500 PE，月度 TTM，1871 年至今）；CAPE 历史序列截至 2023-09（Shiller，源站未更新、当前值暂缺）" });
        }
      }
      for (const t of INDEX_PE_TARGETS) {
        const inst = byKey.get(t.key);
        if (!inst) continue;
        const st = peStatsByKey.get(t.key);
        if (st) {
          inst.peHist = { ...st, indexName: t.indexName };
        } else {
          inst.peNoData = true;
        }
      }
      for (const key of ["spx", "voo"]) {
        const inst = byKey.get(key);
        if (!inst) continue;
        const st = peStatsByKey.get("spx");
        if (st) {
          inst.peHist = { ...st, indexName: "标普500指数" };
        } else {
          inst.peNoData = true;
        }
      }
      // Hang Seng (part 2, annual points only — no percentile: a 5y
      // window of annual points is 6 < the 8-point floor, so the
      // card shows the current value + history note instead. The
      // forward annual series is stored alongside for the forward
      // row; it is never fed to peStatsFromPoints either.)
      {
        const pts = all.get("pe_hsi_annual");
        const last = pts && pts.length ? pts[pts.length - 1] : null;
        if (last) {
          const inst = byKey.get("hsi");
          if (inst) {
            inst.peCurrent = { value: Math.round(last.value * 100) / 100, date: last.date, source: "Siblis Research（年度 12 月点 + 最新月）" };
          }
        }
      }
      // Nasdaq-100 (B1, annual points only — no percentile: a 5y
      // window of annual points is 6 < the 8-point floor, so the
      // card shows the current value + history note instead. Never
      // fed to peStatsFromPoints; QQQ's signal keeps no valuation
      // factor.)
      {
        const pts = all.get("pe_ndx_annual");
        const last = pts && pts.length ? pts[pts.length - 1] : null;
        if (last) {
          for (const key of ["ndx", "qqq"]) {
            const inst = byKey.get(key);
            if (inst) {
              inst.peCurrent = { value: Math.round(last.value * 100) / 100, date: last.date, source: "Siblis Research（年度 12 月点 + 最新月）" };
            }
          }
        }
      }
      // Forward PE (part 2, manual accumulation): latest recorded
      // row + source-edition 5y/10y averages; percentile from the
      // stored rows' own 5y window, same 8-point floor as TTM.
      // Display-only — never a signal factor.
      {
        const fwdRows = await db.select().from(schema.forwardPe).orderBy(asc(schema.forwardPe.date));
        const byFwdKey = new Map<string, { date: string; value: number; avg5: number | null; avg10: number | null; source: string }[]>();
        for (const r of fwdRows) {
          const arr = byFwdKey.get(r.key) ?? [];
          arr.push({ date: r.date, value: r.value, avg5: r.avg5, avg10: r.avg10, source: r.source });
          byFwdKey.set(r.key, arr);
        }
        const attachFwd = (instKeys: string[], fwdKey: string) => {
          const rows = byFwdKey.get(fwdKey) ?? [];
          if (rows.length === 0) return;
          const last = rows[rows.length - 1];
          if (!last) return;
          const st = peStatsFromPoints(rows.map((r) => ({ date: r.date, value: r.value, volume: null })));
          // n = rows inside the same trailing-5y window peStatsFromPoints
          // uses (calendar years from the last point), even while the
          // sample is under the 8-point floor and st is null.
          const cutoff = new Date(`${last.date}T00:00:00Z`);
          cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 5);
          const nWin = rows.filter((r) => r.date > cutoff.toISOString().slice(0, 10)).length;
          for (const k of instKeys) {
            const inst = byKey.get(k);
            if (!inst) continue;
            inst.fwdPe = {
              value: Math.round(last.value * 100) / 100,
              date: last.date,
              avg5: last.avg5,
              avg10: last.avg10,
              percentile: st ? st.percentile : null,
              n: st ? st.n : nWin,
              source: last.source,
              points: rows.map((r) => ({ d: r.date, v: Math.round(r.value * 100) / 100 })),
            };
          }
        };
        attachFwd(["spx", "voo"], "fwd_spx");
        attachFwd(["ndx", "qqq"], "fwd_ndx");
        // SPDR sector cards (v123): FactSet prints all 11 GICS sector
        // forward P/Es in the same Earnings Insight table as the S&P
        // 500 row, so the sector keys ride the identical pipeline —
        // manual weekly copy into forward_pe, read-only here. The
        // SPDR ETFs track these same sector indices, so no basis
        // conversion; the card labels the S&P 500 sector-index basis.
        for (const sec of ["xlb", "xlc", "xle", "xlf", "xli", "xlk", "xlp", "xlre", "xlu", "xlv", "xly"]) {
          attachFwd([`sec_${sec}`], `fwd_${sec}`);
        }
      }
      for (const key of PE_NO_DATA_KEYS) {
        const inst = byKey.get(key);
        if (inst) inst.peNoData = true;
      }
      // SPDR sectors + US dividend ETFs (part 2): weekly Yahoo
      // trailingPE accumulation — same 5y percentile rule and
      // cadence "周度" once the sample reaches 8; before that the
      // card shows 积累中, not 暂无历史 PE 数据 (peNoData is cleared
      // here for any key that has accumulation points at all). The
      // source label says plainly this is Yahoo current prints, not
      // official. indexName names the tracked S&P 500 sector index
      // for SPDR cards; dividend ETFs use their own card name.
      {
        const etfIndexNames: Record<string, string> = {
          sec_xlb: "标普500材料行业指数", sec_xlc: "标普500通信服务行业指数", sec_xle: "标普500能源行业指数",
          sec_xlf: "标普500金融行业指数", sec_xli: "标普500工业行业指数", sec_xlk: "标普500信息技术行业指数",
          sec_xlp: "标普500日常消费品行业指数", sec_xlre: "标普500房地产行业指数", sec_xlu: "标普500公用事业行业指数",
          sec_xlv: "标普500医疗保健行业指数", sec_xly: "标普500非必需消费品行业指数",
        };
        for (const key of ["sec_xlb", "sec_xlc", "sec_xle", "sec_xlf", "sec_xli", "sec_xlk", "sec_xlp", "sec_xlre", "sec_xlu", "sec_xlv", "sec_xly", "schd", "vym", "vig", "dgro", "spyd", "hdv"]) {
          const inst = byKey.get(key);
          if (!inst) continue;
          const pts = all.get(peSeriesKey(key));
          if (!pts || pts.length === 0) continue;
          inst.peNoData = false;
          const st = peStatsFromPoints(pts);
          if (st) {
            const full: PeHistStats = { ...st, cadence: "周度", source: "Yahoo 报价（ETF 当期 TTM PE，周度积累；非 SPDJI/指数公司官方序列）" };
            peStatsByKey.set(key, full);
            inst.peHist = { ...full, indexName: etfIndexNames[key] ?? inst.name };
          } else {
            inst.peAccumulating = true;
            inst.peAccumulatingCount = pts.length;
          }
        }
      }

      // Bond-ETF valuation scale (V-1 step 3/4): a bond ETF's own price
      // percentile says nothing about cheap/expensive — yields move
      // against prices. Each bond ETF card therefore carries the
      // percentile of its corresponding yield (or, for HYG, the credit
      // spread) as its valuation block, computed from the same stored
      // series and the same display window as every other card.
      //   tlt → US 30Y (its duration is 20y+; 30Y is the closest stored
      //   tenor), ief → US 10Y, hyg → HY OAS (FRED fredhy; when FRED
      //   has not landed, the HYG/IEF price-ratio proxy the 华尔街 page
      //   already uses — labelled as a proxy, never as the spread),
      //   511010 → CN 5Y, 511260 → CN 10Y, 511520 → CN 10Y as the
      //   7-10Y policy-bank yield proxy (no free policy-bank yield
      //   series exists; the label says so), credit ETFs → CN 10Y as
      //   the rates backdrop (their own credit spreads have no free
      //   programmatic source — not fabricated).
      {
        const yieldStatsFor = (seriesKey: string): z.infer<typeof statsZ> | null => {
          const pts = all.get(seriesKey);
          if (!pts || pts.length < 20) return null;
          return histStats(pts.map((p) => p.date), pts.map((p) => p.value), windowDays, true);
        };
        const attachYield = (key: string, stats: z.infer<typeof statsZ> | null, label: string, unit = "%") => {
          const inst = byKey.get(key);
          if (inst && stats) {
            inst.yieldStats = stats;
            inst.yieldLabel = label;
            inst.yieldUnit = unit;
          }
        };
        attachYield("tlt", yieldStatsFor("us30y"), "美国 30 年国债收益率（TLT 久期 20 年+，以 30 年期为对应期限）");
        attachYield("ief", yieldStatsFor("us10y"), "美国 10 年国债收益率");
        const hyStats = yieldStatsFor("fredhy");
        if (hyStats) {
          attachYield("hyg", hyStats, "美国高收益债利差 HY OAS（FRED）");
        } else {
          // HYG/IEF ratio proxy: ratio low = credit sold off = spreads
          // wide = credit cheap. The ratio is a relative PRICE, so its
          // percentile keeps the plain lens (low = cheap side) — the
          // label and the card caption spell the reading out.
          const hygPts = all.get("hyg");
          const iefPts = all.get("ief");
          if (hygPts && iefPts) {
            const iefMap = new Map(iefPts.map((p) => [p.date, p.value]));
            const dts: string[] = [];
            const vals: number[] = [];
            for (const p of hygPts) {
              const iv = iefMap.get(p.date);
              if (iv !== undefined && iv > 0) {
                dts.push(p.date);
                vals.push((p.value / iv) * 100);
              }
            }
            if (vals.length >= 20) {
              const st = histStats(dts, vals, windowDays, false);
              if (st) attachYield("hyg", st, "HYG/IEF 价格比（信用利差的市场代理，非官方利差）", "");
            }
          }
        }
        attachYield("bond5y", yieldStatsFor("cn5y"), "中国 5 年国债收益率");
        attachYield("bond10y", yieldStatsFor("cn10y"), "中国 10 年国债收益率");
        attachYield("polbond", yieldStatsFor("cn10y"), "7-10 年政金债收益率代理（中国 10 年国债收益率；政金债收益率无免费序列，不编造）");
        attachYield("chengtou", yieldStatsFor("cn10y"), "中国 10 年国债收益率（利率尺度；城投债自身利差无免费序列）");
        attachYield("corpbond", yieldStatsFor("cn10y"), "中国 10 年国债收益率（利率尺度；公司债自身利差无免费序列）");
        attachYield("convbond", yieldStatsFor("cn10y"), "中国 10 年国债收益率（利率尺度；可转债的债底尺度）");
      }

      // Yields block
      let yieldsBlock: z.infer<typeof dashboardResponse>["yields"] = null;
      const derived: Indicator[] = [];
      const cn10 = all.get("cn10y");
      if (cn10 && cn10.length >= 60) {
        const latestDate = cn10[cn10.length - 1]?.date ?? "";
        const buildTenors = (defs: { key: string; tenor: string }[], prefix: "cn" | "us"): z.infer<typeof tenorZ>[] =>
          defs.flatMap((f) => {
            const pts = all.get(`${prefix}${f.key}`) ?? [];
            if (pts.length < 2) return [];
            const vals = pts.map((p) => p.value);
            const dts = pts.map((p) => p.date);
            const lastV = vals[vals.length - 1] ?? 0;
            const prevV = vals[vals.length - 2] ?? lastV;
            return [{
              key: `${prefix}${f.key}`,
              tenor: f.tenor,
              yieldPct: lastV,
              changeBp: Math.round((lastV - prevV) * 1000) / 10,
              // Term treasury yields are read as bond valuations:
              // a low percentile means the yield is at a historic low
              // and the bond is expensive — invert the chip colours.
              stats: histStats(dts, vals, windowDays, true),
            }];
          });
        // CN table + curve = the six ChinaBond tenors; the US table
        // keeps the four tenors Eastmoney publishes. Pairing is by
        // tenor key, never by array position.
        const cn = buildTenors(CN_CURVE_TENORS, "cn");
        const us = buildTenors(YIELD_FIELDS, "us");
        const usByKey = new Map(us.map((t) => [t.key, t]));
        yieldsBlock = {
          date: latestDate,
          cn,
          us,
          curve: cn.map((t) => ({
            tenor: t.tenor,
            cn: t.yieldPct,
            us: usByKey.get(t.key.replace(/^cn/, "us"))?.yieldPct ?? null,
          })),
          cn10yChart: cn10.slice(-windowDays).map((p) => ({ d: p.date, v: p.value })),
          us10yChart: (all.get("us10y") ?? []).slice(-windowDays).map((p) => ({ d: p.date, v: p.value })),
        };

        // Derived spread series (aligned by date)
        const spread = (
          key: string,
          name: string,
          method: string,
          aKey: string,
          bKey: string,
          note: string,
          unit = "%",
        ) => {
          const a = all.get(aKey);
          const b = all.get(bKey);
          if (!a || !b) return;
          const bMap = new Map(b.map((p) => [p.date, p.value]));
          const dts: string[] = [];
          const vals: number[] = [];
          for (const p of a) {
            const bv = bMap.get(p.date);
            if (bv !== undefined) {
              dts.push(p.date);
              vals.push(p.value - bv);
            }
          }
          if (vals.length < 60) return;
          const now = vals[vals.length - 1] ?? 0;
          const ind = makeIndicator({ windowDays,
            key,
            name,
            method,
            unit,
            decimals: 2,
            dates: dts,
            values: vals,
            state: now > 0 ? "正利差" : now < 0 ? "利差倒挂" : "利差为零",
            note,
            // Term / segment / CN-US spreads are compensation gauges:
            // the wider the spread, the more the long bond pays over
            // the short end — wider = long bond relatively cheap,
            // narrower = compensation thin and the long bond
            // relatively expensive. Same inverted lens as yields.
            invert: true,
          });
          if (ind) derived.push(ind);
        };

        spread("cnTermSpread1y", "中国 10年−1年 期限利差", "termspread", "cn10y", "cn1y",
          "本台的主口径（与课程锚点一致）：长债比 1 年短债多给的利息。1 年期最贴近资金面和政策利率预期，所以这条利差对“钱松不松、长端贵不贵”最敏感。利差的历史百分位越低，说明长债相对短债给的补偿越薄，追长债的性价比越差；利差走阔，则是长端在变便宜或短端在变松。");
        spread("cnTermSpread", "中国 10年−2年 期限利差（对照）", "termspread", "cn10y", "cn2y",
          "对照口径：国际上最常引用的 10−2 利差（美债衰退预警用的同款），保留它是为了和新闻、研报里的说法对得上。本台自己的主口径是上一张卡的 10年−1年——两者短端不同（2 年还带一点期限溢价，1 年更纯粹是资金与政策预期），数值和百分位都不一样，别混着看。");
        spread("usTermSpread", "美国 10年−2年 期限利差", "termspread", "us10y", "us2y",
          "美债最有名的衰退预警指标：历史上每次倒挂（变负）之后，美国经济大概率在 1-2 年内衰退，但它只报天气、不报具体哪天下雨。");
        spread("cnUsSpread", "中美 10 年国债利差（中−美）", "cnusspread", "cn10y", "us10y",
          "中国 10 年收益率减美国 10 年。为负说明把钱放美国国债利息更高，这会给人民币汇率和跨境资金流带来压力；历史上长期为正，倒挂是 2022 年之后的新现象。");
        // Curve segment spreads: which part of the curve is moving
        spread("cnSeg5y2y", "中国 5年−2年 分段利差", "curvesegments", "cn5y", "cn2y",
          "曲线短端这一截的陡峭程度。短端主要由资金面和央行政策决定：这一段走陡，常见于资金宽松、短端利率下得比中段快。");
        spread("cnSeg10y5y", "中国 10年−5年 分段利差", "curvesegments", "cn10y", "cn5y",
          "曲线中长端这一截的陡峭程度。这一段走陡，通常是长端在反映增长/通胀预期或长债供给压力；走平则是长端被买盘压住（比如保险、理财配置盘）。");
        spread("cnSeg30y10y", "中国 30年−10年 分段利差", "curvesegments", "cn30y", "cn10y",
          "超长端比长端多给的利息。30 年国债主要由保险和养老金这类“超长钱”定价：利差被压得很窄，说明超长钱在抢券；突然走阔，往往是超长债供给或止盈盘的信号。");
        spread("usSeg30y10y", "美国 30年−10年 分段利差", "curvesegments", "us30y", "us10y",
          "美债超长端溢价。财政赤字和长债供给是这一段的主导变量，走阔常被解读为市场在为美国财政的可持续性要价。");
      }

      // CDB−govt 10Y spread block (monthly month-end points, bp).
      // Stats run over the FULL stored monthly history with the
      // inverted bond lens — deliberately not sliced by windowDays:
      // the series is monthly, its sample is the trailing-5y seed
      // window (61 month-ends) that then grows, and the card labels
      // the sample as month-end points with its true count.
      let cdbGovBlock: z.infer<typeof dashboardResponse>["cdbGov"] = null;
      {
        const pts = all.get("cdbgov10y");
        if (pts && pts.length >= 20) {
          const lastPt = pts[pts.length - 1];
          const prevPt = pts[pts.length - 2];
          if (lastPt) {
            cdbGovBlock = {
              date: lastPt.date,
              valueBp: lastPt.value,
              prevBp: prevPt ? prevPt.value : null,
              stats: histStats(
                pts.map((p) => p.date),
                pts.map((p) => p.value),
                undefined,
                true,
              ),
              chart: pts.map((p) => ({ d: p.date, v: p.value })),
            };
          }
        }
      }

      // Money-market block (ChinaMoney: repo fixings + SHIBOR)
      let moneyBlock: z.infer<typeof dashboardResponse>["money"] = null;
      {
        const fr007 = all.get("fr007");
        const fdr007 = all.get("fdr007");
        const shiborDefs: { key: string; tenor: string }[] = [
          { key: "shiboron", tenor: "隔夜" },
          { key: "shibor1w", tenor: "1 周" },
          { key: "shibor2w", tenor: "2 周" },
          { key: "shibor1m", tenor: "1 月" },
          { key: "shibor3m", tenor: "3 月" },
          { key: "shibor6m", tenor: "6 月" },
          { key: "shibor9m", tenor: "9 月" },
          { key: "shibor1y", tenor: "1 年" },
        ];
        const shiborRows = shiborDefs.flatMap((d) => {
          const pts = all.get(d.key);
          if (!pts || pts.length < 2) return [];
          const vals = pts.map((p) => p.value);
          const lastV = vals[vals.length - 1] ?? 0;
          const prevV = vals[vals.length - 2] ?? lastV;
          return [{
            key: d.key,
            tenor: d.tenor,
            value: lastV,
            changeBp: Math.round((lastV - prevV) * 1000) / 10,
            // SHIBOR is a funding cost, read on the plain price lens
            // (low rate = money is cheap) — deliberately NOT inverted
            // like the term treasury yields above.
            stats: histStats(pts.map((p) => p.date), vals, windowDays),
          }];
        });
        const cards: Indicator[] = [];
        const moneyCard = (
          key: string,
          name: string,
          method: string,
          seriesKey: string,
          stateFn: (v: number) => string,
          note: string,
        ) => {
          const pts = all.get(seriesKey);
          if (!pts || pts.length < 60) return;
          const now = pts[pts.length - 1]?.value ?? 0;
          const ind = makeIndicator({ windowDays,
            key,
            name,
            method,
            unit: "%",
            decimals: 3,
            dates: pts.map((p) => p.date),
            values: pts.map((p) => p.value),
            state: stateFn(now),
            note,
          });
          if (ind) cards.push(ind);
        };
        moneyCard("fr007", "FR007 · 7 天回购定盘利率（全市场）", "repo", "fr007",
          (v) => (v >= 2.5 ? "资金明显偏紧" : v >= 1.8 ? "资金中性偏紧" : "资金偏松"),
          "把钱借出去 7 天的“批发价”，由全市场（含券商、基金等非银机构）的回购成交定盘。它比 DR007 更容易在季末、缴税期冲高，因为非银借钱更急。");
        moneyCard("fdr007", "FDR007 / DR007 · 7 天回购定盘利率（存款类机构）", "repo", "fdr007",
          (v) => (v >= 2.2 ? "银行间资金偏紧" : v >= 1.6 ? "银行间资金中性" : "银行间资金宽松"),
          "只统计银行等存款类机构之间借钱的价格，是央行最盯的资金面锚。它长期围绕 7 天逆回购政策利率上下波动：持续高于政策利率 = 央行觉得还可以，持续低于 = 钱多到借不出去。");
        moneyCard("fr001", "FR001 · 隔夜回购定盘利率", "repo", "fr001",
          (v) => (v >= 2.5 ? "隔夜资金紧张" : v >= 1.5 ? "隔夜资金正常" : "隔夜资金很松"),
          "借 1 天钱的价格，对突发流动性冲击最敏感。2013 年“钱荒”时隔夜利率一度冲到两位数；平时它突然跳升，往往是季末或突发缴款的信号。");
        // Liquidity tiering spread: FR007 − FDR007
        if (fr007 && fdr007) {
          const dMap = new Map(fdr007.map((p) => [p.date, p.value]));
          const dts: string[] = [];
          const vals: number[] = [];
          for (const p of fr007) {
            const dv = dMap.get(p.date);
            if (dv !== undefined) {
              dts.push(p.date);
              vals.push(Math.round((p.value - dv) * 1000) / 1000);
            }
          }
          if (vals.length >= 60) {
            const now = vals[vals.length - 1] ?? 0;
            const ind = makeIndicator({ windowDays,
              key: "tierSpread",
              name: "流动性分层利差（FR007 − FDR007）",
              method: "repo",
              unit: "%",
              decimals: 3,
              dates: dts,
              values: vals,
              state: now >= 0.3 ? "分层明显（非银借钱贵很多）" : now >= 0.1 ? "轻度分层" : "分层不明显（资金传导顺畅）",
              note: "同一个 7 天借钱，全市场价格减去银行间价格。差得越大，说明钱卡在银行体系里传不到非银手上——这是信用风险事件和季末紧张时最先报警的指标之一。",
            });
            if (ind) cards.push(ind);
          }
        }
        moneyCard("gc007", "GC007 · 上交所 7 天质押式回购（交易所）", "repo", "gc007",
          (v) => (v >= 2.5 ? "交易所资金明显偏紧" : v >= 1.8 ? "交易所资金中性偏紧" : "交易所资金偏松"),
          "在上交所做的 7 天质押式回购的收盘利率，就是股民常说的“7 天逆回购”那个品种的市场价格（你把钱借出去时锁定的就是它）。它由交易所市场的机构和资管产品定价，季末常比银行间冲得更高。");
        moneyCard("gc001", "GC001 · 上交所 1 天质押式回购（交易所）", "repo", "gc001",
          (v) => (v >= 2.5 ? "交易所隔夜资金紧张" : v >= 1.5 ? "交易所隔夜资金正常" : "交易所隔夜资金很松"),
          "在上交所做的 1 天（隔夜）质押式回购的收盘利率，就是股民常说的“隔夜逆回购”品种的市场价格。它对突发流动性冲击最敏感，月末、季末、缴款日常脉冲式冲高。来源与更新日期同 GC007（东方财富交易所回购行情，与 GC007 同批拉取）。");
        moneyCard("shibor3m", "SHIBOR 3 个月", "shibor", "shibor3m",
          (v) => (v >= 2.5 ? "中期资金偏贵" : v >= 1.8 ? "中期资金中性" : "中期资金便宜"),
          "大银行报出的 3 个月拆借价，是很多浮息贷款和同业存单的定价参考。它和 FDR007 的差，反映银行对未来 3 个月资金面的预期。");
        if (shiborRows.length > 0 || cards.length > 0) {
          moneyBlock = {
            date: fr007?.[fr007.length - 1]?.date ?? shiborRows[0]?.key ?? "",
            shibor: shiborRows,
            cards,
            fr007Chart: (fr007 ?? []).slice(-windowDays).map((p) => ({ d: p.date, v: p.value })),
            fdr007Chart: (fdr007 ?? []).slice(-windowDays).map((p) => ({ d: p.date, v: p.value })),
            gc007Chart: (all.get("gc007") ?? []).slice(-windowDays).map((p) => ({ d: p.date, v: p.value })),
            gc001Chart: (all.get("gc001") ?? []).slice(-windowDays).map((p) => ({ d: p.date, v: p.value })),
          };
          const s3 = all.get("shibor3m");
          const gc = all.get("gc007");
          if (!fr007 && s3) moneyBlock.date = s3[s3.length - 1]?.date ?? "";
          if (!fr007 && !s3 && gc) moneyBlock.date = gc[gc.length - 1]?.date ?? "";
        }
      }

      // Gold / silver ratio
      const goldPts = all.get("gold");
      const silverPts = all.get("silver");
      if (goldPts && silverPts) {
        const sMap = new Map(silverPts.map((p) => [p.date, p.value]));
        const dts: string[] = [];
        const vals: number[] = [];
        for (const p of goldPts) {
          const sv = sMap.get(p.date);
          if (sv !== undefined && sv > 0) {
            dts.push(p.date);
            vals.push(p.value / sv);
          }
        }
        if (vals.length >= 60) {
          const now = vals[vals.length - 1] ?? 0;
          const ind = makeIndicator({ windowDays,
            key: "goldSilverRatio",
            name: "金银比（1盎司金 = 几盎司银）",
            method: "goldratio",
            unit: "倍",
            decimals: 1,
            dates: dts,
            values: vals,
            state: now > 100 ? "白银相对很便宜（金银比高）" : now >= 80 ? "白银相对便宜（金银比偏高）" : now <= 55 ? "白银相对偏贵（金银比低）" : "金银比处在常见区间",
            note: "金银比冲高通常出现在避险情绪浓、工业需求弱的时候；历史上极端高位（如 2020 年的 120 倍）之后，白银常有补涨。",
          });
          if (ind) derived.push(ind);
        }
      }

      // Gold vs US 10Y correlation (1y, daily changes)
      const us10 = all.get("us10y");
      if (goldPts && us10) {
        const yMap = new Map(us10.map((p) => [p.date, p.value]));
        const pairs: { g: number; y: number }[] = [];
        let prevG: number | null = null;
        let prevY: number | null = null;
        for (const p of goldPts.slice(-300)) {
          const yv = yMap.get(p.date);
          if (yv === undefined) continue;
          if (prevG !== null && prevY !== null && prevG > 0) {
            pairs.push({ g: (p.value - prevG) / prevG, y: yv - prevY });
          }
          prevG = p.value;
          prevY = yv;
        }
        if (pairs.length >= 60) {
          const mg = pairs.reduce((a, b) => a + b.g, 0) / pairs.length;
          const my = pairs.reduce((a, b) => a + b.y, 0) / pairs.length;
          let cov = 0;
          let vg = 0;
          let vy = 0;
          for (const pr of pairs) {
            cov += (pr.g - mg) * (pr.y - my);
            vg += (pr.g - mg) ** 2;
            vy += (pr.y - my) ** 2;
          }
          const corr = vg > 0 && vy > 0 ? cov / Math.sqrt(vg * vy) : 0;
          derived.push({
            key: "goldUsCorr",
            name: "黄金与美债名义收益率相关性（近1年）",
            method: "correlation",
            value: Math.round(corr * 100) / 100,
            unit: "",
            decimals: 2,
            date: goldPts[goldPts.length - 1]?.date ?? "",
            change: null,
            state: corr <= -0.3 ? "明显负相关（教科书关系成立）" : corr >= 0.3 ? "明显正相关（非常规状态）" : "关系不明显",
            note: "这张卡算的是金价与 10 年美债名义收益率变动的相关系数。教科书说法：名义收益率涨，黄金就跌，所以正常是负相关。但真正决定持有黄金机会成本的是实际利率——名义收益率上行若只是通胀预期走阔（实际利率没动），金价未必跌，两者会背离，所以这张卡须对照实际利率卡一起读。如果变成正相关，说明有更强的力量（如央行购金、避险）在推黄金，值得多看一眼。",
            stats: null,
            chart: [],
          });
        }
      }

      // Hero strip: CN 10Y + SPX + CSI300 + HSTECH + Gold
      const hero: z.infer<typeof dashboardResponse>["hero"] = [];
      const cn10Stats = cn10 ? histStats(cn10.map((p) => p.date), cn10.map((p) => p.value), undefined, true) : null;
      if (cn10 && cn10.length > 0) {
        const lastV = cn10[cn10.length - 1]?.value ?? 0;
        const prevV = cn10[cn10.length - 2]?.value ?? lastV;
        // Hero percentile follows the selected window like every other
        // card; the full-history cn10Stats above stays for the signal.
        const cn10WinStats = histStats(cn10.map((p) => p.date), cn10.map((p) => p.value), windowDays, true);
        hero.push({
          key: "cn10y",
          name: "中国 10 年国债收益率",
          value: lastV,
          unit: "%",
          decimals: 2,
          changePct: Math.round((lastV - prevV) * 1000) / 10, // bp, shown with bp label client-side via key check
          percentile: cn10WinStats?.percentile ?? null,
          count: cn10WinStats?.count ?? null,
          label: cn10WinStats?.label ?? "",
          invert: true,
          date: cn10[cn10.length - 1]?.date ?? "",
          partial: false,
        });
      }
      const heroKeys: { key: string; name: string }[] = [
        { key: "spx", name: "标普 500" },
        { key: "csi300", name: "沪深300（510300）" },
        { key: "hstech3033", name: "恒生科技（3033）" },
        { key: "gold", name: "黄金" },
      ];
      for (const h of heroKeys) {
        const inst = byKey.get(h.key);
        if (!inst) continue;
        hero.push({
          key: h.key,
          name: h.name,
          value: inst.price,
          unit: inst.unit,
          decimals: inst.decimals,
          changePct: inst.changePct,
          percentile: inst.priceStats?.percentile ?? null,
          count: inst.priceStats?.count ?? null,
          label: inst.priceStats?.label ?? "",
          invert: inst.priceStats?.invert ?? false,
          date: inst.date,
          partial: inst.partial,
        });
      }

      // ---- FRED (Wall-Street layer) indicator cards ----
      // Which source supplied the stored corporate-profits series
      // (BEA direct vs FRED mirror), recorded by stageWallst on every
      // run — the corpProfits card below labels the actual source.
      const cpSource = await readCpSource(ctx);
      const fred: Indicator[] = [];
      const fredCard = (
        key: string,
        name: string,
        method: string,
        seriesKey: string,
        unit: string,
        decimals: number,
        stateFn: (v: number) => string,
        note: string,
        invert = false,
      ) => {
        const pts = all.get(seriesKey);
        if (!pts || pts.length < 20) return;
        // Never present a dead series as current: if the newest stored
        // point is over a year old, the source has frozen (this is what
        // the Chicago Fed's static NFCI file did) — the card disappears
        // and the page's gap note names it instead.
        const tail = pts[pts.length - 1];
        if (!tail || Date.now() - new Date(`${tail.date}T00:00:00Z`).getTime() > 370 * 86400000) return;
        const ind = makeIndicator({ windowDays,
          key,
          name,
          method,
          unit,
          decimals,
          dates: pts.map((p) => p.date),
          values: pts.map((p) => p.value),
          state: stateFn(pts[pts.length - 1]?.value ?? 0),
          note,
          withChart: true,
          invert,
        });
        if (ind) fred.push(ind);
      };
      fredCard("realRate", "美国 10 年实际利率（TIPS）", "realrate", "fredreal10", "%", 2,
        (v) => (v >= 2 ? "实际利率高位（对黄金和成长股都是逆风）" : v >= 1 ? "实际利率偏高" : v >= 0 ? "实际利率温和" : "实际利率为负（钱存着贬值）"),
        "名义利率减通胀预期，代表“扣掉物价后真正赚到的利息”。它是黄金最重要的对手：实际利率上行，持有不生息的黄金机会成本变高，金价通常承压。数据来自美国财政部官网每日实际收益率曲线（10 年期 TIPS 面值实际收益率，即 FRED 的 DFII10 的原始发布源）。", true);
      fredCard("breakeven", "美国 10 年通胀预期（盈亏平衡）", "breakeven", "fredbe10", "%", 2,
        (v) => (v >= 2.6 ? "通胀预期偏高（美联储会保持鹰派）" : v >= 2.2 ? "通胀预期略高于目标" : v >= 1.8 ? "通胀预期锚定在目标附近" : "通胀预期偏低（市场在担心需求）"),
        "用国债和通胀保值国债（TIPS）的收益率差算出的“市场认为未来 10 年平均通胀”。美联储盯着它看：预期脱锚（冲过 2.6%）是加息的理由，掉头向下则是降息的铺垫。本台按同口径用美国财政部官网每日名义收益率减实际收益率算出（即 FRED 的 T10YIE 的原始数据）。");
      fredCard("hySpread", "美国高收益债利差（HY OAS）", "creditoas", "fredhy", "%", 2,
        (v) => (v >= 8 ? "危机级利差（信用市场在恐慌）" : v >= 5 ? "利差偏宽（市场在担心违约）" : v >= 3.2 ? "利差正常区间" : "利差极窄（市场亢奋，风险补偿很薄）"),
        "垃圾债比国债多给的利息，是华尔街最灵敏的“风险胃口计”：股市还没跌，信用利差往往先走阔。历史上利差冲过 8% 都对应大危机，缩到 3% 以下则说明市场在抢风险、补偿很薄。FRED 序列 BAMLH0A0HYM2（ICE 美银指数）。样本说明：FRED 对这条 ICE 指数只分发近约 3 年的历史（自 2023-11-21 起，约 786 个交易日——已用分页 offset 复核，窗口外无更多数据），本卡的百分位、中位数与区间都按这段实际样本计算，不按 5 年口径。", true);
      fredCard("igSpread", "美国投资级债利差（IG OAS）", "creditoas", "fredig", "%", 2,
        (v) => (v >= 2 ? "IG 利差明显走阔（避险在升级）" : v >= 1.2 ? "IG 利差温和走阔" : "IG 利差平稳（大公司融资环境友好）"),
        "大公司债比国债多给的利息。IG 利差平时很稳，一旦它都开始快速走阔，说明恐慌从垃圾债蔓延到了优质公司，是系统性压力的信号。FRED 序列 BAMLC0A0CM。样本说明：与 HY 同口径——FRED 对这条 ICE 指数只分发近约 3 年的历史（自 2023-11-21 起，约 785 个交易日），本卡的百分位、中位数与区间都按这段实际样本计算，不按 5 年口径。", true);
      fredCard("termPremium", "美国 10 年期限溢价", "termpremium", "fredtp10", "%", 2,
        (v) => (v >= 1.5 ? "期限溢价高（长债在为财政和供给要价）" : v >= 0.5 ? "期限溢价正常化中" : v >= 0 ? "期限溢价偏低" : "期限溢价为负（长债被抢，长端收益率被压低）"),
        "买 10 年长债而不是滚动买短债，市场要求多给的补偿。它为负的年代（2016–2023 多数时间）是“长债被全球央行和养老金抢爆”的结果；转正并走高，往往对应财政供给压力和长端收益率易上难下。数据来自纽约联储官网直接发布的 ACM 模型估计（Adrian–Crump–Moench，即 FRED 的 THREEFYTP10 的原始来源）。百分位与全站各卡一致：按页面所选统计窗口计算（默认近 2 年），与图表同窗口。", true);
      fredCard("fedFunds", "联邦基金有效利率（EFFR）", "realrate", "freddff", "%", 2,
        (v) => `当前政策利率水平 ${v.toFixed(2)}%`,
        "美联储政策利率的实际成交水平。看它和 2 年美债收益率的差，就知道市场在定价“接下来是降息还是加息”：2 年期低于它 = 市场押注降息。点阵图每季度才更新一次，没有程序化序列，本台用这条实际利率 + 2 年收益率跟踪路径变化。数据来自纽约联储官网每日发布的 EFFR（即 FRED 的 DFF 的原始发布源）。");
      fredCard("nfci", "芝加哥联储金融条件指数", "creditoas", "frednfci", "", 2,
        (v) => (v > 0.3 ? "金融条件偏紧" : v > -0.2 ? "金融条件中性" : "金融条件宽松（对风险资产友好）"),
        "把利率、利差、杠杆等上百个指标压成一个数：正数 = 钱紧，负数 = 钱松。它是“体感版”的货币政策——有时美联储没降息，但市场自己把条件放松了（比如股市大涨）。芝加哥联储发布的 NFCI（周频）；取数通道为芝加哥联储官方数据接口 api.data.chicagofed.org（旧官网静态文件已停更在 2016 年，不再使用）。本台只接受足够新的数据。");
      fredCard("sentiment", "密歇根大学消费者信心", "sentiment", "fredsent", "点", 1,
        (v) => (v >= 90 ? "消费者信心强劲" : v >= 70 ? "消费者信心中性" : v >= 55 ? "消费者信心偏弱" : "消费者信心低迷（历史上常对应股市大底附近）"),
        "每月问卷问老百姓对经济的感受。信心极低时往往物极必反（2009、2022 年低点都在股市底部附近），但它更多是同步指标而非领先指标。数据来自密歇根大学消费者调查（Surveys of Consumers）官网发布的 ICS 指数表（月频，即 FRED 的 UMCSENT 的原始来源）。");
      fredCard("corpProfits", "美国企业利润（税后，季频）", "earnings", "fredcp", "十亿美元", 0,
        (v) => `最新一季企业利润 ${Math.round(v).toLocaleString("zh-CN")} 十亿美元`,
        `全美企业税后利润总额（BEA 国民账户）。股市长期涨跌最终要靠它兑现：利润创新高时，高估值有支撑；利润连续两个季度下滑，是盈利衰退的信号。回购规模没有免费的程序化序列，本台用利润 + 金融条件间接跟踪。${cpSource === "bea" ? "数据来源：BEA NIPA Table 1.12（直连）（季频）。" : "数据来源：FRED CP（BEA 镜像）（季频）。"}`);
      fredCard("be5y5y", "美国 5y5y 远期通胀预期", "breakeven", "fredbe5", "%", 2,
        (v) => (v >= 2.6 ? "长期通胀预期偏高（脱锚风险）" : v >= 2.2 ? "长期通胀预期略高于目标" : v >= 1.8 ? "长期通胀预期锚定良好" : "长期通胀预期偏低"),
        "市场认为“5 年之后的那 5 年”平均通胀是多少：用美国财政部官网 5 年、10 年名义收益率减去同期限实际（TIPS）收益率，得到两段盈亏平衡通胀，再由这两段推算出远期（与 FRED 的 T5YIFR 同思路，输入全部是财政部官方曲线）。美联储最在意它：短期通胀预期会被油价带着跑，5y5y 动了才叫预期脱锚。它稳在 2% 附近，美联储就有耐心；它持续上行，长端收益率很难下来。");
      fredCard("broadUsd", "美元广义指数（贸易加权）", "realrate", "fredusd", "", 2,
        (v) => (v >= 125 ? "美元处在强势区（新兴市场和大宗商品承压）" : v >= 110 ? "美元偏强" : v >= 95 ? "美元中性区间" : "美元偏弱（对风险资产友好）"),
        "美联储自己编制的美元指数，按美国和主要贸易伙伴的贸易量加权，比只看欧元日元的 DXY 更全面。美元是全球流动性的总阀门：它走强，新兴市场和美股跨国公司的海外利润都难受；它掉头向下，往往是全球风险偏好回升的同步信号。FRED 序列 DTWEXBGS。");

      // ---- Macro data series (monthly; rendered on the 宏观 page) ----
      // CPI YoY and core PCE YoY are computed here from the stored
      // monthly index levels (BLS CPI-U NSA index / BEA core PCE price
      // index via FRED); the unemployment rate is published as a rate
      // and used directly. Percentiles come from makeIndicator over the
      // displayed (YoY) series itself, same window rule as every card.
      const macroFred: Indicator[] = [];
      const yoySeries = (pts: Pt[]): { dates: string[]; values: number[] } => {
        const byDate = new Map(pts.map((p) => [p.date, p.value]));
        const dates: string[] = [];
        const values: number[] = [];
        for (const p of pts) {
          const [y = "", m = "", d = ""] = p.date.split("-");
          const prev = byDate.get(`${Number(y) - 1}-${m}-${d}`);
          if (prev !== undefined && prev > 0) {
            dates.push(p.date);
            values.push(Math.round((p.value / prev - 1) * 10000) / 100);
          }
        }
        return { dates, values };
      };
      const macroCard = (
        key: string,
        name: string,
        seriesKey: string,
        yoy: boolean,
        stateFn: (values: number[]) => string,
        note: string,
      ) => {
        const pts = all.get(seriesKey);
        if (!pts || pts.length < 24) return;
        // Same staleness guard as fredCard: a frozen monthly feed must
        // disappear into the page's gap note, never pose as current.
        const tailPt = pts[pts.length - 1];
        if (!tailPt || Date.now() - new Date(`${tailPt.date}T00:00:00Z`).getTime() > 370 * 86400000) return;
        const s = yoy ? yoySeries(pts) : { dates: pts.map((p) => p.date), values: pts.map((p) => p.value) };
        if (s.values.length < 20) return;
        const ind = makeIndicator({ windowDays,
          key,
          name,
          method: "macrodata",
          unit: "%",
          decimals: 2,
          dates: s.dates,
          values: s.values,
          state: stateFn(s.values),
          note,
          withChart: true,
        });
        if (ind) macroFred.push(ind);
      };
      macroCard("cpiYoY", "美国 CPI 同比", "fredcpi", true,
        (vs) => {
          const v = vs[vs.length - 1] ?? 0;
          return v >= 4 ? "通胀高烧未退（美联储很难降息）" : v >= 3 ? "通胀仍高于目标（降息空间有限）" : v >= 2 ? "通胀接近 2% 目标" : v >= 1 ? "通胀低于目标" : "通胀极低（要警惕需求不足）";
        },
        "美国劳工统计局（BLS）每月公布的居民消费价格指数（CPI-U，未季调），同比 = 和去年同月比涨了多少——新闻里说的“美国通胀”默认就是它。它决定美联储的脸色：同比在 3% 上方，降息很难；回到 2% 附近，降息才有空间。数据来自 BLS 官方 API（序列 CUUR0000SA0），FRED 的 CPIAUCNS 是同一条序列的转引，两边谁先拉到用谁。月频数据、发布滞后约半个月，卡片日期是数据所属月份。");
      macroCard("unrate", "美国失业率", "fredunrate", false,
        (vs) => {
          const v = vs[vs.length - 1] ?? 0;
          const n = vs.length;
          const ma3At = (end: number) => ((vs[end] ?? 0) + (vs[end - 1] ?? 0) + (vs[end - 2] ?? 0)) / 3;
          const now3 = ma3At(n - 1);
          let low3 = Infinity;
          for (let e = Math.max(2, n - 13); e < n; e++) low3 = Math.min(low3, ma3At(e));
          const sahm = now3 - (Number.isFinite(low3) ? low3 : now3);
          if (sahm >= 0.5) return `萨姆规则已触发：3 个月均值较近一年低点回升 ${sahm.toFixed(2)} 个百分点（历史上对应衰退）`;
          if (v >= 5) return "失业率偏高（就业市场明显走弱）";
          if (v >= 4.5) return "失业率温和回升（留意是否加速）";
          if (v >= 3.8) return "失业率低位（就业市场偏紧）";
          return "失业率处在极低水平（劳动力市场很紧）";
        },
        "美国劳工统计局每月就业报告里的失业率（季调）：想工作、正在找工作的人占劳动力的比例。它是滞后指标——经济已经转弱它才明显往上走，所以看趋势比看单月值重要。经验法则（萨姆规则）：失业率 3 个月均值较过去一年的低点回升 0.5 个百分点以上，历史上衰退基本都已经开始了——卡片状态就是按这条规则算的。数据来自 BLS 官方 API（序列 LNS14000000），FRED 的 UNRATE 同源。月频数据，卡片日期是数据所属月份。");
      macroCard("corePceYoY", "美国核心 PCE 同比", "fredpce", true,
        (vs) => {
          const v = vs[vs.length - 1] ?? 0;
          return v >= 3.5 ? "核心通胀黏性很强（离 2% 目标还远）" : v >= 2.5 ? "核心通胀仍高于目标（回落但没到位）" : v >= 1.8 ? "核心通胀接近 2% 目标" : "核心通胀低于目标（需求偏冷）";
        },
        "美联储真正盯的通胀指标：个人消费支出价格指数（PCE）里去掉食品和能源的“核心”部分，美国经济分析局（BEA）每月发布，美联储的 2% 目标就是对它定的。CPI 波动大、房租权重高，PCE 的权重会随消费结构调整，所以定政策看 PCE、看市场情绪先看 CPI。同比由核心 PCE 价格指数按月计算（FRED 序列 PCEPILFE）；BEA 官方 API 需要注册密钥、没有免密钥的程序化渠道，这条只能走 FRED——拉不到时它会明确缺位（见本页下方标注），本台不拿 CPI 冒充它。");

      // HY risk-appetite market proxy: HYG / IEF price ratio. The official
      // ICE BofA OAS is a proprietary index whose only free distribution is
      // FRED (unreachable from this egress); the high-yield ETF's price
      // relative to the Treasury ETF is the standard tradable stand-in —
      // it falls when credit is sold off (spreads widening). The card is
      // labelled as a market proxy, never as the official spread.
      {
        const hygPts = all.get("hyg");
        const iefPts = all.get("ief");
        if (hygPts && iefPts && hygPts.length >= 60 && iefPts.length >= 60) {
          const iefMap = new Map(iefPts.map((p) => [p.date, p.value]));
          const dts: string[] = [];
          const vals: number[] = [];
          for (const p of hygPts) {
            const iv = iefMap.get(p.date);
            if (iv !== undefined && iv > 0) {
              dts.push(p.date);
              vals.push(Math.round((p.value / iv) * 10000) / 100);
            }
          }
          if (vals.length >= 60) {
            const sorted = [...vals].sort((a, b) => a - b);
            const now = vals[vals.length - 1] ?? 0;
            const pct = Math.round(((sorted.filter((v) => v <= now).length || 1) / sorted.length) * 100);
            const ind = makeIndicator({ windowDays,
              key: "hyProxy",
              name: "高收益债相对强弱（市场代理 · HYG/IEF 价格比，非利差）",
              method: "creditoas",
              unit: "",
              decimals: 2,
              dates: dts,
              values: vals,
              state: pct >= 80 ? "比值处在历史高位：信用债被抢着买、风险胃口旺盛（对应利差很窄的状态）" : pct >= 55 ? "比值偏高：信用环境友好" : pct >= 30 ? "比值中性：信用市场没有明显压力" : pct >= 12 ? "比值偏低：信用债在被抛售，利差的方向在走阔" : "比值处在历史低位：信用压力大（对应利差危机级走阔的状态）",
              note: "先说清口径：这不是官方利差。官方 HY 利差（ICE 美银 OAS 指数）是私有指数，免费渠道只有美联储 FRED 分发，本机出口暂不可达。这张卡是市场数据代理——HYG（高收益债 ETF）除以 IEF（7-10 年国债 ETF）的价格比 ×100：信用债被抛售时 HYG 跌得比国债 ETF 多，比值下行；历史上它与 OAS 利差反向同步，比值百分位越低、信用压力越大。FRED 恢复后官方利差卡会自动补上，两张卡会并存对照。",
              withChart: true,
            });
            if (ind) {
              const igIdx = fred.findIndex((f) => f.key === "igSpread" || f.key === "hySpread");
              if (igIdx >= 0) fred.splice(igIdx + 1, 0, ind);
              else fred.push(ind);
            }
          }
        }
      }

      // VIX term structure: spot VIX minus 3-month VIX (backwardation check)
      {
        const vixPts = all.get("vix");
        const v3Pts = all.get("vix3m");
        if (vixPts && v3Pts && vixPts.length >= 60 && v3Pts.length >= 60) {
          const m3 = new Map(v3Pts.map((p) => [p.date, p.value]));
          const dts: string[] = [];
          const vals: number[] = [];
          for (const p of vixPts) {
            const v3 = m3.get(p.date);
            if (v3 !== undefined) {
              dts.push(p.date);
              vals.push(Math.round((p.value - v3) * 100) / 100);
            }
          }
          if (vals.length >= 60) {
            const now = vals[vals.length - 1] ?? 0;
            const ind = makeIndicator({ windowDays,
              key: "vixTerm",
              name: "VIX 期限结构（现货 − 3 个月）",
              method: "vixterm",
              unit: "点",
              decimals: 2,
              dates: dts,
              values: vals,
              state: now > 0 ? "倒挂（backwardation）：近端恐慌贵过远端，是压力事件的标志" : "正向结构（contango）：远端更贵，平静期的常态",
              note: "正常时候市场为“远期的不确定性”付更多钱（VIX3M > VIX，差为负）。一旦现货 VIX 冲过 3 个月（差转正），说明恐慌集中在眼前——历史上每次大跌都伴随这个倒挂，它比 VIX 绝对值更早恢复正常，是判断恐慌是否退潮的好用指标。",
              withChart: true,
            });
            if (ind) derived.push(ind);
          }
        }
      }

      // ---- A-share money: turnover + margin + southbound ----
      const cnMoney: Indicator[] = [];
      {
        const sseAmt = all.get("sseamt");
        const szAmt = all.get("szamt");
        if (sseAmt && szAmt) {
          const szMap = new Map(szAmt.map((p) => [p.date, p.value]));
          const dts: string[] = [];
          const vals: number[] = [];
          for (const p of sseAmt) {
            const sv = szMap.get(p.date);
            if (sv !== undefined) {
              dts.push(p.date);
              vals.push(Math.round((p.value + sv) * 10) / 10);
            }
          }
          if (vals.length >= 60) {
            const now = vals[vals.length - 1] ?? 0;
            const ind = makeIndicator({ windowDays,
              key: "turnover",
              name: "两市成交额合计（沪+深）",
              method: "turnover",
              unit: "亿元",
              decimals: 0,
              dates: dts,
              values: vals,
              state: now >= 20000 ? "成交火热（情绪高涨）" : now >= 10000 ? "成交活跃" : now >= 6000 ? "成交平淡" : "成交地量（情绪冰点）",
              note: "全场一天买卖的总金额，是 A 股人气最直观的刻度。历史上地量（几千亿）常出现在底部区域，天量（3 万亿+）常出现在阶段高点附近——但趋势中段的天量只是人气旺，要结合价格百分位一起看。",
            });
            if (ind) cnMoney.push(ind);
          }
        }
        const marginPts = all.get("margin");
        if (marginPts && marginPts.length >= 60) {
          const now = marginPts[marginPts.length - 1]?.value ?? 0;
          const ind = makeIndicator({ windowDays,
            key: "margin",
            name: "两融余额（融资+融券）",
            method: "turnover",
            unit: "亿元",
            decimals: 0,
            dates: marginPts.map((p) => p.date),
            values: marginPts.map((p) => p.value),
            state: now >= 20000 ? "杠杆资金高位（拥挤，注意踩踏风险）" : now >= 15000 ? "杠杆资金中高位" : "杠杆资金中低位",
            note: "投资者借钱炒股（融资）和借股做空（融券）的总余额，绝大部分是融资。它是散户和游资风险偏好的温度计：余额快速冲高 = 杠杆在堆积（2015 年教训），趋势性回落 = 杠杆在撤退。数据来自东方财富数据中心（交易所汇总）。",
          });
          if (ind) cnMoney.push(ind);
        }
        const sbPts = all.get("southbound");
        if (sbPts && sbPts.length >= 60) {
          const now = sbPts[sbPts.length - 1]?.value ?? 0;
          const last5 = sbPts.slice(-5).reduce((s, p) => s + p.value, 0);
          const last5Text = `${last5 >= 0 ? "+" : ""}${last5.toFixed(1)} 亿港元`;
          const ind = makeIndicator({ windowDays,
            key: "southbound",
            name: "南向资金净买入（港股通沪+深）",
            method: "turnover",
            unit: "亿港元",
            decimals: 1,
            dates: sbPts.map((p) => p.date),
            values: sbPts.map((p) => p.value),
            state:
              now > 0
                ? `当日净买入（近 5 个交易日合计 ${last5Text}）`
                : now < 0
                  ? `当日净卖出（近 5 个交易日合计 ${last5Text}）`
                  : "当日净买入为零",
            note: "内地资金经港股通买卖港股的每日净额（买入 − 卖出，沪+深两个通道合计）。和北向不同：北向每日净买入已于 2024 年 8 月停披，南向由港交所照常每日披露，从未停过。南向是港股最重要的边际买家之一：连续大额净买入常出现在港股低位（内地资金在捡便宜），连续净卖出则是内地资金在兑现离场——和恒生科技页对照着看最清楚。数据来自东方财富数据中心（转引港交所每日披露）。",
          });
          if (ind) cnMoney.push(ind);
        }
        // ---- 股债性价比（ETF 口径代理）: dividend yield of the two
        // tracked dividend ETFs' underlying indices (CSI official
        // D/P1 prints, stored as divlowdy / divdy by the extras stage)
        // minus the same-date CN 10Y yield. Full-market dividend yield
        // still has no free programmatic source — this card is the
        // dividend-ETF proxy and says so in its name and note. The
        // spread series only exists on dates both legs printed; the
        // card renders once ≥20 aligned points have accumulated (the
        // CSI file's first seed is exactly its ~20-day window).
        const dlPts = all.get("divlowdy");
        const sdPts = all.get("divdy");
        const cn10Pts = all.get("cn10y");
        if (dlPts && cn10Pts) {
          const yMap = new Map(cn10Pts.map((p) => [p.date, p.value]));
          const spreadOf = (dyPts: Pt[]): { d: string[]; v: number[] } => {
            const d: string[] = [];
            const v: number[] = [];
            for (const p of dyPts) {
              const y = yMap.get(p.date);
              if (y !== undefined) {
                d.push(p.date);
                v.push(Math.round((p.value - y) * 100) / 100);
              }
            }
            return { d, v };
          };
          const sp = spreadOf(dlPts);
          if (sp.v.length >= 20) {
            const now = sp.v[sp.v.length - 1] ?? 0;
            const lastDate = sp.d[sp.d.length - 1] ?? "";
            const dyNow = dlPts.find((p) => p.date === lastDate)?.value ?? 0;
            const yNow = yMap.get(lastDate) ?? 0;
            const spStats = histStats(sp.d, sp.v, windowDays, true);
            const pctText = spStats ? `利差历史百分位 ${spStats.percentile}（${spStats.label}，样本 ${spStats.count} 个交易日）` : "利差样本不足，暂无历史百分位";
            const sdSp = sdPts ? spreadOf(sdPts) : { d: [] as string[], v: [] as number[] };
            const sdLast = sdSp.v.length > 0 ? (sdSp.v[sdSp.v.length - 1] ?? 0) : null;
            const sdDyNow = sdLast !== null ? (sdPts?.find((p) => p.date === (sdSp.d[sdSp.d.length - 1] ?? ""))?.value ?? null) : null;
            const ind = makeIndicator({ windowDays,
              key: "erpProxy",
              name: "股债性价比（红利低波 512890 · ETF 口径代理）",
              method: "erp",
              unit: "个百分点",
              decimals: 2,
              dates: sp.d,
              values: sp.v,
              state:
                now > 0
                  ? `红利股息率高于 10 年国债收益率 ${now.toFixed(2)} 个百分点，红利相对债偏便宜（${pctText}）`
                  : `红利股息率已不高于 10 年国债收益率（利差 ${now.toFixed(2)} 个百分点），红利相对债不便宜（${pctText}）`,
              note:
                `ETF 口径代理，不是全市场口径：股息率取 512890 跟踪的中证红利低波动指数官方股息率（中证指数官网每日估值文件，股息率1 / 总股本口径），${lastDate} 为 ${dyNow.toFixed(2)}%，减同日 10 年国债收益率 ${yNow.toFixed(2)}%（东方财富数据中心），利差 ${now.toFixed(2)} 个百分点。` +
                (sdLast !== null && sdDyNow !== null
                  ? `另一只红利 ETF 510880 跟踪的上证红利指数同口径股息率 ${sdDyNow.toFixed(2)}%（${sdSp.d[sdSp.d.length - 1] ?? ""}），对应利差 ${sdLast.toFixed(2)} 个百分点，两只红利 ETF 口径互相印证。`
                  : "") +
                `读法：利差越宽，红利资产相对国债越便宜、股息对利率的补偿越厚；利差收窄到历史低位，说明红利被买贵了或国债收益率上行，性价比在变差。股息率历史由中证官网每日文件逐日积累（文件本身回溯约 20 个交易日，样本随每次刷新增长，百分位样本数见上方统计）；全市场股息率仍无免费程序源，本卡只代表红利 ETF 这一口径。`,
              withChart: true,
              // A spread, read like the other spreads: wider (higher
              // percentile) = equities cheaper vs bonds — inverted lens.
              invert: true,
            });
            if (ind) cnMoney.push(ind);
          }
        }
      }

      // ---- Style factors: 63d log-relative-strength between two series ----
      const style: Indicator[] = [];
      const relDiffCard = (
        key: string,
        name: string,
        aKey: string,
        bKey: string,
        aLabel: string,
        bLabel: string,
        note: string,
      ) => {
        const a = all.get(aKey);
        const b = all.get(bKey);
        if (!a || !b) return;
        const bMap = new Map(b.map((p) => [p.date, p.value]));
        const dts: string[] = [];
        const diffs: number[] = [];
        for (const p of a) {
          const bv = bMap.get(p.date);
          if (bv !== undefined && bv > 0 && p.value > 0) {
            dts.push(p.date);
            diffs.push(Math.log(p.value) - Math.log(bv));
          }
        }
        const vals: (number | null)[] = diffs.map((d, i) => (i < 63 ? null : (d - (diffs[i - 63] ?? 0)) * 100));
        const pr = paired(dts, vals);
        if (pr.v.length < 60) return;
        const now = pr.v[pr.v.length - 1] ?? 0;
        const ind = makeIndicator({ windowDays,
          key,
          name,
          method: "stylefactor",
          unit: "%",
          decimals: 1,
          dates: pr.d,
          values: pr.v,
          state: now > 0 ? `${aLabel}占优（近 3 月跑赢 ${bLabel}）` : `${bLabel}占优（近 3 月跑赢 ${aLabel}）`,
          note,
        });
        if (ind) style.push(ind);
      };
      relDiffCard("styleDivGrowth", "风格：红利低波 vs 创业板（A股）", "sec_divlow", "chinext", "红利低波", "创业板",
        "A 股最重要的一组风格跷跷板：这个数 >0 说明防御型红利在跑赢成长，<0 说明风险偏好在追成长。它转正/转负的拐点，往往就是市场风格切换的开始。");
      relDiffCard("styleSmallLarge", "风格：中证1000 vs 沪深300（大小盘）", "cs1000", "csi300", "小盘", "大盘",
        "小盘跑赢 = 题材和流动性行情，大盘跑赢 = 机构抱团核心资产。2015 年小盘极端占优后均值回归了好几年，看百分位能知道现在挤不挤。");
      relDiffCard("styleValueGrowthUS", "风格：SCHD 红利 vs QQQ（美股）", "schd", "qqq", "红利价值", "科技成长",
        "美股版的价值-成长跷跷板。利率上行期红利相对占优，利率下行 + AI 浪潮里 QQQ 碾压红利——这个数的百分位告诉你现在市场在为什么定价。");
      // A-P2-2: three more A-share factor pairs, computed by the exact
      // same relDiffCard (63-day log relative strength, same percentile
      // machinery, same window). Each factor leg is paired with the
      // broad index of its OWN universe, so the difference isolates
      // the factor tilt instead of mixing in a size/board effect.
      relDiffCard("styleMomentumCN", "风格：动量成长 vs 创业板（A股动量）", "momgrowth", "chinext", "动量成长", "创业板宽基",
        "动量 = 过去涨得顺的股票接下来一阵往往继续顺（强者恒强）。A 股没有纯动量单因子 ETF：这条腿用华夏创业板动量成长 ETF（159967，跟踪创业板动量成长指数，按动量与成长因子选股），和同板块的创业板宽基 ETF（159915）比——同为创业板股票池，差值主要来自“专挑强势股”的选股倾斜。动量占优 = 趋势行情顺、追强有效；动量转负常出现在风格急转弯时，动量策略最怕的就是这种拐点。");
      relDiffCard("styleLowVolCN", "风格：中证500低波 vs 中证500（A股低波）", "lowvol500", "cs500", "低波动", "中证500宽基",
        "低波 = 专挑波动最小的一批股票。同为中证 500 股票池：512260 跟踪中证 500 行业中性低波动指数（行业中性后按波动率从小到大选），和中证 500 宽基 ETF（510500）比，差值基本就是纯低波因子的相对表现。低波占优通常是避险、震荡或下跌市——资金宁可慢也要稳；低波大幅落后，往往是普涨进攻行情，稳健股被嫌“涨得慢”。");
      relDiffCard("styleValueGrowthCN", "风格：沪深300价值 vs 沪深300成长（A股）", "csi300value", "csi300growth", "大盘价值", "大盘成长",
        "A 股大盘内部的价值-成长跷跷板，和已有的“红利 vs 创业板”不同：这次两端同出沪深 300 股票池、用同一套中证风格指数框架切分（562320 沪深300价值 vs 159656 沪深300成长），差值不掺大小盘和板块效应。价值占优 = 资金在为便宜和确定性付钱；成长占优 = 在为增速和想象力付钱。注意样本：两只 ETF 都是 2022 年底上市，相对强弱历史从 2023 年 1 月起，百分位样本比上面几组年轻，卡片统计里的样本数就是实际天数，别和十年样本的极端值直接比。");

      // ---- Seasonality: average calendar-month returns over the window ----
      const seasonality: z.infer<typeof dashboardResponse>["seasonality"] = [];
      for (const key of ["spx", "qqq", "csi300"]) {
        const pts = all.get(key);
        const inst = byKey.get(key);
        if (!pts || !inst || pts.length < 400) continue;
        const monthEnd = new Map<string, number>();
        for (const p of pts) monthEnd.set(p.date.slice(0, 7), p.value);
        const keys = [...monthEnd.keys()].sort();
        const byMonth = new Map<number, number[]>();
        for (let i = 1; i < keys.length; i++) {
          const prevK = keys[i - 1];
          const curK = keys[i];
          if (!prevK || !curK) continue;
          const pv = monthEnd.get(prevK) ?? 0;
          const cv = monthEnd.get(curK) ?? 0;
          if (pv <= 0) continue;
          const month = Number(curK.slice(5, 7));
          const arr = byMonth.get(month) ?? [];
          arr.push(((cv - pv) / pv) * 100);
          byMonth.set(month, arr);
        }
        const months = [...byMonth.entries()]
          .map(([m, arr]) => ({
            m,
            avg: Math.round((arr.reduce((x, y) => x + y, 0) / arr.length) * 100) / 100,
            winRate: Math.round((arr.filter((x) => x > 0).length / arr.length) * 100),
            n: arr.length,
          }))
          .sort((a, b) => a.m - b.m);
        if (months.length >= 10) seasonality.push({ key, name: inst.name, months });
      }

      // ---- Breadth across the tracked universes ----
      const breadth: z.infer<typeof dashboardResponse>["breadth"] = [];
      const breadthOf = (label: string, assets: string[]) => {
        const set = instruments.filter((i) => assets.includes(i.asset) && i.ma250 != null);
        if (set.length < 5) return;
        breadth.push({
          label,
          total: set.length,
          aboveMaPct: Math.round((set.filter((i) => i.price > (i.ma250 ?? Infinity)).length / set.length) * 100),
          atHigh: set.filter((i) => i.pos52 >= 97).length,
          atLow: set.filter((i) => i.pos52 <= 3).length,
          up: null,
          flat: null,
          down: null,
          aboveMa50Pct: null,
          aboveMa200Pct: null,
          farFromHigh: null,
          asOf: "",
          fullMarket: false,
        });
      };
      breadthOf("美股跟踪池（大盘+板块+红利）", ["us", "ussec", "usdiv"]);
      breadthOf("A股跟踪池（大盘+板块）", ["cn", "cnsec"]);

      // ---- CSI 300 full-market breadth, from the cloud snapshot ----
      // The A-share tracked pool above is only 17 ETFs. The cloud map's
      // cloud_stocks snapshot already holds every CSI 300 constituent's
      // 1-day return and MA50/MA200 distances — aggregate them here so
      // the portfolio page carries a true full-market breadth row next
      // to the tracked-pool one. Up/flat/down uses the cloud map's own
      // neutral band (CLOUD_NEUTRAL = 0.2% on d1, see cloudBreadth in
      // the client) over the same stored rows the map renders, so the
      // counts equal the sum of the map's per-group header counts by
      // construction. The row only appears on a near-complete snapshot
      // (the cloud refresh itself only replaces a market at ≥250 rows);
      // a partial snapshot must not wear a "全市场" label.
      {
        const cnRows = await db.select().from(schema.cloudStocks).where(eq(schema.cloudStocks.market, "cn"));
        if (cnRows.length >= 250) {
          const NEUTRAL = 0.2;
          let up = 0;
          let flat = 0;
          let down = 0;
          for (const r of cnRows) {
            if (r.d1 > NEUTRAL) up++;
            else if (r.d1 < -NEUTRAL) down++;
            else flat++;
          }
          type CnRow = (typeof cnRows)[number];
          const maPct = (pick: (r: CnRow) => number | null): number | null => {
            const withMa = cnRows.filter((r) => pick(r) != null);
            if (withMa.length === 0) return null;
            return Math.round((withMa.filter((r) => (pick(r) ?? 0) > 0).length / withMa.length) * 100);
          };
          const aboveMa50Pct = maPct((r) => r.ma50Diff);
          const aboveMa200Pct = maPct((r) => r.ma200Diff);
          breadth.push({
            label: "沪深300全市场宽度",
            total: cnRows.length,
            aboveMaPct: aboveMa200Pct ?? aboveMa50Pct ?? 0,
            atHigh: cnRows.filter((r) => r.fromHigh >= -3).length,
            atLow: null,
            up,
            flat,
            down,
            aboveMa50Pct,
            aboveMa200Pct,
            farFromHigh: cnRows.filter((r) => r.fromHigh <= -30).length,
            asOf: cnRows.reduce((m, r) => (r.date > m ? r.date : m), ""),
            fullMarket: true,
          });
        }
      }

      // ---- Portfolio: correlations + simulated allocations ----
      const portfolio: z.infer<typeof dashboardResponse>["portfolio"] = { corrAssets: [], correlations: [], sims: [] };
      {
        const corrDefs = [
          { key: "spx", name: "标普500" },
          { key: "csi300", name: "沪深300" },
          { key: "bond10y", name: "中国国债" },
          { key: "polbond", name: "政金债" },
          { key: "gold", name: "黄金" },
          { key: "tlt", name: "美债TLT" },
          { key: "sec_divlow", name: "红利低波" },
        ].filter((d) => (all.get(d.key) ?? []).length >= 260);
        portfolio.corrAssets = corrDefs.map((d) => ({ key: d.key, name: d.name }));
        // Align daily log returns on common dates (last ~252 trading days)
        const retMaps = new Map<string, Map<string, number>>();
        for (const d of corrDefs) {
          const pts = (all.get(d.key) ?? []).slice(-253);
          const m = new Map<string, number>();
          for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1]?.value ?? 0;
            const b = pts[i]?.value ?? 0;
            const dt = pts[i]?.date ?? "";
            if (a > 0 && b > 0 && dt) m.set(dt, Math.log(b / a));
          }
          retMaps.set(d.key, m);
        }
        const corr = (aKey: string, bKey: string): number | null => {
          const A = retMaps.get(aKey);
          const B = retMaps.get(bKey);
          if (!A || !B) return null;
          const xs: number[] = [];
          const ys: number[] = [];
          for (const [dt, v] of A) {
            const w = B.get(dt);
            if (w !== undefined) {
              xs.push(v);
              ys.push(w);
            }
          }
          if (xs.length < 60) return null;
          const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
          const my = ys.reduce((s, v) => s + v, 0) / ys.length;
          let cov = 0;
          let vx = 0;
          let vy = 0;
          xs.forEach((x, i) => {
            cov += (x - mx) * ((ys[i] ?? 0) - my);
            vx += (x - mx) ** 2;
            vy += ((ys[i] ?? 0) - my) ** 2;
          });
          return vx > 0 && vy > 0 ? Math.round((cov / Math.sqrt(vx * vy)) * 100) / 100 : null;
        };
        for (let i = 0; i < corrDefs.length; i++) {
          for (let j = i + 1; j < corrDefs.length; j++) {
            const a = corrDefs[i];
            const b = corrDefs[j];
            if (!a || !b) continue;
            const v = corr(a.key, b.key);
            if (v !== null) portfolio.correlations.push({ a: a.key, b: b.key, v });
          }
        }
        // Simulated portfolios, monthly rebalanced, from month-end closes
        const monthEnds = (key: string): Map<string, number> => {
          const m = new Map<string, number>();
          for (const p of all.get(key) ?? []) m.set(p.date.slice(0, 7), p.value);
          return m;
        };
        const sim = (name: string, desc: string, legs: { key: string; w: number }[]) => {
          const maps = legs.map((l) => monthEnds(l.key));
          let months: string[] | null = null;
          for (const m of maps) {
            const ks = [...m.keys()].sort();
            months = months === null ? ks : months.filter((k) => m.has(k));
          }
          if (!months || months.length < 24) return;
          let value = 100;
          const curve: { d: string; v: number }[] = [];
          const rets: number[] = [];
          let peak = 100;
          let maxDd = 0;
          months.forEach((mk, idx) => {
            if (idx > 0) {
              let r = 0;
              legs.forEach((l, li) => {
                const mm = maps[li];
                const prevK = months?.[idx - 1] ?? "";
                const pv = mm?.get(prevK) ?? 0;
                const cv = mm?.get(mk) ?? 0;
                if (pv > 0 && cv > 0) r += l.w * (cv / pv - 1);
              });
              value *= 1 + r;
              rets.push(r);
            }
            peak = Math.max(peak, value);
            maxDd = Math.min(maxDd, (value / peak - 1) * 100);
            curve.push({ d: mk, v: Math.round(value * 100) / 100 });
          });
          const years = months.length / 12;
          const totalReturn = value - 100;
          const cagr = (Math.pow(value / 100, 1 / years) - 1) * 100;
          const vol = rets.length > 6 ? stdev(rets) * Math.sqrt(12) * 100 : 0;
          portfolio.sims.push({
            name,
            desc,
            years: Math.round(years * 10) / 10,
            totalReturn: Math.round(totalReturn * 10) / 10,
            cagr: Math.round(cagr * 100) / 100,
            vol: Math.round(vol * 100) / 100,
            maxDd: Math.round(maxDd * 10) / 10,
            currentDd: Math.round((value / peak - 1) * 1000) / 10,
            curve,
          });
        };
        sim("美股 60/40（股/债）", "标普 500 60% + TLT 美债 40%，每月再平衡。", [
          { key: "spx", w: 0.6 },
          { key: "tlt", w: 0.4 },
        ]);
        sim("A股股债金 50/30/20", "沪深 300 50% + 10 年国债 ETF 30% + 黄金 20%，每月再平衡。", [
          { key: "csi300", w: 0.5 },
          { key: "bond10y", w: 0.3 },
          { key: "gold", w: 0.2 },
        ]);
        sim("跨市场股债金 40/20/20/20", "标普 40% + 沪深 300 20% + 中国国债 20% + 黄金 20%，每月再平衡。", [
          { key: "spx", w: 0.4 },
          { key: "csi300", w: 0.2 },
          { key: "bond10y", w: 0.2 },
          { key: "gold", w: 0.2 },
        ]);
      }

      // ---- Calendar: stored events + rule-generated recurring events ----
      const calendar: z.infer<typeof dashboardResponse>["calendar"] = { events: [] };
      {
        const today = bjToday();
        const addDays = (dstr: string, n: number) => new Date(new Date(`${dstr}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
        const stored = await db
          .select()
          .from(schema.calendarEvents)
          .orderBy(asc(schema.calendarEvents.date));
        type Ev = z.infer<typeof dashboardResponse>["calendar"]["events"][number];
        const evs: Ev[] = [];
        for (const r of stored) {
          if (r.date < addDays(today, -10) || r.date > addDays(today, 100)) continue;
          evs.push({
            date: r.date,
            timeText: r.timeText,
            title: r.title,
            category: r.category,
            impact: r.impact,
            forecast: r.forecast,
            previous: r.previous,
            explain: r.explain,
            watch: r.watch,
            source: r.source,
            past: r.date < today,
            // Stored rows whose source says the date was derived by
            // convention (the FOMC minutes rows: "纪要日期按会后三周惯例
            // 推算") carry the same 日期为推算 badge as the rule-generated
            // estimates below — one badge rule for every derived date.
            estimated: r.source.includes("推算"),
          });
        }
        const hasNear = (category: string, titlePart: string, date: string, days: number) =>
          evs.some((e) => e.category === category && e.title.includes(titlePart) && Math.abs(daysBetween(e.date, date)) <= days);
        const dictEntry = (part: string) => EVENT_DICT.find((e) => e.match.some((m) => m.toLowerCase().includes(part.toLowerCase())));
        const rule = (date: string, timeText: string, title: string, category: string, dictPart: string, source: string, estimated = false, impact = "Medium") => {
          const d = dictEntry(dictPart);
          evs.push({
            date,
            timeText,
            title,
            category,
            impact,
            forecast: "",
            previous: "",
            explain: d?.explain ?? "",
            watch: d?.watch ?? "",
            source,
            past: date < today,
            estimated,
          });
        };
        // Weekly jobless claims (Thursdays, 8:30 ET). When the Thursday is
        // a US federal holiday, the Labor Department releases on Wednesday
        // instead (Thanksgiving week; Christmas week, when Dec 24 closes
        // the federal government ahead of a Friday Christmas) — step back
        // to that Wednesday.
        for (let i = 0; i < 84; i++) {
          const dstr = addDays(today, i);
          const dow = new Date(`${dstr}T00:00:00Z`).getUTCDay();
          if (dow !== 4) continue;
          const usHol = usFederalHolidays(Number(dstr.slice(0, 4)));
          let relDate = dstr;
          for (let s = 0; s < 3 && usHol.has(relDate); s++) relDate = addDays(relDate, -1);
          const conv = etToBj(relDate, 8, 30);
          if (!hasNear("美国数据", "初请", conv.date, 3)) {
            rule(conv.date, conv.timeText, "美国初请失业金人数", "美国数据", "Jobless Claims", "按惯例推算（每周四公布，遇美国联邦假日提前至周三）", true);
          }
        }
        // ISM manufacturing (1st business day) & services (3rd business day), LPR (20th),
        // CN PMI (month-end), OPEX (3rd Friday), CN CPI/PPI & 社融 windows — next 3 months
        const base = new Date(`${today}T00:00:00Z`);
        for (let k = 0; k < 3; k++) {
          const y = base.getUTCFullYear() + Math.floor((base.getUTCMonth() + k) / 12);
          const mo = ((base.getUTCMonth() + k) % 12) + 1;
          const mm = String(mo).padStart(2, "0");
          const usHolidaysY = usFederalHolidays(y);
          const bizDays: string[] = [];
          const calFridays: string[] = [];
          for (let d = 1; d <= 31; d++) {
            const ds = `${y}-${mm}-${String(d).padStart(2, "0")}`;
            const dt = new Date(`${ds}T00:00:00Z`);
            if (dt.getUTCMonth() !== mo - 1) break;
            const dw = dt.getUTCDay();
            if (dw === 5) calFridays.push(ds);
            if (dw === 0 || dw === 6) continue;
            if (usHolidaysY.has(ds)) continue; // US federal holidays: no ISM/release that day
            bizDays.push(ds);
          }
          const ismM = bizDays[0];
          if (ismM && ismM >= today && !hasNear("美国数据", "ISM 制造业", ismM, 3)) {
            const conv = etToBj(ismM, 10, 0);
            rule(conv.date, conv.timeText, "美国 ISM 制造业 PMI", "美国数据", "ISM Manufacturing", "按惯例推算（每月第一个工作日）", true);
          }
          const ismS = bizDays[2];
          if (ismS && ismS >= today && !hasNear("美国数据", "ISM 服务业", ismS, 3)) {
            const conv = etToBj(ismS, 10, 0);
            rule(conv.date, conv.timeText, "美国 ISM 服务业 PMI", "美国数据", "ISM Services", "按惯例推算（每月第三个工作日）", true);
          }
          // LPR on the 20th, postponed to the next China workday when the
          // 20th is a weekend or a statutory holiday （调休 workdays count
          // as workdays, so a 调休 Saturday keeps the 20th).
          const lpr = cnShiftToWorkday(`${y}-${mm}-20`);
          if (lpr >= today && !hasNear("中国数据", "LPR", lpr, 4)) {
            rule(lpr, "09:15（北京时间）", "中国 LPR 报价", "中国数据", "Loan Prime Rate", "按惯例推算（每月 20 日，遇节假日顺延至下一工作日）", true);
          }
          // CN official PMI on the last day of the month, postponed to the
          // next China workday when month-end is a weekend or a statutory
          // holiday (a 调休 workday month-end — e.g. 2027-01-31, a Sunday
          // the State Council designates as a workday — stays put).
          const lastCalDay = (() => {
            let d = 31;
            while (d > 28) {
              const ds = `${y}-${mm}-${String(d).padStart(2, "0")}`;
              if (new Date(`${ds}T00:00:00Z`).getUTCMonth() === mo - 1) return ds;
              d--;
            }
            return bizDays[bizDays.length - 1] ?? "";
          })();
          const pmiDay = lastCalDay ? cnShiftToWorkday(lastCalDay) : "";
          if (pmiDay && pmiDay >= today && !hasNear("中国数据", "PMI", pmiDay, 3)) {
            rule(pmiDay, "09:30（北京时间）", "中国官方制造业 PMI", "中国数据", "Manufacturing PMI", "按惯例推算（每月最后一天，遇节假日顺延）", true);
          }
          // CN CPI/PPI estimated window (~10th) and 社融 window (~13th)
          const cpiD = `${y}-${mm}-10`;
          if (cpiD >= today && !hasNear("中国数据", "CPI", cpiD, 4)) {
            rule(cpiD, "09:30（北京时间，约）", "中国 CPI / PPI（预计窗口）", "中国数据", "Chinese CPI", "按统计局发布惯例推算，临近时以日历源更新为准", true);
          }
          const sfD = `${y}-${mm}-13`;
          if (sfD >= today && !hasNear("中国数据", "社融", sfD, 4)) {
            rule(sfD, "发布时间不固定（窗口约当月 10–15 日）", "中国社融 / M2（预计窗口）", "中国数据", "Money Supply", "央行发布时间不固定，按惯例给窗口，临近时以日历源更新为准", true);
          }
          // US BLS releases beyond the feed's ~2-week window. BLS publishes
          // exact dates a year ahead but its schedule pages return 403 to
          // programmatic access, so months 2–3 are filled with convention
          // estimates (flagged 推算) that the real feed event suppresses as
          // soon as it lands within ±4–5 days. PCE normally arrives via the
          // BEA schedule with an exact date; this estimate is its backstop.
          const firstFriday = (() => {
            for (let d = 1; d <= 7; d++) {
              const ds = `${y}-${mm}-${String(d).padStart(2, "0")}`;
              if (new Date(`${ds}T00:00:00Z`).getUTCDay() === 5) {
                // New Year's Day is a federal holiday: BLS moves the
                // Employment Situation to the second Friday.
                return ds === `${y}-01-01` ? addDays(ds, 7) : ds;
              }
            }
            return "";
          })();
          if (firstFriday && firstFriday >= today && !hasNear("美国数据", "非农", firstFriday, 4)) {
            const conv = etToBj(firstFriday, 8, 30);
            rule(conv.date, conv.timeText, "美国非农就业报告", "美国数据", "Non-Farm", "按劳工部惯例推算（每月第一个周五），临近时以日历源更新为准", true, "High");
          }
          const cpiEst = `${y}-${mm}-12`;
          if (cpiEst >= today && !hasNear("美国数据", "CPI", cpiEst, 4)) {
            rule(cpiEst, "约当月 10–14 日发布（窗口估计）", "美国 CPI 消费者物价", "美国数据", "CPI", "劳工部日程页对程序抓取返回 403，按惯例给窗口，临近时以日历源更新为准", true, "High");
          }
          const ppiEst = `${y}-${mm}-13`;
          if (ppiEst >= today && !hasNear("美国数据", "PPI", ppiEst, 4)) {
            rule(ppiEst, "约当月 11–15 日发布（窗口估计）", "美国 PPI 生产者物价", "美国数据", "PPI", "劳工部日程页对程序抓取返回 403，按惯例给窗口（通常紧随 CPI），临近时以日历源更新为准", true);
          }
          const retailEst = `${y}-${mm}-16`;
          if (retailEst >= today && !hasNear("美国数据", "零售", retailEst, 4)) {
            rule(retailEst, "约当月 15–17 日发布（窗口估计）", "美国零售销售", "美国数据", "Retail Sales", "按人口普查局惯例推算，临近时以日历源更新为准", true);
          }
          const pceEst = `${y}-${mm}-27`;
          if (pceEst >= today && !hasNear("美国数据", "PCE", pceEst, 5)) {
            rule(pceEst, "约当月最后一周发布（窗口估计）", "美国 PCE 物价 / 个人收入支出", "美国数据", "PCE", "BEA 日程未覆盖时的惯例估计，临近时以 BEA/日历源更新为准", true, "High");
          }
          // Monthly options expiry: 3rd Friday of the month (quarterly =
          // triple witching). When that Friday is a US holiday, expiry
          // moves to the Thursday before — take the 3rd calendar Friday
          // and step back, rather than the 3rd business Friday.
          const opexThird = calFridays[2];
          const opex = opexThird ? (usHolidaysY.has(opexThird) ? addDays(opexThird, -1) : opexThird) : undefined;
          if (opex && opex >= today) {
            const quarterly = [3, 6, 9, 12].includes(mo);
            rule(opex, "美股当日收盘结算", quarterly ? "期权到期日（季度三巫日）" : "月度期权到期日", "市场事件", "OPEC",
              "按规则推算（每月第三个周五，遇美国假日提前至周四）", true);
            const last = evs[evs.length - 1];
            if (last && last.title.includes("期权到期")) {
              last.explain = quarterly
                ? "股指期货、股指期权、个股期权同一天到期结算（四巫日/三巫日），机构集中调仓，到期日尾盘成交量和波动常放大，未平仓合约密集的行权价附近容易出现“钉住”效应。"
                : "月度期权到期日：大量期权合约在这一天结算，做市商对冲盘集中在尾盘，波动和成交量常放大。";
              last.watch = "看尾盘一小时的量能和指数是否被“钉”在整数关口/大行权价附近；到期日次日对冲盘撤退后，方向才更真实。";
            }
          }
        }
        evs.sort((a, b) => (a.date === b.date ? (a.timeText < b.timeText ? -1 : 1) : a.date < b.date ? -1 : 1));
        calendar.events = evs;
      }

      // ---- Margin balances: CN 融资余额 (SH+SZ) + FINRA margin debt (v108) ----
      const marginMeta = await readMarginMeta(ctx);
      // CNN Fear & Greed headline snapshot (v109); the FG1 signal below
      // reads the same row.
      const fgMeta = await readFearGreedMeta(ctx);
      // Trailing-5-calendar-year slice: the margin seed floor is a
      // fixed date (2021-11-20), so without slicing, the "5y"
      // percentile sample would quietly grow past 5 years over time.
      const slice5y = (dates: string[], values: number[]): { d: string[]; v: number[] } => {
        const lastD = dates[dates.length - 1];
        if (!lastD) return { d: dates, v: values };
        const floor = shiftDateStr(lastD, -1826);
        const i = dates.findIndex((d) => d > floor);
        return i <= 0 ? { d: dates, v: values } : { d: dates.slice(i), v: values.slice(i) };
      };
      let marginCn: DashboardPayload["marginCn"] = null;
      {
        const tot = all.get("margin_total");
        const shPts = all.get("margin_sh");
        const szPts = all.get("margin_sz");
        if (tot && tot.length >= 20 && shPts && shPts.length > 0 && szPts && szPts.length > 0) {
          const dates = tot.map((p) => p.date);
          const vals = tot.map((p) => p.value);
          const last = vals[vals.length - 1] ?? 0;
          const chgBack = (back: number): number | null => {
            const p = vals[vals.length - 1 - back];
            return p !== undefined && p > 0 ? Math.round(((last / p) - 1) * 10000) / 100 : null;
          };
          let hi = -Infinity;
          let hiD = "";
          vals.forEach((v, i) => {
            if (v > hi) {
              hi = v;
              hiD = dates[i] ?? "";
            }
          });
          const latestOf = (k: string): number => {
            const arr = all.get(k);
            return arr && arr.length > 0 ? (arr[arr.length - 1]?.value ?? 0) : 0;
          };
          // 融资买入额占两市成交额比： latest date present in both the
          // buy leg and the stored turnover legs (same 亿元 caliber).
          let share: number | null = null;
          const buyPts = all.get("margin_total_buy");
          const sseA = all.get("sseamt");
          const szA = all.get("szamt");
          if (buyPts && sseA && szA) {
            const sseMap = new Map(sseA.map((p) => [p.date, p.value]));
            const szMap = new Map(szA.map((p) => [p.date, p.value]));
            for (let i = buyPts.length - 1; i >= 0; i--) {
              const bp = buyPts[i];
              if (!bp) continue;
              const t = (sseMap.get(bp.date) ?? 0) + (szMap.get(bp.date) ?? 0);
              if (t > 0) {
                share = Math.round((bp.value / t) * 1000) / 10;
                break;
              }
            }
          }
          const start = vals.length > windowDays ? vals.length - windowDays : 0;
          const netPts = all.get("margin_total_net") ?? [];
          const netStart = netPts.length > windowDays ? netPts.length - windowDays : 0;
          const s5 = slice5y(dates, vals);
          marginCn = {
            date: dates[dates.length - 1] ?? "",
            totalYi: last,
            shYi: latestOf("margin_sh"),
            szYi: latestOf("margin_sz"),
            buyYi: latestOf("margin_total_buy"),
            repayYi: latestOf("margin_total_repay"),
            netYi: latestOf("margin_total_net"),
            rqyeYi: latestOf("margin_total_rqye"),
            rqylYiGu: latestOf("margin_total_rqyl"),
            chg5Pct: chgBack(5),
            chg20Pct: chgBack(20),
            highYi: hi,
            highDate: hiD,
            distHighPct: hi > 0 ? Math.round(((last / hi) - 1) * 10000) / 100 : 0,
            stats: histStats(dates, vals, windowDays),
            statsFull: histStats(s5.d, s5.v),
            chart: dates.slice(start).map((d, i) => ({ d, v: vals[start + i] ?? 0 })),
            netChart: netPts.slice(netStart).map((p) => ({ d: p.date, v: p.value })),
            points: tot.length,
            turnoverSharePct: share,
            szSource: marginMeta.szSource,
          };
        }
      }
      let marginUs: DashboardPayload["marginUs"] = null;
      {
        const debt = all.get("finra_margin_debt");
        if (debt && debt.length >= 8) {
          const dates = debt.map((p) => p.date);
          const vals = debt.map((p) => p.value);
          const last = vals[vals.length - 1] ?? 0;
          const yoyBase = vals[vals.length - 13];
          let hi = -Infinity;
          let hiD = "";
          let lo = Infinity;
          let loD = "";
          vals.forEach((v, i) => {
            if (v > hi) {
              hi = v;
              hiD = dates[i] ?? "";
            }
            if (v < lo) {
              lo = v;
              loD = dates[i] ?? "";
            }
          });
          let stats = histStats(dates, vals);
          let seedStats = false;
          if (!stats) {
            // Seed-only state (13 page months < histStats' 20-point
            // floor): percentile over exactly the months on file,
            // flagged so the page labels it as the short window.
            const below = vals.filter((v) => v <= last).length;
            const pct = Math.round((below / vals.length) * 1000) / 10;
            stats = {
              percentile: pct,
              median: medianOf(vals),
              min: lo,
              max: hi,
              minDate: loD,
              maxDate: hiD,
              count: vals.length,
              label: labelFor(pct),
              invert: false,
            };
            seedStats = true;
          }
          const spxPts = all.get("spx") ?? [];
          const spxByMonth = new Map<string, number>();
          for (const p of spxPts) spxByMonth.set(p.date.slice(0, 7), p.value); // ascending: last write = month-end close
          const lastOf = (k: string): number | null => {
            const arr = all.get(k);
            return arr && arr.length > 0 ? (arr[arr.length - 1]?.value ?? null) : null;
          };
          marginUs = {
            month: (dates[dates.length - 1] ?? "").slice(0, 7),
            firstMonth: (dates[0] ?? "").slice(0, 7),
            debtM: last,
            cashM: lastOf("finra_credit_cash"),
            marginCreditM: lastOf("finra_credit_margin"),
            yoyPct: yoyBase !== undefined && yoyBase > 0 ? Math.round(((last / yoyBase) - 1) * 10000) / 100 : null,
            highM: hi,
            highMonth: hiD.slice(0, 7),
            distHighPct: hi > 0 ? Math.round(((last / hi) - 1) * 10000) / 100 : 0,
            stats,
            seedStats,
            fullHistory: marginMeta.finraFull || debt.length >= 100,
            chart: debt.map((p) => ({ d: p.date, debt: p.value, spx: spxByMonth.get(p.date.slice(0, 7)) ?? null })),
            points: debt.length,
          };
        }
      }

      // ---- CNN Fear & Greed (v109) ----
      let fearGreed: DashboardPayload["fearGreed"] = null;
      {
        const fgPts = all.get("fear_greed_cnn");
        if (fgMeta && fgPts && fgPts.length >= 8) {
          const dates = fgPts.map((p) => p.date);
          const vals = fgPts.map((p) => p.value);
          const lastD = dates[dates.length - 1] ?? "";
          // Trailing-1-year stats window: the endpoint's history is
          // one year, so the percentile is honest only over that
          // window — slice by calendar days from the last stored
          // date, never the page's trading-day window.
          const floor = shiftDateStr(lastD, -366);
          const wi = dates.findIndex((d) => d > floor);
          const wDates = wi > 0 ? dates.slice(wi) : dates;
          const wVals = wi > 0 ? vals.slice(wi) : vals;
          const stats = histStats(wDates, wVals);
          const tsDate = new Date(fgMeta.timestamp);
          fearGreed = {
            score: fgMeta.score,
            updatedBj: Number.isNaN(tsDate.getTime()) ? "" : bjDateTimeText(tsDate),
            dateBj: Number.isNaN(tsDate.getTime()) ? "" : bjDateTimeText(tsDate).slice(0, 10),
            prevClose: fgMeta.prevClose,
            prevWeek: fgMeta.prevWeek,
            prevMonth: fgMeta.prevMonth,
            prevYear: fgMeta.prevYear,
            components: fgMeta.components,
            stats,
            statsFrom: wDates[0] ?? "",
            distHigh: stats ? Math.round((fgMeta.score - stats.max) * 100) / 100 : 0,
            distLow: stats ? Math.round((fgMeta.score - stats.min) * 100) / 100 : 0,
            chart: fgPts.slice(-1500).map((p) => ({ d: p.date, v: p.value })),
            points: fgPts.length,
          };
        }
      }

      // ---- Drawdown archaeology over the full stored window ----
      const drawdowns: z.infer<typeof drawdownZ>[] = [];
      const DD_KEYS = [
        "ndx", "qqq", "spx", "voo", "schd", "vym", "vig", "spyd", "hdv",
        "csi300", "sec_divlow", "sec_div", "hstech3033", "chinext", "star50",
        "gold", "tlt", "bond10y", "polbond",
      ];
      for (const key of DD_KEYS) {
        const pts = all.get(key);
        const inst = byKey.get(key);
        if (!pts || pts.length < 250 || !inst) continue;
        const dates = pts.map((p) => p.date);
        const closes = pts.map((p) => p.value);
        // Episode threshold by asset class. CN bond ETFs (511260 / 511520)
        // barely move: measured 2026-11-19 on the stored history, their
        // all-time max drawdowns are −4.6% (511260, 2020-04-29→2020-11-20)
        // and −2.6% (511520, 2025-02-06→2025-03-17), so the equity 8%
        // threshold produced ZERO episodes and both silently vanished
        // from this page. Bond ETFs therefore use 2%; TLT keeps 8% (its
        // own max drawdown is −55%, long-duration US rates are equity-like
        // in drawdown terms). The max-drawdown fallback below additionally
        // guarantees no selected instrument is ever dropped for having no
        // episode at its threshold.
        const thresholdPct = inst.asset === "bondetf" ? 2 : 8;
        let eps = drawdownEpisodes(dates, closes, thresholdPct);
        if (eps.length === 0) {
          const mdd = maxDrawdownEpisode(dates, closes);
          if (mdd) eps = [mdd];
        }
        if (eps.length === 0) continue;
        let runMax = -Infinity;
        let peakI = 0;
        closes.forEach((c, i) => {
          if (c >= runMax) {
            runMax = c;
            peakI = i;
          }
        });
        const lastDate = dates[dates.length - 1] ?? "";
        const peakDate = dates[peakI] ?? "";
        const currentDd = inst.indicators.find((i) => i.key === "drawdown")?.value ?? 0;
        const big = eps.filter((e) => e.depthPct <= -10);
        const recovered = big.filter((e) => e.daysRecover != null);
        const top = [...eps].sort((a, b) => a.depthPct - b.depthPct).slice(0, 6);
        drawdowns.push({
          key,
          name: inst.name,
          asset: inst.asset,
          windowYears: Math.round((daysBetween(dates[0] ?? "", lastDate) / 365.25) * 10) / 10,
          currentDd,
          peakDate,
          daysSincePeak: daysBetween(peakDate, lastDate),
          deepest: Math.min(...eps.map((e) => e.depthPct)),
          count10: big.length,
          count20: eps.filter((e) => e.depthPct <= -20).length,
          medianDepth: big.length ? medianOf(big.map((e) => e.depthPct)) : null,
          medianRecoverDays: recovered.length
            ? Math.round(medianOf(recovered.map((e) => e.daysRecover as number)))
            : null,
          deeperThanNow: eps.filter((e) => e.recoveryDate != null && e.depthPct < currentDd - 0.05).length,
          thresholdPct,
          episodeCount: eps.length,
          episodes: top,
        });
      }

      // ---- Rule-based decision signals (transparent scoring, no model) ----
      const signals: z.infer<typeof signalZ>[] = [];
      const f1 = (v: number) => v.toLocaleString("zh-CN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      const verdictFor = (score: number): { verdict: string; tone: "buy" | "add" | "hold" | "reduce" | "avoid" } => {
        if (score >= 3) return { verdict: "积极分批买入", tone: "buy" };
        if (score >= 1.2) return { verdict: "逢低分批买入", tone: "add" };
        if (score > -1.2) return { verdict: "持有 / 观望", tone: "hold" };
        if (score > -3) return { verdict: "减仓 / 暂缓新增", tone: "reduce" };
        return { verdict: "回避 / 止盈", tone: "avoid" };
      };
      // bar: optional mini percentile bar rendered under this factor's
      // basis line (r6 O1) — pct is the same value the text prints.
      type Factor = { pts: number; text: string; bar?: { pct: number; invert: boolean } };
      // Every expected signal occupies its slot even when its input data
      // never landed: a placeholder with verdict 数据未到 and a `missing`
      // reason, so the signals page always shows the full set of slots
      // and the overview strip counts the same number. When the data
      // lands on a later refresh, the real signal replaces the slot.
      const missingSignal = (key: string, name: string, group: string, reason: string) => {
        signals.push({
          key,
          name,
          group,
          verdict: "数据未到",
          tone: "hold",
          score: 0,
          headline: "本条信号这次没算出来——缺的数据和原因写在下面，数据一到自动恢复。",
          basis: [reason],
          basisBars: [null],
          headlineBar: null,
          caution: "数据缺失期间这条不给结论：不要拿旧值或猜测代替，等下一次刷新把数据补回来。",
          date: "",
          missing: reason,
        });
      };
      const equitySignal = (
        key: string,
        name: string,
        group: string,
        extraBasis: string[],
        caution: string,
        // Precomputed valuation factor, caller-supplied: bond ETFs
        // score theirs from the corresponding YIELD percentile
        // (V-1 step 3/4); equity signals whose target gained a PE
        // pipeline in step 5 (沪深300 / 红利低波 / VOO） score theirs
        // from the historical PE percentile. Everything else passes
        // null —
        // a price percentile is a position gauge, never a valuation
        // factor, so it does not score at all.
        valuationFactor: Factor | null = null,
        // Parallel to extraBasis: mini-bar annotation per extra line
        // (same length; null entries render no bar).
        extraBasisBars: ({ pct: number; invert: boolean } | null)[] = [],
      ) => {
        const inst = byKey.get(key);
        if (!inst) {
          missingSignal(key, name, group,
            `缺什么：${name} 的价格序列本次刷新没有取到（行情源未返回该标的的数据）。为什么缺：多为行情接口临时失败或该标的当日无数据。怎么恢复：不用做任何事——下一次刷新（点右上角「刷新数据」全量刷新；若刷新后仍有未完全成功的分块，在刷新面板里点「只重试未完全成功的块」，把所有失败分块一起重试）取到价格后，本条自动恢复成正常信号。`);
          return;
        }
        const factors: Factor[] = [];
        // V-1 step 3/4: the price-percentile factor is GONE from every
        // equity / gold signal — a price percentile only marks where
        // the price sits (trend / drawdown), it is not a cheap/expensive
        // gauge. What scores now: drawdown, MA250 trend, RSI, momentum,
        // Fib (QQQ/VOO), plus the caller-supplied valuationFactor —
        // bond ETFs score theirs from the matching yield percentile,
        // and since step 5 the three equity signals with a PE pipeline
        // （沪深300 / 红利低波 / VOO） score theirs from the
        // historical PE
        // percentile. Signals without a pipeline keep no valuation
        // factor at all.
        if (valuationFactor) factors.push(valuationFactor);
        const dd = inst.indicators.find((i) => i.key === "drawdown");
        if (dd) {
          const pts = dd.value <= -25 ? 2 : dd.value <= -15 ? 1.5 : dd.value <= -8 ? 0.5 : dd.value <= -3 ? 0 : -0.5;
          factors.push({ pts, text: `距窗口高点回撤 ${f1(dd.value)}%（高点在 ${drawdowns.find((d) => d.key === key)?.peakDate ?? "—"}）` });
        }
        if (inst.ma250 != null) {
          const above = inst.price > inst.ma250;
          factors.push({
            pts: above ? 0.5 : -1,
            text: above
              ? `价格在年线（MA250=${f1(inst.ma250)}）之上，中期趋势未破`
              : `价格在年线（MA250=${f1(inst.ma250)}）之下：按历史对照，价格处在年线下方时中期趋势读数偏弱，站回年线是这一读数转强的分界（只描述数据状态，不构成操作指令）`,
          });
        }
        const rsi = inst.indicators.find((i) => i.key === "rsi");
        if (rsi) {
          const pts = rsi.value <= 30 ? 1 : rsi.value >= 72 ? -1 : 0;
          if (pts !== 0) factors.push({ pts, text: `RSI(14)=${f1(rsi.value)}，${pts > 0 ? "短线超卖，历史上这个位置反弹概率高" : "短线超买，追高容易被套"}` });
        }
        const mom = inst.indicators.find((i) => i.key === "momentum");
        if (mom) {
          const pts = mom.value >= 5 ? 0.5 : mom.value <= -8 ? -0.5 : 0;
          if (pts !== 0) factors.push({ pts, text: `近 3 月动量 ${mom.value >= 0 ? "+" : ""}${f1(mom.value)}%` });
        }
        // Fibonacci factor: where the price sits on the 52-week
        // retracement ladder (anchors validated against Nasdaq).
        const fib = fibMap.get(key);
        if (fib && fib.range > 0) {
          const cur = inst.unit === "美元" ? "$" : "";
          const fp = (v: number) =>
            `${cur}${v.toLocaleString("en-US", { minimumFractionDigits: inst.decimals, maximumFractionDigits: inst.decimals })}`;
          let pts = 0;
          if (fib.direction === "up") {
            const depth = (fib.high - fib.close) / fib.range; // fraction retraced from the high
            pts = depth >= 0.786 ? -1 : depth >= 0.618 ? -0.5 : depth <= 0.5 ? 0.5 : 0;
          }
          const gapPct = fib.nearest.price !== 0 ? (fib.close / fib.nearest.price - 1) * 100 : 0;
          factors.push({
            pts,
            text:
              `斐波那契（52 周锚点：低 ${fp(fib.low)}@${fib.lowDate} → 高 ${fp(fib.high)}@${fib.highDate}${fib.verified ? `，已由第二源验证（${fib.verifySource}）` : "，第二源未确认"}）：` +
              `现价最近的回撤位是 ${fib.nearest.label} ${fp(fib.nearest.price)}（现价 ${fp(fib.close)}，在该位${gapPct >= 0 ? "上方" : "下方"} ${gapPct >= 0 ? "+" : ""}${gapPct.toFixed(2)}%）` +
              (fib.support ? `，下方支撑 ${fib.support.label} ${fp(fib.support.price)}` : "") +
              (fib.resistance ? `，上方压力 ${fib.resistance.label} ${fp(fib.resistance.price)}` : "") +
              "。按两根收盘规则：连续两根收盘跌破最近的下方回撤位，才算这一档失守",
          });
        }
        const score = Math.round(factors.reduce((a, f) => a + f.pts, 0) * 10) / 10;
        const { verdict, tone } = verdictFor(score);
        const strongest = [...factors].sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts))[0];
        signals.push({
          key,
          name,
          group,
          verdict,
          tone,
          score,
          headline: strongest ? strongest.text : "各因子大致中性",
          basis: [...factors.map((f) => `${f.pts > 0 ? "＋" : f.pts < 0 ? "－" : "·"} ${f.text}`), ...extraBasis],
          basisBars: [
            ...factors.map((f) => f.bar ?? null),
            ...extraBasis.map((_, i) => extraBasisBars[i] ?? null),
          ],
          // The headline IS the strongest factor's text (no prefix): when
          // that factor carries a percentile bar, the headline occurrence
          // gets the same bar (r6 O1 counts each occurrence separately).
          headlineBar: strongest?.bar ?? null,
          caution,
          date: inst.date,
          missing: "",
        });
      };

      // 中国国债：直接用收益率百分位打分（收益率越高 = 债券越便宜）
      if (yieldsBlock && cn10Stats) {
        const p = cn10Stats.percentile;
        const score = p >= 90 ? 3 : p >= 75 ? 2 : p >= 60 ? 1 : p >= 40 ? 0 : p >= 25 ? -1 : p >= 10 ? -2 : -3;
        const { verdict, tone } = verdictFor(score);
        const cn30Pts = all.get("cn30y");
        const cn30Full = cn30Pts ? histStats(cn30Pts.map((x) => x.date), cn30Pts.map((x) => x.value), undefined, true) : null;
        // Term spread on the primary caliber (10Y−1Y), scored on FULL
        // history like every other signal factor — the derived card's
        // own stats follow the display window and are not reused here.
        const cn1Pts = all.get("cn1y");
        let termFull: { value: number; percentile: number; count: number } | null = null;
        if (cn10 && cn1Pts) {
          const m1 = new Map(cn1Pts.map((x) => [x.date, x.value]));
          const sdts: string[] = [];
          const svals: number[] = [];
          for (const pt of cn10) {
            const v1 = m1.get(pt.date);
            if (v1 !== undefined) {
              sdts.push(pt.date);
              svals.push(pt.value - v1);
            }
          }
          if (svals.length >= 60) {
            const st = histStats(sdts, svals, undefined, true);
            if (st) termFull = { value: svals[svals.length - 1] ?? 0, percentile: st.percentile, count: st.count };
          }
        }
        const term = derived.find((d) => d.key === "cnTermSpread1y") ?? derived.find((d) => d.key === "cnTermSpread");
        const basis = [
          `10 年国债收益率 ${(yieldsBlock.cn.find((t) => t.key === "cn10y")?.yieldPct ?? 0).toFixed(2)}%，处在近 ${cn10Stats.count} 个交易日历史百分位 ${p}（${cn10Stats.label}）——收益率百分位越高，债券价格越便宜`,
          `这段时间收益率的历史区间：最低 ${cn10Stats.min.toFixed(2)}%（${cn10Stats.minDate}）、最高 ${cn10Stats.max.toFixed(2)}%（${cn10Stats.maxDate}），中位数 ${cn10Stats.median.toFixed(2)}%`,
          ...(cn30Full ? [`30 年国债收益率百分位 ${cn30Full.percentile}（全历史，${cn30Full.label}）：超长端${cn30Full.percentile >= p ? "相对更便宜，拉久期的性价比在长端" : "相对不便宜，超长钱抢券更凶"}`] : []),
          ...(termFull
            ? [`期限利差 10年−1年 = ${termFull.value.toFixed(2)}%（约 ${Math.round(termFull.value * 100)}bp），处在近 ${termFull.count} 个交易日历史百分位 ${termFull.percentile}：利差越宽，长债相对短债越“多给钱”（主口径 10年−1年，与课程锚点一致；10年−2年只作对照）`]
            : term
              ? [`期限利差 ${term.key === "cnTermSpread1y" ? "10年−1年" : "10年−2年"} = ${term.value.toFixed(2)}%：利差越宽，长债相对短债越“多给钱”`]
              : []),
        ];
        // Parallel mini-bar annotations (r6 O1): yield / spread
        // percentiles take the reversed (invert) lens; each value is
        // the same computed percentile its line's text prints. The
        // headline's own 收益率百分位 bar rides in headlineBar (same p).
        const basisBars: ({ pct: number; invert: boolean } | null)[] = [
          { pct: p, invert: true },
          null,
          ...(cn30Full ? [{ pct: cn30Full.percentile, invert: true }] : []),
          ...(termFull ? [{ pct: termFull.percentile, invert: true }] : term ? [null] : []),
        ];
        signals.push({
          key: "cnGov",
          name: "中国国债（10 年）",
          group: "债券",
          verdict,
          tone,
          score,
          headline: `收益率百分位 ${p}：${score >= 1 ? "利率在历史偏高位，对应债券价格处在历史偏低区间（收益率口径的便宜区）" : score <= -1 ? "利率在历史偏低位，对应债券价格处在历史偏高区间（收益率口径的贵区）" : "利率在历史中段，没有明显的便宜或昂贵"}`,
          basis,
          basisBars,
          headlineBar: { pct: p, invert: true },
          caution: "读数失效条件（描述的是数据状态，不是操作指令）：资金面持续收紧（GC007 持续高于 2.5%）、期限利差快速走阔，或收益率跌到历史最低附近时，上面的百分位对照关系不再成立，本条读数应视为失效。",
          date: yieldsBlock.date,
          missing: "",
        });
      } else {
        missingSignal("cnGov", "中国国债（10 年）", "债券",
          "缺什么：中国国债收益率序列（东方财富国债收益率表，10 年期为主）本次刷新没有取到，算不出收益率的历史百分位。为什么缺：多为数据源接口临时失败。怎么恢复：不用做任何事——下一次刷新（点右上角「刷新数据」全量刷新；若刷新后仍有未完全成功的分块，在刷新面板里点「只重试未完全成功的块」，把所有失败分块一起重试）取到收益率后，本条自动恢复成正常信号。");
      }

      // V-1 step 5: signals whose target now has a PE pipeline score
      // their valuation factor from the historical PE percentile —
      // the same stats object the instrument card renders, so the
      // signal and the card can never quote two different numbers.
      // Targets without a pipeline (QQQ / SCHD / SPYD / gold) keep
      // the step-3/4 state: no valuation factor, no wording. VOO
      // joined the pipeline in part 1 (Multpl S&P 500 PE).
      const peFactorFor = (key: string, label: string): Factor | null => {
        const st = peStatsByKey.get(key);
        if (!st) return null;
        const pts = st.percentile <= 20 ? 1.5 : st.percentile <= 35 ? 0.5 : st.percentile >= 80 ? -1.5 : st.percentile >= 65 ? -0.5 : 0;
        return {
          pts,
          text: `估值看历史 PE 百分位：${label}当前 TTM PE ${st.current} 倍（数据日期 ${st.lastDate}），处在近 5 年${st.cadence} PE 的百分位 ${st.percentile}（样本 ${st.n} 个${st.cadence}点，中位数 ${st.median} 倍；来源：${st.source}）——百分位越低，相对自身历史越便宜`,
          // PE percentile: plain gradient (high = expensive = red end).
          bar: { pct: st.percentile, invert: false },
        };
      };

      // V-11-9: 政金债的估值因子改看收益率百分位（7-10 年政金债收益
      // 率代理 = 中国 10 年国债收益率全历史百分位，与中国国债信号同
      // 一条序列、同一口径），价格百分位不再参与打分。
      const polbondYieldFactor: Factor | null = cn10Stats
        ? {
            pts: cn10Stats.percentile >= 75 ? 1.5 : cn10Stats.percentile >= 60 ? 1 : cn10Stats.percentile >= 40 ? 0 : cn10Stats.percentile >= 25 ? -1 : -1.5,
            text: `估值看收益率：7-10 年政金债收益率代理（中国 10 年国债收益率 ${(yieldsBlock?.cn.find((t) => t.key === "cn10y")?.yieldPct ?? 0).toFixed(2)}%）处在全历史百分位 ${cn10Stats.percentile}（${cn10Stats.label}，样本 ${cn10Stats.count} 天）——收益率百分位越高，对应债券越便宜；政金债收益率无免费序列，此处以同期限国债收益率百分位为代理，不编造政金债利差`,
            // Yield percentile: reversed lens.
            bar: { pct: cn10Stats.percentile, invert: true },
          }
        : null;
      equitySignal("polbond", "国开债等政金债（511520）", "债券",
        ["估值口径已切换：政金债不看 ETF 价格百分位（价格只标位置），改看对应收益率百分位——上方因子用的是 7-10 年政金债收益率代理（中国 10 年国债收益率百分位），与中国国债信号同一口径",
         "政金债相对国债的强弱看它相对 10 年国债 ETF 的相对强弱指标：跑赢 = 政金债更受追捧（政金债相对国债的利差收窄），跑输 = 利差走阔"],
        "政金债和国债是同一条曲线的两个点位：国债收益率百分位读数偏弱时，政金债的方向读数历史上通常同向，两者的差异主要体现在相对利差上。",
        polbondYieldFactor);
      // TLT 同理：估值因子改看美国 30 年国债收益率全历史百分位
      // （TLT 久期 20 年+，30 年期是最接近的已存期限）。
      const us30Pts = all.get("us30y");
      const us30Full = us30Pts ? histStats(us30Pts.map((x) => x.date), us30Pts.map((x) => x.value), undefined, true) : null;
      const tltYieldFactor: Factor | null = us30Full
        ? {
            pts: us30Full.percentile >= 75 ? 1.5 : us30Full.percentile >= 60 ? 1 : us30Full.percentile >= 40 ? 0 : us30Full.percentile >= 25 ? -1 : -1.5,
            text: `估值看收益率：美国 30 年国债收益率处在全历史百分位 ${us30Full.percentile}（${us30Full.label}，样本 ${us30Full.count} 天）——收益率百分位越高，TLT 对应的长债越便宜；TLT 自身的价格百分位只标位置、不参与估值打分`,
            // Yield percentile: reversed lens.
            bar: { pct: us30Full.percentile, invert: true },
          }
        : null;
      equitySignal("tlt", "美债长端（TLT）", "债券",
        [...(yieldsBlock?.us[2]?.stats ? [`对照：美国 10 年国债收益率百分位 ${yieldsBlock.us[2].stats.percentile}（${yieldsBlock.us[2].stats.label}）——美债收益率越高，长债价格越低`] : [])],
        "TLT 久期极长：美债收益率上行 1%，价格大约跌 15% 以上——这是它的波动特征读数，价格摆动幅度远大于短久期债券。",
        tltYieldFactor,
        // 对照 line: US 10Y yield percentile, reversed lens (r6 O1).
        [...(yieldsBlock?.us[2]?.stats ? [{ pct: yieldsBlock.us[2].stats.percentile, invert: true }] : [])]);
      equitySignal("qqq", "QQQ（纳指 100）", "美股",
        ["QQQ 的回撤史在“历史回撤”页：纳指 100 出现过多次 30%+ 级别回撤，买它先想清楚能不能拿得住"],
        "失效条件：连续两根收盘跌破年线且 3 月动量转负，暂停加仓；回撤超过 25% 仍未止跌时，只按计划分批、不主观加倍。");
      equitySignal("voo", "VOO（标普 500）", "美股",
        ["VOO 跟踪标普 500，和 QQQ 的区别是行业更分散、回撤通常比纳指浅——同一笔钱想稳一点选 VOO，想弹性选 QQQ"],
        "失效条件：标普跌破年线且 VIX 冲上 40 后仍在放大，先停新增、等波动率回落。",
        peFactorFor("spx", "标普 500"));
      // U1 美股杠杆：FINRA 保证金负债全历史分位 + 同比（触发条件写死）。
      // 全历史分位只在官方 xlsx 历史已落库时才算；种子（页面 13 个月）
      // 状态下按规格显示「数据不足，暂不评分」，绝不拿短样本冒充全历史。
      {
        const fd = all.get("finra_margin_debt");
        const fullHist = !!fd && fd.length >= 100 && (marginMeta.finraFull || fd.length >= 100);
        let pushed = false;
        if (fd && fullHist) {
          const dts = fd.map((p) => p.date);
          const vls = fd.map((p) => p.value);
          const st = histStats(dts, vls);
          const last = vls[vls.length - 1] ?? 0;
          const yoyBase = vls[vls.length - 13];
          const yoy = yoyBase !== undefined && yoyBase > 0 ? ((last / yoyBase) - 1) * 100 : null;
          if (st && yoy !== null) {
            const hot = st.percentile > 90 && yoy > 20;
            const score = hot ? -3 : st.percentile > 90 ? -2 : st.percentile >= 75 ? -1 : st.percentile <= 25 ? 1 : 0;
            const { tone } = verdictFor(score);
            signals.push({
              key: "usMargin",
              name: "美股杠杆（FINRA 保证金负债）",
              group: "美股",
              verdict: hot ? "杠杆过热参考" : score <= -2 ? "杠杆偏热" : score <= -1 ? "杠杆中高位" : score >= 1 ? "杠杆低位" : "杠杆热度中性",
              tone,
              score,
              headline: `保证金负债 ${(last / 1e6).toFixed(3)} 万亿美元（${(dts[dts.length - 1] ?? "").slice(0, 7)}），处在 ${st.count} 个月全历史百分位 ${st.percentile}，同比 ${yoy >= 0 ? "+" : ""}${yoy.toFixed(1)}%${hot ? "——两条触发线同时越过：杠杆过热参考" : ""}`,
              basis: [
                `触发条件（写死）：保证金负债全历史分位 > 90 且同比 > +20% → 判定「杠杆过热参考」。当前：分位 ${st.percentile}（${st.percentile > 90 ? "已越线" : "未越线"}）、同比 ${yoy >= 0 ? "+" : ""}${yoy.toFixed(1)}%（${yoy > 20 ? "已越线" : "未越线"}）`,
                `全历史区间：最低 ${(st.min / 1e6).toFixed(3)} 万亿美元（${st.minDate.slice(0, 7)}）、最高 ${(st.max / 1e6).toFixed(3)} 万亿美元（${st.maxDate.slice(0, 7)}），中位数 ${(st.median / 1e6).toFixed(3)} 万亿美元`,
                "读法：保证金负债是美股投资者借钱买股的总盘子（FINRA 月度公布，滞后约一个月）。它和标普 500 长期同涨同跌，本身创新高不奇怪；真正的警报是分位极端 + 还在以 20% 以上的同比加速——2000 年与 2007 年的顶部附近都出现过这种组合，之后去杠杆放大了跌幅。",
              ],
              basisBars: [{ pct: st.percentile, invert: false }, null, null],
              headlineBar: { pct: st.percentile, invert: false },
              caution: "失效条件：这是月度慢变量（滞后约一个月），急跌已经发生时它还在报上个月的热度；若保证金负债同比转负且标普已跌破年线，说明去杠杆已在进行，本条的「热度」读数滞后，应视为失效。",
              date: (dts[dts.length - 1] ?? "").slice(0, 7),
              missing: "",
            });
            pushed = true;
          }
        }
        if (!pushed) {
          missingSignal("usMargin", "美股杠杆（FINRA 保证金负债）", "美股",
            `数据不足，暂不评分：FINRA 保证金负债的全历史月度序列（1997 年至今）尚未接入——官方 xlsx 本次未取到，当前只有最近 13 个月页面值（已存 ${fd?.length ?? 0} 个月），样本不足以算全历史分位。后续刷新取到 xlsx 后本条自动开始评分；不拿 13 个月短样本冒充全历史分位。`);
        }
      }
      // FG1 情绪极端：CNN 恐惧与贪婪指数（触发条件写死）。分数 <20
      // （极度恐惧）或 >75（极度贪婪）→ 逆向参考；这是情绪温度计，
      // 不是买卖信号——极端读数可以持续、也可以更极端。
      {
        if (fgMeta) {
          const s = fgMeta.score;
          const fearSide = s < 20;
          const greedSide = s > 75;
          const score = fearSide ? 2 : greedSide ? -2 : s <= 25 ? 1 : s >= 70 ? -1 : 0;
          const { tone } = verdictFor(score);
          const fgStats = fearGreed?.stats ?? null;
          const sortedComps = [...fgMeta.components].sort((a, b) => a.score - b.score);
          const coldest = sortedComps[0];
          const hottest = sortedComps[sortedComps.length - 1];
          signals.push({
            key: "fearGreed",
            name: "情绪极端（CNN 恐惧与贪婪）",
            group: "美股",
            verdict: fearSide ? "极度恐惧 · 逆向参考" : greedSide ? "极度贪婪 · 逆向参考" : score === 1 ? "情绪偏恐惧" : score === -1 ? "情绪偏贪婪" : "情绪中性",
            tone,
            score,
            headline: `恐惧与贪婪指数 ${s.toFixed(1)}（${fgRatingLabel(s)}）${fearSide ? "，已越过 <20 的极端线——按写死规则记「逆向参考」" : greedSide ? "，已越过 >75 的极端线——按写死规则记「逆向参考」" : "，未越过任一极端线"}`,
            basis: [
              `触发条件（写死）：分数 <20（极度恐惧）或 >75（极度贪婪）→ 判定「逆向参考」。当前 ${s.toFixed(1)}（${fearSide ? "已触发极度恐惧一侧" : greedSide ? "已触发极度贪婪一侧" : "未触发"}）`,
              `对照读数：前收 ${fgMeta.prevClose.toFixed(1)}（${fgRatingLabel(fgMeta.prevClose)}）、1 周前 ${fgMeta.prevWeek.toFixed(1)}（${fgRatingLabel(fgMeta.prevWeek)}）、1 月前 ${fgMeta.prevMonth.toFixed(1)}（${fgRatingLabel(fgMeta.prevMonth)}）、1 年前 ${fgMeta.prevYear.toFixed(1)}（${fgRatingLabel(fgMeta.prevYear)}）——看情绪是从哪一档滑到现在这一档的`,
              ...(coldest && hottest
                ? [
                    `7 个分项里最冷的是${FG_COMPONENT_NAMES[coldest.key] ?? coldest.key} ${coldest.score.toFixed(1)} 分、最热的是${FG_COMPONENT_NAMES[hottest.key] ?? hottest.key} ${hottest.score.toFixed(1)} 分——总分是 7 个分项的等权平均，分项越整齐地贴在同一档，情绪读数越可信`,
                  ]
                : []),
              ...(fgStats
                ? [
                    `当前分数处在近 1 年（${fgStats.count} 个交易日，CNN 端点历史只有 1 年）百分位 ${fgStats.percentile}；近 1 年区间 ${fgStats.min.toFixed(1)}（${fgStats.minDate}）～${fgStats.max.toFixed(1)}（${fgStats.maxDate}），中位数 ${fgStats.median.toFixed(1)}`,
                  ]
                : []),
              "读法：这是逆向指标——极端恐惧之后市场常有反弹、极端贪婪之后常有回调，统计上赔率向逆向一侧倾斜；但它测的是情绪不是价值，极端区间的赔率改善不等于时点已到。",
            ],
            basisBars: [null, null, ...(coldest && hottest ? [null] : []), ...(fgStats ? [{ pct: fgStats.percentile, invert: false }] : []), null],
            headlineBar: fgStats ? { pct: fgStats.percentile, invert: false } : null,
            caution: "失效条件：情绪极端不等于见底或见顶——极端恐惧可以更恐惧（本指数一年前读数 5.17，之后并未立刻反转），在极端区停留数周并不罕见。本条只作仓位节奏的逆向参考，不是买卖信号；分数回到 20–75 区间后本条自动回到中性。",
            date: fearGreed?.dateBj ?? "",
            missing: "",
          });
        } else {
          missingSignal("fearGreed", "情绪极端（CNN 恐惧与贪婪）", "美股",
            "数据不足，暂不评分：CNN 恐惧与贪婪指数尚未拉取入库。点右上角「刷新数据」全量刷新会一并更新这一分块；若这一分块刷新失败，可在刷新面板里点「只重试未完全成功的块」单独重试它。拉到后本条自动开始评分；不拿旧截图或猜测代替。");
        }
      }
      equitySignal("schd", "美股红利质量（SCHD）", "美股红利",
        ["SCHD 的选股先看现金流和分红质量再看股息率，历史上回撤比大盘浅、恢复也稳，是红利里偏“质量”的那一只"],
        "红利策略的代价是牛市跑输成长股：若相对强弱连续两个季度垫底且股息率优势消失，再评估是否换仓。");
      equitySignal("spyd", "美股高息（SPYD）", "美股红利",
        ["SPYD 是等权挑最高息的 80 只，股息率最高但成分里周期股多，熊市回撤并不比大盘浅——高息不等于低风险"],
        "买 SPYD 前先看它的回撤史（历史回撤页有）：跌幅和大盘相当，靠的是股息率补偿，不是靠跌得少。");
      equitySignal("sec_divlow", "A股红利低波（512890）", "A股红利",
        ["红利低波 = 高股息 + 低波动双筛选，是 A 股里回撤控制最有代表性的一只；股债跷跷板里它常扮演“类债”角色"],
        "红利低波要盯的是股息率本身：价格涨得太快会把股息率摊薄、防御性打折——判断贵便宜主看上方的历史 PE 百分位因子（跟踪指数口径），并与股息率、股债性价比利差（A 股页 ERP 代理卡）对照；价格百分位只标位置、不作估值依据。",
        peFactorFor("sec_divlow", "红利低波（512890 跟踪的中证红利低波动指数）"));
      equitySignal("csi300", "沪深 300（510300）", "A股",
        ["和债券页的 10 年国债收益率对照看：利率下行期，沪深 300 的估值通常有支撑（股债跷跷板）"],
        "失效条件：跌破年线且红利/银行等防御板块同步走弱，说明是系统性risk-off，先观望。",
        peFactorFor("csi300", "沪深300指数"));
      // A1 杠杆热度：融资余额近 5 年分位 + 近 20 日增速（触发条件写死）。
      // 分位与 A股页融资余额小节的 statsFull 共用同一 5 年切片口径；
      // 回补样本不足时显示「数据不足，暂不评分」，不编分位。
      {
        const mt = all.get("margin_total");
        let pushed = false;
        if (mt && mt.length >= 250 && marginCn) {
          const s5 = slice5y(
            mt.map((p) => p.date),
            mt.map((p) => p.value),
          );
          const st = histStats(s5.d, s5.v);
          const chg20 = marginCn.chg20Pct;
          if (st && chg20 !== null) {
            const hot = st.percentile > 90 && chg20 > 5;
            const score = hot ? -3 : st.percentile > 90 ? -2 : st.percentile >= 75 ? -1 : st.percentile <= 25 ? 1 : 0;
            const { tone } = verdictFor(score);
            signals.push({
              key: "marginHeat",
              name: "A股杠杆热度（融资余额）",
              group: "A股",
              verdict: hot ? "杠杆过热参考" : score <= -2 ? "杠杆偏热" : score <= -1 ? "杠杆中高位" : score >= 1 ? "杠杆低位" : "杠杆热度中性",
              tone,
              score,
              headline: `融资余额 ${marginCn.totalYi.toLocaleString("zh-CN")} 亿元，处在近 5 年（${st.count} 个交易日）百分位 ${st.percentile}，近 20 个交易日 ${chg20 >= 0 ? "+" : ""}${chg20.toFixed(1)}%${hot ? "——两条触发线同时越过：杠杆过热参考" : ""}`,
              basis: [
                `触发条件（写死）：融资余额 5 年分位 > 90 且近 20 个交易日涨幅 > 5% → 判定「杠杆过热参考」。当前：分位 ${st.percentile}（${st.percentile > 90 ? "已越线" : "未越线"}）、近 20 日 ${chg20 >= 0 ? "+" : ""}${chg20.toFixed(1)}%（${chg20 > 5 ? "已越线" : "未越线"}）`,
                `近 5 年区间：最低 ${st.min.toLocaleString("zh-CN")} 亿元（${st.minDate}）、最高 ${st.max.toLocaleString("zh-CN")} 亿元（${st.maxDate}），中位数 ${st.median.toLocaleString("zh-CN")} 亿元；当前距区间高点 ${marginCn.distHighPct.toFixed(1)}%`,
                "读法：融资余额是借钱买股的总盘子。分位冲到极端且还在加速，说明杠杆资金在追涨——这种位置一旦行情反转，去杠杆的踩踏会放大跌幅（2015 年的教训）；分位低且增速温和时，杠杆不是风险源。存量方向再对照下一条「杠杆资金流向」看。",
              ],
              basisBars: [{ pct: st.percentile, invert: false }, null, null],
              headlineBar: { pct: st.percentile, invert: false },
              caution: "失效条件：分位与增速都是慢变量；若融资余额单周骤降超过 5%（强制平仓式去杠杆），说明踩踏已经在发生、本条读数滞后，应视为失效，改看融资净买入的连续为负天数。",
              date: marginCn.date,
              missing: "",
            });
            pushed = true;
          }
        }
        if (!pushed) {
          missingSignal("marginHeat", "A股杠杆热度（融资余额）", "A股",
            `数据不足，暂不评分：融资余额（沪+深合计）日度序列目前 ${mt?.length ?? 0} 个交易日，算近 5 年分位需要约 5 年（1200+ 个交易日）的回补样本。回补由「融资余额与保证金负债」刷新分块从上交所官网与深市披露分段拉取，样本到位后本条自动开始评分；不拿短样本编分位。`);
        }
      }
      // A2 杠杆资金流向：融资净买入连续为负天数（触发条件写死）。
      {
        const net = all.get("margin_total_net");
        let pushed = false;
        if (net && net.length >= 20) {
          let streak = 0;
          for (let i = net.length - 1; i >= 0; i--) {
            if ((net[i]?.value ?? 0) < 0) streak++;
            else break;
          }
          const last5 = net.slice(-5);
          const sum5 = last5.reduce((s, p) => s + p.value, 0);
          const lastNet = net[net.length - 1]?.value ?? 0;
          const triggered = streak >= 5;
          const score = triggered ? -2 : streak >= 3 ? -1 : sum5 > 0 ? 0.5 : 0;
          const { tone } = verdictFor(score);
          signals.push({
            key: "marginFlow",
            name: "A股杠杆资金流向（融资净买入）",
            group: "A股",
            verdict: triggered ? "杠杆资金撤退参考" : streak >= 3 ? "杠杆资金偏弱" : sum5 > 0 ? "杠杆资金在流入" : "杠杆资金流向中性",
            tone,
            score,
            headline: triggered
              ? `融资净买入已连续 ${streak} 个交易日为负——杠杆资金在撤退（参考）`
              : `融资净买入最近一日 ${lastNet >= 0 ? "+" : ""}${lastNet.toFixed(1)} 亿元，近 5 个交易日合计 ${sum5 >= 0 ? "+" : ""}${sum5.toFixed(1)} 亿元，当前连续为负 ${streak} 天`,
            basis: [
              `触发条件（写死）：融资净买入（融资买入额 − 融资偿还额，沪+深合计）连续 5 个交易日为负 → 判定「杠杆资金撤退参考」。当前连续为负 ${streak} 天（${triggered ? "已触发" : "未触发"}）`,
              `最近 5 个交易日净买入（亿元）：${last5.map((p) => `${p.date.slice(5)} ${p.value >= 0 ? "+" : ""}${p.value.toFixed(1)}`).join("、")}`,
              "读法：净买入看的是杠杆资金的方向，不是存量。存量高但还在流入，与存量高且连续流出，风险完全不同；连续 5 天为负说明不是单日噪声，是趋势性的偿还大于买入。",
            ],
            basisBars: [null, null, null],
            headlineBar: null,
            caution: "失效条件：长假前后与季末的资金面扰动会让净买入短暂转负；若连续为负但融资余额存量不降，多半是换仓而非撤退，本条读数要打折看。",
            date: net[net.length - 1]?.date ?? "",
            missing: "",
          });
          pushed = true;
        }
        if (!pushed) {
          missingSignal("marginFlow", "A股杠杆资金流向（融资净买入）", "A股",
            `数据不足，暂不评分：融资净买入（沪+深合计）序列目前 ${net?.length ?? 0} 个交易日，需要至少 20 个交易日才能数连续为负的天数。「融资余额与保证金负债」刷新分块回补到位后本条自动开始评分。`);
        }
      }
      equitySignal("gold", "黄金", "贵金属",
        ["黄金不看“估值”：它没有现金流、没有市盈率，价格百分位只标价格在历史中的位置（趋势 / 回撤含义），不当贵便宜尺度——本条只按距高点回撤、年线趋势、RSI 与动量打分，实际利率交叉验证见下方"],
        "金价与美债实际利率长期负相关：若美债收益率快速上行且金银比同步回落，金价的顺风就停了。");

      // 华尔街信用信号：HY 利差（风险胃口的总开关）
      {
        const hy = fred.find((f) => f.key === "hySpread");
        if (hy) {
          const v = hy.value;
          const score = v >= 6 ? 2 : v >= 4.5 ? 1 : v >= 3 ? 0 : v >= 2.5 ? -1 : -2;
          const { verdict, tone } = verdictFor(score);
          signals.push({
            key: "hyCredit",
            name: "美股风险胃口（HY 信用利差）",
            group: "华尔街",
            verdict,
            tone,
            score,
            headline: `HY 利差 ${v.toFixed(2)}%，当前统计窗口百分位 ${hy.stats?.percentile ?? "—"}：${score >= 1 ? "利差偏宽，信用市场在给风险资产打折" : score <= -1 ? "利差极窄，市场在抢风险、补偿很薄——顺风但别追高" : "利差在正常区间，信用环境中性"}`,
            basis: [
              `HY 利差 ${v.toFixed(2)}%（当前统计窗口区间 ${hy.stats?.min.toFixed(2)}%～${hy.stats?.max.toFixed(2)}%，中位数 ${hy.stats?.median.toFixed(2)}%）`,
              "读法和收益率相同、和价格相反：利差越宽 = 垃圾债越被嫌弃 = 风险资产越便宜；利差越窄 = 市场越亢奋、信用债越贵。这个指标历史上比股市先见顶、也常先见底",
              ...(derived.find((d) => d.key === "vixTerm")
                ? [`VIX 期限结构差 ${derived.find((d) => d.key === "vixTerm")?.value.toFixed(2)} 点：${(derived.find((d) => d.key === "vixTerm")?.value ?? 0) > 0 ? "已倒挂，近端恐慌未退" : "正向结构，恐慌未失控"}`]
                : []),
            ],
            basisBars: [null, null, ...(derived.find((d) => d.key === "vixTerm") ? [null] : [])],
            headlineBar: null,
            caution: "利差单周走阔超过 0.5 个百分点是独立的报警信号，无论当时分数如何，先停新增风险仓位、等利差企稳。",
            date: hy.date,
            missing: "",
          });
        } else {
          // FRED-only series that feed this layer of the page; name the
          // ones that are also absent so the reason matches what the
          // 华尔街 page's gap note says (same stored data, same read).
          const fredOnlyNames: [string, string][] = [
            ["igSpread", "IG 投资级利差"],
            ["corpProfits", "企业利润"],
            ["broadUsd", "广义美元指数"],
          ];
          const alsoMissing = fredOnlyNames
            .filter(([k]) => !fred.some((f) => f.key === k))
            .map(([, n]) => n);
          missingSignal("hyCredit", "美股风险胃口（HY 信用利差）", "华尔街",
            `缺什么：HY 信用利差（FRED 序列 BAMLH0A0HYM2，ICE 美银高收益债 OAS）——它是私有指数，FRED 是唯一的免费分发渠道，没有官方替代源，本台不拿估算或代理值冒充它${alsoMissing.length ? `；同一批没拉到的还有 ${alsoMissing.join("、")}，同为 FRED 独占序列` : ""}。为什么缺：FRED API 本次未返回（逐条失败原因见总览的刷新状态与华尔街页的缺口说明）。怎么恢复：不用做任何事——下一次刷新（全量刷新；失败分块用「只重试未完全成功的块」重试）只要 FRED 通了，本条自动恢复成正常信号。数据缺失期间，风险胃口可先看华尔街页的 HYG/IEF 市场代理卡（已明确标注为代理、非官方利差）。`);
        }
        // Gold cross-check with the real rate. When the real rate is
        // absent (Treasury curve + FRED both unreachable, so no card
        // was built), the cross-check must not vanish silently: the
        // gold signal carries an explicit 未执行 basis line naming the
        // gap, with the last stored value as background when one
        // exists (stale values are labelled, never scored).
        const real = fred.find((f) => f.key === "realRate");
        const goldSig = signals.find((s) => s.key === "gold");
        if (real && goldSig && !goldSig.missing) {
          goldSig.basis.push(
            `交叉验证：美国 10 年实际利率 ${real.value.toFixed(2)}%（当前统计窗口百分位 ${real.stats?.percentile ?? "—"}）——实际利率越高，金价的逆风越强；若实际利率见顶回落，金价的顺风才真正回来`,
          );
          // Real-rate percentile: reversed lens like yields (r6 O1).
          // Null when the text itself prints "—" (no stats).
          goldSig.basisBars.push(real.stats ? { pct: real.stats.percentile, invert: true } : null);
        } else if (goldSig && !goldSig.missing) {
          goldSig.basis.push(
            realRateLast
              ? `交叉验证未执行：本次无实际利率数据，交叉验证未执行——美国 10 年实际利率卡本次未生成（美国财政部官网实际收益率曲线与 FRED 两路本次均未拉到新数据），本条黄金信号只按金价本身的回撤、趋势与动量打分（价格百分位只标位置、不作估值因子），没有纳入实际利率的逆风/顺风核对。库中最后成功落库的实际利率为 ${realRateLast.value.toFixed(2)}%（最后成功日期 ${realRateLast.date}），已不是本次数据、只作背景参考，不计入本次交叉验证；下一次华尔街分块刷新成功后交叉验证自动恢复`
              : `交叉验证未执行：本次无实际利率数据，交叉验证未执行——美国 10 年实际利率（美国财政部官网每日实际收益率曲线 / FRED 的 DFII10）至今没有成功落库记录，本条黄金信号只按金价本身的回撤、趋势与动量打分（价格百分位只标位置、不作估值因子），没有纳入实际利率的逆风/顺风核对；华尔街分块刷新成功拉到实际利率后，交叉验证自动恢复`,
          );
          goldSig.basisBars.push(null);
        }
        // Style signal: which side of the A-share seesaw is winning
        const sdg = style.find((s) => s.key === "styleDivGrowth");
        if (sdg) {
          signals.push({
            key: "styleCN",
            name: "A股风格提示（红利 vs 成长）",
            group: "A股风格",
            verdict: sdg.value >= 3 ? "红利占优延续" : sdg.value <= -3 ? "成长占优延续" : "风格均衡",
            tone: "hold",
            score: Math.round(Math.max(-2, Math.min(2, sdg.value / 4)) * 10) / 10,
            headline: `近 3 月红利低波相对创业板 ${sdg.value >= 0 ? "+" : ""}${sdg.value.toFixed(1)}%（当前统计窗口百分位 ${sdg.stats?.percentile ?? "—"}）：${sdg.value >= 3 ? "防御风格占上风，市场在避险" : sdg.value <= -3 ? "成长风格占上风，风险偏好在扩张" : "两种风格拉锯，没有明确主线"}`,
            basis: [
              "风格信号不是买卖信号，是“往哪边配”的提示：占优的一方趋势更顺，但百分位冲到极端（>90 或 <10）时，跷跷板反转的风险在累积",
              `小盘 vs 大盘：${style.find((s) => s.key === "styleSmallLarge")?.state ?? "—"}`,
            ],
            basisBars: [null, null],
            // Headline's relative-strength percentile: plain gradient,
            // position only (no cheap/expensive wording), same stats
            // value the headline text prints (r6 O1, item 13).
            headlineBar: sdg.stats ? { pct: sdg.stats.percentile, invert: false } : null,
            caution: "风格切换的确认要看相对强弱连续两周同向；单周异动多是事件驱动，别急着全仓换风格。",
            date: sdg.date,
            missing: "",
          });
        } else {
          missingSignal("styleCN", "A股风格提示（红利 vs 成长）", "A股风格",
            "缺什么：红利低波相对创业板的相对强弱序列本次没有算出来（需要红利低波与创业板两只 ETF 的价格序列，本次刷新至少有一只没取到）。为什么缺：多为行情接口临时失败。怎么恢复：不用做任何事——下一次刷新（点右上角「刷新数据」全量刷新；若刷新后仍有未完全成功的分块，在刷新面板里点「只重试未完全成功的块」，把所有失败分块一起重试）数据齐了，本条自动恢复成正常信号。");
        }
      }

      // 股债相关性信号：直接读组合页相关矩阵里的标普 500 × TLT 这一格——
      // 与组合页同一口径（近 252 个交易日、共同交易日对齐的日对数收益
      // Pearson 相关）、同一个数，信号页不另算一套。组合页只有矩阵和
      // 一句读法提示，这里把它落成带触发/失效条件的打分信号。
      {
        const sbPair = portfolio.correlations.find(
          (c) => (c.a === "spx" && c.b === "tlt") || (c.a === "tlt" && c.b === "spx"),
        );
        const cnPair = portfolio.correlations.find(
          (c) => (c.a === "csi300" && c.b === "bond10y") || (c.a === "bond10y" && c.b === "csi300"),
        );
        if (sbPair) {
          const v = sbPair.v;
          const score = v <= -0.25 ? 2 : v <= -0.1 ? 1 : v < 0.1 ? 0 : v < 0.3 ? -1 : -2;
          const verdict = v <= -0.1 ? "股债跷跷板有效" : v >= 0.1 ? "股债同向 · 分散打折" : "股债关系中性";
          const tone: "buy" | "add" | "hold" | "reduce" | "avoid" = v <= -0.1 ? "add" : v >= 0.3 ? "reduce" : "hold";
          signals.push({
            key: "stockBondCorr",
            name: "股债相关性（标普 500 vs 美债 TLT）",
            group: "组合",
            verdict,
            tone,
            score,
            headline: `股债相关系数 ${v}：${v <= -0.1 ? "负相关——股跌的时候债能接住一部分，60/40 这类股债搭配的分散保护现在是有效的" : v >= 0.1 ? "正相关——股和债同涨同跌，是 2022 年式“股债双杀”的环境特征，股债搭配的分散保护正在打折" : "接近 0——股债各走各的，分散仍然有效，只是没有跷跷板那种一跌一涨的对冲增益"}`,
            basis: [
              "口径：标普 500 与 TLT 近 252 个交易日的日对数收益、按共同交易日对齐算 Pearson 相关系数——就是组合页“相关性矩阵 · 近 1 年日收益”里的同一格、同一个数，本条不另算一套",
              "触发条件：相关系数 ≤ −0.2 判定“跷跷板有效”（债对股的对冲成立，股债搭配按原比例即可）；≥ +0.2 判定“股债同向”（通胀主导环境，分散保护失效，要靠现金和黄金补分散）；−0.2～+0.2 之间是过渡区，只提示、不下结论",
              ...(cnPair ? [`A 股口径对照（同一矩阵）：沪深 300 与中国国债相关系数 ${cnPair.v}——${cnPair.v <= -0.1 ? "同为负相关，A 股这边的股债跷跷板也在起作用" : cnPair.v >= 0.1 ? "为正相关，A 股股债同向的程度比美股这边更明显" : "接近 0，A 股股债基本各走各的"}`] : []),
            ],
            basisBars: [null, null, ...(cnPair ? [null] : [])],
            headlineBar: null,
            caution: "失效条件：这是 252 日滚动的慢变量，环境切换时转身慢——若 CPI 连续超预期、美债收益率快速上行而本条仍显示负相关，说明读数滞后于通胀冲击，应视为失效，等滚动窗口把新环境算进来；另外它只刻画平常日子的线性同涨同跌，暴跌日里债到底接不接得住，要另看组合页模拟组合的历史回撤。",
            date: byKey.get("spx")?.date ?? byKey.get("tlt")?.date ?? "",
            missing: "",
          });
        } else {
          missingSignal("stockBondCorr", "股债相关性（标普 500 vs 美债 TLT）", "组合",
            "缺什么：组合页相关性矩阵里标普 500 × TLT 这一格本次没有算出来（需要两条序列近 1 年的日收益有至少 60 个共同交易日，本次刷新至少有一条没取到或历史太短）。为什么缺：多为行情接口临时失败。怎么恢复：不用做任何事——下一次刷新（点右上角「刷新数据」全量刷新；若刷新后仍有未完全成功的分块，在刷新面板里点「只重试未完全成功的块」，把所有失败分块一起重试）数据齐了，相关矩阵和本条信号会一起恢复。");
        }
      }

      // ---- 抄底逃顶指数 (v120, 2026-11-22): 10 bottom + 10 top
      // contrarian signals, computed from stored series only — no
      // external fetch at read time. Each side's score = triggered
      // share of its AVAILABLE signals (×100, rounded); composite =
      // top − bottom (−100..100); ≤ −50 抄底区 / ≥ +30 逃顶区 (v121
      // backtest-calibrated). A
      // signal whose source is unreachable (B9/T7 AAII, T10 breadth),
      // whose percentile is still accumulating (T4 forward PE), or
      // whose latest point is stale (>5 SPX trading days behind the
      // newest stored SPX close — the slow FINRA-monthly and
      // forward-PE series are exempt, their cadence IS the lag) is
      // value/triggered = null and leaves both numerator and
      // denominator: an old reading is never dressed up as today's.
      let bottomTop: DashboardPayload["bottomTop"] = null;
      {
        type BtBlock = NonNullable<DashboardPayload["bottomTop"]>;
        type BtSignal = BtBlock["signals"][number];
        const btSignals: BtSignal[] = [];
        const spxPts = all.get("spx") ?? [];
        const refDate = spxPts.length ? (spxPts[spxPts.length - 1]?.date ?? "") : "";
        const staleDaily = (date: string): boolean => {
          if (!date || !refDate) return true;
          if (date >= refDate) return false;
          let behind = 0;
          for (let i = spxPts.length - 1; i >= 0; i--) {
            if ((spxPts[i]?.date ?? "") <= date) return behind > 5;
            behind++;
          }
          return true;
        };
        const lastPt = (k: string): Pt | undefined => {
          const a = all.get(k);
          return a && a.length > 0 ? a[a.length - 1] : undefined;
        };
        const num2 = (v: number): string =>
          v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const pct2 = (v: number): string => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
        // 200-day mean + deviation from the stored closes (the §1
        // definition: arithmetic mean of the last 200 closes incl.
        // today; deviation = close / mean − 1).
        const maDevOf = (k: string): { close: number; ma: number; devPct: number; date: string } | null => {
          const a = all.get(k);
          if (!a || a.length < 200) return null;
          let sum = 0;
          for (let i = a.length - 200; i < a.length; i++) sum += a[i]?.value ?? 0;
          const ma = sum / 200;
          const last = a[a.length - 1];
          if (!last || !(ma > 0)) return null;
          return { close: last.value, ma, devPct: Math.round(((last.value / ma) - 1) * 10000) / 100, date: last.date };
        };
        const ndxDevRaw = maDevOf("ndx");
        const dxyDevRaw = maDevOf("dxy");
        const ndxDev = ndxDevRaw && !staleDaily(ndxDevRaw.date) ? ndxDevRaw : null;
        const dxyDev = dxyDevRaw && !staleDaily(dxyDevRaw.date) ? dxyDevRaw : null;
        const vixPt = lastPt("vix");
        const vixOk = vixPt && !staleDaily(vixPt.date) ? vixPt : undefined;
        const pcrPt = lastPt("cboe_total_pcr");
        const pcrOk = pcrPt && !staleDaily(pcrPt.date) ? pcrPt : undefined;
        const hyPt = lastPt("fredhy");
        const hyOk = hyPt && !staleDaily(hyPt.date) ? hyPt : undefined;
        const fgSeriesLast = lastPt("fear_greed_cnn");
        const fgOk = fearGreed && fgSeriesLast && !staleDaily(fgSeriesLast.date) ? fearGreed : null;
        const spxCloses = spxPts.map((p) => p.value);
        const spxRsiArr = rsiSeries(spxCloses);
        const spxRsiLast = spxRsiArr.length ? (spxRsiArr[spxRsiArr.length - 1] ?? null) : null;
        let spxDd: { ddPct: number; high: number; highDate: string } | null = null;
        if (spxPts.length >= 2) {
          let hi = -Infinity;
          let hiD = "";
          for (const p of spxPts.slice(-252)) {
            if (p.value > hi) {
              hi = p.value;
              hiD = p.date;
            }
          }
          const last = spxPts[spxPts.length - 1];
          if (last && hi > 0) spxDd = { ddPct: Math.round(((last.value / hi) - 1) * 10000) / 100, high: hi, highDate: hiD };
        }
        const push = (
          id: string,
          side: "bottom" | "top",
          name: string,
          value: number | null,
          valueText: string,
          threshold: string,
          triggered: boolean | null,
          pct: number | null,
          date: string,
          source: string,
        ) => {
          btSignals.push({ id, side, name, value, valueText, threshold, triggered, pct, date, source });
        };
        const NO_DATA = "暂无数据";
        // ---- Bottom side (B1–B10) ----
        push("B1", "bottom", "VIX 恐慌指数",
          vixOk ? Math.round(vixOk.value * 100) / 100 : null,
          vixOk ? num2(vixOk.value) : NO_DATA,
          "≥ 28", vixOk ? vixOk.value >= 28 : null, null, vixOk?.date ?? "",
          "CBOE VIX（Yahoo ^VIX 日线）");
        push("B2", "bottom", "纳指 100 在 200 日均线上方",
          ndxDev ? ndxDev.devPct : null,
          ndxDev ? `收盘 ${num2(ndxDev.close)} · 均线 ${num2(ndxDev.ma)}（${pct2(ndxDev.devPct)}）` : NO_DATA,
          "收盘 > 200 日均线", ndxDev ? ndxDev.close > ndxDev.ma : null, null, ndxDev?.date ?? "",
          "纳斯达克 100（Yahoo ^NDX 日线）自算");
        push("B3", "bottom", "美元指数在 200 日均线下方",
          dxyDev ? dxyDev.devPct : null,
          dxyDev ? `收盘 ${num2(dxyDev.close)} · 均线 ${num2(dxyDev.ma)}（${pct2(dxyDev.devPct)}）` : NO_DATA,
          "收盘 < 200 日均线", dxyDev ? dxyDev.close < dxyDev.ma : null, null, dxyDev?.date ?? "",
          "美元指数（Yahoo DX-Y.NYB 日线）自算");
        push("B4", "bottom", "恐惧与贪婪指数（CNN）",
          fgOk ? Math.round(fgOk.score * 10) / 10 : null,
          fgOk ? `${fgOk.score.toFixed(1)}（${fgRatingLabel(fgOk.score)}）` : NO_DATA,
          "< 20（极度恐惧）", fgOk ? fgOk.score < 20 : null, null, fgOk?.dateBj ?? "",
          "CNN Fear & Greed Index");
        push("B5", "bottom", "标普 500 RSI(14)",
          spxRsiLast != null ? Math.round(spxRsiLast * 100) / 100 : null,
          spxRsiLast != null ? spxRsiLast.toFixed(2) : NO_DATA,
          "< 30（超卖）", spxRsiLast != null ? spxRsiLast < 30 : null, null, refDate,
          "标普 500（Yahoo ^GSPC 日线）自算 RSI(14)");
        push("B6", "bottom", "标普 500 距 52 周高点回撤",
          spxDd ? spxDd.ddPct : null,
          spxDd ? `${pct2(spxDd.ddPct)}（高点 ${num2(spxDd.high)}，${spxDd.highDate}）` : NO_DATA,
          "回撤 ≥ 10%", spxDd ? spxDd.ddPct <= -10 : null, null, refDate,
          "标普 500（Yahoo ^GSPC 日线）自算");
        push("B7", "bottom", "期权总 Put/Call 比率",
          pcrOk ? pcrOk.value : null,
          pcrOk ? pcrOk.value.toFixed(2) : NO_DATA,
          "> 1.1", pcrOk ? pcrOk.value > 1.1 : null, null, pcrOk?.date ?? "",
          "CBOE 每日期权统计（官方）");
        push("B8", "bottom", "高收益债利差（HY OAS）",
          hyOk ? hyOk.value : null,
          hyOk ? `${hyOk.value.toFixed(2)}%` : NO_DATA,
          "> 4.0%", hyOk ? hyOk.value > 4 : null, null, hyOk?.date ?? "",
          "FRED ICE BofA 美国高收益 OAS");
        push("B9", "bottom", "AAII 个人投资者看多比例",
          null, NO_DATA, "< 25%", null, null, "",
          "AAII 情绪调查（官网机器人验证，暂无可用数据源）");
        push("B10", "bottom", "纳指 100 距 200 日均线（超卖侧）",
          ndxDev ? ndxDev.devPct : null,
          ndxDev ? pct2(ndxDev.devPct) : NO_DATA,
          "< −5%", ndxDev ? ndxDev.devPct < -5 : null, null, ndxDev?.date ?? "",
          "纳斯达克 100（Yahoo ^NDX 日线）自算");
        // ---- Top side (T1–T10) ----
        push("T1", "top", "恐惧与贪婪指数（CNN）",
          fgOk ? Math.round(fgOk.score * 10) / 10 : null,
          fgOk ? `${fgOk.score.toFixed(1)}（${fgRatingLabel(fgOk.score)}）` : NO_DATA,
          "> 75（极度贪婪）", fgOk ? fgOk.score > 75 : null, null, fgOk?.dateBj ?? "",
          "CNN Fear & Greed Index");
        push("T2", "top", "VIX 恐慌指数",
          vixOk ? Math.round(vixOk.value * 100) / 100 : null,
          vixOk ? num2(vixOk.value) : NO_DATA,
          "< 13", vixOk ? vixOk.value < 13 : null, null, vixOk?.date ?? "",
          "CBOE VIX（Yahoo ^VIX 日线）");
        push("T3", "top", "标普 500 RSI(14)",
          spxRsiLast != null ? Math.round(spxRsiLast * 100) / 100 : null,
          spxRsiLast != null ? spxRsiLast.toFixed(2) : NO_DATA,
          "> 70（超买）", spxRsiLast != null ? spxRsiLast > 70 : null, null, refDate,
          "标普 500（Yahoo ^GSPC 日线）自算 RSI(14)");
        const fwdSpx = byKey.get("spx")?.fwdPe ?? null;
        if (fwdSpx && fwdSpx.percentile != null) {
          push("T4", "top", "标普前瞻 PE 历史百分位",
            fwdSpx.percentile, `百分位 ${fwdSpx.percentile}（前瞻 PE ${fwdSpx.value}×）`,
            "> 80", fwdSpx.percentile > 80, fwdSpx.percentile, fwdSpx.date, fwdSpx.source);
        } else if (fwdSpx) {
          push("T4", "top", "标普前瞻 PE 历史百分位",
            null, `前瞻 PE ${fwdSpx.value}×；百分位积累中（已记录 ${fwdSpx.n} 期，满 8 期起算）`,
            "> 80", null, null, fwdSpx.date, fwdSpx.source);
        } else {
          push("T4", "top", "标普前瞻 PE 历史百分位",
            null, NO_DATA, "> 80", null, null, "", "FactSet Earnings Insight（手工积累）");
        }
        const muPct = marginUs?.stats?.percentile ?? null;
        push("T5", "top", "FINRA 保证金负债历史百分位",
          muPct,
          marginUs && muPct != null
            ? `全历史百分位 ${muPct}（负债 $${(marginUs.debtM / 1e6).toFixed(2)} 万亿，${marginUs.month}）`
            : NO_DATA,
          "> 95", muPct != null ? muPct > 95 : null, muPct, marginUs?.month ?? "",
          "FINRA Margin Statistics（月度）");
        push("T6", "top", "期权总 Put/Call 比率",
          pcrOk ? pcrOk.value : null,
          pcrOk ? pcrOk.value.toFixed(2) : NO_DATA,
          "< 0.75", pcrOk ? pcrOk.value < 0.75 : null, null, pcrOk?.date ?? "",
          "CBOE 每日期权统计（官方）");
        push("T7", "top", "AAII 个人投资者看多比例",
          null, NO_DATA, "> 50%", null, null, "",
          "AAII 情绪调查（官网机器人验证，暂无可用数据源）");
        push("T8", "top", "纳指 100 距 200 日均线（过热侧）",
          ndxDev ? ndxDev.devPct : null,
          ndxDev ? pct2(ndxDev.devPct) : NO_DATA,
          "> +20%", ndxDev ? ndxDev.devPct > 20 : null, null, ndxDev?.date ?? "",
          "纳斯达克 100（Yahoo ^NDX 日线）自算");
        push("T9", "top", "高收益债利差（HY OAS）",
          hyOk ? hyOk.value : null,
          hyOk ? `${hyOk.value.toFixed(2)}%` : NO_DATA,
          "< 3.0%", hyOk ? hyOk.value < 3 : null, null, hyOk?.date ?? "",
          "FRED ICE BofA 美国高收益 OAS");
        push("T10", "top", "标普成分股高于 50 日均线比例",
          null, NO_DATA, "> 85%", null, null, "",
          "成分股宽度（StockCharts $SPXA50R，无公开 API）");
        // ---- Scores ----
        const bAvail = btSignals.filter((s) => s.side === "bottom" && s.triggered !== null);
        const tAvail = btSignals.filter((s) => s.side === "top" && s.triggered !== null);
        const bTrig = bAvail.filter((s) => s.triggered).length;
        const tTrig = tAvail.filter((s) => s.triggered).length;
        const bottomScore = bAvail.length > 0 ? Math.round((100 * bTrig) / bAvail.length) : null;
        const topScore = tAvail.length > 0 ? Math.round((100 * tTrig) / tAvail.length) : null;
        const composite = bottomScore !== null && topScore !== null ? topScore - bottomScore : null;
        const zone: "bottom" | "neutral" | "top" | null =
          composite === null ? null : composite <= -50 ? "bottom" : composite >= 30 ? "top" : "neutral";
        // asOf = the newest stored SPX close — the trading day this
        // composite is computed "as of". Slower series (FRED HY lags
        // a day by publication design; FINRA is monthly; forward PE
        // is edition-dated) carry their own dates in their rows, so
        // they never drag the headline date backwards.
        const asOf = refDate;
        const trigOf = (id: string): boolean => btSignals.find((s) => s.id === id)?.triggered === true;
        // ---- History: trailing ~2 years, day-by-day recomputation
        // over the 11 daily-recomputable signals ONLY (B1/B2/B3/B5/
        // B6/B8/B10 + T2/T3/T8/T9). Series align by an as-of pointer
        // over each series' own dates (FRED HY publishes on business
        // days, the price series on trading days; NDX/DXY index by
        // exact date since all three share the US trading calendar).
        const hist: BtBlock["history"] = [];
        const entries: BtBlock["entries"] = [];
        {
          const ndxPts = all.get("ndx") ?? [];
          const dxyPts = all.get("dxy") ?? [];
          const vixPts = all.get("vix") ?? [];
          const hyPts = all.get("fredhy") ?? [];
          if (spxPts.length >= 260 && ndxPts.length >= 200 && dxyPts.length >= 200 && refDate) {
            const ndxCloses = ndxPts.map((p) => p.value);
            const dxyCloses = dxyPts.map((p) => p.value);
            const ndxMaArr = smaSeries(ndxCloses, 200);
            const dxyMaArr = smaSeries(dxyCloses, 200);
            const ndxIdxByDate = new Map(ndxPts.map((p, i) => [p.date, i]));
            const dxyIdxByDate = new Map(dxyPts.map((p, i) => [p.date, i]));
            const asofVal = (pts: Pt[], date: string): number | null => {
              let lo = 0;
              let hi = pts.length - 1;
              let ans = -1;
              while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if ((pts[mid]?.date ?? "") <= date) {
                  ans = mid;
                  lo = mid + 1;
                } else {
                  hi = mid - 1;
                }
              }
              return ans >= 0 ? (pts[ans]?.value ?? null) : null;
            };
            const startDate = shiftDateStr(refDate, -731);
            let prevZone: "bottom" | "neutral" | "top" = "neutral";
            for (let i = 0; i < spxPts.length; i++) {
              const d = spxPts[i]?.date ?? "";
              if (d < startDate) continue;
              const sClose = spxCloses[i];
              const ni = ndxIdxByDate.get(d);
              const di = dxyIdxByDate.get(d);
              if (sClose === undefined || ni === undefined || di === undefined) continue;
              const nClose = ndxCloses[ni];
              const dClose = dxyCloses[di];
              const nMa = ndxMaArr[ni];
              const dMa = dxyMaArr[di];
              const rsi = spxRsiArr[i];
              if (nClose === undefined || dClose === undefined || nMa == null || dMa == null || rsi == null) continue;
              const nDev = (nClose / nMa - 1) * 100;
              const vix = asofVal(vixPts, d);
              const hy = asofVal(hyPts, d);
              let hi252 = -Infinity;
              for (let j = Math.max(0, i - 251); j <= i; j++) {
                const c = spxCloses[j];
                if (c !== undefined && c > hi252) hi252 = c;
              }
              const dd = hi252 > 0 ? (sClose / hi252 - 1) * 100 : 0;
              const bFlags: (boolean | null)[] = [
                vix == null ? null : vix >= 28,
                nClose > nMa,
                dClose < dMa,
                rsi < 30,
                dd <= -10,
                hy == null ? null : hy > 4,
                nDev < -5,
              ];
              const tFlags: (boolean | null)[] = [
                vix == null ? null : vix < 13,
                rsi > 70,
                nDev > 20,
                hy == null ? null : hy < 3,
              ];
              const sideScore = (flags: (boolean | null)[]): number | null => {
                const av = flags.filter((f) => f !== null);
                if (av.length === 0) return null;
                return Math.round((100 * av.filter((f) => f).length) / av.length);
              };
              const bs = sideScore(bFlags);
              const ts = sideScore(tFlags);
              if (bs === null || ts === null) continue;
              const comp = ts - bs;
              hist.push({ date: d, composite: comp, bottomScore: bs, topScore: ts });
              const z: "bottom" | "neutral" | "top" = comp <= -50 ? "bottom" : comp >= 30 ? "top" : "neutral";
              if (z !== "neutral" && z !== prevZone) entries.push({ date: d, zone: z });
              prevZone = z;
            }
          }
        }
        bottomTop = {
          bottomScore,
          topScore,
          composite,
          zone,
          bottomTriggered: bTrig,
          bottomAvailable: bAvail.length,
          topTriggered: tTrig,
          topAvailable: tAvail.length,
          asOf,
          resonance: {
            vix: trigOf("B1"),
            ndxAbove: trigOf("B2"),
            dxyBelow: trigOf("B3"),
            all: trigOf("B1") && trigOf("B2") && trigOf("B3"),
          },
          signals: btSignals,
          history: hist,
          entries,
        };
      }

      const result: DashboardPayload = {
        hasData: true,
        windowDays,
        cloudCounts,
        coverage: [...covMap.entries()]
          .map(([key, v]) => ({ key, from: v.minDate ?? "", to: v.maxDate ?? "", points: v.count }))
          .sort((a, b) => (a.key < b.key ? -1 : 1)),
        stages,
        updatedAt: lastLog ? lastLog.finishedAt.toISOString() : null,
        refreshStatus: aggRefreshStatus,
        refreshDetail: aggRefreshDetail,
        hero,
        yields: yieldsBlock,
        cdbGov: cdbGovBlock,
        money: moneyBlock,
        derived,
        instruments,
        drawdowns,
        signals,
        fibs,
        fred,
        realRateLast,
        macroFred,
        cnMoney,
        marginCn,
        marginUs,
        fearGreed,
        bottomTop,
        style,
        seasonality,
        breadth,
        portfolio,
        calendar,
      };
      dashMemo.set(windowDays, { version, value: result });
      return result;
    },
  }),
} satisfies ActionsModule;
