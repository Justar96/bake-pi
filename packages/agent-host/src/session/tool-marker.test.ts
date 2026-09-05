import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  describeInterruptedTool,
  type InterruptedTool,
  takeInterruptedTools,
  ToolMarker,
  toolMarkerPathFor,
} from "./tool-marker.ts"

/**
 * `REC-003`, the half main cannot see.
 *
 * The mechanism is small enough that the tests worth writing are about its
 * edges rather than its happy path: a batch where one call of three ends, a
 * marker torn by the very crash it exists to describe, and a marker on a path
 * that cannot be written. Each of those is a way the marker could quietly stop
 * meaning what the recovery report claims it means.
 *
 * The end-to-end proof — a real Pi tool call writing a real marker, and a
 * reopened session reporting it — is in `test/vertical-slice.test.ts`. Nothing
 * here drives Pi.
 */

const temporary: string[] = []
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true })
})

const sessionPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "bakepi-marker-"))
  temporary.push(dir)
  return join(dir, "session.jsonl")
}

const call = (id: string, overrides: Partial<InterruptedTool> = {}): InterruptedTool => ({
  toolCallId: id,
  toolName: "write",
  startedAt: 1_700_000_000_000,
  targets: [join("C:", "work", `${id}.txt`)],
  ...overrides,
})

describe("while a tool runs", () => {
  test("the marker is on disk between begin and end, and gone after", () => {
    const file = sessionPath()
    const marker = new ToolMarker(file, "host-1")

    expect(existsSync(marker.path)).toBe(false)
    marker.begin(call("call-1"))
    expect(existsSync(marker.path)).toBe(true)
    marker.end("call-1")
    expect(existsSync(marker.path)).toBe(false)
  })

  test("it sits beside the session file, where a later open will look for it", () => {
    const file = sessionPath()
    expect(new ToolMarker(file, "host-1").path).toBe(toolMarkerPathFor(file))
    expect(toolMarkerPathFor(file)).toBe(`${file}.tool`)
  })

  test("it records what the call named, not merely that one existed", () => {
    const file = sessionPath()
    const marker = new ToolMarker(file, "host-1")
    marker.begin(call("call-1", { toolName: "bash", targets: ["/usr/bin/make"] }))

    const written = JSON.parse(readFileSync(marker.path, "utf8")) as {
      hostId: string
      pid: number
      calls: InterruptedTool[]
    }
    expect(written.hostId).toBe("host-1")
    expect(written.pid).toBe(process.pid)
    expect(written.calls).toEqual([
      { toolCallId: "call-1", toolName: "bash", startedAt: 1_700_000_000_000, targets: ["/usr/bin/make"] },
    ])
  })

  test("a batch keeps the calls that are still running when one of them ends", () => {
    // Pi runs tool batches. Removing the file when the first call returns would
    // leave the other two running with nothing recorded, which is the exact case
    // a crash is most likely to land in.
    const file = sessionPath()
    const marker = new ToolMarker(file, "host-1")
    marker.begin(call("call-1"))
    marker.begin(call("call-2"))
    marker.begin(call("call-3"))

    marker.end("call-2")
    expect(takeInterruptedTools(file).map((entry) => entry.toolCallId)).toEqual(["call-1", "call-3"])
  })

  test("ending a call the marker never saw start changes nothing", () => {
    const file = sessionPath()
    const marker = new ToolMarker(file, "host-1")
    marker.begin(call("call-1"))
    marker.end("call-unknown")
    expect(takeInterruptedTools(file).map((entry) => entry.toolCallId)).toEqual(["call-1"])
  })

  test("a marker that cannot be written does not stop the tool", () => {
    // A directory that does not exist stands in for every reason a write can
    // fail. Throwing here would make an unwritable session directory a session
    // that cannot use tools at all, which is a far worse failure than losing a
    // warning about a crash that may never happen.
    const marker = new ToolMarker(join(sessionPath(), "no-such-directory", "session.jsonl"), "host-1")
    expect(() => {
      marker.begin(call("call-1"))
    }).not.toThrow()
    expect(() => {
      marker.clear()
    }).not.toThrow()
  })
})

describe("what a later open finds", () => {
  test("no marker means no interruption", () => {
    expect(takeInterruptedTools(sessionPath())).toEqual([])
  })

  test("a marker is reported and removed, so the warning does not repeat forever", () => {
    const file = sessionPath()
    new ToolMarker(file, "dead-host").begin(call("call-1"))

    expect(takeInterruptedTools(file)).toEqual([call("call-1")])
    expect(existsSync(toolMarkerPathFor(file))).toBe(false)
    expect(takeInterruptedTools(file)).toEqual([])
  })

  test("a marker torn by the crash still reports an interruption", () => {
    // The marker is rewritten in place, so the crash it describes can cut it
    // mid-write. Both readings of a torn marker — died running a tool, died
    // writing down that it was about to — mean a tool was interrupted, so the
    // unreadable case reports rather than shrugs.
    const file = sessionPath()
    const marker = new ToolMarker(file, "dead-host")
    marker.begin(call("call-1"))
    const whole = readFileSync(marker.path, "utf8")
    writeFileSync(marker.path, whole.slice(0, Math.floor(whole.length / 2)), "utf8")

    const interrupted = takeInterruptedTools(file)
    expect(interrupted).toHaveLength(1)
    expect(interrupted[0]!.toolName).toBe("unknown")
    expect(existsSync(marker.path)).toBe(false)
  })

  test("a marker whose entries are unusable reports unknown rather than nothing", () => {
    // Never assembled from the entries that did parse. A half-read batch could
    // name one of three calls and omit the destructive one, which reads as a
    // complete report and is not one.
    const file = sessionPath()
    writeFileSync(toolMarkerPathFor(file), JSON.stringify({ hostId: "x", pid: 1, calls: [{ nope: true }] }), "utf8")

    const interrupted = takeInterruptedTools(file)
    expect(interrupted).toHaveLength(1)
    expect(interrupted[0]!.toolName).toBe("unknown")
  })

  test("an empty marker is still an interruption, because writing it took a tool to start", () => {
    const file = sessionPath()
    writeFileSync(toolMarkerPathFor(file), JSON.stringify({ hostId: "x", pid: 1, calls: [] }), "utf8")
    expect(takeInterruptedTools(file)).toHaveLength(1)
  })
})

describe("what the user is told", () => {
  test("the tool is named with the path it was working on", () => {
    expect(describeInterruptedTool(call("call-1", { toolName: "write", targets: ["/work/index.ts"] }))).toBe(
      "write: /work/index.ts",
    )
  })

  test("a batch names one target and counts the rest, rather than carrying all of them", () => {
    // `detail` is a short renderer-safe fragment by contract. A delete across a
    // hundred files would otherwise put a kilobyte of paths into an error card.
    expect(
      describeInterruptedTool(call("call-1", { toolName: "delete", targets: ["/a", "/b", "/c"] })),
    ).toBe("delete: /a (+2 more)")
  })

  test("a tool with no resolved targets is named alone rather than with an empty path", () => {
    expect(describeInterruptedTool(call("call-1", { toolName: "bash", targets: [] }))).toBe("bash")
  })
})
