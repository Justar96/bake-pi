import { MessageChannelMain, type UtilityProcess, utilityProcess } from "electron"
import {
  BakePiError,
  CONTRACT_VERSION,
  type CommandName,
  type CommandParams,
  type CommandResult,
  type ContractError,
  type Hello,
  type HelloAck,
  PI_ROOT_ENV,
  type ResponseEnvelope,
  checkEnvelope,
  isCompatible,
} from "@bake-pi/contract"
import { app } from "electron"
import { NO_SHUTDOWN, type ShutdownTimings } from "./shutdown.ts"
import { randomUUID } from "node:crypto"
import { terminateHostTree } from "./process-group.ts"
import type { HostLauncher, RendererEventChannel } from "./supervisor.ts"
import { appendLog } from "../observability/log-file.ts"

const HANDSHAKE_TIMEOUT_MS = 15_000
const COMMAND_TIMEOUT_MS = 120_000


export interface UtilityProcessLauncherOptions {
  entry: string
  onExit: (code: number) => void
  /**
   * Sessions the supervisor has decided not to reopen, asked for at each start.
   *
   * Read at start rather than passed once, because the answer changes: a crash
   * between one start and the next is what produces a quarantine. The host
   * announces these to the renderer, since main holds no end of the event port.
   */
  quarantinedSessions?: () => string[]
  /**
   * Called as a start reaches each of its two visible phases.
   *
   * A callback rather than a timer here, because the host has no business owning
   * a clock: main already keeps the startup stopwatch, and the same start
   * happens again on every restart, where those numbers mean something different
   * and are the caller's to interpret. Splitting `forked` from `acked` is what
   * makes a slow handshake attributable — before `forked` is Electron launching
   * a process, after it is the host evaluating its bundle, resolving Pi, and
   * answering.
   */
  onPhase?: (phase: "forked" | "acked") => void
  /**
   * The managed Pi directory this start should prefer, asked for at each start.
   *
   * `undefined` means the copy inside the asar, which is always present and is
   * what the application ships with. See `pi-resolution.ts` in the agent host
   * for how the host acts on it.
   */
  piRoot?: () => string | undefined
}

/**
 * Main's handle on the agent host.
 *
 * Two channels, deliberately:
 *
 * - Commands travel over the utility process's own parent channel, so every
 *   privileged request passes through main, where the sender is checked and the
 *   payload is validated.
 * - Events travel over a separate `MessagePort` transferred straight to the
 *   renderer. Main never sees a streamed token, so it needs no replay buffer
 *   and cannot become the bottleneck on a fast stream. This is safe because the
 *   direction that matters for privilege is renderer-to-host, and that one
 *   still goes through main.
 */
export class UtilityProcessLauncher implements HostLauncher {
  #child: UtilityProcess | undefined
  #pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  #features: HelloAck["features"] | undefined
  #piVersion = "unknown"
  #ready = false
  #stopPromise: Promise<ShutdownTimings> | undefined
  readonly #intentionalStops = new WeakSet<UtilityProcess>()
  readonly #options: UtilityProcessLauncherOptions

  constructor(options: UtilityProcessLauncherOptions) {
    this.#options = options
  }

  get piVersion(): string {
    return this.#piVersion
  }

  get features(): HelloAck["features"] | undefined {
    return this.#features
  }

  get running(): boolean {
    return this.#child !== undefined && this.#ready
  }

  /** A process exists but has not completed the versioned handshake. */
  get starting(): boolean {
    return this.#child !== undefined && !this.#ready
  }

  async start(): Promise<HelloAck> {
    if (this.#child !== undefined) {
      throw new BakePiError("host_unavailable", { detail: "host_already_started", retryable: true })
    }
    /*
      Read at start rather than captured once, for the same reason the
      quarantine list is: the answer changes between one start and the next.
      Installing or reverting a managed Pi restarts the host, and the restart is
      the moment the new choice takes effect — a value bound when the launcher
      was constructed would keep every later start on the Pi that was active
      when the application opened.
    */
    const piRoot = this.#options.piRoot?.()
    const child = utilityProcess.fork(this.#options.entry, [], {
      serviceName: "bake-pi-agent-host",
      // Program output is diagnostics, never protocol. Piping it keeps a
      // `console.log` from a user extension out of anything that parses.
      stdio: "pipe",
      env: piRoot === undefined
        ? { ...process.env }
        : { ...process.env, [PI_ROOT_ENV]: piRoot },
    })
    this.#child = child
    this.#options.onPhase?.("forked")

    child.stdout?.on("data", (chunk: Buffer) => log("host.stdout", chunk))
    child.stderr?.on("data", (chunk: Buffer) => log("host.stderr", chunk))
    child.on("message", (message: unknown) => this.#onMessage(message))
    child.on("exit", (code) => {
      // An old process may report its exit after a replacement has started.
      // It must not clear the replacement's state or attribute its commands.
      if (this.#child !== child) return
      this.#child = undefined
      this.#ready = false
      // `onExit` first, and the order is load-bearing rather than incidental.
      // The supervisor attributes a crash to whatever the host was working on,
      // and `#failAllPending` is what erases that record — it settles every
      // outstanding command, which is exactly the evidence the attribution
      // reads. Failing first would leave every crash unattributable.
      if (!this.#intentionalStops.has(child)) this.#options.onExit(code)
      this.#failAllPending(new BakePiError("host_unavailable", { retryable: true }))
    })

    const ack = await this.#handshake(child)
    if (this.#child !== child) {
      throw new BakePiError("handshake_failed", { detail: "host_exited" })
    }
    this.#ready = true
    this.#options.onPhase?.("acked")
    return ack
  }

  /**
   * Creates the direct host→renderer event channel and hands each end to its
   * owner. Called after the handshake and again after every restart, because a
   * transferred port dies with the process that held it.
   */
  attachEventChannel(
    deliverToRenderer: (channel: RendererEventChannel) => void,
    restoreProjection = false,
  ): void {
    const child = this.#require()
    const { port1, port2 } = new MessageChannelMain()
    child.postMessage({ kind: "event_port", restoreProjection }, [port1])
    deliverToRenderer({ kind: "message_port", port: port2 })
  }

  async send<N extends CommandName>(name: N, params: CommandParams<N>): Promise<CommandResult<N>> {
    const child = this.#require()
    const id = randomUUID()
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new BakePiError("internal_error", { detail: `${name}:timeout`, retryable: true }))
      }, COMMAND_TIMEOUT_MS)
      this.#pending.set(id, { resolve, reject, timer })
    })
    child.postMessage({ kind: "command", id, name, params })
    return (await result) as CommandResult<N>
  }

  /**
   * Stops the host, and reports how long each part of stopping took.
   *
   * Milestone 3 budgets graceful shutdown at two seconds. `scripts/orphans.ts`
   * proves the *ungraceful* half — a killed host leaves no tool descendant — but
   * it drives `terminateHostTree` directly and has no command channel, so the
   * leg that dominates the budget never runs there. This is the only place the
   * whole of it happens against a real host, so this is where it is timed.
   *
   * Two reported legs, because they fail for unrelated reasons. A slow
   * `shutdown` command is Pi finishing or refusing to finish; a slow ordered
   * termination is the operating system enumerating and killing the process
   * tree. Returning one total would make the two-second budget unactionable the
   * moment it was missed.
   *
   * Every figure is a duration measured here, on main's clock, start to finish.
   */
  async stop(): Promise<ShutdownTimings> {
    this.#stopPromise ??= this.#performStop().finally(() => {
      this.#stopPromise = undefined
    })
    return await this.#stopPromise
  }

  async #performStop(): Promise<ShutdownTimings> {
    const child = this.#child
    if (child === undefined) return NO_SHUTDOWN
    const pid = child.pid
    const startedAt = performance.now()
    // The process still emits `exit`, but an exit caused by this method is not a
    // crash and must not spend the restart budget or race a manual restart.
    this.#intentionalStops.add(child)

    // Whether the host answered at all is the difference between "shut down" and
    // "was killed while it was still going", and a duration alone cannot say
    // which — a host that hangs and a host that answers instantly both produce a
    // number, and only one of them stopped cleanly.
    let acknowledged = false
    try {
      acknowledged = (await Promise.race([this.send("shutdown", {}).then(() => true), delay(2_000).then(() => false)])) as boolean
    } catch {
      // An unresponsive host is exactly the case this path exists for.
    }
    const requestedAt = performance.now()
    // Tree first, then the host. Reversed — which is how this was written — the
    // tree walk finds nothing, because it walks by parent and the parent has
    // already exited, so it was equivalent to not calling it at all. Measured in
    // `scripts/orphans.ts`; the ordering lives in `terminateHostTree` so it
    // cannot be got wrong again here.
    await terminateHostTree(pid, () => {
      child.kill()
    })
    const walkedAt = performance.now()
    this.#child = undefined
    this.#ready = false
    this.#failAllPending(new BakePiError("host_unavailable", { retryable: true }))
    return {
      requested: requestedAt - startedAt,
      walked: walkedAt - requestedAt,
      total: walkedAt - startedAt,
      acknowledged,
    }
  }

  #require(): UtilityProcess {
    const child = this.#child
    if (child === undefined) throw new BakePiError("host_unavailable", { retryable: true })
    return child
  }

  async #handshake(child: UtilityProcess): Promise<HelloAck> {
    const quarantined = this.#options.quarantinedSessions?.() ?? []
    const hello: Hello = {
      kind: "hello",
      contractVersion: CONTRACT_VERSION,
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      ...(quarantined.length === 0 ? {} : { quarantinedSessions: quarantined }),
    }

    const ack = await new Promise<HelloAck>((resolve, reject) => {
      let timer: NodeJS.Timeout
      const cleanup = (): void => {
        clearTimeout(timer)
        child.off("message", onMessage)
        child.off("exit", onExit)
      }
      const onMessage = (message: unknown): void => {
        if (!checkEnvelope("hello_ack", message)) return
        cleanup()
        resolve(message as HelloAck)
      }
      const onExit = (): void => {
        cleanup()
        reject(new BakePiError("handshake_failed", { detail: "host_exited", retryable: true }))
      }
      timer = setTimeout(() => {
        cleanup()
        reject(new BakePiError("handshake_failed", { detail: "timeout", retryable: true }))
      }, HANDSHAKE_TIMEOUT_MS)
      child.on("message", onMessage)
      child.once("exit", onExit)
      child.postMessage(hello)
    })

    // A version mismatch is fatal rather than negotiable. Two peers that
    // disagree about the shape of a tool-approval request must not proceed on a
    // best guess about what the other meant.
    if (!isCompatible(ack.contractVersion)) {
      await this.stop()
      throw new BakePiError("contract_version_mismatch", {
        detail: `host=${ack.contractVersion} app=${CONTRACT_VERSION}`,
      })
    }

    this.#features = ack.features
    this.#piVersion = ack.piVersion
    return ack
  }

  #onMessage(message: unknown): void {
    if (!checkEnvelope("response", message)) return
    const response = message as ResponseEnvelope
    const pending = this.#pending.get(response.id)
    if (pending === undefined) return
    this.#pending.delete(response.id)
    clearTimeout(pending.timer)
    if (response.ok) pending.resolve(response.result)
    else pending.reject(fromContractError(response.error))
  }

  #failAllPending(error: Error): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }
}

const fromContractError = (error: ContractError): BakePiError =>
  new BakePiError(error.code, {
    ...(error.detail === undefined ? {} : { detail: error.detail }),
    retryable: error.retryable,
  })

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const log = (scope: string, chunk: Buffer): void => {
  const text = chunk.toString("utf8")
  process.stdout.write(`[${scope}] ${text}`)
  // The console this reaches does not exist in an installed copy, and a host
  // that fails on a machine we cannot reach leaves nothing else behind.
  appendLog(scope, text)
}
