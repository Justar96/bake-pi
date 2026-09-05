import { BrowserWindow, Menu, nativeTheme, screen } from "electron"
import { join } from "node:path"
import { APP_ORIGIN } from "./protocol.ts"
import { HARDENED_WEB_PREFERENCES } from "./security/preferences.ts"
import { installNavigationGuards } from "./security/navigation.ts"
import { frameBorderColor } from "./frame.ts"
import { WindowStateStore, fitWindowToWorkArea, resolveWindowPlacement } from "./window-state.ts"

export interface WindowPaths {
  preload: string
  statePath: string
  /** A bitmap for the title bar and taskbar, where the executable does not carry one. */
  icon?: string
}

export const createMainWindow = async ({ preload, statePath, icon }: WindowPaths): Promise<BrowserWindow> => {
  const stateStore = new WindowStateStore(statePath)
  const saved = await stateStore.read()
  const placement = resolveWindowPlacement(saved, screen.getAllDisplays(), screen.getPrimaryDisplay())
  const window = new BrowserWindow({
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    /**
     * 720, which is the narrowest width the renderer is normally drawn for.
     *
     * It was 880, and that made most of the workbench's responsive work
     * unreachable: the file rail folds to an off-canvas panel at 940 and the
     * tab strip compacts at 720, so a floor of 880 left a sixty-pixel band in
     * which the first was true and no width at all in which the second was.
     * A breakpoint no window can reach is a rule nobody can check.
     *
     * At 720 both rails are off-canvas and the conversation has the window to
     * itself, which is the layout those breakpoints were written to produce.
     * A monitor whose whole DIP work area is smaller lowers this constraint so
     * high OS scaling cannot make part of the native frame unreachable.
     */
    minWidth: placement.minWidth,
    minHeight: placement.minHeight,
    // Shown on `ready-to-show`. A window that appears before its first paint
    // flashes the background colour, which reads as a crash on slow machines.
    show: false,
    backgroundColor: "#111111",
    ...(icon === undefined ? {} : { icon }),
    ...(process.platform === "win32" ? {
      // Windows owns the outer edge of this hidden-title-bar window. Keep its
      // resize frame and shadow, but paint the one-pixel edge as the theme's
      // own hairline rather than a desktop accent or the system's default grey.
      //
      // How wide that edge is depends on the executable, not on anything
      // here: Electron insets the client area by the current display's frame
      // thickness on the left, right and bottom, and Windows only sizes the
      // frame to match when the process is per-monitor DPI aware v2. That is
      // `build/windows.manifest`; without it a 150% display beside a 100%
      // primary shows three pixels of frame inside the hairline on those
      // three sides. `bun run frame` measures it on every display.
      thickFrame: true,
      accentColor: frameBorderColor(nativeTheme.shouldUseDarkColors),
    } : {}),
    // Keep the desktop frame subtly softened while the interface inside it
    // remains borderless. Electron clips this natively where the platform
    // supports client-side window corners.
    roundedCorners: true,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    ...(process.platform === "darwin" ? {} : {
      titleBarOverlay: {
        // Transparent lets the renderer's themed strip remain the substrate;
        // the controls stay native, while dark, light and high contrast do not
        // acquire a hard-coded rectangle at the right edge.
        color: "#00000000",
        // One neutral that clears the non-text contrast threshold on the
        // darkest and lightest strip substrates. The overlay cannot consume
        // renderer theme variables, so this is deliberately not a theme role.
        symbolColor: "#727d8c",
        // Must equal `size.tabStrip` in the renderer's scale. Main cannot read
        // a StyleX variable, so the two are kept in step by hand: a mismatch
        // puts the native buttons at a different height from the strip they sit
        // in, which is visible as a step at the top-right corner of the window.
        height: 44,
      },
    }),
    webPreferences: {
      ...HARDENED_WEB_PREFERENCES,
      preload: join(preload),
    },
  })

  installNavigationGuards(window)

  if (process.platform === "win32") {
    /*
     * A draggable custom title bar is non-client space on Windows, so its
     * right-click menu is drawn by the window manager rather than Chromium.
     * That menu can retain the system DPI after the window moves to a monitor
     * with a different scale. Electron's popup menu follows the window's
     * current scale and, with no explicit coordinates, anchors itself to the
     * live cursor. That avoids translating the event's physical screen point
     * through two APIs whose coordinate spaces differ on mixed-DPI desktops.
     *
     * Alt+Space still exposes Windows' complete system menu, including its
     * keyboard-only Move and Size commands. This pointer menu keeps the actions
     * people use from the title bar and gives them readable native hit targets.
     */
    window.on("system-context-menu", (event) => {
      event.preventDefault()
      const maximized = window.isMaximized()
      const menu = Menu.buildFromTemplate([
        {
          label: "Restore",
          enabled: maximized,
          click: () => window.restore(),
        },
        {
          label: "Minimize",
          click: () => window.minimize(),
        },
        {
          label: "Maximize",
          enabled: !maximized,
          click: () => window.maximize(),
        },
        { type: "separator" },
        {
          label: "Close",
          accelerator: "Alt+F4",
          click: () => window.close(),
        },
      ])
      menu.popup({ window })
    })
  }

  const adaptToCurrentDisplay = (keepVisible: boolean): void => {
    if (window.isDestroyed() || window.isFullScreen()) return
    const bounds = window.getNormalBounds()
    const display = screen.getDisplayMatching(window.getBounds())
    const fitted = fitWindowToWorkArea(bounds, display.workArea)
    window.setMinimumSize(fitted.minWidth, fitted.minHeight)
    if (window.isMaximized()) return
    const tooLarge = fitted.width !== bounds.width || fitted.height !== bounds.height
    if (keepVisible || tooLarge) {
      window.setBounds({ x: fitted.x, y: fitted.y, width: fitted.width, height: fitted.height })
    }
  }

  let saveTimer: ReturnType<typeof setTimeout> | undefined
  const saveWindowState = (): void => {
    if (window.isDestroyed()) return
    const bounds = window.getNormalBounds()
    const display = screen.getDisplayMatching(window.getBounds())
    void stateStore.remember({
      version: 1,
      bounds,
      displayId: display.id,
      displayWorkArea: display.workArea,
      maximized: window.isMaximized(),
    })
  }
  const scheduleWindowStateSave = (): void => {
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      adaptToCurrentDisplay(false)
      saveWindowState()
    }, 150)
  }
  window.on("resize", scheduleWindowStateSave)
  window.on("move", scheduleWindowStateSave)
  window.on("maximize", scheduleWindowStateSave)
  window.on("unmaximize", scheduleWindowStateSave)
  window.on("close", () => {
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    saveWindowState()
  })

  if (process.platform === "win32") {
    const followAppearance = (): void => {
      if (!window.isDestroyed()) window.setAccentColor(frameBorderColor(nativeTheme.shouldUseDarkColors))
    }
    nativeTheme.on("updated", followAppearance)
    window.once("closed", () => nativeTheme.off("updated", followAppearance))
  }

  const refitForDisplayChange = (): void => adaptToCurrentDisplay(true)
  screen.on("display-added", refitForDisplayChange)
  screen.on("display-removed", refitForDisplayChange)
  screen.on("display-metrics-changed", refitForDisplayChange)
  window.once("closed", () => {
    screen.off("display-added", refitForDisplayChange)
    screen.off("display-removed", refitForDisplayChange)
    screen.off("display-metrics-changed", refitForDisplayChange)
  })

  // Subscribe before navigation. `ready-to-show` may fire before `loadURL`
  // settles; attaching afterward leaves a successfully painted window hidden.
  window.once("ready-to-show", () => {
    if (saved?.maximized === true) window.maximize()
    window.show()
  })
  await window.loadURL(`${APP_ORIGIN}/index.html`)
  return window
}
