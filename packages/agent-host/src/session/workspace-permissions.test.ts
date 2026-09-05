import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveWorkspaceTrust, WorkspacePermissionStore } from "./workspace-permissions.ts"

const withAgentDir = (body: (agentDir: string) => void): void => {
  const agentDir = mkdtempSync(join(tmpdir(), "bakepi-permissions-"))
  try {
    body(agentDir)
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
}

const permissionsFile = (agentDir: string): string => join(agentDir, "bake-pi", "workspace-permissions.json")

test("an absent file remembers nothing and defaults to the safe end of the scale", () => {
  withAgentDir((agentDir) => {
    const store = new WorkspacePermissionStore(agentDir)
    expect(store.defaultTrust()).toBe("untrusted")
    expect(store.remembered("/work/app")).toBeUndefined()
  })
})

test("a chosen level survives a new store over the same directory", () => {
  withAgentDir((agentDir) => {
    new WorkspacePermissionStore(agentDir).remember("/work/app", "full")
    expect(new WorkspacePermissionStore(agentDir).remembered("/work/app")).toBe("full")
  })
})

test("the default is stored beside the per-workspace choices, not instead of them", () => {
  withAgentDir((agentDir) => {
    const store = new WorkspacePermissionStore(agentDir)
    store.remember("/work/app", "full")
    store.setDefaultTrust("trusted")
    expect(store.defaultTrust()).toBe("trusted")
    expect(store.remembered("/work/app")).toBe("full")
  })
})

test("a malformed or foreign-version file reads as nothing remembered", () => {
  withAgentDir((agentDir) => {
    mkdirSync(join(agentDir, "bake-pi"), { recursive: true })
    writeFileSync(permissionsFile(agentDir), "{ not json", "utf8")
    expect(new WorkspacePermissionStore(agentDir).defaultTrust()).toBe("untrusted")

    writeFileSync(permissionsFile(agentDir), JSON.stringify({ version: 99, default: "full", roots: { "/work/app": "full" } }), "utf8")
    const store = new WorkspacePermissionStore(agentDir)
    expect(store.defaultTrust()).toBe("untrusted")
    expect(store.remembered("/work/app")).toBeUndefined()
  })
})

test("a level this build does not declare is dropped rather than trusted", () => {
  withAgentDir((agentDir) => {
    mkdirSync(join(agentDir, "bake-pi"), { recursive: true })
    writeFileSync(
      permissionsFile(agentDir),
      JSON.stringify({ version: 1, default: "root", roots: { "/work/app": "everything", "/work/other": "trusted" } }),
      "utf8",
    )
    const store = new WorkspacePermissionStore(agentDir)
    expect(store.defaultTrust()).toBe("untrusted")
    expect(store.remembered("/work/app")).toBeUndefined()
    expect(store.remembered("/work/other")).toBe("trusted")
  })
})

test("a write from another host is merged rather than overwritten", () => {
  withAgentDir((agentDir) => {
    const windows = new WorkspacePermissionStore(agentDir)
    const wsl = new WorkspacePermissionStore(agentDir)
    windows.remember("/work/app", "full")
    // The second store was constructed before that write and must still see it.
    wsl.remember("/work/other", "trusted")
    expect(windows.remembered("/work/other")).toBe("trusted")
    expect(wsl.remembered("/work/app")).toBe("full")
  })
})

test("the file is bounded, and returning to a workspace keeps it", () => {
  withAgentDir((agentDir) => {
    const store = new WorkspacePermissionStore(agentDir)
    store.remember("/work/first", "full")
    for (let index = 0; index < 220; index += 1) {
      store.remember(`/work/filler-${String(index)}`, "trusted")
      // Re-chosen every round, so the oldest entry is never the one a person uses.
      if (index === 100) store.remember("/work/first", "full")
    }
    const stored = JSON.parse(readFileSync(permissionsFile(agentDir), "utf8")) as { roots: Record<string, string> }
    expect(Object.keys(stored.roots).length).toBeLessThanOrEqual(200)
    expect(store.remembered("/work/first")).toBe("full")
    expect(store.remembered("/work/filler-0")).toBeUndefined()
  })
})

test("a remembered level cannot outlive the trust Pi records for it", () => {
  expect(resolveWorkspaceTrust({ piTrusted: true, remembered: "full", fallback: "untrusted" })).toBe("full")
  expect(resolveWorkspaceTrust({ piTrusted: false, remembered: "full", fallback: "trusted" })).toBe("untrusted")
  expect(resolveWorkspaceTrust({ piTrusted: false, remembered: "trusted", fallback: "full" })).toBe("untrusted")
})

test("a remembered restriction stands even where Pi trusts the project", () => {
  expect(resolveWorkspaceTrust({ piTrusted: true, remembered: "untrusted", fallback: "full" })).toBe("untrusted")
})

test("the default applies only where nothing has been decided", () => {
  expect(resolveWorkspaceTrust({ piTrusted: false, remembered: undefined, fallback: "full" })).toBe("full")
  expect(resolveWorkspaceTrust({ piTrusted: false, remembered: undefined, fallback: "untrusted" })).toBe("untrusted")
  // Pi's own grant is a decision, so it is not overridden by a lower default.
  expect(resolveWorkspaceTrust({ piTrusted: true, remembered: undefined, fallback: "untrusted" })).toBe("trusted")
})
