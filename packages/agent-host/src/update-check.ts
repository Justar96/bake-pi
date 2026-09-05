const LATEST_PI_URL = "https://registry.npmjs.org/@earendil-works/pi-coding-agent/latest"
const UPDATE_TIMEOUT_MS = 3_000

interface LatestVersionResponse {
  version?: unknown
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * Checks the package's public npm metadata without involving the renderer.
 *
 * This is deliberately best-effort status: offline mode, an explicit Pi skip,
 * a timeout, malformed JSON, and network failure all mean "show nothing". The
 * check must never delay the host handshake or turn absence of a network into a
 * connection failure.
 */
export const checkForPiUpdate = async (
  currentVersion: string,
  fetcher: Fetcher = fetch,
): Promise<string | undefined> => {
  if (process.env.PI_OFFLINE || process.env.PI_SKIP_VERSION_CHECK) return undefined

  try {
    const response = await fetcher(LATEST_PI_URL, {
      headers: {
        accept: "application/json",
        "user-agent": `Bake-Pi Pi/${currentVersion}`,
      },
      signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const data = (await response.json()) as LatestVersionResponse
    if (typeof data.version !== "string") return undefined
    const latest = data.version.trim()
    return compareVersions(latest, currentVersion) > 0 ? latest : undefined
  } catch {
    return undefined
  }
}

/** Returns zero when either value is not a semantic version. */
export const compareVersions = (left: string, right: string): number => {
  const parsedLeft = parseVersion(left)
  const parsedRight = parseVersion(right)
  if (parsedLeft === undefined || parsedRight === undefined) return 0

  for (let index = 0; index < 3; index += 1) {
    const difference = parsedLeft.core[index]! - parsedRight.core[index]!
    if (difference !== 0) return Math.sign(difference)
  }

  if (parsedLeft.prerelease.length === 0 || parsedRight.prerelease.length === 0) {
    return parsedLeft.prerelease.length === parsedRight.prerelease.length
      ? 0
      : parsedLeft.prerelease.length === 0
        ? 1
        : -1
  }

  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = parsedLeft.prerelease[index]
    const rightPart = parsedRight.prerelease[index]
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1
    if (leftPart === rightPart) continue
    const leftNumber = numericIdentifier(leftPart)
    const rightNumber = numericIdentifier(rightPart)
    if (leftNumber !== undefined && rightNumber !== undefined) return Math.sign(leftNumber - rightNumber)
    if (leftNumber !== undefined) return -1
    if (rightNumber !== undefined) return 1
    return leftPart.localeCompare(rightPart)
  }
  return 0
}

const parseVersion = (version: string): { core: readonly [number, number, number]; prerelease: readonly string[] } | undefined => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim())
  if (match === null) return undefined
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  }
}

const numericIdentifier = (value: string): number | undefined => /^\d+$/.test(value) ? Number(value) : undefined
