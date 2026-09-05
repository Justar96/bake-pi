import { Type } from "@sinclair/typebox"
import { Model, ModelSelection, Provider, ThinkingLevel } from "../dto/model.ts"
import { SessionId } from "../dto/primitives.ts"
import { defineCommands } from "./define.ts"

export const modelCommands = defineCommands({
  list_providers: { params: Type.Object({}), result: Type.Object({ providers: Type.Array(Provider) }) },
  list_models: {
    params: Type.Object({ providerId: Type.Optional(Type.String({ maxLength: 128 })) }),
    result: Type.Object({ models: Type.Array(Model) }),
  },
  /**
   * `providerId` is required rather than inferred. The same model id is offered
   * by several providers — a proxy, a gateway, and the vendor itself all list
   * `claude-sonnet-4` — and resolving one by id alone would silently pick
   * whichever came first in the catalog, which is a different credential, a
   * different endpoint, and a different bill. Every `Model` the renderer can
   * offer already carries its provider.
   */
  set_model: {
    params: Type.Object({
      sessionId: SessionId,
      providerId: Type.String({ maxLength: 128 }),
      modelId: Type.String({ maxLength: 128 }),
    }),
    result: Type.Object({ selection: ModelSelection }),
  },
  set_thinking_level: {
    params: Type.Object({ sessionId: SessionId, level: ThinkingLevel }),
    result: Type.Object({ selection: ModelSelection }),
  },
  /** Re-queries providers for their model lists. Network-bound, so it is explicit rather than automatic. */
  refresh_models: { params: Type.Object({}), result: Type.Object({ models: Type.Array(Model) }) },
})
