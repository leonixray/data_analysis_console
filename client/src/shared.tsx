// Shared formatting helpers and small building blocks used by
// App.tsx and the cloud module (client/src/cloud/). Moved verbatim
// out of App.tsx in the 2026-11-19 cloud split; behaviour unchanged.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { api, ApiResponse } from "./api";

type Stages = ApiResponse<typeof api, "getDashboard">["stages"];

export function fmt(v: number, decimals: number): string {
  return v.toLocaleString("zh-CN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function signed(v: number, decimals: number): string {
  return `${v > 0 ? "+" : ""}${fmt(v, decimals)}`;
}

export function SectionHead({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="flex gap-3">
      <span aria-hidden className="mt-1.5 w-1 shrink-0 rounded-full bg-[var(--accent)]" />
      <div className="min-w-0">
        <h2 className="font-serif-sc text-xl font-black text-[var(--text)]">{title}</h2>
        {desc ? <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">{desc}</p> : null}
      </div>
    </div>
  );
}

/** Per-stage freshness label: when did this block's data last land?
 *  Blocks whose stage hasn't run in this session keep their stored time —
 *  that visible difference is how cached data and fresh data are told
 *  apart. D-P2-5: NO fallback to the "all"/"legacy" full-refresh rows —
 *  a block that has never had a staged refresh of its own must not
 *  borrow the full-refresh time and look freshly updated; it says
 *  尚未分块刷新 instead. */
export function stageTimeText(stages: Stages, stage: string): string {
  const s = stages.find((x) => x.stage === stage);
  if (!s) return "尚未分块刷新";
  return new Date(s.finishedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

/** Horizontal-scroll wrapper for wide tables. When (and only when) the
 *  content is wider than the viewport AND the user hasn't scrolled yet,
 *  it shows a right-edge fade plus a 「可左右滑动」 pill so the hidden
 *  right-hand columns are discoverable on a phone. The hint disappears
 *  as soon as the user scrolls sideways, and never renders when the
 *  table fits. `fadeBg` must match the surface the table card sits on
 *  so the gradient blends into the card edge. */
export function ScrollHint({
  className,
  fadeBg = "var(--surface)",
  children,
}: {
  className?: string;
  fadeBg?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hint, setHint] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () =>
      setHint(el.scrollWidth > el.clientWidth + 1 && el.scrollLeft <= 1);
    update();
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      el.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [children]);
  return (
    <div className="relative">
      <div ref={ref} className={className}>
        {children}
      </div>
      {hint ? (
        <>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 w-10"
            style={{ background: `linear-gradient(to right, transparent, ${fadeBg})` }}
          />
          <span
            aria-hidden
            className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-[var(--chip-bg)] px-2 py-1 text-[11px] leading-none text-[var(--chip-text)] shadow"
          >
            可左右滑动 »
          </span>
        </>
      ) : null}
    </div>
  );
}

/** One-line per-block freshness note for module pages: which refresh
 *  stage(s) this page's data comes from, and when each last landed. */
export function FreshLine({ stages, items }: { stages: Stages; items: [string, string][] }) {
  return (
    <p className="mb-2 text-[11px] text-[var(--dim)]">
      本页数据更新于 {items.map(([label, st]) => `${label} ${stageTimeText(stages, st)}`).join(" · ")}
    </p>
  );
}
