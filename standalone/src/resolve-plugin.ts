// Module-resolution plugin for standalone mode.
//
// The tower's source imports `@hatch/space-sdk*` and `@space/privileged`,
// which only exist inside the Muse runtime. This plugin redirects those
// specifiers to the local shims in `standalone/shims/`, so the tower's
// source files run unchanged under plain Bun.
//
// It also redirects the tower's bare third-party imports
// (`drizzle-orm`, `zod`, `react`, …) to `standalone/node_modules`.
// Those imports live in files outside `standalone/` (`server/src/*`,
// `client/src/*`), so Bun's normal node_modules walk-up from the
// importing file would never find `standalone/node_modules` — the
// plugin closes that gap. Only the whitelisted packages are redirected;
// anything else (relative paths, `bun:` / `node:` builtins) resolves
// normally.
//
// Used by `standalone/src/build-client.ts` and
// `standalone/src/build-server.ts` (passed to `Bun.build`).

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BunPlugin } from "bun";

const STANDALONE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(STANDALONE_DIR, "..");
const NODE_MODULES = resolve(STANDALONE_DIR, "node_modules");

/** Bare packages the tower's source imports; resolved from standalone/node_modules. */
const BARE_PACKAGES = [
  "drizzle-orm",
  "zod",
  "react",
  "react-dom",
  "@tanstack/react-query",
  "recharts",
] as const;

function barePackageRoot(specifier: string): string | null {
  for (const pkg of BARE_PACKAGES) {
    if (specifier !== pkg && !specifier.startsWith(`${pkg}/`)) continue;
    const base = resolve(NODE_MODULES, specifier);
    if (existsSync(base)) return base;
    // Subpath files without an extension: react/jsx-runtime -> jsx-runtime.js
    for (const ext of [".js", ".ts", ".mjs", ".cjs"]) {
      if (existsSync(base + ext)) return base + ext;
    }
    for (const index of ["index.js", "index.ts", "index.mjs"]) {
      if (existsSync(join(base, index))) return join(base, index);
    }
    return null;
  }
  return null;
}

export const sdkShimPlugin: BunPlugin = {
  name: "standalone-sdk-shim",
  setup(build) {
    build.onResolve({ filter: /^@hatch\/space-sdk(\/client|\/build)?$/ }, (args) => {
      if (args.path === "@hatch/space-sdk/client") {
        return { path: resolve(STANDALONE_DIR, "shims/space-sdk-client.ts") };
      }
      if (args.path === "@hatch/space-sdk/build") {
        return { path: resolve(STANDALONE_DIR, "shims/space-sdk-build.ts") };
      }
      return { path: resolve(STANDALONE_DIR, "shims/space-sdk.ts") };
    });
    build.onResolve({ filter: /^@space\/privileged$/ }, () => ({
      path: resolve(REPO_ROOT, "server/.generated/privileged.contract.ts"),
    }));
    // Bare third-party imports: let Bun's own resolver pick the right
    // file (package.json "exports", jsx-runtime, subpaths, …) with
    // standalone/ as the parent, so they land in standalone/node_modules.
    // Returning a directory path from onResolve fails at build time
    // (EISDIR), so never return the raw package dir.
    build.onResolve({ filter: /^(?![./]|bun:|node:).+/ }, (args) => {
      if (barePackageRoot(args.path) === null) return undefined;
      try {
        return { path: Bun.resolveSync(args.path, join(STANDALONE_DIR, "package.json")) };
      } catch {
        return undefined;
      }
    });
  },
};
