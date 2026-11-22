// Minimal standalone replacement for `@hatch/space-sdk` (server side).
//
// The tower's server code imports `defineAction`, `z`, `definePrivileged*`
// and the `Ctx` / `ActionsModule` types from the Muse SDK, which is not on
// npm. This file re-implements the small portable core the tower actually
// uses — action definitions, privileged contracts, and the privileged
// executor — with the same runtime semantics (same brands, same zod
// validation), so `server/src/actions.ts` runs unchanged under plain Bun.
//
// What it deliberately does NOT provide: the Muse-only parts of `Ctx`
// (`agent`, `inference`, `tool`, `blobs`). The standalone server fills
// those with stubs that throw if called; the tower never calls them —
// its actions only use `ctx.db`, `ctx.executePrivileged` and
// `ctx.invalidateQueries` (verified by grep).

import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { z } from "zod";

export { z };

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/** Same method surface the SDK's `SpaceDb` exposes; backed by bun:sqlite here. */
export type SpaceDb<TSchema extends Record<string, unknown> = Record<string, never>> =
  BunSQLiteDatabase<TSchema>;

export type SpaceDbAccessor = <TSchema extends Record<string, unknown> = Record<string, never>>() => SpaceDb<TSchema>;

// ---------------------------------------------------------------------------
// Privileged contracts
// ---------------------------------------------------------------------------

export const PRIVILEGED_CONTRACT_BRAND = "@hatch/space-sdk/privileged-contract/v1";
export const PRIVILEGED_HANDLERS_FORMAT = "hatch-space-privileged-handlers-v1";

export interface PrivilegedContract<
  Req extends z.ZodType = z.ZodType,
  Res extends z.ZodType = z.ZodType,
> {
  readonly __brand: typeof PRIVILEGED_CONTRACT_BRAND;
  readonly name: string;
  readonly request: Req;
  readonly response: Res;
  readonly capabilities?: readonly string[];
  readonly timeoutMs?: number;
}

export type PrivilegedRequest<C extends PrivilegedContract> = z.infer<C["request"]>;
export type PrivilegedResponse<C extends PrivilegedContract> = z.infer<C["response"]>;

export interface PrivilegedContractSpec<
  Req extends z.ZodType = z.ZodType,
  Res extends z.ZodType = z.ZodType,
> {
  readonly request: Req;
  readonly response: Res;
  readonly capabilities?: readonly string[];
  readonly timeoutMs?: number;
}

export type PrivilegedContractsFor<T extends Record<string, PrivilegedContractSpec>> = {
  [K in keyof T]: PrivilegedContract<T[K]["request"], T[K]["response"]>;
};

export function definePrivilegedContracts<T extends Record<string, PrivilegedContractSpec>>(
  specs: T,
): PrivilegedContractsFor<T> {
  const contracts: Record<string, PrivilegedContract> = {};
  for (const [name, spec] of Object.entries(specs)) {
    contracts[name] = {
      __brand: PRIVILEGED_CONTRACT_BRAND,
      name,
      request: spec.request,
      response: spec.response,
      ...(spec.capabilities !== undefined ? { capabilities: spec.capabilities } : {}),
      ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
    };
  }
  return contracts as PrivilegedContractsFor<T>;
}

export function isPrivilegedContract(value: unknown): value is PrivilegedContract {
  return (
    typeof value === "object" &&
    value !== null &&
    "__brand" in value &&
    value.__brand === PRIVILEGED_CONTRACT_BRAND
  );
}

export type PrivilegedHandler = (args: never) => Promise<unknown>;

export interface PrivilegedHandlerEntry {
  readonly contract: PrivilegedContract;
  readonly handler: (args: never) => Promise<unknown>;
}

export interface PrivilegedHandlers {
  readonly format: typeof PRIVILEGED_HANDLERS_FORMAT;
  readonly entries: readonly PrivilegedHandlerEntry[];
}

export function definePrivilegedHandlers<T extends Record<string, PrivilegedContractSpec>>(
  contracts: PrivilegedContractsFor<T>,
  handlers: { [K in keyof T]?: (args: z.infer<T[K]["request"]>) => Promise<z.infer<T[K]["response"]>> },
): PrivilegedHandlers {
  const entries: PrivilegedHandlerEntry[] = [];
  for (const [key, handler] of Object.entries(handlers)) {
    if (handler === undefined) continue;
    const contract = (contracts as Record<string, PrivilegedContract>)[key];
    if (!isPrivilegedContract(contract)) {
      throw new Error(`privileged handler '${key}' does not have a contract descriptor`);
    }
    entries.push({ contract, handler: handler as (args: never) => Promise<unknown> });
  }
  return { format: PRIVILEGED_HANDLERS_FORMAT, entries };
}

export function isPrivilegedHandlers(value: unknown): value is PrivilegedHandlers {
  return (
    typeof value === "object" &&
    value !== null &&
    "format" in value &&
    value.format === PRIVILEGED_HANDLERS_FORMAT &&
    Array.isArray((value as PrivilegedHandlers).entries)
  );
}

export type PrivilegedTransport = (
  contract: PrivilegedContract,
  args: unknown,
) => Promise<unknown>;

export interface PrivilegedExecutor {
  executePrivileged<C extends PrivilegedContract>(
    contract: C,
    args: PrivilegedRequest<C>,
  ): Promise<PrivilegedResponse<C>>;
}

export function createPrivilegedExecutor(
  declared: readonly PrivilegedContract[] | undefined,
  transport: PrivilegedTransport,
): PrivilegedExecutor {
  const declaredNames = new Set((declared ?? []).map((contract) => contract.name));
  return {
    async executePrivileged<C extends PrivilegedContract>(
      contract: C,
      args: PrivilegedRequest<C>,
    ): Promise<PrivilegedResponse<C>> {
      if (!isPrivilegedContract(contract)) {
        throw new Error("ctx.executePrivileged requires a privileged contract descriptor");
      }
      if (!declaredNames.has(contract.name)) {
        throw new Error(`ctx.executePrivileged(${contract.name}) was not declared by this action`);
      }
      const parsedArgs = contract.request.parse(args);
      const result = await transport(contract, parsedArgs);
      return contract.response.parse(result) as PrivilegedResponse<C>;
    },
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const ACTION_BRAND = "@hatch/space-sdk/action/v1";

export interface ActionDefinition<
  TCtx extends PortableCtx = PortableCtx,
  Req extends z.ZodType = z.ZodType,
  Res extends z.ZodType = z.ZodType,
> {
  readonly __brand: typeof ACTION_BRAND;
  readonly request: Req;
  readonly response: Res;
  readonly description?: string;
  readonly privileged?: readonly PrivilegedContract[];
  readonly handler: (ctx: TCtx, args: z.infer<Req>) => Promise<z.infer<Res>>;
}

export type ActionFactoryInput<
  TCtx extends PortableCtx,
  Req extends z.ZodType,
  Res extends z.ZodType,
> = {
  request: Req;
  response: Res;
  description?: string;
  privileged?: readonly PrivilegedContract[];
  handler: (ctx: TCtx, args: z.infer<Req>) => Promise<z.infer<Res>>;
};

export function defineAction<Req extends z.ZodType, Res extends z.ZodType>(
  spec: ActionFactoryInput<Ctx, Req, Res>,
): ActionDefinition<Ctx, Req, Res> {
  return {
    __brand: ACTION_BRAND,
    request: spec.request,
    response: spec.response,
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    ...(spec.privileged !== undefined ? { privileged: spec.privileged } : {}),
    handler: spec.handler,
  };
}

export function isAction(value: unknown): value is ActionDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    "__brand" in value &&
    value.__brand === ACTION_BRAND
  );
}

export type ActionsModuleFor<TCtx extends PortableCtx> = Record<
  string,
  Omit<ActionDefinition<TCtx>, "handler"> & {
    handler: (ctx: TCtx, args: never) => Promise<unknown>;
  }
>;

export type ActionRequest<A extends { request: z.ZodType }> = z.infer<A["request"]>;
export type ActionResponse<A extends { response: z.ZodType }> = z.infer<A["response"]>;

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export type SpaceRole = "owner" | "editor" | "viewer" | "peer";

export interface Viewer {
  readonly id?: string;
  readonly name?: string;
  readonly role?: SpaceRole;
}

/** Standalone has no agent runtime: every method throws if called. */
export interface AgentClient {
  spawnTask(message: string, options?: Record<string, unknown>): Promise<never>;
  send(message: string, options?: Record<string, unknown>): Promise<never>;
  status(taskId: string): Promise<never>;
}

/** Standalone has no inference runtime: every method throws if called. */
export interface InferenceClient {
  complete<T extends z.ZodType>(
    prompt: string,
    options: { schema: T; timeout_secs?: number; system?: string },
  ): Promise<z.infer<T>>;
}

/** Standalone has no tool runtime: every method throws if called. */
export type SpaceToolClient = Record<string, (...args: never[]) => Promise<never>>;

/** Standalone has no blob store: every method throws if called. */
export type BlobClient = Record<string, (...args: never[]) => Promise<never>>;

export type SpaceQueryKey = readonly JsonValue[];
export interface SpaceQueryInvalidation {
  readonly queryKey: SpaceQueryKey;
}
export interface SpaceQueryInvalidationBatch {
  readonly queryKeys: readonly SpaceQueryKey[];
}
export type SpaceQueryInvalidationInput =
  | SpaceQueryKey
  | SpaceQueryInvalidation
  | SpaceQueryInvalidationBatch;

export interface PortableCtx extends PrivilegedExecutor {
  readonly slug: string;
  readonly invocationId: string;
  readonly spaceDir: string;
  readonly db: SpaceDbAccessor;
  readonly viewer?: Viewer;
  readonly blobs: BlobClient;
}

export interface Ctx extends PortableCtx {
  readonly agent: AgentClient;
  readonly inference: InferenceClient;
  readonly tool: SpaceToolClient;
  emit(data: JsonValue): void;
  invalidateQueries(invalidation?: SpaceQueryInvalidationInput): void;
}

export type ActionsModule = ActionsModuleFor<Ctx>;
