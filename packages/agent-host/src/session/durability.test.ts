import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionManager } from "@earendil-works/pi-coding-agent"

/**
 * What Pi's session files actually do, measured rather than assumed.
 *
 * These are the Milestone 0 durability questions — `INT-001` (single writer) and
 * `INT-002` (torn final entry) — and they exist as executable assertions rather
 * than as prose in a document because every one of them is a claim about a
 * pinned upstream version. When Pi changes any of it, this file is what says so.
 *
 * Nothing here is a wish. Several of these tests assert behavior Bake Pi has to
 * defend against, not behavior it wants; the comments say which is which.
 *
 * Read through `SessionManager` only. `loadEntriesFromFile` is exported from Pi's
 * session-manager module but not from the package index, so it is not public API
 * and not what Bake Pi will be running against.
 */

const temporary: string[] = []
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true })
})

const userMessage = (text: string) => ({ role: "user", content: text }) as never
const assistantMessage = (text: string) =>
  ({ role: "assistant", content: [{ type: "text", text }] }) as never

const newSessionDir = (): { cwd: string; dir: string } => {
  const cwd = mkdtempSync(join(tmpdir(), "bakepi-durability-cwd-"))
  const dir = mkdtempSync(join(tmpdir(), "bakepi-durability-sessions-"))
  temporary.push(cwd, dir)
  return { cwd, dir }
}

/** A session that has reached disk, which takes an assistant message. See below. */
const persistedSession = (): { manager: SessionManager; file: string } => {
  const { cwd, dir } = newSessionDir()
  const manager = SessionManager.create(cwd, dir)
  manager.appendMessage(userMessage("seed"))
  manager.appendMessage(assistantMessage("seeded"))
  return { manager, file: manager.getSessionFile()! }
}

const physicalLines = (file: string): string[] => readFileSync(file, "utf8").split("\n").filter(Boolean)

const tearFinalLine = (file: string): string => {
  const lines = physicalLines(file)
  const torn = [...lines.slice(0, -1), lines.at(-1)!.slice(0, 20)].join("\n")
  writeFileSync(file, torn, "utf8")
  return torn
}

const appendInterleavedMessages = (a: SessionManager, b: SessionManager): void => {
  a.appendMessage(userMessage("a1"))
  b.appendMessage(userMessage("b1"))
  a.appendMessage(userMessage("a2"))
  b.appendMessage(userMessage("b2"))
}

const isJson = (line: string): boolean => {
  try {
    JSON.parse(line)
    return true
  } catch {
    return false
  }
}

describe("when a session reaches disk", () => {
  test("nothing is written until an assistant message exists", () => {
    // Measured, and it surprises: a session holding only user messages has no
    // file at all. Any Bake Pi behavior keyed on the session file existing —
    // a rail entry, a resume list, a lock, a mtime comparison — has to treat
    // "no file yet" as an ordinary state rather than an error.
    const { cwd, dir } = newSessionDir()
    const manager = SessionManager.create(cwd, dir)
    const file = manager.getSessionFile()!

    manager.appendMessage(userMessage("only a user message"))
    expect(existsSync(file)).toBe(false)

    manager.appendMessage(assistantMessage("now there is an assistant message"))
    expect(existsSync(file)).toBe(true)

    // The whole backlog is flushed at that point, not just the triggering entry.
    expect(physicalLines(file).length).toBe(3)
  })
})

describe("INT-002: a torn final JSONL entry", () => {
  test("the torn entry is silently discarded and the file is repaired", () => {
    const { manager, file } = persistedSession()
    manager.appendMessage(userMessage("one"))
    manager.appendMessage(userMessage("two"))

    const before = readFileSync(file, "utf8")
    const entriesBefore = SessionManager.open(file).getEntries().length
    expect(before.endsWith("\n")).toBe(true)

    // A kill during append: the last line is half written and unterminated.
    const torn = tearFinalLine(file)

    const reopened = SessionManager.open(file)

    // The measured outcome, and the reason `INT-002` mattered: history committed
    // before the tear survives, the torn entry is gone, and nothing anywhere
    // says so. There is no thrown error, no diagnostic, and no flag on the
    // manager. Bake Pi has to notice this itself if a user is ever to be told.
    expect(reopened.getEntries().length).toBe(entriesBefore - 1)

    // Pi repairs the file by terminating the torn line, so the next append
    // cannot be concatenated onto the fragment.
    const repaired = readFileSync(file, "utf8")
    expect(repaired.endsWith("\n")).toBe(true)
    expect(repaired.length).toBe(torn.length + 1)
  })

  test("the repair terminates the fragment but never removes it", () => {
    // The repair is narrower than the word suggests, and the difference matters.
    // Pi appends a newline so the next entry cannot be concatenated onto the
    // fragment — but the fragment itself stays in the file permanently, as an
    // unparseable line that every future load skips in silence.
    //
    // So a Bake Pi integrity check of the form "does this file contain only
    // valid JSON lines" would report a fault on every session ever killed
    // mid-append, forever. The condition that identifies a *fresh* tear is the
    // file not ending in a newline, and that is true exactly once, because the
    // first load clears it.
    const { manager, file } = persistedSession()
    manager.appendMessage(userMessage("one"))

    tearFinalLine(file)

    const reopened = SessionManager.open(file)
    const recovered = reopened.getEntries().length
    reopened.appendMessage(userMessage("after the repair"))

    const after = physicalLines(file)
    expect(after.filter((line) => !isJson(line))).toHaveLength(1)
    expect(isJson(after.at(-1)!)).toBe(true)
    expect(SessionManager.open(file).getEntries().length).toBe(recovered + 1)
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true)
  })

  test("a torn session header refuses to open and leaves the file alone", () => {
    // The opposite treatment from a torn final entry, and the safer one. A
    // header Pi cannot parse is fatal and loud rather than silently empty, so a
    // damaged file is never mistaken for a fresh session and overwritten.
    const { manager, file } = persistedSession()
    manager.appendMessage(userMessage("one"))

    const lines = physicalLines(file)
    const damaged = [lines[0]!.slice(0, 20), ...lines.slice(1)].join("\n") + "\n"
    writeFileSync(file, damaged, "utf8")

    expect(() => SessionManager.open(file)).toThrow(/not a valid pi session/)
    expect(readFileSync(file, "utf8")).toBe(damaged)
  })
})

describe("INT-001: two writers on one session file", () => {
  test("no lock is taken, so a second writer is never refused", () => {
    // The premise behind `sessionFileLocking: false`. Pi neither takes nor
    // checks an advisory or mandatory lock; opening always succeeds.
    const { file } = persistedSession()

    const readers = [SessionManager.open(file), SessionManager.open(file), SessionManager.open(file)]
    for (const reader of readers) expect(reader.getEntries().length).toBeGreaterThan(0)
  })

  test("concurrent appends do not corrupt bytes", () => {
    // The good news, and the reason the damage is subtle rather than obvious:
    // appends are whole-line and atomic at these sizes, so every physical line
    // in the file remains valid JSON no matter how the writers interleave.
    const { manager: a, file } = persistedSession()
    const b = SessionManager.open(file)

    appendInterleavedMessages(a, b)

    expect(physicalLines(file).every(isJson)).toBe(true)
  })

  test("concurrent appends silently fork the tree and orphan one writer's turns", () => {
    // This is the actual `INT-001` hazard, and it is worse than interleaved
    // bytes because nothing looks broken. Each manager holds its own in-memory
    // leaf pointer and never re-reads the file, so both writers append as
    // children of the same parent. The file keeps every entry; the active
    // branch keeps only one writer's. The other writer's conversation is still
    // on disk and no longer in the session.
    //
    // Bake Pi cannot fix this in Pi. It has to prevent the second writer, which
    // is why application-level single-writer behavior is a Milestone 2
    // deliverable and not a nicety.
    const { manager: a, file } = persistedSession()
    const b = SessionManager.open(file)

    appendInterleavedMessages(a, b)

    const reloaded = SessionManager.open(file)
    const entries = reloaded.getEntries() as { id: string; parentId?: string | null }[]

    const childCounts = new Map<string, number>()
    for (const entry of entries) {
      const parent = String(entry.parentId ?? "root")
      childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1)
    }
    const forks = [...childCounts.values()].filter((count) => count > 1)
    expect(forks).toHaveLength(1)

    // Four appends went in; the active branch shows two of them plus the seed.
    const branch = reloaded.getBranch(reloaded.getLeafId()!)
    expect(entries.length).toBeGreaterThan(branch.length)
    expect(a.getLeafId()).not.toBe(b.getLeafId())
  })

  test("a second writer flushing onto an existing file throws a raw fs error", () => {
    // Pi's first flush is an exclusive create, `openSync(file, "wx")`. So the
    // one case where a second writer *is* refused is the one Bake Pi is least
    // ready for: the error is an unwrapped EEXIST from the filesystem, arriving
    // from inside an `appendMessage` call that looks like bookkeeping.
    const { cwd, dir } = newSessionDir()
    const a = SessionManager.create(cwd, dir)
    const file = a.getSessionFile()!

    const b = SessionManager.create(cwd, dir)
    b.setSessionFile(file)

    a.appendMessage(userMessage("a"))
    a.appendMessage(assistantMessage("a"))
    expect(existsSync(file)).toBe(true)

    b.appendMessage(userMessage("b"))
    expect(() => b.appendMessage(assistantMessage("b"))).toThrow(/EEXIST/)
  })
})
