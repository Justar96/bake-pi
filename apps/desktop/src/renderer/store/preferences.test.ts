import { afterAll, beforeEach, describe, expect, test } from "bun:test"

const originalWindow = globalThis.window
const values = new Map<string, string>()
const windows = (root: string) => ({ root, runtime: { kind: "windows" as const } })

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  },
})

const {
  forgetWorkspaceSession,
  rememberedWorkspaceSession,
  rememberWorkspaceSession,
} = await import("./preferences.ts")

beforeEach(() => values.clear())

afterAll(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow })
})

describe("per-workspace resume preference", () => {
  test("keeps the last selected session independently for each canonical root", () => {
    rememberWorkspaceSession(windows("C:\\one"), "session-one")
    rememberWorkspaceSession(windows("C:\\two"), "session-two")
    rememberWorkspaceSession(windows("C:\\one"), "session-one-new")

    expect(rememberedWorkspaceSession(windows("C:\\one"))).toBe("session-one-new")
    expect(rememberedWorkspaceSession(windows("C:\\two"))).toBe("session-two")
  })

  test("forgets only the workspace being cleared", () => {
    rememberWorkspaceSession(windows("C:\\one"), "session-one")
    rememberWorkspaceSession(windows("C:\\two"), "session-two")

    forgetWorkspaceSession(windows("C:\\one"))

    expect(rememberedWorkspaceSession(windows("C:\\one"))).toBeUndefined()
    expect(rememberedWorkspaceSession(windows("C:\\two"))).toBe("session-two")
  })

  test("keeps equal Linux roots distinct across WSL distributions", () => {
    const ubuntu = { root: "/home/alice/project", runtime: { kind: "wsl" as const, distro: "Ubuntu" } }
    const debian = { ...ubuntu, runtime: { kind: "wsl" as const, distro: "Debian" } }

    rememberWorkspaceSession(ubuntu, "ubuntu-session")
    rememberWorkspaceSession(debian, "debian-session")

    expect(rememberedWorkspaceSession(ubuntu)).toBe("ubuntu-session")
    expect(rememberedWorkspaceSession(debian)).toBe("debian-session")
  })

  test("treats malformed stored state as absent", () => {
    values.set("bakepi:workspace-resumes", JSON.stringify([{ root: "C:\\one", sessionId: 42 }]))
    expect(rememberedWorkspaceSession(windows("C:\\one"))).toBeUndefined()

    values.set("bakepi:workspace-resumes", "not json")
    expect(rememberedWorkspaceSession(windows("C:\\one"))).toBeUndefined()
  })

  test("migrates a pre-runtime preference to Windows", () => {
    values.set("bakepi:workspace-resumes", JSON.stringify([{ root: "C:\\one", sessionId: "session-one" }]))

    expect(rememberedWorkspaceSession(windows("C:\\one"))).toBe("session-one")
  })
})
