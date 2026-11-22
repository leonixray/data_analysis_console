// Cloud stock detail drawer: the dark bottom sheet shown when a tile
// (or an 「其他」 strip row, or a peer chip) is tapped. Derivations and
// markup moved verbatim out of CloudView (App.tsx) in the 2026-11-19
// cloud split; the on-demand quote fetch stays in CloudView and the
// result arrives as props (sd / loading).
import { fmt, signed } from "../shared";
import { CLOUD_PERIODS } from "./copy";
import type { CloudDetailSel, CloudMarketId, CloudPeriodKey, CloudSession, CloudStock, StockDetail } from "./types";
import { cloudRet, cloudTileBg, cloudTileFg, cloudHeadline, fmtMonthDay, fmtVol, fmtCap, fmtWeightPct } from "./utils";

export function CloudDetail({
  detail, indexName, stocks, market, viewMode, sd, loading, detailPeriod,
  onPeriodChange, effSession, onClose, onSelectPeer, onDrill,
}: {
  detail: CloudDetailSel | null;
  indexName: string;
  stocks: CloudStock[];
  market: CloudMarketId;
  viewMode: "sector" | "industry";
  sd: StockDetail | undefined;
  loading: boolean;
  detailPeriod: CloudPeriodKey;
  onPeriodChange: (p: CloudPeriodKey) => void;
  effSession: CloudSession;
  onClose: () => void;
  onSelectPeer: (s: CloudStock) => void;
  onDrill: (s: CloudStock) => void;
}) {
  const detailStock = detail?.stock ?? null;
  // Drawer stats are computed on the drawer's OWN selected period and
  // always on the close basis (contribution to the index is a close
  // concept) — the sector comparison is re-derived here on the same
  // basis instead of reusing the map session's sector return, so the
  // drawer never mixes premarket and close numbers either.
  const detailContrib = detailStock ? (detailStock.weight / 100) * cloudRet(detailStock, detailPeriod) : 0;
  const detailSectorStocks = detailStock ? stocks.filter((s) => s.sector === detailStock.sector) : [];
  const detailSectorRet = (() => {
    let w = 0;
    let n = 0;
    for (const s of detailSectorStocks) {
      w += s.weight;
      n += s.weight * cloudRet(s, detailPeriod);
    }
    return w > 0 ? n / w : 0;
  })();
  const detailVsSector = detailStock ? cloudRet(detailStock, detailPeriod) - detailSectorRet : 0;
  // Detail-drawer derivations from the snapshot itself (instant, before
  // the on-demand detail fetch lands): rank inside the sector by market
  // cap (weight fallback), the day's absolute move, and sector peers.
  const detailRank = detailStock
    ? [...detailSectorStocks].sort((a, b) => (b.cap ?? b.weight) - (a.cap ?? a.weight)).findIndex((s) => s.code === detailStock.code) + 1
    : 0;
  const detailDayAmt = detailStock && detailStock.d1 > -100 ? detailStock.price - detailStock.price / (1 + detailStock.d1 / 100) : 0;
  const detailPeers = detailStock
    ? detailSectorStocks
        .filter((s) => s.code !== detailStock.code)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 5)
    : [];
  // One cell of the drawer's four-column data grid (photo 2 order is
  // written out at the render site).
  const drawerCell = (label: string, value: string | null, valueClass = "text-[15px]") => (
    <div key={label} className="min-w-0">
      <div className="truncate text-[10px] text-[#8b98a9]">{label}</div>
      <div className={`mt-0.5 truncate font-semibold text-[#eef2f6] ${valueClass}`}>{value ?? "—"}</div>
    </div>
  );
  const drawerAnyMissing =
    sd != null &&
    [sd.open, sd.high, sd.low, sd.volume, sd.peTtm, sd.peFwd, sd.divYieldPct, sd.roePct, sd.epsTtm, sd.beta, sd.avgVolume, sd.ps, sd.pb, sd.high52, sd.low52].some((v) => v == null);
  const rangePos =
    detailStock && sd?.low52 != null && sd?.high52 != null && sd.high52 > sd.low52
      ? Math.max(0, Math.min(100, ((detailStock.price - sd.low52) / (sd.high52 - sd.low52)) * 100))
      : null;
  // Intraday line geometry (viewBox units) incl. the previous-close level.
  const intraGeom = (() => {
    const pts = sd?.intraday ?? [];
    if (pts.length < 2) return null;
    const vals = pts.map((p) => p.p);
    const pc = sd?.intraPrevClose ?? sd?.prevClose;
    const lo = Math.min(...vals, ...(pc != null ? [pc] : []));
    const hi = Math.max(...vals, ...(pc != null ? [pc] : []));
    const span = hi - lo || 1;
    const y = (v: number) => 34 - ((v - lo) / span) * 32 - 1;
    const line = pts.map((p, i) => `${((i / (pts.length - 1)) * 100).toFixed(1)},${y(p.p).toFixed(1)}`).join(" ");
    const maxV = Math.max(...pts.map((p) => p.v), 1);
    const lastPt = pts[pts.length - 1];
    if (!lastPt) return null;
    const last = lastPt.p;
    // M-P2-3: phone Y-axis ticks — label positions as % of the 36-unit
    // viewBox height, using the same y mapping as the line, so the
    // highest / current / lowest labels sit exactly at their price
    // levels. The current-price tick is nudged when it would collide
    // with the high/low tick so all three stay readable.
    const pct = (v: number) => (y(v) / 36) * 100;
    // Clamp the extreme ticks a touch inward so their centred labels
    // stay inside the column instead of eating the gap above the chart.
    const hiPct = Math.max(pct(hi), 5);
    const loPct = Math.min(pct(lo), 95);
    let lastPct = pct(last);
    if (lastPct - hiPct < 14) lastPct = hiPct + 14;
    if (loPct - lastPct < 14) lastPct = loPct - 14;
    // When the last price IS the high or the low, that tick already
    // shows the value — don't print the same number twice.
    const axisTicks = [
      { v: hi, pct: hiPct },
      ...(last !== hi && last !== lo ? [{ v: last, pct: lastPct }] : []),
      { v: lo, pct: loPct },
    ];
    return { pts, line, pcY: pc != null ? y(pc) : null, pc, lo, hi, maxV, last, axisTicks };
  })();

  // The 1天→1年 period strip (F-P2-9): the SAME chips, from the SAME
  // snapshot period returns, render under the intraday chart when the
  // intraday fetch lands AND as the fallback when it doesn't — one
  // position (directly under the chart slot), one caliber (the cloud
  // snapshot's stored period returns, themselves computed from the
  // daily closes at refresh time). Previously the strip only existed
  // in the fallback branch, so a successful intraday fetch hid it.
  const periodChips = detailStock ? (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="各时段涨跌">
      {CLOUD_PERIODS.map((p) => {
        const v = cloudRet(detailStock, p.id);
        return (
          <span key={p.id} className="inline-flex items-center rounded px-1.5 py-1 text-[11px] font-medium" style={{ background: cloudTileBg(v, p.cap), color: cloudTileFg(v, p.cap) }}>
            {p.label} {signed(v, 1)}%
          </span>
        );
      })}
    </div>
  ) : null;
  if (!detail || !detailStock) return null;
  return (
    <>
              <button type="button" aria-label="关闭个股详情" onClick={() => onClose()} className="fixed inset-0 z-40 cursor-default bg-black/55" />
              <div
                className="fixed inset-x-0 bottom-0 z-50 mx-auto max-h-[92dvh] w-full max-w-3xl overflow-y-auto rounded-t-3xl bg-[#0a1120] px-4 pb-6 pt-2 text-[#eef2f6] shadow-2xl sm:px-6"
                role="dialog"
                aria-modal="true"
                aria-label={`${detailStock.name} ${detailStock.code} 个股详情`}
              >
                <div className="mx-auto h-1 w-10 rounded-full bg-white/25" aria-hidden />
                <div className="mt-2 flex items-start gap-3">
                  <button
                    type="button"
                    onClick={() => onClose()}
                    aria-label="关闭个股详情"
                    className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10 text-lg leading-none text-white"
                  >
                    ✕
                  </button>
                  <div className="min-w-0">
                    <div className="truncate text-[26px] font-bold leading-tight">{market === "cn" ? detailStock.name : detailStock.code}</div>
                    <div className="truncate text-sm text-[#aeb8c2]">{market === "cn" ? detailStock.code : (detailStock.zh ?? detailStock.name)}</div>
                    <div className="text-sm text-[#aeb8c2]">
                      {detailStock.sector} · {detailRank}/{detailSectorStocks.length}
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-baseline gap-x-3">
                  <span className="text-[44px] font-bold leading-none">{fmt(detailStock.price, 2)}</span>
                  <span className="text-lg text-[#aeb8c2]">
                    {signed(detailDayAmt, 2)} {signed(detailStock.d1, 2)}%
                  </span>
                </div>
                {sd?.prePrice != null ? (
                  <p className="mt-2 text-[15px] font-semibold">
                    盘前 {market === "cn" ? "¥" : "US$"}
                    {fmt(sd.prePrice, 2)}
                    {sd.prePct != null ? ` ${signed(sd.prePct, 2)}%` : ""}
                  </p>
                ) : sd?.postPrice != null ? (
                  <p className="mt-2 text-[15px] font-semibold text-[#aeb8c2]">
                    盘后 {market === "cn" ? "¥" : "US$"}
                    {fmt(sd.postPrice, 2)}
                    {sd.postPct != null ? ` ${signed(sd.postPct, 2)}%` : ""}
                  </p>
                ) : null}
                <p className="mt-1 text-[13px] text-[#8b98a9]">
                  1天 · {fmtMonthDay(detailStock.date)} · {sd?.prePrice != null ? "盘前" : "收盘"}
                </p>

                {/* Company profile + recent headlines (F-P2-9), between
                    the price block and the key-data grid. The profile
                    is the source publisher's own text, excerpted
                    server-side (Yahoo assetProfile for US names,
                    Eastmoney F10 公司简介 for A-shares); when the
                    source carries none, the whole block is absent —
                    nothing is written to fill it. News is Yahoo
                    Finance's own feed (US names only; the feed is
                    empty for A-share symbols, so CN drawers show the
                    profile alone). */}
                {sd?.profile ? (
                  <div className="mt-3">
                    <p className="text-[13px] leading-relaxed text-[#c8d2dc]">{sd.profile}</p>
                    <p className="mt-1 text-[11px] text-[#8b98a9]">公司简介 · {sd.profileSource}（原文摘录）</p>
                    {sd.news.length > 0 ? (
                      <ul className="mt-2.5 space-y-2">
                        {sd.news.map((n) => (
                          <li key={n.link}>
                            <a href={n.link} target="_blank" rel="noreferrer" className="block">
                              <span className="block text-[13px] font-medium leading-snug text-[#eef2f6]">{n.title}</span>
                              <span className="mt-0.5 block text-[11px] text-[#8b98a9]">
                                {n.date}
                                {n.publisher ? ` · ${n.publisher}` : ""} · Yahoo Finance
                              </span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}

                {detailPeriod === "d1" && intraGeom ? (
                  <div className="mt-3">
                    <div className="relative pr-14">
                      <svg viewBox="0 0 100 36" className="h-44 w-full" preserveAspectRatio="none" role="img" aria-label={`${detailStock.code} 日内分时图，高 ${fmt(intraGeom.hi, 2)}，低 ${fmt(intraGeom.lo, 2)}，现价 ${fmt(intraGeom.last, 2)}${intraGeom.pc != null ? `，昨收 ${fmt(intraGeom.pc, 2)}` : ""}`}>
                        {intraGeom.pcY != null ? <line x1="0" x2="100" y1={intraGeom.pcY} y2={intraGeom.pcY} stroke="#8b98a9" strokeWidth="0.5" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" /> : null}
                        <polyline points={intraGeom.line} fill="none" stroke="#ffffff" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
                      </svg>
                      {intraGeom.pc != null ? (
                        <span className="absolute left-0 -translate-y-full text-[11px] text-[#8b98a9]" style={{ top: `${(intraGeom.pcY ?? 0) * (100 / 36)}%` }}>
                          昨收 {fmt(intraGeom.pc, 2)}
                        </span>
                      ) : null}
                      {intraGeom.axisTicks
                        .filter((t) => t.v !== intraGeom.last)
                        .map((t, i) => (
                          <span key={i} className="absolute right-0 w-12 -translate-y-1/2 text-[11px] text-[#8b98a9]" style={{ top: `${t.pct}%` }}>
                            {fmt(t.v, t.v >= 100 ? 0 : 2)}
                          </span>
                        ))}
                      {(() => {
                        const lastTick = intraGeom.axisTicks.find((t) => t.v === intraGeom.last);
                        return lastTick ? (
                          <span className="absolute right-0 -translate-y-1/2 whitespace-nowrap rounded-full bg-white px-1.5 py-0.5 text-[11px] font-semibold text-[#0a1120]" style={{ top: `${lastTick.pct}%` }}>
                            {fmt(intraGeom.last, 2)}
                          </span>
                        ) : null;
                      })()}
                    </div>
                    <div className="flex justify-between pr-14 text-[11px] text-[#8b98a9]">
                      {[0, 0.25, 0.5, 0.75, 1].map((f) => {
                        const pt = intraGeom.pts[Math.min(intraGeom.pts.length - 1, Math.round(f * (intraGeom.pts.length - 1)))];
                        return <span key={f}>{pt ? `${Number.parseInt(pt.t.slice(0, 2), 10)}时` : ""}</span>;
                      })}
                    </div>
                    <svg viewBox="0 0 100 10" className="mt-1 h-6 w-full pr-14" preserveAspectRatio="none" aria-hidden>
                      {intraGeom.pts.map((pt, i) => (
                        <rect key={i} x={(i / intraGeom.pts.length) * 100} y={10 - (pt.v / intraGeom.maxV) * 10} width={(100 / intraGeom.pts.length) * 0.8} height={(pt.v / intraGeom.maxV) * 10} fill="#8b98a9" opacity="0.6" />
                      ))}
                    </svg>
                    {/* 1天→1年 mini strip: always present under the
                        chart, same chips as the no-intraday fallback
                        below (F-P2-9). */}
                    <div className="mt-2.5">{periodChips}</div>
                  </div>
                ) : detailPeriod === "d1" ? (
                  <div className="mt-3">
                    {periodChips}
                    <p className="mt-1.5 text-[11px] text-[#8b98a9]">{loading ? "日内分时拉取中…" : "日内分时本次未取到，先看各时段涨跌"}</p>
                  </div>
                ) : (
                  <div className="mt-3 rounded-xl bg-white/5 px-3 py-3">
                    <span className="text-sm text-[#aeb8c2]">{CLOUD_PERIODS.find((p) => p.id === detailPeriod)?.label}涨跌 </span>
                    <span className="text-xl font-bold">{signed(cloudRet(detailStock, detailPeriod), 2)}%</span>
                  </div>
                )}

                <div className="no-scrollbar mt-3 flex gap-1 overflow-x-auto rounded-full bg-white/10 p-1" role="group" aria-label="详情时段">
                  {CLOUD_PERIODS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => onPeriodChange(p.id)}
                      aria-pressed={detailPeriod === p.id}
                      className={`shrink-0 rounded-full px-3 py-1.5 text-[13px] font-medium ${detailPeriod === p.id ? "bg-[var(--accent)] text-white" : "text-white/60"}`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>

                {loading && !sd ? (
                  <p className="mt-4 text-sm text-[#8b98a9]">正在拉取个股详情（报价、分时与估值）…</p>
                ) : (
                  <>
                    <div className="mt-4 grid grid-cols-4 gap-x-3 gap-y-3.5">
                      {drawerCell("开盘价", sd?.open != null ? fmt(sd.open, 2) : null)}
                      {drawerCell("日内最高", sd?.high != null ? fmt(sd.high, 2) : null)}
                      {drawerCell("日内最低", sd?.low != null ? fmt(sd.low, 2) : null)}
                      {drawerCell("成交量", sd?.volume != null ? fmtVol(sd.volume) : null)}
                      {drawerCell("市值", (sd?.cap ?? detailStock.cap) != null ? fmtCap((sd?.cap ?? detailStock.cap)!, market === "cn" ? "¥" : "US$") : null, "text-[13px]")}
                      {drawerCell("市盈率（TTM）", sd?.peTtm != null ? fmt(sd.peTtm, 1) : null)}
                      {drawerCell("市盈率（NTM）", sd?.peFwd != null ? fmt(sd.peFwd, 1) : null)}
                      {drawerCell("股息率", sd?.divYieldPct != null ? `${fmt(sd.divYieldPct, 2)}%` : null)}
                      <div className="col-span-2 min-w-0">
                        <div className="text-[10px] text-[#8b98a9]">52 周区间</div>
                        {rangePos != null && sd?.low52 != null && sd?.high52 != null ? (
                          <div className="mt-1.5 flex items-center gap-1.5 text-[13px] font-semibold">
                            <span>{fmt(sd.low52, 2)}</span>
                            <span className="relative h-1 min-w-6 flex-1 rounded-full bg-white/15">
                              <span className="absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full bg-white" style={{ left: `calc(${rangePos}% - 5px)` }} />
                            </span>
                            <span>{fmt(sd.high52, 2)}</span>
                          </div>
                        ) : (
                          <div className="mt-0.5 text-[15px] font-semibold">—</div>
                        )}
                      </div>
                      {drawerCell("净资产收益率", sd?.roePct != null ? `${fmt(sd.roePct, 1)}%` : null)}
                      {drawerCell(sd?.earningsEst ? "下次财报 · 预估" : "下次财报", sd?.nextEarnings ? fmtMonthDay(sd.nextEarnings) : null)}
                      {drawerCell("52 周最高", sd?.high52 != null ? fmt(sd.high52, 2) : null)}
                      {drawerCell("52 周最低", sd?.low52 != null ? fmt(sd.low52, 2) : null)}
                      {drawerCell("每股收益（TTM）", sd?.epsTtm != null ? fmt(sd.epsTtm, 2) : null)}
                      {drawerCell("贝塔系数", sd?.beta != null ? fmt(sd.beta, 2) : null)}
                      {drawerCell("平均成交量", sd?.avgVolume != null ? fmtVol(sd.avgVolume) : null)}
                      {drawerCell("市销率", sd?.ps != null ? fmt(sd.ps, 1) : null)}
                      {drawerCell("市净率", sd?.pb != null ? fmt(sd.pb, 1) : null)}
                      {drawerCell("指数权重", fmtWeightPct(detailStock.weight))}
                    </div>
                    {drawerAnyMissing ? <p className="mt-2 text-[11px] text-[#8b98a9]">标「—」的字段为数据源本次未提供，未做估算。</p> : null}
                  </>
                )}

                <p className="mt-4 text-[13px] leading-relaxed text-[#aeb8c2]">
                  {sd?.peHist ? (
                    <>
                      5 年市盈率中位数 {fmt(sd.peHist.median, 1)} · 当前 {fmt(sd.peHist.current, 1)}，处于第 {sd.peHist.percentile} 百分位
                      <span className="text-[#8b98a9]">（{sd.peHist.n} 个季度观测：每季末股价 ÷ 当时滚动四季 EPS，EPS 来自{market === "cn" ? "东财财报" : "SEC EDGAR"}申报）</span>
                    </>
                  ) : loading ? (
                    "5 年市盈率百分位计算中…"
                  ) : (
                    "5 年市盈率百分位：暂无可靠历史 EPS 序列，未做估算。"
                  )}
                </p>
                {/* Same coloured percentile scale as the main dashboard's
                    PctBar / LabelChip (green = low vs own history =
                    relatively cheap, red = high = expensive), drawn
                    locally because PctBar is not exported from App.tsx.
                    The track is translucent white to sit on the drawer's
                    dark surface, like the 52-week range bar above. */}
                {sd?.peHist ? (
                  <div className="mt-2 flex items-center gap-2">
                    <div
                      className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/15"
                      role="img"
                      aria-label={`5 年市盈率百分位 ${sd.peHist.percentile}`}
                    >
                      <div
                        className="absolute inset-y-0 left-0 rounded-full"
                        style={{
                          width: `${Math.min(100, Math.max(0, sd.peHist.percentile))}%`,
                          background: "linear-gradient(90deg, var(--down), var(--gold) 50%, var(--up))",
                        }}
                      />
                      <div
                        className="absolute inset-y-0 w-[2px] bg-[#0d151c]"
                        style={{ left: `calc(${Math.min(100, Math.max(0, sd.peHist.percentile))}% - 1px)` }}
                      />
                    </div>
                    <span
                      className={`inline-block shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${
                        sd.peHist.percentile >= 75
                          ? "bg-[#c0392b]/30 text-[#ffb3a7]"
                          : sd.peHist.percentile <= 25
                            ? "bg-[#1e7d4f]/30 text-[#8fe3b6]"
                            : "bg-white/10 text-[#aeb8c2]"
                      }`}
                    >
                      {sd.peHist.percentile >= 95 ? "极端偏高" : sd.peHist.percentile >= 75 ? "偏高" : sd.peHist.percentile > 25 ? "中性" : sd.peHist.percentile > 5 ? "偏低" : "极端偏低"}
                    </span>
                  </div>
                ) : null}
                <p className="mt-2 text-xs leading-relaxed text-[#8b98a9]">
                  拉动{indexName} {Math.abs(detailContrib) < 0.005 ? "不足 0.01" : signed(detailContrib, 2)} 个百分点 · {detailVsSector >= 0 ? "领先" : "落后"}
                  {detail.sectorName}板块 {Math.abs(detailVsSector).toFixed(1)} 个百分点 · 距 52 周高点{" "}
                  {detailStock.fromHigh <= -0.05 ? `低 ${Math.abs(detailStock.fromHigh).toFixed(1)}%` : "就在高点附近"} ·{" "}
                  {detailStock.ma50 == null && detailStock.ma200 == null
                    ? "均线位置 —"
                    : detailStock.ma50 != null && detailStock.ma200 != null && detailStock.ma50 >= 0 && detailStock.ma200 >= 0
                      ? "高于 50 日与 200 日均线"
                      : detailStock.ma50 != null && detailStock.ma200 != null && detailStock.ma50 < 0 && detailStock.ma200 < 0
                        ? "低于 50 日与 200 日均线"
                        : [
                            detailStock.ma50 != null ? `${detailStock.ma50 >= 0 ? "高于" : "低于"} 50 日线 ${Math.abs(detailStock.ma50).toFixed(1)}%` : null,
                            detailStock.ma200 != null ? `${detailStock.ma200 >= 0 ? "高于" : "低于"} 200 日线 ${Math.abs(detailStock.ma200).toFixed(1)}%` : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}{" "}
                  · 数据日期 {detailStock.date} · 报价与基本面按需拉取自 Yahoo Finance
                </p>

                {detailPeers.length > 0 ? (
                  <div className="mt-4 flex flex-wrap gap-1.5" aria-label="同板块相关股">
                    {detailPeers.map((s) => {
                      const pv = effSession === "pre" ? s.pre : cloudRet(s, detailPeriod);
                      const pcap = CLOUD_PERIODS.find((p) => p.id === detailPeriod)?.cap ?? 5;
                      return (
                        <button
                          key={s.code}
                          type="button"
                          onClick={() => onSelectPeer(s)}
                          aria-label={`查看 ${cloudHeadline(s, market)} ${s.code} 详情，${effSession === "pre" ? "盘前" : (CLOUD_PERIODS.find((p) => p.id === detailPeriod)?.label ?? "")}涨跌 ${pv == null ? "暂无" : `${signed(pv, 2)}%`}`}
                          className="rounded-xl px-3 py-2 text-center"
                          style={{
                            background: pv == null ? "#5a6572" : cloudTileBg(pv, pcap),
                            color: pv == null ? "#fff" : cloudTileFg(pv, pcap),
                          }}
                        >
                          <span className="block text-xs font-bold leading-tight">{market === "cn" ? s.name : s.code}</span>
                          <span className="block text-[11px] leading-tight">{pv == null ? "—" : `${signed(pv, 2)}%`}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                <button
                  type="button"
                  onClick={() => onDrill(detailStock)}
                  aria-label={`简介：${detailStock.industry || detailStock.sector}，点击下钻到该${viewMode === "industry" ? "行业" : "板块"}`}
                  className="mt-4 block py-1 text-left text-sm text-[#eef2f6]"
                >
                  简介 · {detailStock.industry || detailStock.sector} <span aria-hidden>›</span>
                </button>

                {sd?.divRateTtm != null || sd?.divDate ? (
                  <div className="mt-3">
                    <div className="text-sm font-semibold">股息</div>
                    <p className="mt-1 text-sm">
                      近 12 个月每股 {sd?.divRateTtm != null ? fmt(sd.divRateTtm, 2) : "—"}
                      {sd?.divDate ? `，除息日 ${fmtMonthDay(sd.divDate)}` : ""}
                    </p>
                    <p className="mt-0.5 text-xs text-[#8b98a9]">股息数据来自 Yahoo 报价（滚动 12 个月每股股息与除息日）。</p>
                  </div>
                ) : null}
              </div>
    </>
  );
}
