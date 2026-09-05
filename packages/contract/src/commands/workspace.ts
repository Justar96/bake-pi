import { Type } from "@sinclair/typebox"
import { AbsolutePath, WorkspaceId } from "../dto/primitives.ts"
import {
  DirectoryEntry,
  TrustLevel,
  Workspace,
  WorkspaceLocation,
  WorkspaceLocationId,
  WorkspaceRuntime,
} from "../dto/workspace.ts"
import { defineCommands } from "./define.ts"

/**
 * How many entries one directory listing may carry.
 *
 * A cap rather than pagination, because this listing feeds a tree that expands
 * one directory at a time: a person who opens `node_modules` wants to be told
 * the directory is enormous, not handed the first page of it. The listing says
 * so with `truncated`, and the rail draws that rather than pretending the
 * directory ends where the array does.
 */
export const MAX_DIRECTORY_ENTRIES = 1000

export const workspaceCommands = defineCommands({
  /**
   * Opens Electron's native directory picker, then asks the host to open the
   * selected path. The renderer receives the canonical workspace, never a
   * capability to invent a host filesystem path.
   */
  choose_workspace: {
    /** Where the picker opens. A location id main handed out; never a path. */
    params: Type.Object({ startAt: Type.Optional(WorkspaceLocationId) }),
    result: Type.Object({ workspace: Type.Optional(Workspace) }),
  },
  /**
   * The places main can offer without a native dialog: recent roots, and on
   * Windows the home directories of each WSL distribution. Every entry carries
   * an id main minted for this process; the renderer names one of those ids in
   * `reopen_recent_workspace`, `choose_workspace` or `create_workspace`, so it
   * still never supplies a host path.
   */
  list_workspace_locations: {
    params: Type.Object({}),
    result: Type.Object({
      recent: Type.Array(WorkspaceLocation),
      wsl: Type.Array(WorkspaceLocation),
      /** Where a new workspace may be created: the WSL homes plus the directories the recent roots live in. */
      parents: Type.Array(WorkspaceLocation),
    }),
  },
  /**
   * Reopens a recent root without accepting a path from the renderer. Without
   * an id the most recent one. Main owns both lookup and dispatch so this
   * convenience does not widen the renderer's filesystem authority.
   */
  reopen_recent_workspace: {
    params: Type.Object({ id: Type.Optional(WorkspaceLocationId) }),
    result: Type.Object({ workspace: Type.Optional(Workspace) }),
  },
  /**
   * Makes a new directory under a location main offered, optionally runs
   * `git init` in it, and opens it. Gesture-required: it writes to disk and
   * runs a program.
   */
  create_workspace: {
    params: Type.Object({
      parent: WorkspaceLocationId,
      /** One path segment. Main rejects separators and dot names. */
      name: Type.String({ minLength: 1, maxLength: 255 }),
      initializeGit: Type.Boolean(),
    }),
    result: Type.Object({ workspace: Workspace }),
  },
  /**
   * Host-internal half of `choose_workspace`. Main sends the path returned by
   * its native dialog; this command is deliberately absent from the preload.
   */
  open_workspace: {
    params: Type.Object({ root: AbsolutePath, runtime: WorkspaceRuntime }),
    result: Type.Object({ workspace: Workspace }),
  },
  close_workspace: { params: Type.Object({ id: WorkspaceId }), result: Type.Object({}) },
  get_project_trust: { params: Type.Object({ id: WorkspaceId }), result: Type.Object({ trust: TrustLevel }) },
  /**
   * Granting trust loads project-supplied executable code. The renderer may
   * only send this from an explicit user gesture — the trust screen, or the
   * permission chooser on the prompt bar; the host re-reads the workspace and
   * returns the state it committed.
   */
  set_project_trust: {
    params: Type.Object({ id: WorkspaceId, trust: TrustLevel }),
    result: Type.Object({ workspace: Workspace }),
  },
  /**
   * The level a workspace opens at when nobody has chosen one for it.
   *
   * A fallback, never an override: a workspace the person has set keeps its own
   * level, because the alternative silently discards a decision they made in
   * front of the project it was about. Pi's own `defaultProjectTrust` is a
   * different setting for a different interface — it decides whether Pi's CLI
   * *asks* — while this one decides what Bake Pi opens at, and it is the only
   * one that can say `full`.
   */
  get_default_trust: {
    params: Type.Object({}),
    result: Type.Object({ trust: TrustLevel }),
  },
  /**
   * Gesture-required for the same reason `set_project_trust` is, and more so:
   * this one grants a level to every project that has not been decided yet, so
   * it must never originate from a timer, a re-render, or a stream handler.
   */
  set_default_trust: {
    params: Type.Object({ trust: TrustLevel }),
    result: Type.Object({ trust: TrustLevel }),
  },
  /**
   * One directory of the open workspace, for the file rail.
   *
   * `path` is omitted for the root and is otherwise a path a previous listing
   * returned. The host canonicalizes it and re-checks containment before
   * reading anything — the same check the approval policy makes, for the same
   * reason: a junction or a symlink under the root resolves somewhere else, and
   * a string comparison would not notice.
   *
   * Reading a directory is not gesture-required. It discloses names the user
   * already opened a workspace to see, grants nothing, loads no code, and is
   * issued while a tree node expands rather than from a click the renderer
   * could prove.
   */
  list_directory: {
    params: Type.Object({ id: WorkspaceId, path: Type.Optional(AbsolutePath) }),
    result: Type.Object({
      /** The canonical directory that was read, which is not always the one asked for. */
      path: AbsolutePath,
      entries: Type.Array(DirectoryEntry, { maxItems: MAX_DIRECTORY_ENTRIES }),
      /** True when the directory holds more than the cap. The rail says so. */
      truncated: Type.Boolean(),
    }),
  },
})
