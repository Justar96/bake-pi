import { describe, expect, test } from "bun:test"
import type { Model, Provider } from "@bake-pi/contract"
import { availableModels } from "./available-models.ts"

const model = (providerId: string, id: string): Model => ({
  id,
  providerId,
  displayName: id,
  supportsThinking: false,
  supportsVision: false,
  supportsToolCalls: true,
})

const provider = (id: string, authStatus: Provider["authStatus"]): Provider => ({
  id,
  displayName: id,
  authStatus,
  supportedAuth: ["api_key"],
})

describe("models offered by the composer", () => {
  test("includes only providers with a usable credential", () => {
    const models = [model("ready", "a"), model("env", "b"), model("missing", "c"), model("unknown", "d")]
    const providers = [
      provider("ready", "authenticated"),
      provider("env", "environment"),
      provider("missing", "unauthenticated"),
      provider("unknown", "unknown"),
    ]

    expect(availableModels(models, providers).map(({ id }) => id)).toEqual(["a", "b"])
  })

  test("excludes expired providers and models whose provider was not reported", () => {
    const models = [model("expired", "old"), model("ready", "current"), model("unreported", "orphan")]
    const providers = [provider("expired", "expired"), provider("ready", "authenticated")]

    expect(availableModels(models, providers).map(({ id }) => id)).toEqual(["current"])
  })
})
