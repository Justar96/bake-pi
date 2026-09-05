import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Diagnostics } from "../diagnostics.ts"
import { EventEmitter } from "../emitter.ts"
import { createPiRuntime, type PiRuntime } from "../runtime.ts"
import { agentDirWith, startModelServer, type ModelServer } from "../../test/provider-fixture.ts"

/**
 * Project trust at the Pi boundary, not only at Bake Pi's approval boundary.
 *
 * A project extension runs with the host's full permissions, so the trust card
 * has already failed if the module is evaluated before the answer reaches Pi's
 * resource loader. The marker below is written at module evaluation rather
 * than from a hook: waiting for an event would test whether the extension was
 * used, while this tests the stronger and required property that it never
 * loaded at all.
 */
test("an untrusted workspace cannot load a project extension, and a trusted one can", async () => {
  const temporary: string[] = []
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  const previousOffline = process.env.PI_OFFLINE
  const previousSkip = process.env.PI_SKIP_VERSION_CHECK
  const previousTelemetry = process.env.PI_TELEMETRY
  let runtime: PiRuntime | undefined
  let server: ModelServer | undefined

  try {
    server = await startModelServer()
    const agentDir = agentDirWith(server.baseUrl)
    temporary.push(agentDir)
    process.env.PI_CODING_AGENT_DIR = agentDir
    process.env.PI_OFFLINE = "1"
    process.env.PI_SKIP_VERSION_CHECK = "1"
    process.env.PI_TELEMETRY = "0"

    const root = mkdtempSync(join(tmpdir(), "bakepi-project-trust-"))
    temporary.push(root)
    const extensionDir = join(root, ".pi", "extensions")
    const loadedMarker = join(root, "project-extension-loaded.txt")
    mkdirSync(extensionDir, { recursive: true })
    writeFileSync(
      join(extensionDir, "trust-fixture.ts"),
      `import { appendFileSync } from "node:fs"
appendFileSync(${JSON.stringify(loadedMarker)}, "loaded\\n", "utf8")
export default function () {}
`,
      "utf8",
    )

    runtime = await createPiRuntime({ diagnostics: new Diagnostics(), emitter: new EventEmitter() })
    const { workspace } = await runtime.services.open_workspace({ root, runtime: { kind: "windows" } })
    expect(workspace.trust).toBe("untrusted")

    const untrusted = await runtime.services.create_session({ workspaceId: workspace.id })
    expect(existsSync(loadedMarker)).toBe(false)
    await runtime.services.close_session({ sessionId: untrusted.snapshot.summary.id })

    await runtime.services.set_project_trust({ id: workspace.id, trust: "trusted" })
    const trusted = await runtime.services.create_session({ workspaceId: workspace.id })
    expect(readFileSync(loadedMarker, "utf8")).toBe("loaded\n")
    await runtime.services.close_session({ sessionId: trusted.snapshot.summary.id })
  } finally {
    await runtime?.services.shutdown({})
    await server?.close()
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    if (previousOffline === undefined) delete process.env.PI_OFFLINE
    else process.env.PI_OFFLINE = previousOffline
    if (previousSkip === undefined) delete process.env.PI_SKIP_VERSION_CHECK
    else process.env.PI_SKIP_VERSION_CHECK = previousSkip
    if (previousTelemetry === undefined) delete process.env.PI_TELEMETRY
    else process.env.PI_TELEMETRY = previousTelemetry
    for (const path of temporary) rmSync(path, { recursive: true, force: true })
  }
}, 60_000)

/**
 * Full access outlives the host that granted it.
 *
 * Pi's trust store is a boolean, so the difference between `trusted` and `full`
 * exists only in Bake Pi's own permission file. This is the test that the file
 * is written where the decision is made and read where the workspace is opened
 * — across two runtimes, because a level held in one host's memory would pass
 * every assertion inside a single one.
 */
test("a workspace comes back at the level it was last set to, across host restarts", async () => {
  const temporary: string[] = []
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  const previousOffline = process.env.PI_OFFLINE
  const previousSkip = process.env.PI_SKIP_VERSION_CHECK
  const previousTelemetry = process.env.PI_TELEMETRY
  let first: PiRuntime | undefined
  let second: PiRuntime | undefined
  let third: PiRuntime | undefined
  let server: ModelServer | undefined

  try {
    server = await startModelServer()
    const agentDir = agentDirWith(server.baseUrl)
    temporary.push(agentDir)
    process.env.PI_CODING_AGENT_DIR = agentDir
    process.env.PI_OFFLINE = "1"
    process.env.PI_SKIP_VERSION_CHECK = "1"
    process.env.PI_TELEMETRY = "0"

    const root = mkdtempSync(join(tmpdir(), "bakepi-permission-memory-"))
    temporary.push(root)
    const undecided = mkdtempSync(join(tmpdir(), "bakepi-permission-default-"))
    temporary.push(undecided)

    first = await createPiRuntime({ diagnostics: new Diagnostics(), emitter: new EventEmitter() })
    const opened = await first.services.open_workspace({ root, runtime: { kind: "windows" } })
    expect(opened.workspace.trust).toBe("untrusted")
    const granted = await first.services.set_project_trust({ id: opened.workspace.id, trust: "full" })
    expect(granted.workspace.trust).toBe("full")
    await first.services.shutdown({})

    second = await createPiRuntime({ diagnostics: new Diagnostics(), emitter: new EventEmitter() })
    const reopened = await second.services.open_workspace({ root, runtime: { kind: "windows" } })
    expect(reopened.workspace.trust).toBe("full")
    // A project nobody has decided on is still restricted: the memory is
    // per-workspace, and the default has not been moved.
    expect((await second.services.get_default_trust({})).trust).toBe("untrusted")
    const fresh = await second.services.open_workspace({ root: undecided, runtime: { kind: "windows" } })
    expect(fresh.workspace.trust).toBe("untrusted")
    await second.services.set_default_trust({ trust: "trusted" })
    await second.services.shutdown({})

    third = await createPiRuntime({ diagnostics: new Diagnostics(), emitter: new EventEmitter() })
    // The default applies where nothing was decided, and only there.
    expect((await third.services.open_workspace({ root: undecided, runtime: { kind: "windows" } })).workspace.trust).toBe("trusted")
    expect((await third.services.open_workspace({ root, runtime: { kind: "windows" } })).workspace.trust).toBe("full")
  } finally {
    await first?.services.shutdown({})
    await second?.services.shutdown({})
    await third?.services.shutdown({})
    await server?.close()
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    if (previousOffline === undefined) delete process.env.PI_OFFLINE
    else process.env.PI_OFFLINE = previousOffline
    if (previousSkip === undefined) delete process.env.PI_SKIP_VERSION_CHECK
    else process.env.PI_SKIP_VERSION_CHECK = previousSkip
    if (previousTelemetry === undefined) delete process.env.PI_TELEMETRY
    else process.env.PI_TELEMETRY = previousTelemetry
    for (const path of temporary) rmSync(path, { recursive: true, force: true })
  }
}, 60_000)
