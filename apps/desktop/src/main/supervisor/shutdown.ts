/**
 * What stopping the host cost, and the value for having stopped nothing.
 *
 * Kept out of `host.ts` because that module imports Electron for real:
 * `HostSupervisor` needs these two, and importing them from `host.ts` would
 * drag `utilityProcess` and `MessageChannelMain` into every process that reads
 * a timing — including the supervisor's own tests, which have no Electron
 * runtime to resolve them against.
 *
 * The figures are milliseconds, split by what could have been slow.
 * `requested` covers the `shutdown` command and its two-second race, which is
 * the host being asked to finish. `walked` covers the ordered tree termination
 * and the kill that follows it. `total` is the two together, and is the figure
 * Milestone 3's two-second budget is about.
 */
export interface ShutdownTimings {
  requested: number
  walked: number
  total: number
  /** False when the host never answered and the race timed out instead. */
  acknowledged: boolean
}

/** Nothing was running, so nothing was spent stopping it. */
export const NO_SHUTDOWN: ShutdownTimings = { requested: 0, walked: 0, total: 0, acknowledged: false }

