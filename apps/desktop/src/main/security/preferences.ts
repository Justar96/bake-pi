import type { WebPreferences } from "electron"

/**
 * The window preferences that make the renderer untrusted, stated once so the
 * window module and the assertion below cannot drift apart.
 */
export const HARDENED_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
  navigateOnDragDrop: false,
  spellcheck: false,
} as const satisfies WebPreferences

/**
 * There is deliberately no main-process assertion here.
 *
 * Electron 44 exposes no way to read back a window's effective preferences, and
 * the two flags that actually matter — `contextIsolated` and `sandboxed` — are
 * observable only from inside the process they apply to. So the check lives in
 * the preload, where it can see the state the renderer really got rather than
 * the options main asked for, and where it can refuse to expose the capability
 * surface if either is false. See `src/preload/index.ts`.
 */
