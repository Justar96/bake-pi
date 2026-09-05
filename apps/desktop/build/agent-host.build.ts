import { join } from "node:path"
import { PI_EXTERNAL, banner, mode, outDir, repoRoot, runBuild } from "./shared.ts"

/**
 * The agent host bundles only its own source. See `PI_EXTERNAL` for why Pi
 * stays out of the graph.
 */
export const buildAgentHost = () =>
  runBuild("agent-host", {
    entrypoints: [join(repoRoot, "packages/agent-host/src/index.ts")],
    outdir: join(outDir, "agent-host"),
    target: "node",
    format: "esm",
    external: PI_EXTERNAL,
    sourcemap: "external",
    // Never minified. This process owns credentials, session files and tool
    // execution; when it throws, a readable stack in the diagnostics log is
    // worth more than the kilobytes.
    minify: false,
    banner: banner("agent-host"),
    define: { "process.env.NODE_ENV": JSON.stringify(mode()) },
  })

if (import.meta.main) await buildAgentHost()
