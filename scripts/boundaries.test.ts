/**
 * Import-boundary assertions.
 *
 * Every rule the plan states about who may touch what is expressed here as a
 * failing test, because a rule that lives only in prose is a rule that erodes.
 * These run in the normal `bun test` pass, so a violation fails a pull request
 * in seconds rather than at packaging time — or, worse, at runtime in a
 * sandboxed renderer that suddenly cannot resolve `node:fs`.
 */
import { describe, expect, test } from "bun:test"
import { Glob } from "bun"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createScanner, SyntaxKind } from "typescript/unstable/ast"

const root = join(import.meta.dir, "..")

/**
 * `tsconfig` files carry comments, and the comments in ours explain the
 * boundaries these tests enforce. Stripping them here is cheaper than deleting
 * them there.
 */
const stripJsonComments = (text: string): string => {
  let out = ""
  let inString = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    const next = text[i + 1]
    if (inLine) {
      if (ch === "\n") { inLine = false; out += ch }
      continue
    }
    if (inBlock) {
      if (ch === "*" && next === "/") { inBlock = false; i += 1 }
      continue
    }
    if (inString) {
      out += ch
      if (ch === "\\") { out += next ?? ""; i += 1 } else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; out += ch; continue }
    if (ch === "/" && next === "/") { inLine = true; i += 1; continue }
    if (ch === "/" && next === "*") { inBlock = true; i += 1; continue }
    out += ch
  }
  // Trailing commas are legal in tsconfig and illegal in JSON.
  return out.replace(/,(\s*[}\]])/g, "$1")
}

const readJson = (relativePath: string): Record<string, unknown> =>
  JSON.parse(stripJsonComments(readFileSync(join(root, relativePath), "utf8"))) as Record<string, unknown>

const sourceFiles = (relativeDir: string): string[] =>
  [...new Glob("**/*.{ts,tsx}").scanSync({ cwd: join(root, relativeDir), absolute: false })]
    .filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"))

const importsIn = (source: string): string[] => {
  const imports = new Bun.Transpiler({ loader: "tsx" }).scanImports(source).map(({ path }) => path)

  // Bun correctly scans value imports, re-exports and dynamic imports, but
  // erases `import type` as part of scanning. Those imports still express an
  // architectural dependency, so recover them from TypeScript's lexical
  // scanner. Lexical tokens avoid false hits in comments and string literals.
  const scanner = createScanner(true, undefined, source)
  const tokens: { kind: SyntaxKind; value: string }[] = []
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    tokens.push({ kind, value: scanner.getTokenValue() })
  }
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index]?.kind !== SyntaxKind.ImportKeyword || tokens[index + 1]?.kind !== SyntaxKind.TypeKeyword) {
      continue
    }
    for (let cursor = index + 2; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor]!
      if (token.kind === SyntaxKind.SemicolonToken || token.kind === SyntaxKind.ImportKeyword) break
      if (token.kind !== SyntaxKind.FromKeyword) continue
      const specifier = tokens[cursor + 1]
      if (specifier?.kind === SyntaxKind.StringLiteral) imports.push(specifier.value)
      break
    }
  }
  return [...new Set(imports)]
}

const importsOf = (absolutePath: string): string[] => importsIn(readFileSync(absolutePath, "utf8"))

const allImports = (relativeDir: string): { file: string; specifier: string }[] =>
  sourceFiles(relativeDir).flatMap((file) =>
    importsOf(join(root, relativeDir, file)).map((specifier) => ({ file: join(relativeDir, file), specifier })),
  )

const PI_PACKAGE = "@earendil-works/pi-coding-agent"
const PI_SERVER_PACKAGE = "@earendil-works/pi-server"
const AGENT_HOST_PACKAGE = "@bake-pi/agent-host"
const isPi = (specifier: string): boolean =>
  [PI_PACKAGE, PI_SERVER_PACKAGE].some((name) => specifier === name || specifier.startsWith(`${name}/`))
const isNodeBuiltin = (specifier: string): boolean => specifier.startsWith("node:")
const isElectron = (specifier: string): boolean => specifier === "electron" || specifier.startsWith("electron/")

describe("the renderer has no privileged access", () => {
  const rendererImports = allImports("apps/desktop/src/renderer")

  test("imports no Node builtin", () => {
    const violations = rendererImports.filter(({ specifier }) => isNodeBuiltin(specifier))
    expect(violations).toEqual([])
  })

  test("imports neither electron nor Pi", () => {
    const violations = rendererImports.filter(({ specifier }) => isElectron(specifier) || isPi(specifier))
    expect(violations).toEqual([])
  })

  test("its tsconfig makes a Node import a type error, not a review question", () => {
    const config = readJson("apps/desktop/tsconfig.renderer.json") as {
      compilerOptions: { types?: string[]; lib?: string[] }
    }
    expect(config.compilerOptions.types).toEqual([])
    expect(config.compilerOptions.lib).toContain("DOM")
  })
})

describe("exactly one package touches Pi", () => {
  // Discovered rather than enumerated, so adding a workspace cannot put Pi in
  // a fifth manifest the test never learned to inspect.
  const manifests = [
    "package.json",
    ...[...new Glob("{apps,packages}/*/package.json").scanSync({ cwd: root, absolute: false })].map((path) =>
      path.replaceAll("\\", "/"),
    ),
  ].sort()

  test("Pi appears in the agent host's manifest and nowhere else", () => {
    const declaring = manifests.filter((manifest) => {
      const json = readJson(manifest) as { dependencies?: Record<string, string> }
      return json.dependencies !== undefined && PI_PACKAGE in json.dependencies
    })
    expect(declaring).toEqual(["packages/agent-host/package.json"])
  })

  test("Pi's published runtime packages stay on the exact same version", () => {
    const json = readJson("packages/agent-host/package.json") as { dependencies?: Record<string, string> }
    expect(json.dependencies?.[PI_SERVER_PACKAGE]).toBe(json.dependencies?.[PI_PACKAGE])
  })

  test("no other workspace can reach Pi through a workspace dependency", () => {
    type Manifest = {
      name?: string
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    const loaded = manifests.map((path) => ({ path, manifest: readJson(path) as Manifest }))
    const byName = new Map(loaded.flatMap((entry) => entry.manifest.name === undefined ? [] : [[entry.manifest.name, entry]]))
    const dependenciesOf = (manifest: Manifest): string[] => [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]
    const reachesPi = (entry: (typeof loaded)[number], seen = new Set<string>()): boolean => {
      if (seen.has(entry.path)) return false
      seen.add(entry.path)
      return dependenciesOf(entry.manifest).some((dependency) => {
        if (dependency === PI_PACKAGE || dependency === PI_SERVER_PACKAGE) return true
        const workspace = byName.get(dependency)
        return workspace !== undefined && reachesPi(workspace, seen)
      })
    }

    expect(
      loaded.filter((entry) => entry.manifest.name !== AGENT_HOST_PACKAGE && reachesPi(entry)).map(({ path }) => path),
    ).toEqual([])
  })

  test("no source outside the agent host imports Pi", () => {
    const violations = [
      ...allImports("apps/desktop/src"),
      ...allImports("packages/contract/src"),
    ].filter(({ specifier }) => isPi(specifier))
    expect(violations).toEqual([])
  })

  test("no desktop source launders Pi through the agent-host workspace", () => {
    const violations = allImports("apps/desktop/src").filter(
      ({ specifier }) => specifier === AGENT_HOST_PACKAGE || specifier.startsWith(`${AGENT_HOST_PACKAGE}/`),
    )
    expect(violations).toEqual([])
  })
})

describe("the contract compiles for both runtimes", () => {
  test("it declares neither the DOM lib nor Node types", () => {
    const config = readJson("packages/contract/tsconfig.json") as {
      compilerOptions: { types?: string[]; lib?: string[] }
    }
    expect(config.compilerOptions.types).toEqual([])
    expect(config.compilerOptions.lib?.some((lib) => lib.toLowerCase().startsWith("dom"))).toBe(false)
  })

  test("its only dependency is TypeBox", () => {
    const json = readJson("packages/contract/package.json") as { dependencies?: Record<string, string> }
    expect(Object.keys(json.dependencies ?? {})).toEqual(["@sinclair/typebox"])
  })

  test("no source imports a Node builtin or electron", () => {
    const violations = allImports("packages/contract/src").filter(
      ({ specifier }) => isNodeBuiltin(specifier) || isElectron(specifier),
    )
    expect(violations).toEqual([])
  })
})

describe("main supervises without understanding Pi", () => {
  test("the agent host does not depend on electron", () => {
    const json = readJson("packages/agent-host/package.json") as { dependencies?: Record<string, string> }
    expect(Object.keys(json.dependencies ?? {})).not.toContain("electron")
  })

  test("main imports no Pi", () => {
    const violations = allImports("apps/desktop/src/main").filter(({ specifier }) => isPi(specifier))
    expect(violations).toEqual([])
  })
})

describe("the preload exposes capabilities, not IPC", () => {
  const source = sourceFiles("apps/desktop/src/preload")
    .map((file) => readFileSync(join(root, "apps/desktop/src/preload", file), "utf8"))
    .join("\n")

  test("it derives its command list from the contract instead of hand-writing one", () => {
    // A hand-written list is the drift this test exists to prevent: a command
    // added to the contract and forgotten here is a control that silently does
    // nothing, and one removed from the contract but left here is a channel
    // with no handler.
    expect(source).toContain("RENDERER_COMMAND_NAMES")
    expect(source).not.toMatch(/\bCOMMAND_NAMES\b/)
  })

  test("it exposes no ipcRenderer and no generic invoke", () => {
    const exposed = source.slice(source.indexOf("exposeInMainWorld"))
    expect(exposed).not.toContain("ipcRenderer")
    expect(exposed).not.toMatch(/\binvoke\s*[,:]/)
  })

  test("it transfers the event port into the isolated main world instead of copying it through contextBridge", () => {
    expect(source).toContain("window.postMessage(EVENT_PORT_CHANNEL")
    expect(source).not.toContain("onEventPort:")
  })

  test("it refuses to install the bridge when the renderer is not hardened", () => {
    expect(source).toContain("process.contextIsolated")
    expect(source).toContain("process.sandboxed")
  })
})

describe("import discovery", () => {
  test("sees every syntax form the boundaries prohibit", () => {
    expect(
      importsIn(`
        import type { BrowserWindow } from "electron"
        import value from "node:fs"
        export { thing } from "@earendil-works/pi-coding-agent"
        export * from "@bake-pi/agent-host"
        const lazy = import("electron/renderer")
      `).sort(),
    ).toEqual([
      "electron",
      "node:fs",
      "@earendil-works/pi-coding-agent",
      "@bake-pi/agent-host",
      "electron/renderer",
    ].sort())
  })
})
