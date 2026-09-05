/**
 * Where an image block's bytes come from, as a URL two processes have to agree
 * on and neither one may invent.
 *
 * `ImageBlock.url` is a `bakepi://image/…` URL the agent host mints and main's
 * protocol handler serves. That split is why this module is in the contract
 * rather than beside either end of it: the host builds the string, main takes
 * it apart, and the renderer only ever puts it in an `<img src>`. A builder in
 * the host and a parser in main would be one regular expression away from
 * disagreeing, and the symptom of disagreeing is a blank image with no error.
 *
 * Bytes travel this way rather than on the block for one reason: a data URI on
 * the block would put the whole image through structured clone on every
 * snapshot and every resync, and a snapshot is taken on gaps, on reconnects,
 * and on every session replacement. A URL is a few dozen bytes and the fetch
 * happens once, lazily, when the row is actually on screen — and the browser's
 * own cache, not the renderer's heap, is what holds the decoded result.
 *
 * The scheme is defined here, not in main, so that the one string every origin
 * in this application is built from has a single definition that both sides of
 * the process boundary can import. Main's `protocol.ts` re-exports it for the
 * window, the CSP and the navigation guard.
 */

export const APP_SCHEME = "bakepi"

/**
 * The image origin is its own host on the app scheme, which makes it its own
 * origin: `bakepi://image` cannot read anything belonging to `bakepi://app`.
 * The renderer's CSP names both, so a URL pointing anywhere else — including
 * one a model emitted — fails to load rather than reaching the network.
 */
export const IMAGE_HOST = "image"

/**
 * An image's address within a session's history: which message, and which
 * content part of it.
 *
 * Both are indices rather than identifiers because that is all Pi's history
 * offers — see `messageIdAt` in the host's message mapping. They are stable
 * for exactly as long as the projection the renderer is holding, which is the
 * same guarantee every message id in this application carries: anything that
 * renumbers history produces a fresh snapshot, and a fresh snapshot carries
 * fresh URLs.
 */
export interface ImageRef {
  sessionId: string
  messageIndex: number
  blockIndex: number
}

export const imageUrl = (ref: ImageRef): string =>
  `${APP_SCHEME}://${IMAGE_HOST}/${encodeURIComponent(ref.sessionId)}/${String(ref.messageIndex)}/${String(ref.blockIndex)}`

/** Session ids are bounded at 128 characters by `SessionId`; this is that bound, not a new one. */
const MAX_SESSION_ID_LENGTH = 128

/**
 * Reads back exactly what `imageUrl` writes, and refuses everything else.
 *
 * Strict on purpose: this parses a path that arrived from a renderer fetch, so
 * a session id is length-bounded here rather than trusted to be one, and an
 * index has to be plain digits. `Number.parseInt` would accept `"1abc"`, `"+1"`
 * and `"1e3"` and quietly resolve a different message than the URL named.
 */
export const parseImageUrl = (pathname: string): ImageRef | undefined => {
  const parts = pathname.split("/")
  // A pathname always starts with "/", so the first part is empty.
  if (parts.length !== 4 || parts[0] !== "") return undefined
  const sessionId = decodeSegment(parts[1])
  const messageIndex = wholeNumber(parts[2])
  const blockIndex = wholeNumber(parts[3])
  if (sessionId === undefined || messageIndex === undefined || blockIndex === undefined) return undefined
  return { sessionId, messageIndex, blockIndex }
}

const decodeSegment = (raw: string | undefined): string | undefined => {
  if (raw === undefined || raw.length === 0) return undefined
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    // A lone `%` is not a session id, and `decodeURIComponent` throws on it.
    return undefined
  }
  return decoded.length === 0 || decoded.length > MAX_SESSION_ID_LENGTH ? undefined : decoded
}

const wholeNumber = (raw: string | undefined): number | undefined => {
  if (raw === undefined || !/^(?:0|[1-9][0-9]{0,9})$/.test(raw)) return undefined
  return Number(raw)
}
