import type { SessionSnapshot } from "@bake-pi/contract"

/**
 * A rung on the theme's lightness ladder. The palette has no hue, so "colour"
 * for a state is how far up the ladder its own text sits: the brighter the
 * word, the more the setting will spend or allow.
 */
export type Tone = "faint" | "reasoning" | "success" | "running" | "warning" | "danger"

export type ThinkingLevel = SessionSnapshot["model"]["thinkingLevel"]

/**
 * One vocabulary for the thinking level, read by every surface that shows it.
 *
 * The chooser used to render the contract's own key through `capitalize`, so
 * the same setting read "Xhigh" in the composer and "Extra high" in the
 * sessions modal. A level is a word a person chose; it has one spelling, and a
 * level added to the contract fails to compile here until it has one.
 */
export const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
}

/**
 * What each rung of the ladder spends, in one clause.
 *
 * The tones already say *how much* — the brighter the word, the more the
 * setting spends — but not what the spending buys, and a level a person cannot
 * predict is a level they leave alone. The caption is the chooser's answer,
 * the way the reference prompt bar puts a description under every model name:
 * what it does first, what it costs second.
 */
export const EFFORT_HINTS: Record<ThinkingLevel, string> = {
  off: "Straight to the answer, no reasoning pass.",
  minimal: "Reasons only where a step clearly needs it.",
  low: "A short reasoning pass before answering.",
  medium: "The everyday balance of speed and care.",
  high: "Longer reasoning for harder problems.",
  xhigh: "Extended reasoning, at extended cost.",
  max: "The most the model can spend on a turn.",
}
