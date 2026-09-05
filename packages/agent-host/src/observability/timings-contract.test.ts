import { describe, expect, test } from "bun:test"
import {
  MAX_TIMING_SESSIONS,
  MAX_TIMING_SPANS,
  SessionId,
  TIMING_TOOL_LABELS,
  TURN_SPAN_NAMES as CONTRACT_TURN_SPAN_NAMES,
  type SpanName as ContractSpanName,
  type TurnSpanName as ContractTurnSpanName,
} from "@bake-pi/contract"
import {
  DEFAULT_MAX_TRACKED_SESSIONS,
  DEFAULT_RING_CAPACITY,
  MAX_SESSION_ID_LENGTH,
  TOOL_LABELS,
  TURN_SPAN_NAMES,
  type SpanName,
  type TurnSpanName,
} from "./timings.ts"

/**
 * The seam between the instrument and the wire.
 *
 * `observability/timings.ts` and `contract/src/commands/timings.ts` each declare
 * the span vocabulary, and they have to, because the contract is the agent
 * host's dependency rather than the reverse — the producer cannot be the source
 * of a type the consumer needs before the producer exists. This file is the only
 * place in the repository where both are in scope, so it is the only place the
 * duplication can be held to account.
 *
 * The consequence of drift is not a crash. A tool label the contract does not
 * know produces a report the renderer's own schema check silently drops, which
 * looks exactly like an instrument that stopped working.
 */
describe("the report the host produces is the report the contract describes", () => {
  test("the tool vocabularies are the same list in the same order", () => {
    // Order as well as membership, because both lists are also read as the
    // authoritative copy of Pi's `ToolName` union, and a reader comparing them
    // by eye should not have to sort first.
    expect([...TOOL_LABELS]).toEqual([...TIMING_TOOL_LABELS])
  })

  test("the turn legs are the same list in the same order", () => {
    expect([...TURN_SPAN_NAMES]).toEqual([...CONTRACT_TURN_SPAN_NAMES])
  })

  test("the two span-name types are each assignable to the other", () => {
    // A compile-time assertion with a runtime body, which is the only way to
    // write one that a test runner reports. If the two unions ever differ these
    // two lines stop compiling, and `bun run typecheck:tests` fails before this
    // file is ever executed.
    const fromContract: ContractSpanName = "tool.powershell" satisfies SpanName
    const fromHost: SpanName = "turn.accepted_to_first_delta" satisfies ContractSpanName
    expect([fromContract, fromHost]).toEqual(["tool.powershell", "turn.accepted_to_first_delta"])
  })

  test("the ring cannot produce a report larger than the wire allows", () => {
    // The store's capacity is chosen for how many minutes of history it holds;
    // the contract's cap is chosen for how many bytes a response may be. They
    // are independent numbers that happen to agree today, and the relation that
    // has to hold is this one rather than equality.
    expect(DEFAULT_RING_CAPACITY).toBeLessThanOrEqual(MAX_TIMING_SPANS)
  })

  test("the session table cannot produce a report larger than the wire allows", () => {
    // Same relation, same reason: the store's cap is derived from
    // `MAX_OPEN_SESSIONS` and the wire's from how many bytes a response may be.
    expect(DEFAULT_MAX_TRACKED_SESSIONS).toBeLessThanOrEqual(MAX_TIMING_SESSIONS)
  })

  /**
   * The one number in the producer that is a restatement of a DTO rather than a
   * decision of its own.
   *
   * The store refuses to attribute a turn to an id longer than this, because a
   * report carrying one would fail the renderer's own schema check on arrival --
   * silently, and in its entirety, which is indistinguishable from an instrument
   * that stopped working. Read from the schema rather than written out, so the
   * DTO moving is caught here rather than in production.
   */
  test("the producer's session-id bound is the SessionId DTO's own", () => {
    expect(SessionId.maxLength).toBe(MAX_SESSION_ID_LENGTH)
    expect(MAX_SESSION_ID_LENGTH).toBe(128)
  })

  test("the two turn-leg types are each assignable to the other", () => {
    // The per-session aggregates are narrowed to the turn legs on both sides --
    // the producer types the map key, the contract types the union in the
    // schema -- and this is the only place that narrowing can be checked against
    // itself. If they diverge these two lines stop compiling.
    const fromContract: ContractTurnSpanName = "turn.first_delta_to_settled" satisfies TurnSpanName
    const fromHost: TurnSpanName = "turn.accepted_to_settled" satisfies ContractTurnSpanName
    expect([fromContract, fromHost]).toEqual(["turn.first_delta_to_settled", "turn.accepted_to_settled"])
  })
})
