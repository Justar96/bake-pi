import { describe, expect, test } from "bun:test"
import { nodeBinDir, nodeMajor, parseLoginShell, parseNodeProbe } from "./wsl-node.ts"

describe("WSL Node discovery", () => {
  test("accepts Node's version output without guessing malformed text", () => {
    expect(nodeMajor("v22.14.0\n")).toBe(22)
    expect(nodeMajor("v24.18.1")).toBe(24)
    expect(nodeMajor("22.14.0")).toBeUndefined()
    expect(nodeMajor("node is unavailable")).toBeUndefined()
  })

  test("reads the probe's two lines and requires an absolute Linux path", () => {
    expect(parseNodeProbe("v26.7.0\n/home/dev/.local/share/fnm/node-versions/v26.7.0/installation/bin/node\n"))
      .toEqual({ version: "v26.7.0", path: "/home/dev/.local/share/fnm/node-versions/v26.7.0/installation/bin/node" })
    expect(parseNodeProbe("v22.14.0\nbin/node\n")).toBeUndefined()
    expect(parseNodeProbe("no node here\n/usr/bin/node\n")).toBeUndefined()
    expect(parseNodeProbe("")).toBeUndefined()
  })

  test("puts the discovered binary's own directory on PATH", () => {
    expect(nodeBinDir({ version: "v26.7.0", path: "/opt/node/bin/node" })).toBe("/opt/node/bin")
  })

  test("runs the second pass only in a shell that would parse the probe", () => {
    expect(parseLoginShell("/usr/bin/zsh\n")).toBe("/usr/bin/zsh")
    expect(parseLoginShell("/bin/bash")).toBe("/bin/bash")
    // fish and nushell cannot run a POSIX script, so an interactive pass in one
    // of them would fail for a reason that has nothing to do with Node.
    expect(parseLoginShell("/usr/bin/fish")).toBeUndefined()
    expect(parseLoginShell("/usr/sbin/nologin")).toBeUndefined()
    expect(parseLoginShell("bash")).toBeUndefined()
    expect(parseLoginShell("")).toBeUndefined()
  })
})
