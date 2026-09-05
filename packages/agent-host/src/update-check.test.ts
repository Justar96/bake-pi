import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { checkForPiUpdate, compareVersions } from "./update-check.ts"

const previousOffline = process.env.PI_OFFLINE
const previousSkip = process.env.PI_SKIP_VERSION_CHECK

beforeEach(() => {
  delete process.env.PI_OFFLINE
  delete process.env.PI_SKIP_VERSION_CHECK
})

afterAll(() => {
  if (previousOffline === undefined) delete process.env.PI_OFFLINE
  else process.env.PI_OFFLINE = previousOffline
  if (previousSkip === undefined) delete process.env.PI_SKIP_VERSION_CHECK
  else process.env.PI_SKIP_VERSION_CHECK = previousSkip
})

describe("Pi update checks", () => {
  test("compares stable and prerelease semantic versions", () => {
    expect(compareVersions("0.85.0", "0.84.4")).toBe(1)
    expect(compareVersions("0.84.4", "0.84.4")).toBe(0)
    expect(compareVersions("0.84.4-beta.2", "0.84.4-beta.1")).toBe(1)
    expect(compareVersions("0.84.4", "0.84.4-beta.2")).toBe(1)
    expect(compareVersions("not-a-version", "0.84.4")).toBe(0)
  })

  test("returns a newer Pi version from the npm registry", async () => {
    const requested: string[] = []
    const latest = await checkForPiUpdate("0.84.4", async (input) => {
      requested.push(String(input))
      return Response.json({ version: "0.85.0" })
    })

    expect(latest).toBe("0.85.0")
    expect(requested).toEqual(["https://registry.npmjs.org/@earendil-works/pi-coding-agent/latest"])
  })

  test("stays silent for current, offline, and failed checks", async () => {
    expect(await checkForPiUpdate("0.84.4", async () => Response.json({ version: "0.84.4" }))).toBeUndefined()

    process.env.PI_OFFLINE = "1"
    let called = false
    expect(await checkForPiUpdate("0.84.4", async () => {
      called = true
      return Response.json({ version: "0.85.0" })
    })).toBeUndefined()
    expect(called).toBe(false)

    delete process.env.PI_OFFLINE
    expect(await checkForPiUpdate("0.84.4", async () => { throw new Error("offline") })).toBeUndefined()
  })
})
