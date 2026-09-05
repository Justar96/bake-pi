import { describe, expect, test } from "bun:test"
import { LAB_ARTWORK } from "./lab-artwork.ts"
import { labArtwork, labMarkForModel, labMarkForModelId, labMarkForProvider, labMarkForResource } from "./lab-icons.ts"

/**
 * Every provider id Pi's own `docs/providers.md` table names, plus the
 * subscription logins that never appear in it.
 *
 * Copied rather than derived, deliberately: reading the ids out of the
 * installed Pi would make this test agree with whatever Pi says today, and the
 * thing worth knowing is whether *our* table still covers the providers a
 * person can actually connect. When Pi adds one, this list is where a reviewer
 * has to notice.
 */
const PI_PROVIDERS = [
  "amazon-bedrock",
  "ant-ling",
  "anthropic",
  "azure-openai-responses",
  "baseten",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "deepseek",
  "fireworks",
  "github-copilot",
  "google",
  "groq",
  "huggingface",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "mistral",
  "nvidia",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "qwen-token-plan-individual",
  "together",
  "vercel-ai-gateway",
  "xai",
  "xiaomi",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "zai",
  "zai-coding-cn",
]

describe("the lab mark for a provider", () => {
  test("covers every provider Pi can connect, except the one with no brand at all", () => {
    const unmarked = PI_PROVIDERS.filter((id) => labArtwork(labMarkForProvider(id)) === undefined)
    expect(unmarked).toEqual([])
  })

  test("takes the longest matching prefix, so a plan or a region is not a different lab", () => {
    expect(labMarkForProvider("qwen-token-plan-cn")).toBe("qwen")
    expect(labMarkForProvider("xiaomi-token-plan-sgp")).toBe("xiaomi-mimo")
    expect(labMarkForProvider("minimax-cn")).toBe("minimax")
    expect(labMarkForProvider("zai-coding-cn")).toBe("zhipu")
  })

  test("does not let a shorter prefix win over the id that extends it", () => {
    expect(labMarkForProvider("openai")).toBe("openai")
    expect(labMarkForProvider("openai-codex")).toBe("codex-openai")
    expect(labMarkForProvider("cloudflare-ai-gateway")).toBe("cloudflare")
    expect(labMarkForProvider("cloudflare-workers-ai")).toBe("workersai-cloudflare")
  })

  test("keeps Anthropic and Ant Ling apart, though one id starts the other", () => {
    expect(labMarkForProvider("anthropic")).toBe("anthropic")
    expect(labMarkForProvider("ant-ling")).toBe("antgroup")
  })

  test("has no mark for a provider it does not know", () => {
    // Radius is a real Pi provider and deliberately absent: thesvg.org lists no
    // mark for it, and the surfaces fall back rather than invent one.
    expect(labMarkForProvider("radius")).toBeUndefined()
    expect(labMarkForProvider("some-self-hosted-gateway")).toBeUndefined()
  })
})

describe("the lab mark for a model", () => {
  test("is the lab that made the model, not the gateway that serves it", () => {
    expect(labMarkForModel({ id: "claude-sonnet-5", providerId: "openrouter" })).toBe("claude")
    expect(labMarkForModel({ id: "meta.llama3-70b-instruct-v1:0", providerId: "amazon-bedrock" })).toBe("meta")
    expect(labMarkForModel({ id: "Qwen/Qwen3-235B-A22B", providerId: "together" })).toBe("qwen")
    expect(labMarkForModel({ id: "deepseek-v3", providerId: "fireworks" })).toBe("deepseek")
  })

  test("falls back to the provider when no family answers", () => {
    expect(labMarkForModel({ id: "some-unreleased-thing", providerId: "openrouter" })).toBe("openrouter")
    expect(labMarkForModel({ id: "some-unreleased-thing", providerId: "radius" })).toBeUndefined()
  })

  test("reads the id's words rather than its letters", () => {
    // A word may extend a family — `qwen3` is Qwen — but a family may not
    // extend a word: `grok-code-fast-1` is xAI, and only a match that ran the
    // other way would read its `code` as Codex.
    expect(labMarkForModel({ id: "o3-mini", providerId: "radius" })).toBe("openai")
    expect(labMarkForModel({ id: "grok-code-fast-1", providerId: "radius" })).toBe("xai")
    expect(labMarkForModel({ id: "ring-1t", providerId: "radius" })).toBeUndefined()
    expect(labMarkForModel({ id: "ling-1t", providerId: "radius" })).toBe("antgroup")
  })

  test("prefers the more specific family where two could answer", () => {
    // Codex is an OpenAI model whose id also carries `gpt`; the row is about
    // Codex, which is the mark a person is looking for.
    expect(labMarkForModel({ id: "gpt-5-codex", providerId: "openai" })).toBe("codex-openai")
    expect(labMarkForModel({ id: "gpt-5", providerId: "openai" })).toBe("openai")
    expect(labMarkForModel({ id: "gpt-oss-120b", providerId: "groq" })).toBe("openai")
  })

  test("names a mark the generated artwork actually carries", () => {
    const ids = [
      "claude-opus-5", "gpt-5", "gemini-3-pro", "grok-4", "deepseek-r1", "qwen3-coder",
      "kimi-k2", "glm-4.6", "minimax-m2", "mistral-large", "devstral-small", "llama-4-scout",
      "nvidia/llama-3.3-nemotron-super", "mimo-7b", "ling-1t",
    ]
    const missing = ids.filter((id) => labArtwork(labMarkForModel({ id, providerId: "radius" })) === undefined)
    expect(missing).toEqual([])
  })
})

describe("the mark for one of Pi's resources", () => {
  test("reads the short names people actually give these servers", () => {
    expect(labMarkForResource("mcp-server-postgres")).toBe("postgresql")
    expect(labMarkForResource("k8s")).toBe("kubernetes")
    expect(labMarkForResource("gdrive")).toBe("google-drive")
    expect(labMarkForResource("GitHub")).toBe("github")
    expect(labMarkForResource("Linear MCP")).toBe("linear")
  })

  test("does not let a shorter entry shadow a longer one it prefixes", () => {
    // All three are in the table, and `github` and `gitlab` both start with
    // `git`. The sort is what decides this, not the order they were typed in.
    expect(labMarkForResource("github-mcp")).toBe("github")
    expect(labMarkForResource("gitlab-mcp")).toBe("gitlab")
    expect(labMarkForResource("git-tools")).toBe("git")
  })

  test("has nothing to say about a name that names no vendor", () => {
    // The row keeps its kind glyph, so a miss costs nothing and a wrong
    // guess would cost the only thing the mark is for.
    expect(labMarkForResource("code-review")).toBeUndefined()
    expect(labMarkForResource("my-project-skill")).toBeUndefined()
  })
})

describe("the mark for a model id with no provider", () => {
  test("answers from the family or not at all", () => {
    // What a past turn has to go on. Falling back to a provider here would
    // put the session's current gateway on a turn that predated it.
    expect(labMarkForModelId("claude-opus-5")).toBe("claude")
    expect(labMarkForModelId("gpt-5")).toBe("openai")
    expect(labMarkForModelId("extension-model")).toBeUndefined()
  })
})

describe("the generated artwork", () => {
  test("is markup the renderer may inject", () => {
    // The bodies reach the DOM through `dangerouslySetInnerHTML`, so what
    // `scripts/lab-icons.ts` refuses to write is asserted again on what it
    // did write — the generator can be re-run, and the file can be edited.
    for (const [mark, artwork] of Object.entries(LAB_ARTWORK)) {
      expect(artwork.viewBox, mark).toMatch(/^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/)
      expect(artwork.body, mark).not.toMatch(/<(script|image|foreignObject|use)\b/i)
      expect(artwork.body, mark).not.toMatch(/\son\w+=/i)
      expect(artwork.body, mark).not.toContain("href=")
      // `style-src` carries no `'unsafe-inline'`, and the parser creates the
      // attributes of injected markup.
      expect(artwork.body, mark).not.toContain('style="')
    }
  })

  test("is monochrome everywhere but the one mark that cannot be", () => {
    const coloured = Object.entries(LAB_ARTWORK)
      .filter(([, artwork]) => /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(artwork.body))
      .map(([mark]) => mark)
    // Groq's mark is a filled square with the glyph knocked out of it, so a
    // single colour makes it a block. Every other mark inherits `currentColor`
    // and therefore reads in both themes — which is the reason for the rule.
    expect(coloured).toEqual(["groq"])
  })

  test("carries no mark nothing can reach", () => {
    // A vendor mark is asked for by its own name, which is the assertion that
    // matters for the resource list: a server called `sentry` finds Sentry.
    const reachable = new Set(
      [
        ...PI_PROVIDERS.map((id) => labMarkForProvider(id)),
        ...["claude", "gpt-5", "gpt-5-codex", "gemini-3", "grok-4", "deepseek-r1", "qwen3", "kimi-k2",
          "glm-4.6", "minimax-m2", "mistral-large", "llama-4", "nemotron", "mimo-7b", "ling-1t",
        ].map((id) => labMarkForModel({ id, providerId: "radius" })),
        ...Object.keys(LAB_ARTWORK).map((mark) => labMarkForResource(mark)),
      ].filter((mark): mark is string => mark !== undefined),
    )
    const orphans = Object.keys(LAB_ARTWORK).filter((mark) => !reachable.has(mark))
    expect(orphans).toEqual([])
  })
})
