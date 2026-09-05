import { join } from "node:path"
import { ELECTRON_EXTERNAL, appRoot, banner, mode, outDir, runBuild } from "./shared.ts"

/** Refuses syntax that requires an ES-module loader, regardless of whitespace or minification. */
export const assertCommonJsSyntax = (source: string): void => {
  try {
    // Electron evaluates this file as a classic CommonJS script. Constructing
    // a function applies that same grammar without executing the bundle, so
    // `require`, `module` and Electron's preload globals need not exist here.
    Function(source)
  } catch {
    throw new Error(
      "preload bundle is not valid CommonJS script syntax; Bun's experimental CJS output regressed — switch to the esbuild fallback",
    )
  }
}

/**
 * The one CommonJS output in the project.
 *
 * A sandboxed preload is not an ES module context and cannot be one: Electron
 * loads it as a single CommonJS script with a polyfilled subset of Node. Bun's
 * CJS output is still marked experimental, which makes this the project's one
 * known-soft build path — hence the assertion below and the esbuild fallback
 * noted in the plan. The mitigation is that this is also the smallest bundle we
 * ship, so the blast radius is one file.
 */
export const buildPreload = async () => {
  const report = await runBuild("preload", {
    entrypoints: [join(appRoot, "src/preload/index.ts")],
    outdir: join(outDir, "preload"),
    target: "node",
    format: "cjs",
    external: ELECTRON_EXTERNAL,
    naming: "[dir]/[name].cjs",
    sourcemap: mode() === "production" ? "external" : "inline",
    minify: mode() === "production",
    banner: banner("preload"),
  })

  const bundle = report.outputs.find((output) => output.path.endsWith(".cjs"))
  if (bundle === undefined) throw new Error("preload build produced no .cjs output")

  // A stray static `import`/`export` here means the CJS transform let an ES
  // module construct through. Parse the syntax instead of matching its text:
  // production minification removes the whitespace and newlines the old regex
  // relied on, which made the shipping artifact the one it could not inspect.
  assertCommonJsSyntax(await Bun.file(bundle.path).text())
  return report
}

if (import.meta.main) await buildPreload()
