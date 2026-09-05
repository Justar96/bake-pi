import {
  BakePiError,
  CONTRACT_VERSION,
  checkEnvelope,
  isCompatible,
  type CommandName,
  type CommandParams,
  type CommandResult,
  type ContractError,
  type Hello,
  type HelloAck,
  type ResponseEnvelope,
} from "@bake-pi/contract"
import type { ChildProcess } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { NO_SHUTDOWN, type ShutdownTimings } from "./shutdown.ts"
import type { HostLauncher, RendererEventChannel } from "./supervisor.ts"
import { discoverWslNode, nodeBinDir, type WslNode } from "./wsl-node.ts"
import { runWsl, spawnWsl } from "./wsl-process.ts"
import { appendLog } from "../observability/log-file.ts"

const HANDSHAKE_TIMEOUT_MS = 15_000
const COMMAND_TIMEOUT_MS = 120_000
const EVENT_TICKET_TIMEOUT_MS = 15_000
const RELAY_RETRY_MS = 150
const MINIMUM_NODE_MAJOR = 22
const PI_PACKAGE = "@earendil-works/pi-coding-agent"

export interface WslLauncherOptions {
  distro: string
  entry: string
  appVersion: string
  /** Omitted only by the self-contained WSL smoke fixture. */
  packageVersion?: string
  onExit: (code: number) => void
  quarantinedSessions?: () => string[]
  onPhase?: (phase: "forked" | "acked") => void
}

interface SocketAnnouncement {
  port: number
  token: string
}

interface EventTicket {
  kind: "event_ticket"
  id: string
  port: number
  ticket: string
}

/**
 * Launches a plain Node agent host inside one WSL distribution.
 *
 * Commands use the authenticated control socket. A renderer attachment asks
 * that channel for a one-time ticket, then hands the resulting loopback URL to
 * preload; streamed events never relay through main.
 */
export class WslLauncher implements HostLauncher {
  readonly #options: WslLauncherOptions
  readonly #pending = new Map<string, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  }>()
  readonly #intentionalStops = new WeakSet<ChildProcess>()
  #child: ChildProcess | undefined
  #socket: WebSocket | undefined
  #hostProcessId: number | undefined
  #bundleHash: string | undefined
  #ready = false
  #stopPromise: Promise<ShutdownTimings> | undefined

  constructor(options: WslLauncherOptions) {
    this.#options = options
  }

  get running(): boolean {
    return this.#child !== undefined && this.#socket?.readyState === WebSocket.OPEN && this.#ready
  }

  get starting(): boolean {
    return this.#child !== undefined && !this.#ready
  }

  async start(): Promise<HelloAck> {
    if (this.#child !== undefined) {
      throw new BakePiError("host_unavailable", { detail: "host_already_started", retryable: true })
    }

    const node = await discoverWslNode(this.#options.distro, MINIMUM_NODE_MAJOR)
    const hash = await this.#stageBundle(node)
    this.#bundleHash = hash
    // The absolute binary rather than the name, because the name may only exist
    // on an interactive shell's PATH. Its directory goes on PATH anyway so that
    // anything the host or a Pi tool shells out to — `npm`, `npx`, a bare
    // `node` in a script — is the same runtime the host is running on.
    const child = spawnWsl(this.#options.distro, [
      "sh",
      "-lc",
      'set -eu; PATH="$2:$PATH"; export PATH; exec "$1" "$HOME/.cache/bake-pi/$3/index.js" --listen',
      "sh",
      node.path,
      nodeBinDir(node),
      hash,
    ], "ignore")
    this.#child = child
    this.#options.onPhase?.("forked")
    child.stderr?.on("data", (chunk: Buffer) => log("wsl-host.stderr", chunk))
    child.once("error", () => this.#processExited(child, 1))
    child.once("exit", (code) => this.#processExited(child, code ?? 1))

    try {
      const announcement = await readAnnouncement(child)
      const socket = await this.#connect(child, announcement.port)
      const ack = await this.#handshake(socket, announcement.token)
      if (this.#child !== child || this.#socket !== socket) {
        throw new BakePiError("handshake_failed", { detail: "host_exited", retryable: true })
      }
      this.#ready = true
      this.#hostProcessId = ack.processId
      this.#options.onPhase?.("acked")
      return ack
    } catch (error) {
      this.#intentionalStops.add(child)
      this.#socket?.close()
      child.kill()
      if (this.#child === child) this.#child = undefined
      this.#socket = undefined
      this.#hostProcessId = undefined
      this.#bundleHash = undefined
      this.#ready = false
      this.#failAllPending(new BakePiError("host_unavailable", { retryable: true }))
      throw error
    }
  }

  async send<N extends CommandName>(name: N, params: CommandParams<N>): Promise<CommandResult<N>> {
    const socket = this.#require()
    const id = randomUUID()
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new BakePiError("internal_error", { detail: `${name}:timeout`, retryable: true }))
      }, COMMAND_TIMEOUT_MS)
      this.#pending.set(id, { resolve, reject, timer })
    })
    socket.send(JSON.stringify({ kind: "command", id, name, params }))
    return await result as CommandResult<N>
  }

  async attachEventChannel(
    deliver: (channel: RendererEventChannel) => void,
    restoreProjection = false,
  ): Promise<void> {
    const socket = this.#require()
    const id = randomUUID()
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new BakePiError("host_unavailable", { detail: "event_ticket_timeout", retryable: true }))
      }, EVENT_TICKET_TIMEOUT_MS)
      this.#pending.set(id, { resolve, reject, timer })
    })
    socket.send(JSON.stringify({ kind: "event_ticket_request", id, restoreProjection }))
    const ticket = await response as EventTicket
    deliver({
      kind: "websocket",
      url: `ws://127.0.0.1:${String(ticket.port)}/events?ticket=${ticket.ticket}`,
    })
  }

  stop(): Promise<ShutdownTimings> {
    this.#stopPromise ??= this.#performStop().finally(() => {
      this.#stopPromise = undefined
    })
    return this.#stopPromise
  }

  async #performStop(): Promise<ShutdownTimings> {
    const child = this.#child
    if (child === undefined) return NO_SHUTDOWN
    const startedAt = performance.now()
    this.#intentionalStops.add(child)

    let acknowledged = false
    if (this.running) {
      try {
        acknowledged = await Promise.race([
          this.send("shutdown", {}).then(() => true),
          delay(2_000).then(() => false),
        ])
      } catch {
        // A dead control socket is the ungraceful path this cleanup owns.
      }
    }
    const requestedAt = performance.now()
    this.#socket?.close(1000, "main stopping")
    await waitForExit(child, 250)
    if (child.exitCode === null && child.signalCode === null) {
      await terminateWslHost(this.#options.distro, this.#hostProcessId, this.#bundleHash)
      await waitForExit(child, 2_750)
    }
    if (child.exitCode === null && child.signalCode === null) child.kill()
    const stoppedAt = performance.now()

    if (this.#child === child) this.#child = undefined
    this.#socket = undefined
    this.#hostProcessId = undefined
    this.#bundleHash = undefined
    this.#ready = false
    this.#failAllPending(new BakePiError("host_unavailable", { retryable: true }))
    return {
      requested: requestedAt - startedAt,
      walked: stoppedAt - requestedAt,
      total: stoppedAt - startedAt,
      acknowledged,
    }
  }

  /**
   * Opens the control socket, retrying a connection Windows refuses.
   *
   * The host binds inside the WSL virtual machine and announces its port the
   * moment that bind succeeds, but Windows cannot reach `127.0.0.1` on that
   * port until WSL's localhost relay has noticed the new listener and put a
   * matching listener on the Windows side. That is not instant: on a healthy
   * machine the first connect is refused and the same port answers roughly a
   * second later. Failing on the first refusal made a host that had started
   * correctly report a failed handshake, which is the wrong diagnosis and the
   * wrong remedy.
   *
   * So a refusal is retried until the handshake deadline. The child is the
   * only thing that can end the wait early: a host that has exited will not
   * start answering, and waiting the full budget for it would delay the real
   * error by fifteen seconds. Mirrored networking needs none of this — the
   * guest's loopback is the host's — and pays one successful connect.
   */
  async #connect(child: ChildProcess, port: number): Promise<WebSocket> {
    const deadline = performance.now() + HANDSHAKE_TIMEOUT_MS
    for (;;) {
      const socket = new WebSocket(`ws://127.0.0.1:${String(port)}`)
      this.#socket = socket
      socket.addEventListener("message", (event) => this.#onMessage(parseSocketMessage(event.data)))
      try {
        await waitForOpen(socket)
        return socket
      } catch (error) {
        socket.close()
        this.#socket = undefined
        const exited = child.exitCode !== null || child.signalCode !== null
        if (exited || performance.now() + RELAY_RETRY_MS >= deadline) throw error
        await delay(RELAY_RETRY_MS)
      }
    }
  }

  async #stageBundle(node: WslNode): Promise<string> {
    try {
      const bundle = await readFile(this.#options.entry)
      const packageJson = JSON.stringify({
        private: true,
        type: "module",
        ...(this.#options.packageVersion === undefined
          ? {}
          : { dependencies: { [PI_PACKAGE]: this.#options.packageVersion } }),
      })
      const hash = createHash("sha256").update(bundle).update("\0").update(packageJson).digest("hex")
      const exists = await runWsl(this.#options.distro, [
        "sh",
        "-c",
        'test -f "$HOME/.cache/bake-pi/$1/index.js" && test -f "$HOME/.cache/bake-pi/$1/package.json" && test -f "$HOME/.cache/bake-pi/$1/.ready"',
        "sh",
        hash,
      ])
      if (exists.code === 0) return hash

      const copied = await runWsl(this.#options.distro, [
        "sh",
        "-c",
        'set -eu; umask 077; target="$HOME/.cache/bake-pi/$1"; mkdir -p "$target"; rm -f "$target/.ready"; tmp="$target/index.js.tmp.$$"; trap \'rm -f "$tmp"\' EXIT; cat > "$tmp"; printf "%s\\n" "$2" > "$target/package.json"; chmod 700 "$tmp"; mv "$tmp" "$target/index.js"; trap - EXIT',
        "sh",
        hash,
        packageJson,
      ], bundle)
      if (copied.code !== 0) {
        throw new BakePiError("host_unavailable", { detail: "bundle_stage_failed", retryable: true })
      }

      if (this.#options.packageVersion !== undefined) {
        // npm ships beside the Node that was found, and on a machine using a
        // version manager that is the only place it exists. Putting that one
        // directory on PATH is also what makes npm's own `#!/usr/bin/env node`
        // shebang resolve to the runtime the host will be started on.
        const installed = await runWsl(this.#options.distro, [
          "sh",
          "-c",
          'set -eu; PATH="$2:$PATH"; export PATH; cd "$HOME/.cache/bake-pi/$1"; npm install --omit=dev --ignore-scripts --no-audit --no-fund --package-lock=false; touch .ready',
          "sh",
          hash,
          nodeBinDir(node),
        ], undefined, 180_000)
        if (installed.code !== 0) {
          throw new BakePiError("host_unavailable", { detail: "dependency_stage_failed", retryable: true })
        }
      } else {
        const ready = await runWsl(this.#options.distro, [
          "sh",
          "-c",
          'touch "$HOME/.cache/bake-pi/$1/.ready"',
          "sh",
          hash,
        ])
        if (ready.code !== 0) {
          throw new BakePiError("host_unavailable", { detail: "bundle_stage_failed", retryable: true })
        }
      }
      return hash
    } catch (cause) {
      if (cause instanceof BakePiError) throw cause
      throw new BakePiError("host_unavailable", { detail: "bundle_stage_failed", retryable: true, cause })
    }
  }

  async #handshake(socket: WebSocket, token: string): Promise<HelloAck> {
    const quarantined = this.#options.quarantinedSessions?.() ?? []
    const hello: Hello = {
      kind: "hello",
      contractVersion: CONTRACT_VERSION,
      appVersion: this.#options.appVersion,
      platform: process.platform,
      arch: process.arch,
      ...(quarantined.length === 0 ? {} : { quarantinedSessions: quarantined }),
    }
    const ack = await new Promise<HelloAck>((resolve, reject) => {
      const onMessage = (event: MessageEvent): void => {
        const message = parseSocketMessage(event.data)
        if (!checkEnvelope("hello_ack", message)) return
        cleanup()
        resolve(message as HelloAck)
      }
      const onClose = (): void => {
        cleanup()
        reject(new BakePiError("handshake_failed", { detail: "host_exited", retryable: true }))
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        socket.removeEventListener("message", onMessage)
        socket.removeEventListener("close", onClose)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new BakePiError("handshake_failed", { detail: "timeout", retryable: true }))
      }, HANDSHAKE_TIMEOUT_MS)
      socket.addEventListener("message", onMessage)
      socket.addEventListener("close", onClose)
      socket.send(JSON.stringify({ ...hello, token }))
    })

    if (!isCompatible(ack.contractVersion)) {
      await this.stop()
      throw new BakePiError("contract_version_mismatch", {
        detail: `host=${ack.contractVersion} app=${CONTRACT_VERSION}`,
      })
    }
    return ack
  }

  #require(): WebSocket {
    const socket = this.#socket
    if (socket === undefined || socket.readyState !== WebSocket.OPEN || !this.#ready) {
      throw new BakePiError("host_unavailable", { retryable: true })
    }
    return socket
  }

  #onMessage(message: unknown): void {
    const ticket = parseEventTicket(message)
    if (ticket !== undefined) {
      const pending = this.#pending.get(ticket.id)
      if (pending === undefined) return
      this.#pending.delete(ticket.id)
      clearTimeout(pending.timer)
      pending.resolve(ticket)
      return
    }
    if (!checkEnvelope("response", message)) return
    const response = message as ResponseEnvelope
    const pending = this.#pending.get(response.id)
    if (pending === undefined) return
    this.#pending.delete(response.id)
    clearTimeout(pending.timer)
    if (response.ok) pending.resolve(response.result)
    else pending.reject(fromContractError(response.error))
  }

  #processExited(child: ChildProcess, code: number): void {
    if (this.#child !== child) return
    this.#child = undefined
    this.#socket?.close()
    this.#socket = undefined
    this.#hostProcessId = undefined
    this.#bundleHash = undefined
    this.#ready = false
    if (!this.#intentionalStops.has(child)) this.#options.onExit(code)
    this.#failAllPending(new BakePiError("host_unavailable", { retryable: true }))
  }

  #failAllPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }
}

export const parseSocketAnnouncement = (line: string): SocketAnnouncement | undefined => {
  try {
    const value = JSON.parse(line) as { port?: unknown; token?: unknown }
    if (!Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65_535) return undefined
    if (typeof value.token !== "string" || !/^[a-f0-9]{64}$/u.test(value.token)) return undefined
    return { port: value.port as number, token: value.token }
  } catch {
    return undefined
  }
}

export const parseEventTicket = (message: unknown): EventTicket | undefined => {
  if (typeof message !== "object" || message === null) return undefined
  const value = message as { kind?: unknown; id?: unknown; port?: unknown; ticket?: unknown }
  if (value.kind !== "event_ticket" || typeof value.id !== "string" || value.id.length === 0 || value.id.length > 128) {
    return undefined
  }
  if (!Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65_535) return undefined
  if (typeof value.ticket !== "string" || !/^[a-f0-9]{64}$/u.test(value.ticket)) return undefined
  return { kind: "event_ticket", id: value.id, port: value.port as number, ticket: value.ticket }
}

/**
 * Fast stop for a socket host that did not answer its graceful shutdown.
 *
 * The PID came from the authenticated host, but it is still checked against
 * the content-addressed bundle before a signal is sent. That closes the PID
 * reuse window instead of letting a delayed stop terminate an unrelated Linux
 * process. Pi launches shell tools as detached process-group leaders on Linux;
 * killing each direct child's group first takes the command and its ordinary
 * descendants before the host that names them disappears.
 */
const terminateWslHost = async (
  distro: string,
  processId: number | undefined,
  bundleHash: string | undefined,
): Promise<void> => {
  if (processId === undefined || bundleHash === undefined) return
  await runWsl(distro, [
    "sh",
    "-c",
    'pid="$1"; expected="$HOME/.cache/bake-pi/$2/index.js"; test -r "/proc/$pid/cmdline" || exit 0; command=$(tr "\\000" " " < "/proc/$pid/cmdline"); case "$command" in *"$expected"*"--listen"*) ;; *) exit 0 ;; esac; children=$(cat "/proc/$pid/task/$pid/children" 2>/dev/null || true); for child in $children; do kill -KILL -- "-$child" 2>/dev/null || kill -KILL -- "$child" 2>/dev/null || true; done; kill -TERM -- "$pid" 2>/dev/null || true',
    "sh",
    String(processId),
    bundleHash,
  ], undefined, 5_000).catch(() => undefined)
}

const readAnnouncement = async (child: ChildProcess): Promise<SocketAnnouncement> => {
  const stdout = child.stdout
  if (stdout === null) throw new BakePiError("handshake_failed", { detail: "missing_announcement", retryable: true })

  return await new Promise<SocketAnnouncement>((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    const cleanup = (): void => {
      clearTimeout(timer)
      stdout.off("data", onData)
      child.off("exit", onExit)
      child.off("error", onError)
    }
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      if (buffered.length > 4_096) {
        cleanup()
        reject(new BakePiError("handshake_failed", { detail: "invalid_announcement", retryable: true }))
        return
      }
      const newline = buffered.indexOf(0x0a)
      if (newline < 0) return
      const announcement = parseSocketAnnouncement(buffered.subarray(0, newline).toString("utf8").trim())
      if (announcement === undefined) {
        cleanup()
        reject(new BakePiError("handshake_failed", { detail: "invalid_announcement", retryable: true }))
        return
      }
      const remainder = buffered.subarray(newline + 1)
      cleanup()
      if (remainder.length > 0) log("wsl-host.stdout", remainder)
      stdout.on("data", (next: Buffer) => log("wsl-host.stdout", next))
      resolve(announcement)
    }
    const onExit = (): void => {
      cleanup()
      reject(new BakePiError("handshake_failed", { detail: "host_exited", retryable: true }))
    }
    const onError = (): void => {
      cleanup()
      reject(new BakePiError("host_unavailable", { detail: "wsl_unavailable", retryable: false }))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new BakePiError("handshake_failed", { detail: "announcement_timeout", retryable: true }))
    }, HANDSHAKE_TIMEOUT_MS)
    stdout.on("data", onData)
    child.once("exit", onExit)
    child.once("error", onError)
  })
}

const waitForOpen = async (socket: WebSocket): Promise<void> => {
  if (socket.readyState === WebSocket.OPEN) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer)
      socket.removeEventListener("open", onOpen)
      socket.removeEventListener("error", onError)
      socket.removeEventListener("close", onClose)
    }
    const onOpen = (): void => {
      cleanup()
      resolve()
    }
    const onError = (): void => {
      cleanup()
      reject(new BakePiError("handshake_failed", { detail: "socket_error", retryable: true }))
    }
    const onClose = (): void => {
      cleanup()
      reject(new BakePiError("handshake_failed", { detail: "host_exited", retryable: true }))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new BakePiError("handshake_failed", { detail: "socket_timeout", retryable: true }))
    }, HANDSHAKE_TIMEOUT_MS)
    socket.addEventListener("open", onOpen)
    socket.addEventListener("error", onError)
    socket.addEventListener("close", onClose)
  })
}

const waitForExit = async (child: ChildProcess, timeoutMs: number): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(timeoutMs),
  ])
}

const parseSocketMessage = (data: unknown): unknown => {
  if (typeof data !== "string") return undefined
  try {
    return JSON.parse(data)
  } catch {
    return undefined
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
