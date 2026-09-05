import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseCommandResult } from "@bake-pi/contract"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { type DiscoveredSession, titleFor, toSessionSummary } from "./discovery.ts"

/**
 * Session discovery: what the rail can show, and the property the whole design
 * rests on.
 *
 * That property is in the second describe block. `SessionManager.list` reads
 * session files without modifying them, while `SessionManager.open` repairs a
 * torn file as a side effect — so listing through `open` would destroy the
 * tear evidence for every session in a workspace merely by showing the user a
 * list. If a Pi upgrade ever makes `list` mutate, that test is what says so.
 */

const temporary: string[] = []
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true })
})

const userMessage = (text: string) => ({ role: "user", content: text }) as never
const assistantMessage = (text: string) =>
  ({ role: "assistant", content: [{ type: "text", text }] }) as never

const workspace = (): { cwd: string; dir: string } => {
  const cwd = mkdtempSync(join(tmpdir(), "bakepi-discovery-cwd-"))
  const dir = mkdtempSync(join(tmpdir(), "bakepi-discovery-sessions-"))
  temporary.push(cwd, dir)
  return { cwd, dir }
}

const tornSession = (): {
  cwd: string
  dir: string
  manager: SessionManager
  file: string
  torn: string
} => {
  const { cwd, dir } = workspace()
  const manager = SessionManager.create(cwd, dir)
  manager.appendMessage(userMessage("seed"))
  manager.appendMessage(assistantMessage("seeded"))
  const file = manager.getSessionFile()!
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean)
  writeFileSync(file, [...lines.slice(0, -1), lines.at(-1)!.slice(0, 20)].join("\n"), "utf8")
  return { cwd, dir, manager, file, torn: readFileSync(file, "utf8") }
}

const discovered = (overrides: Partial<DiscoveredSession> = {}): DiscoveredSession => ({
  path: "C:\\sessions\\one.jsonl",
  id: "session-1",
  cwd: "C:\\work",
  created: new Date(1_700_000_000_000),
  modified: new Date(1_700_000_900_000),
  messageCount: 4,
  firstMessage: "make the tests pass",
  ...overrides,
})

describe("what a session is called in the rail", () => {
  test("a name the user set wins over anything derived", () => {
    expect(titleFor({ name: "Refactor the parser", firstMessage: "hello" })).toBe("Refactor the parser")
  })

  test("otherwise the opening message describes it in the user's own words", () => {
    // Better than a filename or a uuid, which describe the session to the
    // filesystem rather than to the person who wrote it.
    expect(titleFor({ firstMessage: "why does the smoke test hang" })).toBe("why does the smoke test hang")
  })

  test("a multi-line opening message is flattened to one line", () => {
    // A pasted stack trace must not become a paragraph in a list.
    expect(titleFor({ firstMessage: "fix this:\n\n  at foo()\n  at bar()" })).toBe("fix this: at foo() at bar()")
  })

  test("blank names and blank messages fall through rather than showing emptiness", () => {
    expect(titleFor({ name: "   ", firstMessage: "\n\t " })).toBe("Untitled session")
    expect(titleFor({})).toBe("Untitled session")
  })

  test("an over-long title is truncated to the contract's ceiling", () => {
    const title = titleFor({ firstMessage: "x".repeat(5_000) })

    expect(title.length).toBe(512)
    expect(title.endsWith("…")).toBe(true)
  })
})

describe("mapping a discovered session onto the contract", () => {
  test("timestamps cross as epoch milliseconds", () => {
    const summary = toSessionSummary(discovered(), "workspace-1")

    expect(summary.createdAt).toBe(1_700_000_000_000)
    expect(summary.updatedAt).toBe(1_700_000_900_000)
  })

  test("an unparseable date becomes zero rather than NaN", () => {
    // NaN would fail schema validation at the boundary, where the failure is
    // reported against the whole command rather than against the session that
    // caused it.
    const summary = toSessionSummary(discovered({ created: new Date("not a date") }), "workspace-1")

    expect(summary.createdAt).toBe(0)
  })

  test("a parent session path is not smuggled in as a parent id", () => {
    // Resolving a path to a session id means opening the parent file, which
    // repairs it. A line in a list is not worth mutating a file for.
    const summary = toSessionSummary(discovered({ parentSessionPath: "C:\\sessions\\parent.jsonl" }), "w")

    expect(summary.parentId).toBeUndefined()
  })

  test("a real listing satisfies the contract's own schema", () => {
    // The mapping is only correct if the boundary accepts it, so the boundary is
    // what checks it here rather than my reading of the DTO.
    const summary = toSessionSummary(discovered({ name: "named" }), "workspace-1")

    expect(() => parseCommandResult("list_sessions", { sessions: [summary] })).not.toThrow()
  })
})

describe("listing a workspace's sessions", () => {
  test("every persisted session is found, and one with no assistant message is not", async () => {
    // Pi writes no file until an assistant message exists, so an unanswered
    // session is genuinely not on disk. The host merges live sessions over the
    // listing for exactly this reason.
    const { cwd, dir } = workspace()

    const first = SessionManager.create(cwd, dir)
    first.appendMessage(userMessage("first session"))
    first.appendMessage(assistantMessage("reply"))

    const unanswered = SessionManager.create(cwd, dir)
    unanswered.appendMessage(userMessage("never answered"))

    const listed = await SessionManager.list(cwd, dir)
    expect(listed.map((session) => session.id)).toEqual([first.getSessionId()])
  })

  test("listing does not modify the files it reads, torn ones included", async () => {
    // The property the design depends on. `SessionManager.open` repairs a torn
    // file; `list` must not, or drawing the session rail would silently destroy
    // the evidence of every unfinished write in the workspace.
    const { cwd, dir, file, torn } = tornSession()
    expect(torn.endsWith("\n")).toBe(false)

    await SessionManager.list(cwd, dir)

    expect(readFileSync(file, "utf8")).toBe(torn)
  })

  test("a torn session still appears in the listing rather than vanishing", async () => {
    // A damaged session the user cannot see is a session they cannot recover.
    const { cwd, dir, manager } = tornSession()

    const listed = await SessionManager.list(cwd, dir)
    expect(listed.map((session) => session.id)).toEqual([manager.getSessionId()])
  })

  test("what Pi reports maps into a valid contract result", async () => {
    const { cwd, dir } = workspace()
    const manager = SessionManager.create(cwd, dir)
    manager.appendMessage(userMessage("a real opening message"))
    manager.appendMessage(assistantMessage("a real reply"))

    const listed = await SessionManager.list(cwd, dir)
    const result = { sessions: listed.map((session) => toSessionSummary(session, "workspace-1")) }

    expect(() => parseCommandResult("list_sessions", result)).not.toThrow()
    expect(result.sessions[0]?.title).toBe("a real opening message")
    expect(result.sessions[0]?.path).toBe(manager.getSessionFile()!)
  })
})
