// Minimal standalone replacement for `@hatch/space-sdk/client`.
//
// The tower's client imports `createActionClient`, `spaceQueryClient` and
// `SafeAreaTopScrim` from the Muse SDK, which is not on npm. This file
// re-implements the three with the same wire protocol and the same
// observable behaviour, so `client/src/*` runs unchanged under plain Bun:
//
// - `createActionClient` POSTs `{action, args, actionCallId}` to
//   `./actions` and returns `body.data`; non-OK responses become
//   `SpaceActionError` (same fields the SDK carries: status, retryAfterMs,
//   retrySafe, code, issues, detail).
// - `spaceQueryClient` is a TanStack QueryClient with the SDK's defaults
//   (30s staleTime, no refetch on focus, retry only retry-safe action
//   errors, exponential backoff with jitter).
// - `SafeAreaTopScrim` is the same fixed top safe-area scrim.
//
// Viewer APIs (`getSpaceViewer` etc.) have no host in standalone mode:
// they resolve to `null` / no-op. There is no cross-client invalidation
// broadcast here — each browser tab refetches on its own staleTime.

import { QueryClient, MutationCache } from "@tanstack/react-query";
import { createElement, type CSSProperties, type HTMLAttributes } from "react";
import type { infer as ZodInfer, input as ZodInput, ZodType } from "zod";

// ---------------------------------------------------------------------------
// Errors & retry policy (same semantics as the SDK)
// ---------------------------------------------------------------------------

export interface SpaceActionIssue {
  readonly path: readonly string[];
  readonly message: string;
}

export class SpaceActionError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number | undefined;
  readonly retrySafe: boolean;
  readonly code?: string | undefined;
  readonly issues: readonly SpaceActionIssue[];
  readonly detail: string;

  constructor(
    message: string,
    status: number,
    retryAfterMs?: number | undefined,
    retrySafe = false,
    code?: string | undefined,
    issues: readonly SpaceActionIssue[] = [],
    detail: string = message,
  ) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.retrySafe = retrySafe;
    this.code = code;
    this.issues = issues;
    this.detail = detail;
    this.name = "SpaceActionError";
  }
}

export const PERMANENT_ACTION_STATUSES: Set<number> = new Set([
  400, 401, 403, 404, 409, 413, 415, 422,
]);
export const MAX_ACTION_RETRIES = 3;

const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 30_000;
const OUTCOME_UNKNOWN_MESSAGE =
  "The app could not confirm the result. Reload to check your changes before trying again.";

export function shouldRetryAction(failureCount: number, error: unknown): boolean {
  if (error instanceof SpaceActionError && PERMANENT_ACTION_STATUSES.has(error.status)) {
    return false;
  }
  return error instanceof SpaceActionError && error.retrySafe && failureCount < MAX_ACTION_RETRIES;
}

export function actionRetryDelay(failureCount: number, error: unknown): number {
  const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** failureCount);
  const floor =
    error instanceof SpaceActionError && error.retryAfterMs != null
      ? Math.min(RETRY_CAP_MS, Math.max(0, error.retryAfterMs))
      : 0;
  return floor + Math.random() * ceiling;
}

// ---------------------------------------------------------------------------
// Typed RPC client
// ---------------------------------------------------------------------------

type ClientActionShape = {
  request: ZodType;
  response: ZodType;
};

type ActionResponse<A extends { response: ZodType }> = ZodInfer<A["response"]>;

export type ActionClient<A extends Record<string, ClientActionShape>> = {
  [K in keyof A]: (args: ZodInput<A[K]["request"]>) => Promise<ActionResponse<A[K]>>;
};

export type ApiRequest<
  C extends Record<string, (args: never) => Promise<unknown>>,
  K extends keyof C,
> = Parameters<C[K]>[0];

export type ApiResponse<
  C extends Record<string, (args: never) => Promise<unknown>>,
  K extends keyof C,
> = Awaited<ReturnType<C[K]>>;

interface ClientOptions {
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_ENDPOINT = "./actions";
const INVALID_ARGS_PREFIX = "invalid args: ";

function requestSchemaIssues(body: unknown): SpaceActionIssue[] {
  if (body === null || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  let raw: unknown = "issues" in record ? record.issues : undefined;
  const error = "error" in record ? record.error : undefined;
  if (raw === undefined && typeof error === "string" && error.startsWith(INVALID_ARGS_PREFIX)) {
    try {
      raw = JSON.parse(error.slice(INVALID_ARGS_PREFIX.length)) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((issue): issue is Record<string, unknown> => issue !== null && typeof issue === "object")
    .map((issue) => {
      const path = Array.isArray(issue.path) ? issue.path.map(String) : [];
      const message = typeof issue.message === "string" && issue.message.trim().length > 0
        ? issue.message.trim()
        : "This value is invalid.";
      return { path, message };
    });
}

function requestSchemaMessage(issues: readonly SpaceActionIssue[]): string {
  return [...new Set(issues.map((issue) => issue.message))].join("\n");
}

function parseRetryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (raw == null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

function resolveEndpoint(relative: string): string {
  const href = globalThis.location?.href;
  if (typeof href !== "string" || href.length === 0) return relative;
  const base = new URL(href);
  base.hash = "";
  base.search = "";
  return new URL(relative, base).toString();
}

function createActionCallId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function readErrorBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return "";
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorText(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const error = (body as Record<string, unknown>).error;
  const message = typeof error === "string" ? error : (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message.replace(/^Error: /, "").trim() : undefined;
}

function failedActionError(name: string, response: Response, body: unknown): SpaceActionError {
  const issues = requestSchemaIssues(body);
  const detail = `action ${name} failed: ${response.status} ${typeof body === "string" ? body : JSON.stringify(body ?? null)}`;
  const code =
    body !== null && typeof body === "object" && typeof (body as Record<string, unknown>).code === "string"
      ? (body as Record<string, unknown>).code as string
      : undefined;
  const retrySafe =
    body !== null && typeof body === "object" && (body as Record<string, unknown>).retrySafe === true;
  const message =
    issues.length > 0 ? requestSchemaMessage(issues) : (errorText(body) ?? "Something went wrong. Please try again.");
  return new SpaceActionError(message, response.status, parseRetryAfterMs(response), retrySafe, code, issues, detail);
}

export function createActionClient<A extends Record<string, ClientActionShape>>(
  options: ClientOptions = {},
): ActionClient<A> {
  const endpoint = options.endpoint ?? resolveEndpoint(DEFAULT_ENDPOINT);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const callAction = (action: string, args: unknown, actionCallId: string) =>
    fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": actionCallId,
      },
      body: JSON.stringify({ action, args: args ?? {}, actionCallId }),
    });

  return new Proxy({} as ActionClient<A>, {
    get(_target, name) {
      if (typeof name !== "string") return undefined;
      if (name === "then" || name === "catch" || name === "finally") return undefined;
      const invokeAction = async (args: unknown): Promise<unknown> => {
        const actionCallId = createActionCallId();
        const response = await callAction(name, args, actionCallId);
        if (!response.ok) {
          throw failedActionError(name, response, await readErrorBody(response));
        }
        const body = (await response.json()) as Record<string, unknown>;
        if (body && typeof body === "object" && "error" in body && body.error) {
          throw new Error(`action ${name} error: ${String(body.error)}`);
        }
        return body.data;
      };
      return (args: unknown) =>
        invokeAction(args).catch((error: unknown) => {
          if (error instanceof SpaceActionError) throw error;
          throw new SpaceActionError(OUTCOME_UNKNOWN_MESSAGE, 0, undefined, false, undefined, [], String(error));
        });
    },
  });
}

// ---------------------------------------------------------------------------
// Shared QueryClient
// ---------------------------------------------------------------------------

let failureNoticeTimer: number | undefined;

function showFailureNotice(error: unknown): void {
  if (typeof document === "undefined") return;
  const message = error instanceof Error ? error.message : "操作失败，请重试。";
  let el = document.querySelector<HTMLElement>("[data-standalone-failure-notice]");
  if (!el) {
    el = document.createElement("div");
    el.setAttribute("data-standalone-failure-notice", "");
    el.style.cssText =
      "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9999;max-width:min(90vw,480px);padding:10px 16px;border-radius:8px;background:#1f2937;color:#f9fafb;font-size:14px;line-height:1.5;box-shadow:0 4px 16px rgba(0,0,0,.3);";
    document.body.appendChild(el);
  }
  el.textContent = message;
  window.clearTimeout(failureNoticeTimer);
  failureNoticeTimer = window.setTimeout(() => el?.remove(), 6000);
}

export const spaceQueryClient = new QueryClient({
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (mutation.options.onError === undefined && mutation.options.onSettled === undefined) {
        showFailureNotice(error);
      }
    },
  }),
  defaultOptions: {
    queries: {
      retry: shouldRetryAction,
      retryDelay: actionRetryDelay,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

/** In-flight count probe (same idea as the SDK's `__hatchAuditSettle`). */
export function installAuditSettleProbe(queryClient: QueryClient = spaceQueryClient): void {
  if (typeof window === "undefined") return;
  const target = window as unknown as Record<string, unknown>;
  if (typeof target.__standaloneAuditSettle === "function") return;
  target.__standaloneAuditSettle = () => queryClient.isFetching() + queryClient.isMutating();
}

installAuditSettleProbe();

// ---------------------------------------------------------------------------
// Viewer (no host in standalone mode)
// ---------------------------------------------------------------------------

export type SpaceRole = "owner" | "editor" | "viewer" | "peer";

export interface SpaceViewer {
  readonly id?: string;
  readonly name?: string;
  readonly role?: SpaceRole;
}

export type SpaceViewerEvent = { readonly type: string };

export async function getSpaceViewer(): Promise<SpaceViewer | null> {
  return null;
}

export function subscribeSpaceViewer(
  _listener: (viewer: SpaceViewer | null, event?: SpaceViewerEvent) => void,
): () => void {
  return () => {};
}

export function useSpaceViewer(): SpaceViewer | null {
  return null;
}

// ---------------------------------------------------------------------------
// Safe-area scrim (same geometry as the SDK's)
// ---------------------------------------------------------------------------

const TOP_SAFE_AREA_SCRIM_HEIGHT =
  "calc(var(--twsa-safe-area-inset-top) + min(2rem, var(--twsa-safe-area-inset-top)))";
const TOP_SAFE_AREA_INSET_HEIGHT = "var(--twsa-safe-area-inset-top)";
const TOP_SAFE_AREA_GRADIENT_MASK =
  "linear-gradient(to bottom, rgba(0, 0, 0, 1) 0%, rgba(0, 0, 0, 0.99) 10%, rgba(0, 0, 0, 0.96) 20%, rgba(0, 0, 0, 0.90) 30%, rgba(0, 0, 0, 0.80) 40%, rgba(0, 0, 0, 0.67) 50%, rgba(0, 0, 0, 0.52) 60%, rgba(0, 0, 0, 0.36) 70%, rgba(0, 0, 0, 0.20) 80%, rgba(0, 0, 0, 0.08) 90%, rgba(0, 0, 0, 0) 100%)";

export type SafeAreaTopScrimVariant = "gradient" | "blur";

export interface SafeAreaTopScrimProps extends HTMLAttributes<HTMLDivElement> {
  variant?: SafeAreaTopScrimVariant;
  backgroundColor?: string;
  zIndex?: number;
}

export function SafeAreaTopScrim({
  variant = "gradient",
  backgroundColor,
  zIndex = 40,
  className,
  style,
  ...props
}: SafeAreaTopScrimProps) {
  const resolvedBackgroundColor = backgroundColor ?? style?.backgroundColor ?? "var(--bg)";
  const managedStyle: CSSProperties = {
    ...style,
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    zIndex,
    pointerEvents: "none",
    height: variant === "gradient" ? TOP_SAFE_AREA_SCRIM_HEIGHT : TOP_SAFE_AREA_INSET_HEIGHT,
    backgroundColor: resolvedBackgroundColor,
  };
  if (variant === "gradient") {
    managedStyle.maskImage = TOP_SAFE_AREA_GRADIENT_MASK;
    managedStyle.WebkitMaskImage = TOP_SAFE_AREA_GRADIENT_MASK;
  } else if (variant === "blur") {
    managedStyle.backdropFilter = style?.backdropFilter ?? "blur(12px)";
    managedStyle.WebkitBackdropFilter = style?.WebkitBackdropFilter ?? "blur(12px)";
  }
  return createElement("div", {
    ...props,
    "aria-hidden": props["aria-hidden"] ?? true,
    className,
    style: managedStyle,
  });
}
