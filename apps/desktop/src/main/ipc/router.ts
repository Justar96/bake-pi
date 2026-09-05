import { type BrowserWindow, ipcMain } from "electron"
import type { HostConnectionNotice } from "@bake-pi/contract"
import type { HostSupervisor, RendererEventChannel } from "../supervisor/supervisor.ts"
import type { CommandGuard } from "./guard.ts"
import { type Supervision, routeCommand } from "./route.ts"

export const COMMAND_CHANNEL = "bakepi:command"
export const EVENT_PORT_CHANNEL = "bakepi:event-port"
export const HOST_CONNECTION_CHANNEL = "bakepi:host-connection"

export type { Supervision } from "./route.ts"

/**
 * One channel, one handler. The renderer names a command from the contract and
 * main forwards it; there is no generic `invoke`, no channel the renderer can
 * choose, and no place for a string from the renderer to become a method name.
 *
 * The decisions live in `route.ts`. This file is the registration, and it is
 * separate so that everything worth testing is reachable without booting
 * Electron.
 *
 * The one thing that has to happen *here* rather than in `route.ts` is the start
 * of main's own timing leg. This callback is the earliest instant main can
 * observe about a command — everything before it belongs to the renderer, the
 * preload and Chromium's IPC, and pricing that stretch would take a renderer
 * clock compared against main's, which is the cross-process timestamp this
 * milestone deliberately does not take. So main's leg is defined as arrival here
 * to dispatch. The instant is passed as a value with that command; it never
 * occupies a shared slot that a concurrent dispatch could overwrite. See
 * `RecoveryLedger.commandLatency` for what the resulting legs mean and for the
 * part of the journey neither of them covers.
 */
export const installCommandRouter = (
  host: HostSupervisor,
  guard: CommandGuard,
  supervision: Supervision,
  onCommandSettled?: () => void,
): void => {
  ipcMain.handle(COMMAND_CHANNEL, async (event, name: unknown, params: unknown) => {
    const arrivedAt = performance.now()
    try {
      return await routeCommand({ host, guard, supervision }, event, name, params, { arrivedAt })
    } finally {
      onCommandSettled?.()
    }
  })
}

/** Hands the renderer a direct event channel. Re-run after every host restart. */
export const deliverEventChannel = (window: BrowserWindow, channel: RendererEventChannel): void => {
  if (channel.kind === "message_port") {
    deliverEventPort(window, channel.port)
    return
  }
  window.webContents.send(EVENT_PORT_CHANNEL, channel)
}

/** The utility-process branch transfers the renderer's end of a MessagePort. */
export const deliverEventPort = (window: BrowserWindow, port: Electron.MessagePortMain): void => {
  window.webContents.postMessage(EVENT_PORT_CHANNEL, null, [port])
}

/** Announces state the event port cannot: its owning process disappeared. */
export const deliverHostConnection = (window: BrowserWindow, notice: HostConnectionNotice): void => {
  window.webContents.send(HOST_CONNECTION_CHANNEL, notice)
}
