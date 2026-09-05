import type {
  ContentBlock,
  EventName,
  EventPayload,
  Message,
  SessionEventName,
  SessionSnapshot,
  ToolCall,
} from "@bake-pi/contract"

/**
 * The renderer's projection of one session.
 *
 * State here is a projection, never truth. The host is authoritative; every
 * value in this object came from an event or a snapshot, and a snapshot
 * replaces it wholesale. Nothing in the UI may write to it directly — an
 * optimistic edit that survives a snapshot is a lie the user cannot detect.
 */
/**
 * Something that happened to the session which the timeline has to say out loud.
 *
 * Not a projection of anything the host holds — both of these describe an
 * event rather than a state, and neither is recoverable from a snapshot. That
 * is exactly why they are kept: a compaction that removed forty messages
 * otherwise reads as the interface losing them, and a provider retry reads as
 * a hang.
 */
export type SessionNotice =
  | { kind: "compacted"; removedMessages: number }
  | { kind: "retrying"; attempt: number; delayMs: number; reason: string }

export interface SessionState {
  snapshot: SessionSnapshot
  /** Set when a byte cap was breached and a resync is pending. The UI says so. */
  gap: boolean
  /** The last announcement worth showing, until the next turn begins. */
  notice: SessionNotice | undefined
}

/**
 * A projection from a snapshot alone.
 *
 * `gap` comes from the snapshot rather than being assumed false: a snapshot that
 * followed a discard says so, and a baseline built from one is incomplete
 * history no matter that it is the first thing this projection has seen.
 */
export const initialState = (snapshot: SessionSnapshot): SessionState => {
  indexesFor(snapshot.messages)
  callIndexesFor(snapshot.messages)
  return { snapshot, gap: snapshot.afterGap, notice: undefined }
}

type Reducer = <N extends EventName>(state: SessionState, name: N, payload: EventPayload<N>) => SessionState

/**
 * A pure reducer over contract events, deliberately free of React.
 *
 * Being pure is what lets the interleaving tests exist: a snapshot delivered in
 * the middle of a live stream is just a sequence of calls, and asserting the
 * result needs no renderer, no timers, and no mocking.
 */
export const reduce: Reducer = (state, name, payload) => {
  switch (name) {
    case "session_snapshot": {
      const { snapshot } = payload as EventPayload<"session_snapshot">
      // The notice survives, and it has to: compaction announces itself and
      // *then* replaces the projection, so a snapshot that cleared it would
      // erase the only explanation for the messages it just removed.
      return { ...initialState(snapshot), notice: state.notice }
    }

    case "session_status_changed": {
      const { status } = payload as EventPayload<"session_status_changed">
      return { ...state, snapshot: { ...state.snapshot, status } }
    }

    case "session_summary_changed": {
      const { summary } = payload as EventPayload<"session_summary_changed">
      return { ...state, snapshot: { ...state.snapshot, summary } }
    }

    /**
     * A turn of the loop begins, and whatever the last one had to say stops
     * being current. Nothing else here: the status the turn puts the session
     * into arrives as its own event, and the message this names is added by
     * `message_added` a moment later.
     */
    case "turn_started":
      return state.notice === undefined ? state : { ...state, notice: undefined }

    /**
     * Compaction rewrote history. The count is the only part a snapshot cannot
     * carry — afterwards the messages are simply gone — so it is kept and said.
     */
    case "compaction_finished": {
      const { removedMessages } = payload as EventPayload<"compaction_finished">
      return { ...state, notice: { kind: "compacted", removedMessages } }
    }

    /**
     * Pi is retrying a provider call. The contract's own note on this event is
     * that it is shown rather than hidden, because a silent stall cannot be
     * told from a hang — and until this case existed it was hidden.
     */
    case "retry_scheduled": {
      const { attempt, delayMs, reason } = payload as EventPayload<"retry_scheduled">
      return { ...state, notice: { kind: "retrying", attempt, delayMs, reason } }
    }

    case "message_added": {
      const { message } = payload as EventPayload<"message_added">
      const messages = [...state.snapshot.messages, message]
      const indexes = new Map(indexesFor(state.snapshot.messages))
      if (!indexes.has(message.id)) indexes.set(message.id, messages.length - 1)
      const calls = reindexCalls(callIndexesFor(state.snapshot.messages), messages.length - 1, message)
      return withMessages(state, messages, indexes, calls)
    }

    case "block_started": {
      const { messageId, block } = payload as EventPayload<"block_started">
      return mapMessage(state, messageId, (message) => ({
        ...message,
        blocks: upsertBlock(message.blocks, block),
      }), true)
    }

    case "block_delta": {
      const { messageId, blockIndex, textDelta } = payload as EventPayload<"block_delta">
      return mapMessage(state, messageId, (message) => ({
        ...message,
        blocks: message.blocks.map((block) => {
          if (block.index !== blockIndex) return block
          if (block.kind !== "text" && block.kind !== "reasoning") return block
          return { ...block, text: block.text + textDelta }
        }),
      }))
    }

    case "block_finished": {
      const { messageId, block } = payload as EventPayload<"block_finished">
      return mapMessage(state, messageId, (message) => ({
        ...message,
        blocks: upsertBlock(message.blocks, block),
      }), true)
    }

    /**
     * A tool call enters the timeline, and this is the only way it can.
     *
     * `message_end` re-emits text and reasoning blocks and deliberately not
     * tool calls — the host says so at the site — so a projection that ignored
     * this event showed no tool card at all until the next snapshot replaced
     * it. That is what was happening: every card a person watched appear was
     * one a reload had fetched.
     *
     * Upserted by call id rather than by block index, because the host does not
     * carry an index here. The call keeps whatever index it already had if it
     * has one, and otherwise takes the one after the message's last block.
     */
    case "tool_call_started": {
      const { messageId, call } = payload as EventPayload<"tool_call_started">
      return mapMessage(state, messageId, (message) => ({ ...message, blocks: upsertCall(message.blocks, call) }), true)
    }

    /**
     * A running tool's output so far, which Pi reports cumulatively — so the
     * call replaces its predecessor rather than merging into it.
     *
     * No `messageId` travels with this one, so the call is found by its id
     * across the projection. There is exactly one block that can hold it.
     */
    case "tool_call_updated": {
      const { call } = payload as EventPayload<"tool_call_updated">
      return mapCall(state, call.id, () => call)
    }

    /**
     * The outcome, applied to the card that has been showing `running`.
     *
     * Only the status is taken. The tool's output arrives as its own message —
     * Pi appends a tool-result message and the host projects it at
     * `message_start` — so writing the output onto the call here would draw it
     * twice, once on the card and once in the message below it.
     */
    case "tool_call_finished": {
      const { result } = payload as EventPayload<"tool_call_finished">
      return mapCall(state, result.toolCallId, (call) => ({
        ...call,
        // Pi reports every blocked hook as an error. Keep the more precise
        // approval outcome the renderer already received instead of turning a
        // denial or cancellation into a generic failed tool a moment later.
        status: result.status === "failed" && (call.status === "denied" || call.status === "aborted")
          ? call.status
          : result.status,
      }))
    }

    case "turn_settled": {
      const { messageId, status, usage } = payload as EventPayload<"turn_settled">
      return mapMessage(state, messageId, (message) => ({
        ...message,
        status,
        ...(usage === undefined ? {} : { usage }),
      }))
    }

    case "queue_changed": {
      const { queue } = payload as EventPayload<"queue_changed">
      return { ...state, snapshot: { ...state.snapshot, queue } }
    }

    case "usage_changed": {
      const { usage } = payload as EventPayload<"usage_changed">
      return { ...state, snapshot: { ...state.snapshot, usage } }
    }

    case "model_changed": {
      const { selection } = payload as EventPayload<"model_changed">
      return { ...state, snapshot: { ...state.snapshot, model: selection } }
    }

    case "approval_requested": {
      const { request } = payload as EventPayload<"approval_requested">
      const pending = mapCall(state, request.call.id, (call) => ({ ...call, status: "pending_approval" }))
      return {
        ...pending,
        snapshot: {
          ...pending.snapshot,
          status: "awaiting_approval",
          approvals: [...pending.snapshot.approvals.filter((approval) => approval.id !== request.id), request],
        },
      }
    }

    case "approval_resolved": {
      const { requestId, decision, resolvedBy } = payload as EventPayload<"approval_resolved">
      const request = state.snapshot.approvals.find((approval) => approval.id === requestId)
      const settled = request === undefined
        ? state
        : mapCall(state, request.call.id, (call) => ({
            ...call,
            status: resolvedBy === "cancelled" ? "aborted" : decision === "deny" ? "denied" : "running",
          }))
      const approvals = settled.snapshot.approvals.filter((approval) => approval.id !== requestId)
      return {
        ...settled,
        snapshot: {
          ...settled.snapshot,
          status: approvals.length > 0 ? "awaiting_approval" : "streaming",
          approvals,
        },
      }
    }

    case "stream_gap":
      // Marked, not repaired. A snapshot follows, and until it arrives the UI
      // states that history is incomplete rather than pretending otherwise.
      return { ...state, gap: true }

    default:
      // Interaction and lifecycle events reach this reducer and are the store's
      // business, not the projection's. Every *session* event is accounted for
      // by `PROJECTION` below, which is typed so that a new one cannot arrive
      // here by omission.
      return state
  }
}

/**
 * What every session event does to this projection, declared rather than
 * discovered.
 *
 * `Record<SessionEventName, string>` is the whole point: a session event added
 * to the contract fails this file to compile until somebody says what the
 * renderer does with it. Without that, the reducer's `default` accepted new
 * events silently — which is how `tool_call_started`, `tool_call_updated`,
 * `tool_call_finished` and `retry_scheduled` came to be dropped for as long as
 * they were, each one an event the host went to some trouble to send.
 *
 * The host has the same table pointed the other way, at what Pi's events
 * become (`packages/agent-host/src/mapping/coverage.ts`). Between them the two
 * ends of the stream are declared rather than assumed.
 *
 * Approvals are not here: they are interaction events, not session ones, and
 * the reducer handles them above.
 */
export const PROJECTION: Record<SessionEventName, string> = {
  session_snapshot: "Replaces the projection wholesale, keeping only the notice, which describes an event rather than a state.",
  session_status_changed: "The session's status, which every spinner and dot in the interface reads.",
  session_summary_changed: "The title, which the tab and the session list show.",
  turn_started: "Clears the last notice. The turn's own message and status arrive as their own events.",
  turn_settled: "The turn's stop reason and its token usage, onto the message that produced them.",
  message_added: "A message enters the timeline.",
  block_started: "Opens a block on its message, positioned by index rather than by arrival.",
  block_delta: "Appends to the addressed text or reasoning block, and to nothing else.",
  block_finished: "The authoritative version of a block, replacing whatever the deltas accumulated.",
  tool_call_started: "Puts the tool card in the timeline. Nothing else does — message_end deliberately re-emits text and reasoning only.",
  tool_call_updated: "Replaces the call with Pi's cumulative view of it, output so far included.",
  tool_call_finished: "The outcome, onto the card. The output arrives separately, as the tool-result message.",
  queue_changed: "Prompts Pi has accepted but not yet delivered.",
  usage_changed: "Cumulative session usage, which the activity rail meters.",
  model_changed: "The model and thinking level the composer shows.",
  compaction_started: "Nothing. The status change that accompanies it is what the interface shows, and a second announcement of one state would be two things to keep in step.",
  compaction_finished: "Records how many messages compaction removed, which the snapshot that follows cannot say.",
  retry_scheduled: "Records the attempt and the delay, because a silent stall is indistinguishable from a hang.",
  stream_gap: "Flags the projection as incomplete until the resync snapshot lands.",
}

/** Message arrays keep their address table across snapshot metadata changes. */
const messageIndexes = new WeakMap<Message[], ReadonlyMap<string, number>>()
export interface CallAddress { messageIndex: number; blockIndex: number }
const toolCallIndexes = new WeakMap<Message[], ReadonlyMap<string, CallAddress>>()

/**
 * The address tables, exported because the projection wrapping this reducer
 * needs the same two answers and used to keep its own incremental copies of
 * them. Keyed on the array identity, so a snapshot replacement invalidates them
 * for free — which is the case a hand-maintained table has to remember.
 */
export const indexesFor = (messages: Message[]): ReadonlyMap<string, number> => {
  const existing = messageIndexes.get(messages)
  if (existing !== undefined) return existing

  const indexes = new Map<string, number>()
  for (let index = 0; index < messages.length; index += 1) {
    const id = messages[index]!.id
    if (!indexes.has(id)) indexes.set(id, index)
  }
  messageIndexes.set(messages, indexes)
  return indexes
}

export const callIndexesFor = (messages: Message[]): ReadonlyMap<string, CallAddress> => {
  const existing = toolCallIndexes.get(messages)
  if (existing !== undefined) return existing

  const indexes = new Map<string, CallAddress>()
  for (const [messageIndex, message] of messages.entries()) {
    for (const [blockIndex, block] of message.blocks.entries()) {
      if (block.kind === "tool_call" && !indexes.has(block.call.id)) {
        indexes.set(block.call.id, { messageIndex, blockIndex })
      }
    }
  }
  toolCallIndexes.set(messages, indexes)
  return indexes
}

const withMessages = (
  state: SessionState,
  messages: Message[],
  indexes: ReadonlyMap<string, number> = indexesFor(state.snapshot.messages),
  calls: ReadonlyMap<string, CallAddress> = callIndexesFor(state.snapshot.messages),
): SessionState => {
  messageIndexes.set(messages, indexes)
  toolCallIndexes.set(messages, calls)
  return { ...state, snapshot: { ...state.snapshot, messages } }
}

const mapMessage = (
  state: SessionState,
  messageId: string,
  update: (message: Message) => Message,
  callsChanged = false,
): SessionState => {
  const index = indexesFor(state.snapshot.messages).get(messageId) ?? -1
  // An event for a message we do not have is dropped rather than synthesized.
  // Inventing a placeholder would put a message in the timeline that the host's
  // next snapshot then deletes, which reads as the interface losing content.
  if (index === -1) return state

  const messages = [...state.snapshot.messages]
  messages[index] = update(messages[index]!)
  const calls = callsChanged
    ? reindexCalls(callIndexesFor(state.snapshot.messages), index, messages[index]!)
    : callIndexesFor(state.snapshot.messages)
  return withMessages(state, messages, indexesFor(state.snapshot.messages), calls)
}

/**
 * Replaces the tool call wherever the projection is holding it.
 *
 * A call is addressed by its id and lives in exactly one block of one message,
 * so this scans until it finds it. A call nobody is holding is dropped rather
 * than given a message of its own — the same rule `mapMessage` follows, for the
 * same reason: a block invented here is one the next snapshot deletes.
 */
const mapCall = (state: SessionState, callId: string, update: (call: ToolCall) => ToolCall): SessionState => {
  const messages = state.snapshot.messages
  const address = callIndexesFor(messages).get(callId)
  if (address === undefined) return state
  const message = messages[address.messageIndex]
  const block = message?.blocks[address.blockIndex]
  if (message === undefined || block?.kind !== "tool_call" || block.call.id !== callId) return state

  const next = [...messages]
  const blocks = [...message.blocks]
  blocks[address.blockIndex] = { ...block, call: update(block.call) }
  next[address.messageIndex] = {
    ...message,
    blocks,
  }
  return withMessages(state, next)
}

const reindexCalls = (
  current: ReadonlyMap<string, CallAddress>,
  messageIndex: number,
  message: Message,
): ReadonlyMap<string, CallAddress> => {
  const next = new Map(current)
  for (const [id, address] of next) {
    if (address.messageIndex === messageIndex) next.delete(id)
  }
  for (const [blockIndex, block] of message.blocks.entries()) {
    if (block.kind === "tool_call" && !next.has(block.call.id)) next.set(block.call.id, { messageIndex, blockIndex })
  }
  return next
}

/**
 * A tool call placed into a message's blocks, by id rather than by index.
 *
 * The host does not say where the call belongs — no index travels with
 * `tool_call_started` — so a call already on the message keeps the position it
 * has, and a new one takes the place after the last block. Appending by index
 * rather than by array position is what keeps it there once `upsertBlock` sorts
 * the streamed text blocks that arrive after it.
 */
const upsertCall = (blocks: ContentBlock[], call: ToolCall): ContentBlock[] => {
  const existing = blocks.find((block) => block.kind === "tool_call" && block.call.id === call.id)
  const index = existing?.index ?? blocks.reduce((highest, block) => Math.max(highest, block.index + 1), 0)
  return upsertBlock(blocks, { index, kind: "tool_call", call })
}

const upsertBlock = (blocks: ContentBlock[], block: ContentBlock): ContentBlock[] => {
  const index = blocks.findIndex((existing) => existing.index === block.index)
  if (index === -1) return [...blocks, block].sort((a, b) => a.index - b.index)
  const next = [...blocks]
  next[index] = block
  return next
}
