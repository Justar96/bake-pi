import { app, BrowserWindow, utilityProcess, type UtilityProcess } from "electron"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Do Electron's three runtimes agree about what time it is?
 *
 * Every cross-process latency Bake Pi could ever report depends on the answer,
 * and the answer cannot be reasoned to. Main and the agent host are Node inside
 * Electron; the renderer is Chromium, which coarsens `performance.now()` and
 * anchors its time origin separately. A measurement taken between two ordinary
 * Node processes is evidence about the wrong thing.
 *
 * The parent reads its clock, asks a peer to read its own, and reads again. The
 * driver estimates the peer's offset from the midpoint of that window, like a
 * time protocol does. The estimate assumes the exchange is roughly symmetric;
 * the window width bounds how wrong asymmetry can make it.
 *
 * The window width is therefore part of the result and not an aside. The driver
 * reports both the tightest and median window alongside the offset, its spread,
 * and drift across the run.
 */

const wall = (): number => performance.timeOrigin + performance.now()

interface Sample {
  beforeWall: number
  peerWall: number
  afterWall: number
}

interface PeerReport {
  samples: Sample[]
  resolutionWall: number
  resolutionDate: number
}

interface Report {
  ok: boolean
  error?: string
  electron: string
  chrome: string
  node: string
  host?: PeerReport
  renderer?: PeerReport
}

const SAMPLES = 200

const askHost = (child: UtilityProcess, message: string): Promise<{ wall: number; date: number }> =>
  new Promise((resolve) => {
    child.once("message", (value: { wall: number; date: number }) => resolve(value))
    child.postMessage(message)
  })

const sampleHost = async (child: UtilityProcess): Promise<PeerReport> => {
  const resolution = await askHost(child, "resolution")
  const samples: Sample[] = []
  // Warm up first: the opening exchanges pay for the port's own lazy setup, and
  // a wide first window would flatter the tightest-window claim rather than
  // testing it.
  for (let i = 0; i < 10; i += 1) await askHost(child, "stamp")
  for (let i = 0; i < SAMPLES; i += 1) {
    const beforeWall = wall()
    const peer = await askHost(child, "stamp")
    samples.push({
      beforeWall,
      peerWall: peer.wall,
      afterWall: wall(),
    })
  }
  return { samples, resolutionWall: resolution.wall, resolutionDate: resolution.date }
}

/**
 * The renderer is sampled through `executeJavaScript` rather than through a
 * channel of its own. There is nothing to build and nothing to get wrong: the
 * call returns the value the page computed, and the page computes it between our
 * two readings exactly as the host does.
 */
const sampleRenderer = async (window: BrowserWindow): Promise<PeerReport> => {
  const resolutionScript = `(() => {
    const resolutionOf = (read) => {
      let smallest = Infinity
      for (let i = 0; i < 20000; i += 1) {
        const a = read()
        let b = read()
        let spins = 0
        while (b === a && spins < 10000) { b = read(); spins += 1 }
        if (b > a) smallest = Math.min(smallest, b - a)
      }
      return smallest
    }
    return {
      wall: resolutionOf(() => performance.timeOrigin + performance.now()),
      date: resolutionOf(() => Date.now()),
      isolated: globalThis.crossOriginIsolated === true,
    }
  })()`
  const resolution = (await window.webContents.executeJavaScript(resolutionScript)) as {
    wall: number
    date: number
  }

  const stamp = "({ wall: performance.timeOrigin + performance.now(), date: Date.now() })"
  const samples: Sample[] = []
  for (let i = 0; i < 10; i += 1) await window.webContents.executeJavaScript(stamp)
  for (let i = 0; i < SAMPLES; i += 1) {
    const beforeWall = wall()
    const peer = (await window.webContents.executeJavaScript(stamp)) as { wall: number; date: number }
    samples.push({
      beforeWall,
      peerWall: peer.wall,
      afterWall: wall(),
    })
  }
  return { samples, resolutionWall: resolution.wall, resolutionDate: resolution.date }
}

void app.whenReady().then(async () => {
  const report: Report = {
    ok: false,
    electron: process.versions.electron ?? "unknown",
    chrome: process.versions.chrome ?? "unknown",
    node: process.versions.node,
  }
  try {
    const child = utilityProcess.fork(join(app.getAppPath(), "host.js"), [], {
      serviceName: "clock-probe-host",
      stdio: "pipe",
    })
    await new Promise<void>((resolve) => child.once("spawn", () => resolve()))

    // The same hardening the real window uses. A renderer's clock precision is
    // affected by its isolation state, so measuring an unhardened one would
    // answer a question about a window Bake Pi does not open.
    const window = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    await window.loadFile(join(app.getAppPath(), "index.html"))

    report.host = await sampleHost(child)
    report.renderer = await sampleRenderer(window)
    report.ok = true
    child.kill()
  } catch (error) {
    report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }

  writeFileSync(process.env.PROBE_OUT!, JSON.stringify(report), "utf8")
  app.exit(0)
})
