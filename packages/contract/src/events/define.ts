import type { TSchema } from "@sinclair/typebox"

export const defineEvents = <const T extends Record<string, TSchema>>(defs: T): T => defs
