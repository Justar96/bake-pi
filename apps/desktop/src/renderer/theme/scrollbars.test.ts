import { describe, expect, test } from "bun:test"
import { Glob } from "bun"

/**
 * Every surface that scrolls wears the same scrollbar, checked rather than
 * claimed.
 *
 * `scrollbars.ts` says the list of elements that import it is the list of
 * elements that scroll, and until now that was an assertion about people
 * remembering. It is exactly the kind of thing nobody notices being wrong: a
 * new scrolling panel gets the platform's default bar — a permanent grey
 * channel with a slab in it, sized for a mouse from 2003 — and it looks merely
 * slightly off rather than broken, on one surface, in one state, that a
 * screenshot has to catch. The model chooser shipped that way and was spotted
 * by eye, which is the review this replaces.
 *
 * Read as text, because a `.stylex.ts` module throws the moment it is loaded
 * without the Babel plugin and a `.tsx` component cannot be rendered here at
 * all. The roster is the second half: a style that starts scrolling has to be
 * listed, which costs a line and buys the question being asked once.
 */

const root = new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")

/** `name: {` … `overflow: "auto"`, wherever the two ended up relative to each other. */
const SCROLLS = /\b(?:overflow|overflowX|overflowY):\s*"(?:auto|scroll)"/
const STYLE_KEY = /^\s{2}([a-zA-Z][\w]*):\s*\{/

/** Every scrolling style in the renderer, as `file#styleName`. */
const surfaces = async (): Promise<{ found: string[]; files: Map<string, string> }> => {
  const found: string[] = []
  const files = new Map<string, string>()
  for await (const relative of new Glob("**/*.{ts,tsx}").scan({ cwd: root })) {
    if (relative.endsWith(".test.ts") || relative.endsWith(".test.tsx")) continue
    const source = await Bun.file(`${root}${relative}`).text()
    files.set(relative.replace(/\\/g, "/"), source)
    const lines = source.split("\n")
    lines.forEach((line, index) => {
      if (!SCROLLS.test(line)) return
      // Walk back to the style this declaration belongs to. A style object is
      // either one line or an indented block, and both start the same way.
      for (let at = index; at >= 0; at -= 1) {
        const key = STYLE_KEY.exec(lines[at]!)
        if (key !== null) {
          found.push(`${relative.replace(/\\/g, "/")}#${key[1]!}`)
          return
        }
      }
    })
  }
  return { found, files }
}

/**
 * The roster. Each of these scrolls, and each is composed with
 * `scrollbars.thin` where it is used.
 *
 * `TabStrip#tabs` is the one that looks like an exception and is not: it scrolls
 * horizontally through open sessions and sets `scrollbarWidth: "none"` because
 * a bar under a row of tabs is noise, but it still wears the shared style so
 * that the platform's bar cannot appear where the property is not honoured.
 */
const ROSTER = [
  "App.tsx#center",
  "features/conversation/ApprovalTray.tsx#tray",
  "features/conversation/CodeBlock.tsx#body",
  "features/conversation/Composer.tsx#choiceMenu",
  "features/conversation/QuestionTray.tsx#options",
  "features/conversation/Markdown.tsx#tableScroll",
  "features/conversation/Timeline.tsx#viewport",
  "features/workbench/ActivityRail.tsx#list",
  "features/workbench/CommandPalette.tsx#list",
  "features/workbench/FileRail.tsx#tree",
  "features/workbench/Overlay.tsx#body",
  "features/workbench/PiSettings.tsx#textarea",
  "features/workbench/SelectControl.tsx#menu",
  "features/workbench/SettingsRail.tsx#body",
  "features/workbench/TabStrip.tsx#tabs",
  "features/workbench/Workbench.tsx#start",
]

test("the renderer scrolls in exactly the places the roster names", async () => {
  const { found } = await surfaces()
  expect(found.sort()).toEqual([...ROSTER].sort())
})

describe("each of them wears the shared scrollbar", () => {
  test("the file declaring it imports the module", async () => {
    const { found, files } = await surfaces()
    for (const surface of found) {
      const source = files.get(surface.split("#")[0]!)
      expect(source, `${surface} has a source`).toBeDefined()
      const importsScrollbars = source!.includes('from "../../theme/scrollbars.ts"')
        || source!.includes('from "./theme/scrollbars.ts"')
      expect(importsScrollbars, `${surface} imports scrollbars`).toBe(true)
    }
  })

  /**
   * A file may scroll in more than one place — `Timeline.tsx` scrolls in three —
   * so importing the module is not enough on its own. Every scrolling style has
   * to appear beside `scrollbars.thin` in a `stylex.props` call, which is the
   * composition the module's own comment describes.
   */
  test("the style is composed with it at the call site", async () => {
    const { found, files } = await surfaces()
    for (const surface of found) {
      const [file, name] = surface.split("#") as [string, string]
      const source = files.get(file)!
      const composed = new RegExp(`stylex\\.props\\([^)]*scrollbars\\.thin[^)]*\\b(?:styles|overlay)\\.${name}\\b`).test(source)
        || new RegExp(`stylex\\.props\\([^)]*\\b(?:styles|overlay)\\.${name}\\b[^)]*scrollbars\\.thin`).test(source)
      expect(composed, `${surface} is composed with scrollbars.thin`).toBe(true)
    }
  })
})
