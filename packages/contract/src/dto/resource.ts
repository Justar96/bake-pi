import { type Static, Type } from "@sinclair/typebox"
import { AbsolutePath } from "./primitives.ts"

/** Pi's resource kinds. Bake Pi lists and toggles them; it does not interpret their contents. */
export const ResourceKind = Type.Union([
  Type.Literal("skill"),
  Type.Literal("prompt"),
  Type.Literal("extension"),
  Type.Literal("mcp_server"),
  Type.Literal("instruction"),
])
export type ResourceKind = Static<typeof ResourceKind>

export const ResourceScope = Type.Union([
  Type.Literal("builtin"),
  Type.Literal("user"),
  Type.Literal("project"),
])
export type ResourceScope = Static<typeof ResourceScope>

export const Resource = Type.Object({
  id: Type.String({ maxLength: 256 }),
  kind: ResourceKind,
  scope: ResourceScope,
  name: Type.String({ maxLength: 256 }),
  description: Type.Optional(Type.String({ maxLength: 2048 })),
  path: Type.Optional(AbsolutePath),
  enabled: Type.Boolean(),
  /**
   * A project-scoped extension is executable code from the repository. The UI
   * says so on the trust screen; this flag is what it reads.
   */
  executable: Type.Boolean(),
  loadError: Type.Optional(Type.String({ maxLength: 512 })),
})
export type Resource = Static<typeof Resource>
