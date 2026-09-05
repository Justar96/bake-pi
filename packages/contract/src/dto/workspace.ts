import { type Static, Type } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import { AbsolutePath, WorkspaceId } from "./primitives.ts"

/**
 * Trust is a Bake Pi concept layered over Pi's project handling, and it is
 * honest about what it is: a gate on loading project-supplied executable code
 * and on running tools without prompting. It is not a sandbox.
 */
export const TrustLevel = Type.Union([
  /** Never opened before. No project extensions load; every tool asks. */
  Type.Literal("untrusted"),
  /** Project extensions load. Writes inside the workspace run without asking; everything else asks. */
  Type.Literal("trusted"),
  /**
   * Nothing asks. Pi's trust store is a boolean, so this level cannot live in
   * it — Pi records `trusted` and the host remembers the extra step in its own
   * per-workspace permission file, which is what brings it back on the next
   * open.
   *
   * It survives a restart, and that is a deliberate reversal of an earlier
   * decision to let it lapse. The cost is real: a workspace someone once set to
   * full access reopens with nothing asking, and they are not shown the choice
   * again. What made lapsing worse in practice is that the person who wants
   * this wants it for a project they work in every day, and re-picking it every
   * launch trains them to reach for the most permissive level by reflex. The
   * decision stays visible instead — the permission pill under the composer
   * always names the level in force, and Pi's own trust store still overrules
   * this one, so revoking trust from the CLI drops the workspace back to
   * restricted.
   */
  Type.Literal("full"),
])
export type TrustLevel = Static<typeof TrustLevel>

/** The operating environment that owns the workspace, Pi state, and tools. */
export const WorkspaceRuntime = Type.Union([
  Type.Object({ kind: Type.Literal("windows") }),
  Type.Object({
    kind: Type.Literal("wsl"),
    distro: Type.String({ minLength: 1, maxLength: 128, pattern: "^[^\\\\/\\u0000\\r\\n]+$" }),
  }),
])
export type WorkspaceRuntime = Static<typeof WorkspaceRuntime>

/** A host-local root paired with the environment in which it is meaningful. */
export const WorkspaceTarget = Type.Object({
  root: AbsolutePath,
  runtime: WorkspaceRuntime,
})
export type WorkspaceTarget = Static<typeof WorkspaceTarget>

/** The runtime every Windows-hosted workspace names, stated once. */
export const WINDOWS_RUNTIME: WorkspaceRuntime = { kind: "windows" }

/**
 * Runtime identity, validity and workspace identity, in the one module both
 * sides import.
 *
 * Each of these was written out at four or five call sites across main and the
 * renderer, and the copies had already disagreed: one guard enforced the
 * schema's distro bounds and another accepted any non-empty string, so a
 * workspace the renderer remembered could be one main refuses to open. The
 * schema above is the single statement of what a runtime is; these three
 * derive from it rather than restating it.
 */
export const isWorkspaceRuntime = (value: unknown): value is WorkspaceRuntime =>
  Value.Check(WorkspaceRuntime, value)

export const sameWorkspaceRuntime = (left: WorkspaceRuntime, right: WorkspaceRuntime): boolean =>
  left.kind === right.kind && (left.kind === "windows" || left.distro === (right as { distro: string }).distro)

/**
 * A stable key for "the same workspace". Windows roots are compared
 * case-insensitively because the filesystem is; Linux roots are not, because
 * it is not.
 */
export const workspaceTargetKey = (target: { root: string; runtime: WorkspaceRuntime }): string =>
  target.runtime.kind === "wsl"
    ? `wsl\0${target.runtime.distro}\0${target.root}`
    : `windows\0${target.root.toLocaleLowerCase("en-US")}`

export const Workspace = Type.Object({
  id: WorkspaceId,
  root: AbsolutePath,
  runtime: WorkspaceRuntime,
  displayName: Type.String({ maxLength: 256 }),
  trust: TrustLevel,
  /** Recorded when trust was granted, so a moved or replaced directory re-prompts. */
  trustedAt: Type.Optional(Type.Integer({ minimum: 0 })),
  isGitRepository: Type.Boolean(),
})
export type Workspace = Static<typeof Workspace>

/** An opaque handle main minted for a path it knows. The renderer cannot forge a useful one. */
export const WorkspaceLocationId = Type.String({ minLength: 1, maxLength: 64 })
export type WorkspaceLocationId = Static<typeof WorkspaceLocationId>

/**
 * A place a workspace could be opened or created, offered by main.
 *
 * `root` is display only. The renderer sends back `id`, and main resolves it
 * to the path it minted the id for — the same asymmetry `DirectoryEntry`
 * relies on, applied before a workspace exists.
 */
export const WorkspaceLocation = Type.Object({
  id: WorkspaceLocationId,
  root: AbsolutePath,
  runtime: WorkspaceRuntime,
  displayName: Type.String({ maxLength: 256 }),
})
export type WorkspaceLocation = Static<typeof WorkspaceLocation>

/**
 * One entry in a workspace directory listing.
 *
 * The path is canonical and the host has already decided it lies inside the
 * workspace root, so what the renderer holds is a name to draw and a key to
 * expand — never a path it composed itself and asked to have read. That
 * asymmetry is the point: the file rail can only ever walk down from the root
 * the user opened, because every path it can name came back from a listing the
 * host had already contained.
 */
export const DirectoryEntry = Type.Object({
  name: Type.String({ maxLength: 512 }),
  path: AbsolutePath,
  kind: Type.Union([Type.Literal("directory"), Type.Literal("file")]),
  /** Git's current answer for this path; false outside a repository. */
  ignored: Type.Boolean(),
})
export type DirectoryEntry = Static<typeof DirectoryEntry>
