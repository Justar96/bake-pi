import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { installPiResolution, piAnchor } from "./pi-resolution.ts"

const scratches: string[] = []

const scratch = (): string => {
  const root = mkdtempSync(join(tmpdir(), "bake-pi-anchor-"))
  scratches.push(root)
  return root
}

afterEach(() => {
  for (const path of scratches.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe("deciding whether a managed Pi is in play", () => {
  test("no directory means the bundled Pi, which is the normal case", () => {
    expect(piAnchor(undefined)).toBeUndefined()
    expect(piAnchor("")).toBeUndefined()
  })

  test("a directory without node_modules is ignored rather than trusted", () => {
    // This is what a half-written install looks like. Anchoring at it would
    // capture every Pi import and fail all of them, which is strictly worse
    // than never having looked.
    expect(piAnchor(scratch())).toBeUndefined()
  })

  test("a populated directory produces a file URL inside it", () => {
    const root = scratch()
    mkdirSync(join(root, "node_modules"))

    const anchor = piAnchor(root)

    expect(anchor).toBeDefined()
    expect(anchor?.startsWith("file:")).toBe(true)
    // Node resolves a bare specifier by walking up from the parent's directory,
    // so the anchor's own existence never matters — only where it sits.
    expect(join(fileURLToPath(anchor!), "..")).toBe(root)
  })

  test("installing against nothing installs nothing", () => {
    // Bun has no `module.registerHooks`, so this also covers the runtime that
    // cannot redirect at all: the answer is the bundled Pi either way, and no
    // exception reaches the caller.
    expect(installPiResolution(undefined)).toBeUndefined()
  })
})
