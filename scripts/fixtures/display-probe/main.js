/**
 * Prints the desktop as Electron sees it: every display with its id, work area
 * in DIPs and scale factor, one JSON document on stdout, then exits.
 *
 * `bun run frame` needs this to put the application's window on each display in
 * turn, and only Electron knows the DIP coordinates it will give a display —
 * they depend on the primary display's scale, which no Win32 call reports in
 * the same terms. Plain CommonJS, no dependencies: the question is about the
 * desktop, not about anything Bake Pi does.
 */
const { app, screen } = require("electron")

app.whenReady().then(() => {
  const primary = screen.getPrimaryDisplay()
  const displays = screen.getAllDisplays().map((display) => ({
    id: display.id,
    primary: display.id === primary.id,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor,
  }))
  process.stdout.write(`${JSON.stringify(displays)}\n`)
  app.quit()
})
