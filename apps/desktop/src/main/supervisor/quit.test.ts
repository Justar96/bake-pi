import { describe, expect, test } from "bun:test"
import { QuitCoordinator } from "./quit.ts"

describe("application quit coordination", () => {
  test("concurrent quit requests await one cleanup and permit the re-entry", async () => {
    let release!: () => void
    const stopping = new Promise<void>((resolve) => { release = resolve })
    let stops = 0
    let quits = 0
    let prevented = 0
    const coordinator = new QuitCoordinator(
      async () => { stops += 1; await stopping },
      () => { quits += 1 },
      () => {},
    )

    coordinator.handle({ preventDefault: () => { prevented += 1 } })
    coordinator.handle({ preventDefault: () => { prevented += 1 } })
    expect(stops).toBe(1)
    expect(prevented).toBe(2)
    expect(coordinator.quitting).toBe(true)

    release()
    await coordinator.settled()
    expect(quits).toBe(1)
    expect(coordinator.quitting).toBe(true)

    coordinator.handle({ preventDefault: () => { prevented += 1 } })
    expect(prevented).toBe(2)
  })

  test("cleanup failure is reported but cannot leave the application half-quit", async () => {
    const failures: unknown[] = []
    let quits = 0
    const coordinator = new QuitCoordinator(
      () => Promise.reject(new Error("stop failed")),
      () => { quits += 1 },
      (error) => failures.push(error),
    )

    coordinator.handle({ preventDefault: () => {} })
    await coordinator.settled()

    expect(failures).toHaveLength(1)
    expect(quits).toBe(1)
  })
})
