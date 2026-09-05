import { BakePiError } from "@bake-pi/contract"
import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"
import { MANAGED_NODE_ROOT, parseNodeProbe, type WslNode } from "./wsl-node.ts"
import { runWsl, streamWsl } from "./wsl-process.ts"

/**
 * The last resort when a distribution genuinely has no Node: bring one.
 *
 * This is the part of VS Code's remote model we were missing. VS Code never
 * asks whether the distribution can run its server — it extracts its own Linux
 * Node under `~/.vscode-server` and runs on that, which is why "install Node
 * first" is not a step anybody performs. `wsl-node.ts` still looks for the
 * person's own Node and still prefers it; this module only answers the case
 * where there is nothing to find.
 *
 * Three decisions are worth stating.
 *
 * The version and its hash are **pinned in this file**, not discovered. A build
 * that fetched `SHASUMS256.txt` at runtime would be trusting the same
 * connection twice and would have nothing to compare against; pinning means the
 * bytes that reach the distribution are the bytes this repository named, and a
 * change to either is a reviewable diff.
 *
 * The download happens **on the Windows side** and is piped into the
 * distribution over stdin. Doing it in Linux would require `curl` or `wget` to
 * exist there, would put a second network stack behind a corporate proxy, and
 * would verify the hash on the far side of the boundary. Piping also means the
 * distribution needs no writable Windows mount, so it works where `automount`
 * is off.
 *
 * The archive is **gzip, not xz**, though xz is a third smaller. `gzip` is in
 * every base image; `xz-utils` is not, and a missing decompressor would fail
 * this fallback exactly on the minimal distributions it exists to rescue.
 */

/**
 * The Node that Electron embeds, so a WSL host and a Windows host run the same
 * runtime. It has to move when Electron's does — `@types/node` being ahead of
 * the runtime is already a stated hazard in this repo, and two different
 * runtimes behind one contract would be a second.
 */
export const MANAGED_NODE_VERSION = "24.18.1"

/**
 * From `https://nodejs.org/dist/v24.18.1/SHASUMS256.txt`. Exported so a test can
 * hold the pins to their shape: a version-consistent nodejs.org URL and a full
 * SHA-256, which is what a hand-edited table gets wrong.
 */
export const MANAGED_NODE_DOWNLOADS = {
  x64: {
    url: `https://nodejs.org/dist/v${MANAGED_NODE_VERSION}/node-v${MANAGED_NODE_VERSION}-linux-x64.tar.gz`,
    sha256: "9f5eb6ac21845a66c493c91a253b1da32fd684e89e9b7202d4936982336be4ca",
    bytes: 57_254_099,
  },
  arm64: {
    url: `https://nodejs.org/dist/v${MANAGED_NODE_VERSION}/node-v${MANAGED_NODE_VERSION}-linux-arm64.tar.gz`,
    sha256: "df224555a083b918e46260cc969838501b9f9a87140c1195e5b9597b56d5dae2",
    bytes: 56_968_528,
  },
} as const

export type ManagedNodeArch = keyof typeof MANAGED_NODE_DOWNLOADS

const DOWNLOAD_TIMEOUT_MS = 300_000
const EXTRACT_TIMEOUT_MS = 300_000

/**
 * Unpacks the archive into a version directory, proves the binary runs before
 * anything points at it, and only then moves `current`.
 *
 * Every step is atomic against a second Bake Pi doing the same thing: the
 * extraction happens in a process-private temporary directory and the symlink
 * is replaced by `mv`, which is atomic on the same filesystem. A half-written
 * tree is therefore never reachable through `current`, which is the only name
 * the probe knows.
 *
 * Older managed versions are removed once the new one works. Nothing else will
 * ever collect them, and a fallback that quietly accumulates 200 MB per Electron
 * upgrade would be a worse problem than the one it solves.
 */
const EXTRACT = [
  "set -eu",
  "umask 077",
  "version=$1",
  "arch=$2",
  `root="${MANAGED_NODE_ROOT}"`,
  'target="$root/$version-$arch"',
  'mkdir -p "$root"',
  'tmp="$root/.tmp.$$"',
  'rm -rf "$tmp"',
  'mkdir -p "$tmp"',
  "trap 'rm -rf \"$tmp\"' EXIT",
  'tar -xzf - -C "$tmp" --strip-components=1',
  'test -x "$tmp/bin/node"',
  '"$tmp/bin/node" -v >/dev/null',
  'rm -rf "$target"',
  'mv "$tmp" "$target"',
  "trap - EXIT",
  'ln -sfn "$target" "$root/.current.$$"',
  // `mv -T` is GNU coreutils and is the atomic replacement; busybox has no
  // `-T` and would move the new link *into* the directory the old one points
  // at, so that case unlinks first and accepts the millisecond of absence.
  'mv -T "$root/.current.$$" "$root/current" 2>/dev/null || { rm -rf "$root/current"; mv "$root/.current.$$" "$root/current"; }',
  'for stale in "$root"/*; do',
  '  case "$stale" in "$target" | "$root/current") continue ;; esac',
  '  [ -e "$stale" ] || continue',
  '  rm -rf "$stale"',
  "done",
  '"$target/bin/node" -v',
  'printf "%s\\n" "$target/bin/node"',
].join("\n")

export interface InstallManagedNodeOptions {
  /**
   * Injected so main can hand in Electron's `net.fetch`, which follows the
   * system proxy, without this module importing `electron` — `bun run
   * wsl-smoke` drives the launcher outside Electron. Narrower than
   * `globalThis.fetch` on purpose: only a string URL is ever passed, and
   * `net.fetch` does not accept a `URL`.
   */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  /** Fraction of the download completed, 0 to 1. Extraction is not reported. */
  onProgress?: (fraction: number) => void
}

export const parseWslArch = (output: string): ManagedNodeArch | undefined => {
  switch (output.trim()) {
    case "x86_64":
    case "amd64":
      return "x64"
    case "aarch64":
    case "arm64":
      return "arm64"
    default:
      return undefined
  }
}

/** What the offer should say before anyone agrees to it. */
export const managedNodeSummary = (): string =>
  `Node ${MANAGED_NODE_VERSION} (about ${String(Math.round(MANAGED_NODE_DOWNLOADS.x64.bytes / 1_000_000))} MB)`

export const installManagedNode = async (
  distro: string,
  options: InstallManagedNodeOptions = {},
): Promise<WslNode> => {
  const arch = await detectArch(distro)
  const download = MANAGED_NODE_DOWNLOADS[arch]
  const scratch = await mkdtemp(join(tmpdir(), "bakepi-node-"))
  const archive = join(scratch, "node.tar.gz")

  try {
    await fetchVerified(archive, download, options)
    const extracted = await streamWsl(
      distro,
      ["sh", "-c", EXTRACT, "sh", MANAGED_NODE_VERSION, arch],
      createReadStream(archive),
      EXTRACT_TIMEOUT_MS,
    )
    if (extracted.code !== 0) {
      throw new BakePiError("host_unavailable", {
        detail: "managed_node_extract_failed",
        retryable: true,
        cause: new Error(extracted.stderr.trim() || `tar exited ${String(extracted.code)}`),
      })
    }
    // The script prints Node's own version and then the path it installed, which
    // is exactly the two-line shape the probe already knows how to read.
    const node = parseNodeProbe(extracted.stdout)
    if (node === undefined) {
      throw new BakePiError("host_unavailable", { detail: "managed_node_extract_failed", retryable: true })
    }
    return node
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}

const detectArch = async (distro: string): Promise<ManagedNodeArch> => {
  const result = await runWsl(distro, ["sh", "-c", "uname -m"], undefined, 10_000).catch(() => undefined)
  const arch = result?.code === 0 ? parseWslArch(result.stdout) : undefined
  if (arch === undefined) {
    throw new BakePiError("host_unavailable", { detail: "managed_node_unsupported_arch", retryable: false })
  }
  return arch
}

/**
 * Downloads to a file and hashes it, and lets nothing past that fails either
 * check. The length is checked as well as the digest, not because it adds
 * strength — it does not — but because it fails a truncated transfer in the
 * first megabyte instead of after the whole download.
 */
const fetchVerified = async (
  path: string,
  download: { url: string; sha256: string; bytes: number },
  options: InstallManagedNodeOptions,
): Promise<void> => {
  const request = options.fetch ?? globalThis.fetch
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const response = await request(download.url, { signal: abort.signal })
    if (!response.ok || response.body === null) {
      throw new BakePiError("host_unavailable", {
        detail: "managed_node_download_failed",
        retryable: true,
        cause: new Error(`${download.url} answered ${String(response.status)}`),
      })
    }

    const digest = createHash("sha256")
    let received = 0
    await pipeline(
      async function* () {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          received += chunk.byteLength
          // Refuse a body longer than the pin before it reaches the disk, so a
          // wrong or hostile answer costs one chunk rather than the whole link.
          if (received > download.bytes) throw new Error("download exceeded its declared length")
          digest.update(chunk)
          options.onProgress?.(received / download.bytes)
          yield chunk
        }
      },
      createWriteStream(path),
    )

    if (received !== download.bytes) {
      throw new BakePiError("host_unavailable", { detail: "managed_node_truncated", retryable: true })
    }
    if (digest.digest("hex") !== download.sha256) {
      throw new BakePiError("host_unavailable", { detail: "managed_node_checksum_mismatch", retryable: false })
    }
  } catch (cause) {
    if (cause instanceof BakePiError) throw cause
    throw new BakePiError("host_unavailable", { detail: "managed_node_download_failed", retryable: true, cause })
  } finally {
    clearTimeout(timer)
  }
}
