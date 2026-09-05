/**
 * Proves the WSL launcher and the host's authenticated loopback parent port can
 * complete the versioned handshake without involving Electron or the renderer.
 *
 * The fixture is intentionally self-contained. The production launcher gives
 * its staged bundle an exact Pi dependency inside the distro; this fixture
 * omits that install so the transport proof stays independent of the network.
 */
import { BakePiError, CONTRACT_VERSION } from "@bake-pi/contract"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WslLauncher } from "../apps/desktop/src/main/supervisor/wsl-launcher.ts"
import { MANAGED_NODE_LINK, NODE_PROBE, parseNodeProbe } from "../apps/desktop/src/main/supervisor/wsl-node.ts"
import { runWsl } from "../apps/desktop/src/main/supervisor/wsl-process.ts"

if (process.platform !== "win32") throw new Error("wsl smoke requires Windows")

const repoRoot = join(import.meta.dir, "..")
const workDir = await mkdtemp(join(tmpdir(), "bakepi-wsl-smoke-"))

try {
  const distro = process.env.BAKE_PI_WSL_DISTRO ?? await defaultDistro()
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "fixtures/wsl-handshake/index.ts")],
    outdir: workDir,
    target: "node",
    format: "esm",
    minify: false,
    sourcemap: "none",
  })
  if (!result.success || result.outputs[0] === undefined) {
    for (const message of result.logs) console.error(message)
    throw new Error("could not build the WSL handshake fixture")
  }

  let unexpectedExit: number | undefined
  const launcher = new WslLauncher({
    distro,
    entry: result.outputs[0].path,
    appVersion: "wsl-smoke",
    onExit: (code) => { unexpectedExit = code },
  })

  let ack
  try {
    ack = await launcher.start()
  } catch (error) {
    if (error instanceof BakePiError && error.detail === "node_missing") {
      throw new Error(`WSL distribution ${distro} has no Node 22 or newer that Bake Pi could find, in any supported version manager or in its login shell`)
    }
    throw error
  }
  if (ack.contractVersion !== CONTRACT_VERSION) throw new Error("WSL host answered with the wrong contract version")
  if (ack.piVersion !== "wsl-handshake-fixture") throw new Error("WSL handshake did not reach the staged fixture")
  if (unexpectedExit !== undefined) throw new Error(`WSL host exited unexpectedly with ${String(unexpectedExit)}`)

  let eventUrl: string | undefined
  await launcher.attachEventChannel((channel) => {
    if (channel.kind === "websocket") eventUrl = channel.url
  })
  if (eventUrl === undefined) throw new Error("WSL launcher did not provide an event socket")
  const eventSocket = new WebSocket(eventUrl)
  await new Promise<void>((resolve, reject) => {
    let received = 0
    const timer = setTimeout(() => reject(new Error("WSL event socket timed out")), 5_000)
    eventSocket.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error("WSL event socket failed"))
    }, { once: true })
    eventSocket.addEventListener("message", (event) => {
      const message = typeof event.data === "string" ? JSON.parse(event.data) as { name?: unknown } : undefined
      received += 1
      if (received === 1) {
        if (message?.name !== "host_ready") {
          clearTimeout(timer)
          reject(new Error("WSL event socket returned the wrong first event"))
          return
        }
        eventSocket.send(JSON.stringify({ kind: "event_ack", count: 1 }))
        return
      }
      if (message?.name !== "workspace_changed") {
        clearTimeout(timer)
        reject(new Error("WSL event socket did not carry its acknowledgement"))
        return
      }
      clearTimeout(timer)
      resolve()
    })
  })
  eventSocket.close()

  const shutdown = await launcher.stop()
  if (!shutdown.acknowledged) throw new Error("WSL host did not acknowledge shutdown")

  const managed = await proveManagedNodeIsFound(distro)

  console.log("wsl smoke ok")
  console.log(`  distro ${distro}  node ${ack.nodeVersion}  contract v${String(ack.contractVersion)}`)
  console.log("  authenticated control and one-time event WebSockets completed")
  console.log(`  probe reaches a managed Node at ${managed}`)
} finally {
  await rm(workDir, { recursive: true, force: true })
}

async function defaultDistro(): Promise<string> {
  const child = Bun.spawn(["wsl.exe", "--exec", "sh", "-lc", 'printf "%s" "$WSL_DISTRO_NAME"'], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  const distro = stdout.trim()
  if (code !== 0 || distro.length === 0) {
    throw new Error(`could not find a default WSL distribution: ${stderr.trim() || `exit ${String(code)}`}`)
  }
  return distro
}

/**
 * The probe's candidate list is the one part of Node discovery that can fail in
 * silence: a path typed wrong still compiles, still passes every unit test, and
 * simply never matches. So run the real script against a synthetic `HOME`
 * holding nothing but a stub where `wsl-node-install.ts` promises to put a
 * managed Node, and require the probe to find it.
 *
 * No download and no network — the stub is two lines of shell that print a
 * version — but it fails the moment the installer and the probe stop agreeing
 * on where a managed Node lives, which is the failure neither module can catch
 * on its own.
 */
async function proveManagedNodeIsFound(distro: string): Promise<string> {
  // `MANAGED_NODE_LINK` is written in the distribution's vocabulary and opens
  // with `$HOME`; the synthetic home replaces exactly that prefix, so the two
  // stay derived from one constant rather than typed twice.
  const suffix = MANAGED_NODE_LINK.replace("$HOME", "")
  const stub = "#!/bin/sh\necho v24.18.1"
  const plant = [
    "set -eu",
    "home=$(mktemp -d)",
    `trap 'rm -rf "$home"' EXIT`,
    `bin="$home${suffix}/bin"`,
    'mkdir -p "$bin"',
    `printf '%s\\n' "$3" > "$bin/node"`,
    'chmod 700 "$bin/node"',
    'HOME="$home" sh -c "$2" probe "$1"',
  ].join("\n")

  const result = await runWsl(distro, ["sh", "-c", plant, "sh", "22", NODE_PROBE, stub], undefined, 20_000)
  const found = result.code === 0 ? parseNodeProbe(result.stdout) : undefined
  if (found === undefined) {
    throw new Error(
      `the Node probe did not find a managed Node at ${MANAGED_NODE_LINK}: ${result.stderr.trim() || `exit ${String(result.code)}`}`,
    )
  }
  return found.path
}
