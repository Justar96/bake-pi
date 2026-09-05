import { createContext, useContext } from "react"

/**
 * How a thinking step decides whether to show its listing without being asked.
 *
 * - `auto`: open while its turn is running, closed once the turn has ended. A
 *   running tool's output is the thing being watched; a finished turn of eight
 *   tools with eight listings open is the wall of text the step list replaces.
 * - `collapsed`: never opened by the interface. Only a click discloses.
 * - `open`: every step with content starts open, running or settled.
 *
 * A click always wins over the preference; this only decides the default.
 * It is a view preference, so it lives in `localStorage` beside the theme.
 */
export type StepDisclosure = "auto" | "collapsed" | "open"

export const STEP_DISCLOSURE_CHOICES = ["auto", "collapsed", "open"] as const satisfies readonly StepDisclosure[]

export const StepDisclosureContext = createContext<StepDisclosure>("auto")

export const useStepDisclosure = (): StepDisclosure => useContext(StepDisclosureContext)
