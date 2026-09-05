import { existsSync, mkdirSync, openSync, renameSync, statSync, writeSync } from "node:fs"
import { join } from "node:path"
import { format } from "node:util"

/**
 * Where a packaged Bake Pi says what went wrong.
 *
 * Development has a terminal, so everything main and the agent host print is
 * already in front of whoever started it. An installed copy has none: Windows
 * launches it from a shortcut with no console attached, and every
 * `console.error` and every byte the host writes to stderr goes to a handle
 * nobody can read. The first report from a machine that was not this one made
 * the cost concrete — a host that died before its handshake, a window that
 * could only say the host was gone, and no way for the person in front of it
 * or for us to learn a single thing more.
 *
 * So the same lines go to a file as well as to the console. Not a logging
 * framework and not a second diagnostic channel: `Diagnostics` in the agent
 * host remains the structured record the interface reads, and this is the
 * unstructured one for the failures that happen before, below, or instead of
 * it.
 *
 * Written with `writeSync` on a held descriptor. A buffered stream is faster
 * and loses precisely the last few lines when the process dies, which are the
 * only ones worth having; the volume here is startup diagnostics and a crash,
 * not a hot path. Nothing needs closing at quit for the same reason.
 *
 * Electron is not imported here, and the directory arrives as an argument. Two
 * of the three modules that write to this file are reachable from tests that
 * never boot a main process, and an `import { app } from "electron"` at the top
 * of this one would take all of them down with it.
 */

/** Past this, the file is rotated. One previous generation is kept. */
const MAX_BYTES = 4 * 1024 * 1024

export interface LogSink {
  readonly path: string
  write: (level: string, text: string) => void
}

/**
 * Opens the file and returns the one operation everything else needs.
 *
 * Separate from `installLogFile` because that one patches the global console,
 * which a test cannot undo and must not inherit. Everything worth asserting —
 * where the file lands, what a line looks like, when the previous generation is
 * rotated away — is here, and reachable without touching a global.
 */
export const createLogSink = (directory: string, banner: string): LogSink => {
  mkdirSync(directory, { recursive: true })
  const target = join(directory, "bake-pi.log")
  if (existsSync(target) && statSync(target).size >= MAX_BYTES) renameSync(target, `${target}.1`)
  const descriptor = openSync(target, "a")

  const write = (level: string, text: string): void => {
    try {
      writeSync(descriptor, `${new Date().toISOString()} ${level} ${text}\n`)
    } catch {
      // A log that cannot be written must not become the failure it was there
      // to explain. The console still has the line.
    }
  }

  write("log", banner)
  return { path: target, write }
}

let sink: LogSink | undefined

/** The log's location, once `installLogFile` has run. */
export const logFilePath = (): string | undefined => sink?.path

/**
 * Appends one line, for output that never went through `console`.
 *
 * The agent host's stdout and stderr are piped rather than inherited, and the
 * supervisor forwards the chunks to `process.stdout` directly. Those chunks are
 * the whole reason this file exists, so they take the short path in.
 */
export const appendLog = (scope: string, text: string): void => {
  sink?.write(scope, text.replace(/\n+$/, ""))
}

/**
 * Opens the log and starts copying the console into it.
 *
 * Patching `console` rather than asking every call site to log twice: the lines
 * worth having are the ones already written, across main, the supervisor and
 * every module either of them loads, and a rule that only holds where somebody
 * remembered to follow it is not a rule. The original console still receives
 * everything first, so a terminal-run build behaves exactly as it did.
 *
 * Safe to call more than once; the second call does nothing.
 */
export const installLogFile = (directory: string, banner: string): string | undefined => {
  if (sink !== undefined) return sink.path

  let opened: LogSink
  try {
    opened = createLogSink(directory, banner)
  } catch (error) {
    console.error("[main] no log file; diagnostics stay on the console only", error)
    return undefined
  }
  sink = opened

  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]): void => {
      original(...args)
      opened.write(level, format(...args))
    }
  }
  return opened.path
}
