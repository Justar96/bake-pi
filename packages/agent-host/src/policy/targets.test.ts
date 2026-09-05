import { describe, expect, test } from "bun:test"
import { join, resolve } from "node:path"
import { extractTargets, isBuiltinToolName } from "./targets.ts"

const cwd = resolve("/w/project")

describe("target extraction from built-in tool arguments", () => {
  test("read names one path it reads", () => {
    expect(extractTargets("read", { path: "/w/project/src/a.ts" }, cwd)).toEqual({
      resolved: true,
      targets: [{ path: "/w/project/src/a.ts", kind: "read" }],
    })
  })

  test("write and edit name one path they write", () => {
    expect(extractTargets("write", { path: "/w/project/a.ts", content: "x" }, cwd).targets).toEqual([
      { path: "/w/project/a.ts", kind: "write" },
    ])
    expect(extractTargets("edit", { path: "/w/project/a.ts", edits: [] }, cwd).targets).toEqual([
      { path: "/w/project/a.ts", kind: "write" },
    ])
  })

  test("a relative path resolves against the session cwd, not the host process cwd", () => {
    // The agent host runs wherever Electron started it, which is never the
    // workspace. Resolving against the wrong base puts an ordinary in-workspace
    // edit outside the workspace, and the policy then prompts for routine work
    // while a real escape looks identical to it.
    expect(extractTargets("edit", { path: "src/a.ts", edits: [] }, cwd).targets).toEqual([
      { path: join(cwd, "src", "a.ts"), kind: "write" },
    ])
  })

  test("a shell command is an execute on its working directory", () => {
    // Deliberately not parsed for the files it might touch: that cannot be done
    // correctly, and a policy that claimed it could would be lying about the one
    // thing the card exists to tell the truth about.
    for (const tool of ["bash", "powershell"]) {
      expect(extractTargets(tool, { command: "rm -rf /etc" }, cwd)).toEqual({
        resolved: true,
        targets: [{ path: cwd, kind: "execute" }],
      })
    }
  })

  test("search tools fall back to the cwd when no path is given", () => {
    for (const tool of ["ls", "grep", "find"]) {
      expect(extractTargets(tool, { pattern: "x" }, cwd)).toEqual({
        resolved: true,
        targets: [{ path: cwd, kind: "read" }],
      })
    }
  })

  test("an unknown tool resolves to nothing, and says so", () => {
    // The distinction that matters: not "this tool touches no files" but "this
    // host cannot tell". The policy reads `resolved`, not the array length.
    expect(extractTargets("deploy_to_production", { region: "eu" }, cwd)).toEqual({
      resolved: false,
      targets: [],
    })
  })

  test("a known tool missing its path argument is unresolved rather than empty", () => {
    expect(extractTargets("write", { content: "x" }, cwd).resolved).toBe(false)
    expect(extractTargets("read", { path: 42 }, cwd).resolved).toBe(false)
    expect(extractTargets("edit", {}, cwd).resolved).toBe(false)
  })

  test("a non-object input does not throw", () => {
    // Extension tools can be called with anything the model emitted.
    expect(extractTargets("write", null, cwd).resolved).toBe(false)
    expect(extractTargets("write", "a string", cwd).resolved).toBe(false)
  })
})

describe("built-in tool identification", () => {
  test("Pi's own tools are builtin and anything else is not", () => {
    for (const tool of ["read", "write", "edit", "grep", "find", "ls", "bash", "powershell"]) {
      expect(isBuiltinToolName(tool)).toBe(true)
    }
    expect(isBuiltinToolName("deploy_to_production")).toBe(false)
  })
})
