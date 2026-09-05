import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { findGitRepository, ignoredByGit } from "./workspace-ignore.ts"

const temporary: string[] = []

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe("workspace Git ignores", () => {
  test("uses Git's current rules, negation, and index", async () => {
    // Production passes canonical workspace/candidate paths to Git. Windows
    // runners may return an 8.3 alias from tmpdir(), unlike Git's own root.
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "bakepi-ignore-")))
    temporary.push(root)
    execFileSync("git", ["init", "--quiet"], { cwd: root })

    const source = join(root, "src")
    const distribution = join(root, "dist")
    mkdirSync(source)
    mkdirSync(distribution)
    const ignoredLog = join(root, "debug.log")
    const includedLog = join(root, "important.log")
    const trackedLog = join(root, "tracked.log")
    writeFileSync(ignoredLog, "ignored")
    writeFileSync(includedLog, "included")
    writeFileSync(trackedLog, "tracked")
    writeFileSync(join(root, ".gitignore"), "dist/\n*.log\n!important.log\n")
    execFileSync("git", ["add", "--force", "tracked.log"], { cwd: root })

    const repository = await findGitRepository(source)
    expect(repository).toBeDefined()
    const ignored = await ignoredByGit(repository!, [distribution, ignoredLog, includedLog, trackedLog])
    expect([...ignored].map((path) => basename(path)).sort()).toEqual(["debug.log", "dist"])

    writeFileSync(join(root, ".gitignore"), "dist/\n")
    const current = await ignoredByGit(repository!, [distribution, ignoredLog])
    expect([...current].map((path) => basename(path))).toEqual(["dist"])
  })

  test("treats an ordinary directory as a non-repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "bakepi-ignore-"))
    temporary.push(root)
    expect(await findGitRepository(root)).toBeUndefined()
  })
})
