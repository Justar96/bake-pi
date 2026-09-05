import { BakePiError, type ContractError } from "@bake-pi/contract"

/**
 * The one coercion from a thrown value to something the renderer may read.
 *
 * Three call sites had grown their own copy — the command router, the
 * supervisor's restart announcement, and bootstrap's failure report — which
 * meant an error code that needed different treatment had to be found three
 * times. A `BakePiError` was authored for the renderer and travels intact;
 * anything else is ours, and its message is not the renderer's business, so it
 * is logged where it is useful and reported as `internal_error`.
 */
export const toContractError = (error: unknown): ContractError => {
  if (error instanceof BakePiError) return error.toContractError()
  console.error("[main] unhandled command failure", error)
  return { code: "internal_error", retryable: false }
}
