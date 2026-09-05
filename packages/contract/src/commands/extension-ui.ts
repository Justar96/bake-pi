import { Type } from "@sinclair/typebox"
import { defineCommands } from "./define.ts"

/**
 * Responses to a blocking extension request. `requestId` must match an
 * outstanding request: a response to an unknown or already-answered id is
 * dropped, because an extension waiting on a promise must not be resolved twice.
 */
const respondTo = Type.String({ maxLength: 64 })
const accepted = Type.Object({ accepted: Type.Boolean() })

export const extensionUiCommands = defineCommands({
  respond_select: {
    params: Type.Object({ requestId: respondTo, value: Type.Union([Type.String({ maxLength: 256 }), Type.Null()]) }),
    result: accepted,
  },
  respond_confirm: { params: Type.Object({ requestId: respondTo, confirmed: Type.Boolean() }), result: accepted },
  respond_input: {
    params: Type.Object({ requestId: respondTo, value: Type.Union([Type.String({ maxLength: 65_536 }), Type.Null()]) }),
    result: accepted,
  },
  respond_editor: {
    params: Type.Object({ requestId: respondTo, text: Type.Union([Type.String({ maxLength: 1_048_576 }), Type.Null()]) }),
    result: accepted,
  },
})
