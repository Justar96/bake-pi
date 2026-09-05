import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"

/**
 * Evidence, left on disk, that a tool was running when this process died.
 *
 * This exists because of a hole `recovery.ts` states and cannot close. Main is
 * the only party that survives a host crash, and main reads commands, never
 * events — deliberately, because a supervisor on the event path would be the
 * bottleneck the direct `MessagePort` exists to avoid. Tools start and finish as
 * events. So from the supervisor, a crash in the middle of `rm -rf` and a crash
 * during an idle moment are the same observation, and the interrupted one is
 * silently retried or silently forgotten.
 *
 * The two ways out were named in `recovery.ts`: tee the event stream into main,
 * or have the host write the fact down. This is the second, and it is the better
 * one for a reason worth stating — the marker survives exactly the crash it
 * describes. A tee only works if main is also alive and also correct; a file
 * written before the tool ran is still there when anything opens the session
 * next, including a different application, a later launch, or a person with a
 * text editor.
 *
 * ## What the marker does and does not claim
 *
 * It claims: **execution began.** It is written when Pi announces
 * `tool_execution_start` and removed when the call ends, so its presence means a
 * tool was between those two points when the process stopped. It says nothing
 * about how far the tool got, because nothing here can know that — a file may be
 * whole, half-written, or untouched, and a command may have run to completion
 * with only its result lost.
 *
 * It does not claim to cover approval. A crash while an approval card is open
 * leaves no marker, and that is correct: nothing ran, so there is nothing to
 * warn about.
 *
 * ## Why presence alone is the signal
 *
 * There is no liveness check here, and none is needed. A marker is only read
 * during adoption, and adoption happens *after* `SessionLock` is acquired — so a
 * host that is still alive and still running that tool would have refused the
 * adoption outright. A marker readable at that moment is necessarily a dead
 * host's. Making this a pid check as well would add a second way to be wrong
 * without adding a way to be right.
 *
 * ## Why an unreadable marker still reports
 *
 * The file is rewritten in place on every start and end rather than written
 * through a temporary and renamed, so a crash can tear it. A torn marker is
 * treated as an interruption with unknown details, because both readings of a
 * torn marker mean the same thing: the host died either while running a tool or
 * while writing down that it was about to. Reporting an unknown interruption is
 * right for both. That tolerance is also what lets the write stay a single
 * syscall on a path that runs twice per tool call.
 */

/** One tool call that was in flight, as much of it as the marker recorded. */
export interface InterruptedTool {
  toolCallId: string
  toolName: string
  startedAt: number
  /**
   * The paths the call named, resolved the same way the approval gate resolves
   * them. This is the part that makes the report actionable rather than
   * alarming: "a tool was interrupted" is a shrug, "`write` was interrupted on
   * `src/index.ts`" is something a person can go and check.
   */
  targets: string[]
}

interface MarkerFile {
  /** Diagnostics only. Attribution comes from the marker existing, not from these. */
  hostId: string
  pid: number
  calls: InterruptedTool[]
}

export const toolMarkerPathFor = (sessionFile: string): string => `${sessionFile}.tool`

/**
 * What a tool called for whose details did not survive. Never fabricated from a
 * partially-parsed marker: a half-read JSON array could name one of three calls
 * and omit the destructive one, which is worse than admitting the file is
 * unreadable.
 */
export const UNKNOWN_INTERRUPTED_TOOL: InterruptedTool = {
  toolCallId: "unknown",
  toolName: "unknown",
  startedAt: 0,
  targets: [],
}

/**
 * The marker for one session, owned by the host that has that session open.
 *
 * Writes are synchronous on purpose. The point of the marker is to be on disk
 * before the tool runs, and an awaited write is a write that may still be queued
 * when the tool starts — which is precisely the window the marker exists to
 * cover.
 */
export class ToolMarker {
  readonly #path: string
  readonly #hostId: string
  readonly #calls = new Map<string, InterruptedTool>()

  constructor(sessionFile: string, hostId: string) {
    this.#path = toolMarkerPathFor(sessionFile)
    this.#hostId = hostId
  }

  get path(): string {
    return this.#path
  }

  /** Records a tool call as running. Called before Pi's tool body executes. */
  begin(call: InterruptedTool): void {
    this.#calls.set(call.toolCallId, call)
    this.#flush()
  }

  /**
   * Records a tool call as finished.
   *
   * Pi runs tool batches, so the marker is a set rather than a single entry:
   * removing the file when the first of three calls returns would leave the
   * other two unrecorded while they were still running.
   */
  end(toolCallId: string): void {
    if (!this.#calls.delete(toolCallId)) return
    this.#flush()
  }

  /**
   * Forgets every call and removes the file. Used where the host learns a turn
   * is over — `agent_settled` — and on dispose, so an aborted call that never
   * reported an end does not leave a marker that outlives the session.
   */
  clear(): void {
    this.#calls.clear()
    this.#flush()
  }

  #flush(): void {
    try {
      if (this.#calls.size === 0) {
        removeMarker(this.#path)
        return
      }
      const contents: MarkerFile = { hostId: this.#hostId, pid: process.pid, calls: [...this.#calls.values()] }
      writeFileSync(this.#path, JSON.stringify(contents), "utf8")
    } catch {
      // A marker that cannot be written must not stop the tool from running. The
      // cost of failing here is a lost warning after a crash that may not come;
      // the cost of throwing is a session that cannot use tools because its
      // directory is read-only.
    }
  }
}

/**
 * Reads and removes the marker a previous host left, if there is one.
 *
 * Removal is part of reading, and not an afterthought: an interruption must be
 * reported once. Leaving the file would re-report the same dead tool call every
 * time the session is opened, long after whatever it did was dealt with, and a
 * warning that never goes away is a warning nobody reads.
 *
 * Call this after taking the lock and before the new host can begin a tool of
 * its own.
 */
export const takeInterruptedTools = (sessionFile: string): InterruptedTool[] => {
  const path = toolMarkerPathFor(sessionFile)
  if (!existsSync(path)) return []

  let interrupted: InterruptedTool[]
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<MarkerFile>
    const calls = Array.isArray(parsed.calls) ? parsed.calls.filter(isInterruptedTool) : []
    // An empty or unusable list from a file that exists is still an
    // interruption: the file was written, so a tool had started.
    interrupted = calls.length > 0 ? calls : [UNKNOWN_INTERRUPTED_TOOL]
  } catch {
    interrupted = [UNKNOWN_INTERRUPTED_TOOL]
  }

  removeMarker(path)
  return interrupted
}

/** Removes a marker when possible without disrupting tool completion or adoption. */
const removeMarker = (path: string): void => {
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    // A surviving marker may repeat a warning on the next open. That is smaller
    // than failing either the live tool or the warning already read from disk.
  }
}

const isInterruptedTool = (value: unknown): value is InterruptedTool => {
  if (typeof value !== "object" || value === null) return false
  const call = value as Partial<InterruptedTool>
  return (
    typeof call.toolCallId === "string" &&
    typeof call.toolName === "string" &&
    typeof call.startedAt === "number" &&
    Array.isArray(call.targets) &&
    call.targets.every((target) => typeof target === "string")
  )
}

/**
 * The renderer-safe fragment describing an interrupted call.
 *
 * One target is named rather than all of them, because `detail` is a short
 * fragment by contract and a batch delete could otherwise carry a kilobyte of
 * paths into an error card. The count is kept so the message does not imply the
 * call touched only what it names.
 */
export const describeInterruptedTool = (call: InterruptedTool): string => {
  const [first, ...rest] = call.targets
  if (first === undefined) return call.toolName
  const others = rest.length === 0 ? "" : ` (+${String(rest.length)} more)`
  return `${call.toolName}: ${first}${others}`
}
