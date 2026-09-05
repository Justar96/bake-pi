import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PiStore } from "./store.ts"

const scratches: string[] = []

const store = (): PiStore => {
  const root = mkdtempSync(join(tmpdir(), "bake-pi-store-"))
  scratches.push(root)
  return new PiStore(root)
}

/** A finished staging directory, the only thing `commit` accepts. */
const staged = (target: PiStore, version: string): string => {
  const directory = join(target.stagingDir, `${version}-staged`)
  mkdirSync(join(directory, "node_modules", "@earendil-works", "pi-coding-agent"), { recursive: true })
  writeFileSync(join(directory, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "{}")
  return directory
}

afterEach(() => {
  for (const path of scratches.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe("the managed Pi store", () => {
  test("reports nothing before anything is installed, and the bundled Pi is what that means", () => {
    const target = store()

    expect(target.list()).toEqual([])
    expect(target.active()).toBeUndefined()
  })

  test("a committed version becomes listable and selectable", () => {
    const target = store()

    target.commit(staged(target, "0.85.1"), "0.85.1", 133)
    target.activate("0.85.1")

    expect(target.list()).toEqual([expect.objectContaining({ version: "0.85.1", packages: 133 })])
    expect(target.active()).toBe("0.85.1")
    expect(existsSync(join(target.rootFor("0.85.1"), "node_modules"))).toBe(true)
  })

  test("selecting nothing returns to the bundled Pi without deleting the install", () => {
    const target = store()
    target.commit(staged(target, "0.85.1"), "0.85.1", 133)
    target.activate("0.85.1")

    target.activate(undefined)

    // The way back has to be free, or nobody tries a new Pi in the first place.
    expect(target.active()).toBeUndefined()
    expect(target.list()).toHaveLength(1)
  })

  test("a version that was never installed cannot be selected", () => {
    const target = store()

    expect(() => { target.activate("9.9.9") }).toThrow(/not installed/)
  })

  test("a pointer at a version that is gone reads as the bundled Pi rather than throwing", () => {
    const target = store()
    target.commit(staged(target, "0.85.1"), "0.85.1", 1)
    target.activate("0.85.1")

    // What clearing application data by hand leaves behind. The answer must be
    // the copy in the asar, not a host that refuses to start.
    rmSync(target.rootFor("0.85.1"), { recursive: true, force: true })

    expect(target.active()).toBeUndefined()
  })

  test("the version in use cannot be removed", () => {
    const target = store()
    target.commit(staged(target, "0.85.1"), "0.85.1", 1)
    target.activate("0.85.1")

    expect(() => { target.remove("0.85.1") }).toThrow(/in use/)
    expect(target.list()).toHaveLength(1)
  })

  test("committing over an existing version replaces it", () => {
    const target = store()
    target.commit(staged(target, "0.85.1"), "0.85.1", 1)

    target.commit(staged(target, "0.85.1"), "0.85.1", 133)

    expect(target.list()).toEqual([expect.objectContaining({ version: "0.85.1", packages: 133 })])
  })

  test("a directory with no node_modules is not an install, however it got there", () => {
    const target = store()
    mkdirSync(join(target.versionsDir, "0.0.1"), { recursive: true })

    // What an interrupted `rm` leaves. Listing it would offer a Pi that cannot
    // load, and the offer is worse than the absence.
    expect(target.list()).toEqual([])
  })

  test("sweeping clears staging and the leftovers a locked replacement left behind", () => {
    const target = store()
    mkdirSync(join(target.stagingDir, "abandoned"), { recursive: true })
    mkdirSync(join(target.versionsDir, "0.85.0.old-1700000000000"), { recursive: true })
    target.commit(staged(target, "0.85.1"), "0.85.1", 1)

    target.sweep()

    expect(existsSync(target.stagingDir)).toBe(false)
    expect(existsSync(join(target.versionsDir, "0.85.0.old-1700000000000"))).toBe(false)
    expect(target.list()).toHaveLength(1)
  })
})
