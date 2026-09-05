import { net, protocol } from "electron"
import { existsSync } from "node:fs"
import { join, normalize, relative, sep } from "node:path"
import { pathToFileURL } from "node:url"
import {
  APP_SCHEME,
  BakePiError,
  IMAGE_HOST,
  parseImageUrl,
  renderableImageMediaType,
  type ImageRef,
} from "@bake-pi/contract"

export { APP_SCHEME }
export const APP_ORIGIN = `${APP_SCHEME}://app`

/** The second origin on the scheme: image bytes, and nothing else. */
export const IMAGE_ORIGIN = `${APP_SCHEME}://${IMAGE_HOST}`

/**
 * Registered before `app.whenReady()`, because scheme privileges are fixed when
 * the first renderer process starts and a later registration silently does
 * nothing.
 *
 * `standard` gives the scheme an origin, which is what makes the CSP above
 * expressible and what gives the renderer a usable `localStorage` and module
 * resolution. `secure` puts it in a secure context. `supportFetchAPI` lets the
 * renderer load its own assets. `corsEnabled` stays false: the renderer has one
 * origin and nothing to share with.
 */
export const registerSchemePrivileges = (): void => {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true },
    },
  ])
}

/** What main asks the agent host for when the renderer fetches an image URL. */
export type ImageReader = (ref: ImageRef) => Promise<{ mediaType: string; data: string }>

/**
 * Serves the built renderer from `bakepi://app`, image bytes from
 * `bakepi://image`, and nothing else.
 *
 * The containment check compares the resolved path against the root using
 * `relative()`, not a `startsWith` on the string. A prefix comparison accepts
 * `…/renderer-secrets` for a root of `…/renderer`, and on Windows it also
 * misses the case difference between `C:\` and `c:\`.
 *
 * Images are a second hostname rather than a path under `app` because a
 * hostname is a separate origin on a `standard` scheme: bytes a model put in
 * front of the user cannot read anything belonging to the renderer, whatever
 * the browser decides they are. `reader` is how they arrive — main holds no
 * session history and never will, so the fetch becomes a `read_image` command
 * and the answer becomes this response.
 */
export const installAppProtocol = (rendererRoot: string, reader: ImageReader, log: Pick<Console, "error"> = console): void => {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.hostname === IMAGE_HOST) return await serveImage(url.pathname, reader, log)
    if (url.hostname !== "app") return new Response("not found", { status: 404 })

    const requested = decodeURIComponent(url.pathname)
    const target = normalize(join(rendererRoot, requested === "/" ? "index.html" : requested))

    const within = relative(rendererRoot, target)
    if (within.startsWith("..") || within.startsWith(sep) || within === "") {
      return new Response("forbidden", { status: 403 })
    }
    if (!existsSync(target)) return new Response("not found", { status: 404 })

    return net.fetch(pathToFileURL(target).toString())
  })
}

/**
 * One image, or a 404.
 *
 * A miss is ordinary rather than exceptional: a URL names a fixed position in
 * a session's history, and compaction, a fork or a tree move renumber that
 * history — so a row still on screen from before a resync legitimately points
 * at nothing. Those are quiet. Anything else is logged, because a host that is
 * refusing every image should not look the same as an image that moved.
 *
 * The media type is narrowed again here rather than trusted from the response.
 * The host already refuses everything outside the set, so this is not a second
 * opinion about the file — it is about what main is willing to *label* bytes
 * on an origin the renderer trusts, and that decision belongs at the point
 * where the header is written.
 */
const serveImage = async (pathname: string, reader: ImageReader, log: Pick<Console, "error">): Promise<Response> => {
  const ref = parseImageUrl(pathname)
  if (ref === undefined) return new Response("not found", { status: 404 })
  let bytes: Awaited<ReturnType<ImageReader>>
  try {
    bytes = await reader(ref)
  } catch (error) {
    if (!(error instanceof BakePiError) || error.code !== "resource_not_found") {
      log.error(`[main] image ${pathname} could not be read:`, error)
    }
    return new Response("not found", { status: 404 })
  }
  const mediaType = renderableImageMediaType(bytes.mediaType)
  if (mediaType === undefined) return new Response("not found", { status: 404 })
  return new Response(Buffer.from(bytes.data, "base64"), {
    headers: {
      "Content-Type": mediaType,
      // A URL addresses one content part of one message, and nothing rewrites
      // a message in place — anything that could mints new URLs instead. So
      // the browser may hold it for as long as the window lives, which is what
      // keeps scrolling back past an image from re-running the command.
      "Cache-Control": "private, max-age=3600, immutable",
    },
  })
}
