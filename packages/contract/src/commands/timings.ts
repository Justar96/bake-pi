import { Type, type TLiteral, type TSchema, type TUnion } from "@sinclair/typebox"
import { SessionId } from "../dto/primitives.ts"
import type { CommandName } from "./index.ts"

/**
 * `get_timings`: where the agent host's time went, as the renderer is allowed
 * to see it.
 *
 * The producer is `packages/agent-host/src/observability/timings.ts`; this file
 * is the wire shape it has to fit through, and the shape is the enforcement
 * rather than a description of it. Milestone 2.1 states the constraint as "span
 * detail cannot carry a path, a tool argument, or any free-form string from
 * host internals to the renderer", and the way that is held here is that a span
 * carries a name drawn from a closed vocabulary, a number, and — where the span
 * is a turn leg — the `SessionId` the turn ran on. No schema below accepts an
 * unconstrained string, so a future change that wanted to attach a file path to
 * a slow `read` would have to widen this file first, in a diff whose whole
 * subject is the widening.
 *
 * A `SessionId` is the one identifier that is not host internals, and the
 * distinction is the point rather than an exception to it. The renderer either
 * supplied this id on `open_session` or received it from `create_session`; it
 * rides on every session event envelope and on the params of most session
 * commands; and it is a validated DTO with a length bound rather than a
 * free-form string. Returning it in a timing report discloses nothing the
 * renderer did not already have, which is exactly what cannot be said of a
 * workspace path, a tool argument, or a Pi tool call id. The rule the schema
 * keeps is therefore not "no strings" but "no string the renderer does not
 * already hold", and `validate.test.ts` walks this schema to assert that
 * `SessionId` appears in the two places below and nowhere else.
 *
 * The other rule the shape encodes is that every field here is a *duration*.
 * Nothing is an instant. A timestamp taken in the agent host and subtracted
 * from one taken in main or the renderer is meaningless across a host restart,
 * a machine suspend, or a stepped wall clock, and the cheapest way to keep that
 * mistake unavailable is to never put an instant on the wire.
 */

/**
 * The legs a settled turn decomposes into.
 *
 * Two legs and a total, because a turn that settles without ever streaming — an
 * immediate refusal, a turn that is all tool call, an aborted one — has no
 * first-delta instant and therefore neither leg, and would otherwise be
 * invisible. The total is always recorded, so a name's `count` also says how
 * many turns of each kind there were.
 */
export const TURN_SPAN_NAMES = [
  "turn.accepted_to_first_delta",
  "turn.first_delta_to_settled",
  "turn.accepted_to_settled",
] as const

export type TurnSpanName = (typeof TURN_SPAN_NAMES)[number]

/**
 * The tool vocabulary a span may be named after.
 *
 * These are Pi's built-in tools plus `other`, and `other` is the part that
 * matters: Pi's tool set is open, because project extensions and MCP servers
 * register tools whose names this repository has never seen and which are
 * influenced from outside in exactly the way a file path is. Every unrecognised
 * name folds onto `other` in the host before it can reach a span, so no string
 * from outside becomes a span name.
 *
 * This list is a second copy of `TOOL_LABELS` in the agent host's
 * `observability/timings.ts`, and the duplication is forced rather than chosen:
 * the contract is the agent host's dependency and not the reverse, so it cannot
 * import the producer's list, and the producer's list is itself a copy of Pi's
 * own `ToolName` union — which Pi does not export from its package entry. The
 * two are pinned against each other by a test in the agent host, which is the
 * only place both are in scope.
 */
export const TIMING_TOOL_LABELS = ["read", "write", "edit", "bash", "powershell", "grep", "find", "ls", "other"] as const

export type TimingToolLabel = (typeof TIMING_TOOL_LABELS)[number]

/**
 * Every name a span may carry.
 *
 * `unknown` is the producer's total-function escape: its name table and this
 * union are built from the same three sources, and a count against `unknown`
 * can mean they have drifted apart. It is a name rather than a thrown error
 * because a reporting path must not be able to take down the host it is
 * reporting on.
 *
 * It has a second meaning, and a reader has to know both to read a count of it.
 * The agent host times a command from before its envelope is validated, so a
 * message that never became a command — malformed, oversized, or naming
 * something that is not a command — is measured, and the only name it could
 * otherwise be given is a string chosen by whoever sent it. Those spans are
 * `unknown` too, deliberately: the measurement is worth keeping and the name is
 * not one this vocabulary will ever admit.
 */
export type SpanName = TurnSpanName | `tool.${TimingToolLabel}` | `command.${CommandName}` | "unknown"

/**
 * The wire cap on how many individual spans one report may carry.
 *
 * It exists so the array bound is a stated number rather than whatever the
 * producer's ring happens to be, and it is the number the producer's
 * `DEFAULT_RING_CAPACITY` is held under by a test in the agent host. At roughly
 * forty bytes of JSON per span this is about 160 KB — two percent of
 * `MAX_ENVELOPE_BYTES`, which is affordable for a command a developer issues by
 * hand and is not something to put on a hot path.
 */
export const MAX_TIMING_SPANS = 4096

/**
 * The wire cap on how many sessions one report may decompose turns for.
 *
 * The producer's own cap is the number that matters and is held under this one
 * by a test in the agent host; this exists so the array bound on the wire is a
 * stated number rather than whatever the producer happens to keep. Sixty-four
 * `SessionId`s and three aggregates apiece is on the order of 30 KB of JSON,
 * which is a fifth of what `recent` costs and not worth economising on.
 */
export const MAX_TIMING_SESSIONS = 64

/** A union of literals rather than a pattern, so the vocabulary is closed by enumeration. */
type TSpanName = TUnion<TLiteral<SpanName>[]>

const spanNameLiteral = (name: SpanName): TLiteral<SpanName> => Type.Literal(name)

/**
 * The one narrowing in this file, and the only place a `string` becomes a span
 * name.
 *
 * The argument really is a contract command name -- the registry passes its own
 * keys -- but it arrives through `Object.keys`, which erases that, and typing
 * the parameter as `CommandName` instead puts `CommandName` in this function's
 * signature and makes the registry's type circular through it. So the narrowing
 * is asserted here and checked where it can be: `validate.test.ts` compares the
 * vocabulary this produces against `COMMAND_NAMES` itself, which is the only
 * assertion that would actually catch a name going missing.
 */
const commandSpanName = (name: string): SpanName => `command.${name}` as SpanName

const emptyParams = Type.Object({})

/**
 * A percentile, stated as the bucket it fell in rather than as a millisecond
 * figure fixed buckets cannot support.
 *
 * `belowMs` is null for the open-ended top bucket. A number there would be a
 * fabricated ceiling for a `bash` call that might have run for an hour.
 */
const bucketedPercentile = Type.Object({
  atLeastMs: Type.Number({ minimum: 0 }),
  belowMs: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
})

/**
 * One name's totals, whichever population they were gathered over.
 *
 * The same shape serves the host-wide aggregates and a session's own turn legs,
 * because the arithmetic is identical and only the population differs. The name
 * schema is a parameter so the per-session array can be narrowed to the three
 * turn legs, which is the design decision this file gets to enforce rather than
 * merely describe: a tool or command aggregate appearing under a session would
 * fail validation.
 */
const spanAggregate = <TName extends TSchema>(name: TName) =>
  Type.Object({
    name,
    count: Type.Integer({ minimum: 0 }),
    /** Spans opened and never closed. A leak surfaces here rather than as memory nobody attributes. */
    abandoned: Type.Integer({ minimum: 0 }),
    totalMs: Type.Number(),
    maxMs: Type.Number(),
    /**
     * Null rather than zero when `count` is zero, which happens for a name that
     * has only ever been abandoned. Zero would read as "this is instant"; null
     * reads as "there is no measurement here".
     */
    meanMs: Type.Union([Type.Number(), Type.Null()]),
    p50: Type.Union([bucketedPercentile, Type.Null()]),
    p95: Type.Union([bucketedPercentile, Type.Null()]),
    p99: Type.Union([bucketedPercentile, Type.Null()]),
  })

/** The three turn legs, as their own closed union, because only they carry a session. */
const turnSpanName = Type.Union(TURN_SPAN_NAMES.map((name): TLiteral<TurnSpanName> => Type.Literal(name)))

/**
 * The report itself.
 *
 * Durations are `Type.Number()` with no lower bound, and that is deliberate.
 * Every duration in a report is a difference of two readings of one monotonic
 * clock inside the host, so a negative one means an assumption in the producer
 * is wrong — an instant recorded out of order, a handle reused across turns.
 * Clamping the schema at zero would refuse the one report worth having, the one
 * carrying that evidence. Counts and byte figures are non-negative integers
 * because there is no such story for them: a negative count is not a
 * measurement, it is a corrupt payload.
 *
 * `spanNameCount` bounds the two arrays that hold one entry per name. It is
 * passed in rather than derived here because the vocabulary is only complete
 * once the command registry is, which is the same reason this whole schema is
 * built by a function.
 */
const snapshotSchemaFor = (spanName: TSpanName, spanNameCount: number) =>
  Type.Object({
    /**
     * Completed spans, oldest first. Individual durations rather than a summary.
     *
     * `sessionId` is optional rather than nullable, and the difference is worth
     * a line: a tool span and a command span have no session dimension at all,
     * so the field is *absent* on them, which keeps the two-field guarantee
     * those spans have always had and keeps a null out of every one of them on
     * the wire. It is also absent on a turn leg whose session has since been
     * evicted from the producer's table — the duration is still a measurement,
     * it just no longer says whose.
     */
    recent: Type.Array(
      Type.Object({ name: spanName, ms: Type.Number(), sessionId: Type.Optional(SessionId) }),
      { maxItems: MAX_TIMING_SPANS },
    ),
    /**
     * Per-name totals across the whole host, which survive the ring's eviction.
     * Without these an hour-old pathology is gone as if it never happened;
     * without `recent`, "how long did the turn I just watched take" is
     * unanswerable.
     */
    aggregates: Type.Array(spanAggregate(spanName), { maxItems: spanNameCount }),
    /**
     * The same turn legs again, decomposed by the session that ran them.
     *
     * This is the array the milestone's exit criterion is about. A host may hold
     * thirty-two sessions at once and a turn's cost grows with the history
     * behind it, so a host-wide mean is an average of a four-hundred-turn
     * session against thirty idle ones — which hides the only session anyone
     * needed to find. `aggregates` still answers "is first-delta latency
     * drifting across this host"; this answers "on which session".
     */
    sessions: Type.Array(
      Type.Object({
        sessionId: SessionId,
        /** Turn legs only, by construction: tools and commands stay host-wide. */
        turns: Type.Array(spanAggregate(turnSpanName), { maxItems: TURN_SPAN_NAMES.length }),
      }),
      { maxItems: MAX_TIMING_SESSIONS },
    ),
    /**
     * Spans in flight, counted by name and never by key.
     *
     * The producer files open spans under session ids, tool call ids and
     * request ids, and a count answers "something has been open a while"
     * without naming what. A session dimension here would say less than it
     * appears to: the count is of spans that have *not* finished, so attributing
     * them would name the sessions that are merely busy right now alongside the
     * one that is stuck.
     */
    open: Type.Array(Type.Object({ name: spanName, count: Type.Integer({ minimum: 0 }) }), {
      maxItems: spanNameCount,
    }),
    /**
     * What the instrument itself cost, so "this is cheap" is a number the caller
     * can check rather than a claim this file makes. `clockReads` is the one
     * that matters for the streaming path: a turn that streamed a thousand
     * deltas must not have read the clock a thousand times.
     */
    cost: Type.Object({
      clockReads: Type.Integer({ minimum: 0 }),
      spansRecorded: Type.Integer({ minimum: 0 }),
      spansAbandoned: Type.Integer({ minimum: 0 }),
      ringCapacity: Type.Integer({ minimum: 0 }),
      ringBytes: Type.Integer({ minimum: 0 }),
      bucketBytes: Type.Integer({ minimum: 0 }),
      openSpans: Type.Integer({ minimum: 0 }),
      maxOpenSpans: Type.Integer({ minimum: 0 }),
      /** How many sessions the report decomposes, and the cap that bounds it. */
      trackedSessions: Type.Integer({ minimum: 0 }),
      maxTrackedSessions: Type.Integer({ minimum: 0 }),
      /**
       * How many sessions have been dropped from that table to make room. A
       * non-zero figure is what says a missing `sessionId` on an old turn leg is
       * eviction rather than a wiring fault.
       */
      sessionsForgotten: Type.Integer({ minimum: 0 }),
    }),
  })

export interface TimingsCommandDefs {
  readonly get_timings: {
    readonly params: typeof emptyParams
    readonly result: ReturnType<typeof snapshotSchemaFor>
  }
}

/**
 * Built by a function rather than declared as a constant, because the span
 * vocabulary carries one name per contract command and therefore cannot be
 * written until every other command is known.
 *
 * The obvious alternative — importing `COMMAND_NAMES` here — is a module cycle
 * that fails at load rather than at build: `COMMAND_NAMES` is derived from
 * `CommandDefs`, `CommandDefs` contains this command, so the import would reach
 * `COMMAND_NAMES` in its temporal dead zone. The registry therefore hands this
 * function the names it has already assembled, and this function contributes
 * the one name the registry cannot have yet, which is its own.
 */
export const timingsCommands = (otherCommandNames: readonly string[]): TimingsCommandDefs => {
  const spanNames: SpanName[] = [
    ...TURN_SPAN_NAMES,
    ...TIMING_TOOL_LABELS.map((label): SpanName => `tool.${label}`),
    ...otherCommandNames.map(commandSpanName),
    "command.get_timings",
    "unknown",
  ]
  return {
    get_timings: {
      params: emptyParams,
      result: snapshotSchemaFor(Type.Union(spanNames.map(spanNameLiteral)), spanNames.length),
    },
  }
}
