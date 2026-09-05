import { describe, expect, test } from "bun:test"
import { terminateHostTree } from "./process-group.ts"

/**
 * `REC-001`, the half that is a decision rather than an OS behavior.
 *
 * The OS behavior is measured by `scripts/orphans.ts`, which needs a real
 * Electron process and a real process tree. What is left over is one ordering,
 * and the reason it is worth a test of its own is that getting it wrong is
 * invisible: `taskkill /T` after the parent exits returns quickly, reports an
 * error nobody reads, and leaves the descendants running. The supervisor did
 * exactly that, and every kill test that only asserted "the host is gone" passed
 * the whole time.
 */

const record = () => {
  const order: string[] = []
  return {
    order,
    kill: () => {
      order.push("kill")
    },
    terminate: async (pid: number) => {
      order.push(`terminate:${String(pid)}`)
    },
  }
}

describe("killing the host and its tree", () => {
  test("the tree is taken before the host, because after it there is no tree", async () => {
    const { order, kill, terminate } = record()
    await terminateHostTree(4242, kill, { terminate })
    expect(order).toEqual(["terminate:4242", "kill"])
  })

  test("a host that never spawned is killed without a tree walk", async () => {
    // `UtilityProcess.pid` is undefined until the process spawns — a fact that
    // cost a full round of measurement, because a `taskkill /PID undefined`
    // fails silently and looks exactly like a tree that was already clean.
    const { order, kill, terminate } = record()
    await terminateHostTree(undefined, kill, { terminate })
    expect(order).toEqual(["kill"])
  })

  test("the host is killed even when the tree walk fails", async () => {
    // A supervisor that left a live host behind because cleanup failed would
    // turn a leaked subprocess into a leaked everything.
    const { order, kill } = record()
    await terminateHostTree(4242, kill, {
      terminate: () => Promise.reject(new Error("taskkill unavailable")),
    }).catch(() => order.push("threw"))
    expect(order).toContain("kill")
  })
})
