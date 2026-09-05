import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import * as stylex from "@stylexjs/stylex"
import { useVirtualizer } from "@tanstack/react-virtual"
import { AlertTriangle, ChevronDown, RefreshCw, Scissors, SquareStop, X } from "lucide-react"
import type { ContentBlock, ImageBlock, Message, SessionStatus, ToolCall, ToolResult } from "@bake-pi/contract"
import type { SessionNotice } from "../../store/reducers/session.ts"
import type { SessionTimelineView } from "../../store/session-projection.ts"
import { colors, effects, motion, radius, space, typography } from "../../theme/tokens.stylex.ts"
import { focus } from "../../theme/focus.ts"
import { size } from "../../theme/sizes.stylex.ts"
import { scrollbars } from "../../theme/scrollbars.ts"
import { shimmer } from "../../theme/shimmer.ts"
import { spinners } from "../../theme/spinners.ts"
import { Markdown } from "./Markdown.tsx"
import { followingAfterTimelineScroll, initialTimelineOffset, shouldDetachFollowOnWheel } from "./timeline-follow.ts"
import { activeTimelineRows, heldChangeKey, type CompletedTimelineRow, type ToolLookup } from "./timeline-projection.ts"
import { CodeBlock } from "./CodeBlock.tsx"
import { ThinkingStep } from "./ThinkingStep.tsx"
import { TurnSummary } from "./TurnSummary.tsx"
import { turnSummary } from "./turn-summary.ts"
import { briefDiff, isChangeActivity, presentReasoning, presentToolResult, presentToolStep, summarizeActivity, WRITE_PREVIEW_LINES, type PresentedActivity } from "./tool-present.ts"
import { toolStepState, type ActivityStatus, type StepOutcome } from "./tool-state.ts"
import { LabIcon } from "../../ui/LabIcon.tsx"
import { labArtwork, labMarkForModelId } from "../../ui/lab-icons.ts"

/**
 * What a row is worth before it has been measured.
 *
 * One number for every row was the jump. A tool-heavy transcript is mostly
 * activity rows — a 24px header line on 2px of padding — and estimating each
 * of them at a paragraph's 150px made the scroll height several times too
 * tall: every row that measured on its way into view then corrected the offset
 * of everything below it, which is what a person sees as the transcript moving
 * under them while they scroll it. An activity row's height is not a guess, so
 * it is no longer guessed at; prose still is, and keeps the number it had.
 *
 * 32 rather than 28 because a run pays for its ends once — `activityStart`
 * adds 8px above the first step, `activityEnd` 12px below the last — so a run
 * of six averages a little over 31.
 */
const ROW_ESTIMATE = { activity: 32, prose: 150 } as const

export const Timeline = ({ timeline, followRequest, status, aborting, resting }: { timeline: SessionTimelineView; followRequest: number; status: SessionStatus; aborting: boolean; resting: boolean }): React.JSX.Element => {
  const viewport = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const followingRef = useRef(true)
  const [following, setFollowing] = useState(true)
  const { rows: completed, active, calls, results } = timeline
  /**
   * The run can be on with nothing to show for it yet: the provider call that
   * opens a turn, or a compaction between turns, both arrive as a status with
   * no streaming message behind it. The tab strip and the composer already say
   * so; `waiting` says it in the seat the answer will take, so the pane is
   * never silent — or claiming to be ready — while work is on.
   */
  const waiting = active === undefined && (status === "streaming" || status === "compacting")
  /**
   * The recap of the turn that just ended, in the gap between the last answer
   * and the next prompt.
   *
   * Only while nothing is running, and computed only then: a turn in flight is
   * being reported by its own steps, and a recap that assembled itself token by
   * token would be four different summaries of one turn. `rows` keeps its
   * identity across deltas, so this memo is entered once per settled turn
   * rather than once per frame.
   */
  const settled = active === undefined && !waiting
  const summary = useMemo(() => settled ? turnSummary(completed, results) : undefined, [settled, completed, results])
  const getItemKey = useCallback((index: number) => completed[index]?.key ?? index, [completed])
  const estimateSize = useCallback((index: number) => (completed[index]?.activity === true ? ROW_ESTIMATE.activity : ROW_ESTIMATE.prose), [completed])
  const virtualizer = useVirtualizer({
    count: completed.length,
    getScrollElement: () => viewport.current,
    estimateSize,
    // Start with tail rows rather than mounting the head's Markdown and tools
    // only for the layout effect to discard them. This runs once per keyed
    // timeline; measured following and detached scroll intent stay unchanged.
    initialOffset: () => initialTimelineOffset(completed.length, estimateSize),
    // Measuring several newly mounted rows belongs to one React update, not
    // one forced commit per observer callback. The virtualizer still applies
    // its scroll anchoring immediately; React batches the changed row range.
    useFlushSync: false,
    getItemKey,
    overscan: 5,
    // Preserve the visible keyed row when history changes. Manual following
    // below still owns whether the viewport advances to the end; anchoring
    // keeps an append from moving a detached reader or a live selection while
    // estimated row heights settle to their measured values.
    anchorTo: "end",
  })

  const scrollToLatest = useCallback((): void => {
    const element = viewport.current
    const selection = window.getSelection()
    if (element === null || (selection !== null && !selection.isCollapsed)) return
    element.scrollTop = element.scrollHeight
  }, [])

  /**
   * Rendered height is the scroll signal, not message count. A streamed tool
   * mutates one block, Markdown can reflow after it renders, and the composer
   * takes height away from this viewport without changing the transcript at
   * all.
   *
   * Answered inside the observation rather than a frame after it. A resize
   * observer is delivered after layout and before paint, so the growth and the
   * scroll that follows it land in the same picture. The frame this used to
   * wait for was a frame already painted with the new content below the fold
   * and the old offset still in place — at a token that is a pixel of lag, and
   * at a settling turn it is the whole transcript arriving a frame before the
   * scroll that was meant to accompany it.
   *
   * A person's scroll still wins the race, and now by more than a ref read:
   * input events are dispatched before the rendering steps, so a wheel in this
   * frame has already cleared the flag this reads.
   */
  const pinToLatest = useCallback((): void => {
    if (followingRef.current) scrollToLatest()
  }, [scrollToLatest])

  const setFollow = useCallback((next: boolean): void => {
    followingRef.current = next
    setFollowing(next)
  }, [])

  const followLatest = useCallback((): void => {
    setFollow(true)
    scrollToLatest()
  }, [scrollToLatest, setFollow])

  useLayoutEffect(() => {
    // A different conversation and a prompt sent from this composer are both
    // explicit requests to see the current end, even if the old view was
    // detached. The observer catches any virtual rows measured after this pass.
    setFollow(true)
    scrollToLatest()
  }, [followRequest, scrollToLatest, timeline.sessionId, setFollow])

  useEffect(() => {
    const viewportElement = viewport.current
    const contentElement = content.current
    if (viewportElement === null || contentElement === null) return

    const observer = new ResizeObserver(pinToLatest)
    observer.observe(viewportElement)
    observer.observe(contentElement)
    return () => {
      observer.disconnect()
    }
  }, [pinToLatest])

  const noteScroll = (): void => {
    const element = viewport.current
    if (element === null) return
    setFollow(followingAfterTimelineScroll(followingRef.current, element))
  }

  const notePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const element = viewport.current
    if (element === null) return
    const scrollbarWidth = element.offsetWidth - element.clientWidth
    const edge = element.getBoundingClientRect().right - scrollbarWidth
    if (scrollbarWidth > 0 && event.clientX >= edge) setFollow(false)
  }

  return (
    <div {...stylex.props(styles.frame, resting && styles.frameResting)}>
      {/*
        Announcements about the conversation rather than in it: a gap being
        repaired, a compaction that removed messages, a provider call being
        retried. They float over the timeline instead of joining it, because
        none of them is something anybody said — and they do not take the
        pointer, so the log underneath still scrolls where they sit.
      */}
      <div {...stylex.props(styles.banners)}>
        {timeline.gap ? (
          <div role="status" {...stylex.props(styles.banner, styles.bannerWarning)}><AlertTriangle size={16} aria-hidden="true" /> Recovering a gap in the event stream…</div>
        ) : null}
        {timeline.notice === undefined ? null : <NoticeBanner notice={timeline.notice} />}
      </div>
      <div
        ref={viewport}
        onScroll={noteScroll}
        onWheel={(event) => {
          const element = viewport.current
          if (element !== null && shouldDetachFollowOnWheel(event.deltaY, element)) setFollow(false)
        }}
        onPointerDown={notePointerDown}
        onTouchMove={() => setFollow(false)}
        role="log"
        aria-label="Conversation timeline"
        {...stylex.props(scrollbars.thin, styles.viewport, resting && styles.viewportResting)}
      >
        <div ref={content}>
          {completed.length === 0 && active === undefined && !waiting ? <EmptyTimeline resting={resting} /> : null}
          <div {...stylex.props(styles.virtualCanvas(virtualizer.getTotalSize()))}>
            {virtualizer.getVirtualItems().map((row) => {
              const item = completed[row.index]
              if (item === undefined) return null
              return (
                <div
                  key={item.key}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  {...stylex.props(styles.virtualRow(row.start))}
                >
                  <CompletedBlockView item={item} calls={calls} results={results} />
                </div>
              )
            })}
          </div>
          {active !== undefined ? <MessageView message={active} active modelSwitch={timeline.activeModelSwitch} aborting={aborting} calls={calls} results={results} /> : waiting ? <PendingTurn compacting={status === "compacting"} aborting={aborting} /> : summary === undefined ? null : <TurnSummary key={summary.key} summary={summary} />}
          <div {...stylex.props(styles.end)} />
        </div>
      </div>
      {!following ? (
        <div {...stylex.props(styles.jumpSlot)}>
          <button type="button" onClick={followLatest} {...stylex.props(focus.control, styles.jump)}>
            <ChevronDown size={12} aria-hidden="true" /> Jump to latest
          </button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * What just happened to the session, in one line.
 *
 * Both of these are events the host announces and no snapshot can restate: the
 * messages compaction removed are gone from the next projection, and a retry is
 * over by the time anything else could report it. Saying them here is the
 * difference between a conversation that lost forty messages and one that
 * explains why.
 */
const NoticeBanner = ({ notice }: { notice: SessionNotice }): React.JSX.Element =>
  notice.kind === "compacted" ? (
    <div role="status" {...stylex.props(styles.banner)}>
      <Scissors size={16} aria-hidden="true" />
      Compaction summarized {notice.removedMessages === 1 ? "1 message" : `${String(notice.removedMessages)} messages`} out of this conversation.
    </div>
  ) : (
    <div role="status" {...stylex.props(styles.banner)}>
      <RefreshCw size={16} aria-hidden="true" />
      Retrying in {(notice.delayMs / 1000).toFixed(1)}s — attempt {String(notice.attempt)}. {notice.reason}
    </div>
  )

/**
 * Only the states a person has to act on. Role is already the article's name.
 *
 * Three states, three tones, and each one says its own word — none of them is
 * announced by colour alone. `stopped` rather than Pi's `aborted`, and muted
 * rather than red, because the person reading it is the one who asked for it:
 * a turn a person ended is not a turn that broke. It borrows the word and the
 * `SquareStop` the step list has always marked an interrupted tool with, so
 * one stop does not go by two names on one screen.
 */
const TurnState = ({ active, status, aborting = false }: { active: boolean; status: Message["status"]; aborting?: boolean }): React.JSX.Element | null => {
  if (active) {
    return (
      <span role="status" {...stylex.props(styles.turnState, styles.turnWorking)}>
        <span {...stylex.props(shimmer.text)}>{aborting ? "stopping" : "working"}</span>
      </span>
    )
  }
  if (status === "failed") return <span {...stylex.props(styles.turnState, styles.turnFailed)}><X size={12} aria-hidden="true" />failed</span>
  if (status === "aborted") return <span {...stylex.props(styles.turnState, styles.turnStopped)}><SquareStop size={12} aria-hidden="true" />stopped</span>
  return null
}

/**
 * Where the answers started coming from somewhere else.
 *
 * Only at the boundary, never on every turn: a conversation held on one model
 * carries no marks at all, and one that switched carries exactly one, at the
 * turn it switched on. The mark is the whole statement, and the model id is in
 * the title for a pointer — the mark says Anthropic, and a person asking this
 * question wants to know which Claude.
 *
 * `null` for a model no table knows, rather than a bare id in a transcript of
 * prose. The composer and the sessions rail both say what is selected; this
 * sits in the log only to mark a change, and an unrecognised change is better
 * left to them than announced as a string.
 */
const ModelSwitch = ({ modelId }: { modelId: string | undefined }): React.JSX.Element | null => {
  if (modelId === undefined) return null
  const mark = labMarkForModelId(modelId)
  if (labArtwork(mark) === undefined) return null
  return (
    <span title={`Switched to ${modelId}`} {...stylex.props(styles.modelSwitch)}>
      <LabIcon mark={mark} size="micro" />
    </span>
  )
}

/**
 * The run is on but no message has streamed yet. Same word and same ring the
 * rest of the interface waits on, in the same column the answer will take —
 * the turn's own `TurnState` replaces this the moment its message exists.
 *
 * It says `stopping` for the same reason the composer's button goes quiet: an
 * abort is a command with a round trip, and until it answers, a ring turning
 * beside the word `working` is the interface disagreeing with what was just
 * asked of it.
 */
const PendingTurn = ({ compacting, aborting }: { compacting: boolean; aborting: boolean }): React.JSX.Element => (
  <div role="status" {...stylex.props(styles.pending)}>
    <span aria-hidden="true" {...stylex.props(spinners.running)} />
    <span {...stylex.props(shimmer.text)}>{aborting ? "stopping" : compacting ? "compacting" : "working"}</span>
  </div>
)

/**
 * One line, in the column the composer beneath it takes.
 *
 * It used to be a 30px glyph, a display-sized heading and two sentences about
 * what Pi can do and where tool activity appears — a small landing page, read
 * once and then in the way of the field every session after that. What the
 * screen has to say is that this session is empty and ready, and the composer
 * directly under it says the rest by existing. The heading survives because it
 * is the empty timeline's only landmark for a screen reader; nothing else did.
 */
const EmptyTimeline = ({ resting }: { resting: boolean }): React.JSX.Element => (
  <div {...stylex.props(styles.empty, resting && styles.emptyResting)}>
    <h2 {...stylex.props(styles.emptyTitle)}>Ready at the workbench</h2>
  </div>
)

/**
 * An image block as the picture, falling back to naming it.
 *
 * The bytes are not in the block — `url` is a `bakepi://image` address main's
 * protocol handler answers, so this is an ordinary `<img>` and the browser's
 * cache, not the projection, is what holds the decoded result. See
 * `dto/image-ref.ts` for why the bytes travel that way.
 *
 * Two things put a person back in front of a sentence instead of a picture.
 * The host mints no URL for a media type it will not serve, and a URL can go
 * stale — history renumbers, and a row still on screen from before a resync
 * points at nothing, which arrives here as a load error rather than as an
 * event. Both say an image is there and could not be drawn, which is the one
 * thing a blank space does not.
 *
 * The broken flag is keyed on the URL rather than kept as a boolean, so a
 * resync that hands the same block a fresh address gets a fresh attempt
 * without an effect to reset it.
 */
const ImageBlockView = ({ block }: { block: ImageBlock }): React.JSX.Element => {
  const [brokenUrl, setBrokenUrl] = useState<string | undefined>(undefined)
  if (block.url.length === 0 || brokenUrl === block.url) {
    return <div {...stylex.props(styles.notice)}>{block.altText ?? `Image (${block.mediaType})`}</div>
  }
  return (
    <img
      src={block.url}
      alt={block.altText ?? "Attached image"}
      loading="lazy"
      decoding="async"
      onError={() => setBrokenUrl(block.url)}
      {...stylex.props(styles.image)}
    />
  )
}

const MessageView = ({ message, active, modelSwitch, aborting, calls, results }: { message: Message; active: boolean; modelSwitch: string | undefined; aborting: boolean; calls: ToolLookup<ToolCall>; results: ToolLookup<ToolResult> }): React.JSX.Element => {
  const user = message.role === "user"
  if (user) {
    return (
      <article aria-label="user message" {...stylex.props(styles.userMessage, active && styles.activeMessage)}>
        <div {...stylex.props(styles.userBubble)}>
          {message.blocks.map((block) => <BlockView key={`${message.id}-${block.index}`} block={block} user calls={calls} results={results} />)}
        </div>
      </article>
    )
  }
  const rows = activeTimelineRows(message, (id) => calls.get(id) !== undefined)
  const heldKey = active ? heldChangeKey(rows, (name) => name === "edit" || name === "write") : undefined
  return (
    <article aria-label={`${message.role} message`} {...stylex.props(styles.message, active && styles.activeMessage)}>
      <div {...stylex.props(styles.messageBody)}>
        <TurnState active={active} status={message.status} aborting={aborting} />
        <ModelSwitch modelId={modelSwitch} />
        <div {...stylex.props(styles.blocks)}>
          {rows.map((row, index) => (
            /*
              The gap lives on the row rather than on the container. Steps in
              one reasoning-led group must touch so their tree line meets; a
              new reasoning root gets one measured gap. A container `gap` put
              an eight-pixel hole between every tool in a running turn, and the
              holes closed when the turn ended and the rows moved to the
              virtualized path. Same rule, both paths, so nothing moves when
              the last token lands.
            */
            <div key={row.key} {...stylex.props(index > 0 && !(row.activity && !row.activityGroupStart) && styles.rowGap, styles.rowEnter)}>
              <BlockView
                block={row.block}
                user={user}
                calls={calls}
                results={results}
                firstActivity={row.activityGroupStart}
                lastActivity={row.activityGroupEnd}
                nestedActivity={row.activityNested}
                live={row.live}
                preview={row.key === heldKey}
                turnActive={active}
              />
            </div>
          ))}
        </div>
      </div>
    </article>
  )
}

const CompletedBlockView = memo(function CompletedBlockView({ item, calls, results }: { item: CompletedTimelineRow; calls: ToolLookup<ToolCall>; results: ToolLookup<ToolResult> }): React.JSX.Element {
  const user = item.message.role === "user"
  if (user) {
    return (
      <article
        aria-label="user message"
        {...stylex.props(styles.userMessage, !item.first && styles.userMessageContinuation, !item.last && styles.userMessageBeforeEnd)}
      >
        <div {...stylex.props(styles.userBubble)}>
          {item.block === undefined ? null : <BlockView block={item.block} user calls={calls} results={results} />}
        </div>
      </article>
    )
  }
  return (
    <article
      aria-label={`${item.message.role} message`}
      {...stylex.props(
        styles.message,
        !item.first && styles.messageContinuation,
        !item.last && styles.messageBeforeEnd,
        item.activity && styles.activity,
        item.activityGroupStart && styles.activityStart,
        item.activityEnd && styles.activityEnd,
      )}
    >
      <div {...stylex.props(styles.messageBody)}>
        {item.first ? <TurnState active={false} status={item.message.status} /> : null}
        <ModelSwitch modelId={item.modelSwitch} />
        {item.block === undefined ? null : (
          <BlockView
            block={item.block}
            user={user}
            calls={calls}
            results={results}
            firstActivity={item.activityGroupStart}
            lastActivity={item.activityGroupEnd}
            nestedActivity={item.activityNested}
            live={false}
          />
        )}
      </div>
    </article>
  )
})

const BlockView = ({
  block,
  user,
  calls,
  results,
  firstActivity = true,
  lastActivity = true,
  nestedActivity = false,
  live = false,
  preview = false,
  turnActive = false,
}: {
  block: ContentBlock
  user: boolean
  calls: ToolLookup<ToolCall>
  results: ToolLookup<ToolResult>
  firstActivity?: boolean
  lastActivity?: boolean
  nestedActivity?: boolean
  live?: boolean
  preview?: boolean
  /** The message is the running turn, so `auto` disclosure keeps its steps open. */
  turnActive?: boolean
}): React.JSX.Element => {
  switch (block.kind) {
    case "text": return user ? <p {...stylex.props(styles.userText)}>{block.text}</p> : <Markdown text={block.text} />
    case "reasoning": {
      const presented = presentReasoning(block.text, block.redacted)
      const thought = presented.description
      // The settled first line is the phase heading, as in the reference:
      // tools that follow it are the indented work beneath that thought rather
      // than peers beside a generic "Reasoning" row. While text is arriving,
      // the stable "Thinking" label avoids rewriting the tree on every token.
      return (
        <ThinkingStep kind="reasoning" label={live ? "Thinking" : presented.label} status={live ? "active" : "complete"} first={firstActivity} last={lastActivity} nested={nestedActivity} turnActive={turnActive}>
          {thought === undefined ? null : <span {...stylex.props(styles.thought)}>{thought}</span>}
        </ThinkingStep>
      )
    }
    case "tool_call": return <ToolCallStep call={block.call} result={results.get(block.call.id)} first={firstActivity} last={lastActivity} nested={nestedActivity} preview={preview} turnActive={turnActive} />
    case "tool_result": return <ToolResultStep result={block.result} call={calls.get(block.result.toolCallId)} first={firstActivity} last={lastActivity} nested={nestedActivity} turnActive={turnActive} />
    case "image": return <ImageBlockView block={block} />
    case "error": return <div role="alert" {...stylex.props(styles.errorBlock)}>{friendlyError(block.error.code)}</div>
  }
}

/**
 * A tool, as one thinking step rather than a card and a second step.
 *
 * The listing — command, patch, file body — is the work, so it sits in the
 * step instead of inside a second surface. The result sits in the same step
 * once it arrives: the header says what ran and how much came back, the mark
 * says how it ended, and opening the step shows the command and then its
 * output. While a shell tool is still running, its partial output streams
 * into the same place and follows its own end.
 *
 * Memoized, because the streaming turn above it is not: a batch of deltas
 * re-renders the whole live message once a frame, and `presentToolStep` parses
 * a unified diff and word-diffs every changed line pair. Ten settled tools
 * ahead of the prose would redo all of that sixty times a second. The reducer
 * returns the identical block object for every message it did not touch, so a
 * settled step's props are reference-stable across a delta and the comparison
 * costs nothing.
 */
const ToolCallStep = memo(function ToolCallStep({ call, result, first, last, nested, preview = false, turnActive = false }: { call: ToolCall; result: ToolResult | undefined; first: boolean; last: boolean; nested: boolean; preview?: boolean; turnActive?: boolean }): React.JSX.Element {
  const state = toolStepState(call.status)
  const presented = presentToolStep(call, state.status === "complete" ? result : undefined)
  return (
    <ActivityStep
      presented={presented}
      status={state.status}
      {...(state.outcome === undefined ? {} : { outcome: state.outcome })}
      first={first}
      last={last}
      nested={nested}
      truncated={result?.truncated === true}
      preview={preview}
      turnActive={turnActive}
      {...(state.status === "active" && call.partialOutput !== undefined ? { stream: call.partialOutput } : {})}
    />
  )
})

/**
 * An orphan result keeps its size on the header line. Shell payloads use the
 * same verbose default as their ordinary call step; other results stay
 * compact until asked for.
 */
const ToolResultStep = memo(function ToolResultStep({ result, call, first, last, nested, turnActive = false }: { result: ToolResult; call: ToolCall | undefined; first: boolean; last: boolean; nested: boolean; turnActive?: boolean }): React.JSX.Element {
  const presented = presentToolResult(result, call)
  const summary = summarizeActivity(presented)
  const outcome = toolStepState(result.status).outcome
  return (
    <ActivityStep
      presented={summary === undefined ? presented : { ...presented, description: summary }}
      status="complete"
      {...(outcome === undefined ? {} : { outcome })}
      first={first}
      last={last}
      nested={nested}
      truncated={result.truncated}
      turnActive={turnActive}
    />
  )
})

const ActivityStep = ({
  presented,
  status,
  outcome,
  first,
  last,
  nested,
  truncated = false,
  preview = false,
  turnActive = false,
  stream,
}: {
  presented: PresentedActivity
  status: ActivityStatus
  outcome?: StepOutcome
  first: boolean
  last: boolean
  nested: boolean
  truncated?: boolean
  preview?: boolean
  turnActive?: boolean
  /** A running shell tool's output so far, which streams into its own block. */
  stream?: string
}): React.JSX.Element => {
  const held = preview && status !== "pending" && isChangeActivity(presented.kind)
  const brief = held && status === "complete"
  /*
   * A command and what it printed are one block: one header, one Copy, the
   * command above a recess and the answer below it. Two blocks said `bash`
   * twice and left the relationship between them to be inferred.
   *
   * `command` is what makes this decidable here rather than by kind. A shell
   * result that arrived without its call is also `kind: "shell"` and also
   * carries a listing, but that listing is output — presenting it under a `$`
   * would claim the transcript was the command. Only a step built from a call
   * has a command to pair.
   */
  const exchange = presented.command
  const printed = stream ?? presented.output?.text
  return (
    <ThinkingStep
      kind={presented.kind}
      label={presented.label}
      {...(presented.target === undefined ? {} : { target: presented.target })}
      {...(presented.targetPath === undefined ? {} : { targetPath: presented.targetPath })}
      {...(presented.description === undefined ? {} : { description: presented.description })}
      status={status}
      {...(outcome === undefined ? {} : { outcome })}
      first={first}
      last={last}
      nested={nested}
      turnActive={turnActive}
    >
      {presented.diffs?.map((listing) => {
        const shown = brief ? briefDiff(listing) : listing
        return (
          <CodeBlock
            key={listing.filename}
            variant="diff"
            listing={shown}
            filename={listing.filename}
            {...(listing.previousName === undefined ? {} : { previousName: listing.previousName })}
          />
        )
      })}
      {exchange !== undefined ? (
        <CodeBlock
          variant="terminal"
          filename={exchange.filename}
          command={{ text: exchange.text, language: exchange.language }}
          {...(printed === undefined ? {} : { text: printed })}
          follow={stream !== undefined}
        />
      ) : (
        <>
          {presented.code === undefined ? null : (
            <CodeBlock
              variant="code"
              filename={presented.code.filename}
              text={presented.code.text}
              language={presented.code.language}
              {...(brief && presented.kind === "write" ? { previewLines: WRITE_PREVIEW_LINES } : {})}
            />
          )}
          {presented.output === undefined ? null : (
            <CodeBlock variant={presented.kind === "shell" ? "terminal" : "code"} filename={presented.output.filename} text={presented.output.text} language={presented.output.language} />
          )}
        </>
      )}
      {truncated ? <p {...stylex.props(styles.muted)}>Output was truncated by the host.</p> : null}
    </ThinkingStep>
  )
}

const friendlyError = (code: string): string => ({
  session_busy: "Another Pi process changed this session. Close and reopen it before continuing.",
  session_file_repaired: "Pi recovered the session file, but the incomplete final entry was lost.",
  tool_interrupted: "The host stopped while a tool was running. Inspect the workspace before retrying.",
}[code] ?? `The operation failed (${code}). Open diagnostics for details.`)

/**
 * Declared here rather than shared from the theme because StyleX cannot import
 * keyframes across modules — only a `.stylex.ts` file may export them, and even
 * then the compiler will not resolve the imported name into `animationName`.
 * The duplication is the compiler's, not a choice.
 */
const fadeIn = stylex.keyframes({ from: { opacity: 0 } })

const enterBanner = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(-100%)" },
})

const enterJump = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(4px)" },
})

/** An action arriving: the smallest travel that still reads as arrival rather than as a repaint. */
const enterRow = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(2px)" },
})


const styles = stylex.create({
  /**
   * The session swap, as one fade rather than a settle a person can watch.
   *
   * `Timeline` is keyed by session id where it is rendered, so this plays once
   * per switch — and the work that used to be visible happens inside its first
   * frames: the new session's rows measure, the total size stops being an
   * estimate, and the viewport pins to the end. What arrives at full opacity is
   * a transcript that has already stopped moving. Opacity only, so reduced
   * motion keeps the fade instead of losing the cover it provides.
   */
  frame: {
    position: "relative",
    minHeight: 0,
    flex: 1,
    animationName: fadeIn,
    animationDuration: { default: motion.moderate, "@media (prefers-reduced-motion: reduce)": motion.accessibleFade },
    animationTimingFunction: motion.settle,
  },
  /**
   * A session with nothing said in it yet does not claim the column.
   *
   * The timeline normally takes every pixel the conversation has and the
   * composer sits under whatever is left, which is right the moment there is a
   * transcript to read and wrong before there is one: it pins the field to the
   * floor with an empty page above it. Sized to its own greeting instead, the
   * greeting and the composer become one group the column can centre — the
   * first prompt is typed in the middle of the space it will fill. The pixels
   * come back the moment a message exists, because `resting` is exactly the
   * condition `EmptyTimeline` renders under.
   */
  frameResting: { flex: "0 1 auto" },
  // The block-start padding is what keeps the first prompt off the tab strip;
  // the end spacer below does the same job at the other end.
  //
  // `overflow-anchor` stays at its default here, and that is a measurement
  // rather than an omission. Turning it off reads well on paper: the
  // virtualizer compensates the estimate-to-measured delta of rows above the
  // fold and `anchorTo: "end"` holds the end while a row resizes, so browser
  // anchoring looks like a second authority moving one offset twice. It is
  // not. Virtual-core skips its compensation while the scroll direction is
  // backward — deliberately, because applying it there cascades into rows
  // jumping as a person scrolls up — so anchoring is the half that covers
  // upward scrolling, not a duplicate of the half that does not.
  //
  // Without it, a wheel away from the end has its distance eaten by the next
  // re-measure: the log reaches the end again on its own, `noteScroll` reads
  // that as arrival, and following can no longer be released at all. Nothing
  // in the unit tests or the journey sees this. `bun run resources` does — its
  // 10,000-block probe wheels 120px and waits for "Jump to latest", which
  // never appears. A nested listing is a different case: `CodeBlock` turns
  // anchoring off because it has no virtualizer and follows its own tail.
  viewport: { height: "100%", overflowY: "auto", overflowX: "hidden", paddingInline: size.columnInset, paddingBlockStart: space.lg },
  /** Percentage heights need a definite parent; a resting frame has none, so the viewport measures its own content. */
  viewportResting: { height: "auto", paddingBlockStart: 0 },
  virtualCanvas: (height: number) => ({ height, position: "relative", width: "100%" }),
  virtualRow: (start: number) => ({ position: "absolute", insetInlineStart: 0, insetBlockStart: 0, width: "100%", transform: `translateY(${start}px)` }),
  end: { height: space.xl },
  /**
   * One column, not two. Prose starts where the composer, the approval card
   * and the user's bubble start. An author mark beside it would be a second
   * track, and the assistant is the document this column already is.
   */
  message: { maxWidth: size.column, marginInline: "auto", paddingBlock: space.md, borderBottomWidth: effects.hairline, borderBottomStyle: "solid", borderBottomColor: colors.border },
  /**
   * Prompts sit on the right as the one authored surface in the conversation.
   * The assistant stays on the canvas: input is a discrete object; the answer
   * is the document the rest of the interface is built around.
   */
  userMessage: { maxWidth: size.column, marginInline: "auto", display: "flex", justifyContent: "flex-end", paddingBlockStart: space.md, paddingBlockEnd: space.sm },
  userMessageContinuation: { paddingBlockStart: 0 },
  userMessageBeforeEnd: { paddingBlockEnd: space.md },
  /** Symmetric with its inline padding: a bubble is a card in miniature, and 8 over 12 read as a mistake rather than a decision. */
  userBubble: { maxWidth: "78%", paddingBlock: space.md, paddingInline: space.md, color: colors.text, backgroundColor: colors.surface, borderRadius: radius.md },
  activeMessage: { borderBottomColor: "transparent" },
  messageContinuation: { paddingBlockStart: 0 },
  messageBeforeEnd: { paddingBlockEnd: space.lg, borderBottomColor: "transparent" },
  /**
   * Thinking steps sit in the same column as the prose, with no card and no
   * rule, so a run of tools reads as one tree rather than a stack of objects.
   * Steps inside a phase share a connector; a new reasoning root gets only
   * whitespace. The padding collapse keeps either shape stable across virtual
   * rows.
   */
  // Longhands, deliberately: `messageBeforeEnd` sets `paddingBlockEnd`, and a
  // longhand outranks a shorthand in StyleX whatever the order — so a
  // `paddingBlock: 0` here lost, and the connector broke between a turn's
  // reasoning and its first tool.
  activity: { paddingBlockStart: 0, paddingBlockEnd: 0, borderBottomColor: "transparent" },
  activityStart: { paddingBlockStart: space.sm },
  /** A new reasoning phase is whitespace, not another card or divider. */
  activityEnd: { paddingBlockEnd: space.md },
  messageBody: { minWidth: 0 },
  blocks: { display: "flex", flexDirection: "column" },
  rowGap: { marginBlockStart: space.sm },
  /**
   * An action arriving, in the live path only.
   *
   * Two pixels and 80ms, on opacity and transform — neither is a layout
   * property, so a step easing in cannot move the row beneath it and nothing
   * re-measures on its account. The completed rows deliberately carry none of
   * this: they mount as they scroll into view, so the same entrance there
   * would flash the whole transcript past anyone dragging the scrollbar.
   */
  rowEnter: {
    animationName: { default: enterRow, "@media (prefers-reduced-motion: reduce)": fadeIn },
    animationDuration: { default: motion.fast, "@media (prefers-reduced-motion: reduce)": motion.accessibleFade },
    animationTimingFunction: motion.settle,
  },
  userText: { margin: 0, whiteSpace: "pre-wrap", color: colors.text, fontSize: typography.body, lineHeight: typography.bodyLine },
  // Level with the turn's own header row and in the same muted tone the
  // status word uses, so a boundary reads as a note about the turn rather
  // than as content inside it.
  modelSwitch: { display: "inline-grid", placeItems: "center", color: colors.textFaint },
  /**
   * One row for every turn state, so a turn that ends does not change shape on
   * its way to saying so: the glyph sits in the line rather than above it, and
   * only the tone and the word differ between the three.
   */
  turnState: { display: "inline-flex", alignItems: "center", gap: space.xs, marginBlockEnd: space.sm, fontSize: typography.caption },
  turnWorking: { color: colors.running, fontWeight: 500 },
  turnFailed: { color: colors.danger },
  /** Muted, not red: the interface asked for this one. */
  turnStopped: { color: colors.textMuted },
  /** The `TurnState` word without a message to sit on, so it takes the message's column and seat instead. */
  pending: { maxWidth: size.column, marginInline: "auto", paddingBlock: space.md, display: "flex", alignItems: "center", gap: space.xs, color: colors.running, fontSize: typography.caption, fontWeight: 500 },
  /**
   * One stack, centred, above the log and out of its way. `pointer-events` is
   * off on the stack and back on for each banner, so one sitting over the
   * conversation cannot swallow a scroll or a text selection.
   */
  banners: { position: "absolute", insetBlockStart: space.sm, insetInlineStart: "50%", transform: "translateX(-50%)", zIndex: 2, display: "flex", flexDirection: "column", alignItems: "center", gap: space.xs, maxWidth: "90%", pointerEvents: "none" },
  banner: { display: "flex", alignItems: "center", gap: space.sm, paddingBlock: space.sm, paddingInline: space.md, color: colors.textMuted, backgroundColor: colors.surfaceOverlay, borderRadius: radius.lg, boxShadow: effects.liftOverlay, fontSize: typography.caption, pointerEvents: "auto", animationName: { default: enterBanner, "@media (prefers-reduced-motion: reduce)": fadeIn }, animationDuration: { default: motion.moderate, "@media (prefers-reduced-motion: reduce)": motion.accessibleFade }, animationTimingFunction: motion.settle },
  bannerWarning: { color: colors.warning, backgroundColor: colors.warningSoft },
  /**
   * Same seat the banners take at the top: centred on the conversation, not
   * parked on the pane's trailing edge. The slot owns the centering so the
   * chip can press and enter on its own transform.
   */
  jumpSlot: { position: "absolute", insetInlineStart: "50%", insetBlockEnd: space.md, transform: "translateX(-50%)", zIndex: 2 },
  /**
   * A recovery chip, not a page CTA. Overlay and lift, like the banners, at
   * the dense control height. It arrives from below — that is where the latest
   * content is — and reduced motion keeps the fade.
   */
  jump: {
    height: size.controlDense,
    boxSizing: "border-box",
    display: "inline-flex",
    alignItems: "center",
    gap: space.xs,
    paddingInline: space.md,
    color: colors.text,
    backgroundColor: colors.surfaceOverlay,
    borderWidth: 0,
    borderRadius: radius.lg,
    boxShadow: { default: effects.liftOverlay, ":focus-visible": effects.focusState },
    fontFamily: typography.ui,
    fontSize: typography.caption,
    lineHeight: typography.captionLine,
    fontWeight: 500,
    cursor: "pointer",
    whiteSpace: "nowrap",
    userSelect: "none",
    transform: { default: "none", ":active": "scale(0.97)" },
    animationName: { default: enterJump, "@media (prefers-reduced-motion: reduce)": fadeIn },
    animationDuration: { default: motion.moderate, "@media (prefers-reduced-motion: reduce)": motion.accessibleFade },
    animationTimingFunction: motion.settle,
  },
  empty: { width: "100%", maxWidth: size.column, minHeight: "360px", boxSizing: "border-box", display: "flex", flexDirection: "column", alignItems: "flex-start", justifyContent: "safe center", marginInline: "auto", paddingBlock: space.xxxl, color: colors.textFaint, textAlign: "start" },
  /**
   * Resting, the greeting is the composer's own top edge: same clamp, so the
   * heading starts exactly where `Message Pi` does, and only enough air under
   * it to read as a label for the field rather than as a section above it.
   */
  emptyResting: { maxWidth: size.columnResting, minHeight: 0, paddingBlockStart: 0, paddingBlockEnd: space.md },
  emptyTitle: { marginBlock: 0, color: colors.text, fontFamily: typography.display, fontSize: typography.title, lineHeight: typography.titleLine, fontWeight: 400, letterSpacing: "-0.008em" },
  muted: { marginBlock: 0, color: colors.textFaint, fontSize: typography.caption },
  thought: { color: colors.textMuted, fontSize: typography.caption, lineHeight: typography.captionLine, whiteSpace: "pre-wrap" },
  notice: { padding: space.md, color: colors.textMuted, backgroundColor: colors.surface, borderRadius: radius.lg },
  /**
   * Bounded in both directions, because an attachment is evidence in a
   * conversation rather than the conversation: a phone screenshot at its own
   * dimensions is several viewports of scrolling between two sentences. The
   * plate underneath shows while the fetch is in flight and stays visible
   * behind a transparent PNG, which would otherwise read as a hole.
   */
  image: {
    display: "block",
    maxWidth: "100%",
    maxHeight: "min(48vh, 400px)",
    width: "auto",
    height: "auto",
    borderRadius: radius.md,
    backgroundColor: colors.canvasSubtle,
  },
  errorBlock: { padding: space.md, color: colors.danger, backgroundColor: colors.dangerSoft, borderRadius: radius.lg },
})
