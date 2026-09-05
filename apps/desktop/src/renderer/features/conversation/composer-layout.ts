/**
 * Below this width the composer's two rows say the same things in fewer
 * characters: the permission pill keeps its glyph and drops its word, the
 * context gauge drops its word and keeps its ring, Steer drops its label.
 * Without it the slots wrap into three rows of chips under the field — more
 * chrome than editor.
 *
 * 560 is both rails open on a 1280 window, which is the narrowest layout the
 * conversation is expected to hold a full control row at.
 */
const DENSE_BELOW = 560

export const composerIsDense = (width: number): boolean => width > 0 && width < DENSE_BELOW

/**
 * How full the context window is, as the composer's gauge reads it.
 *
 * The composer used to print `12,345 / 200,000`, which is the widest thing on
 * the control row and the least useful: nobody budgets a conversation to the
 * token. A percentage and a ring answer the question the number was being read
 * for — is there room left — and the exact counts stay a hover away and live in
 * full in the activity rail.
 */
export interface ContextReading {
  /** Whole percent used, for the meter's `aria-valuenow` and its label. */
  percent: number
  /**
   * The same reading unrounded, because the ring is drawn from it.
   *
   * The percentage is what a person reads and rounding it is right; the arc is
   * a length, and rounding a length to a whole percent would quantise it for
   * no reason now that nothing forces a quantised value.
   */
  fraction: number
  /**
   * How close the window is to needing compaction, which is the only part of
   * this the ring changes colour for.
   *
   * `pressing` is the model's own compaction threshold where it reports one,
   * because that is the point the session's behaviour changes rather than a
   * number chosen here; three quarters is the fallback for a model that
   * reports no threshold at all.
   */
  pressure: "calm" | "pressing" | "critical"
  /**
   * The same reading as a colour temperature: 0 empty, 0.5 at the point
   * compaction becomes due, 1 full.
   *
   * `pressure` is three states and it is what the words are coloured by;
   * `warmth` is the continuous quantity the ring is drawn in, so the arc says
   * how full the window is by its colour as well as by its length instead of
   * staying one colour for the first three quarters of a session and then
   * changing twice.
   *
   * It is anchored on the threshold rather than spread evenly over the window
   * so that the two signals never disagree: the ring reaches the warning hue
   * exactly where the word does, for a model that compacts at three quarters
   * and for one that compacts at half.
   */
  warmth: number
}

/**
 * How many colours the ramp is cut into.
 *
 * The stroke is a class, not a computed value — this renderer's CSP carries no
 * `style-src 'unsafe-inline'`, so a colour per render would have to be an
 * inline custom property and would be dropped. Ten declared stops is the
 * activity rail's twenty-one declared widths applied to a colour: fine enough
 * that a filling ring reads as warming rather than as switching, coarse enough
 * that every value it can take is written down and themed.
 */
export const CONTEXT_RAMP_STOPS = 10

/** Which of those stops a reading lands on: 0 is the coolest, `CONTEXT_RAMP_STOPS - 1` the hottest. */
export const contextRampStop = (warmth: number): number =>
  Math.min(CONTEXT_RAMP_STOPS - 1, Math.max(0, Math.round(warmth * (CONTEXT_RAMP_STOPS - 1))))

export const readContext = ({ usedTokens, maxTokens, compactionThresholdTokens }: {
  usedTokens: number
  maxTokens: number
  compactionThresholdTokens?: number | undefined
}): ContextReading => {
  const fraction = maxTokens > 0 ? Math.min(1, Math.max(0, usedTokens / maxTokens)) : 0
  const percent = Math.round(fraction * 100)
  const pressing = compactionThresholdTokens === undefined ? percent >= 75 : usedTokens >= compactionThresholdTokens
  /*
   * Where the ramp's midpoint sits, as a fraction of the window. Held off both
   * ends: a model reporting a threshold of nought, or one reporting its whole
   * window, would otherwise divide one half of the ramp by zero and take the
   * ring straight to red or leave it grey until the last token.
   */
  const midpoint = Math.min(0.95, Math.max(0.05, maxTokens > 0 && compactionThresholdTokens !== undefined
    ? compactionThresholdTokens / maxTokens
    : 0.75))
  return {
    percent,
    fraction,
    pressure: percent >= 90 ? "critical" : pressing ? "pressing" : "calm",
    warmth: fraction <= midpoint
      ? 0.5 * (fraction / midpoint)
      : 0.5 + 0.5 * ((fraction - midpoint) / (1 - midpoint)),
  }
}
