import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { mkdir, realpath, rm, stat } from "node:fs/promises"
import { basename, dirname, join, posix } from "node:path"
import { promisify } from "node:util"
import {
  BakePiError,
  WINDOWS_RUNTIME,
  type WorkspaceLocation,
  type WorkspaceRuntime,
  type WorkspaceTarget,
  workspaceTargetKey,
} from "@bake-pi/contract"
import { runWsl } from "./supervisor/wsl-process.ts"

const run = promisify(execFile)

/**
 * The paths main is willing to name to the renderer, each behind an id.
 *
 * The renderer never sends a path across the boundary; it sends back an id
 * from a listing main produced, and main looks the path up again here. Ids are
 * minted once per path for the life of the process, so a listing can be
 * refreshed without invalidating a choice the person is about to make.
 */
export class WorkspaceLocations {
  readonly #targetById = new Map<string, WorkspaceTarget>()
  readonly #idByTarget = new Map<string, string>()

  offer(target: WorkspaceTarget): WorkspaceLocation {
    const key = workspaceTargetKey(target)
    let id = this.#idByTarget.get(key)
    if (id === undefined) {
      id = randomUUID()
      this.#idByTarget.set(key, id)
      this.#targetById.set(id, target)
    }
    return {
      id,
      ...target,
      displayName: target.runtime.kind === "wsl" ? target.runtime.distro : basename(target.root) || target.root,
    }
  }

  resolve(id: string): WorkspaceTarget {
    const target = this.#targetById.get(id)
    if (target === undefined) throw new BakePiError("malformed_command", { detail: "unknown_location" })
    return target
  }
}

export const workspaceParent = (target: WorkspaceTarget): WorkspaceTarget => ({
  root: target.runtime.kind === "wsl" ? posix.dirname(target.root) : dirname(target.root),
  runtime: target.runtime,
})

/**
 * The home directory of every WSL distribution, in that distro's own path
 * vocabulary. UNC paths are deliberately absent from the returned locations:
 * the root goes to the Linux host, and conversion for the native picker is a
 * separate, one-way display operation.
 *
 * `wsl.exe --list --quiet` writes UTF-16LE, one distribution per line. Asking
 * for `$HOME` starts a stopped distribution, which is the cost of knowing
 * the actual login home rather than guessing `/home/<windows-user>`. A distro
 * that cannot answer is omitted. No `wsl.exe` or no distributions is an empty
 * list, not an error: the modal has other tabs.
 */
export const listWslHomes = async (): Promise<WorkspaceTarget[]> => {
  if (process.platform !== "win32") return []
  let distros: string[]
  try {
    const { stdout } = await run("wsl.exe", ["--list", "--quiet"], { encoding: "buffer", timeout: 5_000, windowsHide: true })
    distros = stdout.toString("utf16le").split(/\r?\n/).map((line) => line.replace(/\0/g, "").trim()).filter((line) => line.length > 0)
  } catch {
    return []
  }
  const homes = await Promise.all(distros.map(async (distro): Promise<WorkspaceTarget | undefined> => {
    try {
      const { code, stdout } = await runWsl(distro, ["sh", "-lc", 'printf "%s" "$HOME"'], undefined, 5_000)
      if (code !== 0) return undefined
      const root = stdout.trim()
      if (!posix.isAbsolute(root) || root.includes("\0") || root.includes("\n")) return undefined
      return { root, runtime: { kind: "wsl", distro } }
    } catch {
      return undefined
    }
  }))
  return homes.filter((home): home is WorkspaceTarget => home !== undefined)
}

/** Converts a host-local root into the path understood by Electron's Windows picker. */
export const windowsPathFor = (target: WorkspaceTarget): string => {
  if (target.runtime.kind === "windows") return target.root
  const mounted = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/u.exec(target.root)
  if (mounted !== null) {
    const suffix = mounted[2]?.replaceAll("/", "\\") ?? ""
    return `${mounted[1]!.toUpperCase()}:\\${suffix}`
  }
  const suffix = target.root === "/" ? "" : target.root.replace(/^\//u, "").replaceAll("/", "\\")
  return `\\\\wsl.localhost\\${target.runtime.distro}${suffix.length === 0 ? "" : `\\${suffix}`}`
}

/** The explicit slow path offered only when a selected WSL distro cannot run Node. */
export const windowsFallbackFor = (target: WorkspaceTarget): WorkspaceTarget => ({
  root: windowsPathFor(target),
  runtime: WINDOWS_RUNTIME,
})

/** Converts one native-picker result back into the selected host's path vocabulary. */
export const hostPathFor = (path: string, runtime: WorkspaceRuntime): string => {
  if (runtime.kind === "windows") return path

  const unc = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(?:\\(.*))?$/iu.exec(path)
  if (unc !== null) {
    if (unc[1]!.toLocaleLowerCase("en-US") !== runtime.distro.toLocaleLowerCase("en-US")) {
      throw new BakePiError("path_outside_workspace", { detail: "path belongs to another WSL distribution" })
    }
    const segments = (unc[2] ?? "").split("\\").filter((segment) => segment.length > 0)
    if (segments.some((segment) => segment === "." || segment === "..")) {
      throw new BakePiError("malformed_command", { detail: "invalid_wsl_path" })
    }
    return `/${segments.join("/")}`
  }

  const drive = /^([a-zA-Z]):[\\/](.*)$/u.exec(path)
  if (drive !== null) {
    const segments = drive[2]!.split(/[\\/]/u).filter((segment) => segment.length > 0)
    if (segments.some((segment) => segment === "." || segment === "..")) {
      throw new BakePiError("malformed_command", { detail: "invalid_wsl_path" })
    }
    return `/mnt/${drive[1]!.toLowerCase()}/${segments.join("/")}`.replace(/\/$/u, "")
  }

  throw new BakePiError("malformed_command", { detail: "unsupported_wsl_path" })
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu

const validWorkspaceName = (name: string, windows = process.platform === "win32"): boolean => {
  if (name.length === 0 || name.length > 255 || /[\/\\\0]/u.test(name)) return false
  if (name === "." || name === ".." || name.trim() !== name) return false
  if (!windows) return true
  return !/[<>:"|?*\u0000-\u001f]/u.test(name) && !name.endsWith(".") && !WINDOWS_RESERVED_NAME.test(name)
}

const initializeRepository = async (root: string): Promise<void> => {
  await run("git", ["init", "--quiet"], { cwd: root, timeout: 15_000, windowsHide: true })
}

/**
 * Creates one new workspace below an existing offered parent.
 *
 * Both separators are rejected on every platform. In particular, a backslash
 * is a separator on Windows even though `/[\/]/` only rejects the forward one;
 * accepting it let a renderer-supplied `..\\sibling` escape the location id
 * main had offered. The parent is resolved before the child is made so the
 * returned path and the path the host later canonicalizes name the same place.
 *
 * Git initialization is part of the requested operation rather than a best-
 * effort extra. If it fails, only the directory this call just created is
 * removed, leaving a retry with the same name clean instead of returning a
 * workspace that contradicts the checked option.
 */
export const createWorkspaceDirectory = async (
  parent: string,
  name: string,
  initializeGit: boolean,
  initGit: (root: string) => Promise<void> = initializeRepository,
): Promise<string> => {
  if (!validWorkspaceName(name, true)) {
    throw new BakePiError("malformed_command", { detail: "invalid_workspace_name" })
  }

  let canonicalParent: string
  try {
    canonicalParent = await realpath(parent)
    if (!(await stat(canonicalParent)).isDirectory()) {
      throw new BakePiError("malformed_command", { detail: "workspace_parent_not_directory" })
    }
  } catch (cause) {
    if (cause instanceof BakePiError) throw cause
    throw new BakePiError("internal_error", { detail: "workspace_parent_unavailable", cause })
  }

  const root = join(canonicalParent, name)
  try {
    await mkdir(root)
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    throw new BakePiError("internal_error", { detail: code === "EEXIST" ? "workspace_exists" : `mkdir_failed:${code ?? "unknown"}` })
  }
  if (initializeGit) {
    try {
      await initGit(root)
    } catch (cause) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
      throw new BakePiError("internal_error", { detail: "git_init_failed", cause })
    }
  }
  return root
}

/** Creates a workspace in the filesystem owned by its selected runtime. */
export const createWorkspaceTarget = async (
  parent: WorkspaceTarget,
  name: string,
  initializeGit: boolean,
): Promise<WorkspaceTarget> => {
  if (parent.runtime.kind === "windows") {
    return { root: await createWorkspaceDirectory(parent.root, name, initializeGit), runtime: parent.runtime }
  }
  if (!validWorkspaceName(name, false)) {
    throw new BakePiError("malformed_command", { detail: "invalid_workspace_name" })
  }

  const script = 'set -eu; parent=$(readlink -f -- "$1"); test -d "$parent"; target="$parent/$2"; mkdir -- "$target"; if [ "$3" = true ]; then trap \'rm -rf -- "$target"\' EXIT; git -C "$target" init --quiet; trap - EXIT; fi; readlink -f -- "$target"'
  try {
    const { code, stdout } = await runWsl(
      parent.runtime.distro,
      ["sh", "-c", script, "sh", parent.root, name, initializeGit ? "true" : "false"],
      undefined,
      20_000,
    )
    if (code !== 0) throw new Error("WSL could not create the workspace directory")
    const root = stdout.trim()
    if (!posix.isAbsolute(root)) throw new Error("WSL did not return an absolute workspace path")
    return { root, runtime: parent.runtime }
  } catch (cause) {
    throw new BakePiError("internal_error", { detail: initializeGit ? "workspace_create_or_git_failed" : "workspace_create_failed", cause })
  }
}

/**
 * Reads metadata in Linux so attachment contents never traverse the WSL share.
 *
 * The whole selection goes in one `wsl.exe`, because the launch is the cost:
 * `stat` over sixteen paths is arithmetic, while sixteen serialized process
 * starts into a distribution are seconds a person spends staring at the picker
 * they just dismissed. `"$@"` keeps every path a positional argument, so
 * nothing is interpolated into the script.
 */
export const wslFileSizes = async (distro: string, paths: readonly string[]): Promise<number[]> => {
  if (paths.length === 0) return []
  try {
    const { code, stdout } = await runWsl(
      distro,
      ["sh", "-c", 'stat -c "%s" -- "$@"', "sh", ...paths],
      undefined,
      5_000,
    )
    if (code !== 0) throw new Error("WSL could not read the attachment metadata")
    const sizes = stdout.trim().split(/\r?\n/u).map((line) => Number(line.trim()))
    if (sizes.length !== paths.length || sizes.some((bytes) => !Number.isSafeInteger(bytes) || bytes < 0)) {
      throw new Error("WSL returned an invalid file size")
    }
    return sizes
  } catch (cause) {
    throw new BakePiError("resource_not_found", { detail: "attachment could not be read", cause })
  }
}
