import { isAbsolute, resolve } from "node:path"

/** A target before canonicalization and containment classification. */
export interface RawTarget {
  path: string
  kind: "read" | "write" | "execute"
}

export interface ExtractedTargets {
  /**
   * False when this host does not know the tool's argument shape well enough to
   * say what it will touch. The policy treats that as a reason to ask, not as a
   * reason to allow — see `requiresApproval`.
   */
  resolved: boolean
  targets: RawTarget[]
}

/**
 * Pi's built-in tools, with the argument field naming each one's target.
 *
 * These shapes are read off the pinned Pi version's tool schemas
 * (`dist/core/tools/*.d.ts`), not guessed:
 *
 * | Tool | Arguments | Target |
 * | --- | --- | --- |
 * | `read` | `{ path, offset?, limit? }` | that path, read |
 * | `ls` | `{ path?, limit? }` | that path or the cwd, read |
 * | `grep` | `{ pattern, path?, ... }` | that path or the cwd, read |
 * | `find` | `{ pattern, path?, limit? }` | that path or the cwd, read |
 * | `write` | `{ path, content }` | that path, write |
 * | `edit` | `{ path, edits[] }` | that path, write |
 * | `bash` | `{ command, timeout? }` | the cwd, execute |
 * | `powershell` | `{ command, timeout? }` | the cwd, execute |
 *
 * A tool absent from this table is `resolved: false`. That is the honest answer
 * for an extension-contributed tool whose arguments mean nothing to Bake Pi, and
 * it is the reason the table is data rather than a chain of `if`s: adding a tool
 * to it is a deliberate claim that its targets are understood.
 */
const BUILTIN_TOOLS = {
  read: { field: "path", kind: "read", fallbackToCwd: false },
  ls: { field: "path", kind: "read", fallbackToCwd: true },
  grep: { field: "path", kind: "read", fallbackToCwd: true },
  find: { field: "path", kind: "read", fallbackToCwd: true },
  write: { field: "path", kind: "write", fallbackToCwd: false },
  edit: { field: "path", kind: "write", fallbackToCwd: false },
} as const satisfies Record<string, { field: string; kind: RawTarget["kind"]; fallbackToCwd: boolean }>

/** Shell tools whose one honest target is the directory they run in. */
const SHELL_TOOLS = new Set(["bash", "powershell"])

export const isBuiltinToolName = (toolName: string): boolean =>
  Object.hasOwn(BUILTIN_TOOLS, toolName) || SHELL_TOOLS.has(toolName)

/**
 * What a tool call intends to touch, as far as the arguments can say.
 *
 * Relative paths resolve against the session's `cwd` and not against the agent
 * host's own working directory. The host process runs wherever Electron started
 * it, which is never the workspace — resolving `src/a.ts` against the wrong base
 * produces a path outside the workspace, and the policy would then prompt for
 * ordinary in-workspace edits while a real escape looked identical.
 *
 * A shell command is deliberately reported as `execute` on the working directory
 * rather than parsed for the files it might touch. Parsing a shell command to
 * predict its effects cannot be done correctly — `eval`, a variable, a pipeline,
 * a script that writes a script — and a policy that claimed it could would be
 * lying about the one thing the approval card exists to tell the truth about.
 * The card shows the command and its working directory; the user reads the
 * command.
 */
export const extractTargets = (toolName: string, input: unknown, cwd: string): ExtractedTargets => {
  if (SHELL_TOOLS.has(toolName)) {
    return { resolved: true, targets: [{ path: cwd, kind: "execute" }] }
  }

  const spec = Object.hasOwn(BUILTIN_TOOLS, toolName)
    ? BUILTIN_TOOLS[toolName as keyof typeof BUILTIN_TOOLS]
    : undefined
  if (spec === undefined) return { resolved: false, targets: [] }

  const raw = readStringField(input, spec.field)
  if (raw === undefined) {
    // A known tool whose required target argument is missing or not a string.
    // The tool would fail validation anyway, but "we could not tell" is the only
    // truthful classification, and it fails closed.
    return spec.fallbackToCwd
      ? { resolved: true, targets: [{ path: cwd, kind: spec.kind }] }
      : { resolved: false, targets: [] }
  }

  return { resolved: true, targets: [{ path: absolutize(raw, cwd), kind: spec.kind }] }
}

const readStringField = (input: unknown, field: string): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined
  const value = (input as Record<string, unknown>)[field]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

const absolutize = (path: string, cwd: string): string => (isAbsolute(path) ? path : resolve(cwd, path))
