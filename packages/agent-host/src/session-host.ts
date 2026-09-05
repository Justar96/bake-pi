import { statSync } from "node:fs"
import {
  BakePiError,
  type ApprovalRequest,
  type ContentBlock,
  type ModelSelection,
  type QueuedPrompt,
  type SessionSnapshot,
  type SessionStatus,
  type SessionSummary,
  type SessionUsage,
  type ToolCall,
  type TrustLevel,
} from "@bake-pi/contract"
import type { AgentSessionEvent, AgentSessionRuntime } from "@earendil-works/pi-coding-agent"
import type { Diagnostics } from "./diagnostics.ts"
import type { EventEmitter } from "./emitter.ts"
import {
  assistantStatus,
  messageIdAt,
  projectMessage,
  projectMessages,
  projectToolCall,
  tokenUsageOf,
  toolOutputText,
} from "./mapping/messages.ts"
import { titleFor } from "./session/discovery.ts"
import {
  changedSince,
  fingerprintSession,
  type SessionLock,
  type WriteFingerprint,
} from "./session/ownership.ts"
import type { ToolMarker } from "./session/tool-marker.ts"
import { toolResultStatus } from "./tool-outcome.ts"
import { projectTodoState } from "./mapping/todo.ts"

/**
 * One event from Pi's assistant stream, derived from the session event that
 * carries it. The type is declared in `@earendil-works/pi-ai`, which is not a
 * package this workspace depends on directly; narrowing Pi's own union keeps the
 * shape exact without naming a second package.
 */
type AssistantStreamEvent = Extract<AgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"]

export interface SessionHostOptions {
  runtime: AgentSessionRuntime
  emitter: EventEmitter
  diagnostics: Diagnostics
  workspaceId: string
  workspaceRoot: string
  trust: TrustLevel
  /**
   * Held for as long as this host owns the session file, and released on
   * dispose. Undefined when the session is not persisted, in which case there is
   * no file for anyone to contend over.
   */
  lock?: SessionLock
  /**
   * Written before each tool runs and removed when it ends, so a host that dies
   * mid-tool leaves the one piece of evidence main cannot gather for itself.
   * See `session/tool-marker.ts`. Undefined for the same reason `lock` is: an
   * unpersisted session has no file to put a marker beside.
   */
  toolMarker?: ToolMarker
  /** Read at snapshot time: approval state changes while the session object stays the same. */
  pendingApprovals?: (sessionId: string) => readonly ApprovalRequest[]
}

/**
 * One Pi session, projected onto the contract.
 *
 * The single subtlety worth stating: Pi replaces the live `AgentSession` object
 * on new-session, switch, fork, clone and import, and subscriptions are bound to
 * a specific `AgentSession`. So every replacement has to re-subscribe and emit a
 * fresh snapshot. Forgetting the re-subscribe does not throw — it produces a
 * session that renders correctly and then goes permanently silent, which is the
 * hardest kind of bug to attribute after the fact.
 */
export class SessionHost {
  readonly #options: SessionHostOptions
  #unsubscribe: (() => void) | undefined
  #status: SessionStatus = "idle"
  /**
   * The queue as last projected, rather than as Pi's two arrays.
   *
   * Pi's queue is a list of strings: no identity, no arrival time. Minting both
   * from the position on every read gave every entry a new `queuedAt` each time
   * a snapshot was taken, and shifted every id down by one whenever the head was
   * delivered — so a renderer keyed on them would animate the wrong rows and
   * show a wait that resets itself. Held here instead, an entry keeps the id and
   * the time it got when this host first saw it, for as long as it waits.
   */
  #queue: QueuedPrompt[] = []
  #queueSequence = 0
  #fingerprint: WriteFingerprint | undefined
  /** What the renderer was last told is selected, so an unchanged selection emits nothing. */
  #lastSelection: ModelSelection
  /**
   * The assistant message this host last saw finish, by contract id.
   *
   * `turn_end` and every tool call after the first need it, and neither can
   * compute it: Pi appends the turn's tool results *after* the assistant
   * message, so the last entry in history at those moments is a tool result
   * rather than the message the turn produced. Addressing the turn by index
   * would settle the wrong message and hang each tool card off the wrong one —
   * silently, because both ids are real.
   */
  #lastAssistantMessageId: string | undefined
  /**
   * Tool calls Pi has started and not yet finished. An update then reports the
   * same call rather than a second one, and carries the targets that were
   * resolved once at the start.
   */
  readonly #activeToolCalls = new Map<string, ToolCall>()
  /** The last usage announced, so an unchanged total emits nothing. */
  #lastUsage: SessionUsage | undefined
  /** History length when compaction began, so what compaction removed can be counted. */
  #messagesBeforeCompaction: number | undefined
  /** The status a summarization retry interrupted, restored when the retry ends. */
  #statusBeforeSummarizationRetry: SessionStatus | undefined
  /** When this host opened the session, used only while there is no file to read it from. */
  readonly #openedAt = Date.now()

  constructor(options: SessionHostOptions) {
    this.#options = options
    this.#recordWrites()
    this.#lastSelection = this.modelSelection()
  }

  get sessionFile(): string | undefined {
    return this.#options.runtime.session.sessionFile ?? undefined
  }

  /**
   * Refuses the mutation if anyone else has written this session file since we
   * last looked.
   *
   * This is the half of `INT-001` a lock cannot cover. The Pi CLI does not
   * consult Bake Pi's lock and never will, and `durability.test.ts` measured
   * what happens when both write: no error, no corruption, and one writer's
   * turns silently stop being part of the session, because each manager appends
   * onto the leaf it remembers. Refusing here is what turns that into something
   * a user can be told.
   *
   * The window is one turn wide, not zero. Between this check and Pi's append
   * another writer can still land, and no amount of checking closes that against
   * a program that takes no lock. Narrowing it to a turn is the strongest claim
   * available, and it is the claim made — not that concurrent writes are
   * impossible.
   */
  assertSoleWriter(): void {
    const file = this.sessionFile
    if (file === undefined || this.#fingerprint === undefined) return
    // A turn of ours is appending right now — the prompt that opened it, and an
    // entry per tool call after that — and the fingerprint cannot tell those
    // from someone else's append. The question is unanswerable mid-turn, so it
    // is not answered: steering and following up are exactly the commands that
    // arrive here while a turn is in flight, and accusing the user of being a
    // second writer for the message they just queued is the wrong answer to
    // give when no answer is available. The baseline is re-recorded on
    // `agent_settled` either way, so the boundary check is unchanged.
    if (!this.#options.runtime.session.isIdle) return

    const current = fingerprintSession(file)
    // The file could not be read at all — not that it is missing, which
    // fingerprints as empty, but that opening it failed. Nothing about that
    // says another process wrote, so nothing about it is refused.
    if (current === undefined) return

    if (changedSince(this.#fingerprint, current)) {
      // Deliberately not resynced away: re-reading and continuing is exactly how
      // the fork happens. The session stops accepting mutations until someone
      // decides what to keep.
      throw new BakePiError("session_busy", { detail: "written by another process", retryable: false })
    }
  }

  /**
   * Re-records the file's identity after a mutation this host made outside a
   * turn.
   *
   * A turn re-records itself on `agent_settled`, which covers prompting. Model
   * and thinking-level changes append to the session file too, and they happen
   * between turns where no `agent_settled` is coming — so without this the next
   * prompt would find the file moved and refuse our own write as a foreign one.
   */
  recordWrites(): void {
    this.#recordWrites()
  }

  /**
   * Re-records the file's identity after our own writes, so they are not
   * mistaken for someone else's on the next prompt.
   */
  #recordWrites(): void {
    const file = this.sessionFile
    // Undefined either way — no file to compare against, or a file we could not
    // read — and the guard abstains on both. A baseline we are not sure of is
    // the one thing worse than no baseline: it accuses on the next mutation.
    this.#fingerprint = file === undefined ? undefined : fingerprintSession(file)
  }

  get sessionId(): string {
    return this.#options.runtime.session.sessionId
  }

  get workspaceId(): string {
    return this.#options.workspaceId
  }

  get workspaceRoot(): string {
    return this.#options.workspaceRoot
  }

  /**
   * The live Pi session. It is a getter and never a stored reference, because
   * Pi replaces the object on new-session, switch, fork, clone and import — a
   * caller holding the old one would be driving a session that no longer exists.
   */
  get session(): AgentSessionRuntime["session"] {
    return this.#options.runtime.session
  }

  get trust(): TrustLevel {
    return this.#options.trust
  }

  /**
   * What model this session is on, as Pi reports it right now.
   *
   * `thinkingLevel` is read back rather than remembered because Pi clamps: a
   * request for `max` against a model that stops at `high` leaves the session at
   * `high`, and reporting the request instead of the result would put a level in
   * the UI that nothing is running at.
   */
  modelSelection(): ModelSelection {
    const session = this.#options.runtime.session
    return {
      modelId: session.model?.id ?? "",
      providerId: session.model?.provider ?? "",
      thinkingLevel: session.thinkingLevel,
      availableThinkingLevels: session.getAvailableThinkingLevels(),
    }
  }

  /**
   * Emits `model_changed`, and only when something changed.
   *
   * Both halves of a model switch reach here: Pi emits `thinking_level_changed`
   * from inside `setModel`, and `setModel` itself emits no session event at all,
   * so the command has to announce it. Left undeduplicated that is two events
   * for one switch — harmless to a reducer and confusing in a log — and a
   * clamped thinking level that lands on the value already in force is one event
   * for no change.
   */
  emitModelChanged(): void {
    const selection = this.modelSelection()
    if (sameSelection(selection, this.#lastSelection)) return
    this.#lastSelection = selection
    this.#options.emitter.emit("model_changed", { selection }, this.sessionId)
  }

  /** Subscribes to the current `AgentSession` and returns the authoritative snapshot. */
  attach(): SessionSnapshot {
    this.#resubscribe()
    return this.snapshot()
  }

  /**
   * Call after any operation that replaces the runtime's session. Re-subscribes
   * and re-fences: the new session's history is not the old one's, so the
   * renderer needs a snapshot with a reset sequence rather than a continuation.
   */
  resync(reason: "replacement" | "gap" | "reconnect"): SessionSnapshot {
    this.#resubscribe()
    // History was renumbered or replaced, so a remembered message id now names
    // a different message. Forgetting it falls back to the current history,
    // which is at least computed from what exists.
    this.#lastAssistantMessageId = undefined
    this.#options.emitter.resetSession(this.sessionId)
    const snapshot = this.snapshot(reason === "gap")
    this.#options.emitter.emit("session_snapshot", { snapshot }, this.sessionId)
    return snapshot
  }

  snapshot(afterGap = false): SessionSnapshot {
    const session = this.#options.runtime.session
    const approvals = [...(this.#options.pendingApprovals?.(this.sessionId) ?? [])]
    return {
      // Taken *at* the current sequence: the renderer discards everything at or
      // below this and applies only what arrives after.
      sequence: this.#options.emitter.sequenceFor(this.sessionId),
      summary: this.summary(),
      status: approvals.length > 0 ? "awaiting_approval" : this.#status,
      messages: projectMessages(session.messages, {
        workspaceRoot: this.#options.workspaceRoot,
        // Images are addressed within a session, so the projection needs to
        // know which one it is projecting. Every URL in this snapshot resolves
        // against the history it was taken from, which is the same lifetime
        // the message ids already have.
        sessionId: this.sessionId,
        pendingApprovals: approvals,
      }),
      queue: [...this.#queue],
      approvals,
      model: this.modelSelection(),
      usage: this.usage(),
      afterGap,
    }
  }

  /**
   * What the session has spent, as Pi accounts for it.
   *
   * Read from `getSessionStats`, which sums the persisted entries rather than
   * the live message array — so a reopened session reports the whole history's
   * cost and not just this host's turns. The figures were hard-coded zeroes
   * until now, which is worse than absent: a usage panel built on them would
   * have shown a session that never costs anything.
   */
  usage(): SessionUsage {
    const stats = this.#options.runtime.session.getSessionStats()
    const context = stats.contextUsage
    return {
      // Pi counts assistant messages; a turn is one assistant response, and
      // there is no separate turn counter to prefer over it.
      turnCount: whole(stats.assistantMessages),
      total: {
        inputTokens: whole(stats.tokens.input),
        outputTokens: whole(stats.tokens.output),
        cacheReadTokens: whole(stats.tokens.cacheRead),
        cacheWriteTokens: whole(stats.tokens.cacheWrite),
      },
      totalCostUsd: Math.max(0, stats.cost),
      // `tokens` is null exactly when Pi cannot know it — right after
      // compaction, before the next response. Omitted rather than sent as zero,
      // because a context meter reading empty is a claim, and a missing one is
      // not.
      ...(context === undefined || context.tokens === null || context.contextWindow <= 0
        ? {}
        : { context: { usedTokens: whole(context.tokens), maxTokens: whole(context.contextWindow) } }),
    }
  }

  summary(): SessionSummary {
    const session = this.#options.runtime.session
    const times = fileTimes(session.sessionFile)
    return {
      id: session.sessionId,
      workspaceId: this.#options.workspaceId,
      // Derived from the conversation rather than from the file path, so a live
      // session that has not reached disk is named the same way a discovered one
      // is. `list_sessions` prefers the on-disk summary when there is one; this
      // is what a session looks like before there is.
      title: titleFor({ firstMessage: this.#openingMessage() }),
      // The session file is the only record of when a session began, and it
      // outlives this host — a reopened session that reported "created now"
      // would sort to the top of the rail every time it was opened. Both fall
      // back to this host's own clock only while there is no file yet, which is
      // an ordinary state: Pi writes nothing until an assistant message exists.
      createdAt: times?.createdAt ?? this.#openedAt,
      updatedAt: times?.updatedAt ?? this.#openedAt,
      messageCount: session.messages.length,
      path: session.sessionFile ?? this.#options.workspaceRoot,
    }
  }

  /** The first thing the user said, which is the only description a session has of its own. */
  #openingMessage(): string | undefined {
    for (const message of this.#options.runtime.session.messages) {
      if (message.role !== "user") continue
      const content = message.content
      let text: string
      if (typeof content === "string") {
        text = content
      } else {
        text = content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(" ")
      }
      if (text.length > 0) return text
    }
    return undefined
  }

  dispose(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
    // An orderly shutdown is not an interruption, even one that arrives while a
    // tool is running: the marker is for a crash, and a close that leaves one
    // behind would warn about a tool the user themselves stopped.
    this.#clearActiveToolCalls()
    this.#options.emitter.forgetSession(this.sessionId)
    this.#options.runtime.session.dispose()
    // Last, and unconditionally: a lock outliving its host is a session no other
    // host may open until the stale-holder check reclaims it.
    this.#options.lock?.release()
  }

  /**
   * Re-projects Pi's queue, reusing the entry an unchanged prompt already had.
   *
   * Matched by text and consumed as it matches, so two identical prompts stay
   * two entries rather than collapsing into one.
   */
  #projectQueue(steering: readonly string[], followUp: readonly string[]): QueuedPrompt[] {
    const previous = [...this.#queue]
    const project = (text: string, mode: QueuedPrompt["mode"]): QueuedPrompt => {
      const index = previous.findIndex((entry) => entry.text === text && entry.mode === mode)
      if (index !== -1) return previous.splice(index, 1)[0]!
      this.#queueSequence += 1
      return { id: `q${String(this.#queueSequence)}`, text, mode, queuedAt: Date.now() }
    }
    this.#queue = [
      ...steering.map((text) => project(text, "steer")),
      ...followUp.map((text) => project(text, "follow_up")),
    ]
    return [...this.#queue]
  }

  #resubscribe(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = this.#options.runtime.session.subscribe((event) => {
      try {
        this.#onPiEvent(event)
      } catch (error) {
        // A mapping bug must not tear down the session. It is recorded and the
        // stream continues; the next snapshot repairs whatever the renderer
        // missed.
        this.#options.diagnostics.capture("session.event", error)
      }
    })
  }

  /**
   * Every event Pi can emit on a session, and what each becomes.
   *
   * `mapping/coverage.ts` is the report: it is keyed by Pi's own event union, so
   * an event added upstream fails the build there rather than falling through
   * here, and `coverage.test.ts` drives a fixture for every entry against this
   * method. The cases below carry the reasoning; the table carries the promise.
   */
  #onPiEvent(event: AgentSessionEvent): void {
    const emit = this.#options.emitter
    const sessionId = this.sessionId
    const session = this.#options.runtime.session

    switch (event.type) {
      case "agent_start":
        this.#setStatus("streaming")
        break

      case "agent_end":
        // Deliberately nothing. The loop has stopped emitting, which is not the
        // same as the session being idle: a retry or a queued follow-up can
        // continue straight after it, and `agent_settled` is the event that
        // means what this one looks like it means.
        break

      case "agent_settled":
        this.#setStatus("idle")
        // The turn is over and every write it made has landed, so this is the
        // file state our next prompt must compare against. Recording anywhere
        // earlier would leave our own appends looking foreign.
        this.#recordWrites()
        // A tool call still open here never ended — an abort, a host error —
        // and holding its description would leak one entry per abandoned call.
        // Same reasoning applied to disk. The turn is over, so nothing this host
        // started is still running, and a marker left behind now would be read
        // as an interruption by whatever opens the session next.
        this.#clearActiveToolCalls()
        break

      case "turn_start":
        // The id the turn's first message will take. It is not necessarily the
        // assistant's: a turn injects queued steering messages before the model
        // answers, and each of those is a message of this turn.
        emit.emit("turn_started", { messageId: messageIdAt(session.messages.length) }, sessionId)
        break

      case "turn_end": {
        const message = event.message
        const usage = message.role === "assistant" ? tokenUsageOf(message.usage) : undefined
        emit.emit(
          "turn_settled",
          {
            messageId: this.#assistantMessageId(),
            // Read from the message rather than assumed. Reporting `complete`
            // for every turn described an aborted turn and a provider failure
            // as successes.
            status: message.role === "assistant" ? assistantStatus(message) : "complete",
            ...(usage === undefined ? {} : { usage }),
          },
          sessionId,
        )
        this.#emitUsage()
        break
      }

      case "message_start":
        // The streaming message is not yet in `session.messages` — Pi appends it
        // on `message_end` — so its index is the current length, which is
        // exactly where it will land.
        emit.emit(
          "message_added",
          {
            message: projectMessage(event.message, session.messages.length, {
              workspaceRoot: this.#options.workspaceRoot,
              // A prompt's own attachments arrive on this path, so an image
              // that only got its URL from `snapshot()` would render as a
              // filename until the next resync.
              sessionId,
            }),
          },
          sessionId,
        )
        break

      case "message_update":
        this.#onAssistantStreamEvent(event.assistantMessageEvent, messageIdAt(session.messages.length))
        break

      case "message_end": {
        // Pi appended the message before this listener ran, so it is the last
        // one in history.
        const messageId = messageIdAt(Math.max(session.messages.length - 1, 0))
        if (event.message.role !== "assistant") {
          // A user or tool-result message arrived complete at `message_start`;
          // there is nothing here that the renderer does not already hold.
          break
        }
        this.#lastAssistantMessageId = messageId
        // The authoritative version of what was streamed. Re-emitting each
        // block finished repairs a delta the renderer dropped and is where
        // redacted reasoning gets its flag: the stream events do not carry it,
        // so a reasoning block is only honest about redaction once the message
        // is complete.
        for (const block of projectMessage(event.message, session.messages.length - 1, {
          workspaceRoot: this.#options.workspaceRoot,
        }).blocks) {
          if (block.kind !== "text" && block.kind !== "reasoning") continue
          emit.emit("block_finished", { messageId, block }, sessionId)
        }
        break
      }

      case "tool_execution_start": {
        const call = this.#describeToolCall(event.toolCallId, event.toolName, event.args)
        // Before the event goes out, and therefore before anything downstream
        // can await. This is the earliest in-process moment the host learns a
        // tool is about to run, and the marker is worth only as much as the
        // width of the window it covers.
        this.#options.toolMarker?.begin({
          toolCallId: call.id,
          toolName: call.name,
          startedAt: call.startedAt ?? Date.now(),
          targets: call.targets.map((target) => target.path),
        })
        emit.emit("tool_call_started", { messageId: this.#assistantMessageId(), call }, sessionId)
        break
      }

      case "tool_execution_update": {
        const call = this.#describeToolCall(event.toolCallId, event.toolName, event.args)
        const partial = toolOutputText(event.partialResult)
        emit.emit(
          "tool_call_updated",
          // Pi reports the output so far as a cumulative snapshot, so this
          // replaces the previous partial rather than appending to it. The tail
          // is kept when it overflows: the newest output is the part anyone
          // watching a running command is watching for.
          { call: { ...call, partialOutput: partial.slice(-MAX_PARTIAL_OUTPUT) } },
          sessionId,
        )
        break
      }

      case "tool_execution_end": {
        this.#activeToolCalls.delete(event.toolCallId)
        this.#options.toolMarker?.end(event.toolCallId)
        const output = toolOutputText(event.result)
        const todo = projectTodoState(event.toolName, (event.result as { details?: unknown } | undefined)?.details)
        emit.emit(
          "tool_call_finished",
          {
            result: {
              toolCallId: event.toolCallId,
              status: toolResultStatus(event.isError, output),
              output: output.slice(0, MAX_TOOL_OUTPUT),
              truncated: output.length > MAX_TOOL_OUTPUT,
              ...(todo === undefined ? {} : { todo }),
            },
          },
          sessionId,
        )
        break
      }

      case "queue_update":
        emit.emit("queue_changed", { queue: this.#projectQueue(event.steering, event.followUp) }, sessionId)
        break

      case "compaction_start":
        // Counted here because Pi's compaction result reports tokens and a
        // kept-entry id but no message count, and the renderer's unit is
        // messages.
        this.#messagesBeforeCompaction = session.messages.length
        this.#setStatus("compacting")
        emit.emit("compaction_started", {}, sessionId)
        break

      case "compaction_end": {
        const before = this.#messagesBeforeCompaction
        this.#messagesBeforeCompaction = undefined
        // `willRetry` is about the *turn*, not about compaction: it means
        // compaction ran to recover from an overflow and the agent is about to
        // try the turn again. Reporting idle there would show a finished turn
        // in the middle of one.
        this.#setStatus(event.willRetry ? "streaming" : "idle")
        emit.emit(
          "compaction_finished",
          { removedMessages: before === undefined ? 0 : Math.max(0, before - session.messages.length) },
          sessionId,
        )
        // Compaction rewrites history, so an incremental repair is not possible;
        // the projection is replaced instead.
        this.resync("replacement")
        break
      }

      case "entry_appended":
        // Every append to the session file, including the ones this host just
        // made. Not used: the projection is built from messages and lifecycle
        // events, and re-recording the write fingerprint here would fold a
        // foreign append made mid-turn into our own baseline — which is exactly
        // the write the guard exists to refuse.
        break

      case "auto_retry_start":
        this.#setStatus("retrying")
        emit.emit(
          "retry_scheduled",
          { attempt: Math.max(1, event.attempt), delayMs: Math.max(0, event.delayMs), reason: reasonOf(event.errorMessage) },
          sessionId,
        )
        break

      case "auto_retry_end":
        this.#setStatus(event.success ? "streaming" : "idle")
        break

      case "summarization_retry_scheduled":
        // Compaction and branch summarization make their own model calls and
        // retry on the same budget a turn does. A user watching a stalled
        // compaction is owed the same explanation as one watching a stalled turn.
        this.#statusBeforeSummarizationRetry ??= this.#status
        this.#setStatus("retrying")
        emit.emit(
          "retry_scheduled",
          { attempt: Math.max(1, event.attempt), delayMs: Math.max(0, event.delayMs), reason: reasonOf(event.errorMessage) },
          sessionId,
        )
        break

      case "summarization_retry_attempt_start":
        // Restored rather than assumed. These retries fire under compaction and
        // under branch summarization, and only the first of those was
        // compacting — so there is no single status to return to.
        this.#restoreStatusAfterSummarizationRetry(false)
        break

      case "summarization_retry_finished":
        this.#restoreStatusAfterSummarizationRetry(true)
        break

      case "bash_execution_update":
        // Output from `AgentSession.executeBash`, the CLI's own bang-command
        // path. Bake Pi never calls it — an integrated terminal is outside v1 —
        // so this cannot arise from anything the interface offers. Bash run as a
        // *tool* streams through `tool_execution_update`, which is mapped.
        break

      case "thinking_level_changed":
        // The event carries the level, but the selection is read from the
        // session rather than built from it: a level change that arrived from
        // inside `setModel` is also a model change, and an event naming the new
        // level beside the old model would describe a state that never existed.
        this.emitModelChanged()
        break

      case "session_info_changed":
        emit.emit("session_summary_changed", { summary: this.summary() }, sessionId)
        break

      default:
        // Unreachable against the pinned Pi: `PI_EVENT_COVERAGE` is keyed by
        // Pi's event union, so a new member fails the build there long before
        // it reaches here. This is the case the compiler cannot see — a Pi
        // upgrade at runtime — and recording it beats both ignoring it and
        // throwing inside a subscription.
        this.#options.diagnostics.record("warn", "session.event", `unmapped pi event: ${describeEvent(event)}`)
        break
    }
  }

  /**
   * One event from Pi's assistant stream.
   *
   * Split out because the shapes are unrelated to the session-level events
   * around them, and because the omission below deserves to be stated once
   * rather than buried in a nested default.
   */
  #onAssistantStreamEvent(inner: AssistantStreamEvent, messageId: string): void {
    const emit = this.#options.emitter
    const sessionId = this.sessionId

    switch (inner.type) {
      case "text_start":
      case "thinking_start":
        emit.emit("block_started", { messageId, block: emptyBlockFor(inner.type, inner.contentIndex) }, sessionId)
        break

      case "text_delta":
      case "thinking_delta":
        emit.emit("block_delta", { messageId, blockIndex: inner.contentIndex, textDelta: inner.delta }, sessionId)
        break

      case "text_end":
        emit.emit("block_finished", { messageId, block: { index: inner.contentIndex, kind: "text", text: inner.content } }, sessionId)
        break

      case "thinking_end":
        emit.emit(
          "block_finished",
          // `redacted` is not in the stream event. It is false here and correct
          // on `message_end`, which re-emits the block from the finished
          // message — the only place the flag exists.
          { messageId, block: { index: inner.contentIndex, kind: "reasoning", text: inner.content, redacted: false } },
          sessionId,
        )
        break

      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end":
        // Nothing, and this is the contract's rule rather than an omission: a
        // half-parsed tool call is not something the renderer should ever hold.
        // The complete call reaches it through `tool_call_started`, which Pi
        // emits for every call — including one that is about to be denied — and
        // which carries the resolved targets and a status that reflects what
        // actually happened. A block synthesized from the assistant message
        // would carry neither and would have to invent an outcome for a call
        // that has not run.
        break

      case "start":
      case "done":
      case "error":
        // Consumed by Pi's own loop, which turns them into `message_start` and
        // `message_end`. Present in the type, never forwarded.
        break
    }
  }

  /** The message a tool call or a settled turn belongs to. */
  #assistantMessageId(): string {
    return (
      this.#lastAssistantMessageId ?? messageIdAt(Math.max(this.#options.runtime.session.messages.length - 1, 0))
    )
  }

  /**
   * The tool call as it was described when it started, or a fresh description
   * if this host never saw it start.
   *
   * Targets are resolved the same way the approval gate resolves them, by the
   * same functions, so the tool card in the timeline and the approval card
   * describe one tool call identically. A card that showed no targets for a
   * write would be stating something false about what ran.
   */
  #describeToolCall(id: string, name: string, args: unknown): ToolCall {
    const remembered = this.#activeToolCalls.get(id)
    if (remembered !== undefined) return remembered

    const call = projectToolCall(id, name, args, this.#options.workspaceRoot, "running", Date.now())
    this.#activeToolCalls.set(id, call)
    return call
  }

  /** Clears the in-memory and on-disk views of tools this host still owns. */
  #clearActiveToolCalls(): void {
    this.#activeToolCalls.clear()
    this.#options.toolMarker?.clear()
  }

  #restoreStatusAfterSummarizationRetry(finished: boolean): void {
    const restored = this.#statusBeforeSummarizationRetry
    if (finished) this.#statusBeforeSummarizationRetry = undefined
    if (restored !== undefined) this.#setStatus(restored)
  }

  /** Announces session usage, and only when a figure changed. */
  #emitUsage(): void {
    const usage = this.usage()
    // Compared as JSON because both sides are built by `usage()` from the same
    // literal, so key order is fixed. A field-by-field comparison here would be
    // one more thing to forget to extend.
    if (this.#lastUsage !== undefined && JSON.stringify(usage) === JSON.stringify(this.#lastUsage)) return
    this.#lastUsage = usage
    this.#options.emitter.emit("usage_changed", { usage }, this.sessionId)
  }

  #setStatus(status: SessionStatus): void {
    if (this.#status === status) return
    this.#status = status
    this.#options.emitter.emit("session_status_changed", { status }, this.sessionId)
  }
}

const sameSelection = (a: ModelSelection, b: ModelSelection): boolean =>
  a.modelId === b.modelId &&
  a.providerId === b.providerId &&
  a.thinkingLevel === b.thinkingLevel &&
  a.availableThinkingLevels.length === b.availableThinkingLevels.length &&
  a.availableThinkingLevels.every((level, index) => level === b.availableThinkingLevels[index])

const emptyBlockFor = (type: "text_start" | "thinking_start", index: number): ContentBlock =>
  type === "text_start"
    ? { index, kind: "text", text: "" }
    : { index, kind: "reasoning", text: "", redacted: false }

/** The contract's ceilings, applied where the text is produced rather than trusted. */
const MAX_TOOL_OUTPUT = 262_144
const MAX_PARTIAL_OUTPUT = 65_536
const MAX_RETRY_REASON = 256

/**
 * A provider's error text, trimmed to what the contract carries.
 *
 * It reaches the renderer because a retry the user cannot see the cause of is
 * indistinguishable from a hang. It is provider text rather than ours, so it is
 * bounded here and rendered as text there.
 */
const reasonOf = (message: string): string => message.slice(0, MAX_RETRY_REASON)

/** For the diagnostic on an event this build does not know about. */
const describeEvent = (event: unknown): string => {
  const type = (event as { type?: unknown } | null)?.type
  return typeof type === "string" ? type.slice(0, 64) : "(no type)"
}

/**
 * When the session began and when it was last written, from the file itself.
 *
 * `birthtimeMs` is not available on every filesystem — it reads as 0, or as the
 * modification time — so it falls back rather than reporting 1970. A session
 * with no file yet has no times to read, which is an ordinary state: Pi writes
 * nothing until an assistant message exists.
 */
const fileTimes = (file: string | undefined): { createdAt: number; updatedAt: number } | undefined => {
  if (file === undefined) return undefined
  try {
    const stats = statSync(file)
    const updatedAt = whole(stats.mtimeMs)
    return { createdAt: stats.birthtimeMs > 0 ? whole(stats.birthtimeMs) : updatedAt, updatedAt }
  } catch {
    // The file was removed or is unreadable. The summary still has to render,
    // and the caller's fallback is a real time rather than a wrong one.
    return undefined
  }
}

/** The contract's counters are non-negative integers; Pi's are numbers. */
const whole = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0)
