import { WINDOWS_RUNTIME, type Workspace, type WorkspaceRuntime, isWorkspaceRuntime, workspaceTargetKey } from "@bake-pi/contract"

/**
 * The handful of things this interface remembers about itself.
 *
 * Nothing here is session state, and that is the whole rule: a preference is
 * about the window a person is looking through, not about the conversation
 * behind it. Rail widths and the chosen theme survive a restart because they
 * are the person's; everything Pi owns is read back from Pi.
 *
 * `localStorage` rather than a command, because there is no host round trip
 * that would make these truer — the agent host has no opinion about how wide a
 * rail is, and asking it would put a preference behind a process that can
 * crash. The renderer runs on the `bakepi://` scheme, which is registered
 * `standard` and `secure`, so it has an origin and a store of its own.
 *
 * Every read is defended. A value written by an older build, edited by hand, or
 * absent because the store is unavailable has to produce the fallback rather
 * than a `NaN` width or a theme nobody declared.
 */

const NAMESPACE = "bakepi:"

/** Reads a stored string, or `undefined` if there is none or the store refused. */
const read = (name: string): string | undefined => {
  try {
    return window.localStorage.getItem(NAMESPACE + name) ?? undefined
  } catch {
    // A store that throws is a store that is not there. Chromium throws on
    // access when site data is blocked, and a preference is never worth an
    // exception on the path that draws the window.
    return undefined
  }
}

export const remember = (name: string, value: string | number): void => {
  try {
    window.localStorage.setItem(NAMESPACE + name, String(value))
  } catch {
    // Written where it can be, forgotten where it cannot. Failing to persist a
    // rail width is not a failure a person should be told about.
  }
}

/** Removes a preference so its responsive default can take over again. */
export const forget = (name: string): void => {
  try {
    window.localStorage.removeItem(NAMESPACE + name)
  } catch {
    // Reset where possible; an unavailable preference store already behaves
    // as though the value were absent.
  }
}

/**
 * A remembered number, clamped to the range that is meaningful for it.
 *
 * Clamped rather than rejected: a width stored when the window was wider is
 * still the person's preference, and the nearest legal value is closer to what
 * they asked for than the default is. An absent value stays absent so a fluid
 * default can continue following the window until the person actually drags.
 */
export const rememberedNumberIfSet = (name: string, min: number, max: number): number | undefined => {
  const stored = Number(read(name))
  if (!Number.isFinite(stored)) return undefined
  return Math.min(max, Math.max(min, stored))
}

/** A remembered choice, which has to be one of the ones this build declares. */
export const rememberedChoice = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
  const stored = read(name)
  return allowed.find((choice) => choice === stored) ?? fallback
}

export interface RememberedWorkspace {
  displayName: string
  root: string
}

/**
 * Stores only what the opening page needs to draw the recent-project row.
 *
 * This is not authority to open a path: the pathless command asks main to look
 * up its own copy, so edited renderer storage can change a label but cannot
 * choose what the host opens.
 */
export const rememberWorkspace = ({ displayName, root }: RememberedWorkspace): void => {
  remember("recent-workspace", JSON.stringify({ displayName, root }))
}

export const rememberedWorkspace = (): RememberedWorkspace | undefined => {
  const stored = read("recent-workspace")
  if (stored === undefined) return undefined
  try {
    const value = JSON.parse(stored) as Partial<RememberedWorkspace>
    return typeof value.displayName === "string" && typeof value.root === "string" && value.root.length > 0
      ? { displayName: value.displayName, root: value.root }
      : undefined
  } catch {
    return undefined
  }
}

interface WorkspaceResume {
  root: string
  runtime: WorkspaceRuntime
  sessionId: string
}

interface StoredWorkspaceResume {
  root: string
  runtime?: WorkspaceRuntime
  sessionId: string
}

const MAX_WORKSPACE_RESUMES = 20

const workspaceResumes = (): WorkspaceResume[] => {
  const stored = read("workspace-resumes")
  if (stored === undefined) return []
  try {
    const values = JSON.parse(stored) as unknown
    if (!Array.isArray(values)) return []
    return values.filter((value): value is StoredWorkspaceResume => {
      if (typeof value !== "object" || value === null) return false
      const candidate = value as Partial<StoredWorkspaceResume>
      return typeof candidate.root === "string" && candidate.root.length > 0 &&
        typeof candidate.sessionId === "string" && candidate.sessionId.length > 0 &&
        (candidate.runtime === undefined || isWorkspaceRuntime(candidate.runtime))
    }).map((value) => ({ ...value, runtime: value.runtime ?? WINDOWS_RUNTIME })).slice(0, MAX_WORKSPACE_RESUMES)
  } catch {
    return []
  }
}

/**
 * Remembers which Pi session the person last selected in one workspace.
 *
 * This is a view preference, not a second history store. On resume the id is
 * accepted only if Pi's fresh `list_sessions` result still assigns it to the
 * canonical workspace root. The messages themselves never enter localStorage.
 */
export const rememberWorkspaceSession = (
  workspace: Pick<Workspace, "root" | "runtime">,
  sessionId: string,
): void => {
  const key = workspaceTargetKey(workspace)
  const resumes = [{ ...workspace, sessionId }, ...workspaceResumes().filter((entry) => workspaceTargetKey(entry) !== key)]
    .slice(0, MAX_WORKSPACE_RESUMES)
  remember("workspace-resumes", JSON.stringify(resumes))
}

export const rememberedWorkspaceSession = (workspace: Pick<Workspace, "root" | "runtime">): string | undefined =>
  workspaceResumes().find((entry) => workspaceTargetKey(entry) === workspaceTargetKey(workspace))?.sessionId

export const forgetWorkspaceSession = (workspace: Pick<Workspace, "root" | "runtime">): void => {
  const key = workspaceTargetKey(workspace)
  remember("workspace-resumes", JSON.stringify(workspaceResumes().filter((entry) => workspaceTargetKey(entry) !== key)))
}

/**
 * The pixel number behind a StyleX size token.
 *
 * `size` is a `defineConsts` group, so the compiler folds a token into its own
 * literal — `size.railFiles` is the string `"248px"` here, not a `var()`. The
 * number is therefore already in hand and this is a parse.
 *
 * It used to be a DOM round trip. While `size` was `defineVars` a token in
 * JavaScript was `var(--x1a2b3c)` and the value lived on `:root`, so recovering
 * it meant `getComputedStyle` plus a fallback for the test environment, which
 * has no stylesheet — and that fallback was a second copy of the number,
 * sitting in the caller, free to drift from the token it was standing in for.
 * Inlining removed the reason for both.
 */
export const tokenPixels = (token: string): number => {
  // The suffix is checked rather than assumed. `size` also holds `74ch` and a
  // `clamp()`, and a bare `parseFloat` would read the first of those as 74
  // pixels without complaint — a plausible number, silently wrong.
  const pixels = /^(\d+(?:\.\d+)?)px$/.exec(token)?.[1]
  if (pixels === undefined) throw new Error(`size token is not a pixel length: ${token}`)
  return Number.parseFloat(pixels)
}
