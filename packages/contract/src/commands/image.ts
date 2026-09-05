import { Type } from "@sinclair/typebox"
import { SessionId } from "../dto/primitives.ts"
import { defineCommands } from "./define.ts"

/**
 * `read_image`: the bytes behind one image block, fetched once when a row is
 * on screen rather than carried on every snapshot.
 *
 * This is the one command main issues on its own behalf. It is in
 * `HOST_INTERNAL_COMMANDS` because the renderer never sends it — the renderer
 * writes a `bakepi://image/…` URL into an `<img src>`, the protocol handler in
 * main receives that fetch, and answering it is what this command is for.
 * Exposing it to the renderer as well would put the base64 in the renderer's
 * heap for no gain, which is the cost the URL exists to avoid.
 *
 * Main still does not understand agent semantics here, which is the boundary
 * that matters: the params are three numbers-and-an-id parsed out of a URL,
 * and the result is a media type and some bytes. Nothing in the round trip
 * requires main to know what a message or a content part is.
 */

/**
 * The decoded ceiling, chosen against the envelope rather than against what
 * images tend to weigh: base64 costs a third more than the bytes it encodes,
 * and `MAX_ENVELOPE_BYTES` is 8 MiB, so 4 MiB decoded leaves the response
 * comfortably inside a frame that would otherwise be refused whole. An image
 * past it is reported as `payload_too_large` rather than truncated — half a
 * PNG is not a smaller PNG.
 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024

/** Ceil(4 MiB / 3) * 4, plus room for the padding characters. */
const MAX_IMAGE_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4

/**
 * The media types an image block is allowed to become a picture for.
 *
 * A closed set rather than a `image/*` prefix test, and the exclusion that
 * matters is `image/svg+xml`: an SVG is a document with a script element and a
 * stylesheet in it, not a bitmap, and while browsers do refuse scripts in an
 * SVG loaded through `<img>`, that refusal is the only thing standing between
 * a model-supplied file and script execution on an origin the renderer trusts.
 * Nothing in this application needs vector output from a provider, so the
 * cheaper answer is to never label a response with it.
 *
 * Anything outside the set stays the text notice it was before — the block
 * still says an image came back, it just does not claim to be able to draw it.
 */
export const RENDERABLE_IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const

export type RenderableImageMediaType = (typeof RENDERABLE_IMAGE_MEDIA_TYPES)[number]

/**
 * Compared on the type alone: providers and file sniffers both attach
 * parameters (`image/png; charset=binary` really does turn up), and a
 * comparison against the raw string rejects a perfectly ordinary PNG.
 */
export const renderableImageMediaType = (value: string): RenderableImageMediaType | undefined => {
  const type = value.split(";", 1)[0]?.trim().toLowerCase()
  if (type === "image/jpg") return "image/jpeg"
  return RENDERABLE_IMAGE_MEDIA_TYPES.find((allowed) => allowed === type)
}

export const imageCommands = defineCommands({
  read_image: {
    params: Type.Object({
      sessionId: SessionId,
      messageIndex: Type.Integer({ minimum: 0 }),
      blockIndex: Type.Integer({ minimum: 0 }),
    }),
    result: Type.Object({
      /**
       * The media type the host detected, not the one a provider claimed. The
       * renderer's CSP puts these bytes in an `<img>` and nowhere else, so the
       * type is what the protocol handler labels the response with rather than
       * a capability grant — but it is still narrowed to a closed set at the
       * host, because `Content-Type: text/html` on a response from an origin
       * the renderer trusts is worth not being able to express.
       */
      mediaType: Type.String({ minLength: 1, maxLength: 128 }),
      /** Base64, because the envelope is JSON and a byte array would cost four characters a byte. */
      data: Type.String({ maxLength: MAX_IMAGE_BASE64_LENGTH }),
    }),
  },
})
