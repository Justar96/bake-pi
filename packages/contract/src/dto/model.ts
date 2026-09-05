import { type Static, Type } from "@sinclair/typebox"

/**
 * Pi's thinking levels, all seven of them.
 *
 * This union is wider than a product would choose, and deliberately so: Pi
 * clamps a requested level to what the selected model actually supports, and
 * the clamped value is what `AgentSession.thinkingLevel` then reports. A
 * narrower union here would not narrow Pi — it would only mean a snapshot
 * describing a session as thinking at a level it is not. The renderer offers
 * the subset in `ModelSelection.availableThinkingLevels`; the contract carries
 * everything Pi can hand back.
 */
export const ThinkingLevel = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
])
export type ThinkingLevel = Static<typeof ThinkingLevel>

export const AuthStatus = Type.Union([
  Type.Literal("authenticated"),
  Type.Literal("unauthenticated"),
  Type.Literal("expired"),
  /** Pi resolved a credential from the environment. Bake Pi shows it and does not manage it. */
  Type.Literal("environment"),
  Type.Literal("unknown"),
])
export type AuthStatus = Static<typeof AuthStatus>

export const Provider = Type.Object({
  id: Type.String({ maxLength: 128 }),
  displayName: Type.String({ maxLength: 128 }),
  authStatus: AuthStatus,
  /** Which login flows Pi actually supports for this provider. The UI offers nothing else. */
  supportedAuth: Type.Array(
    Type.Union([Type.Literal("api_key"), Type.Literal("oauth"), Type.Literal("environment")]),
    { maxItems: 8 },
  ),
})
export type Provider = Static<typeof Provider>

export const Model = Type.Object({
  id: Type.String({ maxLength: 128 }),
  providerId: Type.String({ maxLength: 128 }),
  displayName: Type.String({ maxLength: 128 }),
  contextWindowTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  supportsThinking: Type.Boolean(),
  supportsVision: Type.Boolean(),
  supportsToolCalls: Type.Boolean(),
})
export type Model = Static<typeof Model>

export const ModelSelection = Type.Object({
  modelId: Type.String({ maxLength: 128 }),
  /** Model ids are not unique across providers, so a selection is only complete with both. */
  providerId: Type.String({ maxLength: 128 }),
  thinkingLevel: ThinkingLevel,
  /**
   * The levels the selected model actually supports, in Pi's order.
   *
   * A capability rather than a selection, and it lives here because it changes
   * *with* the selection: switching models changes which levels exist, and a
   * renderer holding a stale list offers a control whose only effect is to be
   * silently clamped. Whoever has the selection has the valid choices for it.
   */
  availableThinkingLevels: Type.Array(ThinkingLevel, { maxItems: 8 }),
})
export type ModelSelection = Static<typeof ModelSelection>
