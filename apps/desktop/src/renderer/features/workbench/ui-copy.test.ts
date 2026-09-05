import { describe, expect, test } from "bun:test"
import { credentialLifetimeWarning, errorBody, errorTitle } from "./ui-copy.ts"

describe("recovery and credential copy", () => {
  test("explains a live Pi CLI write without exposing a raw lock error", () => {
    expect(errorTitle("session_busy")).toBe("Session changed elsewhere")
    expect(errorBody("session_busy")).toContain("Pi CLI")
    expect(errorBody("session_busy")).toContain("Close and reopen")
  })

  test("states exactly what a torn final entry cost", () => {
    expect(errorTitle("session_file_repaired")).toBe("Session recovered")
    expect(errorBody("session_file_repaired")).toContain("incomplete final JSONL entry")
    expect(errorBody("session_file_repaired")).toContain("kept the earlier history")
  })

  test("states the API key's measured lifetime before entry", () => {
    expect(credentialLifetimeWarning).toContain("Host-lifetime only")
    expect(credentialLifetimeWarning).toContain("Restarting the agent host removes it")
  })
})
