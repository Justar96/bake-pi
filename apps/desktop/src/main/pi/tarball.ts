import { gunzipSync } from "node:zlib"

/**
 * Just enough tar to unpack an npm tarball.
 *
 * A dependency would have been the obvious answer, and it was rejected on the
 * shape of the problem rather than on principle. This code runs in the main
 * process, which bundles everything it imports, so a tar library becomes part
 * of the binary that unpacks *unverified downloads* — the one place in this
 * application where the input is chosen by whatever the network returned. npm
 * tarballs are also a far narrower format than tar: gzip, ustar, regular files
 * and directories under a single `package/` prefix. Two hundred lines that
 * accept exactly that and refuse everything else are easier to audit than a
 * general extractor, and they cannot be surprised by an entry type nobody in
 * this project has ever needed.
 *
 * Refused, deliberately and loudly: symlinks, hardlinks, devices, absolute
 * paths, and any path that climbs out of its destination. Those are the entries
 * a malicious tarball is built from, and none of them appear in a package
 * published by npm.
 */

const BLOCK = 512

export interface TarEntry {
  /** Path with the leading `package/` component removed. */
  readonly path: string
  readonly mode: number
  readonly contents: Uint8Array
}

/** A tar field is NUL-padded, and some writers pad with spaces instead. */
const text = (block: Uint8Array, offset: number, length: number): string => {
  const raw = block.subarray(offset, offset + length)
  let end = 0
  while (end < raw.length && raw[end] !== 0 && raw[end] !== 0x20) end += 1
  return new TextDecoder().decode(raw.subarray(0, end))
}

const octal = (block: Uint8Array, offset: number, length: number): number => {
  const value = text(block, offset, length)
  if (value === "") return 0
  const parsed = Number.parseInt(value, 8)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("tar: unreadable numeric field")
  return parsed
}

const isZeroBlock = (block: Uint8Array): boolean => block.every((byte) => byte === 0)

/**
 * Rejects a path before anything is written with it.
 *
 * Normalizing and then checking would be the usual shape, and it is the shape
 * that produces extraction bugs: the check has to agree with the platform's own
 * normalization, and on Windows it has to agree about backslashes, drive
 * letters and UNC prefixes too. Refusing the suspicious characters outright is
 * a rule with no such seam, and it costs nothing, because no package on npm
 * contains a path that needs them.
 */
const safeRelativePath = (raw: string): string => {
  const path = raw.replace(/\\/g, "/")
  if (path === "" || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new Error(`tar: refusing absolute path ${raw}`)
  }
  if (path.split("/").some((part) => part === "..")) {
    throw new Error(`tar: refusing path that escapes its destination ${raw}`)
  }
  return path
}

/**
 * Reads the pax record set that precedes an entry with an oversized field.
 *
 * Only `path` is honored. The other records — timestamps, ownership, the
 * extended attributes some build tools add — describe things this extractor
 * does not reproduce, and quietly ignoring them is the correct behavior for a
 * reader that only wants file contents.
 */
const paxPath = (contents: Uint8Array): string | undefined => {
  const records = new TextDecoder().decode(contents)
  for (const line of records.split("\n")) {
    const space = line.indexOf(" ")
    if (space === -1) continue
    const record = line.slice(space + 1)
    if (record.startsWith("path=")) return record.slice("path=".length)
  }
  return undefined
}

/**
 * Unpacks a gzipped npm tarball into entries, dropping the `package/` prefix.
 *
 * Synchronous and fully in memory, which is the right trade here: the largest
 * package in Pi's dependency closure is a few megabytes, a hundred and sixty
 * of them are unpacked concurrently in bounded batches, and a streaming reader
 * would add a state machine to code whose whole value is being small enough to
 * read in one sitting.
 */
export const readNpmTarball = (gzipped: Uint8Array): TarEntry[] => {
  const buffer = gunzipSync(gzipped)
  const entries: TarEntry[] = []
  let offset = 0
  let pendingPath: string | undefined

  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK)
    if (isZeroBlock(header)) break
    offset += BLOCK

    const size = octal(header, 124, 12)
    const typeFlag = String.fromCharCode(header[156] ?? 0).replace("\0", "0")
    const stored = Math.ceil(size / BLOCK) * BLOCK
    const body = buffer.subarray(offset, offset + size)
    offset += stored

    if (typeFlag === "x" || typeFlag === "X") {
      pendingPath = paxPath(body)
      continue
    }
    if (typeFlag === "g") continue
    if (typeFlag === "L") {
      pendingPath = new TextDecoder().decode(body).replace(/\0+$/, "")
      continue
    }
    if (typeFlag === "K") continue

    const prefix = text(header, 345, 155)
    const name = text(header, 0, 100)
    const raw = pendingPath ?? (prefix === "" ? name : `${prefix}/${name}`)
    pendingPath = undefined

    if (typeFlag === "5") continue
    if (typeFlag !== "0") {
      throw new Error(`tar: refusing entry type ${typeFlag} for ${raw}`)
    }

    const path = safeRelativePath(raw)
    // npm publishes every file under one root component, conventionally
    // `package`. Whatever it is called, it is dropped: the destination is the
    // package's own directory, chosen by the caller from the lockfile.
    const slash = path.indexOf("/")
    if (slash === -1) continue
    entries.push({ path: path.slice(slash + 1), mode: octal(header, 100, 8), contents: body })
  }

  return entries
}
