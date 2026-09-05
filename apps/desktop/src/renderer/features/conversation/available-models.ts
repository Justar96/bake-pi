import type { Model, Provider } from "@bake-pi/contract"

/** A provider can serve a model only when Pi resolved a usable credential. */
export const availableModels = (models: Model[], providers: Provider[]): Model[] => {
  const connected = new Set(
    providers
      .filter((provider) => provider.authStatus === "authenticated" || provider.authStatus === "environment")
      .map((provider) => provider.id),
  )
  return models.filter((model) => connected.has(model.providerId))
}
