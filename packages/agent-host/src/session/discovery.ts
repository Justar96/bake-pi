import type { SessionSummary } from "@bake-pi/contract"

/**
 * Turning Pi's on-disk session listing into something the renderer can show.
 *
 * `SessionManager.list(cwd, sessionDir)` is the discovery API, and one measured
 * property of it is what makes this safe: **it does not modify the files it
 * reads.** A torn session file is byte-identical after a listing, still missing
 * its trailing newline. That matters more than it sounds — Pi's other public
 * read path, `SessionManager.open`, repairs the file as a side effect, so
 * listing through it would silently destroy the tear evidence for every session
 * in a workspace just by showing the user a list. See `discovery.test.ts`.
 *
 * The shaping here is deliberately dumb. Everything interesting about a session
 * file has already been decided by Pi; this only picks the fields the contract
 * has and makes a title out of what is available.
 */

/**
 * The subset of Pi's `SessionInfo` this projection reads, declared structurally
 * so the mapping can be tested without building sessions on disk.
 */
export interface DiscoveredSession {
  path: string
  id: string
  cwd: string
  name?: string | undefined
  parentSessionPath?: string | undefined
  created: Date
  modified: Date
  messageCount: number
  firstMessage: string
}

/** The contract's ceiling for a summary title. Titles are truncated, never rejected. */
const TITLE_LIMIT = 512

/**
 * What the session rail shows for a session.
 *
 * A user-set name wins; otherwise the opening message is the only thing that
 * describes a session in the user's own words, which beats a filename or a uuid.
 * Newlines are flattened because this is one line in a list, and a pasted stack
 * trace should not become a paragraph in the rail.
 */
export const titleFor = (session: {
  name?: string | undefined
  firstMessage?: string | undefined
}): string => {
  const named = session.name?.trim()
  if (named !== undefined && named.length > 0) return truncate(named)

  const opening = session.firstMessage?.replace(/\s+/gu, " ").trim()
  if (opening !== undefined && opening.length > 0) return truncate(opening)

  // Reached by a session whose only entries are non-message ones. Rare, and the
  // renderer still needs a string rather than an empty label.
  return "Untitled session"
}

export const toSessionSummary = (session: DiscoveredSession, workspaceId: string): SessionSummary => ({
  id: session.id,
  workspaceId,
  title: titleFor(session),
  // The contract carries milliseconds and leaves formatting to the renderer's
  // locale. `getTime()` on an unparseable date is NaN, which would fail
  // validation at the boundary rather than here, so it is clamped.
  createdAt: epochMs(session.created),
  updatedAt: epochMs(session.modified),
  messageCount: Math.max(0, Math.trunc(session.messageCount)),
  path: session.path,
  // `parentId` is deliberately not filled from `parentSessionPath`. The contract
  // wants a session id and Pi records a path, and resolving one to the other
  // means opening the parent file — which repairs it. A forked session's parent
  // link is worth having, but not at the cost of mutating a file to draw a line
  // in a list.
})

const truncate = (value: string): string =>
  value.length <= TITLE_LIMIT ? value : `${value.slice(0, TITLE_LIMIT - 1)}…`

const epochMs = (date: Date): number => {
  const time = date.getTime()
  return Number.isFinite(time) ? Math.max(0, Math.trunc(time)) : 0
}
