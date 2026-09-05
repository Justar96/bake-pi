import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  WorkspaceLocations,
  createWorkspaceDirectory,
  hostPathFor,
  windowsFallbackFor,
  windowsPathFor,
  workspaceParent,
} from "./workspace-locations.ts"

const temporary: string[] = []

const parentDirectory = (): string => {
  const parent = mkdtempSync(join(tmpdir(), "bakepi-workspace-parent-"))
  temporary.push(parent)
  return parent
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe("workspace location capabilities", () => {
  test("offers a stable opaque id and refuses one main did not mint", () => {
    const locations = new WorkspaceLocations()
    const root = parentDirectory()
    const target = { root, runtime: { kind: "windows" as const } }

    expect(locations.offer(target).id).toBe(locations.offer(target).id)
    expect(locations.resolve(locations.offer(target).id)).toEqual(target)
    expect(() => locations.resolve("not-offered")).toThrow("malformed_command")
  })

  test("does not conflate equal Linux roots owned by different distributions", () => {
    const locations = new WorkspaceLocations()
    const ubuntu = { root: "/home/alice/project", runtime: { kind: "wsl" as const, distro: "Ubuntu" } }
    const debian = { ...ubuntu, runtime: { kind: "wsl" as const, distro: "Debian" } }

    expect(locations.offer(ubuntu).id).not.toBe(locations.offer(debian).id)
    expect(locations.offer(ubuntu)).toMatchObject({ root: ubuntu.root, runtime: ubuntu.runtime, displayName: "Ubuntu" })
  })

  test("translates WSL roots only at the native picker boundary", () => {
    const runtime = { kind: "wsl" as const, distro: "Ubuntu" }

    expect(windowsPathFor({ root: "/home/alice/project", runtime })).toBe("\\\\wsl.localhost\\Ubuntu\\home\\alice\\project")
    expect(windowsPathFor({ root: "/mnt/c/Users/alice/project", runtime })).toBe("C:\\Users\\alice\\project")
    expect(hostPathFor("\\\\wsl.localhost\\Ubuntu\\home\\alice\\file.txt", runtime)).toBe("/home/alice/file.txt")
    expect(hostPathFor("D:\\work\\file.txt", runtime)).toBe("/mnt/d/work/file.txt")
    expect(workspaceParent({ root: "/home/alice/project", runtime })).toEqual({ root: "/home/alice", runtime })
    expect(windowsFallbackFor({ root: "/home/alice/project", runtime })).toEqual({
      root: "\\\\wsl.localhost\\Ubuntu\\home\\alice\\project",
      runtime: { kind: "windows" },
    })
  })

  test("refuses a picker result owned by another WSL distribution", () => {
    expect(() => hostPathFor("\\\\wsl.localhost\\Debian\\home\\alice\\file.txt", {
      kind: "wsl",
      distro: "Ubuntu",
    })).toThrow("path_outside_workspace")
  })
})

describe("workspace creation", () => {
  test("creates exactly one child below the canonical parent", async () => {
    const parent = parentDirectory()

    const root = await createWorkspaceDirectory(parent, "project", false)

    expect(root).toBe(join(realpathSync.native(parent), "project"))
    expect(existsSync(root)).toBe(true)
  })

  test("rejects empty, dot and path-shaped names before touching the filesystem", async () => {
    const parent = parentDirectory()
    const invalid = ["", " ", ".", "..", "../outside", "..\\outside", "nested/child", "nested\\child", "bad\0name"]

    for (const name of invalid) {
      await expect(createWorkspaceDirectory(parent, name, false)).rejects.toMatchObject({
        code: "malformed_command",
        detail: "invalid_workspace_name",
      })
    }

    expect(existsSync(join(parent, "outside"))).toBe(false)
    expect(existsSync(join(parent, "nested"))).toBe(false)
  })

  test("rejects a parent that is not a directory", async () => {
    const parent = parentDirectory()
    const file = join(parent, "file.txt")
    writeFileSync(file, "not a directory", "utf8")

    await expect(createWorkspaceDirectory(file, "project", false)).rejects.toMatchObject({
      code: "malformed_command",
      detail: "workspace_parent_not_directory",
    })
  })

  test("rolls back the new directory when requested git initialization fails", async () => {
    const parent = parentDirectory()
    const root = join(parent, "project")

    await expect(createWorkspaceDirectory(parent, "project", true, async () => {
      throw new Error("git unavailable")
    })).rejects.toMatchObject({ code: "internal_error", detail: "git_init_failed" })

    expect(existsSync(root)).toBe(false)
  })
})
