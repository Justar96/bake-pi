import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { inspectSessionFile, willLoseEntries } from "./integrity.ts"

/**
 * The integrity probe is tested against files Pi actually produced, not against
 * synthetic JSONL. The probe exists to describe Pi's behaviour, so a fixture I
 * wrote by hand could only confirm my assumptions about it.
 *
 * `durability.test.ts` is the measurement of what Pi does. This is the check
 * that Bake Pi reads it correctly.
 */

const temporary: string[] = []
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true })
})

const userMessage = (text: string) => ({ role: "user", content: text }) as never
const assistantMessage = (text: string) =>
  ({ role: "assistant", content: [{ type: "text", text }] }) as never

/** A real Pi session on disk, which takes an assistant message to flush. */
const piSession = (turns = 2): { manager: SessionManager; file: string } => {
  const cwd = mkdtempSync(join(tmpdir(), "bakepi-integrity-cwd-"))
  const dir = mkdtempSync(join(tmpdir(), "bakepi-integrity-sessions-"))
  temporary.push(cwd, dir)
  const manager = SessionManager.create(cwd, dir)
  manager.appendMessage(userMessage("seed"))
  manager.appendMessage(assistantMessage("seeded"))
  for (let index = 0; index < turns; index += 1) manager.appendMessage(userMessage(`turn ${index}`))
  return { manager, file: manager.getSessionFile()! }
}

/** A kill during append: the final line is half written and unterminated. */
const tearFinalLine = (file: string): void => {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean)
  writeFileSync(file, [...lines.slice(0, -1), lines.at(-1)!.slice(0, 20)].join("\n"), "utf8")
}

describe("a session file that is not damaged", () => {
  test("an absent file is an ordinary state rather than an error", () => {
    // Pi writes nothing until an assistant message exists, so this is the state
    // of every session between its first prompt and its first reply.
    const integrity = inspectSessionFile(join(tmpdir(), "bakepi-nonexistent-session.jsonl"))

    expect(integrity.exists).toBe(false)
    expect(integrity.freshTear).toBe(false)
    expect(willLoseEntries(integrity)).toBe(false)
  })

  test("an intact Pi file reports no tear, no scar, and a readable header", () => {
    const { manager, file } = piSession()
    const integrity = inspectSessionFile(file)

    expect(integrity.exists).toBe(true)
    expect(integrity.freshTear).toBe(false)
    expect(integrity.scarLines).toBe(0)
    expect(integrity.headerUnreadable).toBe(false)
    expect(integrity.headerSessionId).toBe(manager.getSessionId())
    expect(integrity.validLines).toBe(readFileSync(file, "utf8").split("\n").filter(Boolean).length)
    expect(willLoseEntries(integrity)).toBe(false)

    // The fingerprint's load-bearing field agrees with Pi's own view of where
    // the session ends.
    expect(integrity.lastEntryId).toBe(manager.getLeafId() ?? undefined)
  })

  test("a created but unwritten file is distinguished from a missing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "bakepi-integrity-empty-"))
    temporary.push(dir)
    const file = join(dir, "session.jsonl")
    writeFileSync(file, "", "utf8")

    const integrity = inspectSessionFile(file)
    expect(integrity.exists).toBe(true)
    expect(integrity.sizeBytes).toBe(0)
    expect(integrity.validLines).toBe(0)
    expect(willLoseEntries(integrity)).toBe(false)
  })
})

describe("a fresh tear, which is visible exactly once", () => {
  test("the unterminated fragment is detected and measured", () => {
    const { file } = piSession()
    const before = inspectSessionFile(file)

    tearFinalLine(file)
    const torn = inspectSessionFile(file)

    expect(torn.freshTear).toBe(true)
    expect(torn.headerSessionId).toBe(before.headerSessionId)
    expect(torn.fragmentBytes).toBeGreaterThan(0)
    expect(willLoseEntries(torn)).toBe(true)

    // The entry being lost is the one that had not finished writing, so the last
    // *complete* entry is unchanged — which is why `lastEntryId` is a safe
    // fingerprint even across a tear.
    expect(torn.validLines).toBe(before.validLines - 1)
    expect(torn.lastEntryId).not.toBe(before.lastEntryId)
  })

  test("Pi's load destroys the signal, which is why the probe has to run first", () => {
    // The whole reason this module exists. After `SessionManager.open`, the file
    // is terminated and the tear is indistinguishable from an old scar: the
    // probe would now report nothing lost, and it would be right about the file
    // and wrong about the session.
    const { file } = piSession()
    tearFinalLine(file)

    expect(willLoseEntries(inspectSessionFile(file))).toBe(true)

    SessionManager.open(file)

    const after = inspectSessionFile(file)
    expect(after.freshTear).toBe(false)
    expect(after.fragmentBytes).toBe(0)
    expect(willLoseEntries(after)).toBe(false)
    expect(after.scarLines).toBe(1)
  })

  test("a scar is history and not a fault, so a repaired session opens clean", () => {
    // A session killed mid-append once, then used normally for a month, must not
    // report a fault on every open for the rest of its life.
    const { file } = piSession()
    tearFinalLine(file)
    const reopened = SessionManager.open(file)
    reopened.appendMessage(userMessage("back to work"))
    reopened.appendMessage(assistantMessage("carrying on"))

    const integrity = inspectSessionFile(file)
    expect(integrity.scarLines).toBe(1)
    expect(integrity.freshTear).toBe(false)
    expect(willLoseEntries(integrity)).toBe(false)
    expect(integrity.lastEntryId).toBe(reopened.getLeafId() ?? undefined)
  })

  test("two tears leave two scars, and only the newest is fresh", () => {
    const { file } = piSession()
    tearFinalLine(file)
    const reopened = SessionManager.open(file)
    reopened.appendMessage(userMessage("more"))
    reopened.appendMessage(assistantMessage("more"))
    tearFinalLine(file)

    const integrity = inspectSessionFile(file)
    expect(integrity.freshTear).toBe(true)
    expect(integrity.scarLines).toBe(1)
    expect(willLoseEntries(integrity)).toBe(true)
  })
})

describe("a torn header", () => {
  test("is reported as unreadable, and loses nothing silently", () => {
    // Pi throws on this file rather than opening it empty, so nothing is
    // silently lost and `willLoseEntries` must not claim otherwise. The session
    // is unopenable, which is a different problem with a different remedy.
    const { file } = piSession()
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean)
    writeFileSync(file, [lines[0]!.slice(0, 20), ...lines.slice(1)].join("\n") + "\n", "utf8")

    const integrity = inspectSessionFile(file)
    expect(integrity.headerUnreadable).toBe(true)
    expect(willLoseEntries(integrity)).toBe(false)
    expect(() => SessionManager.open(file)).toThrow(/not a valid pi session/)
  })

  test("the probe never modifies the file it judges", () => {
    // It runs before Pi on a file that may be the user's only copy of a
    // conversation.
    const { file } = piSession()
    tearFinalLine(file)
    const before = readFileSync(file, "utf8")

    inspectSessionFile(file)
    inspectSessionFile(file)

    expect(readFileSync(file, "utf8")).toBe(before)
  })
})
