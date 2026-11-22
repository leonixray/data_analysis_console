// Build everything standalone: client bundle + server bundle.
// `bun run build` in standalone/.
await import("./build-client");
await import("./build-server");
console.log("[build] all done");
