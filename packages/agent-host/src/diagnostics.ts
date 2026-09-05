import { randomUUID } from "node:crypto"
import type { ContractError, ErrorCode } from "@bake-pi/contract"
import { BakePiError } from "@bake-pi/contract"

export interface DiagnosticEntry {
  id: string
  at: number
  level: "info" | "warn" | "error"
  scope: string
  message: string
  error?: ContractError
}

/**
 * Where the truth about a failure lives.
 *
 * The renderer receives a code and, at most, a short safe fragment. The message
 * and the stack stay here, behind an id the user can open from the error card.
 * The ring is bounded because a session that fails in a loop must not become a
 * memory leak on top of being broken.
 */
export class Diagnostics {
  readonly #entries: DiagnosticEntry[] = []
  readonly #limit: number

  constructor(limit = 2_000) {
    this.#limit = limit
  }

  record(level: DiagnosticEntry["level"], scope: string, message: string, error?: ContractError): string {
    const entry: DiagnosticEntry = { id: randomUUID(), at: Date.now(), level, scope, message, ...(error === undefined ? {} : { error }) }
    this.#entries.push(entry)
    if (this.#entries.length > this.#limit) this.#entries.splice(0, this.#entries.length - this.#limit)
    return entry.id
  }

  /**
   * Turns any thrown value into something safe to send, and logs the part that
   * is not safe to send. Every path that answers a command goes through here,
   * so there is no route by which a provider's error message reaches the UI.
   */
  capture(scope: string, error: unknown): ContractError {
    if (error instanceof BakePiError) {
      const id = this.record("error", scope, error.message, error.toContractError())
      return error.toContractError(id)
    }
    const message = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error)
    const id = this.record("error", scope, message)
    return { code: "internal_error" satisfies ErrorCode, diagnosticId: id, retryable: false }
  }

  since(sinceId: string | undefined, limit: number): DiagnosticEntry[] {
    const start = sinceId === undefined ? 0 : this.#entries.findIndex((entry) => entry.id === sinceId) + 1
    return this.#entries.slice(Math.max(start, 0)).slice(-limit)
  }
}
