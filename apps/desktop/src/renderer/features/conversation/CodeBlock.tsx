import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"
import * as stylex from "@stylexjs/stylex"
import { Check, Copy } from "lucide-react"
import { colors, effects, radius, space, typography } from "../../theme/tokens.stylex.ts"
import { size } from "../../theme/sizes.stylex.ts"
import { focus } from "../../theme/focus.ts"
import { useAppearance } from "../../theme/appearance.ts"
import { scrollbars } from "../../theme/scrollbars.ts"
import { languageForFile, resolveLanguage, useTokens, type Token } from "./highlight.ts"
import type { DiffFile } from "./diff-model.ts"
import { listingFromDiffFile, type ListingRow, type PresentedDiff } from "./tool-present.ts"
import type { CodePiece } from "./word-diff.ts"
import { ansiTokens, stripAnsi } from "./ansi.ts"
import { followingAfterTimelineScroll, listingConsumesWheel, shouldDetachFollowOnWheel } from "./timeline-follow.ts"
import { FileIcon } from "../workbench/FileIcon.tsx"
import { pickFileIcon, useFileIcons } from "../workbench/file-icons.ts"

/**
 * A light editor listing, not a card around one.
 *
 * Fluid's code-block is a filename, a gutter, wrapping lines, and — when the
 * listing is a diff — a 3px accent, a row tint, and word-level add/del marks.
 * The surrounding chrome in that component is a raised card with a shadow, and
 * that is the part this one leaves off: a listing that already sits inside a
 * thinking step does not also need to be an object. The sunken fill is the
 * substrate the syntax theme is measured on, not a second wrapper.
 *
 * Colour still arrives through React's `style` prop. That is a CSSOM write,
 * which `style-src` does not police — see `highlight.ts`. The add/del tints
 * are StyleX, because they are a closed set of states rather than per-token
 * data.
 */

export const TokenRun = ({ tokens }: { tokens: Token[] }): React.JSX.Element => (
  <>
    {tokens.map((token, index) => (
      <span
        key={index}
        style={{
          color: token.color,
          fontWeight: token.bold ? 700 : undefined,
          fontStyle: token.italic ? "italic" : undefined,
          textDecoration: token.underline ? "underline" : undefined,
        }}
      >
        {token.text}
      </span>
    ))}
  </>
)

const sliceTokens = (tokens: Token[], start: number, end: number): Token[] => {
  const sliced: Token[] = []
  let pos = 0
  for (const token of tokens) {
    const tokenEnd = pos + token.text.length
    if (tokenEnd <= start) {
      pos = tokenEnd
      continue
    }
    if (pos >= end) break
    const from = Math.max(0, start - pos)
    const to = Math.min(token.text.length, end - pos)
    sliced.push({ ...token, text: token.text.slice(from, to) })
    pos = tokenEnd
  }
  return sliced
}

const Pieces = ({ pieces, tokens }: { pieces: CodePiece[]; tokens: Token[] | undefined }): React.JSX.Element => {
  if (tokens === undefined) {
    return (
      <>
        {pieces.map((piece, index) => (
          <span key={index} {...stylex.props(piece.change === "add" && styles.pieceAdd, piece.change === "del" && styles.pieceDel)}>
            {piece.text}
          </span>
        ))}
      </>
    )
  }
  let offset = 0
  return (
    <>
      {pieces.map((piece, index) => {
        const start = offset
        offset += piece.text.length
        const run = sliceTokens(tokens, start, offset)
        return (
          <span key={index} {...stylex.props(piece.change === "add" && styles.pieceAdd, piece.change === "del" && styles.pieceDel)}>
            {run.length === 0 ? piece.text : <TokenRun tokens={run} />}
          </span>
        )
      })}
    </>
  )
}

const linesOf = (text: string): string[] => {
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines.length === 0 ? [""] : lines
}

/**
 * `terminal` is what a process wrote, not a file: no line numbers, no grammar,
 * and the escape codes it emitted turned back into the emphasis they meant.
 * With `command` it is the whole exchange: the line that was run, a recess,
 * and what came back — one object with one header, because a command and its
 * output are one thing that happened. Two blocks said `bash` twice, offered
 * two Copy buttons, and left the reader to infer that the second was the
 * answer to the first.
 * With `follow` the listing stays scrolled to its end as text streams in, the
 * way a terminal does. The pin policy is the conversation's: a scroll event
 * is geometry, not a person, so layout and the follow write itself cannot
 * unpin it. An upward wheel, a drag on this listing's scrollbar, or a touch
 * move can. Reaching the end again resumes. A wheel this box can still move
 * with is consumed here; at either edge it yields, so the cursor is not
 * trapped in the listing while the conversation waits underneath.
 */
export const CodeBlock = ({
  variant = "code",
  filename,
  previousName,
  text,
  language,
  listing,
  file,
  follow = false,
  previewLines,
  command,
}: {
  variant?: "code" | "diff" | "terminal"
  filename?: string
  previousName?: string
  text?: string
  language?: string | undefined
  listing?: PresentedDiff
  file?: DiffFile
  follow?: boolean
  /** Live write preview: render this many lines, keep the rest for copy. */
  previewLines?: number
  /** The command a `terminal` listing is the output of, drawn above it. */
  command?: { text: string; language?: string | undefined }
}): React.JSX.Element => {
  const appearance = useAppearance()
  const icons = useFileIcons()
  const presented = listing ?? (file === undefined ? undefined : listingFromDiffFile(file))
  const isDiff = variant === "diff" || presented !== undefined
  const isTerminal = variant === "terminal" && !isDiff
  const title = filename ?? presented?.filename
  const prior = previousName ?? presented?.previousName
  const label = title ?? "code"
  const iconName = label.split(/[\\/]/).filter(Boolean).at(-1) ?? label
  const raw = isTerminal ? stripAnsi(text ?? "") : text ?? (presented === undefined ? "" : presented.rows.filter((row) => row.type !== "gap").map((row) => row.text).join("\n"))
  const resolved = isTerminal ? undefined : resolveLanguage(language) ?? (title === undefined ? undefined : languageForFile(title))
  const lines = isDiff ? [] : linesOf(raw)
  const previewed = previewLines !== undefined && lines.length > previewLines
  const visible = previewed ? lines.slice(0, previewLines) : lines
  const highlighted = useTokens(isDiff || isTerminal ? "" : raw, isDiff || isTerminal ? undefined : resolved, appearance)
  /*
   * The command keeps its grammar even though the body around it is a
   * transcript. A shell pipeline is the one line in the block a reader has to
   * take apart — which redirection went where, which `&&` guards what — and
   * the output below it has no grammar to lose by the contrast.
   */
  const shown = isTerminal ? command : undefined
  const commandLines = shown === undefined ? [] : linesOf(shown.text)
  const commandTokens = useTokens(shown?.text ?? "", resolveLanguage(shown?.language), appearance)
  const terminalTokens = useMemo(() => isTerminal ? ansiTokens(text ?? "", appearance) : undefined, [isTerminal, text, appearance])
  const codeTokens = terminalTokens ?? highlighted

  const body = useRef<HTMLDivElement>(null)
  // Pinned to the end until the reader asks otherwise. A ref, because it
  // changes on every scroll event and nothing renders from it.
  const pinned = useRef(true)
  useLayoutEffect(() => {
    const element = body.current
    if (!follow || element === null || !pinned.current) return
    element.scrollTop = element.scrollHeight
  }, [follow, text])
  const noteListingScroll = (): void => {
    const element = body.current
    if (!follow || element === null) return
    pinned.current = followingAfterTimelineScroll(pinned.current, element)
  }
  const touchY = useRef<number | undefined>(undefined)
  const noteListingWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    const element = event.currentTarget
    if (!listingConsumesWheel(event.deltaY, element)) return
    event.stopPropagation()
    if (follow && shouldDetachFollowOnWheel(event.deltaY, element)) pinned.current = false
  }
  const noteListingPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!follow) return
    const element = event.currentTarget
    const scrollbarWidth = element.offsetWidth - element.clientWidth
    const edge = element.getBoundingClientRect().right - scrollbarWidth
    if (scrollbarWidth > 0 && event.clientX >= edge) pinned.current = false
  }
  const noteListingTouchStart = (event: React.TouchEvent<HTMLDivElement>): void => {
    touchY.current = event.touches[0]?.clientY
  }
  const noteListingTouchMove = (event: React.TouchEvent<HTMLDivElement>): void => {
    const element = event.currentTarget
    const y = event.touches[0]?.clientY
    if (y === undefined) return
    const previous = touchY.current
    touchY.current = y
    if (previous === undefined) return
    const deltaY = previous - y
    if (!listingConsumesWheel(deltaY, element)) return
    event.stopPropagation()
    if (follow && shouldDetachFollowOnWheel(deltaY, element)) pinned.current = false
  }
  const noteListingTouchEnd = (): void => {
    touchY.current = undefined
  }
  const additionText = useMemo(() => file?.additionLines.join("\n") ?? "", [file])
  const deletionText = useMemo(() => file?.deletionLines.join("\n") ?? "", [file])
  const additions = useTokens(additionText, file === undefined ? undefined : resolved, appearance)
  const deletions = useTokens(deletionText, file === undefined ? undefined : resolved, appearance)
  // Tokenized as one text, so the line index has to skip the folds, which
  // have no code of their own. `tokensFor` below receives the same index.
  const listingTokens = useTokens(
    presented === undefined || file !== undefined ? "" : presented.rows.map((row) => row.text).join("\n"),
    presented === undefined || file !== undefined ? undefined : resolved,
    appearance,
  )

  const [copied, setCopied] = useState(false)
  // The whole exchange, in the order it happened. A person copying a terminal
  // block is reproducing it somewhere, and the command is the half that gets
  // pasted back into a shell.
  const copyable = shown === undefined ? raw : raw.length === 0 ? shown.text : shown.text + "\n" + raw
  const copy = useCallback(() => {
    void navigator.clipboard.writeText(copyable).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }, [copyable])

  const added = presented?.added ?? 0
  const removed = presented?.removed ?? 0

  return (
    <div {...stylex.props(styles.block)}>
      <div {...stylex.props(styles.header)}>
        <span {...stylex.props(styles.file)}>
          <FileIcon icon={pickFileIcon(icons, { name: iconName, kind: "file" }, false)} />
          {prior === undefined ? null : <span {...stylex.props(styles.previous)}>{prior}</span>}
          <span {...stylex.props(styles.filename)}>{label}</span>
        </span>
        {isDiff ? (
          <span {...stylex.props(styles.counts)}>
            <span {...stylex.props(styles.addedCount)}>+{added}</span>
            <span {...stylex.props(styles.removedCount)}>−{removed}</span>
          </span>
        ) : (
          <button type="button" onClick={copy} aria-label="Copy code" {...stylex.props(focus.ring, styles.copy, copied && styles.copied)}>
            {copied ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>

      <div
        ref={body}
        onScroll={noteListingScroll}
        onWheel={noteListingWheel}
        onPointerDown={noteListingPointerDown}
        onTouchStart={noteListingTouchStart}
        onTouchMove={noteListingTouchMove}
        onTouchEnd={noteListingTouchEnd}
        onTouchCancel={noteListingTouchEnd}
        {...stylex.props(scrollbars.thin, styles.body)}
      >
        {isTerminal ? null : <span aria-hidden="true" {...stylex.props(styles.rule)} />}
        {previewed ? <span aria-hidden="true" {...stylex.props(styles.previewVeil)} /> : null}
        {commandLines.map((line, index) => (
          <div key={`command-${String(index)}`} {...stylex.props(styles.terminalRow)}>
            <code {...stylex.props(styles.line, styles.terminalLine, styles.commandLine)}>
              {/* The prompt is the marker that says which half of the block
                  this is. A continuation keeps the indent without repeating
                  it, the way a shell's own secondary prompt does. */}
              <span aria-hidden="true" {...stylex.props(styles.prompt)}>{index === 0 ? "$ " : "  "}</span>
              {commandTokens === undefined ? line : <TokenRun tokens={commandTokens[index] ?? []} />}
            </code>
          </div>
        ))}
        {shown === undefined || raw.length === 0 ? null : <span aria-hidden="true" {...stylex.props(styles.exchangeRule)} />}
        {isDiff && presented !== undefined
          ? presented.rows.map((row, index) => {
              if (row.type === "gap") {
                return (
                  <div key={index} {...stylex.props(styles.gap)}>
                    <span aria-hidden="true" {...stylex.props(styles.gutter)}>⋯</span>
                    <span {...stylex.props(styles.gapText)}>{row.text}</span>
                  </div>
                )
              }
              const tokens = tokensFor(row, { additions, deletions, listingTokens, index, fromFile: file !== undefined })
              const num = row.type === "del" ? row.old : row.cur
              return (
                <div key={index} {...stylex.props(styles.row, row.type === "add" && styles.added, row.type === "del" && styles.removed)}>
                  {row.type === "ctx" ? null : <span aria-hidden="true" {...stylex.props(styles.accent, row.type === "add" ? styles.accentAdd : styles.accentDel)} />}
                  <span aria-hidden="true" {...stylex.props(styles.gutter, row.type === "add" && styles.addedCount, row.type === "del" && styles.removedCount)}>{num ?? ""}</span>
                  <span {...stylex.props(styles.marker)}>{row.type === "add" ? "+" : row.type === "del" ? "−" : " "}</span>
                  <code {...stylex.props(styles.line)}>
                    <Pieces pieces={row.pieces} tokens={tokens} />
                  </code>
                </div>
              )
            })
          : (shown !== undefined && raw.length === 0 ? [] : visible).map((line, index) => (
              <div key={index} {...stylex.props(isTerminal ? styles.terminalRow : styles.codeRow)}>
                {isTerminal ? null : <span aria-hidden="true" {...stylex.props(styles.gutter)}>{index + 1}</span>}
                <code {...stylex.props(styles.line, isTerminal && styles.terminalLine)}>{codeTokens === undefined ? line : <TokenRun tokens={codeTokens[index] ?? []} />}</code>
              </div>
            ))}
      </div>
    </div>
  )
}

const tokensFor = (
  row: ListingRow,
  source: {
    additions: Token[][] | undefined
    deletions: Token[][] | undefined
    listingTokens: Token[][] | undefined
    index: number
    fromFile: boolean
  },
): Token[] | undefined => {
  if (!source.fromFile) return source.listingTokens?.[source.index]
  if (row.sourceIndex === undefined) return undefined
  return (row.type === "del" ? source.deletions : source.additions)?.[row.sourceIndex]
}


const styles = stylex.create({
  /**
   * No lift, no wrapping radius on the outside. The listing is a recess in
   * whatever already contains it, and the header is a row of type above that
   * recess — not a second surface stacked on it.
   */
  block: { minWidth: 0, marginBlockStart: space.sm },
  header: {
    minHeight: size.controlDense,
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    paddingInline: space.sm,
    fontSize: typography.caption,
  },
  file: { minWidth: 0, display: "inline-flex", alignItems: "center", gap: space.sm, color: colors.textFaint },
  filename: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.text, fontFamily: typography.mono, fontSize: typography.caption },
  previous: { color: colors.textFaint, fontFamily: typography.mono, textDecorationLine: "line-through" },
  counts: { flex: "none", display: "flex", gap: space.sm, marginInlineStart: "auto", fontFamily: typography.mono, fontSize: typography.micro, fontVariantNumeric: "tabular-nums" },
  addedCount: { color: colors.diffAdded },
  removedCount: { color: colors.diffRemoved },
  copy: {
    flex: "none",
    marginInlineStart: "auto",
    height: "24px",
    display: "inline-flex",
    alignItems: "center",
    gap: space.xs,
    paddingInline: space.sm,
    color: { default: colors.textFaint, ":hover": colors.text },
    backgroundColor: { default: "transparent", ":hover": colors.canvasSubtle },
    borderWidth: 0,
    borderRadius: radius.sm,
    outline: "none",
    fontFamily: typography.ui,
    fontSize: typography.micro,
    fontWeight: 500,
    cursor: "pointer",
  },
  copied: { color: colors.success },
  /** The live write preview fades into the listing, so the cut is a fade not a clip. */
  previewVeil: {
    pointerEvents: "none",
    position: "absolute",
    insetInline: 0,
    insetBlockEnd: 0,
    height: "36px",
    backgroundColor: colors.sunken,
    maskImage: "linear-gradient(to top, #000, transparent)",
    zIndex: 1,
  },
  body: {
    position: "relative",
    maxHeight: "320px",
    overflow: "auto",
    overflowAnchor: "none",
    paddingBlock: space.sm,
    backgroundColor: colors.sunken,
    borderRadius: radius.md,
    borderWidth: effects.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    fontFamily: typography.mono,
    fontSize: typography.caption,
    lineHeight: "1.65",
    color: colors.textMuted,
  },
  /**
   * The editor's column rule. It is a fill, one pixel, sitting in the listing
   * rather than around it — the same job a line number gutter has in every
   * editor, and not the card outline this interface otherwise refuses to draw.
   */
  rule: { pointerEvents: "none", position: "absolute", insetBlock: 0, insetInlineStart: "28px", width: "1px", backgroundColor: colors.canvasSubtle },
  row: { position: "relative", display: "grid", gridTemplateColumns: "28px 1ch minmax(0, 1fr)", alignItems: "start" },
  codeRow: { position: "relative", display: "grid", gridTemplateColumns: "28px minmax(0, 1fr)", alignItems: "start" },
  /** No gutter: a process's output has no line numbers a reader would refer to. */
  terminalRow: { position: "relative", display: "grid", gridTemplateColumns: "minmax(0, 1fr)", alignItems: "start" },
  terminalLine: { paddingInlineStart: space.sm },
  /**
   * The command, one step brighter than what it printed. The tone is not
   * carrying this alone — the prompt marks it and the recess below separates
   * it — but the pair reads as question and answer only if the question is
   * the one in focus.
   */
  commandLine: { color: colors.text },
  prompt: { userSelect: "none", color: colors.textFaint, whiteSpace: "pre" },
  /**
   * A recess between the command and its output, not a border under it. It is
   * the sunken fill's own shade one step up, so it separates two halves of one
   * surface rather than drawing the outline this interface refuses.
   */
  exchangeRule: { display: "block", height: "1px", marginBlock: space.xs, backgroundColor: colors.canvasSubtle },
  /** A fold between hunks: a recess in the listing with the count of what it hides. */
  gap: { position: "relative", display: "grid", gridTemplateColumns: "28px minmax(0, 1fr)", alignItems: "center", marginBlock: space.xs, paddingBlock: space.xs, backgroundColor: colors.canvasSubtle },
  gapText: { paddingInlineStart: space.sm, color: colors.textFaint, fontFamily: typography.ui, fontSize: typography.micro, userSelect: "none" },
  added: { backgroundColor: colors.diffAddedSoft },
  removed: { backgroundColor: colors.diffRemovedSoft },
  accent: { position: "absolute", insetBlock: 0, insetInlineStart: 0, width: "3px" },
  accentAdd: { backgroundColor: colors.diffAdded },
  /**
   * A hatch rather than a solid bar, so a removed row is not the same mark as
   * an added one once both have been greyed. The fluid block uses red for this;
   * hue is not available here, so the pattern is the remaining distinction.
   */
  accentDel: {
    color: colors.diffRemoved,
    backgroundImage: "repeating-linear-gradient(45deg, currentColor 0, currentColor 1.5px, transparent 1.5px, transparent 3px)",
  },
  gutter: {
    paddingInline: space.xs,
    color: colors.textFaint,
    textAlign: "center",
    fontSize: typography.micro,
    fontVariantNumeric: "tabular-nums",
    userSelect: "none",
  },
  /**
   * Real +/− characters, not decoration. Selecting a range still copies a
   * patch that applies, which a coloured bar alone would not survive.
   */
  marker: { color: colors.textFaint, userSelect: "none" },
  line: { paddingInlineEnd: space.md, paddingInlineStart: space.xs, minWidth: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: typography.mono },
  pieceAdd: {
    backgroundColor: colors.diffAddedSoft,
    borderRadius: "3px",
    boxDecorationBreak: "clone",
  },
  pieceDel: {
    backgroundColor: colors.diffRemovedSoft,
    borderRadius: "3px",
    boxDecorationBreak: "clone",
  },
})
