import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SettingsManager } from "@earendil-works/pi-coding-agent"

/**
 * `SEC-003`: whether Pi's telemetry has a public off switch.
 *
 * The measured answer is yes, and the shape of it matters more than the yes.
 * What Pi 0.85.0 calls install telemetry is two distinct things:
 *
 * 1. **A fresh-install ping** to `https://pi.dev/api/report-install`, sent from
 *    `modes/interactive/interactive-mode.ts` when the changelog is displayed.
 *    Bake Pi never runs interactive mode, so this call site is unreachable from
 *    the agent host. It is additionally gated by `PI_OFFLINE`.
 * 2. **Provider attribution headers** added in `core/provider-attribution.ts` —
 *    `HTTP-Referer` and `X-OpenRouter-*` for OpenRouter, `X-BILLING-INVOKE-ORIGIN`
 *    for NVIDIA NIM, a `pi-coding-agent` `User-Agent` for Cloudflare. These ride
 *    on requests the user already chose to make to their own provider. There is
 *    no separate endpoint and no separate payload.
 *
 * So the honest claim for the handshake's `telemetryOptOut` flag is that the
 * switch exists and is public. What is *not* yet proven is the other half of
 * `SEC-003`: that diagnostics report the state, and that an egress capture
 * confirms it. That half belongs to Milestone 5 and stays open.
 *
 * The switch is measured here through `SettingsManager` only, because
 * `isInstallTelemetryEnabled` is exported from Pi's telemetry module but not
 * from the package index — it is not API Bake Pi may depend on.
 */

const temporary: string[] = []
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true })
})

const newAgentDir = (): { cwd: string; agentDir: string } => {
  const cwd = mkdtempSync(join(tmpdir(), "bakepi-telemetry-cwd-"))
  const agentDir = mkdtempSync(join(tmpdir(), "bakepi-telemetry-agent-"))
  temporary.push(cwd, agentDir)
  return { cwd, agentDir }
}

const settings = (): SettingsManager => {
  const { cwd, agentDir } = newAgentDir()
  return SettingsManager.create(cwd, agentDir)
}

describe("SEC-003: Pi's telemetry switch is public", () => {
  test("install telemetry is on by default, so this is opt-out and not opt-in", () => {
    expect(settings().getEnableInstallTelemetry()).toBe(true)
  })

  test("it can be turned off through a public setter and the choice persists", async () => {
    const { cwd, agentDir } = newAgentDir()
    const manager = SettingsManager.create(cwd, agentDir)

    manager.setEnableInstallTelemetry(false)
    expect(manager.getEnableInstallTelemetry()).toBe(false)

    // The setter updates memory immediately and queues the write. `flush()` is
    // the public durability boundary, so a Bake Pi settings screen cannot report
    // "saved" from the setter returning; it has to await the flush and surface
    // any errors collected by `drainErrors()`.
    await manager.flush()

    // Re-read from the same agent directory rather than trusting the in-memory
    // object. The point of the measurement is that the choice survives a restart
    // of the host, which means it reached disk — and it reaches
    // `<agentDir>/settings.json`, so an isolated agent directory keeps this test
    // out of the developer's real Pi settings.
    const restarted = SettingsManager.create(cwd, agentDir)
    expect(restarted.getEnableInstallTelemetry()).toBe(false)
    expect(manager.drainErrors()).toEqual([])
  })

  test("it can be turned back on, so the control is a toggle and not a one-way door", () => {
    const manager = settings()
    manager.setEnableInstallTelemetry(false)
    manager.setEnableInstallTelemetry(true)
    expect(manager.getEnableInstallTelemetry()).toBe(true)
  })
})
