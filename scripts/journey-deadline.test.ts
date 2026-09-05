import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { withJourneyDeadline } from "./journey-deadline.ts"

const cleared = spyOn(globalThis, "clearTimeout")
afterEach(() => cleared.mockClear())
afterAll(() => cleared.mockRestore())

// These tests await the watchdog itself, not a sleep meant to guess when some
// unrelated work finishes. A renderer that never replies must fail on its own.
test("a permanently pending evaluation fails with the operation and its deadline", async () => {
  await expect(withJourneyDeadline(new Promise<never>(() => {}), 1, "click Settings")).rejects.toThrow(
    "click Settings did not finish within 1 ms",
  )
  expect(cleared).toHaveBeenCalledTimes(1)
})

test("success returns its value and cancels the watchdog", async () => {
  expect(await withJourneyDeadline(Promise.resolve("painted"), 20_000, "evaluate")).toBe("painted")
  expect(cleared).toHaveBeenCalledTimes(1)
})

test("an operation failure keeps its original error and cancels the watchdog", async () => {
  const error = new Error("the renderer connection closed")
  await expect(withJourneyDeadline(Promise.reject(error), 20_000, "evaluate")).rejects.toBe(error)
  expect(cleared).toHaveBeenCalledTimes(1)
})

test("a late response cannot change a timed-out request or poison the next one", async () => {
  const late = Promise.withResolvers<string>()
  const timedOut = withJourneyDeadline(late.promise, 1, "old request")
  await expect(timedOut).rejects.toThrow("old request did not finish")
  late.resolve("stale")
  await expect(timedOut).rejects.toThrow("old request did not finish")
  expect(await withJourneyDeadline(Promise.resolve("current"), 20_000, "new request")).toBe("current")
})

test("a late rejection is still observed after the watchdog wins", async () => {
  const late = Promise.withResolvers<never>()
  const timedOut = withJourneyDeadline(late.promise, 1, "old request")
  await expect(timedOut).rejects.toThrow("old request did not finish")
  late.reject(new Error("late socket failure"))
  await expect(timedOut).rejects.toThrow("old request did not finish")
})
