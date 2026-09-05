import type { TSchema } from "@sinclair/typebox"

/**
 * A command is a params schema and a result schema declared together. Keeping
 * them adjacent is the whole point: a hand-written type next to a schema drifts
 * from it silently, and the first symptom is a validated payload the renderer
 * cannot read.
 */
export interface CommandDef {
  readonly params: TSchema
  readonly result: TSchema
}

export const defineCommands = <const T extends Record<string, CommandDef>>(defs: T): T => defs
