import { expect, test } from "bun:test"
import { Glob } from "bun"

/**
 * Layout geometry is square inside the native rounded desktop frame; contained
 * components may soften a little and circles still have to earn the circle.
 *
 * The radius scale keeps semantic names because call sites need to say whether
 * they are a control, contained object or card. The values stay deliberately
 * small beside the square application frame. `pill` is narrower still: it may
 * describe something whose shape communicates state, never a decorative
 * capsule around content.
 *
 * Read the source as text because a `.stylex.ts` module cannot execute in Bun's
 * test runner without the compiler plugin. The declaration matches either
 * `defineVars` or `defineConsts`: which of the two a never-themed scale uses is
 * a compilation decision, and the roles asserted below are the same either way.
 */
const tokenSource = await Bun.file(new URL("./tokens.stylex.ts", import.meta.url)).text()
const declaration = /export const radius = stylex\.define(?:Vars|Consts)\(\{ ([^}]+) \}\)/.exec(tokenSource)
const overlaySource = await Bun.file(new URL("../features/workbench/Overlay.tsx", import.meta.url)).text()
const settingsSource = await Bun.file(new URL("../features/workbench/SettingsRail.tsx", import.meta.url)).text()
const sessionsSource = await Bun.file(new URL("../features/workbench/SessionsRail.tsx", import.meta.url)).text()

test("component radius roles stay minimal and ordered", () => {
  expect(declaration, "the radius scale is declared inline").not.toBeNull()
  const values = new Map(
    [...declaration![1]!.matchAll(/(\w+): "([^"]+)"/g)].map((match) => [match[1]!, match[2]!]),
  )

  expect(values.get("sm")).toBe("1px")
  expect(values.get("md")).toBe("2px")
  expect(values.get("lg")).toBe("4px")
  expect(values.get("pill")).toBe("999px")
})

const renderer = new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
const PILL_RADIUS = /borderRadius:\s*radius\.pill/
const STYLE_KEY = /^\s{2}([a-zA-Z][\w]*):\s*\{/

/** The complete roster of shapes that communicate by being circular. */
const CIRCLES = [
  "features/workbench/TabStrip.tsx#dot",
  "theme/spinners.ts#running",
  "features/conversation/ThinkingStep.tsx#dot",
  "features/conversation/QuestionTray.tsx#radio",
  "features/conversation/QuestionTray.tsx#radioDot",
]

test("pill radius is reserved for true circles", async () => {
  const found: string[] = []
  for await (const relative of new Glob("**/*.{ts,tsx}").scan({ cwd: renderer })) {
    if (relative.endsWith(".test.ts") || relative.endsWith(".test.tsx")) continue
    const lines = (await Bun.file(`${renderer}${relative}`).text()).split("\n")
    lines.forEach((line, index) => {
      if (!PILL_RADIUS.test(line)) return
      for (let at = index; at >= 0; at -= 1) {
        const key = STYLE_KEY.exec(lines[at]!)
        if (key !== null) {
          found.push(`${relative.replace(/\\/g, "/")}#${key[1]!}`)
          return
        }
      }
    })
  }

  expect(found.sort()).toEqual([...CIRCLES].sort())
})

/** Card-level surfaces share the quiet 4px seat; controls and wells stay tighter. */
const CARDS = [
  "features/conversation/ApprovalTray.tsx#card",
  "features/conversation/Composer.tsx#composer",
  "features/conversation/Composer.tsx#menu",
  "features/conversation/QuestionTray.tsx#card",
  "features/conversation/Timeline.tsx#banner",
  "features/conversation/Timeline.tsx#errorBlock",
  "features/conversation/Timeline.tsx#notice",
  "features/workbench/Overlay.tsx#modal",
  "features/workbench/SessionsRail.tsx#empty",
  "features/workbench/SettingsRail.tsx#issueDisclosure",
  "features/workbench/SettingsRail.tsx#previewCard",
  "features/workbench/SettingsRail.tsx#resourceCard",
  "features/workbench/SettingsRail.tsx#resourceEmpty",
  "features/workbench/SettingsRail.tsx#themeTile",
  "features/workbench/Workbench.tsx#notice",
] as const

test("card surfaces use the minimal card radius", async () => {
  for (const card of CARDS) {
    const [relative, key] = card.split("#") as [string, string]
    const source = await Bun.file(`${renderer}${relative}`).text()
    const start = source.search(new RegExp(`^  ${key}:\\s*\\{`, "m"))
    expect(start, `${card} exists`).toBeGreaterThanOrEqual(0)
    const rest = source.slice(start)
    const next = rest.slice(1).search(/^  [a-zA-Z][\w]*:\s*\{/m)
    const block = next < 0 ? rest : rest.slice(0, next + 1)
    expect(block, `${card} uses radius.lg`).toContain("borderRadius: radius.lg")
  }
})

test("interactive surfaces use the minimal focus state instead of rings", async () => {
  const sharedFocus = await Bun.file(`${renderer}theme/focus.ts`).text()
  const missing: string[] = []
  const rings: string[] = []
  for await (const relative of new Glob("**/*.tsx").scan({ cwd: renderer })) {
    if (relative.endsWith(".test.tsx")) continue
    const source = await Bun.file(`${renderer}${relative}`).text()
    if (!/<(?:a|button|input|select|summary|textarea)\b/.test(source)) continue
    const usesSharedFocus = source.includes("/theme/focus.ts\"") && source.includes("focus.")
    if (!source.includes("effects.focusState") && !usesSharedFocus) missing.push(relative.replace(/\\/g, "/"))
    if (/outline(?:Color|Offset|Style|Width):/.test(source)) rings.push(relative.replace(/\\/g, "/"))
  }

  expect(missing).toEqual([])
  expect(rings).toEqual([])
  expect(sharedFocus).toContain("effects.focusState")
  expect(tokenSource.match(/\bfocusState:/g)).toHaveLength(3)
})

test("settings and sessions use the shared workspace modal", () => {
  expect(settingsSource).toContain('<Modal id="settings-modal"')
  expect(settingsSource).toContain("wide contained")
  expect(settingsSource).not.toContain('id="settings-panel-sessions"')
  expect(sessionsSource).toContain('<Modal id="sessions-modal"')
  expect(overlaySource).toContain('role="dialog"')
  expect(overlaySource).toContain('aria-modal="true"')
  expect(overlaySource).toContain("styles.scrim")
  expect(overlaySource).not.toContain("export const Drawer")
  expect(overlaySource).toContain("modalScrim: { insetBlockStart: 0, zIndex: 50")
})
