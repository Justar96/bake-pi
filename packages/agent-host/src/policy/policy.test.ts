import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionAllowances, requiresApproval } from "./approval.ts"
import { canonicalize, isInside } from "./paths.ts"

const workspace = (): string => {
  const root = mkdtempSync(join(tmpdir(), "bakepi-"))
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "src", "a.ts"), "")
  return canonicalize(root)
}

describe("workspace containment", () => {
  const root = workspace()

  test("the root itself is inside", () => {
    expect(isInside(root, root)).toBe(true)
  })

  test("a descendant is inside", () => {
    expect(isInside(root, join(root, "src", "a.ts"))).toBe(true)
  })

  test("a path that does not exist yet is judged by its parent", () => {
    // A write tool names a file before it exists. Refusing to classify it would
    // make every new file an out-of-workspace prompt.
    expect(isInside(root, join(root, "src", "new-file.ts"))).toBe(true)
  })

  test("a traversal escape is outside", () => {
    expect(isInside(root, join(root, "..", "elsewhere.txt"))).toBe(false)
  })

  test("a sibling sharing the root's name prefix is outside", () => {
    // The case a `startsWith` comparison gets wrong. It is not exotic: it is
    // what a repository sitting next to its own backup directory looks like.
    expect(isInside(root, root + "-secrets")).toBe(false)
    expect(isInside(root, root + "-secrets/key.pem")).toBe(false)
  })

  test("comparison happens after canonicalization, not before", () => {
    const noisy = join(root, ".", "src", "..", "src", "a.ts")
    expect(isInside(root, noisy)).toBe(true)
  })
})

describe("the approval policy is three rules", () => {
  const inside = { path: "/w/a.ts", insideWorkspace: true, kind: "write" as const }
  const outside = { path: "/etc/hosts", insideWorkspace: false, kind: "write" as const }
  const readInside = { path: "/w/a.ts", insideWorkspace: true, kind: "read" as const }
  const readOutside = { path: "/etc/hosts", insideWorkspace: false, kind: "read" as const }
  const executeInside = { path: "/w", insideWorkspace: true, kind: "execute" as const }
  const executeOutside = { path: "/tmp", insideWorkspace: false, kind: "execute" as const }

  test("an untrusted workspace asks before every tool", () => {
    expect(requiresApproval("untrusted", [inside])).toBe("workspace_untrusted")
    expect(requiresApproval("untrusted", [readInside])).toBe("workspace_untrusted")
    expect(requiresApproval("untrusted", [executeInside])).toBe("workspace_untrusted")
    expect(requiresApproval("untrusted", [])).toBe("workspace_untrusted")
  })

  test("an untrusted workspace asks even for a tool whose targets are unknown", () => {
    expect(requiresApproval("untrusted", [], false)).toBe("workspace_untrusted")
  })

  test("a workspace with full access never asks, whatever the tool touches", () => {
    expect(requiresApproval("full", [inside])).toBeUndefined()
    expect(requiresApproval("full", [executeInside])).toBeUndefined()
    expect(requiresApproval("full", [], false)).toBeUndefined()
  })

  test("a trusted workspace does not ask for work inside it", () => {
    expect(requiresApproval("trusted", [inside])).toBeUndefined()
    expect(requiresApproval("trusted", [readInside])).toBeUndefined()
  })

  test("a trusted workspace asks before writing outside it", () => {
    expect(requiresApproval("trusted", [outside])).toBe("outside_workspace")
  })

  test("a trusted workspace asks before executing outside it", () => {
    expect(requiresApproval("trusted", [executeOutside])).toBe("outside_workspace")
  })

  test("a trusted workspace runs a command in its own directory without asking", () => {
    // This is what trusting a project means here, and it is a decision rather
    // than an omission: Pi's own CLI runs commands in a trusted project without
    // asking, and prompting on every shell call would train the user to approve
    // without reading. Rule 1 still covers the untrusted case.
    expect(requiresApproval("trusted", [executeInside])).toBeUndefined()
  })

  test("a read outside the workspace does not prompt", () => {
    // Reading is how the agent learns about the machine it runs on. Prompting
    // for every one would train the user to approve without reading, which
    // would cost more than it buys on the writes that matter.
    expect(requiresApproval("trusted", [readOutside])).toBeUndefined()
  })

  test("one escaping target in a batch is enough to prompt", () => {
    expect(requiresApproval("trusted", [inside, outside])).toBe("outside_workspace")
    expect(requiresApproval("trusted", [readInside, readOutside, executeOutside])).toBe("outside_workspace")
  })

  test("a trusted workspace asks when it cannot tell what the tool touches", () => {
    // The hole this rule closes. A tool with no determinable target used to fall
    // through to "allow", which is how an extension-contributed tool ran in a
    // trusted workspace with nothing shown to the user.
    expect(requiresApproval("trusted", [], false)).toBe("targets_unknown")
  })

  test("resolved targets that happen to be empty do not prompt", () => {
    // The distinction the third rule rests on: "touches nothing we can name" is
    // not the same claim as "we could not tell".
    expect(requiresApproval("trusted", [], true)).toBeUndefined()
  })

  test("an escape outranks an unknown, because it is the more specific reason", () => {
    expect(requiresApproval("trusted", [outside], false)).toBe("outside_workspace")
  })
})

describe("session allowances", () => {
  test("an allowance applies to one tool in one session and nowhere else", () => {
    const allowances = new SessionAllowances()
    allowances.allow("s1", "bash")

    expect(allowances.isAllowed("s1", "bash")).toBe(true)
    expect(allowances.isAllowed("s1", "write")).toBe(false)
    expect(allowances.isAllowed("s2", "bash")).toBe(false)
  })

  test("closing a session forgets its allowances", () => {
    const allowances = new SessionAllowances()
    allowances.allow("s1", "bash")
    allowances.forget("s1")
    expect(allowances.isAllowed("s1", "bash")).toBe(false)
  })
})
