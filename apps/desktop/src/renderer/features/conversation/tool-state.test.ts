import { expect, test } from "bun:test"
import { toolStepState } from "./tool-state.ts"

test("every tool state has a distinct step state", () => {
  expect(toolStepState("pending_approval")).toEqual({ status: "pending" })
  expect(toolStepState("running")).toEqual({ status: "active" })
  expect(toolStepState("succeeded")).toEqual({ status: "complete", outcome: "succeeded" })
  expect(toolStepState("failed")).toEqual({ status: "complete", outcome: "failed" })
  expect(toolStepState("denied")).toEqual({ status: "complete", outcome: "denied" })
  expect(toolStepState("aborted")).toEqual({ status: "complete", outcome: "aborted" })
})
