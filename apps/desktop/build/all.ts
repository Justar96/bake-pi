import { rm } from "node:fs/promises"
import { buildAgentHost } from "./agent-host.build.ts"
import { buildMain } from "./main.build.ts"
import { buildPreload } from "./preload.build.ts"
import { buildRenderer } from "./renderer.build.ts"
import { mode, outDir, report } from "./shared.ts"

await rm(outDir, { recursive: true, force: true })

console.log(`building bake-pi (${mode()})`)
// The four outputs share no build state, so they run concurrently. Ordering
// them would only hide which one is slow.
const reports = await Promise.all([buildMain(), buildPreload(), buildRenderer(), buildAgentHost()])
report(reports)

// `--watch` keeps this process alive: it starts the app and rebuilds what is
// edited. Everything above has to happen first either way, because a watch run
// begins from a complete bundle.
// Imported here rather than at the top: a one-shot build should not load the
// watcher, let alone run the checks it makes on the way in.
if (process.argv.includes("--watch")) await (await import("./watch.ts")).watchBuild()
