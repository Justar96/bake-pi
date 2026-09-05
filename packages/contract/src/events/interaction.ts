import { Type } from "@sinclair/typebox"
import { ApprovalDecision, ApprovalRequest } from "../dto/approval.ts"
import { ExtensionUiRequest } from "../dto/extension-ui.ts"
import { defineEvents } from "./define.ts"

export const interactionEvents = defineEvents({
  approval_requested: Type.Object({ request: ApprovalRequest }),
  /**
   * Also emitted when the host resolves a request without the user — an abort,
   * a session close, a host shutdown. The renderer dismisses the card on this
   * event, never on its own optimistic guess.
   */
  approval_resolved: Type.Object({
    requestId: Type.String({ maxLength: 64 }),
    decision: ApprovalDecision,
    resolvedBy: Type.Union([Type.Literal("user"), Type.Literal("policy"), Type.Literal("cancelled")]),
  }),
  extension_ui_requested: Type.Object({ request: ExtensionUiRequest }),
  extension_ui_resolved: Type.Object({ requestId: Type.String({ maxLength: 64 }) }),
})
