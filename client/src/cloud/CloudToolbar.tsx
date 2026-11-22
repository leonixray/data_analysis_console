// Cloud page top surface: title, freshness line and the dark top bar
// (period pill / 盘前 pill / index selector / settings popover).
// Presentational: all state lives in CloudView
// and arrives as props. Copy & option tables come from ./copy.
import { SectionHead, signed, stageTimeText } from "../shared";
import type { api, ApiResponse } from "../api";
import { CLOUD_INDEX_MENU, CLOUD_PERIODS, CLOUD_TITLE, cloudUpdatedLine } from "./copy";
import type { CloudMarketId, CloudPeriodKey, CloudSession } from "./types";
import { cloudPctColor } from "./utils";

type Stages = ApiResponse<typeof api, "getDashboard">["stages"];
type MenuKind = "index" | "period" | "settings";

export function CloudToolbar({
  stages, cloudStage, isRut, indexName, asOf, period, periodLabel,
  preActive, session, market, menuOpen, viewMode, sizeMode, zoom,
  indexDay, onToggleMenu, onCloseMenu, onPickPeriod, onToggleSession,
  onPickMarket, onPickViewMode, onPickSizeMode, onPickZoom, onOpenMethod,
}: {
  stages: Stages;
  cloudStage: string;
  isRut: boolean;
  indexName: string;
  asOf: string;
  period: CloudPeriodKey;
  periodLabel: string;
  preActive: boolean;
  session: CloudSession;
  market: CloudMarketId;
  menuOpen: MenuKind | null;
  viewMode: "sector" | "industry";
  sizeMode: "sqrt" | "linear";
  zoom: 1 | 2 | 3;
  indexDay: (id: CloudMarketId) => { day: number | null; official: boolean };
  onToggleMenu: (w: MenuKind) => void;
  onCloseMenu: () => void;
  onPickPeriod: (p: CloudPeriodKey) => void;
  onToggleSession: () => void;
  onPickMarket: (m: CloudMarketId) => void;
  onPickViewMode: (vm: "sector" | "industry") => void;
  onPickSizeMode: (m: "sqrt" | "linear") => void;
  onPickZoom: (z: 1 | 2 | 3) => void;
  onOpenMethod: () => void;
}) {
  const menuItems = CLOUD_INDEX_MENU.map((cfg) => ({ ...cfg, ...indexDay(cfg.id) }));
  return (
    <>
      <SectionHead title={CLOUD_TITLE} />
      <p className="mt-1.5 text-[11px] text-[var(--dim)]">{cloudUpdatedLine(stageTimeText(stages, cloudStage), isRut, indexName, asOf)}</p>

      {/* Top bar, copied from the reference app (photo 1/3): period
          pill left, 盘前 session pill, index pill opening the dark
          selector menu, settings icon right — all on the map's own
          dark panel so the bar and the wall read as one surface. The
          reference's share icon is NOT copied: sharing belongs to the
          shell, and a dead share button would be a fake control. */}
      <div className="relative mt-3">
        <div className="flex items-center gap-2 rounded-t-[var(--radius)] bg-[#131a24] px-2.5 py-2">
          <button
            type="button"
            onClick={() => onToggleMenu("period")}
            aria-label={`选择时段，当前 ${preActive ? "1天" : periodLabel}`}
            aria-expanded={menuOpen === "period"}
            className="shrink-0 rounded-full bg-white/10 px-3.5 py-1.5 text-sm font-medium text-white"
          >
            {preActive ? "1天" : periodLabel} <span aria-hidden>∨</span>
          </button>
          {market !== "cn" ? (
            <button
              type="button"
              onClick={onToggleSession}
              aria-pressed={session === "pre"}
              aria-label={session === "pre" ? "盘前口径已开，点击回到收盘口径" : "切换到盘前口径（快照抓取时的盘前涨跌）"}
              className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium ${session === "pre" ? "bg-[var(--accent)] text-white" : "bg-white/10 text-white/60"}`}
            >
              盘前
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => onToggleMenu("index")}
            aria-label={`选择指数，当前 ${indexName}`}
            aria-expanded={menuOpen === "index"}
            className="mx-auto min-w-0 flex-1 rounded-full bg-white/10 px-4 py-1.5 text-center text-sm font-semibold text-white sm:max-w-72"
          >
            <span className="block truncate">
              {indexName} <span aria-hidden>∨</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => onToggleMenu("settings")}
            aria-label="云图设置（视图、面积模式、缩放）"
            aria-expanded={menuOpen === "settings"}
            className="shrink-0 rounded-full bg-white/10 p-2 text-white"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <line x1="4" y1="7" x2="20" y2="7" />
              <circle cx="9" cy="7" r="2.2" fill="#131a24" />
              <line x1="4" y1="12" x2="20" y2="12" />
              <circle cx="15" cy="12" r="2.2" fill="#131a24" />
              <line x1="4" y1="17" x2="20" y2="17" />
              <circle cx="7" cy="17" r="2.2" fill="#131a24" />
            </svg>
          </button>
        </div>

        {menuOpen ? (
          <button type="button" aria-label="关闭菜单" onClick={onCloseMenu} className="fixed inset-0 z-20 cursor-default bg-transparent" />
        ) : null}

        {menuOpen === "period" ? (
          <div className="absolute left-2 top-full z-30 mt-1 w-36 rounded-2xl bg-[#0b1220] py-1.5 shadow-2xl" role="menu" aria-label="选择时段">
            {CLOUD_PERIODS.map((p) => (
              <button
                key={p.id}
                type="button"
                role="menuitem"
                onClick={() => onPickPeriod(p.id)}
                aria-pressed={!preActive && period === p.id}
                className={`block w-full px-4 py-2 text-left text-sm ${!preActive && period === p.id ? "bg-[var(--accent)] font-semibold text-white" : "text-white/75"}`}
              >
                {p.label}
              </button>
            ))}
          </div>
        ) : null}

        {menuOpen === "index" ? (
          <div className="absolute left-1/2 top-full z-30 mt-1 w-60 max-w-[86vw] -translate-x-1/2 rounded-3xl bg-[#0b1220] py-2 shadow-2xl" role="menu" aria-label="选择指数">
            <div className="px-4 pb-1 pt-1 text-center text-[15px] font-semibold text-white">
              {indexName} <span aria-hidden>∧</span>
            </div>
            {menuItems.map((m) => (
              <button
                key={m.label}
                type="button"
                role="menuitem"
                onClick={() => onPickMarket(m.id)}
                aria-label={`${m.label}${m.day != null ? `，${m.official ? "官方指数" : "成分加权估算"}当日涨跌 ${signed(m.day, 1)}%` : "，当日涨跌暂无"}`}
                aria-current={market === m.id}
                className={`block w-full px-4 py-1.5 text-center ${market === m.id ? "bg-[var(--accent)]" : ""}`}
              >
                <div className={`text-[15px] ${market === m.id ? "font-semibold text-white" : "text-white/85"}`}>{m.label}</div>
                <div className="text-xs font-medium" style={{ color: market === m.id ? "rgb(255 255 255 / 0.92)" : m.day == null ? "#8b98a9" : cloudPctColor(m.day) }}>
                  {m.day == null ? "—" : `${signed(m.day, 1)}%`}
                </div>
              </button>
            ))}
            <div className="mx-4 mt-1.5 border-t border-white/10 px-2 pb-1 pt-2 text-center text-[11px] text-white/50">
              {asOf
                ? `休市 · ${["周日", "周一", "周二", "周三", "周四", "周五", "周六"][new Date(`${asOf}T00:00:00Z`).getUTCDay()] ?? ""}收盘 · 快照 ${asOf}`
                : "暂无快照"}
            </div>
          </div>
        ) : null}

        {menuOpen === "settings" ? (
          <div className="absolute right-2 top-full z-30 mt-1 w-60 rounded-2xl bg-[#0b1220] p-3 shadow-2xl" aria-label="云图设置">
            {(
              [
                {
                  label: "视图",
                  group: "云图视图",
                  items: [
                    { id: "sector", label: "板块视图", active: viewMode === "sector", run: () => onPickViewMode("sector") },
                    { id: "industry", label: "行业视图", active: viewMode === "industry", run: () => onPickViewMode("industry") },
                  ],
                },
                {
                  label: "面积",
                  group: "云图面积模式",
                  items: [
                    { id: "linear", label: "真实比例", active: sizeMode === "linear", run: () => onPickSizeMode("linear") },
                    { id: "sqrt", label: "均匀浏览", active: sizeMode === "sqrt", run: () => onPickSizeMode("sqrt") },
                  ],
                },
                {
                  label: "缩放",
                  group: "云图缩放",
                  items: [
                    { id: "z1", label: "标准", active: zoom === 1, run: () => onPickZoom(1) },
                    { id: "z2", label: "放大", active: zoom === 2, run: () => onPickZoom(2) },
                    { id: "z3", label: "特大", active: zoom === 3, run: () => onPickZoom(3) },
                  ],
                },
              ] as const
            ).map((row) => (
              <div key={row.label} className="mb-2.5 last:mb-0">
                <div className="mb-1 text-[11px] text-white/45">{row.label}</div>
                <div className="flex gap-1" role="group" aria-label={row.group}>
                  {row.items.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={o.run}
                      aria-pressed={o.active}
                      className={`rounded-full px-3 py-1.5 text-xs font-medium ${o.active ? "bg-[var(--accent)] text-white" : "bg-white/10 text-white/70"}`}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={onOpenMethod}
              className="mt-1 w-full border-t border-white/10 pt-2.5 text-left text-xs text-[#9fc1ff]"
            >
              云图怎么看 →
            </button>
          </div>
        ) : null}
      </div>

    </>
  );
}
