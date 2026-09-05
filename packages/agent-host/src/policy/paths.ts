import { realpathSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"

/**
 * Deciding whether a path is inside the workspace.
 *
 * This is the check the whole approval policy rests on, and it is easy to get
 * subtly wrong on Windows in ways that never show up on a developer's machine:
 *
 * - `C:\PROGRA~1` and `C:\Program Files` are the same directory. A string
 *   comparison says they are not.
 * - A `subst` drive, a junction, and a symlink all alias one real directory
 *   under a different prefix.
 * - `\?\C:\x` and `C:\x` differ as strings and not as locations.
 * - Path comparison is case-insensitive on Windows and macOS, and not on Linux.
 *
 * `realpath` resolves every one of those to the same canonical form, which is
 * why the comparison happens after it and never before.
 */
export const canonicalize = (path: string): string => {
  const absolute = resolve(path)
  try {
    return realpathSync.native(absolute)
  } catch {
    // The path does not exist yet — a file a write tool is about to create. Its
    // parent decides containment, and the parent's canonical form is what a
    // junction or a subst drive would have hidden.
    const parent = dirname(absolute)
    if (parent === absolute) return absolute
    try {
      return resolve(realpathSync.native(parent), absolute.slice(parent.length + 1))
    } catch {
      return absolute
    }
  }
}

/**
 * True when `path` is the root itself or lies beneath it.
 *
 * Uses `relative()` rather than a prefix comparison, because `startsWith` on a
 * root of `C:\work\app` accepts `C:\work\app-secrets`. That is not a
 * theoretical case; it is what a repository sitting next to its own backup
 * directory looks like.
 */
export const isInside = (root: string, path: string): boolean => {
  const canonicalRoot = canonicalize(root)
  const canonicalPath = canonicalize(path)
  if (canonicalRoot === canonicalPath) return true

  const within = relative(canonicalRoot, canonicalPath)
  if (within === "") return true
  if (within.startsWith("..")) return false
  // An absolute result means the two are on different roots or drives.
  return !isAbsolute(within) && !within.startsWith(sep)
}

/**
 * Canonicalizes a tool's declared targets for display and for the policy
 * decision.
 *
 * Both the approval card and the policy read the same canonical values, so what
 * the user is shown is what is being decided on. Re-canonicalizing between the
 * two would be the classic time-of-check-to-time-of-use gap: a symlink swapped
 * after the card renders and before the tool runs.
 */
export const classifyTargets = (
  root: string,
  targets: { path: string; kind: "read" | "write" | "execute" }[],
): { path: string; kind: "read" | "write" | "execute"; insideWorkspace: boolean }[] =>
  targets.map((target) => {
    const path = canonicalize(target.path)
    return { path, kind: target.kind, insideWorkspace: isInside(root, path) }
  })
