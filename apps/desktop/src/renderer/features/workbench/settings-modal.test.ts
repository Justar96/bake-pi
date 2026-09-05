import { expect, test } from "bun:test"

const settingsSource = await Bun.file(new URL("./SettingsRail.tsx", import.meta.url)).text()
const piSettingsSource = await Bun.file(new URL("./PiSettings.tsx", import.meta.url)).text()

test("settings mounts only the active tab panel and resets its viewport", () => {
  expect(settingsSource.match(/role="tabpanel"/g)).toHaveLength(1)
  expect(settingsSource).toContain("key={active}")
  expect(settingsSource).toContain('id={`settings-panel-${active}`}')
  expect(settingsSource).toContain("body.current?.scrollTo({ top: 0 })")
  expect(settingsSource).not.toContain("hidden={active !== section.id}")
})

test("Pi-backed sections share one snapshot for the modal lifetime", () => {
  expect(settingsSource).toContain("usePiSettingsController(active ===")
  expect(settingsSource.match(/controller=\{piSettings\}/g)).toHaveLength(3)
  expect(piSettingsSource.match(/store\.getPiSettings\(\)/g)).toHaveLength(1)
  expect(piSettingsSource).not.toContain("setSettings(undefined)")
  expect(piSettingsSource).toContain("styles.skeletonRows")
})

/**
 * The header is the section's heading, and nothing but the heading. A panel
 * that titled itself again put a third heading level under a header that
 * already named the section and the index that already highlighted it, so
 * these assert the absence rather than the presence: no `h3` anywhere in the
 * modal, no eyebrow or lede in the header — the eyebrow sits over the index,
 * and the group titles say what a lede used to — and one group treatment for
 * the level that remains.
 */
test("the modal header is the section's heading, and no panel repeats it", () => {
  expect(settingsSource).toContain("title={current.label}")
  expect(settingsSource).not.toContain("subtitle=")
  expect(settingsSource).not.toContain('eyebrow="Settings"')
  expect(settingsSource).toContain("styles.indexEyebrow")
  expect(settingsSource).toContain("SECTION_GROUPS.map(")
  expect(settingsSource).not.toMatch(/<h3\b/)
  expect(piSettingsSource).not.toMatch(/<h3\b/)
  expect(settingsSource).not.toContain("overlay.groupLabel")
  expect(piSettingsSource).toContain("export const SettingsGroupHead")
  // Seven in the sections this file owns outright, plus the workspace-permission
  // group Privacy stacks above Pi's own panel.
  expect(settingsSource.match(/<SettingsGroupHead\b/g)).toHaveLength(8)
})

test("one refresh control acts on the whole section, from the header", () => {
  // The header's control, and the status line's own spinner. Nothing else.
  expect(settingsSource.match(/<RefreshCw\b/g)).toHaveLength(2)
  // Pi's panel keeps one, in the first-load skeleton it is the only content of.
  expect(piSettingsSource.match(/<RefreshCw\b/g)).toHaveLength(1)
  expect(settingsSource).toContain('refresh.busy ? "Refreshing…" : refresh.label')
  expect(settingsSource).toContain('case "providers": case "appearance": return undefined')
  expect(settingsSource).not.toContain("styles.diagnosticsError")
})

/**
 * The status is a toast in the layout's corner, shown only while there is
 * something to say. It used to be a line at the top of every panel that
 * reserved its height and, at rest, explained where saves go — a sentence
 * read once and paid for on every visit.
 */
test("a section reports through one status toast that floats over the panel", () => {
  expect(settingsSource.match(/const SectionStatusLine\b/g)).toHaveLength(1)
  expect(settingsSource).toMatch(/status: \{\s*\n\s*position: "absolute"/)
  expect(settingsSource).not.toContain("Changes are written to Pi’s global settings.")
  expect(settingsSource).not.toContain('tone: "idle"')
  expect(settingsSource).toContain("Existing results are unchanged.")
  expect(settingsSource).toContain('pi.notice.area === section')
  expect(piSettingsSource).not.toContain("styles.notice")
})

test("refreshing replaces content in place rather than emptying it", () => {
  expect(settingsSource).toContain("aria-busy={controller.refreshing || controller.checking || controller.updating}")
  expect(settingsSource).toContain("<FactSkeleton rows={5} />")
  expect(settingsSource).toContain("<FactSkeleton rows={3} />")
  expect(settingsSource).not.toMatch(/styles\.quiet\)}>Loading/)
})

/**
 * A one-line field saves on commit — Enter or blur — like the switch and the
 * select beside it. The filled Save that used to sit on every text row was
 * the heaviest element on the panel for the action pressed least; only the
 * multi-line fields keep one, and only once there is something to save.
 */
test("single-line settings fields commit on blur and Enter, with no Save button", () => {
  expect(piSettingsSource).not.toContain("styles.saveIcon")
  expect(piSettingsSource.match(/onBlur=\{commit\}/g)).toHaveLength(2)
  expect(piSettingsSource.match(/\{changed \? <button type="submit"/g)).toHaveLength(2)
})

test("settings textareas use the shared clean overflow treatment", () => {
  expect(piSettingsSource.match(/<textarea\b/g)).toHaveLength(2)
  expect(piSettingsSource.match(/stylex\.props\(scrollbars\.thin, focus\.ring, styles\.textarea/g)).toHaveLength(2)
  expect(piSettingsSource).toContain('overflowY: "auto", scrollbarGutter: "stable", resize: "vertical"')
  expect(piSettingsSource).toContain('aria-invalid={error !== undefined}')
})
