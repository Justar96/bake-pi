import { Type } from "@sinclair/typebox"
import { AuthStatus, Provider } from "../dto/model.ts"
import { defineCommands } from "./define.ts"

const providerRef = Type.Object({ providerId: Type.String({ maxLength: 128 }) })

export const authCommands = defineCommands({
  get_auth_status: { params: Type.Object({}), result: Type.Object({ providers: Type.Array(Provider) }) },
  /**
   * Starts whatever flow Pi supports for the provider. Bake Pi does not
   * implement provider auth; it drives Pi's `ModelRuntime` and reports back.
   */
  login: { params: providerRef, result: Type.Object({ status: AuthStatus }) },
  logout: { params: providerRef, result: Type.Object({ status: AuthStatus }) },
  /**
   * The key travels renderer → main → host once and enters Pi's runtime-only
   * credential overlay. Pi exposes no public persistent write, so the result
   * says explicitly that a host restart loses it. The key is never echoed back
   * in any result or event, and never written to a Bake Pi file.
   */
  set_api_key: {
    params: Type.Object({ providerId: Type.String({ maxLength: 128 }), apiKey: Type.String({ minLength: 1, maxLength: 4096 }) }),
    result: Type.Object({ status: AuthStatus, persisted: Type.Literal(false) }),
  },
})
