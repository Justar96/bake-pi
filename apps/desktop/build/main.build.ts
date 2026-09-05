import { join } from "node:path"
import { ELECTRON_EXTERNAL, appRoot, banner, mode, outDir, runBuild } from "./shared.ts"

const agentHostPackage = await Bun.file(join(appRoot, "..", "..", "packages/agent-host/package.json")).json() as {
  dependencies?: Record<string, string>
}
const piVersion = agentHostPackage.dependencies?.["@earendil-works/pi-coding-agent"]
if (piVersion === undefined) throw new Error("agent host does not declare its Pi version")

export const buildMain = () =>
  runBuild("main", {
    entrypoints: [join(appRoot, "src/main/index.ts")],
    outdir: join(outDir, "main"),
    target: "node",
    // Electron 44 supports ESM in the main process, with one measured caveat:
    // the app does not become ready until the entry module finishes evaluating,
    // so a top-level `await app.whenReady()` deadlocks. See src/main/index.ts.
    format: "esm",
    external: ELECTRON_EXTERNAL,
    sourcemap: mode() === "production" ? "external" : "inline",
    minify: mode() === "production",
    banner: banner("main"),
    define: {
      "process.env.NODE_ENV": JSON.stringify(mode()),
      "process.env.BAKE_PI_PI_VERSION": JSON.stringify(piVersion),
    },
  })

if (import.meta.main) await buildMain()
