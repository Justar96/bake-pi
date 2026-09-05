import { afterAll, describe, expect, test } from "bun:test"
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import {
  changedSince,
  fingerprintSession,
  lockPathFor,
  processIsAlive,
  readHolder,
  SessionLock,
  type WriteFingerprint,
} from "./ownership.ts"

/**
 * `INT-001`: the two halves of single-writer behaviour.
 *
 * The lock is a real guarantee between Bake Pi hosts and no guarantee at all
 * against the Pi CLI, so the fingerprint tests matter more than the lock tests.
 * The last describe block drives Pi's actual second-writer fork and proves the
 * fingerprint catches it, which is the only test here that speaks to the
 * measured hazard rather than to Bake Pi's own bookkeeping.
 */

const temporary: string[] = []
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true })
})

const alive = () => true
const dead = () => false

/**
 * A fingerprint of a file that is definitely there.
 *
 * `fingerprintSession` returns undefined for a file it could not read, which is
 * a state these tests never construct — every one of them fingerprints a
 * session it just wrote. Unwrapping once here keeps that out of the assertions,
 * and the tests that *do* care about the unreadable case call the real function.
 */
const printOf = (file: string): WriteFingerprint => {
  const fingerprint = fingerprintSession(file)
  if (fingerprint === undefined) throw new Error(`unreadable session file: ${file}`)
  return fingerprint
}

const sessionPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "bakepi-ownership-"))
  temporary.push(dir)
  return join(dir, "session.jsonl")
}

const userMessage = (text: string) => ({ role: "user", content: text }) as never
const assistantMessage = (text: string) =>
  ({ role: "assistant", content: [{ type: "text", text }] }) as never

const piSession = (): { manager: SessionManager; file: string } => {
  const cwd = mkdtempSync(join(tmpdir(), "bakepi-ownership-cwd-"))
  const dir = mkdtempSync(join(tmpdir(), "bakepi-ownership-sessions-"))
  temporary.push(cwd, dir)
  const manager = SessionManager.create(cwd, dir)
  manager.appendMessage(userMessage("seed"))
  manager.appendMessage(assistantMessage("seeded"))
  return { manager, file: manager.getSessionFile()! }
}

describe("liveness", () => {
  test("this process is alive and an impossible pid is not", () => {
    expect(processIsAlive(process.pid)).toBe(true)
    expect(processIsAlive(2_147_483_646)).toBe(false)
  })

  test("a nonsense pid is dead rather than throwing", () => {
    // A lock file is data on disk and may hold anything at all.
    for (const pid of [0, -1, 1.5, Number.NaN]) expect(processIsAlive(pid)).toBe(false)
  })
})

describe("holding a session", () => {
  test("acquiring writes a holder naming this process", () => {
    const file = sessionPath()
    const outcome = SessionLock.acquire(file, "host-a")

    expect(outcome.acquired).toBe(true)
    expect(existsSync(lockPathFor(file))).toBe(true)

    const holder = readHolder(lockPathFor(file))
    expect(holder?.pid).toBe(process.pid)
    expect(holder?.hostId).toBe("host-a")
    expect(holder?.acquiredAt).toBeGreaterThan(0)
  })

  test("the lock sits beside the session and never inside it", () => {
    // A lock written into the session file would be an entry Pi cannot parse.
    const file = sessionPath()
    expect(lockPathFor(file)).toBe(`${file}.lock`)
  })

  test("a second host is refused while the holder lives, and told who holds it", () => {
    const file = sessionPath()
    const first = SessionLock.acquire(file, "host-a", alive)
    expect(first.acquired).toBe(true)

    const second = SessionLock.acquire(file, "host-b", alive)
    expect(second.acquired).toBe(false)
    if (second.acquired) throw new Error("unreachable")
    expect(second.heldBy?.hostId).toBe("host-a")

    // Refusing must not disturb the holder's lock.
    expect(readHolder(lockPathFor(file))?.hostId).toBe("host-a")
  })

  test("releasing hands the session to the next host", () => {
    const file = sessionPath()
    const first = SessionLock.acquire(file, "host-a", alive)
    if (!first.acquired) throw new Error("unreachable")

    first.lock.release()
    expect(existsSync(lockPathFor(file))).toBe(false)

    expect(SessionLock.acquire(file, "host-b", alive).acquired).toBe(true)
  })

  test("releasing twice is not an error", () => {
    // Release runs on both the ordinary close path and disposal.
    const file = sessionPath()
    const outcome = SessionLock.acquire(file, "host-a")
    if (!outcome.acquired) throw new Error("unreachable")

    outcome.lock.release()
    expect(() => outcome.lock.release()).not.toThrow()
  })

  test("a slow shutdown cannot release a lock another host has taken over", () => {
    // The hazard this guards: host A is unresponsive, its lock is stolen, and A
    // then finishes shutting down. A naive release would delete B's lock and
    // leave the session owned by nobody while B still believes it owns it.
    const file = sessionPath()
    const first = SessionLock.acquire(file, "host-a", alive)
    if (!first.acquired) throw new Error("unreachable")

    const second = SessionLock.acquire(file, "host-b", dead)
    expect(second.acquired).toBe(true)

    first.lock.release()

    expect(existsSync(lockPathFor(file))).toBe(true)
    expect(readHolder(lockPathFor(file))?.hostId).toBe("host-b")
  })
})

describe("a lock left behind by a dead host", () => {
  test("is stolen, and the dead holder is reported so the crash can be attributed", () => {
    const file = sessionPath()
    const first = SessionLock.acquire(file, "host-a", alive)
    if (!first.acquired) throw new Error("unreachable")

    const second = SessionLock.acquire(file, "host-b", dead)
    expect(second.acquired).toBe(true)
    if (!second.acquired) throw new Error("unreachable")

    // Not merely "the lock was free". A host died holding this session, which is
    // the input to quarantine and to ambiguous-mutation recovery.
    expect(second.stoleFrom?.hostId).toBe("host-a")
    expect(readHolder(lockPathFor(file))?.hostId).toBe("host-b")
  })

  test("an unreadable lock file is treated as abandoned rather than stranding the session", () => {
    // Refusing forever on a corrupt lock would leave a user with a session they
    // cannot open and no way to say so.
    const file = sessionPath()
    writeFileSync(lockPathFor(file), "{ this is not json", "utf8")

    const outcome = SessionLock.acquire(file, "host-a", alive)
    expect(outcome.acquired).toBe(true)
    if (!outcome.acquired) throw new Error("unreachable")
    expect(outcome.stoleFrom?.hostId).toBe("unreadable")
  })

  test("a lock still being taken is respected rather than stolen", () => {
    // The window the fallback create path opens: the lock file exists, and for
    // the instant before its holder is written it reads as empty. Calling that
    // abandoned is how two hosts end up owning one session, so an empty lock
    // young enough to be a claim in flight is refused — and `dead` is passed to
    // prove the refusal is not the liveness check doing the work, since there is
    // no holder to check the liveness of.
    const file = sessionPath()
    writeFileSync(lockPathFor(file), "", "utf8")

    const outcome = SessionLock.acquire(file, "host-b", dead)

    expect(outcome.acquired).toBe(false)
    if (outcome.acquired) throw new Error("unreachable")
    // Refused with nobody named, rather than refused in the name of a pid that
    // never held anything.
    expect(outcome.heldBy).toBeUndefined()
    expect(readFileSync(lockPathFor(file), "utf8")).toBe("")
  })

  test("an empty lock older than a claim is reclaimed rather than stranding the session", () => {
    // The other half. A host that died between the two syscalls leaves the same
    // empty file, and respecting that forever would make the session unopenable
    // with no way for a user to say so. Age is what separates the two.
    const file = sessionPath()
    const path = lockPathFor(file)
    writeFileSync(path, "", "utf8")
    const longAgo = (Date.now() - 60_000) / 1000
    utimesSync(path, longAgo, longAgo)

    expect(SessionLock.acquire(file, "host-a", dead).acquired).toBe(true)
    expect(readHolder(path)?.hostId).toBe("host-a")
  })

  test("acquiring publishes a complete lock and leaves no staging file behind", () => {
    // The window above is closed by writing the holder to a private file and
    // linking it into place, so the lock never exists without a holder in it.
    // The staging file is an implementation detail that must not outlive the
    // call — a directory filling with them would be the visible symptom.
    const file = sessionPath()
    const outcome = SessionLock.acquire(file, "host-a")

    expect(outcome.acquired).toBe(true)
    expect(readHolder(lockPathFor(file))?.hostId).toBe("host-a")
    expect(readdirSync(dirname(file)).filter((entry) => entry.endsWith(".claim"))).toEqual([])
  })

  test("a lock holding valid JSON that is not a holder is also abandoned", () => {
    const file = sessionPath()
    writeFileSync(lockPathFor(file), JSON.stringify({ note: "wrong shape" }), "utf8")

    expect(SessionLock.acquire(file, "host-a", alive).acquired).toBe(true)
    expect(readHolder(lockPathFor(file))?.hostId).toBe("host-a")
  })
})

describe("detecting a writer no lock can bind", () => {
  test("the mutation fingerprint does not reuse the whole-file integrity scan", () => {
    // `inspectSessionFile` deliberately reads and parses the entire JSONL file.
    // That is necessary before Pi opens a possibly torn session and wrong on
    // this path, which runs before and after every turn. Keep the two jobs from
    // quietly becoming one O(history) operation again.
    const source = readFileSync(join(import.meta.dir, "ownership.ts"), "utf8")
    const fingerprint = source.slice(
      source.indexOf("export const fingerprintSession"),
      source.indexOf("export const changedSince"),
    )
    expect(fingerprint).not.toContain("inspectSessionFile")
  })

  test("an absent session file fingerprints without throwing", () => {
    // The state of every session before its first assistant message.
    expect(printOf(sessionPath())).toEqual({ sizeBytes: 0, lastEntryId: undefined })
  })

  test("an unchanged file is not reported as changed", () => {
    const { file } = piSession()
    const recorded = printOf(file)

    expect(changedSince(recorded, printOf(file))).toBe(false)
  })

  test("Pi's silent fork is caught before the second append", () => {
    // This is `INT-001` itself. A second writer opens the session and appends;
    // `durability.test.ts` proves nothing about the file looks wrong and that
    // our own next append is what orphans a branch. The fingerprint is what
    // makes that refusable.
    const { manager, file } = piSession()
    const recorded = printOf(file)

    const foreign = SessionManager.open(file)
    foreign.appendMessage(userMessage("written by someone else"))

    expect(changedSince(recorded, printOf(file))).toBe(true)

    // And the detection does not depend on our own manager noticing anything:
    // it still holds its stale leaf, which is precisely the problem.
    expect(manager.getLeafId() ?? undefined).toBe(recorded.lastEntryId)
  })

  test("a torn final append keeps the preceding valid entry as the leaf", () => {
    const { file } = piSession()
    const recorded = printOf(file)

    appendFileSync(file, '{"type":"message","id":"torn', "utf8")
    const after = printOf(file)

    expect(after.sizeBytes).toBeGreaterThan(recorded.sizeBytes)
    expect(after.lastEntryId).toBe(recorded.lastEntryId)
    expect(changedSince(recorded, after)).toBe(true)
  })

  test("finds the final entry when one JSON line is larger than the first tail read", () => {
    const { manager, file } = piSession()
    manager.appendMessage(assistantMessage("x".repeat(256 * 1024)))

    expect(printOf(file).lastEntryId).toBe(manager.getLeafId() ?? undefined)
  })

  test("re-recording after our own turn keeps our own writes from looking foreign", () => {
    // Without this the guard would fire on every second prompt.
    const { manager, file } = piSession()
    let recorded = printOf(file)

    manager.appendMessage(userMessage("ours"))
    manager.appendMessage(assistantMessage("ours"))
    expect(changedSince(recorded, printOf(file))).toBe(true)

    recorded = printOf(file)
    expect(changedSince(recorded, printOf(file))).toBe(false)
  })

  test("a file that has no bytes yet is empty, and one that cannot be read is unknown", () => {
    // Pi fixes the session path at creation and defers the write, so a session
    // between its first prompt and its first reply has a path and no file. That
    // is a state worth knowing exactly — the next append changes it, which is
    // what the guard reads. A file that could not be opened for any other
    // reason is a state worth *not* claiming to know: reported as empty, it
    // mismatched every real baseline and refused the user's own next write.
    const file = sessionPath()
    expect(fingerprintSession(file)).toEqual({ sizeBytes: 0, lastEntryId: undefined })

    const { file: written } = piSession()
    const busy = () => {
      throw Object.assign(new Error("EBUSY"), { code: "EBUSY" })
    }
    expect(fingerprintSession(written, busy)).toBeUndefined()
  })

  test("a truncation with no new entry is still a change", () => {
    // `lastEntryId` alone would miss this, which is why size is compared too.
    const { file } = piSession()
    const recorded = printOf(file)

    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean)
    writeFileSync(file, lines.join("\n") + "\n\n", "utf8")

    expect(changedSince(recorded, printOf(file))).toBe(true)
  })
})
