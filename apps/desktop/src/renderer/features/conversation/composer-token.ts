/**
 * What the caret is standing in, when it is standing in a mention.
 *
 * The textarea stays uncontrolled — the draft is not React state, and the
 * comment on `hasDraft` says why — so this is the one thing read out of it on
 * each keystroke. It holds where the token starts and what has been typed
 * since, never the message around it.
 */
export interface Token {
  kind: "file" | "command"
  /** Index in the draft where the `@` or `/` sits, so a pick knows what to replace. */
  start: number
  query: string
}

export interface MentionInsertion {
  text: string
  caret: number
}

const MENTION = /(^|\s)([@/])([^\s]*)$/

/**
 * A mention is read from the text *before* the caret, not from the end of the
 * draft. Someone who goes back to add a reference mid-sentence is doing the
 * ordinary thing, and a parser that only looked at the tail would leave them
 * typing into a menu that never opened.
 *
 * A command is only a command at the very start. `/compact` replaces the
 * message rather than joining it, so it cannot be something a sentence arrives
 * at halfway through — and prose is full of slashes that are not commands.
 */
export const tokenAt = (draft: string, caret: number): Token | undefined => {
  const match = MENTION.exec(draft.slice(0, caret))
  if (match === null) return undefined
  const start = match.index + match[1]!.length
  const kind = match[2] === "@" ? "file" : "command"
  if (kind === "command" && start !== 0) return undefined
  return { kind, start, query: match[3]! }
}

/** The relative spelling Pi can resolve from its workspace root. */
export const workspaceRelativePath = (workspaceRoot: string, path: string): string =>
  path.startsWith(workspaceRoot) ? path.slice(workspaceRoot.length).replace(/^[\\/]/, "").replace(/\\/g, "/") : path

/** Inserts a tree-picked file at the textarea's retained selection. */
export const insertFileMention = (
  draft: string,
  selectionStart: number,
  selectionEnd: number,
  workspaceRoot: string,
  path: string,
): MentionInsertion => {
  const mention = `@${workspaceRelativePath(workspaceRoot, path)} `
  return {
    text: draft.slice(0, selectionStart) + mention + draft.slice(selectionEnd),
    caret: selectionStart + mention.length,
  }
}
