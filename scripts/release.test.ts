import { expect, test } from "bun:test"
import { PublisherGithub } from "@electron-forge/publisher-github"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import config from "../apps/desktop/forge.config.ts"

const root = join(import.meta.dir, "..")
const workspace = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version: string
  license: string
  scripts: Record<string, string>
}
const desktop = JSON.parse(readFileSync(join(root, "apps/desktop/package.json"), "utf8")) as { version: string; license: string }

test("the root and packaged application advertise the same release version", () => {
  expect(workspace.version).toBe(desktop.version)
})

test("release manifests declare the repository's MIT license", () => {
  expect(workspace.license).toBe("MIT")
  expect(desktop.license).toBe(workspace.license)
  expect(readFileSync(join(root, "LICENSE"), "utf8")).toContain("MIT License")
})

test("clean installs download Electron before attempting to stamp its manifest", () => {
  // Electron 44 has no dependency postinstall hook. A cached local binary
  // hides this omission; the first fresh Windows runner then fails on ENOENT.
  expect(workspace.scripts.postinstall).toBe(
    "bun run node_modules/electron/install.js && bun run scripts/manifest.ts",
  )
})

test("the GitHub publisher keeps prerelease versions out of the stable channel", () => {
  const publisher = config.publishers?.find((entry) => entry instanceof PublisherGithub)
  if (!(publisher instanceof PublisherGithub)) throw new Error("the GitHub publisher is missing")
  expect(publisher.config.draft).toBe(true)
  expect(publisher.config.prerelease).toBe(desktop.version.includes("-"))
})
