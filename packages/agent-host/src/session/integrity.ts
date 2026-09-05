import { readFileSync, statSync } from "node:fs"

/**
 * What a session file's bytes say, read before Pi is allowed to touch it.
 *
 * The timing is the entire point. `durability.test.ts` measured that Pi silently
 * discards a torn final entry and then "repairs" the file by appending a single
 * newline to terminate the fragment — which destroys the only evidence that
 * anything was lost. So an integrity verdict taken after `SessionManager.open`
 * is worthless: it can no longer distinguish a session that just lost a turn
 * from one that never had it.
 *
 * Nothing here writes, and nothing here throws for a damaged file. A file being
 * damaged is the answer, not an error.
 */

export interface SessionIntegrity {
  /**
   * False is an ordinary state, not a fault: Pi writes no session file at all
   * until an assistant message exists, so a session that has only taken a user
   * message has a path and no file.
   */
  exists: boolean
  /** Total bytes. Zero for a created-but-unwritten file. */
  sizeBytes: number
  /** Physical lines that parse as JSON. */
  validLines: number
  /**
   * A tear that has not yet been seen: the file does not end in a newline, so
   * the last line was still being written when the process died.
   *
   * This is true exactly once in a file's life. Pi's next load terminates the
   * fragment, and from then on the tear is indistinguishable from an old scar.
   * Detecting it is therefore not optional bookkeeping — it is the only moment
   * the information exists.
   */
  freshTear: boolean
  /** Bytes in the unterminated fragment. Zero unless `freshTear`. */
  fragmentBytes: number
  /**
   * Healed tears from earlier kills: interior lines that will never parse
   * again. Pi skips them in silence on every load, forever.
   *
   * These are the reason "does this file contain only valid JSON lines" is the
   * wrong integrity check — it would report a fault on every session ever
   * killed mid-append. A scar is history, not a fault.
   */
  scarLines: number
  /**
   * Pi will refuse to open this file and throw `not a valid pi session`.
   *
   * Necessary rather than sufficient: this checks that the first line parses as
   * JSON, and Pi additionally requires it to be a well-formed session header.
   * A false here means Pi will certainly throw; a true does not promise it
   * will not.
   */
  headerUnreadable: boolean
  /** Session id from a well-formed header, used to reject a stale cached path. */
  headerSessionId: string | undefined
  /**
   * The `id` of the last entry that parses, or undefined when there is none.
   * This is what makes a foreign append detectable — see `ownership.ts`.
   */
  lastEntryId: string | undefined
}

const ABSENT: SessionIntegrity = {
  exists: false,
  sizeBytes: 0,
  validLines: 0,
  freshTear: false,
  fragmentBytes: 0,
  scarLines: 0,
  headerUnreadable: false,
  headerSessionId: undefined,
  lastEntryId: undefined,
}

/**
 * Reads the whole file. That is O(size) at session open, which is the same cost
 * Pi is about to pay to load it, so it does not change the shape of the work —
 * but it does mean this is an open-time check and not something to call per
 * append.
 */
export const inspectSessionFile = (file: string): SessionIntegrity => {
  let content: string
  let sizeBytes: number
  try {
    sizeBytes = statSync(file).size
    content = readFileSync(file, "utf8")
  } catch {
    // Missing, unreadable, or a directory. All of them mean "there is no session
    // here to judge", and the caller distinguishes them by what it does next.
    return ABSENT
  }

  if (content.length === 0) return { ...ABSENT, exists: true }

  const freshTear = !content.endsWith("\n")
  const lines = content.split("\n").filter((line) => line.length > 0)

  let validLines = 0
  let scarLines = 0
  let lastEntryId: string | undefined
  for (const [index, line] of lines.entries()) {
    const parsed = parseEntry(line)
    if (parsed === undefined) {
      // The unterminated final fragment is the fresh tear, counted as such. Any
      // other unparseable line is an old scar.
      const isFragment = freshTear && index === lines.length - 1
      if (!isFragment) scarLines += 1
      continue
    }
    validLines += 1
    if (typeof parsed.id === "string") lastEntryId = parsed.id
  }

  const header = parseEntry(lines[0] ?? "")
  return {
    exists: true,
    sizeBytes,
    validLines,
    freshTear,
    fragmentBytes: freshTear ? Buffer.byteLength(lines.at(-1) ?? "", "utf8") : 0,
    scarLines,
    headerUnreadable: header === undefined,
    headerSessionId: header?.type === "session" && typeof header.id === "string" ? header.id : undefined,
    lastEntryId,
  }
}

/**
 * Whether opening this file will silently drop committed history.
 *
 * Deliberately not `scarLines > 0`: a scar has already been mourned. Only a
 * fresh tear loses something on *this* open.
 */
export const willLoseEntries = (integrity: SessionIntegrity): boolean =>
  integrity.exists && integrity.freshTear && !integrity.headerUnreadable

const parseEntry = (line: string): { id?: unknown; type?: unknown } | undefined => {
  try {
    const value = JSON.parse(line) as unknown
    return typeof value === "object" && value !== null ? (value as { id?: unknown; type?: unknown }) : {}
  } catch {
    return undefined
  }
}
