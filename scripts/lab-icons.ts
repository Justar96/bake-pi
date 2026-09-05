/**
 * Regenerates `apps/desktop/src/renderer/ui/lab-artwork.ts` from thesvg.org.
 *
 * A model picker listing thirty models across a dozen providers is a wall of
 * near-identical words; the mark of the lab that made a model is the fastest
 * thing in a row to recognise, and it is the one thing the words cannot say
 * faster. thesvg.org publishes those marks as plain SVG under
 * `/icons/{slug}/{variant}.svg`, with a registry naming each icon's license.
 *
 * The artwork is fetched here and committed rather than fetched by the build: a
 * build that reaches the network is a build that fails on a plane, and one that
 * pulls artwork at package time ships whatever the site said that morning.
 * `@thesvg/icons` on npm carries the same marks, but it is 97 MB across 19.5k
 * files to supply the thirty below — a poor trade for a devDependency.
 *
 * Run `bun run lab-icons` after editing `ARTWORK`. The output is checked in and
 * reviewed like source, because the renderer injects these bodies through
 * `innerHTML` — see the assertions in `readArtwork`.
 */
import { writeFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const SITE = "https://thesvg.org"

interface Entry {
  slug: string
  variant: string
  tint: "mono" | "brand"
}

/**
 * Which mark stands for each lab, and how it is coloured.
 *
 * `mono` art is stripped of every colour and inherits `currentColor`, so one
 * glyph reads correctly in both themes and beside whatever text it sits next
 * to — the same treatment every other glyph in the app already gets. Most
 * brands publish a `mono` variant for exactly this; where one does not, a
 * variant whose paths carry no fill of their own does the same job, and
 * `readArtwork` fails the run if a colour survives one anyway.
 *
 * `brand` keeps the artwork's own colours, and exists for one shape: Groq's
 * mark is a filled square with the glyph knocked out of it, so flattening it to
 * a single colour yields a solid block rather than a logo. It is the exception
 * that proves the rule rather than a second style.
 */
const ARTWORK: Entry[] = [
  { slug: "anthropic", variant: "mono", tint: "mono" },
  { slug: "antgroup", variant: "mono", tint: "mono" },
  { slug: "azure", variant: "default", tint: "mono" },
  { slug: "baseten", variant: "mono", tint: "mono" },
  { slug: "bedrock-aws", variant: "mono", tint: "mono" },
  { slug: "cerebras", variant: "mono", tint: "mono" },
  { slug: "claude", variant: "mono", tint: "mono" },
  { slug: "cloudflare", variant: "mono", tint: "mono" },
  { slug: "codex-openai", variant: "mono", tint: "mono" },
  { slug: "deepseek", variant: "default", tint: "mono" },
  { slug: "fireworks", variant: "mono", tint: "mono" },
  { slug: "github-copilot", variant: "mono", tint: "mono" },
  { slug: "google-gemini", variant: "mono", tint: "mono" },
  { slug: "groq", variant: "default", tint: "brand" },
  { slug: "hugging-face", variant: "mono", tint: "mono" },
  { slug: "meta", variant: "mono", tint: "mono" },
  { slug: "minimax", variant: "mono", tint: "mono" },
  { slug: "mistral-ai", variant: "mono", tint: "mono" },
  { slug: "moonshot", variant: "mono", tint: "mono" },
  { slug: "nvidia", variant: "mono", tint: "mono" },
  { slug: "openai", variant: "light", tint: "mono" },
  { slug: "opencode", variant: "mono", tint: "mono" },
  { slug: "openrouter", variant: "mono", tint: "mono" },
  { slug: "qwen", variant: "light", tint: "mono" },
  { slug: "togetherdotai", variant: "mono", tint: "mono" },
  { slug: "vercel", variant: "mono", tint: "mono" },
  { slug: "workersai-cloudflare", variant: "mono", tint: "mono" },
  { slug: "xai", variant: "mono", tint: "mono" },
  { slug: "xiaomi-mimo", variant: "mono", tint: "mono" },
  { slug: "zhipu", variant: "mono", tint: "mono" },
]

/**
 * The marks of the tools a workspace brings with it, for the resource list.
 *
 * Pi loads whatever extensions and MCP servers a project declares, so the
 * names in that list are open-ended and mostly not labs. A table answering ten
 * rows out of thirty would read as a broken list rather than a partial one,
 * which is why this set is wide: the cost of a mark nobody installs is a
 * kilobyte of path data, and the cost of a missing one is a row that looks
 * unrecognised beside its neighbours.
 *
 * A handful of well-known marks are deliberately absent — Playwright, Canva,
 * Chromium, Salesforce. Each is layered artwork or a gradient that has no
 * single-colour form, so it would have to come in as `brand` and put four
 * full-colour logos in a list of silhouettes. Those rows keep the kind glyph
 * they already had, which is the honest answer.
 */
const VENDOR_ARTWORK: Entry[] = [
  { slug: "airtable", variant: "mono", tint: "mono" },
  { slug: "asana", variant: "mono", tint: "mono" },
  { slug: "atlassian", variant: "mono", tint: "mono" },
  { slug: "aws", variant: "mono", tint: "mono" },
  { slug: "box", variant: "mono", tint: "mono" },
  { slug: "clickup", variant: "mono", tint: "mono" },
  { slug: "confluence", variant: "mono", tint: "mono" },
  { slug: "datadog", variant: "mono", tint: "mono" },
  { slug: "discord", variant: "mono", tint: "mono" },
  { slug: "docker", variant: "mono", tint: "mono" },
  { slug: "elasticsearch", variant: "mono", tint: "mono" },
  { slug: "figma", variant: "mono", tint: "mono" },
  { slug: "git", variant: "mono", tint: "mono" },
  { slug: "github", variant: "mono", tint: "mono" },
  { slug: "gitlab", variant: "mono", tint: "mono" },
  { slug: "gmail", variant: "mono", tint: "mono" },
  { slug: "google-drive", variant: "mono", tint: "mono" },
  { slug: "googlecloud", variant: "mono", tint: "mono" },
  { slug: "grafana", variant: "mono", tint: "mono" },
  { slug: "graphql", variant: "mono", tint: "mono" },
  { slug: "hubspot", variant: "mono", tint: "mono" },
  { slug: "intercom", variant: "mono", tint: "mono" },
  { slug: "jira", variant: "mono", tint: "mono" },
  { slug: "kubernetes", variant: "mono", tint: "mono" },
  { slug: "linear", variant: "mono", tint: "mono" },
  { slug: "monday", variant: "mono", tint: "mono" },
  { slug: "mongodb", variant: "mono", tint: "mono" },
  { slug: "mysql", variant: "mono", tint: "mono" },
  { slug: "netlify", variant: "mono", tint: "mono" },
  { slug: "notion", variant: "mono", tint: "mono" },
  { slug: "npm", variant: "mono", tint: "mono" },
  { slug: "obsidian", variant: "mono", tint: "mono" },
  { slug: "openapi", variant: "mono", tint: "mono" },
  { slug: "postgresql", variant: "mono", tint: "mono" },
  { slug: "puppeteer", variant: "mono", tint: "mono" },
  { slug: "raycast", variant: "mono", tint: "mono" },
  { slug: "redis", variant: "mono", tint: "mono" },
  { slug: "sentry", variant: "mono", tint: "mono" },
  { slug: "shopify", variant: "mono", tint: "mono" },
  { slug: "slack", variant: "default", tint: "mono" },
  { slug: "sqlite", variant: "mono", tint: "mono" },
  { slug: "stripe", variant: "mono", tint: "mono" },
  { slug: "supabase", variant: "mono", tint: "mono" },
  { slug: "telegram", variant: "mono", tint: "mono" },
  { slug: "terraform", variant: "mono", tint: "mono" },
  { slug: "trello", variant: "mono", tint: "mono" },
  { slug: "twilio", variant: "default", tint: "mono" },
  { slug: "zapier", variant: "mono", tint: "mono" },
  { slug: "zendesk", variant: "mono", tint: "mono" },
]

interface RegistryIcon {
  slug: string
  title: string
  license: string
  variants: string[]
}

const fetchText = async (url: string): Promise<string> => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${String(response.status)}`)
  return await response.text()
}

/**
 * One mark as the renderer will draw it: a viewBox and the markup inside the
 * `<svg>`, with everything the app's own rules forbid already gone.
 *
 * The body is injected through `innerHTML`, so every assertion here is a
 * property the renderer would otherwise have to take on trust:
 *
 * - No `style="…"`. `style-src` carries no `'unsafe-inline'`, and a style
 *   attribute the HTML parser creates is judged by it — the smoke run measures
 *   exactly that. The file icons are stripped for the same reason.
 * - No script, no external reference, no `href`. A brand mark is a shape, and
 *   this is the last point at which anyone reads one before it reaches a DOM.
 * - For `mono`, no colour literal survives. A leftover `#4D6BFE` would render
 *   the same in both themes, which is the whole defect this treatment avoids.
 */
const readArtwork = (entry: Entry, svg: string): { viewBox: string; body: string } => {
  const open = /^[\s\S]*?<svg\b([^>]*)>/.exec(svg)
  const close = svg.lastIndexOf("</svg>")
  if (open === null || close < 0) throw new Error(`${entry.slug}: not an SVG document`)
  const viewBox = /viewBox="([^"]+)"/.exec(open[1] ?? "")?.[1]
  if (viewBox === undefined) throw new Error(`${entry.slug}: the root <svg> declares no viewBox, so the mark has no frame to fit`)

  let body = svg
    .slice(open[0].length, close)
    .replace(/<title>[\s\S]*?<\/title>/g, "")
    .replace(/\s+style="[^"]*"/g, "")
    .replace(/\s+xmlns(:\w+)?="[^"]*"/g, "")
  // `fill="none"` and `stroke="none"` are shape rather than colour: stroke-only
  // art disappears without the first, and the second is how a path opts out of
  // a parent's paint. Only named colours go.
  if (entry.tint === "mono") body = body.replace(/\s+(fill|stroke)="(?!none")[^"]*"/g, "")
  body = body.replace(/\s+/g, " ").trim()

  const forbidden = /<(script|image|foreignObject|use)\b|\son\w+=|href=|url\(/i.exec(body)
  if (forbidden !== null) throw new Error(`${entry.slug}: the body carries "${forbidden[0]}", which is not a shape`)
  if (body.includes('style="')) throw new Error(`${entry.slug}: a style attribute survived, and style-src would reject it`)
  if (entry.tint === "mono" && /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(body)) {
    throw new Error(`${entry.slug}: a colour literal survived a mono mark, so it would read identically in both themes — pick another variant or mark it brand`)
  }
  return { viewBox, body }
}

const registry = JSON.parse(await fetchText(`${SITE}/api/registry.json`)) as { icons: RegistryIcon[] }
const known = new Map(registry.icons.map((icon) => [icon.slug, icon]))

const marks: { slug: string; title: string; license: string; viewBox: string; body: string }[] = []
for (const entry of [...ARTWORK, ...VENDOR_ARTWORK]) {
  const icon = known.get(entry.slug)
  if (icon === undefined) throw new Error(`${entry.slug}: the registry no longer lists this icon`)
  if (!icon.variants.includes(entry.variant)) {
    throw new Error(`${entry.slug}: no "${entry.variant}" variant any more, only ${icon.variants.join(", ")}`)
  }
  const { viewBox, body } = readArtwork(entry, await fetchText(`${SITE}/icons/${entry.slug}/${entry.variant}.svg`))
  marks.push({ slug: entry.slug, title: icon.title, license: icon.license, viewBox, body })
}
marks.sort((left, right) => left.slug.localeCompare(right.slug))

const generated = `/**
 * The lab marks, as the renderer draws them. Generated by \`bun run lab-icons\`;
 * do not edit by hand.
 *
 * Source: ${SITE}/icons/{slug}/{variant}.svg.
 * \`scripts/lab-icons.ts\` records which variant each mark is from, and why.
 *
 * Every mark is the property of its owner and appears here to identify the lab
 * a model came from: nominative fair use, not a claim of endorsement. The
 * per-icon licenses thesvg.org records are:
 *
${marks.map((mark) => ` * - ${mark.title} (\`${mark.slug}\`): ${mark.license}`).join("\n")}
 */

/** One mark: a viewBox and the markup inside the \`<svg>\`. */
export interface LabArtwork {
  viewBox: string
  body: string
}

export const LAB_ARTWORK: Record<string, LabArtwork> = {
${marks.map((mark) => `  ${JSON.stringify(mark.slug)}: { viewBox: ${JSON.stringify(mark.viewBox)}, body: ${JSON.stringify(mark.body)} },`).join("\n")}
}
`

const output = join(root, "apps/desktop/src/renderer/ui/lab-artwork.ts")
writeFileSync(output, generated, "utf8")
console.log(`wrote apps/desktop/src/renderer/ui/lab-artwork.ts (${String(marks.length)} marks, ${String(Math.round(generated.length / 1024))} KB)`)
