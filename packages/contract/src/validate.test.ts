import { describe, expect, test } from "bun:test"
import { CONTRACT_VERSION } from "./version.ts"
import { isCompatible } from "./handshake.ts"
import { BakePiError } from "./errors.ts"
import {
  COMMAND_NAMES,
  CommandDefs,
  GESTURE_REQUIRED_COMMANDS,
  MAIN_OWNED_COMMANDS,
  isCommandName,
  isMainOwnedCommand,
} from "./commands/index.ts"
import { MAX_TIMING_SESSIONS, MAX_TIMING_SPANS, TIMING_TOOL_LABELS, TURN_SPAN_NAMES } from "./commands/timings.ts"
import { SessionId } from "./dto/primitives.ts"
import { EVENT_NAMES, EventDefs, SESSION_SCOPED_EVENTS } from "./events/index.ts"
import {
  acceptCommand,
  acceptEvent,
  checkEnvelope,
  exceedsSizeLimit,
  parseCommandParams,
  parseCommandResult,
  parseHostConnectionNotice,
} from "./validate.ts"

const command = (name: string, params: unknown) => ({ kind: "command", id: "req-1", name, params })

describe("inbound commands", () => {
  test("a well-formed command is accepted and its params are narrowed", () => {
    const accepted = acceptCommand(command("get_diagnostics", { limit: 50 }))
    expect(accepted.name).toBe("get_diagnostics")
    expect(accepted.params).toEqual({ limit: 50 })
  })

  test("an unknown command name is rejected by name, not by shape", () => {
    // The distinction matters: an unknown command is a version skew or a bug,
    // while a malformed one is a payload problem. They get different codes so
    // the diagnostics say which happened.
    expect(() => acceptCommand(command("delete_everything", {}))).toThrow(
      expect.objectContaining({ code: "unknown_command" }),
    )
  })

  test("params that do not match the schema are rejected", () => {
    expect(() => acceptCommand(command("get_diagnostics", { limit: "fifty" }))).toThrow(
      expect.objectContaining({ code: "malformed_command" }),
    )
  })

  test("a missing required field is rejected rather than defaulted", () => {
    expect(() => acceptCommand(command("open_workspace", {}))).toThrow(
      expect.objectContaining({ code: "malformed_command" }),
    )
  })

  test("workspace runtimes are explicit and WSL distribution names are bounded", () => {
    expect(parseCommandParams("open_workspace", {
      root: "/home/alice/project",
      runtime: { kind: "wsl", distro: "Ubuntu" },
    })).toEqual({ root: "/home/alice/project", runtime: { kind: "wsl", distro: "Ubuntu" } })
    expect(() => parseCommandParams("open_workspace", {
      root: "/home/alice/project",
      runtime: { kind: "wsl", distro: "../Ubuntu" },
    })).toThrow(BakePiError)
    expect(() => parseCommandParams("choose_attachments", { workspaceRoot: "C:\\work" })).toThrow(BakePiError)
  })

  test("an envelope that is not an envelope is rejected", () => {
    for (const bad of [null, undefined, 42, "command", [], { kind: "event" }]) {
      expect(() => acceptCommand(bad)).toThrow(BakePiError)
    }
  })

  test("an oversized payload is refused before it is validated", () => {
    const huge = command("prompt", { sessionId: "s1", text: "x".repeat(9 * 1024 * 1024), attachments: [] })
    expect(() => acceptCommand(huge)).toThrow(expect.objectContaining({ code: "payload_too_large" }))
  })

  test("size is checked before schema, so a huge malformed payload is cheap to reject", () => {
    expect(exceedsSizeLimit({ text: "x".repeat(9 * 1024 * 1024) })).toBe(true)
    expect(exceedsSizeLimit({ text: "small" })).toBe(false)
  })
})

describe("schema bounds are real limits, not documentation", () => {
  test("prompt text is capped", () => {
    expect(() =>
      parseCommandParams("prompt", { sessionId: "s1", text: "x".repeat(1_048_577), attachments: [] }),
    ).toThrow(BakePiError)
  })

  test("an empty prompt is refused", () => {
    expect(() => parseCommandParams("prompt", { sessionId: "s1", text: "", attachments: [] })).toThrow(BakePiError)
  })

  test("attachment count is capped for every prompt delivery mode", () => {
    const attachment = { path: "/tmp/a.png", mediaType: "image/png", bytes: 10 }
    for (const name of ["prompt", "steer", "follow_up"] as const) {
      expect(() =>
        parseCommandParams(name, { sessionId: "s1", text: "hi", attachments: Array(17).fill(attachment) }),
      ).toThrow(BakePiError)
    }
  })

  test("an approval decision outside the union is refused", () => {
    expect(() => parseCommandParams("respond_tool_approval", { requestId: "r1", decision: "allow_always" })).toThrow(
      BakePiError,
    )
  })

  test("Pi settings accept bounded public choices", () => {
    expect(parseCommandParams("get_pi_settings", { workspaceId: "w1" })).toEqual({ workspaceId: "w1" })
    expect(parseCommandParams("update_global_settings", {
      workspaceId: "w1",
      patch: { defaultThinkingLevel: "xhigh", transport: "websocket", editorPaddingX: 3, packages: [{ source: "git:example/resource", autoload: false, skills: ["skills/**"] }] },
    })).toEqual({
      workspaceId: "w1",
      patch: { defaultThinkingLevel: "xhigh", transport: "websocket", editorPaddingX: 3, packages: [{ source: "git:example/resource", autoload: false, skills: ["skills/**"] }] },
    })
  })

  test("Pi settings reject values outside the SDK surface", () => {
    for (const patch of [
      { transport: "long-polling" },
      { editorPaddingX: 4 },
      { httpIdleTimeoutMs: -1 },
      { autocompleteMaxVisible: 21 },
      { packages: [{ source: "package", scripts: ["not-a-resource-kind"] }] },
    ]) {
      expect(() => parseCommandParams("update_global_settings", { workspaceId: "w1", patch })).toThrow(BakePiError)
    }
  })
})

describe("the registry is internally consistent", () => {
  test("every command name round-trips through the type guard", () => {
    for (const name of COMMAND_NAMES) expect(isCommandName(name)).toBe(true)
    expect(isCommandName("nope")).toBe(false)
  })

  test("every command declares both a params and a result schema", () => {
    for (const name of COMMAND_NAMES) {
      expect(CommandDefs[name].params).toBeDefined()
      expect(CommandDefs[name].result).toBeDefined()
    }
  })

  test("every gesture-required command exists", () => {
    for (const name of GESTURE_REQUIRED_COMMANDS) expect(COMMAND_NAMES).toContain(name)
  })

  /**
   * The split between what main answers and what the agent host answers.
   *
   * The register is worth having because the
   * consequence of getting it wrong is silent: a main-owned command the router
   * forwards reaches a host that cannot implement it, and a host-owned command
   * main intercepts never reaches Pi at all.
   */
  test("every main-owned command exists and is exposed like any other", () => {
    for (const name of MAIN_OWNED_COMMANDS) {
      expect(COMMAND_NAMES).toContain(name)
      expect(isMainOwnedCommand(name)).toBe(true)
    }
  })

  test("commands are host-owned unless they are named otherwise", () => {
    const owned = COMMAND_NAMES.filter((name) => isMainOwnedCommand(name))
    expect(owned).toEqual([...MAIN_OWNED_COMMANDS])
    // Restart and the log reveal have to be answerable while no host exists;
    // the native pickers, the location listing, creation and pathless
    // recent-workspace lookup stay in main because only main may choose a host
    // filesystem path.
    expect(owned).toEqual([
      "choose_attachments",
      "choose_workspace",
      "create_workspace",
      "list_workspace_locations",
      "reopen_recent_workspace",
      "restart_host",
      "reveal_log_file",
    ])
  })

  test("every session-scoped event exists", () => {
    for (const name of SESSION_SCOPED_EVENTS) expect(EVENT_NAMES).toContain(name)
  })

  test("event names and definitions agree", () => {
    expect([...EVENT_NAMES].sort()).toEqual(Object.keys(EventDefs).sort() as typeof EVENT_NAMES[number][])
  })
})

/**
 * `get_timings` carries host internals to the renderer, so its schema is the
 * place SEC-006 is enforced rather than merely described. These tests are
 * written against the schema object itself where they can be, because a test
 * that only fed it well-formed data would pass just as happily against a schema
 * that accepted anything.
 */
describe("the timings report cannot carry host detail", () => {
  const timingsResult = CommandDefs.get_timings.result as unknown as Record<string, unknown>

  /**
   * Every subschema in the result, with the path it was found at.
   *
   * The path is what turns "no free-form strings anywhere" into the stronger
   * claim this file now has to make: the report does carry one string that is
   * not a literal, and the test has to say exactly where it is allowed to
   * appear rather than merely that it is bounded.
   */
  interface Located {
    path: string
    node: Record<string, unknown>
  }
  const subschemas = (schema: unknown, path = ""): Located[] => {
    if (typeof schema !== "object" || schema === null) return []
    const node = schema as Record<string, unknown>
    const children = Object.entries(node).flatMap(([key, value]) =>
      Array.isArray(value)
        ? value.flatMap((item, index) => subschemas(item, `${path}.${key}[${String(index)}]`))
        : subschemas(value, `${path}.${key}`),
    )
    return [{ path: path === "" ? "(root)" : path.slice(1), node }, ...children]
  }
  const nodes = (): Record<string, unknown>[] => subschemas(timingsResult).map((found) => found.node)

  /**
   * The only string in the report that is not drawn from a closed vocabulary,
   * and the two places it is allowed to be.
   *
   * A `SessionId` is not host internals: the renderer supplied it on
   * `open_session` or was handed it by `create_session`, and it rides on every
   * session event envelope already. Attributing a turn to one is the whole point
   * of the report — a host-wide mean averages a four-hundred-turn session
   * against thirty idle ones and hides the one anyone was looking for.
   *
   * What still may not happen is any *other* free string reaching the renderer,
   * or a `SessionId` field appearing somewhere it was not argued for — on a tool
   * span, say, where the id would be a claim the producer cannot support. So the
   * assertion is on the exact set of paths, not on a count.
   */
  test("the only string that is not a literal is the session id, in the two places a turn is attributed", () => {
    // TypeBox emits a literal as `{ const, type: "string" }`, so a string
    // subschema with no `const` is a free-form string — the exact shape a file
    // path, a tool argument or a fragment of a prompt would travel in.
    const freeStrings = subschemas(timingsResult).filter(
      (found) => found.node["type"] === "string" && !Object.hasOwn(found.node, "const"),
    )
    expect(freeStrings.map((found) => found.path).sort()).toEqual([
      "properties.recent.items.properties.sessionId",
      "properties.sessions.items.properties.sessionId",
    ])
  })

  test("each of those two is the SessionId DTO rather than a string that resembles it", () => {
    // Length bounds and nothing else is what `SessionId` is, so a field that had
    // dropped the DTO for a bare `Type.String()` would still be a non-literal
    // string at the same path and would pass the test above. This is the half
    // that catches it.
    const bounds = (node: Record<string, unknown>): unknown => ({
      type: node["type"],
      minLength: node["minLength"],
      maxLength: node["maxLength"],
    })
    const freeStrings = subschemas(timingsResult).filter(
      (found) => found.node["type"] === "string" && !Object.hasOwn(found.node, "const"),
    )
    expect(freeStrings.length).toBe(2)
    for (const found of freeStrings) expect(bounds(found.node)).toEqual(bounds(SessionId))
    expect(bounds(SessionId)).toEqual({ type: "string", minLength: 1, maxLength: 128 })
  })

  test("a session's turn figures cannot be a tool or a command", () => {
    // The producer draws the line at the three turn legs — a tool call's cost
    // does not depend on which session ran it, a turn's demonstrably does — and
    // this is where that decision is enforced rather than described.
    const perSession = report()
    perSession.sessions = [
      {
        sessionId: "s-1",
        turns: [
          { name: "tool.bash", count: 1, abandoned: 0, totalMs: 1, maxMs: 1, meanMs: 1, p50: null, p95: null, p99: null },
        ],
      },
    ]
    expect(() => parseCommandResult("get_timings", perSession)).toThrow(BakePiError)
  })

  test("the per-session array is bounded, so a host that opens sessions all day cannot grow one", () => {
    const turns = [
      {
        name: "turn.accepted_to_settled",
        count: 1,
        abandoned: 0,
        totalMs: 1,
        maxMs: 1,
        meanMs: 1,
        p50: null,
        p95: null,
        p99: null,
      },
    ]
    const overflowing = report()
    overflowing.sessions = Array.from({ length: MAX_TIMING_SESSIONS + 1 }, (_, index) => ({
      sessionId: `s-${String(index)}`,
      turns,
    }))
    expect(() => parseCommandResult("get_timings", overflowing)).toThrow(BakePiError)

    const atTheCap = report()
    atTheCap.sessions = Array.from({ length: MAX_TIMING_SESSIONS }, (_, index) => ({
      sessionId: `s-${String(index)}`,
      turns,
    }))
    expect(() => parseCommandResult("get_timings", atTheCap)).not.toThrow()
  })

  test("a session id longer than the DTO allows is refused rather than reported", () => {
    // The producer declines to attribute a turn whose id is over the bound, for
    // exactly this reason: a report the renderer's own checker drops on arrival
    // is an instrument that has silently stopped working.
    const tooLong = report()
    tooLong.recent = [{ name: "turn.accepted_to_settled", ms: 1, sessionId: "s".repeat(129) }]
    expect(() => parseCommandResult("get_timings", tooLong)).toThrow(BakePiError)

    const atTheBound = report()
    atTheBound.recent = [{ name: "turn.accepted_to_settled", ms: 1, sessionId: "s".repeat(128) }]
    expect(() => parseCommandResult("get_timings", atTheBound)).not.toThrow()
  })

  test("a tool span carries no session, and is still accepted without one", () => {
    // `sessionId` is optional rather than nullable: a tool span has no session
    // dimension at all, so the field is absent rather than null, which is what
    // keeps four thousand nulls off the wire in a report that is mostly tools.
    const noSession = report()
    noSession.recent = [{ name: "tool.read", ms: 4 }]
    expect(() => parseCommandResult("get_timings", noSession)).not.toThrow()

    const nulled = report()
    nulled.recent = [{ name: "tool.read", ms: 4, sessionId: null }]
    expect(() => parseCommandResult("get_timings", nulled)).toThrow(BakePiError)
  })

  test("the span vocabulary is exactly the turn legs, the tool labels, every command, and unknown", () => {
    const names = nodes()
      .filter((node) => Object.hasOwn(node, "const"))
      .map((node) => String(node["const"]))
    const expected = [
      ...TURN_SPAN_NAMES,
      ...TIMING_TOOL_LABELS.map((label) => `tool.${label}`),
      ...COMMAND_NAMES.map((name) => `command.${name}`),
      "unknown",
    ]
    // `new Set` because the vocabulary appears once per field that carries a
    // span name, and the claim is about its membership rather than its arity.
    expect([...new Set(names)].sort()).toEqual([...new Set(expected)].sort())
  })

  test("a command added to the registry gets a span name without anyone remembering to add one", () => {
    // The registry builds the vocabulary from its own keys, so this is a
    // property rather than a list to maintain. It is asserted separately from
    // the test above because that one would also pass if both sides were
    // hand-written and happened to agree today.
    const names = new Set(
      nodes()
        .filter((node) => Object.hasOwn(node, "const"))
        .map((node) => String(node["const"])),
    )
    for (const name of COMMAND_NAMES) expect(names.has(`command.${name}`)).toBe(true)
    expect(names.has("command.get_timings")).toBe(true)
    expect(names.size).toBe(TURN_SPAN_NAMES.length + TIMING_TOOL_LABELS.length + COMMAND_NAMES.length + 1)
  })

  test("a well-formed report validates", () => {
    expect(() => parseCommandResult("get_timings", report())).not.toThrow()
  })

  test("a span name outside the vocabulary is refused", () => {
    for (const name of [
      "tool.C:\\Users\\someone\\.pi\\credentials.json",
      "command.rm -rf /",
      "turn.accepted_to_first_delta ",
      "",
    ]) {
      const bad = report()
      bad.recent = [{ name, ms: 1 }]
      expect(() => parseCommandResult("get_timings", bad)).toThrow(BakePiError)
    }
  })

  test("a span may carry a name and a duration and nothing else", () => {
    const bad = report()
    bad.recent = [{ name: "tool.read", ms: 1, path: "C:\\Users\\someone\\secret.txt" }]
    // `additionalProperties` is not set on these objects, so an extra field is
    // permitted by the schema — which is why the guarantee cannot rest on
    // validation alone. What the schema does guarantee is that nothing the
    // *producer* is typed to emit has a field to put a path in, and the test
    // that holds that lives beside the producer in the agent host.
    expect(() => parseCommandResult("get_timings", bad)).not.toThrow()
  })

  test("durations may be negative but counts may not", () => {
    // A negative duration is a difference of two readings of one monotonic
    // clock coming out backwards, which is evidence of a bug in the producer and
    // has to survive to the report. A negative count is not a measurement at all.
    const negativeDuration = report()
    negativeDuration.recent = [{ name: "turn.accepted_to_settled", ms: -3 }]
    expect(() => parseCommandResult("get_timings", negativeDuration)).not.toThrow()

    const negativeCount = report()
    negativeCount.open = [{ name: "turn.accepted_to_settled", count: -1 }]
    expect(() => parseCommandResult("get_timings", negativeCount)).toThrow(BakePiError)
  })

  test("the report is bounded, so a long-lived host cannot grow one without limit", () => {
    const overflowing = report()
    overflowing.recent = Array.from({ length: MAX_TIMING_SPANS + 1 }, () => ({ name: "tool.read", ms: 1 }))
    expect(() => parseCommandResult("get_timings", overflowing)).toThrow(BakePiError)

    const atTheCap = report()
    atTheCap.recent = Array.from({ length: MAX_TIMING_SPANS }, () => ({ name: "tool.read", ms: 1 }))
    expect(() => parseCommandResult("get_timings", atTheCap)).not.toThrow()
  })

  test("an unmeasured percentile is null rather than zero", () => {
    const abandonedOnly = report()
    abandonedOnly.aggregates = [
      { name: "tool.bash", count: 0, abandoned: 2, totalMs: 0, maxMs: 0, meanMs: null, p50: null, p95: null, p99: null },
    ]
    expect(() => parseCommandResult("get_timings", abandonedOnly)).not.toThrow()
  })

  test("the top bucket has no upper edge", () => {
    const openEnded = report()
    openEnded.aggregates = [
      {
        name: "tool.bash",
        count: 1,
        abandoned: 0,
        totalMs: 90_000,
        maxMs: 90_000,
        meanMs: 90_000,
        p50: { atLeastMs: 65_536, belowMs: null },
        p95: { atLeastMs: 65_536, belowMs: null },
        p99: { atLeastMs: 65_536, belowMs: null },
      },
    ]
    expect(() => parseCommandResult("get_timings", openEnded)).not.toThrow()
  })

  test("the command takes no parameters and is not main-owned", () => {
    expect(acceptCommand(command("get_timings", {})).name).toBe("get_timings")
    expect(isMainOwnedCommand("get_timings")).toBe(false)
  })
})

/** A minimal valid report, rebuilt per test so a mutation cannot leak between them. */
const report = (): Record<string, unknown> & {
  recent: unknown
  aggregates: unknown
  sessions: unknown
  open: unknown
} => ({
  recent: [{ name: "turn.accepted_to_settled", ms: 12.5, sessionId: "s-1" }],
  aggregates: [
    {
      name: "turn.accepted_to_settled",
      count: 1,
      abandoned: 0,
      totalMs: 12.5,
      maxMs: 12.5,
      meanMs: 12.5,
      p50: { atLeastMs: 12, belowMs: 16 },
      p95: { atLeastMs: 12, belowMs: 16 },
      p99: { atLeastMs: 12, belowMs: 16 },
    },
  ],
  sessions: [
    {
      sessionId: "s-1",
      turns: [
        {
          name: "turn.accepted_to_settled",
          count: 1,
          abandoned: 0,
          totalMs: 12.5,
          maxMs: 12.5,
          meanMs: 12.5,
          p50: { atLeastMs: 12, belowMs: 16 },
          p95: { atLeastMs: 12, belowMs: 16 },
          p99: { atLeastMs: 12, belowMs: 16 },
        },
      ],
    },
  ],
  open: [{ name: "command.get_timings", count: 1 }],
  cost: {
    clockReads: 3,
    spansRecorded: 1,
    spansAbandoned: 0,
    ringCapacity: 4096,
    ringBytes: 49_152,
    bucketBytes: 288,
    openSpans: 1,
    maxOpenSpans: 256,
    trackedSessions: 1,
    maxTrackedSessions: 64,
    sessionsForgotten: 0,
  },
})

/**
 * The renderer's `script-src` carries no `'unsafe-eval'`, so anything reached
 * from `store/stream.ts` that builds a function from a string throws there and
 * nowhere else. This module used to: `TypeCompiler.Compile` calls
 * `new globalThis.Function`, which meant every session event was rejected in
 * the packaged app while all of these tests passed, because Bun enforces no CSP.
 *
 * Taking `globalThis.Function` away is a simulation of that policy, not the
 * policy — the proof that the real one is satisfied is the smoke run, which
 * asserts a streamed token reaches the renderer under the actual header. What
 * this buys is speed: a validator that reaches for runtime codegen again fails
 * here in seconds rather than in a packaged build nobody runs by accident.
 */
describe("validation never generates code at runtime", () => {
  /** Runs `body` with the function constructor replaced by one that throws, as the policy makes it. */
  const withoutCodegen = <T>(body: () => T): T => {
    const original = globalThis.Function
    // A CSP violation surfaces as an `EvalError`, so that is what stands in for
    // it. The property is writable and restored in `finally`, because leaving a
    // thrower installed would fail every later test in the file for the wrong
    // reason.
    globalThis.Function = function () {
      throw new EvalError("call to Function() blocked by Content-Security-Policy")
    } as unknown as FunctionConstructor
    try {
      return body()
    } finally {
      globalThis.Function = original
    }
  }

  test("the stand-in actually blocks what the policy blocks", () => {
    // Without this the two tests below would pass against a stand-in that had
    // silently stopped working — which is the failure mode being guarded.
    expect(() => withoutCodegen(() => new Function("return 1"))).toThrow(EvalError)
    expect(new Function("return 1")()).toBe(1)
  })

  test("an event validates with no function constructor available", () => {
    const event = {
      kind: "event",
      name: "block_delta",
      sequence: 1,
      sessionId: "s-1",
      payload: { messageId: "m-1", blockIndex: 0, textDelta: "hello" },
    }
    const accepted = withoutCodegen(() => acceptEvent(event))
    expect(accepted.name).toBe("block_delta")
    expect(accepted.payload).toEqual({ messageId: "m-1", blockIndex: 0, textDelta: "hello" })
  })

  test("a rejection is still a rejection with no function constructor available", () => {
    // The half that matters: a validator that had quietly become a no-op would
    // pass the test above and accept anything at all.
    const bad = { kind: "event", name: "block_delta", sequence: 1, sessionId: "s-1", payload: { messageId: "m-1" } }
    expect(() => withoutCodegen(() => acceptEvent(bad))).toThrow(BakePiError)
    expect(() => withoutCodegen(() => acceptCommand(command("get_diagnostics", { limit: "fifty" })))).toThrow(
      BakePiError,
    )
  })
})

describe("contract versioning", () => {
  test("only an exact match is compatible", () => {
    expect(isCompatible(CONTRACT_VERSION)).toBe(true)
    expect(isCompatible(CONTRACT_VERSION + 1)).toBe(false)
    expect(isCompatible(CONTRACT_VERSION - 1)).toBe(false)
  })
})

test("a host process id is positive and bounded when the handshake reports one", () => {
  const base = {
    kind: "hello_ack",
    contractVersion: CONTRACT_VERSION,
    piVersion: "test",
    nodeVersion: "24.18.1",
    features: {
      apiKeyPersistence: false,
      telemetryOptOut: false,
      policyHookOrdering: false,
      sessionFileLocking: false,
      processTreeCleanup: false,
      rpcFallback: false,
    },
  }
  expect(checkEnvelope("hello_ack", { ...base, processId: 42 })).toBe(true)
  expect(checkEnvelope("hello_ack", { ...base, processId: 0 })).toBe(false)
})

describe("errors carry codes, never host detail", () => {
  test("a contract error exposes only the fields the renderer may see", () => {
    const error = new BakePiError("session_not_found", { detail: "s1", cause: new Error("secret path /home/u/x") })
    expect(Object.keys(error.toContractError("diag-1")).sort()).toEqual(["code", "detail", "diagnosticId", "retryable"])
    expect(JSON.stringify(error.toContractError("diag-1"))).not.toContain("secret path")
  })
})

describe("main-process host connection notices", () => {
  test("accepts only the two lifecycle states the dead event port cannot announce", () => {
    expect(parseHostConnectionNotice({ status: "connecting" })).toEqual({ status: "connecting" })
    expect(
      parseHostConnectionNotice({
        status: "disconnected",
        error: { code: "host_unavailable", retryable: true },
      }),
    ).toEqual({ status: "disconnected", error: { code: "host_unavailable", retryable: true } })
    expect(() => parseHostConnectionNotice({ status: "connected" })).toThrow()
    expect(() => parseHostConnectionNotice({ status: "disconnected", error: { code: "raw stack" } })).toThrow()
  })
})
