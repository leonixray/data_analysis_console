// Standalone server for the data-analysis console.
//
// Serves the statically built client (`standalone/dist`) and dispatches
// `POST /actions` to the tower's own action handlers
// (`server/src/actions.ts`) — the same code the Muse runtime runs, with
// a locally built `Ctx`:
//
// - `ctx.db` — drizzle over bun:sqlite on `DATABASE_PATH`
//   (default `./data/app.db`); migrations from `./drizzle` run on startup.
// - `ctx.executePrivileged` — the FINRA xlsx handler runs in-process
//   (it is plain `node:zlib` + fetch code; no host needed).
// - `ctx.invalidateQueries` — no-op (each browser tab refetches on its
//   own staleTime; there is no cross-client broadcast here).
// - `ctx.agent` / `ctx.inference` / `ctx.tool` / `ctx.blobs` — stubs that
//   throw; the tower never calls them.
//
// Refresh: the Muse version uses 18 managed cron jobs; here a single
// in-process timer calls the same `refreshData` action every
// `REFRESH_INTERVAL_MINUTES` (default 60, `0` disables). On first boot
// with an empty database a backfill refresh starts in the background
// (`REFRESH_ON_START=auto`, set `never` to skip, `always` to force).
//
// Keys: FRED / BEA are read exactly as the tower reads them — database
// first (`server_secrets`, writable via the `setFredApiKey` /
// `setBeaApiKey` actions), environment second. `.env` at the repo root
// is loaded here (Bun only auto-loads `.env` from the working
// directory, so a run from `standalone/` would otherwise miss it).
// Never commit `.env` or `data/` — both are gitignored.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { count } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "../../server/src/schema";
import { Actions } from "../../server/src/actions";
import { privilegedHandlers } from "../../server/src/privileged";
import {
  createPrivilegedExecutor,
  isAction,
  z,
  type ActionDefinition,
  type AgentClient,
  type BlobClient,
  type Ctx,
  type InferenceClient,
  type SpaceDbAccessor,
  type SpaceToolClient,
} from "@hatch/space-sdk";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const DIST_DIR = resolve(REPO_ROOT, "standalone/dist");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Load KEY=VALUE files into process.env without overwriting real env vars. */
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(join(REPO_ROOT, ".env"));
loadEnvFile(join(REPO_ROOT, ".env.local"));

const PORT = envInt("PORT", 3000);
const HOST = process.env.HOST?.trim() || "0.0.0.0";
const DATABASE_PATH = resolve(REPO_ROOT, process.env.DATABASE_PATH?.trim() || "data/app.db");
const REFRESH_INTERVAL_MINUTES = envInt("REFRESH_INTERVAL_MINUTES", 60);
const REFRESH_ON_START = (process.env.REFRESH_ON_START?.trim() || "auto").toLowerCase();

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

mkdirSync(dirname(DATABASE_PATH), { recursive: true });
const sqlite = new Database(DATABASE_PATH);
const db: BunSQLiteDatabase<typeof schema> = drizzle(sqlite, { schema });

migrate(db, { migrationsFolder: join(REPO_ROOT, "drizzle") });

async function seriesCount(): Promise<number> {
  const rows = await db.select({ n: count() }).from(schema.seriesPoints);
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Action context
// ---------------------------------------------------------------------------

function unavailable(name: string): Record<string, (...args: never[]) => Promise<never>> {
  return new Proxy(
    {},
    {
      get: () =>
        async () => {
          throw new Error(`${name} is not available in standalone mode`);
        },
    },
  );
}

function makeCtx<Req extends z.ZodType, Res extends z.ZodType>(
  def: ActionDefinition<Ctx, Req, Res>,
): Ctx {
  const executor = createPrivilegedExecutor(def.privileged ?? [], async (contract, args) => {
    const entry = privilegedHandlers.entries.find((e) => e.contract.name === contract.name);
    if (!entry) throw new Error(`no privileged handler registered for ${contract.name}`);
    return entry.handler(args as never);
  });
  const ctx = {
    slug: "data-analysis-console",
    invocationId: crypto.randomUUID(),
    spaceDir: REPO_ROOT,
    db: (() => db) as unknown as SpaceDbAccessor,
    blobs: unavailable("blobs") as unknown as BlobClient,
    agent: unavailable("agent") as unknown as AgentClient,
    inference: unavailable("inference") as unknown as InferenceClient,
    tool: unavailable("tool") as unknown as SpaceToolClient,
    emit: () => {},
    invalidateQueries: () => {},
    ...executor,
  };
  return ctx as unknown as Ctx;
}

// ---------------------------------------------------------------------------
// Action dispatch (same wire protocol as the Muse client)
// ---------------------------------------------------------------------------

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function handleAction(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid args: request body is not valid JSON", retrySafe: true }, 400);
  }
  const record = body as Record<string, unknown> | null;
  if (!record || typeof record.action !== "string") {
    return jsonResponse({ error: "invalid args: expected {action, args}", retrySafe: true }, 400);
  }
  const name = record.action;
  const def = (Actions as Record<string, unknown>)[name];
  if (!def || !isAction(def)) {
    return jsonResponse({ error: `unknown action: ${name}` }, 404);
  }
  let args: unknown;
  try {
    args = def.request.parse(record.args ?? {});
  } catch (err) {
    if (err instanceof z.ZodError) {
      return jsonResponse({ error: `invalid args: ${JSON.stringify(err.issues)}`, retrySafe: true }, 400);
    }
    throw err;
  }
  try {
    const result = await def.handler(makeCtx(def), args);
    const data = def.response.parse(result);
    return jsonResponse({ data }, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[actions] ${name} failed: ${message}`);
    return jsonResponse({ error: message }, 500);
  }
}

// ---------------------------------------------------------------------------
// Static client
// ---------------------------------------------------------------------------

async function serveStatic(pathname: string): Promise<Response> {
  if (pathname.includes("..")) return new Response("not found", { status: 404 });
  const safe = pathname === "/" ? "/index.html" : pathname;
  const file = Bun.file(join(DIST_DIR, safe));
  if (await file.exists()) return new Response(file);
  if (safe.startsWith("/assets/")) return new Response("not found", { status: 404 });
  const index = Bun.file(join(DIST_DIR, "index.html"));
  if (await index.exists()) return new Response(index);
  return new Response("client not built — run `bun run build` in standalone/ first", { status: 503 });
}

// ---------------------------------------------------------------------------
// Refresh (timer + first-boot backfill)
// ---------------------------------------------------------------------------

let refreshRunning = false;

async function runRefresh(reason: string): Promise<void> {
  if (refreshRunning) {
    console.log(`[refresh] skipped (${reason}): a refresh is already running`);
    return;
  }
  refreshRunning = true;
  const started = Date.now();
  try {
    const def = Actions.refreshData;
    const result = await def.handler(makeCtx(def), {});
    console.log(`[refresh] ${reason}: ok=${result.ok} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (err) {
    console.error(`[refresh] ${reason} failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    refreshRunning = false;
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const startedAt = Date.now();

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") {
      return Response.json({
        ok: true,
        series: await seriesCount(),
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      });
    }
    if (url.pathname === "/actions" && req.method === "POST") return handleAction(req);
    if (req.method === "GET") return serveStatic(url.pathname);
    return new Response("not found", { status: 404 });
  },
});

const hasDist = existsSync(join(DIST_DIR, "index.html"));
console.log(`[standalone] listening on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${server.port}`);
console.log(`[standalone] database: ${DATABASE_PATH}`);
console.log(`[standalone] client bundle: ${hasDist ? DIST_DIR : "NOT BUILT — run `bun run build` in standalone/"}`);
console.log(
  `[standalone] refresh timer: ${
    REFRESH_INTERVAL_MINUTES > 0 ? `every ${REFRESH_INTERVAL_MINUTES} min` : "disabled"
  }`,
);

void (async () => {
  const n = await seriesCount();
  console.log(`[standalone] stored series points: ${n}`);
  if (REFRESH_ON_START === "always" || (REFRESH_ON_START === "auto" && n === 0)) {
    console.log(`[refresh] starting background backfill (REFRESH_ON_START=${REFRESH_ON_START})`);
    void runRefresh("startup backfill");
  }
})();

if (REFRESH_INTERVAL_MINUTES > 0) {
  setInterval(() => void runRefresh("timer"), REFRESH_INTERVAL_MINUTES * 60 * 1000);
}

process.on("SIGINT", () => {
  sqlite.close();
  server.stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  sqlite.close();
  server.stop();
  process.exit(0);
});
