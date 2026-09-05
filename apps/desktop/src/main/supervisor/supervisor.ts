import { randomUUID } from "node:crypto"
import type { MessagePortMain } from "electron"
import {
  BakePiError,
  type CommandName,
  type CommandParams,
  type CommandResult,
  type HelloAck,
  type HostConnectionNotice,
  WINDOWS_RUNTIME,
  type WorkspaceRuntime,
  type WorkspaceTarget,
  sameWorkspaceRuntime,
} from "@bake-pi/contract"
import { NO_SHUTDOWN, type ShutdownTimings } from "./shutdown.ts"
import { toContractError } from "../errors.ts"
import { RestartBudget } from "./health.ts"
import { RecoveryLedger, formatCommandLatency, type CommandLatency } from "./recovery.ts"

export interface HostLauncher {
  readonly running: boolean
  readonly starting: boolean
  start(): Promise<HelloAck>
  send<N extends CommandName>(name: N, params: CommandParams<N>): Promise<CommandResult<N>>
  attachEventChannel(deliver: (channel: RendererEventChannel) => void, restoreProjection?: boolean): void | Promise<void>
  stop(): Promise<ShutdownTimings>
}

export type RendererEventChannel =
  | { kind: "message_port"; port: MessagePortMain }
  | { kind: "websocket"; url: string }

export interface RendererEndpoint {
  available(): boolean
  announce(notice: HostConnectionNotice): void
  deliverEventChannel(channel: RendererEventChannel): void
}

export interface HostLauncherHooks {
  onUnexpectedExit(code: number): void
  quarantinedSessions(): string[]
  onPhase(phase: "forked" | "acked"): void
}

export interface HostSupervisorOptions {
  createLauncher(runtime: WorkspaceRuntime, hooks: HostLauncherHooks): HostLauncher
  renderer: RendererEndpoint
  onWorkspaceClosed?: (id: string) => void
  budget?: RestartBudget
  clock?: () => number
  nextId?: () => string
  onPhase?: (phase: "forked" | "acked") => void
  log?: Pick<Console, "error" | "log">
}

export interface CommandTiming {
  arrivedAt?: number
}

/**
 * The one main-process owner of host generations, recovery, and recorded
 * command dispatch.
 *
 * Electron remains behind HostLauncher and RendererEndpoint. The supervisor
 * never sees a session event; crash attribution is still derived exclusively
 * from validated commands, preserving the direct host-to-renderer hot path.
 */
export class HostSupervisor {
  readonly #options: HostSupervisorOptions
  readonly #budget: RestartBudget
  readonly #ledger: RecoveryLedger
  readonly #clock: () => number
  readonly #nextId: () => string
  readonly #log: Pick<Console, "error" | "log">
  #launcher: HostLauncher | undefined
  #runtime: WorkspaceRuntime | undefined
  #generation = 0
  #recoveryEnabled = false
  #stopping = false
  #startPromise: Promise<HelloAck> | undefined
  #stopPromise: Promise<ShutdownTimings> | undefined

  constructor(options: HostSupervisorOptions) {
    this.#options = options
    this.#budget = options.budget ?? new RestartBudget()
    this.#clock = options.clock ?? (() => performance.now())
    this.#ledger = new RecoveryLedger(this.#clock)
    this.#nextId = options.nextId ?? randomUUID
    this.#log = options.log ?? console
  }

  get running(): boolean {
    return this.#launcher?.running === true
  }

  get commandLatency(): CommandLatency[] {
    return this.#ledger.commandLatency
  }

  get openSessions(): string[] {
    return this.#ledger.openSessions
  }

  get quarantinedSessions(): string[] {
    return this.#ledger.quarantinedSessions
  }

  get runtime(): WorkspaceRuntime | undefined {
    return this.#runtime
  }

  start(): Promise<HelloAck> {
    if (this.#startPromise !== undefined) return this.#startPromise
    if (this.#launcher?.running === true) {
      throw new BakePiError("host_unavailable", { detail: "host_already_started", retryable: true })
    }
    return this.#launch(WINDOWS_RUNTIME, [], false)
  }

  async execute<N extends CommandName>(
    name: N,
    params: CommandParams<N>,
    timing: CommandTiming = {},
  ): Promise<CommandResult<N>> {
    const launcher = this.#launcher
    if (launcher?.running !== true) throw new BakePiError("host_unavailable", { retryable: true })
    return await this.#sendRecorded(launcher, name, params, timing)
  }

  /** Opens a root in its owning runtime, replacing the host when that runtime changes. */
  async openWorkspace(target: WorkspaceTarget): Promise<CommandResult<"open_workspace">> {
    if (this.#launcher?.running === true && this.#runtime !== undefined && sameWorkspaceRuntime(this.#runtime, target.runtime)) {
      return await this.execute("open_workspace", target)
    }

    const previous = this.#launcher
    try {
      this.#stopping = true
      ++this.#generation
      try {
        if (previous?.running === true || previous?.starting === true) await previous.stop()
      } finally {
        if (this.#launcher === previous) this.#launcher = undefined
        this.#stopping = false
      }

      this.#budget.reset()
      this.#ledger.resetRuntime()
      await this.#launch(target.runtime, [], false)
      const result = await this.execute("open_workspace", target)
      await this.attachRenderer({ reason: "runtime_switch" })
      return result
    } catch (error) {
      this.#options.renderer.announce({ status: "disconnected", error: toContractError(error) })
      throw error
    }
  }

  async attachRenderer(options: {
    reason: "initial" | "reload" | "renderer_recovery" | "runtime_switch"
  }): Promise<void> {
    if (options.reason === "initial") this.#recoveryEnabled = true
    const launcher = this.#launcher
    if (launcher?.running !== true || !this.#options.renderer.available()) return
    await launcher.attachEventChannel(
      (channel) => this.#options.renderer.deliverEventChannel(channel),
      options.reason === "renderer_recovery",
    )
  }

  async restart(): Promise<CommandResult<"restart_host">> {
    this.#stopping = true
    ++this.#generation
    try {
      if (this.#launcher?.running === true || this.#launcher?.starting === true) await this.#launcher.stop()
    } finally {
      this.#stopping = false
    }
    this.#budget.reset()
    await this.#launch(this.#runtime ?? WINDOWS_RUNTIME, this.#ledger.openSessions, true)
    return { started: true, quarantined: this.#ledger.quarantinedSessions }
  }

  stop(): Promise<ShutdownTimings> {
    this.#stopPromise ??= this.#performStop().finally(() => {
      this.#stopPromise = undefined
    })
    return this.#stopPromise
  }

  async #performStop(): Promise<ShutdownTimings> {
    this.#stopping = true
    this.#recoveryEnabled = false
    ++this.#generation
    const launcher = this.#launcher
    if (launcher === undefined) return NO_SHUTDOWN
    try {
      return await launcher.stop()
    } finally {
      if (this.#launcher === launcher) this.#launcher = undefined
    }
  }

  #launch(runtime: WorkspaceRuntime, restore: readonly string[], attachAfterRestore: boolean): Promise<HelloAck> {
    const generation = ++this.#generation
    let launcher!: HostLauncher
    launcher = this.#options.createLauncher(runtime, {
      onUnexpectedExit: (code) => this.#onUnexpectedExit(generation, launcher, code),
      quarantinedSessions: () => this.#ledger.quarantinedSessions,
      onPhase: (phase) => this.#options.onPhase?.(phase),
    })
    this.#launcher = launcher
    this.#runtime = runtime
    this.#options.renderer.announce({ status: "connecting" })

    const start = (async (): Promise<HelloAck> => {
      const ack = await launcher.start()
      if (!this.#owns(generation, launcher)) throw new BakePiError("host_unavailable", { retryable: true })
      await this.#restore(generation, launcher, runtime, restore)
      if (attachAfterRestore && this.#owns(generation, launcher) && this.#options.renderer.available()) {
        await launcher.attachEventChannel((channel) => this.#options.renderer.deliverEventChannel(channel), true)
      }
      return ack
    })()
    const tracked = start.finally(() => {
      if (this.#startPromise === tracked) this.#startPromise = undefined
    })
    this.#startPromise = tracked
    return tracked
  }

  #onUnexpectedExit(generation: number, launcher: HostLauncher, code: number): void {
    if (!this.#owns(generation, launcher) || this.#stopping) return
    this.#options.renderer.announce({
      status: "disconnected",
      error: { code: "host_unavailable", retryable: true },
    })
    this.#log.error(`[main] agent host exited with code ${String(code)}`)
    this.#log.error(`[main] command latency up to the exit\n${formatCommandLatency(this.#ledger.commandLatency)}`)

    // A launcher invokes this callback before rejecting pending sends. The plan
    // therefore consumes the only crash-attribution evidence before command
    // promises can settle and erase it.
    const plan = this.#ledger.planRestart({ budgetRemains: this.#budget.record() })
    if (plan.quarantined.length > 0) {
      this.#log.error(`[main] quarantined after crash: ${plan.quarantined.join(", ")}`)
    }
    if (plan.mode !== "automatic") {
      this.#log.error(`[main] not restarting automatically: ${plan.reason}`)
      return
    }
    if (!this.#recoveryEnabled) return
    void this.#launch(this.#runtime ?? WINDOWS_RUNTIME, plan.restore, true).catch((error: unknown) => {
      // A newer generation owns the visible state and reports its own result.
      if (generation + 1 !== this.#generation) return
      this.#log.error("[main] automatic host restart failed", error)
      this.#options.renderer.announce({ status: "disconnected", error: toContractError(error) })
    })
  }

  async #restore(
    generation: number,
    launcher: HostLauncher,
    runtime: WorkspaceRuntime,
    sessionIds: readonly string[],
  ): Promise<void> {
    // Workspaces first: a session restored into no workspace has nothing to
    // open against. The two passes differ only in what they send and what they
    // record on failure — the ownership check before, the ownership re-check
    // after, and the swallow are identical, and were worth stating once so a
    // change to generation handling cannot land in one loop and miss the other.
    // `<T,>` rather than `<T>`: the import-boundary test scans every source with
    // Bun's tsx loader, which reads a bare type parameter as a JSX tag.
    const restoreEach = async <T,>(
      items: readonly T[],
      command: (item: T) => readonly [CommandName, object],
      noteFailed: (item: T) => void,
      describe: (item: T) => string,
    ): Promise<boolean> => {
      for (const item of items) {
        if (!this.#owns(generation, launcher)) return false
        const [name, params] = command(item)
        try {
          await this.#sendRecorded(launcher, name, params as never, {}, () => this.#owns(generation, launcher))
        } catch (error) {
          if (!this.#owns(generation, launcher)) return false
          noteFailed(item)
          this.#log.error(`[main] could not restore ${describe(item)}`, error)
        }
      }
      return true
    }

    const owned = await restoreEach(
      this.#ledger.openWorkspaceRoots,
      (root) => ["open_workspace", { root, runtime }],
      (root) => { this.#ledger.noteWorkspaceRestoreFailed(root) },
      (root) => `workspace ${root}`,
    )
    if (!owned) return

    await restoreEach(
      sessionIds,
      (sessionId) => ["open_session", { sessionId }],
      (sessionId) => { this.#ledger.noteRestoreFailed(sessionId) },
      (sessionId) => `session ${sessionId}`,
    )
  }

  async #sendRecorded<N extends CommandName>(
    launcher: HostLauncher,
    name: N,
    params: CommandParams<N>,
    timing: CommandTiming = {},
    acceptResult: () => boolean = () => true,
  ): Promise<CommandResult<N>> {
    const id = this.#nextId()
    this.#ledger.noteSent(id, name, params, timing)
    try {
      const result = await launcher.send(name, params)
      const accepted = acceptResult()
      this.#ledger.noteSettled(id, accepted ? { ok: true, result } : { ok: false })
      if (!accepted) throw new BakePiError("host_unavailable", { retryable: true })
      if (name === "close_workspace") {
        this.#options.onWorkspaceClosed?.((params as CommandParams<"close_workspace">).id)
      }
      return result
    } catch (error) {
      this.#ledger.noteSettled(id, { ok: false })
      throw error
    }
  }

  #owns(generation: number, launcher: HostLauncher): boolean {
    return generation === this.#generation && launcher === this.#launcher && !this.#stopping
  }
}
