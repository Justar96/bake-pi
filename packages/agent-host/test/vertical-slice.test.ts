import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import type {
  CommandName,
  CommandParams,
  CommandResult,
  EventEnvelope,
  EventName,
  EventPayload,
  ResponseEnvelope,
} from "@bake-pi/contract"
import { acceptEvent, parseCommandResult, parseImageUrl } from "@bake-pi/contract"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { Diagnostics } from "../src/diagnostics.ts"
import { createDispatcher, type Dispatch } from "../src/dispatch.ts"
import { EventEmitter } from "../src/emitter.ts"
import { TimingStore } from "../src/observability/timings.ts"
import type { HostMessagePort } from "../src/parent-port.ts"
import { createPiRuntime, type PiRuntime } from "../src/runtime.ts"
import { lockPathFor } from "../src/session/ownership.ts"
import { toolMarkerPathFor } from "../src/session/tool-marker.ts"
import {
  agentDirWith,
  FIXTURE_MODEL,
  FIXTURE_PROVIDER,
  FIXTURE_REASONING_MODEL,
  startModelServer,
  UNAUTHED_MODEL,
  UNAUTHED_PROVIDER,
  type ModelServer,
} from "./provider-fixture.ts"

/**
 * The Milestone 2 slice, driven end to end.
 *
 * Everything under this file is already unit-tested with Pi faked out. That is
 * exactly why this file exists: those tests deliberately cannot see the failures
 * that only appear once real Pi is in the middle — an event emitted against the
 * wrong session, a snapshot fence taken at the wrong moment, an approval that
 * resolves after the tool already ran, a lock taken in an order that cannot
 * detect what it exists to detect. Each of those renders perfectly and is wrong.
 *
 * Two things are faked, and only because they cannot be made deterministic
 * otherwise: what a language model decided (`provider-fixture.ts`, reached over
 * a real socket) and the renderer's `MessagePort` (`Recorder`, below). Pi is
 * real, the session files are real, the tools really run, and the approval gate
 * really blocks them.
 *
 * One runtime is shared across the file and each test gets its own workspace and
 * session. That is not a shortcut around isolation: `createPiRuntime` builds
 * Pi's entire `ModelRuntime`, and a per-test one would trade about fifteen
 * seconds for isolation the workspace boundary already gives. Everything that
 * must not leak between tests — trust, session files, event sequences — is
 * scoped to a workspace or a session already.
 */

const temporary: string[] = []
let previousAgentDir: string | undefined
let previousOffline: string | undefined
let previousSkip: string | undefined
let previousTelemetry: string | undefined

/**
 * Collects the event stream the way the renderer would, and lets a test wait for
 * an event rather than sleep for one.
 *
 * Every envelope goes through the contract's own `acceptEvent` before it is
 * recorded, and that check is made on all of them rather than on a chosen few:
 * an event the agent host can emit but the contract cannot validate is an event
 * the renderer drops on the floor, and a test that only inspected payloads
 * directly would never notice. It caught a malformed `approval_resolved` the
 * first time this file ran.
 */
class Recorder {
  readonly envelopes: EventEnvelope[] = []
  /**
   * Run synchronously as each envelope arrives, for the one thing waiting
   * cannot observe: disk state at an instant *during* a turn. A test that awaits
   * `tool_call_started` and then reads the filesystem is reading it after the
   * tool already finished, which is exactly the moment the interesting evidence
   * is gone.
   */
  readonly probes: ((envelope: EventEnvelope) => void)[] = []
  readonly #waiters: { match: (envelope: EventEnvelope) => boolean; settle: () => void }[] = []

  port(): HostMessagePort {
    let onMessage: ((event: { data: unknown }) => void) | undefined
    return {
      postMessage: (message: unknown) => {
        const envelope = message as EventEnvelope
        acceptEvent(envelope)
        this.envelopes.push(envelope)
        for (const probe of this.probes) probe(envelope)
        for (const waiter of [...this.#waiters]) {
          if (!waiter.match(envelope)) continue
          this.#waiters.splice(this.#waiters.indexOf(waiter), 1)
          waiter.settle()
        }
        queueMicrotask(() => onMessage?.({ data: { kind: "event_ack", count: 1 } }))
      },
      on: (event, listener) => {
        if (event === "message") onMessage = listener as (event: { data: unknown }) => void
      },
      start: () => {},
      close: () => {},
    }
  }

  /**
   * A view of one session's stream.
   *
   * Scoping to a session is not tidiness. Several sessions run in this file and
   * they emit the same event names; a wait that matched on name alone would
   * resolve against a previous test's turn and assert nothing at all — which is
   * how three of these tests first passed for the wrong reason.
   */
  session(sessionId: string): SessionView {
    return new SessionView(this, sessionId)
  }

  /** For the host-scoped events, which carry their session inside the payload. */
  async waitForHostEvent<N extends EventName>(
    name: N,
    where: (payload: EventPayload<N>) => boolean,
    since: number,
    timeoutMs = 20_000,
  ): Promise<EventPayload<N>> {
    return await this.waitFor(name, undefined, where, since, timeoutMs)
  }

  matching<N extends EventName>(
    name: N,
    sessionId: string | undefined,
    predicate: (payload: EventPayload<N>) => boolean,
    since: number,
  ): { index: number; payload: EventPayload<N> } | undefined {
    for (let index = since; index < this.envelopes.length; index += 1) {
      const envelope = this.envelopes[index]!
      if (envelope.name !== name) continue
      if (sessionId !== undefined && envelope.sessionId !== sessionId) continue
      const payload = envelope.payload as EventPayload<N>
      if (predicate(payload)) return { index, payload }
    }
    return undefined
  }

  async waitFor<N extends EventName>(
    name: N,
    sessionId: string | undefined,
    predicate: (payload: EventPayload<N>) => boolean,
    since: number,
    timeoutMs: number,
  ): Promise<EventPayload<N>> {
    const seen = this.matching(name, sessionId, predicate, since)
    if (seen !== undefined) return seen.payload

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const saw = this.envelopes
          .slice(since)
          .filter((envelope) => sessionId === undefined || envelope.sessionId === sessionId)
          .map((envelope) => envelope.name)
        reject(new Error(`timed out waiting for ${name}; saw [${saw.join(", ")}]`))
      }, timeoutMs)
      this.#waiters.push({
        match: (envelope) =>
          envelope.name === name &&
          (sessionId === undefined || envelope.sessionId === sessionId) &&
          predicate(envelope.payload as EventPayload<N>),
        settle: () => {
          clearTimeout(timer)
          resolve()
        },
      })
    })
    return this.matching(name, sessionId, predicate, since)!.payload
  }
}

class SessionView {
  readonly #recorder: Recorder
  readonly #sessionId: string

  constructor(recorder: Recorder, sessionId: string) {
    this.#recorder = recorder
    this.#sessionId = sessionId
  }

  /**
   * A position in the stream. Waits are made relative to one so a turn is never
   * satisfied by the turn before it.
   */
  mark(): number {
    return this.#recorder.envelopes.length
  }

  names(since = 0): string[] {
    return this.#recorder.envelopes
      .slice(since)
      .filter((envelope) => envelope.sessionId === this.#sessionId)
      .map((envelope) => envelope.name)
  }

  sequences(): number[] {
    return this.#recorder.envelopes
      .filter((envelope) => envelope.sessionId === this.#sessionId)
      .map((envelope) => envelope.sequence)
  }

  payloads<N extends EventName>(name: N, since = 0): EventPayload<N>[] {
    return this.#recorder.envelopes
      .slice(since)
      .filter((envelope) => envelope.name === name && envelope.sessionId === this.#sessionId)
      .map((envelope) => envelope.payload as EventPayload<N>)
  }

  async waitFor<N extends EventName>(
    name: N,
    options: { since?: number; where?: (payload: EventPayload<N>) => boolean; timeoutMs?: number } = {},
  ): Promise<EventPayload<N>> {
    return await this.#recorder.waitFor(
      name,
      this.#sessionId,
      options.where ?? (() => true),
      options.since ?? 0,
      options.timeoutMs ?? 20_000,
    )
  }

  /** Waits for the turn started at `since` to finish, rather than for a fixed delay. */
  async settled(since: number): Promise<void> {
    await this.waitFor("session_status_changed", { since, where: (payload) => payload.status === "streaming" })
    await this.waitFor("session_status_changed", { since, where: (payload) => payload.status === "idle" })
  }
}

let server: ModelServer
let runtime: PiRuntime
let recorder: Recorder
let diagnostics: Diagnostics
/** Held so one test can take the renderer away and give it back. */
let emitter: EventEmitter
/** The store the host's own leg of a command is recorded in, shared with the runtime. */
let timings: TimingStore
let dispatch: Dispatch

beforeAll(async () => {
  server = await startModelServer()
  // Loaded through Pi's settings rather than as an inline factory. This is the
  // arbitrary absolute TypeScript path Milestone 0 calls for, and makes jiti,
  // resource discovery and the shared ExtensionUIContext part of the proof.
  const extensionDir = mkdtempSync(join(tmpdir(), "bakepi-extension-"))
  temporary.push(extensionDir)
  const extensionPath = join(extensionDir, "dialog-fixture.ts")
  writeFileSync(
    extensionPath,
    `export default function (pi) {
  pi.on("session_start", async (_event, ctx) => {
    if (process.env.BAKE_PI_BLOCK_SESSION_START !== "1") return
    await ctx.ui.confirm("Blocking session start", "Keep the bind in flight")
  })
  pi.on("before_agent_start", async (event, ctx) => {
    if (event.prompt !== "ask the extension" && event.prompt !== "ask the failing extension") return
    const selected = await ctx.ui.select("Arbitrary extension dialog", ["Continue", "Stop"])
    if (event.prompt === "ask the failing extension") throw new Error("fixture failed after its dialog")
    return { systemPrompt: event.systemPrompt + "\\n\\nExtension choice: " + (selected ?? "cancelled") }
  })
  pi.on("input", async (event, ctx) => {
    if (!event.text.startsWith("block queued input")) return { action: "continue" }
    await ctx.ui.confirm("Blocking queued input", event.text)
    return { action: "continue" }
  })
}
`,
    "utf8",
  )

  const agentDir = agentDirWith(server.baseUrl, [extensionPath])
  temporary.push(agentDir)

  // Set before `createPiRuntime`, which is when Pi resolves the agent directory.
  // Everything Pi reads or writes for the rest of this file — models, settings,
  // credentials, project trust, sessions — lands under the temp directory rather
  // than in the developer's own `~/.pi`.
  previousAgentDir = process.env.PI_CODING_AGENT_DIR
  previousOffline = process.env.PI_OFFLINE
  previousSkip = process.env.PI_SKIP_VERSION_CHECK
  previousTelemetry = process.env.PI_TELEMETRY
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_OFFLINE = "1"
  process.env.PI_SKIP_VERSION_CHECK = "1"
  process.env.PI_TELEMETRY = "0"

  diagnostics = new Diagnostics()
  emitter = new EventEmitter()
  recorder = new Recorder()
  emitter.attach(recorder.port())
  timings = new TimingStore()
  runtime = await createPiRuntime({ diagnostics, emitter, timings })
  dispatch = createDispatcher({
    diagnostics,
    emitter,
    timings,
    services: () => runtime.services,
    respond: (response) => void answers.push(response),
  })
})

afterAll(async () => {
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
})

type TimingsReport = CommandResult<"get_timings">

interface Open {
  workspaceId: string
  root: string
  sessionId: string
  view: SessionView
}

const openSessionIn = async (options: { trusted: boolean }): Promise<Open> => {
  const root = mkdtempSync(join(tmpdir(), "bakepi-slice-"))
  temporary.push(root)
  const { workspace } = await runtime.services.open_workspace({ root, runtime: { kind: "windows" } })
  if (options.trusted) await runtime.services.set_project_trust({ id: workspace.id, trust: "trusted" })
  const { snapshot } = await runtime.services.create_session({ workspaceId: workspace.id })
  return {
    workspaceId: workspace.id,
    root,
    sessionId: snapshot.summary.id,
    view: recorder.session(snapshot.summary.id),
  }
}

/**
 * Every response the host has posted, in order, so a command issued as a
 * message can be answered like a call.
 */
const answers: ResponseEnvelope[] = []
let requestSequence = 0

/**
 * A command the way one actually arrives: as a message, through the same
 * `dispatch` that `index.ts` wires to the parent port.
 *
 * Most of this file calls `runtime.services` directly, which is the shortest
 * path to the behaviour those tests are about and keeps a thrown `BakePiError`
 * where they can assert on it. The timing tests cannot: what they measure is
 * the host's leg of a command — the message arriving, the envelope validated,
 * the handler run, the answer posted — and none of that is entered by calling a
 * handler. Since the span moved out of the handler map and onto the leg,
 * calling a handler records nothing at all, which is the correct behaviour and
 * makes this helper the only way to ask what a command cost.
 */
const sendRaw = async (message: unknown): Promise<ResponseEnvelope> => {
  const at = answers.length
  await dispatch(message)
  const response = answers[at]
  if (response === undefined) throw new Error("the host answered nothing")
  return response
}

const send = async <N extends CommandName>(name: N, params: CommandParams<N>): Promise<CommandResult<N>> => {
  const id = `req-${String((requestSequence += 1))}`
  const response = await sendRaw({ kind: "command", id, name, params })
  // Rethrown so a caller reads like a handler call. The code is carried in the
  // message rather than in a rebuilt `BakePiError`, because what came back is a
  // wire error and inventing an exception around it would claim more than the
  // response said.
  if (!response.ok) throw new Error(`${name}: ${response.error.code}`)
  return response.result as CommandResult<N>
}

describe("a prompt, streamed", () => {
  test("the turn reaches the model, reaches the renderer, and reaches disk", async () => {
    const open = await openSessionIn({ trusted: true })
    const since = open.view.mark()
    server.script({ text: ["Hel", "lo ", "there"] })

    expect(await runtime.services.prompt({ sessionId: open.sessionId, text: "say hello", attachments: [] })).toEqual({
      accepted: true,
      queued: false,
    })
    await open.view.settled(since)

    const names = open.view.names(since)
    // This order is the contract the renderer's reducer is written against: the
    // status opens the turn, the message exists before any delta names it, and
    // the turn settles before the session goes idle.
    expect(names.indexOf("session_status_changed")).toBeLessThan(names.indexOf("message_added"))
    expect(names.indexOf("message_added")).toBeLessThan(names.indexOf("block_delta"))
    expect(names.indexOf("block_delta")).toBeLessThan(names.indexOf("turn_settled"))

    const deltas = open.view.payloads("block_delta", since).map((payload) => payload.textDelta)
    expect(deltas.join("")).toBe("Hello there")

    // Strictly monotonic per session, from one, with no gaps. This is the fence
    // the renderer discards against; a repeat or a skip is indistinguishable
    // from a lost event on its side.
    const sequences = open.view.sequences()
    expect(sequences).toEqual(sequences.map((_, index) => index + 1))

    // Pi persisted the turn, and the summary points at the file it wrote.
    const { sessions } = await runtime.services.list_sessions({ workspaceId: open.workspaceId })
    const summary = sessions.find((session) => session.id === open.sessionId)!
    expect(existsSync(summary.path)).toBe(true)
    expect(readFileSync(summary.path, "utf8")).toContain("Hello there")

    // A session names itself by what was asked, not by where it landed.
    expect(summary.title).toBe("say hello")
  }, 40_000)

  test("the snapshot carries the model the fixture provider registered", async () => {
    const open = await openSessionIn({ trusted: true })
    const { snapshot } = await runtime.services.open_session({ sessionId: open.sessionId })
    expect(snapshot.model.modelId).toBe(FIXTURE_MODEL)
    expect(snapshot.status).toBe("idle")
  }, 40_000)

  test("an attached workspace file reaches the model through Pi's prompt API", async () => {
    const open = await openSessionIn({ trusted: true })
    const attachment = join(open.root, "context.txt")
    const content = "attachment content only the model request can prove"
    writeFileSync(attachment, content, "utf8")
    const before = server.requests.length
    const since = open.view.mark()
    server.script({ text: ["read it"] })

    await runtime.services.prompt({
      sessionId: open.sessionId,
      text: "use the attachment",
      attachments: [{ path: attachment, mediaType: "text/plain", bytes: Buffer.byteLength(content) }],
    })
    await open.view.settled(since)

    const request = server.requests[before]!
    expect(JSON.stringify(request.messages)).toContain(content)
    expect(JSON.stringify(request.messages)).toContain("use the attachment")
  }, 40_000)

  test("an attached workspace file remains attached when queued as a follow-up", async () => {
    const open = await openSessionIn({ trusted: true })
    const attachment = join(open.root, "follow-up.txt")
    const content = "queued attachment content"
    writeFileSync(attachment, content, "utf8")

    expect(await runtime.services.follow_up({
      sessionId: open.sessionId,
      text: "use this next",
      attachments: [{ path: attachment, mediaType: "text/plain", bytes: Buffer.byteLength(content) }],
    })).toEqual({ queued: true })

    const { queue } = await runtime.services.get_queue({ sessionId: open.sessionId })
    expect(queue).toHaveLength(1)
    expect(queue[0]).toMatchObject({ mode: "follow_up" })
    expect(queue[0]?.text).toContain(content)
    expect(queue[0]?.text).toContain("use this next")
  }, 40_000)

  test("an attached image is processed and reaches a vision-capable model", async () => {
    const open = await openSessionIn({ trusted: true })
    await runtime.services.set_model({
      sessionId: open.sessionId,
      providerId: FIXTURE_PROVIDER,
      modelId: FIXTURE_REASONING_MODEL,
    })
    const attachment = join(open.root, "pixel.png")
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    )
    writeFileSync(attachment, png)
    const before = server.requests.length
    const since = open.view.mark()
    server.script({ text: ["saw it"] })

    await runtime.services.prompt({
      sessionId: open.sessionId,
      text: "inspect this image",
      attachments: [{ path: attachment, mediaType: "image/png", bytes: png.byteLength }],
    })
    await open.view.settled(since)

    const request = JSON.stringify(server.requests[before]!.messages)
    expect(request).toContain("image_url")
    expect(request).toContain("data:image/")
  }, 40_000)

  /**
   * The other half of the same attachment: what the *renderer* gets.
   *
   * The test above proves the bytes reach the provider. This one proves the
   * projection carries an address rather than the bytes, and that the address
   * resolves — which is the pair that has to hold, because a URL nothing
   * answers is a broken image and bytes on the block are the megabytes-per-
   * snapshot cost the URL exists to avoid.
   */
  test("an attached image reaches the renderer as a resolvable URL, not as bytes", async () => {
    const open = await openSessionIn({ trusted: true })
    const attachment = join(open.root, "pixel.png")
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    )
    writeFileSync(attachment, png)
    /*
      Closed in `finally`, unlike its neighbours, because this file opens
      sessions up to the host's own cap of 32 and does not give them back. One
      more leaked session turns any failure here into five unrelated
      `session_limit_reached` failures in the tests that follow, which is a long
      way from the assertion that actually broke.
    */
    try {
      const since = open.view.mark()
      server.script({ text: ["saw it"] })
      await runtime.services.prompt({
        sessionId: open.sessionId,
        text: "inspect this image",
        attachments: [{ path: attachment, mediaType: "image/png", bytes: png.byteLength }],
      })
      await open.view.settled(since)

      const { snapshot } = await runtime.services.open_session({ sessionId: open.sessionId })
      const parts = snapshot.messages.flatMap((message, messageIndex) =>
        message.blocks.map((block) => ({ messageIndex, block })),
      )
      const image = parts.find((part) => part.block.kind === "image")
      expect(image).toBeDefined()

      // An address, and one this session actually owns — not an empty string,
      // and not a data URI.
      const url = image!.block.kind === "image" ? image!.block.url : ""
      const ref = parseImageUrl(new URL(url).pathname)
      expect(ref?.sessionId).toBe(open.sessionId)
      expect(url.startsWith("data:")).toBe(false)

      // And it resolves, through the command main's protocol handler issues.
      const served = await runtime.services.read_image(ref!)
      expect(served.mediaType).toBe("image/png")
      // Pi re-encodes an attachment on the way in, so the bytes are not
      // asserted equal to the file — what matters is that they decode to the
      // image the media type claims. The eight-byte PNG signature is that claim.
      expect([...Buffer.from(served.data, "base64").subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])

      /*
        And every neighbouring address is refused rather than guessed at. These
        params arrive from a URL in a renderer fetch, so "a part that is not an
        image", "a part that is not there" and "a message that is not there" are
        the three ways a stale or invented URL reaches the host — all of them
        after history has been renumbered by a compaction or a fork.
      */
      const text = parts.find((part) => part.block.kind === "text")
      expect(text).toBeDefined()
      for (const bad of [
        { messageIndex: text!.messageIndex, blockIndex: text!.block.index },
        { messageIndex: image!.messageIndex, blockIndex: 99 },
        { messageIndex: 99, blockIndex: 0 },
      ]) {
        await expect(runtime.services.read_image({ sessionId: open.sessionId, ...bad })).rejects.toMatchObject({
          code: "resource_not_found",
        })
      }
    } finally {
      await runtime.services.close_session({ sessionId: open.sessionId })
    }
  }, 40_000)
})

/**
 * The renderer's one self-initiated repair, against the real thing.
 *
 * `backpressure.test.ts` proves the mechanism with a faked session; this proves
 * the command is routed, that the host it reaches rebuilds from Pi's actual
 * history rather than from anything it was holding, and that the fence really
 * does restart — which is the part the renderer's discard rule depends on.
 */
describe("asking the host to resync", () => {
  test("a resync answers with a fenced snapshot of the session Pi actually has", async () => {
    const open = await openSessionIn({ trusted: true })
    const since = open.view.mark()
    server.script({ text: ["before ", "the gap"] })
    await runtime.services.prompt({ sessionId: open.sessionId, text: "say something", attachments: [] })
    await open.view.settled(since)

    const asked = open.view.mark()
    expect(await runtime.services.resync_session({ sessionId: open.sessionId })).toEqual({})
    const { snapshot } = await open.view.waitFor("session_snapshot", { since: asked })

    // It says why the timeline is about to jump, and it carries the turn that
    // actually happened rather than a replay of the events that described it.
    expect(snapshot.afterGap).toBe(true)
    const text = snapshot.messages
      .flatMap((message) => message.blocks)
      .map((block) => (block.kind === "text" ? block.text : ""))
      .join("")
    expect(text).toContain("before the gap")

    // The counter restarted, which is what makes the fence usable: every event
    // the renderer already holds is above the new snapshot's sequence and would
    // otherwise be applied on top of it.
    expect(snapshot.sequence).toBe(0)
    const after = open.view.names(asked)
    expect(after[0]).toBe("session_snapshot")
  }, 40_000)

  test("a discard while no renderer is attached repairs itself when one arrives", async () => {
    const open = await openSessionIn({ trusted: true })
    const since = open.view.mark()
    server.script({ text: ["written while nobody watched"] })
    await runtime.services.prompt({ sessionId: open.sessionId, text: "say something", attachments: [] })
    await open.view.settled(since)

    // The window this host buffers in. Nothing emitted from here reaches a
    // renderer, and past the cap nothing is even kept.
    emitter.detach()
    const fat = "x".repeat(65_536)
    while (emitter.droppedWhileDetached === 0) {
      emitter.emit("block_delta", { messageId: "m0", blockIndex: 0, textDelta: fat }, open.sessionId)
    }

    const reattached = open.view.mark()
    emitter.attach(recorder.port())
    const { snapshot } = await open.view.waitFor("session_snapshot", { since: reattached })

    // Nothing asked for this. The emitter reported what it dropped and the
    // runtime's own wiring turned that into a snapshot — the half of the repair
    // that exists because a renderer cannot ask about events it never saw.
    expect(snapshot.afterGap).toBe(true)
    const names = open.view.names(reattached)
    // Stated before it is repaired, so the jump has an explanation attached.
    expect(names.indexOf("stream_gap")).toBeLessThan(names.indexOf("session_snapshot"))
    expect(open.view.payloads("stream_gap", reattached)[0]?.sessionId).toBe(open.sessionId)
  }, 40_000)

  test("a replacement renderer port re-fences every open session without waiting for a gap", async () => {
    const open = await openSessionIn({ trusted: true })
    const reattached = open.view.mark()

    emitter.attach(recorder.port(), true)
    const { snapshot } = await open.view.waitFor("session_snapshot", { since: reattached })

    expect(snapshot.summary.id).toBe(open.sessionId)
    expect(snapshot.afterGap).toBe(false)
    const names = recorder.envelopes.slice(reattached).map((envelope) => envelope.name)
    expect(names).toContain("host_ready")
    expect(names).toContain("workspace_changed")
  }, 40_000)

  test("a resync for a session that is not open is refused rather than invented", async () => {
    await expect(runtime.services.resync_session({ sessionId: "no-such-session" })).rejects.toThrow()
  }, 40_000)
})

describe("credentials and models", () => {
  test("a key set through the contract is held by Pi's runtime and reported back", async () => {
    // The credential path is part of this slice and has no unit: `set_api_key`
    // writes through Pi's `ModelRuntime`, and what that does — and does not —
    // reach is only observable against a real runtime. It reaches the runtime's
    // credential overlay, and through it every session on this host; it does not
    // reach `auth.json`, which is why `apiKeyPersistence` is false. Both halves
    // are measured in `session/credentials.test.ts`.
    const marker = recorder.envelopes.length
    const { status, persisted } = await runtime.services.set_api_key({
      providerId: FIXTURE_PROVIDER,
      apiKey: "set-by-bake-pi",
    })
    expect(status).toBe("authenticated")
    expect(persisted).toBe(false)

    const changed = await recorder.waitForHostEvent(
      "auth_changed",
      (payload) => payload.providerId === FIXTURE_PROVIDER,
      marker,
    )
    expect(changed.status).toBe("authenticated")

    // The key never comes back out. A credential echoed into a result or an
    // event is a credential in the renderer's memory and in every log that
    // records events.
    expect(JSON.stringify(recorder.envelopes.slice(marker))).not.toContain("set-by-bake-pi")

    const { providers } = await runtime.services.get_auth_status({})
    expect(providers.find((provider) => provider.id === FIXTURE_PROVIDER)?.authStatus).toBe("authenticated")

    const { models } = await runtime.services.list_models({ providerId: FIXTURE_PROVIDER })
    expect(models.map((model) => model.id)).toEqual([FIXTURE_MODEL, FIXTURE_REASONING_MODEL])

    // Capabilities come from Pi's catalog entry, not from a literal. They were
    // hard-coded false until model selection existed to read them, which would
    // have produced a selector that hides the thinking control on every model
    // that supports thinking and offers no context window on any model at all.
    expect(models.find((model) => model.id === FIXTURE_MODEL)).toMatchObject({
      supportsThinking: false,
      supportsVision: false,
      contextWindowTokens: 128_000,
      maxOutputTokens: 4096,
    })
    expect(models.find((model) => model.id === FIXTURE_REASONING_MODEL)).toMatchObject({
      supportsThinking: true,
      supportsVision: true,
      contextWindowTokens: 200_000,
      maxOutputTokens: 8192,
    })
  }, 40_000)
})

describe("an extension loaded from an arbitrary path", () => {
  test("resource inventory lists it and reload announces the refreshed inventory", async () => {
    const open = await openSessionIn({ trusted: true })
    expect(await runtime.services.check_resource_updates({ workspaceId: open.workspaceId })).toEqual({ updates: [] })
    const listed = await runtime.services.list_resources({ workspaceId: open.workspaceId })
    expect(listed.resources).toContainEqual(expect.objectContaining({
      kind: "extension",
      scope: "user",
      name: "dialog-fixture",
      enabled: true,
      executable: true,
    }))

    const since = recorder.envelopes.length
    const reloaded = await runtime.services.reload_resources({ workspaceId: open.workspaceId })
    const changed = await recorder.waitForHostEvent("resources_changed", () => true, since)
    expect(changed.resources).toEqual(reloaded.resources)

    // This fixture is a local extension rather than a managed package, so Pi's
    // updater has nothing to replace. The command still goes through Pi and
    // reloads the live resource set instead of inventing a second update path.
    expect((await runtime.services.update_resources({ workspaceId: open.workspaceId })).resources)
      .toContainEqual(expect.objectContaining({ name: "dialog-fixture" }))
  }, 40_000)

  test("its blocking dialog crosses the event and command boundary before the turn continues", async () => {
    const open = await openSessionIn({ trusted: true })
    const since = open.view.mark()
    server.script({ text: ["continued after the dialog"] })

    await runtime.services.prompt({ sessionId: open.sessionId, text: "ask the extension", attachments: [] })
    const requested = await open.view.waitFor("extension_ui_requested", { since })
    expect(requested.request).toMatchObject({
      sessionId: open.sessionId,
      kind: "select",
      title: "Arbitrary extension dialog",
      options: [
        { value: "Continue", label: "Continue" },
        { value: "Stop", label: "Stop" },
      ],
    })
    // Pi's shared UI context does not identify its caller. Omitting attribution
    // is evidence of that SDK limit; naming this fixture would be invented data.
    expect(requested.request.extensionName).toBeUndefined()

    expect(
      await runtime.services.respond_select({ requestId: requested.request.id, value: "Continue" }),
    ).toEqual({ accepted: true })
    await open.view.settled(since)

    expect(open.view.payloads("extension_ui_resolved", since)).toEqual([{ requestId: requested.request.id }])
    // The extension used the answer to alter what Pi sent, proving the command
    // resolved the extension's parked promise rather than only dismissing a UI.
    expect(JSON.stringify(server.requests.at(-1)?.messages)).toContain("Extension choice: Continue")
  }, 60_000)

  test("reloading is refused while a turn is genuinely in flight", async () => {
    // A reload runs extension factories and `session_start` hooks, so landing
    // one mid-turn replaces the extension runtime under a turn that is still
    // going. The fixture streams one chunk and holds the socket, so the turn
    // here is really running rather than merely recently started.
    //
    // The predicate is `isIdle` rather than `isStreaming`, because the narrower
    // flag misses a retry, an auto-compaction, and a queued continuation. Those
    // three cannot be held open on demand in this harness, so what is measured
    // is the case that can be: refused while streaming, and — the part the
    // sole-writer guard's mid-turn abstention could have quietly broken —
    // refused for the right reason, retryably, rather than as a fork.
    const open = await openSessionIn({ trusted: true })
    const since = open.view.mark()
    server.script({ text: ["holding"], stall: true })

    await runtime.services.prompt({ sessionId: open.sessionId, text: "stall please", attachments: [] })
    await open.view.waitFor("block_delta", { since, where: (payload) => payload.textDelta === "holding" })

    await expect(runtime.services.reload_resources({ workspaceId: open.workspaceId })).rejects.toMatchObject({
      code: "session_busy",
      // Retryable, unlike a sole-writer refusal: waiting for the turn to finish
      // is exactly what makes this one succeed, and telling the user to close
      // and reopen the session would be the wrong instruction.
      retryable: true,
    })

    // Closing the session ends the held turn, and the reload then goes through:
    // the refusal was about timing rather than about this workspace.
    await runtime.services.close_session({ sessionId: open.sessionId })
    expect((await runtime.services.reload_resources({ workspaceId: open.workspaceId })).resources.length)
      .toBeGreaterThan(0)
  }, 60_000)

  test("a failure after a dialog is attributed to the extension and does not fail the turn", async () => {
    const open = await openSessionIn({ trusted: true })
    const since = open.view.mark()
    const hostSince = recorder.envelopes.length
    server.script({ text: ["the unaffected turn continued"] })

    await runtime.services.prompt({ sessionId: open.sessionId, text: "ask the failing extension", attachments: [] })
    const requested = await open.view.waitFor("extension_ui_requested", { since })
    await runtime.services.respond_select({ requestId: requested.request.id, value: "Continue" })

    const failure = await recorder.waitForHostEvent(
      "extension_error",
      (payload) => payload.extensionName === "dialog-fixture",
      hostSince,
    )
    expect(failure).toEqual({
      extensionName: "dialog-fixture",
      phase: "hook",
      message: "fixture failed after its dialog",
    })
    await open.view.settled(since)
    expect(open.view.payloads("block_delta", since).map((payload) => payload.textDelta).join(""))
      .toBe("the unaffected turn continued")
  }, 60_000)
})

describe("choosing a model", () => {
  /**
   * `CMD-002`, which is the last row of Milestone 2's first exit criterion.
   *
   * Every assertion here is about something only a real `ModelRuntime` and a
   * real `AgentSession` can answer: what Pi clamps a thinking level to, whether
   * a switch reaches the wire, whether the append it makes to the session file
   * trips the write guard on the next prompt, and how many events one switch
   * produces. A unit test with Pi faked out would have to state each of those as
   * an assumption, and the assumption is the thing at risk.
   */
  test("a switch is announced once, survives into the snapshot, and is what the next prompt runs on", async () => {
    const open = await openSessionIn({ trusted: true })
    const first = open.view.mark()
    server.script({ text: ["on the first model"] })
    await runtime.services.prompt({ sessionId: open.sessionId, text: "hello", attachments: [] })
    await open.view.settled(first)

    const since = open.view.mark()
    const { selection } = await runtime.services.set_model({
      sessionId: open.sessionId,
      providerId: FIXTURE_PROVIDER,
      modelId: FIXTURE_REASONING_MODEL,
    })
    expect(selection).toEqual({
      modelId: FIXTURE_REASONING_MODEL,
      providerId: FIXTURE_PROVIDER,
      // Carried over from the model being left, because nothing in this agent
      // directory sets a default and the level is valid on the new model too.
      thinkingLevel: "off",
      // `xhigh` and `max` are absent: Pi counts them as supported only when the
      // model's `thinkingLevelMap` names them, and this one has no map.
      availableThinkingLevels: ["off", "minimal", "low", "medium", "high"],
    })

    // Exactly one. Pi emits no session event for a model change and may emit a
    // thinking-level change from inside the same call, so this is either
    // silence or a duplicate if the two are not reconciled.
    expect(open.view.payloads("model_changed", since)).toEqual([{ selection }])

    // A snapshot is the authority the renderer rebuilds from, so a selection
    // that lives only in the command result is a selection that vanishes on the
    // next reconnect.
    const { snapshot } = await runtime.services.open_session({ sessionId: open.sessionId })
    expect(snapshot.model).toEqual(selection)

    // The switch appended a `model_change` entry to the session file. If that
    // append were not re-recorded, the guard would read the moved file as a
    // foreign write and refuse this prompt as `session_busy` — our own write
    // locking us out of our own session.
    const next = open.view.mark()
    server.script({ text: ["on the second model"] })
    await runtime.services.prompt({ sessionId: open.sessionId, text: "and now", attachments: [] })
    await open.view.waitFor("block_delta", { since: next, where: (p) => p.textDelta === "on the second model" })

    // And it reached the wire, which is the only proof that the selection drives
    // the run rather than only the UI.
    expect(server.requests.at(-1)?.model).toBe(FIXTURE_REASONING_MODEL)
  }, 60_000)

  test("a clamped level reports where the session actually ended up", async () => {
    const open = await openSessionIn({ trusted: true })
    await runtime.services.set_model({
      sessionId: open.sessionId,
      providerId: FIXTURE_PROVIDER,
      modelId: FIXTURE_REASONING_MODEL,
    })

    const since = open.view.mark()
    const { selection } = await runtime.services.set_thinking_level({ sessionId: open.sessionId, level: "max" })
    // Asked for `max`, running at `high`. Reporting the request back would put a
    // level in the UI that nothing is thinking at.
    expect(selection.thinkingLevel).toBe("high")
    expect(open.view.payloads("model_changed", since)).toEqual([{ selection }])
  }, 60_000)

  test("a model that cannot think reports off, and says nothing changed", async () => {
    const open = await openSessionIn({ trusted: true })
    const since = open.view.mark()

    // `fixture-1` has `reasoning: false`, so Pi's supported set is `off` alone
    // and every request collapses onto it.
    const { selection } = await runtime.services.set_thinking_level({ sessionId: open.sessionId, level: "high" })
    expect(selection.thinkingLevel).toBe("off")
    expect(selection.availableThinkingLevels).toEqual(["off"])

    // No event, because nothing moved. An emit here would redraw a control the
    // user just failed to change, which reads as the change having worked.
    expect(open.view.payloads("model_changed", since)).toEqual([])
  }, 60_000)

  test("an unknown model is refused by name rather than by exception", async () => {
    const open = await openSessionIn({ trusted: true })

    await expect(
      runtime.services.set_model({
        sessionId: open.sessionId,
        providerId: FIXTURE_PROVIDER,
        modelId: "no-such-model",
      }),
    ).rejects.toMatchObject({ code: "model_not_found", detail: `${FIXTURE_PROVIDER}/no-such-model` })

    // The same id under a provider that does not offer it is equally unknown.
    // This is why the command takes both: resolving by id alone would have found
    // the fixture provider's model and switched to a different endpoint and a
    // different bill than the one asked for.
    await expect(
      runtime.services.set_model({
        sessionId: open.sessionId,
        providerId: UNAUTHED_PROVIDER,
        modelId: FIXTURE_MODEL,
      }),
    ).rejects.toMatchObject({ code: "model_not_found" })
  }, 60_000)

  test("a switch is refused while another writer holds the file", async () => {
    // Model and thinking-level changes append to the session file, so they are
    // mutations and belong behind the same guard as a prompt. Without it a
    // switch would fork the tree exactly the way `durability.test.ts` measured
    // — quietly, and onto a leaf the other writer has already moved past.
    const open = await openSessionIn({ trusted: true })
    const since = open.view.mark()
    server.script({ text: ["mine for now"] })
    await runtime.services.prompt({ sessionId: open.sessionId, text: "hold this", attachments: [] })
    await open.view.settled(since)

    const { sessions } = await runtime.services.list_sessions({ workspaceId: open.workspaceId })
    appendForeignEntry(sessions.find((session) => session.id === open.sessionId)!.path)

    await expect(
      runtime.services.set_model({
        sessionId: open.sessionId,
        providerId: FIXTURE_PROVIDER,
        modelId: FIXTURE_REASONING_MODEL,
      }),
    ).rejects.toMatchObject({ code: "session_busy" })

    await expect(
      runtime.services.set_thinking_level({ sessionId: open.sessionId, level: "high" }),
    ).rejects.toMatchObject({ code: "session_busy" })

    await runtime.services.close_session({ sessionId: open.sessionId })
  }, 60_000)

  test("a provider with no credential is refused, and the session stays on the model it had", async () => {
    const open = await openSessionIn({ trusted: true })

    await expect(
      runtime.services.set_model({
        sessionId: open.sessionId,
        providerId: UNAUTHED_PROVIDER,
        modelId: UNAUTHED_MODEL,
      }),
      // Pi throws a plain `Error` carrying the provider and model in its
      // message. Surfacing that as `internal_error` would give the renderer a
      // diagnostics link where it has a "no key for this provider" card.
    ).rejects.toMatchObject({ code: "provider_unauthenticated", detail: UNAUTHED_PROVIDER })

    // A refused switch is not a half-applied one.
    const { snapshot } = await runtime.services.open_session({ sessionId: open.sessionId })
    expect(snapshot.model.modelId).toBe(FIXTURE_MODEL)
    expect(snapshot.model.providerId).toBe(FIXTURE_PROVIDER)
  }, 60_000)

  test("a key set through the contract reaches the session that streams, not only the host that holds it", async () => {
    // The regression this guards was invisible from the host's own runtime.
    // `createAgentSessionServices` builds its own `ModelRuntime` when it is not
    // handed one, and `ModelRuntime.create` is not a singleton — so a key set
    // through `set_api_key` landed in the host runtime's credential overlay
    // while every session streamed through a different runtime that had never
    // seen it. Every status agreed it had worked — `auth_changed` reported
    // authenticated and `get_auth_status` agreed — because both read the host's
    // runtime, which really did hold the key.
    //
    // Removing `modelRuntime` from the factory call in `runtime.ts` is how to
    // watch this fail, and where it fails is worth knowing: `AgentSession
    // .setModel` re-checks auth against the session's own runtime, so it throws
    // `No API key for <provider>/<model>` and Bake Pi maps it to
    // `provider_unauthenticated` — the same refusal as the test directly above,
    // for a provider that now has a key. The prompt is asserted anyway, because
    // a future Pi that drops that check would move the failure to the turn
    // rather than remove it.
    //
    // It runs on the same provider as the refusal above, which is what makes the
    // pair meaningful: the only thing that changed between them is the key.
    const open = await openSessionIn({ trusted: true })
    const marker = recorder.envelopes.length

    await runtime.services.set_api_key({ providerId: UNAUTHED_PROVIDER, apiKey: "reaches-the-session" })
    await runtime.services.set_model({
      sessionId: open.sessionId,
      providerId: UNAUTHED_PROVIDER,
      modelId: UNAUTHED_MODEL,
    })

    const since = open.view.mark()
    server.script({ text: ["streamed on the key the host holds"] })
    await runtime.services.prompt({
      sessionId: open.sessionId,
      text: "stream on the unauthenticated provider",
      attachments: [],
    })
    await open.view.settled(since)

    const deltas = open.view.payloads("block_delta", since).map((payload) => payload.textDelta)
    expect(deltas.join("")).toBe("streamed on the key the host holds")

    // Same rule as the other credential path: the key is never echoed back.
    expect(JSON.stringify(recorder.envelopes.slice(marker))).not.toContain("reaches-the-session")

    // Put the provider back the way the rest of the file expects to find it.
    // The runtime is shared across every describe here, so a credential left
    // behind would silently authenticate a provider another test needs bare.
    await runtime.services.logout({ providerId: UNAUTHED_PROVIDER })
    await runtime.services.close_session({ sessionId: open.sessionId })
  }, 60_000)
})

describe("a tool call, gated", () => {
  test("an approved write really runs, and its result reaches the model", async () => {
    const open = await openSessionIn({ trusted: false })
    const since = open.view.mark()
    const target = join(open.root, "approved.txt")
    const requestsBefore = server.requests.length

    server.script(
      { toolCalls: [{ id: "call-1", name: "write", args: { path: target, content: "written by the agent" } }] },
      { text: ["done"] },
    )
    await runtime.services.prompt({ sessionId: open.sessionId, text: "write a file", attachments: [] })

    const requested = await open.view.waitFor("approval_requested", { since })
    // Rule 1: an untrusted workspace asks before every tool, whatever it targets.
    expect(requested.request.reason).toBe("workspace_untrusted")
    expect(requested.request.call.name).toBe("write")
    expect(requested.request.call.targets[0]).toMatchObject({ kind: "write", insideWorkspace: true })
    // Nothing has run while the card is open. This is the assertion the gate
    // exists for, and it holds only if Pi's hook genuinely blocks.
    expect(existsSync(target)).toBe(false)

    // Reload/resync while Pi is parked. The card must come back from the
    // authoritative snapshot rather than depending on the renderer having seen
    // the original event.
    const beforeSnapshot = open.view.mark()
    await runtime.services.resync_session({ sessionId: open.sessionId })
    const pendingSnapshot = await open.view.waitFor("session_snapshot", { since: beforeSnapshot })
    expect(pendingSnapshot.snapshot.status).toBe("awaiting_approval")
    expect(pendingSnapshot.snapshot.approvals).toEqual([requested.request])

    expect(
      await runtime.services.respond_tool_approval({ requestId: requested.request.id, decision: "allow_once" }),
    ).toEqual({ accepted: true })

    await open.view.waitFor("tool_call_finished", { since, where: (p) => p.result.toolCallId === "call-1" })
    expect(readFileSync(target, "utf8")).toBe("written by the agent")

    await open.view.settled(since)

    // The follow-up request is the proof that the tool result went back to the
    // model rather than only to the renderer.
    const followUp = server.requests[requestsBefore + 1]!
    expect(JSON.stringify(followUp.messages)).toContain("approved.txt")
    expect(followUp.toolNames).toContain("write")
  }, 40_000)

  test("a denied write does not happen, and the denial is what Pi is told", async () => {
    const open = await openSessionIn({ trusted: false })
    const since = open.view.mark()
    const target = join(open.root, "denied.txt")

    server.script(
      { toolCalls: [{ id: "call-2", name: "write", args: { path: target, content: "should never exist" } }] },
      { text: ["understood"] },
    )
    await runtime.services.prompt({ sessionId: open.sessionId, text: "write a file", attachments: [] })

    const requested = await open.view.waitFor("approval_requested", { since })
    await runtime.services.respond_tool_approval({ requestId: requested.request.id, decision: "deny" })

    const finished = await open.view.waitFor("tool_call_finished", {
      since,
      where: (p) => p.result.toolCallId === "call-2",
    })
    expect(existsSync(target)).toBe(false)
    // The blocked hook is still an error to Pi, but Bake retains why it did not
    // run so the timeline does not turn a user's denial into a generic failure.
    expect(finished.result.status).toBe("denied")
    expect(finished.result.output).toContain("Bake Pi denied this tool")

    await open.view.settled(since)
    const { snapshot } = await runtime.services.open_session({ sessionId: open.sessionId })
    const persisted = snapshot.messages.flatMap((message) =>
      message.blocks.filter((block) => block.kind === "tool_call" && block.call.id === "call-2"),
    )[0]
    expect(persisted?.kind === "tool_call" ? persisted.call.status : undefined).toBe("denied")

    const resolved = open.view
      .payloads("approval_resolved", since)
      .find((payload) => payload.requestId === requested.request.id)!
    expect(resolved).toMatchObject({ decision: "deny", resolvedBy: "user" })
  }, 40_000)

  test("a decision for a request that no longer exists is refused rather than applied", async () => {
    // What a click on a card whose session already closed looks like. It must
    // not throw, and it must not be read as an allow.
    expect(
      await runtime.services.respond_tool_approval({ requestId: "no-such-request", decision: "allow_once" }),
    ).toEqual({ accepted: false })
  })

})

describe("what a real turn reports", () => {
  test("usage, finished blocks and tool cards all name the message that produced them", async () => {
    const open = await openSessionIn({ trusted: true })
    const since = open.view.mark()
    const first = join(open.root, "one.txt")
    const second = join(open.root, "two.txt")

    server.script(
      {
        text: ["I will write ", "both files"],
        toolCalls: [
          { id: "call-a", name: "write", args: { path: first, content: "a" } },
          { id: "call-b", name: "write", args: { path: second, content: "b" } },
        ],
      },
      { text: ["both written"] },
    )

    await runtime.services.prompt({ sessionId: open.sessionId, text: "write two files", attachments: [] })
    await open.view.settled(since)
    expect(readFileSync(second, "utf8")).toBe("b")

    // The streamed text arrives twice: once as Pi closes the block, once as the
    // finished message re-states it. Both must name the same message, and the
    // content must be whole — that is what makes the second one a repair for a
    // dropped delta rather than a second version of the truth.
    const finished = open.view.payloads("block_finished", since).filter((payload) => payload.block.kind === "text")
    const streamed = finished[0]!
    const forThisMessage = finished.filter((payload) => payload.messageId === streamed.messageId)
    expect(forThisMessage).toHaveLength(2)
    for (const payload of forThisMessage) {
      expect(payload.block).toMatchObject({ index: 0, kind: "text", text: "I will write both files" })
    }

    // Pi appends the turn's tool results *after* the assistant message, so by
    // the time the second call starts the last message in history is the first
    // call's result. An adapter addressing by index names that instead — and
    // both ids are real, so nothing fails except the interface.
    const started = open.view.payloads("tool_call_started", since)
    expect(started.map((payload) => payload.call.id)).toEqual(["call-a", "call-b"])
    for (const payload of started) expect(payload.messageId).toBe(streamed.messageId)

    const settled = open.view.payloads("turn_settled", since)[0]!
    expect(settled.messageId).toBe(streamed.messageId)
    expect(settled.status).toBe("complete")

    // Usage as the provider reported it, through Pi's own accounting. The
    // fixture's usage chunk is the shape `include_usage` produces upstream, so
    // this is Pi's parsing rather than ours.
    const usage = open.view.payloads("usage_changed", since).at(-1)!.usage
    expect(usage.total.inputTokens).toBeGreaterThan(0)
    expect(usage.total.outputTokens).toBeGreaterThan(0)
    expect(usage.turnCount).toBeGreaterThan(0)

    const { snapshot } = await runtime.services.open_session({ sessionId: open.sessionId })
    expect(snapshot.usage.total.outputTokens).toBe(usage.total.outputTokens)
    // The context meter needs a window as well as a count, and the fixture
    // model declares one.
    expect(snapshot.usage.context?.maxTokens).toBe(128_000)

    // History reports what each call did, read from the result that came back
    // rather than assumed. Both of these really ran.
    const calls = snapshot.messages.flatMap((message) =>
      message.blocks.filter((block) => block.kind === "tool_call"),
    )
    expect(calls.map((block) => block.call.status)).toEqual(["succeeded", "succeeded"])
  }, 40_000)
})

/**
 * What a real turn costs, read back through the command a developer would use.
 *
 * The store itself is unit-tested against an injected clock; none of that can
 * see whether the store is wired to the events it claims to measure. These tests
 * drive a turn through real Pi and then ask `get_timings` what it saw, which is
 * the only way to catch the failures that matter here — a first delta noted on
 * the wrong event, a tool span opened and never closed, a turn whose settle
 * arrives on a session nobody is timing.
 *
 * Most assertions are a *delta* between two reports rather than an absolute, for
 * a reason worth stating: one runtime is shared by this whole file, so the
 * host-wide figures carry every turn every other test took. What those tests can
 * assert exactly is what one turn added.
 *
 * The per-session figures are the exception, and they are the reason the
 * exception is worth having. A session opened inside a test has taken no turns
 * before it, so its own entry in the report is exact without any subtraction —
 * which is the whole argument for the session dimension, arriving here as a
 * property of the tests themselves.
 *
 * Commands are issued through `send` here and by calling `runtime.services`
 * everywhere else in the file. That is the change the command span moving out
 * of the handler map and onto the whole leg forced: a `command.*` span exists
 * because a message arrived, not because a handler ran, so a test that wants to
 * see one has to send a message. The sessions these tests open still open
 * through the services map, which is why `openSessionIn` never appears in the
 * deltas below.
 */
describe("what a turn cost", () => {
  /** Per-name completion counts, which is the part of a report that is exact. */
  const counts = (report: TimingsReport): Map<string, number> =>
    new Map(report.aggregates.map((aggregate) => [aggregate.name, aggregate.count]))

  /** What happened between two reports, with the names that did not move left out. */
  const recordedBetween = (before: TimingsReport, after: TimingsReport): Record<string, number> => {
    const previous = counts(before)
    const added: Record<string, number> = {}
    for (const [name, count] of counts(after)) {
      const delta = count - (previous.get(name) ?? 0)
      if (delta !== 0) added[name] = delta
    }
    return added
  }

  test("a settled turn decomposes into two legs and a total, and the tools it ran", async () => {
    const open = await openSessionIn({ trusted: true })
    const target = join(open.root, "timed.txt")
    const before = await send("get_timings", {})
    const since = open.view.mark()

    server.script(
      {
        text: ["writing ", "it now"],
        toolCalls: [{ id: "timed-call", name: "write", args: { path: target, content: "timed" } }],
      },
      { text: ["done"] },
    )
    await send("prompt", { sessionId: open.sessionId, text: "write a file", attachments: [] })
    await open.view.settled(since)

    const after = await send("get_timings", {})

    // Exactly this, and nothing else. `command.get_timings` is here because the
    // `before` call closed its own span after taking its snapshot, so the second
    // report sees the first one; the second report cannot see itself, which is
    // the same fact from the other side.
    expect(recordedBetween(before, after)).toEqual({
      "turn.accepted_to_first_delta": 1,
      "turn.first_delta_to_settled": 1,
      "turn.accepted_to_settled": 1,
      "tool.write": 1,
      "command.prompt": 1,
      "command.get_timings": 1,
    })

    // Nothing was opened and lost along the way. An abandoned span is how a
    // begin without an end shows up, and it is the failure mode this wiring is
    // most likely to have: a tool that ends on an event nobody subscribed to.
    expect(after.cost.spansAbandoned).toBe(before.cost.spansAbandoned)

    // The legs are recorded before the total and at the same instant, so they
    // are the three entries ending at the last total in the ring, and they add
    // up. Not exactly: each of the three is rounded to a microsecond on its own
    // way out of the store, so the sum can miss by two of them and no more.
    // That bound is the assertion, rather than a loose "close enough" — the
    // mutation this is here to catch is a leg measured from the wrong instant,
    // which misses by milliseconds.
    const totalAt = after.recent.findLastIndex((span) => span.name === "turn.accepted_to_settled")
    const legs = after.recent.slice(totalAt - 2, totalAt + 1)
    expect(legs.map((span) => span.name)).toEqual([
      "turn.accepted_to_first_delta",
      "turn.first_delta_to_settled",
      "turn.accepted_to_settled",
    ])
    expect(Math.abs(legs[0]!.ms + legs[1]!.ms - legs[2]!.ms)).toBeLessThanOrEqual(0.002)
    // Both legs are real time rather than a zero standing in for an instant
    // nobody recorded: the model was asked something over a socket, and it ran a
    // tool before it finished.
    expect(legs[0]!.ms).toBeGreaterThan(0)
    expect(legs[1]!.ms).toBeGreaterThan(0)

    // The tool span sits inside the turn it belongs to rather than beside it.
    const toolSpan = after.recent.slice(0, totalAt).findLast((span) => span.name === "tool.write")
    expect(toolSpan).toBeDefined()
    expect(toolSpan!.ms).toBeLessThan(legs[2]!.ms)
  }, 40_000)

  test("two hundred deltas cost the instrument one clock reading", async () => {
    const open = await openSessionIn({ trusted: true })
    const before = await send("get_timings", {})
    const since = open.view.mark()

    server.script({ text: Array.from({ length: 200 }, (_, index) => `d${String(index)} `) })
    await send("prompt", { sessionId: open.sessionId, text: "say a lot", attachments: [] })
    await open.view.settled(since)

    const after = await send("get_timings", {})
    expect(open.view.payloads("block_delta", since).length).toBe(200)

    /*
     * Seven readings for the whole turn, and each one is accounted for: closing
     * the `before` report's own command span, opening and closing `prompt`,
     * beginning the turn, the first delta, settling the turn, and opening this
     * report's command span. The other 199 deltas cost a property read and a
     * comparison apiece and are not in this number.
     *
     * This is the assertion Milestone 2.1 asks for — "the per-event cost of the
     * instrument is measured and no span is allocated per block delta" — and it
     * is written as an exact figure rather than a ceiling because a ceiling
     * would still pass if the delta path started reading the clock and the turn
     * happened to be short.
     */
    expect(after.cost.clockReads - before.cost.clockReads).toBe(7)
    // Five spans: three turn legs, `prompt`, and the `before` report's command.
    expect(after.cost.spansRecorded - before.cost.spansRecorded).toBe(5)
    // The ring is allocated once and never grows with what it has recorded.
    expect(after.cost.ringBytes).toBe(before.cost.ringBytes)
  }, 40_000)

  test("the report validates against the contract and names nothing from inside the host", async () => {
    const open = await openSessionIn({ trusted: true })
    const secret = join(open.root, "do-not-report-me.txt")
    const since = open.view.mark()

    server.script(
      { toolCalls: [{ id: "secret-call", name: "write", args: { path: secret, content: "x" } }] },
      { text: ["done"] },
    )
    await send("prompt", { sessionId: open.sessionId, text: "write a file", attachments: [] })
    await open.view.settled(since)

    const report = await send("get_timings", {})

    // The host's own output against the contract's own checker. A report the
    // renderer would drop on arrival is an instrument that silently stopped
    // working, and nothing else in this file would notice.
    expect(() => parseCommandResult("get_timings", report)).not.toThrow()

    // SEC-006, asserted against the bytes rather than against the shape. The
    // store is given a session id, a tool call id and a workspace path on every
    // one of these spans, and the line between them is the point: the renderer
    // supplied or received the session id and it rides on every event envelope
    // already, while Pi's tool call id and the workspace path are things the
    // renderer has never seen.
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain("do-not-report-me")
    expect(serialized).not.toContain("secret-call")
    expect(serialized).not.toContain(basename(open.root))

    // The session id is reported, and *only* in the two fields the schema
    // allows. Counting occurrences against the fields that account for them is
    // what makes this a claim about the whole payload rather than about the two
    // places anyone thought to look: a session id that also leaked into a
    // diagnostic string or a third field would push the count above the sum.
    const taggedSpans = report.recent.filter((span) => span.sessionId === open.sessionId)
    const taggedSessions = report.sessions.filter((entry) => entry.sessionId === open.sessionId)
    expect(taggedSessions.length).toBe(1)
    expect(taggedSpans.length).toBeGreaterThan(0)
    expect(serialized.split(open.sessionId).length - 1).toBe(taggedSpans.length + taggedSessions.length)

    // And only on turn legs. A tool span carries no session, because the store
    // keys tool calls on Pi's own id and has no way to relate one back.
    expect(taggedSpans.every((span) => span.name.startsWith("turn."))).toBe(true)
    expect(report.recent.some((span) => span.name === "tool.write" && span.sessionId !== undefined)).toBe(false)

    // A tool ran, so the absence above is a real silence rather than an empty
    // report. `tool.write` is the whole of what the report says about it.
    expect(report.aggregates.map((aggregate) => aggregate.name)).toContain("tool.write")

    // The command being answered is open while it answers. Reporting it as
    // closed would mean a span that ended before the work it measures.
    expect(report.open.find((entry) => entry.name === "command.get_timings")).toEqual({
      name: "command.get_timings",
      count: 1,
    })
  }, 40_000)

  /**
   * The exit criterion, driven through real Pi rather than an injected clock.
   *
   * `scripts/budgets.ts` measured a turn getting roughly three times more
   * expensive over forty turns of history, and the host admits thirty-two
   * sessions, so a host-wide turn mean averages populations that are known to
   * differ. This asserts the two things that make the per-session figures worth
   * having: a turn lands under the session that ran it, and two sessions running
   * against the same host do not share a number.
   *
   * The counts are deliberately unequal — two turns against one — because a
   * store that computed one host-wide figure and copied it into every session
   * would satisfy any assertion where the sessions look alike.
   */
  test("attributes each turn to the session that ran it, and keeps two sessions apart", async () => {
    const busy = await openSessionIn({ trusted: true })
    const quiet = await openSessionIn({ trusted: true })

    for (const reply of ["first", "second"]) {
      const since = busy.view.mark()
      server.script({ text: [reply] })
      await send("prompt", { sessionId: busy.sessionId, text: "again", attachments: [] })
      await busy.view.settled(since)
    }

    const quietSince = quiet.view.mark()
    server.script({ text: ["only once"] })
    await send("prompt", { sessionId: quiet.sessionId, text: "once", attachments: [] })
    await quiet.view.settled(quietSince)

    const report = await send("get_timings", {})
    const totalFor = (sessionId: string): { count: number; totalMs: number } => {
      const entry = report.sessions.find((session) => session.sessionId === sessionId)
      const turn = entry?.turns.find((leg) => leg.name === "turn.accepted_to_settled")
      if (turn === undefined) throw new Error(`no settled turn recorded for ${sessionId}`)
      return { count: turn.count, totalMs: turn.totalMs }
    }

    // Absolute, not a delta: both sessions were created inside this test, so
    // neither had a turn behind it.
    expect(totalFor(busy.sessionId).count).toBe(2)
    expect(totalFor(quiet.sessionId).count).toBe(1)

    // Each session's own total is the sum of its own spans in the ring, which
    // ties the aggregate to the individual measurements rather than letting the
    // two agree by construction. Three legs are rounded to a microsecond apiece
    // on the way out, so the sum can miss by that much and no more.
    const settledFor = (sessionId: string): number[] =>
      report.recent
        .filter((span) => span.sessionId === sessionId && span.name === "turn.accepted_to_settled")
        .map((span) => span.ms)
    const busySpans = settledFor(busy.sessionId)
    const quietSpans = settledFor(quiet.sessionId)
    expect(busySpans.length).toBe(2)
    expect(quietSpans.length).toBe(1)
    expect(Math.abs(busySpans[0]! + busySpans[1]! - totalFor(busy.sessionId).totalMs)).toBeLessThanOrEqual(0.002)
    expect(Math.abs(quietSpans[0]! - totalFor(quiet.sessionId).totalMs)).toBeLessThanOrEqual(0.002)

    // Neither session's figures contain the other's turns, which is the failure
    // a host-wide number wearing a session id would produce.
    expect(totalFor(busy.sessionId).totalMs).not.toBeCloseTo(totalFor(quiet.sessionId).totalMs, 3)
  }, 60_000)

  /**
   * The defect the previous shape of the instrument documented and left.
   *
   * A session closed mid-turn has a turn span that no `agent_settled` will ever
   * close, because `close_session` disposes the Pi session and the subscription
   * that would have delivered one goes with it. Left alone the span waits for
   * the open-span cap and is eventually attributed to whatever was running much
   * later.
   *
   * What it must *not* do is record accept-to-close as a turn duration. The turn
   * did not take that long and it did not finish at all, so the assertion is
   * that no turn was recorded for this session — only an abandonment.
   */
  test("a session closed mid-turn abandons its turn rather than timing the close", async () => {
    const open = await openSessionIn({ trusted: true })
    const before = await send("get_timings", {})
    const since = open.view.mark()

    // The fixture streams one chunk and holds the socket, so the turn is
    // genuinely still running when the session goes away.
    server.script({ text: ["thinking"], stall: true })
    await send("prompt", { sessionId: open.sessionId, text: "stall please", attachments: [] })
    await open.view.waitFor("block_delta", { since, where: (p) => p.textDelta === "thinking" })

    await send("close_session", { sessionId: open.sessionId })
    const after = await send("get_timings", {})

    const entry = after.sessions.find((session) => session.sessionId === open.sessionId)
    expect(entry).toBeDefined()
    expect(entry!.turns).toEqual([
      // No measurement, and `meanMs` null rather than zero: zero would read as
      // an instant turn, which is exactly the fiction being avoided.
      expect.objectContaining({ name: "turn.accepted_to_settled", count: 0, abandoned: 1, meanMs: null }),
    ])

    // One abandonment, and not one turn of any leg — including the first-delta
    // leg, whose instant *was* recorded before the close.
    expect(after.cost.spansAbandoned - before.cost.spansAbandoned).toBe(1)
    expect(recordedBetween(before, after)).toEqual({
      "command.prompt": 1,
      "command.close_session": 1,
      "command.get_timings": 1,
    })
  }, 60_000)

  test("a command that fails is still measured", async () => {
    // A command that fails slowly is a command worth seeing, and it is the one
    // a handler-by-handler instrument would miss: the recording has to be in a
    // `finally`, not after the call. A refusal is also the cheapest handler
    // there is, so this doubles as the check that a sub-millisecond span is
    // still a span rather than a rounding artefact.
    const before = await send("get_timings", {})
    await expect(send("resync_session", { sessionId: "no-such-session" })).rejects.toThrow()
    const after = await send("get_timings", {})

    expect(recordedBetween(before, after)).toEqual({
      "command.resync_session": 1,
      "command.get_timings": 1,
    })
  }, 40_000)

  test("a command whose envelope never validated is measured, under `unknown`", async () => {
    // The leg an instrument wrapped around the handler map cannot see at all:
    // no handler runs, so nothing is recorded, and the time the host spent
    // refusing the message lands in main's round trip as a residual with no
    // name on it. That time is real — the size guard stringifies the whole
    // envelope before anything else looks at it, which is the expensive half of
    // refusing an eight-megabyte payload.
    const before = await send("get_timings", {})
    const refused = await sendRaw({ kind: "command", id: "req-bogus", name: "list_all_secrets", params: {} })
    const after = await send("get_timings", {})

    expect(refused).toMatchObject({ ok: false, error: { code: "unknown_command" } })
    expect(recordedBetween(before, after)).toEqual({ unknown: 1, "command.get_timings": 1 })

    // Measured, and anonymous, and those two are the same decision. The `name`
    // on the envelope is an arbitrary string from outside the host; naming the
    // span after it would carry attacker-chosen text to the renderer through
    // the one command whose result is a list of names, which is `SEC-006`.
    expect(JSON.stringify(after)).not.toContain("list_all_secrets")

    // `unknown` is in the contract's own vocabulary, so a report containing one
    // is a report the renderer still accepts rather than one it drops whole.
    expect(() => parseCommandResult("get_timings", after)).not.toThrow()
  }, 40_000)

  test("a tool Pi does not ship is timed under one bucket rather than by name", async () => {
    // Pi's tool set is open: an MCP server or a project extension can register a
    // name this repository has never seen, and a tool name is influenced from
    // outside in the same way a file path is. Pi refuses to call a tool it has
    // no definition for, so the call fails — and the point is that it is still
    // *timed*, under `tool.other`, with the name it was given nowhere in the
    // report.
    const open = await openSessionIn({ trusted: true })
    const before = await send("get_timings", {})
    const since = open.view.mark()

    server.script(
      { toolCalls: [{ id: "mcp-call", name: "mcp__github__create_pull_request", args: { title: "hi" } }] },
      { text: ["that did not work"] },
    )
    await send("prompt", { sessionId: open.sessionId, text: "call a strange tool", attachments: [] })
    await open.view.settled(since)

    const after = await send("get_timings", {})
    expect(recordedBetween(before, after)["tool.other"]).toBe(1)
    expect(JSON.stringify(after)).not.toContain("mcp__github")
  }, 40_000)
})

describe("aborting a turn in flight", () => {
  test("the session returns to idle and accepts the next prompt", async () => {
    const open = await openSessionIn({ trusted: true })
    const since = open.view.mark()
    // The fixture streams one chunk and then holds the socket open, so the abort
    // interrupts a turn that is genuinely still running.
    server.script({ text: ["thinking"], stall: true })

    await runtime.services.prompt({ sessionId: open.sessionId, text: "stall please", attachments: [] })
    await open.view.waitFor("block_delta", { since, where: (p) => p.textDelta === "thinking" })

    await runtime.services.steer({ sessionId: open.sessionId, text: "recover this guidance" })
    await runtime.services.follow_up({ sessionId: open.sessionId, text: "recover this follow-up" })

    expect(await runtime.services.abort({ sessionId: open.sessionId })).toEqual({
      aborted: true,
      recovered: [
        expect.objectContaining({ text: "recover this guidance", mode: "steer" }),
        expect.objectContaining({ text: "recover this follow-up", mode: "follow_up" }),
      ],
    })
    expect(await runtime.services.get_queue({ sessionId: open.sessionId })).toEqual({ queue: [] })
    await open.view.waitFor("session_status_changed", { since, where: (p) => p.status === "idle" })

    // An abort ends a turn, not a session.
    const resumed = open.view.mark()
    server.script({ text: ["back"] })
    await runtime.services.prompt({ sessionId: open.sessionId, text: "again", attachments: [] })
    await open.view.waitFor("block_delta", { since: resumed, where: (p) => p.textDelta === "back" })
  }, 40_000)
})

describe("manual compaction", () => {
  test("the command enters Pi's compaction lifecycle even when the session is too small", async () => {
    const open = await openSessionIn({ trusted: true })
    const since = open.view.mark()

    expect(await runtime.services.compact_session({ sessionId: open.sessionId })).toEqual({ started: true })
    await open.view.waitFor("compaction_started", { since })
    await open.view.waitFor("compaction_finished", { since })
    await open.view.waitFor("session_status_changed", { since, where: (payload) => payload.status === "idle" })
  }, 40_000)
})

describe("closing and reopening", () => {
  test("a closed session is found on disk and adopted with its history", async () => {
    const open = await openSessionIn({ trusted: true })
    const since = open.view.mark()
    server.script({ text: ["remember this"] })
    await runtime.services.prompt({ sessionId: open.sessionId, text: "remember this for me", attachments: [] })
    await open.view.settled(since)

    await runtime.services.close_session({ sessionId: open.sessionId })

    // Listed from disk now, not from the map of live hosts.
    const { sessions } = await runtime.services.list_sessions({ workspaceId: open.workspaceId })
    const listed = sessions.find((session) => session.id === open.sessionId)
    expect(listed).toBeDefined()
    expect(listed!.messageCount).toBeGreaterThan(0)

    const { snapshot } = await runtime.services.open_session({ sessionId: open.sessionId })
    expect(snapshot.summary.id).toBe(open.sessionId)
    // The history came back, rather than an empty session wearing the same id.
    expect(JSON.stringify(snapshot.messages)).toContain("remember this")

    // And it still works: a reopened session prompts like any other.
    const reopened = open.view.mark()
    server.script({ text: ["still here"] })
    await runtime.services.prompt({ sessionId: open.sessionId, text: "are you there", attachments: [] })
    await open.view.waitFor("block_delta", { since: reopened, where: (p) => p.textDelta === "still here" })
  }, 60_000)

  test("one archive scan supplies paths for later adoptions, and a stale path rescans", async () => {
    const root = mkdtempSync(join(tmpdir(), "bakepi-catalog-"))
    temporary.push(root)
    const { workspace } = await runtime.services.open_workspace({ root, runtime: { kind: "windows" } })
    await runtime.services.set_project_trust({ id: workspace.id, trust: "trusted" })
    const sessionIds: string[] = []

    for (const reply of ["first persisted", "second persisted", "third persisted"]) {
      const { snapshot } = await runtime.services.create_session({ workspaceId: workspace.id })
      const sessionId = snapshot.summary.id
      const view = recorder.session(sessionId)
      const since = view.mark()
      server.script({ text: [reply] })
      await runtime.services.prompt({ sessionId, text: `store ${reply}`, attachments: [] })
      await view.settled(since)
      await runtime.services.close_session({ sessionId })
      sessionIds.push(sessionId)
    }

    const { sessions: persisted } = await runtime.services.list_sessions({ workspaceId: workspace.id })
    const thirdPath = persisted.find((session) => session.id === sessionIds[2])!.path
    await runtime.services.close_workspace({ id: workspace.id })

    let scans = 0
    const restoring = await createPiRuntime({
      diagnostics: new Diagnostics(),
      emitter: new EventEmitter(),
      listSessions: async (cwd, sessionDir) => {
        scans += 1
        return await SessionManager.list(cwd, sessionDir)
      },
    })
    try {
      await restoring.services.open_workspace({ root, runtime: { kind: "windows" } })

      const first = await restoring.services.open_session({ sessionId: sessionIds[0]! })
      await restoring.services.close_session({ sessionId: first.snapshot.summary.id })
      const second = await restoring.services.open_session({ sessionId: sessionIds[1]! })
      await restoring.services.close_session({ sessionId: second.snapshot.summary.id })
      expect(scans).toBe(1)

      const movedThirdPath = join(dirname(thirdPath), `moved-${basename(thirdPath)}`)
      renameSync(thirdPath, movedThirdPath)
      const third = await restoring.services.open_session({ sessionId: sessionIds[2]! })
      await restoring.services.close_session({ sessionId: third.snapshot.summary.id })
      expect(scans).toBe(2)
    } finally {
      await restoring.services.shutdown({})
    }
  }, 60_000)
})

describe("two hosts, one session file", () => {
  /**
   * `INT-001` at the level it actually matters. `durability.test.ts` measured
   * what Pi does with two writers — nothing: no error, no corruption, and one
   * writer's turns silently stop being part of the session. `ownership.test.ts`
   * proved the lock primitive works. Neither can say whether a second Bake Pi
   * host is *actually* refused, because that answer lives in the order
   * `adoptSession` does its three steps, and that ordering has no unit.
   */
  test("a second host is refused while the first holds the session, and admitted after it lets go", async () => {
    const open = await openSessionIn({ trusted: true })
    const since = open.view.mark()
    server.script({ text: ["mine"] })
    await runtime.services.prompt({ sessionId: open.sessionId, text: "hold this session", attachments: [] })
    await open.view.settled(since)

    const { sessions } = await runtime.services.list_sessions({ workspaceId: open.workspaceId })
    const file = sessions.find((session) => session.id === open.sessionId)!.path
    // The lock is taken when the host is built, not when the file first has
    // bytes: Pi fixes the path at session creation and only defers the write.
    expect(existsSync(lockPathFor(file))).toBe(true)

    // A genuinely separate host over the same agent directory — the shape of a
    // second Bake Pi window, or of the same app relaunched after a crash.
    const second = await createPiRuntime({ diagnostics: new Diagnostics(), emitter: new EventEmitter() })
    await second.services.open_workspace({ root: open.root, runtime: { kind: "windows" } })

    await expect(second.services.open_session({ sessionId: open.sessionId })).rejects.toMatchObject({
      code: "session_busy",
    })

    // Releasing is the other half, and the half that fails silently when it is
    // wrong: a lock outliving its host makes the session unopenable until the
    // stale-holder check reclaims it, which is indistinguishable from data loss
    // to the person looking at the rail.
    await runtime.services.close_session({ sessionId: open.sessionId })
    expect(existsSync(lockPathFor(file))).toBe(false)

    const adopted = await second.services.open_session({ sessionId: open.sessionId })
    expect(adopted.snapshot.summary.id).toBe(open.sessionId)
    await second.services.shutdown({})
  }, 60_000)
})

describe("a host that died while a tool was running", () => {
  /**
   * `REC-003`, the half `recovery.ts` states it cannot reach.
   *
   * Main attributes a crash from commands alone, because it never reads the
   * event stream — so a crash during `rm -rf` and a crash during an idle moment
   * are the same observation from the supervisor. The fix is not to give main
   * more to read; it is for the host to write the fact down where it survives
   * the crash that produced it.
   *
   * Both tests turn on timing that has no unit. The marker is only worth
   * anything if it is on disk *before* the tool body runs and gone *after* the
   * turn settles, and both of those are instants inside a turn: a test that
   * awaited the tool and then looked would see an empty directory and pass while
   * proving nothing. Hence the synchronous probe.
   */
  const sessionFileOf = async (open: Open): Promise<string> => {
    const { sessions } = await runtime.services.list_sessions({ workspaceId: open.workspaceId })
    return sessions.find((session) => session.id === open.sessionId)!.path
  }

  test("the marker is on disk while the tool runs, and gone once the turn settles", async () => {
    const open = await openSessionIn({ trusted: true })
    const since = open.view.mark()
    const target = join(open.root, "marked.txt")
    const file = await sessionFileOf(open)

    // Read inside the event dispatch, before the tool body has run. Anything
    // later is a measurement of the wrong moment.
    let duringTool: string | undefined
    recorder.probes.push((envelope) => {
      if (envelope.name !== "tool_call_started") return
      duringTool = readFileSync(toolMarkerPathFor(file), "utf8")
    })

    server.script(
      { toolCalls: [{ id: "marker-1", name: "write", args: { path: target, content: "written" } }] },
      { text: ["done"] },
    )
    await runtime.services.prompt({ sessionId: open.sessionId, text: "write a file", attachments: [] })
    await open.view.settled(since)
    recorder.probes.length = 0

    // It named the call rather than merely existing. A marker that recorded
    // nothing would report "a tool was interrupted" and leave the user with no
    // idea which file to go and check.
    expect(duringTool).toBeDefined()
    const recorded = JSON.parse(duringTool!) as { pid: number; calls: { toolName: string; targets: string[] }[] }
    expect(recorded.pid).toBe(process.pid)
    // Tool targets use canonical paths, not Windows TEMP's possible 8.3 alias.
    expect(recorded.calls).toEqual([{ toolName: "write", targets: [realpathSync.native(target)] }].map((call) => expect.objectContaining(call)))

    // And a turn that ended normally leaves nothing behind. Without this half
    // every completed tool call would be reported as an interruption on the
    // next open, and a warning that always fires is a warning nobody reads.
    expect(existsSync(toolMarkerPathFor(file))).toBe(false)
    expect(readFileSync(target, "utf8")).toBe("written")
  }, 60_000)

  test("the interruption is reported when the session is opened again", async () => {
    const open = await openSessionIn({ trusted: true })
    const since = open.view.mark()
    const target = join(open.root, "interrupted.txt")
    const file = await sessionFileOf(open)

    let duringTool: string | undefined
    recorder.probes.push((envelope) => {
      if (envelope.name !== "tool_call_started") return
      duringTool = readFileSync(toolMarkerPathFor(file), "utf8")
    })

    server.script(
      { toolCalls: [{ id: "marker-2", name: "write", args: { path: target, content: "half of this" } }] },
      { text: ["done"] },
    )
    await runtime.services.prompt({ sessionId: open.sessionId, text: "write a file", attachments: [] })
    await open.view.settled(since)
    recorder.probes.length = 0

    await runtime.services.close_session({ sessionId: open.sessionId })

    // The crash, staged with the bytes the host itself wrote a moment ago rather
    // than with a marker composed by this test. A change to the marker format
    // that the reader stopped understanding would fail here, which a hand-built
    // fixture would not notice.
    writeFileSync(toolMarkerPathFor(file), duringTool!, "utf8")

    const marker = recorder.envelopes.length
    const { snapshot } = await runtime.services.open_session({ sessionId: open.sessionId })
    // Opened, not refused. The session is intact; it is the workspace that may
    // not be, and only the user can judge that.
    expect(snapshot.summary.id).toBe(open.sessionId)

    const reported = await recorder.waitForHostEvent(
      "recoverable_error",
      (payload) => payload.sessionId === open.sessionId && payload.error.code === "tool_interrupted",
      marker,
    )
    // Actionable rather than alarming: the report names the tool and the path.
    expect(reported.error.detail).toBe(`write: ${realpathSync.native(target)}`)
    expect(reported.error.retryable).toBe(false)

    // Reported once. The marker is consumed by the read, so the next open of a
    // session whose interruption was already dealt with is silent.
    expect(existsSync(toolMarkerPathFor(file))).toBe(false)
    await runtime.services.close_session({ sessionId: open.sessionId })
    const second = recorder.envelopes.length
    await runtime.services.open_session({ sessionId: open.sessionId })
    await Bun.sleep(50)
    expect(
      recorder.envelopes
        .slice(second)
        .some((envelope) => envelope.name === "recoverable_error"),
    ).toBe(false)
  }, 60_000)

  test("a refused adoption does not consume the marker of the host still running the tool", async () => {
    // Reading the marker is also removing it, so where that read sits relative
    // to the lock decides whether a second host merely fails to open a session
    // or destroys the evidence belonging to the host that legitimately has it.
    // Both orderings pass every other test in this file.
    const open = await openSessionIn({ trusted: true })
    const since = open.view.mark()
    server.script({ text: ["holding"] })
    await runtime.services.prompt({ sessionId: open.sessionId, text: "hold this session", attachments: [] })
    await open.view.settled(since)

    const file = await sessionFileOf(open)
    const staged = JSON.stringify({
      hostId: "the-host-that-owns-this",
      pid: process.pid,
      calls: [{ toolCallId: "live-1", toolName: "bash", startedAt: Date.now(), targets: [] }],
    })
    writeFileSync(toolMarkerPathFor(file), staged, "utf8")

    const second = await createPiRuntime({ diagnostics: new Diagnostics(), emitter: new EventEmitter() })
    try {
      await second.services.open_workspace({ root: open.root, runtime: { kind: "windows" } })
      await expect(second.services.open_session({ sessionId: open.sessionId })).rejects.toMatchObject({
        code: "session_busy",
      })
      expect(readFileSync(toolMarkerPathFor(file), "utf8")).toBe(staged)
    } finally {
      await second.services.shutdown({})
      // The owning host clears it on close, which is the other half of the same
      // claim: this marker belongs to the session, not to the failed adoption.
      await runtime.services.close_session({ sessionId: open.sessionId })
    }
    expect(existsSync(toolMarkerPathFor(file))).toBe(false)
  }, 60_000)
})

/**
 * What the Pi CLI appending one entry looks like from outside the process.
 *
 * Written with `fs` rather than through a second `SessionManager` so this file
 * keeps its one import boundary: the last valid entry is cloned with a fresh id
 * and chained onto itself, which is the shape Pi's own append produces and
 * enough to move both halves of the fingerprint.
 */
const appendForeignEntry = (file: string): void => {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean)
  const last = JSON.parse(lines.at(-1)!) as { id: string }
  const entry = { ...last, id: `${last.id}-foreign`, parentId: last.id }
  writeFileSync(file, `${[...lines, JSON.stringify(entry)].join("\n")}\n`, "utf8")
}

describe("a session file torn by a crash", () => {
  /**
   * `INT-002a`, composed. `integrity.test.ts` proves the probe reads a torn file
   * correctly, but the probe is only worth anything if it runs *before* Pi's
   * load — and after that load the evidence is gone, so a wrong order produces
   * a session that opens cleanly and reports nothing. That is the failure this
   * test exists to make impossible, and it can only be seen from out here.
   */
  test("the session opens, and the loss is reported rather than passed over in silence", async () => {
    const open = await openSessionIn({ trusted: true })
    const since = open.view.mark()
    server.script({ text: ["the first answer"] })
    await runtime.services.prompt({ sessionId: open.sessionId, text: "first question", attachments: [] })
    await open.view.settled(since)

    const { sessions } = await runtime.services.list_sessions({ workspaceId: open.workspaceId })
    const file = sessions.find((session) => session.id === open.sessionId)!.path
    await runtime.services.close_session({ sessionId: open.sessionId })

    // A crash mid-append: the last line never finished and never got its
    // newline. This is the byte pattern `durability.test.ts` measured Pi
    // producing, reproduced rather than imagined.
    const lines = readFileSync(file, "utf8").split(/\n/u).filter(Boolean)
    writeFileSync(file, [...lines, lines.at(-1)!.slice(0, 24)].join("\n"), "utf8")

    const marker = recorder.envelopes.length
    const { snapshot } = await runtime.services.open_session({ sessionId: open.sessionId })

    // Adopted, not refused: everything before the tear is intact, and
    // withholding it would help nobody.
    expect(snapshot.summary.id).toBe(open.sessionId)
    expect(JSON.stringify(snapshot.messages)).toContain("the first answer")

    const reported = await recorder.waitForHostEvent(
      "recoverable_error",
      (payload) => payload.sessionId === open.sessionId,
      marker,
    )
    expect(reported.error.code).toBe("session_file_repaired")
    expect(reported.error.retryable).toBe(false)
  }, 60_000)
})

describe("the capacity limits", () => {
  /**
   * The three admission limits, against real Pi.
   *
   * `budget.test.ts` decides the rules and `scripts/budgets.ts` measures the
   * numbers they run on, so what is left for this file is the part neither can
   * see: that the checks sit on the paths that actually spend the memory, at the
   * point where a refusal costs nothing. A cap applied after `hostFor` has built
   * a Pi runtime, or after `adoptSession` has taken the lock, refuses exactly as
   * correctly and leaves a session half-built or a file nobody can open — and
   * both of those pass a unit test of the rule.
   *
   * Its own runtime, because the limits it needs are two and two rather than
   * thirty-two and sixteen, and because a shared host cannot be pushed over a
   * memory ceiling without taking every other test in the file with it.
   */
  let limited: PiRuntime
  let watcher: Recorder
  let workspaceId: string
  let workspaceRoot: string
  /** What the limited host weighs, decided here rather than by the allocator. */
  let weight = 0

  beforeAll(async () => {
    const emitter = new EventEmitter()
    watcher = new Recorder()
    emitter.attach(watcher.port())
    limited = await createPiRuntime({
      diagnostics: new Diagnostics(),
      emitter,
      capacity: {
        maxOpenSessions: 2,
        maxQueuedPrompts: 2,
        memoryCeilingBytes: 1_000,
        residentBytes: () => weight,
      },
    })
    const root = mkdtempSync(join(tmpdir(), "bakepi-capacity-"))
    temporary.push(root)
    workspaceRoot = root
    const { workspace } = await limited.services.open_workspace({ root, runtime: { kind: "windows" } })
    await limited.services.set_project_trust({ id: workspace.id, trust: "trusted" })
    workspaceId = workspace.id
  }, 60_000)

  afterAll(async () => {
    await limited?.services.shutdown({})
  })

  const answerBlockingInputs = async (view: SessionView, since: number, count: number): Promise<string[]> => {
    const answered = new Set<string>()
    while (answered.size < count) {
      const { request } = await view.waitFor("extension_ui_requested", {
        since,
        where: (payload) => payload.request.title === "Blocking queued input" && !answered.has(payload.request.id),
      })
      answered.add(request.id)
      await limited.services.respond_confirm({ requestId: request.id, confirmed: true })
    }
    return [...answered]
  }

  test("the session past the cap is refused, and admitted once one closes", async () => {
    const first = await limited.services.create_session({ workspaceId })
    const second = await limited.services.create_session({ workspaceId })

    await expect(limited.services.create_session({ workspaceId })).rejects.toMatchObject({
      code: "session_limit_reached",
    })

    // Closing one and opening another is what shows the refusal left nothing
    // behind: a host that had built the third session and then rejected it would
    // still be holding its runtime, and would refuse this one too.
    await limited.services.close_session({ sessionId: second.snapshot.summary.id })
    const third = await limited.services.create_session({ workspaceId })
    expect(third.snapshot.summary.id).not.toBe(second.snapshot.summary.id)

    await limited.services.close_session({ sessionId: first.snapshot.summary.id })
    await limited.services.close_session({ sessionId: third.snapshot.summary.id })
  }, 60_000)

  test("concurrent session creation reserves the cap before Pi builds runtimes", async () => {
    const outcomes = await Promise.allSettled([
      limited.services.create_session({ workspaceId }),
      limited.services.create_session({ workspaceId }),
      limited.services.create_session({ workspaceId }),
    ])
    const opened = outcomes.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : [])
    const refused = outcomes.flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : [])

    for (const session of opened) {
      await limited.services.close_session({ sessionId: session.snapshot.summary.id })
    }

    expect(opened).toHaveLength(2)
    expect(refused).toHaveLength(1)
    expect(refused[0]).toMatchObject({ code: "session_limit_reached" })
  }, 60_000)

  test("a failed adoption returns its reserved slot", async () => {
    await expect(limited.services.open_session({ sessionId: "missing-session" })).rejects.toMatchObject({
      code: "session_not_found",
    })

    const outcomes = await Promise.allSettled([
      limited.services.create_session({ workspaceId }),
      limited.services.create_session({ workspaceId }),
    ])
    const opened = outcomes.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : [])
    for (const session of opened) {
      await limited.services.close_session({ sessionId: session.snapshot.summary.id })
    }

    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true)
  }, 60_000)

  test("a session already on disk is refused before its lock is taken", async () => {
    // Adoption is where a refusal in the wrong place does lasting damage.
    // `adoptSession` locks the file before Pi opens it, so a cap checked after
    // the lock would leave a session that no host can open until the
    // stale-holder check reclaims it — and to the person looking at the rail
    // that is indistinguishable from having lost it.
    const created = await limited.services.create_session({ workspaceId })
    const sessionId = created.snapshot.summary.id
    const view = watcher.session(sessionId)
    const since = view.mark()
    server.script({ text: ["persisted"] })
    await limited.services.prompt({ sessionId, text: "write me to disk", attachments: [] })
    await view.settled(since)

    const { sessions } = await limited.services.list_sessions({ workspaceId })
    const file = sessions.find((session) => session.id === sessionId)!.path
    await limited.services.close_session({ sessionId })
    expect(existsSync(lockPathFor(file))).toBe(false)

    const blockers = [
      await limited.services.create_session({ workspaceId }),
      await limited.services.create_session({ workspaceId }),
    ]
    await expect(limited.services.open_session({ sessionId })).rejects.toMatchObject({
      code: "session_limit_reached",
    })
    // The file is exactly as the refusal found it, which is the whole point of
    // checking before the lock rather than after.
    expect(existsSync(lockPathFor(file))).toBe(false)

    for (const blocker of blockers) await limited.services.close_session({ sessionId: blocker.snapshot.summary.id })
    const reopened = await limited.services.open_session({ sessionId })
    expect(reopened.snapshot.summary.id).toBe(sessionId)
    await limited.services.close_session({ sessionId })
  }, 60_000)

  test("a host over its memory ceiling refuses a session it has the slots for", async () => {
    weight = 1_000
    try {
      await expect(limited.services.create_session({ workspaceId })).rejects.toMatchObject({
        code: "memory_ceiling_reached",
      })
    } finally {
      weight = 0
    }
    // Under the ceiling again, the same command succeeds: the limit is a state
    // the host is in, not a latch it trips.
    const opened = await limited.services.create_session({ workspaceId })
    await limited.services.close_session({ sessionId: opened.snapshot.summary.id })
  }, 60_000)

  test("a host over its memory ceiling refuses new work on a session it already holds", async () => {
    const { snapshot } = await limited.services.create_session({ workspaceId })
    const sessionId = snapshot.summary.id
    weight = 1_000
    try {
      for (const start of [
        () => limited.services.prompt({ sessionId, text: "one more turn", attachments: [] }),
        () => limited.services.steer({ sessionId, text: "one more steer" }),
        () => limited.services.follow_up({ sessionId, text: "one more follow-up" }),
      ]) {
        await expect(start()).rejects.toMatchObject({ code: "memory_ceiling_reached" })
      }
    } finally {
      weight = 0
    }

    expect((await limited.services.get_queue({ sessionId })).queue).toEqual([])
    await limited.services.close_session({ sessionId })
  }, 60_000)

  test("the queue stops at its cap, and what already fits is still delivered", async () => {
    const { snapshot } = await limited.services.create_session({ workspaceId })
    const sessionId = snapshot.summary.id
    const view = watcher.session(sessionId)
    const since = view.mark()

    // A turn that never finishes, so there is genuinely something to queue
    // behind rather than a race with a turn that may already have settled.
    server.script({ text: ["holding"], stall: true })
    expect(await limited.services.prompt({ sessionId, text: "hold the session", attachments: [] })).toEqual({
      accepted: true,
      queued: false,
    })
    // The delta rather than the status, because it is the one signal that says
    // the model is answering *now*: a queue built before Pi is streaming is a
    // queue of one prompt and two ordinary follow-ups.
    await view.waitFor("block_delta", { since, where: (payload) => payload.textDelta === "holding" })

    expect(await limited.services.follow_up({ sessionId, text: "first in line" })).toEqual({ queued: true })
    expect(await limited.services.follow_up({ sessionId, text: "second in line" })).toEqual({ queued: true })
    await expect(limited.services.follow_up({ sessionId, text: "one too many" })).rejects.toMatchObject({
      code: "queue_cap_exceeded",
    })

    // The refusal rejected a prompt and disturbed nothing already waiting. A cap
    // that dropped the queue it exists to bound would be worse than no cap.
    const { queue } = await limited.services.get_queue({ sessionId })
    expect(queue.map((entry) => entry.text)).toEqual(["first in line", "second in line"])

    await limited.services.abort({ sessionId })
    await limited.services.close_session({ sessionId })
  }, 60_000)

  test("concurrent queued inputs reserve capacity while attachments are prepared", async () => {
    const { snapshot } = await limited.services.create_session({ workspaceId })
    const sessionId = snapshot.summary.id
    const missing = join(workspaceRoot, "missing-attachment.txt")
    await expect(limited.services.follow_up({
      sessionId,
      text: "this fails before queueing",
      attachments: [{ path: missing, mediaType: "text/plain", bytes: 1 }],
    })).rejects.toMatchObject({ code: "resource_not_found" })

    const attachment = join(workspaceRoot, "queued-attachment.txt")
    const content = "queued while the other commands are preparing the same attachment"
    writeFileSync(attachment, content, "utf8")
    const inputs = ["first", "second", "one too many"].map((text) => limited.services.follow_up({
      sessionId,
      text,
      attachments: [{ path: attachment, mediaType: "text/plain", bytes: Buffer.byteLength(content) }],
    }))
    const outcomes = await Promise.allSettled(inputs)
    const { queue } = await limited.services.get_queue({ sessionId })
    await limited.services.close_session({ sessionId })

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(2)
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1)
    expect(outcomes.find((outcome) => outcome.status === "rejected")?.reason).toMatchObject({
      code: "queue_cap_exceeded",
    })
    expect(queue).toHaveLength(2)
  }, 60_000)

  test("queued prompts keep their reservations while an extension input hook awaits", async () => {
    const { snapshot } = await limited.services.create_session({ workspaceId })
    const sessionId = snapshot.summary.id
    const view = watcher.session(sessionId)
    const turn = view.mark()
    server.script({ text: ["holding"], stall: true })
    await limited.services.prompt({ sessionId, text: "hold this turn", attachments: [] })
    await view.waitFor("block_delta", { since: turn, where: (payload) => payload.textDelta === "holding" })

    const marker = view.mark()
    const pending = [
      limited.services.prompt({ sessionId, text: "block queued input one", attachments: [] }),
      limited.services.prompt({ sessionId, text: "block queued input two", attachments: [] }),
      limited.services.prompt({ sessionId, text: "block queued input one too many", attachments: [] }),
    ]
    const requestIds = await answerBlockingInputs(view, marker, 2)
    const outcomes = await Promise.allSettled(pending)
    await view.waitFor("queue_changed", { since: marker, where: (payload) => payload.queue.length === 2 })
    await limited.services.abort({ sessionId })
    await limited.services.close_session({ sessionId })

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(2)
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1)
    expect(outcomes.find((outcome) => outcome.status === "rejected")?.reason).toMatchObject({
      code: "queue_cap_exceeded",
    })
    expect(requestIds).toHaveLength(2)
  }, 60_000)

  test("prompts arriving during an idle prompt preflight become follow-ups instead of being lost", async () => {
    const { snapshot } = await limited.services.create_session({ workspaceId })
    const sessionId = snapshot.summary.id
    const view = watcher.session(sessionId)
    const marker = view.mark()
    server.script({ text: ["holding"], stall: true })

    const pending = [
      limited.services.prompt({ sessionId, text: "block queued input first turn", attachments: [] }),
      limited.services.prompt({ sessionId, text: "block queued input follow-up one", attachments: [] }),
      limited.services.prompt({ sessionId, text: "block queued input follow-up two", attachments: [] }),
    ]

    try {
      const requestIds = await answerBlockingInputs(view, marker, 3)
      const results = await Promise.all(pending)
      await view.waitFor("queue_changed", {
        since: marker,
        where: (payload) => payload.queue.length === 2,
        timeoutMs: 1_000,
      })
      expect(results).toEqual([
        { accepted: true, queued: false },
        { accepted: true, queued: true },
        { accepted: true, queued: true },
      ])
      expect(requestIds).toHaveLength(3)
    } finally {
      await limited.services.abort({ sessionId })
      await limited.services.close_session({ sessionId })
    }
  }, 60_000)
})

describe("workspace and session lifecycle", () => {
  test("closing a workspace wins against a session still being constructed", async () => {
    const root = mkdtempSync(join(tmpdir(), "bakepi-lifecycle-"))
    temporary.push(root)
    const { workspace } = await runtime.services.open_workspace({ root, runtime: { kind: "windows" } })
    await runtime.services.set_project_trust({ id: workspace.id, trust: "trusted" })

    const creating = runtime.services.create_session({ workspaceId: workspace.id })
    await runtime.services.close_workspace({ id: workspace.id })
    const outcome = await Promise.allSettled([creating]).then(([settled]) => settled!)

    // Keep a failing implementation from leaking its late session into the
    // shared real-Pi runtime used by the rest of this file.
    if (outcome.status === "fulfilled") {
      await runtime.services.close_session({ sessionId: outcome.value.snapshot.summary.id })
    }

    expect(outcome.status).toBe("rejected")
    if (outcome.status === "rejected") {
      expect(outcome.reason).toMatchObject({ code: "workspace_not_open" })
    }
  }, 60_000)

  test("closing a workspace cancels a session already registered for extension binding", async () => {
    const root = mkdtempSync(join(tmpdir(), "bakepi-lifecycle-"))
    temporary.push(root)
    const { workspace } = await runtime.services.open_workspace({ root, runtime: { kind: "windows" } })
    await runtime.services.set_project_trust({ id: workspace.id, trust: "trusted" })
    const marker = recorder.envelopes.length
    const previousBlock = process.env.BAKE_PI_BLOCK_SESSION_START
    process.env.BAKE_PI_BLOCK_SESSION_START = "1"

    const creating = runtime.services.create_session({ workspaceId: workspace.id })
    void creating.catch(() => undefined)
    let outcome: PromiseSettledResult<Awaited<typeof creating>> | undefined
    try {
      await recorder.waitForHostEvent(
        "extension_ui_requested",
        (payload) => payload.request.title === "Blocking session start",
        marker,
      )
      await runtime.services.close_workspace({ id: workspace.id })
      outcome = await Promise.allSettled([creating]).then(([settled]) => settled!)
    } finally {
      if (previousBlock === undefined) delete process.env.BAKE_PI_BLOCK_SESSION_START
      else process.env.BAKE_PI_BLOCK_SESSION_START = previousBlock
      await runtime.services.close_workspace({ id: workspace.id })
    }

    expect(outcome?.status).toBe("rejected")
    if (outcome?.status === "rejected") {
      expect(outcome.reason).toMatchObject({ code: "workspace_not_open" })
    }
  }, 60_000)
})

describe("listing a workspace directory", () => {
  /**
   * The file rail's whole surface, and the only place its containment is
   * decided.
   *
   * The rail can name any path it likes, so the check that matters is not that
   * a listing comes back — it is that a path resolving outside the workspace
   * comes back as a refusal rather than a listing of somewhere else. That is
   * the failure a clamp-to-root would hide.
   */
  test("returns the workspace root, directories first", async () => {
    const open = await openSessionIn({ trusted: false })
    mkdirSync(join(open.root, "src"))
    mkdirSync(join(open.root, "Docs"))
    writeFileSync(join(open.root, "readme.md"), "x")
    writeFileSync(join(open.root, ".gitignore"), "x")

    const listing = await runtime.services.list_directory({ id: open.workspaceId })
    expect(listing.truncated).toBe(false)
    // Directories first, then case-insensitively by name. `.gitignore` is
    // listed rather than hidden: a dotfile is a file a person opens.
    expect(listing.entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
      "directory:Docs",
      "directory:src",
      "file:.gitignore",
      "file:readme.md",
    ])
    // The paths came from the host, which is what makes them safe to send back.
    expect(await runtime.services.list_directory({ id: open.workspaceId, path: listing.entries[0]!.path })).toMatchObject({
      entries: [],
    })

    await runtime.services.close_session({ sessionId: open.sessionId })
  })

  test("marks entries from Git's current ignore rules", async () => {
    const root = mkdtempSync(join(tmpdir(), "bakepi-slice-"))
    temporary.push(root)
    execFileSync("git", ["init", "--quiet"], { cwd: root })
    mkdirSync(join(root, "generated"))
    writeFileSync(join(root, "visible.txt"), "x")
    writeFileSync(join(root, ".gitignore"), "generated/\n")

    const { workspace } = await runtime.services.open_workspace({ root, runtime: { kind: "windows" } })
    expect(workspace.isGitRepository).toBe(true)
    const first = await runtime.services.list_directory({ id: workspace.id })
    expect(first.entries.find((entry) => entry.name === "generated")?.ignored).toBe(true)
    expect(first.entries.find((entry) => entry.name === "visible.txt")?.ignored).toBe(false)

    writeFileSync(join(root, ".gitignore"), "visible.txt\n")
    const current = await runtime.services.list_directory({ id: workspace.id })
    expect(current.entries.find((entry) => entry.name === "generated")?.ignored).toBe(false)
    expect(current.entries.find((entry) => entry.name === "visible.txt")?.ignored).toBe(true)

    await runtime.services.close_workspace({ id: workspace.id })
  })

  test("refuses a path that resolves outside the workspace", async () => {
    const open = await openSessionIn({ trusted: false })
    await expect(
      runtime.services.list_directory({ id: open.workspaceId, path: join(open.root, "..") }),
    ).rejects.toMatchObject({ code: "path_outside_workspace" })
    // The refusal says nothing about where the path landed. The renderer knows
    // what it asked for; the canonical location is the host's business.
    await expect(
      runtime.services.list_directory({ id: open.workspaceId, path: tmpdir() }),
    ).rejects.toMatchObject({ code: "path_outside_workspace", detail: "outside the open workspace" })

    await runtime.services.close_session({ sessionId: open.sessionId })
  })

  test("reports a directory it cannot read as an error rather than as empty", async () => {
    const open = await openSessionIn({ trusted: false })
    await expect(
      runtime.services.list_directory({ id: open.workspaceId, path: join(open.root, "never-created") }),
    ).rejects.toMatchObject({ code: "internal_error" })

    await runtime.services.close_session({ sessionId: open.sessionId })
  })
})
