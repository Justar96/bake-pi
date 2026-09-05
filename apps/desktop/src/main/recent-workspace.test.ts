import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RecentWorkspaceStore } from "./recent-workspace.ts"

const temporary: string[] = []
const windows = (root: string) => ({ root, runtime: { kind: "windows" as const } })

const fixture = (): { directory: string; path: string } => {
  const directory = mkdtempSync(join(tmpdir(), "bakepi-recent-workspace-"))
  temporary.push(directory)
  return { directory, path: join(directory, "recent-workspace.json") }
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe("recent workspace preference", () => {
  test("round-trips the absolute root selected by main", async () => {
    const saved = fixture()
    const store = new RecentWorkspaceStore(saved.path)

    await store.remember(windows(saved.directory))

    expect(await store.read()).toEqual(windows(saved.directory))
  })

  test("keeps a most-recent-first list without duplicates and reads the version 1 file", async () => {
    const saved = fixture()
    const store = new RecentWorkspaceStore(saved.path)
    const [a, b] = [join(saved.directory, "a"), join(saved.directory, "b")]

    await store.remember(windows(a))
    await store.remember(windows(b))
    await store.remember(windows(a))
    expect(await store.list()).toEqual([windows(a), windows(b)])

    writeFileSync(saved.path, JSON.stringify({ version: 1, root: b }), "utf8")
    expect(await store.list()).toEqual([windows(b)])
  })

  test("keeps only the five latest workspaces", async () => {
    const saved = fixture()
    const store = new RecentWorkspaceStore(saved.path)
    const roots = Array.from({ length: 7 }, (_, index) => join(saved.directory, String(index)))

    for (const root of roots) await store.remember(windows(root))

    expect(await store.list()).toEqual(roots.slice(2).reverse().map(windows))
  })

  test("keeps the same Linux root distinct in different WSL distributions", async () => {
    const saved = fixture()
    const store = new RecentWorkspaceStore(saved.path)
    const ubuntu = { root: "/home/alice/project", runtime: { kind: "wsl" as const, distro: "Ubuntu" } }
    const debian = { root: ubuntu.root, runtime: { kind: "wsl" as const, distro: "Debian" } }

    await store.remember(ubuntu)
    await store.remember(debian)

    expect(await store.list()).toEqual([debian, ubuntu])
    expect(await Bun.file(saved.path).text()).not.toContain("\\\\wsl")
  })

  test("treats missing, malformed and relative values as no preference", async () => {
    const saved = fixture()
    const store = new RecentWorkspaceStore(saved.path)
    expect(await store.read()).toBeUndefined()

    writeFileSync(saved.path, "not json", "utf8")
    expect(await store.read()).toBeUndefined()

    writeFileSync(saved.path, JSON.stringify({ version: 1, root: "relative/project" }), "utf8")
    expect(await store.read()).toBeUndefined()
  })
})
