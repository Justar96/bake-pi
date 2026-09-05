import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { Diagnostics } from "../src/diagnostics.ts"
import { EventEmitter } from "../src/emitter.ts"
import { createPiRuntime, type PiRuntime } from "../src/runtime.ts"
import {
  agentDirWith,
  FIXTURE_MODEL,
  FIXTURE_PROVIDER,
  startModelServer,
  type ModelServer,
} from "./provider-fixture.ts"

const root = join(import.meta.dir, "../../..")
const cli = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js")
const temporary: string[] = []
let server: ModelServer
let agentDir: string
let previousAgentDir: string | undefined

beforeAll(async () => {
  server = await startModelServer()
  agentDir = agentDirWith(server.baseUrl)
  temporary.push(agentDir)
  previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
})

afterAll(async () => {
  await server.close()
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir
  for (const path of temporary) rmSync(path, { recursive: true, force: true })
})

const runCli = async (cwd: string, args: readonly string[]): Promise<void> => {
  const child = Bun.spawn(
    [
      process.execPath,
      cli,
      "--provider",
      FIXTURE_PROVIDER,
      "--model",
      FIXTURE_MODEL,
      "--approve",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--offline",
      "--print",
      ...args,
    ],
    {
      cwd,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_TELEMETRY: "0" },
      stdout: "pipe",
      stderr: "pipe",
    },
  )

  let timer: ReturnType<typeof setTimeout> | undefined
  const exit = await Promise.race([
    child.exited,
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), 30_000)
    }),
  ]).finally(() => clearTimeout(timer))
  if (exit === "timeout") {
    child.kill()
    throw new Error("Pi CLI did not exit within 30 seconds")
  }
  if (exit !== 0) {
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    throw new Error(`Pi CLI exited ${String(exit)}\n${stdout.slice(0, 1_000)}\n${stderr.slice(0, 1_000)}`)
  }
}

const runtimeFor = async (): Promise<PiRuntime> =>
  createPiRuntime({ emitter: new EventEmitter(), diagnostics: new Diagnostics() })

describe("the real Pi CLI and Bake Pi share one session format", () => {
  test("Bake Pi adopts and continues a CLI session, then detects a later CLI append", async () => {
    // Pi buckets sessions by the workspace spelling; Bake canonicalizes it
    // before opening. Use that same identity even when TEMP is an 8.3 alias.
    const workspace = realpathSync.native(mkdtempSync(join(tmpdir(), "bakepi-cli-workspace-")))
    temporary.push(workspace)
    const sessionDir = SessionManager.create(workspace).getSessionDir()

    server.script({ text: ["created by the real Pi CLI"] })
    await runCli(workspace, ["--session-dir", sessionDir, "first turn from cli"])

    const runtime = await runtimeFor()
    try {
      const { workspace: opened } = await runtime.services.open_workspace({
        root: workspace,
        runtime: { kind: "windows" },
      })
      await runtime.services.set_project_trust({ id: opened.id, trust: "trusted" })
      const listed = await runtime.services.list_sessions({ workspaceId: opened.id })
      expect(listed.sessions).toHaveLength(1)

      const summary = listed.sessions[0]!
      const { snapshot } = await runtime.services.open_session({ sessionId: summary.id })
      expect(JSON.stringify(snapshot.messages)).toContain("first turn from cli")
      expect(JSON.stringify(snapshot.messages)).toContain("created by the real Pi CLI")

      server.script({ text: ["continued by Bake Pi"] })
      await runtime.services.prompt({
        sessionId: summary.id,
        text: "continue in Bake Pi",
        attachments: [],
      })
      await waitUntilIdle(() => runtime.services.open_session({ sessionId: summary.id }))

      // The CLI does not consult Bake Pi's sidecar lock. That is why the
      // fingerprint check exists as a second boundary: after this append, the
      // already-open Bake Pi session must stop instead of silently forking.
      server.script({ text: ["appended by the CLI while Bake Pi owned the file"] })
      await runCli(workspace, ["--session", summary.path, "competing cli turn"])

      await expect(
        runtime.services.prompt({ sessionId: summary.id, text: "must be refused", attachments: [] }),
      ).rejects.toMatchObject({ code: "session_busy" })
    } finally {
      await runtime.services.shutdown({})
    }
  }, 90_000)
})

const waitUntilIdle = async (
  read: () => Promise<{ snapshot: { status: string } }>,
): Promise<void> => {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if ((await read()).snapshot.status === "idle") return
    await Bun.sleep(10)
  }
  throw new Error("Bake Pi turn did not settle")
}
