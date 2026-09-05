import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelRuntime, createAgentSessionServices, readStoredCredential } from "@earendil-works/pi-coding-agent"

/**
 * What `set_api_key` actually does, measured rather than assumed.
 *
 * Two questions, and the repository got both wrong at once because each hid the
 * other:
 *
 * 1. **Does a key set on the host's runtime reach the sessions that stream?**
 *    Only if the host hands its runtime to `createAgentSessionServices`. That
 *    parameter is optional and its fallback is `ModelRuntime.create()`, which is
 *    not a singleton — so omitting it gives every session a private
 *    `RuntimeCredentials` and a key that reaches none of them. Both runtimes read
 *    the same `auth.json`, so the split is invisible for any credential that is
 *    on disk; it appears only for one that lives in memory, which is exactly what
 *    `setRuntimeApiKey` creates.
 *
 * 2. **Does that key survive a restart?** No. Pi's own name for the mechanism is
 *    "non-persistent runtime API keys". The persisting write is
 *    `CredentialStore.modify`, and `ModelRuntime` keeps its store private, so
 *    there is no public path to it — `readStoredCredential` here is the public
 *    read that proves the absence. `apiKeyPersistence` is false because of this
 *    test, and a Pi release that adds a public persisting path should turn this
 *    test red rather than leave the flag quietly pessimistic.
 *
 * Note the asymmetry the second measurement exposes and the first explains:
 * `logout` reaches the persistent store, `set_api_key` does not. That is Pi's
 * shape, not ours, and the renderer needs to know it because "signed out" is
 * durable while "signed in" is not.
 */

const temporary: string[] = []
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true })
})

const newAgentDir = (): { cwd: string; agentDir: string } => {
  const cwd = mkdtempSync(join(tmpdir(), "bakepi-credentials-cwd-"))
  const agentDir = mkdtempSync(join(tmpdir(), "bakepi-credentials-agent-"))
  temporary.push(cwd, agentDir)
  return { cwd, agentDir }
}

// An isolated agent directory keeps every assertion here off the developer's own
// `auth.json`. `refreshOnCreate: false` keeps it off the network too; the
// default already refuses to reach one without `allowModelNetwork`, but a
// credential test should not depend on that default holding.
const newRuntime = (agentDir: string): Promise<ModelRuntime> =>
  ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    refreshOnCreate: false,
  })

const PROVIDER = "openai"

describe("a runtime API key reaches every session on the host", () => {
  test("the session services use the runtime they are handed, not one of their own", async () => {
    const { cwd, agentDir } = newAgentDir()
    const runtime = await newRuntime(agentDir)

    const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime: runtime })

    // Identity, not equivalence. Two runtimes over the same `auth.json` would
    // pass any test that only compared what they can read from disk, and would
    // still lose a runtime-only key — which is the whole defect.
    expect(services.modelRuntime).toBe(runtime)
  })

  test("omitting it gives the session a different runtime, which is how the key used to vanish", async () => {
    const { cwd, agentDir } = newAgentDir()
    const runtime = await newRuntime(agentDir)
    await runtime.setRuntimeApiKey(PROVIDER, "held-only-in-memory")

    // The counterfactual, kept because it is what makes the assertion above mean
    // something. This is the call `runtime.ts` used to make.
    const services = await createAgentSessionServices({ cwd, agentDir })

    expect(services.modelRuntime).not.toBe(runtime)
    expect(runtime.hasConfiguredAuth(PROVIDER)).toBe(true)
    expect(services.modelRuntime.hasConfiguredAuth(PROVIDER)).toBe(false)
  })

  test("with the runtime shared, the key the host set is the key the session sees", async () => {
    const { cwd, agentDir } = newAgentDir()
    const runtime = await newRuntime(agentDir)
    await runtime.setRuntimeApiKey(PROVIDER, "held-only-in-memory")

    const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime: runtime })

    expect(services.modelRuntime.hasConfiguredAuth(PROVIDER)).toBe(true)

    // Pi names the source itself, and `"runtime"` is the whole story in one
    // field: configured, and configured from the overlay rather than from the
    // store. It is what distinguishes this from a key that was on disk all
    // along — the case that would pass even with the runtimes split.
    expect(services.modelRuntime.getProviderAuthStatus(PROVIDER)).toEqual({ configured: true, source: "runtime" })
  })
})

describe("apiKeyPersistence is false, and this is why", () => {
  test("setRuntimeApiKey does not reach auth.json, so the key dies with the host", async () => {
    const { agentDir } = newAgentDir()
    const authPath = join(agentDir, "auth.json")
    const runtime = await newRuntime(agentDir)

    await runtime.setRuntimeApiKey(PROVIDER, "held-only-in-memory")

    // In memory it is real: the provider reports configured auth, which is what
    // `set_api_key` reports back to the renderer as `authenticated`.
    expect(runtime.hasConfiguredAuth(PROVIDER)).toBe(true)

    // On disk it does not exist. `readStoredCredential` is Pi's public read of
    // `auth.json` and is the only public window onto the store, since
    // `ModelRuntime.credentials` is private and `DefaultAuthStorage` is not part
    // of the package's exports.
    expect(readStoredCredential(PROVIDER, authPath)).toBeUndefined()

    // And a fresh runtime over the same directory — the restarted host — sees
    // nothing. This is the claim the handshake flag makes to the renderer.
    const restarted = await newRuntime(agentDir)
    expect(restarted.hasConfiguredAuth(PROVIDER)).toBe(false)
  })

  test("listCredentials reports the runtime key, so status is not evidence of durability", async () => {
    const { agentDir } = newAgentDir()
    const runtime = await newRuntime(agentDir)
    await runtime.setRuntimeApiKey(PROVIDER, "held-only-in-memory")

    // `RuntimeCredentials.list` merges the overrides over the store, so every
    // status surface reports the key as present. A Bake Pi settings screen that
    // inferred "saved" from this would be wrong, and the flag is what stops it.
    const listed = await runtime.listCredentials()
    expect(listed.map((entry) => entry.providerId)).toContain(PROVIDER)
    expect(readStoredCredential(PROVIDER, join(agentDir, "auth.json"))).toBeUndefined()
  })
})
