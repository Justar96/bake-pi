import type { Static } from "@sinclair/typebox"
import { interactionEvents } from "./interaction.ts"
import { lifecycleEvents } from "./lifecycle.ts"
import { sessionEvents } from "./session.ts"
import { workspaceEvents } from "./workspace.ts"

export * from "./define.ts"

export const EventDefs = {
  ...lifecycleEvents,
  ...sessionEvents,
  ...workspaceEvents,
  ...interactionEvents,
} as const

export type EventName = keyof typeof EventDefs
export type EventPayload<N extends EventName> = Static<(typeof EventDefs)[N]>

/**
 * The events that describe one session, named as a type as well as a set.
 *
 * The set below is what the envelope checks at runtime. This is what lets the
 * renderer's projection be exhaustive at compile time over the same list, so a
 * session event added to the contract fails the renderer's build rather than
 * falling through its reducer's `default` and being silently discarded.
 */
export type SessionEventName = keyof typeof sessionEvents

export const EVENT_NAMES = Object.keys(EventDefs).sort() as readonly EventName[]

export const isEventName = (value: unknown): value is EventName =>
  typeof value === "string" && Object.hasOwn(EventDefs, value)

/**
 * Events that are meaningless without a session. The envelope requires
 * `sessionId` for exactly these, checked at construction rather than trusted,
 * because a session event routed to no session is silently dropped by the
 * renderer and looks like a lost token.
 */
export const SESSION_SCOPED_EVENTS = new Set<EventName>(
  Object.keys(sessionEvents) as (keyof typeof sessionEvents)[],
)
