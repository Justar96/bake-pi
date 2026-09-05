import { createHash } from "node:crypto"

/**
 * What upstream Pi publishes, and how Bake Pi reads it.
 *
 * The feed is Pi's own GitHub releases, because that is where upstream states
 * what a release *is*: the tag, the notes, and — the part that makes an
 * installer possible at all — `pi-coding-agent-install-package.json` and its
 * lockfile, which upstream generates for its own installer and updater. Using
 * them means the tree Bake Pi builds is the tree upstream tested, resolved by
 * upstream's npm rather than by a resolver written here, complete with the
 * `overrides` that pin the two packages upstream had to pin.
 *
 * The payloads then come from the registry tarballs that lockfile names. That
 * is not a detour around GitHub: every `resolved` URL in upstream's own
 * lockfile points at registry.npmjs.org, so this is upstream's install path,
 * followed exactly. The platform archives on the release page cannot serve
 * instead — `pi-windows-x64.zip` and its siblings hold a compiled `pi.exe`, a
 * command-line program, and Bake Pi's agent host needs Pi as an importable
 * library with an `exports` map.
 *
 * Everything downloaded is checked. The two manifests are checked against the
 * release's `SHA256SUMS`; each package tarball is checked against the
 * `integrity` its lockfile entry carries, and against the registry's own
 * `dist.integrity` for the handful of entries published without one.
 */

const RELEASES = "https://api.github.com/repos/earendil-works/pi/releases"
const DOWNLOADS = "https://github.com/earendil-works/pi/releases/download"
const REGISTRY = "https://registry.npmjs.org"
const MANIFEST_ASSET = "pi-coding-agent-install-package.json"
const LOCK_ASSET = "pi-coding-agent-install-package-lock.json"
const SUMS_ASSET = "SHA256SUMS"
const FEED_TIMEOUT_MS = 15_000
const DOWNLOAD_TIMEOUT_MS = 120_000

export interface PiRelease {
  readonly version: string
  readonly url: string
  readonly publishedAt: string
}

export interface PiPackage {
  /** Destination relative to the install root, exactly as the lockfile keys it. */
  readonly path: string
  readonly name: string
  readonly version: string
  readonly tarball: string
  /** Subresource integrity, when upstream's lockfile or the registry states one. */
  readonly integrity: string | undefined
  readonly optional: boolean
}

export interface PiInstallPlan {
  readonly version: string
  readonly packages: readonly PiPackage[]
  /** The Node range upstream declares, checked against Electron's before installing. */
  readonly nodeRange: string | undefined
}

/**
 * Attempts per request, including the first, with a second between the first
 * two and a doubling after that.
 *
 * Five rather than three because the failure this absorbs is not evenly
 * distributed: the resets observed while building this all landed on the two
 * largest tarballs in the closure, and one run exhausted four attempts on the
 * same file. A large download racing seven siblings against one CDN is simply
 * more likely to be cut, and the cost of an extra attempt is a few seconds
 * against discarding a hundred and thirty finished packages.
 */
const ATTEMPTS = 5
const BACKOFF_MS = 1_000

const retryable = (status: number): boolean => status === 408 || status === 429 || status >= 500

/**
 * One HTTP request read to completion, retried on the failures that mean
 * "try again".
 *
 * Not defensive padding: an install is a hundred and thirty consecutive
 * downloads, several of them tens of megabytes, and a connection reset partway
 * through one of them is ordinary rather than exceptional — two separate runs
 * of this code died on `ECONNRESET`, on two different packages. Without a retry
 * one reset discards the whole install, including the hundred packages already
 * unpacked.
 *
 * The body is read *inside* the retry, and that placement is the entire point.
 * A version that retried only `fetch` looked correct and helped with nothing:
 * both observed resets arrived while draining the response, long after the
 * status line had made the request a success.
 *
 * A 404 is not retried. A release asset that is absent will still be absent in
 * two seconds, and saying so at once is true about the version that was asked
 * for.
 *
 * Written as a declaration rather than the generic arrow the rest of this
 * project prefers. The import-boundary test scans every source file with Bun's
 * `tsx` loader, and under that loader an unconstrained `<T>` opens a JSX element
 * instead of a type parameter list: the file fails to parse and is silently
 * never checked against the boundary rules it exists inside.
 */
async function request<T>(url: string, timeout: number, accept: string, read: (response: Response) => Promise<T>): Promise<T> {
  let last: unknown
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept,
          // GitHub rate-limits anonymous requests by agent as well as by
          // address, and an unnamed client is the first thing it throttles.
          "user-agent": "bake-pi",
        },
        signal: AbortSignal.timeout(timeout),
      })
      if (!response.ok) {
        const failure = new Error(`${url} answered ${String(response.status)}`)
        if (!retryable(response.status) || attempt === ATTEMPTS) throw failure
        last = failure
      } else {
        return await read(response)
      }
    } catch (error) {
      if (attempt === ATTEMPTS) throw error
      last = error
    }
    await new Promise((resume) => setTimeout(resume, BACKOFF_MS * 2 ** (attempt - 1)))
  }
  throw last instanceof Error ? last : new Error(`${url} could not be fetched`)
}

const asBytes = async (response: Response): Promise<Uint8Array> => new Uint8Array(await response.arrayBuffer())
const asText = async (response: Response): Promise<string> => await response.text()
const asJson = async (response: Response): Promise<unknown> => await response.json()

const versionOf = (tag: string): string => (tag.startsWith("v") ? tag.slice(1) : tag)

/**
 * The releases upstream has published, newest first.
 *
 * Prereleases are dropped. Bake Pi installs Pi underneath an application that
 * already ships a tested Pi, and offering someone a prerelease of the engine
 * their work runs on is a different feature carrying different warnings.
 */
export const listPiReleases = async (limit = 10): Promise<PiRelease[]> => {
  const perPage = String(Math.min(limit * 3, 100))
  const releases = await request(`${RELEASES}?per_page=${perPage}`, FEED_TIMEOUT_MS, "application/vnd.github+json", asJson) as {
    tag_name?: unknown
    prerelease?: unknown
    draft?: unknown
    html_url?: unknown
    published_at?: unknown
  }[]

  const usable: PiRelease[] = []
  for (const release of releases) {
    if (release.prerelease === true || release.draft === true) continue
    if (typeof release.tag_name !== "string") continue
    usable.push({
      version: versionOf(release.tag_name),
      url: typeof release.html_url === "string" ? release.html_url : "",
      publishedAt: typeof release.published_at === "string" ? release.published_at : "",
    })
    if (usable.length === limit) break
  }
  return usable
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

/** `sha512-<base64>`, the form npm writes and the only one this verifies. */
const matchesIntegrity = (bytes: Uint8Array, integrity: string): boolean => {
  const separator = integrity.indexOf("-")
  if (separator === -1) return false
  const algorithm = integrity.slice(0, separator)
  const expected = integrity.slice(separator + 1)
  if (algorithm !== "sha512" && algorithm !== "sha256") return false
  return createHash(algorithm).update(bytes).digest("base64") === expected
}

/**
 * Refuses anything that is not exactly what was expected.
 *
 * An absent integrity is a failure rather than a skip. Every path that reaches
 * this has already had the chance to fill the value in from the registry, so a
 * gap here means the check could not be made — and "could not verify" and
 * "verified" must not take the same branch in code that unpacks a download.
 */
export const verifyIntegrity = (bytes: Uint8Array, integrity: string | undefined, what: string): void => {
  if (integrity === undefined) throw new Error(`${what} has no integrity to check against`)
  if (!matchesIntegrity(bytes, integrity)) throw new Error(`${what} did not match ${integrity}`)
}

interface LockEntry {
  version?: unknown
  resolved?: unknown
  integrity?: unknown
  optional?: unknown
  os?: unknown
  cpu?: unknown
  dev?: unknown
}

/** `node_modules/a/node_modules/@scope/b` names the package `@scope/b`. */
const packageNameOf = (path: string): string => {
  const marker = "node_modules/"
  const at = path.lastIndexOf(marker)
  return at === -1 ? path : path.slice(at + marker.length)
}

const runsHere = (entry: LockEntry): boolean => {
  const platforms = Array.isArray(entry.os) ? entry.os as string[] : undefined
  const architectures = Array.isArray(entry.cpu) ? entry.cpu as string[] : undefined
  if (platforms !== undefined && !platforms.includes(process.platform)) return false
  if (architectures !== undefined && !architectures.includes(process.arch)) return false
  return true
}

/**
 * Asks the registry for a version's tarball and integrity.
 *
 * Needed twice over. Upstream's lockfile omits `integrity` on its own six
 * `@earendil-works/*` entries, and `@earendil-works/pi-server` is not in that
 * lockfile at all — Pi's server entry point imports it but declares it nowhere,
 * so it is Bake Pi's agent host that names it as a dependency. Both gaps are
 * closed from the registry's own metadata rather than by trusting a download.
 */
const registryDist = async (name: string, version: string): Promise<{ tarball: string; integrity: string | undefined }> => {
  const manifest = await request(`${REGISTRY}/${name}/${version}`, FEED_TIMEOUT_MS, "application/json", asJson) as { dist?: { tarball?: unknown; integrity?: unknown } }
  const tarball = manifest.dist?.tarball
  if (typeof tarball !== "string") throw new Error(`${name}@${version} has no tarball on the registry`)
  const integrity = manifest.dist?.integrity
  return { tarball, integrity: typeof integrity === "string" ? integrity : undefined }
}

const parseSemver = (version: string): [number, number, number] | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())
  if (match === null) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

const compare = (left: [number, number, number], right: [number, number, number]): number => {
  // Destructured rather than indexed: a tuple index still reads as possibly
  // undefined under `noUncheckedIndexedAccess`, and the alternative is three
  // non-null assertions on values the type already guarantees.
  const [leftMajor, leftMinor, leftPatch] = left
  const [rightMajor, rightMinor, rightPatch] = right
  if (leftMajor !== rightMajor) return Math.sign(leftMajor - rightMajor)
  if (leftMinor !== rightMinor) return Math.sign(leftMinor - rightMinor)
  return Math.sign(leftPatch - rightPatch)
}

/**
 * Whether a released version satisfies a dependency range.
 *
 * Four range forms, and a refusal for everything else. This is not a semver
 * implementation and must not grow into one: it exists to close a gap of a
 * handful of packages, all published by one project on one schedule, and every
 * range it has ever had to read is an exact pin or a caret. A union range or a
 * prerelease tag throws by falling through, which surfaces as a named install
 * failure — far better than a quietly wrong version resolved by a matcher
 * nobody has tested against npm's.
 */
export const satisfies = (version: string, range: string): boolean => {
  const candidate = parseSemver(version)
  if (candidate === undefined) return false
  const trimmed = range.trim()
  if (trimmed === "" || trimmed === "*" || trimmed === "latest") return true

  const operator = /^(\^|~|>=)?\s*(.+)$/.exec(trimmed)
  const floor = operator === null ? undefined : parseSemver(operator[2] ?? "")
  if (operator === null || floor === undefined) throw new Error(`unsupported dependency range ${range}`)
  if (compare(candidate, floor) < 0) return false

  switch (operator[1]) {
    case undefined:
      return compare(candidate, floor) === 0
    case ">=":
      return true
    case "~":
      return candidate[0] === floor[0] && candidate[1] === floor[1]
    default:
      // Caret, with npm's rule for a zero major: `^0.85.1` allows 0.85.x and
      // not 0.86.0, which is exactly the rule Pi's own versions rely on.
      return floor[0] === 0 ? candidate[0] === 0 && candidate[1] === floor[1] : candidate[0] === floor[0]
  }
}

/** The highest released version satisfying a range, ignoring prereleases. */
const resolveVersion = async (name: string, range: string): Promise<string> => {
  const packument = await request(`${REGISTRY}/${name}`, FEED_TIMEOUT_MS, "application/vnd.npm.install-v1+json", asJson) as { versions?: Record<string, unknown> }
  let best: [number, number, number] | undefined
  let chosen: string | undefined
  for (const candidate of Object.keys(packument.versions ?? {})) {
    const parsed = parseSemver(candidate)
    if (parsed === undefined || !satisfies(candidate, range)) continue
    if (best !== undefined && compare(parsed, best) <= 0) continue
    best = parsed
    chosen = candidate
  }
  if (chosen === undefined) throw new Error(`no released ${name} satisfies ${range}`)
  return chosen
}

/**
 * Adds the packages a seed depends on that upstream's lockfile does not carry.
 *
 * Needed because that lockfile is the closure of `pi-coding-agent` alone, and
 * `pi-coding-agent` ships an `npm-shrinkwrap.json` that prunes what its own
 * bundled `dist` no longer needs. `@earendil-works/pi-server` sits outside both:
 * Pi's server entry point imports it, nothing declares it, and it in turn wants
 * `@earendil-works/pi-protocol`, which is in neither the lockfile nor the tree.
 * The first install that skipped this step produced a Pi that loaded and then
 * failed on the server import — the same class of failure as beta.1, one level
 * deeper.
 *
 * The walk is deliberately narrow: it starts only from packages this file added
 * itself, and stops the moment a dependency is already present at a satisfying
 * version. The hundred and thirty packages upstream locked are not revisited,
 * because npm already resolved them and second-guessing that is how a tree
 * stops being the tree upstream tested.
 */
const closeOverDependencies = async (packages: PiPackage[], seeds: readonly PiPackage[]): Promise<void> => {
  const present = new Map(packages.map((entry) => [entry.name, entry]))
  const queue = [...seeds]
  const seen = new Set(seeds.map((entry) => `${entry.name}@${entry.version}`))

  while (queue.length > 0) {
    const entry = queue.shift()
    if (entry === undefined) break
    const manifest = await request(`${REGISTRY}/${entry.name}/${entry.version}`, FEED_TIMEOUT_MS, "application/json", asJson) as { dependencies?: Record<string, string> }
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      const existing = present.get(name)
      if (existing !== undefined && satisfies(existing.version, range)) continue
      if (existing !== undefined) {
        /*
          A conflict rather than a gap: the tree already holds this package at a
          version the seed cannot use. Nesting a second copy under the seed is
          what npm would do, and doing it here without npm's understanding of
          when that is safe is how a duplicated module identity turns into an
          `instanceof` that quietly returns false. Refusing says so instead.
        */
        throw new Error(`${entry.name} needs ${name}@${range}, and the tree has ${existing.version}`)
      }
      const version = await resolveVersion(name, range)
      if (seen.has(`${name}@${version}`)) continue
      seen.add(`${name}@${version}`)
      const dist = await registryDist(name, version)
      const added: PiPackage = {
        path: `node_modules/${name}`,
        name,
        version,
        tarball: dist.tarball,
        integrity: dist.integrity,
        optional: false,
      }
      packages.push(added)
      present.set(name, added)
      queue.push(added)
    }
  }
}

/**
 * Turns one upstream release into the exact list of packages to unpack.
 *
 * No resolution happens here, and that is the whole reason for using upstream's
 * lockfile: every key in it is already a destination path, and every value
 * already names a version and a tarball. Nesting, hoisting and the two
 * `overrides` upstream applies were decisions npm made when that file was
 * written, and reading them back is the only way to install what upstream
 * installs without reimplementing npm inside an Electron main process.
 */
export const fetchInstallPlan = async (version: string): Promise<PiInstallPlan> => {
  const base = `${DOWNLOADS}/v${version}`
  const [sums, manifestBytes, lockBytes] = await Promise.all([
    request(`${base}/${SUMS_ASSET}`, FEED_TIMEOUT_MS, "text/plain", asText),
    request(`${base}/${MANIFEST_ASSET}`, FEED_TIMEOUT_MS, "application/json", asBytes),
    request(`${base}/${LOCK_ASSET}`, FEED_TIMEOUT_MS, "application/json", asBytes),
  ])

  const expected = new Map<string, string>()
  for (const line of sums.split("\n")) {
    const parts = line.trim().split(/\s+/)
    const digest = parts[0]
    const name = parts[1]
    if (digest !== undefined && name !== undefined) expected.set(name, digest)
  }
  for (const [name, bytes] of [[MANIFEST_ASSET, manifestBytes], [LOCK_ASSET, lockBytes]] as const) {
    const digest = expected.get(name)
    if (digest === undefined) throw new Error(`${SUMS_ASSET} for Pi ${version} does not cover ${name}`)
    if (sha256(bytes) !== digest) throw new Error(`${name} for Pi ${version} did not match ${SUMS_ASSET}`)
  }

  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as { engines?: { node?: unknown } }
  const lock = JSON.parse(new TextDecoder().decode(lockBytes)) as { packages?: Record<string, LockEntry> }
  const entries = Object.entries(lock.packages ?? {})
  if (entries.length === 0) throw new Error(`the lockfile for Pi ${version} lists no packages`)

  const packages: PiPackage[] = []
  const gaps: { at: number; name: string; version: string }[] = []
  for (const [path, entry] of entries) {
    // The root key describes the installer's own private manifest, which
    // describes the tree rather than living inside it.
    if (path === "") continue
    if (typeof entry.resolved !== "string" || typeof entry.version !== "string") continue
    if (entry.dev === true) continue
    if (!runsHere(entry)) continue
    const name = packageNameOf(path)
    const integrity = typeof entry.integrity === "string" ? entry.integrity : undefined
    if (integrity === undefined) gaps.push({ at: packages.length, name, version: entry.version })
    packages.push({ path, name, version: entry.version, tarball: entry.resolved, integrity, optional: entry.optional === true })
  }

  const filled = await Promise.all(gaps.map(async (gap) => await registryDist(gap.name, gap.version)))
  gaps.forEach((gap, index) => {
    const dist = filled[index]
    const current = packages[gap.at]
    if (dist === undefined || current === undefined) return
    packages[gap.at] = { ...current, integrity: dist.integrity }
  })

  /*
    Pi's `experimental/server` entry point imports `@earendil-works/pi-server`
    without declaring it, so upstream's lockfile has no reason to carry it and
    does not. Bake Pi's agent host is what depends on that entry point, so the
    agent host is what names the package — and an install that left it out would
    reproduce, precisely, the missing-package crash that shipped in beta.1.
  */
  if (!packages.some((entry) => entry.name === "@earendil-works/pi-server")) {
    const dist = await registryDist("@earendil-works/pi-server", version)
    const server: PiPackage = {
      path: "node_modules/@earendil-works/pi-server",
      name: "@earendil-works/pi-server",
      version,
      tarball: dist.tarball,
      integrity: dist.integrity,
      optional: false,
    }
    packages.push(server)
    await closeOverDependencies(packages, [server])
  }

  const nodeRange = manifest.engines?.node
  return { version, packages, nodeRange: typeof nodeRange === "string" ? nodeRange : undefined }
}

/** Downloads one package tarball and proves it is the one the plan named. */
export const fetchPackage = async (entry: PiPackage): Promise<Uint8Array> => {
  const bytes = await request(entry.tarball, DOWNLOAD_TIMEOUT_MS, "application/octet-stream", asBytes)
  verifyIntegrity(bytes, entry.integrity, `${entry.name}@${entry.version}`)
  return bytes
}
