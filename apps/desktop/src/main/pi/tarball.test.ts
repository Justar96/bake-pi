import { describe, expect, test } from "bun:test"
import { gzipSync } from "node:zlib"
import { readNpmTarball } from "./tarball.ts"

/**
 * Builds tar archives the way a hostile one would be built.
 *
 * The reader's whole justification is that it refuses entries npm never
 * publishes, and that claim is only worth something if something tries them.
 * A fixture file could not: the archives below cannot be produced by `npm pack`,
 * which is precisely why they are the interesting ones.
 */
const BLOCK = 512

const header = (name: string, size: number, typeFlag: string, mode = 0o644): Uint8Array => {
  const block = new Uint8Array(BLOCK)
  const write = (text: string, at: number, length: number): void => {
    const bytes = new TextEncoder().encode(text.slice(0, length))
    block.set(bytes, at)
  }
  write(name, 0, 100)
  write(mode.toString(8).padStart(7, "0"), 100, 8)
  write("0".repeat(7), 108, 8)
  write("0".repeat(7), 116, 8)
  write(size.toString(8).padStart(11, "0"), 124, 12)
  write("0".repeat(11), 136, 12)
  write(typeFlag, 156, 1)
  write("ustar", 257, 6)
  write("00", 263, 2)

  // The checksum is computed with the field itself read as spaces, then written
  // back into it. Nothing here verifies it, but a header without one is not a
  // tar header and the reader should be fed real ones.
  block.fill(0x20, 148, 156)
  let sum = 0
  for (const byte of block) sum += byte
  write(sum.toString(8).padStart(6, "0"), 148, 8)
  block[154] = 0
  block[155] = 0x20
  return block
}

const archive = (entries: { name: string; body?: string; type?: string; mode?: number }[]): Uint8Array => {
  const parts: Uint8Array[] = []
  for (const entry of entries) {
    const body = new TextEncoder().encode(entry.body ?? "")
    parts.push(header(entry.name, body.length, entry.type ?? "0", entry.mode))
    if (body.length > 0) {
      const padded = new Uint8Array(Math.ceil(body.length / BLOCK) * BLOCK)
      padded.set(body)
      parts.push(padded)
    }
  }
  parts.push(new Uint8Array(BLOCK * 2))
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return gzipSync(out)
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

describe("unpacking an npm tarball", () => {
  test("returns files with the publisher's root component removed", () => {
    const entries = readNpmTarball(archive([
      { name: "package/package.json", body: '{"name":"x"}' },
      { name: "package/dist/index.js", body: "export const x = 1" },
    ]))

    expect(entries.map((entry) => entry.path)).toEqual(["package.json", "dist/index.js"])
    expect(text(entries[0]!.contents)).toBe('{"name":"x"}')
  })

  test("keeps the executable bit and nothing else about permissions", () => {
    const entries = readNpmTarball(archive([
      { name: "package/bin/cli.js", body: "#!/usr/bin/env node", mode: 0o755 },
      { name: "package/README.md", body: "hello", mode: 0o644 },
    ]))

    expect((entries[0]!.mode & 0o111) !== 0).toBe(true)
    expect((entries[1]!.mode & 0o111) !== 0).toBe(false)
  })

  test("skips directory entries, which the caller creates from the file paths", () => {
    const entries = readNpmTarball(archive([
      { name: "package/dist/", type: "5" },
      { name: "package/dist/index.js", body: "1" },
    ]))

    expect(entries.map((entry) => entry.path)).toEqual(["dist/index.js"])
  })

  /**
   * A pax record is `<length> <key>=<value>\n`, and the length counts itself —
   * so it is solved for rather than computed, by growing the prefix until it
   * stops changing. Two iterations is always enough; the loop is there so the
   * fixture cannot be subtly wrong for a path of some other length.
   */
  const paxRecord = (key: string, value: string): string => {
    const body = `${key}=${value}\n`
    let length = body.length + 2
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = body.length + String(length).length + 1
      if (candidate === length) break
      length = candidate
    }
    return `${String(length)} ${body}`
  }

  test("reads a long path out of its pax header rather than truncating it", () => {
    const long = `package/dist/${"nested/".repeat(20)}deep.js`
    expect(long.length).toBeGreaterThan(100)

    const entries = readNpmTarball(archive([
      { name: "package/dist/truncated", body: paxRecord("path", long), type: "x" },
      { name: "package/dist/truncated", body: "deep" },
    ]))

    expect(entries.map((entry) => entry.path)).toEqual([long.slice("package/".length)])
  })

  test("refuses a symlink, which no npm package contains and every escape needs", () => {
    expect(() => readNpmTarball(archive([{ name: "package/link", type: "2" }])))
      .toThrow(/refusing entry type 2/)
  })

  test("refuses a path that climbs out of its destination", () => {
    expect(() => readNpmTarball(archive([{ name: "package/../../evil.js", body: "1" }])))
      .toThrow(/escapes its destination/)
  })

  test("refuses an absolute path, in both spellings Windows accepts", () => {
    expect(() => readNpmTarball(archive([{ name: "/etc/profile", body: "1" }])))
      .toThrow(/refusing absolute path/)
    expect(() => readNpmTarball(archive([{ name: "C:/Windows/system32/evil.dll", body: "1" }])))
      .toThrow(/refusing absolute path/)
  })
})
