// Cloud map （云图） pure helpers: period returns, tile colours,
// formatting, the squarified treemap layout and group aggregation.
// Moved verbatim out of App.tsx in the 2026-11-19 cloud split.
import type { CloudGroup, CloudPeriodKey, CloudSession, CloudStock, TmRect } from "./types";

// Tile labels are ADAPTIVE (user ruling 2026-11-20: follow the
// reference app's heatmap — big tiles carry more lines, small tiles
// fewer, and the smallest tail tiles are dropped entirely):
//   · large tile — the full four lines (name/code, period return,
//     price, market-cap · weight);
//   · medium tile — two lines (name + period return);
//   · small tile — one line (name only; when the name itself is too
//     long to fit whole, the ticker/code takes its place);
//   · a tile that cannot fit even that one line whole is NOT drawn
//     at all — no colour-only brick, no half-cut label like
//     「维萨/万…」, no 「其他」 aggregate tile, no text strip below
//     the map (the no-truncation / no-aggregate rulings of
//     2026-11-19 22:24 still hold). Font sizes scale down with the
//     tile, so far more stocks clear the gate than under the old
//     four-lines-or-nothing rule. The gate is cloudTileTier below:
// it checks PHYSICAL size (a phone renders the 1000-unit canvas at
// ~0.35×) plus the estimated rendered width of the actual label
// strings (headline, return, price and cap line alike), so the
// layout partition and the renderer can never disagree about
// whether a tile's words fit whole at its tier. Drawn stocks
// renormalise to fill their group's rect exactly, so hiding the
// tail never leaves a blank patch.
// CLOUD_MIN_TILE_* survive only as the corner-mark (★/▽) gate.
export const CLOUD_MIN_TILE_W = 66;
export const CLOUD_MIN_TILE_H = 36;

export function cloudRet(s: CloudStock, p: CloudPeriodKey): number {
  if (p === "d1") return s.d1;
  return s[p] ?? s.d1;
}

/** Session-aware tile value. 收盘态 reads the snapshot's close-based
 *  period returns; 盘前态 reads ONLY the premarket change captured
 *  with the snapshot (US markets) — the two sessions never mix for one
 *  stock: a stock whose quote carried no premarket field returns null
 *  here and paints as a gray "—" tile in premarket mode, never as its
 *  close number wearing a premarket label. */
export function cloudVal(s: CloudStock, p: CloudPeriodKey, session: CloudSession): number | null {
  if (session === "pre") return s.pre;
  return cloudRet(s, p);
}

/** US tickers the user holds or watches (from their watchlist): the
 *  reference app stars its marked tiles （美光科技 ★ in the photo);
 *  here the star marks the user's own names so they stand out on the
 *  wall. A-shares have no equivalent mark in the reference. */
export const CLOUD_STAR_CODES = new Set(["MU", "GOOGL", "AVGO", "AAPL", "TSLA", "NVDA", "BE"]);

/** Neutral band: |return| below ~0.2% is not a move at all — the
 *  reference app paints 苹果 +0.15% / PLTR +0.1% / 沃尔玛 −0.13% slate
 *  gray while 微软 +0.40% is already coloured. Same band drives the
 *  group-header breadth counts (flat = inside the band). */
export const CLOUD_NEUTRAL = 0.2;

/** Tile color on the map's own dark slate panel (same in both themes):
 *  RED up / GREEN down — the page-wide 红涨绿跌 convention, same as
 *  every other module; depth ∝ |value| up to the period cap; anything
 *  inside the neutral band reads as slate gray. Returns [hue,
 *  saturation, lightness] or null for the neutral slate.
 *  Direction history: the tiles briefly followed the reference app's
 *  green-up / red-down during the 2026-11-19 1:1 rebuild, but the
 *  colour convention is an open D2 decision the user has not made, so
 *  the cloud map was restored to the site-wide 红涨绿跌 the same day —
 *  do not re-scope the cloud surface to the reference app's colours
 *  unless the user rules on D2. */
export function cloudTileHsl(v: number, cap: number): [number, number, number] | null {
  if (v > CLOUD_NEUTRAL) {
    const t = Math.min(1, v / cap);
    return [4, 72, 33 + t * 23];
  }
  if (v < -CLOUD_NEUTRAL) {
    const t = Math.min(1, -v / cap);
    return [156, 52, 26 + t * 16];
  }
  return null;
}

export function cloudTileBg(v: number, cap: number): string {
  const hsl = cloudTileHsl(v, cap);
  return hsl ? `hsl(${hsl[0]} ${hsl[1]}% ${hsl[2]}%)` : "#5a6572";
}

/** Tile text color: black on the red/green tiles, white on the gray
 *  neutral tiles. The switch points are the computed crossovers where
 *  black overtakes white (red lightness ≈51, green ≈34; both sit at
 *  ≈4.58:1 there), so every tile keeps ≥4.5:1 contrast. */
export function cloudTileFg(v: number, cap: number): string {
  const hsl = cloudTileHsl(v, cap);
  if (!hsl) return "#fff";
  return hsl[2] >= (hsl[0] === 4 ? 51 : 34) ? "#000" : "#fff";
}

export function cloudPctColor(v: number): string {
  if (v > CLOUD_NEUTRAL) return "#ff9d8a";
  if (v < -CLOUD_NEUTRAL) return "#63d68f";
  return "#aeb8c2";
}

/** Breadth of one group for the selected period: how many constituents
 *  rose / sat inside the neutral band / fell （科技 ↑37 →11 ↓42).
 *  Stocks with no value in the active session (premarket gaps) are
 *  simply not counted — never borrowed from the other session. */
export function cloudBreadth(stocks: CloudStock[], p: CloudPeriodKey, session: CloudSession = "close"): { up: number; flat: number; down: number } {
  let up = 0;
  let flat = 0;
  let down = 0;
  for (const s of stocks) {
    const v = cloudVal(s, p, session);
    if (v == null) continue;
    if (v > CLOUD_NEUTRAL) up++;
    else if (v < -CLOUD_NEUTRAL) down++;
    else flat++;
  }
  return { up, flat, down };
}

/** Tile headline for a US/NDX stock: the common Chinese name when one
 *  exists （苹果/英伟达/亚马逊…）, the ticker otherwise. A-shares always
 *  headline the Chinese name (handled at the call site). */
export function cloudHeadline(s: CloudStock, market: string): string {
  if (market === "cn") return s.name;
  return s.zh ?? s.code;
}

export function cloudSubline(s: CloudStock, market: string): string {
  if (market === "cn") return s.code;
  return s.zh ? s.code : s.name;
}

/** "2026-11-18" → "11月18日" (the detail drawer's date style). */
export function fmtMonthDay(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? `${Number(m[2])}月${Number(m[3])}日` : d;
}

/** Compact volume （股） in Chinese magnitude units. */
export function fmtVol(v: number): string {
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
  return `${Math.round(v)}`;
}

/** Absolute market cap in Chinese magnitude units （万亿/亿）, prefixed
 *  with the market's currency symbol. Caps arrive in local currency
 *  (USD for US stocks, CNY for A-shares) from the Yahoo quote leg. */
export function fmtCap(cap: number, sym: string): string {
  if (cap >= 1e12) return `${sym}${(cap / 1e12).toFixed(2)}万亿`;
  if (cap >= 1e11) return `${sym}${(cap / 1e8).toFixed(0)}亿`;
  if (cap >= 1e8) return `${sym}${(cap / 1e8).toFixed(1)}亿`;
  return `${sym}${(cap / 1e4).toFixed(0)}万`;
}

export function fmtWeightPct(w: number): string {
  return `${w >= 0.1 ? w.toFixed(2) : w.toFixed(3)}%`;
}

/** Conservative rendered-width estimate (physical px) for a label
 *  string at a given font size: CJK glyphs are full-width, digits a
 *  bit over 0.6em, latin bold up to ~0.74em. Deliberately biased wide
 *  so a tile that passes the gate never ellipsises in the browser. */
export function cloudTextWidth(text: string, px: number): number {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp > 0x2e7f) w += px * 1.06;
    else if (ch === " ") w += px * 0.4;
    else if (ch >= "0" && ch <= "9") w += px * 0.66;
    else w += px * 0.74;
  }
  return w;
}

export type CloudTileTier = {
  /** How many label lines this tile carries: 4 (full), 2 (name +
   *  return) or 1 (name/code only). */
  level: 4 | 2 | 1;
  headPx: number;
  pctPx: number;
  pricePx: number;
  capPx: number;
  headText: string;
  capText: string;
};

/** Adaptive label gate + tier picker for one stock in one rect
 *  (user ruling 2026-11-20). Tries the richest label first and
 *  degrades by DROPPING WHOLE LINES — never by cutting a string:
 *  level 4 = headline / return / price / cap · weight, level 2 =
 *  headline / return, level 1 = headline alone (falling back to the
 *  bare code when the name itself does not fit whole). Inside a
 *  level, the headline first tries name + subline, then the name
 *  alone, then the code, and the cap line first tries its tier
 *  size, then 8px, then weight-only — a smaller complete line beats
 *  a bigger partial one. Font sizes step down with the tile.
 *  Returns null when not even one line fits whole: the stock is
 *  then not drawn at all. `pctText` / `priceText` are the exact
 *  strings the renderer will print, so every line's real width is
 *  checked, not estimated from a template. All thresholds are
 *  PHYSICAL pixels (rect × tileScale): line stacks need ≈ their
 *  summed line-heights (≈1.2 × font size per line, +4px padding) —
 *  level 4 ≈ 44–64px tall, level 2 ≈ 23–32px, level 1 ≈ 14–17px. */
export function cloudTileTier(
  s: CloudStock,
  market: string,
  unitSym: string,
  r: TmRect,
  tileScale: number,
  pctText: string,
  priceText: string,
): CloudTileTier | null {
  const pw = r.w * tileScale;
  const ph = r.h * tileScale;
  const headline = cloudHeadline(s, market);
  const subline = cloudSubline(s, market);
  const fullHead = subline && subline !== headline ? `${headline} ${subline}` : headline;
  const fullCap = s.cap != null ? `${fmtCap(s.cap, unitSym)} · ${fmtWeightPct(s.weight)}` : `权重 ${fmtWeightPct(s.weight)}`;
  const weightOnly = `权重 ${fmtWeightPct(s.weight)}`;
  const fits = (text: string, px: number, pad: number): boolean => cloudTextWidth(text, px) <= pw - pad;
  // First candidate that fits WHOLE at this size, else null.
  const pickHead = (candidates: string[], px: number, pad: number): string | null => {
    for (const c of candidates) {
      if (c && fits(c, px, pad)) return c;
    }
    return null;
  };
  const stackH = (sizes: number[]): number => sizes.reduce((a, px) => a + px * 1.2, 0) + 4;

  // Level 4 — the complete four lines, largest type first.
  const fullCombos: { headPx: number; pctPx: number; pricePx: number; capPx: number }[] = [
    { headPx: 17, pctPx: 12, pricePx: 11, capPx: 10 },
    { headPx: 15, pctPx: 12, pricePx: 11, capPx: 10 },
    { headPx: 13, pctPx: 12, pricePx: 11, capPx: 10 },
    { headPx: 10, pctPx: 9, pricePx: 9, capPx: 8 },
    { headPx: 9, pctPx: 8, pricePx: 8, capPx: 8 },
  ];
  for (const c of fullCombos) {
    if (ph < stackH([c.headPx, c.pctPx, c.pricePx, c.capPx])) continue;
    const headText = pickHead([fullHead, headline, s.code], c.headPx, 6);
    if (headText == null) continue;
    if (!fits(pctText, c.pctPx, 6) || !fits(priceText, c.pricePx, 6)) continue;
    // The cap line first tries its tier size, then 8px, before it
    // drops the 市值 half and keeps 权重 only.
    let cap: { text: string; px: number } | null = null;
    if (fits(fullCap, c.capPx, 6)) cap = { text: fullCap, px: c.capPx };
    else if (c.capPx > 8 && fits(fullCap, 8, 6)) cap = { text: fullCap, px: 8 };
    else if (fits(weightOnly, c.capPx, 6)) cap = { text: weightOnly, px: c.capPx };
    else if (c.capPx > 8 && fits(weightOnly, 8, 6)) cap = { text: weightOnly, px: 8 };
    if (cap == null) continue;
    return { level: 4, headPx: c.headPx, pctPx: c.pctPx, pricePx: c.pricePx, capPx: cap.px, headText, capText: cap.text };
  }

  // Level 2 — name + period return.
  const midCombos: { headPx: number; pctPx: number }[] = [
    { headPx: 12, pctPx: 11 },
    { headPx: 11, pctPx: 10 },
    { headPx: 10, pctPx: 9 },
    { headPx: 9, pctPx: 8 },
    { headPx: 8, pctPx: 8 },
  ];
  for (const c of midCombos) {
    if (ph < stackH([c.headPx, c.pctPx])) continue;
    const headText = pickHead([fullHead, headline, s.code], c.headPx, 6);
    if (headText == null) continue;
    if (!fits(pctText, c.pctPx, 6)) continue;
    return { level: 2, headPx: c.headPx, pctPx: c.pctPx, pricePx: 0, capPx: 0, headText, capText: "" };
  }

  // Level 1 — one line only: the name, or the code when the name
  // itself cannot fit whole at the smallest legible size.
  for (const headPx of [11, 10, 9, 8]) {
    if (ph < stackH([headPx])) continue;
    const headText = pickHead([headline, s.code], headPx, 4);
    if (headText == null) continue;
    return { level: 1, headPx, pctPx: 0, pricePx: 0, capPx: 0, headText, capText: "" };
  }
  return null;
}


/** Squarified treemap layout inside an arbitrary virtual rect. */
export function squarifyInto(
  items: { key: string; size: number }[],
  x0: number,
  y0: number,
  width: number,
  height: number,
): TmRect[] {
  const total = items.reduce((a, i) => a + Math.max(i.size, 0), 0);
  if (total <= 0 || width <= 0 || height <= 0) return [];
  const scaled = items
    .map((i) => ({ key: i.key, area: (Math.max(i.size, 0) / total) * width * height }))
    .filter((i) => i.area > 0)
    .sort((a, b) => b.area - a.area);
  const rects: TmRect[] = [];
  let row: { key: string; area: number }[] = [];
  let rx = x0;
  let ry = y0;
  let rw = width;
  let rh = height;
  const worst = (r: { area: number }[], side: number) => {
    const s = r.reduce((a, x) => a + x.area, 0);
    if (s <= 0) return Infinity;
    const mx = Math.max(...r.map((x) => x.area));
    const mn = Math.min(...r.map((x) => x.area));
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };
  const layoutRow = () => {
    const s = row.reduce((a, x) => a + x.area, 0);
    if (rw >= rh) {
      const colW = s / rh;
      let cy = ry;
      for (const r of row) {
        const hh = r.area / colW;
        rects.push({ key: r.key, x: rx, y: cy, w: colW, h: hh });
        cy += hh;
      }
      rx += colW;
      rw -= colW;
    } else {
      const rowH = s / rw;
      let cx = rx;
      for (const r of row) {
        const ww = r.area / rowH;
        rects.push({ key: r.key, x: cx, y: ry, w: ww, h: rowH });
        cx += ww;
      }
      ry += rowH;
      rh -= rowH;
    }
    row = [];
  };
  for (const it of scaled) {
    const side = Math.min(rw, rh);
    if (row.length === 0 || worst(row, side) >= worst([...row, it], side)) {
      row.push(it);
    } else {
      layoutRow();
      row.push(it);
    }
  }
  if (row.length > 0) layoutRow();
  return rects;
}


export function groupStocks(stocks: CloudStock[], by: (s: CloudStock) => string, period: CloudPeriodKey, session: CloudSession = "close"): CloudGroup[] {
  const map = new Map<string, CloudStock[]>();
  for (const s of stocks) {
    const k = by(s);
    const arr = map.get(k) ?? [];
    arr.push(s);
    map.set(k, arr);
  }
  const groups: CloudGroup[] = [];
  for (const [name, arr] of map) {
    let wsum = 0;
    let num = 0;
    for (const s of arr) {
      const v = cloudVal(s, period, session);
      if (v == null) continue;
      wsum += s.weight;
      num += s.weight * v;
    }
    groups.push({ name, stocks: arr, ret: wsum > 0 ? num / wsum : 0, weight: wsum });
  }
  return groups.sort((a, b) => b.weight - a.weight);
}
