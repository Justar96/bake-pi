import { describe, expect, test } from "bun:test"
import { SettingsManager } from "@earendil-works/pi-coding-agent"
import { applyPiSettingsPatch, piSettingsSnapshot } from "./settings.ts"

describe("Pi settings bridge", () => {
  test("writes every user-facing global setter represented by the UI and returns Pi's effective values", async () => {
    const manager = SettingsManager.inMemory({}, { projectTrusted: true })

    const snapshot = await applyPiSettingsPatch(manager, {
      defaultModel: { providerId: "anthropic", modelId: "claude-test" },
      defaultThinkingLevel: "high",
      modelThinkingLevel: { providerId: "anthropic", modelId: "claude-test", level: "xhigh" },
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      transport: "websocket-cached",
      compactionEnabled: false,
      retryEnabled: false,
      httpIdleTimeoutMs: 12_000,
      hideThinkingBlock: true,
      showCacheMissNotices: true,
      shellPath: "test-shell",
      shellCommandPrefix: "prefix",
      npmCommand: ["bun", "x"],
      quietStartup: true,
      defaultProjectTrust: "never",
      collapseChangelog: true,
      enableInstallTelemetry: false,
      enableAnalytics: true,
      packages: ["@scope/pi-package", { source: "git:example/resource", autoload: false, skills: ["skills/**"] }],
      extensionPaths: ["extensions/*.ts"],
      skillPaths: ["skills/**/SKILL.md"],
      promptTemplatePaths: ["prompts/*.md"],
      themePaths: ["themes/*.json"],
      enableSkillCommands: false,
      showImages: false,
      imageWidthCells: 72,
      clearOnShrink: false,
      showTerminalProgress: false,
      tuiMode: "fullscreen",
      fullscreenExitOutput: "resume-hint",
      fullscreenScrollbar: "hidden",
      fullscreenCopyOnSelect: true,
      imageAutoResize: false,
      blockImages: true,
      enabledModels: ["anthropic/*"],
      doubleEscapeAction: "fork",
      treeFilterMode: "user-only",
      showHardwareCursor: false,
      editorPaddingX: 3,
      outputPad: 0,
      autocompleteMaxVisible: 11,
      mermaidRenderingMode: "streaming",
      anthropicExtraUsageWarning: false,
      piTheme: "mono-test",
    })

    expect(snapshot).toMatchObject({
      defaultModel: { providerId: "anthropic", modelId: "claude-test" },
      defaultThinkingLevel: "high",
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      transport: "websocket-cached",
      compactionEnabled: false,
      retryEnabled: false,
      httpIdleTimeoutMs: 12_000,
      hideThinkingBlock: true,
      showCacheMissNotices: true,
      quietStartup: true,
      defaultProjectTrust: "never",
      collapseChangelog: true,
      enableInstallTelemetry: false,
      enableAnalytics: true,
      packages: ["@scope/pi-package", { source: "git:example/resource", autoload: false, skills: ["skills/**"] }],
      extensionPaths: ["extensions/*.ts"],
      skillPaths: ["skills/**/SKILL.md"],
      promptTemplatePaths: ["prompts/*.md"],
      themePaths: ["themes/*.json"],
      enableSkillCommands: false,
      showImages: false,
      imageWidthCells: 72,
      clearOnShrink: false,
      showTerminalProgress: false,
      tuiMode: "fullscreen",
      fullscreenExitOutput: "resume-hint",
      fullscreenScrollbar: "hidden",
      fullscreenCopyOnSelect: true,
      imageAutoResize: false,
      blockImages: true,
      enabledModels: ["anthropic/*"],
      doubleEscapeAction: "fork",
      treeFilterMode: "user-only",
      showHardwareCursor: false,
      editorPaddingX: 3,
      outputPad: 0,
      autocompleteMaxVisible: 11,
      mermaidRenderingMode: "streaming",
      anthropicExtraUsageWarning: false,
      piTheme: "mono-test",
    })
    expect(snapshot.modelThinkingLevels).toContainEqual({ providerId: "anthropic", modelId: "claude-test", level: "xhigh" })
    expect(manager.getGlobalSettings()).toMatchObject({
      shellPath: "test-shell",
      shellCommandPrefix: "prefix",
      npmCommand: ["bun", "x"],
    })
  })

  test("null removes optional values through Pi instead of leaving stale settings", async () => {
    const manager = SettingsManager.inMemory({
      shellPath: "test-shell",
      shellCommandPrefix: "prefix",
      npmCommand: ["npm"],
      enabledModels: ["provider/model"],
      modelThinkingLevels: { "provider/model": "high" },
    })

    const snapshot = await applyPiSettingsPatch(manager, {
      shellPath: null,
      shellCommandPrefix: null,
      npmCommand: null,
      enabledModels: null,
      modelThinkingLevel: { providerId: "provider", modelId: "model", level: null },
    })

    expect(snapshot.shellPath).toBeUndefined()
    expect(snapshot.shellCommandPrefix).toBeUndefined()
    expect(snapshot.npmCommand).toBeUndefined()
    expect(snapshot.enabledModels).toBeUndefined()
    expect(snapshot.modelThinkingLevels).toEqual([])
  })

  test("reports project overrides and returns their effective values", () => {
    const storage = seededStorage(
      { steeringMode: "all", theme: "global-theme", compaction: { enabled: true }, skills: ["global-skill"] },
      { steeringMode: "one-at-a-time", theme: "project-theme", compaction: { enabled: false }, skills: ["project-skill"] },
    )
    const snapshot = piSettingsSnapshot(SettingsManager.fromStorage(storage, { projectTrusted: true }))

    expect(snapshot.steeringMode).toBe("one-at-a-time")
    expect(snapshot.compactionEnabled).toBe(false)
    expect(snapshot.piTheme).toBe("project-theme")
    expect(snapshot.skillPaths).toEqual(["project-skill"])
    expect(snapshot.projectOverrides).toEqual(expect.arrayContaining(["steeringMode", "compactionEnabled", "skillPaths", "piTheme"]))
  })

  test("does not expose repository-controlled overrides before trust", () => {
    const storage = seededStorage({ steeringMode: "all" }, { steeringMode: "one-at-a-time" })
    const snapshot = piSettingsSnapshot(SettingsManager.fromStorage(storage, { projectTrusted: false }))

    expect(snapshot.steeringMode).toBe("all")
    expect(snapshot.projectOverrides).toEqual([])
  })
})

interface SeedStorage {
  withLock(scope: "global" | "project", update: (current: string | undefined) => string | undefined): void
}

const seededStorage = (global: object, project: object): SeedStorage => {
  const values = new Map([
    ["global", JSON.stringify(global)],
    ["project", JSON.stringify(project)],
  ])
  return {
    withLock(scope, update) {
      const next = update(values.get(scope))
      if (next === undefined) values.delete(scope)
      else values.set(scope, next)
    },
  }
}
