// Cloud map （云图） shared types. CloudData/CloudStock derive from the
// getCloud action response, so client and server can never drift apart.
import type { api, ApiResponse } from "../api";

export type CloudData = ApiResponse<typeof api, "getCloud">["cloud"];
export type CloudStock = CloudData["us"]["stocks"][number];
export type CloudPeriodKey = "d1" | "w1" | "m1" | "m3" | "m6" | "ytd" | "y1";
export type CloudSession = "close" | "pre";
export type TmRect = { key: string; x: number; y: number; w: number; h: number };
export type CloudGroup = { name: string; stocks: CloudStock[]; ret: number; weight: number };
export type CloudDetailSel = { stock: CloudStock; sectorName: string; sectorRet: number };
export type OfficialDay = { pct: number | null; date: string } | null;
export type CloudMarketId = "us" | "ndx" | "dow" | "rut" | "cn";
export type StockDetail = ApiResponse<typeof api, "getStockDetail">["detail"];
