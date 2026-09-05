import { LAB_ARTWORK, type LabArtwork } from "./lab-artwork.ts"

/**
 * Which lab mark stands for a provider, and which for a model.
 *
 * Two questions rather than one, because the two answers differ often enough to
 * matter: OpenRouter, Bedrock, Together, Vercel and the gateways all serve
 * other labs' models, so a row for `claude-sonnet-5` on OpenRouter is about
 * Anthropic and only incidentally about OpenRouter. A picker whose rows all
 * carried the same gateway mark would have spent a glyph to say nothing, which
 * is the one thing a glyph must never do.
 *
 * The tables below are the only place a brand is tied to an id. They are
 * matched, never assumed: an id neither table knows resolves to `undefined`,
 * and every surface falls back to the plain glyph it drew before.
 */

/**
 * Provider id → mark, matched on the longest prefix.
 *
 * Prefixes rather than exact ids because Pi ships one provider per plan and
 * region: `qwen-token-plan`, `qwen-token-plan-individual` and
 * `qwen-token-plan-cn` are three ids for one lab, and `xiaomi` has four. A
 * table of exact ids would be four entries deep per lab and would still go
 * stale the next time a region is added.
 *
 * Longest match wins, which is what keeps the overlaps honest:
 * `cloudflare-workers-ai` is Workers AI rather than Cloudflare, `openai-codex`
 * is Codex rather than OpenAI, and `anthropic` is Anthropic rather than the
 * `ant-ling` it shares three letters with.
 */
const BY_PROVIDER: Record<string, string> = {
  "amazon-bedrock": "bedrock-aws",
  "ant-ling": "antgroup",
  anthropic: "anthropic",
  "azure-openai-responses": "azure",
  baseten: "baseten",
  cerebras: "cerebras",
  "cloudflare-ai-gateway": "cloudflare",
  "cloudflare-workers-ai": "workersai-cloudflare",
  deepseek: "deepseek",
  fireworks: "fireworks",
  "github-copilot": "github-copilot",
  google: "google-gemini",
  groq: "groq",
  huggingface: "hugging-face",
  "kimi-coding": "moonshot",
  minimax: "minimax",
  mistral: "mistral-ai",
  nvidia: "nvidia",
  openai: "openai",
  "openai-codex": "codex-openai",
  opencode: "opencode",
  openrouter: "openrouter",
  qwen: "qwen",
  together: "togetherdotai",
  "vercel-ai-gateway": "vercel",
  xai: "xai",
  xiaomi: "xiaomi-mimo",
  zai: "zhipu",
}

/**
 * Model family → mark, matched on the id's own words by `firstWordMatch`.
 *
 * Order decides ties here rather than key length, because the tie that
 * matters is a judgement and not a measurement: `gpt-5-codex` carries both
 * `codex` and `gpt`, and the row is about Codex. Hand-ordered from the
 * specific to the general, and the order is what the tests pin.
 */
const BY_FAMILY: { word: string; mark: string }[] = [
  { word: "claude", mark: "claude" },
  { word: "chatgpt", mark: "openai" },
  { word: "codex", mark: "codex-openai" },
  { word: "gpt", mark: "openai" },
  { word: "o1", mark: "openai" },
  { word: "o3", mark: "openai" },
  { word: "o4", mark: "openai" },
  { word: "gemini", mark: "google-gemini" },
  { word: "grok", mark: "xai" },
  { word: "deepseek", mark: "deepseek" },
  { word: "qwen", mark: "qwen" },
  { word: "qwq", mark: "qwen" },
  { word: "qvq", mark: "qwen" },
  { word: "kimi", mark: "moonshot" },
  { word: "moonshot", mark: "moonshot" },
  { word: "glm", mark: "zhipu" },
  { word: "chatglm", mark: "zhipu" },
  { word: "minimax", mark: "minimax" },
  { word: "abab", mark: "minimax" },
  { word: "mistral", mark: "mistral-ai" },
  { word: "ministral", mark: "mistral-ai" },
  { word: "magistral", mark: "mistral-ai" },
  { word: "devstral", mark: "mistral-ai" },
  { word: "codestral", mark: "mistral-ai" },
  { word: "pixtral", mark: "mistral-ai" },
  { word: "llama", mark: "meta" },
  { word: "nemotron", mark: "nvidia" },
  { word: "mimo", mark: "xiaomi-mimo" },
  { word: "ling", mark: "antgroup" },
]

/**
 * Tool name → mark, for the resource list.
 *
 * Matched on the name's words like a model family, and sorted longest key
 * first at module scope rather than by hand: `github` and `gitlab` both start
 * with `git`, and so does the `git` this table also answers. Sorting is what
 * makes that safe without an ordering comment on every third line — an entry
 * added at the bottom cannot quietly shadow one above it.
 *
 * The aliases are the short names people actually give these servers:
 * `postgres` rather than `postgresql`, `k8s` and `kube`, `gdrive`, `gcp`.
 */
const BY_VENDOR: { word: string; mark: string }[] = [
  { word: "airtable", mark: "airtable" },
  { word: "asana", mark: "asana" },
  { word: "atlassian", mark: "atlassian" },
  { word: "aws", mark: "aws" },
  { word: "amazon", mark: "aws" },
  { word: "box", mark: "box" },
  { word: "clickup", mark: "clickup" },
  { word: "confluence", mark: "confluence" },
  { word: "datadog", mark: "datadog" },
  { word: "discord", mark: "discord" },
  { word: "docker", mark: "docker" },
  { word: "elastic", mark: "elasticsearch" },
  { word: "figma", mark: "figma" },
  { word: "github", mark: "github" },
  { word: "gitlab", mark: "gitlab" },
  { word: "git", mark: "git" },
  { word: "gmail", mark: "gmail" },
  { word: "gdrive", mark: "google-drive" },
  { word: "drive", mark: "google-drive" },
  { word: "googledrive", mark: "google-drive" },
  { word: "gcp", mark: "googlecloud" },
  { word: "googlecloud", mark: "googlecloud" },
  { word: "grafana", mark: "grafana" },
  { word: "graphql", mark: "graphql" },
  { word: "hubspot", mark: "hubspot" },
  { word: "intercom", mark: "intercom" },
  { word: "jira", mark: "jira" },
  { word: "kubernetes", mark: "kubernetes" },
  { word: "kube", mark: "kubernetes" },
  { word: "k8s", mark: "kubernetes" },
  { word: "linear", mark: "linear" },
  { word: "monday", mark: "monday" },
  { word: "mongo", mark: "mongodb" },
  { word: "mysql", mark: "mysql" },
  { word: "netlify", mark: "netlify" },
  { word: "notion", mark: "notion" },
  { word: "npm", mark: "npm" },
  { word: "obsidian", mark: "obsidian" },
  { word: "openapi", mark: "openapi" },
  { word: "swagger", mark: "openapi" },
  { word: "postgres", mark: "postgresql" },
  { word: "puppeteer", mark: "puppeteer" },
  { word: "raycast", mark: "raycast" },
  { word: "redis", mark: "redis" },
  { word: "sentry", mark: "sentry" },
  { word: "shopify", mark: "shopify" },
  { word: "slack", mark: "slack" },
  { word: "sqlite", mark: "sqlite" },
  { word: "stripe", mark: "stripe" },
  { word: "supabase", mark: "supabase" },
  { word: "telegram", mark: "telegram" },
  { word: "terraform", mark: "terraform" },
  { word: "trello", mark: "trello" },
  { word: "twilio", mark: "twilio" },
  { word: "zapier", mark: "zapier" },
  { word: "zendesk", mark: "zendesk" },
].sort((left, right) => right.word.length - left.word.length)

/** The mark for a provider, or `undefined` when the table does not know the id. */
export const labMarkForProvider = (providerId: string): string | undefined => {
  const id = providerId.toLowerCase()
  let match: string | undefined
  let matched = 0
  for (const [prefix, mark] of Object.entries(BY_PROVIDER)) {
    if (prefix.length > matched && id.startsWith(prefix)) {
      match = mark
      matched = prefix.length
    }
  }
  return match
}

/**
 * The mark for a model: its family's, or its provider's when no family answers.
 *
 * The fallback is what keeps a gateway's own catalogue legible — an OpenRouter
 * row for a model nobody's table names still says OpenRouter, which is more
 * than nothing and is true.
 */
export const labMarkForModel = (model: { id: string; providerId: string }): string | undefined =>
  labMarkForModelId(model.id) ?? labMarkForProvider(model.providerId)

/**
 * The mark for a model id alone, with no provider to fall back on.
 *
 * What a past turn has. A message records the model that produced it and not
 * the provider that served it, and guessing the session's current provider
 * would put a gateway's mark on a turn that may well have predated it. The
 * family or nothing is the only honest answer for a transcript.
 */
export const labMarkForModelId = (modelId: string): string | undefined => firstWordMatch(modelId, BY_FAMILY)

/**
 * The mark for one of Pi's resources — an extension, a skill, an MCP server.
 *
 * A name rather than an id, because that is all a resource has that a person
 * would recognise. `undefined` for the many that name no vendor, and the row
 * keeps the glyph for its kind: within a list filtered to one kind that glyph
 * is the same on every row, so a brand is strictly more than it said.
 */
export const labMarkForResource = (name: string): string | undefined => firstWordMatch(name, BY_VENDOR)

/**
 * The first table entry whose word starts one of the phrase's own words.
 *
 * An id or a name is a hyphenated phrase, and what it names is one of its
 * words: `claude-sonnet-5`, `meta.llama3-70b`, `Qwen/Qwen3-235B`,
 * `mcp-server-postgres`. Splitting on everything that is not a letter or a
 * digit and matching a word's start is what tells `o3` from the `3` inside a
 * version — a plain substring search would find `o3` in half the catalogue —
 * and it is why `grok-code-fast-1` is xAI rather than Codex: a word may extend
 * a table entry, never the other way round.
 */
const firstWordMatch = (phrase: string, table: readonly { word: string; mark: string }[]): string | undefined => {
  const words = phrase.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 0)
  for (const { word, mark } of table) {
    if (words.some((part) => part.startsWith(word))) return mark
  }
  return undefined
}

/** The artwork a mark names, or `undefined` when the generated set has no such mark. */
export const labArtwork = (mark: string | undefined): LabArtwork | undefined =>
  mark === undefined ? undefined : LAB_ARTWORK[mark]
