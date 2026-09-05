import type { EventEnvelope, EventName, EventPayload } from "@bake-pi/contract"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MessageChannel } from "node:worker_threads"
import { Diagnostics } from "../packages/agent-host/src/diagnostics.ts"
import { EventEmitter } from "../packages/agent-host/src/emitter.ts"
import { createPiRuntime, type PiRuntime } from "../packages/agent-host/src/runtime.ts"

/**
 * The deliberately opt-in real-provider lane.
 *
 * Normal tests prove composition through a deterministic HTTP provider, but a
 * fixture cannot vouch for a vendor's actual SSE and tool-call framing. This
 * probe spends real credentials, so it is absent from `verify`, requires an
 * explicit confirmation variable, creates exactly one session and accepts only
 * one tool approval. A second requested tool is denied and the turn is aborted.
 */

const required = (name: string): string => {
  const value = process.env[name]?.trim()
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

class EventInbox {
  readonly #events: EventEnvelope[] = []
  readonly #listeners = new Set<() => void>()

  push(value: unknown): void {
    if (typeof value !== "object" || value === null || (value as { kind?: unknown }).kind !== "event") return
    this.#events.push(value as EventEnvelope)
    for (const listener of this.#listeners) listener()
  }

  async waitFor<N extends EventName>(
    name: N,
    sessionId: string,
    options: { after?: number; timeoutMs?: number } = {},
  ): Promise<{ index: number; payload: EventPayload<N> }> {
    const after = options.after ?? 0
    const timeoutMs = options.timeoutMs ?? 75_000
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      for (let index = after; index < this.#events.length; index += 1) {
        const event = this.#events[index]!
        if (event.name === name && event.sessionId === sessionId) {
          return { index, payload: event.payload as EventPayload<N> }
        }
      }
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          clearTimeout(timer)
          this.#listeners.delete(wake)
          resolve()
        }
        const timer = setTimeout(wake, Math.min(250, Math.max(1, deadline - Date.now())))
        this.#listeners.add(wake)
      })
    }
    throw new Error(`timed out waiting for ${name}`)
  }

  count(name: EventName, sessionId: string): number {
    return this.#events.filter((event) => event.name === name && event.sessionId === sessionId).length
  }
}

const run = async (): Promise<void> => {
  if (process.env.BAKE_PI_LIVE_CONFIRM !== "yes") {
    throw new Error(
      "real-provider calls can incur cost; set BAKE_PI_LIVE_CONFIRM=yes together with " +
        "BAKE_PI_LIVE_PROVIDER, BAKE_PI_LIVE_MODEL, and BAKE_PI_LIVE_API_KEY",
    )
  }

  const providerId = required("BAKE_PI_LIVE_PROVIDER")
  const modelId = required("BAKE_PI_LIVE_MODEL")
  const apiKey = required("BAKE_PI_LIVE_API_KEY")
  const agentDir = mkdtempSync(join(tmpdir(), "bakepi-live-agent-"))
  const workspaceRoot = mkdtempSync(join(tmpdir(), "bakepi-live-workspace-"))
  const target = join(workspaceRoot, "provider-proof.txt")
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  const previousOffline = process.env.PI_OFFLINE
  const previousTelemetry = process.env.PI_TELEMETRY
  let runtime: PiRuntime | undefined

  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_OFFLINE = "1"
  process.env.PI_TELEMETRY = "0"

  try {
    const emitter = new EventEmitter()
    const inbox = new EventInbox()
    const channel = new MessageChannel()
    channel.port2.on("message", (message: unknown) => inbox.push(message))
    emitter.attach(channel.port1)
    runtime = await createPiRuntime({ emitter, diagnostics: new Diagnostics() })

    const models = await runtime.services.list_models({ providerId })
    const chosen = models.models.find((model) => model.id === modelId)
    if (chosen === undefined) throw new Error(`Pi does not offer ${providerId}/${modelId}`)
    if (!chosen.supportsToolCalls) throw new Error(`${providerId}/${modelId} does not support tool calls`)

    const credential = await runtime.services.set_api_key({ providerId, apiKey })
    if (credential.persisted !== false) throw new Error("the probe credential must remain host-lifetime only")

    const { workspace } = await runtime.services.open_workspace({
      root: workspaceRoot,
      runtime: { kind: "windows" },
    })
    // Deliberately untrusted: the provider's tool call must stop in Bake Pi's
    // blocking policy hook before any filesystem mutation can occur.
    const { snapshot } = await runtime.services.create_session({ workspaceId: workspace.id })
    const sessionId = snapshot.summary.id
    await runtime.services.set_model({ sessionId, providerId, modelId })

    await runtime.services.prompt({
      sessionId,
      attachments: [],
      text:
        `Use the write tool exactly once. Write the exact text bake-pi-live-ok to this exact path: ${target}. ` +
        "Do not call any other tool. After the write succeeds, reply with exactly bake-pi-live-ok.",
    })

    const approval = await inbox.waitFor("approval_requested", sessionId)
    if (approval.payload.request.call.name !== "write") {
      await runtime.services.respond_tool_approval({ requestId: approval.payload.request.id, decision: "deny" })
      await runtime.services.abort({ sessionId })
      throw new Error(`provider requested ${approval.payload.request.call.name} instead of write`)
    }
    if (existsSync(target)) throw new Error("the tool ran before approval")
    await runtime.services.respond_tool_approval({
      requestId: approval.payload.request.id,
      decision: "allow_once",
    })

    const finished = await inbox.waitFor("tool_call_finished", sessionId, { after: approval.index })
    if (finished.payload.result.status !== "succeeded") {
      throw new Error(`approved tool finished as ${finished.payload.result.status}`)
    }

    const settled = await inbox.waitFor("turn_settled", sessionId, { after: finished.index })
    if (settled.payload.status !== "complete") {
      throw new Error(`provider turn settled as ${settled.payload.status}`)
    }
    if (inbox.count("approval_requested", sessionId) !== 1) {
      await runtime.services.abort({ sessionId })
      throw new Error("provider requested more than the probe's one-tool cap")
    }
    if (inbox.count("block_delta", sessionId) === 0) throw new Error("provider produced no streamed text delta")
    if (!existsSync(target) || readFileSync(target, "utf8") !== "bake-pi-live-ok") {
      throw new Error("the approved real-provider write did not produce the expected file")
    }

    const final = await runtime.services.open_session({ sessionId })
    if (!JSON.stringify(final.snapshot.messages).includes("bake-pi-live-ok")) {
      throw new Error("the provider's streamed answer was absent from the authoritative snapshot")
    }

    console.log(
      JSON.stringify(
        {
          provider: providerId,
          model: modelId,
          streamed: true,
          approvalBlockedMutation: true,
          approvedToolCompleted: true,
          status: "passed",
        },
        null,
        2,
      ),
    )
  } finally {
    await runtime?.services.shutdown({})
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    if (previousOffline === undefined) delete process.env.PI_OFFLINE
    else process.env.PI_OFFLINE = previousOffline
    if (previousTelemetry === undefined) delete process.env.PI_TELEMETRY
    else process.env.PI_TELEMETRY = previousTelemetry
    rmSync(agentDir, { recursive: true, force: true })
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
}

await run()
