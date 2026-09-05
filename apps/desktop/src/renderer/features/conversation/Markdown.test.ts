import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ReactMarkdown from "react-markdown"
import { canRenderMarkdownAsPlainText, markdownDisallowedElements, markdownLinkProps, safeMarkdownUrl } from "./markdown-policy.ts"

describe("model markdown links", () => {
  test("bypasses parsing only for text that is certainly one plain paragraph", () => {
    expect(canRenderMarkdownAsPlainText("An ordinary sentence (with punctuation).")).toBe(true)
    for (const text of [
      "", "two\nparagraphs", "**bold**", "[link](https://example.com)", "<b>html</b>",
      "https://example.com", "person@example.com", "- list", "1. ordered", "> quote", "---",
      "    indented code", "entity &amp;",
    ]) expect(canRenderMarkdownAsPlainText(text)).toBe(false)
  })

  test("allows web and local-fragment links", () => {
    expect(safeMarkdownUrl("https://example.com/path", "", {} as never)).toBe("https://example.com/path")
    expect(safeMarkdownUrl("#section", "", {} as never)).toBe("#section")
  })

  test("rejects executable, embedded, file, and app-protocol URLs", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,boom", "file:///secret", "bakepi://image/x"] as const) {
      expect(safeMarkdownUrl(url, "", {} as never)).toBe("")
    }
  })

  test("renders hostile model content without HTML, images, SVG, or executable links", () => {
    const html = renderToStaticMarkup(createElement(ReactMarkdown, {
      skipHtml: true,
      disallowedElements: markdownDisallowedElements,
      urlTransform: safeMarkdownUrl,
      children: '<script>alert(1)</script><img src="javascript:alert(2)">[run](javascript:alert(3))<svg onload="alert(4)"></svg>',
    }))

    expect(html).not.toContain("<script")
    expect(html).not.toContain("<img")
    expect(html).not.toContain("<svg")
    expect(html).not.toContain("javascript:")
    expect(html).not.toContain("onload")
  })

  test("marks external web links for isolated navigation", () => {
    expect(markdownLinkProps).toEqual({ target: "_blank", rel: "noreferrer" })
  })
})
