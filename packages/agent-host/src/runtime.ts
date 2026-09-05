import { randomUUID } from "node:crypto"
import { readdir } from "node:fs/promises"
import { basename, join } from "node:path"
import {
  BakePiError,
  MAX_DIRECTORY_ENTRIES,
  MAX_IMAGE_BYTES,
  renderableImageMediaType,
  type AuthStatus,
  type FeatureFlags,
  type Model as ModelDto,
  type Provider as ProviderDto,
  type Workspace,
  type WorkspaceRuntime,
} from "@bake-pi/contract"
import {
  DefaultPackageManager,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  VERSION,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  type AgentSessionEvent,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent"
import type { Diagnostics } from "./diagnostics.ts"
import type { EventEmitter } from "./emitter.ts"
import { ExtensionUiGate } from "./extension-ui/gate.ts"
import { TimingStore, toolLabel, type TurnTiming } from "./observability/timings.ts"
import { createApprovalExtension } from "./policy/extension.ts"
import { ApprovalGate, type ApprovalContext } from "./policy/gate.ts"
import { canonicalize, isInside } from "./policy/paths.ts"
import { SessionHost } from "./session-host.ts"
import { Capacity, type CapacityOptions } from "./session/budget.ts"
import { processAttachments, promptWithAttachments } from "./session/attachments.ts"
import { type DiscoveredSession, toSessionSummary } from "./session/discovery.ts"
import { inspectSessionFile, willLoseEntries } from "./session/integrity.ts"
import { describeInterruptedTool, takeInterruptedTools, ToolMarker } from "./session/tool-marker.ts"
import { SessionLock } from "./session/ownership.ts"
import { listWorkspaceResources } from "./session/resources.ts"
import { applyPiSettingsPatch, reloadPiSettings } from "./session/settings.ts"
import { resolveWorkspaceTrust, WorkspacePermissionStore } from "./session/workspace-permissions.ts"
import type { HostServices } from "./services.ts"
import { checkForPiUpdate } from "./update-check.ts"
import { findGitRepository, ignoredByGit, type GitRepository } from "./workspace-ignore.ts"

export interface PiRuntime {
  services: HostServices
  features: FeatureFlags
  piVersion: string
}

interface OpenWorkspace {
  workspace: Workspace
  /** One Pi settings authority shared by every attached session in this workspace. */
  settingsManager: SettingsManager
  /** Git owns ignore semantics; absent when this workspace is not in a repository. */
  repository?: GitRepository
  /**
   * Where Pi keeps this workspace's sessions. Held as a path rather than as a
   * `SessionManager`, because a manager is not a directory: it *is* one session,
   * with one id and one file, fixed for its lifetime. Keeping one per workspace
   * and starting every session from it gave every session in the workspace the
   * same id.
   */
  sessionDir: string
}

/**
 * Bake Pi's adapter around Pi, and the only code in the project that imports it.
 *
 * The rule this file follows: reuse Pi's own state wherever Pi has state.
 * Project trust in particular is Pi's `ProjectTrustStore` — so a project
 * trusted in the CLI is trusted here and the reverse, which is the whole point
 * of preserving upstream behavior rather than layering over it. The one thing
 * kept beside it is the part Pi's boolean has no room for: whether the person
 * chose `full` rather than `trusted`, and what an undecided project opens at.
 * `WorkspacePermissionStore` holds those two and can only ever spend a grant
 * Pi already recorded.
 */
export const createPiRuntime = async (deps: {
  diagnostics: Diagnostics
  emitter: EventEmitter
  /**
   * Overrides for the capacity limits. Present so a test can reach a cap in
   * three sessions rather than in thirty-two, and so the memory ceiling can be
   * reached by saying what the host weighs rather than by making it weigh it.
   * Production passes nothing and gets the measured defaults.
   */
  capacity?: CapacityOptions
  /**
   * Pi's authoritative session listing. The seam lets integration coverage
   * count archive scans without turning wall-clock time into a test assertion.
   */
  listSessions?: (cwd: string, sessionDir: string) => Promise<DiscoveredSession[]>
  /**
   * Where turn and tool spans are filed. Injected rather than built here,
   * because the host's other instrument — the span around a whole command —
   * begins before this runtime is consulted and has to be able to run when
   * there is no runtime at all. `index.ts` owns the store and hands it in; a
   * caller that has no interest in the report, which is every test that is not
   * about timings and `scripts/budgets.ts`, gets a private one and never reads
   * it.
   */
  timings?: TimingStore
}): Promise<PiRuntime> => {
  const { diagnostics, emitter } = deps
  const capacity = new Capacity(deps.capacity)
  const listSessions = deps.listSessions ?? ((cwd: string, sessionDir: string) => SessionManager.list(cwd, sessionDir))
  const agentDir = getAgentDir()
  // Identifies this host in every session lock it takes. Per-process rather than
  // per-machine: two Bake Pi hosts on one machine must be able to tell each
  // other apart, and a released lock must be attributable to the host that took
  // it rather than to whatever runs next with the same pid.
  const hostId = randomUUID()
  const modelRuntime = await ModelRuntime.create()
  const trustStore = new ProjectTrustStore(agentDir)
  // The half of a permission decision Pi's boolean cannot hold: which of
  // `trusted` and `full` the person chose, and what a project nobody has
  // decided on opens at. Pi's store stays authoritative for whether there is a
  // grant at all — see `resolveWorkspaceTrust`.
  const permissions = new WorkspacePermissionStore(agentDir)
  let latestPiVersion: string | undefined
  // Best effort and deliberately not awaited. Startup already has a measured
  // handshake budget; update awareness cannot spend it or make offline fatal.
  void checkForPiUpdate(VERSION).then((version) => {
    latestPiVersion = version
    if (version !== undefined) {
      emitter.emit("pi_update_available", { currentVersion: VERSION, latestVersion: version })
    }
  })

  const workspaces = new Map<string, OpenWorkspace>()
  const sessions = new Map<string, SessionHost>()
  let activeWorkspaceId: string | undefined
  // Paths only, never summaries or messages. Pi and its JSONL remain the
  // authority; this avoids rediscovering every other file before opening one.
  const sessionPaths = new Map<string, Map<string, string>>()

  /**
   * Pi's installed and currently loaded resources for one workspace.
   *
   * Package discovery supplies disabled entries without executing them. Live
   * session loaders are merged over that inventory so extension-contributed
   * resources and actual load failures are reported when they exist.
   */
  const resourcesForWorkspace = async (workspaceId: string) => {
    const open = requireWorkspace(workspaceId)
    return await listWorkspaceResources({
      workspaceRoot: open.workspace.root,
      agentDir,
      projectTrusted: open.workspace.trust !== "untrusted",
      loaders: [...sessions.values()]
        .filter((session) => session.workspaceId === workspaceId)
        .map((session) => session.session.resourceLoader),
    })
  }

  const announceResources = async (workspaceId: string): Promise<void> => {
    try {
      emitter.emit("resources_changed", { resources: await resourcesForWorkspace(workspaceId) })
    } catch (error) {
      // Resource inventory is status information. A malformed package or an
      // unreadable directory must not tear down a session that already opened.
      diagnostics.capture("resources.list", error)
    }
  }

  const packageManagerForWorkspace = (workspaceId: string): DefaultPackageManager => {
    const open = requireWorkspace(workspaceId)
    // Recreate the settings view for every explicit package operation. Pi's
    // CLI may have changed package sources while this workspace stayed open;
    // the package manager must act on Pi's current file, not our open-time copy.
    const settingsManager = SettingsManager.create(open.workspace.root, agentDir, {
      projectTrusted: open.workspace.trust !== "untrusted",
    })
    return new DefaultPackageManager({ cwd: open.workspace.root, agentDir, settingsManager })
  }

  const reloadableSessions = (): SessionHost[] => {
    const attached = [...sessions.values()]
    // A user package can be shared by every open workspace. Updating one while
    // another workspace is mid-turn would replace executable code under that
    // turn, so the guard deliberately covers the whole host rather than only
    // the workspace whose Settings panel initiated the update.
    for (const host of attached) {
      if (!host.session.isIdle) {
        throw new BakePiError("session_busy", { detail: host.sessionId, retryable: true })
      }
      host.assertSoleWriter()
    }
    return attached
  }

  const reloadSessions = async (attached: readonly SessionHost[]): Promise<void> => {
    for (const host of attached) {
      try {
        await host.session.reload()
      } finally {
        // A reload hook may append before a later hook fails. Record our own
        // writes even on that failure so the next guard sees the right writer.
        host.recordWrites()
      }
    }
  }

  /**
   * Where this host's time went. One store for the whole host, which carries the
   * session dimension inside itself rather than by being cloned per session.
   *
   * A store per session was the obvious alternative and is the wrong shape: it
   * would cost a 40 KB ring apiece against a cap of thirty-two sessions, and it
   * would make the host-wide questions — is first-delta latency drifting, which
   * tool is expensive, which command handler is slow — a merge across
   * thirty-two reports rather than a read of one. `TimingStore` instead files a
   * turn twice, once host-wide and once against a bounded per-session table, so
   * both questions are answered by the same `get_timings` call.
   *
   * Every session id this passes in is the renderer's own handle for the
   * session — it supplied it on `open_session` or received it from
   * `create_session` — which is why a turn may be attributed to one without
   * `SEC-006` having anything to say about it. Tool call ids and request ids are
   * not, and those are used as pairing keys the store never reports.
   *
   * The fallback is a whole store rather than a null instrument because the
   * alternative is a `timings?.` at every recording site, and the one that
   * would eventually be forgotten is on the streaming path.
   */
  const timings = deps.timings ?? new TimingStore()

  /**
   * A session's turn handle, held where the streaming path can reach it without
   * a lookup.
   *
   * The handle is what makes the per-delta cost a property read and a compare
   * rather than a string hash and a map probe — see `TurnTiming` in
   * `observability/timings.ts`. It lives in a mutable slot because the two
   * halves are in different places: the prompt handler knows when a turn was
   * accepted, and the Pi subscription below knows when it streamed and when it
   * settled. Keyed weakly on the host so a closed session's slot goes away with
   * it; nothing has to remember to delete one, which matters because sessions
   * are removed from `sessions` in four different places.
   */
  interface TurnSlot {
    turn: TurnTiming | undefined
  }
  const turnSlots = new WeakMap<SessionHost, TurnSlot>()

  /**
   * Prompts Pi has accepted into its asynchronous preflight but has not yet
   * classified as a turn or a queued message.
   *
   * Pi does not become streaming until after extension input hooks finish. A
   * second prompt during that await must already be labelled as a follow-up or
   * Pi will later reject it despite this host having reported it accepted.
   * Keying by the host keeps a replacement session with the same id separate.
   */
  interface PromptPreflightState {
    active: number
    tail: Promise<void>
  }
  const promptPreflights = new WeakMap<SessionHost, PromptPreflightState>()
  const beginPromptPreflight = (
    host: SessionHost,
  ): { followsAnother: boolean; waitForPrevious?: Promise<void>; finish: () => void } => {
    const state = promptPreflights.get(host) ?? { active: 0, tail: Promise.resolve() }
    const followsAnother = state.active > 0
    const previous = state.tail
    let complete!: () => void
    const own = new Promise<void>((resolve) => {
      complete = resolve
    })
    state.active += 1
    state.tail = previous.then(() => own)
    promptPreflights.set(host, state)

    let finished = false
    return {
      followsAnother,
      ...(followsAnother ? { waitForPrevious: previous } : {}),
      finish: () => {
        if (finished) return
        finished = true
        complete()
        state.active -= 1
        if (state.active === 0 && promptPreflights.get(host) === state) promptPreflights.delete(host)
      },
    }
  }

  /**
   * Records a session's turn legs and tool calls from Pi's own event stream.
   *
   * This is a second subscription on the same `AgentSession` that `SessionHost`
   * subscribes to, and the separation is deliberate rather than incidental:
   * timing is not part of projecting Pi onto the contract, and putting it in the
   * middle of `SessionHost.#onPiEvent` would mean every future edit to the
   * mapping is also an edit to the instrument. Pi supports multiple listeners
   * and removes them all in `AgentSession.dispose`, so this needs no teardown of
   * its own.
   *
   * The `message_update` case is the hot one: a streaming turn emits hundreds of
   * them, and each costs the switch that got here plus `noteFirstDelta`, which
   * is a property read and a comparison after the first. Nothing is allocated
   * and the clock is not read. Every Pi event that is not one of these four
   * falls through to a bare `return`.
   *
   * `tool_execution_*` is keyed on Pi's tool call id rather than on the session,
   * because Pi may have more than one call outstanding in a turn, and the raw
   * tool name goes through `toolLabel` before it can reach a span — that
   * narrowing is what keeps an MCP server's tool name out of the report.
   */
  const recordTurnTimings = (
    sessionId: string,
    // Only the one method, declared structurally, because that is genuinely all
    // this needs from an `AgentSession` and naming the whole class here would
    // suggest otherwise.
    session: { subscribe: (listener: (event: AgentSessionEvent) => void) => () => void },
  ): TurnSlot => {
    const slot: TurnSlot = { turn: undefined }
    session.subscribe((event) => {
      switch (event.type) {
        case "message_update":
          slot.turn?.noteFirstDelta()
          return
        case "agent_settled":
          slot.turn = undefined
          timings.endTurn(sessionId)
          return
        case "tool_execution_start":
          timings.beginTool(event.toolCallId, toolLabel(event.toolName))
          return
        case "tool_execution_end":
          timings.endTool(event.toolCallId)
          return
        default:
          return
      }
    })
    return slot
  }

  /**
   * Resolved per tool call, never captured. Trust is mutable: the user can trust
   * a workspace with a session already open, and the very next tool call must be
   * judged against the decision they just made rather than the one in force when
   * the session started.
   */
  const resolveApprovalContext = (sessionId: string): ApprovalContext | undefined => {
    const session = sessions.get(sessionId)
    if (session === undefined) return undefined
    const open = workspaces.get(session.workspaceId)
    if (open === undefined) return undefined
    return { workspaceRoot: open.workspace.root, trust: open.workspace.trust }
  }

  /**
   * Repairs a session whose events the emitter had to discard.
   *
   * The emitter reports the gap; only the host can answer it, because the answer
   * is a fenced snapshot. A session that has since closed gets nothing, which is
   * correct: there is no projection left to repair.
   */
  emitter.onGap((sessionId, droppedEvents) => {
    const host = sessions.get(sessionId)
    if (host === undefined) return
    diagnostics.record("warn", "session.stream", `resyncing after ${String(droppedEvents)} dropped events`)
    host.resync("gap")
  })
  emitter.onAttach((alreadyResynced, restoreProjection) => {
    // A replacement renderer document begins with no projection at all. Re-send
    // the small host/workspace baseline before the per-session snapshots so a
    // crash recovery returns to the workbench rather than the opening screen.
    emitter.emit("host_ready", { piVersion: VERSION })
    const activeWorkspace = activeWorkspaceId === undefined ? undefined : workspaces.get(activeWorkspaceId)
    if (restoreProjection && activeWorkspace !== undefined) {
      emitter.emit("workspace_changed", { workspace: activeWorkspace.workspace })
      void announceResources(activeWorkspace.workspace.id)
    }
    for (const [sessionId, host] of sessions) {
      if (!alreadyResynced.has(sessionId)) host.resync("reconnect")
    }
  })

  const gate = new ApprovalGate({ emitter, diagnostics, resolveContext: resolveApprovalContext })
  const extensionUi = new ExtensionUiGate(emitter)
  const approvalExtension = createApprovalExtension(gate)

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    // Trust has to reach Pi before its resource loader is built. The approval
    // gate also reads this store, but that is a separate boundary: it decides
    // whether a tool may run after a model asks for it, while project trust
    // decides whether repository-controlled settings, packages, skills and
    // extensions may load at all. The workspace's shared SettingsManager was
    // created with that trust before any session reaches this factory; making
    // another one here would default `projectTrusted` to true and let an
    // untrusted `.pi/extensions` module execute while the renderer is still
    // truthfully showing "untrusted".
    //
    // The inline approval extension below is host-supplied rather than a
    // project resource, so Pi keeps it in both trust states.
    const open = [...workspaces.values()].find((candidate) => candidate.workspace.root === cwd)
    if (open === undefined) throw new BakePiError("workspace_not_open", { detail: "session workspace" })
    const settingsManager = open.settingsManager
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      // The host's runtime, not a fresh one. `createAgentSessionServices` falls
      // back to `ModelRuntime.create()` when this is omitted, and that is not a
      // singleton — every session would get its own `RuntimeCredentials`. The
      // two runtimes read the same `auth.json`, so the split is invisible until
      // a credential lives only in memory: `setRuntimeApiKey` writes to an
      // override map (see `set_api_key`), so a key set through the host's
      // runtime would reach no session at all, and every prompt would fail
      // unauthenticated while `auth_changed` reported success. Model selection
      // and the catalog refresh have the same shape, for the same reason.
      modelRuntime,
      // The approval policy loads as an inline extension so it runs on Pi's
      // supported blocking `tool_call` path. See `policy/extension.ts` for why
      // this rather than `agent.beforeToolCall`, and for the load-order
      // reasoning that puts this handler last.
      resourceLoaderOptions: { extensionFactories: [approvalExtension] },
    })
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
      })),
      services,
      diagnostics: services.diagnostics,
    }
  }

  const requireWorkspace = (id: string): OpenWorkspace => {
    const open = workspaces.get(id)
    if (open === undefined) throw new BakePiError("workspace_not_open", { detail: id })
    return open
  }

  const requireSession = (id: string): SessionHost => {
    const session = sessions.get(id)
    if (session === undefined) throw new BakePiError("session_not_found", { detail: id })
    return session
  }

  /** Settings whose Pi runtime value is captured at construction are refreshed explicitly. */
  const syncLiveSettings = (workspaceId: string, manager: SettingsManager): void => {
    for (const host of sessions.values()) {
      if (host.workspaceId !== workspaceId) continue
      host.session.agent.steeringMode = manager.getSteeringMode()
      host.session.agent.followUpMode = manager.getFollowUpMode()
      host.session.agent.transport = manager.getTransport()
    }
  }

  /**
   * The gate on every command that appends to the session file.
   *
   * Reads are unaffected; only mutation is refused. See
   * `SessionHost.assertSoleWriter` for why this is a check rather than a lock,
   * and for the size of the window it does not close.
   */
  const requireWritableSession = (id: string): SessionHost => {
    const session = requireSession(id)
    session.assertSoleWriter()
    return session
  }

  /** Takes and attributes a session lock identically for new and adopted sessions. */
  const acquireSessionLock = (sessionFile: string): SessionLock => {
    const outcome = SessionLock.acquire(sessionFile, hostId)
    if (!outcome.acquired) {
      // Named where the holder could be read. A lock held by a host still
      // taking it has no holder to name yet, and reporting a pid nobody has is
      // worse than reporting none.
      const heldBy = outcome.heldBy
      throw new BakePiError("session_busy", {
        detail: heldBy === undefined ? "held by another Bake Pi host" : `held by pid ${String(heldBy.pid)}`,
      })
    }
    if (outcome.stoleFrom !== undefined) {
      // A host died holding this session. Not fatal — the lock is reclaimed —
      // but it is the only moment that fact is knowable, so it is recorded for
      // the crash-attribution work in `REC-002` and `REC-003`.
      diagnostics.capture("session.lock.stale", {
        sessionFile,
        previousHost: outcome.stoleFrom.hostId,
        previousPid: outcome.stoleFrom.pid,
      })
    }
    return outcome.lock
  }

  /**
   * Builds a host around a session manager, claiming the file before anything can
   * write through it.
   *
   * Every path that produces a session uses `acquireSessionLock`, so contention
   * and stale-holder attribution have one implementation. `adoptSession` probes
   * the file before acquiring and passes that lock in, because by the time a
   * `SessionManager` exists Pi has already opened and repaired the file.
   */
  const hostFor = async (
    workspaceId: string,
    open: OpenWorkspace,
    sessionManager: SessionManager,
    releaseAdmission: () => void,
    heldLock?: SessionLock,
  ): Promise<SessionHost> => {
    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: open.workspace.root,
      agentDir,
      sessionManager,
    })

    // Session construction yields inside Pi. The workspace may have closed
    // while it was building, and a late host must not resurrect ownership that
    // `close_workspace` already removed.
    if (!workspaces.has(workspaceId)) {
      runtime.session.dispose()
      throw new BakePiError("workspace_not_open", { detail: workspaceId })
    }

    // Claim the file before anything can write through it. A session with no
    // file is not persisted, so there is nothing to contend over and nothing to
    // lock.
    const sessionFile = runtime.session.sessionFile ?? undefined
    let lock: SessionLock | undefined = heldLock
    if (sessionFile !== undefined && lock === undefined) {
      try {
        lock = acquireSessionLock(sessionFile)
      } catch (error) {
        // Undo the session we just built rather than leaving an unowned one
        // attached to Pi.
        runtime.session.dispose()
        throw error
      }
    }

    const host = new SessionHost({
      runtime,
      emitter,
      diagnostics,
      workspaceId,
      workspaceRoot: open.workspace.root,
      trust: open.workspace.trust,
      ...(lock === undefined ? {} : { lock }),
      // Same condition as the lock, and for the same reason: both are files
      // beside the session file, and a session with no file has neither a
      // contender to exclude nor a place to leave evidence.
      ...(sessionFile === undefined ? {} : { toolMarker: new ToolMarker(sessionFile, hostId) }),
      pendingApprovals: (sessionId) => gate.pendingFor(sessionId),
    })
    sessions.set(host.sessionId, host)
    // The map now accounts for this session, so its in-flight claim would
    // double-count it. No command can interleave between these synchronous
    // operations, and the release is idempotent for the caller's `finally`.
    releaseAdmission()
    const assertStillOwned = (): void => {
      if (!workspaces.has(workspaceId)) {
        throw new BakePiError("workspace_not_open", { detail: workspaceId })
      }
      if (sessions.get(host.sessionId) !== host) {
        throw new BakePiError("session_not_found", { detail: host.sessionId })
      }
    }
    // Subscribed here rather than after `bindExtensions`, so a tool an
    // extension runs during the bind is already inside a span. The subscription
    // is bound to the `AgentSession` that exists now; Pi replaces that object on
    // fork, clone and import, and this host answers all three with
    // `not_implemented`, so there is no reachable path today that would leave it
    // listening to a session nobody is using. If one is added, it has to
    // re-subscribe the same way `SessionHost.resync("replacement")` does.
    turnSlots.set(host, recordTurnTimings(host.sessionId, runtime.session))

    try {
      // The SDK starts with print-mode's inert UI. Binding here is what turns a
      // loaded extension's blocking `ctx.ui.*` promise into a renderer request.
      // The host is already in the map and owns the file before `session_start`
      // runs, so a dialog can be answered while this bind is awaiting it and an
      // extension cannot mutate an unowned session.
      await runtime.session.bindExtensions({
        uiContext: extensionUi.contextFor(host.sessionId),
        mode: "rpc",
        onError: (error) => {
          diagnostics.capture("extension.hook", error)
          emitter.emit("extension_error", {
            extensionName: extensionNameFor(error.extensionPath),
            phase: error.event.includes("tool") ? "tool" : "hook",
            message: error.error.slice(0, 2048),
          })
        },
      })
      assertStillOwned()
      host.recordWrites()
      await announceResources(workspaceId)
      assertStillOwned()
    } catch (error) {
      // A close may have removed this host and a later adoption may already own
      // the same session id. Only clean up the registration that is still ours;
      // the close path already cancelled and timed a stale host.
      if (sessions.get(host.sessionId) === host) {
        extensionUi.cancelSession(host.sessionId)
        sessions.delete(host.sessionId)
        // The session was in `sessions` before this await, so a prompt could
        // have been accepted against it while the bind ran. `closeSession`
        // covers that case and is a no-op in the ordinary one.
        timings.closeSession(host.sessionId)
      }
      host.dispose()
      throw error
    }
    return host
  }

  /**
   * A new session in a workspace.
   *
   * The manager is created per session and never shared. One `SessionManager` is
   * one session id and one session file for its whole life, so reusing the
   * workspace's would make every session in that workspace the same session.
   */
  const startSession = async (workspaceId: string): Promise<SessionHost> => {
    const open = requireWorkspace(workspaceId)
    // Before Pi builds anything. A refusal after the runtime exists would have
    // already spent the memory the limit is there to protect, and would leave a
    // session to unwind.
    const releaseAdmission = capacity.reserveSession(sessions.size)
    try {
      return await hostFor(
        workspaceId,
        open,
        SessionManager.create(open.workspace.root, open.sessionDir),
        releaseAdmission,
      )
    } finally {
      releaseAdmission()
    }
  }

  const discoverSessions = async (workspaceId: string, open: OpenWorkspace): Promise<DiscoveredSession[]> => {
    const discovered = await listSessions(open.workspace.root, open.sessionDir)
    sessionPaths.set(workspaceId, new Map(discovered.map((session) => [session.id, session.path] as const)))
    return discovered
  }

  /**
   * Opens a session that already exists on disk.
   *
   * The order of the first three steps is the whole point and is not
   * rearrangeable:
   *
   * 1. **Probe the file.** Pi's load discards a torn final entry and terminates
   *    the fragment, which destroys the only evidence that anything was lost.
   *    After step 3 the question can no longer be asked.
   * 2. **Take the lock**, so no second host adopts the same file behind us.
   * 3. **Let Pi open it.**
   *
   * A torn session is still adopted rather than refused — the history before the
   * tear is intact and withholding it would help nobody — but the loss is
   * reported instead of passing in silence.
   */
  const adoptSession = async (sessionId: string): Promise<SessionHost> => {
    // Before the listing, and well before the lock. Refusing after the lock is
    // taken would leave the session unopenable by anyone until the stale-holder
    // check reclaimed it, which is a worse outcome than the refusal.
    const releaseAdmission = capacity.reserveSession(sessions.size)
    try {
      return await adoptReservedSession(sessionId, releaseAdmission)
    } finally {
      releaseAdmission()
    }
  }

  const adoptReservedSession = async (
    sessionId: string,
    releaseAdmission: () => void,
  ): Promise<SessionHost> => {
    // A listing streams and parses every entry in every session file. The first
    // adoption on a fresh host pays that authoritative scan and remembers only
    // its id-to-path result; restoring the next session must not scan the same
    // archive again. The target is still probed and fully opened from disk, and
    // a missing or mismatched header discards the hint and falls back to Pi's
    // listing, so a CLI move or replacement cannot attach the wrong session.
    for (const [workspaceId, open] of workspaces) {
      const cachedPath = sessionPaths.get(workspaceId)?.get(sessionId)
      if (cachedPath === undefined) continue
      const integrity = inspectSessionFile(cachedPath)
      if (integrity.exists && integrity.headerSessionId === sessionId) {
        return await adoptLocatedSession(sessionId, workspaceId, open, cachedPath, integrity, releaseAdmission)
      }
      sessionPaths.get(workspaceId)?.delete(sessionId)
    }

    for (const [workspaceId, open] of workspaces) {
      const found = (await discoverSessions(workspaceId, open)).find((candidate) => candidate.id === sessionId)
      if (found === undefined) continue
      return await adoptLocatedSession(
        sessionId,
        workspaceId,
        open,
        found.path,
        inspectSessionFile(found.path),
        releaseAdmission,
      )
    }

    throw new BakePiError("session_not_found", { detail: sessionId })
  }

  const adoptLocatedSession = async (
    sessionId: string,
    workspaceId: string,
    open: OpenWorkspace,
    path: string,
    integrity: ReturnType<typeof inspectSessionFile>,
    releaseAdmission: () => void,
  ): Promise<SessionHost> => {
    if (integrity.headerUnreadable) {
      // Pi would throw on this file. Refusing here makes it a contract error
      // carrying a path rather than an exception from inside the SDK, and
      // leaves the file untouched for a user who may recover it by hand.
      throw new BakePiError("internal_error", { detail: `unreadable session header: ${path}` })
    }
    const lostEntries = willLoseEntries(integrity)

    const lock = acquireSessionLock(path)

    // Read after the lock and before the new host exists, which is the only
    // window where a marker on disk is unambiguously a dead host's: taking the
    // lock proved no live host holds this session, and nothing of ours has
    // begun a tool yet. Reading it also removes it, so an interruption is
    // reported once rather than on every open forever.
    const interrupted = takeInterruptedTools(path)

    let host: SessionHost
    try {
      const manager = SessionManager.open(path, open.sessionDir)
      if (manager.getSessionId() !== sessionId) {
        sessionPaths.get(workspaceId)?.delete(sessionId)
        throw new BakePiError("session_not_found", { detail: sessionId })
      }
      host = await hostFor(
        workspaceId,
        open,
        manager,
        releaseAdmission,
        lock,
      )
    } catch (error) {
      // The lock must not outlive a failed adoption, or the session becomes
      // unopenable until the stale-holder check reclaims it.
      lock.release()
      throw error
    }

    for (const call of interrupted) {
      // Not fatal, and deliberately not a refusal to open. The session is
      // fine; the workspace is what may not be. Only the user can say whether
      // a half-finished write or a command that may have run twice matters,
      // and they cannot say it about a session they were not allowed to open.
      emitter.emit(
        "recoverable_error",
        {
          sessionId: host.sessionId,
          error: { code: "tool_interrupted", detail: describeInterruptedTool(call), retryable: false },
        },
        undefined,
      )
    }

    if (lostEntries) {
      // Recoverable by design: the session opens, and the user is told that the
      // last thing they saw before the crash is not in it.
      emitter.emit(
        "recoverable_error",
        {
          sessionId: host.sessionId,
          error: { code: "session_file_repaired", detail: path, retryable: false },
        },
        undefined,
      )
    }
    return host
  }

  const services: HostServices = {
    // ---- Runtime -----------------------------------------------------------

    get_runtime_info: async () => ({
      appVersion: process.env.BAKE_PI_VERSION ?? "0.0.0",
      piVersion: VERSION,
      ...(latestPiVersion === undefined ? {} : { latestPiVersion }),
      electronVersion: process.versions.electron ?? "unknown",
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    }),

    get_diagnostics: async ({ sinceId, limit }) => ({ entries: diagnostics.since(sinceId, limit) }),

    /**
     * The timing report.
     *
     * The arrays are re-wrapped rather than passed through because the store
     * hands out `readonly` views of its own freshly built arrays and the
     * contract's static type is mutable. It is a shallow copy on a command a
     * developer issues by hand, not a conversion: every element is already a
     * plain object of names, numbers and session ids the renderer already holds,
     * which is the property that makes this whole snapshot safe to send.
     * `sessions` needs one more level than the rest because its elements each
     * hold an array of their own.
     *
     * A command that arrived as a message is timed by `dispatch`, this one
     * included, and its span is still open while the snapshot is taken — so a
     * report shows `command.get_timings` open once and counts one fewer
     * completion than the number of times it has been asked. That is not an
     * off-by-one to fix: a span that closed before the work it measures would be
     * the bug. A handler reached by calling this map directly, which is what
     * every test that is not about the command leg does, is not timed at all,
     * because the span belongs to the leg and not to the handler.
     */
    get_timings: async () => {
      const snapshot = timings.snapshot()
      return {
        recent: [...snapshot.recent],
        aggregates: [...snapshot.aggregates],
        sessions: snapshot.sessions.map((session) => ({ sessionId: session.sessionId, turns: [...session.turns] })),
        open: [...snapshot.open],
        cost: snapshot.cost,
      }
    },

    shutdown: async () => {
      // Denied before the sessions go, so no tool call is left parked on a
      // decision that can no longer be delivered.
      gate.cancelAll()
      extensionUi.cancelAll()
      for (const session of sessions.values()) {
        timings.closeSession(session.sessionId)
        session.dispose()
      }
      sessions.clear()
      return { accepted: true }
    },

    // ---- Workspace ---------------------------------------------------------

    open_workspace: async ({ root, runtime }) => {
      assertWorkspaceRuntime(runtime)
      // Canonicalize before anything else records or compares this path. A
      // junction, a subst drive, or an 8.3 short name reaches us as a different
      // string for the same directory, and a trust decision keyed on the wrong
      // one applies to a directory the user never saw.
      const canonicalRoot = canonicalize(root)
      const existing = [...workspaces.values()].find((open) => open.workspace.root === canonicalRoot)
      if (existing !== undefined) {
        activeWorkspaceId = existing.workspace.id
        emitter.emit("workspace_changed", { workspace: existing.workspace })
        return { workspace: existing.workspace }
      }
      const foundRepository = await findGitRepository(canonicalRoot)
      const repository = foundRepository === undefined ? undefined : { root: canonicalize(foundRepository.root) }
      const decision = trustStore.get(canonicalRoot)
      const trust = resolveWorkspaceTrust({
        piTrusted: decision === true,
        remembered: permissions.remembered(canonicalRoot),
        fallback: permissions.defaultTrust(),
      })
      const workspace: Workspace = {
        id: randomUUID(),
        root: canonicalRoot,
        runtime,
        displayName: basename(canonicalRoot),
        trust,
        isGitRepository: repository !== undefined,
      }
      // Created only to ask Pi where this workspace's sessions live; the session
      // it represents is never written, because nothing prompts through it and Pi
      // persists nothing until an assistant message exists.
      // The resolved level rather than Pi's boolean, because the default may
      // have granted a project Pi has no record of — and a settings manager
      // that disagreed with `workspace.trust` would load project resources on a
      // different answer than the one the interface is showing.
      const settingsManager = SettingsManager.create(canonicalRoot, agentDir, {
        projectTrusted: trust !== "untrusted",
      })
      workspaces.set(workspace.id, {
        workspace,
        settingsManager,
        sessionDir: SessionManager.create(canonicalRoot, settingsManager.getSessionDir()).getSessionDir(),
        ...(repository === undefined ? {} : { repository }),
      })
      activeWorkspaceId = workspace.id
      emitter.emit("workspace_changed", { workspace })
      return { workspace }
    },

    close_workspace: async ({ id }) => {
      for (const [sessionId, session] of sessions) {
        if (session.workspaceId !== id) continue
        gate.cancelSession(sessionId)
        extensionUi.cancelSession(sessionId)
        timings.closeSession(sessionId)
        session.dispose()
        sessions.delete(sessionId)
      }
      workspaces.delete(id)
      sessionPaths.delete(id)
      if (activeWorkspaceId === id) activeWorkspaceId = undefined
      return {}
    },

    get_project_trust: async ({ id }) => ({ trust: requireWorkspace(id).workspace.trust }),

    get_default_trust: async () => ({ trust: permissions.defaultTrust() }),

    /**
     * Changes what an undecided workspace opens at, and nothing that is
     * already open: a level in force is a level the person can see on the
     * prompt bar, and moving it out from under a running session would change
     * what a tool call is allowed to do without the session saying so.
     */
    set_default_trust: async ({ trust }) => {
      permissions.setDefaultTrust(trust)
      return { trust: permissions.defaultTrust() }
    },

    /**
     * One directory of the workspace, for the file rail.
     *
     * Containment is decided here and nowhere else. The renderer names a path
     * and the host canonicalizes it first, because a junction, a subst drive or
     * a symlink under the root resolves somewhere the string never admitted —
     * the same reason `classifyTargets` canonicalizes before the approval
     * policy compares. A path that fails the check is refused rather than
     * clamped to the root: silently reading a different directory than the one
     * asked for is how a rail ends up showing a listing nobody requested.
     *
     * Symlinked *entries* are reported by the name they have in this directory
     * and are only followed if the user expands one, which routes back through
     * this same check. So the rail can never walk out of the workspace, however
     * the directory is linked.
     */
    list_directory: async ({ id, path }) => {
      const open = requireWorkspace(id)
      const root = open.workspace.root
      const target = path === undefined ? root : canonicalize(path)
      if (!isInside(root, target)) {
        // No path in the detail. The renderer already knows what it asked for,
        // and the answer to a containment failure should not carry the
        // canonical location the check just resolved.
        throw new BakePiError("path_outside_workspace", { detail: "outside the open workspace" })
      }

      let found
      try {
        found = await readdir(target, { withFileTypes: true })
      } catch (error) {
        throw new BakePiError("internal_error", { detail: "directory could not be read", cause: error })
      }

      const entries = found
        .map((entry) => ({
          name: entry.name,
          path: join(target, entry.name),
          // A symlink is drawn as whatever it is here rather than resolved now:
          // resolving would cost a stat per entry on a directory the user may
          // only be scrolling past, and expanding one canonicalizes anyway.
          kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
        }))
        // Directories first, then by name without regard to case — the order a
        // file tree is read in, rather than the order the filesystem returns.
        .sort((left, right) =>
          left.kind === right.kind
            ? left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
            : left.kind === "directory"
              ? -1
              : 1,
        )

      const limited = entries.slice(0, MAX_DIRECTORY_ENTRIES)
      const ignored = open.repository === undefined
        ? new Set<string>()
        : await ignoredByGit(open.repository, limited.map((entry) => entry.path))

      return {
        path: target,
        entries: limited.map((entry) => ({ ...entry, ignored: ignored.has(entry.path) })),
        truncated: entries.length > MAX_DIRECTORY_ENTRIES,
      }
    },

    set_project_trust: async ({ id, trust }) => {
      const open = requireWorkspace(id)
      // Written through Pi's store, so the decision is the same one the CLI
      // reads. A separate Bake Pi trust file would mean a project trusted in one
      // interface and prompting in the other, with no way for a user to tell why.
      // Pi's store is a boolean, so `full` is stored as trusted and the extra
      // step lives only in this host's memory — see `TrustLevel`.
      trustStore.set(open.workspace.root, trust !== "untrusted")
      // The step Pi's boolean rounds off. Recorded here rather than in the
      // store above so the two files are written from one decision, and read
      // back together by `resolveWorkspaceTrust` on the next open.
      permissions.remember(open.workspace.root, trust)
      open.settingsManager.setProjectTrusted(trust !== "untrusted")
      const workspace: Workspace = {
        ...open.workspace,
        trust,
        ...(trust !== "untrusted" ? { trustedAt: open.workspace.trustedAt ?? Date.now() } : {}),
      }
      workspaces.set(id, {
        ...open,
        workspace,
        sessionDir: SessionManager.create(open.workspace.root, open.settingsManager.getSessionDir()).getSessionDir(),
      })
      emitter.emit("workspace_changed", { workspace })
      await announceResources(id)
      return { workspace }
    },

    // ---- Session -----------------------------------------------------------

    list_sessions: async ({ workspaceId }) => {
      const open = requireWorkspace(workspaceId)
      // Disk is the authority: it holds every session in the workspace, not only
      // the ones this host happens to have attached. Live hosts are merged over
      // the top, because a session that has not yet reached disk — one with no
      // assistant message — exists only in memory, and one that has moved on
      // since the listing is described better by the host driving it.
      const discovered = await discoverSessions(workspaceId, open)
      const summaries = new Map(
        discovered.map((session) => [session.id, toSessionSummary(session, workspaceId)] as const),
      )
      for (const session of sessions.values()) {
        if (session.workspaceId !== workspaceId) continue
        const live = session.summary()
        const onDisk = summaries.get(session.sessionId)
        // Where both exist, disk wins on identity and the live host wins on
        // progress: the listing knows the name and the path, and only the host
        // knows how far the conversation has got since the listing was taken.
        summaries.set(
          session.sessionId,
          onDisk === undefined
            ? live
            : { ...onDisk, messageCount: live.messageCount, updatedAt: live.updatedAt },
        )
      }
      return { sessions: [...summaries.values()] }
    },

    create_session: async ({ workspaceId }) => ({ snapshot: (await startSession(workspaceId)).attach() }),

    new_session: async ({ workspaceId }) => ({ snapshot: (await startSession(workspaceId)).attach() }),

    open_session: async ({ sessionId }) => {
      // Already attached: re-attaching is a re-subscribe and a fresh snapshot,
      // not a second adoption. Adopting a file this host already holds would
      // refuse on its own lock.
      const attached = sessions.get(sessionId)
      if (attached !== undefined) return { snapshot: attached.attach() }
      return { snapshot: (await adoptSession(sessionId)).attach() }
    },

    fork_session: async () => notYet("fork_session"),
    clone_session: async () => notYet("clone_session"),
    navigate_tree: async () => notYet("navigate_tree"),

    compact_session: async ({ sessionId }) => {
      const host = requireWritableSession(sessionId)
      void host.session
        .compact()
        .catch((error: unknown) => {
          emitter.emit("recoverable_error", { sessionId, error: diagnostics.capture("compact_session", error) }, undefined)
        })
        .finally(() => host.recordWrites())
      return { started: true }
    },

    /**
     * The renderer noticed a gap the host could not: an event that failed its
     * schema check on arrival is dropped there and leaves a hole in the sequence
     * nothing on this side ever sees. Answering with a fenced snapshot costs one
     * projection and makes the question moot either way.
     */
    resync_session: async ({ sessionId }) => {
      requireSession(sessionId).resync("gap")
      return {}
    },

    close_session: async ({ sessionId }) => {
      const host = requireSession(sessionId)
      gate.cancelSession(sessionId)
      extensionUi.cancelSession(sessionId)
      // Before the dispose, because disposing removes the Pi subscription that
      // would have delivered `agent_settled` — after it, a turn in flight would
      // have no route to any ending at all. `closeSession` abandons that turn
      // rather than recording accept-to-close as if it were a turn duration,
      // which would put a fast fiction into every figure the report keeps.
      timings.closeSession(sessionId)
      host.dispose()
      sessions.delete(sessionId)
      return {}
    },

    // ---- Images ------------------------------------------------------------

    /**
     * The bytes behind one image block, answered to main's protocol handler
     * rather than to the renderer — see `commands/image.ts`.
     *
     * Pi already holds the image as base64 on the message part, so this is a
     * lookup and two checks rather than a read: the media type has to be one
     * the renderer agreed to draw, and the bytes have to fit the envelope. Both
     * were already true when the block was projected with a URL on it, and both
     * are checked again here because a projection is not an authorization —
     * this command's params arrive from a URL in a renderer fetch, and the only
     * thing standing between `messageIndex` and an arbitrary message is the
     * shape check below.
     */
    read_image: async ({ sessionId, messageIndex, blockIndex }) => {
      const message = requireSession(sessionId).session.messages[messageIndex]
      // Only a user message carries image parts, and only in array form: a
      // string `content` is a plain typed prompt with no attachments at all.
      const content = message?.role === "user" && typeof message.content !== "string" ? message.content : undefined
      const part = content?.[blockIndex]
      if (part?.type !== "image") throw new BakePiError("resource_not_found", { detail: "image_block" })
      const mediaType = renderableImageMediaType(part.mimeType)
      if (mediaType === undefined) throw new BakePiError("resource_not_found", { detail: "image_media_type" })
      if (decodedBase64Bytes(part.data) > MAX_IMAGE_BYTES) {
        throw new BakePiError("payload_too_large", { detail: "image" })
      }
      return { mediaType, data: part.data }
    },

    // ---- Prompt ------------------------------------------------------------

    prompt: async ({ sessionId, text, attachments }) => {
      const host = requireWritableSession(sessionId)
      capacity.admitWork()
      const session = host.session
      const processedAttachments = await processAttachments(host.workspaceRoot, attachments)
      // `prompt()` resolves only when the whole accepted run finishes, retries
      // included. Awaiting it here would hold the command channel open for the
      // length of a turn and make an abort impossible to deliver, so the run is
      // observed through the event stream instead.
      const preflight = beginPromptPreflight(host)
      const queued = session.isStreaming || preflight.followsAnother
      // Only a prompt that will wait is subject to the queue cap. One that runs
      // immediately is the turn, not a plan about a later one.
      let releaseQueue: (() => void) | undefined
      try {
        releaseQueue = queued
          ? capacity.reserveQueuedPrompt(sessionId, session.pendingMessageCount)
          : undefined
      } catch (error) {
        preflight.finish()
        throw error
      }
      const finishPreflight = (): void => {
        releaseQueue?.()
        preflight.finish()
      }
      try {
        if (preflight.waitForPrevious !== undefined) await preflight.waitForPrevious
        if (sessions.get(sessionId) !== host) {
          throw new BakePiError("session_not_found", { detail: sessionId })
        }
        // Attachment processing and an earlier prompt preflight both yield.
        // Recheck immediately before the operation that can append.
        host.assertSoleWriter()
      } catch (error) {
        finishPreflight()
        throw error
      }
      // The turn's accepted instant, and it is taken here rather than on Pi's
      // `agent_start` on purpose: the leg worth watching is the one a user is
      // waiting through, which includes whatever Pi does before the model is
      // asked anything. A prompt accepted while a turn is already streaming
      // re-anchors the span to itself, because the single `agent_settled` that
      // eventually arrives is the settle for *this* prompt — see `beginTurn`.
      // The cost is that the displaced turn is counted as abandoned rather than
      // measured, which the report says plainly.
      const slot = turnSlots.get(host)
      if (slot !== undefined) slot.turn = timings.beginTurn(sessionId)
      void session
        .prompt(promptWithAttachments(text, processedAttachments), {
          ...(processedAttachments.images.length === 0 ? {} : { images: processedAttachments.images }),
          // Harmless while Pi remains idle, and load-bearing when an awaited
          // extension hook lets another prompt start first: the prompt then
          // becomes a follow-up instead of being rejected and silently lost.
          streamingBehavior: "followUp",
          // Pi calls this after its awaited extension preflight. For a
          // follow-up that is after the message entered Pi's queue; for the
          // active turn it is immediately before Pi starts the run. That is
          // the point where Pi's state replaces our in-flight reservation.
          preflightResult: finishPreflight,
        })
        .catch((error: unknown) => {
          emitter.emit("recoverable_error", { sessionId, error: diagnostics.capture("prompt", error) }, undefined)
        })
        .finally(finishPreflight)
      return { accepted: true, queued }
    },

    /**
     * Steering and follow-up land in two different arrays inside Pi and in one
     * queue in the renderer, so the cap is applied to Pi's own combined count
     * rather than per array. A user looking at sixteen waiting messages does not
     * care which array holds them, and two caps of sixteen would be a cap of
     * thirty-two wearing a smaller number.
     *
     * The count is Pi's own combined count plus an in-flight reservation held
     * across attachment processing. Releasing after Pi's queue method resolves
     * transfers the same position from the reservation to Pi without a window
     * where neither side counts it. Reservations are per session, so a full
     * queue in one conversation has no effect on another.
     */
    steer: async ({ sessionId, text, attachments = [] }) => {
      const host = requireWritableSession(sessionId)
      capacity.admitWork()
      const releaseQueue = capacity.reserveQueuedPrompt(sessionId, host.session.pendingMessageCount)
      try {
        const processedAttachments = await processAttachments(host.workspaceRoot, attachments)
        if (sessions.get(sessionId) !== host) {
          throw new BakePiError("session_not_found", { detail: sessionId })
        }
        host.assertSoleWriter()
        await host.session.steer(
          promptWithAttachments(text, processedAttachments),
          processedAttachments.images.length === 0 ? undefined : processedAttachments.images,
        )
        return { accepted: true }
      } finally {
        releaseQueue()
      }
    },

    follow_up: async ({ sessionId, text, attachments = [] }) => {
      const host = requireWritableSession(sessionId)
      capacity.admitWork()
      const releaseQueue = capacity.reserveQueuedPrompt(sessionId, host.session.pendingMessageCount)
      try {
        const processedAttachments = await processAttachments(host.workspaceRoot, attachments)
        if (sessions.get(sessionId) !== host) {
          throw new BakePiError("session_not_found", { detail: sessionId })
        }
        host.assertSoleWriter()
        await host.session.followUp(
          promptWithAttachments(text, processedAttachments),
          processedAttachments.images.length === 0 ? undefined : processedAttachments.images,
        )
        return { queued: true }
      } finally {
        releaseQueue()
      }
    },

    abort: async ({ sessionId }) => {
      const host = requireSession(sessionId)
      const recovered = host.snapshot().queue
      extensionUi.cancelSession(sessionId)
      host.session.clearQueue()
      if (host.session.isCompacting) {
        host.session.abortCompaction()
        return { aborted: true, recovered }
      }
      await host.session.abort()
      return { aborted: true, recovered }
    },

    get_queue: async ({ sessionId }) => ({ queue: requireSession(sessionId).snapshot().queue }),

    // ---- Model -------------------------------------------------------------

    list_providers: async () => ({ providers: modelRuntime.getProviders().map(toProviderDto(modelRuntime)) }),

    list_models: async ({ providerId }) => ({
      models: modelRuntime.getModels(providerId).map(toModelDto),
    }),

    /**
     * Switching model mid-session.
     *
     * Three things about this are Pi's behavior rather than ours, and each one
     * shapes the handler:
     *
     * - `setModel` appends a `model_change` entry to the session file, so this
     *   is a mutating command. It goes through the write guard, and it
     *   re-records the fingerprint afterwards — no `agent_settled` is coming to
     *   do it, and without that the next prompt would refuse our own append as
     *   a foreign one.
     * - `setModel` throws a plain `Error` when the target provider has no
     *   credential. That is a state the renderer has a card for, so it becomes
     *   `provider_unauthenticated` rather than an `internal_error` with a
     *   stringified exception.
     * - `setModel` emits no session event. The thinking level it applies for the
     *   new model may emit one; `emitModelChanged` deduplicates the two into the
     *   single `model_changed` that actually describes the switch.
     */
    set_model: async ({ sessionId, providerId, modelId }) => {
      const host = requireWritableSession(sessionId)
      const model = modelRuntime.getModel(providerId, modelId)
      if (model === undefined) {
        throw new BakePiError("model_not_found", { detail: `${providerId}/${modelId}` })
      }

      try {
        await host.session.setModel(model)
      } catch (error) {
        if (!modelRuntime.hasConfiguredAuth(providerId)) {
          throw new BakePiError("provider_unauthenticated", { detail: providerId, cause: error })
        }
        throw error
      }

      host.recordWrites()
      host.emitModelChanged()
      return { selection: host.modelSelection() }
    },

    /**
     * The result reports what Pi settled on, not what was asked for. Pi clamps a
     * level to the model's supported set — `max` against a model that stops at
     * `high` leaves the session at `high`, and a model with no reasoning at all
     * leaves it at `off` — so returning the request would tell the renderer the
     * control worked when the session is running at something else.
     */
    set_thinking_level: async ({ sessionId, level }) => {
      const host = requireWritableSession(sessionId)
      host.session.setThinkingLevel(level)
      host.recordWrites()
      // Pi emits `thinking_level_changed` when the level actually moved, and the
      // subscription has already turned that into `model_changed`; this is the
      // clamped-to-no-change case, where the dedupe makes the call a no-op.
      host.emitModelChanged()
      return { selection: host.modelSelection() }
    },

    refresh_models: async () => {
      await modelRuntime.refresh()
      return { models: modelRuntime.getModels().map(toModelDto) }
    },

    // ---- Authentication ----------------------------------------------------

    get_auth_status: async () => ({ providers: modelRuntime.getProviders().map(toProviderDto(modelRuntime)) }),

    login: async () => notYet("login"),

    logout: async ({ providerId }) => {
      await modelRuntime.logout(providerId)
      const status = toAuthStatus(modelRuntime.getProviderAuthStatus(providerId))
      emitter.emit("auth_changed", { providerId, status })
      return { status }
    },

    set_api_key: async ({ providerId, apiKey }) => {
      // Held in Pi's runtime credential overlay for the life of this host, not
      // written to `auth.json`: `setRuntimeApiKey` sets an in-memory override
      // (`RuntimeCredentials`, "non-persistent runtime API keys" in Pi's own
      // words) and `synchronizeCredentialState` only recomposes the provider and
      // refreshes the catalog. Pi's persisting write is `CredentialStore.modify`,
      // and `ModelRuntime.credentials` is private, so there is no public path to
      // it — which is why `apiKeyPersistence` is false and why `logout` is
      // asymmetric with this: it reaches the store, and this does not.
      //
      // The key is never echoed back in a result or an event, and never written
      // to a Bake Pi file.
      await modelRuntime.setRuntimeApiKey(providerId, apiKey)
      const status = toAuthStatus(modelRuntime.getProviderAuthStatus(providerId))
      emitter.emit("auth_changed", { providerId, status })
      return { status, persisted: false }
    },

    // ---- Settings ----------------------------------------------------------

    get_pi_settings: async ({ workspaceId }) => {
      const open = requireWorkspace(workspaceId)
      const settings = await reloadPiSettings(open.settingsManager)
      syncLiveSettings(workspaceId, open.settingsManager)
      return { settings }
    },

    update_global_settings: async ({ workspaceId, patch }) => {
      const open = requireWorkspace(workspaceId)
      // Re-read first so a Pi CLI edit made while Settings was closed remains
      // the base of this field-level write. Pi's own setter then merges under
      // its file lock; Bake Pi never rewrites the settings document wholesale.
      await reloadPiSettings(open.settingsManager)
      const settings = await applyPiSettingsPatch(open.settingsManager, patch)
      syncLiveSettings(workspaceId, open.settingsManager)
      return { settings }
    },

    // ---- Resources ---------------------------------------------------------

    list_resources: async ({ workspaceId }) => ({ resources: await resourcesForWorkspace(workspaceId) }),

    reload_resources: async ({ workspaceId }) => {
      requireWorkspace(workspaceId)
      const attached = [...sessions.values()].filter((session) => session.workspaceId === workspaceId)

      // Reloading executes extension factories and session_start hooks. Refuse
      // while a turn is active rather than replacing the extension runtime in
      // the middle of one, and apply the same sole-writer guard as every other
      // command that can let an extension append to the session.
      for (const host of attached) {
        // `isIdle`, not `isStreaming`: the narrower flag missed a retry, an
        // auto-compaction, and a queued continuation, and a reload during any
        // of those replaces the extension runtime under a turn that is still
        // going. It is also the flag the sole-writer guard abstains on, so the
        // two now refuse and abstain over the same interval rather than leaving
        // a gap between them where neither applies.
        if (!host.session.isIdle) {
          throw new BakePiError("session_busy", { detail: host.sessionId, retryable: true })
        }
        host.assertSoleWriter()
      }
      for (const host of attached) {
        try {
          await host.session.reload()
        } finally {
          // A reload hook may append before a later hook fails. Record our own
          // writes even on that failure so the sole-writer guard does not
          // misreport them as a Pi CLI conflict on the next command.
          host.recordWrites()
        }
      }

      const resources = await resourcesForWorkspace(workspaceId)
      emitter.emit("resources_changed", { resources })
      return { resources }
    },
    check_resource_updates: async ({ workspaceId }) => {
      const updates = await packageManagerForWorkspace(workspaceId).checkForAvailableUpdates()
      // Package sources can contain private registry URLs or git credentials.
      // Pi needs those sources to update; the renderer only needs safe labels.
      return { updates: updates.map(({ displayName, type, scope }) => ({ displayName, type, scope })) }
    },
    update_resources: async ({ workspaceId }) => {
      const attached = reloadableSessions()
      await packageManagerForWorkspace(workspaceId).update()
      await reloadSessions(attached)

      const resources = await resourcesForWorkspace(workspaceId)
      emitter.emit("resources_changed", { resources })
      return { resources }
    },
    enable_resource: async () => notYet("enable_resource"),
    disable_resource: async () => notYet("disable_resource"),

    // ---- Extension UI and approvals ---------------------------------------

    respond_select: async ({ requestId, value }) => ({ accepted: extensionUi.respondSelect(requestId, value) }),
    respond_confirm: async ({ requestId, confirmed }) => ({
      accepted: extensionUi.respondConfirm(requestId, confirmed),
    }),
    respond_input: async ({ requestId, value }) => ({ accepted: extensionUi.respondInput(requestId, value) }),
    respond_editor: async ({ requestId, text }) => ({ accepted: extensionUi.respondEditor(requestId, text) }),
    /**
     * A decision for a request that no longer exists returns `accepted: false`
     * rather than throwing. It is what a late click on an expired or cancelled
     * card looks like, and the gate has already denied that call — reporting a
     * failure would describe the wrong thing to the user.
     */
    respond_tool_approval: async ({ requestId, decision }) => ({
      accepted: gate.respond(requestId, decision),
    }),
  }

  return {
    services,
    piVersion: VERSION,
    features: await detectFeatures(),
  }
}

const toProviderDto =
  (runtime: ModelRuntime) =>
  (provider: { id: string; name?: string }): ProviderDto => ({
    id: provider.id,
    displayName: provider.name ?? provider.id,
    authStatus: toAuthStatus(runtime.getProviderAuthStatus(provider.id)),
    supportedAuth: ["api_key"],
  })

/**
 * A Pi model, as the renderer's selector needs it.
 *
 * The capability fields were hard-coded false until model selection existed to
 * consume them, and a selector built on that would have hidden the thinking
 * control on every model that supports thinking. They are read from Pi's own
 * catalog entry now. `supportsToolCalls` stays true because Pi's catalog does
 * not carry the fact — every model it exposes to the coding agent is expected
 * to call tools — and claiming otherwise would be a guess in the other
 * direction.
 */
const toModelDto = (model: PiCatalogModel): ModelDto => ({
  id: model.id,
  providerId: model.provider,
  displayName: model.name ?? model.id,
  ...(model.contextWindow > 0 ? { contextWindowTokens: model.contextWindow } : {}),
  ...(model.maxTokens > 0 ? { maxOutputTokens: model.maxTokens } : {}),
  supportsThinking: model.reasoning,
  supportsVision: model.input.includes("image"),
  supportsToolCalls: true,
})

const extensionNameFor = (extensionPath: string): string =>
  (extensionPath.startsWith("<")
    ? extensionPath.replaceAll(/[<>]/g, "")
    : basename(extensionPath).replace(/\.(?:ts|js)$/, "")
  ).slice(0, 128)

/**
 * The half of Pi's `Model` this mapping reads. Declared structurally rather than
 * imported, because the type lives in `@earendil-works/pi-ai` and pulling that
 * in would put a second Pi package in this workspace's manifest — the boundary
 * `scripts/boundaries.test.ts` exists to hold.
 */
interface PiCatalogModel {
  id: string
  provider: string
  name?: string
  reasoning: boolean
  input: readonly ("text" | "image")[]
  contextWindow: number
  maxTokens: number
}

/**
 * Pi's auth status, as Pi actually reports it.
 *
 * `ModelRuntime.getProviderAuthStatus` returns a record, not a string:
 * `{ configured, source?, label? }`. This mapper previously switched on string
 * literals, so it matched nothing and every provider came back `unknown` — a
 * value the renderer would have built its whole login surface on. Nothing caught
 * it, because reading a real `ModelRuntime` is exactly what a unit test of this
 * file cannot do; `test/vertical-slice.test.ts` is what found it.
 *
 * The shape is declared here rather than imported because Pi exports the type
 * from an internal module, not from the package index. If it changes, the
 * mapping falls back to `unknown` rather than lying.
 */
interface PiAuthStatus {
  configured: boolean
  source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command"
}

const toAuthStatus = (status: unknown): AuthStatus => {
  if (typeof status !== "object" || status === null || !("configured" in status)) return "unknown"
  const { configured, source } = status as PiAuthStatus
  if (configured !== true) return "unauthenticated"
  switch (source) {
    // Resolved from the environment. Bake Pi shows it and does not manage it:
    // there is no credential of ours to revoke, and offering a logout for one
    // would be a control that silently does nothing.
    case "environment":
      return "environment"
    case "stored":
    case "runtime":
    case "fallback":
    case "models_json_key":
    case "models_json_command":
      return "authenticated"
    default:
      // Configured by a means this version does not model. Saying so is better
      // than claiming a specific one.
      return "unknown"
  }
}

/**
 * `expired` is deliberately unreachable. Pi's status does not distinguish an
 * expired OAuth credential from a present one — it reports what is configured,
 * not whether it still works — and the only honest report of a stale token is
 * the failure of the request that used it. Synthesizing `expired` here would be
 * a guess wearing a state name.
 */

/**
 * Feature flags are measured, not assumed.
 *
 * The renderer decides what to offer from these, so a flag that is optimistic
 * produces a control that fails when used — which is worse than one that was
 * never shown. Every flag here has a measurement behind it, and each one names
 * the test or document that measured it, so a Pi upgrade that changes the
 * answer changes a failing test rather than only this literal.
 */
const detectFeatures = async (): Promise<FeatureFlags> => ({
  // The flag asks whether a key can be *persisted* through a public path, and
  // it cannot. `setRuntimeApiKey` is public but writes only an in-memory
  // override; the persisting write is `CredentialStore.modify`, reachable only
  // through `ModelRuntime`'s private `credentials` field or a deep import into
  // `dist/core/auth-storage.ts`, which is not part of the package's exports.
  // Measured by `session/credentials.test.ts`. A key therefore survives until
  // the host restarts and no longer, which is what the renderer must not
  // promise otherwise. Closing this needs a public path from Pi (`CMD-008`).
  apiKeyPersistence: false,
  // The flag asks whether telemetry has an off switch, and it does:
  // `SettingsManager.setEnableInstallTelemetry(false)`, persisted to
  // `<agentDir>/settings.json` and durable across a restart of the host. It is
  // opt-out rather than opt-in, which is exactly why the renderer needs to know
  // the control exists. See `session/telemetry.test.ts`. That the switch is
  // public is not the same claim as telemetry being off or as egress being
  // verified; the Milestone 5 half of `SEC-003` stays open.
  telemetryOptOut: true,
  // True as of Pi 0.85.0, and this is a claim about ordering rather than about
  // the hook existing: Pi appends inline extensions after every file-based one
  // and returns on the first handler that blocks, so Bake Pi's policy observes
  // the arguments a tool will actually run with and cannot be skipped by an
  // earlier extension. `policy/extension.ts` records where that was read from.
  policyHookOrdering: true,
  // Measured false, and it is the dangerous kind of false. Pi takes no lock at
  // all: a second writer is never refused, bytes are never corrupted, and the
  // session tree silently forks so that one writer's turns stay on disk but
  // leave the active branch. Nothing reports it. Bake Pi has to enforce a single
  // writer itself. See `session/durability.test.ts`.
  sessionFileLocking: false,
  // True on Windows because it was measured there, and false elsewhere because
  // it was not. `scripts/orphans.ts` drives the real topology — Electron main, a
  // utility process, a tool, and a process that tool started — and shows the
  // supervisor's kill takes all of it, alongside the counterfactual that proves
  // the ordering is what does it rather than the operating system. Off Windows
  // the guarantee is known to be weaker rather than merely unmeasured: Pi spawns
  // tools `detached: true` there, putting each in its own process group, which
  // the supervisor's group kill does not reach.
  processTreeCleanup: process.platform === "win32",
  // False, and now for a recorded reason rather than by default: RPC mode has no
  // command for tool approval, project trust, credentials, or resource
  // enable/disable, so the fallback is unavailable precisely where a fallback
  // would be needed. See `docs/reference/pi-rpc-support.md`.
  rpcFallback: false,
})

const notYet = (command: string): never => {
  throw new BakePiError("internal_error", { detail: `not_implemented:${command}` })
}

/**
 * What a base64 string weighs decoded, without decoding it.
 *
 * Four characters carry three bytes, and the one or two `=` at the end each
 * stand for a byte that is not there. Allocating the buffer to measure it would
 * be the allocation the ceiling exists to refuse.
 */
const decodedBase64Bytes = (data: string): number => {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0
  return Math.floor(data.length / 4) * 3 - padding
}

const assertWorkspaceRuntime = (runtime: WorkspaceRuntime): void => {
  if (runtime.kind === "windows") {
    if (process.platform !== "win32") {
      throw new BakePiError("host_unavailable", { detail: "workspace_runtime_mismatch", retryable: false })
    }
    return
  }
  const actual = process.env.WSL_DISTRO_NAME
  if (process.platform !== "linux" || actual?.toLocaleLowerCase("en-US") !== runtime.distro.toLocaleLowerCase("en-US")) {
    throw new BakePiError("host_unavailable", { detail: "workspace_runtime_mismatch", retryable: false })
  }
}
