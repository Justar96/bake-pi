import type { CommandParams, CommandResult } from "@bake-pi/contract"
import { BakePiError } from "@bake-pi/contract"
import { installPi, type InstallProgress } from "./install.ts"
import { PiStore } from "./store.ts"
import { listPiReleases } from "./upstream.ts"

/**
 * The application's answer to "which Pi is this running, and can I change it".
 *
 * It sits in main and holds three things that have to agree: what is on disk,
 * which of those the next host start will use, and how far along an install is.
 * The agent host is not consulted about any of it, and cannot be — it is the
 * process with Pi loaded, so it is the last process that can be asked to swap
 * Pi out.
 *
 * One install at a time, tracked here rather than in the panel. A second window
 * or a second click must not start a second download into the same staging
 * directory, and the panel that started the first one may be closed and
 * reopened while it runs; both need one authority, and this is it.
 */
export class PiManager {
  readonly #store: PiStore
  readonly #bundledVersion: string
  readonly #restartHost: () => Promise<unknown>
  #install: CommandResult<"get_pi_runtime">["install"]
  #running: string | undefined
  #inFlight: Promise<void> | undefined

  constructor(options: {
    root: string
    /** The Pi inside the archive, as the build recorded it. */
    bundledVersion: string
    restartHost: () => Promise<unknown>
  }) {
    this.#store = new PiStore(options.root)
    this.#bundledVersion = options.bundledVersion
    this.#restartHost = options.restartHost
    this.#running = this.#store.active()
  }

  /**
   * The directory the next host start should resolve Pi from.
   *
   * Read at each start by the launcher, so an install or a revert takes effect
   * on the restart that follows it and not before. `undefined` is the bundled
   * copy.
   */
  rootForNextStart = (): string | undefined => {
    const active = this.#store.active()
    // Recorded here because the panel reports whether the running host is on
    // the current choice, and a start is the only moment the two converge.
    this.#running = active
    return active === undefined ? undefined : this.#store.rootFor(active)
  }

  status(): CommandResult<"get_pi_runtime"> {
    const activeVersion = this.#store.active()
    return {
      bundledVersion: this.#bundledVersion,
      ...(activeVersion === undefined ? {} : { activeVersion }),
      pending: activeVersion !== this.#running,
      installed: this.#store.list(),
      ...(this.#install === undefined ? {} : { install: this.#install }),
    }
  }

  async releases(): Promise<CommandResult<"check_pi_releases">> {
    return { releases: await listPiReleases(10) }
  }

  /**
   * Starts an install, and refuses a second one.
   *
   * The promise this returns settles as soon as the work has begun. Everything
   * after that is read through `status`, so a closed panel, a reopened panel and
   * a second window all see the same run rather than three views of it.
   */
  install(params: CommandParams<"install_pi">): CommandResult<"install_pi"> {
    if (this.#inFlight !== undefined) {
      throw new BakePiError("pi_unavailable", { detail: "install_already_running" })
    }
    const { version } = params
    this.#install = { version, phase: "planning", completed: 0, total: 0 }

    const record = (progress: InstallProgress): void => {
      this.#install = { version, phase: progress.phase, completed: progress.completed, total: progress.total }
    }

    this.#inFlight = installPi(this.#store, version, { onProgress: record })
      .then((result) => {
        this.#install = { version, phase: "done", completed: result.packages, total: result.packages }
      })
      .catch((error: unknown) => {
        /*
          The failure is kept rather than rethrown. Nothing is awaiting this
          promise — the command that started it returned long ago — so a
          rejection here would be an unhandled one, and the panel would show an
          install that simply stopped. `installPi` has already removed its
          staging directory, so the only thing left to preserve is the reason.
        */
        this.#install = {
          version,
          phase: "failed",
          completed: this.#install?.completed ?? 0,
          total: this.#install?.total ?? 0,
          error: error instanceof Error ? error.message : String(error),
        }
      })
      .finally(() => {
        this.#inFlight = undefined
      })

    return { started: true }
  }

  /**
   * Selects a Pi and restarts the host onto it.
   *
   * The restart is part of the command rather than a second thing to ask for.
   * A selection that did not take effect until the next launch would be a
   * setting that lies about the state it displays, and the panel's whole job
   * here is to say which Pi is running.
   */
  async use(params: CommandParams<"use_pi">): Promise<CommandResult<"use_pi">> {
    const { version } = params
    try {
      this.#store.activate(version)
    } catch (error) {
      throw new BakePiError("pi_unavailable", { detail: error instanceof Error ? error.message : "pi_not_installed" })
    }
    await this.#restartHost()
    const activeVersion = this.#store.active()
    return activeVersion === undefined ? {} : { activeVersion }
  }

  remove(params: CommandParams<"remove_pi">): CommandResult<"remove_pi"> {
    try {
      this.#store.remove(params.version)
    } catch (error) {
      throw new BakePiError("pi_unavailable", { detail: error instanceof Error ? error.message : "pi_in_use" })
    }
    return { removed: params.version }
  }
}
