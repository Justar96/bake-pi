import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path"
import type { Resource } from "@bake-pi/contract"
import {
  DefaultPackageManager,
  SettingsManager,
  type ResourceDiagnostic,
  type ResourceLoader,
  type ResolvedResource,
  type SourceInfo,
} from "@earendil-works/pi-coding-agent"

interface ResourceInventoryOptions {
  workspaceRoot: string
  agentDir: string
  projectTrusted: boolean
  loaders?: readonly ResourceLoader[]
}

type ResourceKind = Resource["kind"]
type ResourceScope = Resource["scope"]

/**
 * Lists Pi resources without executing extension code just to populate a UI.
 *
 * `DefaultResourceLoader.reload()` would answer the same question by loading
 * every enabled extension, which runs arbitrary user and project code. Doing
 * that from a read command would make opening Settings a second extension
 * startup. `DefaultPackageManager.resolve()` is Pi's public discovery layer
 * underneath it: it returns enabled and disabled paths with their provenance,
 * and the `skip` callback keeps this inventory read from installing a missing
 * package or touching the network.
 *
 * When a session is already open, its real loader is merged over the inventory.
 * That contributes extension-provided skills/prompts, context files and load
 * failures without creating another extension runtime.
 */
export const listWorkspaceResources = async ({
  workspaceRoot,
  agentDir,
  projectTrusted,
  loaders = [],
}: ResourceInventoryOptions): Promise<Resource[]> => {
  const settingsManager = SettingsManager.create(workspaceRoot, agentDir, { projectTrusted })
  const packageManager = new DefaultPackageManager({ cwd: workspaceRoot, agentDir, settingsManager })
  const resolved = await packageManager.resolve(async () => "skip")
  const resources = new Map<string, Resource>()

  for (const resource of resolved.extensions) add(resources, fromResolved("extension", resource))
  for (const resource of resolved.skills) add(resources, fromResolved("skill", resource))
  for (const resource of resolved.prompts) add(resources, fromResolved("prompt", resource))

  for (const loader of loaders) mergeLoadedResources(resources, loader, workspaceRoot, agentDir)

  return [...resources.values()].sort(
    (left, right) =>
      KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind) ||
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
      left.scope.localeCompare(right.scope),
  )
}

const mergeLoadedResources = (
  resources: Map<string, Resource>,
  loader: ResourceLoader,
  workspaceRoot: string,
  agentDir: string,
): void => {
  const extensions = loader.getExtensions()
  const extensionErrors = new Map(extensions.errors.map(({ path, error }) => [pathKey(path), error]))

  for (const extension of extensions.extensions) {
    if (extension.hidden === true) continue
    const inline = extension.path.startsWith("<inline:")
    const path = inline ? undefined : extension.resolvedPath
    const identity = inline ? undefined : packageIdentity(extension.sourceInfo)
    add(
      resources,
      makeResource({
        kind: "extension",
        scope: inline ? "builtin" : scopeFor(extension.sourceInfo),
        name: inline ? extension.path.slice("<inline:".length, -1) : extensionName(extension.resolvedPath, identity),
        ...(identity?.description === undefined ? {} : { description: identity.description }),
        ...(path === undefined ? {} : { path }),
        enabled: true,
        executable: true,
        ...(path === undefined ? {} : errorAt(extensionErrors, path)),
      }),
    )
  }
  for (const { path, error } of extensions.errors) {
    add(
      resources,
      makeResource({
        kind: "extension",
        scope: scopeForPath(path, workspaceRoot, agentDir),
        name: resourceName("extension", path),
        ...(isAbsolute(path) ? { path } : {}),
        enabled: true,
        executable: true,
        loadError: error,
      }),
    )
  }

  const skills = loader.getSkills()
  for (const skill of skills.skills) {
    add(
      resources,
      makeResource({
        kind: "skill",
        scope: scopeFor(skill.sourceInfo),
        name: skill.name,
        description: skill.description,
        path: skill.filePath,
        enabled: true,
        executable: false,
        ...diagnosticAt(skills.diagnostics, skill.filePath),
      }),
    )
  }
  addDiagnosticOnlyResources(resources, "skill", skills.diagnostics, workspaceRoot, agentDir)

  const prompts = loader.getPrompts()
  for (const prompt of prompts.prompts) {
    add(
      resources,
      makeResource({
        kind: "prompt",
        scope: scopeFor(prompt.sourceInfo),
        name: prompt.name,
        description: prompt.description,
        path: prompt.filePath,
        enabled: true,
        executable: false,
        ...diagnosticAt(prompts.diagnostics, prompt.filePath),
      }),
    )
  }
  addDiagnosticOnlyResources(resources, "prompt", prompts.diagnostics, workspaceRoot, agentDir)

  const instructionPaths = [
    ...loader.getAgentsFiles().agentsFiles.map(({ path }) => path),
    ...(loader.getSystemPromptSource() === undefined ? [] : [loader.getSystemPromptSource()!.path]),
    ...loader.getAppendSystemPromptSources().map(({ path }) => path),
  ]
  for (const path of instructionPaths) {
    add(
      resources,
      makeResource({
        kind: "instruction",
        scope: scopeForPath(path, workspaceRoot, agentDir),
        name: basename(path),
        path,
        enabled: true,
        executable: false,
      }),
    )
  }
}

const addDiagnosticOnlyResources = (
  resources: Map<string, Resource>,
  kind: "skill" | "prompt",
  diagnostics: readonly ResourceDiagnostic[],
  workspaceRoot: string,
  agentDir: string,
): void => {
  for (const diagnostic of diagnostics) {
    if (diagnostic.type !== "error" || diagnostic.path === undefined) continue
    add(
      resources,
      makeResource({
        kind,
        scope: scopeForPath(diagnostic.path, workspaceRoot, agentDir),
        name: resourceName(kind, diagnostic.path),
        ...(isAbsolute(diagnostic.path) ? { path: diagnostic.path } : {}),
        enabled: true,
        executable: false,
        loadError: diagnostic.message,
      }),
    )
  }
}

const fromResolved = (kind: "extension" | "skill" | "prompt", resource: ResolvedResource): Resource => {
  const identity = kind === "extension" ? packageIdentity(resource.metadata) : undefined
  return makeResource({
    kind,
    scope: scopeFor(resource.metadata),
    name: kind === "extension" ? extensionName(resource.path, identity) : resourceName(kind, resource.path),
    ...(identity?.description === undefined ? {} : { description: identity.description }),
    path: resource.path,
    enabled: resource.enabled,
    executable: kind === "extension",
  })
}

const makeResource = (resource: Omit<Resource, "id">): Resource => {
  const name = resource.name.slice(0, 256)
  const description = resource.description?.slice(0, 2048)
  const loadError = resource.loadError?.slice(0, 512)
  return {
    id: resourceId(resource.kind, resource.path, name, resource.scope),
    ...resource,
    name,
    ...(description === undefined ? {} : { description }),
    ...(loadError === undefined ? {} : { loadError }),
  }
}

/** Loaded data enriches the inventory; configured scope and enabled state win. */
const add = (resources: Map<string, Resource>, resource: Resource): void => {
  const key = resourceKey(resource)
  const current = resources.get(key)
  if (current === undefined) {
    resources.set(key, resource)
    return
  }
  resources.set(key, {
    ...current,
    ...resource,
    id: current.id,
    scope: current.scope,
    enabled: current.enabled,
    ...(current.description === undefined && resource.description === undefined
      ? {}
      : { description: resource.description ?? current.description }),
    ...(current.loadError === undefined && resource.loadError === undefined
      ? {}
      : { loadError: resource.loadError ?? current.loadError }),
  })
}

const diagnosticAt = (diagnostics: readonly ResourceDiagnostic[], path: string): Pick<Resource, "loadError"> | {} => {
  const found = diagnostics.find((diagnostic) => diagnostic.type === "error" && diagnostic.path === path)
  return found === undefined ? {} : { loadError: found.message }
}

const errorAt = (errors: ReadonlyMap<string, string>, path: string): Pick<Resource, "loadError"> | {} => {
  const error = errors.get(pathKey(path))
  return error === undefined ? {} : { loadError: error }
}

const scopeFor = (source: Pick<SourceInfo, "scope" | "source">): ResourceScope => {
  if (source.source === "builtin") return "builtin"
  return source.scope === "project" ? "project" : "user"
}

const scopeForPath = (path: string, workspaceRoot: string, agentDir: string): ResourceScope => {
  if (!isAbsolute(path)) return "builtin"
  if (isInside(agentDir, path)) return "user"
  return isInside(workspaceRoot, path) ? "project" : "user"
}

const isInside = (root: string, target: string): boolean => {
  const rel = relative(resolve(root), resolve(target))
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

const resourceName = (kind: ResourceKind, path: string): string => {
  const file = basename(path)
  if (kind === "skill" && file.toLowerCase() === "skill.md") return basename(dirname(path))
  if (kind === "extension" && /^index\.[cm]?[jt]s$/i.test(file)) return basename(dirname(path))
  return file.slice(0, Math.max(1, file.length - extname(file).length))
}

/**
 * What an installed extension is actually called.
 *
 * A package decides its own layout, so the directory above the entry file is
 * the package's business rather than its name: `pi-simplify` ships
 * `dist/index.js`, `@tintinweb/pi-subagents` ships `src/index.ts`, and
 * `@router-for-me/pi-cliproxyapi-provider` ships two files under `extensions/`.
 * Naming those from the path produced rows reading "dist", "src" and
 * "extensions" — three names that are not any package's, and two of which would
 * collide the moment a second package chose the same layout.
 *
 * `baseDir` is where Pi installed the package, so its manifest is the one
 * authority on both the name and the description, and `source` is the fallback
 * for the case Pi resolved a package whose manifest cannot be read.
 */
const extensionName = (path: string, identity: PackageIdentity | undefined): string => {
  const stem = resourceName("extension", path)
  if (identity === undefined) return stem
  /**
   * A package that contributes several extension files needs each of them
   * distinguishable, and the entry is the one that carries the package's name
   * unqualified — anything else would leave a person guessing which row is the
   * extension they installed.
   */
  return isPackageEntry(path, identity) ? identity.name : `${identity.name} · ${stem}`
}

const isPackageEntry = (path: string, identity: PackageIdentity): boolean =>
  /^index\.[cm]?[jt]s$/i.test(basename(path)) || basename(path, extname(path)) === basename(identity.name)

interface PackageIdentity {
  name: string
  description?: string
}

/**
 * Reads a resolved package's manifest once per directory.
 *
 * The inventory is rebuilt on every Settings open and every reload, and a
 * package contributing several files would otherwise read the same manifest
 * once per file. The cache is keyed by resolved directory and never
 * invalidated, which is correct for a process whose packages are installed by
 * a different one: a reinstall arrives with a new host.
 */
const manifests = new Map<string, PackageIdentity | undefined>()

const packageIdentity = (
  source: Pick<SourceInfo, "source" | "origin" | "baseDir">,
): PackageIdentity | undefined => {
  if (source.origin !== "package") return undefined
  const baseDir = source.baseDir
  if (baseDir === undefined) return sourceIdentity(source.source)
  const key = pathKey(baseDir)
  if (!manifests.has(key)) manifests.set(key, readManifest(baseDir) ?? sourceIdentity(source.source))
  return manifests.get(key) ?? undefined
}

const readManifest = (baseDir: string): PackageIdentity | undefined => {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(baseDir, "package.json"), "utf8"))
    if (typeof manifest !== "object" || manifest === null) return undefined
    const { name, description } = manifest as { name?: unknown; description?: unknown }
    if (typeof name !== "string" || name === "") return undefined
    return { name, ...(typeof description === "string" && description !== "" ? { description } : {}) }
  } catch {
    return undefined
  }
}

/**
 * A package source without its scheme: `npm:pi-web-access` is the package
 * `pi-web-access`, and a git source is named by the repository it clones.
 */
const sourceIdentity = (source: string): PackageIdentity | undefined => {
  const withoutScheme = source.replace(/^(?:npm|git|github|file|local):/i, "")
  if (withoutScheme === "") return undefined
  if (!/^(?:https?:\/\/|git@)/i.test(withoutScheme)) return { name: withoutScheme }
  const repository = withoutScheme.replace(/[#?].*$/, "").replace(/\.git$/i, "").split(/[/:]/).filter(Boolean).at(-1)
  return repository === undefined ? undefined : { name: repository }
}

const resourceId = (kind: ResourceKind, path: string | undefined, name: string, scope: ResourceScope): string =>
  `${kind}:${createHash("sha256").update(`${scope}\0${path ?? name}`).digest("hex")}`

const resourceKey = (resource: Resource): string =>
  `${resource.kind}\0${resource.path === undefined ? `${resource.scope}\0${resource.name}` : pathKey(resource.path)}`

const pathKey = (path: string): string => {
  const normalized = resolve(path)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

const KIND_ORDER: readonly ResourceKind[] = ["extension", "skill", "prompt", "mcp_server", "instruction"]
