import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Where managed copies of Pi live on disk, and which one is in use.
 *
 * One directory per version, never written in place. An install is built in
 * `staging` and renamed into `versions/<version>` as its last act, so a
 * directory under `versions` is either absent or complete — there is no state
 * in which the host can find a half-unpacked Pi and try to run it. A power cut
 * in the middle leaves rubbish in `staging`, which the next install clears.
 *
 * The active version is a pointer rather than a copy or a symlink. A pointer
 * can be moved back to the bundled Pi in one write, without deleting anything,
 * which is what makes "go back to the version this app shipped with" a safe
 * button rather than a reinstall. Symlinks would need elevation on Windows.
 */

export interface InstalledPi {
  readonly version: string
  readonly installedAt: string
  readonly packages: number
}

/** Written last inside a version directory; its presence is not the completeness signal. */
const RECEIPT = "bake-pi-install.json"

export class PiStore {
  readonly #root: string

  /** `root` is a directory this application owns, conventionally under `userData`. */
  constructor(root: string) {
    this.#root = root
  }

  get versionsDir(): string {
    return join(this.#root, "versions")
  }

  get stagingDir(): string {
    return join(this.#root, "staging")
  }

  /** The directory a host would set `BAKE_PI_PI_ROOT` to for this version. */
  rootFor(version: string): string {
    return join(this.versionsDir, version)
  }

  /**
   * Every complete install, newest first by install time.
   *
   * A directory without a readable receipt is reported anyway, with what can be
   * seen. It got there by being renamed into place, so its contents are whole;
   * only the description of them is missing, and hiding a usable Pi because a
   * small JSON file could not be parsed would be the worse failure.
   */
  list(): InstalledPi[] {
    if (!existsSync(this.versionsDir)) return []
    const installed: InstalledPi[] = []
    for (const version of readdirSync(this.versionsDir)) {
      const directory = join(this.versionsDir, version)
      if (!existsSync(join(directory, "node_modules"))) continue
      let installedAt = ""
      let packages = 0
      try {
        const receipt = JSON.parse(readFileSync(join(directory, RECEIPT), "utf8")) as { installedAt?: unknown; packages?: unknown }
        if (typeof receipt.installedAt === "string") installedAt = receipt.installedAt
        if (typeof receipt.packages === "number") packages = receipt.packages
      } catch {
        // Described below by what is on disk instead.
      }
      installed.push({ version, installedAt, packages })
    }
    return installed.sort((left, right) => right.installedAt.localeCompare(left.installedAt))
  }

  /**
   * The version the host should run, or nothing for the bundled copy.
   *
   * A pointer at a version that is no longer on disk answers `undefined` rather
   * than throwing. That happens whenever someone clears application data by
   * hand, and the right response to it is the copy inside the asar — which is
   * always present and always works — not a host that refuses to start.
   */
  active(): string | undefined {
    const pointer = join(this.#root, "active.json")
    if (!existsSync(pointer)) return undefined
    try {
      const parsed = JSON.parse(readFileSync(pointer, "utf8")) as { version?: unknown }
      if (typeof parsed.version !== "string") return undefined
      return existsSync(join(this.rootFor(parsed.version), "node_modules")) ? parsed.version : undefined
    } catch {
      return undefined
    }
  }

  /** Points at an installed version, or at the bundled Pi when given nothing. */
  activate(version: string | undefined): void {
    const pointer = join(this.#root, "active.json")
    if (version === undefined) {
      rmSync(pointer, { force: true })
      return
    }
    if (!existsSync(join(this.rootFor(version), "node_modules"))) {
      throw new Error(`Pi ${version} is not installed`)
    }
    writeFileSync(pointer, `${JSON.stringify({ version }, null, 2)}\n`, "utf8")
  }

  /**
   * Deletes an installed version, refusing the one currently in use.
   *
   * Refusing rather than deactivating first: removing the Pi a running host has
   * open would leave that host reading files that no longer exist, and the
   * person asking almost certainly means to switch away and then remove, which
   * is two deliberate acts rather than one silent one.
   */
  remove(version: string): void {
    if (this.active() === version) throw new Error(`Pi ${version} is in use`)
    rmSync(this.rootFor(version), { recursive: true, force: true })
  }

  /** Moves a finished staging directory into place, replacing any earlier copy. */
  commit(staged: string, version: string, packages: number): void {
    writeFileSync(
      join(staged, RECEIPT),
      `${JSON.stringify({ version, installedAt: new Date().toISOString(), packages }, null, 2)}\n`,
      "utf8",
    )
    const destination = this.rootFor(version)
    // `rename` will not create the parent, and on a first install there is no
    // parent: nothing before this point has had a reason to make `versions`.
    mkdirSync(this.versionsDir, { recursive: true })
    /*
      The old directory is moved aside and deleted afterwards, not deleted
      first. On Windows a file inside it may still be open — a running host has
      Pi's own modules mapped — and `rm` would fail partway, leaving neither the
      old install nor the new one. A rename of the whole directory succeeds
      while its contents are open, and the leftovers are cleared on the next
      install if they cannot be cleared now.
    */
    if (existsSync(destination)) {
      const aside = `${destination}.old-${String(Date.now())}`
      renameSync(destination, aside)
      rmSync(aside, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
    renameSync(staged, destination)
  }

  /** Clears staging and any directory a previous commit could not delete. */
  sweep(): void {
    rmSync(this.stagingDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    if (!existsSync(this.versionsDir)) return
    for (const entry of readdirSync(this.versionsDir)) {
      if (!entry.includes(".old-")) continue
      rmSync(join(this.versionsDir, entry), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    }
  }
}
