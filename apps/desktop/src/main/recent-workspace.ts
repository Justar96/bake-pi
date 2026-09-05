import { readFile, writeFile } from "node:fs/promises"
import { isAbsolute, posix } from "node:path"
import { type WorkspaceTarget, isWorkspaceRuntime, workspaceTargetKey } from "@bake-pi/contract"

const MAX_RECENT = 5

interface StoredRecentWorkspaces {
  version: 3
  workspaces: WorkspaceTarget[]
}

/**
 * The roots Electron's own picker returned, most recent first.
 *
 * The renderer may ask to reopen one, but never receives a command that accepts
 * a path. Keeping the paths on this side preserves the boundary that prevents a
 * compromised renderer from making the host load an arbitrary project.
 *
 * This is a convenience preference, not session state. A missing, malformed or
 * unwritable file therefore behaves like no recent workspace instead of
 * keeping the application from opening.
 */
export class RecentWorkspaceStore {
  constructor(private readonly path: string) {}

  /** The most recent root, for the startup shortcut. */
  async read(): Promise<WorkspaceTarget | undefined> {
    return (await this.list())[0]
  }

  async list(): Promise<WorkspaceTarget[]> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as {
        version?: unknown
        root?: unknown
        roots?: unknown
        workspaces?: unknown
      }
      if (value.version === 3) {
        if (!Array.isArray(value.workspaces)) return []
        return value.workspaces.filter(isWorkspaceTarget).slice(0, MAX_RECENT)
      }
      // Versions 1 and 2 held Windows roots only.
      const roots = value.version === 2 ? value.roots : value.version === 1 ? [value.root] : []
      if (!Array.isArray(roots)) return []
      return roots
        .filter((root): root is string => typeof root === "string" && isAbsolute(root))
        .map((root) => ({ root, runtime: { kind: "windows" as const } }))
        .slice(0, MAX_RECENT)
    } catch {
      return []
    }
  }

  async remember(target: WorkspaceTarget): Promise<void> {
    if (!isWorkspaceTarget(target)) return
    const key = workspaceTargetKey(target)
    const workspaces = [target, ...(await this.list()).filter((known) => workspaceTargetKey(known) !== key)].slice(0, MAX_RECENT)
    const value: StoredRecentWorkspaces = { version: 3, workspaces }
    try {
      await writeFile(this.path, JSON.stringify(value), "utf8")
    } catch {
      // Opening the workspace succeeded. Failure to remember that convenience
      // must not turn a successful, authoritative host result into an error.
    }
  }
}

// The runtime half is the contract's own guard, so a stored file is held to
// exactly the schema a command would be. What stays here is the part the schema
// cannot state: which absoluteness rule a root is judged by depends on the
// runtime beside it, and `AbsolutePath` knows only one of the two.
const isWorkspaceTarget = (value: unknown): value is WorkspaceTarget => {
  if (typeof value !== "object" || value === null) return false
  const target = value as { root?: unknown; runtime?: unknown }
  if (typeof target.root !== "string" || !isWorkspaceRuntime(target.runtime)) return false
  return target.runtime.kind === "wsl" ? posix.isAbsolute(target.root) : isAbsolute(target.root)
}
