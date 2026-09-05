import { Type } from "@sinclair/typebox"
import { WorkspaceId } from "../dto/primitives.ts"
import { Resource } from "../dto/resource.ts"
import { defineCommands } from "./define.ts"

const resourceRef = Type.Object({ resourceId: Type.String({ maxLength: 256 }) })
const ResourcePackageUpdate = Type.Object({
  displayName: Type.String({ maxLength: 256 }),
  type: Type.Union([Type.Literal("npm"), Type.Literal("git")]),
  scope: Type.Union([Type.Literal("user"), Type.Literal("project")]),
})

export const resourceCommands = defineCommands({
  list_resources: {
    params: Type.Object({ workspaceId: WorkspaceId }),
    result: Type.Object({ resources: Type.Array(Resource) }),
  },
  /** Re-runs Pi's discovery. Extensions are executable, so this reloads code and says so in the UI. */
  reload_resources: {
    params: Type.Object({ workspaceId: WorkspaceId }),
    result: Type.Object({ resources: Type.Array(Resource) }),
  },
  /** Uses Pi's package manager to check the configured extension and resource packages. */
  check_resource_updates: {
    params: Type.Object({ workspaceId: WorkspaceId }),
    result: Type.Object({ updates: Type.Array(ResourcePackageUpdate, { maxItems: 128 }) }),
  },
  /** Updates configured packages through Pi, then reloads their live resource set. */
  update_resources: {
    params: Type.Object({ workspaceId: WorkspaceId }),
    result: Type.Object({ resources: Type.Array(Resource) }),
  },
  enable_resource: { params: resourceRef, result: Type.Object({ resource: Resource }) },
  disable_resource: { params: resourceRef, result: Type.Object({ resource: Resource }) },
})
