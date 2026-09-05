import type { IpcMainInvokeEvent } from "electron"
import {
  type CommandParams,
  type CommandResult,
  type ContractError,
  type MainOwnedCommand,
  isMainOwnedCommand,
} from "@bake-pi/contract"
import type { CommandTiming, HostSupervisor } from "../supervisor/supervisor.ts"
import { toContractError } from "../errors.ts"
import type { CommandGuard } from "./guard.ts"

/**
 * What happens to a command between the renderer and the agent host.
 *
 * Separated from `router.ts`, which registers it, for one reason: registering
 * needs `ipcMain` and therefore a live Electron main process, and none of the
 * behavior here does. Keeping the decisions in a module that imports Electron
 * only as types is what makes them testable at all — main had no tests before
 * this, and the crash-attribution ordering below is exactly the kind of thing
 * that is wrong silently.
 */

export interface Supervision {
  chooseWorkspace: (params: CommandParams<"choose_workspace">) => Promise<CommandResult<"choose_workspace">>
  listWorkspaceLocations: () => Promise<CommandResult<"list_workspace_locations">>
  reopenRecentWorkspace: (
    params: CommandParams<"reopen_recent_workspace">,
  ) => Promise<CommandResult<"reopen_recent_workspace">>
  createWorkspace: (params: CommandParams<"create_workspace">) => Promise<CommandResult<"create_workspace">>
  chooseAttachments: (
    params: CommandParams<"choose_attachments">,
  ) => Promise<CommandResult<"choose_attachments">>
  /**
   * Kept out of this module rather than done here, although it is two lines:
   * showing a file needs Electron's `shell`, and this file imports Electron for
   * types only so that routing stays testable without a main process.
   */
  revealLogFile: () => Promise<CommandResult<"reveal_log_file">>
}

/** The collaborators, narrowed to what routing actually uses. */
export interface Routing {
  host: Pick<HostSupervisor, "execute" | "restart">
  guard: Pick<CommandGuard, "check">
  supervision: Supervision
}

export type CommandOutcome = { ok: true; result: unknown } | { ok: false; error: ContractError }

/**
 * Every command main answers itself, keyed by name.
 *
 * The four used to be an if-chain ending in a `throw` that claimed to keep the
 * omission "compile-visible". It did not: adding a fifth entry to
 * `MAIN_OWNED_COMMANDS` typechecked, passed its tests, and failed as an opaque
 * `internal_error` at the first click. A mapped type over `MainOwnedCommand`
 * makes the guarantee real — a command added to the contract fails this file to
 * compile until somebody says what main does with it, which is the property
 * `MAIN_OWNED_COMMANDS` was introduced to have. `PROJECTION` in the renderer's
 * session reducer is the same idiom on the event side.
 */
const MAIN_HANDLERS: {
  [N in MainOwnedCommand]: (routing: Routing, params: CommandParams<N>) => Promise<CommandResult<N>>
} = {
  restart_host: async (routing) => await routing.host.restart(),
  choose_workspace: async (routing, params) => await routing.supervision.chooseWorkspace(params),
  list_workspace_locations: async (routing) => await routing.supervision.listWorkspaceLocations(),
  reopen_recent_workspace: async (routing, params) => await routing.supervision.reopenRecentWorkspace(params),
  create_workspace: async (routing, params) => await routing.supervision.createWorkspace(params),
  choose_attachments: async (routing, params) => await routing.supervision.chooseAttachments(params),
  reveal_log_file: async (routing) => await routing.supervision.revealLogFile(),
}

/**
 * The record is exhaustive by construction, but TypeScript cannot correlate the
 * narrowed name with its own entry across an index, so the lookup is widened
 * once here rather than at each of four call sites.
 */
type MainHandler = (routing: Routing, params: unknown) => Promise<unknown>

/**
 * Checks a command, then either answers it or forwards it.
 *
 * Two things happen besides forwarding. Main-owned commands are answered here,
 * because the one that exists has to work when no host does. And every other
 * command is recorded against the recovery ledger going out and coming back,
 * which is how a crash gets attributed to whatever the host was working on —
 * main reads no events, so commands are the only evidence there is.
 */
export const routeCommand = async (
  routing: Routing,
  event: IpcMainInvokeEvent,
  name: unknown,
  params: unknown,
  timing: CommandTiming = {},
): Promise<CommandOutcome> => {
  try {
    const checked = routing.guard.check(event, name, params)
    if (isMainOwnedCommand(checked.name)) {
      const handle = MAIN_HANDLERS[checked.name] as MainHandler
      return { ok: true, result: await handle(routing, checked.params) }
    }

    const result = await routing.host.execute(checked.name, checked.params as never, timing)
    return { ok: true, result }
  } catch (error) {
    // HostSupervisor settled the command before rethrowing. If the host died,
    // its exit callback consumed the entry first, so crash attribution is
    // already preserved and this layer only converts the error for the bridge.
    return { ok: false, error: toContractError(error) }
  }
}
