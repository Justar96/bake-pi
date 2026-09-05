/**
 * The colour Windows paints along the window's one-pixel edge.
 *
 * With the title bar hidden and `thickFrame` kept, DWM still draws a hairline
 * around the frame. Disabling the accent colour asked for the system default —
 * a mid grey that read as a light seam down both sides of the dark canvas and
 * as a dark outline around the light one. Matching the chrome's tint instead
 * made the line vanish along the tab strip and rails while it stayed visible
 * against the canvas below them, which read as a frame with its top missing.
 *
 * So the edge is a deliberate hairline in the renderer's `border` token: one
 * step above `canvasSubtle` and two above `canvas`, so it reads the same along
 * every side and around all four rounded corners. The two hex values mirror
 * the theme tokens; main cannot read a StyleX variable.
 *
 * Kept free of Electron imports so `bun run frame` can ask for the same answer
 * from outside the application and hold the real desktop to it.
 */
export const frameBorderColor = (dark: boolean): string => (dark ? "#2a2a2a" : "#d6d6d6")
