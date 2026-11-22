// Standalone stub for `@hatch/space-sdk/build`.
//
// `buildClient()` is the Muse builder's entry point and is intentionally
// unavailable outside Muse (it refuses to run without the builder driver).
// The standalone client build lives in `standalone/src/build-client.ts`
// (same Bun.build configuration, plus the SDK shim plugin). This stub
// exists only so an accidental import fails with a pointer instead of a
// bare "cannot resolve module" error.

export async function buildClient(): Promise<void> {
  throw new Error(
    "buildClient() is only available inside the Muse builder. " +
      "For the standalone build, run `bun run build` in standalone/ " +
      "(see standalone/src/build-client.ts).",
  );
}
