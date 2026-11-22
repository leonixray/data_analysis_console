// Ensures `<repo root>/node_modules` exists as a symlink to
// `standalone/node_modules`.
//
// Why: the tower's source lives outside `standalone/` (`server/src/*`,
// `client/src/*`), so plain Node/Bun resolution from those files never
// sees `standalone/node_modules`. The resolve plugin covers JS/TS
// imports, but the Tailwind compiler resolves CSS `@import`s
// (`@import "tailwindcss"` in `client/src/theme.css`) with its own
// resolver rooted at the CSS file — only a real `node_modules` on the
// walk-up path from `client/src` satisfies it.
//
// The link is gitignored (`node_modules/`), never committed, and only
// ever points at this repo's own standalone install. Best-effort: if
// the filesystem refuses (read-only, no privilege), the resolve plugin
// still covers JS/TS imports and only the client build's CSS step fails
// — the error then says to create the link by hand.

import { existsSync, symlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function ensureRootNodeModules(): void {
  const standaloneDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const rootLink = resolve(standaloneDir, "..", "node_modules");
  const target = resolve(standaloneDir, "node_modules");
  try {
    if (existsSync(rootLink)) return;
    symlinkSync(target, rootLink, "junction");
  } catch {
    // Best effort only — see the header comment.
  }
}

// Self-executing so `postinstall` can run this file directly:
//   "postinstall": "bun src/ensure-root-node-modules.ts"
ensureRootNodeModules();
