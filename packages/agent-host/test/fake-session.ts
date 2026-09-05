import type { AgentSessionEvent, AgentSessionRuntime } from "@earendil-works/pi-coding-agent"

/**
 * A Pi session runtime with nothing behind it, for the tests that must not be
 * driven by a real model.
 *
 * `test/vertical-slice.test.ts` runs the same code against real Pi and a real
 * provider, and that is the test that proves the wiring. This one exists for the
 * cases a real session cannot produce on demand — a summarization retry, a
 * compaction that fails, an event Pi only emits under a provider fault — where
 * waiting for the real thing would mean never testing it at all.
 *
 * Only the members `SessionHost` actually touches are present. Anything else it
 * reached for fails loudly rather than silently returning undefined, which is
 * the point of not using a permissive stub: a host that started calling
 * `getSessionStats` would otherwise have quietly produced zeroed usage here and
 * nowhere else.
 */

export interface SessionStatsShape {
  assistantMessages: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  cost: number
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null }
}

/**
 * Whether Pi has a turn in flight. Mutable, because the sole-writer guard
 * abstains exactly while this says a turn of ours may still be appending.
 */
export interface FlagsShape {
  idle: boolean
}

/** What the session reports as selected. Mutable: a model change is a state change. */
export interface SelectionShape {
  model: { id: string; provider: string } | undefined
  thinkingLevel: string
  availableThinkingLevels: string[]
}

export interface FakeSession {
  runtime: AgentSessionRuntime
  /** Delivers one Pi event to whatever the host subscribed with. */
  emit: (event: AgentSessionEvent) => void
  /** Pi's history, live: push to it the way Pi's agent does before it emits. */
  messages: unknown[]
  /** What `getSessionStats` will report next. Mutable, because usage changes mid-session. */
  stats: SessionStatsShape
  /** What the session is running on. Mutable, because that is what a model change is. */
  selection: SelectionShape
  /** Pi's own in-flight state, live: flip it the way a turn starting and settling does. */
  flags: FlagsShape
  disposed: () => boolean
}

export interface FakeSessionOptions {
  sessionId?: string
  sessionFile?: string | undefined
  messages?: unknown[]
  stats?: Partial<SessionStatsShape>
  idle?: boolean
}

export const fakeSession = (options: FakeSessionOptions = {}): FakeSession => {
  const messages = options.messages ?? []
  const stats: SessionStatsShape = {
    assistantMessages: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    ...options.stats,
  }
  const selection: SelectionShape = { model: undefined, thinkingLevel: "off", availableThinkingLevels: ["off"] }
  const flags: FlagsShape = { idle: options.idle ?? true }
  let subscriber: ((event: AgentSessionEvent) => void) | undefined
  let disposed = false

  const runtime = {
    session: {
      sessionId: options.sessionId ?? "session-under-test",
      sessionFile: options.sessionFile,
      messages,
      // Getters rather than values: the host reads the selection back after
      // every change precisely because Pi may not have applied what was asked.
      get model() {
        return selection.model
      },
      get thinkingLevel() {
        return selection.thinkingLevel
      },
      get isIdle() {
        return flags.idle
      },
      getAvailableThinkingLevels: () => selection.availableThinkingLevels,
      getSessionStats: () => stats,
      subscribe: (callback: (event: AgentSessionEvent) => void) => {
        subscriber = callback
        return () => {
          subscriber = undefined
        }
      },
      dispose: () => {
        disposed = true
      },
    },
  } as unknown as AgentSessionRuntime

  return {
    runtime,
    emit: (event) => subscriber?.(event),
    messages,
    stats,
    selection,
    flags,
    disposed: () => disposed,
  }
}
