import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BakePiError } from "@bake-pi/contract"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { fakeSession } from "../../test/fake-session.ts"
import { Diagnostics } from "../diagnostics.ts"
import { EventEmitter } from "../emitter.ts"
import { SessionHost } from "../session-host.ts"
import { lockPathFor, SessionLock } from "./ownership.ts"

/**
 * The write guard where it is actually wired, rather than as pure functions.
 *
 * `ownership.test.ts` proves the fingerprint detects a foreign append.
 * This proves `SessionHost` refuses the mutation when it does, re-records after
 * its own turns so ordinary use never trips the guard, and releases the lock on
 * dispose. The runtime around it is faked; the session file, the second writer,
 * and the fork are real Pi.
 */

const temporary: string[] = []
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true })
})

const userMessage = (text: string) => ({ role: "user", content: text }) as never
const assistantMessage = (text: string) =>
  ({ role: "assistant", content: [{ type: "text", text }] }) as never

const piSession = (): { manager: SessionManager; file: string } => {
  const cwd = mkdtempSync(join(tmpdir(), "bakepi-guard-cwd-"))
  const dir = mkdtempSync(join(tmpdir(), "bakepi-guard-sessions-"))
  temporary.push(cwd, dir)
  const manager = SessionManager.create(cwd, dir)
  manager.appendMessage(userMessage("seed"))
  manager.appendMessage(assistantMessage("seeded"))
  return { manager, file: manager.getSessionFile()! }
}

interface Harness {
  host: SessionHost
  emit: (event: AgentSessionEvent) => void
  /** Pi's in-flight state, so a test can hold a turn open the way steering does. */
  flags: { idle: boolean }
}

/** A `SessionHost` over the shared fake Pi session, with a real file under it. */
const hostOver = (
  sessionFile: string | undefined,
  lock?: SessionLock,
  messages: unknown[] = [],
): Harness => {
  const fake = fakeSession({ sessionFile, messages })

  const host = new SessionHost({
    runtime: fake.runtime,
    emitter: new EventEmitter(),
    diagnostics: new Diagnostics(),
    workspaceId: "workspace-under-test",
    workspaceRoot: tmpdir(),
    trust: "trusted",
    ...(lock === undefined ? {} : { lock }),
  })
  host.attach()
  return { host, emit: fake.emit, flags: fake.flags }
}

describe("refusing to be the second writer", () => {
  test("an untouched session accepts writes", () => {
    const { file } = piSession()
    const { host } = hostOver(file)

    expect(() => host.assertSoleWriter()).not.toThrow()
  })

  test("a session with no file on disk is never refused", () => {
    // Pi writes nothing until an assistant message exists, so a session between
    // its first prompt and its first reply has no file. Refusing there would
    // block the very turn that creates the file.
    const { host } = hostOver(undefined)

    expect(() => host.assertSoleWriter()).not.toThrow()
  })

  test("a foreign append is refused as session_busy rather than forking the tree", () => {
    // The measured hazard, at the point it can still be stopped. Without this
    // the next prompt appends onto a stale leaf and one writer's turns leave the
    // session with nothing reported.
    const { file } = piSession()
    const { host } = hostOver(file)

    SessionManager.open(file).appendMessage(userMessage("the CLI was here"))

    expect(() => host.assertSoleWriter()).toThrow(BakePiError)
    try {
      host.assertSoleWriter()
      throw new Error("unreachable")
    } catch (error) {
      expect((error as BakePiError).code).toBe("session_busy")
      // Not retryable: nothing about waiting and trying again makes the other
      // writer's turns come back.
      expect((error as BakePiError).retryable).toBe(false)
    }
  })

  test("the refusal stands rather than quietly resolving itself", () => {
    // A guard that re-recorded on refusal would fire once and then let the fork
    // happen on the next attempt, which is worse than not guarding at all.
    const { file } = piSession()
    const { host } = hostOver(file)

    SessionManager.open(file).appendMessage(userMessage("the CLI was here"))

    expect(() => host.assertSoleWriter()).toThrow()
    expect(() => host.assertSoleWriter()).toThrow()
    expect(() => host.assertSoleWriter()).toThrow()
  })
})

describe("not tripping over our own writes", () => {
  test("a settled turn re-records the file, so the next prompt is allowed", () => {
    // Without this the guard would refuse every prompt after the first, having
    // mistaken our own appends for someone else's.
    const { manager, file } = piSession()
    const { host, emit } = hostOver(file)

    manager.appendMessage(userMessage("our prompt"))
    manager.appendMessage(assistantMessage("our reply"))

    // Before the turn settles the host has not looked again, and the file has
    // genuinely moved.
    expect(() => host.assertSoleWriter()).toThrow()

    emit({ type: "agent_settled" } as AgentSessionEvent)

    expect(() => host.assertSoleWriter()).not.toThrow()
  })

  test("many turns in a row stay allowed", () => {
    const { manager, file } = piSession()
    const { host, emit } = hostOver(file)

    for (let turn = 0; turn < 5; turn += 1) {
      expect(() => host.assertSoleWriter()).not.toThrow()
      manager.appendMessage(userMessage(`prompt ${turn}`))
      manager.appendMessage(assistantMessage(`reply ${turn}`))
      emit({ type: "agent_settled" } as AgentSessionEvent)
    }

    expect(() => host.assertSoleWriter()).not.toThrow()
  })
})

describe("what a live session is called", () => {
  test("a session names itself by what the user first asked", () => {
    // A session that has not reached disk is not in Pi's listing, so this is the
    // only name it has. A file path would name it to the filesystem instead of
    // to the person who opened it.
    const { file } = piSession()
    const { host } = hostOver(file, undefined, [
      { role: "assistant", content: [{ type: "text", text: "ignored" }] },
      { role: "user", content: "rename the approval gate" },
      { role: "user", content: "and then stop" },
    ])

    expect(host.summary().title).toBe("rename the approval gate")
  })

  test("structured user content matches Pi's first non-empty text extraction", () => {
    const { file } = piSession()
    const { host } = hostOver(file, undefined, [
      { role: "user", content: "" },
      {
        role: "user",
        content: [
          { type: "image", mimeType: "image/png" },
          { type: "text", text: "what" },
          { type: "text", text: "is this" },
        ],
      },
    ])

    expect(host.summary().title).toBe("what is this")
  })

  test("a session with nothing said yet still has a name", () => {
    const { file } = piSession()
    const { host } = hostOver(file)

    expect(host.summary().title).toBe("Untitled session")
  })
})

describe("the lock's lifetime", () => {
  test("disposing the host releases the session for the next one", () => {
    const { file } = piSession()
    const outcome = SessionLock.acquire(file, "host-under-test")
    if (!outcome.acquired) throw new Error("unreachable")

    const { host } = hostOver(file, outcome.lock)
    expect(existsSync(lockPathFor(file))).toBe(true)

    host.dispose()

    expect(existsSync(lockPathFor(file))).toBe(false)
    expect(SessionLock.acquire(file, "a-later-host").acquired).toBe(true)
  })

  test("a session without a lock disposes cleanly", () => {
    const { file } = piSession()
    const { host } = hostOver(file)

    expect(() => host.dispose()).not.toThrow()
  })
})

describe("a turn of our own is not a second writer", () => {
  test("mid-turn appends by this host do not trip the guard", () => {
    // Steering and following up happen *during* a turn, and the turn has
    // already appended by then — the prompt itself, and every tool entry after
    // it. The fingerprint cannot tell those from a foreign append, so a check
    // taken mid-turn refused every steer a user ever sent.
    const { manager, file } = piSession()
    const { host, flags } = hostOver(file)
    flags.idle = false

    manager.appendMessage(userMessage("what this turn already wrote"))

    expect(() => host.assertSoleWriter()).not.toThrow()
  })

  test("the guard resumes once the turn settles", () => {
    // Abstaining is scoped to the turn, not permanent: the settle re-records
    // the baseline, and the next foreign append is refused as before.
    const { manager, file } = piSession()
    const { host, emit, flags } = hostOver(file)
    flags.idle = false

    manager.appendMessage(userMessage("what this turn wrote"))
    emit({ type: "agent_settled" } as never)
    flags.idle = true
    manager.appendMessage(userMessage("the CLI was here"))

    expect(() => host.assertSoleWriter()).toThrow(BakePiError)
  })
})
