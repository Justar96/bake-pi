import { describe, expect, test } from "bun:test"
import { abortedToolReason, deniedToolReason, toolResultStatus } from "./tool-outcome.ts"

describe("tool outcomes persisted through Pi", () => {
  test("distinguishes policy denial from an ordinary tool failure", () => {
    expect(toolResultStatus(true, deniedToolReason("the workspace is not trusted"))).toBe("denied")
    expect(toolResultStatus(true, "EACCES: permission denied")).toBe("failed")
  })

  test("distinguishes cancellation before execution from denial", () => {
    expect(toolResultStatus(true, abortedToolReason())).toBe("aborted")
  })

  test("a successful result remains successful regardless of its text", () => {
    expect(toolResultStatus(false, deniedToolReason("quoted by the tool"))).toBe("succeeded")
  })
})
