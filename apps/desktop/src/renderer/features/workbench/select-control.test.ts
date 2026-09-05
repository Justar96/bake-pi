import { describe, expect, test } from "bun:test"

const root = import.meta.dir.replaceAll("\\", "/")
const selectSource = await Bun.file(`${root}/SelectControl.tsx`).text()
const piSettingsSource = await Bun.file(`${root}/PiSettings.tsx`).text()
const settingsSource = await Bun.file(`${root}/SettingsRail.tsx`).text()
const workspaceSource = await Bun.file(`${root}/WorkspaceDialog.tsx`).text()
const manifest = await Bun.file(`${root}/../../../../package.json`).json() as { dependencies: Record<string, string> }

/**
 * The select is a listbox of our own, and these assert what it kept from the
 * native control it replaced: one trigger, one list, the platform's dismissal
 * and focus return through `popover="auto"`, and a position that comes from
 * the invoker's implicit anchor rather than a measured inline style this
 * renderer's CSP would refuse.
 */
describe("modal select controls", () => {
  test("are a popover listbox hung from its trigger by anchor positioning", () => {
    expect(selectSource).not.toMatch(/<select\s/)
    expect(selectSource.match(/role="listbox"/g)).toHaveLength(1)
    expect(selectSource).toContain('popover="auto"')
    expect(selectSource).toContain("popoverTarget={listId}")
    expect(selectSource).toContain('aria-haspopup="listbox"')
    expect(selectSource).toContain('insetBlockStart: `anchor(bottom)`')
    expect(selectSource).toContain('minWidth: "anchor-size(width)"')
    expect(selectSource).toContain('positionTryFallbacks: "flip-block"')
    expect(selectSource).not.toMatch(/\bstyle=\{/)
    expect(selectSource).toContain("focus.ring")
  })

  test("move focus through the rows and open on the chosen one", () => {
    expect(selectSource).toContain('event.key === "ArrowDown" || event.key === "ArrowUp"')
    expect(selectSource).toContain('event.key === "Home"')
    expect(selectSource).toContain('event.key === "End"')
    expect(selectSource).toContain("rows()[current < 0 ? 0 : current]")
    expect(selectSource).toContain('row?.scrollIntoView({ block: "center" })')
    expect(selectSource).toContain("tabIndex={-1}")
  })

  test("use the bundled Heroicons indicator as inert decoration", () => {
    expect(manifest.dependencies["@heroicons/react"]).toBe("2.2.0")
    expect(selectSource).toContain('from "@heroicons/react/20/solid"')
    expect(selectSource).toContain('<ChevronUpDownIcon aria-hidden="true"')
    expect(selectSource.match(/pointerEvents: "none"/g)).toHaveLength(2)
  })

  test("carry a mark on every row and on the trigger while chosen, never announced", () => {
    expect(selectSource).toContain("glyph?: React.JSX.Element | null")
    expect(selectSource.match(/<span aria-hidden="true" \{\.\.\.stylex\.props\(styles\.glyph\)\}>/g)).toHaveLength(2)
    // Every model row wears its lab's mark and names its provider as the hint;
    // every provider row wears the provider's mark.
    expect(piSettingsSource).toContain("const modelOption = (model: Model): SelectOption =>")
    expect(piSettingsSource).toContain("glyph: <LabIcon mark={labMarkForModel(")
    expect(settingsSource).toContain("glyph: <LabIcon mark={labMarkForProvider(provider.id)}")
  })

  test("route every modal dropdown through the shared control", () => {
    expect(piSettingsSource).not.toMatch(/<select\b|<option\b/)
    expect(settingsSource).not.toMatch(/<select\b|<option\b/)
    expect(workspaceSource).not.toMatch(/<select\b|<option\b/)
    expect(piSettingsSource).toContain("<SelectControl")
    expect(settingsSource).toContain("<SelectControl")
    expect(workspaceSource).toContain("<SelectControl")
  })
})
