import { describe, expect, test } from "bun:test"
import { RENDERER_COMMAND_NAMES } from "@bake-pi/contract"
import { createCommandSurface } from "./command-bridge.ts"

describe("the preload command surface", () => {
  test("has exactly the contract's command keys", () => {
    const commands = createCommandSurface(async () => ({ ok: true, result: {} }))
    expect(Object.keys(commands).sort()).toEqual([...RENDERER_COMMAND_NAMES])
    expect("open_workspace" in commands).toBe(false)
  })

  test("validates params before invoking main", async () => {
    let calls = 0
    const commands = createCommandSurface(async () => {
      calls += 1
      return { ok: true, result: {} }
    })

    await expect(commands.get_project_trust({ id: "" })).rejects.toEqual({
      code: "malformed_command",
      detail: "get_project_trust",
      retryable: false,
    })
    expect(calls).toBe(0)
  })

  test("accepts a valid result and rejects a malformed one", async () => {
    const valid = createCommandSurface(async () => ({ ok: true, result: { trust: "trusted" } }))
    await expect(valid.get_project_trust({ id: "workspace-1" })).resolves.toEqual({ trust: "trusted" })

    const malformed = createCommandSurface(async () => ({ ok: true, result: { trust: "invented" } }))
    await expect(malformed.get_project_trust({ id: "workspace-1" })).rejects.toEqual({
      code: "internal_error",
      retryable: false,
    })
  })

  test("forwards only a contract-valid error", async () => {
    const expected = { code: "session_busy" as const, retryable: true, detail: "held" }
    const valid = createCommandSurface(async () => ({ ok: false, error: expected }))
    await expect(valid.get_project_trust({ id: "workspace-1" })).rejects.toEqual(expected)

    const malformed = createCommandSurface(async () => ({ ok: false, error: { code: "made_up" } }))
    await expect(malformed.get_project_trust({ id: "workspace-1" })).rejects.toEqual({
      code: "internal_error",
      retryable: false,
    })
  })
})
