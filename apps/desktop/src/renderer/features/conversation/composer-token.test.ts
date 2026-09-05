import { describe, expect, test } from "bun:test"
import { insertFileMention, tokenAt, workspaceRelativePath } from "./composer-token.ts"

/**
 * What opens a menu over the prompt bar, and what must not.
 *
 * The parser runs on every keystroke and on every caret move, and it decides
 * whether the next Enter sends the message or picks a row. Getting that wrong
 * in either direction is worse than having no menu: a mention the parser misses
 * leaves a person typing a path by hand, and a mention it invents swallows the
 * Enter that was meant to send.
 *
 * The cases here are the ones prose actually produces. Slashes in particular
 * are everywhere in a coding conversation — paths, dates, and/or — and none of
 * them are commands.
 */

describe("a mention opens where one was typed", () => {
  test("an @ at the start of an empty draft", () => {
    expect(tokenAt("@", 1)).toEqual({ kind: "file", start: 0, query: "" })
  })

  test("an @ after a word, carrying what has been typed since", () => {
    expect(tokenAt("look at @src/ma", 15)).toEqual({ kind: "file", start: 8, query: "src/ma" })
  })

  test("a slash at the very start", () => {
    expect(tokenAt("/comp", 5)).toEqual({ kind: "command", start: 0, query: "comp" })
  })
})

describe("the caret decides, not the end of the draft", () => {
  /**
   * Going back to add a reference mid-sentence is the ordinary thing to do. A
   * parser reading the tail would find nothing here and leave the menu shut.
   */
  test("a mention before the caret opens even with text after it", () => {
    expect(tokenAt("check @src and then stop", 10)).toEqual({ kind: "file", start: 6, query: "src" })
  })

  test("a mention the caret has moved past is not open", () => {
    expect(tokenAt("check @src and then stop", 24)).toBeUndefined()
  })
})

describe("what is not a mention", () => {
  test("a slash anywhere but the start, because a command is the whole message", () => {
    expect(tokenAt("compare a /b", 12)).toBeUndefined()
    expect(tokenAt("and/or", 6)).toBeUndefined()
  })

  test("an email address, which is an @ nobody typed as a mention", () => {
    expect(tokenAt("mail ada@example.com", 20)).toBeUndefined()
  })

  test("a mention that has been finished with a space", () => {
    expect(tokenAt("@src/main.ts ", 13)).toBeUndefined()
  })

  test("ordinary prose", () => {
    expect(tokenAt("summarize the last turn", 23)).toBeUndefined()
  })
})

describe("a file dropped from the tree", () => {
  test("uses a workspace-relative path with message separators", () => {
    expect(workspaceRelativePath("C:\\project", "C:\\project\\src\\main.ts")).toBe("src/main.ts")
    expect(insertFileMention("Review ", 7, 7, "C:\\project", "C:\\project\\src\\main.ts")).toEqual({
      text: "Review @src/main.ts ",
      caret: 20,
    })
  })

  test("replaces the textarea selection and leaves the caret after the mention", () => {
    expect(insertFileMention("Review this today", 7, 11, "/project", "/project/src/main.ts")).toEqual({
      text: "Review @src/main.ts  today",
      caret: 20,
    })
  })
})
