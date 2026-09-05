import { describe, expect, test } from "bun:test"
import { Stopwatch, nativeLaunchOffset, readStartupTimings } from "./startup.ts"

/** A clock that advances only when the test says so. */
const scripted = (values: readonly number[]): (() => number) => {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]!
}

describe("the startup stopwatch", () => {
  test("reports the distance between two marks", () => {
    const watch = new Stopwatch(scripted([100, 250]))
    watch.mark("a")
    watch.mark("b")
    expect(watch.leg("a", "b")).toBe(150)
  })

  test("keeps the first reading of a mark, so a restart cannot overwrite startup", () => {
    const watch = new Stopwatch(scripted([10, 20, 5_000]))
    watch.mark("hostForked")
    watch.mark("hostAcked")
    watch.mark("hostForked")
    expect(watch.at("hostForked")).toBe(10)
    expect(watch.leg("hostForked", "hostAcked")).toBe(10)
  })

  test("reports an unreached leg as unknown rather than as zero", () => {
    const watch = new Stopwatch(scripted([10, 20]))
    watch.mark("a")
    expect(watch.leg("a", "b")).toBeUndefined()
    expect(watch.leg("b", "a")).toBeUndefined()
  })

  test("accepts an instant computed elsewhere, and ignores a missing one", () => {
    const watch = new Stopwatch(scripted([500]))
    watch.markAt("processCreated", -320)
    watch.markAt("neverKnown", null)
    watch.mark("scriptStarted")
    expect(watch.leg("processCreated", "scriptStarted")).toBe(820)
    expect(watch.at("neverKnown")).toBeUndefined()
  })

  test("an externally supplied instant is also written only once", () => {
    const watch = new Stopwatch(scripted([0]))
    watch.markAt("processCreated", -320)
    watch.markAt("processCreated", -1)
    expect(watch.at("processCreated")).toBe(-320)
  })
})

describe("the native launch offset", () => {
  test("places process creation before the JavaScript timeline", () => {
    // Electron started the process at epoch 1000; V8's timeline began 320 ms
    // later, so creation sits 320 ms *behind* the origin every mark is relative
    // to.
    expect(nativeLaunchOffset(1_000, 1_320)).toBe(-320)
  })

  test("is unknown, not zero, where the platform cannot answer", () => {
    expect(nativeLaunchOffset(null, 1_320)).toBeNull()
  })
})

describe("the startup report", () => {
  const complete = (): Stopwatch => {
    const watch = new Stopwatch(scripted([0, 400, 900, 905, 1_500, 1_510, 1_600]))
    watch.markAt("processCreated", -300)
    watch.mark("scriptStarted")
    watch.mark("appReady")
    watch.mark("windowLoaded")
    watch.mark("hostForked")
    watch.mark("hostAcked")
    watch.mark("hostAttached")
    watch.mark("rendererReady")
    return watch
  }

  test("decomposes a launch into legs that sum to the whole", () => {
    const timings = readStartupTimings(complete())
    expect(timings).toEqual({
      nativeLaunch: 300,
      toReady: 400,
      toWindowLoaded: 500,
      toHostReady: 595,
      toConnected: 1_810,
      toUsable: 1_900,
      coldStart: 1_200,
    })
    expect(timings.nativeLaunch! + timings.toReady! + timings.toWindowLoaded!).toBe(timings.coldStart!)
  })

  test("omits what a failed startup never reached", () => {
    const watch = new Stopwatch(scripted([0, 400]))
    watch.mark("scriptStarted")
    watch.mark("appReady")
    const timings = readStartupTimings(watch)
    expect(timings).toEqual({ toReady: 400 })
    expect("coldStart" in timings).toBe(false)
  })

  test("rounds to microseconds rather than carrying float noise into a report", () => {
    const watch = new Stopwatch(scripted([0, 0.123456789]))
    watch.mark("scriptStarted")
    watch.mark("appReady")
    expect(readStartupTimings(watch).toReady).toBe(0.123)
  })
})
