import { createContext, useContext } from "react"

/** A person's persisted appearance preference, before `system` is resolved. */
export type ThemeChoice = "system" | "light" | "dark" | "high-contrast"

/**
 * The resolved appearance, after `system` has been answered by the media query.
 *
 * `ThemeChoice` is what a person picks and includes `system`; this is what the
 * pick resolved to. Syntax highlighting needs the resolved value because a
 * Shiki theme is chosen by name rather than by CSS, so it cannot follow
 * `prefers-color-scheme` the way the StyleX themes do.
 */
export type Appearance = "light" | "dark" | "high-contrast"

/**
 * Defaults to `dark` because `darkTheme` is `createTheme(colors, {})` — the
 * `defineVars` defaults with nothing overridden. A component rendered outside
 * the provider therefore matches the tokens it would actually be painted with.
 */
export const AppearanceContext = createContext<Appearance>("dark")

export const useAppearance = (): Appearance => useContext(AppearanceContext)
