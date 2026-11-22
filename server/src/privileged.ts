// Privileged (host-capable) handlers for the margin module (v108).
//
// FINRA's margin statistics ship as an .xlsx workbook — a zip archive
// whose entries are DEFLATE-compressed XML. Decompressing it needs
// node:zlib, which action code may not import, so the download +
// unzip + sheet parse live here behind a typed contract; actions.ts
// calls ctx.executePrivileged and receives plain rows. The workbook
// is a 21 KB single-sheet file (shared strings + one worksheet), so a
// minimal read-only zip reader suffices — no dependency.

import { inflateRawSync } from "node:zlib";
import { definePrivilegedContracts, definePrivilegedHandlers, z } from "@hatch/space-sdk";

export const privileged = definePrivilegedContracts({
  fetchFinraMargin: {
    request: z.object({}),
    response: z.object({
      rows: z.array(
        z.object({
          month: z.string(), // "2026-10"
          debt: z.number(), // debit balances, $ millions
          cash: z.number().nullable(), // free credit balances, cash accounts
          marginCredit: z.number().nullable(), // free credit balances, margin accounts
        }),
      ),
    }),
    timeoutMs: 60000,
  },
});

type FinraRow = z.infer<typeof privileged.fetchFinraMargin.response>["rows"][number];

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

function unzipEntryText(buf: Uint8Array, name: string): string | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const fname = dec.decode(buf.subarray(off + 46, off + 46 + nameLen));
    if (fname === name) {
      if (csize === 0xffffffff) return null; // zip64 — not this file
      const dataStart = localOff + 30 + dv.getUint16(localOff + 26, true) + dv.getUint16(localOff + 28, true);
      const comp = buf.subarray(dataStart, dataStart + csize);
      const raw = method === 8 ? inflateRawSync(comp) : comp;
      return dec.decode(raw);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function parseFinraXlsx(buf: Uint8Array): FinraRow[] {
  const ssXml = unzipEntryText(buf, "xl/sharedStrings.xml");
  const sheetXml = unzipEntryText(buf, "xl/worksheets/sheet1.xml");
  if (!ssXml || !sheetXml) throw new Error("FINRA xlsx 结构变化（缺 sharedStrings / sheet1）");
  const strings: string[] = [];
  for (const m of ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const t = [...(m[1] ?? "").matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1] ?? "").join("");
    strings.push(xmlUnescape(t));
  }
  const rows: FinraRow[] = [];
  for (const rm of sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = new Map<string, string>();
    for (const cm of (rm[1] ?? "").matchAll(/<c\s+([^>]*?)(?:\/>|>(?:<v>([\s\S]*?)<\/v>)?<\/c>)/g)) {
      const attrs = cm[1] ?? "";
      const v = cm[2];
      if (v === undefined) continue;
      const col = /r="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? "";
      if (!col) continue;
      cells.set(col, /t="s"/.test(attrs) ? (strings[Number(v)] ?? "") : v);
    }
    const month = cells.get("A") ?? "";
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const debt = Number(cells.get("B"));
    if (!Number.isFinite(debt) || debt <= 0) continue;
    const cash = Number(cells.get("C"));
    const mc = Number(cells.get("D"));
    rows.push({
      month,
      debt,
      cash: Number.isFinite(cash) && cash > 0 ? cash : null,
      marginCredit: Number.isFinite(mc) && mc > 0 ? mc : null,
    });
  }
  rows.sort((a, b) => (a.month < b.month ? -1 : 1));
  if (rows.length < 24) throw new Error(`FINRA xlsx 行数异常（${rows.length}）`);
  return rows;
}

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  async fetchFinraMargin() {
    const res = await fetch("https://www.finra.org/sites/default/files/2021-03/margin-statistics.xlsx", {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`FINRA xlsx HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length < 1000 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
      throw new Error("FINRA xlsx 返回非 Excel 文件（可能被拦截页替换）");
    }
    return { rows: parseFinraXlsx(buf) };
  },
});
