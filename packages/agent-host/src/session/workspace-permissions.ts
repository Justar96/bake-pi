import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { TrustLevel } from "@bake-pi/contract"

/**
 * The permission level a person last chose for a workspace, and the level a
 * workspace they have never decided on opens at.
 *
 * This is the one piece of trust state Pi cannot hold for us. `ProjectTrustStore`
 * is a boolean and is shared with Pi's command line, which is exactly why it
 * stays authoritative here — a project trusted in the CLI is trusted in Bake Pi
 * and the reverse. What that boolean cannot say is the difference between
 * `trusted` and `full`, so the extra step is kept beside it rather than
 * forgotten at every restart. Pi's answer still wins where the two disagree:
 * `resolveWorkspaceTrust` can only ever spend a grant Pi already recorded, so
 * revoking trust from the CLI drops a remembered `full` back to restricted.
 *
 * It is a preference file, in the sense `RecentWorkspaceStore` is: a missing,
 * malformed, or unwritable one behaves as "nothing remembered" rather than as a
 * workspace that will not open. What it must never do is *widen* on failure,
 * which is why every recovery path in here lands on the declared default and
 * every unreadable level is dropped rather than guessed at.
 */

const VERSION = 1

/**
 * How many workspaces are remembered, oldest evicted first.
 *
 * A cap because this file is written from a machine's whole history of opened
 * projects and read on the path that opens one. Insertion order is the eviction
 * order: `remember` re-inserts a root so the ones a person actually returns to
 * stay, and `JSON.stringify` preserves that order for non-numeric keys.
 */
const MAX_REMEMBERED = 200

/** The safe end of the scale, and what an absent or unreadable file means. */
const FALLBACK: TrustLevel = "untrusted"

const TRUST_LEVELS: readonly TrustLevel[] = ["untrusted", "trusted", "full"]

const isTrustLevel = (value: unknown): value is TrustLevel =>
  typeof value === "string" && (TRUST_LEVELS as readonly string[]).includes(value)

interface StoredPermissions {
  version: typeof VERSION
  default: TrustLevel
  roots: Record<string, TrustLevel>
}

/**
 * Workspace roots reach this store already canonicalized, so the only
 * difference left between two spellings of one directory is case — and only
 * where the filesystem does not care about it. Judged by the platform the host
 * runs on, which is the platform whose paths these are: a WSL host is a Linux
 * process holding Linux paths, and its case sensitivity is its own.
 */
const key = (root: string): string => (process.platform === "win32" ? root.toLocaleLowerCase("en-US") : root)

export class WorkspacePermissionStore {
  readonly #path: string

  constructor(agentDir: string) {
    this.#path = join(agentDir, "bake-pi", "workspace-permissions.json")
  }

  /** The level a workspace with no recorded choice opens at. */
  defaultTrust(): TrustLevel {
    return this.#read().default
  }

  setDefaultTrust(trust: TrustLevel): void {
    const stored = this.#read()
    this.#write({ ...stored, default: trust })
  }

  /** What the person last chose for this root, or `undefined` if they never have. */
  remembered(root: string): TrustLevel | undefined {
    return this.#read().roots[key(root)]
  }

  remember(root: string, trust: TrustLevel): void {
    const stored = this.#read()
    const roots = { ...stored.roots }
    // Deleted before it is set, so a root that is chosen again moves to the end
    // of the insertion order rather than keeping the position it first got.
    delete roots[key(root)]
    roots[key(root)] = trust
    const entries = Object.entries(roots)
    this.#write({
      ...stored,
      roots: Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_REMEMBERED))),
    })
  }

  /**
   * Read on every call rather than cached, because two hosts can be running
   * against one agent directory — a Windows workspace and a WSL one — and the
   * one that writes last should not lose the other's entries. A read of a file
   * this size costs less than the mistake would.
   */
  #read(): StoredPermissions {
    try {
      const value = JSON.parse(readFileSync(this.#path, "utf8")) as Partial<StoredPermissions>
      if (value.version !== VERSION) return { version: VERSION, default: FALLBACK, roots: {} }
      const roots: Record<string, TrustLevel> = {}
      for (const [root, trust] of Object.entries(value.roots ?? {})) {
        if (isTrustLevel(trust)) roots[root] = trust
      }
      return {
        version: VERSION,
        default: isTrustLevel(value.default) ? value.default : FALLBACK,
        roots,
      }
    } catch {
      return { version: VERSION, default: FALLBACK, roots: {} }
    }
  }

  #write(value: StoredPermissions): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true })
      writeFileSync(this.#path, JSON.stringify(value), "utf8")
    } catch {
      // The decision itself already took effect in the open workspace. Failing
      // to remember it for next time is not worth failing the command over.
    }
  }
}

/**
 * What level a workspace opens at, given what Pi recorded and what this host
 * remembers.
 *
 * Two rules. Pi's boolean is a ceiling on what this file may restore: a root
 * remembered as `full` comes back restricted once the CLI revokes its trust,
 * so a revocation is honoured on the next open rather than papered over. And a
 * remembered choice beats the default, because the default is a fallback for
 * projects nobody has decided on — overriding a decision made in front of the
 * project it was about would discard the more informed of the two.
 *
 * The default is the one path that can widen a workspace neither store has an
 * answer for, and that is what the person asked it for: a level chosen once in
 * Settings, applied to every project they have not met yet. Its ceiling is the
 * setting itself, which is why it ships as `untrusted` and why writing it is
 * gesture-required.
 *
 * The one asymmetry worth stating: a workspace Pi already trusts opens at
 * `trusted` even when the default is `untrusted`. Pi's grant is a decision
 * someone made, and the default is a preference about projects they have not
 * met yet.
 */
export const resolveWorkspaceTrust = ({ piTrusted, remembered, fallback }: {
  piTrusted: boolean
  remembered: TrustLevel | undefined
  fallback: TrustLevel
}): TrustLevel => {
  if (remembered !== undefined) {
    if (remembered === "untrusted") return "untrusted"
    return piTrusted ? remembered : "untrusted"
  }
  return piTrusted ? "trusted" : fallback
}
