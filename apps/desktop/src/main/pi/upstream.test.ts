import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { satisfies, verifyIntegrity } from "./upstream.ts"

const bytes = new TextEncoder().encode("a package tarball")
const sha512 = `sha512-${createHash("sha512").update(bytes).digest("base64")}`

describe("matching a dependency range", () => {
  test("an exact pin matches only itself", () => {
    expect(satisfies("1.3.7", "1.3.7")).toBe(true)
    expect(satisfies("1.3.8", "1.3.7")).toBe(false)
    expect(satisfies("1.3.6", "1.3.7")).toBe(false)
  })

  test("a caret on a zero major is locked to its minor, which is what Pi relies on", () => {
    expect(satisfies("0.85.1", "^0.85.1")).toBe(true)
    expect(satisfies("0.85.9", "^0.85.1")).toBe(true)
    expect(satisfies("0.85.0", "^0.85.1")).toBe(false)
    expect(satisfies("0.86.0", "^0.85.1")).toBe(false)
  })

  test("a caret above zero allows the rest of the major", () => {
    expect(satisfies("7.9.0", "^7.6.5")).toBe(true)
    expect(satisfies("8.0.0", "^7.6.5")).toBe(false)
  })

  test("tilde and greater-or-equal behave as npm writes them", () => {
    expect(satisfies("4.1.9", "~4.1.2")).toBe(true)
    expect(satisfies("4.2.0", "~4.1.2")).toBe(false)
    expect(satisfies("9.0.0", ">=4.1.2")).toBe(true)
  })

  test("a range this does not understand throws instead of guessing", () => {
    // The install stops with the range named, which is a fixable report. A
    // matcher that shrugged and returned false would install a second copy of
    // a package under a nested path, and a duplicated module identity is the
    // kind of failure that shows up as an `instanceof` quietly returning false.
    expect(() => satisfies("1.0.0", "^1 || ^2")).toThrow(/unsupported dependency range/)
  })

  test("a prerelease is never a match, because nothing here asks for one", () => {
    expect(satisfies("0.86.0-rc.1", "^0.86.0")).toBe(false)
  })
})

describe("checking what was downloaded", () => {
  test("accepts the bytes the plan named", () => {
    expect(() => { verifyIntegrity(bytes, sha512, "a-package@1.0.0") }).not.toThrow()
  })

  test("refuses bytes that are not those bytes", () => {
    expect(() => { verifyIntegrity(new TextEncoder().encode("something else"), sha512, "a-package@1.0.0") })
      .toThrow(/did not match/)
  })

  test("refuses to treat an unknown integrity as a pass", () => {
    // "could not verify" and "verified" must not take the same branch in code
    // that then unpacks the result.
    expect(() => { verifyIntegrity(bytes, undefined, "a-package@1.0.0") }).toThrow(/no integrity/)
    expect(() => { verifyIntegrity(bytes, "md5-abc", "a-package@1.0.0") }).toThrow(/did not match/)
  })
})
