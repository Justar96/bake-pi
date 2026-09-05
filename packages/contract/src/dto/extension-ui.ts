import { type Static, Type } from "@sinclair/typebox"
import { SessionId } from "./primitives.ts"

/**
 * Pi extensions can ask the user something and block until answered. In the TUI
 * that is a terminal prompt; here it is a modal the renderer owns. The request
 * shapes are fixed by the contract, so an extension cannot describe arbitrary
 * UI — it picks one of four.
 */
const requestBase = {
  id: Type.String({ maxLength: 64 }),
  sessionId: SessionId,
  /**
   * Pi gives every loaded extension one shared UI context and does not identify
   * the caller when a dialog method reaches it. Omit attribution when Pi cannot
   * prove it; a made-up name would make an untrusted prompt look attributable
   * to a specific extension when it is not.
   */
  extensionName: Type.Optional(Type.String({ maxLength: 128 })),
  title: Type.String({ maxLength: 256 }),
  message: Type.Optional(Type.String({ maxLength: 4096 })),
}

export const SelectRequest = Type.Object({
  ...requestBase,
  kind: Type.Literal("select"),
  options: Type.Array(
    Type.Object({ value: Type.String({ maxLength: 256 }), label: Type.String({ maxLength: 256 }) }),
    { minItems: 1, maxItems: 64 },
  ),
})

export const ConfirmRequest = Type.Object({ ...requestBase, kind: Type.Literal("confirm") })

export const InputRequest = Type.Object({
  ...requestBase,
  kind: Type.Literal("input"),
  placeholder: Type.Optional(Type.String({ maxLength: 256 })),
  secret: Type.Boolean(),
})

export const EditorRequest = Type.Object({
  ...requestBase,
  kind: Type.Literal("editor"),
  initialText: Type.String(),
  language: Type.Optional(Type.String({ maxLength: 64 })),
})

export const ExtensionUiRequest = Type.Union([SelectRequest, ConfirmRequest, InputRequest, EditorRequest])
export type ExtensionUiRequest = Static<typeof ExtensionUiRequest>
export type SelectRequest = Static<typeof SelectRequest>
export type ConfirmRequest = Static<typeof ConfirmRequest>
export type InputRequest = Static<typeof InputRequest>
export type EditorRequest = Static<typeof EditorRequest>
