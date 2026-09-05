import { spawn } from "node:child_process"
import { isAbsolute, relative, sep } from "node:path"

export interface GitRepository {
  root: string
}

/**
 * Finds the repository that owns a workspace, including when the opened
 * workspace is a directory below its root.
 *
 * Git answers this rather than a `.git` directory probe: worktrees use a file,
 * and a workspace may legitimately be nested inside a repository. Failure is
 * deliberately ordinary — Bake Pi does not require Git in order to open a
 * directory.
 */
export const findGitRepository = async (workspaceRoot: string): Promise<GitRepository | undefined> => {
  const result = await runGit(workspaceRoot, ["rev-parse", "--show-toplevel"])
  if (result.code !== 0) return undefined
  const root = result.stdout.trim()
  return root === "" ? undefined : { root }
}

/**
 * Classifies paths using Git's live ignore rules.
 *
 * Delegating the decision matters: `.gitignore` files below the root,
 * `.git/info/exclude`, a user's global excludes, negation, and tracked files
 * are all parts of Git's answer. Reimplementing only the first of those would
 * make the rail disagree with `git status` in exactly the repositories where
 * the distinction is useful.
 *
 * Paths travel over a NUL-delimited stdin stream, so neither the platform's
 * command-line length nor spaces and newlines in a filename change the result.
 * If Git becomes unavailable after the workspace opens, the safe UI failure is
 * to show a path rather than silently hide one.
 */
export const ignoredByGit = async (
  repository: GitRepository,
  absolutePaths: readonly string[],
): Promise<ReadonlySet<string>> => {
  const absoluteByRelative = new Map<string, string>()
  for (const path of absolutePaths) {
    const fromRoot = relative(repository.root, path)
    if (fromRoot === "" || fromRoot.startsWith(`..${sep}`) || fromRoot === ".." || isAbsolute(fromRoot)) continue
    absoluteByRelative.set(fromRoot.split(sep).join("/"), path)
  }
  if (absoluteByRelative.size === 0) return new Set()

  const input = `${[...absoluteByRelative.keys()].join("\0")}\0`
  const result = await runGit(repository.root, ["check-ignore", "--stdin", "-z"], input)
  // Exit 1 means no candidate was ignored. Anything else non-zero is a real
  // Git failure, and fail-open is the least surprising tree behavior.
  if (result.code !== 0 && result.code !== 1) return new Set()

  const ignored = new Set<string>()
  for (const relativePath of result.stdout.split("\0")) {
    const absolutePath = absoluteByRelative.get(relativePath)
    if (absolutePath !== undefined) ignored.add(absolutePath)
  }
  return ignored
}

interface GitResult {
  code: number | null
  stdout: string
}

const runGit = async (cwd: string, args: readonly string[], input?: string): Promise<GitResult> =>
  await new Promise((resolve) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    })
    const chunks: Buffer[] = []
    let settled = false
    const finish = (result: GitResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
    child.once("error", () => finish({ code: null, stdout: "" }))
    child.once("close", (code) => finish({ code, stdout: Buffer.concat(chunks).toString("utf8") }))
    child.stdin.end(input)
  })
