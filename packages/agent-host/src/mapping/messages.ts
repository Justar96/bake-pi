import type {
  ApprovalRequest,
  ContentBlock,
  Message,
  MessageStatus,
  TokenUsage,
  ToolCall,
  ToolCallStatus,
} from "@bake-pi/contract"
import { imageUrl, renderableImageMediaType } from "@bake-pi/contract"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai"
import { classifyTargets } from "../policy/paths.ts"
import { extractTargets, isBuiltinToolName } from "../policy/targets.ts"
import { toolResultStatus } from "../tool-outcome.ts"
import { projectTodoState } from "./todo.ts"

/**
 * Pi's messages carry a timestamp, not an identifier.
 *
 * The projection needs stable keys, so it uses the message's position in the
 * session's history. That is sound because Pi's history is append-only within a
 * branch: the only operations that renumber it — compaction, tree navigation,
 * fork, session replacement — all produce a fresh snapshot, which replaces the
 * renderer's projection wholesale. So an index is stable for exactly as long as
 * the renderer holds it.
 */
export const messageIdAt = (index: number): string => `m${index}`

/** Pi's per-message token counts, as the contract carries them. */
export const tokenUsageOf = (usage: Usage | undefined): TokenUsage | undefined =>
  usage === undefined
    ? undefined
    : {
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
      }

/**
 * How a turn ended, read from the message rather than assumed.
 *
 * `turn_settled` used to report `complete` for every turn, which described an
 * aborted turn and a provider failure as successes.
 */
export const assistantStatus = (message: AssistantMessage): MessageStatus => {
  switch (message.stopReason) {
    case "aborted":
      return "aborted"
    case "error":
      return "failed"
    default:
      return "complete"
  }
}

/**
 * The text of a tool's output, whatever shape the tool returned it in.
 *
 * Pi's tools return `{ content, details }` — the same shape a tool-result
 * message carries — and both a finished result and a running tool's partial
 * snapshot arrive that way. Stringifying the wrapper instead put
 * `{"content":[{"type":"text","text":"..."}]}` in front of the user for every
 * tool call. A tool that returns something else entirely still has to render,
 * so an unrecognized value falls back to JSON rather than to nothing.
 */
export const toolOutputText = (value: unknown): string => {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return ""
  if (typeof value !== "object") return String(value)

  const content = (value as { content?: unknown }).content
  return Array.isArray(content) ? contentText(content as ToolResultMessage["content"]) : safeJson(value)
}

const contentText = (content: ToolResultMessage["content"]): string =>
  content.map((part) => (part.type === "text" ? part.text : `[image ${part.mimeType}]`)).join("")

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    // Reached by a tool result carrying a cycle or a BigInt. The call still
    // happened, and a card that says so beats one that renders empty.
    return "[unserializable tool result]"
  }
}

const userBlocks = (message: UserMessage, messageIndex: number, context: MessageProjectionContext): ContentBlock[] => {
  if (typeof message.content === "string") return [{ index: 0, kind: "text", text: message.content }]
  return message.content.map((part, index) => {
    if (part.type === "text") return { index, kind: "text", text: part.text } satisfies ContentBlock
    // The renderer never receives image bytes. The host mints a `bakepi://image`
    // URL for the attachment it already holds and main serves it from
    // `read_image`; a data URI here would put megabytes through structured
    // clone on every snapshot, and a snapshot is taken on every gap, every
    // reconnect and every session replacement.
    //
    // No URL without a session to address it in, and none for a media type the
    // renderer has agreed not to draw: both leave `url` empty, which is what
    // makes the block fall back to naming the image instead of showing a
    // picture that cannot load.
    const mediaType = renderableImageMediaType(part.mimeType)
    const url =
      context.sessionId === undefined || mediaType === undefined
        ? ""
        : imageUrl({ sessionId: context.sessionId, messageIndex, blockIndex: index })
    return { index, kind: "image", url, mediaType: part.mimeType } satisfies ContentBlock
  })
}

/**
 * What a tool call in a *finished* assistant message is known to have done.
 *
 * The message itself does not say: the outcome lives in the tool-result message
 * that follows it. Every tool-call block used to be projected as `succeeded`,
 * so a denied write and a failed command both rendered as though they had run.
 * `projectMessages` builds this from the history it already has; a lone message
 * has no such history, and its calls are reported as still running rather than
 * as guessed outcomes.
 */
export type ToolCallOutcomes = ReadonlyMap<string, ToolCallStatus>

export interface MessageProjectionContext {
  workspaceRoot: string
  /**
   * Which session this history belongs to, needed only to address its images.
   *
   * Optional because `projectMessage` is also called on a lone message with no
   * session around it, and an image in that position has no URL that would
   * resolve — see `userBlocks`.
   */
  sessionId?: string
  pendingApprovals?: readonly ApprovalRequest[]
}

/** The one derivation used by persisted tool blocks and live tool events. */
export const projectToolCall = (
  id: string,
  name: string,
  args: unknown,
  workspaceRoot: string,
  status: ToolCallStatus,
  startedAt?: number,
): ToolCall => {
  const extracted = extractTargets(name, args, workspaceRoot)
  return {
    id,
    name,
    source: isBuiltinToolName(name) ? "builtin" : "extension",
    args,
    targets: classifyTargets(workspaceRoot, extracted.targets),
    status,
    ...(startedAt === undefined ? {} : { startedAt }),
  }
}

const assistantBlocks = (
  message: AssistantMessage,
  context: MessageProjectionContext,
  outcomes: ToolCallOutcomes | undefined,
): ContentBlock[] =>
  message.content.map((part, index) => {
    switch (part.type) {
      case "text":
        return { index, kind: "text", text: part.text } satisfies ContentBlock
      case "thinking":
        return {
          index,
          kind: "reasoning",
          text: part.thinking,
          redacted: part.redacted ?? false,
        } satisfies ContentBlock
      case "toolCall":
        return {
          index,
          kind: "tool_call",
          call: projectToolCall(
            part.id,
            part.name,
            part.arguments,
            context.workspaceRoot,
            outcomes?.get(part.id) ??
              (context.pendingApprovals?.some((approval) => approval.call.id === part.id) === true
                ? "pending_approval"
                : "running"),
          ),
        } satisfies ContentBlock
    }
  })

const toolResultBlocks = (message: ToolResultMessage): ContentBlock[] => {
  const text = contentText(message.content)
  const todo = projectTodoState(message.toolName, message.details)
  return [
    {
      index: 0,
      kind: "tool_result",
      result: {
        toolCallId: message.toolCallId,
        status: toolResultStatus(message.isError, text),
        output: text.slice(0, 262_144),
        truncated: text.length > 262_144,
        ...(todo === undefined ? {} : { todo }),
      },
    },
  ]
}

/**
 * Projects one of Pi's messages onto the contract.
 *
 * Roles Bake Pi does not model yet — Pi's custom messages, bash-execution
 * records, branch and compaction summaries — become a system text block rather
 * than disappearing. A message that vanishes from the timeline is worse than
 * one rendered plainly: the user cannot tell that the agent did something the
 * interface failed to show.
 */
export const projectMessage = (
  message: AgentMessage,
  index: number,
  context: MessageProjectionContext,
  outcomes?: ToolCallOutcomes,
): Message => {
  const id = messageIdAt(index)

  switch (message.role) {
    case "user":
      return { id, role: "user", status: "complete", blocks: userBlocks(message, index, context), createdAt: message.timestamp }
    case "assistant": {
      const usage = tokenUsageOf(message.usage)
      return {
        id,
        role: "assistant",
        status: assistantStatus(message),
        blocks: assistantBlocks(message, context, outcomes),
        // Pi's own timestamp, not this projection's clock. Reading `Date.now()`
        // here re-dated every assistant message on every snapshot, so a reopened
        // session claimed the model answered just now and any resync silently
        // moved history forward.
        createdAt: message.timestamp,
        modelId: message.model,
        ...(usage === undefined ? {} : { usage }),
      }
    }
    case "toolResult":
      return {
        id,
        role: "system",
        status: "complete",
        blocks: toolResultBlocks(message),
        createdAt: message.timestamp,
      }
    default:
      return {
        id,
        role: "system",
        status: "complete",
        blocks: [{ index: 0, kind: "text", text: describeUnmodelled(message) }],
        createdAt: timestampOf(message),
      }
  }
}

export const projectMessages = (messages: readonly AgentMessage[], context: MessageProjectionContext): Message[] => {
  const outcomes = toolCallOutcomes(messages)
  return messages.map((message, index) => projectMessage(message, index, context, outcomes))
}

/**
 * Pairs each tool call in history with the result that came back for it.
 *
 * A call with no result in history is left out of the map, so it projects as
 * running — which is what it is: a snapshot taken mid-batch legitimately
 * contains a call whose result has not been written yet.
 */
const toolCallOutcomes = (messages: readonly AgentMessage[]): ToolCallOutcomes => {
  const outcomes = new Map<string, ToolCallStatus>()
  for (const message of messages) {
    if (message.role !== "toolResult") continue
    outcomes.set(message.toolCallId, toolResultStatus(message.isError, contentText(message.content)))
  }
  return outcomes
}

const describeUnmodelled = (message: AgentMessage): string => {
  const role = (message as { role?: unknown }).role
  switch (role) {
    case "bashExecution":
      return (message as { command: string }).command
    case "compactionSummary":
    case "branchSummary":
      return (message as { summary: string }).summary
    default:
      return `[${String(role)}]`
  }
}

const timestampOf = (message: AgentMessage): number => {
  const at = (message as { timestamp?: unknown }).timestamp
  return typeof at === "number" ? at : Date.now()
}
