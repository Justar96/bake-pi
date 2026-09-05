import { useEffect, useId, useRef, useState } from "react"
import * as stylex from "@stylexjs/stylex"
import { CircleAlert, RefreshCw, Save } from "lucide-react"
import type {
  Model,
  PiPackageSource,
  PiSettingKey,
  PiSettingsPatch,
  PiSettingsSnapshot,
  ThinkingLevel,
} from "@bake-pi/contract"
import { store } from "../../store/session-store.ts"
import { focus } from "../../theme/focus.ts"
import { spinners } from "../../theme/spinners.ts"
import { scrollbars } from "../../theme/scrollbars.ts"
import { colors, effects, motion, radius, space, typography } from "../../theme/tokens.stylex.ts"
import { size } from "../../theme/sizes.stylex.ts"
import { SelectControl, type SelectOption } from "./SelectControl.tsx"
import { LabIcon } from "../../ui/LabIcon.tsx"
import { labMarkForModel } from "../../ui/lab-icons.ts"

export type PiSettingsArea = "agent" | "resources" | "privacy"
type PiSettingsNotice = { kind: "saved" | "error"; message: string; area?: PiSettingsArea }
type PiSettingsOperation = "refresh" | "save"

export interface PiSettingsController {
  settings: PiSettingsSnapshot | undefined
  busy: boolean
  operation: PiSettingsOperation | undefined
  notice: PiSettingsNotice | undefined
  load: () => void
  update: (area: PiSettingsArea, patch: PiSettingsPatch) => void
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

/**
 * One controller lives for the lifetime of the Settings modal.
 *
 * Agent, resource, and privacy sections are three views over one Pi settings
 * snapshot. Keeping that snapshot above the active panel makes tab changes
 * immediate, while an explicit refresh leaves the previous values visible and
 * disabled until Pi returns the replacement.
 */
export const usePiSettingsController = (enabled: boolean): PiSettingsController => {
  const [settings, setSettings] = useState<PiSettingsSnapshot>()
  const [operation, setOperation] = useState<PiSettingsOperation>()
  const [notice, setNotice] = useState<PiSettingsNotice>()
  const inFlight = useRef(false)

  const load = (): void => {
    if (inFlight.current) return
    inFlight.current = true
    setOperation("refresh")
    setNotice(undefined)
    void store.getPiSettings()
      .then((next) => setSettings(next))
      .catch((error: unknown) => {
        store.capture(error)
        setNotice({ kind: "error", message: "Pi settings could not be loaded." })
      })
      .finally(() => {
        inFlight.current = false
        setOperation(undefined)
      })
  }

  useEffect(() => {
    if (enabled && settings === undefined) load()
  }, [enabled, settings])

  const update = (area: PiSettingsArea, patch: PiSettingsPatch): void => {
    if (inFlight.current) return
    inFlight.current = true
    setOperation("save")
    setNotice(undefined)
    void store.updateGlobalSettings(patch)
      .then((next) => {
        setSettings(next)
        setNotice({
          kind: "saved",
          message: isResourcePatch(patch) ? "Saved to Pi. Reload resources to apply it." : "Saved to Pi.",
          area,
        })
      })
      .catch((error: unknown) => {
        store.capture(error)
        setNotice({ kind: "error", message: "Pi did not save that setting.", area })
      })
      .finally(() => {
        inFlight.current = false
        setOperation(undefined)
      })
  }

  return { settings, busy: operation !== undefined, operation, notice, load, update }
}

/**
 * Pi remains authoritative; the panel only projects its shared controller.
 *
 * The panel has no heading, no lede, and no refresh control of its own. All
 * three belong to the section this panel is one view of, and the settings
 * modal's header owns them — including this controller's notices, which is
 * why `notice` is read here only while there is nothing else on screen to
 * attach a message to.
 */
export const PiSettings = ({ area, models, controller }: { area: PiSettingsArea; models: Model[]; controller: PiSettingsController }): React.JSX.Element => {
  const { settings, busy, notice, load, update } = controller

  if (settings === undefined) {
    return (
      <div aria-busy={busy} {...stylex.props(styles.loading)}>
        <span {...stylex.props(styles.loadingStatus)}>
          <RefreshCw size={16} aria-hidden="true" {...stylex.props(busy && spinners.rotate)} />
          <span>{notice?.message ?? "Loading Pi settings…"}</span>
        </span>
        <span aria-hidden="true" {...stylex.props(styles.loadingHint)}>
          <span {...stylex.props(styles.skeletonLine, styles.skeletonTitle)} />
          <span {...stylex.props(styles.skeletonLine, styles.skeletonCopy)} />
          <span {...stylex.props(styles.skeletonRows)}>
            <span {...stylex.props(styles.skeletonRow)} />
            <span {...stylex.props(styles.skeletonRow)} />
            <span {...stylex.props(styles.skeletonRow)} />
          </span>
        </span>
        {notice?.kind === "error" ? <button type="button" onClick={load} {...stylex.props(focus.control, styles.retry)}>Try again</button> : null}
      </div>
    )
  }

  const locked = (key: PiSettingKey): boolean => settings.projectOverrides.includes(key)
  const shared = { busy, locked, update: (patch: PiSettingsPatch) => update(area, patch) }

  return (
    <div aria-busy={busy} {...stylex.props(styles.panel)}>
      {settings.projectOverrides.length === 0 ? null : (
        <div {...stylex.props(styles.overrideNote)}>
          <CircleAlert size={15} aria-hidden="true" />
          <span>This workspace overrides some global choices in <code>.pi/settings.json</code>. Those controls are locked here so a save never appears to work when it cannot.</span>
        </div>
      )}

      {area === "agent"
        ? <AgentSettings settings={settings} models={models} {...shared} />
        : area === "resources"
          ? <ResourceSourceSettings settings={settings} {...shared} />
          : <PrivacySettings settings={settings} {...shared} />}
    </div>
  )
}

interface SettingsProps {
  settings: PiSettingsSnapshot
  busy: boolean
  locked: (key: PiSettingKey) => boolean
  update: (patch: PiSettingsPatch) => void
}

const AgentSettings = ({ settings, models, busy, locked, update }: SettingsProps & { models: Model[] }): React.JSX.Element => {
  const modelChoices = [...models].sort((left, right) =>
    left.providerId.localeCompare(right.providerId) || left.displayName.localeCompare(right.displayName))
  const defaultModelKey = settings.defaultModel === undefined ? "" : modelKey(settings.defaultModel.providerId, settings.defaultModel.modelId)
  const [overrideModelKey, setOverrideModelKey] = useState(defaultModelKey || (modelChoices[0] === undefined ? "" : modelKey(modelChoices[0].providerId, modelChoices[0].id)))
  const overrideModel = modelChoices.find((model) => modelKey(model.providerId, model.id) === overrideModelKey)
  const overrideLevel = overrideModel === undefined
    ? ""
    : settings.modelThinkingLevels.find((entry) => entry.providerId === overrideModel.providerId && entry.modelId === overrideModel.id)?.level ?? ""

  return (
    <>
      <SettingsGroup title="Session defaults" description="Used when Pi opens a new session.">
        <SelectSetting
          setting="defaultModel"
          label="Default model"
          description="Provider and model chosen for new sessions."
          value={defaultModelKey}
          disabled={busy || modelChoices.length === 0}
          locked={locked("defaultModel")}
          placeholder="Pi default"
          options={modelChoices.map(modelOption)}
          onChange={(value) => {
            const selected = modelChoices.find((model) => modelKey(model.providerId, model.id) === value)
            if (selected !== undefined) update({ defaultModel: { providerId: selected.providerId, modelId: selected.id } })
          }}
        />
        <SelectSetting
          setting="defaultThinkingLevel"
          label="Default thinking"
          description="Baseline reasoning effort before model-specific overrides."
          value={settings.defaultThinkingLevel}
          disabled={busy}
          locked={locked("defaultThinkingLevel")}
          options={THINKING_LEVELS.map(option)}
          onChange={(value) => update({ defaultThinkingLevel: value as ThinkingLevel })}
        />
        <div {...stylex.props(styles.composite)}>
          <SettingCopy
            id="model-thinking-override"
            label="Model thinking override"
            description="Optional effort for one model; “Use default” removes its override."
            locked={locked("modelThinkingLevels")}
          />
          <div {...stylex.props(styles.compositeControls)}>
            <SelectControl
              aria-labelledby="model-thinking-override-title"
              value={overrideModelKey}
              onChange={setOverrideModelKey}
              disabled={busy || locked("modelThinkingLevels") || modelChoices.length === 0}
              options={modelChoices.length === 0 ? [{ value: "", label: "No discovered models" }] : modelChoices.map(modelOption)}
            />
            <SelectControl
              aria-label="Thinking override"
              value={overrideLevel}
              onChange={(level) => {
                if (overrideModel === undefined) return
                update({ modelThinkingLevel: { providerId: overrideModel.providerId, modelId: overrideModel.id, level: level === "" ? null : level as ThinkingLevel } })
              }}
              disabled={busy || locked("modelThinkingLevels") || overrideModel === undefined}
              options={[{ value: "", label: "Use default" }, ...THINKING_LEVELS.map(option)]}
            />
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup title="Prompt delivery" description="How messages queue while an answer is running.">
        <SelectSetting setting="steeringMode" label="Steering messages" description="Send all queued steering messages, or one at a time." value={settings.steeringMode} disabled={busy} locked={locked("steeringMode")} options={[{ value: "all", label: "Send all" }, { value: "one-at-a-time", label: "One at a time" }]} onChange={(value) => update({ steeringMode: value as PiSettingsSnapshot["steeringMode"] })} />
        <SelectSetting setting="followUpMode" label="Follow-up messages" description="How queued follow-ups are released after a turn." value={settings.followUpMode} disabled={busy} locked={locked("followUpMode")} options={[{ value: "all", label: "Send all" }, { value: "one-at-a-time", label: "One at a time" }]} onChange={(value) => update({ followUpMode: value as PiSettingsSnapshot["followUpMode"] })} />
        <SelectSetting setting="transport" label="Model transport" description="Let Pi choose, or require a streaming transport." value={settings.transport} disabled={busy} locked={locked("transport")} options={[{ value: "auto", label: "Automatic" }, { value: "sse", label: "Server-sent events" }, { value: "websocket", label: "WebSocket" }, { value: "websocket-cached", label: "Cached WebSocket" }]} onChange={(value) => update({ transport: value as PiSettingsSnapshot["transport"] })} />
      </SettingsGroup>

      <SettingsGroup title="Resilience" description="Recovery behavior for long or interrupted turns.">
        <ToggleSetting setting="compactionEnabled" label="Automatic compaction" description="Compact conversation history when the context window fills." value={settings.compactionEnabled} disabled={busy} locked={locked("compactionEnabled")} onChange={(value) => update({ compactionEnabled: value })} />
        <ToggleSetting setting="retryEnabled" label="Automatic retry" description="Let Pi retry supported transient provider failures." value={settings.retryEnabled} disabled={busy} locked={locked("retryEnabled")} onChange={(value) => update({ retryEnabled: value })} />
        <NumberSetting setting="httpIdleTimeoutMs" label="HTTP idle timeout" description="Stop an HTTP stream after this many idle seconds. Zero disables it." value={Math.round(settings.httpIdleTimeoutMs / 1000)} min={0} max={86_400} unit="seconds" disabled={busy} locked={locked("httpIdleTimeoutMs")} onSave={(value) => update({ httpIdleTimeoutMs: value * 1000 })} />
      </SettingsGroup>

      <SettingsGroup title="Response content" description="What Pi includes and prepares for display.">
        <ToggleSetting setting="hideThinkingBlock" label="Hide thinking blocks" description="Keep reasoning out of Pi’s terminal transcript." value={settings.hideThinkingBlock} disabled={busy} locked={locked("hideThinkingBlock")} onChange={(value) => update({ hideThinkingBlock: value })} />
        <ToggleSetting setting="showCacheMissNotices" label="Cache-miss notices" description="Show when a provider cannot reuse prompt cache data." value={settings.showCacheMissNotices} disabled={busy} locked={locked("showCacheMissNotices")} onChange={(value) => update({ showCacheMissNotices: value })} />
        <ToggleSetting setting="enableSkillCommands" label="Skill commands" description="Expose discovered skills as slash commands in Pi." value={settings.enableSkillCommands} disabled={busy} locked={locked("enableSkillCommands")} onChange={(value) => update({ enableSkillCommands: value })} />
        <ToggleSetting setting="imageAutoResize" label="Resize large images" description="Scale images to provider limits before sending them." value={settings.imageAutoResize} disabled={busy} locked={locked("imageAutoResize")} onChange={(value) => update({ imageAutoResize: value })} />
        <ToggleSetting setting="blockImages" label="Block image input" description="Prevent images from being sent to models." value={settings.blockImages} disabled={busy} locked={locked("blockImages")} onChange={(value) => update({ blockImages: value })} />
        <SelectSetting setting="mermaidRenderingMode" label="Mermaid rendering" description="When Pi’s terminal renderer turns diagrams into graphics." value={settings.mermaidRenderingMode} disabled={busy} locked={locked("mermaidRenderingMode")} options={[{ value: "off", label: "Off" }, { value: "final", label: "After completion" }, { value: "streaming", label: "While streaming" }]} onChange={(value) => update({ mermaidRenderingMode: value as PiSettingsSnapshot["mermaidRenderingMode"] })} />
      </SettingsGroup>

      <details {...stylex.props(styles.advanced)}>
        <summary {...stylex.props(focus.control, styles.advancedSummary)}>
          <span>Terminal & CLI compatibility</span>
          <span {...stylex.props(styles.advancedHint)}>Advanced</span>
        </summary>
        <div {...stylex.props(styles.advancedBody)}>
          <p {...stylex.props(styles.advancedCopy)}>These choices mainly affect Pi’s own terminal interface. Bake Pi stores them through the same global settings file so both interfaces agree.</p>
          <TextSetting setting="piTheme" label="Pi terminal theme" description="Theme name used by Pi’s own TUI." value={settings.piTheme ?? ""} placeholder="default" disabled={busy} locked={locked("piTheme")} onSave={(value) => update({ piTheme: value })} />
          <ToggleSetting setting="quietStartup" label="Quiet startup" description="Hide routine startup information in Pi’s TUI." value={settings.quietStartup} disabled={busy} locked={locked("quietStartup")} onChange={(value) => update({ quietStartup: value })} />
          <ToggleSetting setting="collapseChangelog" label="Collapse changelog" description="Keep Pi’s changelog compact after updates." value={settings.collapseChangelog} disabled={busy} locked={locked("collapseChangelog")} onChange={(value) => update({ collapseChangelog: value })} />
          <ToggleSetting setting="showImages" label="Show terminal images" description="Render supported images in Pi’s terminal." value={settings.showImages} disabled={busy} locked={locked("showImages")} onChange={(value) => update({ showImages: value })} />
          <NumberSetting setting="imageWidthCells" label="Terminal image width" description="Maximum image width measured in terminal cells." value={settings.imageWidthCells} min={1} max={500} unit="cells" disabled={busy} locked={locked("imageWidthCells")} onSave={(value) => update({ imageWidthCells: value })} />
          <ToggleSetting setting="clearOnShrink" label="Clear after terminal shrink" description="Redraw the TUI when the terminal becomes narrower." value={settings.clearOnShrink} disabled={busy} locked={locked("clearOnShrink")} onChange={(value) => update({ clearOnShrink: value })} />
          <ToggleSetting setting="showTerminalProgress" label="Terminal progress" description="Show streaming progress in Pi’s terminal." value={settings.showTerminalProgress} disabled={busy} locked={locked("showTerminalProgress")} onChange={(value) => update({ showTerminalProgress: value })} />
          <SelectSetting setting="tuiMode" label="Terminal layout" description="Regular scrollback or Pi’s fullscreen terminal mode." value={settings.tuiMode} disabled={busy} locked={locked("tuiMode")} options={[{ value: "regular", label: "Regular" }, { value: "fullscreen", label: "Fullscreen" }]} onChange={(value) => update({ tuiMode: value as PiSettingsSnapshot["tuiMode"] })} />
          <SelectSetting setting="fullscreenExitOutput" label="Fullscreen exit output" description="What Pi leaves in the terminal when fullscreen closes." value={settings.fullscreenExitOutput} disabled={busy} locked={locked("fullscreenExitOutput")} options={[{ value: "transcript", label: "Transcript" }, { value: "resume-hint", label: "Resume hint" }]} onChange={(value) => update({ fullscreenExitOutput: value as PiSettingsSnapshot["fullscreenExitOutput"] })} />
          <SelectSetting setting="fullscreenScrollbar" label="Fullscreen scrollbar" description="Visibility of Pi’s terminal scrollbar." value={settings.fullscreenScrollbar} disabled={busy} locked={locked("fullscreenScrollbar")} options={[{ value: "auto", label: "Automatic" }, { value: "always", label: "Always" }, { value: "hidden", label: "Hidden" }]} onChange={(value) => update({ fullscreenScrollbar: value as PiSettingsSnapshot["fullscreenScrollbar"] })} />
          <ToggleSetting setting="fullscreenCopyOnSelect" label="Copy on selection" description="Copy selected terminal text in fullscreen mode." value={settings.fullscreenCopyOnSelect} disabled={busy} locked={locked("fullscreenCopyOnSelect")} onChange={(value) => update({ fullscreenCopyOnSelect: value })} />
          <SelectSetting setting="doubleEscapeAction" label="Double Escape" description="Pi TUI action for two presses of Escape." value={settings.doubleEscapeAction} disabled={busy} locked={locked("doubleEscapeAction")} options={[{ value: "tree", label: "Open tree" }, { value: "fork", label: "Fork session" }, { value: "none", label: "No action" }]} onChange={(value) => update({ doubleEscapeAction: value as PiSettingsSnapshot["doubleEscapeAction"] })} />
          <SelectSetting setting="treeFilterMode" label="Tree filter" description="Which messages Pi shows in its session tree." value={settings.treeFilterMode} disabled={busy} locked={locked("treeFilterMode")} options={[{ value: "default", label: "Default" }, { value: "no-tools", label: "No tools" }, { value: "user-only", label: "User only" }, { value: "labeled-only", label: "Labeled only" }, { value: "all", label: "Everything" }]} onChange={(value) => update({ treeFilterMode: value as PiSettingsSnapshot["treeFilterMode"] })} />
          <ToggleSetting setting="showHardwareCursor" label="Hardware cursor" description="Use the terminal’s native cursor when possible." value={settings.showHardwareCursor} disabled={busy} locked={locked("showHardwareCursor")} onChange={(value) => update({ showHardwareCursor: value })} />
          <SelectSetting setting="editorPaddingX" label="Editor side padding" description="Horizontal cells around Pi’s terminal editor." value={String(settings.editorPaddingX)} disabled={busy} locked={locked("editorPaddingX")} options={[0, 1, 2, 3].map((value) => ({ value: String(value), label: `${value} ${value === 1 ? "cell" : "cells"}` }))} onChange={(value) => update({ editorPaddingX: Number(value) as 0 | 1 | 2 | 3 })} />
          <SelectSetting setting="outputPad" label="Output padding" description="Blank terminal line between response blocks." value={String(settings.outputPad)} disabled={busy} locked={locked("outputPad")} options={[{ value: "0", label: "None" }, { value: "1", label: "One line" }]} onChange={(value) => update({ outputPad: Number(value) as 0 | 1 })} />
          <NumberSetting setting="autocompleteMaxVisible" label="Autocomplete rows" description="Maximum suggestions visible in Pi’s terminal." value={settings.autocompleteMaxVisible} min={3} max={20} unit="rows" disabled={busy} locked={locked("autocompleteMaxVisible")} onSave={(value) => update({ autocompleteMaxVisible: value })} />
          <TextSetting setting="shellPath" label="Shell path" description="Executable Pi uses for shell commands. Empty restores automatic discovery." value={settings.shellPath ?? ""} placeholder="Automatic" disabled={busy} locked={locked("shellPath")} allowEmpty onSave={(value) => update({ shellPath: value === "" ? null : value })} />
          <TextSetting setting="shellCommandPrefix" label="Shell command prefix" description="Text Pi prepends to every shell command." value={settings.shellCommandPrefix ?? ""} placeholder="None" disabled={busy} locked={locked("shellCommandPrefix")} allowEmpty onSave={(value) => update({ shellCommandPrefix: value === "" ? null : value })} />
          <TextSetting setting="npmCommand" label="Package command" description="One command argument per line. Empty restores Pi’s default." value={(settings.npmCommand ?? []).join("\n")} placeholder={"bun\nadd"} disabled={busy} locked={locked("npmCommand")} multiline allowEmpty onSave={(value) => update({ npmCommand: lines(value) })} />
          <TextSetting setting="enabledModels" label="Enabled model patterns" description="One provider/model glob per line. Empty shows Pi’s full catalog." value={(settings.enabledModels ?? []).join("\n")} placeholder="provider/model-*" disabled={busy} locked={locked("enabledModels")} multiline allowEmpty onSave={(value) => update({ enabledModels: lines(value) })} />
          <p {...stylex.props(styles.jsonOnly)}><strong>JSON-only in this Pi SDK:</strong> compaction and retry tuning, branch summaries, external editor, default tools, thinking budgets, session directory, proxy and WebSocket timeout, terminal capability overrides, and code-block indentation. Edit those in Pi’s settings file; Bake Pi will not bypass Pi with its own writer.</p>
        </div>
      </details>
    </>
  )
}

const PrivacySettings = ({ settings, busy, locked, update }: SettingsProps): React.JSX.Element => (
  <>
    {/*
      The workspace's own level is stated once, by the Bake Pi group above this
      panel. It used to be repeated here as a boolean read off
      `projectTrusted`, which could not say “Full access” at all — so the two
      lines disagreed on exactly the workspace where the difference mattered.
    */}
    <SettingsGroup title="Pi’s command line" description="What Pi’s own interface does when it meets a project for the first time.">
      <SelectSetting setting="defaultProjectTrust" label="New projects in Pi’s CLI" description="Ask is the safest default; existing decisions are not changed." value={settings.defaultProjectTrust} disabled={busy} locked={false} options={[{ value: "ask", label: "Ask each time" }, { value: "never", label: "Restrict by default" }, { value: "always", label: "Trust by default" }]} onChange={(value) => update({ defaultProjectTrust: value as PiSettingsSnapshot["defaultProjectTrust"] })} />
    </SettingsGroup>
    <SettingsGroup title="Usage data" description="Independent controls owned by Pi, not Bake Pi.">
      <ToggleSetting setting="enableInstallTelemetry" label="Installation telemetry" description="Allow Pi’s anonymous installation-count ping." value={settings.enableInstallTelemetry} disabled={busy} locked={locked("enableInstallTelemetry")} onChange={(value) => update({ enableInstallTelemetry: value })} />
      <ToggleSetting setting="enableAnalytics" label="Product analytics" description="Allow Pi’s opt-in usage analytics when supported." value={settings.enableAnalytics} disabled={busy} locked={locked("enableAnalytics")} onChange={(value) => update({ enableAnalytics: value })} />
    </SettingsGroup>
    <SettingsGroup title="Provider notices" description="Warnings shown before potentially billable provider behavior.">
      <ToggleSetting setting="anthropicExtraUsageWarning" label="Anthropic extra-usage warning" description="Warn before continuing into Anthropic extra usage." value={settings.anthropicExtraUsageWarning} disabled={busy} locked={locked("anthropicExtraUsageWarning")} onChange={(value) => update({ anthropicExtraUsageWarning: value })} />
    </SettingsGroup>
  </>
)

const ResourceSourceSettings = ({ settings, busy, locked, update }: SettingsProps): React.JSX.Element => (
  <SettingsGroup title="Discovery configuration" description="Reload the inventory below after changing a source." layout="grid">
    <PackageSourcesSetting value={settings.packages} disabled={busy} locked={locked("packages")} onSave={(packages) => update({ packages })} />
    <TextSetting setting="extensionPaths" label="Extension paths" description="One global extension path or glob per line." value={settings.extensionPaths.join("\n")} placeholder="extensions/**/*.ts" disabled={busy} locked={locked("extensionPaths")} multiline allowEmpty onSave={(value) => update({ extensionPaths: lines(value) ?? [] })} />
    <TextSetting setting="skillPaths" label="Skill paths" description="One global skill path or glob per line." value={settings.skillPaths.join("\n")} placeholder="skills/**/SKILL.md" disabled={busy} locked={locked("skillPaths")} multiline allowEmpty onSave={(value) => update({ skillPaths: lines(value) ?? [] })} />
    <TextSetting setting="promptTemplatePaths" label="Prompt paths" description="One global prompt-template path or glob per line." value={settings.promptTemplatePaths.join("\n")} placeholder="prompts/*.md" disabled={busy} locked={locked("promptTemplatePaths")} multiline allowEmpty onSave={(value) => update({ promptTemplatePaths: lines(value) ?? [] })} />
    <TextSetting setting="themePaths" label="Pi theme paths" description="One global Pi terminal-theme path or glob per line." value={settings.themePaths.join("\n")} placeholder="themes/*.json" disabled={busy} locked={locked("themePaths")} multiline allowEmpty onSave={(value) => update({ themePaths: lines(value) ?? [] })} />
  </SettingsGroup>
)

/**
 * The one group heading in the settings modal, exported because the sections
 * that are not Pi-backed have groups too.
 *
 * Before this, a group was a tracked uppercase eleven-pixel word in Providers
 * and Diagnostics and a bold twelve-and-a-half-pixel line here — two heading
 * systems inside one panel, told apart only by which section a person happened
 * to be looking at.
 */
export const SettingsGroupHead = ({ title, description }: { title: string; description: string }): React.JSX.Element => (
  <div {...stylex.props(styles.groupHead)}>
    <h4 {...stylex.props(styles.groupTitle)}>{title}</h4>
    <p {...stylex.props(styles.groupDescription)}>{description}</p>
  </div>
)

/**
 * `layout` is about what the fields are, not about how much room there is.
 *
 * A column of rows is right when each row is a label and its one control:
 * reading down the labels is how a person finds the setting they came for. It
 * is wrong for the resource paths, which are four independent multi-line
 * fields — stacked, they were seven hundred pixels of mostly empty textarea,
 * and nothing about the fourth follows from the third.
 */
const SettingsGroup = ({ title, description, layout = "rows", children }: { title: string; description: string; layout?: "rows" | "grid"; children: React.ReactNode }): React.JSX.Element => (
  <section {...stylex.props(styles.group)}>
    <SettingsGroupHead title={title} description={description} />
    <div {...stylex.props(styles.groupBody, layout === "grid" && styles.groupBodyGrid)}>{children}</div>
  </section>
)

const SettingCopy = ({ id, label, description, locked }: { id: string; label: string; description: string; locked: boolean }): React.JSX.Element => (
  <span {...stylex.props(styles.copy)}>
    <span id={`${id}-title`} {...stylex.props(styles.label)}>{label}{locked ? <span {...stylex.props(styles.overrideBadge)}>Project</span> : null}</span>
    <span id={`${id}-description`} {...stylex.props(styles.description)}>{locked ? "Controlled by .pi/settings.json for this workspace." : description}</span>
  </span>
)

const ToggleSetting = ({ setting, label, description, value, disabled, locked, onChange }: { setting: PiSettingKey; label: string; description: string; value: boolean; disabled: boolean; locked: boolean; onChange: (value: boolean) => void }): React.JSX.Element => {
  const id = `pi-setting-${setting}`
  return (
    <div {...stylex.props(styles.row, (disabled || locked) && styles.rowDisabled)}>
      <SettingCopy id={id} label={label} description={description} locked={locked} />
      <button type="button" role="switch" aria-label={label} aria-checked={value} aria-describedby={`${id}-description`} disabled={disabled || locked} onClick={() => onChange(!value)} {...stylex.props(focus.control, styles.switchTrack, value && styles.switchTrackOn)}>
        <span aria-hidden="true" {...stylex.props(styles.switchThumb, value && styles.switchThumbOn)} />
      </button>
    </div>
  )
}

const SelectSetting = ({ setting, label, description, value, options, placeholder, disabled, locked, onChange }: { setting: PiSettingKey; label: string; description: string; value: string; options: readonly SelectOption[]; placeholder?: string; disabled: boolean; locked: boolean; onChange: (value: string) => void }): React.JSX.Element => {
  const id = `pi-setting-${setting}`
  return (
    <div {...stylex.props(styles.row, (disabled || locked) && styles.rowDisabled)}>
      <SettingCopy id={id} label={label} description={description} locked={locked} />
      <SelectControl
        id={id}
        inline
        value={value}
        onChange={onChange}
        disabled={disabled || locked}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        options={value === "" && placeholder !== undefined ? [{ value: "", label: placeholder }, ...options] : options}
      />
    </div>
  )
}

const TextSetting = ({ setting, label, description, value, placeholder, disabled, locked, multiline = false, allowEmpty = false, onSave }: { setting: PiSettingKey; label: string; description: string; value: string; placeholder?: string; disabled: boolean; locked: boolean; multiline?: boolean; allowEmpty?: boolean; onSave: (value: string) => void }): React.JSX.Element => {
  const id = `pi-setting-${setting}-${useId()}`
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const trimmed = draft.trim()
  const changed = draft !== value
  const canSave = changed && (allowEmpty || trimmed !== "") && !disabled && !locked
  /*
    A one-line field belongs on the row its label is on, beside the switches
    and selects it sits between, and it saves the way they do: on commit, with
    no button. Enter or leaving the field writes the value; Escape puts the
    saved one back. A filled Save beside every text row was the heaviest
    element on a panel of forty settings, for the action pressed least. Only
    the multi-line ones — a list of globs, a block of JSON — keep a labelled
    Save, because a blur mid-edit of a JSON array is not a decision.
  */
  const commit = (): void => { if (canSave) onSave(trimmed) }
  if (!multiline) {
    return (
      <div {...stylex.props(styles.row, (disabled || locked) && styles.rowDisabled)}>
        <SettingCopy id={id} label={label} description={description} locked={locked} />
        <input
          id={id}
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); commit() }
            else if (event.key === "Escape" && changed) { event.stopPropagation(); setDraft(value) }
          }}
          placeholder={placeholder}
          disabled={disabled || locked}
          spellCheck={false}
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-description`}
          {...stylex.props(focus.ring, styles.field)}
        />
      </div>
    )
  }
  return (
    <form onSubmit={(event) => { event.preventDefault(); commit() }} {...stylex.props(styles.textSetting, (disabled || locked) && styles.rowDisabled)}>
      <SettingCopy id={id} label={label} description={description} locked={locked} />
      <textarea id={id} value={draft} onChange={(event) => setDraft(event.currentTarget.value)} placeholder={placeholder} disabled={disabled || locked} rows={2} spellCheck={false} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} {...stylex.props(scrollbars.thin, focus.ring, styles.textarea)} />
      {changed ? <button type="submit" disabled={!canSave} {...stylex.props(focus.control, styles.save)}><Save size={13} aria-hidden="true" /> Save</button> : null}
    </form>
  )
}

const NumberSetting = ({ setting, label, description, value, min, max, unit, disabled, locked, onSave }: { setting: PiSettingKey; label: string; description: string; value: number; min: number; max: number; unit: string; disabled: boolean; locked: boolean; onSave: (value: number) => void }): React.JSX.Element => {
  const id = `pi-setting-${setting}-${useId()}`
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const parsed = Number(draft)
  const canSave = Number.isInteger(parsed) && parsed >= min && parsed <= max && parsed !== value && !disabled && !locked
  // Committed like the text field: a value that is out of range or unchanged
  // is put back on blur rather than left sitting in the field looking saved.
  const commit = (): void => { if (canSave) onSave(parsed); else setDraft(String(value)) }
  return (
    <div {...stylex.props(styles.row, (disabled || locked) && styles.rowDisabled)}>
      <SettingCopy id={id} label={label} description={description} locked={locked} />
      <div {...stylex.props(styles.rowControls)}>
        <input
          id={id}
          type="number"
          value={draft}
          min={min}
          max={max}
          step={1}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); commit() }
            else if (event.key === "Escape" && draft !== String(value)) { event.stopPropagation(); setDraft(String(value)) }
          }}
          disabled={disabled || locked}
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-description`}
          {...stylex.props(focus.ring, styles.numberField)}
        />
        <span {...stylex.props(styles.unit)}>{unit}</span>
      </div>
    </div>
  )
}

const PackageSourcesSetting = ({ value, disabled, locked, onSave }: { value: PiPackageSource[]; disabled: boolean; locked: boolean; onSave: (value: PiPackageSource[]) => void }): React.JSX.Element => {
  const id = `pi-setting-packages-${useId()}`
  const serialized = JSON.stringify(value, null, 2)
  const [draft, setDraft] = useState(serialized)
  const [error, setError] = useState<string>()
  useEffect(() => { setDraft(serialized); setError(undefined) }, [serialized])
  const changed = draft !== serialized
  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    const parsed = parsePackageSources(draft)
    if (parsed === undefined) {
      setError("Use a JSON array of package names or package filter objects with a source.")
      return
    }
    setError(undefined)
    onSave(parsed)
  }
  return (
    <form onSubmit={submit} {...stylex.props(styles.textSetting, styles.groupBodyWide, (disabled || locked) && styles.rowDisabled)}>
      <SettingCopy id={id} label="Package sources" description="Pi package names, or filtered source objects in Pi’s native JSON format." locked={locked} />
      <textarea id={id} value={draft} onChange={(event) => { setDraft(event.currentTarget.value); setError(undefined) }} disabled={disabled || locked} rows={6} spellCheck={false} aria-invalid={error !== undefined} aria-labelledby={`${id}-title`} aria-describedby={error === undefined ? `${id}-description` : `${id}-description ${id}-error`} {...stylex.props(scrollbars.thin, focus.ring, styles.textarea, error !== undefined && styles.textareaError)} />
      {error === undefined ? null : <span id={`${id}-error`} role="alert" {...stylex.props(styles.fieldError)}>{error}</span>}
      {changed ? <button type="submit" disabled={disabled || locked} {...stylex.props(focus.control, styles.save)}><Save size={13} aria-hidden="true" /> Save package sources</button> : null}
    </form>
  )
}

const option = (value: string): SelectOption => ({ value, label: sentence(value) })
/** A model as a row: its lab's mark, its name, and the provider serving it as the hint. */
const modelOption = (model: Model): SelectOption => ({ value: modelKey(model.providerId, model.id), label: model.displayName, hint: model.providerId, glyph: <LabIcon mark={labMarkForModel({ id: model.id, providerId: model.providerId })} size="icon" /> })
const sentence = (value: string): string => value[0]!.toLocaleUpperCase() + value.slice(1).replaceAll("-", " ")
const modelKey = (providerId: string, modelId: string): string => `${providerId}\u0000${modelId}`
const lines = (value: string): string[] | null => {
  const entries = value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)
  return entries.length === 0 ? null : entries
}
const RESOURCE_KEYS: readonly PiSettingKey[] = ["packages", "extensionPaths", "skillPaths", "promptTemplatePaths", "themePaths"]
const isResourcePatch = (patch: PiSettingsPatch): boolean => RESOURCE_KEYS.some((key) => Object.hasOwn(patch, key))
const parsePackageSources = (value: string): PiPackageSource[] | undefined => {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return undefined }
  if (!Array.isArray(parsed) || parsed.length > 128) return undefined
  return parsed.every(isPackageSource) ? parsed : undefined
}
const isPackageSource = (value: unknown): value is PiPackageSource => {
  if (typeof value === "string") return value.length >= 1 && value.length <= 4096
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  const allowed = new Set(["source", "autoload", "extensions", "skills", "prompts", "themes"])
  return Object.keys(entry).every((key) => allowed.has(key))
    && typeof entry["source"] === "string" && entry["source"].length >= 1 && entry["source"].length <= 4096
    && (entry["autoload"] === undefined || typeof entry["autoload"] === "boolean")
    && ["extensions", "skills", "prompts", "themes"].every((key) => entry[key] === undefined || isResourcePatternList(entry[key]))
}
const isResourcePatternList = (value: unknown): value is string[] => Array.isArray(value)
  && value.length <= 128
  && value.every((entry) => typeof entry === "string" && entry.length >= 1 && entry.length <= 4096)

/**
 * One card per group, rows told apart by a line.
 *
 * The body used to be a `sunken` well holding `surface` row cards holding
 * `surfaceRaised` controls, each step with its own border and shadow: four
 * nested surfaces before the value. The group is now one `surface` card with
 * the ordinary lift, its rows separated by a one-pixel `border` rule, and its
 * controls a recess in the card rather than a thing standing on it. Shape
 * still comes from fill and elevation; the divider is the one line, because a
 * row that is not an object should not be boxed like one.
 */
const styles = stylex.create({
  panel: { display: "flex", flexDirection: "column", gap: space.xl },
  loading: { minHeight: "240px", display: "flex", flexDirection: "column", justifyContent: "center", gap: space.lg, paddingBlock: space.xl, color: colors.textMuted, fontSize: typography.caption, lineHeight: typography.captionLine },
  loadingStatus: { display: "flex", alignItems: "center", gap: space.sm },
  loadingHint: { display: "flex", flexDirection: "column", gap: space.sm },
  skeletonLine: { display: "block", height: "8px", backgroundColor: colors.surfaceRaised, borderRadius: radius.sm },
  skeletonTitle: { width: "32%" },
  skeletonCopy: { width: "58%" },
  skeletonRows: { display: "flex", flexDirection: "column", gap: "1px", backgroundColor: colors.border, borderRadius: radius.lg, overflow: "hidden", boxShadow: effects.lift },
  skeletonRow: { display: "block", height: "48px", backgroundColor: colors.surface },
  retry: { alignSelf: "flex-start", minHeight: size.control, paddingInline: space.md, color: { default: colors.textMuted, ":hover": colors.text }, backgroundColor: { default: colors.sunken, ":hover": colors.accentSoft }, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.border, borderRadius: radius.md, cursor: "pointer", fontFamily: typography.ui, fontSize: typography.label },
  overrideNote: { display: "grid", gridTemplateColumns: "16px minmax(0, 1fr)", gap: space.sm, padding: space.sm, color: colors.warning, backgroundColor: colors.warningSoft, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.borderStrong, borderRadius: radius.md, fontSize: typography.caption, lineHeight: typography.captionLine },
  group: { display: "flex", flexDirection: "column", gap: space.sm },
  /** Title and its one line, on one baseline: the description is a gloss on the title, not a paragraph under it. */
  groupHead: { display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: space.md, paddingInline: space.xs },
  groupTitle: { margin: 0, color: colors.text, fontSize: typography.body, lineHeight: typography.bodyLine, fontWeight: 600 },
  groupDescription: { margin: 0, color: colors.textFaint, fontSize: typography.caption, lineHeight: typography.captionLine },
  groupBody: { display: "flex", flexDirection: "column", backgroundColor: colors.surface, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.border, borderRadius: radius.lg, boxShadow: effects.lift, overflow: "hidden" },
  groupBodyGrid: {
    display: "grid",
    gridTemplateColumns: { default: "minmax(0, 1fr)", "@container (min-width: 640px)": "repeat(2, minmax(0, 1fr))" },
    alignItems: "start",
  },
  /** A field that reads across the whole group rather than sharing a row. */
  groupBodyWide: { gridColumn: "1 / -1" },
  /**
   * The divider is drawn by the row, on its top edge, and the first row draws
   * none. `:first-child` rather than a JS index because rows arrive from a
   * dozen call sites as siblings, and a card that has to be told which of its
   * children is first is a card every call site can get wrong.
   */
  row: {
    minWidth: 0, minHeight: "48px", boxSizing: "border-box", display: "grid",
    gridTemplateColumns: { default: "minmax(0, 1fr)", "@container (min-width: 400px)": "minmax(0, 1fr) auto" },
    alignItems: "center", gap: { default: space.sm, "@container (min-width: 400px)": space.xl },
    paddingBlock: space.sm, paddingInline: space.lg,
    borderTopWidth: { default: "1px", ":first-child": 0 }, borderTopStyle: "solid", borderTopColor: colors.border,
  },
  textSetting: {
    minWidth: 0, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: space.sm, paddingBlock: space.md, paddingInline: space.lg,
    borderTopWidth: { default: "1px", ":first-child": 0 }, borderTopStyle: "solid", borderTopColor: colors.border,
  },
  rowDisabled: { opacity: 0.66 },
  copy: { minWidth: 0, display: "flex", flexDirection: "column", gap: "2px" },
  label: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: space.xs, color: colors.text, fontSize: typography.body, lineHeight: typography.bodyLine, fontWeight: 500 },
  description: { maxWidth: size.measure, color: colors.textMuted, fontSize: typography.caption, lineHeight: typography.captionLine },
  overrideBadge: { paddingInline: space.xs, color: colors.warning, backgroundColor: colors.warningSoft, borderRadius: radius.sm, fontSize: typography.micro, lineHeight: typography.microLine, fontWeight: 600 },
  /**
   * Reshaped's Switch, in this interface's geometry: a 36×20 track with a
   * square thumb, because the radius scale here stops at four pixels. The
   * track is a recess when off and the accent when on; nothing is drawn
   * around it.
   */
  switchTrack: { justifySelf: "end", width: "36px", height: "20px", boxSizing: "border-box", display: "flex", alignItems: "center", padding: "2px", color: colors.textMuted, backgroundColor: { default: colors.sunken, ":hover": colors.accentSoft, ":disabled": colors.sunken }, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.borderStrong, borderRadius: radius.md, cursor: { default: "pointer", ":disabled": "not-allowed" }, transitionProperty: "background-color, box-shadow", transitionDuration: motion.fast, transitionTimingFunction: motion.settle },
  switchTrackOn: { backgroundColor: { default: colors.accent, ":hover": colors.accentHover, ":disabled": colors.accent } },
  switchThumb: { width: "16px", height: "16px", backgroundColor: colors.textMuted, borderRadius: radius.sm, transform: "translateX(0)", transitionProperty: "background-color, transform", transitionDuration: motion.moderate, transitionTimingFunction: motion.move },
  switchThumbOn: { backgroundColor: colors.accentOn, transform: "translateX(16px)" },
  /** The same recess the select is, at the same width and dense height. */
  field: { width: { default: "100%", "@container (min-width: 400px)": size.controlWidth }, minWidth: 0, height: size.controlDense, boxSizing: "border-box", paddingInline: space.md, color: colors.text, backgroundColor: { default: colors.sunken, ":hover": colors.accentSoft, ":focus": colors.sunken }, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.borderStrong, borderRadius: radius.md, fontFamily: typography.ui, fontSize: typography.label, "::placeholder": { color: colors.textFaint } },
  textarea: {
    width: "100%", minWidth: 0, minHeight: "64px", maxHeight: "320px", boxSizing: "border-box",
    overflowY: "auto", scrollbarGutter: "stable", resize: "vertical",
    paddingBlock: space.sm, paddingInline: space.md,
    color: colors.text, caretColor: colors.accent, backgroundColor: colors.sunken,
    borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.borderStrong, borderRadius: radius.md,
    transitionProperty: "background-color, border-color, box-shadow", transitionDuration: motion.fast, transitionTimingFunction: motion.settle,
    fontFamily: typography.mono, fontSize: typography.label, lineHeight: typography.bodyLine,
    "::placeholder": { color: colors.textFaint },
  },
  textareaError: { backgroundColor: colors.dangerSoft, borderColor: colors.danger },
  composite: {
    display: "flex", flexDirection: "column", gap: space.sm, paddingBlock: space.md, paddingInline: space.lg,
    borderTopWidth: { default: "1px", ":first-child": 0 }, borderTopStyle: "solid", borderTopColor: colors.border,
  },
  compositeControls: { display: "grid", gridTemplateColumns: { default: "minmax(0, 1fr)", "@container (min-width: 400px)": `minmax(0, 1fr) ${size.controlWidth}` }, gap: space.sm },
  /**
   * The right-hand cluster of a settings row: a field and its unit.
   *
   * `justifySelf: end` is what keeps its edge on the same vertical as the
   * switches and selects in the rows around it.
   */
  rowControls: { minWidth: 0, display: "flex", alignItems: "center", justifySelf: { default: "stretch", "@container (min-width: 400px)": "end" }, gap: space.sm },
  numberField: { width: "88px", height: size.controlDense, boxSizing: "border-box", paddingInline: space.md, color: colors.text, backgroundColor: { default: colors.sunken, ":hover": colors.accentSoft, ":focus": colors.sunken }, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.borderStrong, borderRadius: radius.md, fontFamily: typography.mono, fontSize: typography.label, fontVariantNumeric: "tabular-nums", textAlign: "end" },
  unit: { minWidth: "48px", color: colors.textMuted, fontSize: typography.caption, lineHeight: typography.captionLine },
  fieldError: { color: colors.danger, fontSize: typography.caption, lineHeight: typography.captionLine },
  /** The one filled button left in a Pi panel, and it appears only once there is something to save. */
  save: { minHeight: size.controlDense, display: "inline-flex", alignItems: "center", gap: space.xs, paddingInline: space.md, color: { default: colors.accentOn, ":disabled": colors.textFaint }, backgroundColor: { default: colors.accent, ":hover": colors.accentHover, ":disabled": colors.sunken }, borderWidth: 0, borderRadius: radius.md, cursor: { default: "pointer", ":disabled": "not-allowed" }, transform: { default: "scale(1)", ":active": "scale(0.97)" }, transitionProperty: "background-color, box-shadow, transform", transitionDuration: motion.fast, transitionTimingFunction: motion.settle, fontFamily: typography.ui, fontSize: typography.label, fontWeight: 600 },
  /** The advanced disclosure is the same card the groups are, closed by default. */
  advanced: { backgroundColor: colors.surface, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.border, borderRadius: radius.lg, boxShadow: effects.lift, overflow: "hidden" },
  advancedSummary: { minHeight: "48px", boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.sm, paddingInline: space.lg, color: colors.text, cursor: "pointer", listStyle: "none", fontSize: typography.body, lineHeight: typography.bodyLine, fontWeight: 500, "::-webkit-details-marker": { display: "none" } },
  advancedHint: { color: colors.textFaint, fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" },
  advancedBody: { display: "flex", flexDirection: "column" },
  advancedCopy: { margin: 0, paddingBlock: space.sm, paddingInline: space.lg, color: colors.textMuted, fontSize: typography.caption, lineHeight: typography.captionLine, borderTopWidth: "1px", borderTopStyle: "solid", borderTopColor: colors.border },
  jsonOnly: { margin: 0, paddingBlock: space.sm, paddingInline: space.lg, color: colors.textMuted, fontSize: typography.caption, lineHeight: typography.captionLine, borderTopWidth: "1px", borderTopStyle: "solid", borderTopColor: colors.border },
})
