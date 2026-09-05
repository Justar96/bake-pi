import { COMMAND_NAMES, type CommandName, type SessionId } from "@bake-pi/contract"

/**
 * Where the agent host's time went, recorded so that a slow turn is attributed
 * rather than guessed at.
 *
 * Three constraints shaped every decision in this file, and each of them cost
 * something that a more obvious design would have kept.
 *
 * **No cross-process timestamp, ever.** Every duration recorded here begins and
 * ends inside this process, on this process's `performance.now()`. Durations
 * cross the boundary to main and the renderer; instants do not. Electron's three
 * runtimes were measured against each other by `scripts/clocks.ts` and agree to
 * under a millisecond over a short undisturbed window, and that measurement
 * licenses nothing: the host restarts, machines suspend, and wall clocks get
 * stepped, none of which it covers. So there is no field anywhere below that
 * holds an absolute time, and nothing here can be subtracted from a reading
 * taken somewhere else.
 *
 * **The instrument must not change what it measures.** A streaming turn emits
 * hundreds of block deltas. A span per delta would allocate hundreds of objects
 * and take hundreds of clock readings inside the exact loop whose latency is
 * under investigation, which is measuring the thermometer. So the finest thing
 * recorded here is a turn: three instants (prompt accepted, first delta,
 * settled) and the legs between them. The first delta is the only per-delta
 * event that touches this module at all, and every delta after it costs one
 * property read and one comparison -- see `OpenSpan.noteFirstDelta`.
 *
 * **A span may carry a name, numbers, and the renderer's own handle for a
 * session -- and nothing else.** These records are returned to the renderer
 * through `get_timings`, and `SEC-006` is precisely about host internals
 * reaching the renderer. A free-form string field would be a standing
 * invitation to put a file path, a tool argument, or a fragment of a prompt
 * into telemetry, and the first such leak would be found by an auditor rather
 * than by a compiler. The enforcement is structural: `SpanName` is a closed
 * union, and the public methods accept `ToolLabel` and `CommandName` rather
 * than `string`, so there is no argument position anywhere in this API that an
 * arbitrary tool or command name fits into. `toolLabel` is the one door between
 * the two worlds, and it is a total function onto the closed set -- a name it
 * does not recognise becomes `"other"`.
 *
 * A `SessionId` is on the other side of that line, and stating why is the
 * reason this paragraph is long. The rule exists to stop things the renderer
 * does not have from reaching it: a workspace path, a tool argument, a Pi tool
 * call id, a fragment of a prompt. A session id is not one of those. The
 * renderer either supplied it on `open_session` or was handed it by
 * `create_session`; it rides on every session event envelope and on the params
 * of most session commands; and it is a validated `SessionId` DTO with a length
 * bound, not a free-form string. Returning it here discloses nothing, and
 * withholding it costs the report the only thing it is for.
 *
 * Because `scripts/budgets.ts` measured that a turn's cost grows roughly
 * threefold over forty turns of history, and `session/budget.ts` admits up to
 * `MAX_OPEN_SESSIONS` of them at once, a host-wide mean over turns is an
 * average of one four-hundred-turn conversation against thirty idle ones. It
 * says "turns are slow" and hides which session is slow, which is the whole of
 * the question. So the three turn legs carry a session dimension and nothing
 * else does -- see `#recordTurn` for where that line is drawn and why tool and
 * command spans stay host-wide.
 */

/**
 * How this module reads time. Injected so tests decide what the clock says
 * rather than trying to make wall time cooperate, following the same pattern as
 * `apps/desktop/src/main/observability/startup.ts`.
 */
export type Clock = () => number

/**
 * What an open span is filed under while it is open.
 *
 * A key is a caller's own identifier -- a tool call id for a tool, a request id
 * for a command -- and for those two kinds it is a map key and nothing more: it
 * is never copied into a `Span`, into an aggregate, or into a snapshot, so a Pi
 * tool call id and a renderer request id cannot reach the report through this
 * path even though the caller had to supply one.
 *
 * A turn's key is the exception, and it is an exception by design rather than
 * by oversight: it is the `SessionId`, and it *is* reported. `beginTurn`,
 * `endTurn` and `closeSession` take a `SessionId` rather than a `SpanKey` for
 * that reason -- the signature is where a reader finds out which keys are
 * reported and which are not, so the two cases must not share a type.
 *
 * The type is a bare `string` rather than a brand because branding it would
 * suggest the value is meaningful here, and for a tool call id or a request id
 * it is not.
 */
export type SpanKey = string

/**
 * The legs a settled turn decomposes into.
 *
 * Two legs and a total rather than two legs alone, because a turn that settles
 * without ever streaming a delta -- an immediate refusal, a turn that is all
 * tool call, an aborted one -- has no first-delta instant and therefore neither
 * leg. Recording only the legs would make those turns invisible; recording only
 * the total would make a slow one indistinguishable between "the model took a
 * long time to say its first word" and "it said a great many words". The total
 * is always recorded and the two legs are recorded when there was a first delta,
 * so a name's `count` also says how many turns of each kind there were.
 */
export const TURN_SPAN_NAMES = [
  "turn.accepted_to_first_delta",
  "turn.first_delta_to_settled",
  "turn.accepted_to_settled",
] as const

export type TurnSpanName = (typeof TURN_SPAN_NAMES)[number]

/**
 * The name a turn is open under before it is known which legs it will produce.
 *
 * A turn that never settles is abandoned against this name, because the total
 * is the one leg every turn would have had. Naming it once here rather than
 * repeating the literal is what lets `#abandon` file an abandonment into a
 * session's own table without a cast: it is the only name a turn's open span
 * can carry, so the type is `TurnSpanName` and not `SpanName`.
 */
const TURN_TOTAL_SPAN_NAME: TurnSpanName = "turn.accepted_to_settled"

/**
 * The longest session id this module will attribute a turn to.
 *
 * It is the contract's `SessionId` bound, restated because this module produces
 * the report rather than validating it, and a report that fails its own
 * contract on arrival is an instrument that has silently stopped working. A
 * longer id is not truncated -- a truncated id names a session that does not
 * exist -- and it is not thrown on either, because a reporting path must not be
 * able to take down the host it reports on. The turn is recorded host-wide with
 * no session, which is the honest answer: it happened, and this module declines
 * to say whose it was. `timings-contract.test.ts` pins the number against the
 * DTO so the two cannot drift.
 */
export const MAX_SESSION_ID_LENGTH = 128

/**
 * The tool vocabulary a span may be named after.
 *
 * These eight are Pi 0.85.0's built-in tools, read from its own `ToolName` union
 * in `dist/core/tools/index.d.ts`. They are copied rather than imported because
 * Pi's package `exports` map publishes only `.`, `./client` and `./rpc-entry`,
 * and neither `ToolName` nor `allToolNames` is re-exported from the entry point
 * -- so there is no import that would turn a Pi upgrade renaming a tool into a
 * compile error. A rename would instead show up as that tool's spans moving to
 * `"other"`, which is a visible symptom rather than a silent one, and
 * `timings.test.ts` pins the list so the copy is at least deliberate.
 *
 * `"other"` is not a fallback that got added for tidiness; it is the security
 * boundary. Pi's tool set is open -- project extensions and MCP servers register
 * tools whose names this repository has never seen, and a tool name is
 * influenced from outside in exactly the way a file path is. Folding every
 * unknown name into one bucket costs the ability to attribute time to a
 * third-party tool by name and buys the guarantee that no string from outside
 * this file can become a span name.
 */
export const TOOL_LABELS = ["read", "write", "edit", "bash", "powershell", "grep", "find", "ls", "other"] as const

export type ToolLabel = (typeof TOOL_LABELS)[number]

/**
 * Every name a span may carry, and there is no ninth shape.
 *
 * `"unknown"` began as the escape that lets the index lookup in `#record` have
 * a total answer without a non-null assertion, and it still is that. It now has
 * a second producer, and this one is deliberate: a command span opened by
 * `beginCommand` before the envelope was validated, whose `nameCommand` never
 * arrived because validation refused the message. A count against `"unknown"`
 * is therefore no longer evidence on its own that the name table and this union
 * have drifted apart -- it is that, or it is malformed input, and the two are
 * told apart by whether anything else in the report moved.
 *
 * Refusing to name those spans after the message's own `name` field is the
 * whole point rather than a limitation: that field is an arbitrary string from
 * outside the host, bounded to 64 characters by the envelope schema and
 * otherwise unconstrained, and putting it in a span name is exactly the
 * `SEC-006` leak this vocabulary is closed to prevent. The measurement survives;
 * the attacker-supplied name does not.
 */
export type SpanName = TurnSpanName | `tool.${ToolLabel}` | `command.${CommandName}` | "unknown"

const UNKNOWN_SPAN_NAME = "unknown" satisfies SpanName

/**
 * `tool.read`, `command.prompt` and friends, built once at module load.
 *
 * Prebuilt rather than interpolated at the call site so that starting a tool
 * span allocates no string. Templating the name per call would be one small
 * allocation per tool call, which is affordable, but it would also hand the
 * aggregate map a fresh string to hash each time instead of the same interned
 * literal every time, and the point of this module is to cost as close to
 * nothing as it can.
 */
const TOOL_SPAN_NAMES: Readonly<Record<ToolLabel, SpanName>> = Object.freeze(
  Object.fromEntries(TOOL_LABELS.map((label) => [label, `tool.${label}`])) as Record<ToolLabel, SpanName>,
)

const COMMAND_SPAN_NAMES: Readonly<Record<CommandName, SpanName>> = Object.freeze(
  Object.fromEntries(COMMAND_NAMES.map((name) => [name, `command.${name}`])) as Record<CommandName, SpanName>,
)

/** Every span name in a fixed order, so the ring can store a `Uint16` index instead of a pointer. */
const SPAN_NAMES: readonly SpanName[] = Object.freeze([
  ...TURN_SPAN_NAMES,
  ...TOOL_LABELS.map((label) => TOOL_SPAN_NAMES[label]),
  ...COMMAND_NAMES.map((name) => COMMAND_SPAN_NAMES[name]),
  UNKNOWN_SPAN_NAME,
])

const SPAN_NAME_INDEX: ReadonlyMap<SpanName, number> = new Map(SPAN_NAMES.map((name, index) => [name, index]))

/** The index every unrecognised name folds onto: the last entry, `"unknown"`. */
const UNKNOWN_SPAN_INDEX = SPAN_NAMES.length - 1

/**
 * Narrows a tool name Pi reported onto the closed vocabulary above.
 *
 * This is the only function in the module that accepts an arbitrary string, and
 * it is total: everything it does not recognise becomes `"other"`. Callers must
 * go through it, which is why `beginTool` takes a `ToolLabel` and not a
 * `string`. Making the narrowing a separate, visible step is the point -- a
 * signature that took the raw name would put the security decision inside this
 * file where a future caller cannot see that it happened.
 */
export const toolLabel = (rawToolName: string): ToolLabel => {
  const found = TOOL_LABELS.find((label) => label === rawToolName)
  return found ?? "other"
}

/**
 * The bucket ladder, in milliseconds, and why it looks like this.
 *
 * Two boundaries per octave -- `2^k` and `1.5 * 2^k` -- from 0.5 ms to 65536 ms,
 * which is 35 boundaries and therefore 36 buckets counting the one below the
 * bottom and the one above the top. Consecutive boundaries are a factor of 1.5
 * or 1.333 apart, so a percentile answer is a range whose upper edge is at most
 * half again its lower edge.
 *
 * That range is the honest form of the answer, and it is why `percentileOf`
 * returns a pair rather than a number. Fixed buckets cost accuracy in exchange
 * for a fixed footprint: to report an exact p95 this module would have to retain
 * every sample, which is the unbounded growth the ring below exists to prevent.
 * What a bucketed p95 supports is "the 95th percentile turn took between 2048
 * and 3072 ms". What it does not support is "the 95th percentile turn took
 * 2412 ms", and the return type refuses to say that.
 *
 * The span is chosen for what is actually being timed. A command handler that
 * only reads the host's own state settles below the bottom boundary and lands in
 * the "under 0.5 ms" bucket, which is the right amount of detail for something
 * that is not the problem. A turn's first-delta leg is hundreds of milliseconds
 * to a few seconds -- the middle of the ladder, where the resolution is. A
 * `bash` tool can run for minutes and overflows the top, which the open-ended
 * top bucket says plainly rather than clamping into a plausible number.
 */
const BUCKET_BOUNDS_MS: readonly number[] = Object.freeze(
  ((): number[] => {
    const bounds: number[] = []
    for (let octave = -1; octave <= 16; octave += 1) {
      const base = 2 ** octave
      bounds.push(base)
      if (octave < 16) bounds.push(base * 1.5)
    }
    return bounds
  })(),
)

const BUCKET_COUNT = BUCKET_BOUNDS_MS.length + 1

/**
 * Which bucket a duration falls in: the number of boundaries at or below it.
 *
 * A linear scan of at most 35 numeric comparisons, deliberately not a binary
 * search or a logarithm. It runs once per settled turn, once per tool call and
 * once per command -- never per delta -- so it is a bounded constant against a
 * leg the caller is measuring in milliseconds, and a loop is the version a
 * reader can check against the ladder above without trusting a bit trick.
 */
const bucketOf = (ms: number): number => {
  let index = 0
  while (index < BUCKET_BOUNDS_MS.length && ms >= (BUCKET_BOUNDS_MS[index] ?? Number.POSITIVE_INFINITY)) {
    index += 1
  }
  return index
}

/**
 * A percentile, stated as the bucket it fell in rather than as a millisecond
 * figure the buckets cannot support.
 *
 * `belowMs` is `null` for the top bucket, which has no upper edge. A number
 * there would be a fabricated ceiling for a tool call that might have run for an
 * hour.
 */
export interface BucketedPercentile {
  atLeastMs: number
  belowMs: number | null
}

const percentileOf = (buckets: Uint32Array, count: number, quantile: number): BucketedPercentile | null => {
  if (count === 0) return null
  // Ceil rather than floor, which also removes the need for a lower clamp: for
  // any positive quantile over at least one sample the product is above zero, so
  // the rank is at least one and the scan below cannot return the empty bottom
  // bucket. Floor would put the p50 of three samples at the first of them.
  const targetRank = Math.ceil(quantile * count)
  let seen = 0
  for (let index = 0; index < BUCKET_COUNT; index += 1) {
    seen += buckets[index] ?? 0
    if (seen >= targetRank) {
      // Both edges fall out of the ladder by index, and both ends of it are the
      // absent neighbour rather than a special case: the bottom bucket has no
      // boundary beneath it, so its floor is zero, and the top bucket has none
      // above it, so its ceiling is `null`.
      return { atLeastMs: BUCKET_BOUNDS_MS[index - 1] ?? 0, belowMs: BUCKET_BOUNDS_MS[index] ?? null }
    }
  }
  // Unreachable while the bucket counts sum to `count`, which `#record` keeps
  // true by incrementing both together. It returns the open-ended top bucket
  // rather than throwing, because a reporting path must not be able to take down
  // the host it is reporting on.
  return { atLeastMs: BUCKET_BOUNDS_MS[BUCKET_BOUNDS_MS.length - 1] ?? 0, belowMs: null }
}

/**
 * What survives eviction from the ring: everything except the individual
 * durations.
 *
 * The ring remembers recent history exactly and forgets it in order; these
 * counters remember all of history approximately and never forget. Both are
 * needed. Without the ring, "how long did the turn I just watched take" is
 * unanswerable; without these, an hour-old pathology is gone as if it never
 * happened.
 */
interface Aggregate {
  count: number
  abandoned: number
  totalMs: number
  maxMs: number
  buckets: Uint32Array
}

/**
 * One session's entry in the bounded table, and the two fields beyond its
 * aggregates are both about eviction.
 *
 * `index` is what the ring stores instead of the id: one `Uint16` per slot
 * rather than a string pointer. `closed` is set by `closeSession` and cleared
 * whenever the session records again -- a reopened session keeps the id it had,
 * so `adoptSession` bringing one back finds its own history rather than a fresh
 * empty entry.
 */
interface SessionEntry {
  readonly index: number
  readonly sessionId: SessionId
  closed: boolean
  readonly turns: Map<TurnSpanName, Aggregate>
}

/**
 * One completed span.
 *
 * Three fields at most, and the third is present only on a turn leg. A tool
 * span and a command span have no session dimension, so `sessionId` is absent
 * from them entirely rather than present and null -- which keeps the two-field
 * guarantee those spans have always had, and keeps four thousand nulls off the
 * wire in a report that is mostly tool and command spans.
 *
 * It is also absent on a turn leg whose session has since been evicted from the
 * store's table. The duration is still a measurement; it just no longer says
 * whose, and `cost.sessionsForgotten` is what distinguishes that from a wiring
 * fault.
 */
export interface Span {
  name: SpanName
  ms: number
  sessionId?: SessionId
}

/**
 * Per-name totals as they leave this module.
 *
 * `meanMs` and the three percentiles are `null` when `count` is zero, which
 * happens for a name that has only ever been abandoned. Zero would read as "this
 * is instant"; `null` reads as "there is no measurement here", which is what is
 * true. `totalMs` and `maxMs` are 0 in that case for the arithmetic reason that
 * nothing was summed into them, and `count` is sitting right there to say so.
 */
export interface SpanAggregate<TName extends SpanName = SpanName> {
  name: TName
  count: number
  abandoned: number
  totalMs: number
  maxMs: number
  meanMs: number | null
  p50: BucketedPercentile | null
  p95: BucketedPercentile | null
  p99: BucketedPercentile | null
}

/**
 * What the instrument costs, exposed so that "this is cheap" is a measurement a
 * test makes rather than an assertion this comment makes.
 *
 * `clockReads` is the one that matters for the streaming path: it counts every
 * call to the injected clock, so a test can assert that a thousand block deltas
 * on one turn read the clock exactly once.
 *
 * `ringBytes` and `bucketBytes` are the two allocations that could in principle
 * grow with what has been recorded, and they are reported so a test can show
 * that neither does. `bucketBytes` counts the per-session bucket arrays as well
 * as the host-wide ones, so the session dimension's cost is in the same figure
 * rather than in one nobody is looking at. They are not the module's total
 * footprint: the three `Map`s, their entries, and the open-span objects are not
 * counted, and no claim is made about them here beyond their being bounded by
 * `maxOpenSpans`, `maxTrackedSessions`, and the closed span-name vocabulary.
 * `ringBytes` is read from the buffers' own `byteLength` rather than computed
 * from the capacity, so it cannot report a size the allocation does not have.
 *
 * `trackedSessions` and `sessionsForgotten` are the pair that says whether the
 * session table is doing its job: a host that has forgotten nothing has a
 * complete per-session history, and one that has forgotten a great deal is
 * opening and closing sessions faster than anyone is reading about them.
 */
export interface TimingCost {
  clockReads: number
  spansRecorded: number
  spansAbandoned: number
  ringCapacity: number
  ringBytes: number
  bucketBytes: number
  openSpans: number
  maxOpenSpans: number
  trackedSessions: number
  maxTrackedSessions: number
  sessionsForgotten: number
}

/** How many spans are in flight, by the name each would be recorded under. Never keys. */
export interface OpenSpanCount {
  name: SpanName
  count: number
}

/**
 * One session's turns, which is the whole of what a session dimension buys.
 *
 * `turns` is typed to `TurnSpanName` rather than `SpanName` because the
 * narrowing is the design decision, not a convenience: tool spans and command
 * spans stay host-wide, and this type is where a future edit that wanted to put
 * `tool.bash` under a session would have to argue for it. `turns` is empty for a
 * session whose first turn has been accepted and has not settled yet, which is
 * how a session appears in the report before it has produced a measurement.
 */
export interface SessionTimings {
  sessionId: SessionId
  turns: readonly SpanAggregate<TurnSpanName>[]
}

/**
 * The whole report, shaped so that `JSON.stringify` is the entire serialisation
 * step: numbers, strings drawn from a closed vocabulary or bounded by the
 * `SessionId` DTO, arrays, plain objects. No `Map`, no `Set`, no typed array, no
 * `undefined`, no class instance.
 */
export interface TimingsSnapshot {
  /** Completed spans, oldest first, up to the ring's capacity. */
  recent: readonly Span[]
  /** Per-name totals across the host, including names whose individual spans have been evicted. */
  aggregates: readonly SpanAggregate[]
  /**
   * The turn legs again, per session, in eviction order -- least recently
   * recorded first, so the entry at the front is the one that will be forgotten
   * next. That order carries information a sort by id would throw away.
   */
  sessions: readonly SessionTimings[]
  open: readonly OpenSpanCount[]
  cost: TimingCost
}

/**
 * How many completed spans the ring remembers, and what that buys in minutes.
 *
 * The unit to reason in is a settled turn. A session in an agentic loop settles
 * a turn somewhere between every ten and every thirty seconds, and a settled
 * turn records three turn legs, one span per tool call it made -- Pi runs a
 * session's tools one at a time and a working turn makes on the order of five --
 * and one span per command the renderer sent through the host while it ran. Call
 * that twenty spans per turn. Two or three sessions a person is actually
 * watching, each settling six turns a minute, is roughly 250 spans a minute; a
 * host driving sessions harder than anyone is reading them might reach twice
 * that.
 *
 * 4096 spans is therefore about a quarter of an hour of recent history at 250
 * spans a minute and about eight minutes at 500, and hours of an idle host. That
 * is the property worth stating: a turn someone noticed was slow is still in the
 * ring by the time they open the report and go looking for it. A ring that
 * remembered four seconds would only ever describe the turn that was running
 * while the report was requested.
 *
 * The cost is fixed and small, because the ring stores no objects: a `Uint16`
 * name index, a `Float64` duration and a `Uint16` session-table index per slot,
 * so 4096 * 12 = 49152 bytes, allocated once at construction and never grown.
 * The session column is what the third of those bought and it is worth pricing
 * separately: 8192 bytes, a fifth again on top of the ring, in exchange for
 * `recent` being readable when two sessions are streaming at once -- without it
 * the ring interleaves their turns into a list that cannot be decomposed. A
 * `SessionId` per slot instead of an index would have put four thousand string
 * pointers in the ring and made its footprint an estimate about V8 rather than a
 * number, which is the property this design refuses to give up. Against the 256 MB
 * `SESSION_MEMORY_BUDGET_BYTES` in `session/budget.ts` that is under two
 * hundredths of one percent, which is the standard this had to meet: an
 * instrument that eats into the ceiling it is meant to help explain would be
 * self-defeating. `TimingCost.ringBytes` reports the figure from the allocated
 * buffers' own `byteLength`, so it cannot drift from the allocation.
 */
export const DEFAULT_RING_CAPACITY = 4096

/**
 * How many spans may be open at once before the oldest is abandoned.
 *
 * A bound is required because an open span is a map entry that only a matching
 * `end*` call removes, and the calls that would remove one are exactly the calls
 * a crash, an abort, or a thrown handler skips. Unbounded, the open map is the
 * one part of this module that a long session could grow without limit -- which
 * would undermine the memory ceiling in `session/budget.ts` that this module
 * exists to help diagnose.
 *
 * The bound is a count and not an age. An age sweep needs a threshold for how
 * long a span may legitimately stay open, and there is no such number here: a
 * `bash` tool may correctly run for an hour, and a sweep would silently delete
 * that measurement and then record nothing when it finished. A count instead
 * discards only when more spans are open simultaneously than the host can
 * legitimately have work in flight: `MAX_OPEN_SESSIONS` is 32, Pi runs one turn
 * and one tool at a time per session, and main has at most a few commands in
 * flight per session, so a legitimate ceiling is on the order of a hundred. 256
 * sits above that and still bounds the map at a few tens of kilobytes.
 *
 * An abandonment is counted against the name the span would have been recorded
 * under, so a leak surfaces as a growing `abandoned` figure in the report rather
 * than as memory that nobody attributes to anything.
 */
export const DEFAULT_MAX_OPEN_SPANS = 256

/**
 * How many sessions the store keeps turn figures for, and why sixty-four.
 *
 * A bound is required for a reason the open-span cap does not cover. At most
 * `MAX_OPEN_SESSIONS` sessions exist at once, but session ids are unbounded over
 * time: a host left running all day opens and closes hundreds, and a table keyed
 * on the id would accumulate an aggregate for every one of them forever. That is
 * the same unbounded growth the ring exists to prevent, arriving through a
 * different door.
 *
 * Sixty-four is `2 * MAX_OPEN_SESSIONS`, and the factor is the point. Half the
 * table is enough for every session the host is allowed to have open at once, so
 * the sessions a person is actually watching can never be evicted by each other.
 * The other half is history for sessions that have closed, which is what makes a
 * report taken *after* a slow conversation ended still able to name it. A cap of
 * exactly 32 would have made every eviction a live session losing its figures to
 * a newly opened one.
 *
 * The arithmetic on cost. A tracked session holds at most three `Aggregate`s --
 * one per turn leg, created on first use -- and an `Aggregate`'s bucket array is
 * `BUCKET_COUNT * 4` = 144 bytes. So 64 * 3 * 144 = 27648 bytes of buckets, plus
 * four numbers and a map entry per aggregate and one map entry and one id string
 * per session: on the order of 100 KB in total, against the 256 MB
 * `SESSION_MEMORY_BUDGET_BYTES` in `session/budget.ts`. That is four hundredths
 * of one percent, which is the same standard the ring had to meet.
 *
 * The eviction policy is in `#forgetOneSession`, and it is not plain LRU: a
 * session the host has told the store about through `closeSession` goes first,
 * however recently it ran, because its figures can no longer change and a live
 * session's still can.
 */
export const DEFAULT_MAX_TRACKED_SESSIONS = 64

/**
 * The ring's session column reads zero for "not attributed", which is also what
 * a freshly allocated `Uint16Array` reads as -- so an untouched slot and a tool
 * span mean the same thing without anyone writing the sentinel. Real table
 * indices therefore start at one.
 */
const NO_SESSION_INDEX = 0

export interface TimingStoreOptions {
  clock?: Clock
  capacity?: number
  maxOpenSpans?: number
  /** Zero turns session attribution off entirely, which is a configuration rather than a degenerate case. */
  maxTrackedSessions?: number
}

/**
 * A turn in flight, from the caller's side.
 *
 * Deliberately a handle rather than a key lookup. The delta path has to be as
 * close to free as it can be, and `Map.get` on a session id -- hashing a string,
 * probing a table -- is more work than the whole rest of the operation. Holding
 * the handle turns the steady state into one property read and one comparison.
 * The handle exposes nothing but that one method: the caller cannot read a start
 * instant off it, which is the same no-cross-process-timestamp rule applied to
 * this module's own API.
 */
export interface TurnTiming {
  /**
   * Records this turn's first block delta. Every call after the first returns
   * immediately without reading the clock.
   */
  noteFirstDelta(): void
}

class OpenSpan implements TurnTiming {
  firstDeltaAt: number | undefined = undefined
  closed = false

  constructor(
    /**
     * Mutable for exactly one caller: `nameCommand`, which supplies a command
     * span's name after the envelope it came in has been validated. Everything
     * else sets this once at `#begin` and never again -- a turn's span in
     * particular, which is why `#abandon` can still file a turn's abandonment
     * under `TURN_TOTAL_SPAN_NAME` without a cast: `nameCommand` reaches only
     * spans opened under the `"command"` key namespace, and there is no path
     * from it to a turn's or a tool's span.
     */
    public name: SpanName,
    readonly startedAt: number,
    private readonly tick: Clock,
    /**
     * The session this span will be attributed to, held as the id rather than
     * as a table index.
     *
     * That choice is what makes eviction unable to corrupt a measurement. An
     * index captured when the turn began could be freed and handed to a
     * different session before the turn settles, and the settle would then land
     * in the wrong session's figures. Holding the id means the table is
     * consulted at settle time, so the worst eviction can do is lose the
     * session's earlier history -- the turn itself is still recorded against
     * the session that ran it. Storing the id costs nothing: it is a reference
     * to a string the caller already had, on an object that was already being
     * allocated, and `noteFirstDelta` never touches it.
     *
     * `undefined` for tool and command spans, which have no session dimension.
     */
    readonly sessionId: SessionId | undefined,
  ) {}

  /**
   * The hot path, and the reason the two guards are in this order.
   *
   * A streaming turn calls this once per block delta, hundreds of times. After
   * the first call `firstDeltaAt` is set, so the first comparison short-circuits
   * and the method is a property read and a compare against `undefined` -- no
   * clock read, no allocation, no map lookup, no branch on a second field. The
   * `closed` guard is second because it only matters for a stale handle the
   * caller kept past `endTurn`, which is a mistake rather than a hot path, and
   * putting it first would put its cost on every delta.
   */
  noteFirstDelta(): void {
    if (this.firstDeltaAt !== undefined) return
    if (this.closed) return
    this.firstDeltaAt = this.tick()
  }
}

/**
 * Microsecond resolution in the report, matching `readStartupTimings`.
 *
 * Rounding happens here, at the edge, and never on the way in: the aggregates
 * sum raw readings, so a thousand spans do not accumulate a thousand rounding
 * errors into their mean.
 */
const roundMs = (ms: number): number => Math.round(ms * 1000) / 1000

const byName = (left: { name: SpanName }, right: { name: SpanName }): number =>
  left.name < right.name ? -1 : left.name > right.name ? 1 : 0

const newAggregate = (): Aggregate => ({
  count: 0,
  abandoned: 0,
  totalMs: 0,
  maxMs: 0,
  buckets: new Uint32Array(BUCKET_COUNT),
})

/**
 * Finds or creates one name's aggregate inside a map of them.
 *
 * Generic over the key so the host-wide table (`SpanName`) and a session's turn
 * table (`TurnSpanName`) share one implementation without the narrower of the
 * two widening to the other. Lazy creation is the property that matters: a
 * report lists what actually happened instead of every possible zero row, and a
 * session that only ever settled turns never allocates buckets for the leg it
 * never had.
 */
const aggregateIn = <TName extends SpanName>(into: Map<TName, Aggregate>, name: TName): Aggregate => {
  const existing = into.get(name)
  if (existing !== undefined) return existing
  const created = newAggregate()
  into.set(name, created)
  return created
}

/**
 * Adds one duration to one aggregate.
 *
 * Free-standing so the host-wide and per-session tallies are provably the same
 * arithmetic rather than two copies that could drift -- the failure that would
 * produce is a per-session mean that quietly disagrees with the host-wide one
 * and no way to tell which is wrong.
 */
const tally = (aggregate: Aggregate, ms: number): void => {
  aggregate.count += 1
  aggregate.totalMs += ms
  if (aggregate.count === 1 || ms > aggregate.maxMs) aggregate.maxMs = ms
  const bucket = bucketOf(ms)
  aggregate.buckets[bucket] = (aggregate.buckets[bucket] ?? 0) + 1
}

/**
 * Turn, tool and command spans for one agent host.
 *
 * Nothing in here is thread-safe or reentrancy-safe, and nothing needs to be:
 * the host is one JavaScript thread and every method returns before yielding.
 */
export class TimingStore {
  readonly #clock: Clock
  readonly #capacity: number
  readonly #maxOpenSpans: number
  readonly #maxTrackedSessions: number

  /**
   * The ring, as three parallel typed arrays rather than an array of objects.
   *
   * A `{ name, ms, sessionId }` object per span would allocate on a path that
   * runs whenever a turn settles, and would make the ring's footprint an
   * estimate about V8's object layout instead of a number. Typed arrays make
   * recording three indexed writes with no allocation at all, and make the
   * footprint exactly `capacity * 12` bytes. The name is stored as its index
   * into `SPAN_NAMES`, which is why that table is built eagerly and never
   * appended to; the session is stored as its index into `#sessions`, which is
   * why an eviction has to sweep this column -- see `#forgetOneSession`.
   */
  readonly #ringNames: Uint16Array
  readonly #ringDurations: Float64Array
  readonly #ringSessions: Uint16Array
  #ringNext = 0
  #ringFilled = 0

  readonly #aggregates = new Map<SpanName, Aggregate>()

  /**
   * Per-session turn figures, in insertion order, which is what makes eviction
   * order a `Map` iteration rather than a sort. A session is moved to the back
   * every time it records, so the front of this map is the least recently active
   * session -- see `#sessionEntryFor`.
   */
  readonly #sessions = new Map<SessionId, SessionEntry>()

  /**
   * Table indices freed by eviction, so the ring's `Uint16` column stays within
   * `1..maxTrackedSessions` instead of climbing with every session the host has
   * ever seen. Without this a long-lived host would eventually mint an index a
   * `Uint16` cannot hold, and the ring would start attributing turns to the
   * wrong session by silent truncation.
   */
  readonly #freeSessionIndexes: number[] = []
  #nextSessionIndex = NO_SESSION_INDEX + 1
  #sessionsForgotten = 0

  /**
   * Open spans, in insertion order, which is what makes "evict the oldest" a
   * `Map` iteration rather than a sort. Keys are namespaced by kind (see
   * `#openKey`) so a tool call id can never close a turn.
   */
  readonly #open = new Map<string, OpenSpan>()

  #clockReads = 0
  #spansRecorded = 0
  #spansAbandoned = 0

  /** Bound once so an `OpenSpan` counts its own clock reads against this store. */
  readonly #tick: Clock = () => {
    this.#clockReads += 1
    return this.#clock()
  }

  constructor(options: TimingStoreOptions = {}) {
    this.#clock = options.clock ?? ((): number => performance.now())
    this.#capacity = options.capacity ?? DEFAULT_RING_CAPACITY
    this.#maxOpenSpans = options.maxOpenSpans ?? DEFAULT_MAX_OPEN_SPANS
    this.#maxTrackedSessions = options.maxTrackedSessions ?? DEFAULT_MAX_TRACKED_SESSIONS
    this.#ringNames = new Uint16Array(this.#capacity)
    this.#ringDurations = new Float64Array(this.#capacity)
    this.#ringSessions = new Uint16Array(this.#capacity)
  }

  /**
   * Prompt accepted. Returns the handle the streaming path holds.
   *
   * Beginning a turn on a key that already has one open replaces it and counts
   * the displaced turn as abandoned. That is the queued-prompt case: if a second
   * prompt was accepted for a session whose previous turn never settled, the new
   * turn's start is the one that will match the settle that eventually arrives,
   * and keeping the old start would report a duration spanning two turns.
   */
  beginTurn(sessionId: SessionId): TurnTiming {
    // Interned here as well as at settle, so a session with a turn in flight is
    // already in the report -- with an empty `turns` array -- rather than
    // appearing only once its first turn finishes. On a host where every turn is
    // slow, "which sessions are mid-turn" is a question the report should answer
    // before any of them settles.
    this.#sessionEntryFor(sessionId)
    return this.#begin(this.#openKey("turn", sessionId), TURN_TOTAL_SPAN_NAME, sessionId)
  }

  /**
   * Turn settled. Records the total, and the two legs if a delta was seen.
   *
   * One clock read for up to three spans, because all three end at the same
   * instant and taking three readings would make the legs fail to sum to the
   * total by the cost of taking them.
   *
   * Settling a key with no turn open is a no-op that does not read the clock --
   * the turn was abandoned, or this is a second settle for the same prompt, and
   * either way there is no start to measure from, so inventing one would put a
   * fictitious duration into the aggregates.
   */
  endTurn(sessionId: SessionId): void {
    const openKey = this.#openKey("turn", sessionId)
    const span = this.#open.get(openKey)
    if (span === undefined) return
    this.#open.delete(openKey)
    span.closed = true
    const settledAt = this.#tick()
    // Resolved once for all three legs, and resolved *now* rather than when the
    // turn began: the table may have evicted this session while the turn ran, in
    // which case this re-admits it with a fresh index and the turn is still
    // attributed correctly. What is lost is the session's earlier history, which
    // eviction had already decided to lose.
    const session = this.#sessionEntryFor(sessionId)
    // Legs before the total, so the ring reads in the order the turn happened
    // and the total lands next to the two figures that sum to it.
    if (span.firstDeltaAt !== undefined) {
      this.#recordTurn("turn.accepted_to_first_delta", span.firstDeltaAt - span.startedAt, session)
      this.#recordTurn("turn.first_delta_to_settled", settledAt - span.firstDeltaAt, session)
    }
    this.#recordTurn(TURN_TOTAL_SPAN_NAME, settledAt - span.startedAt, session)
  }

  /**
   * The session is going away: closed by the renderer, dropped with its
   * workspace, or disposed by `shutdown`.
   *
   * Two things happen here, and the first is the one that had to be decided
   * rather than written. A session closed mid-turn has a turn span that no
   * `agent_settled` will ever close, because the subscription that would have
   * delivered it went away with the Pi session. Left alone the span sits in the
   * open map until the open-span cap evicts it, which attributes the
   * abandonment to whatever session happens to be running much later.
   *
   * The turn is therefore abandoned here, explicitly, and *not* recorded.
   * Measuring accept-to-close and filing it as a turn duration would be a lie:
   * the turn did not take that long, it did not finish at all, and a report full
   * of fast "turns" that are really closes is worse than no attribution. An
   * abandonment against `turn.accepted_to_settled` -- host-wide and in the
   * session's own table -- says exactly what happened and nothing more.
   *
   * What this cannot reach is a tool span that was running when the session
   * closed. Tool spans are keyed on Pi's tool call id, which the store has no
   * way to relate back to a session, so one of those still waits for the
   * open-span cap. That is a known and bounded leak of one span per session
   * closed mid-tool, and naming it here is better than a comment claiming this
   * method cleans up everything.
   *
   * The session's figures are kept. A report asked for right after a slow
   * conversation ended is exactly when someone wants to read it; the entry is
   * marked closed instead, which is what moves it to the front of the eviction
   * queue in `#forgetOneSession`.
   */
  closeSession(sessionId: SessionId): void {
    const openKey = this.#openKey("turn", sessionId)
    const span = this.#open.get(openKey)
    if (span !== undefined) {
      this.#open.delete(openKey)
      span.closed = true
      this.#abandon(span)
    }
    // After the abandonment, never before: `#abandon` interns the session, and
    // interning is also what clears `closed` for a session that has come back.
    const entry = this.#sessions.get(sessionId)
    if (entry !== undefined) entry.closed = true
  }

  /**
   * A tool call starts. `label` is a `ToolLabel`, not a tool name: callers pass
   * Pi's raw name through `toolLabel` first, and that narrowing is the reason no
   * argument here can carry a path or an argument value.
   */
  beginTool(key: SpanKey, label: ToolLabel): void {
    this.#begin(this.#openKey("tool", key), TOOL_SPAN_NAMES[label])
  }

  endTool(key: SpanKey): void {
    this.#end(this.#openKey("tool", key))
  }

  /**
   * A command arrived, and which command it is is not known yet.
   *
   * The two-call shape -- begin, then name -- exists because of an ordering the
   * host cannot change. The clock has to start before `acceptCommand`, since
   * the size guard and the envelope and params checks are real host work and an
   * enormous or malformed payload is the case where they stop being negligible:
   * a span that started after them would report the cheapest part of the leg
   * and hide the expensive one. But the name comes *from* the command, and
   * there is no command until those same checks have passed. Something has to
   * give, and what gives is the name: the span opens as `"unknown"` and is
   * named a moment later, so a message that never validates is measured under
   * `"unknown"` rather than not measured at all.
   *
   * The alternative -- taking the name at `endCommand` and leaving the span
   * anonymous while it runs -- was rejected for what it costs the `open` list.
   * That list is how a stuck command is found, and "one command has been open
   * for a minute" without saying which command is most of the way to useless.
   * Under this shape a span is anonymous only for the synchronous stretch
   * between arrival and validation, which contains no `await` and therefore no
   * moment at which a report can observe it.
   */
  beginCommand(key: SpanKey): void {
    this.#begin(this.#openKey("command", key), UNKNOWN_SPAN_NAME)
  }

  /**
   * The envelope validated: this is which command it was.
   *
   * Naming a key with no command span open is a no-op rather than an error,
   * for the same reason `endCommand` is: the span may have been evicted by the
   * open-span cap while the caller held the key, and a reporting path must not
   * be able to take down the host it reports on.
   */
  nameCommand(key: SpanKey, command: CommandName): void {
    const span = this.#open.get(this.#openKey("command", key))
    if (span !== undefined) span.name = COMMAND_SPAN_NAMES[command]
  }

  endCommand(key: SpanKey): void {
    this.#end(this.#openKey("command", key))
  }

  /**
   * The report, materialised on demand.
   *
   * This is the only method here that allocates in proportion to what has been
   * recorded, and it is the only one that is not on any path being measured: it
   * runs when a developer asks `get_timings`, not when a turn streams.
   * Everything it returns is a fresh plain object, so a caller holding a
   * snapshot cannot see the store change underneath it and cannot reach into the
   * store's own state.
   */
  snapshot(): TimingsSnapshot {
    let sessionBuckets = 0
    for (const entry of this.#sessions.values()) sessionBuckets += entry.turns.size
    return {
      recent: this.#readRing(),
      aggregates: [...this.#aggregates.entries()]
        .map(([name, aggregate]) => this.#readAggregate(name, aggregate))
        .sort(byName),
      // Map order, which is eviction order, and not sorted: a sort by id would
      // replace information with alphabetical noise.
      sessions: [...this.#sessions.values()].map((entry) => ({
        sessionId: entry.sessionId,
        turns: [...entry.turns.entries()].map(([name, aggregate]) => this.#readAggregate(name, aggregate)).sort(byName),
      })),
      open: this.#readOpen(),
      cost: {
        clockReads: this.#clockReads,
        spansRecorded: this.#spansRecorded,
        spansAbandoned: this.#spansAbandoned,
        ringCapacity: this.#capacity,
        ringBytes: this.#ringNames.byteLength + this.#ringDurations.byteLength + this.#ringSessions.byteLength,
        // Host-wide and per-session buckets in one figure, so the session
        // dimension's cost is in the number a test is already watching.
        bucketBytes: (this.#aggregates.size + sessionBuckets) * BUCKET_COUNT * Uint32Array.BYTES_PER_ELEMENT,
        openSpans: this.#open.size,
        maxOpenSpans: this.#maxOpenSpans,
        trackedSessions: this.#sessions.size,
        maxTrackedSessions: this.#maxTrackedSessions,
        sessionsForgotten: this.#sessionsForgotten,
      },
    }
  }

  /**
   * Namespaces a caller's key by the kind of span it opens.
   *
   * Turn keys are session ids, tool keys are tool call ids and command keys are
   * request ids; those three id spaces are minted by three different owners and
   * nothing guarantees they do not collide. Without the prefix a tool call whose
   * id happened to equal a session id would close that session's turn and record
   * a turn duration that actually measured a tool. One string concatenation per
   * `begin` and per `end` is the price, and neither runs per delta.
   */
  #openKey(kind: "turn" | "tool" | "command", key: SpanKey): string {
    return `${kind}:${key}`
  }

  #begin(openKey: string, name: SpanName, sessionId?: SessionId): OpenSpan {
    const displaced = this.#open.get(openKey)
    if (displaced !== undefined) {
      displaced.closed = true
      this.#abandon(displaced)
      this.#open.delete(openKey)
    }
    this.#evictOldestOpenIfFull()
    const span = new OpenSpan(name, this.#tick(), this.#tick, sessionId)
    this.#open.set(openKey, span)
    return span
  }

  #end(openKey: string): void {
    const span = this.#open.get(openKey)
    if (span === undefined) return
    this.#open.delete(openKey)
    span.closed = true
    // Tool and command spans only; a turn goes through `endTurn`, which is the
    // one path that resolves a session.
    this.#record(span.name, this.#tick() - span.startedAt, undefined)
  }

  /**
   * Makes room for one more open span by dropping the oldest.
   *
   * `Map` iterates in insertion order, so the first entry is the span that has
   * been open longest, which is the one most likely to be the leak. It is
   * dropped rather than recorded: its duration is unknown -- it may still be
   * running -- and a span whose end never happened is not a measurement.
   */
  #evictOldestOpenIfFull(): void {
    if (this.#open.size < this.#maxOpenSpans) return
    const oldest = this.#open.entries().next()
    if (oldest.done === true) return
    const [oldestKey, oldestSpan] = oldest.value
    oldestSpan.closed = true
    this.#abandon(oldestSpan)
    this.#open.delete(oldestKey)
  }

  /**
   * A span that began and will never end, counted against the name it would
   * have been recorded under -- and, for a turn, against its session too.
   *
   * The per-session half is what makes "this session was closed mid-turn"
   * legible in the report. It is filed under `TURN_TOTAL_SPAN_NAME` because that
   * is the only name a turn's open span can carry, which is why that constant
   * exists: it lets this method reach a `Map<TurnSpanName, Aggregate>` without a
   * cast from `SpanName`.
   */
  #abandon(span: OpenSpan): void {
    this.#spansAbandoned += 1
    this.#aggregateFor(span.name).abandoned += 1
    if (span.sessionId === undefined) return
    const entry = this.#sessionEntryFor(span.sessionId)
    if (entry === undefined) return
    aggregateIn(entry.turns, TURN_TOTAL_SPAN_NAME).abandoned += 1
  }

  /**
   * Files one completed duration in both the ring and the aggregate.
   *
   * Negative durations are recorded as they are rather than clamped to zero.
   * Every duration here is a difference of two readings of one monotonic clock
   * in one process, so a negative one means an assumption in this file is wrong
   * -- an instant recorded out of order, or a handle reused across turns -- and
   * that should be visible in the report rather than rounded into a plausible
   * small number. This is the same reasoning `readStartupTimings` applies to its
   * `hostLaunch` leg.
   */
  #record(name: SpanName, ms: number, session: SessionEntry | undefined): void {
    const slot = this.#ringNext
    this.#ringNames[slot] = SPAN_NAME_INDEX.get(name) ?? UNKNOWN_SPAN_INDEX
    this.#ringDurations[slot] = ms
    this.#ringSessions[slot] = session?.index ?? NO_SESSION_INDEX
    this.#ringNext = slot + 1 === this.#capacity ? 0 : slot + 1
    if (this.#ringFilled < this.#capacity) this.#ringFilled += 1

    tally(this.#aggregateFor(name), ms)
    this.#spansRecorded += 1
  }

  /**
   * A turn leg, which is the only kind of span with a session dimension, filed
   * once host-wide and once against the session that produced it.
   *
   * The line is drawn here rather than anywhere else, so here is where it is
   * argued. A turn is the unit whose cost provably depends on which session it
   * ran on: `scripts/budgets.ts` measured a turn getting roughly three times
   * more expensive over forty turns of accumulated history, so two sessions of
   * different depths produce systematically different turn durations and a
   * host-wide mean over them describes neither.
   *
   * A tool call has no such dependence. `bash` takes as long as the command
   * takes, `read` as long as the file needs, and neither is a function of how
   * many turns the session has behind it -- so per-session tool figures would
   * split one honest population into thirty-two small noisy ones and answer no
   * question the host-wide figures do not answer better. A command handler is
   * the same case and more so: a third of them do not name a session at all.
   *
   * Cost argues the same way. Three names against sixty-four sessions is a
   * bounded table; the whole span vocabulary against sixty-four sessions is over
   * eighteen times the buckets, for figures nobody would read.
   */
  #recordTurn(name: TurnSpanName, ms: number, session: SessionEntry | undefined): void {
    this.#record(name, ms, session)
    if (session === undefined) return
    tally(aggregateIn(session.turns, name), ms)
  }

  /**
   * Aggregates are created on first use rather than pre-allocated for every span
   * name, so a report lists what actually happened instead of dozens of zero
   * rows, and a host that never runs a tool never allocates its buckets.
   */
  #aggregateFor(name: SpanName): Aggregate {
    return aggregateIn(this.#aggregates, name)
  }

  /**
   * This session's entry in the bounded table, admitting it if it is new.
   *
   * Also the recency touch: an existing entry is deleted and re-inserted so that
   * `Map` iteration order stays "least recently active first", which is what
   * makes eviction a walk rather than a sort. Two map operations per settled
   * turn, on a path that already took a clock reading and filed six aggregates.
   *
   * Re-inserting also clears `closed`, which is how a session that was closed
   * and reopened -- `adoptSession` brings one back under the same id -- gets its
   * history back rather than a fresh empty entry beside the old one.
   *
   * Returns `undefined` in two cases, and both are deliberate rather than
   * defensive. A store configured with no session slots is a store with
   * attribution turned off. An id longer than the contract\'s `SessionId` bound
   * is not attributed at all, because putting it in the report would produce a
   * payload the renderer\'s own schema check drops on arrival -- silently, and in
   * its entirety.
   */
  #sessionEntryFor(sessionId: SessionId): SessionEntry | undefined {
    if (this.#maxTrackedSessions <= 0) return undefined
    if (sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_LENGTH) return undefined
    const existing = this.#sessions.get(sessionId)
    if (existing !== undefined) {
      this.#sessions.delete(sessionId)
      existing.closed = false
      this.#sessions.set(sessionId, existing)
      return existing
    }
    if (this.#sessions.size >= this.#maxTrackedSessions) this.#forgetOneSession()
    // Safe by arithmetic rather than by luck: every index ever minted is either
    // in `#sessions` or on the free list, and the line above keeps the first of
    // those below the cap -- so an index taken from the counter is at most
    // `maxTrackedSessions`, which is what keeps the ring\'s `Uint16` column
    // honest.
    const index = this.#freeSessionIndexes.pop() ?? this.#nextSessionIndex++
    const created: SessionEntry = { index, sessionId, closed: false, turns: new Map() }
    this.#sessions.set(sessionId, created)
    return created
  }

  /**
   * Drops one session from the table, choosing the one whose figures are worth
   * least.
   *
   * Closed sessions first, oldest closed first, and only then the least recently
   * active session still running. Plain LRU would have been the obvious answer
   * and is the wrong one for this shape: a live session that has been idle for
   * ten minutes is still a session someone may prompt again and want figures
   * for, while a closed one can never record anything else. The scan is over at
   * most `maxTrackedSessions` entries and runs only when a session the store has
   * never seen arrives at a full table, which on a real host is a few times an
   * hour.
   *
   * The ring sweep is the part that is easy to leave out and expensive to leave
   * out. The freed index will be handed to some other session, and every ring
   * slot still carrying it would then read back as that session\'s turn -- the
   * exact cross-contamination the whole session dimension exists to prevent. So
   * those slots drop their attribution and keep their duration, which is true:
   * the turn happened, and the store no longer knows whose it was.
   */
  #forgetOneSession(): void {
    let victim: SessionEntry | undefined
    for (const entry of this.#sessions.values()) {
      victim ??= entry
      if (entry.closed) {
        victim = entry
        break
      }
    }
    if (victim === undefined) return
    this.#sessions.delete(victim.sessionId)
    this.#freeSessionIndexes.push(victim.index)
    for (let slot = 0; slot < this.#capacity; slot += 1) {
      if (this.#ringSessions[slot] === victim.index) this.#ringSessions[slot] = NO_SESSION_INDEX
    }
    this.#sessionsForgotten += 1
  }

  /**
   * Oldest first, which is the order a reader follows a session in.
   *
   * The index-to-id lookup is built once for the whole read rather than
   * consulted per slot: sixty-four map entries against four thousand ring slots
   * is a quarter of a million string comparisons done the other way, on a method
   * that is already the most expensive one here.
   *
   * `sessionId` is omitted rather than set to `undefined`, so a tool span and a
   * command span still have exactly the two fields they always had -- which is
   * the property `timings.test.ts` asserts by listing `Object.keys`.
   */
  #readRing(): Span[] {
    const idByIndex: (SessionId | undefined)[] = []
    for (const entry of this.#sessions.values()) idByIndex[entry.index] = entry.sessionId

    const spans: Span[] = []
    const start = this.#ringFilled < this.#capacity ? 0 : this.#ringNext
    for (let offset = 0; offset < this.#ringFilled; offset += 1) {
      const slot = (start + offset) % this.#capacity
      const nameIndex = this.#ringNames[slot] ?? UNKNOWN_SPAN_INDEX
      const sessionId = idByIndex[this.#ringSessions[slot] ?? NO_SESSION_INDEX]
      spans.push({
        name: SPAN_NAMES[nameIndex] ?? UNKNOWN_SPAN_NAME,
        ms: roundMs(this.#ringDurations[slot] ?? 0),
        ...(sessionId === undefined ? {} : { sessionId }),
      })
    }
    return spans
  }

  #readAggregate<TName extends SpanName>(name: TName, aggregate: Aggregate): SpanAggregate<TName> {
    return {
      name,
      count: aggregate.count,
      abandoned: aggregate.abandoned,
      totalMs: roundMs(aggregate.totalMs),
      maxMs: roundMs(aggregate.maxMs),
      meanMs: aggregate.count === 0 ? null : roundMs(aggregate.totalMs / aggregate.count),
      p50: percentileOf(aggregate.buckets, aggregate.count, 0.5),
      p95: percentileOf(aggregate.buckets, aggregate.count, 0.95),
      p99: percentileOf(aggregate.buckets, aggregate.count, 0.99),
    }
  }

  /**
   * Open spans counted by name -- never by key.
   *
   * The names are the same closed vocabulary a completed span carries. Two of
   * the three key spaces -- tool call ids and request ids -- are host internals
   * and could not be reported whatever the argument, and the third could be:
   * a turn's key is a `SessionId`, which is reported everywhere else in this
   * file. It is not reported here because it would say less than it appears to.
   * These are the spans that have *not* finished, so naming their sessions would
   * list every session that is merely busy right now beside the one that is
   * stuck, and a reader has no way to tell which is which. A count answers
   * "something has been open a while" without the false precision.
   */
  #readOpen(): OpenSpanCount[] {
    const counts = new Map<SpanName, number>()
    for (const span of this.#open.values()) counts.set(span.name, (counts.get(span.name) ?? 0) + 1)
    return [...counts.entries()].map(([name, count]) => ({ name, count })).sort(byName)
  }
}
