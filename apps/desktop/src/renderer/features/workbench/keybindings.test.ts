import { expect, test } from "bun:test"
import { matchCommand, parseChord, WORKBENCH_COMMANDS, type ChordEvent } from "./keybindings.ts"

/**
 * The registry's non-conflict rules, held as tests rather than as review.
 * The four rules are stated at the top of `keybindings.ts`; what lives here
 * is the proof that no edit quietly breaks one — a second command on a chord,
 * a bare letter, a modifier that drifts out of the canonical order.
 */

const chord = (key: string, modifiers: Partial<ChordEvent> = {}): ChordEvent => ({
  key,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...modifiers,
})

test("every command has a unique id and something to say", () => {
  const ids = WORKBENCH_COMMANDS.map((command) => command.id)
  expect(new Set(ids).size).toBe(ids.length)
  for (const command of WORKBENCH_COMMANDS) {
    expect(command.title.trim().length, `${command.id} has a title`).toBeGreaterThan(0)
    expect(command.group.trim().length, `${command.id} has a group`).toBeGreaterThan(0)
  }
})

test("no two commands share a chord", () => {
  const seen = new Map<string, string>()
  for (const command of WORKBENCH_COMMANDS) {
    for (const keys of command.keys) {
      const normalized = parseChord(keys)
      expect(seen.has(normalized), `${normalized} is bound by both ${seen.get(normalized) ?? "?"} and ${command.id}`).toBe(false)
      seen.set(normalized, command.id)
    }
  }
})

test("no chord is a bare key — text fields own those", () => {
  for (const command of WORKBENCH_COMMANDS) {
    for (const keys of command.keys) {
      const parts = parseChord(keys).split("+")
      expect(parts.length, `${command.id}'s ${keys} carries a modifier`).toBeGreaterThan(1)
    }
  }
})

test("no chord is Alt without Ctrl — bare Alt is the window's mnemonic layer", () => {
  for (const command of WORKBENCH_COMMANDS) {
    for (const keys of command.keys) {
      const parts = parseChord(keys).split("+")
      if (parts.includes("alt")) expect(parts, `${command.id}'s ${keys} rides with Ctrl`).toContain("ctrl")
    }
  }
})

test("chords normalise to one canonical form in VS Code's display order", () => {
  expect(parseChord("Ctrl+K")).toBe("ctrl+k")
  expect(parseChord("CTRL+SHIFT+P")).toBe("ctrl+shift+p")
  expect(parseChord("Alt+Ctrl+B")).toBe("ctrl+alt+b")
  expect(parseChord("Ctrl+,")).toBe("ctrl+,")
  expect(parseChord("Cmd+K")).toBe("ctrl+k")
})

test("the matcher fires on the exact chord and on nothing near it", () => {
  const palette = WORKBENCH_COMMANDS.find((command) => command.id === "view.palette")
  expect(matchCommand(chord("k", { ctrlKey: true }), WORKBENCH_COMMANDS)).toBe(palette)
  expect(matchCommand(chord("K", { ctrlKey: true }), WORKBENCH_COMMANDS)).toBe(palette)
  expect(matchCommand(chord("p", { ctrlKey: true, shiftKey: true }), WORKBENCH_COMMANDS)).toBe(palette)
  // A bare key is nobody's command.
  expect(matchCommand(chord("k"), WORKBENCH_COMMANDS)).toBeUndefined()
  // Extra modifiers are a different chord, not a weaker match.
  expect(matchCommand(chord("k", { ctrlKey: true, shiftKey: true }), WORKBENCH_COMMANDS)).toBeUndefined()
  expect(matchCommand(chord("k", { ctrlKey: true, altKey: true }), WORKBENCH_COMMANDS)).toBeUndefined()
  // A modifier press on its own is not a chord.
  expect(matchCommand(chord("Control", { ctrlKey: true }), WORKBENCH_COMMANDS)).toBeUndefined()
  // macOS reflexes count as Ctrl.
  expect(matchCommand(chord("b", { metaKey: true }), WORKBENCH_COMMANDS)?.id).toBe("view.files")
})

test("the bindings keep their VS Code meanings, pinned so a drift is a red diff", () => {
  const bindings = Object.fromEntries(
    WORKBENCH_COMMANDS.filter((command) => command.keys.length > 0).map((command) => [command.id, command.keys]),
  )
  expect(bindings).toEqual({
    "session.new": ["Ctrl+N"],
    "view.palette": ["Ctrl+K", "Ctrl+Shift+P"],
    "view.files": ["Ctrl+B"],
    "view.activity": ["Ctrl+Alt+B"],
    "view.settings": ["Ctrl+,"],
  })
})
