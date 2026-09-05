import { app, utilityProcess } from "electron"
import { appendFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { terminateHostTree, terminateTree } from "../../../apps/desktop/src/main/supervisor/process-group.ts"

/**
 * The supervisor's kill path, in the real topology and nothing else.
 *
 * This is deliberately not the application: no Pi, no contract, no renderer.
 * The question is an operating-system one — what happens to a tool's own
 * descendants when the host dies — and putting the whole app around it would
 * only add ways for the answer to be wrong for an unrelated reason.
 *
 * It imports the real `process-group.ts` rather than restating the sequence, so
 * a change to the ordering is measured here rather than described here.
 */

const log = (line: string): void => {
  appendFileSync(process.env.PROBE_LOG!, `${line}\n`)
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

void app.whenReady().then(async () => {
  // `app.getAppPath()` rather than `__dirname`: the bundler inlines the latter
  // to this file's *source* directory, which loaded the host from the repository
  // — where the root `package.json` is `"type": "module"` and its `require`
  // calls are a syntax error. Silent, because a utility process that fails to
  // start says nothing at all.
  const child = utilityProcess.fork(join(app.getAppPath(), "host.js"), [], {
    serviceName: "orphan-probe-host",
    // Piped rather than ignored: a host that fails to start is otherwise
    // completely silent, and Electron writes nothing useful to stderr on
    // Windows either.
    stdio: "pipe",
    env: { ...process.env, PROBE_MAIN_PID: String(process.pid) },
  })

  child.stderr?.on("data", (chunk: Buffer) => log(`host.stderr ${chunk.toString("utf8")}`))
  child.stdout?.on("data", (chunk: Buffer) => log(`host.stdout ${chunk.toString("utf8")}`))
  child.on("exit", (code) => log(`host exited ${String(code)}`))
  child.on("spawn", () => log(`host spawned pid=${String(child.pid)}`))

  // The harness must have observed the live tool and its descendants before
  // this process may kill them. A four-second timer raced those OS queries:
  // a slow CIM lookup could report a dead tool after the kill already ran,
  // failing the pre-kill control without ever testing cleanup. The signal is
  // private to this fixture directory and written only after both controls.
  const stopSignal = `${process.env.PROBE_OUT!}.stop`
  const deadline = Date.now() + 30_000
  while (!existsSync(stopSignal)) {
    if (Date.now() >= deadline) {
      log("the harness did not authorize the kill within 30s")
      app.exit(1)
      return
    }
    await delay(25)
  }

  // Read here rather than after `fork`: `UtilityProcess.pid` is undefined until
  // the process actually spawns, and a tree walk on `undefined` fails in a way
  // that is indistinguishable from a tree that was already clean.
  const pid = child.pid
  log(`pid=${String(pid)}`)

  if (process.env.PROBE_ORDER === "wrong") {
    // The counterfactual. Without it, the correct-order assertion could be
    // passing because the OS cleans up anyway, and the test would prove nothing.
    child.kill()
    if (pid !== undefined) await terminateTree(pid)
  } else {
    await terminateHostTree(pid, () => {
      child.kill()
    })
  }

  log("killed")
  // Stay alive. Main exiting takes the whole tree with it on Windows, which
  // would mask the very thing being measured.
  await delay(45_000)
  app.exit(0)
})
