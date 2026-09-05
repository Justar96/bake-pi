import {
  type Attachment,
  type CommandParams,
  type CommandResult,
  type ContractError,
  type DirectoryEntry,
  type EventPayload,
  type ExtensionUiRequest,
  type HostConnectionNotice,
  type Model,
  type PiSettingsPatch,
  type PiSettingsSnapshot,
  type Provider,
  type QueuedPrompt,
  type RendererCommandName,
  type Resource,
  type SessionSnapshot,
  type SessionStatus,
  type SessionSummary,
  type Workspace,
  sameWorkspaceRuntime,
} from "@bake-pi/contract"
import { EventStream, type StreamEvent } from "./stream.ts"
import { StreamBatcher } from "./stream-batcher.ts"
import { MutableView, type ReadableView } from "./readable-view.ts"
import { SessionProjection, type SessionCore } from "./session-projection.ts"
import {
  forgetWorkspaceSession,
  rememberedWorkspaceSession,
  rememberWorkspaceSession,
} from "./preferences.ts"

export type ConnectionState =
  | { status: "connecting" }
  | { status: "connected"; piVersion: string; latestPiVersion?: string; runtime?: CommandResult<"get_runtime_info"> }
  | { status: "disconnected"; error?: ContractError }

/** One directory as the rail receives it: what was read, and whether that was all of it. */
export interface Listing {
  entries: DirectoryEntry[]
  truncated: boolean
}

export type ExtensionError = EventPayload<"extension_error">

/**
 * The statuses an interrupt lives inside.
 *
 * These two are what the Stop button and the timeline's word are drawn for, so
 * they are also what releases them. Anything else — idle, disconnected,
 * quarantined — means the turn a person stopped is over, whether or not the
 * abort's own response has arrived yet.
 */
const TURN_IN_FLIGHT = new Set<SessionStatus>(["streaming", "compacting"])

export interface AppState {
  connection: ConnectionState
  workspace: Workspace | undefined
  sessionList: SessionSummary[]
  activeSessionId: string | undefined
  /** Renderer-local command state; the session itself does not exist until Pi returns its snapshot. */
  sessionStarting: boolean
  /**
   * Which session has an abort in flight, if any.
   *
   * Renderer-local for the same reason `sessionStarting` is: Pi has no status
   * between "streaming" and whatever the turn settles as, because from the
   * host's side there is nothing between them — the abort either lands or the
   * turn was already over. From a person's side there is: the round trip they
   * are waiting through, which used to be spent watching a spinner over the
   * word `working` and a Stop button that took the click and said nothing.
   *
   * An id rather than a flag, so stopping one tab does not report the next one
   * as stopping too.
   *
   * It is released by the session leaving `streaming`/`compacting`, not by the
   * command answering. Those are two different moments: the response says the
   * abort was delivered, the status says the turn is actually over, and they
   * travel different transports — events go straight to the renderer while a
   * response is relayed through main. Clearing on the response therefore risks
   * showing `stopping` and then `working` again for however long the status
   * takes to catch up, which is the interface arguing with itself about
   * something the person already decided.
   */
  abortingSessionId: string | undefined
  providers: Provider[]
  models: Model[]
  resources: Resource[]
  attachments: Attachment[]
  extensionRequest: ExtensionUiRequest | undefined
  extensionErrors: ExtensionError[]
  notices: ContractError[]
}

export interface ShellView {
  connection: ConnectionState
  workspace: Workspace | undefined
}

export interface WorkbenchView extends AppState {
  sessions: Record<string, SessionCore>
}

export interface RendererViews {
  shell: ReadableView<ShellView>
  workbench: ReadableView<WorkbenchView>
  session: (sessionId: string) => SessionProjection | undefined
}

declare global {
  interface Window {
    bakePi: {
      commands: {
        [N in RendererCommandName]: (params: CommandParams<N>) => Promise<CommandResult<N>>
      }
      onHostConnection: (handler: (notice: HostConnectionNotice) => void) => void
    }
  }
}

/**
 * One command facade over explicit renderer views and pure reducers.
 *
 * The compatibility AppState remains private to command methods and focused
 * tests. React consumes `views`: a streamed block can therefore publish the
 * active timeline without replacing the workbench's snapshot or waking every
 * rail, tab, tray, and control above it.
 */
export class SessionStore {
  #state: AppState = {
    connection: { status: "connecting" },
    workspace: undefined,
    sessionList: [],
    activeSessionId: undefined,
    sessionStarting: false,
    abortingSessionId: undefined,
    providers: [],
    models: [],
    resources: [],
    attachments: [],
    extensionRequest: undefined,
    extensionErrors: [],
    notices: [],
  }
  #sessionCores: Record<string, SessionCore> = {}
  readonly #projections = new Map<string, SessionProjection>()
  #connectionGeneration = 0
  #workspaceGeneration = 0
  #currentWorkspace: Workspace | undefined
  #resumeSessionId: string | undefined
  #workspaceCommandPending = false
  #workspaceChange: Promise<void> = Promise.resolve()
  #catalogRefresh: { generation: number; promise: Promise<void> } | undefined
  #sessionStart: Promise<SessionSnapshot> | undefined
  readonly #sessionOpens = new Map<string, Promise<CommandResult<"open_session">>>()
  // Navigation belongs to the person's latest action, not the last command to
  // answer. Background sessions still attach and stream without taking focus.
  #selectionGeneration = 0
  readonly #stream = new EventStream()
  readonly #events = new StreamBatcher((event) => this.#applyEvent(event))
  readonly #shell = new MutableView<ShellView>(shellOf(this.#state))
  readonly #workbench = new MutableView<WorkbenchView>(workbenchOf(this.#state, this.#sessionCores))
  readonly views: RendererViews = {
    shell: this.#shell,
    workbench: this.#workbench,
    session: (sessionId) => this.#projections.get(sessionId),
  }

  constructor() {
    window.bakePi.onHostConnection((notice) => {
      if (notice.status === "connecting") {
        this.#connectionGeneration += 1
        this.#patch({ connection: { status: "connecting" } })
        return
      }

      this.#connectionGeneration += 1
      this.#stream.disconnect()
      for (const projection of this.#projections.values()) projection.disconnect()
      this.#sessionCores = Object.fromEntries(
        [...this.#projections.entries()].map(([sessionId, projection]) => [
          sessionId,
          projection.view("core").getSnapshot(),
        ]),
      )
      this.#patch({
        connection: { status: "disconnected", ...(notice.error === undefined ? {} : { error: notice.error }) },
      })
    })

    window.addEventListener("message", (event) => {
      if (event.source !== window || event.data !== "bakepi:event-port") return
      const port = event.ports[0]
      if (port === undefined) return
      this.#connectionGeneration += 1
      this.#stream.connect(port)
      this.#patch({ connection: { status: "connected", piVersion: "" } })
      this.#loadRuntimeInfo()
    })

    /**
     * A gap the stream detected against itself, which the host cannot see.
     *
     * Two things happen, and both are necessary. The projection is flagged, so
     * the interface says history is incomplete rather than showing a plausible
     * timeline with a hole in it; and a snapshot is requested, because a flag
     * that never clears is only half an answer. If the request fails the flag
     * stands, which is the honest end state — the session is still incomplete.
     */
    this.#stream.onGap((sessionId, dropped) => {
      const projection = this.#projections.get(sessionId)
      if (projection !== undefined) {
        projection.apply("stream_gap", { sessionId, droppedEvents: dropped })
        this.#syncCore(sessionId, projection)
      }
      void this.send("resync_session", { sessionId }).catch(() => {
        // Nothing to escalate to yet. The flag above is what the user sees, and
        // it stays set until a snapshot clears it.
      })
    })

    this.#stream.subscribe((event) => this.#events.push(event))
  }

  #applyEvent(event: StreamEvent): void {
      if (event.name === "host_ready") {
        const { piVersion } = event.payload as { piVersion: string }
        const previous = this.#state.connection
        this.#patch({
          connection: {
            status: "connected",
            piVersion,
            ...(previous.status === "connected" && previous.latestPiVersion !== undefined
              ? { latestPiVersion: previous.latestPiVersion }
              : {}),
          },
        })
        this.#loadRuntimeInfo()
        return
      }
      if (event.name === "pi_update_available") {
        const { currentVersion, latestVersion } = event.payload as { currentVersion: string; latestVersion: string }
        const current = this.#state.connection
        if (current.status === "connected" && (current.piVersion === "" || current.piVersion === currentVersion)) {
          this.#patch({ connection: { ...current, piVersion: currentVersion, latestPiVersion: latestVersion } })
        }
        return
      }
      if (event.name === "host_shutting_down" || event.name === "fatal_error") {
        this.#connectionGeneration += 1
        this.#patch({ connection: { status: "disconnected" } })
        return
      }
      if (event.name === "workspace_changed") {
        const { workspace } = event.payload as { workspace: Workspace }
        const current = this.#currentWorkspace
        if (current === undefined) {
          this.#replaceWorkspace(workspace)
        } else if (sameWorkspaceRuntime(current.runtime, workspace.runtime) && current.root === workspace.root) {
          // Workspace ids belong to one host generation. A recovered host gives
          // the same canonical root a new id; keep the visible projections and
          // move only the handle future commands must use.
          if (current.id !== workspace.id) {
            this.#workspaceGeneration += 1
            this.#sessionStart = undefined
            this.#catalogRefresh = undefined
            this.#sessionOpens.clear()
          }
          this.#currentWorkspace = workspace
          this.#patch({ workspace })
        } else if (!this.#workspaceCommandPending) {
          // Re-attachment has no command response for the renderer to adopt.
          // During an explicit open, however, the event precedes that response
          // and must not erase the previous workspace before it is closed.
          this.#replaceWorkspace(workspace)
        }
        return
      }
      if (event.name === "session_list_changed") {
        const { sessions } = event.payload as { sessions: SessionSummary[] }
        const workspaceId = this.#currentWorkspace?.id
        if (workspaceId !== undefined && sessions.every((session) => session.workspaceId === workspaceId)) {
          this.#patch({ sessionList: sessions })
        }
        return
      }
      if (event.name === "providers_changed") {
        const { providers } = event.payload as { providers: Provider[] }
        this.#patch({ providers })
        return
      }
      if (event.name === "resources_changed") {
        const { resources } = event.payload as { resources: Resource[] }
        this.#patch({ resources })
        return
      }
      if (event.name === "auth_changed") {
        const { providerId, status } = event.payload as { providerId: string; status: Provider["authStatus"] }
        this.#patch({
          providers: this.#state.providers.map((provider) =>
            provider.id === providerId ? { ...provider, authStatus: status } : provider,
          ),
        })
        return
      }
      if (event.name === "recoverable_error") {
        const { error } = event.payload as { error: ContractError }
        this.#patch({ notices: [...this.#state.notices.slice(-2), error] })
        return
      }
      if (event.name === "extension_error") {
        const error = event.payload as ExtensionError
        this.#patch({ extensionErrors: [...this.#state.extensionErrors.slice(-7), error] })
        return
      }
      if (event.name === "extension_ui_requested") {
        const { request } = event.payload as { request: ExtensionUiRequest }
        this.#patch({ extensionRequest: request })
        return
      }
      if (event.name === "extension_ui_resolved") {
        const { requestId } = event.payload as EventPayload<"extension_ui_resolved">
        if (this.#state.extensionRequest?.id === requestId) this.#patch({ extensionRequest: undefined })
        return
      }

      const sessionId = event.sessionId
      if (sessionId === undefined) return

      if (event.name === "session_snapshot") {
        const { snapshot } = event.payload as { snapshot: SessionSnapshot }
        if (snapshot.summary.workspaceId !== this.#currentWorkspace?.id) return
      }

      let projection = this.#projections.get(sessionId)
      if (projection === undefined && event.name === "session_snapshot") {
        projection = new SessionProjection((event.payload as { snapshot: SessionSnapshot }).snapshot)
        this.#projections.set(sessionId, projection)
      } else if (projection !== undefined) {
        projection.apply(event.name, event.payload)
      }
      // An event for a session with no baseline has nothing to apply to. It is
      // dropped; the snapshot that follows attach is what establishes state.
      if (projection === undefined) return

      const coresChanged = this.#syncCore(sessionId, projection)

      const partial: Partial<AppState> = {
        ...(event.name === "session_summary_changed"
          ? { sessionList: upsertSummary(this.#state.sessionList, (event.payload as { summary: SessionSummary }).summary) }
          : event.name === "session_snapshot"
            ? { sessionList: upsertSummary(this.#state.sessionList, (event.payload as { snapshot: SessionSnapshot }).snapshot.summary) }
            : {}),
        // The end of an interrupt is the turn ending, which is a status and
        // not a command response. Read after `#syncCore`, so this is the
        // status the event just produced rather than the one before it.
        ...(this.#state.abortingSessionId === sessionId && !TURN_IN_FLIGHT.has(this.#sessionCores[sessionId]?.snapshot.status ?? "idle")
          ? { abortingSessionId: undefined }
          : {}),
        ...(event.name === "session_snapshot" && this.#selectionGeneration === 0
          && (this.#state.activeSessionId === undefined || sessionId === this.#resumeSessionId)
          && this.#state.activeSessionId !== sessionId
          ? { activeSessionId: sessionId }
          : {}),
      }
      // A delta changes neither the shell nor the workbench: it moves a block
      // inside one session, and that publishes through the projection's own
      // views. Nothing else feeds `shellOf` or `workbenchOf`, so with no state
      // to merge and no core replaced there is nothing either view could have
      // moved to — and this is the branch every token of every turn takes.
      if (coresChanged || Object.keys(partial).length > 0) this.#patch(partial)
      if (event.name === "session_snapshot") {
        if (sessionId === this.#resumeSessionId) this.#resumeSessionId = undefined
        void this.#refreshModelCatalog().catch((error: unknown) => this.capture(error))
      }
  }

  #loadRuntimeInfo(): void {
    if (this.#state.connection.status !== "connected") return
    const generation = this.#connectionGeneration
    void this.send("get_runtime_info", {}).then(
      (runtime) => {
        const current = this.#state.connection
        if (current.status !== "connected" || this.#connectionGeneration !== generation) return
        this.#patch({
          connection: {
            ...current,
            piVersion: runtime.piVersion,
            runtime,
            ...(runtime.latestPiVersion === undefined ? {} : { latestPiVersion: runtime.latestPiVersion }),
          },
        })
      },
      () => {
        // The host may restart between port delivery and this optional detail
        // read. Connection state already says what the user needs to act on.
      },
    )
  }

  /**
   * Re-reads the catalog after a session has loaded its extensions.
   *
   * Extension providers do not exist in Pi's shared ModelRuntime until the
   * first session binds those extensions. The workspace's initial catalog read
   * therefore cannot see them. Coalescing keeps a host restore with several
   * session snapshots from issuing the same two reads once per session.
   */
  #refreshModelCatalog(): Promise<void> {
    const generation = this.#workspaceGeneration
    if (this.#catalogRefresh?.generation === generation) return this.#catalogRefresh.promise
    const refresh = Promise.all([
      this.send("get_auth_status", {}),
      this.send("list_models", {}),
    ]).then(([{ providers }, { models }]) => {
      if (generation !== this.#workspaceGeneration) return
      this.#patch({ providers, models })
    }).finally(() => {
      if (this.#catalogRefresh?.promise === refresh) this.#catalogRefresh = undefined
    })
    this.#catalogRefresh = { generation, promise: refresh }
    return refresh
  }

  getSnapshot = (): AppState => this.#state

  /**
   * The only way the renderer reaches privilege. Typed against the contract, so
   * a command name that does not exist, or params of the wrong shape, is a
   * compile error rather than a validation failure at the far end.
   */
  async send<N extends RendererCommandName>(name: N, params: CommandParams<N>): Promise<CommandResult<N>> {
    const command = window.bakePi.commands[name]
    return await command(params)
  }

  async chooseWorkspace(startAt?: string): Promise<Workspace | undefined> {
    return await this.#openWorkspace(async () =>
      (await this.send("choose_workspace", startAt === undefined ? {} : { startAt })).workspace,
    )
  }

  async reopenRecentWorkspace(id?: string): Promise<Workspace | undefined> {
    return await this.#openWorkspace(async () =>
      (await this.send("reopen_recent_workspace", id === undefined ? {} : { id })).workspace,
    )
  }

  async createWorkspace(params: CommandParams<"create_workspace">): Promise<Workspace> {
    const workspace = await this.#openWorkspace(async () => (await this.send("create_workspace", params)).workspace)
    if (workspace === undefined) throw new Error("workspace creation returned no workspace")
    return workspace
  }

  /** Leaves the workbench for the launch screen. Sessions stay on disk where Pi keeps them. */
  async closeWorkspace(): Promise<void> {
    await this.#queueWorkspaceChange(async () => {
      const workspace = this.#currentWorkspace
      if (workspace === undefined) return
      await this.send("close_workspace", { id: workspace.id })
      if (this.#currentWorkspace?.id !== workspace.id) return
      this.#workspaceGeneration += 1
      this.#currentWorkspace = undefined
      this.#resumeSessionId = undefined
      this.#sessionStart = undefined
      this.#catalogRefresh = undefined
      this.#clearWorkspaceState(undefined)
    })
  }

  async #openWorkspace(open: () => Promise<Workspace | undefined>): Promise<Workspace | undefined> {
    return await this.#queueWorkspaceChange(async () => {
      this.#workspaceCommandPending = true
      try {
        const workspace = await open()
        if (workspace === undefined) return undefined
        await this.#adoptWorkspace(workspace)
        return workspace
      } finally {
        this.#workspaceCommandPending = false
      }
    })
  }

  #queueWorkspaceChange<T>(change: () => Promise<T>): Promise<T> {
    const queued = this.#workspaceChange.then(change)
    this.#workspaceChange = queued.then(() => undefined, () => undefined)
    return queued
  }

  async #adoptWorkspace(workspace: Workspace): Promise<void> {
    const previous = this.#currentWorkspace
    if (previous !== undefined && previous.id !== workspace.id && sameWorkspaceRuntime(previous.runtime, workspace.runtime)) {
      try {
        await this.send("close_workspace", { id: previous.id })
      } catch (error) {
        // Opening already happened in main. Roll it back so a failed switch
        // does not leave two workspace session sets alive behind one window.
        await this.send("close_workspace", { id: workspace.id }).catch(() => undefined)
        throw error
      }
    }
    this.#replaceWorkspace(workspace)
    const generation = this.#workspaceGeneration
    const selection = this.#selectionGeneration
    const sessions = await this.#refreshWorkspace(workspace, generation)
    // Restoring a preference is a fallback, never a later navigation action.
    // A person may already have selected a session while the archive was read.
    if (!this.#ownsWorkspace(workspace, generation) || selection !== this.#selectionGeneration) return
    const sessionId = rememberedWorkspaceSession(workspace)
    if (sessionId === undefined) return
    if (!sessions.some((session) => session.id === sessionId && session.workspaceId === workspace.id)) {
      forgetWorkspaceSession(workspace)
      this.#resumeSessionId = undefined
      return
    }
    try {
      await this.#openSession(sessionId, workspace, generation)
    } catch (error) {
      // The workspace itself opened successfully. A session may be locked by
      // the CLI or damaged; keep the rail usable and report that failure rather
      // than turning it into a failed workspace switch.
      if (this.#ownsWorkspace(workspace, generation)) this.capture(error)
    }
  }

  async #refreshWorkspace(workspace: Workspace, generation: number): Promise<SessionSummary[]> {
    const [{ sessions }, { providers }, { models }, { resources }] = await Promise.all([
      this.send("list_sessions", { workspaceId: workspace.id }),
      this.send("get_auth_status", {}),
      this.send("list_models", {}),
      this.send("list_resources", { workspaceId: workspace.id }).catch((error: unknown) => {
        if (this.#ownsWorkspace(workspace, generation)) this.capture(error)
        return { resources: [] }
      }),
    ])
    if (!this.#ownsWorkspace(workspace, generation)) return []
    this.#patch({ sessionList: sessions, providers, models, resources })
    return sessions
  }

  async reloadResources(): Promise<void> {
    const workspace = this.#state.workspace
    if (workspace === undefined) return
    const { resources } = await this.send("reload_resources", { workspaceId: workspace.id })
    this.#patch({ resources })
    await this.#refreshModelCatalog()
  }

  async checkResourceUpdates(): Promise<CommandResult<"check_resource_updates">["updates"]> {
    const workspace = this.#state.workspace
    if (workspace === undefined) return []
    return (await this.send("check_resource_updates", { workspaceId: workspace.id })).updates
  }

  async updateResources(): Promise<void> {
    const workspace = this.#state.workspace
    if (workspace === undefined) return
    const { resources } = await this.send("update_resources", { workspaceId: workspace.id })
    this.#patch({ resources })
    await this.#refreshModelCatalog()
  }

  async getPiSettings(): Promise<PiSettingsSnapshot> {
    const workspace = this.#state.workspace
    if (workspace === undefined) throw new Error("no workspace is open")
    return (await this.send("get_pi_settings", { workspaceId: workspace.id })).settings
  }

  async updateGlobalSettings(patch: PiSettingsPatch): Promise<PiSettingsSnapshot> {
    const workspace = this.#state.workspace
    if (workspace === undefined) throw new Error("no workspace is open")
    return (await this.send("update_global_settings", { workspaceId: workspace.id, patch })).settings
  }

  async decideTrust(trust: Workspace["trust"]): Promise<Workspace> {
    const workspace = this.#state.workspace
    if (workspace === undefined) throw new Error("no workspace is open")
    const result = await this.send("set_project_trust", { id: workspace.id, trust })
    this.#patch({ workspace: result.workspace })
    return result.workspace
  }

  /**
   * The level a workspace nobody has decided on opens at.
   *
   * Read from the host on demand rather than kept in this projection: it is
   * settings-modal state, no event carries it, and a copy here would be a
   * second answer to a question the host already answers. Nothing about the
   * open workspace changes when it moves — the host applies it at the next
   * open — so there is nothing to patch.
   */
  async getDefaultTrust(): Promise<Workspace["trust"]> {
    return (await this.send("get_default_trust", {})).trust
  }

  async setDefaultTrust(trust: Workspace["trust"]): Promise<Workspace["trust"]> {
    return (await this.send("set_default_trust", { trust })).trust
  }

  async authenticate(providerId: string, apiKey: string): Promise<void> {
    const { status } = await this.send("set_api_key", { providerId, apiKey })
    await this.#adoptAuthStatus(providerId, status)
  }

  async logout(providerId: string): Promise<void> {
    const { status } = await this.send("logout", { providerId })
    await this.#adoptAuthStatus(providerId, status)
  }

  /**
   * What follows any credential change, stated once.
   *
   * Signing in and signing out differ only in the command that produced the
   * status; both then have to re-read the catalogue, because which models a
   * provider offers is a function of whether it is authenticated. Two copies
   * of this meant a change to the refresh — clearing a stale selection, say —
   * would have applied to one of them.
   */
  async #adoptAuthStatus(providerId: string, status: Provider["authStatus"]): Promise<void> {
    const providers = this.#state.providers.map((provider) =>
      provider.id === providerId ? { ...provider, authStatus: status } : provider,
    )
    const { models } = await this.send("list_models", { providerId })
    this.#patch({ providers, models: mergeModels(this.#state.models, models) })
  }

  async createSession(): Promise<SessionSnapshot> {
    return await this.#startSession("create_session")
  }

  async openSession(sessionId: string): Promise<SessionSnapshot> {
    const workspace = this.#currentWorkspace
    if (workspace === undefined) throw new Error("no workspace is open")
    const generation = this.#workspaceGeneration
    return await this.#openSession(sessionId, workspace, generation)
  }

  async #openSession(sessionId: string, workspace: Workspace, generation: number): Promise<SessionSnapshot> {
    const selection = this.#beginSelection()
    const existing = this.#projections.get(sessionId)
    if (existing !== undefined) {
      if (this.#ownsWorkspace(workspace, generation)) this.#activateSession(sessionId)
      return existing.state().snapshot
    }
    let opening = this.#sessionOpens.get(sessionId)
    if (opening === undefined) {
      const request = this.send("open_session", { sessionId }).finally(() => {
        if (this.#sessionOpens.get(sessionId) === request) this.#sessionOpens.delete(sessionId)
      })
      this.#sessionOpens.set(sessionId, request)
      opening = request
    }
    const { snapshot } = await opening
    if (this.#ownsWorkspace(workspace, generation) && snapshot.summary.workspaceId === workspace.id) {
      this.#installSnapshot(snapshot, selection === this.#selectionGeneration)
      await this.#refreshModelCatalog()
    }
    return snapshot
  }

  /**
   * Detaches a session and picks what the tab strip shows next.
   *
   * The host is told first and the projection follows, because closing is the
   * one mutation whose failure a person must see: a tab that vanished from a
   * session the host still holds open would leave the session running with no
   * way back to it.
   *
   * The replacement is the neighbour rather than the first tab. Closing a tab
   * is a way of getting out of the way of the one beside it, and jumping to the
   * other end of the strip is not what anyone was reaching for.
   */
  async closeSession(sessionId: string): Promise<void> {
    const workspace = this.#currentWorkspace
    const generation = this.#workspaceGeneration
    if (this.#state.activeSessionId === sessionId) this.#beginSelection()
    await this.send("close_session", { sessionId })
    if (workspace === undefined || !this.#ownsWorkspace(workspace, generation)) return
    this.#projections.delete(sessionId)
    const { [sessionId]: closedCore, ...sessionCores } = this.#sessionCores
    void closedCore
    this.#sessionCores = sessionCores
    const open = this.#state.sessionList.filter((session) => this.#projections.has(session.id))
    const index = this.#state.sessionList.findIndex((session) => session.id === sessionId)
    const neighbour = open.find((session) => this.#state.sessionList.indexOf(session) > index) ?? open.at(-1)
    if (this.#state.activeSessionId === sessionId) {
      this.#patch({ activeSessionId: neighbour?.id })
      if (neighbour === undefined) forgetWorkspaceSession(workspace)
      else rememberWorkspaceSession(workspace, neighbour.id)
    } else {
      this.#patch({})
    }
  }

  /**
   * One directory of the workspace, for the file rail.
   *
   * Deliberately not stored. A listing is a read of the filesystem at an
   * instant, not a projection of anything the host holds — keeping it here
   * would be a second source of truth for something with no truth to be second
   * about, and it would go stale the moment a tool wrote a file. The rail holds
   * what it has expanded and asks again when it needs to.
   *
   * `truncated` travels with the entries rather than being dropped here. A
   * directory past the cap is listed in part, and a rail that showed the part
   * without saying so would be claiming a directory holds what fits.
   */
  async listDirectory(path?: string): Promise<Listing> {
    const workspace = this.#state.workspace
    if (workspace === undefined) return { entries: [], truncated: false }
    const { entries, truncated } = await this.send("list_directory", { id: workspace.id, ...(path === undefined ? {} : { path }) })
    return { entries, truncated }
  }

  selectSession(sessionId: string): void {
    if (this.#projections.has(sessionId)) {
      this.#beginSelection()
      this.#activateSession(sessionId)
    }
    else void this.openSession(sessionId).catch((error: unknown) => this.capture(error))
  }

  async chooseAttachments(): Promise<void> {
    const workspace = this.#state.workspace
    if (workspace === undefined) return
    const { attachments } = await this.send("choose_attachments", {
      workspaceRoot: workspace.root,
      runtime: workspace.runtime,
    })
    if (attachments.length > 0) this.#patch({ attachments })
  }

  clearAttachments(): void {
    this.#patch({ attachments: [] })
  }

  /**
   * Drop one attachment rather than all of them.
   *
   * Renderer-local, and allowed to be: `attachments` is the pending result of a
   * native picker, not a projection of anything Pi holds. It becomes Pi's the
   * moment `prompt` carries it, and is cleared in the same breath.
   */
  removeAttachment(path: string): void {
    this.#patch({ attachments: this.#state.attachments.filter((attachment) => attachment.path !== path) })
  }

  async submitPrompt(text: string, mode: "prompt" | "steer" | "follow_up" = "prompt"): Promise<void> {
    const sessionId = this.#state.activeSessionId
    if (sessionId === undefined) throw new Error("no session is active")
    if (mode === "steer") await this.send("steer", { sessionId, text, attachments: this.#state.attachments })
    else if (mode === "follow_up") await this.send("follow_up", { sessionId, text, attachments: this.#state.attachments })
    else await this.send("prompt", { sessionId, text, attachments: this.#state.attachments })
    this.clearAttachments()
  }

  async abortActive(): Promise<QueuedPrompt[]> {
    const sessionId = this.#state.activeSessionId
    if (sessionId === undefined) return []
    // One abort per session at a time, refused here rather than by disabling
    // the button that sends it. A control that goes dead until a command
    // answers is a control a hung abort strands, and this is the only place
    // every caller — button, shortcut, a future one — has to pass through. The
    // queue a second call would report is empty anyway: the first one recovered
    // it, and the draft it went into is the copy that matters.
    if (this.#state.abortingSessionId === sessionId) return []
    this.#patch({ abortingSessionId: sessionId })
    try {
      const { recovered } = await this.send("abort", { sessionId })
      return recovered
    } catch (error) {
      // Nothing was stopped, so nothing is stopping. Success deliberately does
      // not clear this; the status leaving the turn does, in `#applyEvent`.
      if (this.#state.abortingSessionId === sessionId) this.#patch({ abortingSessionId: undefined })
      throw error
    }
  }

  /**
   * Asks Pi to summarize the conversation so far, which is a request rather
   * than a result: `started` is all the command answers with, and the count of
   * what was removed arrives later as `compaction_finished`. Nothing is patched
   * here for the same reason — the snapshot that replaces the history is the
   * host's to send.
   */
  async compactSession(): Promise<boolean> {
    const sessionId = this.#state.activeSessionId
    if (sessionId === undefined) return false
    const { started } = await this.send("compact_session", { sessionId })
    return started
  }

  /** A fresh session in the same workspace; the host detaches the current one. */
  async newSession(): Promise<SessionSnapshot> {
    return await this.#startSession("new_session")
  }

  /**
   * Shows the new-session surface before the utility process finishes loading
   * Pi, without fabricating a session projection or identifier in the renderer.
   */
  #startSession(command: "create_session" | "new_session"): Promise<SessionSnapshot> {
    const workspace = this.#currentWorkspace
    if (workspace === undefined) throw new Error("no workspace is open")
    if (this.#sessionStart !== undefined) return this.#sessionStart
    const generation = this.#workspaceGeneration
    const selection = this.#beginSelection()

    this.#patch({ sessionStarting: true })
    const start = this.send(command, { workspaceId: workspace.id }).then(({ snapshot }) => {
      if (this.#ownsWorkspace(workspace, generation) && snapshot.summary.workspaceId === workspace.id) {
        this.#installSnapshot(snapshot, selection === this.#selectionGeneration)
      }
      return snapshot
    }).finally(() => {
      if (this.#sessionStart !== start) return
      this.#sessionStart = undefined
      if (this.#state.sessionStarting) this.#patch({ sessionStarting: false })
    })
    this.#sessionStart = start
    return start.then(async (snapshot) => {
      if (this.#ownsWorkspace(workspace, generation)) await this.#refreshModelCatalog()
      return snapshot
    })
  }

  /**
   * Branches the conversation at a message, which is the only way to try a
   * different direction without losing the one already taken.
   *
   * The message has to be named, and the caller names it — the last one, in
   * practice, because that is where a person is standing when they decide the
   * next answer should go elsewhere. Defaulting to it here instead would make
   * the command mean something different once the timeline gains a per-message
   * fork, and the contract has carried `atMessageId` from the start.
   */
  async forkSession(atMessageId: string): Promise<SessionSnapshot> {
    const sessionId = this.#state.activeSessionId
    if (sessionId === undefined) throw new Error("no session is active")
    const workspace = this.#currentWorkspace
    if (workspace === undefined) throw new Error("no workspace is open")
    const generation = this.#workspaceGeneration
    const selection = this.#beginSelection()
    const { snapshot } = await this.send("fork_session", { sessionId, atMessageId })
    if (this.#ownsWorkspace(workspace, generation) && snapshot.summary.workspaceId === workspace.id) {
      this.#installSnapshot(snapshot, selection === this.#selectionGeneration)
      await this.#refreshModelCatalog()
    }
    return snapshot
  }

  async setModel(providerId: string, modelId: string): Promise<void> {
    if (this.#state.activeSessionId === undefined) return
    await this.send("set_model", { sessionId: this.#state.activeSessionId, providerId, modelId })
  }

  async setThinking(level: SessionSnapshot["model"]["thinkingLevel"]): Promise<void> {
    if (this.#state.activeSessionId === undefined) return
    await this.send("set_thinking_level", { sessionId: this.#state.activeSessionId, level })
  }

  async decideApproval(requestId: string, decision: "allow_once" | "allow_for_session" | "deny"): Promise<void> {
    await this.send("respond_tool_approval", { requestId, decision })
  }

  async restartHost(): Promise<void> {
    await this.send("restart_host", {})
  }

  dismissNotice(index: number): void {
    this.#patch({ notices: this.#state.notices.filter((_notice, current) => current !== index) })
  }

  capture(error: unknown): void {
    if (typeof error !== "object" || error === null || !("code" in error)) return
    this.#patch({ notices: [...this.#state.notices.slice(-2), error as ContractError] })
  }

  #replaceWorkspace(workspace: Workspace): void {
    this.#workspaceGeneration += 1
    this.#currentWorkspace = workspace
    this.#resumeSessionId = rememberedWorkspaceSession(workspace)
    // These promises may still settle, but no longer belong to the visible
    // workspace. Their generation checks keep their results out of this state;
    // clearing the slots lets the new workspace start its own work immediately.
    this.#sessionStart = undefined
    this.#catalogRefresh = undefined
    this.#clearWorkspaceState(workspace)
  }

  #clearWorkspaceState(workspace: Workspace | undefined): void {
    this.#selectionGeneration = 0
    this.#sessionOpens.clear()
    this.#projections.clear()
    this.#sessionCores = {}
    this.#patch({
      workspace,
      sessionList: [],
      activeSessionId: undefined,
      sessionStarting: false,
      resources: [],
      attachments: [],
      extensionErrors: [],
      notices: [],
    })
  }

  #ownsWorkspace(workspace: Workspace, generation: number): boolean {
    return generation === this.#workspaceGeneration && this.#currentWorkspace?.id === workspace.id
  }

  #beginSelection(): number {
    this.#resumeSessionId = undefined
    return ++this.#selectionGeneration
  }

  #activateSession(sessionId: string): void {
    this.#patch({ activeSessionId: sessionId })
    const workspace = this.#currentWorkspace
    if (workspace !== undefined) rememberWorkspaceSession(workspace, sessionId)
  }

  #installSnapshot(snapshot: SessionSnapshot, activate: boolean): void {
    let projection = this.#projections.get(snapshot.summary.id)
    if (projection === undefined) {
      projection = new SessionProjection(snapshot)
      this.#projections.set(snapshot.summary.id, projection)
    }
    // Attach emits its snapshot on the event port as well as in the command
    // reply. If the port won, that projection may already contain later tokens
    // or approvals: replaying the slower reply would erase them and rebuild the
    // whole timeline. Subsequent snapshots replace state through the ordered
    // event intake; the command snapshot only supplies a missing baseline.
    this.#syncCore(snapshot.summary.id, projection)
    this.#patch({ sessionList: upsertSummary(this.#state.sessionList, projection.state().snapshot.summary) })
    if (activate) this.#activateSession(snapshot.summary.id)
  }

  /** Reports whether the map was replaced, which is what makes the workbench view stale. */
  #syncCore(sessionId: string, projection: SessionProjection): boolean {
    const core = projection.view("core").getSnapshot()
    if (this.#sessionCores[sessionId] === core) return false
    this.#sessionCores = { ...this.#sessionCores, [sessionId]: core }
    return true
  }

  /**
   * StreamBatcher is the only frame boundary. Once it delivers a batch, each
   * affected named view publishes immediately; a second scheduler here would
   * turn a one-frame token path into a possible two-frame path.
   */
  #patch(partial: Partial<AppState>): void {
    this.#state = { ...this.#state, ...partial }
    const shell = shellOf(this.#state)
    const previousShell = this.#shell.getSnapshot()
    if (shell.connection !== previousShell.connection || shell.workspace !== previousShell.workspace) {
      this.#shell.publish(shell)
    }

    const workbench = workbenchOf(this.#state, this.#sessionCores)
    if (!sameWorkbench(workbench, this.#workbench.getSnapshot())) this.#workbench.publish(workbench)
  }
}

const upsertSummary = (sessions: SessionSummary[], summary: SessionSummary): SessionSummary[] =>
  [...sessions.filter((session) => session.id !== summary.id), summary].sort((left, right) => right.updatedAt - left.updatedAt)

const mergeModels = (current: Model[], next: Model[]): Model[] => {
  const keys = new Set(next.map((model) => `${model.providerId}\0${model.id}`))
  return [...current.filter((model) => !keys.has(`${model.providerId}\0${model.id}`)), ...next]
}

const shellOf = (state: AppState): ShellView => ({ connection: state.connection, workspace: state.workspace })

const workbenchOf = (state: AppState, sessions: Record<string, SessionCore>): WorkbenchView => ({
  connection: state.connection,
  workspace: state.workspace,
  sessions,
  sessionList: state.sessionList,
  activeSessionId: state.activeSessionId,
  sessionStarting: state.sessionStarting,
  abortingSessionId: state.abortingSessionId,
  providers: state.providers,
  models: state.models,
  resources: state.resources,
  attachments: state.attachments,
  extensionRequest: state.extensionRequest,
  extensionErrors: state.extensionErrors,
  notices: state.notices,
})

/**
 * Every field of the view is a reference `workbenchOf` copied straight across,
 * so equality is identity on each key. Comparing by key rather than by a
 * hand-written list means a field added to `AppState` is compared without
 * anyone remembering to add a line here — the failure that list had was silent:
 * a forgotten field simply stopped publishing.
 */
const sameWorkbench = (left: WorkbenchView, right: WorkbenchView): boolean =>
  (Object.keys(left) as (keyof WorkbenchView)[]).every((key) => left[key] === right[key])

export const store = new SessionStore()
