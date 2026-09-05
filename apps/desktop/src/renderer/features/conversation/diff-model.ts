import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs"

/**
 * Turns a unified patch into rows a component can draw, and nothing more.
 *
 * The parsing is `@pierre/diffs`', which is the part worth having: hunk
 * headers, rename and mode metadata, no-newline-at-EOF markers, and the
 * context/change grouping are all things a `startsWith("+")` scan gets wrong.
 * What this module does not do is render — see `highlight.ts` for why the
 * library's own renderer cannot draw under this application's CSP.
 *
 * Keeping the flattening here rather than in the component is what makes it
 * testable without a DOM, which is how the rest of this renderer's logic is
 * covered.
 */
export type DiffRowKind = "context" | "added" | "removed"

export interface DiffRow {
  kind: DiffRowKind
  /** Line number in the old file, absent on an added line. */
  oldLine: number | undefined
  /** Line number in the new file, absent on a removed line. */
  newLine: number | undefined
  text: string
  /** Index into the file's `additionLines` or `deletionLines`, for tokens. */
  sourceIndex: number
}

export interface DiffHunk {
  header: string
  context: string | undefined
  rows: DiffRow[]
}

export interface DiffFile {
  name: string
  previousName: string | undefined
  change: FileDiffMetadata["type"]
  hunks: DiffHunk[]
  added: number
  removed: number
  /** Every old-side line the patch carried, in order, for tokenizing once. */
  deletionLines: string[]
  /** Every new-side line the patch carried, in order, for tokenizing once. */
  additionLines: string[]
}

/**
 * `parsePatchFiles` throws on input that is not a patch, and most tool output
 * is not a patch. The throw is the detector — asked not to throw it returns
 * an empty parse for good input and bad alike, which cannot be told apart.
 */
export const parseUnifiedDiff = (text: string): DiffFile[] => {
  let patches
  try {
    patches = parsePatchFiles(text, undefined, true)
  } catch {
    return []
  }
  const files = patches.flatMap((patch) => patch.files).map(toDiffFile)
  return files.filter((file) => file.hunks.length > 0)
}

/**
 * The parser preserves each line's terminator, which is right for round-tripping
 * a patch and wrong for everything here: a row would render a stray blank, and
 * rejoining the array for tokenization would double every newline.
 */
const stripEol = (line: string): string => line.replace(/\r?\n$/, "")

const toDiffFile = (file: FileDiffMetadata): DiffFile => {
  const deletionLines = file.deletionLines.map(stripEol)
  const additionLines = file.additionLines.map(stripEol)
  let added = 0
  let removed = 0
  const hunks: DiffHunk[] = []

  for (const hunk of file.hunks) {
    const rows: DiffRow[] = []
    let oldLine = hunk.deletionStart
    let newLine = hunk.additionStart

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let index = 0; index < content.lines; index += 1) {
          const sourceIndex = content.additionLineIndex + index
          rows.push({ kind: "context", oldLine, newLine, text: additionLines[sourceIndex] ?? "", sourceIndex })
          oldLine += 1
          newLine += 1
        }
        continue
      }
      // Deletions before additions, which is the order a unified diff reads in
      // and the order the change block stores them.
      for (let index = 0; index < content.deletions; index += 1) {
        const sourceIndex = content.deletionLineIndex + index
        rows.push({ kind: "removed", oldLine, newLine: undefined, text: deletionLines[sourceIndex] ?? "", sourceIndex })
        oldLine += 1
        removed += 1
      }
      for (let index = 0; index < content.additions; index += 1) {
        const sourceIndex = content.additionLineIndex + index
        rows.push({ kind: "added", oldLine: undefined, newLine, text: additionLines[sourceIndex] ?? "", sourceIndex })
        newLine += 1
        added += 1
      }
    }

    hunks.push({
      header: hunk.hunkSpecs ?? `@@ -${String(hunk.deletionStart)},${String(hunk.deletionCount)} +${String(hunk.additionStart)},${String(hunk.additionCount)} @@`,
      context: hunk.hunkContext,
      rows,
    })
  }

  return {
    name: file.name,
    previousName: file.prevName,
    change: file.type,
    hunks,
    added,
    removed,
    deletionLines,
    additionLines,
  }
}
