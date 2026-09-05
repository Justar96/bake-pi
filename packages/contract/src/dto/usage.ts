import { type Static, Type } from "@sinclair/typebox"

export const TokenUsage = Type.Object({
  inputTokens: Type.Integer({ minimum: 0 }),
  outputTokens: Type.Integer({ minimum: 0 }),
  cacheReadTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  cacheWriteTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  reasoningTokens: Type.Optional(Type.Integer({ minimum: 0 })),
})
export type TokenUsage = Static<typeof TokenUsage>

export const CostUsd = Type.Number({ minimum: 0 })

/** What the inspector shows: how full the window is, and what it cost so far. */
export const ContextWindowUsage = Type.Object({
  usedTokens: Type.Integer({ minimum: 0 }),
  maxTokens: Type.Integer({ minimum: 1 }),
  /** Pi's compaction threshold, when the model reports one. */
  compactionThresholdTokens: Type.Optional(Type.Integer({ minimum: 1 })),
})
export type ContextWindowUsage = Static<typeof ContextWindowUsage>

export const SessionUsage = Type.Object({
  turnCount: Type.Integer({ minimum: 0 }),
  total: TokenUsage,
  totalCostUsd: Type.Optional(CostUsd),
  context: Type.Optional(ContextWindowUsage),
})
export type SessionUsage = Static<typeof SessionUsage>
