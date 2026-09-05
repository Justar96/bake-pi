import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listWorkspaceResources } from "./resources.ts"

const temporary: string[] = []

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

const fixture = (): { workspace: string; agentDir: string } => {
  const root = mkdtempSync(join(tmpdir(), "bakepi-resources-"))
  temporary.push(root)
  const workspace = join(root, "workspace")
  const agentDir = join(root, "agent")

  mkdirSync(join(agentDir, "extensions"), { recursive: true })
  mkdirSync(join(agentDir, "skills", "review"), { recursive: true })
  mkdirSync(join(agentDir, "prompts"), { recursive: true })
  mkdirSync(join(workspace, ".pi", "extensions"), { recursive: true })

  writeFileSync(join(agentDir, "extensions", "enabled.ts"), "export default () => {}\n")
  writeFileSync(join(agentDir, "extensions", "disabled.ts"), "export default () => {}\n")
  writeFileSync(
    join(agentDir, "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Review code\n---\n",
  )
  writeFileSync(join(agentDir, "prompts", "fix.md"), "Fix the issue.\n")
  writeFileSync(join(workspace, ".pi", "extensions", "project.ts"), "export default () => {}\n")
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: ["-extensions/disabled.ts"] }))

  return { workspace, agentDir }
}

describe("workspace resource inventory", () => {
  test("lists user resources and their configured enabled state without trusting the project", async () => {
    const { workspace, agentDir } = fixture()
    const resources = await listWorkspaceResources({
      workspaceRoot: workspace,
      agentDir,
      projectTrusted: false,
    })

    const fixtureResources = resources.filter((resource) =>
      ["disabled", "enabled", "review", "fix", "project"].includes(resource.name),
    )
    expect(fixtureResources.map(({ kind, name, scope, enabled }) => ({ kind, name, scope, enabled }))).toEqual([
      { kind: "extension", name: "disabled", scope: "user", enabled: false },
      { kind: "extension", name: "enabled", scope: "user", enabled: true },
      { kind: "skill", name: "review", scope: "user", enabled: true },
      { kind: "prompt", name: "fix", scope: "user", enabled: true },
    ])
    expect(resources.every((resource) => resource.id.length <= 256)).toBe(true)
  })

  test("adds project executable resources only after Pi project trust is active", async () => {
    const { workspace, agentDir } = fixture()
    const resources = await listWorkspaceResources({
      workspaceRoot: workspace,
      agentDir,
      projectTrusted: true,
    })

    expect(resources).toContainEqual(
      expect.objectContaining({
        kind: "extension",
        name: "project",
        scope: "project",
        enabled: true,
        executable: true,
      }),
    )
  })
})
