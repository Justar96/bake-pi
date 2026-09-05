import { closeSync, fstatSync, linkSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeSync } from "node:fs"

/**
 * Who is allowed to write a session file.
 *
 * `durability.test.ts` measured why this module has to exist. Pi takes no lock
 * of any kind, and two writers do not collide loudly — they fork the session
 * tree, because each `SessionManager` holds its own in-memory leaf pointer and
 * never re-reads the file. Every entry stays on disk; one writer's turns quietly
 * stop being part of the session. Nothing reports it.
 *
 * Two mechanisms, because one cannot cover both cases:
 *
 * 1. **`SessionLock`** stops a second *Bake Pi* host. It is a real guarantee
 *    within the application, and it is honestly nothing more than that: the Pi
 *    CLI does not know this file exists and will never consult it. A lock cannot
 *    bind a program that does not take it.
 * 2. **A fingerprint** detects a writer the lock cannot bind. Before mutating,
 *    the host re-reads the file's identity; if it moved since we last looked,
 *    someone else wrote, and appending now is precisely what forks the tree.
 *
 * The second is detection, not prevention, and the window is real: it closes to
 * the duration of one turn, not to zero. That is the strongest claim available
 * against a program that takes no lock, and overstating it would be worse than
 * the gap.
 */

export interface LockHolder {
  pid: number
  hostId: string
  acquiredAt: number
}

export type LockOutcome =
  | {
      acquired: true
      lock: SessionLock
      /**
       * Set when the lock was taken from a holder whose process is gone. That is
       * the crash-recovery signal: a host died with this session open, so its
       * last turn may be exactly the ambiguous mutation `REC-003` is about.
       */
      stoleFrom: LockHolder | undefined
    }
  | {
      acquired: false
      /**
       * Undefined when the lock is held but the holder could not be named — a
       * claim caught between its two syscalls on the fallback path. Refused all
       * the same; there is simply nobody to attribute it to, and inventing a
       * holder would put a pid that never held anything in front of a user.
       */
      heldBy: LockHolder | undefined
    }

export const lockPathFor = (sessionFile: string): string => `${sessionFile}.lock`

/** Injected in tests so the stale-holder path does not require killing processes. */
export type LivenessCheck = (pid: number) => boolean

export const processIsAlive: LivenessCheck = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    // Signal 0 performs the permission and existence check without delivering
    // anything. Works on Windows, where Node maps it onto a process handle open.
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists and belongs to another user. That is alive,
    // and treating it as dead would steal a lock from a running host.
    return (error as { code?: string }).code === "EPERM"
  }
}

/**
 * An advisory lock file beside the session, held for as long as a host has the
 * session open.
 *
 * Advisory is the accurate word and the reason `sessionFileLocking` stays false
 * in the handshake: this is a Bake Pi convention, not a filesystem lock. What it
 * does guarantee is that two Bake Pi hosts — a second window, a restarted host
 * racing its own predecessor's shutdown — cannot both believe they own a
 * session.
 */
export class SessionLock {
  readonly #path: string
  readonly #hostId: string
  #released = false

  private constructor(path: string, hostId: string) {
    this.#path = path
    this.#hostId = hostId
  }

  get path(): string {
    return this.#path
  }

  /**
   * Takes the lock, stealing it only from a holder whose process is provably
   * gone.
   *
   * There is exactly one retry after a steal. A second EEXIST means another
   * process stole the same stale lock in the same instant and won, and the
   * correct answer is to lose rather than to loop: retrying until success is how
   * two hosts end up both believing they own a session.
   */
  static acquire(
    sessionFile: string,
    hostId: string,
    isAlive: LivenessCheck = processIsAlive,
  ): LockOutcome {
    const path = lockPathFor(sessionFile)
    if (SessionLock.#tryCreate(path, hostId)) {
      return { acquired: true, lock: new SessionLock(path, hostId), stoleFrom: undefined }
    }

    const holder = readHolder(path)
    if (holder !== undefined && isAlive(holder.pid)) return { acquired: false, heldBy: holder }

    // An empty lock is not an abandoned one. `#tryCreate` publishes the holder
    // and the file in a single atomic step where the platform allows it, but on
    // the fallback path the file exists for the instant between its exclusive
    // create and its write — and a second host that read it there would find no
    // holder, call it abandoned, and steal a lock somebody is in the middle of
    // taking. Two Bake Pi hosts would then both believe they own the session,
    // which is the fork this whole module exists to prevent. So a lock that is
    // empty *and* fresh is treated as held: losing a race we might have won
    // costs one refusal, and winning one we should have lost costs the session.
    if (holder === undefined && claimInFlight(path)) return { acquired: false, heldBy: undefined }

    // Either the holder is gone, or the lock file is unreadable. An unreadable
    // lock cannot be attributed to a live process, and refusing forever would
    // strand the session with no way for a user to recover it, so it is treated
    // as abandoned.
    try {
      unlinkSync(path)
    } catch {
      // Someone else removed it first, which is the outcome we wanted anyway.
    }

    if (SessionLock.#tryCreate(path, hostId)) {
      return {
        acquired: true,
        lock: new SessionLock(path, hostId),
        stoleFrom: holder ?? { pid: 0, hostId: "unreadable", acquiredAt: 0 },
      }
    }

    return { acquired: false, heldBy: readHolder(path) }
  }

  /**
   * Releases the lock, and only if we still hold it.
   *
   * The hostId comparison is what keeps a slow shutdown from deleting the lock a
   * *different* host has since taken over this session. Idempotent, because
   * release runs on both the ordinary close path and the disposal path.
   */
  release(): void {
    if (this.#released) return
    this.#released = true
    const holder = readHolder(this.#path)
    if (holder !== undefined && holder.hostId !== this.#hostId) return
    try {
      unlinkSync(this.#path)
    } catch {
      // Already gone. Nothing to undo.
    }
  }

  /**
   * Publishes the lock and its holder in one step, so the file is never
   * observable without a holder in it.
   *
   * `open(path, "wx")` is atomic, but the write that names the holder is not
   * part of it, and the gap between them is a window where another host reads
   * an empty lock. A hard link closes that: the holder is written to a private
   * temporary file first, and `link` publishes an already-complete file under
   * the lock's name — atomically, failing if the name is taken.
   *
   * Hard links are not everywhere (FAT and exFAT volumes refuse them), so the
   * exclusive create remains as a fallback rather than a session directory on
   * the wrong filesystem meaning no locking at all. `acquire` covers that
   * path's window by refusing a fresh empty lock instead of stealing it.
   */
  static #tryCreate(path: string, hostId: string): boolean {
    const holder = JSON.stringify({ pid: process.pid, hostId, acquiredAt: Date.now() } satisfies LockHolder)
    const staging = `${path}.${String(process.pid)}.${hostId}.claim`
    let fd: number | undefined
    try {
      fd = openSync(staging, "wx")
      writeSync(fd, holder)
      closeSync(fd)
      fd = undefined
      linkSync(staging, path)
      return true
    } catch (error) {
      // The lock's name being taken is the one failure that is an answer rather
      // than a fault: someone else holds it, and no fallback applies.
      if ((error as { code?: string }).code === "EEXIST") return false
      if (fd !== undefined) {
        closeSync(fd)
        fd = undefined
      }
      return SessionLock.#tryCreateUnlinked(path, holder)
    } finally {
      if (fd !== undefined) closeSync(fd)
      try {
        unlinkSync(staging)
      } catch {
        // Never created, or already published and removed. Nothing to clean.
      }
    }
  }

  /** The fallback for volumes without hard links: exclusive create, then write. */
  static #tryCreateUnlinked(path: string, holder: string): boolean {
    let fd: number | undefined
    try {
      fd = openSync(path, "wx")
      writeSync(fd, holder)
      return true
    } catch {
      return false
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
}

/** How long an empty lock is credited to a host still taking it. */
const CLAIM_WINDOW_MS = 1_000

/**
 * Whether an empty lock file belongs to a claim still in progress.
 *
 * Only the fallback create path can leave one, and only for the instant between
 * its two syscalls, so anything older is the remnant of a host that died in
 * that instant — and refusing that forever would strand the session. The clock
 * is what separates the two, and it is the file's own mtime rather than ours.
 */
const claimInFlight = (lockPath: string): boolean => {
  try {
    const stats = statSync(lockPath)
    return stats.size === 0 && Date.now() - stats.mtimeMs < CLAIM_WINDOW_MS
  } catch {
    // Gone between the failed create and now, which makes it nobody's claim.
    return false
  }
}

export const readHolder = (lockPath: string): LockHolder | undefined => {
  try {
    const value = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockHolder>
    if (typeof value.pid !== "number" || typeof value.hostId !== "string") return undefined
    return { pid: value.pid, hostId: value.hostId, acquiredAt: value.acquiredAt ?? 0 }
  } catch {
    return undefined
  }
}

/**
 * The identity of a session file at a moment, cheap enough to re-take before
 * every mutation.
 *
 * `lastEntryId` is the load-bearing field: it is what a foreign append
 * necessarily changes. `sizeBytes` catches a write that does not add an
 * identified entry — a tear, or a truncation.
 */
export interface WriteFingerprint {
  sizeBytes: number
  lastEntryId: string | undefined
}

/**
 * Injected in tests so the unreadable path does not require provoking a
 * filesystem fault. Windows reports a missing file and a locked one through
 * different codes but offers no portable way to arrange the second, and the
 * two must not be confused — which is the whole reason this seam exists.
 */
export type FileOpen = (path: string) => number

/** Enough for an ordinary final entry; unusually large entries grow the window geometrically. */
const FINGERPRINT_TAIL_BYTES = 64 * 1024

/**
 * Reads the newest valid entry id without parsing the history before it.
 *
 * The integrity probe deliberately reads the whole file because it has to
 * count damage before Pi repairs it. A mutation fingerprint asks a narrower
 * question: what leaf is at the end now? Starting at the tail makes the common
 * cost one fixed-size read. The window doubles only when the newest entry or a
 * torn suffix does not fit, so work follows the final entry rather than the
 * whole conversation.
 */
const lastEntryIdFromTail = (fd: number, sizeBytes: number): string | undefined => {
  let windowBytes = Math.min(sizeBytes, FINGERPRINT_TAIL_BYTES)

  while (windowBytes > 0) {
    const start = sizeBytes - windowBytes
    const bytes = Buffer.allocUnsafe(windowBytes)
    let loaded = 0
    while (loaded < windowBytes) {
      const read = readSync(fd, bytes, loaded, windowBytes - loaded, start + loaded)
      if (read === 0) break
      loaded += read
    }

    const lines = bytes.subarray(0, loaded).toString("utf8").split("\n")
    // A read that begins inside a JSON line cannot parse that first fragment.
    // Discard it; when it is the only candidate, the next window includes more
    // of the line and eventually reaches its beginning.
    const firstCompleteLine = start === 0 ? 0 : 1
    for (let index = lines.length - 1; index >= firstCompleteLine; index -= 1) {
      const id = entryId(lines[index]!)
      if (id !== undefined) return id
    }

    if (start === 0) return undefined
    windowBytes = Math.min(sizeBytes, windowBytes * 2)
  }

  return undefined
}

const entryId = (line: string): string | undefined => {
  if (line.length === 0) return undefined
  try {
    const id = (JSON.parse(line) as { id?: unknown } | null)?.id
    return typeof id === "string" ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * The file's identity now, or `undefined` when it could not be read.
 *
 * The distinction is the whole point of the return type. A session with no file
 * yet is a *known* state — Pi fixes the path at creation and defers the write —
 * and it fingerprints as zero bytes with no leaf, which is exactly what the
 * next append changes. A file that could not be opened for any other reason is
 * an unknown state: a sharing violation while Pi has it open on Windows, a
 * descriptor limit, a permission change. Reporting those as zero bytes made
 * them mismatch every real baseline in both directions, and the verdict on a
 * mismatch is a non-retryable `session_busy` telling the user to close a
 * session that nothing is wrong with. Unknown is not the same as empty, so it
 * is not spelled the same.
 */
export const fingerprintSession = (
  sessionFile: string,
  open: FileOpen = (path) => openSync(path, "r"),
): WriteFingerprint | undefined => {
  let fd: number | undefined
  try {
    fd = open(sessionFile)
    const sizeBytes = fstatSync(fd).size
    return { sizeBytes, lastEntryId: lastEntryIdFromTail(fd, sizeBytes) }
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { sizeBytes: 0, lastEntryId: undefined }
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Whether the file moved since we last recorded it.
 *
 * The host re-records after each of its own turns settle, so a change observed
 * here is a write this host did not make. It cannot say *who* wrote — only that
 * appending now would fork the tree, which is enough to refuse.
 */
export const changedSince = (recorded: WriteFingerprint, current: WriteFingerprint): boolean =>
  recorded.sizeBytes !== current.sizeBytes || recorded.lastEntryId !== current.lastEntryId
