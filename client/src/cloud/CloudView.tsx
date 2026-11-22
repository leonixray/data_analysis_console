// Cloud map （云图） page: full-index treemap (S&P 500 / Nasdaq 100 /
// Dow 30 / Russell 2000 top-200 subset / CSI 300) with sector & industry
// drill-down, period & premarket switching and the per-stock detail
// drawer. Split out of App.tsx in 2026-11-19: helpers in ./utils,
// copy & option tables in ./copy, the top bar in ./CloudToolbar and
// the detail drawer in ./CloudDetail. Behaviour unchanged.
import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type ApiResponse } from "../api";
import { fmt, signed } from "../shared";
import { CloudDetail } from "./CloudDetail";
import { CloudToolbar } from "./CloudToolbar";
import { CLOUD_LOADING_TEXT, CLOUD_PERIODS, CLOUD_RUT_EMPTY_TEXT, cloudEmptyText } from "./copy";
import type { CloudData, CloudDetailSel, CloudGroup, CloudPeriodKey, CloudSession, CloudStock, OfficialDay, TmRect } from "./types";
import { CLOUD_MIN_TILE_W, cloudVal, CLOUD_STAR_CODES, cloudTileBg, cloudTileFg, cloudPctColor, cloudBreadth, cloudHeadline, cloudTextWidth, cloudTileTier, squarifyInto, groupStocks } from "./utils";

type Stages = ApiResponse<typeof api, "getDashboard">["stages"];

export function CloudView({
  cloud,
  stages,
  goMethod,
  officialDay,
}: {
  cloud: CloudData | undefined;
  stages: Stages;
  goMethod: (id: string) => void;
  // Official index day moves from the dashboard's own index series
  // (标普 500 = ^GSPC, 纳指 100 = ^NDX, 沪深 300 = 510300 ETF 代理 —
  // the same rows the overview hero shows, so the two pages can never
  // disagree). pct is null when that series' day change is honestly
  // missing (a skipped trading day), and the selector then falls back
  // to the constituent-weighted estimate, labelled as such below.
  // 道指 / 罗素 2000 have no dashboard instrument card; their official
  // moves (^DJI / ^RUT) are derived server-side from the index closes
  // their cloud stages store, and arrive inside the cloud payload —
  // App maps them into the same prop shape.
  officialDay: { us: OfficialDay; ndx: OfficialDay; dow: OfficialDay; rut: OfficialDay; cn: OfficialDay };
}) {
  const [market, setMarket] = useState<"us" | "ndx" | "dow" | "rut" | "cn">("us");
  const [viewMode, setViewMode] = useState<"sector" | "industry">("sector");
  const [sectorName, setSectorName] = useState<string | null>(null);
  const [industrySel, setIndustrySel] = useState<string | null>(null);
  const [period, setPeriod] = useState<CloudPeriodKey>("d1");
  const [zoom, setZoom] = useState<1 | 2 | 3>(1);
  // Tile area mode. The default is the compressed "sqrt" （均匀浏览）
  // mode (user direction 2026-11-19): square-root sizing shrinks the
  // ~500× linear market-cap / index-weight range inside the S&P 500
  // to ~22×, so giants still read unmistakably bigger than small caps
  // but mid/small names and the smaller sectors (healthcare,
  // industrials, staples…) get enough area to carry a label, and
  // far more labelled stocks fit on the map. Group (sector) areas are
  // the sum of their stocks' compressed sizes (see groupDispSize), so
  // sector area is compressed too, not true-proportion. Tiles that
  // still cannot carry words are simply not drawn (see the layout
  // fixpoint below). The settings menu keeps a "linear" （真实比例）
  // option for the true-proportion view.
  const [sizeMode, setSizeMode] = useState<"sqrt" | "linear">("sqrt");
  // Session: 收盘 (snapshot closes) vs 盘前 (premarket change captured
  // with the snapshot, US markets only — the reference app's 盘前 pill).
  const [session, setSession] = useState<CloudSession>("close");
  // Which top-bar popover is open (index menu / period menu / settings).
  const [menuOpen, setMenuOpen] = useState<"index" | "period" | "settings" | null>(null);
  const [detail, setDetail] = useState<CloudDetailSel | null>(null);
  // Period selected inside the detail drawer (its pill row).
  const [detailPeriod, setDetailPeriod] = useState<CloudPeriodKey>("d1");
  const emptyMkt: CloudData["us"] = { asOf: "", sizeBasis: market === "cn" || market === "rut" ? "weight" : "cap", unit: market === "cn" ? "元" : "美元", stocks: [] };
  const mkt = cloud
    ? market === "us"
      ? cloud.us
      : market === "ndx"
        ? cloud.ndx
        : market === "dow"
          ? cloud.dow
          : market === "rut"
            ? cloud.rut
            : cloud.cn
    : emptyMkt;
  const indexName = market === "us" ? "标普 500" : market === "ndx" ? "纳斯达克 100" : market === "dow" ? "道琼斯工业平均" : market === "rut" ? "罗素 2000" : "沪深 300";
  // Russell 2000 is a labelled SUBSET (top 200 IWM holdings), never the
  // full ~2,000-name index — every scope sentence for this market must
  // carry the qualifier.
  const isRut = market === "rut";
  const unitSym = market === "cn" ? "¥" : "$";
  const cloudStage = market === "us" ? "cloud-us" : market === "ndx" ? "cloud-ndx" : market === "dow" ? "cloud-dow" : market === "rut" ? "cloud-rut" : "cloud-cn";
  // Constituent-weighted ESTIMATE of an index's day move: the
  // cap/weight-weighted average of its constituents' 1-day returns.
  // This is NOT the official index print and must never be presented
  // as one: the official indices weight by float-adjusted shares with
  // a divisor and day-START weights, while this average uses day-END
  // total market caps — the end-weighting alone biases it upward by
  // roughly the day's cross-sectional return variance (verified
  // 2026-11-18: estimate −0.11% / +0.54% vs official ^GSPC −0.23% /
  // ^NDX +0.42%, a +0.12pp gap on BOTH indices, same sign, same size).
  // The selector buttons therefore show the official values (the
  // officialDay prop); this estimate survives only as a labelled
  // cross-check line under the selector and as the fallback when an
  // official day change is honestly missing.
  const constituentDay = (mm: CloudData["us"] | undefined): number | null => {
    if (!mm || mm.stocks.length === 0) return null;
    let w = 0;
    let n = 0;
    for (const s of mm.stocks) {
      w += s.weight;
      n += s.weight * s.d1;
    }
    return w > 0 ? Math.round((n / w) * 100) / 100 : null;
  };
  // What a selector button actually prints: the official index day
  // move when the dashboard has one, else the labelled estimate.
  const selectorDay = (id: "us" | "ndx" | "dow" | "rut" | "cn", mm: CloudData["us"] | undefined): { day: number | null; official: boolean } => {
    const off = officialDay[id];
    if (off && off.pct != null) return { day: Math.round(off.pct * 100) / 100, official: true };
    return { day: constituentDay(mm), official: false };
  };
  const periodMeta = CLOUD_PERIODS.find((p) => p.id === period) ?? CLOUD_PERIODS[0]!;
  // Premarket coverage of the current snapshot: how many constituents
  // carry a captured premarket change. Zero coverage means the toggle
  // has nothing honest to show — the map then stays on close values
  // and says why, instead of dressing close numbers as premarket.
  const preCount = mkt.stocks.filter((s) => s.pre != null).length;
  const preActive = session === "pre" && market !== "cn" && preCount > 0;
  const effSession: CloudSession = preActive ? "pre" : "close";
  const effPeriod: CloudPeriodKey = preActive ? "d1" : period;
  const effCap = preActive ? CLOUD_PERIODS[0]!.cap : periodMeta.cap;

  const sectors = groupStocks(mkt.stocks, (s) => s.sector, effPeriod, effSession);
  const sector = sectors.find((g) => g.name === sectorName) ?? null;
  const industries = sector ? groupStocks(sector.stocks, (s) => s.industry || "其他", effPeriod, effSession) : [];
  // Industry view: every industry in the whole market as its own group,
  // regardless of which sector it belongs to (US = GICS industry buckets,
  // CN = the Sina/Eastmoney industry classification already on each row).
  const allIndustries = groupStocks(mkt.stocks, (s) => s.industry || "其他", effPeriod, effSession);
  const industryGroup = industrySel ? allIndustries.find((g) => g.name === industrySel) ?? null : null;
  const drilled = sector !== null || industryGroup !== null;

  const pickMarket = (m: "us" | "ndx" | "dow" | "rut" | "cn") => {
    setMarket(m);
    setSectorName(null);
    setIndustrySel(null);
    setDetail(null);
    setSession("close");
    setMenuOpen(null);
  };
  const pickViewMode = (vm: "sector" | "industry") => {
    setViewMode(vm);
    setSectorName(null);
    setIndustrySel(null);
    setDetail(null);
  };
  const pickPeriod = (p: CloudPeriodKey) => {
    setPeriod(p);
    setSession("close");
    setDetail(null);
    setMenuOpen(null);
  };

  // Virtual canvas: 1000 wide; height grows with the zoom level so tiles
  // get physically bigger instead of turning into untappable slivers.
  // On a phone-width container the canvas additionally stretches
  // vertically (PHONE_VH_BOOST, user direction 2026-11-19 22:55): the
  // map is NOT confined to one screenful — the page scrolls and the
  // taller canvas gives every tile more physical height, so together
  // with the compressed (sqrt) sizing far more stocks clear the
  // adaptive label gate and appear with text. Desktop widths
  // keep the base proportions untouched (boost = 1).
  const VW = 1000;
  const PHONE_VH_BOOST = 3.2;
  const baseVH = (drilled ? 1150 : viewMode === "industry" ? 1500 : 1250) * zoom;

  // Display size of one stock under the active area mode. The floor
  // keeps a near-zero-weight stock a visible sliver in sqrt mode; in
  // linear mode a layout-only epsilon (0.001, far below the smallest
  // real index weight) does the same, so EVERY stock lands a tile and
  // no stock silently vanishes from the wall. A group's display size
  // is the sum of its stocks' display sizes, so the two treemap
  // levels stay consistent in both modes.
  const sizeOf = (w: number): number => (sizeMode === "sqrt" ? Math.sqrt(Math.max(w, 0.004)) : Math.max(w, 0.001));
  const groupDispSize = (g: CloudGroup): number => g.stocks.reduce((a, s) => a + sizeOf(s.weight), 0);

  // Physical scale of the treemap: the virtual canvas is VW units wide
  // and renders into the map container's pixel width (the height scales
  // by the same factor — the aspect ratio is preserved). Tile and
  // header-strip label rules are checked against PHYSICAL pixels, not
  // just virtual units: on a phone the container is ~350px wide
  // (tileScale ≈ 0.35), so a tile that comfortably carries type on
  // desktop physically cannot on the phone (M-P1-3 / M-P1-4). The
  // layout partition below uses the same scale: which stocks stay
  // drawn as tiles, at which label tier (4 / 2 / 1 lines), and which
  // are not drawn at all is decided against physical size too, so a
  // tile the phone cannot label even with one line never renders as
  // a colour-only or half-labelled brick.
  const [mapEl, setMapEl] = useState<HTMLDivElement | null>(null);
  const [mapW, setMapW] = useState(0);
  useEffect(() => {
    if (!mapEl) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setMapW(w);
    });
    ro.observe(mapEl);
    return () => ro.disconnect();
  }, [mapEl]);
  const tileScale = mapW > 0 ? mapW / VW : 1;
  // Phone-width containers (< 640px physical) get the tall canvas;
  // anything wider keeps the base height exactly as before.
  const VH = baseVH * (mapW > 0 && mapW < 640 ? PHONE_VH_BOOST : 1);

  // The exact label strings a tile would print for this stock under
  // the active period/session — the adaptive gate (cloudTileTier)
  // checks these real strings, so layout and renderer always agree.
  const tileLabelText = (s: CloudStock): { pctText: string; priceText: string } => {
    const v = cloudVal(s, effPeriod, effSession);
    return {
      pctText: v == null ? "—" : `${signed(v, Math.abs(v) >= 100 ? 0 : 1)}%`,
      priceText: fmt(s.price, 2),
    };
  };

  // Two-level layout: group rects first, then each group's stocks inside
  // the area below the group's header strip. Which grouping feeds the top
  // level depends on the view: sectors (板块视图）, all-market industries
  // （行业视图）, or the drill-down inside one sector / one industry.
  const layout = (() => {
    const groups =
      viewMode === "industry"
        ? industryGroup
          ? [industryGroup]
          : allIndustries
        : sector
          ? industries
          : sectors;
    const groupRects = squarifyInto(
      groups.map((g) => ({ key: g.name, size: groupDispSize(g) })),
      0,
      0,
      VW,
      VH,
    );
    const tiles = new Map<string, TmRect>();
    const headers = new Map<string, { rect: TmRect; headerH: number }>();
    // A tile is drawn only when it can carry at least the one-line
    // adaptive label (name or code, whole) — the exact gate
    // renderTile uses (cloudTileTier checks every label string's
    // real width at the tier it assigns: 4 / 2 / 1 lines), so the
    // layout partition and the rendering can never disagree about
    // whether a tile's words fit untruncated.
    const canLabel = (s: CloudStock, t: TmRect): boolean => {
      const lt = tileLabelText(s);
      return cloudTileTier(s, market, unitSym, t, tileScale, lt.pctText, lt.priceText) !== null;
    };
    for (const g of groups) {
      const r = groupRects.find((x) => x.key === g.name);
      if (!r) continue;
      const headerH = r.h >= 34 ? Math.min(30, Math.max(20, r.h * 0.14)) : 0;
      headers.set(g.name, { rect: r, headerH });
      const ix = r.x + 1.5;
      const iy = r.y + headerH + 1;
      const iw = Math.max(0, r.w - 3);
      const ih = Math.max(0, r.h - headerH - 2.5);
      // Tight packing, no holes, and every drawn tile labelled
      // (user rulings 2026-11-19 22:24 + 2026-11-20): labels are
      // adaptive — big tiles carry four lines, medium two, small
      // one — and only the tail too small for even one whole line
      // is left out. That tail is NOT drawn as colour-only bricks,
      // NOT merged into an 「其他」 aggregate tile and NOT listed in
      // a text strip below the map (the user explicitly rejected
      // all three) — it simply does not appear, and squarifyInto
      // renormalises the survivors to fill the group's inner rect
      // exactly, so the rect stays full with no blank patches.
      // Group header figures (return + breadth counts) still
      // aggregate ALL constituents, drawn or not.
      // Partition and layout iterate to a fixpoint (stocks only ever
      // move shown → hidden, so it terminates): hiding the tail
      // enlarges the survivors, and one final enforcement pass after
      // the loop guarantees no drawn tile is left below the gate.
      // The group's largest stock always stays drawn, even if it
      // alone cannot meet the gate — a group area is never left
      // completely blank (renderTile gives it a compact label).
      let shown = [...g.stocks].sort((a, b) => sizeOf(b.weight) - sizeOf(a.weight));
      const layoutNow = (): TmRect[] =>
        squarifyInto(
          shown.map((s) => ({ key: s.code, size: sizeOf(s.weight) })),
          ix,
          iy,
          iw,
          ih,
        );
      let rects = layoutNow();
      const enforce = (): boolean => {
        const byKey = new Map(rects.map((t) => [t.key, t]));
        let small = shown.filter((s) => {
          const t = byKey.get(s.code);
          return !t || !canLabel(s, t);
        });
        // Never strip a group bare: its largest stock (shown is
        // sorted desc) stays as a tile no matter what.
        if (small.length === shown.length) small = small.slice(1);
        if (small.length === 0) return false;
        const smallSet = new Set(small.map((s) => s.code));
        shown = shown.filter((s) => !smallSet.has(s.code));
        rects = layoutNow();
        return true;
      };
      for (let iter = 0; iter < 20 && shown.length > 1; iter++) {
        if (!enforce()) break;
      }
      if (shown.length > 1) enforce();
      for (const t of rects) {
        tiles.set(t.key, t);
      }
    }
    return { groups, groupRects, tiles, headers };
  })();

  // ▽ corner mark: the largest stock (by true weight) of each
  // sector|industry cluster — the lead tile of a drillable group, the
  // tiles that carry ▽ in the reference app.
  const industryLeaders = new Map<string, string>();
  {
    const best = new Map<string, { code: string; weight: number }>();
    for (const s of mkt.stocks) {
      const k = `${s.sector}|${s.industry || "其他"}`;
      const cur = best.get(k);
      if (!cur || s.weight > cur.weight) best.set(k, { code: s.code, weight: s.weight });
    }
    for (const [k, val] of best) industryLeaders.set(k, val.code);
  }

  const openDetail = (s: CloudStock) => {
    const sec = sectors.find((g) => g.name === s.sector);
    setDetail({ stock: s, sectorName: s.sector, sectorRet: sec?.ret ?? 0 });
    setDetailPeriod(effPeriod);
  };

  // Drawer 「简介 ›」 drill: close the drawer and drill into the
  // stock's industry (industry view) or sector (sector view).
  const drillFromDetail = (stock: CloudStock) => {
    const ind = stock.industry || "其他";
    setDetail(null);
    if (viewMode === "industry") setIndustrySel(ind);
    else setSectorName(stock.sector);
  };

  // Rich per-stock detail (quote / intraday / valuation percentile),
  // fetched on demand for the tapped stock only — never on page entry.
  const detailQ = useQuery({
    queryKey: ["stockDetail", market, detail?.stock.code ?? ""],
    queryFn: () => api.getStockDetail({ market, code: detail?.stock.code ?? "" }),
    enabled: !!detail,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const sd = detailQ.data?.detail;

  // Tile faces carry NO valuation line (user ruling 2026-11-19,
  // V-0): a tile shows name/code + Chinese name / period return /
  // price / market-cap · weight and nothing else. The 5-year PE
  // percentile lives only in the detail drawer, from getStockDetail's
  // peHist — there is no PE-on-tile query at all.

  // No leaders strip above the map: the reference app's wall starts
  // straight at the sector headers (user's 1:1 ruling, 2026-11-19).
  // Contribution rankings still exist — inside the detail drawer
  // （拉动指数百分点） and nowhere above the wall.

  const pct = (r: TmRect) => ({
    left: `${(r.x / VW) * 100}%`,
    top: `${(r.y / VH) * 100}%`,
    width: `${(r.w / VW) * 100}%`,
    height: `${(r.h / VH) * 100}%`,
  });

  const renderTile = (s: CloudStock) => {
    const r = layout.tiles.get(s.code);
    if (!r) return null;
    // Session value: close mode reads the period return; premarket
    // mode reads ONLY the captured premarket change (null = no
    // premarket print for this stock — gray tile, "—" instead of a
    // borrowed close number).
    const v = cloudVal(s, effPeriod, effSession);
    const selected = detail?.stock.code === s.code;
    // A-share tiles lead with the Chinese name (a bare numeric code tells
    // a mainland investor nothing at a glance). US tiles headline the
    // common Chinese name when one exists （苹果/英伟达/亚马逊 — as the
    // reference app does), the ticker otherwise.
    const headline = cloudHeadline(s, market);
    const pctText = v == null ? "—" : `${signed(v, Math.abs(v) >= 100 ? 0 : 1)}%`;
    // Tile faces (user rulings 2026-11-19 22:24 + 2026-11-20):
    // labels adapt to the tile's physical size — level 4 = name/code
    // + Chinese name, return, price, cap · weight (and NOTHING else:
    // no PE line ever; valuation lives in the detail drawer);
    // level 2 = name + return; level 1 = name alone, or the code
    // when the name itself cannot fit whole. cloudTileTier has
    // already verified every printed string fits whole at the
    // tier's sizes, so the spans never truncate, and a tile below
    // level 1 is never drawn (no colour-only brick). The fallback
    // below serves only the layout's keep-largest rule for a group
    // too small to fit even one line: it prints the single shortest
    // whole label (name or code, whichever measures narrower) at
    // 8px — one line, never four squeezed lines.
    const w = r.w;
    const pw = w * tileScale;
    const tier = cloudTileTier(s, market, unitSym, r, tileScale, pctText, fmt(s.price, 2));
    let body: ReactNode;
    if (tier && tier.level === 4) {
      body = (
        <>
          <span className="block whitespace-nowrap font-bold" style={{ fontSize: tier.headPx }}>{tier.headText}</span>
          <span className="block whitespace-nowrap font-medium" style={{ fontSize: tier.pctPx }}>{pctText}</span>
          <span className="block whitespace-nowrap opacity-90" style={{ fontSize: tier.pricePx }}>{fmt(s.price, 2)}</span>
          <span className="block whitespace-nowrap opacity-90" style={{ fontSize: tier.capPx }}>{tier.capText}</span>
        </>
      );
    } else if (tier && tier.level === 2) {
      body = (
        <>
          <span className="block whitespace-nowrap font-bold" style={{ fontSize: tier.headPx }}>{tier.headText}</span>
          <span className="block whitespace-nowrap font-medium" style={{ fontSize: tier.pctPx }}>{pctText}</span>
        </>
      );
    } else if (tier) {
      body = <span className="block whitespace-nowrap font-bold" style={{ fontSize: tier.headPx }}>{tier.headText}</span>;
    } else {
      const fallbackText = cloudTextWidth(headline, 8) <= cloudTextWidth(s.code, 8) ? headline : s.code;
      body = <span className="block whitespace-nowrap text-[8px] font-bold">{fallbackText}</span>;
    }
    // Corner marks, as in the reference: ★ top-left on the user's own
    // watchlist/holding names （美光 in the photo), ▽ top-right on the
    // largest stock of each industry (the drillable cluster's lead
    // tile). Only on labelled tiles big enough to carry them.
    const showStar = market !== "cn" && CLOUD_STAR_CODES.has(s.code) && w >= CLOUD_MIN_TILE_W && pw >= 38;
    const indKey = `${s.sector}|${s.industry || "其他"}`;
    const showCaret = w >= CLOUD_MIN_TILE_W && pw >= 38 && (industryLeaders.get(indKey) ?? "") === s.code;
    const bg = v == null ? "#5a6572" : cloudTileBg(v, effCap);
    const fg = v == null ? "#fff" : cloudTileFg(v, effCap);
    return (
      <button
        key={s.code}
        type="button"
        onClick={() => openDetail(s)}
        aria-label={`${s.name} ${s.code}，${preActive ? "盘前" : periodMeta.label}涨跌 ${v == null ? "暂无" : `${signed(v, 2)}%`}，点击看详情`}
        aria-pressed={selected}
        className="absolute flex min-h-0 flex-col items-center justify-center overflow-hidden p-0.5 text-center align-top leading-tight"
        style={{
          ...pct({ key: s.code, x: r.x + 1, y: r.y + 1, w: Math.max(0, r.w - 2), h: Math.max(0, r.h - 2) }),
          background: bg,
          color: fg,
          boxShadow: selected ? "inset 0 0 0 2.5px #fff" : undefined,
          textShadow: fg === "#000" ? "0 1px 2px rgb(255 255 255 / 0.3)" : "0 1px 2px rgb(0 0 0 / 0.35)",
        }}
      >
        {showStar ? (
          <span className="absolute left-0.5 top-0.5 text-[9px] leading-none" aria-hidden>
            ★
          </span>
        ) : null}
        {showCaret ? (
          <span className="absolute right-0.5 top-0.5 text-[8px] leading-none opacity-80" aria-hidden>
            ▽
          </span>
        ) : null}
        {body}
      </button>
    );
  };

  return (
    <section>
      <CloudToolbar
        stages={stages}
        cloudStage={cloudStage}
        isRut={isRut}
        indexName={indexName}
        asOf={mkt.asOf}
        period={period}
        periodLabel={periodMeta.label}
        preActive={preActive}
        session={session}
        market={market}
        menuOpen={menuOpen}
        viewMode={viewMode}
        sizeMode={sizeMode}
        zoom={zoom}
        indexDay={(id) => selectorDay(id, id === "us" ? cloud?.us : id === "ndx" ? cloud?.ndx : id === "dow" ? cloud?.dow : cloud?.cn)}
        onToggleMenu={(w) => setMenuOpen(menuOpen === w ? null : w)}
        onCloseMenu={() => setMenuOpen(null)}
        onPickPeriod={pickPeriod}
        onToggleSession={() => setSession(session === "pre" ? "close" : "pre")}
        onPickMarket={pickMarket}
        onPickViewMode={pickViewMode}
        onPickSizeMode={(m) => { setSizeMode(m); setDetail(null); }}
        onPickZoom={setZoom}
        onOpenMethod={() => { setMenuOpen(null); goMethod("cloudmap"); }}
      />
      {/* Breadcrumb when drilled into a sector */}
      {sector ? (
        <nav aria-label="云图层级" className="mt-3 flex flex-wrap items-center gap-1 text-sm">
          <button type="button" onClick={() => { setSectorName(null); setDetail(null); }} className="rounded px-1.5 py-1 font-medium text-[var(--accent)]">
            ‹ {indexName}
          </button>
          <span className="text-[var(--dim)]" aria-hidden>›</span>
          <span className="px-1.5 py-1 font-semibold text-[var(--text)]">{sector.name}</span>
          <span className="text-xs text-[var(--dim)]">
            {industries.length} 个行业 · {sector.stocks.length} 只成分股 · 板块{preActive ? "盘前" : periodMeta.label} {signed(sector.ret, 2)}% · 涨跌家数 ↑{cloudBreadth(sector.stocks, effPeriod, effSession).up} →{cloudBreadth(sector.stocks, effPeriod, effSession).flat} ↓{cloudBreadth(sector.stocks, effPeriod, effSession).down}
          </span>
        </nav>
      ) : null}

      {/* Breadcrumb when drilled into one industry （行业视图） */}
      {industryGroup ? (
        <nav aria-label="云图层级" className="mt-3 flex flex-wrap items-center gap-1 text-sm">
          <button type="button" onClick={() => { setIndustrySel(null); setDetail(null); }} className="rounded px-1.5 py-1 font-medium text-[var(--accent)]">
            ‹ {indexName}行业
          </button>
          <span className="text-[var(--dim)]" aria-hidden>›</span>
          <span className="px-1.5 py-1 font-semibold text-[var(--text)]">{industryGroup.name}</span>
          <span className="text-xs text-[var(--dim)]">
            {industryGroup.stocks.length} 只成分股 · 行业{preActive ? "盘前" : periodMeta.label} {signed(industryGroup.ret, 2)}% · 涨跌家数 ↑{cloudBreadth(industryGroup.stocks, effPeriod, effSession).up} →{cloudBreadth(industryGroup.stocks, effPeriod, effSession).flat} ↓{cloudBreadth(industryGroup.stocks, effPeriod, effSession).down}
          </span>
        </nav>
      ) : null}

      {!cloud ? (
        <p className="py-10 text-center text-sm text-[var(--dim)]">{CLOUD_LOADING_TEXT}</p>
      ) : mkt.stocks.length === 0 ? (
        <p className="py-10 text-center text-sm leading-relaxed text-[var(--dim)]">
          {isRut
            ? CLOUD_RUT_EMPTY_TEXT
            : cloudEmptyText(indexName)}
        </p>
      ) : (
        <>
          <div
            ref={(el) => {
              setMapEl(el);
            }}
            className="relative w-full overflow-hidden rounded-b-[var(--radius)]"
            style={{ aspectRatio: `${VW} / ${VH}`, background: "#131a24" }}
            role="group"
            aria-label={sector ? `${sector.name}板块行业云图` : industryGroup ? `${industryGroup.name}行业个股云图` : viewMode === "industry" ? `${indexName}全市场行业云图` : `${indexName}全市场云图`}
          >
            {/* Group header strips */}
            {layout.groups.map((g) => {
              const info = layout.headers.get(g.name);
              if (!info) return null;
              const { rect } = info;
              // F-P2-3: a group shorter than 34 virtual px gets headerH
              // 0 in the layout — it used to render NO strip at all:
              // unlabelled, and undrillable since the strip is the
              // drill-down target. It now gets a minimal overlay strip
              // (≤15 virtual px, never taller than the group itself)
              // over the top of its tiles at a higher z-order. The
              // layout, tile areas and the tail handling is untouched
              // — the tiles keep their full area underneath — and the
              // strip is a real button on phone and desktop alike.
              const tiny = info.headerH <= 0;
              const headerH = tiny ? Math.min(15, rect.h) : info.headerH;
              // Industry overview: a wide industry strip also names its
              // largest constituent （龙头）, as the reference app does.
              const topStock = [...g.stocks].sort((a, b) => b.weight - a.weight)[0];
              // The 龙头 suffix only when the strip is also PHYSICALLY
              // wide enough to carry it (M-P1-4: phone strips stay short).
              const stripPw = rect.w * tileScale;
              const stripName =
                viewMode === "industry" && !industryGroup && rect.w >= 430 && stripPw >= 240 && topStock
                  ? `${g.name} · ${cloudHeadline(topStock, market)}`
                  : g.name;
              // Breadth counts on every group strip （板块/行业两层都有）:
              // 科技 › ↑37 →11 ↓42 +0.14%. F-P2-2: the counts come in
              // three tiers by PHYSICAL strip width — full ↑n →n ↓n on
              // wide strips; a compact ↑n ↓n (flat count dropped, 8px)
              // as soon as the strip can carry it, which brings the
              // counts back onto most phone strips that used to show
              // none; below that the counts stay off the strip (never
              // clipped mid-glyph) and live in the aria-label and in
              // the drill-down breadcrumb line instead (M-P1-4). A
              // phone strip too narrow for even name + return drops
              // the return, then the name, rather than clipping (the
              // strip stays tappable, aria-label carries the figures).
              const b = cloudBreadth(g.stocks, effPeriod, effSession);
              // Fit by measured text width, not fixed thresholds: an
              // element is shown only when its whole string fits the
              // strip's physical width, so a strip never prints a
              // half-cut name like 「通…」 (user ruling 2026-11-19
              // 22:24 — nothing truncated anywhere on the wall).
              const nameW = cloudTextWidth(`${stripName} ›`, 10);
              const pctW = cloudTextWidth(`${signed(g.ret, 2)}%`, 10);
              const fullCountsW = cloudTextWidth(`↑${b.up} →${b.flat} ↓${b.down}`, 9);
              const compactCountsW = cloudTextWidth(`↑${b.up} ↓${b.down}`, 8);
              const showStripName = stripPw >= nameW + 4;
              const restW = stripPw - (showStripName ? nameW + 6 : 0);
              // A strip narrower than its own horizontal padding
              // (px-1.5 = 12px) would be floored to 12px wide by the
              // padding and spill past the map's right edge, where the
              // container clips it — narrow strips shrink the padding
              // instead, and every strip clips its content internally.
              const stripPad = stripPw < 40 ? "px-0.5" : "px-1.5";
              const countsTier = restW >= fullCountsW + pctW + 8 ? "full" : restW >= compactCountsW + pctW + 6 ? "compact" : "none";
              const showStripPct = restW - (countsTier === "full" ? fullCountsW + 4 : countsTier === "compact" ? compactCountsW + 4 : 0) >= pctW + 2;
              const strip = (
                <>
                  {showStripName ? <span className={`min-w-0 truncate font-medium leading-none text-white/85 ${tiny ? "text-[9px]" : "text-[10px]"}`}>{stripName} ›</span> : null}
                  {countsTier === "full" ? (
                    <span className="ml-auto shrink-0 text-[9px] font-medium leading-none text-white/60">
                      ↑{b.up} →{b.flat} ↓{b.down}
                    </span>
                  ) : countsTier === "compact" ? (
                    <span className="ml-auto shrink-0 text-[8px] font-medium leading-none text-white/60">
                      ↑{b.up} ↓{b.down}
                    </span>
                  ) : null}
                  {showStripPct ? (
                    <span className="shrink-0 text-[10px] font-semibold leading-none" style={{ color: cloudPctColor(g.ret) }}>
                      {signed(g.ret, 2)}%
                    </span>
                  ) : null}
                </>
              );
              const style: Record<string, string> = {
                left: `${(rect.x / VW) * 100}%`,
                top: `${(rect.y / VH) * 100}%`,
                width: `${(rect.w / VW) * 100}%`,
                height: `${(headerH / VH) * 100}%`,
                // A tiny group's strip overlays live tiles, so it sits
                // above them (z-order) on a more opaque ground; a
                // normal strip keeps the lighter ground in its own
                // reserved band above the tiles.
                background: tiny ? "rgb(10 14 20 / 0.78)" : "rgb(10 14 20 / 0.55)",
                ...(tiny ? { zIndex: "5" } : {}),
              };
              return drilled ? (
                <div key={g.name} className={`absolute flex min-h-0 items-center justify-between gap-1 overflow-hidden ${stripPad}`} style={tiny ? { ...style, pointerEvents: "none" } : style} aria-hidden>
                  {strip}
                </div>
              ) : (
                <button
                  key={g.name}
                  type="button"
                  onClick={() => {
                    if (viewMode === "industry") setIndustrySel(g.name);
                    else setSectorName(g.name);
                    setDetail(null);
                  }}
                  aria-label={`进入${g.name}${viewMode === "industry" ? "行业" : "板块"}，${periodMeta.label}涨跌 ${signed(g.ret, 2)}%，上涨 ${b.up} 只、平盘 ${b.flat} 只、下跌 ${b.down} 只`}
                  className={`absolute flex min-h-0 items-center justify-between gap-1 overflow-hidden text-left ${stripPad}`}
                  style={style}
                >
                  {strip}
                </button>
              );
            })}
            {/* Stock tiles — drawn at their adaptive label tier
                (4 / 2 / 1 lines by physical size); the tail too
                small for even one line appears nowhere (no aggregate
                tile, no strip below the map), and the drawn tiles
                renormalise to fill the whole wall. */}
            {layout.groups.flatMap((g) => g.stocks.map((s) => renderTile(s)))}
          </div>

          {detail ? (
            <CloudDetail
              detail={detail}
              indexName={indexName}
              stocks={mkt.stocks}
              market={market}
              viewMode={viewMode}
              sd={sd}
              loading={detailQ.isLoading}
              detailPeriod={detailPeriod}
              onPeriodChange={setDetailPeriod}
              effSession={effSession}
              onClose={() => setDetail(null)}
              onSelectPeer={openDetail}
              onDrill={drillFromDetail}
            />
          ) : null}
        </>
      )}
    </section>
  );
}
