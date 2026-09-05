import { join } from "node:path"
// The default export is a pre-configured plugin object; the factory is what
// takes options, and `runtimeInjection: false` is not optional here.
import { createStylexBunPlugin } from "@stylexjs/unplugin/bun"
import { appRoot, banner, mode, outDir, repoRoot, runBuild } from "./shared.ts"
import { buildFileIcons } from "./file-icons.build.ts"

const FONT_ASSETS = [
  ["@fontsource-variable/geist/files/geist-latin-wght-normal.woff2", "Geist-Variable.woff2"],
  ["@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2", "GeistMono-Variable.woff2"],
] as const

const FONT_LICENSES = [
  ["@fontsource-variable/geist/LICENSE", "Geist-LICENSE.txt"],
  ["@fontsource-variable/geist-mono/LICENSE", "GeistMono-LICENSE.txt"],
] as const

/**
 * The only build with a plugin chain. StyleX compiles styles to atomic CSS at
 * build time and emits a stylesheet; nothing injects a rule at runtime, which
 * is what lets the packaged renderer run without `style-src 'unsafe-inline'`.
 */
export const buildRenderer = async () => {
  const rendererOut = join(outDir, "renderer")
  const report = await runBuild("renderer", {
    entrypoints: [join(appRoot, "src/renderer/main.tsx")],
    outdir: rendererOut,
    target: "browser",
    format: "esm",
    splitting: true,
    sourcemap: mode() === "production" ? "external" : "inline",
    minify: mode() === "production",
    banner: banner("renderer"),
    define: { "process.env.NODE_ENV": JSON.stringify(mode()) },
    plugins: [
      createStylexBunPlugin({
        // No runtime injection. This is the single option that decides whether
        // the CSP can forbid inline styles, so it is not a preference.
        runtimeInjection: false,
        // StyleX 0.19's Bun path rejects a valid `prefers-reduced-motion`
        // branch in this graph while applying its last-query-wins rewrite.
        // Every conditional property here has one media branch, so there is no
        // precedence for that optional rewrite to resolve; the media rules
        // themselves are still compiled and emitted.
        enableMediaQueryOrder: false,
        dev: mode() === "development",
        useCSSLayers: true,
        unstable_moduleResolution: { type: "commonJS" },
        // The Bun plugin writes the collected stylesheet to a path rather than
        // emitting it as a build output, and defaults to the process working
        // directory — which would put it outside `dist/renderer` and out of
        // reach of the `bakepi://` protocol handler.
        bunDevCssOutput: join(rendererOut, "stylex.css"),
      }),
    ],
  })

  await Bun.write(
    join(rendererOut, "index.html"),
    await Bun.file(join(appRoot, "src/renderer/index.html")).text(),
  )
  await Bun.write(
    join(rendererOut, "fonts.css"),
    await Bun.file(join(appRoot, "src/renderer/fonts.css")).text(),
  )
  for (const [source, output] of FONT_ASSETS) {
    await Bun.write(
      join(rendererOut, "fonts", output),
      Bun.file(join(repoRoot, "node_modules", source)),
    )
  }
  // Fontsource is a build dependency rather than a renderer dependency. Only
  // the two Latin variable subsets and their OFL licenses follow the bundle;
  // no package code enters Electron's runtime graph.
  for (const [source, output] of FONT_LICENSES) {
    await Bun.write(
      join(rendererOut, "fonts", output),
      Bun.file(join(repoRoot, "node_modules", source)),
    )
  }
  await buildFileIcons(rendererOut)
  await assertEveryVariableIsDefined(join(rendererOut, "stylex.css"))
  // Written last, and only once everything else is on disk and checked. A
  // development build is watched, and a watcher that reacted to the outputs
  // themselves would reload the app in the middle of a build: Chromium would
  // open the chunks it found, and Windows would then refuse the writes still to
  // come. One file that means "this bundle is complete" removes the race
  // instead of widening a timeout until it usually misses.
  await Bun.write(join(rendererOut, "build-stamp"), String(Date.now()))
  return report
}

/**
 * Every custom property the stylesheet reads must also be declared in it.
 *
 * This checks for a failure with no symptom at build time and a devastating one
 * at run time. StyleX folds `colors.canvas` into `var(--x1ioh0n2)` wherever it
 * is used, and emits the `:root` block that gives that variable a value only
 * when it compiles the module holding the `defineVars` call. A module exporting
 * nothing else has no import left after the folding, drops out of the bundle,
 * and is never compiled — so the stylesheet ships rules referring to variables
 * that do not exist.
 *
 * Only `defineVars` is exposed to this. A `defineConsts` group folds to its
 * literal and declares no custom property, which is why `sizes.stylex.ts` no
 * longer needs the side-effect import that used to hold it in the graph. The
 * guard now stands over `tokens.stylex.ts`, whose colours, effects and motion
 * are variables precisely because a theme overrides them — and a theme that
 * overrides a variable nothing declared paints every rule that reads it as
 * nothing at all: text the colour of its background, a surface with no edge.
 * The browser discards each of those declarations without a word.
 *
 * Nothing else catches it. The types are satisfied, the build succeeds, the
 * tests pass, and the CSS is present and well-formed. It is visible only by
 * looking at the running application, which is exactly the kind of regression a
 * build should refuse instead.
 */
const assertEveryVariableIsDefined = async (stylesheet: string): Promise<void> => {
  const css = await Bun.file(stylesheet).text()
  const declared = new Set([
    ...[...css.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]!),
    // A dynamic style is registered with `@property` and given its value by
    // `stylex.props` through CSSOM, so the stylesheet names it without ever
    // assigning to it. That is declared, not missing.
    ...[...css.matchAll(/@property\s+(--[\w-]+)/g)].map((match) => match[1]!),
  ])
  // A `var()` may carry a fallback, which makes an undeclared name survivable;
  // only the bare form is a hole.
  const used = new Set([...css.matchAll(/var\((--[\w-]+)\)/g)].map((match) => match[1]!))
  const missing = [...used].filter((name) => !declared.has(name))
  if (missing.length === 0) return
  throw new Error(
    `renderer stylesheet uses ${String(missing.length)} custom ${missing.length === 1 ? "property" : "properties"} nothing declares: ${missing.join(", ")}\n` +
      "  A `.stylex.ts` module whose only exports are `defineVars` is folded out of the bundle and never compiled.\n" +
      "  Import it for its side effect from `src/renderer/main.tsx` to keep it in the graph.",
  )
}

if (import.meta.main) await buildRenderer()
