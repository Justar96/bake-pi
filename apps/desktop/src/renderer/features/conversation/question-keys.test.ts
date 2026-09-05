import { describe, expect, test } from "bun:test"
import { answersOnEnter, optionKeyTarget, optionShortcut } from "./question-keys.ts"

describe("moving through a question's options", () => {
  test("arrows step and wrap, the way a native radio group does", () => {
    expect(optionKeyTarget("ArrowDown", 0, 3)).toBe(1)
    expect(optionKeyTarget("ArrowDown", 2, 3)).toBe(0)
    expect(optionKeyTarget("ArrowUp", 0, 3)).toBe(2)
    expect(optionKeyTarget("ArrowRight", 1, 3)).toBe(2)
    expect(optionKeyTarget("ArrowLeft", 1, 3)).toBe(0)
  })

  test("Home and End are the ends of the list", () => {
    expect(optionKeyTarget("Home", 2, 3)).toBe(0)
    expect(optionKeyTarget("End", 0, 3)).toBe(2)
  })

  test("a digit is the row it is drawn on", () => {
    expect(optionKeyTarget("2", 0, 3)).toBe(1)
    expect(optionKeyTarget("1", 2, 3)).toBe(0)
  })

  test("a digit past the end of the list is not this group's key", () => {
    // It has to fall through: the window's own bindings are behind this
    // handler, and swallowing "4" on a three-option question would make the
    // card a keyboard trap for the shortcuts it does not use.
    expect(optionKeyTarget("4", 0, 3)).toBeUndefined()
    expect(optionKeyTarget("0", 0, 3)).toBeUndefined()
  })

  test("keys that are not movement are left alone", () => {
    expect(optionKeyTarget("Enter", 0, 3)).toBeUndefined()
    expect(optionKeyTarget("Escape", 0, 3)).toBeUndefined()
    expect(optionKeyTarget("Tab", 0, 3)).toBeUndefined()
    expect(optionKeyTarget(" ", 0, 3)).toBeUndefined()
    expect(optionKeyTarget("a", 0, 3)).toBeUndefined()
  })

  test("an empty group has nowhere to move", () => {
    // The contract's `minItems: 1` says this cannot arrive, and the modulo
    // below it would divide by zero if it did.
    expect(optionKeyTarget("ArrowDown", 0, 0)).toBeUndefined()
    expect(optionKeyTarget("End", 0, 0)).toBeUndefined()
  })

  test("a single option is its own neighbour in both directions", () => {
    expect(optionKeyTarget("ArrowDown", 0, 1)).toBe(0)
    expect(optionKeyTarget("ArrowUp", 0, 1)).toBe(0)
  })
})

describe("the digit drawn on an option", () => {
  test("is the row's number for the first nine", () => {
    expect(optionShortcut(0)).toBe("1")
    expect(optionShortcut(8)).toBe("9")
  })

  test("stops where a single key press stops", () => {
    // The contract allows 64 options. The tenth row has no hint and is still
    // reachable by arrow.
    expect(optionShortcut(9)).toBeUndefined()
    expect(optionShortcut(63)).toBeUndefined()
  })
})

describe("which Enter sends the answer", () => {
  test("is the bare one everywhere the answer is not a document", () => {
    expect(answersOnEnter("select", false)).toBe(true)
    expect(answersOnEnter("confirm", false)).toBe(true)
    expect(answersOnEnter("input", false)).toBe(true)
  })

  test("is the modified one in the editor, where Enter is a line break", () => {
    expect(answersOnEnter("editor", true)).toBe(true)
    expect(answersOnEnter("editor", false)).toBe(false)
  })

  test("does not fire twice when a modifier is held on the others", () => {
    // Ctrl+Enter in a one-line field is not a second send; the plain press
    // already sent it, and treating both as a send would answer the next
    // question with the same key press.
    expect(answersOnEnter("input", true)).toBe(false)
    expect(answersOnEnter("select", true)).toBe(false)
  })
})
