/**
 * Stands in for the agent host, and only in the way that matters here: it
 * spawns a tool the way Pi spawns one, and that tool starts a process of its
 * own.
 *
 * The second layer is the point. Pi's own tool child dies with the host on
 * Windows without anyone's help — it is spawned `detached: false` there, so the
 * measurement that only went one level deep found a clean tree in every
 * scenario and concluded, wrongly, that there was nothing to fix. What escapes
 * is what a tool itself starts: a background server, a watcher, a detached
 * build.
 */
const { spawn } = require("node:child_process")
const { writeFileSync } = require("node:fs")

const windows = process.platform === "win32"

// `detached: false` on Windows is what Pi's bash tool does
// (`detached: process.platform !== "win32"`), so the tool layer here is spawned
// the way the real one is.
const tool = windows
  ? spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Start-Process -NoNewWindow powershell -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 240'; Start-Sleep -Seconds 240",
      ],
      { stdio: "ignore", detached: false },
    )
  : spawn("/bin/sh", ["-c", "sleep 240 & sleep 240"], { stdio: "ignore", detached: true })

writeFileSync(
  process.env.PROBE_OUT,
  JSON.stringify({
    mainPid: Number(process.env.PROBE_MAIN_PID),
    hostPid: process.pid,
    toolPid: tool.pid,
  }),
)

process.parentPort.on("message", () => {})
setInterval(() => {}, 1_000)
