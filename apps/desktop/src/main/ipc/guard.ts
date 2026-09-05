import type { IpcMainInvokeEvent, WebContents } from "electron"
import {
  BakePiError,
  type CommandName,
  GESTURE_REQUIRED_COMMANDS,
  isCommandName,
  isHostInternalCommand,
  parseCommandParams,
} from "@bake-pi/contract"

/**
 * Everything main checks before a renderer request becomes a privileged action.
 *
 * Schema validation is not decoration here. The renderer is the least trusted
 * process in the application, and an unvalidated command is the shortest path
 * from a rendering bug to a tool execution.
 */
export interface Guard {
  /** The one window we accept commands from. A second window is a bug, not a feature to support. */
  readonly owner: WebContents
}

const GESTURE_WINDOW_MS = 5_000

export class CommandGuard {
  #owner: WebContents | undefined
  #lastGestureAt = 0

  bind(owner: WebContents): void {
    this.#owner = owner
  }

  /**
   * Records a real user interaction. Fed from Electron's own input events
   * rather than from anything the renderer asserts — a renderer that can claim
   * "the user clicked" has a gesture check in name only.
   */
  noteUserGesture(): void {
    this.#lastGestureAt = Date.now()
  }

  check(event: IpcMainInvokeEvent, name: unknown, params: unknown): { name: CommandName; params: unknown } {
    // Sender identity first. A command from a frame we did not create is not a
    // malformed command; it is a different process asking, and the difference
    // matters for how it is logged.
    if (this.#owner === undefined || event.sender.id !== this.#owner.id) {
      throw new BakePiError("internal_error", { detail: "unknown_sender" })
    }
    if (event.senderFrame?.parent !== null) {
      throw new BakePiError("internal_error", { detail: "subframe_sender" })
    }
    if (!isCommandName(name)) throw new BakePiError("unknown_command")
    // `open_workspace` accepts a host path, but only main's native picker may
    // produce one. It remains a contract command for main → host dispatch and
    // is rejected on the renderer → main boundary.
    if (isHostInternalCommand(name)) throw new BakePiError("unknown_command")

    if ((GESTURE_REQUIRED_COMMANDS as readonly string[]).includes(name)) {
      if (Date.now() - this.#lastGestureAt > GESTURE_WINDOW_MS) {
        // These commands grant trust, load executable code, or move a
        // credential. None of them should ever originate from a timer, a
        // stream handler, or a re-render.
        throw new BakePiError("internal_error", { detail: `${name}:no_user_gesture` })
      }
    }

    return { name, params: parseCommandParams(name, params) }
  }
}
