import type { UrlTransform } from "react-markdown"

const INLINE_MARKDOWN_MARKER = /[\n\\`*_\[\]<>#&~@]/u
const BLOCK_MARKDOWN_MARKER = /^(?: {4}|\t|\s*(?:[-+>] |\d+[.)] |-{3,}\s*$))/u
const AUTOLINK_MARKER = /(?:https?:\/\/|www\.)/iu

/** Avoids a full GFM parse only when the result is certainly one paragraph. */
export const canRenderMarkdownAsPlainText = (text: string): boolean =>
  text.trim().length > 0 &&
  !INLINE_MARKDOWN_MARKER.test(text) &&
  !BLOCK_MARKDOWN_MARKER.test(text) &&
  !AUTOLINK_MARKER.test(text)

/** Model-authored URLs are data, so only explicit web links survive parsing. */
export const safeMarkdownUrl: UrlTransform = (url) => {
  if (url.startsWith("#")) return url
  try {
    const parsed = new URL(url)
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : ""
  } catch {
    return ""
  }
}

export const markdownDisallowedElements = ["img"]
export const markdownLinkProps = { target: "_blank", rel: "noreferrer" } as const
