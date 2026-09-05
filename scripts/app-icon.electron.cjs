// Run by Electron, not by Bun: `scripts/app-icon.ts` launches it.
//
// `nativeImage` is the one image resampler this repository already ships — it
// is inside the Electron binary that `bun install` fetched — and it only exists
// inside an Electron process. This script is therefore CommonJS JavaScript with
// no imports of its own, so the stock binary can load it unbundled.
//
// argv: <source png> <out dir> <size>...
// Writes `<out dir>/<size>.png` for every size, then exits.
const { app, nativeImage } = require("electron")
const { writeFileSync, mkdirSync } = require("node:fs")
const { join } = require("node:path")

const [source, outDir, ...sizes] = process.argv.slice(2)

app.whenReady().then(() => {
  const image = nativeImage.createFromPath(source)
  if (image.isEmpty()) throw new Error(`could not decode ${source}`)
  mkdirSync(outDir, { recursive: true })
  for (const size of sizes.map(Number)) {
    const resized = image.resize({ width: size, height: size, quality: "best" })
    writeFileSync(join(outDir, `${size}.png`), resized.toPNG())
  }
  app.exit(0)
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
