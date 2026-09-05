import { Type } from "@sinclair/typebox"
import { defineCommands } from "./define.ts"

/**
 * Managing the Pi the agent host runs.
 *
 * Every one of these is answered by main, and none of them can be answered by
 * the agent host — which is the point. The host is the process that has Pi
 * loaded; asking it to replace the modules it is running is asking it to pull
 * the floor up while standing on it. Main owns the download, the directory, and
 * the restart that makes a new version take effect, so main owns the commands.
 *
 * They are also the only commands here that must work while nothing is
 * connected. A Pi that fails to start is exactly when someone needs to go back
 * to the version that worked, and a settings panel that could only offer that
 * while the broken Pi was running would be offering nothing.
 */

const PiVersion = Type.String({ maxLength: 64, pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$" })

export const InstalledPi = Type.Object({
  version: PiVersion,
  /** ISO 8601, or empty when the install predates its own receipt. */
  installedAt: Type.String({ maxLength: 64 }),
  packages: Type.Integer({ minimum: 0 }),
})

export const PiRelease = Type.Object({
  version: PiVersion,
  publishedAt: Type.String({ maxLength: 64 }),
  url: Type.String({ maxLength: 512 }),
})

/**
 * How an install is going, or how the last one went.
 *
 * Reported by polling rather than pushed as an event, because an install is
 * owned by main and main has no event channel to the renderer: events travel
 * from the agent host over a transferred `MessagePort` that main never holds.
 * Building a second push channel for one progress bar would add a privileged
 * main-to-renderer path to a design that has deliberately avoided one.
 *
 * `error` survives the run that produced it. A failed install that cleared its
 * own state would leave the panel showing nothing at all, which reads as
 * success.
 */
export const PiInstallState = Type.Object({
  version: PiVersion,
  phase: Type.Union([
    Type.Literal("planning"),
    Type.Literal("downloading"),
    Type.Literal("activating"),
    Type.Literal("done"),
    Type.Literal("failed"),
  ]),
  completed: Type.Integer({ minimum: 0 }),
  total: Type.Integer({ minimum: 0 }),
  error: Type.Optional(Type.String({ maxLength: 1024 })),
})

export const piCommands = defineCommands({
  /**
   * What is on disk and what is in use. Reads no network, so the panel can open
   * and be correct while offline.
   */
  get_pi_runtime: {
    params: Type.Object({}),
    result: Type.Object({
      /** The Pi inside the application archive, which is always available. */
      bundledVersion: Type.String({ maxLength: 64 }),
      /** Absent when the bundled Pi is in use. */
      activeVersion: Type.Optional(PiVersion),
      /**
       * Whether the running host is on the active choice.
       *
       * False between an install finishing and the host restarting, which is the
       * one moment the panel must not claim the new Pi is running.
       */
      pending: Type.Boolean(),
      installed: Type.Array(InstalledPi),
      install: Type.Optional(PiInstallState),
    }),
  },
  /** Asks upstream what it has published. Network-bound, so always explicit. */
  check_pi_releases: {
    params: Type.Object({}),
    result: Type.Object({ releases: Type.Array(PiRelease) }),
  },
  /**
   * Starts an install and returns at once.
   *
   * Returning immediately rather than when the install finishes: it downloads
   * upwards of a hundred packages and takes tens of seconds on a good
   * connection, which is far past the point where a pending command reads as a
   * hung application. Progress is read back through `get_pi_runtime`.
   */
  install_pi: {
    params: Type.Object({ version: PiVersion }),
    result: Type.Object({ started: Type.Boolean() }),
  },
  /**
   * Chooses which Pi the host runs, and restarts it.
   *
   * Omitting `version` selects the bundled copy. That is the way back from a
   * managed install that does not work, so it deletes nothing: the install
   * stays on disk and can be selected again.
   */
  use_pi: {
    params: Type.Object({ version: Type.Optional(PiVersion) }),
    result: Type.Object({ activeVersion: Type.Optional(PiVersion) }),
  },
  /** Deletes an installed version. Refused for the one in use. */
  remove_pi: {
    params: Type.Object({ version: PiVersion }),
    result: Type.Object({ removed: PiVersion }),
  },
})
