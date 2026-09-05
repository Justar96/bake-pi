import type { EventName } from "@bake-pi/contract"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"

/**
 * What Bake Pi does with every event Pi can emit on a session.
 *
 * This table exists because "the adapter handles the important events" is not a
 * claim anyone can check. A `switch` with a permissive `default` looks complete
 * from the inside: an event Pi added upstream, or one that was always there and
 * nobody mapped, falls through silently and becomes an interface that quietly
 * stops describing what the agent is doing.
 *
 * Two mechanisms hold the table honest, and neither is documentation:
 *
 * 1. The type is `Record<PiEventType, ...>`, so a Pi upgrade that adds an event
 *    is a **compile error here** rather than a silent omission in the adapter.
 *    That is the deliberate trade: one place fails loudly, and the failure names
 *    the decision that has to be made — map it, or record why not.
 * 2. `coverage.test.ts` drives a real `SessionHost` with a fixture for every
 *    entry and asserts the events it emits are exactly the ones declared here.
 *    A mapping that is removed, renamed or made conditional fails the suite; so
 *    does an entry claiming an emission the adapter does not make.
 *
 * An entry with an empty `emits` is a decision, not an oversight, and its
 * `reason` is the part worth reading.
 */

export type PiEventType = AgentSessionEvent["type"]

export interface PiEventCoverage {
  /**
   * Every contract event this Pi event can produce. A conditional mapping lists
   * the union across its cases: `message_update` emits one of three, depending
   * on which assistant-stream event it carries.
   */
  emits: readonly EventName[]
  /** Why it maps this way, or — when `emits` is empty — why it maps to nothing. */
  reason: string
}

export const PI_EVENT_COVERAGE: Record<PiEventType, PiEventCoverage> = {
  agent_start: {
    emits: ["session_status_changed"],
    reason: "Opens the turn. The status is what every mutating control disables itself against.",
  },

  agent_end: {
    emits: [],
    reason:
      "Deliberately silent. It means the loop emitted its last event, not that the work finished: an " +
      "auto-retry or a queued follow-up can continue immediately after it, and Pi emits agent_settled " +
      "when the session is actually idle. Reporting idle here would show a finished turn in the " +
      "middle of one.",
  },

  agent_settled: {
    emits: ["session_status_changed"],
    reason:
      "The session is genuinely idle, which is also the only moment every write the turn made has " +
      "landed — so the write guard re-records the file's identity here and nowhere earlier.",
  },

  turn_start: {
    emits: ["turn_started"],
    reason: "One turn of the loop, which may inject queued messages before the assistant answers.",
  },

  turn_end: {
    emits: ["turn_settled", "usage_changed"],
    reason:
      "Carries the assistant message the turn produced, so the stop reason and the token usage are " +
      "read from it rather than assumed. Cumulative session usage follows, deduplicated against the " +
      "last figure announced.",
  },

  message_start: {
    emits: ["message_added"],
    reason: "A message enters the timeline. An assistant message is still empty here; its blocks stream in after.",
  },

  message_update: {
    emits: ["block_started", "block_delta", "block_finished"],
    reason:
      "One assistant-stream event at a time. Text and reasoning open a block, stream deltas into it, " +
      "and close it with the final content; a completed tool call arrives whole as a finished block. " +
      "Partial tool-call JSON emits nothing — see the adapter.",
  },

  message_end: {
    emits: ["block_finished"],
    reason:
      "The authoritative version of a streamed assistant message. Every block is re-emitted finished, " +
      "which repairs a delta the renderer missed and is the only path by which a tool call that never " +
      "streamed reaches the timeline. Other roles arrive complete at message_start and emit nothing here.",
  },

  tool_execution_start: {
    emits: ["tool_call_started"],
    reason:
      "Targets are resolved by the same functions the approval gate uses, so the timeline card and the " +
      "approval card describe one tool call identically.",
  },

  tool_execution_update: {
    emits: ["tool_call_updated"],
    reason:
      "A running tool's output so far. Pi reports it cumulatively, so the update replaces the previous " +
      "partial rather than appending to it.",
  },

  tool_execution_end: {
    emits: ["tool_call_finished"],
    reason: "The tool's result, projected the way a tool-result message in history is.",
  },

  queue_update: {
    emits: ["queue_changed"],
    reason: "Steering and follow-up messages Pi has accepted but not yet delivered.",
  },

  compaction_start: {
    emits: ["session_status_changed", "compaction_started"],
    reason: "Compaction blocks the session, and a compacting session that reported idle would look hung.",
  },

  compaction_end: {
    emits: ["session_status_changed", "compaction_finished", "session_snapshot"],
    reason:
      "Compaction rewrites history, so incremental repair is impossible and the projection is replaced. " +
      "The removed-message count is measured across the operation rather than read from Pi's result, " +
      "which reports tokens and a kept-entry id but no count.",
  },

  entry_appended: {
    emits: [],
    reason:
      "Every append to the session file, including the ones this host just made. The projection is " +
      "built from messages and lifecycle events, not from session entries, and re-recording the write " +
      "fingerprint here would fold a foreign append made mid-turn into our own baseline — which is " +
      "precisely the write the guard exists to refuse.",
  },

  session_info_changed: { emits: ["session_summary_changed"], reason: "The session was renamed." },

  thinking_level_changed: {
    emits: ["model_changed"],
    reason:
      "The selection is read back from the session rather than built from the event: a level change " +
      "that arrived from inside setModel is also a model change, and an event naming the new level " +
      "beside the old model would describe a state that never existed.",
  },

  auto_retry_start: {
    emits: ["session_status_changed", "retry_scheduled"],
    reason: "Shown rather than hidden. A silent stall is indistinguishable from a hang.",
  },

  auto_retry_end: {
    emits: ["session_status_changed"],
    reason: "Back to streaming when the retry took, idle when the budget ran out.",
  },

  summarization_retry_scheduled: {
    emits: ["session_status_changed", "retry_scheduled"],
    reason:
      "Compaction and branch summarization make their own model calls, and retry on the same budget a " +
      "turn does. A user watching a stalled compaction needs the same explanation as one watching a " +
      "stalled turn.",
  },

  summarization_retry_attempt_start: {
    emits: ["session_status_changed"],
    reason:
      "Restores the status the retry interrupted rather than assuming one. Summarization retries fire " +
      "under compaction and under branch summarization, and only the first of those was compacting.",
  },

  summarization_retry_finished: {
    emits: ["session_status_changed"],
    reason: "The same restoration, for the case where the retries stop without another attempt.",
  },

  bash_execution_update: {
    emits: [],
    reason:
      "Output from AgentSession.executeBash, which is the CLI's own bang-command path. Bake Pi never " +
      "calls it — an integrated terminal is explicitly outside v1 — so this event cannot arise from " +
      "anything the interface offers. Bash run as a *tool* streams through tool_execution_update " +
      "instead, and that is mapped.",
  },
}

/** The Pi events the adapter turns into at least one contract event. */
export const MAPPED_PI_EVENTS: readonly PiEventType[] = (Object.keys(PI_EVENT_COVERAGE) as PiEventType[]).filter(
  (type) => PI_EVENT_COVERAGE[type].emits.length > 0,
)
