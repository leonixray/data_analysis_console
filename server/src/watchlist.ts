// 自选股（美股页自选个股行）——示例列表。
//
// 改成你自己的关注列表：只改这里，不用动 actions.ts。每一行就是
// PRICE_SERIES 里的一行（Yahoo symbol + 展示信息），刷新流程、
// 卡片口径与指数行完全一致。
//
// 注意：这里只有代码（ticker），没有股数、成本等个人持仓数据。
// 想记自己的持仓（股数/成本/账户），见 config/holdings.example.json
// 的格式说明；当前版本管控台不直接读取那个文件，它是给你
// 自己扩展持仓视图时用的模板。

export type WatchlistRow = {
  key: string;
  name: string;
  sub: string;
  symbol: string;
  asset: "uswatch";
  unit: string;
  decimals: number;
  benchmark?: string;
};

export const WATCHLIST: WatchlistRow[] = [
  { key: "mu", name: "美光科技（MU）", sub: "Micron Technology · MU（存储芯片）", symbol: "MU", asset: "uswatch", unit: "美元", decimals: 2, benchmark: "spx" },
  { key: "be", name: "Bloom Energy（BE）", sub: "Bloom Energy · BE（燃料电池）", symbol: "BE", asset: "uswatch", unit: "美元", decimals: 2, benchmark: "spx" },
  { key: "googl", name: "谷歌 A（GOOGL）", sub: "Alphabet Class A · GOOGL", symbol: "GOOGL", asset: "uswatch", unit: "美元", decimals: 2, benchmark: "spx" },
  { key: "avgo", name: "博通（AVGO）", sub: "Broadcom · AVGO", symbol: "AVGO", asset: "uswatch", unit: "美元", decimals: 2, benchmark: "spx" },
  { key: "ibkr", name: "盈透证券（IBKR）", sub: "Interactive Brokers · IBKR", symbol: "IBKR", asset: "uswatch", unit: "美元", decimals: 2, benchmark: "spx" },
  { key: "aapl", name: "苹果（AAPL）", sub: "Apple · AAPL", symbol: "AAPL", asset: "uswatch", unit: "美元", decimals: 2, benchmark: "spx" },
  { key: "tsla", name: "特斯拉（TSLA）", sub: "Tesla · TSLA", symbol: "TSLA", asset: "uswatch", unit: "美元", decimals: 2, benchmark: "spx" },
  { key: "nvda", name: "英伟达（NVDA）", sub: "NVIDIA · NVDA", symbol: "NVDA", asset: "uswatch", unit: "美元", decimals: 2, benchmark: "spx" },
  { key: "uso", name: "原油 ETF（USO）", sub: "United States Oil Fund · USO（WTI 原油 ETF）", symbol: "USO", asset: "uswatch", unit: "美元", decimals: 2, benchmark: "spx" },
];
