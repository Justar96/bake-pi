import { Children, useLayoutEffect, useState } from "react"
import * as stylex from "@stylexjs/stylex"
import { Check, ChevronRight, Clock3, File, FileDiff, FilePen, FileSearch, FolderOpen, ListTodo, Puzzle, ShieldBan, SquareStop, Terminal, X, type LucideIcon } from "lucide-react"
import { colors, effects, motion, radius, space, typography } from "../../theme/tokens.stylex.ts"
import { focus } from "../../theme/focus.ts"
import { shimmer } from "../../theme/shimmer.ts"
import type { ActivityKind } from "./tool-present.ts"
import { useStepDisclosure } from "./disclosure.ts"
import type { ActivityStatus, StepOutcome } from "./tool-state.ts"

/**
 * One row of a thinking-steps list, without a card around it.
 *
 * Fluid's ThinkingSteps is an accordion of icon + connector + label. Wrapping
 * each tool in a raised surface made a turn of six calls look like six objects
 * instead of one chain of work, which is the opposite of the step list. The
 * connector is a 1px fill down the icon column — structure of the list, not an
 * outline of a box — and it stops on the last step of a run. A reasoning-led
 * phase gets one more level: its tools move in by 24px and branch from the
 * heading's rail, matching the compact tree in the reference without wrapping
 * the turn in another surface.
 *
 * The header is one line: the verb, the file it acted on as its own small
 * raised object, then whatever else the step is about (a path, a line count)
 * in a muted run that clips before either of them does. Everything
 * else — the listing, the diff, the thought — is behind that line. A step
 * opens itself while its turn is running, because a running turn's work is
 * the thing being watched, and fades closed when the turn ends — a finished
 * turn of eight tools with eight listings open was the wall of text the step
 * list exists to replace. A person can reopen any of them, and the
 * disclosure preference (`disclosure.ts`) can pin every step open or closed.
 *
 * A tool waiting for approval stays collapsed and carries a clock; a running
 * one opens itself and shimmers the label. Completed tools use distinct marks
 * for success, failure, denial and cancellation, so none of those states has
 * to borrow another one's icon. Reduced motion drops the shimmer to the flat
 * running tone, since a swept gradient held still is a word coloured by
 * wherever the sweep stopped.
 */

/**
 * One glyph per kind of work, and one tone. The glyphs are the distinction a
 * person can name — a diff mark is not a pen is not a prompt — and the tone
 * reinforces it on the grey ladder the theme file describes: looking at the
 * workspace sits low, changing it sits high, and running something sits
 * between. Tone never carries the meaning alone; the glyph and the verb in the
 * label do, which is the rule the palette imposes.
 */
const ICONS = {
  reasoning: undefined,
  read: File,
  write: FilePen,
  edit: FileDiff,
  shell: Terminal,
  search: FileSearch,
  list: FolderOpen,
  todo: ListTodo,
  extension: Puzzle,
  result: Terminal,
} as const

/**
 * How a step ended, as one row per state.
 *
 * The mark, the name it is announced by and the tone it gives the glyph are one
 * decision, so they are declared together and read once. Typing the table over
 * the outcome union makes a status Pi adds a compile error here rather than a
 * step that silently renders no mark, which is what a chain of conditionals in
 * the JSX gave when a branch was missed.
 */
const MARKS = {
  pending: { Icon: Clock3, name: "awaiting approval", mark: "markPending", tone: "tonePending" },
  failed: { Icon: X, name: "failed", mark: "markFailed", tone: "toneFailed" },
  denied: { Icon: ShieldBan, name: "denied", mark: "markDenied", tone: "toneDenied" },
  aborted: { Icon: SquareStop, name: "stopped", mark: "markAborted", tone: "toneAborted" },
  // Success is the tone the kind already chose; only the failures step off it.
  succeeded: { Icon: Check, name: "succeeded", mark: "markSucceeded", tone: undefined },
} as const satisfies Record<"pending" | StepOutcome, { Icon: LucideIcon; name: string; mark: keyof typeof styles; tone: keyof typeof styles | undefined }>

const TONES = {
  reasoning: "toneThought",
  read: "toneLow",
  list: "toneLow",
  search: "toneMid",
  todo: "toneTodo",
  extension: "toneMid",
  result: "toneLow",
  shell: "toneRun",
  write: "toneChange",
  edit: "toneChange",
} as const

export const ThinkingStep = ({
  kind,
  label,
  target,
  targetPath,
  description,
  status = "complete",
  outcome,
  first = false,
  last = false,
  nested = false,
  turnActive = false,
  children,
}: {
  kind: ActivityKind
  label: string
  /** The file the step acted on, drawn as a chip after the verb. */
  target?: string
  /** The whole path behind that chip, carried as its tooltip. */
  targetPath?: string
  /** One line beside the label: a path, a count, a pattern. Never a paragraph. */
  description?: string
  status?: ActivityStatus
  /** How the step ended, when the header should say so without being opened. */
  outcome?: StepOutcome
  /** Ends of this reasoning-led group. The connector starts at the heading and stops at its last tool. */
  first?: boolean
  last?: boolean
  /** Tools beneath a reasoning heading use the child branch rather than the root rail. */
  nested?: boolean
  /** Whether the turn this step belongs to is still running. `auto` disclosure closes steps when it ends. */
  turnActive?: boolean
  children?: React.ReactNode
}): React.JSX.Element => {
  const Icon = ICONS[kind]
  const tone = styles[TONES[kind]]
  const active = status === "active"
  const pending = status === "pending"
  // `toArray` drops null, undefined and booleans, so a caller's conditional
  // slots that all came out empty do not count as content to disclose.
  const collapsible = Children.toArray(children).length > 0
  // The preference decides the default; `auto` keeps the turn's steps open
  // until it ends, or as long as a step asked to start disclosed.
  const disclosure = useStepDisclosure()
  const automatic = disclosure === "open" ? true : disclosure === "collapsed" ? false : active || turnActive
  // Undefined until a click: the live preview can then close itself when the
  // next action starts, and a person who opened or closed the step keeps that.
  const [openedByUser, setOpenedByUser] = useState<boolean | undefined>(undefined)
  const open = collapsible && (openedByUser ?? automatic)
  const [shown, setShown] = useState(open)
  useLayoutEffect(() => {
    if (open) setShown(true)
  }, [open])
  // Approval outranks an outcome: a pending call has none yet.
  const state = pending ? MARKS.pending : outcome === undefined ? undefined : MARKS[outcome]

  /*
    The shimmer sits on the verb, which is the one element here with text of
    its own to carry it: the sweep is a gradient clipped to glyphs, so a
    container clips nothing and its children go on painting their own colour.

    The pair used to pulse together instead — one opacity animation on the
    subject, chosen because two elements carrying the same keyframes are two
    animations and nothing in CSS promises they start on the same frame. One
    animated element per step keeps that promise rather than relying on it,
    and the file chip is a raised object: a sweep through its fill would read
    as the chip flickering rather than as the verb working.

    The chip carries `data-step-target` because `bun run journey` has to assert
    the row is *structured* — the verb and the file as two elements, the base
    name shown and the whole path in the tooltip — and not merely that both
    strings appear somewhere in the timeline text. StyleX class names are
    content hashes, so they are not something a test may name; an accessible
    name would be wrong here, since the chip is part of the step's own label
    rather than a separate thing to announce.
  */
  const header = (
    <>
      <span {...stylex.props(styles.subject)}>
        <span title={label} {...stylex.props(styles.label, nested && styles.childLabel, active && shimmer.text)}>
          {label}{active && target === undefined ? "…" : ""}
        </span>
        {target === undefined ? null : <span data-step-target="" title={targetPath ?? target} {...stylex.props(styles.target)}>{target}</span>}
      </span>
      {description === undefined ? null : <span title={description} {...stylex.props(styles.description)}>{description}</span>}
      {state === undefined ? null : <state.Icon size={12} aria-label={state.name} {...stylex.props(styles.mark, styles.markTrailing, styles[state.mark])} />}
      {collapsible ? <ChevronRight size={12} aria-hidden="true" {...stylex.props(styles.mark, state === undefined && styles.markTrailing, styles.chevron, open && styles.chevronOpen)} /> : null}
    </>
  )

  return (
    <div {...stylex.props(styles.step, nested && styles.nestedStep)}>
      {/*
        `data-step-rail` is here for the same reason the chip carries its own
        attribute: the tree is four absolutely-positioned fills whose classes
        are content hashes, and whether they line up is a number, not a
        picture. `bun run journey` reads the rects inside this element and
        requires the run under a heading, the rail its children hang from and
        the branch into each one to agree on a single x — which is the whole
        of what "the line is straight" means, and is invisible to any
        assertion about text.
      */}
      <div data-step-rail="" {...stylex.props(styles.rail)}>
        {nested ? (
          <>
            <span aria-hidden="true" {...stylex.props(styles.parentConnector, last && styles.parentConnectorToIcon)} />
            <span aria-hidden="true" {...stylex.props(styles.branch)} />
          </>
        ) : first && last ? null : (
          <span aria-hidden="true" {...stylex.props(styles.connector, first && styles.connectorFromIcon, last && styles.connectorToIcon)} />
        )}
        <span {...stylex.props(styles.icon, tone, state?.tone !== undefined && styles[state.tone])}>
          <span {...stylex.props(styles.glyph)}>
            {Icon === undefined
              ? <span aria-hidden="true" {...stylex.props(styles.dot)} />
              : <Icon size={14} aria-hidden="true" />}
          </span>
        </span>
      </div>
      <div {...stylex.props(styles.body)}>
        {collapsible ? (
          <button type="button" aria-expanded={open} onClick={() => setOpenedByUser(!(openedByUser ?? automatic))} {...stylex.props(focus.ring, styles.header, styles.headerButton)}>
            {header}
          </button>
        ) : (
          <div {...stylex.props(styles.header)}>{header}</div>
        )}
        {shown ? (
          <div
            onTransitionEnd={(event) => {
              if (!open && event.propertyName === "opacity") setShown(false)
            }}
            {...stylex.props(styles.content, open && styles.contentOpen)}
          >
            <div {...stylex.props(styles.contentInner)}>{children}</div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

const styles = stylex.create({
  /**
   * The row's breathing room is on the body, not the step, so the rail runs
   * the row's full height and the connector meets the next row's without a
   * gap. Consecutive steps are separate elements — separate virtual rows, even
   * — and one continuous line is what makes them read as one list anyway.
   */
  step: { display: "flex", gap: space.sm, minWidth: 0 },
  nestedStep: { marginInlineStart: space.xl },
  rail: { position: "relative", flex: "none", alignSelf: "stretch", width: "14px" },
  /** Centred on the 24px header line, so the connector meets the icon squarely. */
  icon: { position: "relative", width: "14px", height: "24px", marginBlockStart: "2px", display: "grid", placeItems: "center", color: colors.textFaint },
  /** Sits on the canvas so the line passes behind the glyph rather than through it. */
  glyph: { width: "14px", height: "14px", display: "grid", placeItems: "center", backgroundColor: colors.canvas },
  dot: { width: "6px", height: "6px", borderRadius: radius.pill, backgroundColor: "currentColor" },
  toneLow: { color: colors.textFaint },
  toneMid: { color: colors.textMuted },
  toneRun: { color: colors.running },
  toneTodo: { color: colors.running },
  toneChange: { color: colors.diffAdded },
  toneThought: { color: colors.reasoning },
  tonePending: { color: colors.warning },
  toneFailed: { color: colors.danger },
  toneDenied: { color: colors.warning },
  toneAborted: { color: colors.textMuted },
  /**
   * Full height by default; the ends of a run pull it back to the icon's
   * centre. The border tone, not the subtle canvas: one step above the canvas
   * is invisible on it.
   *
   * `7px`, and not the `calc(50% - 0.5px)` that centres a hairline in a 14px
   * rail. Every other line in the tree is placed from the same 7px — the
   * branch of a nested row, and the parent rail it turns off — so a centred
   * line put the root half a pixel to their left: at any scale factor where
   * that lands between device pixels, the run under a phase heading rendered
   * as two half-intensity columns and its children as one solid one, and the
   * tree visibly stepped sideways where the two met. A tree of lines has to
   * agree on one x, and an integer is the only x that survives rounding.
   */
  connector: { position: "absolute", insetInlineStart: "7px", insetBlockStart: 0, insetBlockEnd: 0, width: "1px", backgroundColor: colors.borderStrong },
  connectorFromIcon: { insetBlockStart: "14px" },
  connectorToIcon: { insetBlockEnd: "calc(100% - 14px)" },
  /** The parent's x-position after this row moves in by `space.xl`: 7px - 24px. */
  parentConnector: { position: "absolute", insetInlineStart: `calc(7px - ${space.xl})`, insetBlockStart: 0, insetBlockEnd: 0, width: "1px", backgroundColor: colors.borderStrong },
  parentConnectorToIcon: { insetBlockEnd: "calc(100% - 14px)" },
  branch: { position: "absolute", insetInlineStart: `calc(7px - ${space.xl})`, insetBlockStart: "14px", width: space.xl, height: "1px", backgroundColor: colors.borderStrong },
  body: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: space.xs, paddingBlock: "2px" },
  /**
   * One line, 24px, and the label wins the fight for room: the description
   * is the part that can lose characters without losing the sentence, so it
   * shrinks first, by a wide margin. Both can shrink, though — a label that
   * refused to (a `Ran` followed by a whole shell pipeline) pushed the marks
   * past the column and put a horizontal scrollbar under the conversation.
   */
  header: { width: "100%", minWidth: 0, minHeight: "24px", boxSizing: "border-box", display: "flex", alignItems: "center", gap: space.sm, paddingBlock: 0, paddingInline: 0, textAlign: "start" },
  headerButton: { marginInline: `calc(-1 * ${space.xs})`, paddingInline: space.xs, width: `calc(100% + 2 * ${space.xs})`, color: "inherit", backgroundColor: { default: "transparent", ":hover": colors.surface }, borderWidth: 0, borderRadius: radius.sm, fontFamily: typography.ui, cursor: "pointer",  transitionProperty: "background-color", transitionDuration: motion.fast, transitionTimingFunction: motion.settle },
  /**
   * The verb and its file, as one shrinkable run. The file gives up characters
   * twice as readily as the verb does — a base name still identifies a file
   * from its front, and `Ran` truncated to `Ra` identifies nothing — but both
   * can shrink, because a label that refused to (a `Searched` followed by a
   * whole regex) pushed the marks past the column.
   */
  subject: { flexGrow: 0, flexShrink: 1, flexBasis: "auto", minWidth: 0, display: "flex", alignItems: "center", gap: space.xs },
  label: { flexGrow: 0, flexShrink: 1, flexBasis: "auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.text, fontSize: typography.label, fontWeight: 500, lineHeight: typography.labelLine },
  /**
   * A tool beneath a reasoning heading is the work, not the heading. The
   * reference separates the two by weight and tone rather than by size, and
   * size is the one axis that cannot change here: these rows are virtualized
   * against one estimate, and a heading a few pixels taller than its children
   * pays for itself in re-measurement on every turn.
   */
  childLabel: { color: colors.textMuted, fontWeight: 400 },
  /**
   * The file as a contained object: two pixels of softening and a fill that
   * steps above both the canvas and the header's own hover, never a line
   * drawn around it. `surfaceRaised` rather than `surface` is exactly because
   * of that hover — a chip filled with the colour its row turns on hover
   * disappears under the pointer, and light flattens the pair to white first.
   * The hairline is 0px outside high contrast, where the lift is `none` and an
   * outline is the requirement rather than the decoration.
   */
  target: {
    flexGrow: 0,
    flexShrink: 2,
    flexBasis: "auto",
    minWidth: 0,
    boxSizing: "border-box",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    paddingBlock: "1px",
    paddingInline: space.xs,
    color: colors.text,
    backgroundColor: colors.surfaceRaised,
    borderWidth: effects.hairline,
    borderStyle: "solid",
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    boxShadow: effects.lift,
    fontFamily: typography.mono,
    fontSize: typography.caption,
    lineHeight: typography.captionLine,
  },
  description: { flexGrow: 0, flexShrink: 999, flexBasis: "auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.textFaint, fontSize: typography.caption, lineHeight: typography.captionLine, fontFamily: typography.mono },
  mark: { flex: "none", color: colors.textFaint },
  /** The first mark takes the remaining room; a chevron after it sits beside it. */
  markTrailing: { marginInlineStart: "auto" },
  markPending: { color: colors.warning },
  markSucceeded: { color: colors.success },
  markFailed: { color: colors.danger },
  markDenied: { color: colors.warning },
  markAborted: { color: colors.textMuted },
  chevron: { transitionProperty: "transform", transitionDuration: motion.fast, transitionTimingFunction: motion.move },
  chevronOpen: { transform: "rotate(90deg)" },
  /**
   * Open is instant: a running tool's listing is the thing being watched.
   * Close fades and collapses, because the next action starting would
   * otherwise teleport the listing away. Reduced motion collapses the
   * duration at the token.
   */
  content: {
    display: "grid",
    gridTemplateRows: "0fr",
    minWidth: 0,
    opacity: 0,
    transitionProperty: "grid-template-rows, opacity",
    transitionDuration: motion.moderateExit,
    transitionTimingFunction: motion.settle,
  },
  contentOpen: { gridTemplateRows: "1fr", opacity: 1, transitionDuration: "0ms" },
  contentInner: { minHeight: 0, minWidth: 0, overflow: "hidden", paddingBlockEnd: space.xs },
})
