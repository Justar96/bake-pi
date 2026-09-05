/**
 * Drives the primary journey through the real interface, in real Electron.
 *
 * `bun run smoke` proves the application starts and that one event survives the
 * policy. Neither says a person can use it. Every screen between opening a
 * workspace and resuming a session is composition — a button wired to a store
 * action wired to a command wired to a host — and composition is exactly what
 * unit tests cannot see. A model selector that dispatches the wrong provider, an
 * approval whose decision never reaches Pi, a Stop that leaves the turn running:
 * each of those passes every suite in this repository and fails the product.
 *
 * So this drives the shipped renderer the way a person does. It finds controls
 * by their accessible name, clicks them, types into the composer, and asserts on
 * what the DOM then says — which means it also fails if the interface stops
 * being operable by name, the property the screen-reader work depends on.
 *
 * Nothing here is a stub except the two things that cannot be otherwise. The
 * model is `provider-fixture.ts` — a real OpenAI-compatible server Pi reaches
 * over a socket, so Pi's own request building, SSE parsing and tool-call
 * assembly are all in the path. And the native directory picker, which no
 * automation can drive, is answered from the environment by main.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { agentDirWith, startModelServer } from "../packages/agent-host/test/provider-fixture.ts"
import { LARGE_SESSION_BLOCKS, startFrameProbe, type RendererFrameProbe } from "./frame-budget.ts"
import { withJourneyDeadline } from "./journey-deadline.ts"

const root = join(import.meta.dir, "..")
const STEP_TIMEOUT_MS = 20_000

const electronBinary =
  process.platform === "win32"
    ? join(root, "node_modules/electron/dist/electron.exe")
    : process.platform === "darwin"
      ? join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
      : join(root, "node_modules/electron/dist/electron")

/**
 * Helpers injected ahead of every expression, so each assertion reads as one
 * line rather than as a paragraph of DOM traversal.
 *
 * `named` deliberately matches on the accessible name — `aria-label` first, then
 * text — rather than on a test id. A test id would keep passing after the label
 * a screen reader announces had been deleted, which is the regression this suite
 * is best placed to catch and a test id would be blind to.
 */
const PREAMBLE = `
const $root = () => document.getElementById("root")
const text = () => $root()?.textContent ?? ""
const accessibleName = (el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\\s+/g, " ").trim()
const named = (name) => [...document.querySelectorAll("button")].find((el) => accessibleName(el).includes(name))
const clickableNamed = (name) => [...document.querySelectorAll("button, label")].find((el) => accessibleName(el).includes(name))
/*
 * React installs its own value setter on the element, so assigning \`value\`
 * directly updates the DOM and leaves React's copy stale. Calling the
 * prototype's setter and then dispatching is what a keystroke does.
 */
const type = (selector, value) => {
  const el = document.querySelector(selector)
  if (el === null) throw new Error("no field matching " + selector)
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value)
  el.dispatchEvent(new Event("input", { bubbles: true }))
  return true
}
const timeline = () => document.querySelector('[aria-label="Conversation timeline"]')?.textContent ?? ""
`

/** One Chrome DevTools Protocol connection to the page, and the three things this suite asks of it. */
interface Page {
  evaluate: <T>(expression: string) => Promise<T>
  /** Captures the renderer exactly as Chromium painted it for optional visual QA. */
  screenshot: (path: string) => Promise<void>
  /** Optional diagnostic sampling; profiled runs are not baseline performance measurements. */
  startProfile: () => Promise<void>
  stopProfile: (path: string) => Promise<void>
  /** Native layout/paint/GC timing alongside JavaScript for load-spike diagnosis. */
  startTrace: () => Promise<void>
  stopTrace: (path: string) => Promise<void>
  /** Presses a control where it is drawn, with a mouse event the browser itself synthesizes. */
  click: (name: string) => Promise<void>
  /** Drags one tree row onto a selector through Chromium's real pointer path. */
  drag: (name: string, target: string) => Promise<void>
  /** Rolls the wheel over a named region, so scroll intent reaches the real event path. */
  wheel: (name: string, deltaY: number) => Promise<void>
  close: () => void
}

/**
 * Electron's stderr, accumulated as it arrives.
 *
 * Read incrementally rather than at the end, for two reasons. A piped stream
 * nobody drains fills its buffer and blocks the child; and the debugging
 * endpoint's port is announced on this stream, so waiting for the line is what
 * removes the guess. Asking for a specific `--remote-debugging-port` and
 * assuming it was honoured is what the first version of this did, and a run
 * where it was not presented as "the renderer never appeared".
 */
class Diagnostic {
  #text = ""
  constructor(stream: ReadableStream<Uint8Array>) {
    void (async () => {
      const decoder = new TextDecoder()
      for await (const piece of stream) this.#text += decoder.decode(piece, { stream: true })
    })()
  }

  get text(): string {
    return this.#text
  }

  /** The `DevTools listening on ws://…` line, which Electron prints once the endpoint is up. */
  async endpoint(): Promise<number> {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const found = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(this.#text)
      if (found?.[1] !== undefined) return Number(found[1])
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`Electron never announced a debugging endpoint
${this.#text.slice(0, 1_000)}`)
  }
}

const setFixtureWindowState = async (pid: number, state: "minimized" | "normal"): Promise<void> => {
  // Electron has no Browser.setWindowBounds CDP command. Use the fixture's
  // PID, never a window-title match that could touch a person's other app.
  const command = Bun.spawn(["powershell.exe", "-NoProfile", "-Command", `
    $ErrorActionPreference = 'Stop'
    Add-Type -Namespace BakePiJourney -Name Native -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindowAsync(System.IntPtr handle, int command); [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr handle);'
    $handle = (Get-Process -Id ${String(pid)}).MainWindowHandle
    if ($handle -eq 0) { throw 'the fixture has no native window' }
    [void][BakePiJourney.Native]::ShowWindowAsync($handle, ${state === "minimized" ? "6" : "9"})
    ${state === "normal" ? "[void][BakePiJourney.Native]::SetForegroundWindow($handle)" : ""}
  `], { stdout: "ignore", stderr: "pipe" })
  const error = new Response(command.stderr).text()
  try {
    const [exit, detail] = await withJourneyDeadline(Promise.all([command.exited, error]), STEP_TIMEOUT_MS, `set fixture window ${state}`)
    if (exit !== 0) throw new Error(`could not set fixture window ${state}: ${detail}`)
  } finally {
    command.kill()
    await command.exited
  }
}

const attach = async (port: number, fixturePid: number): Promise<Page> => {
  const deadline = Date.now() + 30_000
  let socketUrl: string | undefined
  while (Date.now() < deadline && socketUrl === undefined) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${String(port)}/json/list`, { signal: AbortSignal.timeout(STEP_TIMEOUT_MS) })).json()) as {
        type: string
        url: string
        webSocketDebuggerUrl?: string
      }[]
      // The renderer, not a devtools page of its own. The scheme is the private
      // one `main/protocol.ts` registers; matching on it rather than on "the
      // first page" is what keeps this pointed at the application.
      socketUrl = targets.find((target) => target.type === "page" && target.url.startsWith("bakepi://"))?.webSocketDebuggerUrl
    } catch {
      // The debugging endpoint is not listening yet; the deadline governs.
    }
    if (socketUrl === undefined) await new Promise<void>((resolve) => setTimeout(resolve, 100))
  }
  if (socketUrl === undefined) throw new Error("no bakepi:// page appeared on the debugging endpoint")

  const socket = new WebSocket(socketUrl)
  try {
    await withJourneyDeadline(new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true })
      socket.addEventListener("error", () => reject(new Error("could not attach to the renderer")), { once: true })
    }), STEP_TIMEOUT_MS, "connect to the renderer")
  } catch (error) {
    socket.close()
    throw error
  }

  let nextId = 0
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  /*
   * A closed connection settles everything still waiting on it.
   *
   * Without this a request outstanding when the socket dies never settles, and
   * the suite hangs rather than failing — which is what a page navigation used
   * to do here, and it presents as a timeout with no message at all.
   */
  socket.addEventListener("close", () => {
    for (const waiter of pending.values()) waiter.reject(new Error("the renderer connection closed"))
    pending.clear()
  })

  let traceFinished: ((stream: string) => void) | undefined
  let interceptedDrag: { resolve: (data: unknown) => void } | undefined
  socket.addEventListener("message", (event: MessageEvent) => {
    const message = JSON.parse(String(event.data)) as { id?: number; method?: string; params?: { data?: unknown; stream?: string }; result?: unknown; error?: { message: string } }
    if (message.method === "Tracing.tracingComplete" && message.params?.stream !== undefined) {
      traceFinished?.(message.params.stream)
      traceFinished = undefined
      return
    }
    if (message.method === "Input.dragIntercepted" && message.params?.data !== undefined) {
      interceptedDrag?.resolve(message.params.data)
      interceptedDrag = undefined
      return
    }
    if (message.id === undefined) return
    const waiter = pending.get(message.id)
    if (waiter === undefined) return
    pending.delete(message.id)
    if (message.error === undefined) waiter.resolve(message.result)
    else waiter.reject(new Error(message.error.message))
  })

  const send = async (method: string, params: Record<string, unknown>, operation: string = method): Promise<unknown> => {
    const id = ++nextId
    const answer = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject })
    })
    try {
      socket.send(JSON.stringify({ id, method, params }))
      return await withJourneyDeadline(answer, STEP_TIMEOUT_MS, operation)
    } finally {
      // An open but unresponsive socket never fires `close`. Retire this id
      // on timeout too, so a late reply cannot retain or settle an old waiter.
      pending.delete(id)
    }
  }

  const evaluateAt = async <T>(expression: string, operation = "evaluate the renderer"): Promise<T> => {
      const answer = (await send("Runtime.evaluate", {
        expression: `(() => {${PREAMBLE}\nreturn (${expression})})()`,
        awaitPromise: true,
        returnByValue: true,
      }, operation)) as {
        result: { value?: T }
        exceptionDetails?: { exception?: { description?: string }; text: string }
      }
    const thrown = answer.exceptionDetails
    if (thrown !== undefined) throw new Error(thrown.exception?.description ?? thrown.text)
    return answer.result.value as T
  }

  const foreground = async (): Promise<void> => {
    await send("Page.bringToFront", {})
    // bringToFront focuses Electron's WebContents but does not restore a
    // minimized native window. Restore only when hidden or unfocused, and
    // await both states rather than assuming the Win32 request already landed.
    if (process.platform === "win32" && await evaluateAt<boolean>('document.visibilityState === "hidden" || !document.hasFocus()')) {
      await setFixtureWindowState(fixturePid, "normal")
    }
    await evaluateAt(`new Promise((resolve) => {
      const visible = () => {
        if (document.visibilityState !== "visible" || !document.hasFocus()) return
        document.removeEventListener("visibilitychange", visible)
        window.removeEventListener("focus", visible)
        resolve(true)
      }
      document.addEventListener("visibilitychange", visible)
      window.addEventListener("focus", visible)
      visible()
    })`, "bring the fixture into view")
  }

  return {
    evaluate: evaluateAt,
    startProfile: async (): Promise<void> => {
      await send("Profiler.enable", {})
      await send("Profiler.start", {})
    },
    stopProfile: async (path: string): Promise<void> => {
      const { profile } = await send("Profiler.stop", {}) as { profile: unknown }
      writeFileSync(path, JSON.stringify(profile), "utf8")
      await send("Profiler.disable", {})
    },
    startTrace: async (): Promise<void> => {
      await send("Tracing.start", {
        categories: "devtools.timeline,v8,blink.user_timing,disabled-by-default-devtools.timeline,disabled-by-default-v8.gc",
        transferMode: "ReturnAsStream",
      })
    },
    stopTrace: async (path: string): Promise<void> => {
      const finished = new Promise<string>((resolve) => { traceFinished = resolve })
      await send("Tracing.end", {})
      const handle = await withJourneyDeadline(finished, STEP_TIMEOUT_MS, "finish the load trace")
      const chunks: string[] = []
      try {
        for (;;) {
          const chunk = await send("IO.read", { handle }) as { data: string; base64Encoded?: boolean; eof: boolean }
          chunks.push(chunk.base64Encoded === true ? Buffer.from(chunk.data, "base64").toString("utf8") : chunk.data)
          if (chunk.eof) break
        }
        writeFileSync(path, chunks.join(""), "utf8")
      } finally {
        await send("IO.close", { handle })
      }
    },
    screenshot: async (path: string): Promise<void> => {
      const result = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }) as { data: string }
      writeFileSync(path, Buffer.from(result.data, "base64"))
    },
    /*
     * A real mouse event at the control's own coordinates, not `el.click()`.
     *
     * Not fastidiousness — the difference decides whether the journey can run
     * at all. `guard.ts` refuses `choose_workspace`, `set_project_trust`,
     * `set_api_key` and five others unless Electron's own `before-input-event`
     * saw a `mouseDown` recently, precisely so that a timer or a stream handler
     * cannot grant trust. A scripted `el.click()` produces no such event and is
     * refused, exactly as a hostile renderer would be.
     *
     * Dispatching through the protocol also asserts something a synthetic click
     * cannot: that the control is where it appears to be, is not covered, and
     * has a box at all.
     */
    click: async (name: string): Promise<void> => {
      // Chromium can suspend animation completion in an occluded/minimized
      // document. Waiting for it before activating the page stranded a click
      // indefinitely. These are foreground interaction measurements: activate
      // this fixture, not a user's other Bake Pi window, before waiting on paint.
      await foreground()
      const literal = JSON.stringify(name)
      /*
       * Measured after every finite animation has finished, because a control
       * that is still arriving is not yet where it appears to be.
       *
       * `waitFor` sees content the moment React renders it, possibly before a
       * nearby transition has settled. Reading the final box after finite
       * motion finishes keeps the mouse event aligned with what a person sees.
       *
       * Infinite animations are excluded and have to be: the streaming spinner
       * never finishes, and awaiting it would hang every click in the suite.
       */
      const box = await evaluateAt<{ x: number; y: number }>(`(async () => {
        const settling = document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        await Promise.all(settling.map((animation) => animation.finished.catch(() => undefined)))
        const el = clickableNamed(${literal})
        if (el === undefined) throw new Error("no control named " + ${literal})
        el.scrollIntoView({ block: "center" })
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) throw new Error("the control named " + ${literal} + " is not drawn")
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      })()`, `locate control ${name}`)
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", {
          type,
          x: box.x,
          y: box.y,
          button: "left",
          buttons: type === "mousePressed" ? 1 : 0,
          clickCount: 1,
        })
      }
    },
    drag: async (name: string, target: string): Promise<void> => {
      await foreground()
      const nameLiteral = JSON.stringify(name)
      const targetLiteral = JSON.stringify(target)
      const boxes = await evaluateAt<{ source: { x: number; y: number }; target: { x: number; y: number } }>(`(async () => {
        const settling = document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        await Promise.all(settling.map((animation) => animation.finished.catch(() => undefined)))
        const source = [...document.querySelectorAll('[draggable="true"]')].find((el) => accessibleName(el).includes(${nameLiteral}))
        const destination = document.querySelector(${targetLiteral})
        if (source === undefined) throw new Error("no draggable row named " + ${nameLiteral})
        if (destination === null) throw new Error("no drop target matching " + ${targetLiteral})
        const from = source.getBoundingClientRect()
        const to = destination.getBoundingClientRect()
        if (from.width === 0 || from.height === 0) throw new Error("the draggable row is not drawn")
        if (to.width === 0 || to.height === 0) throw new Error("the drop target is not drawn")
        return {
          source: { x: from.left + from.width / 2, y: from.top + from.height / 2 },
          target: { x: to.left + to.width / 2, y: to.top + to.height / 2 },
        }
      })()`)

      await send("Input.setInterceptDrags", { enabled: true })
      const data = new Promise<unknown>((resolve) => { interceptedDrag = { resolve } })
      try {
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...boxes.source })
        await send("Input.dispatchMouseEvent", { type: "mousePressed", ...boxes.source, button: "left", buttons: 1, clickCount: 1 })
        // Cross Chromium's drag threshold through the real pointer path. Once
        // Chromium has run the source's `dragstart`, interception gives the
        // protocol the exact DataTransfer it produced, custom MIME type included.
        for (let index = 1; index <= 3; index += 1) {
          await send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: boxes.source.x + 12 * index,
            y: boxes.source.y + 4 * index,
            button: "left",
            buttons: 1,
          })
        }
        const dragData = await withJourneyDeadline(data, 2_000, "Chromium beginning the drag")
        for (const type of ["dragEnter", "dragOver", "drop"]) {
          await send("Input.dispatchDragEvent", { type, ...boxes.target, data: dragData })
        }
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...boxes.target, button: "left", buttons: 0, clickCount: 1 })
      } finally {
        interceptedDrag = undefined
        await send("Input.setInterceptDrags", { enabled: false })
      }
    },
    wheel: async (name: string, deltaY: number): Promise<void> => {
      await foreground()
      const literal = JSON.stringify(name)
      const box = await evaluateAt<{ x: number; y: number }>(`(() => {
        const el = [...document.querySelectorAll("[aria-label]")].find((candidate) => accessibleName(candidate) === ${literal})
        if (el === undefined) throw new Error("no region named " + ${literal})
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) throw new Error("the region named " + ${literal} + " is not drawn")
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      })()`)
      await send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: box.x,
        y: box.y,
        deltaX: 0,
        deltaY,
      })
    },
    close: () => {
      socket.close()
    },
  }
}

/**
 * Waits for a claim about the interface to become true.
 *
 * Polling rather than a fixed pause: every step here waits on a round trip
 * through the host and back, and a sleep long enough to cover the slowest of
 * them on a loaded machine would make the suite mostly sleep. The failure
 * message carries what the screen said instead, because "timed out" alone
 * cannot distinguish a slow host from a wrong screen.
 */
const waitFor = async (page: Page, claim: string, description: string): Promise<void> => {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  let last: unknown
  while (Date.now() < deadline) {
    last = await page.evaluate<boolean>(claim)
    if (last === true) return
    await new Promise<void>((resolve) => setTimeout(resolve, 60))
  }
  const shown = await page.evaluate<string>("text().replace(/\\s+/g, ' ').slice(0, 400)")
  throw new Error(`${description} did not happen within ${String(STEP_TIMEOUT_MS / 1000)}s\n  the screen said: ${shown}`)
}

const steps: { name: string; ms: number }[] = []
let activeStep: string | undefined
const step = async (name: string, body: () => Promise<void>): Promise<void> => {
  activeStep = name
  const startedAt = performance.now()
  await body()
  const ms = performance.now() - startedAt
  steps.push({ name, ms })
  // Printed as it happens rather than collected for the end: a run that hangs
  // has to say which step it hung on, and a summary printed after the last one
  // is exactly the output a hang does not reach.
  console.log(`  ${ms.toFixed(0).padStart(6)} ms  ${name}`)
}

/**
 * Reads the host's own duration for the last session command the interface sent.
 *
 * A journey step includes the mouse event, two process crossings, state update
 * and React render. That is the number a person feels. This is the nested Pi
 * leg: dispatch through constructing or reopening the real AgentSession and
 * producing its snapshot, measured entirely on the host's monotonic clock.
 */
const reportSessionCommand = async (page: Page, command: "create_session" | "open_session"): Promise<void> => {
  const name = `command.${command}`
  const ms = await page.evaluate<number | undefined>(`(async () => {
    const report = await window.bakePi.commands.get_timings({})
    for (let index = report.recent.length - 1; index >= 0; index -= 1) {
      if (report.recent[index].name === ${JSON.stringify(name)}) return report.recent[index].ms
    }
    return undefined
  })()`)
  if (ms === undefined) throw new Error(`the host did not report ${name}`)
  console.log(`  ${ms.toFixed(0).padStart(6)} ms    Pi host ${command.replace("_", " ")}`)
}

/** Reproduces the unterminated final write measured in the session durability suite. */
const tearOnlySession = (agentDir: string): void => {
  const files = [...new Bun.Glob("sessions/**/*.jsonl").scanSync({ cwd: agentDir, absolute: true })]
  if (files.length !== 1) throw new Error(`expected one journey session file, found ${String(files.length)}`)

  const file = files[0]!
  const lines = readFileSync(file, "utf8").split(/\n/u).filter(Boolean)
  const last = lines.at(-1)
  if (last === undefined || last.length <= 24) throw new Error("the journey session has no entry large enough to tear")
  writeFileSync(file, [...lines, last.slice(0, 24)].join("\n"), "utf8")
}

interface PersistedMessageEntry {
  type?: string
  message?: {
    role?: string
    content?: unknown
    [key: string]: unknown
  }
  [key: string]: unknown
}

/**
 * Builds the large-session fixture in the format Pi already wrote.
 *
 * The session is closed before this runs, so the harness is not a second
 * writer. It changes one assistant message in its own temporary session and
 * then asks Bake Pi to discover and open that file normally; parsing, mapping,
 * projection, virtualization, and painting all remain production paths.
 */
/** One part of an assistant turn, in the shapes Pi persists and reads back. */
type PersistedPart =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown }

/** One tool result to append after the turn, so its call reads as finished. */
interface PersistedResult {
  toolCallId: string
  toolName: string
  text: string
}

const replaceLastAssistantTurn = (agentDir: string, parts: PersistedPart[], results: PersistedResult[] = []): string => {
  const files = [...new Bun.Glob("sessions/**/*.jsonl").scanSync({ cwd: agentDir, absolute: true })]
  if (files.length !== 1) throw new Error(`expected one journey session file, found ${String(files.length)}`)

  const lines = readFileSync(files[0]!, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
  const entries: PersistedMessageEntry[] = []
  for (const [index, line] of lines.entries()) {
    try {
      entries.push(JSON.parse(line) as PersistedMessageEntry)
    } catch (error) {
      // The primary journey deliberately leaves one torn final entry before
      // this optional measurement. Pi already reported and ignored it when the
      // session reopened. Only that final fragment may be omitted here; an
      // invalid entry in the middle is a different durability failure.
      if (index !== lines.length - 1) throw error
    }
  }
  const target = entries.findLast((entry) => entry.type === "message" && entry.message?.role === "assistant")
  if (target?.message === undefined) throw new Error("the journey session has no assistant message to expand")
  const header = entries.find((entry) => entry.type === "session")
  if (typeof header?.id !== "string") throw new Error("the journey session header has no id")

  target.message.content = parts
  /*
   * Appended, and chained.
   *
   * `toolCallOutcomes` finds a result anywhere in the history, so position
   * alone would not matter — but Pi's session file is a parent-linked tree,
   * not a list, and it reads back the branch it can walk. An entry with no
   * `parentId` starts a second root, and the session then loads as those
   * orphans alone: the first attempt at this wrote two results that way and
   * the whole conversation came back as one row.
   */
  let parentId = entries.at(-1)?.id
  for (const result of results) {
    const id = crypto.randomUUID().slice(0, 8)
    entries.push({
      type: "message",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        content: [{ type: "text", text: result.text }],
        isError: false,
        timestamp: Date.now(),
      },
    })
    parentId = id
  }
  writeFileSync(files[0]!, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8")
  return header.id
}

const replaceLastAssistantWithBlocks = (agentDir: string, count: number): string =>
  replaceLastAssistantTurn(
    agentDir,
    Array.from({ length: count }, (_unused, index) => ({ type: "text", text: `Budget block ${String(index + 1)}` })),
  )

/**
 * A reasoning-led turn, written straight into the session file.
 *
 * The fixture provider has no reasoning to script and no shell to run, so the
 * two things this covers — a phase heading with its tools branching off it,
 * and a command grouped with what it printed — have no other way to reach a
 * real renderer. Pi reads this back through the same loader the crash-recovery
 * step above exercises, so the rows under test are projected, virtualized and
 * painted by production code; only the model's decisions are fabricated.
 */
const REASONING_LED_TURN: PersistedPart[] = [
  { type: "thinking", thinking: "I need two more facts before answering:" },
  { type: "toolCall", id: "crafted-read", name: "read", arguments: { path: "src/value.ts" } },
  { type: "toolCall", id: "crafted-shell", name: "bash", arguments: { command: "echo grouped" } },
]

const REASONING_LED_RESULTS: PersistedResult[] = [
  { toolCallId: "crafted-read", toolName: "read", text: "export const value = 1\n" },
  // Deliberately not what `echo grouped` would print: the assertion is that
  // the command and its output are two halves of one block, which a result
  // echoing the command back could not distinguish.
  { toolCallId: "crafted-shell", toolName: "bash", text: "one transcript\n" },
]

const temporary: string[] = []
let child: ReturnType<typeof Bun.spawn> | undefined
let page: Page | undefined
let diagnostic: Diagnostic | undefined
let model: Awaited<ReturnType<typeof startModelServer>> | undefined

try {
  const server = await startModelServer()
  model = server
  const extensionDir = mkdtempSync(join(tmpdir(), "bakepi-journey-extension-"))
  temporary.push(extensionDir)
  const extensionPath = join(extensionDir, "provider-fixture.ts")
  writeFileSync(
    extensionPath,
    `export default function (pi) {
  pi.registerProvider("journey-extension", {
    name: "Journey extension",
    baseUrl: ${JSON.stringify(server.baseUrl)},
    apiKey: "fixture-key",
    api: "openai-completions",
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    models: [{
      id: "extension-model",
      name: "Extension model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32000,
      maxTokens: 2048,
    }, {
      // The second model exists for its id alone. Every other model in the
      // journey is named after the fixture that serves it, so none of them
      // reaches a lab, and a picker with no marks in it cannot tell a lab
      // mark that stopped rendering from a catalogue that never had one.
      // This one is a Qwen id on a fixture endpoint: what it proves is that
      // the mark follows the model rather than the provider serving it.
      id: "qwen3-journey",
      name: "Qwen journey",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32000,
      maxTokens: 2048,
    }],
  })
  /*
    Pi's plan is an extension's, not the agent's: the host recognizes a tool
    result whose name is "todo" and whose details carry a "todos" array, which
    is the shape Pi's own example extension writes. A journey that wants to see
    the rail's plan panel has to write one, and a fixed list is what makes "2
    of 4 complete" an assertion rather than a reading of whatever a model felt
    like planning. The schema is a plain object because Pi hands "parameters"
    to the provider and passes the arguments to execute unchecked.
  */
  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: "Record the plan for the current task",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      return {
        content: [{ type: "text", text: "plan written" }],
        details: {
          action: "list",
          nextId: 5,
          todos: [
            { id: 1, text: "Read the request", done: true },
            { id: 2, text: "Sketch the rail", done: true },
            { id: 3, text: "Move the plan into it", status: "in_progress" },
            { id: 4, text: "Gate it in the journey", done: false },
          ],
        },
      }
    },
  })
  pi.on("before_agent_start", async (event, ctx) => {
    if (event.prompt !== "ask me") return
    const answer = await ctx.ui.select("How many flavors should we launch?", ["Three (core line)", "Five (full case)", "Just one hero"])
    return { systemPrompt: event.systemPrompt + "\\n\\nLaunch choice: " + (answer ?? "skipped") }
  })
}
`,
    "utf8",
  )
  /*
    A second extension that registers nothing. Pi names an extension resource
    after its file, so this one exists to put the word "sentry" in the
    resource list — the only way to see a vendor mark resolve, since every
    other resource the journey loads is named after the fixture that serves
    it and names no vendor at all.
  */
  const vendorExtensionPath = join(extensionDir, "sentry.ts")
  writeFileSync(vendorExtensionPath, "export default function () {}"+"\n", "utf8")
  const agentDir = agentDirWith(server.baseUrl, [extensionPath, vendorExtensionPath])
  temporary.push(agentDir)

  const workspace = mkdtempSync(join(tmpdir(), "bakepi-journey-"))
  temporary.push(workspace)
  const profile = mkdtempSync(join(tmpdir(), "bakepi-journey-profile-"))
  temporary.push(profile)
  const initialized = Bun.spawnSync(["git", "init", "--quiet", workspace])
  if (initialized.exitCode !== 0) throw new Error("the journey workspace could not be initialized as a Git repository")
  mkdirSync(join(workspace, "src"), { recursive: true })
  writeFileSync(join(workspace, ".gitignore"), "ignored.log\n", "utf8")
  writeFileSync(join(workspace, "ignored.log"), "visible when ignored files are shown\n", "utf8")
  writeFileSync(join(workspace, "src", "value.ts"), "export const value = 1\n", "utf8")

  /*
   * A real PNG, because the assertion is that Chromium decoded it.
   *
   * The image path is the one part of the conversation renderer that no unit
   * test can reach: it needs the CSP to admit a second origin, the privileged
   * scheme to be registered before the window loads, main to answer the fetch
   * with the host-internal command, and the host to still hold the bytes. Each
   * of those fails as a blank frame with nothing in the log, so the journey
   * attaches this file and then asks the element for its `naturalWidth`.
   */
  const pixel = join(workspace, "pixel.png")
  writeFileSync(pixel, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ))

  // Outside the workspace on purpose. Trust lets a tool write *inside* without
  // asking, so a write within it would never raise the card this journey has to
  // click — and the outside-target case is the one the approval policy exists
  // for anyway.
  const outside = join(tmpdir(), `bakepi-journey-outside-${String(process.pid)}.txt`)
  temporary.push(outside)

  // The write that Escape refuses. A path of its own, because the assertion is
  // that this file does not exist — sharing the allowed write's path would
  // make a denial that silently wrote look exactly like a denial that worked.
  const refused = join(tmpdir(), `bakepi-journey-refused-${String(process.pid)}.txt`)
  temporary.push(refused)

  const overflowReply = Array.from(
    { length: 24 },
    (_unused, index) => `Detail ${String(index + 1)}: the fixture keeps enough rendered history to exercise transcript following.`,
  ).join("\n\n")

  server.script(
    { text: ["Five flavors selected"] },
    { text: ["Hel", "lo ", `there\n\n${overflowReply}`] },
    { toolCalls: [{ id: "call-1", name: "write", args: { path: outside, content: "written by the agent" } }] },
    { text: ["the file is written"] },
    { toolCalls: [{ id: "call-2", name: "write", args: { path: refused, content: "this write is refused" } }] },
    { text: ["the write was refused"] },
    { text: ["one pixel, received"] },
    { toolCalls: [{ id: "todo-1", name: "todo", args: {} }] },
    { text: ["the plan is in the rail"] },
    { text: ["thinking"], stall: true },
    { text: ["selection-safe"], stall: true },
  )

  child = Bun.spawn([electronBinary, "--remote-debugging-port=0", `--user-data-dir=${profile}`, join(root, "apps/desktop")], {
    env: {
      ...process.env,
      BAKE_PI_JOURNEY_WORKSPACE: workspace,
      BAKE_PI_JOURNEY_ATTACHMENT: pixel,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    },
    stdout: "ignore",
    stderr: "pipe",
  })

  const fixturePid = child.pid
  diagnostic = new Diagnostic(child.stderr as ReadableStream<Uint8Array>)
  page = await attach(await diagnostic.endpoint(), fixturePid)
  const driver = page

  await step("the opening screen offers a workspace", async () => {
    await waitFor(driver, `text().includes("Open a workspace")`, "the empty state")
  })

  await step("opening a workspace asks whether it is trusted", async () => {
    await driver.click("Open a workspace")
    await waitFor(driver, `text().includes("Choose a workspace") && named("Browse this computer") !== undefined`, "the consolidated workspace chooser")
    await driver.click("Browse this computer")
    await waitFor(driver, `text().includes("Do you trust")`, "the trust decision")
  })

  await step("trusting it opens the workbench on that workspace", async () => {
    await driver.click("Trust workspace")
    await waitFor(driver, `named("Settings") !== undefined && named("Start a session") !== undefined`, "the workbench")
  })

  await step("a reload offers the recent project and can skip this screen next time", async () => {
    await driver.evaluate(`(location.reload(), true)`)
    await waitFor(driver, `text().includes("Recent project") && named("Open recent project") !== undefined`, "the recent project")
    await driver.click("Skip this screen next time")
    await waitFor(driver, `document.querySelector('input[type="checkbox"]')?.checked === true`, "the startup preference")
    await driver.click("Open recent project")
    await waitFor(driver, `named("Settings") !== undefined && named("Start a session") !== undefined`, "the reopened workbench")
  })

  if (process.platform === "win32") {
    await step("a minimized fixture returns before the next pointer action", async () => {
      await setFixtureWindowState(fixturePid, "minimized")
      await waitFor(driver, `document.visibilityState === "hidden"`, "the fixture to minimize")
      await driver.click("Settings")
      await waitFor(driver, `document.visibilityState === "visible" && document.getElementById("settings-modal") !== null`, "the foreground settings modal")
      await driver.click("Close settings")
      await waitFor(driver, `document.getElementById("settings-modal") === null`, "the settings modal to close")
    })
  }

  await step("sessions and settings are adjacent modal controls", async () => {
    await waitFor(driver, `(() => {
      const settings = document.querySelector('button[aria-label="Settings"]')
      const sessions = document.querySelector('button[aria-label="Sessions"]')
      const header = settings?.closest("header")
      return settings !== null && sessions !== null && header !== null
        && header.querySelectorAll('button[aria-label="Settings"]').length === 1
        && header.querySelectorAll('button[aria-label="Sessions"]').length === 1
        && settings.previousElementSibling === sessions
        && header.querySelector('button[aria-label="All sessions"]') === null
        && header.querySelector('button[aria-label="Providers and credentials"]') === null
        && header.querySelector('button[aria-label="Diagnostics"]') === null
    })()`, "the separate sessions and settings entry points")
    await driver.click("Settings")
    await waitFor(driver, `(() => {
      const trigger = document.querySelector('button[aria-label="Settings"]')
      const modal = document.getElementById("settings-modal")
      return trigger?.getAttribute("aria-expanded") === "true"
        && modal?.matches('[role="dialog"][aria-modal="true"]') === true
        && modal.querySelector('[role="tablist"][aria-label="Settings sections"]') !== null
        && modal.querySelectorAll('[role="tab"]').length === 6
        && document.getElementById("settings-tab-sessions") === null
    })()`, "the settings modal")
  })

  await step("settings sections switch in place", async () => {
    await waitFor(driver, `document.querySelector('#settings-panel-providers:not([hidden])') !== null && text().includes("Model access") && text().includes("Use an API key")`, "provider settings")
    await driver.click("Agent")
    await waitFor(driver, `document.querySelector('#settings-panel-agent:not([hidden])') !== null && text().includes("Automatic compaction") && text().includes("Terminal & CLI compatibility")`, "agent settings")
    if (process.env["BAKE_PI_JOURNEY_SCREENSHOT"] !== undefined) await driver.screenshot(process.env["BAKE_PI_JOURNEY_SCREENSHOT"])
    const compactionWasEnabled = await driver.evaluate<boolean>(`document.querySelector('button[aria-label="Automatic compaction"]')?.getAttribute("aria-checked") === "true"`)
    await driver.click("Automatic compaction")
    await waitFor(driver, `document.querySelector('button[aria-label="Automatic compaction"]')?.getAttribute("aria-checked") === ${JSON.stringify(String(!compactionWasEnabled))} && text().includes("Saved to Pi")`, "a setting saved through Pi")
    const persistedSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as { compaction?: { enabled?: boolean } }
    if (persistedSettings.compaction?.enabled !== !compactionWasEnabled) throw new Error("the settings control did not persist through Pi")
    await driver.click("Privacy")
    await waitFor(driver, `document.querySelector('#settings-panel-privacy:not([hidden])') !== null && text().includes("Installation telemetry") && text().includes("Anthropic extra-usage warning")`, "privacy settings")
    // The current workspace's trust is shown here, even before a session has
    // mounted the composer and its permission control.
    await waitFor(driver, `document.querySelector('#settings-panel-privacy')?.textContent?.includes("Trusted") === true`, "the workspace trust decision")
    await driver.click("Resources")
    await waitFor(driver, `document.querySelector('#settings-panel-resources:not([hidden])') !== null && text().includes("Package sources") && text().includes("Inventory") && text().includes("Reload")`, "resource source settings")
    await driver.click("Diagnostics")
    await waitFor(driver, `document.querySelector('#settings-panel-diagnostics:not([hidden])') !== null && text().includes("Bake Pi") && text().includes("Recent entries") && document.querySelectorAll("#settings-modal").length === 1`, "diagnostic settings")
    await driver.click("Appearance")
    await waitFor(driver, `document.querySelectorAll('#settings-panel-appearance input[type="radio"][name="theme"]').length === 4`, "appearance settings")
  })

  await step("a resource wears its vendor's mark, and an unbranded one keeps its kind", async () => {
    // The settings modal is still open on Appearance from the step above, and
    // the step below is the one that closes it.
    await driver.click("Resources")
    await waitFor(driver, `(() => {
      const rows = [...document.querySelectorAll('#settings-modal ul[aria-label="Extensions"] li')]
      const vendor = rows.find((row) => row.textContent?.includes("sentry"))
      const plain = rows.find((row) => row.textContent?.includes("provider-fixture"))
      return vendor !== undefined && vendor.querySelector('[data-lab-mark="sentry"]') !== null
        && plain !== undefined && plain.querySelector("[data-lab-mark]") === null
    })()`, "the vendor row marked and the fixture row keeping its kind glyph")
    // The mark replaces the kind glyph rather than joining it, so the second
    // half is what proves a row that names no vendor did not lose its glyph.
  })

  await step("sessions and settings open as separate modals", async () => {
    await driver.click("Close settings")
    await driver.click("Sessions")
    await waitFor(driver, `document.getElementById("sessions-modal") !== null
      && document.getElementById("settings-modal") === null
      && document.querySelector('button[aria-label="Sessions"]')?.getAttribute("aria-expanded") === "true"
      && text().includes("No saved sessions")`, "the sessions modal")
    await driver.click("Close sessions")
    await driver.click("Settings")
    await waitFor(driver, `document.getElementById("settings-modal") !== null
      && document.getElementById("sessions-modal") === null
      && document.querySelector('button[aria-label="Settings"]')?.getAttribute("aria-expanded") === "true"
      && document.querySelector('button[aria-label="Sessions"]')?.getAttribute("aria-expanded") === "false"`, "the settings modal reopening")
  })

  await step("Escape closes the settings modal and restores its trigger", async () => {
    await driver.evaluate(`(() => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
      return true
    })()`)
    await waitFor(driver, `document.getElementById("settings-modal") === null && document.querySelector('button[aria-label="Settings"]')?.getAttribute("aria-expanded") === "false" && document.activeElement?.getAttribute("aria-label") === "Settings"`, "settings modal dismissal")
  })

  await step("a session starts and the composer appears", async () => {
    await driver.click("Start a session")
    await waitFor(driver, `(() => {
      const prompt = document.getElementById("prompt")
      const shell = prompt?.parentElement?.parentElement
      const area = shell?.closest("section")
      const model = document.querySelector('button[aria-label="Model"]')
      return prompt !== null && shell !== null && area !== null && model !== null
        && getComputedStyle(shell).backgroundColor !== getComputedStyle(area).backgroundColor
    })()`, "the coloured composer surface and controls")
    /*
     * A session with nothing said in it does not pin the field to the floor
     * under a blank page: the greeting and the composer are one group in the
     * middle of the pane. Measured as the room left under the composer, which
     * is the part that is zero when it is docked and is most of a screen when
     * the layout is wrong in the other direction.
     */
    await waitFor(driver, `(() => {
      const pane = document.getElementById("main-content")?.getBoundingClientRect()
      const area = document.getElementById("prompt")?.closest("section")?.getBoundingClientRect()
      if (pane === undefined || area === undefined) return false
      const below = pane.bottom - area.bottom
      return below > pane.height * 0.15 && area.top > pane.top
    })()`, "the composer resting mid-pane before the first prompt")
    /*
     * And narrower there, at `columnResting`, with the greeting starting on
     * the field's own edge rather than on the wider column the transcript will
     * take. One line of greeting: the glyph and the paragraph that used to sit
     * above the field are gone, so `h2` is the only thing between the pane's
     * top and the composer.
     */
    await waitFor(driver, `(() => {
      const card = document.getElementById("prompt")?.parentElement?.parentElement?.getBoundingClientRect()
      const title = [...document.querySelectorAll("h2")].find((h) => h.textContent === "Ready at the workbench")
      const empty = title?.parentElement
      if (card === undefined || empty == null) return false
      const greeting = empty.getBoundingClientRect()
      return card.width <= 641
        && empty.children.length === 1
        && Math.abs(greeting.left - card.left) < 1
        && greeting.bottom <= card.top
    })()`, "the resting composer at its narrower width, under a one-line greeting")
  })
  await reportSessionCommand(driver, "create_session")

  await step("an extension question stays in the chat and returns its answer to Pi", async () => {
    await driver.evaluate(`type("#prompt", "ask me")`)
    await driver.click("Send message")
    await waitFor(driver, `document.querySelector('[aria-label="Agent question"]') !== null
      && named("Five (full case)") !== undefined`, "the inline question card")
    /*
     * Answered by keyboard, because that is the half of this control a click
     * cannot prove. The options are buttons wearing `role="radio"`, and a
     * group of those gets none of the arrow keys, wrapping, roving tab stop or
     * Enter that the browser gives real radios — every one of them is ours,
     * and a click would pass with all of them broken. The first option holds
     * focus on arrival, so one press down is the second.
     */
    await waitFor(driver, `(() => {
      const hints = [...document.querySelectorAll('[aria-label="Agent question"] kbd')]
      return hints.map((hint) => hint.textContent).join(",") === "1,2,3,esc"
    })()`, "a shortcut drawn on every option and on Skip")
    await driver.evaluate(`(() => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }))
      return true
    })()`)
    await waitFor(driver, `(() => {
      const checked = document.querySelector('[role="radio"][aria-checked="true"]')
      return checked?.textContent?.includes("Five (full case)") === true
        && document.activeElement === checked
        && document.querySelectorAll('[role="radio"][tabindex="0"]').length === 1
        && checked.tabIndex === 0
    })()`, "the arrow moving the selection, and the tab stop with it")
    await driver.evaluate(`(() => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
      return true
    })()`)
    await waitFor(driver, `timeline().includes("Five flavors selected")
      && document.querySelector('[aria-label="Agent question"]') === null`, "the answered question to continue the turn")
    // And with a transcript to read, the timeline takes the column back and
    // the composer returns to the floor it will keep for the rest of the session.
    await waitFor(driver, `(() => {
      const pane = document.getElementById("main-content")?.getBoundingClientRect()
      const area = document.getElementById("prompt")?.closest("section")?.getBoundingClientRect()
      const card = document.getElementById("prompt")?.parentElement?.parentElement?.getBoundingClientRect()
      if (pane === undefined || area === undefined || card === undefined) return false
      // Wider again, unless the window itself is narrower than the two widths
      // differ over — in which case both states clamp to the same pane.
      return pane.bottom - area.bottom < 2 && (card.width > 641 || pane.width < 720)
    })()`, "the composer docked once the conversation exists")
  })

  await step("the file rail exposes search and view state while protecting Git metadata", async () => {
    await waitFor(driver, `(() => {
      const tree = document.querySelector('[aria-label="Workspace files"]')
      const ignored = document.querySelector('button[aria-label="Git-ignored files"]')
      return document.querySelector('input[aria-label="Search open files"]') !== null
        && ignored?.getAttribute("aria-pressed") === "true"
        && tree?.textContent?.includes(".githidden") === true
        && tree.querySelector('button[aria-label=".git"]') === null
        && document.querySelector('[aria-label="ignored.log, drag to prompt, ignored by Git"]') !== null
    })()`, "the default file view")

    await driver.evaluate(`type('input[aria-label="Search open files"]', "ignored")`)
    await waitFor(driver, `document.querySelector('input[aria-label="Search open files"]')?.value === "ignored" && document.querySelector('button[aria-label="Clear filter"]') !== null`, "the file search")
    await driver.click("Clear filter")
    await driver.click("Git-ignored files")
    await waitFor(driver, `document.querySelector('button[aria-label="Git-ignored files"]')?.getAttribute("aria-pressed") === "false" && document.querySelector('[aria-label="ignored.log, drag to prompt, ignored by Git"]') === null`, "ignored files hidden on request")
    await driver.click("Git-ignored files")
  })

  await step("a file tree row only mentions a file when dragged to the composer", async () => {
    await driver.click("src")
    await waitFor(driver, `(() => {
      const file = document.querySelector('[aria-label="value.ts, drag to prompt"]')
      return file?.tagName === "SPAN" && file.getAttribute("draggable") === "true" && file.querySelector("svg") !== null
    })()`, "the draggable, non-button file tree row")
    const clickDidNothing = await driver.evaluate<boolean>(`(async () => {
      document.querySelector('[aria-label="value.ts, drag to prompt"]')?.click()
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      return document.getElementById("prompt")?.value === ""
    })()`)
    if (!clickDidNothing) throw new Error("clicking a file row still inserted a mention")
    await driver.drag("value.ts, drag to prompt", "#prompt")
    await waitFor(driver, `document.getElementById("prompt")?.value === "@src/value.ts " && document.activeElement?.id === "prompt"`, "the dropped file mention")

    await driver.evaluate(`type("#prompt", "@src/")`)
    await waitFor(driver, `(() => {
      const option = [...document.querySelectorAll('#prompt-menu [role="option"]')]
        .find((row) => row.textContent?.includes("value.ts"))
      return option?.querySelector("svg") !== null
    })()`, "the file icon in the mention menu")
  })

  await step("the model chooser offers the catalog and switching is accepted", async () => {
    await driver.click("Model")
    await waitFor(driver, `(() => {
      const options = [...document.querySelectorAll('[role="listbox"][aria-label="Model"] [role="option"]')]
      return options.length === 4
        && options.some((option) => option.textContent?.includes("Extension model"))
        && options.every((option) => !option.textContent?.includes("Unauthed 1"))
    })()`, "the connected-provider model catalog")
    await driver.click("Fixture Reasoning")
    // A reasoning model has thinking levels and a non-reasoning one does not, so
    // the second chooser appearing is the evidence the selection reached Pi
    // rather than only the control that was pressed.
    await waitFor(driver, `document.querySelector('button[aria-label="Model"]')?.textContent?.includes("Fixture Reasoning") === true`, "the selected model")
    await waitFor(driver, `document.querySelector('[aria-label="Thinking"]') !== null`, "the thinking chooser")
  })

  await step("a model row wears the mark of the lab that made it", async () => {
    await driver.click("Model")
    await waitFor(driver, `(() => {
      const rows = [...document.querySelectorAll('[role="listbox"][aria-label="Model"] [role="option"]')]
      const qwen = rows.find((row) => row.textContent?.includes("Qwen journey"))
      const fixture = rows.find((row) => row.textContent?.includes("Fixture Reasoning"))
      return qwen !== undefined && qwen.querySelector('[data-lab-mark="qwen"]') !== null
        && fixture !== undefined && fixture.querySelector("[data-lab-mark]") === null
    })()`, "the Qwen row marked and the fixture row not")
    // Both halves matter. The mark has to appear where a lab is named and stay
    // away where none is, or the glyph is decoration: a table that answered
    // every id would put the same mark on every row and say nothing.
    await driver.click("Qwen journey")
    await waitFor(driver, `document.querySelector('button[aria-label="Model"] [data-lab-mark="qwen"]') !== null`, "the chip wearing the selected model's mark")
    // The rail says the same thing in a third of the width: it drops the
    // provider name first, so the mark is what is left to identify a session by.
    await driver.click("Sessions")
    await waitFor(driver, `document.querySelector('#sessions-modal button[aria-current="page"] [data-lab-mark="qwen"]') !== null`, "the open session's row wearing the mark")
    await driver.click("Close sessions")
    await waitFor(driver, `document.getElementById("sessions-modal") === null`, "the sessions modal closing")
    await driver.click("Model")
    await driver.click("Fixture Reasoning")
    await waitFor(driver, `(() => {
      const chip = document.querySelector('button[aria-label="Model"]')
      return chip?.textContent?.includes("Fixture Reasoning") === true && chip.querySelector("[data-lab-mark]") === null
    })()`, "the chip falling back to the generic glyph for a model no lab claims")
  })

  await step("the sessions modal makes an open session's state and runtime scannable", async () => {
    await driver.click("Sessions")
    await waitFor(driver, `(() => {
      const modal = document.getElementById("sessions-modal")
      const current = modal?.querySelector('button[aria-current="page"]')
      return modal !== null
        && modal.querySelector('#open-sessions')?.textContent === "Open"
        && modal.querySelector('#saved-sessions') === null
        && current?.textContent?.includes("Untitled session") === true
        && current.textContent.includes("Current")
        && current.textContent.includes("0 messages")
        && current.textContent.includes("Fixture Reasoning")
        && current.querySelector("time") !== null
    })()`, "the structured open-session row")
    await driver.click("Close sessions")
    await waitFor(driver, `document.getElementById("sessions-modal") === null`, "the sessions modal closing")
  })

  await step("a prompt streams the model's answer into the timeline", async () => {
    await driver.evaluate(`type("#prompt", "hello")`)
    await driver.click("Send message")
    await waitFor(driver, `(() => {
      const log = document.querySelector('[aria-label="Conversation timeline"]')
      return timeline().includes("Hello there")
        && named("Stop") === undefined
        && log !== null
        && log.scrollHeight > log.clientHeight
        && log.scrollHeight - log.clientHeight - log.scrollTop <= 2
    })()`, "the streamed answer at the end of the timeline")
    /*
     * A turn is also the first moment the model reports a context window, so
     * this is where the gauge can be read. Two claims, both about colour a
     * unit test cannot see: the unfilled ring is distinguishable from the
     * canvas it is drawn on — it used to be a surface a step *below* the
     * canvas, which is to say invisible — and the arc is a different colour
     * from the track, which is what proves the `color-mix` ramp resolved
     * rather than falling back to nothing.
     */
    await waitFor(driver, `(() => {
      const meter = document.querySelector('[aria-label="Context window used"]')
      const circles = meter?.querySelectorAll("circle")
      if (circles?.length !== 2) return false
      const track = getComputedStyle(circles[0]).stroke
      const arc = getComputedStyle(circles[1]).stroke
      const canvas = getComputedStyle(document.getElementById("main-content")).backgroundColor
      const opaque = (colour) => colour.startsWith("rgb") && !colour.includes("rgba(0, 0, 0, 0)")
      return opaque(track) && opaque(arc) && track !== arc && track !== canvas
    })()`, "a context ring whose track reads against the canvas and whose arc does not read as the track")
  })

  await step("composer resizing follows only while the reader stays at the end", async () => {
    const longDraft = JSON.stringify(Array.from({ length: 16 }, (_unused, index) => `Draft line ${String(index + 1)}`).join("\n"))
    await driver.evaluate(`type("#prompt", ${longDraft})`)
    await waitFor(driver, `(() => {
      const log = document.querySelector('[aria-label="Conversation timeline"]')
      const prompt = document.getElementById("prompt")
      return log !== null && prompt !== null && prompt.clientHeight > 160
        && log.scrollHeight - log.clientHeight - log.scrollTop <= 2
    })()`, "the expanded composer to preserve the latest content")

    await driver.evaluate(`type("#prompt", "")`)
    await waitFor(driver, `(() => {
      const log = document.querySelector('[aria-label="Conversation timeline"]')
      const prompt = document.getElementById("prompt")
      return log !== null && prompt !== null && prompt.clientHeight <= 80
        && log.scrollHeight - log.clientHeight - log.scrollTop <= 2
    })()`, "the collapsed composer to preserve the latest content")

    await driver.wheel("Conversation timeline", -240)
    await waitFor(driver, `named("Jump to latest") !== undefined`, "the detached timeline")
    const detachedTop = await driver.evaluate<number>(`document.querySelector('[aria-label="Conversation timeline"]')?.scrollTop ?? -1`)

    await driver.evaluate(`type("#prompt", ${longDraft})`)
    await waitFor(driver, `document.getElementById("prompt")?.clientHeight > 160`, "the composer to expand while detached")
    const afterResize = await driver.evaluate<number>(`document.querySelector('[aria-label="Conversation timeline"]')?.scrollTop ?? -1`)
    if (Math.abs(afterResize - detachedTop) > 2) {
      throw new Error(`the detached timeline moved from ${String(detachedTop)} to ${String(afterResize)} when the composer resized`)
    }

    await driver.click("Jump to latest")
    await waitFor(driver, `(() => {
      const log = document.querySelector('[aria-label="Conversation timeline"]')
      return named("Jump to latest") === undefined && log !== null
        && log.scrollHeight - log.clientHeight - log.scrollTop <= 2
    })()`, "the explicit jump to resume following")
    await driver.evaluate(`type("#prompt", "")`)
  })

  await step("a tool that would write outside the workspace raises an approval", async () => {
    await driver.evaluate(`type("#prompt", "write the file")`)
    await driver.click("Send message")
    await waitFor(driver, `text().includes("Allow") && text().includes("write")
      && document.querySelector('[aria-label="Conversation timeline"] [aria-label="awaiting approval"]') !== null`, "the approval card and pending tool state")
  })

  await step("approving it runs the tool and the result reaches the timeline", async () => {
    await driver.click("Allow once")
    await waitFor(driver, `timeline().includes("the file is written")
      && document.querySelector('[aria-label="Conversation timeline"] [aria-label="succeeded"]') !== null`, "the turn and succeeded tool state")

    /*
     * The step row, asserted as a structure rather than as a substring.
     *
     * `timeline()` reads `textContent`, which cannot tell "Wrote" beside a
     * chip from a single run of prose that happens to contain both words, and
     * it cannot see the tooltip at all. The regression this guards against is
     * the one the row already had once: the whole path in the visible text,
     * competing with the file name and truncating it. So the visible chip must
     * be exactly the base name, the verb must be its own element beside it,
     * and the path must be where a person can still get at it.
     */
    await waitFor(driver, `(() => {
      const chip = document.querySelector('[aria-label="Conversation timeline"] [data-step-target]')
      return chip !== null
        && chip.textContent === ${JSON.stringify(basename(outside))}
        && chip.getAttribute("title") === ${JSON.stringify(outside)}
        && chip.previousElementSibling?.textContent === "Wrote"
    })()`, "the write step naming its file as a chip beside the verb")
  })

  await step("Escape denies the approval, which is the key the card has been promising", async () => {
    await driver.evaluate(`type("#prompt", "write it again")`)
    await driver.click("Send message")
    await waitFor(driver, `document.querySelector('[aria-label="Tool approvals"]') !== null
      && named("Allow once") !== undefined`, "the second approval card")
    /*
     * Dispatched at whatever holds focus, which is the assertion: the card
     * puts focus on Deny when it arrives, and Escape is scoped to the card. A
     * dispatch aimed at the card's own element would prove the handler exists
     * and not that a person's Escape can ever reach it.
     */
    await driver.evaluate(`(() => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
      return true
    })()`)
    await waitFor(driver, `document.querySelector('[aria-label="Tool approvals"]') === null
      && timeline().includes("the write was refused")`, "the denied tool call and the turn continuing")
    // The decision, on disk. A denial that let the write through would leave
    // the card gone, the timeline right, and the file there anyway.
    if (existsSync(refused)) throw new Error("Escape dismissed the card but the write happened anyway")
  })

  await step("an attached image renders as an image, served from the app's own origin", async () => {
    await driver.click("Add files")
    await waitFor(driver, `named("Attach files") !== undefined`, "the attach row of the add-files menu")
    await driver.click("Attach files")
    await waitFor(driver, `document.querySelector('[aria-label="Attachments"]')?.textContent?.includes("pixel.png") === true`, "the chosen attachment on the composer")

    await driver.evaluate(`type("#prompt", "what is in this image")`)
    await driver.click("Send message")
    /*
     * `naturalWidth` is the assertion, not the `src`.
     *
     * An `<img>` whose fetch the CSP blocked, whose protocol handler 404ed, or
     * whose bytes the host no longer had still has the right `src` attribute
     * and still occupies the row — it is simply blank. Only a decoded image
     * has intrinsic dimensions, and this one is 1×1, so a width above zero is
     * proof the whole chain answered: img-src, the privileged scheme, main's
     * route, and `read_image`.
     */
    await waitFor(driver, `(() => {
      const image = document.querySelector('[aria-label="Conversation timeline"] img')
      return image !== null
        && image.src.startsWith("bakepi://image/")
        && image.complete
        && image.naturalWidth > 0
    })()`, "the attached image decoded from the app's own image origin")
    await waitFor(driver, `timeline().includes("one pixel, received") && named("Stop") === undefined`, "the turn that carried the image to finish")
  })

  await step("a plan Pi records reaches the rail, and nothing above the composer", async () => {
    await driver.evaluate(`type("#prompt", "plan it")`)
    await driver.click("Send message")
    // An extension's tool exposes no targets the policy can verify, so even a
    // trusted workspace asks about this one.
    await waitFor(driver, `named("Allow once") !== undefined`, "the approval for the extension's todo tool")
    await driver.click("Allow once")
    await waitFor(driver, `timeline().includes("the plan is in the rail")`, "the turn that recorded the plan")

    await driver.click("Plan")
    await waitFor(driver, `(() => {
      const rail = document.querySelector('[aria-label="Activity"]')
      if (rail === null) return false
      const progress = rail.querySelector('[aria-label="Plan progress"]')
      return progress?.textContent?.includes("2 of 4 complete") === true
        && rail.querySelectorAll("li").length === 4
        && rail.querySelector('[aria-label="in progress"]') !== null
        && rail.querySelectorAll('[aria-label="completed"]').length === 2
        && rail.textContent?.includes("Move the plan into it") === true
        // The card this replaced sat in the conversation column above the
        // composer, where a revised plan pushed the transcript up. Nothing
        // there may hold the plan any more.
        && document.querySelector('main [aria-label="Current plan"]') === null
    })()`, "the plan in the rail, with its progress and its active row")
  })

  await step("stopping an in-flight turn returns the session to idle", async () => {
    await driver.evaluate(`type("#prompt", "stall please")`)
    await driver.click("Send message")
    await waitFor(driver, `named("Stop") !== undefined`, "the stop control")
    await driver.click("Stop")
    await waitFor(driver, `named("Stop") === undefined`, "the return to idle")
  })

  await step("an explicit restart replaces a live host and restores its open session", async () => {
    const result = await driver.evaluate<{ started: boolean }>(`window.bakePi.commands.restart_host({})`)
    if (!result.started) throw new Error("restart_host treated a live host as already recovered")
    await waitFor(driver, `timeline().includes("Hello there") && text().includes("connected")`, "the session after a live-host restart")
  })

  await step("closing the session releases Pi's in-memory copy", async () => {
    // Pi may have named the session by now, so the suffix is intentionally not
    // fixed. With no overlay open, the tab's close button is the only control
    // whose accessible name begins with "Close".
    await driver.click("Close")
    await waitFor(driver, `document.getElementById("prompt") === null && text().includes("Start a session")`, "the closed session")
  })

  tearOnlySession(agentDir)

  await step("reopening a crash-torn session restores its history and reports the loss", async () => {
    // The resume a person actually performs: the application comes up knowing
    // nothing, and the session is read back from the JSONL Pi owns. Asserting
    // the first turn's text is what distinguishes a restored conversation from
    // an empty session with the right title.
    const previousDocument = await driver.evaluate<number>("performance.timeOrigin")
    await driver.evaluate(`(location.reload(), true)`)
    await waitFor(driver, `performance.timeOrigin !== ${String(previousDocument)}
      && text().includes("Start a session")
      && !text().includes("Open a workspace")`, "the automatically reopened workbench")
    // Sessions that nothing is holding open have no tab, so getting back to one
    // goes through the dedicated Sessions modal.
    await driver.click("Sessions")
    await waitFor(driver, `text().includes("Untitled session") || text().includes("messages")`, "the session list")
    await driver.click("messages")
    await waitFor(driver, `document.getElementById("sessions-modal") === null && document.querySelector('[role="tab"][aria-selected="true"]') !== null`, "the restored session selection")
    await waitFor(driver, `timeline().includes("Hello there")
      && document.querySelector('[role="alert"]')?.textContent?.includes("Session recovered") === true
      && document.querySelector('[role="alert"]')?.textContent?.includes("incomplete final JSONL entry") === true
      && document.querySelector('[role="alert"]')?.textContent?.includes("kept the earlier history") === true`, "the restored conversation and its recovery notice")
  })
  await reportSessionCommand(driver, "open_session")

  await step("a reasoning-led group is one straight rail, and a command keeps its output", async () => {
    await driver.click("Close")
    await waitFor(driver, `document.getElementById("prompt") === null && text().includes("Start a session")`, "the session to close before its turn is rewritten")
    replaceLastAssistantTurn(agentDir, REASONING_LED_TURN, REASONING_LED_RESULTS)

    await driver.click("Sessions")
    await waitFor(driver, `document.getElementById("sessions-modal") !== null && text().includes("messages")`, "the rewritten session in the session list")
    await driver.click("messages")
    await waitFor(driver, `timeline().includes("I need two more facts") && timeline().includes("Ran echo grouped")`, "the reasoning-led group")

    /*
     * The tree, as the numbers that decide whether it looks like one.
     *
     * Each rail holds absolutely-positioned fills: a 1px-wide one is a run of
     * the line, a 1px-tall one is the branch into a row, and the box with two
     * real dimensions is the glyph. Reading their rects is the only way to see
     * a half-pixel step between the run under a heading and the run its
     * children hang from — which is exactly the defect that made the tree look
     * bent, and which no assertion about text or class names can reach.
     */
    const rails = await driver.evaluate<{ left: number; verticals: number[]; branches: { left: number; middle: number }[]; glyphMiddle: number | null; text: string }[]>(`(async () => {
      // Text appears before the conversation's entrance finishes. Measuring
      // during its fractional translation rounded a valid 0.5px offset to
      // 0.5000152587890625px. As with clicks, read the settled geometry; keep
      // the half-pixel limit and exclude animations that never finish.
      const settling = document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
      await Promise.all(settling.map((animation) => animation.finished.catch(() => undefined)))
      const log = document.querySelector('[aria-label="Conversation timeline"]')
      if (log === null) throw new Error("the timeline is not drawn")
      return [...log.querySelectorAll("[data-step-rail]")].map((rail) => {
        const parts = [...rail.children].map((child) => child.getBoundingClientRect())
        const glyph = parts.find((rect) => rect.width > 2 && rect.height > 2)
        return {
          left: rail.getBoundingClientRect().left,
          verticals: parts.filter((rect) => rect.width <= 1.5 && rect.height >= 2).map((rect) => rect.left),
          branches: parts.filter((rect) => rect.height <= 1.5 && rect.width >= 2).map((rect) => ({ left: rect.left, middle: rect.top + rect.height / 2 })),
          glyphMiddle: glyph === undefined ? null : glyph.top + glyph.height / 2,
          text: rail.parentElement?.textContent ?? "",
        }
      })
    })()`)

    const heading = rails.find((rail) => rail.text.includes("I need two more facts"))
    const children = rails.filter((rail) => rail.branches.length > 0)
    if (heading === undefined) throw new Error("the phase heading has no rail")
    if (children.length !== 2) throw new Error(`expected two branched tool rows, found ${String(children.length)}`)
    if (heading.verticals.length !== 1) {
      throw new Error(`the heading should run one line down to its tools, it drew ${String(heading.verticals.length)}`)
    }

    for (const child of children) {
      // One x for the whole tree. A branch that starts anywhere but on the
      // line it comes off leaves a notch at the corner; a run half a pixel
      // from the one above it renders as two grey columns beside one solid.
      for (const x of [...child.verticals, child.branches[0]!.left]) {
        if (Math.abs(x - heading.verticals[0]!) > 0.05) {
          throw new Error(`the rail steps sideways: the heading runs at ${heading.verticals[0]!.toFixed(2)}, this row's line is at ${x.toFixed(2)}`)
        }
      }
      // The branch meets the glyph it points at. A 1px fill cannot be centred
      // on an integer, so it sits on the pixel below the centre.
      if (child.glyphMiddle === null) throw new Error("a branched row has no glyph")
      if (Math.abs(child.branches[0]!.middle - child.glyphMiddle) > 0.5) {
        throw new Error(`the branch misses its glyph by ${Math.abs(child.branches[0]!.middle - child.glyphMiddle).toFixed(6)}px`)
      }
      if (Math.abs(child.left - heading.left - 24) > 0.05) {
        throw new Error(`a tool under a heading should move in by 24px, this one moved ${(child.left - heading.left).toFixed(2)}`)
      }
    }

    /*
     * And the command, grouped with what it printed.
     *
     * A shell step used to disclose two listings: one headed `bash` holding
     * the command, another headed `bash` holding the output, each with its own
     * Copy. One header and one Copy is the assertion that they became one
     * transcript, and the `$` is what says which half is which.
     */
    // Completed turns now start collapsed under the default disclosure
    // preference. Open the step through its named control before inspecting
    // its transcript; a missing Copy while collapsed is not lost tool output.
    await waitFor(driver, `named("Ran echo grouped")?.getAttribute("aria-expanded") === "false"`, "the completed shell step to start collapsed")
    await driver.click("Ran echo grouped")
    await waitFor(driver, `named("Ran echo grouped")?.getAttribute("aria-expanded") === "true" && timeline().includes("$ echo grouped")`, "the shell transcript to expand")
    const grouped = await driver.evaluate<{ copies: number; prompted: boolean; printed: boolean }>(`(() => {
      const log = document.querySelector('[aria-label="Conversation timeline"]')
      const rail = [...log.querySelectorAll("[data-step-rail]")].find((candidate) => candidate.parentElement?.textContent?.includes("Ran echo grouped"))
      const step = rail?.parentElement
      if (step === undefined || step === null) throw new Error("the shell step is not drawn")
      const shown = step.textContent ?? ""
      return {
        copies: step.querySelectorAll('button[aria-label="Copy code"]').length,
        prompted: shown.includes("$ echo grouped"),
        printed: shown.includes("one transcript"),
      }
    })()`)
    if (grouped.copies !== 1) throw new Error(`a command and its output is one block with one Copy, this step offered ${String(grouped.copies)}`)
    if (!grouped.prompted) throw new Error("the grouped block did not show the command behind a prompt")
    if (!grouped.printed) throw new Error("the grouped block did not show what the command printed")
  })

  const rendererBudgetOutput = process.env.BAKE_PI_RENDERER_BUDGET_OUT
  if (rendererBudgetOutput !== undefined) {
    await step("a 10,000-block session stays virtualized inside the frame budget probe", async () => {
      await driver.click("Close")
      await waitFor(driver, `document.getElementById("prompt") === null && text().includes("Start a session")`, "the session to close before expanding its file")
      const largeSessionId = replaceLastAssistantWithBlocks(agentDir, LARGE_SESSION_BLOCKS)

      await driver.click("Sessions")
      await waitFor(driver, `document.getElementById("sessions-modal") !== null && text().includes("messages")`, "the expanded session in the session list")
      const loadProfile = process.env.BAKE_PI_RENDERER_LOAD_PROFILE_OUT
      const loadTrace = process.env.BAKE_PI_RENDERER_LOAD_TRACE_OUT
      if (loadTrace !== undefined) {
        console.log("  load timeline tracing enabled; use an untraced run for baseline timings")
        await driver.startTrace()
      }
      if (loadProfile !== undefined) {
        console.log("  load CPU profiling enabled; use an unprofiled run for baseline timings")
        await driver.startProfile()
      }
      await driver.evaluate(`(() => {
        ${loadTrace === undefined ? "" : `
          performance.mark("bakepi:load:start")
          const observer = new MutationObserver(() => {
            const indexes = [...document.querySelectorAll("[data-index]")].map((row) => Number(row.getAttribute("data-index")))
            performance.mark("bakepi:load:rows", { detail: indexes })
          })
          observer.observe(document.getElementById("root"), { childList: true, subtree: true })
          globalThis.__bakePiLoadObserver = observer
        `}
        // Capture the first mounted range, not only the final tail. Rendering
        // the head first and throwing it away passes a final-position check
        // while paying for two sets of Markdown and synchronous measurements.
        globalThis.__bakePiFirstRows = []
        const firstRows = new MutationObserver(() => {
          const indexes = [...document.querySelectorAll("[data-index]")].map((row) => Number(row.getAttribute("data-index")))
          if (indexes.length === 0) return
          globalThis.__bakePiFirstRows = indexes
          firstRows.disconnect()
        })
        firstRows.observe(document.getElementById("root"), { childList: true, subtree: true })
        globalThis.__bakePiFrameProbe = (${startFrameProbe.toString()})(
          requestAnimationFrame,
          ${loadTrace === undefined ? "undefined" : '(now) => performance.mark("bakepi:load:frame", { detail: now })'},
        )
        return true
      })()`)

      await driver.click("messages")
      await waitFor(driver, `(() => {
        const indexes = [...document.querySelectorAll("[data-index]")].map((row) => Number(row.getAttribute("data-index")))
        return indexes.length > 0 && Math.max(...indexes) >= ${String(LARGE_SESSION_BLOCKS - 1)} && indexes.length < 200
      })()`, "the virtualized tail of the 10,000-block session")

      const loadFrameIntervalsMs = await driver.evaluate<number[]>(`(async () => {
        const intervals = await globalThis.__bakePiFrameProbe.stop()
        ${loadTrace === undefined ? "" : 'globalThis.__bakePiLoadObserver.disconnect(); performance.mark("bakepi:load:end")'}
        const first = globalThis.__bakePiFirstRows
        if (first.length === 0 || Math.min(...first) < ${String(LARGE_SESSION_BLOCKS - 200)}) {
          throw new Error("the large timeline initially rendered its head: " + JSON.stringify(first))
        }
        return intervals
      })()`)

      if (loadProfile !== undefined) await driver.stopProfile(loadProfile)
      if (loadTrace !== undefined) await driver.stopTrace(loadTrace)

      const largeTabLabel = await driver.evaluate<string>(`document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? ""`)
      if (largeTabLabel.length === 0) throw new Error("the large session has no named tab")
      const selection = await driver.evaluate<{ text: string; scrollTop: number }>(`(() => {
        const timeline = document.querySelector('[aria-label="Conversation timeline"]')
        const paragraph = [...document.querySelectorAll('[data-index] p')].at(-1)
        if (timeline === null || paragraph === undefined) throw new Error("the large timeline has no selectable paragraph")
        const range = document.createRange()
        range.selectNodeContents(paragraph)
        const selection = window.getSelection()
        if (selection === null) throw new Error("the renderer has no document selection")
        selection.removeAllRanges()
        selection.addRange(range)
        globalThis.__bakePiSelectionProbe = { node: paragraph, scrollTop: timeline.scrollTop }
        return { text: selection.toString(), scrollTop: timeline.scrollTop }
      })()`)
      if (selection.text.length === 0) throw new Error("the large timeline selection was empty")

      const accepted = await driver.evaluate<{ accepted: boolean }>(`window.bakePi.commands.prompt({
        sessionId: ${JSON.stringify(largeSessionId)},
        text: "selection check",
        attachments: [],
      })`)
      if (!accepted.accepted) throw new Error("the large-session selection prompt was not accepted")
      await waitFor(driver, `timeline().includes("selection-safe") && named("Stop") !== undefined`, "the selected large timeline to stream")
      const preserved = await driver.evaluate<{ connected: boolean; text: string; scrollDelta: number }>(`(() => {
        const probe = globalThis.__bakePiSelectionProbe
        const timeline = document.querySelector('[aria-label="Conversation timeline"]')
        return {
          connected: probe.node.isConnected,
          text: window.getSelection()?.toString() ?? "",
          scrollDelta: timeline === null ? Number.POSITIVE_INFINITY : timeline.scrollTop - probe.scrollTop,
        }
      })()`)
      if (!preserved.connected || preserved.text !== selection.text || Math.abs(preserved.scrollDelta) > 2) {
        throw new Error(`the large timeline disturbed its selection: ${JSON.stringify(preserved)}`)
      }
      await driver.evaluate(`window.bakePi.commands.abort({ sessionId: ${JSON.stringify(largeSessionId)} })`)
      await waitFor(driver, `named("Stop") === undefined`, "the large-session selection probe to stop")
      await driver.evaluate(`(window.getSelection()?.removeAllRanges(), true)`)

      await driver.wheel("Conversation timeline", -120)
      await waitFor(driver, `named("Jump to latest") !== undefined`, "the large timeline to detach before the measured scroll")
      await driver.evaluate(`(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        globalThis.__bakePiFrameProbe = (${startFrameProbe.toString()})(requestAnimationFrame)
        return true
      })()`)

      await driver.evaluate(`new Promise((resolve, reject) => {
        const timeline = document.querySelector('[aria-label="Conversation timeline"]')
        if (timeline === null) throw new Error("the conversation timeline is not drawn")
        let remaining = 600
        const scroll = () => {
          // Once the viewport is wholly inside completed history, its mounted
          // range must cover it on each frame. Batching virtualizer renders is
          // only an improvement if it does not trade work for blank content.
          const fromEnd = timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop
          if (timeline.scrollTop > timeline.clientHeight && fromEnd > timeline.clientHeight) {
            const viewport = timeline.getBoundingClientRect()
            const rows = [...timeline.querySelectorAll("[data-index]")].map((row) => row.getBoundingClientRect())
            if (rows.length === 0 || Math.min(...rows.map((row) => row.top)) > viewport.top + 2
              || Math.max(...rows.map((row) => row.bottom)) < viewport.bottom - 2) {
              reject(new Error("the virtualized range left a blank viewport while scrolling"))
              return
            }
          }
          timeline.scrollTop = Math.max(0, timeline.scrollTop - 30)
          remaining -= 1
          if (remaining === 0 || timeline.scrollTop === 0) resolve(true)
          else requestAnimationFrame(scroll)
        }
        requestAnimationFrame(scroll)
      })`)
      await driver.click("Jump to latest")
      await waitFor(driver, `(() => {
        const indexes = [...document.querySelectorAll("[data-index]")].map((row) => Number(row.getAttribute("data-index")))
        return named("Jump to latest") === undefined && Math.max(...indexes) >= ${String(LARGE_SESSION_BLOCKS - 1)}
      })()`, "the large timeline to return to its tail")

      const probe = await driver.evaluate<RendererFrameProbe>(`(async () => {
        const intervals = await globalThis.__bakePiFrameProbe.stop()
        const indexes = [...document.querySelectorAll("[data-index]")].map((row) => Number(row.getAttribute("data-index")))
        return {
          blockCount: ${String(LARGE_SESSION_BLOCKS)},
          loadFrameIntervalsMs: ${JSON.stringify(loadFrameIntervalsMs)},
          frameIntervalsMs: intervals,
          mountedRows: indexes.length,
          lastVirtualIndex: Math.max(...indexes),
        }
      })()`)
      // Switching away must not reuse the large virtualizer for an empty
      // session; switching back must return to the large history's own tail.
      // This is outside frame collection, so session construction is not
      // counted as scrolling work. The final idle sample is back on the large
      // session with the temporary empty session closed again.
      await driver.click("New session")
      await waitFor(driver, `document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.includes("Untitled session") === true
        && document.querySelector('[aria-label="Conversation timeline"]') !== null
        && document.querySelectorAll("[data-index]").length === 0`, "the empty session after leaving the large timeline")
      await driver.click(largeTabLabel)
      await waitFor(driver, `(() => {
        const indexes = [...document.querySelectorAll("[data-index]")].map((row) => Number(row.getAttribute("data-index")))
        return indexes.length > 0 && indexes.length < 200 && Math.max(...indexes) >= ${String(LARGE_SESSION_BLOCKS - 1)}
          && timeline().includes("Budget block 9999")
      })()`, "the large session's tail after switching back")
      await driver.click("Close Untitled session")
      await waitFor(driver, `document.querySelectorAll('[aria-label="Open sessions"] [role="tab"]').length === 1`, "the temporary empty session to close")
      // Frame collection is stopped. This wait exists only so the 250 ms main
      // probe can take several renderer-process readings against an idle large
      // session rather than against the allocation spike that opened it.
      await new Promise<void>((resolve) => setTimeout(resolve, 1000))
      writeFileSync(rendererBudgetOutput, JSON.stringify(probe), "utf8")
    })
  }

  const requested = server.requests.map((request) => request.model)
  // The catalog said the selection was accepted; this is Pi's own request
  // saying it took effect. A selector that updated only the interface would
  // pass every assertion above and fail here.
  if (!requested.includes("fixture-reasoning")) {
    throw new Error(`the model selection never reached the provider; models requested: ${requested.join(", ")}`)
  }

  console.log(`journey ok  (${String(steps.length)} steps)`)
} catch (error) {
  // `stderr` is a stream because the spawn asked for a pipe; the union that
  // includes a file descriptor is the general signature, not this call's.
  const stderr = diagnostic?.text ?? ""
  console.error(`journey${activeStep === undefined ? "" : ` during ${activeStep}`}: ${error instanceof Error ? error.message : String(error)}`)
  if (page !== undefined) {
    try {
      const state = await page.evaluate(`({
        visibility: document.visibilityState,
        focused: document.hasFocus(),
        screen: text().replace(/\\s+/g, " ").slice(0, 400),
        animations: document.getAnimations().slice(0, 20).map((animation) => ({
          state: animation.playState,
          time: animation.currentTime,
          rate: animation.playbackRate,
          timing: animation.effect?.getComputedTiming(),
        })),
      })`)
      console.error(`renderer at failure: ${JSON.stringify(state)}`)
    } catch (diagnosticError) {
      console.error(`renderer diagnostics unavailable: ${String(diagnosticError)}`)
    }
  }
  if (stderr.trim().length > 0) console.error(stderr.slice(-2_000))
  process.exitCode = 1
} finally {
  page?.close()
  if (child !== undefined) {
    child.kill()
    await child.exited
  }
  // Closed on every path. A listening socket keeps Bun's event loop alive, so a
  // failed run that skipped this printed its error and then sat there for the
  // driver's whole timeout — indistinguishable from a hang.
  await model?.close()
  for (const path of temporary) rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
