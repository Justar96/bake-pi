import nodeModule from "node:module"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

/**
 * Lets a Pi installed under `userData` win over the one inside the asar.
 *
 * Bake Pi ships one Pi in its archive and that copy can never change: the asar
 * is read-only and its integrity is validated at load. Upstream releases far
 * more often than this application does, so the settings panel used to name a
 * newer Pi and then offer nothing but "update Bake Pi too". A managed install
 * removes that: a second Pi on disk, built from what upstream publishes, that
 * the host prefers whenever it is present and complete.
 *
 * Preferring it is the whole difficulty. The host is a single ESM bundle with
 * Pi left external, so every `@earendil-works/*` import is a bare specifier
 * that Node resolves by walking up from the bundle into `app.asar/node_modules`.
 * That walk cannot be pointed elsewhere — `NODE_PATH` is CommonJS-only, moving
 * the bundle out of the asar would give up integrity validation, and turning
 * the nine importing files into dynamic imports would put an `await` in front
 * of every type Pi exports. Redirecting resolution costs none of that.
 */

/**
 * The parent Node should resolve Pi as if it were, or nothing.
 *
 * A directory only counts once its `node_modules` exists. A half-written
 * install — the directory created, the packages not yet in it — would otherwise
 * capture every Pi import and fail all of them, which is a worse outcome than
 * ignoring the managed copy entirely. The installer builds elsewhere and
 * renames into place for the same reason; this is the second guard.
 */
export const piAnchor = (root: string | undefined): string | undefined => {
  if (root === undefined || root === "") return undefined
  if (!existsSync(join(root, "node_modules"))) return undefined
  // A file that need not exist: Node only reads the parent to know which
  // directory to start walking up from.
  return pathToFileURL(join(root, "anchor.js")).href
}

/**
 * Installs the resolve hook, and reports the anchor it will resolve against.
 *
 * `registerHooks` rather than `register`: it is synchronous and runs in this
 * thread, so it takes effect on the very next resolution instead of after a
 * worker has started. `boot.ts` calls this before the host bundle is loaded at
 * all, which is the only moment at which it can matter.
 */
export const installPiResolution = (root: string | undefined): string | undefined => {
  const anchor = piAnchor(root)
  if (anchor === undefined) return undefined

  /*
    Read off the namespace and called, rather than imported by name. A named
    import binds at load, so a runtime without the hook cannot import this file
    at all — and one such runtime is Bun, which every test in this project runs
    under. The same shape took `log-file.ts` down once already, through an
    `import { app } from "electron"` in a module three test files could reach.
  */
  const registerHooks = nodeModule.registerHooks as typeof nodeModule.registerHooks | undefined
  if (registerHooks === undefined) {
    // Nothing is broken by this; the bundled Pi is a complete answer. Saying so
    // once beats a managed install that is on disk, selected, and silently not
    // in use.
    console.warn("[host] this runtime cannot redirect module resolution; using the bundled Pi")
    return undefined
  }

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!specifier.startsWith("@earendil-works/")) return nextResolve(specifier, context)
      /*
        Captured before the first call, and restored explicitly on the second.
        Node merges whatever context a hook passes to `nextResolve` into the
        chain's own, so the anchor set below survives into a retry: omitting
        `parentURL` from the fallback silently retried against the managed
        directory that had just failed, and every fallback was a second
        `ERR_MODULE_NOT_FOUND` rather than the bundled copy.
      */
      const parentURL = context.parentURL
      /*
        Re-anchored, not reimplemented. Handing Node a parent inside the managed
        directory keeps every rule that matters — the `exports` map, subpath
        conditions, the walk into nested `node_modules` — identical to what
        upstream tests against. Joining paths by hand would have to reproduce all
        of it and would diverge the first time Pi changed an export.
      */
      try {
        return nextResolve(specifier, { ...context, parentURL: anchor })
      } catch {
        /*
          The managed tree does not have this package. Falling through to the
          bundled copy is deliberate: an install that left one package out would
          otherwise take the host down, and the copy in the asar is a
          known-good answer that is always there. Skew between the two is
          something the runtime reports, not something this prevents.
        */
        return nextResolve(specifier, { ...context, parentURL })
      }
    },
  })
  return anchor
}
