import type { ToolCall, ToolResult } from "@bake-pi/contract"
import { parseUnifiedDiff, type DiffFile } from "./diff-model.ts"
import { diffPieces, type CodePiece } from "./word-diff.ts"
import { lineDiff } from "./line-diff.ts"
import { stripAnsi } from "./ansi.ts"
import { todoProgress } from "./todo-state.ts"

/**
 * What a tool call or result becomes on the timeline, in terms the thinking
 * step can draw without knowing Pi's argument shapes.
 *
 * Arguments stay `unknown` on the wire — see `ToolCall.args` — so this module
 * is the one place the renderer is allowed to look inside them. It only reads
 * the fields `extractTargets` already claims to understand; anything else is
 * presented as a name and, if it must, a JSON listing. Parsing more than that
 * here would be a second, quieter schema for tools, which is exactly what the
 * opaque value exists to prevent.
 */

export type ActivityKind = "reasoning" | "read" | "write" | "edit" | "shell" | "search" | "list" | "todo" | "extension" | "result"

export interface ListingRow {
  old: number | null
  cur: number | null
  /** `gap` is the fold between two hunks; `text` says how many lines it hides. */
  type: "ctx" | "add" | "del" | "gap"
  text: string
  pieces: CodePiece[]
  /** Index into the file's addition or deletion stream, when this row came from a parsed patch. */
  sourceIndex?: number
}

export interface PresentedCode {
  filename: string
  text: string
  language: string | undefined
}

export interface PresentedDiff {
  filename: string
  added: number
  removed: number
  rows: ListingRow[]
  previousName?: string
}

export interface PresentedActivity {
  kind: ActivityKind
  label: string
  /**
   * The file this step acted on, as its base name, kept out of `label` so the
   * step can draw it as its own object rather than as four more words.
   *
   * "Read globals.css" is one string and reads as one; the reference draws the
   * verb and the file as two things, because the file is what a person scans a
   * turn of twelve tools for. Only a real path becomes a target — a shell
   * command and a search pattern stay in the label, because neither is a file
   * and a chip around either would claim they were.
   *
   * The base name, not the path: a row is scanned for which file, and the
   * whole path is a dozen characters of temp directory in front of the two
   * that identify it. `targetPath` keeps the rest within reach.
   */
  target?: string
  /**
   * The whole path behind `target`, for the chip to carry as its tooltip.
   *
   * It used to be the `description`, and with a chip in front of it the row
   * said the file twice — a truncated base name and then a truncated path
   * beside it, which is three runs of text competing for one line and is what
   * the chip was supposed to fix. The description is left for what a step
   * produced (a size, a count); where the file *is* stays available on hover.
   */
  targetPath?: string
  description?: string
  /**
   * The line that was run, when the step ran one.
   *
   * Separate from `code` because the two are read differently: `code` is a
   * listing the step produced or was given — a file's contents, a patch — and
   * a command is the half of an exchange whose other half is `output`. Naming
   * it is what lets the step draw the pair as one transcript instead of two
   * listings that happen to be adjacent, and it is the only field that can
   * tell a command apart from a shell result that was itself put in `code`.
   */
  command?: PresentedCode
  code?: PresentedCode
  diffs?: PresentedDiff[]
  /** What the tool returned, kept apart from `code` (what it was asked) so a step can show both. */
  output?: PresentedCode
}

/** Payloads worth reading in place rather than opening one by one after the turn. */
export const isVerboseActivity = (kind: ActivityKind): boolean => kind === "shell"

/** File changes shown as a brief live preview, then faded when the next action starts. */
export const isChangeActivity = (kind: ActivityKind): boolean => kind === "edit" || kind === "write"

/** How many lines of a write the live preview keeps. Copy still uses the full file. */
export const WRITE_PREVIEW_LINES = 8

/** The last segment of a canonical path, whichever separator the platform used. */
export const basename = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

const pathOf = (call: ToolCall): string | undefined => {
  const fromArgs = asString(asRecord(call.args)?.path)
  if (fromArgs !== undefined) return fromArgs
  return call.targets[0]?.path
}

const commandOf = (call: ToolCall): string | undefined => asString(asRecord(call.args)?.command)

const contentOf = (call: ToolCall): string | undefined => asString(asRecord(call.args)?.content)

interface TextEdit {
  oldText: string
  newText: string
}

const editsOf = (call: ToolCall): TextEdit[] => {
  const raw = asRecord(call.args)?.edits
  if (!Array.isArray(raw)) return []
  const edits: TextEdit[] = []
  for (const entry of raw) {
    const record = asRecord(entry)
    if (record === undefined) continue
    const oldText = asString(record.oldText)
    const newText = asString(record.newText)
    if (oldText === undefined || newText === undefined) continue
    edits.push({ oldText, newText })
  }
  return edits
}

const SHELL = new Set(["bash", "powershell"])
const SEARCH = new Set(["grep", "find"])

const kindOf = (name: string): ActivityKind => {
  if (name.toLowerCase() === "todo") return "todo"
  if (name === "read") return "read"
  if (name === "write") return "write"
  if (name === "edit") return "edit"
  if (SHELL.has(name)) return "shell"
  if (SEARCH.has(name)) return "search"
  if (name === "ls") return "list"
  return "extension"
}

const languageOf = (name: string, filename: string | undefined): string | undefined => {
  if (name === "bash") return "bash"
  if (name === "powershell") return "powershell"
  if (filename === undefined) return undefined
  const dot = filename.lastIndexOf(".")
  return dot < 1 ? undefined : filename.slice(dot + 1)
}

const oneLine = (text: string): string => {
  const trimmed = text.trim()
  const nl = trimmed.search(/\r?\n/)
  return nl === -1 ? trimmed : `${trimmed.slice(0, nl)}…`
}

/**
 * The edit as a diff rather than as two blocks: unchanged lines are context,
 * changed lines are paired for word-level marks. No line numbers, because the
 * arguments never carried any — Pi's result usually does, and when it parses
 * the step prefers it.
 */
const rowsFromEdits = (edits: TextEdit[]): ListingRow[] => {
  const rows: ListingRow[] = []
  for (const edit of edits) {
    for (const line of lineDiff(edit.oldText.split(/\r?\n/), edit.newText.split(/\r?\n/))) {
      rows.push({ old: null, cur: null, type: line.type, text: line.text, pieces: [{ text: line.text, ...(line.type === "ctx" ? {} : { change: line.type }) }] })
    }
  }
  return pairWordDiffs(rows)
}

const pairWordDiffs = (rows: ListingRow[]): ListingRow[] => {
  const out: ListingRow[] = []
  let index = 0
  while (index < rows.length) {
    const row = rows[index]!
    if (row.type !== "del") {
      out.push(row)
      index += 1
      continue
    }
    const deletions: ListingRow[] = []
    while (index < rows.length && rows[index]!.type === "del") {
      deletions.push(rows[index]!)
      index += 1
    }
    const additions: ListingRow[] = []
    while (index < rows.length && rows[index]!.type === "add") {
      additions.push(rows[index]!)
      index += 1
    }
    const paired = Math.min(deletions.length, additions.length)
    for (let pair = 0; pair < paired; pair += 1) {
      const del = deletions[pair]!
      const add = additions[pair]!
      const pieces = diffPieces(del.text, add.text)
      out.push({ ...del, pieces: pieces.del })
      out.push({ ...add, pieces: pieces.add })
    }
    for (const leftover of deletions.slice(paired)) out.push(leftover)
    for (const leftover of additions.slice(paired)) out.push(leftover)
  }
  return out
}

/**
 * Hunks are joined by a fold that names what it hides, the way the diffs.com
 * renderer separates them, rather than butted together so line 12 is followed
 * by line 140 with nothing to say so.
 */
export const listingFromDiffFile = (file: DiffFile): PresentedDiff => {
  const rows: ListingRow[] = []
  let lastOld: number | undefined
  for (const hunk of file.hunks) {
    const firstOld = hunk.rows.find((row) => row.oldLine !== undefined)?.oldLine
    if (lastOld !== undefined && firstOld !== undefined && firstOld > lastOld + 1) {
      const hidden = firstOld - lastOld - 1
      rows.push({ old: null, cur: null, type: "gap", text: `${String(hidden)} unchanged ${hidden === 1 ? "line" : "lines"}`, pieces: [] })
    }
    for (const row of hunk.rows) {
      rows.push({
        old: row.oldLine ?? null,
        cur: row.newLine ?? null,
        type: row.kind === "added" ? "add" : row.kind === "removed" ? "del" : "ctx",
        text: row.text,
        pieces: [{ text: row.text }],
        sourceIndex: row.sourceIndex,
      })
      if (row.oldLine !== undefined) lastOld = row.oldLine
    }
  }
  return {
    filename: file.name,
    added: file.added,
    removed: file.removed,
    rows: pairWordDiffs(rows),
    ...(file.previousName === undefined ? {} : { previousName: file.previousName }),
  }
}

/** Context kept around a change in the live preview; more than this folds. */
const PREVIEW_CONTEXT = 2
/** A rewrite still has to fit the preview, or it becomes the wall of text the step list replaced. */
const PREVIEW_MAX_ROWS = 12

const isChangeRow = (row: ListingRow): boolean => row.type === "add" || row.type === "del"

const hiddenCount = (row: ListingRow): number => {
  if (row.type === "ctx") return 1
  if (row.type !== "gap") return 0
  const count = Number.parseInt(row.text, 10)
  return Number.isFinite(count) ? count : 0
}

const gapRow = (hidden: number): ListingRow => ({
  old: null,
  cur: null,
  type: "gap",
  text: `${String(hidden)} unchanged ${hidden === 1 ? "line" : "lines"}`,
  pieces: [],
})

/**
 * The live preview of an edit: the change, two lines of context, and a fold
 * for the rest. Opening the step later still has the full listing.
 */
export const briefDiff = (diff: PresentedDiff): PresentedDiff => {
  const { rows } = diff
  const keep = rows.map((row, index) => {
    if (isChangeRow(row)) return true
    if (row.type !== "ctx") return false
    for (let distance = 1; distance <= PREVIEW_CONTEXT; distance += 1) {
      const before = rows[index - distance]
      const after = rows[index + distance]
      if ((before !== undefined && isChangeRow(before)) || (after !== undefined && isChangeRow(after))) return true
    }
    return false
  })
  const out: ListingRow[] = []
  let index = 0
  while (index < rows.length) {
    if (keep[index] === true) {
      out.push(rows[index]!)
      index += 1
      continue
    }
    let hidden = 0
    while (index < rows.length && keep[index] !== true) {
      hidden += hiddenCount(rows[index]!)
      index += 1
    }
    if (hidden > 0) out.push(gapRow(hidden))
  }
  const kept = out.filter((row) => row.type !== "gap")
  if (kept.length <= PREVIEW_MAX_ROWS) {
    const same = out.length === rows.length && out.every((row, at) => row === rows[at])
    return same ? diff : { ...diff, rows: out }
  }
  const capped: ListingRow[] = []
  let shown = 0
  let rest = 0
  for (const row of out) {
    if (shown < PREVIEW_MAX_ROWS && row.type !== "gap") {
      capped.push(row)
      shown += 1
      continue
    }
    rest += hiddenCount(row)
  }
  if (rest > 0) capped.push(gapRow(rest))
  return { ...diff, rows: capped }
}

export const presentToolCall = (call: ToolCall): PresentedActivity => {
  // Todo is the one extension result Bake Pi understands structurally. Keep its
  // presentation when it is extension-contributed; every other unknown tool
  // remains visibly an extension.
  const recognized = kindOf(call.name)
  const kind = call.source === "extension" && recognized !== "todo" ? "extension" : recognized
  const path = pathOf(call)
  const name = path === undefined ? undefined : basename(path)
  const command = commandOf(call)
  const content = contentOf(call)
  const edits = editsOf(call)

  if (kind === "todo") {
    const action = asString(asRecord(call.args)?.action)
    const text = asString(asRecord(call.args)?.text)
    const label = action === "add" && text !== undefined
      ? `Added ${oneLine(text)}`
      : action === "clear"
        ? "Cleared the plan"
        : action === "list"
          ? "Reviewed the plan"
          : "Updated the plan"
    return { kind, label }
  }

  if (kind === "shell") {
    return {
      kind,
      label: command === undefined ? `Ran ${call.name}` : `Ran ${oneLine(command)}`,
      ...(command === undefined ? {} : {
        command: { filename: call.name, text: command, language: languageOf(call.name, undefined) },
      }),
    }
  }

  if (kind === "edit") {
    const rows = rowsFromEdits(edits)
    const added = rows.filter((row) => row.type === "add").length
    const removed = rows.filter((row) => row.type === "del").length
    return {
      kind,
      label: "Edited",
      ...(name === undefined ? {} : { target: name }),
      ...(path === undefined ? {} : { targetPath: path }),
      ...(rows.length === 0 ? {} : { diffs: [{ filename: name ?? "edit", added, removed, rows }] }),
    }
  }

  if (kind === "write") {
    return {
      kind,
      label: "Wrote",
      ...(name === undefined ? {} : { target: name }),
      ...(path === undefined ? {} : { targetPath: path }),
      ...(content === undefined || name === undefined ? {} : {
        code: { filename: name, text: content, language: languageOf(call.name, name) },
      }),
    }
  }

  if (kind === "read") {
    return { kind, label: "Read", ...(name === undefined ? {} : { target: name }), ...(path === undefined ? {} : { targetPath: path }) }
  }

  if (kind === "list") {
    // "Listed" alone would be a verb with nothing after it; the directory is
    // what a listing is of, so its absence changes the sentence rather than
    // just dropping a chip.
    return { kind, label: name === undefined ? "Listed files" : "Listed", ...(name === undefined ? {} : { target: name }), ...(path === undefined ? {} : { targetPath: path }) }
  }

  if (kind === "search") {
    const pattern = asString(asRecord(call.args)?.pattern)
    // Quoted, because a pattern is the one label fragment that is a literal
    // somebody typed: `Searched color tokens, theme provider` reads as four
    // more words of interface, and the quotes are what say it is not.
    return {
      kind,
      label: pattern === undefined ? `Searched with ${call.name}` : `Searched "${oneLine(pattern)}"`,
      ...(path === undefined ? {} : { description: path }),
    }
  }

  return {
    kind,
    label: call.extensionName === undefined ? `Ran ${call.name}` : `Ran ${call.name} · ${call.extensionName}`,
  }
}

/**
 * What a step is about, in the few characters that fit beside its label: the
 * size of what it produced, so a closed step still says whether the tool did
 * a little or a lot. A path already carried by the call is not repeated here.
 */
/** Lines in a listing, ignoring the trailing newline every file ends with. */
export const countLines = (text: string): number =>
  stripAnsi(text).split(/\r?\n/).filter((line, index, all) => index < all.length - 1 || line.length > 0).length

export const summarizeActivity = (presented: PresentedActivity): string | undefined => {
  if (presented.diffs !== undefined && presented.diffs.length > 0) {
    const added = presented.diffs.reduce((total, diff) => total + diff.added, 0)
    const removed = presented.diffs.reduce((total, diff) => total + diff.removed, 0)
    const files = presented.diffs.length
    return `${files > 1 ? `${String(files)} files · ` : ""}+${String(added)} −${String(removed)}`
  }
  const listing = presented.output ?? presented.code
  if (listing !== undefined) {
    const lines = countLines(listing.text)
    return `${String(lines)} ${lines === 1 ? "line" : "lines"}`
  }
  return undefined
}

/**
 * A call and its result as one step.
 *
 * "Ran ls" followed by "Output · 12 lines" was two rows for one thing the
 * agent did, and the second row's only job was holding what the first one
 * produced. Together, the header says what ran and how much came back, and
 * opening it shows the command and then the output — or, for an edit, the
 * patch Pi returned, which carries the line numbers the arguments never had.
 *
 * What the tool was asked stays in `code`; what it returned goes in `output`.
 * A successful write's confirmation is not repeated under the content that was
 * written; any unsuccessful result is the explanation, and is shown whatever
 * the tool was.
 */
export const presentToolStep = (call: ToolCall, result: ToolResult | undefined): PresentedActivity => {
  const fromCall = presentToolCall(call)
  if (result === undefined) return fromCall
  const unsuccessful = result.status !== "succeeded"
  if (fromCall.kind === "todo") {
    return {
      ...fromCall,
      ...(result.todo === undefined ? {} : { description: todoProgress(result.todo) }),
      ...(!unsuccessful || result.output.trim().length === 0 ? {} : {
        output: { filename: "error", text: result.output, language: undefined },
      }),
    }
  }
  const parsed = parseUnifiedDiff(result.output)
  const diffs = parsed.length > 0 ? parsed.map(listingFromDiffFile) : fromCall.diffs
  const path = pathOf(call)
  const name = path === undefined ? undefined : basename(path)
  const text = result.output
  const silent = text.trim().length === 0 || parsed.length > 0 || (fromCall.kind === "write" && !unsuccessful)
  const output: PresentedCode | undefined = silent ? undefined : {
    filename: fromCall.kind === "shell" ? call.name : fromCall.kind === "read" && name !== undefined ? name : unsuccessful ? "error" : "output",
    text,
    language: fromCall.kind === "shell" ? languageOf(call.name, undefined) : fromCall.kind === "read" && !unsuccessful ? languageOf(call.name, name) : undefined,
  }
  const step: PresentedActivity = {
    kind: fromCall.kind,
    label: fromCall.label,
    ...(fromCall.target === undefined ? {} : { target: fromCall.target }),
    ...(fromCall.targetPath === undefined ? {} : { targetPath: fromCall.targetPath }),
    ...(fromCall.command === undefined ? {} : { command: fromCall.command }),
    ...(fromCall.code === undefined ? {} : { code: fromCall.code }),
    ...(diffs === undefined ? {} : { diffs }),
    ...(output === undefined ? {} : { output }),
  }
  const size = summarizeActivity(step)
  const description = [size, fromCall.description].filter((part) => part !== undefined).join(" · ")
  return { ...step, ...(description.length === 0 ? {} : { description }) }
}

/**
 * The result names what it holds rather than that it exists. "Done" said the
 * same thing as the check mark on the call above it; "Output" or "Changes"
 * says what opening the step will show. Failed, denied and stopped results name
 * that terminal state because the outcome itself is the news.
 */
export const presentToolResult = (result: ToolResult, call: ToolCall | undefined): PresentedActivity => {
  const unsuccessful = result.status !== "succeeded"
  const outcome = result.status === "denied" ? "Denied" : result.status === "aborted" ? "Stopped" : result.status === "failed" ? "Failed" : "Output"
  if (result.todo !== undefined) {
    return { kind: "todo", label: unsuccessful ? outcome : "Updated the plan", description: todoProgress(result.todo) }
  }
  const files = parseUnifiedDiff(result.output)
  if (files.length > 0) {
    return { kind: "edit", label: unsuccessful ? outcome : "Changes", diffs: files.map(listingFromDiffFile) }
  }

  const fromCall = call === undefined ? undefined : presentToolCall(call)
  if (fromCall?.kind === "shell" || (call !== undefined && SHELL.has(call.name))) {
    return {
      kind: "shell",
      label: outcome,
      code: {
        filename: call?.name ?? "shell",
        text: result.output,
        language: call === undefined ? undefined : languageOf(call.name, undefined),
      },
    }
  }

  if (fromCall?.kind === "write" && fromCall.code !== undefined) {
    return { kind: "write", label: outcome, code: fromCall.code }
  }

  if (fromCall?.kind === "edit" && fromCall.diffs !== undefined) {
    return { kind: "edit", label: unsuccessful ? outcome : "Changes", diffs: fromCall.diffs }
  }

  return {
    kind: "result",
    label: result.output.trim().length === 0 ? (unsuccessful ? outcome : "Done") : outcome,
    ...(result.output.trim().length === 0 ? {} : {
      code: { filename: call?.name ?? "output", text: result.output, language: undefined },
    }),
  }
}

export const presentReasoning = (text: string, redacted: boolean): PresentedActivity => {
  if (redacted) return { kind: "reasoning", label: "Reasoning (provider-redacted)" }
  const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim()
  return {
    kind: "reasoning",
    label: firstLine ?? "Thinking",
    ...(firstLine === undefined ? {} : { description: text }),
  }
}
