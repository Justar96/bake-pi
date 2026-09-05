import type { ToolCallStatus } from "@bake-pi/contract"

const DENIED_MARKER = "Bake Pi denied this tool:"
const ABORTED_MARKER = "Bake Pi cancelled this tool before it ran."

export const deniedToolReason = (detail: string): string => `${DENIED_MARKER} ${detail}`
export const abortedToolReason = (): string => ABORTED_MARKER

/** Recovers Bake Pi's policy outcome from the error Pi persisted for the tool. */
export const toolResultStatus = (isError: boolean, output: string): ToolCallStatus => {
  if (!isError) return "succeeded"
  if (output.includes(DENIED_MARKER)) return "denied"
  if (output.includes(ABORTED_MARKER)) return "aborted"
  return "failed"
}
