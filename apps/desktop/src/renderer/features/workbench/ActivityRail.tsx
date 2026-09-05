import { useMemo, useState } from "react"
import * as stylex from "@stylexjs/stylex"
import { Check, Circle, CircleCheck, CircleSlash, CircleX, Loader, X } from "lucide-react"
import type { SessionUsage, TodoState, ToolCall, ToolTarget } from "@bake-pi/contract"
import type { SessionActivityView } from "../../store/session-projection.ts"
import { colors, radius, space, typography } from "../../theme/tokens.stylex.ts"
import { focus } from "../../theme/focus.ts"
import { size } from "../../theme/sizes.stylex.ts"
import { scrollbars } from "../../theme/scrollbars.ts"
import { todoCompleted, todoProgress } from "../conversation/todo-state.ts"
import { FileIcon } from "./FileIcon.tsx"
import { pickFileIcon, useFileIcons, type FileIconSet } from "./file-icons.ts"

/**
 * The right rail: what the session has spent, and what it has touched.
 *
 * Context pressure is deliberately not here. The composer's ring is the one
 * gauge for it — two meters for one number would drift apart in language and
 * in precision, and the composer is where the decision the number drives
 * (compact, or ask one more) is actually taken. What the rail owns is spend,
 * history and the plan, and none of them gets a box: an uppercase label at
 * eleven pixels is a heading, and a heading does not need a panel drawn around
 * what follows it.
 *
 * The plan is the third tab, which is where this file said it would arrive:
 * the wireframe put a tracker beside the meter, and the note here was that
 * nothing in the contract carried a plan yet and the tabs were the extension
 * point it would grow into. `TodoState` is that event, and a tab is the right
 * seat for it — the plan used to be a card above the composer, where a long
 * one pushed the conversation up every time the agent revised it, and where
 * the six items it had room for were the first six rather than the ones being
 * worked on. A rail column has the height a plan wants and costs the
 * conversation nothing.
 *
 * A subagent list is still not drawn, for the reason the plan no longer is:
 * nothing in the contract carries one.
 *
 * Everything shown is derived from the snapshot, so it is the same projection
 * the timeline renders and cannot drift from it.
 */
export const ActivityRail = ({ activity, todo, onClose }: { activity: SessionActivityView; todo: TodoState | undefined; onClose?: () => void }): React.JSX.Element => {
  const [tab, setTab] = useState<"changes" | "tools" | "plan">("changes")
  const icons = useFileIcons()
  const calls = activity.calls
  // Four passes over every call in the session. The projection republishes
  // `calls` only when the set actually changed, so its identity is the right
  // key — without it this reruns on every unrelated Workbench render, folded
  // rail included.
  const written = useMemo(() => writtenTargets(calls), [calls])

  return (
    <aside aria-label="Activity" {...stylex.props(styles.rail)}>
      <div {...stylex.props(styles.header)}>
        <span {...stylex.props(styles.eyebrow)}>Activity</span>
        {onClose === undefined ? null : (
          <button type="button" onClick={onClose} aria-label="Close activity" {...stylex.props(focus.control, styles.headerAction)}><X size={16} /></button>
        )}
      </div>

      <Spend usage={activity.usage} />

      {/*
        The count rides each tab so the hidden list is never invisible: a
        person watching tools run can see the first change land without giving
        up the list they are reading.
      */}
      <div role="tablist" aria-label="Session activity" {...stylex.props(styles.tabs)}>
        <button type="button" role="tab" aria-selected={tab === "changes"} onClick={() => setTab("changes")} {...stylex.props(focus.control, styles.tab, tab === "changes" && styles.tabActive)}>
          Changes<span {...stylex.props(styles.tabCount)}>{written.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === "tools"} onClick={() => setTab("tools")} {...stylex.props(focus.control, styles.tab, tab === "tools" && styles.tabActive)}>
          Tools<span {...stylex.props(styles.tabCount)}>{calls.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === "plan"} onClick={() => setTab("plan")} {...stylex.props(focus.control, styles.tab, tab === "plan" && styles.tabActive)}>
          Plan<span {...stylex.props(styles.tabCount)}>{todo?.items.length ?? 0}</span>
        </button>
      </div>

      {/*
        Progress is pinned above the list rather than sitting in it, because a
        plan long enough to scroll is exactly the plan whose "3 of 14" a person
        wants while reading item twelve.
      */}
      {tab === "plan" && todo !== undefined && todo.items.length > 0 ? <PlanProgress todo={todo} /> : null}

      <div {...stylex.props(scrollbars.thin, styles.list)}>
        {tab === "changes" ? <Changes written={written} icons={icons} /> : tab === "tools" ? <Tools calls={calls} /> : <Plan todo={todo} />}
      </div>
    </aside>
  )
}

/**
 * What the session has cost so far, as a ledger rather than a dashboard.
 *
 * The headline is the two numbers that decide whether the session's approach
 * is working: money where the provider reports it, turns everywhere. Beneath
 * it the directions sit on one line — wrapping only if they must — because a
 * sidebar that spends four rows on a bill leaves less of itself for the list
 * the bill is about.
 *
 * Cached and reasoning appear only when they happened, because a zero is a
 * claim and an absent figure is the truth. Reasoning's value is the one
 * coloured number in the rail, and it is the reasoning hue rather than a
 * neutral for a reason: it is what the composer's effort chooser spends, and
 * the two wear the same tone so the setting and its bill read as one fact in
 * two places.
 */
const Spend = ({ usage }: { usage: SessionUsage }): React.JSX.Element => {
  const { turnCount, total, totalCostUsd } = usage
  /** Both directions of cache traffic in one figure — the split matters to the provider's bill, not to a glance. */
  const cached = (total.cacheReadTokens ?? 0) + (total.cacheWriteTokens ?? 0)
  return (
    <section aria-label="Session usage" {...stylex.props(styles.usage)}>
      {turnCount === 0 ? (
        <span {...stylex.props(styles.usageNote)}>Nothing spent yet.</span>
      ) : (
        <>
          <span {...stylex.props(styles.usageValue)}>{totalCostUsd === undefined ? turns(turnCount) : `$${totalCostUsd.toFixed(2)} · ${turns(turnCount)}`}</span>
          <dl {...stylex.props(styles.ledger)}>
            <LedgerRow label="In" value={format(total.inputTokens)} />
            <LedgerRow label="Out" value={format(total.outputTokens)} />
            {cached === 0 ? null : <LedgerRow label="Cached" value={format(cached)} />}
            {(total.reasoningTokens ?? 0) === 0 ? null : <LedgerRow label="Reasoning" value={format(total.reasoningTokens ?? 0)} reasoning />}
          </dl>
        </>
      )}
    </section>
  )
}

const LedgerRow = ({ label, value, reasoning = false }: { label: string; value: string; reasoning?: boolean }): React.JSX.Element => (
  <div {...stylex.props(styles.ledgerRow)}>
    <dt {...stylex.props(styles.ledgerLabel)}>{label}</dt>
    <dd {...stylex.props(styles.ledgerValue, reasoning && styles.ledgerValueReasoning)}>{value}</dd>
  </div>
)

/** One turn is a turn. The rail said "1 turns" until this existed. */
const turns = (count: number): string => `${String(count)} ${count === 1 ? "turn" : "turns"}`

/**
 * Files the session has written, most recent first.
 *
 * Taken from the tool calls' canonicalized targets rather than from their
 * arguments: the target is what the host resolved and what the approval card
 * decided on, so this list names the file that was actually touched and not the
 * string the model asked for. Only writes, and only successful ones — a denied
 * write is a decision, not a change.
 */
const writtenTargets = (calls: ToolCall[]): ToolTarget[] => {
  const seen = new Set<string>()
  return calls
    .filter((call) => call.status === "succeeded")
    .flatMap((call) => call.targets.filter((target) => target.kind === "write"))
    .reverse()
    .filter((target) => !seen.has(target.path) && seen.add(target.path))
}

const Changes = ({ written, icons }: { written: ToolTarget[]; icons: FileIconSet }): React.JSX.Element => {
  if (written.length === 0) return <p {...stylex.props(styles.empty)}>No files changed yet.</p>
  return (
    <>
      {written.map((target) => {
        const name = basename(target.path)
        return (
          <div key={target.path} title={target.path} {...stylex.props(styles.row)}>
            <FileIcon icon={pickFileIcon(icons, { name, kind: "file" }, false)} />
            <span {...stylex.props(styles.rowText)}>
              <span {...stylex.props(styles.rowName)}>{name}</span>
            </span>
            {target.insideWorkspace ? null : <span {...stylex.props(styles.outside)}>outside</span>}
          </div>
        )
      })}
    </>
  )
}

/** Every tool call the session has made, newest first, with how long it took. */
const Tools = ({ calls }: { calls: ToolCall[] }): React.JSX.Element => {
  if (calls.length === 0) return <p {...stylex.props(styles.empty)}>No tools have run yet.</p>
  return (
    <>
      {[...calls].reverse().map((call) => {
        const caption = toolCaption(call)
        return (
          <div key={call.id} {...stylex.props(styles.row)}>
            <ToolMark status={call.status} />
            <span {...stylex.props(styles.rowText)}>
              <span {...stylex.props(styles.rowName)}>{call.name}</span>
              {caption === undefined ? null : <span {...stylex.props(styles.rowCaption)}>{caption}</span>}
            </span>
            <span {...stylex.props(styles.rowMeta)}>{duration(call)}</span>
          </div>
        )
      })}
    </>
  )
}

/**
 * The last task list Pi wrote on this branch, in the order Pi wrote it.
 *
 * Read-only, and that is a design rule rather than an unfinished control: the
 * model changes the list through its todo tool and the next tool result
 * replaces this derivation, so a checkbox here would create a state Pi never
 * recorded and the following snapshot would have to contradict.
 *
 * Every item is drawn, because the rail is a column and can scroll. The card
 * this replaced could show six, which mid-plan meant six completed ones and
 * not the item actually being worked on.
 */
const Plan = ({ todo }: { todo: TodoState | undefined }): React.JSX.Element => {
  if (todo === undefined || todo.items.length === 0) return <p {...stylex.props(styles.empty)}>No plan yet.</p>
  return (
    <ol {...stylex.props(styles.plan)}>
      {todo.items.map((item) => {
        const done = item.status === "completed"
        const active = item.status === "in_progress"
        return (
          <li key={item.id} {...stylex.props(styles.planRow)}>
            <span {...stylex.props(styles.planMark)}>
              {done ? <Check size={13} strokeWidth={2.5} aria-label="completed" {...stylex.props(styles.markGood)} />
                : <Circle size={9} fill={active ? "currentColor" : "none"} aria-label={active ? "in progress" : "pending"} {...stylex.props(active ? styles.markRunning : styles.rowIcon)} />}
            </span>
            <span {...stylex.props(styles.planText, done && styles.planTextDone, active && styles.planTextActive)}>{item.text}</span>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * How much of the plan is done, in words and as a hairline.
 *
 * The words are the fact and the bar is the glance; the bar carries no number
 * of its own, so the two cannot disagree the way a second meter would. It is
 * the same count the todo step in the transcript reports, from the same
 * derivation, for the same reason.
 */
const PlanProgress = ({ todo }: { todo: TodoState }): React.JSX.Element => {
  const completed = todoCompleted(todo)
  return (
    <section aria-label="Plan progress" {...stylex.props(styles.planProgress)}>
      <span {...stylex.props(styles.planCount)}>{todoProgress(todo)}</span>
      <span aria-hidden="true" {...stylex.props(styles.planTrack)}>
        <span {...stylex.props(styles.planFill(Math.round((completed / todo.items.length) * 100)))} />
      </span>
    </section>
  )
}

/**
 * What a tool row says under the tool's name: what it touched, whose it is,
 * and how it ended when the ending was a decision.
 *
 * The target is the write before the read, because the write is the change.
 * The extension's name is there because the contract flags extension tools and
 * a row that did not say so would be hiding where the capability came from.
 * Denied and aborted are named in words because their marks alone ask a person
 * to tell two kinds of nothing apart.
 */
const toolCaption = (call: ToolCall): string | undefined => {
  const target = call.targets.find((t) => t.kind === "write") ?? call.targets[0]
  const parts = [
    target === undefined ? undefined : basename(target.path),
    call.source === "extension" ? (call.extensionName ?? "extension") : undefined,
    call.status === "denied" || call.status === "aborted" ? call.status : undefined,
  ].filter((part) => part !== undefined)
  return parts.length === 0 ? undefined : parts.join(" · ")
}

const ToolMark = ({ status }: { status: ToolCall["status"] }): React.JSX.Element =>
  status === "succeeded" ? <CircleCheck size={14} aria-label="succeeded" {...stylex.props(styles.rowIcon, styles.markGood)} />
  : status === "failed" ? <CircleX size={14} aria-label="failed" {...stylex.props(styles.rowIcon, styles.markBad)} />
  : status === "denied" || status === "aborted" ? <CircleSlash size={14} aria-label={status} {...stylex.props(styles.rowIcon)} />
  : <Loader size={14} aria-label={status} {...stylex.props(styles.rowIcon, styles.markRunning)} />

/**
 * How long a call took, from the host's own two instants.
 *
 * Both come from the same process, which is the only reason subtracting them is
 * allowed: durations cross the process boundary in this codebase and instants
 * never do. A call still running has one instant and gets no duration.
 */
const duration = (call: ToolCall): string => {
  if (call.startedAt === undefined || call.endedAt === undefined) return ""
  const ms = call.endedAt - call.startedAt
  return ms < 1000 ? `${String(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

const format = (tokens: number): string =>
  tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)

/** The last segment of a canonical path, whichever separator the platform used. */
const basename = (path: string): string => path.split(/[\\/]/).at(-1) ?? path

const styles = stylex.create({
  rail: { minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", backgroundColor: colors.canvasSubtle },
  /**
   * The same 16px gutter the file rail keeps. Header, spend, tabs and list
   * all pad to it directly — a number in the ledger and a file name below
   * therefore begin on the same line from the window edge.
   */
  header: { flex: "none", height: size.railHeader, display: "flex", alignItems: "center", gap: space.xs, paddingInlineStart: size.gutter, paddingInlineEnd: space.sm },
  /**
   * The rail's name, set as an eyebrow rather than as a heading.
   *
   * Tracked to 0.12em and drawn in `textMuted` rather than `textFaint`: at
   * 11.5px uppercase, tracking is what separates a label from a smudge, and
   * the muted step is what lets it be read at a glance without competing with
   * the rows beneath it. It carries no rule under it — the 16px gutter every
   * row below shares is what says where the rail begins.
   */
  eyebrow: { flex: 1, color: colors.textMuted, fontSize: typography.micro, lineHeight: typography.microLine, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" },
  headerAction: {
    width: size.controlDense, height: size.controlDense, display: "grid", placeItems: "center", padding: 0,
    color: { default: colors.textMuted, ":hover": colors.text, ":active": colors.text },
    backgroundColor: { default: "transparent", ":hover": colors.surface, ":active": colors.sunken },
    borderWidth: 0, borderRadius: radius.sm, cursor: "pointer",
    transform: { default: "none", ":active": "scale(0.97)" },
  },

  usage: { flex: "none", display: "flex", flexDirection: "column", gap: space.xs, paddingInline: size.gutter, marginBlockEnd: space.md },
  /**
   * A number, not a headline. Body size against an eleven-pixel eyebrow is
   * enough; anything larger claims the rail on a session that has barely
   * started.
   */
  usageValue: { color: colors.text, fontSize: typography.body, lineHeight: typography.bodyLine, fontWeight: 600, fontVariantNumeric: "tabular-nums" },
  usageNote: { color: colors.textMuted, fontSize: typography.caption, lineHeight: typography.captionLine },
  /** Directions as pairs on one line, wrapping only when the rail is too narrow to hold them. */
  ledger: { display: "flex", flexWrap: "wrap", columnGap: space.md, rowGap: space.xs, margin: 0 },
  ledgerRow: { display: "flex", alignItems: "baseline", gap: space.xs },
  ledgerLabel: { color: colors.textMuted, fontSize: typography.caption, lineHeight: typography.captionLine },
  ledgerValue: { margin: 0, color: colors.text, fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine, fontVariantNumeric: "tabular-nums" },
  /** What the effort chooser spent, in the chooser's own hue. */
  ledgerValueReasoning: { color: colors.reasoning },

  /**
   * Two words, not a well. Selection is weight and colour — a recessed
   * segmented control was three signals (fill, outline, shadow) for a choice
   * that two labels already carry.
   */
  tabs: { flex: "none", display: "flex", gap: space.md, paddingInline: size.gutter, marginBlockEnd: space.sm },
  tab: {
    height: size.controlDense, display: "inline-flex", alignItems: "center", gap: space.xs, padding: 0,
    color: { default: colors.textMuted, ":hover": colors.text, ":active": colors.text },
    backgroundColor: "transparent", borderWidth: 0, cursor: "pointer",
    fontFamily: typography.ui, fontSize: typography.caption, lineHeight: typography.captionLine,
  },
  tabActive: { color: colors.text, fontWeight: 600 },
  /** The count stays faint on the active tab too — it is the list's size, not its state. */
  tabCount: { color: colors.textFaint, fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine, fontVariantNumeric: "tabular-nums" },

  planProgress: { flex: "none", display: "flex", flexDirection: "column", gap: space.xs, paddingInline: size.gutter, marginBlockEnd: space.sm },
  planCount: { color: colors.textMuted, fontSize: typography.caption, lineHeight: typography.captionLine, fontVariantNumeric: "tabular-nums" },
  /** Two pixels of it, on the rail's own ground: a plan's shape, not a gauge. */
  planTrack: { height: "2px", overflow: "hidden", backgroundColor: colors.canvas, borderRadius: radius.sm },
  planFill: (percent: number) => ({ width: `${String(percent)}%`, height: "100%", display: "block", backgroundColor: colors.success, borderRadius: radius.sm }),
  plan: { display: "flex", flexDirection: "column", margin: 0, padding: 0, listStyle: "none" },
  /**
   * A task is a sentence, so this row wraps where a file name ellipsizes, and
   * the mark sits on the first line rather than centred against three of them.
   */
  planRow: { flex: "none", display: "flex", alignItems: "flex-start", gap: space.sm, paddingBlock: space.xs, color: colors.textMuted },
  planMark: { width: size.icon, height: typography.labelLine, flex: "none", display: "grid", placeItems: "center", color: colors.textFaint },
  planText: { minWidth: 0, overflowWrap: "anywhere", fontSize: typography.label, lineHeight: typography.labelLine },
  /** Struck through and faint: a finished item is history the eye can skip. */
  planTextDone: { color: colors.textFaint, textDecorationLine: "line-through", textDecorationThickness: "1px" },
  planTextActive: { color: colors.text },

  list: { flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", paddingInline: size.gutter, paddingBlockEnd: space.lg },
  /**
   * Rows are not controls. They have no hover fill, because a fill on
   * something that cannot be pressed reads as a missed click.
   */
  row: { flex: "none", minHeight: size.controlDense, display: "flex", alignItems: "center", gap: space.sm, color: colors.textMuted, fontSize: typography.label, lineHeight: typography.labelLine },
  rowIcon: { flex: "none", color: colors.textFaint },
  /** Name over caption, the same row language the composer's menus speak. */
  rowText: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column" },
  rowName: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.text },
  rowCaption: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.textFaint, fontSize: typography.micro, lineHeight: typography.microLine },
  rowMeta: { flex: "none", color: colors.textFaint, fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine, fontVariantNumeric: "tabular-nums" },
  /** A word, not a chip: the hue is the second signal, the word is the first. */
  outside: { flex: "none", color: colors.warning, fontSize: typography.micro, lineHeight: typography.microLine },
  markGood: { color: colors.success },
  markBad: { color: colors.danger },
  markRunning: { color: colors.running },
  empty: { margin: 0, paddingBlock: space.sm, color: colors.textFaint, fontSize: typography.caption, lineHeight: typography.captionLine },
})
