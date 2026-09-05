import type { ToolCallStatus } from "@bake-pi/contract"

export type ActivityStatus = "pending" | "active" | "complete"
export type StepOutcome = Exclude<ToolCallStatus, "pending_approval" | "running">

export interface ToolStepState {
  status: ActivityStatus
  outcome?: StepOutcome
}

/** Maps every contract tool state onto the step's motion and terminal mark. */
export const toolStepState = (status: ToolCallStatus): ToolStepState => {
  if (status === "pending_approval") return { status: "pending" }
  if (status === "running") return { status: "active" }
  return { status: "complete", outcome: status }
}
