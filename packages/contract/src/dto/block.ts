import { type Static, Type } from "@sinclair/typebox"
import { ContractError } from "../errors.ts"
import { ToolCall, ToolResult } from "./tool.ts"

/**
 * A content block is one addressable region of a message. Streaming appends to
 * the block identified by `index`, so the renderer never re-parses a growing
 * string to find out what changed.
 */
const base = { index: Type.Integer({ minimum: 0 }) }

export const TextBlock = Type.Object({ ...base, kind: Type.Literal("text"), text: Type.String() })

/**
 * Reasoning is presented separately and collapsed by default. It is not merged
 * into the text block: users must be able to tell what the model said from what
 * it thought, and some providers bill them differently.
 */
export const ReasoningBlock = Type.Object({
  ...base,
  kind: Type.Literal("reasoning"),
  text: Type.String(),
  /** Providers that return opaque reasoning give a signature instead of content. */
  redacted: Type.Boolean(),
})

export const ToolCallBlock = Type.Object({ ...base, kind: Type.Literal("tool_call"), call: ToolCall })

export const ToolResultBlock = Type.Object({ ...base, kind: Type.Literal("tool_result"), result: ToolResult })

/**
 * Images cross as a `bakepi://image/…` URL the host minted, never as a data
 * URI and never as a filesystem path. The renderer's CSP allows that origin
 * and no other, so a model cannot cause a fetch by emitting a URL.
 *
 * `dto/image-ref.ts` owns the shape of that URL and says why the bytes travel
 * this way; main's protocol handler is what answers the fetch, through
 * `read_image`. The string is empty when the host has nothing to serve — a
 * media type it will not draw, or a part with no bytes behind it — and an
 * empty `url` is the renderer's signal to say an image came back rather than
 * to show a broken one.
 */
export const ImageBlock = Type.Object({
  ...base,
  kind: Type.Literal("image"),
  url: Type.String({ maxLength: 2048 }),
  mediaType: Type.String({ maxLength: 128 }),
  altText: Type.Optional(Type.String({ maxLength: 1024 })),
})

export const ErrorBlock = Type.Object({ ...base, kind: Type.Literal("error"), error: ContractError })

export const ContentBlock = Type.Union([
  TextBlock,
  ReasoningBlock,
  ToolCallBlock,
  ToolResultBlock,
  ImageBlock,
  ErrorBlock,
])
export type ContentBlock = Static<typeof ContentBlock>
export type TextBlock = Static<typeof TextBlock>
export type ReasoningBlock = Static<typeof ReasoningBlock>
export type ToolCallBlock = Static<typeof ToolCallBlock>
export type ToolResultBlock = Static<typeof ToolResultBlock>
export type ImageBlock = Static<typeof ImageBlock>
export type ErrorBlock = Static<typeof ErrorBlock>
