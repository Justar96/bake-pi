import * as stylex from "@stylexjs/stylex"
import { ListChecks } from "lucide-react"
import { colors, motion, space, typography } from "../../theme/tokens.stylex.ts"
import { size } from "../../theme/sizes.stylex.ts"
import type { TurnSummary as TurnSummaryModel } from "./turn-summary.ts"

/**
 * The turn's recap, directly beneath the answer it describes.
 *
 * It is metadata about the answer rather than another object in the transcript,
 * so it stays on the canvas with no fill, corner, or outline. Its groups wrap
 * as one quiet line instead of turning a short recap into a second card.
 *
 * One glance, three facts, in the order they are wanted: how much was done, to
 * which files, at what cost. Nothing here is expandable — the steps above it
 * are the detail, and the activity rail is the session's whole list — so a
 * chevron would only ever reveal what is already on screen.
 */
export const TurnSummary = ({ summary }: { summary: TurnSummaryModel }): React.JSX.Element => {
  const shown = summary.changes.slice(0, FILES_SHOWN)
  const hidden = summary.changes.length - shown.length
  return (
    <section aria-label="Turn summary" {...stylex.props(styles.summary)}>
      <div {...stylex.props(styles.head)}>
        <ListChecks size={13} aria-hidden="true" {...stylex.props(styles.icon)} />
        <h3 {...stylex.props(styles.title)}>Summary</h3>
        <span {...stylex.props(styles.meta)}>
          {tools(summary.tools)}
          {summary.toolMs === undefined ? null : ` · ${elapsed(summary.toolMs)}`}
        </span>
        {/* Never colour alone: the count says "failed" in the word as well. */}
        {summary.failed === 0 ? null : <span {...stylex.props(styles.failed)}>{summary.failed} failed</span>}
      </div>

      {summary.changes.length === 0 ? (
        <span {...stylex.props(styles.note)}>No files changed</span>
      ) : (
        <ul {...stylex.props(styles.files)}>
          {shown.map((change) => (
            <li key={change.path} title={change.path} {...stylex.props(styles.file)}>
              <span {...stylex.props(styles.name)}>{change.name}</span>
              <span {...stylex.props(styles.counts)}>
                {change.added === undefined || change.added === 0 ? null : <span {...stylex.props(styles.added)}>+{change.added}</span>}
                {change.removed === undefined || change.removed === 0 ? null : <span {...stylex.props(styles.removed)}>−{change.removed}</span>}
              </span>
            </li>
          ))}
          {hidden === 0 ? null : (
            <li {...stylex.props(styles.file, styles.more)}>{hidden} more {hidden === 1 ? "file" : "files"}</li>
          )}
        </ul>
      )}

      {summary.inputTokens === undefined || summary.outputTokens === undefined ? null : (
        <span {...stylex.props(styles.note)}>{format(summary.inputTokens)} in · {format(summary.outputTokens)} out</span>
      )}
    </section>
  )
}

/**
 * Five files, then a count. The rail holds the whole list, and a recap long
 * enough to scroll is no longer a recap — it is the list, drawn twice.
 */
const FILES_SHOWN = 5

/** One tool is a tool. */
const tools = (count: number): string => `${String(count)} ${count === 1 ? "tool" : "tools"}`

/** The same two shapes the tool rows in the activity rail use, so one duration does not read two ways. */
const elapsed = (ms: number): string => ms < 1000 ? `${String(ms)}ms` : `${(ms / 1000).toFixed(1)}s`

const format = (tokens: number): string =>
  tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)

/** The recap settling in after the last token, at the smallest travel that still reads as arrival. */
const enterSummary = stylex.keyframes({ from: { opacity: 0, transform: "translateY(3px)" } })
const fadeIn = stylex.keyframes({ from: { opacity: 0 } })

const styles = stylex.create({
  /**
   * The conversation's own column and inset put this immediately under the
   * answer. The answer already pays for its trailing space, so another top
   * margin would detach the recap from the turn it describes.
   */
  summary: {
    maxWidth: size.column,
    boxSizing: "border-box",
    marginInline: "auto",
    marginBlockStart: 0,
    marginBlockEnd: space.lg,
    display: "flex",
    alignItems: "baseline",
    flexWrap: "wrap",
    columnGap: space.md,
    rowGap: space.xs,
    animationName: { default: enterSummary, "@media (prefers-reduced-motion: reduce)": fadeIn },
    animationDuration: { default: motion.moderate, "@media (prefers-reduced-motion: reduce)": motion.accessibleFade },
    animationTimingFunction: motion.settle,
  },
  head: { display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 },
  icon: { flex: "none", color: colors.textFaint },
  /** A heading at caption size: this labels a note, and a note's label is not a title. */
  title: { flex: "none", margin: 0, color: colors.text, fontFamily: typography.ui, fontSize: typography.caption, lineHeight: typography.captionLine, fontWeight: 600 },
  /** The counts trail the label and clip before it does. */
  meta: { flex: 1, minWidth: 0, color: colors.textFaint, fontSize: typography.caption, lineHeight: typography.captionLine, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  failed: { flex: "none", color: colors.danger, fontSize: typography.caption, lineHeight: typography.captionLine, fontWeight: 500 },
  files: { minWidth: 0, maxWidth: "100%", display: "flex", alignItems: "baseline", flexWrap: "wrap", columnGap: space.md, rowGap: space.xs, margin: 0, padding: 0, listStyle: "none" },
  /**
   * Each file keeps its counts attached while the list itself wraps. A long
   * path clips inside its item instead of pushing the rest of the recap away.
   */
  file: { display: "inline-flex", alignItems: "baseline", gap: space.xs, minWidth: 0 },
  name: { minWidth: 0, maxWidth: "240px", color: colors.textMuted, fontFamily: typography.mono, fontSize: typography.caption, lineHeight: typography.captionLine, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  counts: { flex: "none", display: "flex", gap: space.sm, fontFamily: typography.mono, fontSize: typography.caption, lineHeight: typography.captionLine, fontVariantNumeric: "tabular-nums" },
  added: { color: colors.diffAdded },
  removed: { color: colors.diffRemoved },
  more: { color: colors.textFaint, fontSize: typography.caption, lineHeight: typography.captionLine },
  note: { margin: 0, color: colors.textFaint, fontSize: typography.caption, lineHeight: typography.captionLine },
})
