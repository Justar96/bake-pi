import * as stylex from "@stylexjs/stylex"
import { colors } from "./tokens.stylex.ts"

/**
 * One shimmer, worn by every word that means "still working".
 *
 * `spinners.ts` is the precedent and the reason this is a theme module rather
 * than a style in whichever component wanted it first: a shared appearance
 * belongs to the theme. Keyframes cannot cross a module boundary in StyleX —
 * only the created styles can — so the animation is declared beside the single
 * `create` call that uses it, exactly as the spinner's is.
 *
 * The sweep is a gradient clipped to the glyphs, so it has to be carried by an
 * element that *has* text: a container with none of its own clips nothing, and
 * its children go on painting their own colour. That is what decides where
 * this can be applied — the verb of a step rather than the verb-and-file pair
 * around it, the word inside a status line rather than the line.
 *
 * Both stops are legible text tones, which is the difference between a state
 * and a decoration: the word stays readable at every point in the sweep
 * instead of fading toward the canvas and back. `running` is the tone the
 * interface already spends on work in progress, and the highlight is the plain
 * text colour, so the shimmer is that same tone brightening rather than a
 * second hue nobody chose.
 *
 * Percentages, not pixels, and never past `0%`: with a background three times
 * the width of its box, `100%` shows the gradient's right third and `0%` its
 * left, and every value between them keeps the box covered. A position outside
 * that range slides the image clear of the text it is meant to fill, which
 * paints nothing — and nothing, with `color: transparent` underneath it, is an
 * invisible word.
 *
 * Two conditions take the gradient away rather than freezing it. Reduced
 * motion cannot simply stop the sweep, because a stopped sweep is a word
 * coloured by whichever stop it happened to reach; forced colours means the
 * platform is choosing every colour, and a transparent glyph filled by an
 * image is the one thing that cannot survive that. Both fall back to the flat
 * running tone, which still says the same thing with the word.
 */
const sweep = stylex.keyframes({
  from: { backgroundPosition: "100% 0" },
  to: { backgroundPosition: "0% 0" },
})

const still = "@media (prefers-reduced-motion: reduce)"
const forced = "@media (forced-colors: active)"

export const shimmer = stylex.create({
  text: {
    backgroundImage: {
      default: `linear-gradient(100deg, ${colors.running} 40%, ${colors.text} 50%, ${colors.running} 60%)`,
      [still]: "none",
      [forced]: "none",
    },
    backgroundSize: "300% 100%",
    backgroundRepeat: "no-repeat",
    /** Unprefixed since Chromium 120; Electron 44 is far past that. */
    backgroundClip: "text",
    color: { default: "transparent", [still]: colors.running, [forced]: colors.running },
    animationName: { default: sweep, [still]: "none", [forced]: "none" },
    /**
     * Slower than the spinner's 1100ms on purpose. The ring is the thing that
     * proves the process is alive, so it turns at a working tempo; this is a
     * word being read, and a word swept twice a second is harder to read than
     * a still one.
     */
    animationDuration: "1600ms",
    animationIterationCount: "infinite",
    animationTimingFunction: "linear",
  },
})
