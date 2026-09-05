import { Type } from "@sinclair/typebox"
import { AuthStatus, Provider } from "../dto/model.ts"
import { Resource } from "../dto/resource.ts"
import { SessionSummary } from "../dto/session.ts"
import { Workspace } from "../dto/workspace.ts"
import { defineEvents } from "./define.ts"

export const workspaceEvents = defineEvents({
  workspace_changed: Type.Object({ workspace: Workspace }),
  session_list_changed: Type.Object({ sessions: Type.Array(SessionSummary) }),
  resources_changed: Type.Object({ resources: Type.Array(Resource) }),
  /**
   * An extension threw during load or during a hook. Surfaced per extension
   * rather than as a session failure: one bad project extension must not read
   * as "Pi is broken".
   */
  extension_error: Type.Object({
    extensionName: Type.String({ maxLength: 128 }),
    phase: Type.Union([Type.Literal("load"), Type.Literal("hook"), Type.Literal("tool")]),
    message: Type.String({ maxLength: 2048 }),
  }),
  auth_changed: Type.Object({ providerId: Type.String({ maxLength: 128 }), status: AuthStatus }),
  providers_changed: Type.Object({ providers: Type.Array(Provider) }),
})
