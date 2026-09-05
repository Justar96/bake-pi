import { useEffect, useState } from "react"
import { createHighlighterCore, type HighlighterCore } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import type { Appearance } from "../../theme/appearance.ts"
import { CODE_THEMES } from "./code-theme.ts"

/**
 * Syntax highlighting that never reaches the Content Security Policy.
 *
 * Shiki's own `codeToHtml`, and every renderer built on it — `@pierre/diffs`
 * included — produce an HTML string carrying `style="color:#…"` on each token
 * and hand it to the parser through `innerHTML`. CSP's `style-src` governs
 * exactly that: attributes the *parser* creates. Without `'unsafe-inline'` the
 * declaration is dropped and the code renders monochrome, and the `<style>`
 * elements those renderers emit for layout are dropped with it.
 *
 * So this module stops at tokens and lets React apply the colour through the
 * `style` prop, which is a CSSOM write. CSP does not police CSSOM — that is
 * script doing script things, already gated by `script-src` — so the strict
 * policy in `main/security/csp.ts` survives intact, and StyleX keeps buying
 * the property it was adopted for.
 *
 * A nonce would not have rescued the alternative: nonces apply to `<style>`
 * *elements*, and half the problem is attributes, for which no nonce mechanism
 * exists.
 */
export interface Token {
  text: string
  color: string | undefined
  bold: boolean
  italic: boolean
  underline: boolean
}

/** Beyond these limits plain text is more useful than a long renderer stall. */
export const MAX_HIGHLIGHT_CHARACTERS = 100_000
export const MAX_HIGHLIGHT_LINES = 2_000

export const shouldHighlight = (code: string): boolean => {
  if (code.length > MAX_HIGHLIGHT_CHARACTERS) return false
  let lines = 1
  for (let offset = code.indexOf("\n"); offset !== -1; offset = code.indexOf("\n", offset + 1)) {
    lines += 1
    if (lines > MAX_HIGHLIGHT_LINES) return false
  }
  return true
}

interface CacheEntry<Value> {
  value: Value
  characters: number
}

/** A source-weighted LRU so tokens cannot keep every viewed file alive. */
export class HighlightCache<Value> {
  readonly #entries = new Map<string, CacheEntry<Value>>()
  readonly #maxEntries: number
  readonly #maxCharacters: number
  #characters = 0

  constructor(maxEntries: number, maxCharacters: number) {
    this.#maxEntries = maxEntries
    this.#maxCharacters = maxCharacters
  }

  get(key: string): Value | undefined {
    const entry = this.#entries.get(key)
    if (entry === undefined) return undefined
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: Value, characters: number): void {
    if (characters > this.#maxCharacters) return
    this.delete(key)
    this.#entries.set(key, { value, characters })
    this.#characters += characters
    while (this.#entries.size > this.#maxEntries || this.#characters > this.#maxCharacters) {
      const oldest = this.#entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.delete(oldest)
    }
  }

  delete(key: string, expected?: Value): void {
    const entry = this.#entries.get(key)
    if (entry === undefined || (expected !== undefined && entry.value !== expected)) return
    this.#entries.delete(key)
    this.#characters -= entry.characters
  }
}

/** Shiki's `FontStyle` is a bitmask; these are the bits it sets. */
const ITALIC = 1
const BOLD = 2
const UNDERLINE = 4

/**
 * Every language the workbench can highlight, each behind its own dynamic
 * import so the bundler emits it as a separate chunk.
 *
 * Written out rather than computed as `import(`shiki/langs/${name}.mjs`)`,
 * which reads better and would be a mistake: a template-literal specifier
 * forces the bundler to include every file the pattern could match — some two
 * hundred grammars — in the renderer bundle, against a cold-start budget of
 * 2.5 seconds. An unlisted language renders as plain text, which is the right
 * failure: legible, just uncoloured.
 */
const LANGUAGES: Record<string, () => Promise<unknown>> = {
  bash: () => import("shiki/langs/bash.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
}

/** What a fence or a file extension might say, mapped onto a grammar above. */
const ALIASES: Record<string, string> = {
  cc: "cpp", cs: "csharp", "c++": "cpp", cjs: "javascript", cts: "typescript",
  golang: "go", h: "c", hpp: "cpp", htm: "html", js: "javascript",
  jsonc: "json", kt: "java", md: "markdown", mjs: "javascript", mts: "typescript",
  patch: "diff", ps1: "powershell", py: "python", rb: "ruby", rs: "rust",
  sh: "bash", shell: "bash", shellscript: "bash", ts: "typescript", yml: "yaml",
  zsh: "bash",
}

export const resolveLanguage = (name: string | undefined): string | undefined => {
  if (name === undefined) return undefined
  const lower = name.trim().toLowerCase()
  const resolved = ALIASES[lower] ?? lower
  return resolved in LANGUAGES ? resolved : undefined
}

const EXTENSIONS: Record<string, string> = {
  bash: "bash", c: "c", cc: "cpp", cjs: "javascript", cpp: "cpp", cs: "csharp",
  css: "css", cts: "typescript", diff: "diff", go: "go", h: "c", hpp: "cpp",
  htm: "html", html: "html", java: "java", js: "javascript", json: "json",
  jsonc: "json", jsx: "jsx", md: "markdown", mjs: "javascript", mts: "typescript",
  patch: "diff", php: "php", ps1: "powershell", py: "python", rb: "ruby",
  rs: "rust", sh: "bash", sql: "sql", toml: "toml", ts: "typescript",
  tsx: "tsx", xml: "xml", yaml: "yaml", yml: "yaml", zsh: "bash",
}

export const languageForFile = (fileName: string): string | undefined => {
  const base = fileName.split(/[\\/]/).pop() ?? fileName
  const dot = base.lastIndexOf(".")
  if (dot < 1) return undefined
  return resolveLanguage(EXTENSIONS[base.slice(dot + 1).toLowerCase()])
}

let highlighter: HighlighterCore | undefined
let starting: Promise<HighlighterCore> | undefined
const loaded = new Set<string>()
const tokenCache = new HighlightCache<Promise<Token[][]>>(8, 300_000)

/**
 * One highlighter for the window, grown as languages and themes are asked for.
 *
 * The JavaScript regex engine is chosen over the Oniguruma one deliberately.
 * Oniguruma is WebAssembly, and instantiating it would require
 * `'wasm-unsafe-eval'` in `script-src` — the one directive this whole module
 * exists to leave alone.
 */
const shared = async (): Promise<HighlighterCore> => {
  starting ??= createHighlighterCore({ themes: [], langs: [], engine: createJavaScriptRegexEngine() })
  highlighter = await starting
  return highlighter
}

/**
 * The grammar and the theme this call needs, loaded if they are not already.
 *
 * Grammars are dynamic imports and themes are not, which is the difference in
 * their sizes: a grammar is a package and there are two dozen of them, while
 * the three themes in `code-theme.ts` are plain objects the bundle carries for
 * nothing. Both are still loaded lazily — a theme the person never selects is
 * never registered with the highlighter — and `loaded` is keyed by name across
 * both kinds, which is safe because a theme name and a language id cannot
 * collide: the themes are all prefixed `bakepi-`.
 */
const ensure = async (language: string, appearance: Appearance): Promise<HighlighterCore> => {
  const core = await shared()
  const theme = CODE_THEMES[appearance]
  if (!loaded.has(theme.name)) {
    await core.loadTheme(theme)
    loaded.add(theme.name)
  }
  if (!loaded.has(language)) {
    await core.loadLanguage((await LANGUAGES[language]!()) as Parameters<HighlighterCore["loadLanguage"]>[0])
    loaded.add(language)
  }
  return core
}

export const tokenize = (code: string, language: string, appearance: Appearance): Promise<Token[][] | undefined> => {
  if (!shouldHighlight(code)) return Promise.resolve(undefined)

  const key = `${appearance}\u0000${language}\u0000${code}`
  const cached = tokenCache.get(key)
  if (cached !== undefined) return cached

  const work = ensure(language, appearance).then((core) => {
    const { tokens } = core.codeToTokens(code, { lang: language, theme: CODE_THEMES[appearance].name })
    return tokens.map((line) =>
      line.map((token) => ({
        text: token.content,
        color: token.color,
        bold: ((token.fontStyle ?? 0) & BOLD) !== 0,
        italic: ((token.fontStyle ?? 0) & ITALIC) !== 0,
        underline: ((token.fontStyle ?? 0) & UNDERLINE) !== 0,
      })),
    )
  })
  tokenCache.set(key, work, code.length)
  void work.catch(() => tokenCache.delete(key, work))
  return work
}

/**
 * Tokens for a block of code, or `undefined` until they arrive.
 *
 * Highlighting is asynchronous because grammars and themes are fetched on
 * first use, so every caller has to be able to draw the plain text meanwhile.
 * That is not only a loading state: it is also the permanent answer for an
 * unlisted language, and the answer whenever tokenization throws — a grammar
 * that fails on pathological input must cost the reader colour, never the
 * content.
 */
export const useTokens = (code: string, language: string | undefined, appearance: Appearance): Token[][] | undefined => {
  const [tokens, setTokens] = useState<Token[][]>()

  useEffect(() => {
    if (language === undefined || !shouldHighlight(code)) {
      setTokens(undefined)
      return
    }
    let current = true
    tokenize(code, language, appearance)
      .then((next) => { if (current) setTokens(next) })
      .catch(() => { if (current) setTokens(undefined) })
    return () => { current = false }
  }, [code, language, appearance])

  return language === undefined || !shouldHighlight(code) ? undefined : tokens
}
