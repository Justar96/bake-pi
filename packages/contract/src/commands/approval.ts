import { Type } from "@sinclair/typebox"
import { ApprovalDecision } from "../dto/approval.ts"
import { defineCommands } from "./define.ts"

export const approvalCommands = defineCommands({
  /**
   * The host holds the tool call until this arrives or the session aborts. An
   * unknown or stale `requestId` is dropped rather than defaulting to allow —
   * the failure mode of a lost decision must be "nothing ran".
   */
  respond_tool_approval: {
    params: Type.Object({ requestId: Type.String({ maxLength: 64 }), decision: ApprovalDecision }),
    result: Type.Object({ accepted: Type.Boolean() }),
  },
})
