import type { ContentBlock, Message } from "@bake-pi/contract"

export interface ToolLookup<T> {
  get: (id: string) => T | undefined
}

export interface CompletedTimelineRow {
  key: string
  message: Message
  block: ContentBlock | undefined
  first: boolean
  last: boolean
  /**
   * Consecutive reasoning / tool-call / tool-result blocks, including a
   * tool-result that arrived as its own system message. The thinking-step list
   * is these rows, and the connector between them is what `activityEnd` stops.
   */
  activity: boolean
  activityEnd: boolean
  /** A reasoning phase starts at the root; the tools it prompted sit one level beneath it. */
  activityNested: boolean
  activityGroupStart: boolean
  activityGroupEnd: boolean
  /**
   * The model this turn ran on, present only where it differs from the turn
   * before it — and only on the row that opens the turn.
   *
   * A mark on every assistant turn would be the same mark all the way down a
   * conversation, which is a glyph that says nothing. What a reader actually
   * needs is the boundary: this is where the answers started coming from
   * somewhere else. Computed here rather than in the view because no single
   * row can see the turn before it.
   *
   * The first assistant turn of a conversation carries nothing: there is no
   * previous model for it to differ from, and marking it would make every
   * session look like it had switched.
   */
  modelSwitch: string | undefined
}

/**
 * The streaming message's blocks, carrying the same run flags as a completed
 * row plus which one Pi is producing at this moment.
 *
 * It is a separate type only because these rows are not virtualized — there is
 * one streaming message and it is mounted whole — but they go through the same
 * filter and the same run marking, and that is the point. The two paths used to
 * disagree, and every disagreement showed up as the turn ending: a result drawn
 * twice while streaming and once after, a connector with a hole in it that
 * closed when the last token landed, a step that vanished rather than settled.
 */
export interface ActiveTimelineRow {
  key: string
  block: ContentBlock
  activity: boolean
  activityEnd: boolean
  activityNested: boolean
  activityGroupStart: boolean
  activityGroupEnd: boolean
  /**
   * The block being produced right now, which is the last one the message has.
   *
   * Every block in a streaming message used to be told it was live. For a tool
   * that changed nothing — a call carries its own status, and Pi moves it to
   * `running` and then past it — but reasoning has no status of its own, so a
   * turn that thought four times showed four steps all pulsing "Reasoning…"
   * and all held open, and none of them closed until the whole turn did. Only
   * the tail is unfinished; the rest are done and belong closed.
   */
  live: boolean
}

/**
 * The virtualizer counts blocks rather than messages. An assistant turn can
 * contain thousands of tool blocks, so message-level virtualization would
 * still mount the worst-case history Milestone 3 is required to bound.
 */
const isActivity = (block: ContentBlock | undefined): boolean =>
  block !== undefined && (block.kind === "reasoning" || block.kind === "tool_call" || block.kind === "tool_result")

/**
 * A reasoning block with nothing in it is not a step.
 *
 * Providers close a turn with a thinking part that carries a signature and no
 * text, and a model can open one and say nothing before answering. While the
 * message streams, that block is the "Reasoning…" the person is watching; once
 * the message is complete, it is a chevron in front of an empty sentence, and
 * it sat at the end of every turn as though the model had a last thought it was
 * keeping to itself. Redacted reasoning is different: the provider withheld the
 * text, and saying so is the step.
 */
const isShownWhenComplete = (block: ContentBlock, hasCall: (id: string) => boolean): boolean => {
  if (block.kind === "reasoning") return block.redacted || block.text.trim().length > 0
  // A result whose call is on the timeline is drawn inside that call's step.
  // Only a result whose call never arrived — a stream gap, a snapshot that
  // began mid-turn — stands on its own.
  if (block.kind === "tool_result") return !hasCall(block.result.toolCallId)
  return true
}

/**
 * The same question for the message still being written, where one answer
 * differs: an empty reasoning block is the "Reasoning…" a person is watching
 * while it is the last thing in the message, and is nothing at all anywhere
 * else. Showing it anywhere else put a step in the middle of a turn that
 * disappeared when the turn ended, which is a row deleting itself under
 * someone reading it.
 */
const isShownWhileStreaming = (block: ContentBlock, hasCall: (id: string) => boolean, tail: boolean): boolean =>
  block.kind === "reasoning" && !block.redacted && block.text.trim().length === 0
    ? tail
    : isShownWhenComplete(block, hasCall)

/**
 * Marks both the outer run and the reasoning-led groups inside it.
 *
 * A reasoning block is the phase heading. Consecutive tools in the same turn
 * belong beneath it until another reasoning block or ordinary content starts.
 * Tools with no reasoning ahead of them remain a flat group, so a provider
 * that does not expose thinking still gets the compact step list rather than
 * invented hierarchy.
 */
const markActivityRuns = <T extends {
  block: ContentBlock | undefined
  activity: boolean
  activityEnd: boolean
  activityNested: boolean
  activityGroupStart: boolean
  activityGroupEnd: boolean
}>(rows: T[], sameTurn: (left: T, right: T) => boolean = () => true): T[] => {
  // One pass. A group boundary is knowable the moment it is crossed, so the
  // previous row's `activityGroupEnd` is closed here rather than by a second
  // walk over a parallel array of group numbers: the run this loop is leaving
  // is the run that just ended.
  let openGroup: T | undefined
  let reasoningLed = false
  let previousActivity = false

  for (const [index, row] of rows.entries()) {
    const activity = isActivity(row.block)
    if (!activity) {
      reasoningLed = false
      if (openGroup !== undefined) openGroup.activityGroupEnd = true
      openGroup = undefined
      previousActivity = false
      continue
    }

    row.activity = true
    row.activityEnd = !isActivity(rows[index + 1]?.block)

    const previous = rows[index - 1]
    const continuesTurn = previousActivity && previous !== undefined && sameTurn(previous, row)
    const reasoning = row.block?.kind === "reasoning"
    if (!continuesTurn || reasoning) {
      if (openGroup !== undefined) openGroup.activityGroupEnd = true
      row.activityGroupStart = true
      reasoningLed = reasoning
    }
    openGroup = row
    row.activityNested = reasoningLed && !reasoning
    previousActivity = true
  }
  if (openGroup !== undefined) openGroup.activityGroupEnd = true
  return rows
}

/**
 * The streaming message, as rows. Nothing here is memoized: this message is
 * the one that changes on every delta, and it holds a turn's worth of blocks
 * rather than a session's.
 */
export const activeTimelineRows = (message: Message, hasCall: (id: string) => boolean): ActiveTimelineRow[] => {
  const last = message.blocks.at(-1)
  const shown = message.blocks.filter((block) => isShownWhileStreaming(block, hasCall, block === last))
  const tail = shown.at(-1)
  return markActivityRuns(shown.map((block) => ({
    key: `${message.id}:${String(block.index)}`,
    block,
    activity: false,
    activityEnd: false,
    activityNested: false,
    activityGroupStart: false,
    activityGroupEnd: false,
    live: block === tail && message.status === "streaming",
  })))
}

/** Every call id in the conversation, streaming message included. */
const toolCallIds = (messages: Message[]): Set<string> => {
  const ids = new Set<string>()
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.kind === "tool_call") ids.add(block.call.id)
    }
  }
  return ids
}

export const completedTimelineRows = (
  messages: Message[],
  previousRows: readonly CompletedTimelineRow[] = [],
): CompletedTimelineRow[] => {
  const rows: CompletedTimelineRow[] = []
  const calls = toolCallIds(messages)
  const hasCall = (id: string): boolean => calls.has(id)
  // Which model the last assistant turn ran on, so the next one can say
  // whether it changed. Only assistant turns move it: a user message carries
  // no model, and letting one clear this would mark every second turn.
  let previousModel: string | undefined
  const modelSwitchFor = (message: Message): string | undefined => {
    if (message.role !== "assistant" || message.modelId === undefined) return undefined
    const switched = previousModel !== undefined && previousModel !== message.modelId
    previousModel = message.modelId
    return switched ? message.modelId : undefined
  }
  for (const message of messages) {
    if (message.status === "streaming") continue
    const blocks = message.blocks.filter((block) => isShownWhenComplete(block, hasCall))
    // A message that had blocks and lost all of them to the filter has
    // nothing to say; a message that never had any still marks its turn.
    if (blocks.length === 0 && message.blocks.length > 0) continue
    if (blocks.length === 0) {
      rows.push({
        key: `${message.id}:empty`,
        message,
        block: undefined,
        first: true,
        last: true,
        activity: false,
        activityEnd: false,
        activityNested: false,
        activityGroupStart: false,
        activityGroupEnd: false,
        modelSwitch: modelSwitchFor(message),
      })
      continue
    }
    for (const [index, block] of blocks.entries()) {
      rows.push({
        key: `${message.id}:${String(block.index)}`,
        message,
        block,
        first: index === 0,
        last: index === blocks.length - 1,
        activity: false,
        activityEnd: false,
        activityNested: false,
        activityGroupStart: false,
        activityGroupEnd: false,
        modelSwitch: index === 0 ? modelSwitchFor(message) : undefined,
      })
    }
  }
  const projected = markActivityRuns(rows, (left, right) => left.message.id === right.message.id)
  if (previousRows.length === 0) return projected

  // Adding or settling one message rebuilds the derived list, but it must not
  // replace the DOM for every earlier row. Apart from wasting a full-history
  // render, replacing a paragraph destroys a selection a person is holding
  // while the next turn streams. Reuse only rows whose inputs and run markers
  // are unchanged; a changed tool or an activity boundary still redraws.
  const previousByKey = new Map(previousRows.map((row) => [row.key, row]))
  return projected.map((row) => {
    const previous = previousByKey.get(row.key)
    return previous !== undefined && sameRow(previous, row) ? previous : row
  })
}

/**
 * Every field of a row is either a reference this projection copied across or a
 * flag it computed, so equality is identity on each key. Comparing by key
 * rather than by a hand-written list means a field added to the row is compared
 * without anyone remembering to add a line here — the failure that list has is
 * silent: a forgotten field reuses the stale row and the step simply stops
 * redrawing. `modelSwitch` was the most recent field to be added.
 */
const sameRow = (left: CompletedTimelineRow, right: CompletedTimelineRow): boolean =>
  (Object.keys(left) as (keyof CompletedTimelineRow)[]).every((key) => left[key] === right[key])

/**
 * The same boundary for the turn that is still streaming.
 *
 * A streaming message has no model of its own to read yet, and it does not
 * need one: it is running on the model that is selected right now. Comparing
 * that against the last settled turn is what lets the mark appear as the turn
 * opens rather than jumping in when the last token lands — the two paths
 * disagreeing about a row is the defect this whole projection exists to stop.
 */
export const streamingModelSwitch = (messages: readonly Message[], currentModelId: string): string | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role !== "assistant" || message.status === "streaming" || message.modelId === undefined) continue
    return message.modelId === currentModelId ? undefined : currentModelId
  }
  return undefined
}

/** Reference identity, in order — every array guard in the renderer is one of these. */
export const sameRefs = <T,>(left: readonly T[], right: readonly T[]): boolean =>
  left.length === right.length && left.every((item, index) => item === right[index])

/**
 * The last file change still in view on a live turn.
 *
 * An edit or write keeps a brief listing until the next reasoning or tool
 * starts; prose after the change is not a next action, so the preview stays.
 */
export const heldChangeKey = (
  rows: ActiveTimelineRow[],
  isChange: (name: string) => boolean,
): string | undefined => {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!
    if (!row.activity) continue
    if (row.block.kind !== "tool_call") return undefined
    return isChange(row.block.call.name) ? row.key : undefined
  }
  return undefined
}
