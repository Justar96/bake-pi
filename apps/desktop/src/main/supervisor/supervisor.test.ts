import { describe, expect, test } from "bun:test"
import type { MessagePortMain } from "electron"
import {
  BakePiError,
  type CommandName,
  type CommandParams,
  type CommandResult,
  type HelloAck,
  type HostConnectionNotice,
  type WorkspaceRuntime,
} from "@bake-pi/contract"
import { RestartBudget } from "./health.ts"
import type { HostLauncher, HostLauncherHooks, RendererEventChannel } from "./supervisor.ts"
import { HostSupervisor } from "./supervisor.ts"

const ack = {
  kind: "hello_ack",
  contractVersion: "test",
  piVersion: "test",
  nodeVersion: "test",
  features: {},
  startup: {},
} as unknown as HelloAck

const shutdown = { requested: 1, walked: 2, total: 3, acknowledged: true }
const port = {} as MessagePortMain
const windowsRuntime = { kind: "windows" } as const

type Answer = (name: CommandName, params: unknown) => unknown | Promise<unknown>

class FakeLauncher implements HostLauncher {
  running = false
  starting = false
  readonly sent: { name: CommandName; params: unknown }[] = []
  readonly attachments: boolean[] = []
  stops = 0
  answer: Answer
  readonly #hooks: HostLauncherHooks
  readonly #startError: Error | undefined

  constructor(hooks: HostLauncherHooks, answer: Answer, startError?: Error) {
    this.#hooks = hooks
    this.answer = answer
    this.#startError = startError
  }

  async start(): Promise<HelloAck> {
    this.starting = true
    this.#hooks.onPhase("forked")
    this.starting = false
    if (this.#startError !== undefined) throw this.#startError
    this.running = true
    this.#hooks.onPhase("acked")
    return ack
  }

  async send<N extends CommandName>(name: N, params: CommandParams<N>): Promise<CommandResult<N>> {
    this.sent.push({ name, params })
    return await this.answer(name, params) as CommandResult<N>
  }

  attachEventChannel(deliver: (value: RendererEventChannel) => void, restoreProjection = false): void {
    this.attachments.push(restoreProjection)
    deliver({ kind: "message_port", port })
  }

  async stop(): Promise<typeof shutdown> {
    this.stops += 1
    this.running = false
    this.starting = false
    return shutdown
  }

  exit(code = 1): void {
    this.running = false
    this.starting = false
    this.#hooks.onUnexpectedExit(code)
  }
}

const deferred = <T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const defaultAnswer: Answer = (name, params) => {
  if (name === "open_workspace") {
    const target = params as { root: string; runtime: WorkspaceRuntime }
    return {
      workspace: {
        id: "workspace",
        ...target,
        displayName: "workspace",
        trust: "untrusted",
        isGitRepository: false,
      },
    }
  }
  if (name === "open_session") {
    const sessionId = (params as { sessionId: string }).sessionId
    return { snapshot: { summary: { id: sessionId, workspaceId: "workspace" } } }
  }
  return {}
}

const harness = (options: { answers?: Answer[]; startErrors?: (Error | undefined)[]; budget?: RestartBudget; clock?: () => number } = {}) => {
  const launchers: FakeLauncher[] = []
  const notices: HostConnectionNotice[] = []
  const delivered: RendererEventChannel[] = []
  const runtimes: WorkspaceRuntime[] = []
  const closedWorkspaceIds: string[] = []
  let id = 0
  const supervisor = new HostSupervisor({
    createLauncher: (runtime, hooks) => {
      runtimes.push(runtime)
      const launcher = new FakeLauncher(
        hooks,
        options.answers?.[launchers.length] ?? defaultAnswer,
        options.startErrors?.[launchers.length],
      )
      launchers.push(launcher)
      return launcher
    },
    renderer: {
      available: () => true,
      announce: (notice) => notices.push(notice),
      deliverEventChannel: (value) => delivered.push(value),
    },
    onWorkspaceClosed: (workspaceId) => closedWorkspaceIds.push(workspaceId),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    nextId: () => `command-${String(++id)}`,
    log: { error: () => {}, log: () => {} },
  })
  return { supervisor, launchers, notices, delivered, runtimes, closedWorkspaceIds }
}

const settle = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return
    await Promise.resolve()
  }
  throw new Error("condition did not settle")
}

describe("host supervisor lifecycle", () => {
  test("starts once and attaches the initial renderer without requesting a projection restore", async () => {
    const world = harness()

    expect(await world.supervisor.start()).toBe(ack)
    await world.supervisor.attachRenderer({ reason: "initial" })

    expect(world.launchers).toHaveLength(1)
    expect(world.launchers[0]?.attachments).toEqual([false])
    expect(world.delivered).toEqual([{ kind: "message_port", port }])
  })

  test("stopping is idempotent and cannot start recovery", async () => {
    const world = harness()
    await world.supervisor.start()
    await world.supervisor.attachRenderer({ reason: "initial" })

    const first = world.supervisor.stop()
    const second = world.supervisor.stop()
    await Promise.all([first, second])
    world.launchers[0]?.exit()
    await Promise.resolve()

    expect(world.launchers[0]?.stops).toBe(1)
    expect(world.launchers).toHaveLength(1)
  })

  test("switches launchers for WSL and drops state owned by the Windows host", async () => {
    const world = harness()
    await world.supervisor.start()
    await world.supervisor.attachRenderer({ reason: "initial" })
    await world.supervisor.execute("open_workspace", { root: "C:\\work", runtime: windowsRuntime })
    await world.supervisor.execute("open_session", { sessionId: "windows-session" })
    const linux = { root: "/home/alice/project", runtime: { kind: "wsl" as const, distro: "Ubuntu" } }

    const result = await world.supervisor.openWorkspace(linux)

    expect(result).toMatchObject({ workspace: { id: "workspace", ...linux } })
    expect(world.runtimes).toEqual([windowsRuntime, linux.runtime])
    expect(world.launchers[0]?.stops).toBe(1)
    expect(world.launchers[1]?.sent).toEqual([{ name: "open_workspace", params: linux }])
    expect(world.launchers[1]?.attachments).toEqual([false])
    expect(world.supervisor.openSessions).toEqual([])
    expect(world.supervisor.runtime).toEqual(linux.runtime)
  })

  test("opens another root in place when the runtime is unchanged", async () => {
    const world = harness()
    await world.supervisor.start()
    const target = { root: "C:\\second", runtime: windowsRuntime }

    await world.supervisor.openWorkspace(target)

    expect(world.launchers).toHaveLength(1)
    expect(world.launchers[0]?.stops).toBe(0)
    expect(world.launchers[0]?.sent).toEqual([{ name: "open_workspace", params: target }])
  })

  test("reports only a successfully closed workspace", async () => {
    const rejected = new BakePiError("malformed_command")
    const world = harness({
      answers: [(name) => {
        if (name === "close_workspace") throw rejected
        return defaultAnswer(name, {})
      }],
    })
    await world.supervisor.start()

    await expect(world.supervisor.execute("close_workspace", { id: "missing" })).rejects.toBe(rejected)
    expect(world.closedWorkspaceIds).toEqual([])

    world.launchers[0]!.answer = defaultAnswer
    await world.supervisor.execute("close_workspace", { id: "active" })
    expect(world.closedWorkspaceIds).toEqual(["active"])
  })

  test("can restore the Windows host after a selected WSL runtime cannot start", async () => {
    const missingNode = new BakePiError("host_unavailable", { detail: "node_missing" })
    const world = harness({ startErrors: [undefined, missingNode, undefined] })
    await world.supervisor.start()

    await expect(world.supervisor.openWorkspace({
      root: "/home/alice/project",
      runtime: { kind: "wsl", distro: "Ubuntu" },
    })).rejects.toBe(missingNode)
    await world.supervisor.start()
    await world.supervisor.attachRenderer({ reason: "runtime_switch" })

    expect(world.runtimes).toEqual([windowsRuntime, { kind: "wsl", distro: "Ubuntu" }, windowsRuntime])
    expect(world.launchers[2]?.attachments).toEqual([false])
    expect(world.supervisor.runtime).toEqual(windowsRuntime)
    expect(world.supervisor.running).toBe(true)
  })
})

describe("recorded recovery", () => {
  test("attributes the crash before rejection, restores roots before safe sessions, then attaches", async () => {
    const prompt = deferred<never>()
    const firstAnswer: Answer = (name, params) => name === "prompt" ? prompt.promise : defaultAnswer(name, params)
    const world = harness({ answers: [firstAnswer, defaultAnswer] })
    await world.supervisor.start()
    await world.supervisor.attachRenderer({ reason: "initial" })
    await world.supervisor.execute("open_workspace", { root: "C:\\work", runtime: windowsRuntime })
    await world.supervisor.execute("open_session", { sessionId: "safe" })
    await world.supervisor.execute("open_session", { sessionId: "poison" })

    const inFlight = world.supervisor.execute("prompt", { sessionId: "poison", text: "crash", attachments: [] })
    world.launchers[0]!.exit()
    prompt.reject(new BakePiError("host_unavailable", { retryable: true }))
    await expect(inFlight).rejects.toMatchObject({ code: "host_unavailable" })
    await settle(() => world.launchers.length === 2 && world.launchers[1]!.attachments.length === 1)

    expect(world.supervisor.quarantinedSessions).toEqual(["poison"])
    expect(world.launchers[1]?.sent.map(({ name, params }) => ({ name, params }))).toEqual([
      { name: "open_workspace", params: { root: "C:\\work", runtime: windowsRuntime } },
      { name: "open_session", params: { sessionId: "safe" } },
    ])
    expect(world.launchers[1]?.attachments).toEqual([true])
  })

  test("does not automatically restart an ambiguous credential mutation", async () => {
    const credential = deferred<never>()
    const world = harness({ answers: [(name) => name === "set_api_key" ? credential.promise : defaultAnswer(name, {})] })
    await world.supervisor.start()
    await world.supervisor.attachRenderer({ reason: "initial" })

    const inFlight = world.supervisor.execute("set_api_key", { providerId: "fixture", apiKey: "secret" })
    world.launchers[0]!.exit()
    credential.reject(new BakePiError("host_unavailable", { retryable: true }))
    await expect(inFlight).rejects.toMatchObject({ code: "host_unavailable" })
    await Promise.resolve()

    expect(world.launchers).toHaveLength(1)
    expect(world.notices.at(-1)?.status).toBe("disconnected")
  })

  test("a spent restart budget waits for a manual restart", async () => {
    const world = harness({ budget: new RestartBudget({ maxRestarts: 0, windowMs: 60_000 }) })
    await world.supervisor.start()
    await world.supervisor.attachRenderer({ reason: "initial" })

    world.launchers[0]!.exit()
    await Promise.resolve()

    expect(world.launchers).toHaveLength(1)
    expect(world.notices.at(-1)?.status).toBe("disconnected")
  })

  test("manual restart stops a surviving launcher, resets the budget, and restores open state", async () => {
    const budget = new RestartBudget({ maxRestarts: 0, windowMs: 60_000 })
    budget.record()
    const world = harness({ budget })
    await world.supervisor.start()
    await world.supervisor.attachRenderer({ reason: "initial" })
    await world.supervisor.execute("open_workspace", { root: "C:\\work", runtime: windowsRuntime })
    await world.supervisor.execute("open_session", { sessionId: "safe" })

    const result = await world.supervisor.restart()

    expect(result).toEqual({ started: true, quarantined: [] })
    expect(world.launchers[0]?.stops).toBe(1)
    expect(budget.recentFailures).toBe(0)
    expect(world.launchers[1]?.sent.map(({ name }) => name)).toEqual(["open_workspace", "open_session"])
    expect(world.launchers[1]?.attachments).toEqual([true])
  })

  test("one failed restore does not prevent the next session", async () => {
    const secondAnswer: Answer = (name, params) => {
      if (name === "open_session" && (params as { sessionId: string }).sessionId === "bad") {
        throw new BakePiError("session_not_found")
      }
      return defaultAnswer(name, params)
    }
    const world = harness({ answers: [defaultAnswer, secondAnswer] })
    await world.supervisor.start()
    await world.supervisor.attachRenderer({ reason: "initial" })
    await world.supervisor.execute("open_workspace", { root: "C:\\work", runtime: windowsRuntime })
    await world.supervisor.execute("open_session", { sessionId: "bad" })
    await world.supervisor.execute("open_session", { sessionId: "good" })

    world.launchers[0]!.exit()
    await settle(() => world.launchers.length === 2 && world.launchers[1]!.attachments.length === 1)

    expect(world.launchers[1]?.sent.map(({ name, params }) => ({ name, params }))).toEqual([
      { name: "open_workspace", params: { root: "C:\\work", runtime: windowsRuntime } },
      { name: "open_session", params: { sessionId: "bad" } },
      { name: "open_session", params: { sessionId: "good" } },
    ])
    expect(world.supervisor.openSessions).toEqual(["good"])
  })

  test("a superseded generation cannot attach or publish a late restore", async () => {
    const staleWorkspace = deferred<unknown>()
    const secondAnswer: Answer = (name, params) => name === "open_workspace"
      ? staleWorkspace.promise
      : defaultAnswer(name, params)
    const world = harness({ answers: [defaultAnswer, secondAnswer, defaultAnswer] })
    await world.supervisor.start()
    await world.supervisor.attachRenderer({ reason: "initial" })
    await world.supervisor.execute("open_workspace", { root: "C:\\work", runtime: windowsRuntime })
    await world.supervisor.execute("open_session", { sessionId: "safe" })

    world.launchers[0]!.exit()
    await settle(() => world.launchers.length === 2 && world.launchers[1]!.sent.length === 1)
    const manual = world.supervisor.restart()
    await manual
    staleWorkspace.resolve({
      workspace: {
        id: "stale",
        root: "C:\\work",
        runtime: windowsRuntime,
        displayName: "work",
        trust: "untrusted",
        isGitRepository: false,
      },
    })
    await Promise.resolve()

    expect(world.launchers[1]?.attachments).toEqual([])
    expect(world.launchers[1]?.sent.map(({ name }) => name)).toEqual(["open_workspace"])
    expect(world.launchers[2]?.sent.map(({ name }) => name)).toEqual(["open_workspace", "open_session"])
    expect(world.launchers[2]?.attachments).toEqual([true])
  })
})

test("concurrent commands keep their own arrival values", async () => {
  let now = 0
  const releases = [deferred<unknown>(), deferred<unknown>()]
  let sent = 0
  const world = harness({
    clock: () => now,
    answers: [() => releases[sent++]!.promise],
  })
  await world.supervisor.start()

  now = 2
  const first = world.supervisor.execute("list_models", {}, { arrivedAt: 0 })
  now = 107
  const second = world.supervisor.execute("list_models", {}, { arrivedAt: 100 })
  now = 200
  releases[0]!.resolve({ models: [] })
  await first
  now = 300
  releases[1]!.resolve({ models: [] })
  await second

  const [latency] = world.supervisor.commandLatency
  expect(latency?.answered.mainSamples).toBe(2)
  expect(latency?.answered.mainTotalMs).toBe(9)
  expect(latency?.answered.mainMaxMs).toBe(7)
  expect(latency?.answered.roundTripTotalMs).toBe(391)
})
