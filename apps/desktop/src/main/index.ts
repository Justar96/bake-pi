import { BrowserWindow, MessageChannelMain, app, dialog, net, shell } from "electron"
import squirrelStartup from "electron-squirrel-startup"
import { BakePiError, type Attachment, type HostConnectionNotice } from "@bake-pi/contract"
import { stat, writeFile } from "node:fs/promises"
import { extname, join } from "node:path"
import { toContractError } from "./errors.ts"
import { CommandGuard } from "./ipc/guard.ts"
import { Stopwatch, nativeLaunchOffset, readStartupTimings } from "./observability/startup.ts"
import { ResourceProbe } from "./observability/resources.ts"
import { deliverEventChannel, deliverEventPort, deliverHostConnection, installCommandRouter } from "./ipc/router.ts"
import { IMAGE_ORIGIN, installAppProtocol, registerSchemePrivileges } from "./protocol.ts"
import { installContentSecurityPolicy } from "./security/csp.ts"
import { UtilityProcessLauncher } from "./supervisor/host.ts"
import { installManagedNode, managedNodeSummary } from "./supervisor/wsl-node-install.ts"
import { WslLauncher } from "./supervisor/wsl-launcher.ts"
import { RestartBudget } from "./supervisor/health.ts"
import { QuitCoordinator } from "./supervisor/quit.ts"
import { formatCommandLatency } from "./supervisor/recovery.ts"
import { HostSupervisor } from "./supervisor/supervisor.ts"
import { createMainWindow } from "./window.ts"
import { installUpdater } from "./update.ts"
import { PiManager } from "./pi/manager.ts"
import { installLogFile, logFilePath } from "./observability/log-file.ts"
import { watchRendererBundle } from "./dev-reload.ts"
import { RecentWorkspaceStore } from "./recent-workspace.ts"
import {
  WorkspaceLocations,
  createWorkspaceTarget,
  hostPathFor,
  listWslHomes,
  windowsFallbackFor,
  windowsPathFor,
  workspaceParent,
  wslFileSizes,
} from "./workspace-locations.ts"
import { WINDOWS_RUNTIME, type WorkspaceTarget, sameWorkspaceRuntime } from "@bake-pi/contract"

type ActiveWorkspace = WorkspaceTarget & { id: string }

/**
 * Scheme privileges are fixed when the first renderer process starts, so this
 * must run before the app is ready — and therefore at the top level of the entry
 * module, not inside anything deferred.
 */
registerSchemePrivileges()

/** The workspace name the event-intake probe injects. Distinctive so the DOM check cannot match anything real. */
const EVENT_INTAKE_MARKER = "bakepi-event-intake-probe"

const attachmentMediaType = (path: string): string => {
  switch (extname(path).toLowerCase()) {
    case ".png": return "image/png"
    case ".jpg":
    case ".jpeg": return "image/jpeg"
    case ".gif": return "image/gif"
    case ".webp": return "image/webp"
    case ".json": return "application/json"
    case ".md": return "text/markdown"
    default: return "text/plain"
  }
}

const MAX_ATTACHMENT_BYTES = 20_971_520

/**
 * Started at the top of the entry module, before anything else runs.
 *
 * Cold start is a budget Milestone 3 has to meet and nothing could previously
 * read it. The first mark is not taken from the clock at all: `process
 * .getCreationTime()` reaches back past the JavaScript timeline into Electron's
 * own launch, which is a large and otherwise invisible share of the number a
 * user experiences.
 */
const startup = new Stopwatch()
startup.markAt("processCreated", nativeLaunchOffset(process.getCreationTime(), performance.timeOrigin))
startup.mark("scriptStarted")

/**
 * Squirrel.Windows launches the executable once more during install, update
 * and uninstall with a `--squirrel-*` flag, expecting it to create or remove
 * its shortcuts and exit. `electron-squirrel-startup` does exactly that and
 * returns `true`; the application must then start nothing else, because the
 * installer is waiting on this process to leave. An ordinary launch returns
 * `false` immediately on every platform.
 */
if (squirrelStartup) {
  app.quit()
} else if (!app.requestSingleInstanceLock()) {
  // v1 is single-window. A second instance focuses the first rather than
  // opening one, because two windows would mean two agent hosts writing to one
  // set of session files, and Pi's session format has one writer by design.
  app.quit()
} else {
  // The identity Squirrel's shortcut carries (`com.squirrel.<package>.<exe>`).
  // Without it the taskbar shows the window as a second, unpinned entry beside
  // the pinned shortcut, and notifications would come from "electron".
  if (process.platform === "win32") app.setAppUserModelId(app.isPackaged ? "com.squirrel.BakePi.bake-pi" : "works.earendil.bakepi.dev")

  // Before anything that can fail. An installed copy has no console, so until
  // this runs every diagnostic it writes is lost, including the ones that
  // explain why the rest of startup did not happen.
  // `logs` is derived from `userData`, so a run with `--user-data-dir` writes
  // into its own directory and a smoke test never touches the real profile.
  installLogFile(
    app.getPath("logs"),
    `bake-pi ${app.getVersion()} on ${process.platform}-${process.arch}, electron ${process.versions.electron}, node ${process.versions.node}`,
  )

  const distRoot = join(import.meta.dirname, "..")
  const guard = new CommandGuard()
  const rendererBudget = new RestartBudget()
  const resourceProbe = process.env.BAKE_PI_RESOURCE_OUT === undefined
    ? undefined
    : new ResourceProbe(process.env.BAKE_PI_RESOURCE_OUT)
  let window: BrowserWindow | undefined
  let activeWorkspace: ActiveWorkspace | undefined

  const announceHostConnection = (notice: HostConnectionNotice): void => {
    if (window !== undefined && !window.isDestroyed()) deliverHostConnection(window, notice)
  }

  /*
    Declared before the supervisor because the launcher asks it where Pi is,
    and it asks the supervisor to restart. The cycle is only in the types: the
    restart closure runs long after both exist, and `rootForNextStart` is read
    at each host start rather than when the launcher is built.
  */
  const pi = new PiManager({
    root: join(app.getPath("userData"), "pi"),
    // The build stamps the agent host's declared Pi into main. Reading it here
    // rather than asking the running host means the panel can still say what
    // the application ships with while no host is running — which is exactly
    // when someone needs to go back to it.
    bundledVersion: process.env.BAKE_PI_PI_VERSION ?? "unknown",
    restartHost: async () => await supervisor.restart(),
  })

  const supervisor = new HostSupervisor({
    renderer: {
      available: () => window !== undefined && !window.isDestroyed(),
      announce: announceHostConnection,
      deliverEventChannel: (channel) => {
        if (window !== undefined && !window.isDestroyed()) deliverEventChannel(window, channel)
      },
    },
    onWorkspaceClosed: (id) => {
      if (activeWorkspace?.id === id) activeWorkspace = undefined
    },
    createLauncher: (runtime, hooks) => runtime.kind === "wsl"
      ? new WslLauncher({
          distro: runtime.distro,
          /*
            The host bundle directly, and no managed Pi. A WSL workspace runs
            the host inside the distribution, on that distribution's Node and
            its own `node_modules`; the managed installs under `userData` are
            Windows-side trees built for a Windows Electron. Pointing a Linux
            host at one would hand it the wrong platform's native packages.
            A WSL workspace therefore always runs the bundled Pi.
          */
          entry: join(distRoot, "agent-host/index.js"),
          appVersion: app.getVersion(),
          ...(process.env.BAKE_PI_PI_VERSION === undefined
            ? {}
            : { packageVersion: process.env.BAKE_PI_PI_VERSION }),
          quarantinedSessions: hooks.quarantinedSessions,
          onExit: hooks.onUnexpectedExit,
          onPhase: hooks.onPhase,
        })
      : new UtilityProcessLauncher({
          /*
            The boot stub, not the host bundle. It registers the module resolve
            hook that lets a managed Pi win over the one in the asar, and then
            imports the host — an order that only holds because they are two
            files. See `pi-resolution.ts` in the agent host.
          */
          entry: join(distRoot, "agent-host/boot.js"),
          piRoot: pi.rootForNextStart,
          quarantinedSessions: hooks.quarantinedSessions,
          onExit: hooks.onUnexpectedExit,
          onPhase: hooks.onPhase,
        }),
    onPhase: (phase) => startup.mark(phase === "forked" ? "hostForked" : "hostAcked"),
  })

  const quit = new QuitCoordinator(
    async () => {
      console.log(`[main] command latency this session
${formatCommandLatency(supervisor.commandLatency)}`)
      try {
        await supervisor.stop()
      } finally {
        // A process-tree failure must not abandon the probe's final write. The
        // coordinator reports the shutdown error after both cleanups had their
        // chance to finish.
        await resourceProbe?.stop()
      }
    },
    () => app.quit(),
    (error) => console.error("[main] shutdown failed", error),
  )

  app.on("second-instance", () => {
    if (window === undefined) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  app.on("web-contents-created", (_event, contents) => {
    contents.on("input-event", (_e, input) => {
      if (input.type === "mouseDown" || input.type === "keyDown") guard.noteUserGesture()
    })
  })

  app.on("window-all-closed", () => {
    app.quit()
  })

  app.on("before-quit", (event) => {
    quit.handle(event)
  })

  /**
   * A headless startup check for CI.
   *
   * It launches the whole application for real — protocol, window, preload,
   * utility process, handshake — then reports and quits. It is the cheapest
   * thing that catches a broken preload bundle, a scheme registered too late, or
   * an agent host that cannot resolve Pi; each of those presents as a blank
   * window and nothing else.
   *
   * The result goes to a file rather than stdout because `electron.exe` on
   * Windows is a GUI-subsystem binary with no console attached to the shell that
   * launched it: anything written to stdout is simply lost.
   */
  const smokeOutput = process.env.BAKE_PI_SMOKE_OUT
  const reportSmoke = async (result: Record<string, unknown>): Promise<void> => {
    if (smokeOutput === undefined) return
    await writeFile(smokeOutput, JSON.stringify(result, null, 2), "utf8")
  }

  /**
   * Measures which of the two ways to colour a token the policy actually
   * allows, because a load-bearing decision rests on the answer.
   *
   * Syntax highlighting reaches the DOM one of two ways. Every Shiki-based
   * renderer — `@pierre/diffs` among them — builds an HTML string carrying
   * `style="color:…"` and assigns it through `innerHTML`, so the *parser*
   * creates the attribute and `style-src` judges it. The renderer here instead
   * hands the colour to React, which writes it through CSSOM, and CSP does not
   * police CSSOM.
   *
   * That reasoning is why `features/conversation/highlight.ts` stops at tokens
   * rather than adopting the library's renderer, and why `style-src` still has
   * no `'unsafe-inline'`. It is read from a specification and from a shipped
   * `dist/`, neither of which is this application. So the smoke runs the
   * experiment: set a colour both ways in the real renderer under the real
   * policy, and report which one survived. If Chromium ever changes its mind
   * in either direction, this is what says so.
   */
  const probeStylePolicy = async (): Promise<Record<string, unknown> | undefined> => {
    if (window === undefined || window.isDestroyed()) return undefined
    return await window.webContents.executeJavaScript(
      `(() => {
        const violated = []
        const note = (event) => violated.push(event.violatedDirective + " @ " + (event.sourceFile || "?") + ":" + event.lineNumber)
        document.addEventListener("securitypolicyviolation", note)
        const host = document.createElement("div")
        host.style.setProperty("position", "absolute"); host.style.setProperty("left", "-9999px")
        document.body.appendChild(host)
        const viaCssom = document.createElement("span")
        viaCssom.textContent = "x"
        viaCssom.style.color = "rgb(1, 2, 3)"
        host.appendChild(viaCssom)
        const viaParser = document.createElement("div")
        viaParser.innerHTML = '<span style="color: rgb(4, 5, 6)">y</span>'
        host.appendChild(viaParser)
        let evaluate = "allowed"
        try { new globalThis.Function("return 1")() } catch (error) { evaluate = String(error && error.name) }
        const cssom = getComputedStyle(viaCssom).color
        const parser = getComputedStyle(viaParser.firstElementChild).color
        return new Promise((resolve) => setTimeout(() => {
          document.removeEventListener("securitypolicyviolation", note)
          host.remove()
          resolve({ cssom, parser, evaluate, violatedDirectives: [...new Set(violated)] })
        }, 50))
      })()`,
      true,
    ) as Record<string, unknown>
  }

  /**
   * Reports what `img-src` does with an image load, from each side of it.
   *
   * Two loads, because "no violation was reported" is also what a listener
   * that never fired looks like: the foreign one has to be blocked for the
   * result about the app's own origin to mean anything at all. Both loads
   * fail — there is no session here, so the handler answers 404 — and failing
   * is not the measurement; `securitypolicyviolation` naming `img-src` is.
   *
   * Measuring it is how we learned the two halves are not symmetrical.
   * Chromium exempts a scheme registered through `registerSchemesAsPrivileged`
   * from this directive, so the app-scheme load reports no violation even
   * under `img-src 'none'` — it is a canary for that changing, not proof the
   * origin is admitted. `scripts/smoke.ts` says which of the two it asserts
   * and why.
   */
  const probeImageOrigin = async (): Promise<Record<string, unknown> | undefined> => {
    if (window === undefined || window.isDestroyed()) return undefined
    return await window.webContents.executeJavaScript(
      `(() => {
        const blocked = []
        const note = (event) => { if (event.violatedDirective === "img-src") blocked.push(String(event.blockedURI)) }
        document.addEventListener("securitypolicyviolation", note)
        const host = document.createElement("div")
        host.style.setProperty("position", "absolute"); host.style.setProperty("left", "-9999px")
        document.body.appendChild(host)
        for (const src of [${JSON.stringify(`${IMAGE_ORIGIN}/smoke-image-origin-probe/0/0`)}, "https://example.invalid/probe.png"]) {
          const image = document.createElement("img")
          image.src = src
          host.appendChild(image)
        }
        return new Promise((resolve) => setTimeout(() => {
          document.removeEventListener("securitypolicyviolation", note)
          host.remove()
          const reported = blocked.join(" ")
          resolve({ appImagesBlocked: reported.includes("bakepi://image"), foreignImagesBlocked: reported.includes("example.invalid") })
        }, 250))
      })()`,
      true,
    ) as Record<string, unknown>
  }

  /** Proves the two self-hosted variable faces load through the shipped app origin. */
  const probeRendererFonts = async (): Promise<Record<string, unknown>[] | undefined> => {
    if (window === undefined || window.isDestroyed()) return undefined
    return await window.webContents.executeJavaScript(
      `(async () => {
        const sample = "Bake Pi 0123"
        return await Promise.all(["Geist Sans", "Geist Mono"].map(async (family) => {
          const descriptor = '400 16px "' + family + '"'
          const registered = [...document.fonts].map((face) => face.family)
          try {
            const loaded = await document.fonts.load(descriptor, sample)
            return { family, matches: loaded.length, ready: document.fonts.check(descriptor, sample), registered }
          } catch (error) {
            return { family, matches: 0, ready: document.fonts.check(descriptor, sample), error: String(error), registered }
          }
        }))
      })()`,
      true,
    ) as Record<string, unknown>[]
  }

  /**
   * Proves an event survives the renderer's own intake under the real policy.
   *
   * `rendererReady` below does not, and the distinction is the whole reason
   * this exists. The renderer marks itself connected on *receiving* the event
   * port (`store/session-store.ts`), before a single event has been validated,
   * so "Open a workspace" paints whether the intake works or not. It once did
   * not: the contract compiled its validators with `new Function`, which
   * `script-src` forbids in the main world where the port lands, so every
   * session event was silently dropped and the smoke reported a healthy start.
   *
   * So this drives one real envelope down the real path — the production
   * `deliverEventPort`, the preload's transfer, `acceptEvent` in the main
   * world, the reducer, React — and asserts the DOM changed at the end of it.
   * `workspace_changed` is the event used because it is the only host-scoped
   * one whose effect is visible before a workspace is open; the name is a
   * marker rather than a path so nothing can mistake the probe's workspace for
   * a real one. It runs last, and it replaces the live event port, which is why
   * it is only ever reached on the run that exits immediately afterwards.
   */
  const probeEventIntake = async (): Promise<boolean> => {
    if (window === undefined || window.isDestroyed()) return false
    const { port1, port2 } = new MessageChannelMain()
    deliverEventPort(window, port1)
    port2.start()
    port2.postMessage({
      kind: "event",
      name: "workspace_changed",
      sequence: 1,
      payload: {
        workspace: {
          id: "smoke-event-intake",
          root: process.platform === "win32" ? "C:\\bakepi-event-intake-probe" : "/bakepi-event-intake-probe",
          runtime: { kind: "windows" },
          displayName: EVENT_INTAKE_MARKER,
          trust: "untrusted",
          isGitRepository: false,
        },
      },
    })

    const startedAt = performance.now()
    while (performance.now() - startedAt < 5_000) {
      const seen = await window.webContents.executeJavaScript(
        `document.getElementById("root")?.textContent?.includes(${JSON.stringify(EVENT_INTAKE_MARKER)}) === true`,
        true,
      ) as boolean
      if (seen) {
        port2.close()
        return true
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
    port2.close()
    return false
  }

  const waitForRendererHostReady = async (): Promise<boolean> => {
    if (window === undefined || window.isDestroyed()) return false
    const startedAt = performance.now()
    while (performance.now() - startedAt < 5_000) {
      const ready = await window.webContents.executeJavaScript(
        'document.getElementById("root")?.textContent?.includes("Open a workspace") === true',
        true,
      ) as boolean
      if (ready) return true
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
    return false
  }

  const onStartupFailure = (error: unknown): void => {
    console.error("[main] startup failed", error)
    announceHostConnection({
      status: "disconnected",
      error: toContractError(error),
    })
    void reportSmoke({
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }).finally(() => {
      if (smokeOutput !== undefined) app.exit(1)
    })
  }

  const bootstrap = async (): Promise<void> => {
    startup.mark("appReady")
    const recentWorkspace = new RecentWorkspaceStore(join(app.getPath("userData"), "recent-workspace.json"))
    const locations = new WorkspaceLocations()
    /**
     * Brings a Node into a distribution that has none, with the taskbar as the
     * only progress surface.
     *
     * Progress deliberately does not become a contract event. This runs once
     * per distribution, in a state where the renderer has no workspace to
     * decorate, and `HostConnectionNotice` exists to describe supervision
     * rather than a download. Electron's own progress bar says the same thing
     * without widening the surface both sides have to validate.
     *
     * `net.fetch` rather than the global: it follows the system proxy and the
     * certificate store Windows already trusts, which is the difference between
     * working and not working on a managed machine.
     */
    const installNodeInto = async (distro: string): Promise<boolean> => {
      const progress = (fraction: number): void => {
        if (window !== undefined && !window.isDestroyed()) window.setProgressBar(Math.min(fraction, 1))
      }
      try {
        const node = await installManagedNode(distro, { fetch: net.fetch, onProgress: progress })
        console.log(`[wsl] installed ${node.version} for ${distro} at ${node.path}`)
        return true
      } catch (error) {
        if (window !== undefined && !window.isDestroyed()) {
          await dialog.showMessageBox(window, {
            type: "error",
            title: `Could not install Node in ${distro}`,
            message: `Bake Pi could not install Node inside ${distro}.`,
            detail: error instanceof BakePiError && error.detail !== undefined
              ? error.detail
              : String(error),
            buttons: ["Close"],
            noLink: true,
          })
        }
        return false
      } finally {
        if (window !== undefined && !window.isDestroyed()) window.setProgressBar(-1)
      }
    }

    const openTarget = async (target: WorkspaceTarget) => {
      const previous = activeWorkspace
      try {
        const result = await supervisor.openWorkspace(target)
        activeWorkspace = { id: result.workspace.id, root: result.workspace.root, runtime: result.workspace.runtime }
        await recentWorkspace.remember(activeWorkspace)
        return result
      } catch (error) {
        if (
          target.runtime.kind === "wsl"
          && error instanceof BakePiError
          && error.code === "host_unavailable"
          && error.detail === "node_missing"
          && window !== undefined
          && !window.isDestroyed()
        ) {
          const distro = target.runtime.distro
          const choice = await dialog.showMessageBox(window, {
            type: "warning",
            title: `Node is required in ${distro}`,
            message: `${distro} cannot start the agent host.`,
            detail: `No Node 22 or newer was found in ${distro}. Bake Pi looks on the login-shell PATH, in fnm, nvm, volta, mise, asdf and n, and finally in your login shell's own interactive environment, so a version manager does not need to be on a non-interactive PATH.

Bake Pi can install its own copy inside ${distro}, under ~/.cache/bake-pi. It is used only by Bake Pi, it does not change your PATH, and a Node you install yourself later takes precedence over it. Opening through Windows instead works today, but file access uses the slower WSL share and tools run on Windows.`,
            buttons: [`Install ${managedNodeSummary()}`, "Open through Windows", "Cancel"],
            defaultId: 0,
            cancelId: 2,
            noLink: true,
          })
          if (choice.response === 0) {
            const installed = await installNodeInto(distro)
            if (installed) return await openTarget(target)
          }
          if (choice.response === 1) return await openTarget(windowsFallbackFor(target))
          if (previous !== undefined) {
            const restored = await supervisor.openWorkspace(previous)
            activeWorkspace = {
              id: restored.workspace.id,
              root: restored.workspace.root,
              runtime: restored.workspace.runtime,
            }
            return restored
          }
          await supervisor.start()
          await supervisor.attachRenderer({ reason: "runtime_switch" })
          activeWorkspace = undefined
          return undefined
        }
        if (previous !== undefined && !sameWorkspaceRuntime(previous.runtime, target.runtime)) activeWorkspace = undefined
        throw error
      }
    }
    installContentSecurityPolicy()
    /*
      The image route's only job is to turn a renderer fetch into the one
      command main issues on its own behalf. It goes straight to the
      supervisor rather than through `routeCommand`, because there is no
      renderer sender to guard and no gesture to check: the request already
      passed the renderer's CSP, and `read_image` is host-internal precisely so
      that the preload cannot offer it.
    */
    installAppProtocol(join(distRoot, "renderer"), async (ref) => await supervisor.execute("read_image", ref))
    installCommandRouter(supervisor, guard, {
      chooseWorkspace: async ({ startAt }) => {
        if (window === undefined || window.isDestroyed()) return {}
        /*
         * The one thing `bun run journey` cannot drive.
         *
         * A native directory dialog is an operating-system window with no DOM,
         * so the primary-journey suite answers it from the environment instead.
         * Only the picker is stubbed: the chosen root still travels the real
         * `open_workspace` command, through the same supervisor, into the same
         * host, and every screen after it is the shipped one. Setting this
         * requires already controlling the process environment, which is a
         * strictly larger capability than picking a directory the person at the
         * keyboard could have picked anyway.
         */
        const scripted = process.env.BAKE_PI_JOURNEY_WORKSPACE
        if (scripted !== undefined) return await openTarget({ root: scripted, runtime: WINDOWS_RUNTIME }) ?? {}
        const start = startAt === undefined ? undefined : locations.resolve(startAt)
        const picked = await dialog.showOpenDialog(window, {
          title: "Open a workspace",
          properties: ["openDirectory"],
          ...(start === undefined ? {} : { defaultPath: windowsPathFor(start) }),
        })
        const root = picked.filePaths[0]
        if (picked.canceled || root === undefined) return {}
        const runtime = start?.runtime ?? WINDOWS_RUNTIME
        return await openTarget({ root: hostPathFor(root, runtime), runtime }) ?? {}
      },
      listWorkspaceLocations: async () => {
        const [recent, wsl] = await Promise.all([recentWorkspace.list(), listWslHomes()])
        const parents = [...new Map(
          [...wsl, ...recent.map(workspaceParent)].map((target) => [JSON.stringify(target), target]),
        ).values()]
        return {
          recent: recent.map((target) => locations.offer(target)),
          wsl: wsl.map((target) => locations.offer(target)),
          parents: parents.map((target) => locations.offer(target)),
        }
      },
      reopenRecentWorkspace: async ({ id }) => {
        const target = id === undefined ? await recentWorkspace.read() : locations.resolve(id)
        if (target === undefined) return {}
        return await openTarget(target) ?? {}
      },
      createWorkspace: async ({ parent, name, initializeGit }) => {
        const target = await createWorkspaceTarget(locations.resolve(parent), name, initializeGit)
        const opened = await openTarget(target)
        if (opened === undefined) {
          throw new BakePiError("host_unavailable", { detail: "workspace_created_not_opened", retryable: true })
        }
        return opened
      },
      chooseAttachments: async ({ workspaceRoot, runtime }) => {
        if (window === undefined || window.isDestroyed()) return { attachments: [] }
        const target = activeWorkspace
        if (target === undefined || target.root !== workspaceRoot || !sameWorkspaceRuntime(target.runtime, runtime)) {
          throw new BakePiError("malformed_command", { detail: "workspace_runtime_mismatch" })
        }
        /*
         * The same stub the workspace picker needs, and for the same reason: a
         * native file dialog is an operating-system window with no DOM, so the
         * primary-journey suite names the file in the environment instead. Only
         * the picker is bypassed -- the file still travels the real
         * `choose_attachments` result, is read and encoded by the host, and
         * reaches the renderer as a `bakepi://image/...` block like any other
         * attachment, so the journey still proves the whole path.
         */
        const scripted = process.env.BAKE_PI_JOURNEY_ATTACHMENT
        const picked = scripted === undefined
          ? await dialog.showOpenDialog(window, {
            title: "Attach workspace files",
            defaultPath: windowsPathFor(target),
            properties: ["openFile", "multiSelections"],
            filters: [
              {
                name: "Code, text, and supported images",
                extensions: [
                  "txt", "md", "json", "jsonl", "ts", "tsx", "js", "jsx", "css", "html", "xml", "yaml",
                  "yml", "toml", "ini", "py", "rs", "go", "java", "c", "h", "cpp", "hpp", "cs", "sh", "ps1",
                  "png", "jpg", "jpeg", "gif", "webp",
                ],
              },
            ],
          })
          : { canceled: false, filePaths: [scripted] }
        if (picked.canceled) return { attachments: [] }
        const paths = picked.filePaths.slice(0, 16).map((pickedPath) => hostPathFor(pickedPath, target.runtime))
        // Sized together, then capped in order. The caps are arithmetic over
        // the answers, so they cost nothing to apply in a second pass — and
        // doing so keeps the sizing off the critical path it used to hold,
        // where a WSL selection paid one process launch per file in series.
        const sizes = target.runtime.kind === "wsl"
          ? await wslFileSizes(target.runtime.distro, paths)
          : (await Promise.all(paths.map(async (path) => (await stat(path)).size)))
        let aggregateBytes = 0
        const attachments: Attachment[] = []
        for (const [index, path] of paths.entries()) {
          const bytes = sizes[index]!
          aggregateBytes += bytes
          if (bytes > MAX_ATTACHMENT_BYTES || aggregateBytes > MAX_ATTACHMENT_BYTES) {
            throw new BakePiError("payload_too_large", { detail: "attachments" })
          }
          attachments.push({ path, mediaType: attachmentMediaType(path), bytes })
        }
        return { attachments }
      },
      revealLogFile: async () => {
        const path = logFilePath()
        if (path === undefined) throw new BakePiError("internal_error", { detail: "no_log_file" })
        shell.showItemInFolder(path)
        return await Promise.resolve({ path })
      },
      pi: {
        status: () => pi.status(),
        releases: async () => await pi.releases(),
        install: (params) => pi.install(params),
        use: async (params) => await pi.use(params),
        remove: (params) => pi.remove(params),
      },
    }, () => resourceProbe?.sample("command"))

    /*
     * The renderer and Pi host do not depend on each other until the event port
     * is transferred, so start them together. Starting the host only after
     * `loadURL` completed put its entire module-evaluation leg on the critical
     * path even though Chromium was idle from the host's point of view.
     *
     * Attach a rejection handler immediately because the host may fail while
     * the window is still loading. The original promise is awaited below, after
     * a window exists to receive the disconnected notice.
     */
    const hostReady = supervisor.start()
    void hostReady.catch(() => undefined)
    try {
      window = await createMainWindow({
        preload: join(distRoot, "preload/index.cjs"),
        statePath: join(app.getPath("userData"), "window-state.json"),
        // On Windows the packaged executable's own resource is the window icon.
        // In development the binary is the stock Electron and would show its
        // logo, and on Linux there is no resource at all, so both read the
        // bitmap the build renders (and `forge.config.ts` stages).
        ...(app.isPackaged && process.platform === "win32" ? {} : { icon: join(distRoot, "..", "build/icon.png") }),
      })
      installUpdater()
    } catch (error) {
      await supervisor.stop()
      throw error
    }
    startup.mark("windowLoaded")
    guard.bind(window.webContents)

    const ack = await hostReady
    await supervisor.attachRenderer({ reason: "initial" })
    startup.mark("hostAttached")

    /*
     * A reloaded renderer has no event port, and nothing else would give it one.
     *
     * The port is transferred once at startup, and a transfer belongs to the
     * document that received it. Reload the renderer — a crash Electron
     * recovers from, a devtools reload — and the new document has no port,
     * receives no events, and sits on "Warming the workbench" forever while a
     * perfectly healthy host talks to nobody. Restarting the whole application
     * was the only way out, which is not a recovery story.
     *
     * Every event this listener sees is a reload. `createMainWindow` awaits
     * `loadURL`, so the first load has already finished by the time the handler
     * is registered — which matters, because `attachEventChannel` opens a fresh
     * channel on each call and two live ports would deliver every event twice.
     */
    let restoreRendererProjection = false
    let unresponsiveTimer: NodeJS.Timeout | undefined
    const clearUnresponsive = (): void => {
      if (unresponsiveTimer !== undefined) clearTimeout(unresponsiveTimer)
      unresponsiveTimer = undefined
    }
    window.webContents.on("did-finish-load", () => {
      clearUnresponsive()
      if (window === undefined || window.isDestroyed() || !supervisor.running) return
      const restoreProjection = restoreRendererProjection
      restoreRendererProjection = false
      void supervisor.attachRenderer({ reason: restoreProjection ? "renderer_recovery" : "reload" }).catch((error) => {
        console.error("[main] could not attach renderer event channel", error)
        announceHostConnection({ status: "disconnected", error: toContractError(error) })
      })
    })

    const recoverRenderer = (reason: string): void => {
      if (quit.quitting || window === undefined || window.isDestroyed()) return
      if (!rendererBudget.record()) {
        console.error(`[main] renderer recovery budget exhausted after ${reason}`)
        return
      }
      console.error(`[main] reloading renderer after ${reason}`)
      restoreRendererProjection = true
      window.webContents.reload()
    }
    window.webContents.on("unresponsive", () => {
      if (unresponsiveTimer !== undefined || quit.quitting) return
      unresponsiveTimer = setTimeout(() => {
        unresponsiveTimer = undefined
        recoverRenderer("10 seconds unresponsive")
      }, 10_000)
      unresponsiveTimer.unref()
    })
    window.webContents.on("responsive", () => {
      clearUnresponsive()
    })
    window.webContents.on("render-process-gone", (_event, details) => {
      clearUnresponsive()
      if (details.reason === "clean-exit" || quit.quitting) return
      recoverRenderer(`${details.reason} (exit ${String(details.exitCode)})`)
    })

    // Not while a probe is driving the app: smoke and the journey run against a
    // bundle nothing is rebuilding, and a watcher there would only be one more
    // handle to shut down.
    if (smokeOutput === undefined) watchRendererBundle(join(distRoot, "renderer"), window)

    resourceProbe?.start()

    if (smokeOutput !== undefined) {
      const rendererReady = await waitForRendererHostReady()
      if (!rendererReady) {
        throw new BakePiError("handshake_failed", { detail: "renderer_event_port", retryable: true })
      }
      startup.mark("rendererReady")
      const facts = {
        ok: true,
        rendererReady,
        piVersion: ack.piVersion,
        nodeVersion: ack.nodeVersion,
        contractVersion: ack.contractVersion,
        features: ack.features,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        stylePolicy: await probeStylePolicy(),
        imageOrigin: await probeImageOrigin(),
        fonts: await probeRendererFonts(),
        startup: readStartupTimings(startup, ack.startup),
        // Last, because it takes the live event port away from the renderer.
        eventIntake: await probeEventIntake(),
      }
      // Written twice on purpose. The first write is the report as it stands
      // before anything is asked to stop, so a shutdown that hangs still leaves
      // evidence of a successful startup rather than presenting to the driver as
      // an application that produced nothing — which is the same failure a
      // broken preload produces, and the two need to be told apart. The second
      // write adds what the first could not know yet.
      await reportSmoke(facts)
      const shutdown = await supervisor.stop()
      await reportSmoke({ ...facts, shutdown })
      app.exit(0)
    }
  }

  /**
   * `.then()`, and deliberately not `await app.whenReady()` at the top level.
   *
   * Measured on Electron 44: an ESM main process does not become ready until its
   * entry module finishes evaluating, so a top-level `await app.whenReady()`
   * deadlocks — the module waits for `ready`, and `ready` waits for the module
   * to finish. The application starts, reports nothing, and hangs forever.
   *
   * Unrelated top-level awaits are fine: they resolve, the module finishes, and
   * `ready` then fires. It is specifically awaiting readiness from inside the
   * entry module that cannot resolve.
   */
  app.whenReady().then(() => bootstrap().catch(onStartupFailure), onStartupFailure)
}
