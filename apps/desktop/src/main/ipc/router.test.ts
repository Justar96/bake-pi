import { describe, expect, test } from "bun:test"
import type { IpcMainInvokeEvent } from "electron"
import { BakePiError, type CommandName } from "@bake-pi/contract"
import { routeCommand, type Routing } from "./route.ts"

/** Registration needs Electron; this suite holds the runtime-neutral decisions. */
const senderEvent = { sender: { id: 1 }, senderFrame: { parent: null } } as unknown as IpcMainInvokeEvent

interface Harness {
  routing: Routing
  sent: { name: CommandName; params: unknown; arrivedAt: number | undefined }[]
  restarts: number
  workspaceChoices: number
  recentWorkspaceOpens: number
  attachmentChoices: number
}

const harness = (answer?: (name: CommandName) => unknown): Harness => {
  const sent: Harness["sent"] = []
  const world = {
    sent,
    restarts: 0,
    workspaceChoices: 0,
    recentWorkspaceOpens: 0,
    attachmentChoices: 0,
  } as Harness
  world.routing = {
    guard: { check: (_event, name, params) => ({ name: name as CommandName, params }) },
    host: {
      execute: (async (name: CommandName, params: unknown, timing: { arrivedAt?: number } = {}) => {
        sent.push({ name, params, arrivedAt: timing.arrivedAt })
        const result = answer?.(name)
        if (result instanceof Error) throw result
        return result
      }) as Routing["host"]["execute"],
      restart: async () => {
        world.restarts += 1
        return { started: true, quarantined: [] }
      },
    },
    supervision: {
      chooseWorkspace: async () => {
        world.workspaceChoices += 1
        return {}
      },
      listWorkspaceLocations: async () => ({ recent: [], wsl: [], parents: [] }),
      reopenRecentWorkspace: async () => {
        world.recentWorkspaceOpens += 1
        return {}
      },
      createWorkspace: async () => {
        throw new BakePiError("internal_error")
      },
      chooseAttachments: async () => {
        world.attachmentChoices += 1
        return { attachments: [] }
      },
    },
  }
  return world
}

describe("commands main answers itself", () => {
  test("restart_host reaches the supervisor but never the transport command path", async () => {
    const world = harness()

    const outcome = await routeCommand(world.routing, senderEvent, "restart_host", {})

    expect(outcome).toEqual({ ok: true, result: { started: true, quarantined: [] } })
    expect(world.restarts).toBe(1)
    expect(world.sent).toEqual([])
  })

  test("native picker commands stay in main", async () => {
    const world = harness()

    await routeCommand(world.routing, senderEvent, "choose_workspace", {})
    await routeCommand(world.routing, senderEvent, "reopen_recent_workspace", {})
    await routeCommand(world.routing, senderEvent, "choose_attachments", {
      workspaceRoot: "C:\\work",
      runtime: { kind: "windows" },
    })

    expect([world.workspaceChoices, world.recentWorkspaceOpens, world.attachmentChoices]).toEqual([1, 1, 1])
    expect(world.sent).toEqual([])
  })
})

describe("validated host commands", () => {
  test("are forwarded through the supervisor with their own arrival value", async () => {
    const world = harness(() => ({ snapshot: { summary: { id: "s1" } } }))

    const outcome = await routeCommand(
      world.routing,
      senderEvent,
      "open_session",
      { sessionId: "s1" },
      { arrivedAt: 42 },
    )

    expect(outcome.ok).toBe(true)
    expect(world.sent).toEqual([{ name: "open_session", params: { sessionId: "s1" }, arrivedAt: 42 }])
  })

  test("a guard refusal touches neither supervisor path", async () => {
    const world = harness()
    world.routing.guard = { check: () => { throw new BakePiError("unknown_command") } }

    const outcome = await routeCommand(world.routing, senderEvent, "nonsense", {})

    expect(outcome).toEqual({ ok: false, error: { code: "unknown_command", retryable: false } })
    expect(world.sent).toEqual([])
    expect(world.restarts).toBe(0)
  })

  test("contract errors cross intact and internal errors do not leak detail", async () => {
    const rejected = harness(() => new BakePiError("session_not_found"))
    expect(await routeCommand(rejected.routing, senderEvent, "open_session", { sessionId: "missing" })).toEqual({
      ok: false,
      error: { code: "session_not_found", retryable: false },
    })

    const failed = harness(() => new Error("private main detail"))
    expect(await routeCommand(failed.routing, senderEvent, "list_models", {})).toEqual({
      ok: false,
      error: { code: "internal_error", retryable: false },
    })
  })
})
