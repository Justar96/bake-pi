import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acceptEvent, type ApprovalRequest, type EventEnvelope, type EventName } from "@bake-pi/contract"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import { fakeSession, type FakeSession } from "../../test/fake-session.ts"
import { Diagnostics } from "../diagnostics.ts"
import { EventEmitter } from "../emitter.ts"
import { SessionHost } from "../session-host.ts"
import { PI_EVENT_COVERAGE, type PiEventType } from "./coverage.ts"

/**
 * The adapter report, made executable.
 *
 * `coverage.ts` claims what every Pi session event becomes. This file drives a
 * real `SessionHost` with a fixture for each of them and holds the claim to
 * account in both directions: an entry that promises an event the adapter does
 * not emit fails here, and so does an emission the entry does not declare.
 * Without that, the table would be prose that drifts.
 *
 * Pi is faked, deliberately. `test/vertical-slice.test.ts` runs this same
 * adapter against real Pi and a real provider and is what proves the wiring;
 * what it cannot do is produce a summarization retry, a compaction that ends in
 * a retry, or a tool that streams partial output — on demand and in a second.
 * Those are exactly the events that go unmapped for a year, so they are the ones
 * that most need a fixture.
 *
 * Every envelope is validated by the contract's own `acceptEvent` before it is
 * recorded: an event the host can emit but the contract rejects is an event the
 * renderer drops on the floor.
 */

interface Recorded {
  name: EventName
  payload: unknown
}

interface Harness {
  host: SessionHost
  fake: FakeSession
  diagnostics: Diagnostics
  recorded: Recorded[]
}

const harness = (options: { pendingApprovals?: readonly ApprovalRequest[] } = {}): Harness => {
  const fake = fakeSession()
  const recorded: Recorded[] = []
  const emitter = new EventEmitter()
  emitter.attach({
    postMessage: (message: unknown) => {
      const envelope = message as EventEnvelope
      acceptEvent(envelope)
      // The envelope carries a bounded string; `acceptEvent` has just proven it
      // names an event the contract knows.
      recorded.push({ name: envelope.name as EventName, payload: envelope.payload })
    },
    on: () => {},
    start: () => {},
    close: () => {},
  })
  const diagnostics = new Diagnostics()

  const host = new SessionHost({
    runtime: fake.runtime,
    emitter,
    diagnostics,
    workspaceId: "workspace-under-test",
    workspaceRoot: tmpdir(),
    trust: "trusted",
    pendingApprovals: () => options.pendingApprovals ?? [],
  })
  host.attach()
  return { host, fake, diagnostics, recorded }
}

const assistantMessage = (content: unknown[], extra: Record<string, unknown> = {}): never =>
  ({ role: "assistant", content, timestamp: 1, stopReason: "stop", ...extra }) as never

const userMessage = (text: string): never => ({ role: "user", content: text, timestamp: 1 }) as never

const toolResultMessage = (toolCallId: string): never =>
  ({ role: "toolResult", toolCallId, content: [{ type: "text", text: "done" }], isError: false, timestamp: 1 }) as never

/** The tool output shape Pi's tools actually return, for both partials and results. */
const toolOutput = (text: string): unknown => ({ content: [{ type: "text", text }], details: undefined })

const event = (value: unknown): AgentSessionEvent => value as AgentSessionEvent

interface Fixture {
  /** What the case is, so a failure names the behavior rather than an index. */
  case: string
  /** History the session already had, applied before anything else. */
  given?: (fake: FakeSession) => void
  /** Delivered before recording starts, to put the host in the state the case needs. */
  setup?: AgentSessionEvent[]
  /** Runs after setup and before the event, for history Pi would have appended itself. */
  before?: (fake: FakeSession) => void
  event: AgentSessionEvent
  /** The contract events this must produce, in order. */
  emits: EventName[]
  /** Optional deeper check on the payloads the event produced. */
  expect?: (payloads: Recorded[], harness: Harness) => void
}

/**
 * One or more fixtures for every event Pi can emit.
 *
 * Typed as a total record, so an event added to Pi is a compile error here as
 * well as in the table it tests. A new event cannot be mapped without being
 * driven, and cannot be dismissed without someone writing the case that shows
 * it emits nothing.
 */
const FIXTURES: Record<PiEventType, Fixture[]> = {
  agent_start: [
    {
      case: "opens the turn",
      event: event({ type: "agent_start" }),
      emits: ["session_status_changed"],
      expect: ([status]) => {
        expect(status?.payload).toEqual({ status: "streaming" })
      },
    },
  ],

  agent_end: [
    {
      case: "says nothing, because the session is not idle yet",
      setup: [event({ type: "agent_start" })],
      event: event({ type: "agent_end", messages: [], willRetry: false }),
      emits: [],
    },
    {
      case: "says nothing when a retry is coming either",
      setup: [event({ type: "agent_start" })],
      event: event({ type: "agent_end", messages: [], willRetry: true }),
      emits: [],
    },
  ],

  agent_settled: [
    {
      case: "returns the session to idle",
      setup: [event({ type: "agent_start" })],
      event: event({ type: "agent_settled" }),
      emits: ["session_status_changed"],
      expect: ([status]) => {
        expect(status?.payload).toEqual({ status: "idle" })
      },
    },
  ],

  turn_start: [
    {
      case: "names the id the turn's first message will take",
      before: (fake) => fake.messages.push(userMessage("first")),
      event: event({ type: "turn_start" }),
      emits: ["turn_started"],
      expect: ([started]) => {
        expect(started?.payload).toEqual({ messageId: "m1" })
      },
    },
  ],

  turn_end: [
    {
      case: "settles the assistant message with its own stop reason and usage",
      before: (fake) => {
        fake.messages.push(assistantMessage([{ type: "text", text: "hi" }]))
        fake.stats.assistantMessages = 1
        fake.stats.tokens = { input: 11, output: 7, cacheRead: 3, cacheWrite: 1, total: 22 }
        fake.stats.cost = 0.25
      },
      event: event({
        type: "turn_end",
        message: assistantMessage([{ type: "text", text: "hi" }], {
          usage: { input: 11, output: 7, cacheRead: 3, cacheWrite: 1 },
        }),
        toolResults: [],
      }),
      emits: ["turn_settled", "usage_changed"],
      expect: ([settled, usage]) => {
        expect(settled?.payload).toMatchObject({
          status: "complete",
          usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 1 },
        })
        expect(usage?.payload).toEqual({
          usage: {
            turnCount: 1,
            total: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 1 },
            totalCostUsd: 0.25,
          },
        })
      },
    },
    {
      case: "reports an aborted turn as aborted rather than complete",
      before: (fake) => fake.messages.push(assistantMessage([], { stopReason: "aborted" })),
      event: event({
        type: "turn_end",
        message: assistantMessage([], { stopReason: "aborted" }),
        toolResults: [],
      }),
      emits: ["turn_settled", "usage_changed"],
      expect: ([settled]) => {
        expect(settled?.payload).toMatchObject({ status: "aborted" })
      },
    },
    {
      case: "reports a failed turn as failed",
      event: event({
        type: "turn_end",
        message: assistantMessage([], { stopReason: "error", errorMessage: "provider said no" }),
        toolResults: [],
      }),
      emits: ["turn_settled", "usage_changed"],
      expect: ([settled]) => {
        expect(settled?.payload).toMatchObject({ status: "failed" })
      },
    },
  ],

  message_start: [
    {
      case: "adds the message at the index it will occupy",
      before: (fake) => fake.messages.push(userMessage("already here")),
      event: event({ type: "message_start", message: assistantMessage([]) }),
      emits: ["message_added"],
      expect: ([added]) => {
        expect(added?.payload).toMatchObject({ message: { id: "m1", role: "assistant" } })
      },
    },
  ],

  message_update: [
    {
      case: "text_start opens an empty text block",
      event: event({
        type: "message_update",
        message: assistantMessage([]),
        assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: assistantMessage([]) },
      }),
      emits: ["block_started"],
      expect: ([started]) => {
        expect(started?.payload).toEqual({ messageId: "m0", block: { index: 0, kind: "text", text: "" } })
      },
    },
    {
      case: "text_delta appends to it by index",
      event: event({
        type: "message_update",
        message: assistantMessage([]),
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo ", partial: assistantMessage([]) },
      }),
      emits: ["block_delta"],
      expect: ([delta]) => {
        expect(delta?.payload).toEqual({ messageId: "m0", blockIndex: 0, textDelta: "lo " })
      },
    },
    {
      case: "text_end closes it with the whole content, repairing any lost delta",
      event: event({
        type: "message_update",
        message: assistantMessage([]),
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: 0,
          content: "hello there",
          partial: assistantMessage([]),
        },
      }),
      emits: ["block_finished"],
      expect: ([finished]) => {
        expect(finished?.payload).toEqual({
          messageId: "m0",
          block: { index: 0, kind: "text", text: "hello there" },
        })
      },
    },
    {
      case: "thinking_start opens a reasoning block, not a text one",
      event: event({
        type: "message_update",
        message: assistantMessage([]),
        assistantMessageEvent: { type: "thinking_start", contentIndex: 1, partial: assistantMessage([]) },
      }),
      emits: ["block_started"],
      expect: ([started]) => {
        expect(started?.payload).toEqual({
          messageId: "m0",
          block: { index: 1, kind: "reasoning", text: "", redacted: false },
        })
      },
    },
    {
      case: "thinking_delta streams into it",
      event: event({
        type: "message_update",
        message: assistantMessage([]),
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "hm", partial: assistantMessage([]) },
      }),
      emits: ["block_delta"],
    },
    {
      case: "thinking_end closes it",
      event: event({
        type: "message_update",
        message: assistantMessage([]),
        assistantMessageEvent: {
          type: "thinking_end",
          contentIndex: 1,
          content: "hmm",
          partial: assistantMessage([]),
        },
      }),
      emits: ["block_finished"],
      expect: ([finished]) => {
        expect(finished?.payload).toMatchObject({ block: { kind: "reasoning", text: "hmm" } })
      },
    },
    {
      case: "a tool call being assembled is not shown half-parsed",
      event: event({
        type: "message_update",
        message: assistantMessage([]),
        assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, partial: assistantMessage([]) },
      }),
      emits: [],
    },
    {
      case: "nor are its argument deltas",
      event: event({
        type: "message_update",
        message: assistantMessage([]),
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 2,
          delta: '{"path":',
          partial: assistantMessage([]),
        },
      }),
      emits: [],
    },
    {
      case: "and a completed one waits for tool_call_started, which carries its targets",
      event: event({
        type: "message_update",
        message: assistantMessage([]),
        assistantMessageEvent: {
          type: "toolcall_end",
          contentIndex: 2,
          toolCall: { type: "toolCall", id: "call-1", name: "read", arguments: {} },
          partial: assistantMessage([]),
        },
      }),
      emits: [],
    },
    {
      case: "the stream events Pi's own loop consumes never reach the renderer",
      event: event({
        type: "message_update",
        message: assistantMessage([]),
        assistantMessageEvent: { type: "done", reason: "stop", message: assistantMessage([]) },
      }),
      emits: [],
    },
  ],

  message_end: [
    {
      case: "finishes every text and reasoning block of the finished assistant message",
      before: (fake) => {
        fake.messages.push(
          assistantMessage([
            { type: "thinking", thinking: "considering", redacted: true },
            { type: "text", text: "the answer" },
          ]),
        )
      },
      event: event({
        type: "message_end",
        message: assistantMessage([
          { type: "thinking", thinking: "considering", redacted: true },
          { type: "text", text: "the answer" },
        ]),
      }),
      emits: ["block_finished", "block_finished"],
      expect: ([reasoning, text]) => {
        // Redaction only exists on the finished message. The stream events do
        // not carry it, so this is the only event that can be honest about it.
        expect(reasoning?.payload).toEqual({
          messageId: "m0",
          block: { index: 0, kind: "reasoning", text: "considering", redacted: true },
        })
        expect(text?.payload).toEqual({ messageId: "m0", block: { index: 1, kind: "text", text: "the answer" } })
      },
    },
    {
      case: "leaves the message's tool calls to tool_call_started",
      before: (fake) => {
        fake.messages.push(assistantMessage([{ type: "toolCall", id: "call-1", name: "write", arguments: {} }]))
      },
      event: event({
        type: "message_end",
        message: assistantMessage([{ type: "toolCall", id: "call-1", name: "write", arguments: {} }]),
      }),
      emits: [],
    },
    {
      case: "says nothing for a message that was already complete when it started",
      before: (fake) => fake.messages.push(userMessage("a prompt")),
      event: event({ type: "message_end", message: userMessage("a prompt") }),
      emits: [],
    },
  ],

  tool_execution_start: [
    {
      case: "describes the call with the targets the policy resolved",
      event: event({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "notes.md" } }),
      emits: ["tool_call_started"],
      expect: ([started]) => {
        expect(started?.payload).toMatchObject({
          messageId: "m0",
          call: { id: "call-1", name: "read", source: "builtin", status: "running" },
        })
        const { call } = started?.payload as { call: { targets: { kind: string }[] } }
        expect(call.targets).toHaveLength(1)
        expect(call.targets[0]?.kind).toBe("read")
      },
    },
    {
      case: "a tool Pi does not ship is reported as coming from an extension",
      event: event({ type: "tool_execution_start", toolCallId: "call-2", toolName: "deploy", args: {} }),
      emits: ["tool_call_started"],
      expect: ([started]) => {
        expect(started?.payload).toMatchObject({ call: { source: "extension" } })
      },
    },
  ],

  tool_execution_update: [
    {
      case: "reports the running call's output so far, as the same call",
      setup: [event({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "ls" } })],
      event: event({
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "ls" },
        partialResult: toolOutput("first line\n"),
      }),
      emits: ["tool_call_updated"],
      expect: ([updated]) => {
        expect(updated?.payload).toMatchObject({
          call: { id: "call-1", name: "bash", status: "running", partialOutput: "first line\n" },
        })
      },
    },
    {
      case: "an update for a call this host never saw start still describes it",
      event: event({
        type: "tool_execution_update",
        toolCallId: "call-9",
        toolName: "bash",
        args: { command: "ls" },
        partialResult: toolOutput("output"),
      }),
      emits: ["tool_call_updated"],
      expect: ([updated]) => {
        expect(updated?.payload).toMatchObject({ call: { id: "call-9", partialOutput: "output" } })
      },
    },
  ],

  tool_execution_end: [
    {
      case: "returns the tool's text, not the wrapper Pi returns it in",
      setup: [event({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "ls" } })],
      event: event({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        result: toolOutput("notes.md\n"),
        isError: false,
      }),
      emits: ["tool_call_finished"],
      expect: ([finished]) => {
        expect(finished?.payload).toEqual({
          result: { toolCallId: "call-1", status: "succeeded", output: "notes.md\n", truncated: false },
        })
      },
    },
    {
      case: "a failed tool is reported failed",
      event: event({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        result: toolOutput("no such file"),
        isError: true,
      }),
      emits: ["tool_call_finished"],
      expect: ([finished]) => {
        expect(finished?.payload).toMatchObject({ result: { status: "failed", output: "no such file" } })
      },
    },
    {
      case: "a todo result carries its validated current list",
      event: event({
        type: "tool_execution_end",
        toolCallId: "todo-1",
        toolName: "todo",
        result: {
          content: [{ type: "text", text: "Added todo #1" }],
          details: { action: "add", nextId: 2, todos: [{ id: 1, text: "Verify the build", done: false }] },
        },
        isError: false,
      }),
      emits: ["tool_call_finished"],
      expect: ([finished]) => {
        expect(finished?.payload).toMatchObject({
          result: { todo: { items: [{ id: "1", text: "Verify the build", status: "pending" }] } },
        })
      },
    },
  ],

  queue_update: [
    {
      case: "projects both queues in delivery order",
      event: event({ type: "queue_update", steering: ["steer me"], followUp: ["then this"] }),
      emits: ["queue_changed"],
      expect: ([changed]) => {
        const { queue } = changed?.payload as { queue: { text: string; mode: string }[] }
        expect(queue.map(({ text, mode }) => ({ text, mode }))).toEqual([
          { text: "steer me", mode: "steer" },
          { text: "then this", mode: "follow_up" },
        ])
      },
    },
    {
      case: "the delivered head leaves the queue",
      setup: [event({ type: "queue_update", steering: [], followUp: ["first", "second"] })],
      event: event({ type: "queue_update", steering: [], followUp: ["second"] }),
      emits: ["queue_changed"],
      expect: ([changed], world) => {
        const { queue } = changed?.payload as { queue: { text: string }[] }
        expect(queue.map((entry) => entry.text)).toEqual(["second"])
        // The snapshot is the same projection, not a second one taken later.
        expect(world.host.snapshot().queue).toEqual(queue as never)
      },
    },
  ],

  compaction_start: [
    {
      case: "blocks the session while it runs",
      event: event({ type: "compaction_start", reason: "threshold" }),
      emits: ["session_status_changed", "compaction_started"],
      expect: ([status]) => {
        expect(status?.payload).toEqual({ status: "compacting" })
      },
    },
  ],

  compaction_end: [
    {
      case: "counts what it removed and replaces the projection",
      given: (fake) => {
        fake.messages.push(userMessage("one"), assistantMessage([]), userMessage("two"))
      },
      setup: [event({ type: "compaction_start", reason: "threshold" })],
      before: (fake) => {
        // Compaction rewrote history down to a summary plus the recent tail.
        fake.messages.length = 0
        fake.messages.push(userMessage("what is left"))
      },
      event: event({
        type: "compaction_end",
        reason: "threshold",
        result: { summary: "a summary", firstKeptEntryId: "e9", tokensBefore: 100 },
        aborted: false,
        willRetry: false,
      }),
      emits: ["session_status_changed", "compaction_finished", "session_snapshot"],
      expect: ([status, finished]) => {
        expect(status?.payload).toEqual({ status: "idle" })
        // Three messages before, one after. Pi's own result reports tokens and a
        // kept-entry id, so the count has to be measured across the operation.
        expect(finished?.payload).toEqual({ removedMessages: 2 })
      },
    },
    {
      case: "an overflow compaction that precedes a retry returns to streaming, not to idle",
      setup: [event({ type: "compaction_start", reason: "overflow" })],
      event: event({
        type: "compaction_end",
        reason: "overflow",
        result: undefined,
        aborted: false,
        willRetry: true,
      }),
      emits: ["session_status_changed", "compaction_finished", "session_snapshot"],
      expect: ([status]) => {
        expect(status?.payload).toEqual({ status: "streaming" })
      },
    },
  ],

  entry_appended: [
    {
      case: "is not a projection input",
      event: event({ type: "entry_appended", entry: { type: "message", message: userMessage("hi") } }),
      emits: [],
    },
  ],

  session_info_changed: [
    {
      case: "re-sends the summary",
      event: event({ type: "session_info_changed", name: "renamed" }),
      emits: ["session_summary_changed"],
    },
  ],

  thinking_level_changed: [
    {
      case: "announces the selection Pi settled on",
      before: (fake) => {
        fake.selection.availableThinkingLevels = ["off", "low", "high"]
        fake.selection.thinkingLevel = "high"
      },
      event: event({ type: "thinking_level_changed", level: "high" }),
      emits: ["model_changed"],
      expect: ([changed]) => {
        expect(changed?.payload).toMatchObject({ selection: { thinkingLevel: "high" } })
      },
    },
    {
      case: "a level clamped onto the one already in force announces nothing",
      event: event({ type: "thinking_level_changed", level: "off" }),
      emits: [],
    },
  ],

  auto_retry_start: [
    {
      case: "shows the retry rather than stalling silently",
      event: event({
        type: "auto_retry_start",
        attempt: 2,
        maxAttempts: 5,
        delayMs: 1_000,
        errorMessage: "overloaded",
      }),
      emits: ["session_status_changed", "retry_scheduled"],
      expect: ([status, retry]) => {
        expect(status?.payload).toEqual({ status: "retrying" })
        expect(retry?.payload).toEqual({ attempt: 2, delayMs: 1_000, reason: "overloaded" })
      },
    },
  ],

  auto_retry_end: [
    {
      case: "a successful retry resumes streaming",
      setup: [
        event({ type: "auto_retry_start", attempt: 1, maxAttempts: 5, delayMs: 1, errorMessage: "overloaded" }),
      ],
      event: event({ type: "auto_retry_end", success: true, attempt: 1 }),
      emits: ["session_status_changed"],
      expect: ([status]) => {
        expect(status?.payload).toEqual({ status: "streaming" })
      },
    },
    {
      case: "an exhausted retry budget leaves the session idle",
      setup: [
        event({ type: "auto_retry_start", attempt: 5, maxAttempts: 5, delayMs: 1, errorMessage: "overloaded" }),
      ],
      event: event({ type: "auto_retry_end", success: false, attempt: 5, finalError: "gave up" }),
      emits: ["session_status_changed"],
      expect: ([status]) => {
        expect(status?.payload).toEqual({ status: "idle" })
      },
    },
  ],

  summarization_retry_scheduled: [
    {
      case: "a stalled compaction is explained the same way a stalled turn is",
      setup: [event({ type: "compaction_start", reason: "threshold" })],
      event: event({
        type: "summarization_retry_scheduled",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 500,
        errorMessage: "rate limited",
      }),
      emits: ["session_status_changed", "retry_scheduled"],
      expect: ([status, retry]) => {
        expect(status?.payload).toEqual({ status: "retrying" })
        expect(retry?.payload).toEqual({ attempt: 1, delayMs: 500, reason: "rate limited" })
      },
    },
  ],

  summarization_retry_attempt_start: [
    {
      case: "returns to the status the retry interrupted, which is not always idle",
      setup: [
        event({ type: "compaction_start", reason: "threshold" }),
        event({
          type: "summarization_retry_scheduled",
          attempt: 1,
          maxAttempts: 3,
          delayMs: 500,
          errorMessage: "rate limited",
        }),
      ],
      event: event({ type: "summarization_retry_attempt_start", source: "compaction", reason: "threshold" }),
      emits: ["session_status_changed"],
      expect: ([status]) => {
        expect(status?.payload).toEqual({ status: "compacting" })
      },
    },
  ],

  summarization_retry_finished: [
    {
      case: "restores the interrupted status when the retries stop",
      setup: [
        event({ type: "compaction_start", reason: "threshold" }),
        event({
          type: "summarization_retry_scheduled",
          attempt: 1,
          maxAttempts: 3,
          delayMs: 500,
          errorMessage: "rate limited",
        }),
      ],
      event: event({ type: "summarization_retry_finished" }),
      emits: ["session_status_changed"],
      expect: ([status]) => {
        expect(status?.payload).toEqual({ status: "compacting" })
      },
    },
  ],

  bash_execution_update: [
    {
      case: "cannot arise from anything Bake Pi offers, and is not invented",
      event: event({ type: "bash_execution_update", id: "bash-1", delta: "output" }),
      emits: [],
    },
  ],
}

describe("the adapter report is exhaustive", () => {
  test("every event Pi can emit has a fixture", () => {
    for (const type of Object.keys(PI_EVENT_COVERAGE) as PiEventType[]) {
      expect(FIXTURES[type].length).toBeGreaterThan(0)
    }
  })

  test("what the fixtures produce is exactly what the report declares", () => {
    // Both directions. A mapping the report forgot fails here, and so does a
    // report entry promising an event the adapter never emits — which is the
    // failure mode of a hand-maintained table.
    for (const type of Object.keys(PI_EVENT_COVERAGE) as PiEventType[]) {
      const produced = new Set<EventName>()
      for (const fixture of FIXTURES[type]) {
        for (const name of run(fixture).map((entry) => entry.name)) produced.add(name)
      }
      expect([...produced].sort()).toEqual([...PI_EVENT_COVERAGE[type].emits].sort())
    }
  })

  test("an event this build does not know about is recorded rather than dropped or thrown", () => {
    // The runtime half of the promise. The compiler catches a new Pi event at
    // the table; this catches one that arrives at a build the compiler never
    // saw, which is what a Pi upgrade in the field looks like.
    const world = harness()
    world.fake.emit(event({ type: "some_event_from_a_later_pi" }))

    expect(world.recorded).toEqual([])
    const entries = world.diagnostics.since(undefined, 10)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.level).toBe("warn")
    expect(entries[0]?.message).toContain("some_event_from_a_later_pi")
  })
})

describe("each Pi event, driven", () => {
  for (const type of Object.keys(FIXTURES) as PiEventType[]) {
    for (const fixture of FIXTURES[type]) {
      test(`${type}: ${fixture.case}`, () => {
        const world = harness()
        fixture.given?.(world.fake)
        for (const setup of fixture.setup ?? []) world.fake.emit(setup)
        fixture.before?.(world.fake)
        world.recorded.length = 0

        world.fake.emit(fixture.event)

        expect(world.recorded.map((entry) => entry.name)).toEqual(fixture.emits)
        fixture.expect?.(world.recorded, world)
      })
    }
  }
})

/** Runs one fixture and returns what it emitted, for the report comparison. */
const run = (fixture: Fixture): Recorded[] => {
  const world = harness()
  fixture.given?.(world.fake)
  for (const setup of fixture.setup ?? []) world.fake.emit(setup)
  fixture.before?.(world.fake)
  world.recorded.length = 0
  world.fake.emit(fixture.event)
  return world.recorded
}

describe("addressing the right message", () => {
  /**
   * The defect this exists for: Pi appends a turn's tool results *after* the
   * assistant message, so the last message in history when a turn settles — or
   * when its second tool call starts — is a tool result. Addressing either by
   * index settled the wrong message and hung the tool card off the wrong one,
   * and both ids were real, so nothing failed.
   */
  test("a turn settles the assistant message, not the tool result that followed it", () => {
    const world = harness()
    const assistant = assistantMessage([{ type: "toolCall", id: "call-1", name: "read", arguments: {} }])

    world.fake.messages.push(assistant)
    world.fake.emit(event({ type: "message_end", message: assistant }))
    // Pi runs the tool and appends its result message.
    world.fake.messages.push(toolResultMessage("call-1"))
    world.recorded.length = 0

    world.fake.emit(event({ type: "turn_end", message: assistant, toolResults: [toolResultMessage("call-1")] }))

    expect(world.recorded[0]?.name).toBe("turn_settled")
    expect(world.recorded[0]?.payload).toMatchObject({ messageId: "m0" })
  })

  test("every tool call in a batch hangs off the assistant message that asked for it", () => {
    const world = harness()
    const assistant = assistantMessage([
      { type: "toolCall", id: "call-1", name: "read", arguments: {} },
      { type: "toolCall", id: "call-2", name: "read", arguments: {} },
    ])

    world.fake.messages.push(assistant)
    world.fake.emit(event({ type: "message_end", message: assistant }))

    world.fake.emit(event({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: {} }))
    // The first call's result message lands before the second call starts.
    world.fake.messages.push(toolResultMessage("call-1"))
    world.fake.emit(event({ type: "tool_execution_start", toolCallId: "call-2", toolName: "read", args: {} }))

    const started = world.recorded.filter((entry) => entry.name === "tool_call_started")
    expect(started).toHaveLength(2)
    for (const entry of started) expect(entry.payload).toMatchObject({ messageId: "m0" })
  })

  /**
   * Compaction does not just shorten history, it renumbers it: the assistant
   * message that was `m7` before is some lower index after, and a remembered id
   * now names a different message. Forgetting it on resync falls back to the
   * current history, which is at least computed from what exists.
   */
  test("a message id remembered before a resync does not outlive the history it named", () => {
    const world = harness()
    const assistant = assistantMessage([{ type: "text", text: "hello" }])

    world.fake.messages.push(userMessage("hi"), assistant)
    world.fake.emit(event({ type: "message_end", message: assistant }))

    // Compaction replaced the prefix, so the same assistant message now sits at
    // a different index than the one the host was holding.
    world.fake.messages.splice(0, 1)
    world.host.resync("replacement")
    world.recorded.length = 0

    world.fake.emit(event({ type: "turn_end", message: assistant, toolResults: [] }))

    expect(world.recorded[0]?.name).toBe("turn_settled")
    expect(world.recorded[0]?.payload).toMatchObject({ messageId: "m0" })
  })
})

describe("a queued prompt while it waits", () => {
  test("keeps the id and the arrival time it was first given", () => {
    // Entries were minted from the position on every read, so a snapshot reset
    // every entry's arrival time and delivering the head shifted every
    // remaining id down onto its neighbour's. A renderer keyed on them would
    // animate the wrong row and show a wait that keeps restarting.
    const world = harness()
    world.fake.emit(event({ type: "queue_update", steering: ["steer"], followUp: ["first", "second"] }))
    const queued = (world.recorded[0]?.payload as { queue: unknown[] }).queue
    world.recorded.length = 0

    world.fake.emit(event({ type: "queue_update", steering: [], followUp: ["first", "second"] }))

    expect((world.recorded[0]?.payload as { queue: unknown[] }).queue).toEqual(queued.slice(1))
    expect(world.host.snapshot().queue).toEqual(queued.slice(1) as never)
  })

  test("two identical prompts stay two entries", () => {
    // Reuse is matched by text, so the match has to be consumed as it is made.
    // Left unconsumed, both entries resolve to the first one and the queue shows
    // one prompt twice under one id.
    const world = harness()
    world.fake.emit(event({ type: "queue_update", steering: [], followUp: ["same", "same"] }))
    const queue = (world.recorded[0]?.payload as { queue: { id: string }[] }).queue
    world.recorded.length = 0

    world.fake.emit(event({ type: "queue_update", steering: [], followUp: ["same", "same"] }))

    expect(queue).toHaveLength(2)
    expect(queue[0]?.id).not.toBe(queue[1]?.id)
    expect((world.recorded[0]?.payload as { queue: unknown[] }).queue).toEqual(queue)
  })

  test("identical text in different delivery modes keeps its own identity", () => {
    const world = harness()
    world.fake.emit(event({ type: "queue_update", steering: ["same"], followUp: ["same"] }))
    const queue = (world.recorded[0]?.payload as { queue: { id: string; mode: string }[] }).queue

    expect(queue.map((entry) => entry.mode)).toEqual(["steer", "follow_up"])
    expect(queue[0]?.id).not.toBe(queue[1]?.id)
  })
})

describe("usage stops being a placeholder", () => {
  test("the snapshot reports what Pi accounted for", () => {
    const world = harness()
    world.fake.stats.assistantMessages = 3
    world.fake.stats.tokens = { input: 100, output: 40, cacheRead: 10, cacheWrite: 5, total: 155 }
    world.fake.stats.cost = 1.5
    world.fake.stats.contextUsage = { tokens: 900, contextWindow: 128_000, percent: 0.7 }

    expect(world.host.snapshot().usage).toEqual({
      turnCount: 3,
      total: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 10, cacheWriteTokens: 5 },
      totalCostUsd: 1.5,
      context: { usedTokens: 900, maxTokens: 128_000 },
    })
  })

  test("a context size Pi cannot know is omitted rather than reported as empty", () => {
    // Pi reports null right after compaction, before the next response. A meter
    // reading zero is a claim; a missing meter is not.
    const world = harness()
    world.fake.stats.contextUsage = { tokens: null, contextWindow: 128_000, percent: null }

    expect(world.host.snapshot().usage.context).toBeUndefined()
  })

  test("an unchanged total is not re-announced", () => {
    const world = harness()
    const turn = event({ type: "turn_end", message: assistantMessage([]), toolResults: [] })

    world.fake.emit(turn)
    world.recorded.length = 0
    world.fake.emit(turn)

    expect(world.recorded.map((entry) => entry.name)).toEqual(["turn_settled"])
  })
})

describe("an authoritative snapshot", () => {
  test("carries every approval Pi is still blocked on", () => {
    const request: ApprovalRequest = {
      id: "approval-1",
      sessionId: "session-under-test",
      call: {
        id: "call-1",
        name: "write",
        source: "builtin",
        args: { path: join(tmpdir(), "approval-target.txt"), content: "x" },
        targets: [],
        status: "pending_approval",
      },
      reason: "workspace_untrusted",
      requestedAt: 1,
    }
    const world = harness({ pendingApprovals: [request] })
    world.fake.messages.push(
      assistantMessage([{ type: "toolCall", id: "call-1", name: "write", arguments: request.call.args }]),
    )

    const snapshot = world.host.snapshot()

    expect(snapshot.status).toBe("awaiting_approval")
    expect(snapshot.approvals).toEqual([request])
    expect(snapshot.messages[0]?.blocks[0]).toMatchObject({
      kind: "tool_call",
      call: { id: "call-1", status: "pending_approval" },
    })
  })

  test("derives persisted tool provenance and targets exactly like live events", () => {
    const world = harness()
    const target = join(tmpdir(), "snapshot-target.txt")
    const calls = [
      { type: "toolCall", id: "write-1", name: "write", arguments: { path: target, content: "x" } },
      { type: "toolCall", id: "extension-1", name: "project_tool", arguments: { opaque: true } },
    ]
    world.fake.messages.push(assistantMessage(calls))
    const snapshot = world.host.snapshot()

    for (const call of calls) {
      world.recorded.length = 0
      world.fake.emit(
        event({
          type: "tool_execution_start",
          toolCallId: call.id,
          toolName: call.name,
          args: call.arguments,
        }),
      )
      const live = (world.recorded[0]?.payload as { call: Record<string, unknown> }).call
      const { startedAt: _volatile, ...stableLive } = live
      const persisted = snapshot.messages[0]?.blocks.find(
        (block) => block.kind === "tool_call" && block.call.id === call.id,
      )
      expect(persisted).toMatchObject({ kind: "tool_call", call: stableLive })
    }
  })
})
