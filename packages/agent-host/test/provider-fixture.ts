import { mkdtempSync, writeFileSync } from "node:fs"
import { createServer, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * A deterministic model provider, as a real HTTP server.
 *
 * The whole Milestone 2 slice — prompt, stream, approve, abort, close, reopen —
 * is composition. Every piece under it is unit-tested with Pi's runtime faked
 * out, which is why none of those tests can catch the failures that only appear
 * once the pieces are wired together: an event emitted against the wrong
 * session, a lock taken in the wrong order, a tool result Pi never sees. Driving
 * the composition needs a model, and a model that answers the same way every
 * time.
 *
 * This is that model, and it is deliberately *not* a stub of Pi's stream layer.
 * It is an OpenAI-compatible endpoint that Pi reaches over a real socket, so the
 * test exercises Pi's own request construction, SSE parsing, tool-call assembly
 * and session writes rather than a hand-rolled imitation of them. The only thing
 * faked is what a language model would have decided.
 *
 * Registered through `models.json` in a throwaway agent directory, so nothing
 * here reads or writes the developer's real `~/.pi`. See `agentDirWith`.
 */

export const FIXTURE_PROVIDER = "bake-pi-fixture"
export const FIXTURE_MODEL = "fixture-1"
/**
 * A second model on the same provider, differing only in `reasoning`.
 *
 * Model selection needs somewhere to select *to*, and thinking levels need a
 * model that has any: Pi derives the supported set from `reasoning` and
 * `thinkingLevelMap`, so a catalog of one non-reasoning model can only ever
 * report `off` and would make a clamp untestable.
 */
export const FIXTURE_REASONING_MODEL = "fixture-reasoning"

/**
 * A provider with no credential, and no way to acquire one here.
 *
 * `setModel` refuses a model whose provider has no auth, and that refusal is the
 * difference between a selector that reports "no key for this provider" and one
 * that appears to switch and then fails on the next prompt. It needs a provider
 * that is genuinely unauthenticated, which the fixture provider — carrying a
 * literal key so its models are selectable — cannot be.
 */
export const UNAUTHED_PROVIDER = "bake-pi-unauthed"
export const UNAUTHED_MODEL = "unauthed-1"

/** One assistant turn, described by what the model decided rather than by bytes. */
export interface ScriptedTurn {
  /** Text streamed one chunk per element, so a delta is observable mid-turn. */
  text?: readonly string[]
  /** Tool calls the assistant asks for, streamed after the text. */
  toolCalls?: readonly { id: string; name: string; args: unknown }[]
  /**
   * Stops after the first chunk and never finishes the stream.
   *
   * This is how the abort path is driven: the turn is genuinely in flight, Pi is
   * genuinely mid-stream, and the abort has something real to interrupt. A held
   * response is closed by the client hanging up, and any still open when the
   * server shuts down is destroyed then — deliberately *not* on the request's
   * own `close` event, which Node fires as soon as the request body is consumed
   * and which therefore ends the stream instantly instead of holding it.
   */
  stall?: boolean
}

export interface RecordedRequest {
  /** The messages Pi sent, which is how a tool result is proven to have reached the model. */
  messages: readonly { role: string; content: unknown }[]
  toolNames: readonly string[]
  authorization: string | undefined
  /** Which model Pi asked for, which is how a selection is proven to have taken effect. */
  model: string | undefined
}

export interface ModelServer {
  readonly baseUrl: string
  /** Every request the server answered, in order. */
  readonly requests: readonly RecordedRequest[]
  /** Turns are consumed in order; an unscripted request fails the test loudly. */
  script(...turns: ScriptedTurn[]): void
  close(): Promise<void>
}

const chunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
  `data: ${JSON.stringify({
    id: "chatcmpl-fixture",
    object: "chat.completion.chunk",
    created: 0,
    model: FIXTURE_MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`

/**
 * Usage arrives on its own chunk carrying no choices, which is the shape
 * `stream_options: { include_usage: true }` produces upstream. Pi reads usage
 * before it looks for a choice, so a usage-only chunk is not discarded.
 */
const usageChunk = (): string =>
  `data: ${JSON.stringify({
    id: "chatcmpl-fixture",
    object: "chat.completion.chunk",
    created: 0,
    model: FIXTURE_MODEL,
    choices: [],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  })}\n\n`

export const startModelServer = async (): Promise<ModelServer> => {
  const turns: ScriptedTurn[] = []
  const requests: RecordedRequest[] = []

  /** Responses deliberately left unfinished, so shutdown can still reclaim them. */
  const held = new Set<ServerResponse>()

  const server: Server = createServer((request, response) => {
    let body = ""
    request.on("data", (piece: Buffer) => {
      body += piece.toString("utf8")
    })
    request.on("end", () => {
      const parsed = safeParse(body)
      requests.push({
        messages: Array.isArray(parsed.messages) ? (parsed.messages as RecordedRequest["messages"]) : [],
        toolNames: Array.isArray(parsed.tools)
          ? parsed.tools.map((tool) => String((tool as { function?: { name?: unknown } }).function?.name ?? ""))
          : [],
        authorization: request.headers.authorization,
        model: typeof parsed.model === "string" ? parsed.model : undefined,
      })

      const turn = turns.shift()
      if (turn === undefined) {
        // Not a polite fallback. A request the script did not anticipate means
        // the agent did something the test never described, and answering it
        // with "done" would hide exactly that.
        response.writeHead(500, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: { message: "fixture: no scripted turn remains" } }))
        return
      }

      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })

      const pieces = turn.text ?? []
      for (const [index, piece] of pieces.entries()) {
        response.write(chunk(index === 0 ? { role: "assistant", content: piece } : { content: piece }))
        if (turn.stall === true) {
          held.add(response)
          return
        }
      }

      for (const [index, call] of (turn.toolCalls ?? []).entries()) {
        response.write(
          chunk({
            tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: "" } }],
          }),
        )
        // Arguments split across two deltas, because a provider that sent them
        // whole would never exercise Pi's partial-JSON accumulation.
        const args = JSON.stringify(call.args)
        const half = Math.max(1, Math.floor(args.length / 2))
        for (const part of [args.slice(0, half), args.slice(half)]) {
          response.write(chunk({ tool_calls: [{ index, function: { arguments: part } }] }))
        }
      }

      if (turn.stall === true) {
        held.add(response)
        return
      }

      response.write(chunk({}, (turn.toolCalls?.length ?? 0) > 0 ? "tool_calls" : "stop"))
      response.write(usageChunk())
      response.write("data: [DONE]\n\n")
      response.end()
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const { port } = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    requests,
    script: (...next) => {
      turns.push(...next)
    },
    close: async () => {
      for (const response of held) response.destroy()
      held.clear()
      await new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => {
          resolve()
        })
      })
    },
  }
}

const safeParse = (body: string): Record<string, unknown> => {
  try {
    return JSON.parse(body) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * A throwaway `PI_CODING_AGENT_DIR` wired to the fixture server.
 *
 * Pi reads `models.json`, `auth.json`, `settings.json`, extensions, skills and
 * themes out of this directory, so pointing it at a temp path is what keeps a
 * test run from reading — or writing — the developer's own agent state. The
 * literal `apiKey` is what makes the model selectable: Pi loads models without
 * auth but refuses to choose one.
 */
export const agentDirWith = (baseUrl: string, extensionPaths: readonly string[] = []): string => {
  const dir = mkdtempSync(join(tmpdir(), "bakepi-agent-"))
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        [FIXTURE_PROVIDER]: {
          name: "Bake Pi fixture",
          baseUrl,
          api: "openai-completions",
          apiKey: "fixture-key",
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [
            {
              id: FIXTURE_MODEL,
              name: "Fixture 1",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 4096,
            },
            {
              id: FIXTURE_REASONING_MODEL,
              name: "Fixture Reasoning",
              reasoning: true,
              // No `thinkingLevelMap`, which is how Pi is told the model has the
              // ordinary levels and not the two extended ones: `xhigh` and `max`
              // count as supported only when the map names them.
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200_000,
              maxTokens: 8192,
            },
          ],
        },
        [UNAUTHED_PROVIDER]: {
          name: "Bake Pi unauthenticated",
          baseUrl,
          api: "openai-completions",
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [
            {
              id: UNAUTHED_MODEL,
              name: "Unauthed 1",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8_000,
              maxTokens: 1024,
            },
          ],
        },
      },
    }),
    "utf8",
  )
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      defaultProvider: FIXTURE_PROVIDER,
      defaultModel: FIXTURE_MODEL,
      enableInstallTelemetry: false,
      extensions: extensionPaths,
    }),
    "utf8",
  )
  return dir
}
