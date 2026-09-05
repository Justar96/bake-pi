import { describe, expect, test } from "bun:test"
import {
  MANAGED_NODE_DOWNLOADS,
  MANAGED_NODE_VERSION,
  managedNodeSummary,
  parseWslArch,
} from "./wsl-node-install.ts"

describe("managed Node", () => {
  test("maps the architectures WSL actually reports", () => {
    expect(parseWslArch("x86_64\n")).toBe("x64")
    expect(parseWslArch("amd64")).toBe("x64")
    expect(parseWslArch("aarch64\n")).toBe("arm64")
    expect(parseWslArch("arm64")).toBe("arm64")
    // Node publishes no build for these, so the offer must not be made at all
    // rather than downloading something that cannot run.
    expect(parseWslArch("i686")).toBeUndefined()
    expect(parseWslArch("riscv64")).toBeUndefined()
    expect(parseWslArch("")).toBeUndefined()
  })

  test("pins a version-consistent nodejs.org gzip archive and a full digest", () => {
    for (const [arch, download] of Object.entries(MANAGED_NODE_DOWNLOADS)) {
      // Read back as a plain string: the pins are `as const`, so the literal
      // type would make the assertion tautological rather than a check.
      expect(String(download.url)).toBe(
        `https://nodejs.org/dist/v${MANAGED_NODE_VERSION}/node-v${MANAGED_NODE_VERSION}-linux-${arch}.tar.gz`,
      )
      expect(download.sha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(download.bytes).toBeGreaterThan(10_000_000)
    }
  })

  test("says the version and the cost before anyone agrees to it", () => {
    expect(managedNodeSummary()).toContain(MANAGED_NODE_VERSION)
    expect(managedNodeSummary()).toContain("MB")
  })
})
