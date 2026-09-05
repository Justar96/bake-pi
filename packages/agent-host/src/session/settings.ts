import {
  BakePiError,
  type PiSettingKey,
  type PiSettingsPatch,
  type PiSettingsSnapshot,
} from "@bake-pi/contract"
import { SettingsManager } from "@earendil-works/pi-coding-agent"

const own = (value: object, key: PropertyKey): boolean => Object.hasOwn(value, key)

/**
 * The settings Bake Pi can change through Pi's public durability boundary.
 *
 * This module intentionally does not edit `settings.json` itself. Pi's setters
 * merge under its own file lock and `flush()` is the point at which a successful
 * command may claim the choice is durable. Fields for which Pi exposes no
 * setter remain JSON-only rather than gaining a second, subtly different writer.
 */
export const piSettingsSnapshot = (manager: SettingsManager): PiSettingsSnapshot => {
  const project = manager.getProjectSettings()
  const defaultProvider = manager.getDefaultProvider()
  const defaultModel = manager.getDefaultModel()
  const modelThinkingLevels = Object.entries(manager.getAllModelThinkingLevels())
    .slice(0, 512)
    .flatMap(([key, level]) => {
      const separator = key.indexOf("/")
      if (separator < 1) return []
      const providerId = key.slice(0, separator)
      const modelId = key.slice(separator + 1)
      return providerId.length <= 128 && modelId.length >= 1 && modelId.length <= 128
        ? [{ providerId, modelId, level }]
        : []
    })

  return {
    projectTrusted: manager.isProjectTrusted(),
    projectOverrides: projectOverrideKeys(project),
    ...(defaultProvider !== undefined && defaultProvider.length <= 128 && defaultModel !== undefined && defaultModel.length <= 128
      ? { defaultModel: { providerId: defaultProvider, modelId: defaultModel } }
      : {}),
    defaultThinkingLevel: manager.getDefaultThinkingLevel() ?? "medium",
    modelThinkingLevels,
    steeringMode: manager.getSteeringMode(),
    followUpMode: manager.getFollowUpMode(),
    transport: manager.getTransport(),
    compactionEnabled: manager.getCompactionEnabled(),
    retryEnabled: manager.getRetryEnabled(),
    httpIdleTimeoutMs: manager.getHttpIdleTimeoutMs(),
    hideThinkingBlock: manager.getHideThinkingBlock(),
    showCacheMissNotices: manager.getShowCacheMissNotices(),
    ...(manager.getShellPath() === undefined ? {} : { shellPath: manager.getShellPath()!.slice(0, 4096) }),
    ...(manager.getShellCommandPrefix() === undefined
      ? {}
      : { shellCommandPrefix: manager.getShellCommandPrefix()!.slice(0, 4096) }),
    ...(manager.getNpmCommand() === undefined
      ? {}
      : { npmCommand: manager.getNpmCommand()!.slice(0, 32).map((part) => part.slice(0, 4096)) }),
    quietStartup: manager.getQuietStartup(),
    defaultProjectTrust: manager.getDefaultProjectTrust(),
    collapseChangelog: manager.getCollapseChangelog(),
    enableInstallTelemetry: manager.getEnableInstallTelemetry(),
    enableAnalytics: manager.getEnableAnalytics(),
    packages: boundedPackageSources(manager.getPackages()),
    extensionPaths: boundedList(manager.getExtensionPaths()),
    skillPaths: boundedList(manager.getSkillPaths()),
    promptTemplatePaths: boundedList(manager.getPromptTemplatePaths()),
    themePaths: boundedList(manager.getThemePaths()),
    enableSkillCommands: manager.getEnableSkillCommands(),
    showImages: manager.getShowImages(),
    imageWidthCells: manager.getImageWidthCells(),
    clearOnShrink: manager.getClearOnShrink(),
    showTerminalProgress: manager.getShowTerminalProgress(),
    tuiMode: manager.getTuiMode(),
    fullscreenExitOutput: manager.getFullscreenExitOutput(),
    fullscreenScrollbar: manager.getFullscreenScrollbar(),
    fullscreenCopyOnSelect: manager.getFullscreenCopyOnSelect(),
    imageAutoResize: manager.getImageAutoResize(),
    blockImages: manager.getBlockImages(),
    ...(manager.getEnabledModels() === undefined
      ? {}
      : { enabledModels: manager.getEnabledModels()!.slice(0, 128).map((pattern) => pattern.slice(0, 4096)) }),
    doubleEscapeAction: manager.getDoubleEscapeAction(),
    treeFilterMode: manager.getTreeFilterMode(),
    showHardwareCursor: manager.getShowHardwareCursor(),
    editorPaddingX: manager.getEditorPaddingX(),
    outputPad: manager.getOutputPad(),
    autocompleteMaxVisible: manager.getAutocompleteMaxVisible(),
    mermaidRenderingMode: manager.getMermaidRenderingMode(),
    anthropicExtraUsageWarning: manager.getWarnings().anthropicExtraUsage ?? true,
    ...(typeof manager.getThemeSetting() === "string" && manager.getThemeSetting()!.length >= 1
      ? { piTheme: manager.getThemeSetting()!.slice(0, 256) }
      : {}),
  }
}

export const applyPiSettingsPatch = async (
  manager: SettingsManager,
  patch: PiSettingsPatch,
): Promise<PiSettingsSnapshot> => {
  if (patch.defaultModel !== undefined) {
    manager.setDefaultModelAndProvider(patch.defaultModel.providerId, patch.defaultModel.modelId)
  }
  if (patch.defaultThinkingLevel !== undefined) manager.setDefaultThinkingLevel(patch.defaultThinkingLevel)
  if (patch.modelThinkingLevel !== undefined) {
    const { providerId, modelId, level } = patch.modelThinkingLevel
    if (level === null) manager.removeModelThinkingLevel(providerId, modelId)
    else manager.setModelThinkingLevel(providerId, modelId, level)
  }
  if (patch.steeringMode !== undefined) manager.setSteeringMode(patch.steeringMode)
  if (patch.followUpMode !== undefined) manager.setFollowUpMode(patch.followUpMode)
  if (patch.transport !== undefined) manager.setTransport(patch.transport)
  if (patch.compactionEnabled !== undefined) manager.setCompactionEnabled(patch.compactionEnabled)
  if (patch.retryEnabled !== undefined) manager.setRetryEnabled(patch.retryEnabled)
  if (patch.httpIdleTimeoutMs !== undefined) manager.setHttpIdleTimeoutMs(patch.httpIdleTimeoutMs)
  if (patch.hideThinkingBlock !== undefined) manager.setHideThinkingBlock(patch.hideThinkingBlock)
  if (patch.showCacheMissNotices !== undefined) manager.setShowCacheMissNotices(patch.showCacheMissNotices)
  if (patch.shellPath !== undefined) manager.setShellPath(patch.shellPath ?? undefined)
  if (patch.shellCommandPrefix !== undefined) manager.setShellCommandPrefix(patch.shellCommandPrefix ?? undefined)
  if (patch.npmCommand !== undefined) manager.setNpmCommand(patch.npmCommand ?? undefined)
  if (patch.quietStartup !== undefined) manager.setQuietStartup(patch.quietStartup)
  if (patch.defaultProjectTrust !== undefined) manager.setDefaultProjectTrust(patch.defaultProjectTrust)
  if (patch.collapseChangelog !== undefined) manager.setCollapseChangelog(patch.collapseChangelog)
  if (patch.enableInstallTelemetry !== undefined) manager.setEnableInstallTelemetry(patch.enableInstallTelemetry)
  if (patch.enableAnalytics !== undefined) manager.setEnableAnalytics(patch.enableAnalytics)
  if (patch.packages !== undefined) manager.setPackages(patch.packages)
  if (patch.extensionPaths !== undefined) manager.setExtensionPaths(patch.extensionPaths)
  if (patch.skillPaths !== undefined) manager.setSkillPaths(patch.skillPaths)
  if (patch.promptTemplatePaths !== undefined) manager.setPromptTemplatePaths(patch.promptTemplatePaths)
  if (patch.themePaths !== undefined) manager.setThemePaths(patch.themePaths)
  if (patch.enableSkillCommands !== undefined) manager.setEnableSkillCommands(patch.enableSkillCommands)
  if (patch.showImages !== undefined) manager.setShowImages(patch.showImages)
  if (patch.imageWidthCells !== undefined) manager.setImageWidthCells(patch.imageWidthCells)
  if (patch.clearOnShrink !== undefined) manager.setClearOnShrink(patch.clearOnShrink)
  if (patch.showTerminalProgress !== undefined) manager.setShowTerminalProgress(patch.showTerminalProgress)
  if (patch.tuiMode !== undefined) manager.setTuiMode(patch.tuiMode)
  if (patch.fullscreenExitOutput !== undefined) manager.setFullscreenExitOutput(patch.fullscreenExitOutput)
  if (patch.fullscreenScrollbar !== undefined) manager.setFullscreenScrollbar(patch.fullscreenScrollbar)
  if (patch.fullscreenCopyOnSelect !== undefined) manager.setFullscreenCopyOnSelect(patch.fullscreenCopyOnSelect)
  if (patch.imageAutoResize !== undefined) manager.setImageAutoResize(patch.imageAutoResize)
  if (patch.blockImages !== undefined) manager.setBlockImages(patch.blockImages)
  if (patch.enabledModels !== undefined) manager.setEnabledModels(patch.enabledModels ?? undefined)
  if (patch.doubleEscapeAction !== undefined) manager.setDoubleEscapeAction(patch.doubleEscapeAction)
  if (patch.treeFilterMode !== undefined) manager.setTreeFilterMode(patch.treeFilterMode)
  if (patch.showHardwareCursor !== undefined) manager.setShowHardwareCursor(patch.showHardwareCursor)
  if (patch.editorPaddingX !== undefined) manager.setEditorPaddingX(patch.editorPaddingX)
  if (patch.outputPad !== undefined) manager.setOutputPad(patch.outputPad)
  if (patch.autocompleteMaxVisible !== undefined) manager.setAutocompleteMaxVisible(patch.autocompleteMaxVisible)
  if (patch.mermaidRenderingMode !== undefined) manager.setMermaidRenderingMode(patch.mermaidRenderingMode)
  if (patch.anthropicExtraUsageWarning !== undefined) {
    manager.setWarnings({ ...manager.getWarnings(), anthropicExtraUsage: patch.anthropicExtraUsageWarning })
  }
  if (patch.piTheme !== undefined) manager.setTheme(patch.piTheme)

  await manager.flush()
  assertSettingsHealthy(manager)
  return piSettingsSnapshot(manager)
}

export const reloadPiSettings = async (manager: SettingsManager): Promise<PiSettingsSnapshot> => {
  await manager.reload()
  assertSettingsHealthy(manager)
  return piSettingsSnapshot(manager)
}

const assertSettingsHealthy = (manager: SettingsManager): void => {
  const errors = manager.drainErrors()
  if (errors.length === 0) return
  throw new BakePiError("internal_error", {
    detail: `Pi ${errors[0]!.scope} settings could not be read or saved`,
    cause: errors[0]!.error,
  })
}

const projectOverrideKeys = (project: ReturnType<SettingsManager["getProjectSettings"]>): PiSettingKey[] => {
  const keys: PiSettingKey[] = []
  const add = (key: PiSettingKey, overridden: boolean): void => {
    if (overridden) keys.push(key)
  }

  add("defaultModel", own(project, "defaultProvider") || own(project, "defaultModel"))
  add("defaultThinkingLevel", own(project, "defaultThinkingLevel"))
  add("modelThinkingLevels", own(project, "modelThinkingLevels"))
  add("steeringMode", own(project, "steeringMode"))
  add("followUpMode", own(project, "followUpMode"))
  add("transport", own(project, "transport"))
  add("compactionEnabled", project.compaction !== undefined && own(project.compaction, "enabled"))
  add("retryEnabled", project.retry !== undefined && own(project.retry, "enabled"))
  add("httpIdleTimeoutMs", own(project, "httpIdleTimeoutMs"))
  add("hideThinkingBlock", own(project, "hideThinkingBlock"))
  add("showCacheMissNotices", own(project, "showCacheMissNotices"))
  add("shellPath", own(project, "shellPath"))
  add("shellCommandPrefix", own(project, "shellCommandPrefix"))
  add("npmCommand", own(project, "npmCommand"))
  add("quietStartup", own(project, "quietStartup"))
  add("collapseChangelog", own(project, "collapseChangelog"))
  add("enableInstallTelemetry", own(project, "enableInstallTelemetry"))
  add("enableAnalytics", own(project, "enableAnalytics"))
  add("packages", own(project, "packages"))
  add("extensionPaths", own(project, "extensions"))
  add("skillPaths", own(project, "skills"))
  add("promptTemplatePaths", own(project, "prompts"))
  add("themePaths", own(project, "themes"))
  add("enableSkillCommands", own(project, "enableSkillCommands"))
  add("showImages", project.terminal !== undefined && own(project.terminal, "showImages"))
  add("imageWidthCells", project.terminal !== undefined && own(project.terminal, "imageWidthCells"))
  add("clearOnShrink", project.terminal !== undefined && own(project.terminal, "clearOnShrink"))
  add("showTerminalProgress", project.terminal !== undefined && own(project.terminal, "showTerminalProgress"))
  add("tuiMode", own(project, "tuiMode"))
  add("fullscreenExitOutput", own(project, "fullscreenExitOutput"))
  add("fullscreenScrollbar", own(project, "fullscreenScrollbar"))
  add("fullscreenCopyOnSelect", own(project, "fullscreenCopyOnSelect"))
  add("imageAutoResize", project.images !== undefined && own(project.images, "autoResize"))
  add("blockImages", project.images !== undefined && own(project.images, "blockImages"))
  add("enabledModels", own(project, "enabledModels"))
  add("doubleEscapeAction", own(project, "doubleEscapeAction"))
  add("treeFilterMode", own(project, "treeFilterMode"))
  add("showHardwareCursor", own(project, "showHardwareCursor"))
  add("editorPaddingX", own(project, "editorPaddingX"))
  add("outputPad", own(project, "outputPad"))
  add("autocompleteMaxVisible", own(project, "autocompleteMaxVisible"))
  add("mermaidRenderingMode", project.markdown !== undefined && own(project.markdown, "mermaid"))
  add("anthropicExtraUsageWarning", project.warnings !== undefined && own(project.warnings, "anthropicExtraUsage"))
  add("piTheme", own(project, "theme"))
  return keys
}

const boundedList = (values: unknown): string[] => Array.isArray(values)
  ? values.filter((value): value is string => typeof value === "string" && value.length >= 1)
    .slice(0, 128)
    .map((value) => value.slice(0, 4096))
  : []

const boundedPackageSources = (values: unknown): PiSettingsSnapshot["packages"] => {
  if (!Array.isArray(values)) return []
  const result: PiSettingsSnapshot["packages"] = []
  for (const entry of values.slice(0, 128)) {
    if (typeof entry === "string") {
      if (entry.length > 0) result.push(entry.slice(0, 4096))
      continue
    }
    if (typeof entry !== "object" || entry === null || !("source" in entry) || typeof entry.source !== "string" || entry.source.length === 0) continue
    const source = entry as { source: string; autoload?: unknown; extensions?: unknown; skills?: unknown; prompts?: unknown; themes?: unknown }
    result.push({
      source: source.source.slice(0, 4096),
      ...(typeof source.autoload === "boolean" ? { autoload: source.autoload } : {}),
      ...(source.extensions === undefined ? {} : { extensions: boundedList(source.extensions) }),
      ...(source.skills === undefined ? {} : { skills: boundedList(source.skills) }),
      ...(source.prompts === undefined ? {} : { prompts: boundedList(source.prompts) }),
      ...(source.themes === undefined ? {} : { themes: boundedList(source.themes) }),
    })
  }
  return result
}
