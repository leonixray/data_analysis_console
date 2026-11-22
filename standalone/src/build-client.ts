// Standalone client build: `bun run build` in standalone/.
//
// Same Bun.build configuration the Muse builder uses for this space
// (see @hatch/space-sdk/build): HTML entrypoint, minified production
// bundle, Tailwind plugin, `assets/[name]-[hash].[ext]` naming — plus
// the SDK shim plugin so `@hatch/space-sdk/client` resolves to the
// local compatibility layer instead of the Muse-only package.
// Output goes to `standalone/dist/` (served by `standalone/src/server.ts`).

import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindPlugin from "bun-plugin-tailwind";
import { sdkShimPlugin } from "./resolve-plugin";
import { ensureRootNodeModules } from "./ensure-root-node-modules";

ensureRootNodeModules();

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY = join(REPO_ROOT, "client/index.html");
const OUTDIR = join(REPO_ROOT, "standalone/dist");
const PDFJS_ASSET_ROOT = "./assets/pdfjs/";

const platformVersion = await readFile(join(REPO_ROOT, "space.json"), "utf8")
  .then((text) => JSON.parse(text).platformVersion as number)
  .catch(() => 0);

const result = await Bun.build({
  entrypoints: [ENTRY],
  outdir: OUTDIR,
  minify: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    __HATCH_SPACE_PLATFORM_VERSION__: JSON.stringify(platformVersion),
  },
  naming: {
    asset: "assets/[name]-[hash].[ext]",
    chunk: "assets/[name]-[hash].[ext]",
    entry: "[name].[ext]",
  },
  plugins: [tailwindPlugin, sdkShimPlugin],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("standalone client build failed; see logged diagnostics");
}

// Bun writes imported assets to `assets/<name>-<hash>.<ext>` but emits
// the JS/CSS import URL as a bare `./<name>-<hash>.<ext>`. Re-prefix only
// the bare imported-asset URLs to `./assets/...` (same fix as the SDK's
// buildClient; idempotent and never rewrites chunk refs).
const assetFiles = result.outputs
  .filter((output) => output.kind === "asset")
  .map((output) => basename(output.path));
let needsPdfjsAssets = false;
for (const output of result.outputs) {
  if (!/\.(js|css|html)$/.test(output.path)) continue;
  let text = await output.text();
  needsPdfjsAssets ||= text.includes(PDFJS_ASSET_ROOT);
  let changed = false;
  for (const name of assetFiles) {
    const bare = `./${name}`;
    if (text.includes(bare)) {
      text = text.split(bare).join(`./assets/${name}`);
      changed = true;
    }
  }
  if (changed) await Bun.write(output.path, text);
}
if (needsPdfjsAssets) {
  // The tower does not ship PDF.js assets (no PDF viewer); if a future
  // version references them, the standalone build needs the pdfjs-dist
  // asset directory vendored under standalone/ first.
  console.warn("[build] WARNING: bundle references PDF.js assets, which the standalone build does not vendor; the PDF viewer will 404.");
}

console.log(`[build] client bundle written to ${OUTDIR}`);
for (const output of result.outputs) {
  console.log(`[build]   ${output.path.replace(`${OUTDIR}/`, "")} (${(output.size / 1024).toFixed(1)} KiB)`);
}
