import { contextBridge, ipcRenderer } from "electron"
import {
  type HostConnectionNotice,
  parseHostConnectionNotice,
} from "@bake-pi/contract"
import { createCommandSurface } from "./command-bridge.ts"
import { createEventSocketBridge, parseEventSocketDescriptor, type EventSocketBridge } from "./event-channel.ts"

/**
 * The hardening check, at the only point in the application that can make it.
 *
 * `process.contextIsolated` and `process.sandboxed` report what this process
 * actually got, not what main asked for. If either is false the isolated world
 * is not isolated, and exposing the capability surface would hand every command
 * to page scripts — including anything a model wrote into the timeline. So the
 * bridge is not installed, and the renderer fails visibly at startup instead of
 * running unprotected.
 */
const assertHardened = (): void => {
  const problems: string[] = []
  if (process.contextIsolated !== true) problems.push("contextIsolation is off")
  if (process.sandboxed !== true) problems.push("the renderer is not sandboxed")
  if (problems.length > 0) throw new Error("refusing to expose the Bake Pi bridge: " + problems.join("; "))
}

assertHardened()

const COMMAND_CHANNEL = "bakepi:command"
const EVENT_PORT_CHANNEL = "bakepi:event-port"
const HOST_CONNECTION_CHANNEL = "bakepi:host-connection"

/**
 * The privileged surface, and all of it.
 *
 * What is deliberately absent: `ipcRenderer` in any form, a channel name the
 * renderer can choose, a generic `invoke`, and any filesystem or shell access.
 * The renderer can name a command from the contract and it can receive its
 * event port. That is the entire vocabulary.
 *
 * The command list is derived from the contract rather than written here, so a
 * new command cannot be exposed by accident and an existing one cannot be
 * quietly dropped. `command-bridge.test.ts` asserts exact set equality.
 */
const commands = createCommandSurface((name, params) => ipcRenderer.invoke(COMMAND_CHANNEL, name, params))

let deliverHostConnection: ((notice: HostConnectionNotice) => void) | undefined
let bufferedHostConnection: HostConnectionNotice | undefined
const windowLoaded = document.readyState === "complete"
  ? Promise.resolve()
  : new Promise<void>((resolve) => window.addEventListener("load", () => resolve(), { once: true }))
let eventSocketBridge: EventSocketBridge | undefined

/**
 * A DOM MessagePort cannot cross contextBridge: bridge arguments are copied,
 * and custom prototypes are not supported. Electron's documented isolated-
 * world pattern is to transfer the port again with window.postMessage after
 * the main world has installed its load-time listener.
 */
ipcRenderer.on(EVENT_PORT_CHANNEL, async (event, raw: unknown) => {
  eventSocketBridge?.close()
  eventSocketBridge = undefined

  const port = event.ports[0]
  if (port !== undefined) {
    await windowLoaded
    window.postMessage(EVENT_PORT_CHANNEL, "*", [port])
    return
  }

  const descriptor = parseEventSocketDescriptor(raw)
  if (descriptor === undefined) return
  const bridge = createEventSocketBridge(descriptor.url)
  eventSocketBridge = bridge
  try {
    await Promise.all([windowLoaded, bridge.opened])
  } catch {
    if (eventSocketBridge === bridge) eventSocketBridge = undefined
    bridge.close()
    return
  }
  if (eventSocketBridge !== bridge) return
  window.postMessage(EVENT_PORT_CHANNEL, "*", [bridge.port])
})

ipcRenderer.on(HOST_CONNECTION_CHANNEL, (_event, raw: unknown) => {
  let notice: HostConnectionNotice
  try {
    notice = parseHostConnectionNotice(raw)
  } catch {
    return
  }
  if (deliverHostConnection === undefined) bufferedHostConnection = notice
  else deliverHostConnection(notice)
})

contextBridge.exposeInMainWorld("bakePi", {
  commands,
  onHostConnection: (handler: (notice: HostConnectionNotice) => void): void => {
    deliverHostConnection = handler
    if (bufferedHostConnection !== undefined) {
      handler(bufferedHostConnection)
      bufferedHostConnection = undefined
    }
  },
})
