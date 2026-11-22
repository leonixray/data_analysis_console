// Standalone server build: `bun run build:server` in standalone/.
//
// Bundles `standalone/src/server.ts` (plus the tower's own
// `server/src/*`, which it imports) into `standalone/dist-server/`.
// Bundling — rather than running the TypeScript source directly —
// is load-bearing: Bun's runtime `Bun.plugin()` onResolve hooks do
// NOT reliably redirect bare imports that resolve to nothing
// (`@hatch/space-sdk` is not on npm, so the runtime resolver fails
// before the plugin is consulted; verified 2026-11-22). In `Bun.build`
// the same plugin IS consulted for the whole graph, so the bundle
// carries the shims and all third-party code inline. The only runtime
// inputs left are files on disk: `./drizzle` (migrations), `./.env`,
// `standalone/dist` (client) and `DATABASE_PATH`.

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sdkShimPlugin } from "./resolve-plugin";
import { ensureRootNodeModules } from "./ensure-root-node-modules";

ensureRootNodeModules();

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const result = await Bun.build({
  entrypoints: [resolve(REPO_ROOT, "standalone/src/server.ts")],
  outdir: resolve(REPO_ROOT, "standalone/dist-server"),
  target: "bun",
  minify: false,
  plugins: [sdkShimPlugin],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("standalone server build failed; see logged diagnostics");
}

console.log(`[build] server bundle written to ${resolve(REPO_ROOT, "standalone/dist-server")}`);
for (const output of result.outputs) {
  console.log(`[build]   ${output.path.split("/").slice(-1)[0]} (${(output.size / 1024).toFixed(1)} KiB)`);
}
