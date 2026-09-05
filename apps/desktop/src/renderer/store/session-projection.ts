import type {
  ApprovalRequest,
  EventName,
  EventPayload,
  Message,
  SessionEventName,
  SessionSnapshot,
  TodoState,
  ToolCall,
  ToolResult,
} from "@bake-pi/contract"
import {
  completedTimelineRows,
  type CompletedTimelineRow,
  sameRefs,
  streamingModelSwitch,
  type ToolLookup,
} from "../features/conversation/timeline-projection.ts"
import { currentTodoState } from "../features/conversation/todo-state.ts"
import { callIndexesFor, indexesFor, type SessionNotice, type SessionState, initialState, reduce } from "./reducers/session.ts"
import { MutableView, type ReadableView } from "./readable-view.ts"

export interface SessionCoreSnapshot extends Omit<SessionSnapshot, "messages" | "approvals"> {
  messageCount: number
  approvalCount: number
}

export interface SessionCore {
  snapshot: SessionCoreSnapshot
}

export interface SessionTimelineView {
  sessionId: string
  rows: CompletedTimelineRow[]
  active: Message | undefined
  /** The model a streaming turn switched to, when it differs from the last settled turn. */
  activeModelSwitch: string | undefined
  calls: ToolLookup<ToolCall>
  results: ToolLookup<ToolResult>
  gap: boolean
  notice: SessionNotice | undefined
}

export interface SessionActivityView {
  usage: SessionSnapshot["usage"]
  calls: ToolCall[]
}

export interface SessionViews {
  core: SessionCore
  timeline: SessionTimelineView
  activity: SessionActivityView
  approvals: ApprovalRequest[]
  todo: TodoState | undefined
}

/**
 * One session's indexed, disposable renderer projection.
 *
 * Pi's snapshot remains authoritative. Installing one replaces the reducer
 * state and rebuilds every address table and derived view. Between snapshots,
 * named views publish only when the part they expose changes: a text delta
 * therefore cannot wake the workbench chrome, activity, approvals, or todo.
 */
export class SessionProjection {
  #state: SessionState
  readonly #calls = new Map<string, ToolCall>()
  readonly #results = new Map<string, ToolResult>()
  readonly #messageCalls = new Map<string, Set<string>>()
  readonly #messageResults = new Map<string, Set<string>>()
  #callOrder: string[] = []
  #activeMessageId: string | undefined
  readonly #callLookup: ToolLookup<ToolCall> = { get: (id) => this.#calls.get(id) }
  readonly #resultLookup: ToolLookup<ToolResult> = { get: (id) => this.#results.get(id) }
  readonly #views: { [K in keyof SessionViews]: MutableView<SessionViews[K]> }

  constructor(snapshot: SessionSnapshot) {
    this.#state = initialState(snapshot)
    this.#rebuildIndexes()
    this.#views = {
      core: new MutableView(coreOf(this.#state)),
      timeline: new MutableView(this.#timeline(true)),
      activity: new MutableView(this.#activity()),
      approvals: new MutableView(snapshot.approvals),
      todo: new MutableView(currentTodoState(snapshot.messages)),
    }
  }

  view<K extends keyof SessionViews>(name: K): ReadableView<SessionViews[K]> {
    return this.#views[name]
  }

  state(): SessionState {
    return this.#state
  }

  apply<N extends EventName>(name: N, payload: EventPayload<N>): void {
    const before = this.#state
    const affectedMessageId = this.#affectedMessage(name, payload, before)
    const next = reduce(before, name, payload)
    if (next === before) return
    this.#state = next

    if (name === "session_snapshot") {
      this.#rebuildIndexes()
      this.#publishAll()
      return
    }

    const touched = touchedBy(name)

    if (name === "message_added") {
      const { message } = payload as EventPayload<"message_added">
      if (message.status === "streaming") this.#activeMessageId = message.id
      this.#reindexMessage(message.id)
    } else if (affectedMessageId !== undefined && touched.messageContents) {
      this.#reindexMessage(affectedMessageId)
    }

    if (name === "turn_settled" && affectedMessageId === this.#activeMessageId) this.#findActiveMessage()

    if (touched.core) this.#views.core.publish(coreOf(next))
    if (touched.timeline) {
      const rebuildRows = completedRowsMayHaveChanged(name, affectedMessageId, next, indexesFor(next.snapshot.messages))
      this.#views.timeline.publish(this.#timeline(rebuildRows, this.#views.timeline.getSnapshot().rows))
    }
    if (touched.activity) this.#publishActivity()
    if (touched.approvals) this.#views.approvals.publish(next.snapshot.approvals)
    if (touched.todo) this.#views.todo.publish(currentTodoState(next.snapshot.messages))
  }

  disconnect(): void {
    if (this.#state.snapshot.status === "disconnected") return
    this.#state = {
      ...this.#state,
      snapshot: { ...this.#state.snapshot, status: "disconnected" },
    }
    this.#views.core.publish(coreOf(this.#state))
  }

  #publishAll(): void {
    this.#views.core.publish(coreOf(this.#state))
    this.#views.timeline.publish(this.#timeline(true))
    this.#views.activity.publish(this.#activity())
    this.#views.approvals.publish(this.#state.snapshot.approvals)
    this.#views.todo.publish(currentTodoState(this.#state.snapshot.messages))
  }

  /**
   * `previousRows` is passed rather than read back off the view, because the
   * constructor builds the first timeline while `#views` is still being
   * assembled. Reaching into the view there meant an optional chain on a
   * non-optional field, which defeated the type on every later call to cover
   * one ordering quirk in the constructor.
   */
  #timeline(rebuildRows: boolean, previousRows?: CompletedTimelineRow[]): SessionTimelineView {
    return {
      sessionId: this.#state.snapshot.summary.id,
      rows: rebuildRows || previousRows === undefined
        ? completedTimelineRows(this.#state.snapshot.messages, previousRows)
        : previousRows,
      active: this.#activeMessage(),
      activeModelSwitch: streamingModelSwitch(this.#state.snapshot.messages, this.#state.snapshot.model.modelId),
      calls: this.#callLookup,
      results: this.#resultLookup,
      gap: this.#state.gap,
      notice: this.#state.notice,
    }
  }

  #activity(): SessionActivityView {
    return {
      usage: this.#state.snapshot.usage,
      calls: this.#callOrder.flatMap((id) => {
        const call = this.#calls.get(id)
        return call === undefined ? [] : [call]
      }),
    }
  }

  #activeMessage(): Message | undefined {
    if (this.#activeMessageId === undefined) return undefined
    const index = indexesFor(this.#state.snapshot.messages).get(this.#activeMessageId)
    return index === undefined ? undefined : this.#state.snapshot.messages[index]
  }

  #findActiveMessage(): void {
    this.#activeMessageId = undefined
    for (let index = this.#state.snapshot.messages.length - 1; index >= 0; index -= 1) {
      const message = this.#state.snapshot.messages[index]!
      if (message.status !== "streaming") continue
      this.#activeMessageId = message.id
      return
    }
  }

  #publishActivity(): void {
    const previous = this.#views.activity.getSnapshot()
    const next = this.#activity()
    if (previous.usage === next.usage && sameRefs(previous.calls, next.calls)) return
    this.#views.activity.publish(next)
  }

  #affectedMessage<N extends EventName>(name: N, payload: EventPayload<N>, before: SessionState): string | undefined {
    if (name === "message_added") return (payload as EventPayload<"message_added">).message.id
    if (name === "block_started" || name === "block_delta" || name === "block_finished") {
      return (payload as EventPayload<"block_started">).messageId
    }
    if (name === "tool_call_started") return (payload as EventPayload<"tool_call_started">).messageId
    if (name === "tool_call_updated") return ownerOf(before, (payload as EventPayload<"tool_call_updated">).call.id)
    if (name === "tool_call_finished") return ownerOf(before, (payload as EventPayload<"tool_call_finished">).result.toolCallId)
    if (name === "turn_settled") return (payload as EventPayload<"turn_settled">).messageId
    if (name === "approval_requested") return ownerOf(before, (payload as EventPayload<"approval_requested">).request.call.id)
    if (name === "approval_resolved") {
      const requestId = (payload as EventPayload<"approval_resolved">).requestId
      const request = before.snapshot.approvals.find((approval) => approval.id === requestId)
      return request === undefined ? undefined : ownerOf(before, request.call.id)
    }
    return undefined
  }

  #rebuildIndexes(): void {
    this.#calls.clear()
    this.#results.clear()
    this.#messageCalls.clear()
    this.#messageResults.clear()
    this.#callOrder = []
    this.#activeMessageId = undefined
    for (const message of this.#state.snapshot.messages) {
      if (message.status === "streaming") this.#activeMessageId = message.id
      this.#indexMessage(message)
    }
  }

  #reindexMessage(messageId: string): void {
    const index = indexesFor(this.#state.snapshot.messages).get(messageId)
    if (index === undefined) return
    const message = this.#state.snapshot.messages[index]
    if (message === undefined) return

    const nextCalls = new Set(message.blocks.flatMap((block) => block.kind === "tool_call" ? [block.call.id] : []))
    const dropped = new Set<string>()
    for (const id of this.#messageCalls.get(messageId) ?? []) {
      if (nextCalls.has(id)) continue
      this.#calls.delete(id)
      dropped.add(id)
    }
    if (dropped.size > 0) this.#callOrder = this.#callOrder.filter((candidate) => !dropped.has(candidate))
    const nextResults = new Set(message.blocks.flatMap((block) => block.kind === "tool_result" ? [block.result.toolCallId] : []))
    for (const id of this.#messageResults.get(messageId) ?? []) {
      if (nextResults.has(id)) continue
      this.#results.delete(id)
    }
    this.#indexMessage(message)
  }

  #indexMessage(message: Message): void {
    const calls = new Set<string>()
    const results = new Set<string>()
    for (const block of message.blocks) {
      if (block.kind === "tool_call") {
        calls.add(block.call.id)
        if (!this.#calls.has(block.call.id)) this.#callOrder.push(block.call.id)
        this.#calls.set(block.call.id, block.call)
      } else if (block.kind === "tool_result") {
        results.add(block.result.toolCallId)
        this.#results.set(block.result.toolCallId, block.result)
      }
    }
    this.#messageCalls.set(message.id, calls)
    this.#messageResults.set(message.id, results)
  }
}

/**
 * Which message holds a tool call, read off the reducer's own address table.
 *
 * The projection used to keep a second `callId → messageId` map, updated by
 * hand beside this one. Two incremental updaters over one array is two chances
 * to disagree, and a disagreement here shows up as the wrong tool call being
 * updated — a symptom that points at neither file. The table below is keyed on
 * the message array's identity, so it invalidates when the array does.
 */
const ownerOf = (state: SessionState, callId: string): string | undefined => {
  const messages = state.snapshot.messages
  const address = callIndexesFor(messages).get(callId)
  return address === undefined ? undefined : messages[address.messageIndex]?.id
}

const coreOf = (state: SessionState): SessionCore => {
  const { messages, approvals, ...snapshot } = state.snapshot
  return { snapshot: { ...snapshot, messageCount: messages.length, approvalCount: approvals.length } }
}

/**
 * What each event invalidates — the whole publish decision, in one table.
 *
 * This was five separate `||` chains over event names, one per view, and every
 * one of them answered `false` for a name it had never heard of. A session
 * event added to the contract therefore published nothing, silently, in five
 * places at once — the exact failure `PROJECTION` in the session reducer exists
 * to prevent, reintroduced one layer above it. Keyed by `SessionEventName` and
 * typed as a total record, the same addition now fails this file to compile
 * until somebody says which views it disturbs.
 *
 * `messageContents` is not a view. It says the event may have moved blocks
 * inside its message, which is what decides whether the address tables are
 * rebuilt; it rides here because it is answered from the event name alone,
 * exactly like the rest.
 */
type Invalidation = keyof SessionViews | "messageContents"

/** The events a session projection is handed: its own, plus the two approvals. */
type ProjectedEventName = SessionEventName | "approval_requested" | "approval_resolved"

const INVALIDATES: Record<ProjectedEventName, readonly Invalidation[]> = {
  // Replaces everything, and is handled before this table is consulted.
  session_snapshot: [],
  session_status_changed: ["core"],
  session_summary_changed: ["core"],
  turn_started: ["timeline"],
  turn_settled: ["timeline"],
  message_added: ["core", "timeline", "activity", "todo"],
  block_started: ["timeline", "messageContents", "activity", "todo"],
  block_delta: ["timeline"],
  block_finished: ["timeline", "messageContents", "activity", "todo"],
  tool_call_started: ["timeline", "messageContents", "activity"],
  tool_call_updated: ["timeline", "messageContents", "activity"],
  tool_call_finished: ["timeline", "messageContents", "activity"],
  queue_changed: ["core"],
  usage_changed: ["core", "activity"],
  model_changed: ["core"],
  // The status change that accompanies it is what the interface shows.
  compaction_started: [],
  compaction_finished: ["timeline"],
  retry_scheduled: ["timeline"],
  stream_gap: ["timeline"],
  approval_requested: ["core", "timeline", "messageContents", "activity", "approvals"],
  approval_resolved: ["core", "timeline", "messageContents", "activity", "approvals"],
}

interface Touched {
  core: boolean
  timeline: boolean
  activity: boolean
  approvals: boolean
  todo: boolean
  messageContents: boolean
}

const NOTHING_TOUCHED: Touched = { core: false, timeline: false, activity: false, approvals: false, todo: false, messageContents: false }

/** The table, flattened once, so the hot path reads fields rather than scanning arrays. */
const TOUCHED = Object.fromEntries(
  Object.entries(INVALIDATES).map(([name, invalidated]) => [
    name,
    { ...NOTHING_TOUCHED, ...Object.fromEntries(invalidated.map((key) => [key, true])) },
  ]),
) as Record<ProjectedEventName, Touched>

const touchedBy = (name: EventName): Touched => TOUCHED[name as ProjectedEventName] ?? NOTHING_TOUCHED

const completedRowsMayHaveChanged = (
  name: EventName,
  messageId: string | undefined,
  state: SessionState,
  indexes: ReadonlyMap<string, number>,
): boolean => {
  if (name === "turn_settled" || name === "message_added" || name === "tool_call_started") return true
  if (messageId === undefined) return false
  const index = indexes.get(messageId)
  return index !== undefined && state.snapshot.messages[index]?.status !== "streaming"
}
