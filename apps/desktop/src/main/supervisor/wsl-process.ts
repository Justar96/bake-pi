import { spawn, type ChildProcess } from "node:child_process"
import type { Readable } from "node:stream"

/**
 * Every `wsl.exe` invocation main makes, in one place.
 *
 * `--exec` is deliberate: it skips the distribution's default shell, so the
 * argument vector main builds is the argument vector Linux receives. Nothing
 * here ever interpolates a value into a shell string; a script is always a
 * constant and its inputs arrive as positional arguments.
 */

const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024

export interface ProcessResult {
  code: number
  stdout: string
  stderr: string
}

export const spawnWsl = (
  distro: string,
  args: string[],
  stdin: "ignore" | "pipe" = "pipe",
): ChildProcess =>
  spawn("wsl.exe", ["-d", distro, "--exec", ...args], {
    stdio: [stdin, "pipe", "pipe"],
    windowsHide: true,
  })

export const runWsl = async (
  distro: string,
  args: string[],
  input?: Uint8Array,
  timeoutMs = 30_000,
): Promise<ProcessResult> => await collect(spawnWsl(distro, args), input, timeoutMs)

/**
 * The same call for input too large to hold in memory.
 *
 * A managed Node tarball is roughly 57 MB, and buffering it in main only to
 * hand it straight to `wsl.exe` would be 57 MB of resident cost in the one
 * process this application cannot restart.
 */
export const streamWsl = async (
  distro: string,
  args: string[],
  input: Readable,
  timeoutMs = 30_000,
): Promise<ProcessResult> => await collect(spawnWsl(distro, args), input, timeoutMs)

const collect = async (
  child: ChildProcess,
  input: Uint8Array | Readable | undefined,
  timeoutMs: number,
): Promise<ProcessResult> => {
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let stdoutBytes = 0
  let stderrBytes = 0
  child.stdout?.on("data", (chunk: Buffer) => {
    if (stdoutBytes >= MAX_PROCESS_OUTPUT_BYTES) return
    stdout.push(chunk.subarray(0, MAX_PROCESS_OUTPUT_BYTES - stdoutBytes))
    stdoutBytes += chunk.length
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderrBytes >= MAX_PROCESS_OUTPUT_BYTES) return
    stderr.push(chunk.subarray(0, MAX_PROCESS_OUTPUT_BYTES - stderrBytes))
    stderrBytes += chunk.length
  })
  if (input === undefined) child.stdin?.end()
  else if (input instanceof Uint8Array) child.stdin?.end(input)
  else if (child.stdin === null) input.destroy()
  else input.pipe(child.stdin)

  const code = await new Promise<number>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer)
      child.off("error", onError)
      child.off("exit", onExit)
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onExit = (value: number | null): void => {
      cleanup()
      resolve(value ?? 1)
    }
    const timer = setTimeout(() => {
      cleanup()
      child.kill()
      reject(new Error("wsl command timed out"))
    }, timeoutMs)
    child.once("error", onError)
    child.once("exit", onExit)
  })
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  }
}
