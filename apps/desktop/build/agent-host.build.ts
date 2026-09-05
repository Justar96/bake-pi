import { join } from "node:path"
import { PI_EXTERNAL, banner, mode, outDir, repoRoot, runBuild } from "./shared.ts"

/**
 * The agent host bundles only its own source. See `PI_EXTERNAL` for why Pi
 * stays out of the graph.
 */
export const buildAgentHost = () =>
  runBuild("agent-host", {
    /*
      Two entry points, one output directory, and the split is load-bearing.
      `boot.ts` installs the module resolve hook that lets a managed Pi win over
      the bundled one, and a hook is only worth anything before the imports it
      redirects have run. Bundled together, the host's static Pi imports would
      be hoisted above the registration; kept apart, `boot.js` evaluates alone
      and reaches `index.js` only through a runtime `import()`.
    */
    entrypoints: [
      join(repoRoot, "packages/agent-host/src/boot.ts"),
      join(repoRoot, "packages/agent-host/src/index.ts"),
    ],
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
