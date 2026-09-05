import type { TrustLevel } from "@bake-pi/contract"

/**
 * One vocabulary for the permission level, read by every surface that shows it.
 *
 * The same reasoning as `THINKING_LABELS`, and it matters more here: a person
 * sets the default in the settings panel and then reads the result on the pill
 * under the composer, and two spellings of one safety control is how a safety
 * control stops being read at all. A level added to the contract fails to
 * compile here until it has a word.
 *
 * Only the word. The hints stay with their surfaces because they genuinely
 * differ — the composer describes this workspace, the settings panel describes
 * every project nobody has decided on — and the tone and glyph are each
 * surface's own.
 */
export const TRUST_LABELS: Record<TrustLevel, string> = {
  untrusted: "Restricted",
  trusted: "Trusted",
  full: "Full access",
}
