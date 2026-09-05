import { type BrowserWindow, shell } from "electron"
import { APP_ORIGIN } from "../protocol.ts"

/**
 * The renderer is a single document that never navigates. Anything that tries
 * to — a stray anchor, a model-authored link that slipped past the markdown
 * renderer, a redirect — is a defect, and the honest response is to refuse it
 * rather than to guess whether it was intentional.
 */
export const installNavigationGuards = (window: BrowserWindow): void => {
  const contents = window.webContents

  contents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${APP_ORIGIN}/`)) event.preventDefault()
  })

  contents.on("will-frame-navigate", (event) => {
    if (!event.url.startsWith(`${APP_ORIGIN}/`)) event.preventDefault()
  })

  contents.setWindowOpenHandler(({ url }) => {
    // External links open in the user's browser, and only over http(s). A
    // `file:` or custom-scheme URL handed to the shell is a command execution
    // primitive on every platform we ship to.
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url)
    return { action: "deny" }
  })

  contents.on("will-attach-webview", (event) => event.preventDefault())
}
