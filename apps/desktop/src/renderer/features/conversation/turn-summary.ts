import type { Message, ToolCall, ToolResult } from "@bake-pi/contract"
import type { CompletedTimelineRow, ToolLookup } from "./timeline-projection.ts"
import { basename, countLines, presentToolStep } from "./tool-present.ts"

/**
 * What the turn that just ended did, in the few facts a person checks before
 * reading the answer: which files moved, how much work it took, what it spent.
 *
 * Scoped to one turn, deliberately. The activity rail already owns the
 * session's ledger and its whole list of changes, and a second meter for the
 * same number is two numbers that drift apart — in language first and in
 * precision later. What no other surface answers is "what did *that* turn
 * change", which is the question a twelve-tool turn leaves behind once its
 * steps have collapsed.
 *
 * Everything here is read off the same projection the timeline renders, so the
 * recap cannot disagree with the steps above it, and Pi's snapshot remains the
 * only source.
 */

export interface TurnChange {
  path: string
  /** The base name, which is what a recap is scanned for; `path` is the tooltip. */
  name: string
  /**
   * Counted lines, absent rather than zero where the tools that touched this
   * file reported none. A patch and a whole-file write both count; a shell
   * command that moved a file reports a write target and no lines, and saying
   * `+0 −0` about it would be a measurement nobody took.
   */
  added: number | undefined
  removed: number | undefined
}

export interface TurnSummary {
  /**
   * The message the turn ended on. The card is keyed by it, so the next turn
   * mounts a new one — a recap that mutated in place would animate the numbers
   * of the previous turn into the numbers of this one.
   */
  key: string
  tools: number
  /** Tools that failed, named separately because a recap that hid them would be flattering rather than short. */
  failed: number
  changes: TurnChange[]
  /**
   * Time spent inside tools, summed from each call's own two instants.
   *
   * Both come from the host, so subtracting them stays inside one process —
   * the rule this codebase holds is that durations cross the process boundary
   * and instants never do. It is tool time and not turn time: nothing in the
   * contract records when a turn opened and settled, and inferring it from two
   * message timestamps would be exactly the cross-process instant arithmetic
   * that rule forbids.
   */
  toolMs: number | undefined
  inputTokens: number | undefined
  outputTokens: number | undefined
}

/**
 * The messages after the last prompt: the assistant's turn, plus any system
 * message that carried one of its tool results.
 *
 * Rows for one message are contiguous, so the previous row's message is the
 * only thing this has to compare against to collect them once.
 */
const lastTurnMessages = (rows: readonly CompletedTimelineRow[]): Message[] => {
  const messages: Message[] = []
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const message = rows[index]!.message
    if (message.role === "user") break
    if (messages[0] !== message) messages.unshift(message)
  }
  return messages
}

/**
 * How many lines a successful call moved, in the terms the step above it
 * already drew: the patch Pi returned where there is one, and otherwise the
 * content of a write, which is a whole file and therefore all addition.
 *
 * `presentToolStep` rather than a second reading of `call.args`: that module is
 * the one place allowed to look inside Pi's argument shapes, and a recap that
 * counted differently from the step it summarizes would be a second, quieter
 * schema for tools.
 */
const changedLines = (call: ToolCall, result: ToolResult | undefined): Pick<TurnChange, "added" | "removed"> | undefined => {
  const presented = presentToolStep(call, result)
  if (presented.diffs !== undefined && presented.diffs.length > 0) {
    return {
      added: presented.diffs.reduce((total, diff) => total + diff.added, 0),
      removed: presented.diffs.reduce((total, diff) => total + diff.removed, 0),
    }
  }
  if (presented.kind === "write" && presented.code !== undefined) return { added: countLines(presented.code.text), removed: 0 }
  return undefined
}

const merge = (left: number | undefined, right: number | undefined): number | undefined =>
  left === undefined ? right : right === undefined ? left : left + right

/**
 * The recap, or nothing.
 *
 * Nothing when the turn ran no tools: a reply that only spoke is summarized by
 * itself, and a card under every answer saying "0 tools" is furniture. Nothing
 * also while a turn is still open — the caller only draws this once no message
 * is streaming, and completed rows carry no streaming message anyway.
 */
export const turnSummary = (
  rows: readonly CompletedTimelineRow[],
  results: ToolLookup<ToolResult>,
): TurnSummary | undefined => {
  const messages = lastTurnMessages(rows)
  const last = messages.at(-1)
  if (last === undefined || !messages.some((message) => message.role === "assistant")) return undefined

  const calls = messages.flatMap((message) => message.blocks.flatMap((block) => block.kind === "tool_call" ? [block.call] : []))
  if (calls.length === 0) return undefined

  const changes = new Map<string, TurnChange>()
  let failed = 0
  let toolMs = 0
  let timed = 0
  for (const call of calls) {
    if (call.status === "failed") failed += 1
    if (call.startedAt !== undefined && call.endedAt !== undefined) {
      toolMs += call.endedAt - call.startedAt
      timed += 1
    }
    // Only successful writes, and only the host's canonicalized targets: the
    // target is what the policy decided on, so this names the file that was
    // actually touched rather than the string the model asked for. A denied
    // write is a decision, not a change.
    if (call.status !== "succeeded") continue
    const written = call.targets.filter((target) => target.kind === "write")
    if (written.length === 0) continue
    // One call, one patch: with two write targets there is no honest way to
    // divide the count between them, so the files are named without one.
    const counted = written.length === 1 ? changedLines(call, results.get(call.id)) : undefined
    for (const target of written) {
      const existing = changes.get(target.path)
      changes.set(target.path, {
        path: target.path,
        name: basename(target.path),
        added: merge(existing?.added, counted?.added),
        removed: merge(existing?.removed, counted?.removed),
      })
    }
  }

  const usage = messages.reduce<{ input: number; output: number } | undefined>((total, message) => {
    if (message.usage === undefined) return total
    return {
      input: (total?.input ?? 0) + message.usage.inputTokens,
      output: (total?.output ?? 0) + message.usage.outputTokens,
    }
  }, undefined)

  return {
    key: last.id,
    tools: calls.length,
    failed,
    // First touch first: a recap of a turn reads as the order the work happened
    // in, which is not the rail's newest-first list of what the session holds.
    changes: [...changes.values()],
    toolMs: timed === 0 ? undefined : toolMs,
    inputTokens: usage?.input,
    outputTokens: usage?.output,
  }
}
