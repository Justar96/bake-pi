import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import type { CommandParams, CommandResult, EventEnvelope, RendererCommandName, SessionSnapshot, Workspace } from "@bake-pi/contract"

type CommandHandlers = Partial<{
  [N in RendererCommandName]: (params: CommandParams<N>) => CommandResult<N> | Promise<CommandResult<N>>
}>

const handlers: CommandHandlers = {}
const commands = new Proxy({}, {
  get: (_target, property) => (params: unknown) => {
    const handler = handlers[property as RendererCommandName] as ((value: unknown) => unknown) | undefined
    if (handler === undefined) throw new Error(`unexpected command: ${String(property)}`)
    return handler(params)
  },
}) as { [N in RendererCommandName]: (params: CommandParams<N>) => Promise<CommandResult<N>> }

const originalWindow = globalThis.window
const localStorage = new Map<string, string>()
const messageListeners = new Set<(event: MessageEvent) => void>()
const fakeWindow = {
  bakePi: { commands, onHostConnection: () => {} },
  addEventListener: (name: string, listener: (event: MessageEvent) => void) => {
    if (name === "message") messageListeners.add(listener)
  },
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {},
  localStorage: {
    getItem: (key: string) => localStorage.get(key) ?? null,
    setItem: (key: string, value: string) => localStorage.set(key, value),
    removeItem: (key: string) => localStorage.delete(key),
  },
}
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: fakeWindow,
})

const { SessionStore } = await import("./session-store.ts")

const workspace: Workspace = {
  id: "workspace-1",
  root: "C:\\workspace",
  runtime: { kind: "windows" },
  displayName: "workspace",
  trust: "trusted",
  isGitRepository: true,
}

const snapshot: SessionSnapshot = {
  sequence: 0,
  summary: {
    id: "session-1",
    workspaceId: workspace.id,
    title: "",
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    path: "C:\\workspace\\session.jsonl",
  },
  status: "idle",
  messages: [],
  queue: [],
  approvals: [],
  model: { providerId: "fixture", modelId: "fixture", thinkingLevel: "off", availableThinkingLevels: ["off"] },
  usage: { turnCount: 0, total: { inputTokens: 0, outputTokens: 0 } },
  afterGap: false,
}

const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const readyStore = async (): Promise<InstanceType<typeof SessionStore>> => {
  const store = new SessionStore()
  await store.chooseWorkspace()
  return store
}

beforeEach(() => {
  for (const name of Object.keys(handlers) as RendererCommandName[]) delete handlers[name]
  localStorage.clear()
  messageListeners.clear()
  handlers.choose_workspace = () => ({ workspace })
  handlers.list_sessions = () => ({ sessions: [] })
  handlers.get_auth_status = () => ({ providers: [] })
  handlers.list_models = () => ({ models: [] })
  handlers.list_resources = () => ({ resources: [] })
})

afterAll(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow })
})

describe("lazy session start", () => {
  test("publishes a pending surface before Pi returns the authoritative snapshot", async () => {
    const result = deferred<CommandResult<"create_session">>()
    handlers.create_session = () => result.promise
    const store = await readyStore()

    const creating = store.createSession()

    expect(store.getSnapshot().sessionStarting).toBe(true)
    expect(store.getSnapshot().activeSessionId).toBeUndefined()

    result.resolve({ snapshot })
    await creating

    expect(store.getSnapshot().sessionStarting).toBe(false)
    expect(store.getSnapshot().activeSessionId).toBe(snapshot.summary.id)
    expect(store.views.session(snapshot.summary.id)?.state().snapshot).toEqual(snapshot)
  })

  test("coalesces another start while Pi is still creating the first session", async () => {
    const result = deferred<CommandResult<"create_session">>()
    let creates = 0
    handlers.create_session = () => {
      creates += 1
      return result.promise
    }
    handlers.new_session = () => { throw new Error("a second session start reached Pi") }
    const store = await readyStore()

    const first = store.createSession()
    const second = store.newSession()
    result.resolve({ snapshot })

    expect(await first).toEqual(snapshot)
    expect(await second).toEqual(snapshot)
    expect(creates).toBe(1)
  })

  test("removes the pending surface when Pi rejects creation", async () => {
    const result = deferred<CommandResult<"create_session">>()
    handlers.create_session = () => result.promise
    const store = await readyStore()
    const creating = store.createSession()

    result.reject(new Error("creation failed"))

    await expect(creating).rejects.toThrow("creation failed")
    expect(store.getSnapshot().sessionStarting).toBe(false)
    expect(store.getSnapshot().activeSessionId).toBeUndefined()
  })
})

describe("multi-session navigation", () => {
  const session = (id: string): SessionSnapshot => ({ ...snapshot, summary: { ...snapshot.summary, id } })

  // Deliver through the production event intake without depending on transport
  // timing. Deferred command replies let each test choose which channel wins.
  const eventIntake = (): ((event: EventEnvelope) => void) => {
    handlers.get_runtime_info = () => ({
      appVersion: "test", piVersion: "test", electronVersion: "test",
      nodeVersion: "test", platform: "win32", arch: "x64",
    })
    const port = { onmessage: null as ((event: MessageEvent) => void) | null, start() {}, close() {}, postMessage() {} }
    for (const listener of messageListeners) {
      listener({ source: fakeWindow, data: "bakepi:event-port", ports: [port] } as unknown as MessageEvent)
    }
    return (event) => port.onmessage!({ data: event } as MessageEvent)
  }

  test("background events cannot select a previously active tab", async () => {
    handlers.open_session = ({ sessionId }) => ({ snapshot: session(sessionId) })
    const store = await readyStore()
    const receive = eventIntake()
    await store.openSession("a")
    await store.openSession("b")
    store.selectSession("a")

    receive({ kind: "event", name: "session_status_changed", sessionId: "b", sequence: 1, payload: { status: "streaming" } })
    receive({ kind: "event", name: "session_snapshot", sessionId: "b", sequence: 2, payload: { snapshot: { ...session("b"), sequence: 2 } } })

    expect(store.getSnapshot().activeSessionId).toBe("a")
    expect(store.views.session("b")?.state().snapshot.sequence).toBe(2)
  })

  test("the latest selection wins when many opens finish in reverse order", async () => {
    const pending = Array.from({ length: 24 }, () => deferred<CommandResult<"open_session">>())
    handlers.open_session = ({ sessionId }) => pending[Number(sessionId)]!.promise
    const store = await readyStore()
    const opening = pending.map((_result, index) => store.openSession(String(index)))
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      pending[index]!.resolve({ snapshot: session(String(index)) })
      await opening[index]
      expect(store.getSnapshot().activeSessionId).toBe("23")
    }
    expect(Object.keys(store.views.workbench.getSnapshot().sessions)).toHaveLength(24)
    expect(localStorage.get("bakepi:workspace-resumes")).toContain('"sessionId":"23"')
  })

  test("returning to an open tab supersedes an earlier pending open", async () => {
    const result = deferred<CommandResult<"open_session">>()
    handlers.open_session = ({ sessionId }) => sessionId === "a" ? { snapshot: session("a") } : result.promise
    const store = await readyStore()
    await store.openSession("a")
    const opening = store.openSession("b")
    store.selectSession("a")
    result.resolve({ snapshot: session("b") })
    await opening

    expect(store.getSnapshot().activeSessionId).toBe("a")
    expect(store.views.session("b")).toBeDefined()
  })

  test("closing the old tab cannot cancel a newer pending selection", async () => {
    const opened = deferred<CommandResult<"open_session">>()
    const closed = deferred<CommandResult<"close_session">>()
    handlers.open_session = ({ sessionId }) => sessionId === "a" ? { snapshot: session("a") } : opened.promise
    handlers.close_session = () => closed.promise
    const store = await readyStore()
    await store.openSession("a")
    const closing = store.closeSession("a")
    const opening = store.openSession("b")
    closed.resolve({})
    await closing
    opened.resolve({ snapshot: session("b") })
    await opening

    expect(store.getSnapshot().activeSessionId).toBe("b")
    expect(store.views.session("a")).toBeUndefined()
  })

  test("repeated opens share one host request and a failed open can be retried", async () => {
    const result = deferred<CommandResult<"open_session">>()
    let opens = 0
    handlers.open_session = () => { opens += 1; return result.promise }
    const store = await readyStore()
    const first = store.openSession("a")
    const second = store.openSession("a")
    const failures = Promise.allSettled([first, second])
    result.reject(new Error("locked"))
    expect((await failures).map((failure) => failure.status)).toEqual(["rejected", "rejected"])
    expect(opens).toBe(1)

    handlers.open_session = () => { opens += 1; return { snapshot: session("a") } }
    await store.openSession("a")
    expect(opens).toBe(2)
    expect(store.getSnapshot().activeSessionId).toBe("a")
  })

  test("a delayed creation cannot override a later tab selection", async () => {
    const result = deferred<CommandResult<"create_session">>()
    handlers.create_session = () => result.promise
    handlers.open_session = ({ sessionId }) => ({ snapshot: session(sessionId) })
    const store = await readyStore()
    await store.openSession("a")
    const creating = store.createSession()
    store.selectSession("a")
    result.resolve({ snapshot: session("b") })
    await creating

    expect(store.getSnapshot().activeSessionId).toBe("a")
    expect(store.getSnapshot().sessionStarting).toBe(false)
    expect(store.views.session("b")).toBeDefined()
  })

  test("a late command snapshot cannot erase newer streamed state", async () => {
    const result = deferred<CommandResult<"open_session">>()
    handlers.open_session = () => result.promise
    const store = await readyStore()
    const receive = eventIntake()
    const opening = store.openSession("a")
    receive({ kind: "event", name: "session_snapshot", sessionId: "a", sequence: 1, payload: { snapshot: { ...session("a"), sequence: 1 } } })
    receive({ kind: "event", name: "session_status_changed", sessionId: "a", sequence: 2, payload: { status: "streaming" } })
    const projection = store.views.session("a")!
    const timeline = projection.view("timeline").getSnapshot()
    result.resolve({ snapshot: { ...session("a"), sequence: 1 } })
    await opening

    expect(projection.state().snapshot.status).toBe("streaming")
    expect(projection.view("timeline").getSnapshot()).toBe(timeline)
    expect(store.getSnapshot().activeSessionId).toBe("a")
  })

  test("recovery snapshots select the remembered session without following its later activity", async () => {
    localStorage.set("bakepi:workspace-resumes", JSON.stringify([{ root: workspace.root, sessionId: "b" }]))
    const store = new SessionStore()
    const receive = eventIntake()
    receive({ kind: "event", name: "workspace_changed", sequence: 1, payload: { workspace } })
    for (const id of ["a", "b", "c"]) {
      receive({ kind: "event", name: "session_snapshot", sessionId: id, sequence: 1, payload: { snapshot: { ...session(id), sequence: 1 } } })
    }
    expect(store.getSnapshot().activeSessionId).toBe("b")
    store.selectSession("c")
    receive({ kind: "event", name: "session_status_changed", sessionId: "b", sequence: 2, payload: { status: "streaming" } })
    expect(store.getSnapshot().activeSessionId).toBe("c")
  })
})

describe("Pi package updates", () => {
  test("checks and updates through the open workspace", async () => {
    const store = await readyStore()
    const update = { displayName: "Fixture package", type: "npm" as const, scope: "user" as const }
    const checked: string[] = []
    handlers.check_resource_updates = ({ workspaceId }) => {
      checked.push(workspaceId)
      return { updates: [update] }
    }
    handlers.update_resources = ({ workspaceId }) => {
      checked.push(workspaceId)
      return { resources: [{ id: "updated", kind: "extension", scope: "user", name: "Fixture", enabled: true, executable: true }] }
    }
    handlers.list_models = () => ({ models: [] })

    expect(await store.checkResourceUpdates()).toEqual([update])
    await store.updateResources()

    expect(checked).toEqual([workspace.id, workspace.id])
    expect(store.getSnapshot().resources).toEqual([expect.objectContaining({ id: "updated" })])
  })
})

/**
 * Stopping a turn is two moments, not one: the command answers, and then the
 * turn ends. The interface says `stopping` for the whole of it, so what is
 * asserted here is that the first moment does not end the state — the flip
 * back to `working` between them is exactly the defect this state exists to
 * remove.
 */
describe("interrupting a turn", () => {
  const streaming: SessionSnapshot = { ...snapshot, status: "streaming" }

  const attachPort = (): MessagePort => {
    handlers.get_runtime_info = () => ({
      appVersion: "test",
      piVersion: "test",
      electronVersion: "test",
      nodeVersion: "test",
      platform: "win32",
      arch: "x64",
    })
    const channel = new MessageChannel()
    for (const listener of messageListeners) {
      listener({ source: fakeWindow, data: "bakepi:event-port", ports: [channel.port2] } as unknown as MessageEvent)
    }
    channel.port1.start()
    return channel.port1
  }

  const streamingStore = async (): Promise<{ store: InstanceType<typeof SessionStore>; port: MessagePort }> => {
    handlers.open_session = () => ({ snapshot: streaming })
    const store = await readyStore()
    const port = attachPort()
    await store.openSession(streaming.summary.id)
    return { store, port }
  }

  const settle = async (port: MessagePort, status: SessionSnapshot["status"]): Promise<void> => {
    const event: EventEnvelope = {
      kind: "event",
      name: "session_status_changed",
      sequence: 1,
      sessionId: streaming.summary.id,
      payload: { status },
    }
    port.postMessage(event)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  test("the stop outlives its own response and ends with the turn", async () => {
    const result = deferred<CommandResult<"abort">>()
    handlers.abort = () => result.promise
    const { store, port } = await streamingStore()

    const stopping = store.abortActive()
    expect(store.getSnapshot().abortingSessionId).toBe(streaming.summary.id)

    result.resolve({ aborted: true, recovered: [] })
    await stopping

    // The abort was delivered. The turn is not over, so neither is the state.
    expect(store.getSnapshot().abortingSessionId).toBe(streaming.summary.id)

    await settle(port, "idle")

    expect(store.getSnapshot().abortingSessionId).toBeUndefined()
    port.close()
  })

  test("a second stop is refused rather than sent to Pi twice", async () => {
    const result = deferred<CommandResult<"abort">>()
    let aborts = 0
    handlers.abort = () => {
      aborts += 1
      return result.promise
    }
    const { store, port } = await streamingStore()

    const first = store.abortActive()
    const second = store.abortActive()

    const held = { id: "queued-1", text: "held", mode: "follow_up", queuedAt: 2 } as const
    expect(await second).toEqual([])
    result.resolve({ aborted: true, recovered: [held] })
    // The queue belongs to whichever call Pi answered, so the refused one
    // returning nothing is what keeps the draft from being written twice.
    expect(await first).toEqual([held])
    expect(aborts).toBe(1)
    port.close()
  })

  test("an abort that fails stops reporting a stop that never happened", async () => {
    handlers.abort = () => { throw new Error("abort failed") }
    const { store, port } = await streamingStore()

    await expect(store.abortActive()).rejects.toThrow("abort failed")

    expect(store.getSnapshot().abortingSessionId).toBeUndefined()
    port.close()
  })

  test("a turn that ends any other way releases the stop as well", async () => {
    // Nothing but the status can release this. A host that quarantines the
    // session, or a turn that was already finishing when the button was
    // pressed, both end the turn without the abort's response saying so.
    const result = deferred<CommandResult<"abort">>()
    handlers.abort = () => result.promise
    const { store, port } = await streamingStore()

    const stopping = store.abortActive()
    await settle(port, "quarantined")

    expect(store.getSnapshot().abortingSessionId).toBeUndefined()
    result.resolve({ aborted: true, recovered: [] })
    await stopping
    port.close()
  })
})

describe("workspace resume", () => {
  test("reopens the last selected Pi session for that canonical workspace", async () => {
    localStorage.set("bakepi:workspace-resumes", JSON.stringify([{ root: workspace.root, sessionId: snapshot.summary.id }]))
    handlers.list_sessions = () => ({ sessions: [snapshot.summary] })
    let opened: string | undefined
    handlers.open_session = ({ sessionId }) => {
      opened = sessionId
      return { snapshot }
    }

    const store = await readyStore()

    expect(opened).toBe(snapshot.summary.id)
    expect(store.getSnapshot().activeSessionId).toBe(snapshot.summary.id)
    expect(store.views.session(snapshot.summary.id)?.state().snapshot).toEqual(snapshot)
  })

  test("automatic resume cannot override navigation made while the workspace listing loads", async () => {
    localStorage.set("bakepi:workspace-resumes", JSON.stringify([{ root: workspace.root, sessionId: snapshot.summary.id }]))
    const listed = deferred<CommandResult<"list_sessions">>()
    const listingStarted = deferred<void>()
    const opened = deferred<CommandResult<"open_session">>()
    handlers.list_sessions = () => { listingStarted.resolve(); return listed.promise }
    const opens: string[] = []
    handlers.open_session = ({ sessionId }) => {
      opens.push(sessionId)
      return sessionId === "chosen" ? opened.promise : { snapshot }
    }
    const store = new SessionStore()
    const choosing = store.chooseWorkspace()
    await listingStarted.promise
    const opening = store.openSession("chosen")
    listed.resolve({ sessions: [snapshot.summary] })
    await choosing
    opened.resolve({ snapshot: { ...snapshot, summary: { ...snapshot.summary, id: "chosen" } } })
    await opening

    expect(opens).toEqual(["chosen"])
    expect(store.getSnapshot().activeSessionId).toBe("chosen")
  })

  test("does not ask Pi to open a remembered id absent from its fresh listing", async () => {
    localStorage.set("bakepi:workspace-resumes", JSON.stringify([{ root: workspace.root, sessionId: "missing" }]))
    let opens = 0
    handlers.open_session = () => {
      opens += 1
      return { snapshot }
    }

    const store = await readyStore()

    expect(opens).toBe(0)
    expect(store.getSnapshot().activeSessionId).toBeUndefined()
    expect(localStorage.get("bakepi:workspace-resumes")).toBe("[]")
  })

  test("switching away and back resumes each workspace's own selected session", async () => {
    const second: Workspace = { ...workspace, id: "workspace-2", root: "C:\\second", displayName: "second" }
    const secondSnapshot: SessionSnapshot = {
      ...snapshot,
      summary: { ...snapshot.summary, id: "session-2", workspaceId: second.id, path: "C:\\second\\session.jsonl" },
    }
    handlers.open_session = ({ sessionId }) => ({ snapshot: sessionId === snapshot.summary.id ? snapshot : secondSnapshot })
    const store = await readyStore()
    await store.openSession(snapshot.summary.id)

    handlers.close_workspace = () => ({})
    handlers.list_sessions = ({ workspaceId }) => ({
      sessions: workspaceId === workspace.id ? [snapshot.summary] : [secondSnapshot.summary],
    })
    let nextWorkspace = second
    handlers.choose_workspace = () => ({ workspace: nextWorkspace })

    await store.chooseWorkspace()
    await store.openSession(secondSnapshot.summary.id)
    nextWorkspace = workspace
    await store.chooseWorkspace()

    expect(store.getSnapshot().workspace).toEqual(workspace)
    expect(store.getSnapshot().activeSessionId).toBe(snapshot.summary.id)
    expect(store.views.session(snapshot.summary.id)?.state().snapshot).toEqual(snapshot)
  })

  test("an early workspace event cannot hide the previous workspace from switch cleanup", async () => {
    const store = await readyStore()
    const second: Workspace = { ...workspace, id: "workspace-2", root: "C:\\second", displayName: "second" }
    const channel = new MessageChannel()
    handlers.get_runtime_info = () => ({
      appVersion: "test",
      piVersion: "test",
      electronVersion: "test",
      nodeVersion: "test",
      platform: "win32",
      arch: "x64",
    })
    for (const listener of messageListeners) {
      listener({ source: fakeWindow, data: "bakepi:event-port", ports: [channel.port2] } as unknown as MessageEvent)
    }
    channel.port1.start()

    const closed: string[] = []
    handlers.close_workspace = ({ id }) => {
      closed.push(id)
      return {}
    }
    handlers.choose_workspace = async () => {
      const event: EventEnvelope = {
        kind: "event",
        name: "workspace_changed",
        sequence: 1,
        payload: { workspace: second },
      }
      channel.port1.postMessage(event)
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { workspace: second }
    }

    await store.chooseWorkspace()
    channel.port1.close()

    expect(closed).toEqual([workspace.id])
    expect(store.getSnapshot().workspace).toEqual(second)
  })

  test("does not send a host-local workspace id after switching runtimes", async () => {
    const store = await readyStore()
    const linux: Workspace = {
      ...workspace,
      id: "wsl-workspace",
      root: "/home/alice/project",
      runtime: { kind: "wsl", distro: "Ubuntu" },
      displayName: "project",
    }
    const closed: string[] = []
    handlers.close_workspace = ({ id }) => {
      closed.push(id)
      return {}
    }
    handlers.choose_workspace = () => ({ workspace: linux })

    await store.chooseWorkspace()

    expect(closed).toEqual([])
    expect(store.getSnapshot().workspace).toEqual(linux)
  })

  test("a session creation that settles after a switch cannot enter the new workspace", async () => {
    const pending = deferred<CommandResult<"create_session">>()
    handlers.create_session = () => pending.promise
    handlers.close_workspace = () => ({})
    const store = await readyStore()
    const creating = store.createSession()
    const second: Workspace = { ...workspace, id: "workspace-2", root: "C:\\second", displayName: "second" }
    handlers.choose_workspace = () => ({ workspace: second })

    await store.chooseWorkspace()
    pending.resolve({ snapshot })
    await creating

    expect(store.getSnapshot().workspace).toEqual(second)
    expect(store.getSnapshot().activeSessionId).toBeUndefined()
    expect(store.views.session(snapshot.summary.id)).toBeUndefined()
  })
})

describe("a host that goes away says why", () => {
  // The production intake, again: the point of the test is that the reason
  // survives the trip the real event takes, not that a field can be assigned.
  const intake = (store: InstanceType<typeof SessionStore>): ((event: EventEnvelope) => void) => {
    void store
    const port = { onmessage: null as ((event: MessageEvent) => void) | null, start() {}, close() {}, postMessage() {} }
    for (const listener of messageListeners) {
      listener({ source: fakeWindow, data: "bakepi:event-port", ports: [port] } as unknown as MessageEvent)
    }
    return (event) => port.onmessage!({ data: event } as MessageEvent)
  }

  test("a fatal error keeps its reason, which is all an unreproducible startup failure leaves", async () => {
    handlers.get_runtime_info = () => ({
      appVersion: "test", piVersion: "test", electronVersion: "test",
      nodeVersion: "test", platform: "win32", arch: "x64",
    })
    const store = await readyStore()
    const deliver = intake(store)

    deliver({
      kind: "event",
      name: "fatal_error",
      sequence: 1,
      payload: { error: { code: "handshake_failed", detail: "pi_runtime", retryable: false } },
    } as EventEnvelope)
    await new Promise((resolve) => setTimeout(resolve, 10))

    const { connection } = store.getSnapshot()
    expect(connection.status).toBe("disconnected")
    expect(connection.status === "disconnected" ? connection.error : undefined)
      .toEqual({ code: "handshake_failed", detail: "pi_runtime", retryable: false })
  })

  test("an orderly shutdown carries no error, because nothing went wrong", async () => {
    handlers.get_runtime_info = () => ({
      appVersion: "test", piVersion: "test", electronVersion: "test",
      nodeVersion: "test", platform: "win32", arch: "x64",
    })
    const store = await readyStore()
    const deliver = intake(store)

    deliver({ kind: "event", name: "host_shutting_down", sequence: 1, payload: { reason: "requested" } } as EventEnvelope)
    await new Promise((resolve) => setTimeout(resolve, 10))

    const { connection } = store.getSnapshot()
    expect(connection.status).toBe("disconnected")
    expect(connection.status === "disconnected" ? connection.error : undefined).toBeUndefined()
  })
})
