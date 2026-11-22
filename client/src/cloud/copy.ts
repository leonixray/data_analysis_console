// Cloud map （云图） copy & configuration: every user-facing string and
// option table of the cloud page lives here, so wording changes never
// touch the components or the actions. Extracted verbatim from the
// previous inline copies in App.tsx (2026-11-19 cloud split).
import type { CloudMarketId, CloudPeriodKey } from "./types";

// 时段切换：id 与服务端快照的周期字段同名，cap 是该时段的颜色饱和上限（%）。
export const CLOUD_PERIODS: { id: CloudPeriodKey; label: string; cap: number }[] = [
  { id: "d1", label: "1天", cap: 5 },
  { id: "w1", label: "1周", cap: 10 },
  { id: "m1", label: "1月", cap: 18 },
  { id: "m3", label: "3月", cap: 32 },
  { id: "m6", label: "6月", cap: 50 },
  { id: "ytd", label: "年初", cap: 65 },
  { id: "y1", label: "1年", cap: 90 },
];

// 指数菜单：只列本台有成分数据的 4 个指数（用户口径 2026-11-19），默认标普 500。
export const CLOUD_INDEX_MENU: { id: CloudMarketId; label: string }[] = [
  { id: "us", label: "标普 500" },
  { id: "ndx", label: "纳斯达克 100" },
  { id: "dow", label: "道指" },
  { id: "cn", label: "沪深 300" },
];

export const CLOUD_TITLE = "云图 · 全市场热力图";

/** 标题下的时间行：云图数据更新于 <分块时间>（<快照口径>）· 行情截至 <日期>。 */
export function cloudUpdatedLine(stageText: string, isRut: boolean, indexName: string, asOf: string): string {
  return `云图数据更新于 ${stageText}（${isRut ? "罗素 2000 前 200 大成分快照 · 非全量" : `${indexName}成分快照`}）· 行情截至 ${asOf || "—"}`;
}

export const CLOUD_LOADING_TEXT = "正在读取云图缓存…";

export const CLOUD_RUT_EMPTY_TEXT = "罗素 2000 成分源待恢复：IWM 持仓文件被源站拦截，暂无数据。";

/** 成分未入库时的空状态文案（罗素 2000 以外）。 */
export function cloudEmptyText(indexName: string): string {
  return `云图${indexName}成分数据尚未入库，点右上角「刷新数据」拉取一次。`;
}
