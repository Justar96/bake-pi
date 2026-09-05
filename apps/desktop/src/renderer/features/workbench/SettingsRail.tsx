import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import * as stylex from "@stylexjs/stylex"
import {
  Blocks,
  BookOpen,
  BrainCircuit,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleOff,
  FileText,
  Gauge,
  KeyRound,
  Download,
  PackageOpen,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  SunMoon,
  X,
} from "lucide-react"
import type { CommandResult, Model, Provider, Resource, TrustLevel } from "@bake-pi/contract"
import { TRUST_LABELS } from "../conversation/trust-level.ts"
import { LabIcon } from "../../ui/LabIcon.tsx"
import { labMarkForProvider, labMarkForResource } from "../../ui/lab-icons.ts"
import { store, type ExtensionError } from "../../store/session-store.ts"
import { spinners } from "../../theme/spinners.ts"
import { scrollbars } from "../../theme/scrollbars.ts"
import type { ThemeChoice } from "../../theme/appearance.ts"
import type { StepDisclosure } from "../conversation/disclosure.ts"
import { colors, effects, motion, radius, space, typography } from "../../theme/tokens.stylex.ts"
import { a11y } from "../../theme/a11y.ts"
import { focus } from "../../theme/focus.ts"
import { size } from "../../theme/sizes.stylex.ts"
import { Modal } from "./Overlay.tsx"
import { credentialLifetimeWarning } from "./ui-copy.ts"
import { PiEngineSettings, type PiEngineController, usePiEngineController } from "./PiEngine.tsx"
import { PiSettings, type PiSettingsController, SettingsGroupHead, usePiSettingsController } from "./PiSettings.tsx"
import { SelectControl } from "./SelectControl.tsx"

export type SettingsSection = "providers" | "agent" | "resources" | "privacy" | "engine" | "diagnostics" | "appearance"
type DiagnosticsData = { runtime?: CommandResult<"get_runtime_info">; diagnostics?: CommandResult<"get_diagnostics">; timings?: CommandResult<"get_timings"> }
interface DiagnosticsController { data: DiagnosticsData; refreshing: boolean; error: boolean; load: () => void }
type ResourcePackageUpdate = CommandResult<"check_resource_updates">["updates"][number]
interface PiUpdate { currentVersion: string; latestVersion: string }
interface ResourcesController {
  refreshing: boolean
  checking: boolean
  updating: boolean
  checked: boolean
  error: boolean
  updates: ResourcePackageUpdate[]
  reload: () => void
  update: () => void
}

/**
 * Six sections in two groups, by who owns the answer.
 *
 * Providers, Agent, Resources and Privacy write to Pi — its credential store,
 * its global settings file, its trust store — and Pi's command line reads the
 * same values. Appearance and Diagnostics are this application's own. The
 * index says so with a group label over each, because a flat list of six put
 * "the theme of this window" beside "what Pi's CLI does on first open" as if
 * they were the same kind of thing.
 *
 * A section carries only its label: the header is the section's heading, and
 * the group titles inside the panel say the rest.
 */
const SECTION_GROUPS: readonly { label: string; sections: readonly { id: SettingsSection; label: string; Glyph: typeof KeyRound }[] }[] = [
  { label: "Pi", sections: [
    { id: "providers", label: "Providers", Glyph: KeyRound },
    { id: "agent", label: "Agent", Glyph: BrainCircuit },
    { id: "resources", label: "Resources", Glyph: Blocks },
    { id: "privacy", label: "Privacy", Glyph: ShieldCheck },
  ] },
  { label: "Bake Pi", sections: [
    /*
      Under Bake Pi rather than Pi, and the placement is an argument. Every
      section in the group above writes to state Pi owns and Pi's command line
      reads back. This one decides which Pi exists to own anything — a choice
      about this application's own installation, which the command line neither
      sees nor shares.
    */
    { id: "engine", label: "Pi engine", Glyph: PackageOpen },
    { id: "appearance", label: "Appearance", Glyph: SunMoon },
    { id: "diagnostics", label: "Diagnostics", Glyph: Gauge },
  ] },
]
const SECTIONS = SECTION_GROUPS.flatMap((group) => group.sections)

/**
 * What the header's one control does, per section, and what it says while it
 * does it.
 *
 * Three sections used to carry a refresh of their own — "Refresh" in Pi's
 * panel head, "Reload" above the inventory, "Refresh" beside the log, plus a
 * "Try again" inside the diagnostics error box — in three positions, so the
 * control moved every time the view did. There is one now, in the header,
 * where it is the only thing that can act on a whole section. Its wording
 * still differs where the action does: Resources re-runs Pi's discovery rather
 * than re-reading what Pi already holds.
 */
interface SectionRefresh {
  /** What the control says. Two words in the interface, because two actions. */
  label: string
  /**
   * What it announces, which names the thing rather than the verb: one header
   * control that reads "Refresh" to a screen reader in four different sections
   * is four controls with the same name.
   */
  announce: string
  run: () => void
  busy: boolean
}

/**
 * A section's single line of feedback, in the one place a section reports.
 *
 * The tone is separate from the message because the glyph is what a person
 * reads first, and two of the three states are not "done": a busy line wearing
 * a check mark says a save happened when nothing has. There is no resting
 * state: a section with nothing to report shows nothing, rather than a
 * permanent line explaining where saves go.
 */
interface SectionStatus { message: string; tone: "busy" | "done" | "error" }

/**
 * The workspace's settings surface.
 *
 * Settings are a temporary task rather than session activity, so this surface
 * is modal. The section index stays fixed while the selected panel scrolls;
 * the shared modal owns the scrim, focus trap, Escape handling, and restoration
 * to whichever control opened it.
 */
export const SettingsModal = ({
  providers,
  models,
  resources,
  extensionErrors,
  piUpdate,
  section: active,
  onSection,
  workspaceTrust,
  theme,
  onTheme,
  disclosure,
  onDisclosure,
  onClose,
}: {
  providers: Provider[]
  models: Model[]
  resources: Resource[]
  extensionErrors: ExtensionError[]
  piUpdate: PiUpdate | undefined
  section: SettingsSection
  onSection: (section: SettingsSection) => void
  /** The open workspace's level, so Privacy can state what is in force before it offers a default. */
  workspaceTrust: TrustLevel
  theme: ThemeChoice
  onTheme: (theme: ThemeChoice) => void
  disclosure: StepDisclosure
  onDisclosure: (disclosure: StepDisclosure) => void
  onClose: () => void
}): React.JSX.Element => {
  const tabs = useRef(new Map<SettingsSection, HTMLButtonElement>())
  const body = useRef<HTMLDivElement>(null)
  const piSettings = usePiSettingsController(active === "agent" || active === "resources" || active === "privacy")
  const engine = usePiEngineController(active === "engine")
  const diagnostics = useDiagnosticsController(active === "diagnostics")
  const resourceInventory = useResourcesController(active === "resources")
  const current = SECTIONS.find((section) => section.id === active)!
  const refresh = sectionRefresh(active, piSettings, diagnostics, resourceInventory, engine)
  const status = sectionStatus(active, piSettings, diagnostics, resourceInventory, engine)

  useLayoutEffect(() => {
    body.current?.scrollTo({ top: 0 })
  }, [active])

  const refreshControl = refresh === undefined ? undefined : (
    <button
      type="button"
      onClick={refresh.run}
      disabled={refresh.busy}
      aria-label={refresh.announce}
      {...stylex.props(focus.control, styles.headerRefresh)}
    >
      <RefreshCw size={14} aria-hidden="true" {...stylex.props(refresh.busy && spinners.rotate)} />
      <span {...stylex.props(styles.headerRefreshLabel)}>{refresh.busy ? "Refreshing…" : refresh.label}</span>
    </button>
  )

  const activate = (section: SettingsSection): void => {
    if (section !== active) onSection(section)
    tabs.current.get(section)?.focus()
  }

  const move = (from: SettingsSection, direction: -1 | 1): void => {
    const index = SECTIONS.findIndex((section) => section.id === from)
    const next = SECTIONS[(index + direction + SECTIONS.length) % SECTIONS.length]!
    activate(next.id)
  }

  const renderSection = (): React.JSX.Element => {
    switch (active) {
      case "providers": return <ProviderSettings providers={providers} />
      case "agent": return <PiSettings area="agent" models={models} controller={piSettings} />
      /*
        The inventory first, because it is what the section is opened for; the
        five discovery paths and the package JSON sit under a closed disclosure
        beneath it. They used to stand above the list — seven hundred pixels of
        textarea between a person and the extension they came to check.
      */
      case "resources": return (
        <div {...stylex.props(styles.settingsStack)}>
          <ResourceSettings resources={resources} extensionErrors={extensionErrors} piUpdate={piUpdate} onShowEngine={() => { onSection("engine") }} controller={resourceInventory} />
          <details {...stylex.props(styles.sources)}>
            <summary {...stylex.props(focus.control, styles.sourcesSummary)}>
              <span>Sources</span>
              <span {...stylex.props(styles.sourcesHint)}>Packages · paths</span>
            </summary>
            <div {...stylex.props(styles.sourcesBody)}><PiSettings area="resources" models={models} controller={piSettings} /></div>
          </details>
        </div>
      )
      /*
        Two owners on one panel, Bake Pi's first. The permission level is the
        choice a person came to this section to make — it is the one on the
        prompt bar — and Pi's own `defaultProjectTrust` below it decides
        something narrower: whether Pi's command line asks. Stated in that order
        so the more specific setting is not read as the general one.
      */
      case "privacy": return <div {...stylex.props(styles.settingsStack)}><WorkspacePermissionSettings trust={workspaceTrust} /><PiSettings area="privacy" models={models} controller={piSettings} /></div>
      case "engine": return <PiEngineSettings controller={engine} />
      case "diagnostics": return <DiagnosticsSettings controller={diagnostics} />
      case "appearance": return <AppearanceSettings theme={theme} onTheme={onTheme} disclosure={disclosure} onDisclosure={onDisclosure} />
    }
  }

  return (
    <Modal id="settings-modal" title={current.label} onClose={onClose} closeLabel="Close settings" aside={refreshControl} wide contained>
      <div {...stylex.props(styles.layout)}>
        <div role="tablist" aria-label="Settings sections" aria-orientation="vertical" {...stylex.props(styles.sectionTabs)}>
          <span aria-hidden="true" {...stylex.props(styles.indexEyebrow)}>Settings</span>
          {SECTION_GROUPS.map((group) => (
            <div key={group.label} role="group" aria-label={group.label} {...stylex.props(styles.sectionGroup)}>
              <span aria-hidden="true" {...stylex.props(styles.sectionGroupLabel)}>{group.label}</span>
              {group.sections.map((section) => {
                const selected = section.id === active
                return (
                  <button
                    key={section.id}
                    id={`settings-tab-${section.id}`}
                    ref={(node) => {
                      if (node === null) tabs.current.delete(section.id)
                      else tabs.current.set(section.id, node)
                    }}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls={`settings-panel-${section.id}`}
                    tabIndex={selected ? 0 : -1}
                    data-autofocus={selected ? "true" : undefined}
                    onClick={() => activate(section.id)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown" || event.key === "ArrowRight") move(section.id, 1)
                      else if (event.key === "ArrowUp" || event.key === "ArrowLeft") move(section.id, -1)
                      else if (event.key === "Home") activate(SECTIONS[0]!.id)
                      else if (event.key === "End") activate(SECTIONS.at(-1)!.id)
                      else return
                      event.preventDefault()
                    }}
                    {...stylex.props(focus.control, styles.sectionTab, selected && styles.sectionTabActive)}
                  >
                    <section.Glyph size={16} aria-hidden="true" {...stylex.props(styles.sectionGlyph, selected && styles.sectionGlyphActive)} />
                    <span {...stylex.props(styles.sectionLabel)}>{section.label}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>

        <div ref={body} {...stylex.props(scrollbars.thin, styles.body)}>
          <section
            key={active}
            id={`settings-panel-${active}`}
            role="tabpanel"
            aria-labelledby={`settings-tab-${active}`}
            {...stylex.props(styles.panel)}
          >
            {renderSection()}
          </section>
        </div>
        {status === undefined ? null : <SectionStatusLine status={status} />}
      </div>
    </Modal>
  )
}

/**
 * Reloading the inventory is a command to Pi, so its progress lives beside the
 * other two controllers rather than inside the list it replaces — that is what
 * lets the header drive it and the panel keep showing the previous inventory
 * while Pi rediscovers.
 */
const useResourcesController = (enabled: boolean): ResourcesController => {
  const [refreshing, setRefreshing] = useState(false)
  const [checking, setChecking] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [checked, setChecked] = useState(false)
  const [error, setError] = useState(false)
  const reloadInFlight = useRef(false)
  const checkInFlight = useRef(false)
  const updateInFlight = useRef(false)
  const [updates, setUpdates] = useState<ResourcePackageUpdate[]>([])

  const check = useCallback((): void => {
    if (checkInFlight.current) return
    checkInFlight.current = true
    setChecking(true)
    setError(false)
    void store.checkResourceUpdates()
      .then((available) => { setUpdates(available); setChecked(true) })
      .catch((cause: unknown) => { store.capture(cause); setError(true) })
      .finally(() => { checkInFlight.current = false; setChecking(false) })
  }, [])

  useEffect(() => {
    if (enabled) check()
  }, [check, enabled])

  const reload = (): void => {
    if (reloadInFlight.current) return
    reloadInFlight.current = true
    setRefreshing(true)
    setError(false)
    void store.reloadResources()
      .then(check)
      .catch((cause: unknown) => { store.capture(cause); setError(true) })
      .finally(() => { reloadInFlight.current = false; setRefreshing(false) })
  }

  const update = (): void => {
    if (updateInFlight.current) return
    updateInFlight.current = true
    setUpdating(true)
    setError(false)
    void store.updateResources()
      .then(() => { setUpdates([]); setChecked(true) })
      .catch((cause: unknown) => { store.capture(cause); setError(true) })
      .finally(() => { updateInFlight.current = false; setUpdating(false) })
  }

  return { refreshing, checking, updating, checked, error, updates, reload, update }
}

const sectionRefresh = (section: SettingsSection, pi: PiSettingsController, diagnostics: DiagnosticsController, inventory: ResourcesController, engine: PiEngineController): SectionRefresh | undefined => {
  switch (section) {
    case "diagnostics": return { label: "Refresh", announce: "Refresh diagnostics", run: diagnostics.load, busy: diagnostics.refreshing }
    case "engine": return { label: "Refresh", announce: "Re-read installed Pi versions", run: engine.load, busy: engine.busy !== undefined }
    case "resources": return { label: "Reload", announce: "Reload Pi resources and check for package updates", run: () => { pi.load(); inventory.reload() }, busy: pi.busy || inventory.refreshing || inventory.checking || inventory.updating }
    case "agent": case "privacy": return { label: "Refresh", announce: "Refresh Pi settings", run: pi.load, busy: pi.busy }
    /*
      Providers and Appearance have nothing to re-read. Provider availability
      arrives on its own events, and a theme is this renderer's own choice — a
      refresh there would be a control that does nothing, which is worse than
      no control at all.
    */
    case "providers": case "appearance": return undefined
  }
}

const sectionStatus = (section: SettingsSection, pi: PiSettingsController, diagnostics: DiagnosticsController, inventory: ResourcesController, engine: PiEngineController): SectionStatus | undefined => {
  if (section === "diagnostics") {
    if (diagnostics.error) return { message: "Diagnostics could not be refreshed. Existing results are unchanged.", tone: "error" }
    if (diagnostics.refreshing) return { message: "Refreshing diagnostics…", tone: "busy" }
    if (diagnostics.data.runtime === undefined) return { message: "Reading runtime information from the host…", tone: "busy" }
    return undefined
  }
  if (section === "engine") {
    if (engine.error !== undefined) return { message: engine.error, tone: "error" }
    if (engine.busy === "selecting") return { message: "Restarting the agent host onto the selected Pi…", tone: "busy" }
    if (engine.busy === "removing") return { message: "Removing the installed Pi…", tone: "busy" }
    if (engine.busy === "checking") return { message: "Asking upstream what it has published…", tone: "busy" }
    return undefined
  }
  if (section === "providers" || section === "appearance") return undefined
  if (section === "resources" && inventory.error) return { message: "Pi could not reload the resource inventory. The previous one is unchanged.", tone: "error" }
  if (section === "resources" && inventory.updating) return { message: "Pi is updating packages and reloading their resources…", tone: "busy" }
  if (section === "resources" && inventory.checking) return { message: "Checking configured Pi packages for updates…", tone: "busy" }
  if (section === "resources" && inventory.refreshing) return { message: "Asking Pi to rediscover resources…", tone: "busy" }
  /*
    A notice carries the area it came from so a save in Agent does not report
    itself under Resources, which is the one thing sharing a controller across
    three sections could get wrong.
  */
  const notice = pi.notice?.area === undefined || pi.notice.area === section ? pi.notice : undefined
  if (notice !== undefined) return { message: notice.message, tone: notice.kind === "error" ? "error" : "done" }
  if (pi.operation === "save") return { message: "Saving to Pi…", tone: "busy" }
  if (pi.operation === "refresh") return { message: "Reading Pi’s global settings…", tone: "busy" }
  return undefined
}

/**
 * One line, one place: a toast in the modal's bottom corner.
 *
 * It floats over the panel rather than sitting in it, so nothing below moves
 * when a save reports back and nothing is reserved for it when there is
 * nothing to say. The glyph is what distinguishes the three states at a
 * glance; the role is what distinguishes them to a screen reader, and an error
 * is the only one worth interrupting for.
 */
const SectionStatusLine = ({ status }: { status: SectionStatus }): React.JSX.Element => (
  <p role={status.tone === "error" ? "alert" : "status"} {...stylex.props(styles.status, status.tone === "error" && styles.statusError, status.tone === "done" && styles.statusDone)}>
    {status.tone === "error"
      ? <CircleAlert size={14} aria-hidden="true" {...stylex.props(styles.statusGlyph)} />
      : status.tone === "busy"
        ? <RefreshCw size={14} aria-hidden="true" {...stylex.props(styles.statusGlyph, spinners.rotate)} />
        : <CircleCheck size={14} aria-hidden="true" {...stylex.props(styles.statusGlyph)} />}
    <span>{status.message}</span>
  </p>
)

const ProviderSettings = ({ providers }: { providers: Provider[] }): React.JSX.Element => {
  const input = useRef<HTMLInputElement>(null)
  const apiKeyProviders = providers.filter((provider) => provider.supportedAuth.includes("api_key"))
  const [providerId, setProviderId] = useState(apiKeyProviders[0]?.id ?? "")
  const [busy, setBusy] = useState(false)
  const [busyProvider, setBusyProvider] = useState<string>()
  const [message, setMessage] = useState<{ text: string; error: boolean }>()

  useEffect(() => {
    if (apiKeyProviders.some((provider) => provider.id === providerId)) return
    setProviderId(apiKeyProviders[0]?.id ?? "")
  }, [providers, providerId])

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const apiKey = input.current?.value ?? ""
    if (providerId === "" || apiKey === "") return
    setBusy(true)
    setMessage(undefined)
    try {
      await store.authenticate(providerId, apiKey)
      setMessage({ text: "Key is active for this agent-host process.", error: false })
    } catch (error) {
      store.capture(error)
      setMessage({ text: "The provider did not accept that key.", error: true })
    } finally {
      if (input.current !== null) input.current.value = ""
      setBusy(false)
    }
  }

  const logout = (provider: Provider): void => {
    setBusyProvider(provider.id)
    setMessage(undefined)
    void store.logout(provider.id)
      .then(() => setMessage({ text: `${provider.displayName} was signed out of Pi.`, error: false }))
      .catch((error: unknown) => {
        store.capture(error)
        setMessage({ text: `${provider.displayName} could not be signed out.`, error: true })
      })
      .finally(() => setBusyProvider(undefined))
  }

  return (
    <>
      {apiKeyProviders.length === 0 ? null : (
        <section aria-label="Use an API key" {...stylex.props(styles.formSection)}>
          <SettingsGroupHead title="Use an API key" description="Sent straight to Pi and kept only by this host process" />
          <form onSubmit={(event) => void submit(event)} {...stylex.props(styles.card)}>
            <div {...stylex.props(styles.row)}>
              <span id="provider-label" {...stylex.props(styles.rowTitle)}>Provider</span>
              <SelectControl id="provider" aria-labelledby="provider-label" inline value={providerId} onChange={setProviderId} options={apiKeyProviders.map((provider) => ({ value: provider.id, label: provider.displayName, glyph: <LabIcon mark={labMarkForProvider(provider.id)} size="icon" /> }))} />
            </div>
            <div {...stylex.props(styles.row)}>
              <span {...stylex.props(styles.rowText)}>
                <label htmlFor="api-key" {...stylex.props(styles.rowTitle)}>API key</label>
                <span id="credential-lifetime" {...stylex.props(styles.rowNote)}>{credentialLifetimeWarning}</span>
              </span>
              <span {...stylex.props(styles.rowControls)}>
                <input id="api-key" ref={input} type="password" autoComplete="off" spellCheck={false} aria-describedby="credential-lifetime" {...stylex.props(focus.ring, styles.keyField)} />
                <button type="submit" disabled={busy || providerId === ""} {...stylex.props(focus.control, styles.submit)}>{busy ? "Checking…" : "Use key"}</button>
              </span>
            </div>
          </form>
        </section>
      )}
      <SettingsGroupHead title="Model access" description="Which providers Pi can use right now" />
      {providers.length === 0 ? <p {...stylex.props(styles.quiet)}>Provider availability appears after discovery finishes.</p> : (
        <ul {...stylex.props(styles.list, styles.card)}>
          {providers.map((provider) => {
            const available = provider.authStatus === "authenticated" || provider.authStatus === "environment"
            return (
              <li key={provider.id} {...stylex.props(styles.row, styles.providerRow)}>
                {/*
                  The mark gets a column of its own rather than a slot in the
                  text, so the provider names stay on one left edge whether or
                  not a mark exists for the row. This is the one surface that
                  reserves the space: a settings list is read down the column
                  of names, and a name that steps right on the rows Pi has a
                  logo for is worse than a gap.
                */}
                <span aria-hidden="true" {...stylex.props(styles.providerMark)}><LabIcon mark={labMarkForProvider(provider.id)} size="icon" /></span>
                <span {...stylex.props(styles.rowText)}>
                  <span {...stylex.props(styles.rowTitle)}>{provider.displayName}</span>
                  <span {...stylex.props(styles.rowDetail)}>{provider.id} · {provider.supportedAuth.map(formatAuthMethod).join(" / ") || "no auth flow"}</span>
                </span>
                <span {...stylex.props(styles.providerActions)}>
                  <span {...stylex.props(styles.rowState, available ? styles.good : styles.needsKey)}>{formatAuthStatus(provider.authStatus)}</span>
                  {provider.authStatus === "authenticated" ? (
                    <button type="button" disabled={busyProvider !== undefined} onClick={() => logout(provider)} {...stylex.props(focus.control, styles.logout)}>
                      {busyProvider === provider.id ? "Signing out…" : "Sign out"}
                    </button>
                  ) : null}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {message === undefined ? null : <p role={message.error ? "alert" : "status"} {...stylex.props(styles.formMessage, message.error && styles.formError)}>{message.text}</p>}
    </>
  )
}

/**
 * The inventory Pi loaded, which is a view rather than a setting.
 *
 * It reports `aria-busy` while the header's Reload runs and keeps the previous
 * inventory on screen throughout, because an inventory that empties itself to
 * say "working" loses the thing a person opened it to compare against.
 */
const ResourceSettings = ({ resources, extensionErrors, piUpdate, onShowEngine, controller }: { resources: Resource[]; extensionErrors: ExtensionError[]; piUpdate: PiUpdate | undefined; onShowEngine: () => void; controller: ResourcesController }): React.JSX.Element => {
  const [view, setView] = useState<ResourceView>("extension")
  const [filter, setFilter] = useState("")
  const filterField = useRef<HTMLInputElement>(null)
  const query = filter.trim().toLocaleLowerCase()
  // Counted through `resourceInView`, the same predicate the list below is
  // filtered by. A second statement of the split is a tab whose number
  // disagrees with its own contents once a resource kind is added.
  const counts = Object.fromEntries(
    RESOURCE_VIEWS.map((candidate) => [candidate.id, resources.filter((resource) => resourceInView(resource, candidate.id)).length]),
  ) as Record<ResourceView, number>
  const visible = resources
    .filter((resource) => resourceInView(resource, view))
    .filter((resource) => query === "" || resourceMatches(resource, query))
  const activeView = RESOURCE_VIEWS.find((candidate) => candidate.id === view)!

  return (
    <div aria-busy={controller.refreshing || controller.checking || controller.updating} {...stylex.props(styles.resourcePanel)}>
      <SettingsGroupHead title="Inventory" description="The same resources Pi loads on the command line" />

      {piUpdate === undefined ? null : (
        <div role="status" {...stylex.props(styles.coreUpdate)}>
          <span aria-hidden="true" {...stylex.props(styles.packageUpdateGlyph)}><Download size={17} /></span>
          <span {...stylex.props(styles.packageUpdateCopy)}>
            <span {...stylex.props(styles.packageUpdateTitle)}>Pi {piUpdate.latestVersion} is available</span>
            {/*
              This used to end with "update Bake Pi to move the app and Pi
              together", which was true and useless: it named a newer Pi and
              then offered nothing. Pi engine installs it.
            */}
            <span {...stylex.props(styles.packageUpdateDetail)}>This build runs {piUpdate.currentVersion}.</span>
          </span>
          <button type="button" onClick={onShowEngine} {...stylex.props(focus.control, styles.packageUpdateAction)}>
            <PackageOpen size={14} aria-hidden="true" />
            Pi engine
          </button>
        </div>
      )}

      {controller.updates.length > 0 ? (
        <div role="status" {...stylex.props(styles.packageUpdate)}>
          <span aria-hidden="true" {...stylex.props(styles.packageUpdateGlyph)}><Download size={17} /></span>
          <span {...stylex.props(styles.packageUpdateCopy)}>
            <span {...stylex.props(styles.packageUpdateTitle)}>{controller.updates.length} package {controller.updates.length === 1 ? "update" : "updates"} available</span>
            <span {...stylex.props(styles.packageUpdateDetail)}>
              {controller.updates.map((update) => update.displayName).join(", ")}
            </span>
          </span>
          <button
            type="button"
            onClick={controller.update}
            disabled={controller.updating}
            {...stylex.props(focus.control, styles.packageUpdateAction)}
          >
            <Download size={14} aria-hidden="true" />
            {controller.updating ? "Updating…" : "Update all"}
          </button>
        </div>
      ) : controller.checked && !controller.checking && !controller.error ? (
        <div role="status" {...stylex.props(styles.packagesCurrent)}>
          <CircleCheck size={14} aria-hidden="true" />
          Configured Pi packages are up to date
        </div>
      ) : null}

      <div role="group" aria-label="Resource type" {...stylex.props(styles.resourceViews)}>
        {RESOURCE_VIEWS.map((candidate) => {
          const selected = candidate.id === view
          return (
            <button
              key={candidate.id}
              type="button"
              aria-pressed={selected}
              onClick={() => setView(candidate.id)}
              {...stylex.props(focus.control, styles.resourceView, selected && styles.resourceViewActive)}
            >
              <span>{candidate.label}</span>
              <span aria-hidden="true" {...stylex.props(styles.resourceCount)}>{counts[candidate.id]}</span>
            </button>
          )
        })}
      </div>

      <div {...stylex.props(styles.resourceFilter)}>
        <Search size={14} aria-hidden="true" {...stylex.props(styles.resourceFilterIcon)} />
        <input
          ref={filterField}
          type="text"
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || filter === "") return
            event.stopPropagation()
            setFilter("")
          }}
          aria-label={`Search ${activeView.searchLabel}`}
          placeholder={`Search ${activeView.searchLabel}`}
          spellCheck={false}
          {...stylex.props(focus.control, styles.resourceFilterInput)}
        />
        {filter === "" ? null : (
          <button
            type="button"
            onClick={() => { setFilter(""); filterField.current?.focus() }}
            aria-label="Clear resource search"
            {...stylex.props(focus.control, styles.resourceFilterClear)}
          >
            <X size={12} aria-hidden="true" />
          </button>
        )}
      </div>

      <span role="status" {...stylex.props(a11y.visuallyHidden)}>
        {visible.length} {activeView.resultLabel} {visible.length === 1 ? "result" : "results"}
      </span>

      {view !== "extension" || extensionErrors.length === 0 ? null : (
        <details {...stylex.props(stylex.defaultMarker(), styles.issueDisclosure)}>
          <summary {...stylex.props(focus.control, styles.issueSummary)}>
            <CircleAlert size={16} aria-hidden="true" />
            <span {...stylex.props(styles.issueSummaryText)}>{extensionErrors.length} recent extension {extensionErrors.length === 1 ? "issue" : "issues"}</span>
            <ChevronRight size={14} aria-hidden="true" {...stylex.props(styles.resourceChevron)} />
          </summary>
          <ol {...stylex.props(styles.issueList)}>
            {extensionErrors.map((error, index) => (
              <li key={`${error.extensionName}:${error.phase}:${String(index)}`} {...stylex.props(styles.resourceIssue)}>
                <span {...stylex.props(styles.rowTitle)}>{error.extensionName}</span>
                <span {...stylex.props(styles.resourceError)}>{error.phase} · {error.message}</span>
              </li>
            ))}
          </ol>
        </details>
      )}

      {visible.length === 0 ? (
        <div {...stylex.props(styles.resourceEmpty)}>
          <PackageOpen size={20} aria-hidden="true" />
          <span {...stylex.props(styles.rowText)}>
            <span {...stylex.props(styles.rowTitle)}>{query === "" ? `No ${activeView.emptyLabel} discovered` : "No matching resources"}</span>
            <span {...stylex.props(styles.emptyDetail)}>{query === "" ? "Reload after changing Pi’s resource configuration." : "Try a name, description, scope, or path."}</span>
          </span>
        </div>
      ) : (
        <ul aria-label={activeView.listLabel} {...stylex.props(styles.resourceList)}>
          {visible.map((resource) => <ResourceRow key={resource.id} resource={resource} />)}
        </ul>
      )}
    </div>
  )
}

const ResourceRow = ({ resource }: { resource: Resource }): React.JSX.Element => {
  const vendor = labMarkForResource(resource.name)
  return (
    <li>
      <details {...stylex.props(stylex.defaultMarker(), styles.resourceCard, resource.loadError !== undefined && styles.resourceCardError)}>
        <summary {...stylex.props(focus.control, styles.resourceSummary)}>
          {/*
            The vendor mark takes the kind glyph's place when the name says a
            vendor. The list is filtered to one kind at a time, so inside it
            the kind glyph is the same on every row and says nothing a person
            did not already choose; the brand is what tells the rows apart.
            Names that name nothing keep the kind glyph, which is why this is
            an either/or and not a second column.
          */}
          <span aria-hidden="true" {...stylex.props(styles.resourceGlyph)}>
            {vendor === undefined ? <ResourceGlyph kind={resource.kind} /> : <LabIcon mark={vendor} size="icon" />}
          </span>
          <span {...stylex.props(styles.resourceSummaryText)}>
            <span {...stylex.props(styles.resourceName, !resource.enabled && styles.resourceNameInactive)}>{resource.name}</span>
            <span {...stylex.props(styles.resourceMeta)}>
              {resource.enabled ? <CircleCheck size={12} aria-hidden="true" /> : <CircleOff size={12} aria-hidden="true" />}
              {resource.enabled ? "Enabled" : "Disabled"} · {formatScope(resource.scope)}
            </span>
          </span>
          <ChevronRight size={14} aria-hidden="true" {...stylex.props(styles.resourceChevron)} />
        </summary>
        <div {...stylex.props(styles.resourceDetail)}>
          {resource.description === undefined ? null : <p {...stylex.props(styles.resourceDescription)}>{resource.description}</p>}
          <dl {...stylex.props(styles.resourceFacts)}>
            <ResourceFact label="Type" value={formatKind(resource.kind)} />
            <ResourceFact label="Scope" value={formatScope(resource.scope)} />
            <ResourceFact label="Status" value={resource.enabled ? "Enabled" : "Disabled"} />
          </dl>
          {resource.executable && resource.scope === "project" ? <span {...stylex.props(styles.executable)}>Runs project code after trust</span> : null}
          {resource.path === undefined ? null : <code title={resource.path} {...stylex.props(styles.resourcePath)}>{resource.path}</code>}
          {resource.loadError === undefined ? null : <span role="alert" {...stylex.props(styles.resourceError)}>{resource.loadError}</span>}
        </div>
      </details>
    </li>
  )
}

const ResourceGlyph = ({ kind }: { kind: Resource["kind"] }): React.JSX.Element => {
  if (kind === "skill") return <Sparkles size={16} />
  if (kind === "mcp_server") return <Server size={16} />
  if (kind === "prompt") return <FileText size={16} />
  if (kind === "instruction") return <BookOpen size={16} />
  return <PackageOpen size={16} />
}

const ResourceFact = ({ label, value }: { label: string; value: string }): React.JSX.Element => (
  <div {...stylex.props(styles.resourceFact)}><dt {...stylex.props(styles.resourceFactLabel)}>{label}</dt><dd {...stylex.props(styles.resourceFactValue)}>{value}</dd></div>
)

const useDiagnosticsController = (enabled: boolean): DiagnosticsController => {
  const [data, setData] = useState<DiagnosticsData>({})
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(false)
  const inFlight = useRef(false)
  const load = (): void => {
    if (inFlight.current) return
    inFlight.current = true
    setRefreshing(true)
    setError(false)
    void Promise.all([store.send("get_runtime_info", {}), store.send("get_diagnostics", { limit: 100 }), store.send("get_timings", {})])
      .then(([runtime, diagnostics, timings]) => setData({ runtime, diagnostics, timings }))
      .catch((cause: unknown) => { store.capture(cause); setError(true) })
      .finally(() => { inFlight.current = false; setRefreshing(false) })
  }
  useEffect(() => {
    if (enabled && data.runtime === undefined && data.diagnostics === undefined) load()
  }, [enabled, data.runtime, data.diagnostics])
  return { data, refreshing, error, load }
}

const DiagnosticsSettings = ({ controller }: { controller: DiagnosticsController }): React.JSX.Element => {
  const { data, refreshing } = controller
  const entries = data.diagnostics?.entries ?? []
  const loading = data.runtime === undefined || data.diagnostics === undefined

  return (
    <div aria-busy={refreshing || loading} {...stylex.props(styles.settingsStack)}>
      <SettingsGroupHead title="Runtime" description="What this process is actually running" />
      {data.runtime === undefined ? <FactSkeleton rows={5} /> : (
        <dl {...stylex.props(styles.facts)}>
          <Fact label="Bake Pi" value={data.runtime.appVersion} />
          <Fact label="Pi" value={data.runtime.piVersion} />
          <Fact label="Electron" value={data.runtime.electronVersion} />
          <Fact label="Node" value={data.runtime.nodeVersion} />
          <Fact label="Platform" value={`${data.runtime.platform} / ${data.runtime.arch}`} />
        </dl>
      )}
      {data.timings === undefined ? null : (
        <>
          <SettingsGroupHead title="Instrument cost" description="Held by the timing instrument for this host" />
          <dl {...stylex.props(styles.facts)}>
            <Fact label="Recorded" value={data.timings.cost.spansRecorded.toLocaleString()} />
            <Fact label="Open" value={data.timings.cost.openSpans.toLocaleString()} />
            <Fact label="Abandoned" value={data.timings.cost.spansAbandoned.toLocaleString()} />
            <Fact label="Ring bytes" value={data.timings.cost.ringBytes.toLocaleString()} />
          </dl>
        </>
      )}
      <SettingsGroupHead title="Recent entries" description="Warnings and failures since the host started" />
      {data.diagnostics === undefined ? <FactSkeleton rows={3} /> : entries.length === 0 ? (
        /*
          An empty log is the good outcome, so it gets the same card an empty
          resource view gets rather than one muted sentence adrift in a panel
          the size of the window. The panel has a fixed height; a sparse
          section either says something in that space or looks unfinished.
        */
        <div {...stylex.props(styles.resourceEmpty)}>
          <CircleCheck size={20} aria-hidden="true" />
          <span {...stylex.props(styles.rowText)}>
            <span {...stylex.props(styles.rowTitle)}>Nothing reported</span>
            <span {...stylex.props(styles.emptyDetail)}>The host has not logged a warning or failure in this process.</span>
          </span>
        </div>
      ) : (
        <ol {...stylex.props(styles.list)}>{entries.map((entry) => (
          <li key={entry.id}>
            <article {...stylex.props(styles.log, entry.level === "warn" && styles.logWarning, entry.level === "error" && styles.logError)}>
              <span {...stylex.props(styles.logMeta)}><span {...stylex.props(styles.logLevel)}>{entry.level}</span><span {...stylex.props(styles.logScope)}>{entry.scope}</span><time dateTime={formatDateTime(entry.at)} {...stylex.props(styles.logTime)}>{formatTimestamp(entry.at)}</time></span>
              <p {...stylex.props(styles.logMessage)}>{entry.message}</p>
              {entry.error === undefined ? null : <span {...stylex.props(styles.logCode)}>{entry.error.code}{entry.error.retryable ? " · retryable" : ""}</span>}
            </article>
          </li>
        ))}</ol>
      )}
    </div>
  )
}

/**
 * A placeholder the shape of what replaces it.
 *
 * Diagnostics used to announce its wait on one line and then become a
 * five-row list, so arriving at the section moved everything below it twice.
 * Rows the height of the facts they stand in for move it none.
 */
const FactSkeleton = ({ rows }: { rows: number }): React.JSX.Element => (
  <span aria-hidden="true" {...stylex.props(styles.factSkeleton)}>
    {Array.from({ length: rows }, (_, index) => <span key={index} {...stylex.props(styles.factSkeletonRow)} />)}
  </span>
)

/**
 * The theme, chosen from pictures of it.
 *
 * Each option is a miniature of the window drawn in that theme's own palette —
 * a rail, a strip of cards, a few lines of text — because "Dark" and "High
 * contrast" are words a person has to imagine, and a thumbnail is the thing
 * itself. System is the two halves it switches between, split down the middle.
 *
 * The colours inside a thumbnail are literals rather than tokens on purpose:
 * a token would repaint every preview in whichever theme is current, and a
 * light thumbnail drawn in dark's greys is a picture of nothing.
 *
 * The native radio stays in the tree, hidden rather than removed: it is what
 * carries the group's keyboard model and the checked state to assistive
 * technology. The tile shows focus for it through `:focus-within`.
 */
const THEMES: readonly { value: ThemeChoice; label: string; description: string }[] = [
  { value: "system", label: "System", description: "Follows the operating system." },
  { value: "dark", label: "Dark", description: "Low-glare surfaces for focused work." },
  { value: "light", label: "Light", description: "Bright, neutral surfaces for daylight." },
  { value: "high-contrast", label: "High contrast", description: "Stronger separation and visible outlines." },
]

/**
 * The three levels, in the order of how much they let through, and the sentence
 * each one is.
 *
 * The same words the prompt bar's chooser uses, deliberately: a person sets the
 * default here and then reads the result on the pill under the composer, and
 * two vocabularies for one setting is how a safety control stops being read at
 * all. The tone is repeated too, because the level in force is the one thing on
 * this panel worth recognising before it is read.
 */
const PERMISSION_LEVELS: readonly { value: TrustLevel; label: string; hint: string }[] = [
  { value: "untrusted", label: TRUST_LABELS.untrusted, hint: "Every tool asks first. Project extensions stay unloaded." },
  { value: "trusted", label: TRUST_LABELS.trusted, hint: "Tools run unasked inside the workspace. Reaching outside it asks." },
  { value: "full", label: TRUST_LABELS.full, hint: "Nothing asks, anywhere, in every project you have not decided on." },
]

/**
 * Bake Pi's own permission settings: what is in force here, and what a project
 * nobody has decided on opens at.
 *
 * It holds its own state rather than joining the Pi settings controller,
 * because it is not a Pi setting — the host keeps it beside Pi's trust store,
 * and folding it into a snapshot Pi owns would make a Bake Pi file look like
 * something the CLI reads. The read is deliberately not part of the section's
 * refresh either: there is no second writer for it inside one host, so a
 * refresh would re-fetch a value that cannot have changed.
 *
 * Changing the default changes nothing that is already open, and the copy says
 * so. A level in force is a level the person can see on the prompt bar, and
 * moving it out from under a running session would change what a tool call may
 * do without the session saying anything about it.
 */
const WorkspacePermissionSettings = ({ trust }: { trust: TrustLevel }): React.JSX.Element => {
  const [level, setLevel] = useState<TrustLevel>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean }>()
  const current = PERMISSION_LEVELS.find((option) => option.value === trust)

  useEffect(() => {
    let live = true
    void store.getDefaultTrust()
      .then((value) => { if (live) setLevel(value) })
      .catch((error: unknown) => {
        store.capture(error)
        if (live) setMessage({ text: "The default permission level could not be read.", error: true })
      })
    return () => { live = false }
  }, [])

  const choose = (value: TrustLevel): void => {
    const previous = level
    // Moved first and reverted on failure. The select is the person's own
    // input; leaving it on the old value until a round trip answers reads as a
    // control that ignored the click.
    setLevel(value)
    setBusy(true)
    setMessage(undefined)
    void store.setDefaultTrust(value)
      .then((saved) => {
        setLevel(saved)
        setMessage({ text: "Saved. It applies the next time an undecided project is opened.", error: false })
      })
      .catch((error: unknown) => {
        store.capture(error)
        setLevel(previous)
        setMessage({ text: "The default permission level could not be saved.", error: true })
      })
      .finally(() => setBusy(false))
  }

  return (
    <section {...stylex.props(styles.formSection)}>
      <SettingsGroupHead title="Workspace permissions" description="What an agent may do without asking" />
      <div {...stylex.props(styles.card)}>
        <div {...stylex.props(styles.row)}>
          <span {...stylex.props(styles.rowText)}>
            <span {...stylex.props(styles.rowTitle)}>This workspace</span>
            <span {...stylex.props(styles.rowNote)}>{current?.hint ?? ""} Change it from the control under the message box.</span>
          </span>
          <span {...stylex.props(styles.rowState, trust === "untrusted" ? styles.needsKey : trust === "full" ? styles.permissive : styles.good)}>{TRUST_LABELS[trust]}</span>
        </div>
        <div {...stylex.props(styles.row)}>
          <span {...stylex.props(styles.rowText)}>
            <span id="default-permission-label" {...stylex.props(styles.rowTitle)}>Projects you have not decided on</span>
            <span id="default-permission-note" {...stylex.props(styles.rowNote)}>A fallback: a project you have already set keeps its own level, and Pi’s trust store still decides whether there is a grant at all.</span>
          </span>
          <SelectControl
            id="default-permission"
            inline
            value={level ?? "untrusted"}
            disabled={busy || level === undefined}
            aria-labelledby="default-permission-label"
            aria-describedby="default-permission-note"
            onChange={(value) => choose(value as TrustLevel)}
            options={PERMISSION_LEVELS.map((option) => ({ value: option.value, label: option.label }))}
          />
        </div>
      </div>
      {message === undefined ? null : <p role={message.error ? "alert" : "status"} {...stylex.props(styles.formMessage, message.error && styles.formError)}>{message.text}</p>}
    </section>
  )
}

/**
 * The three ways a step may decide its own disclosure, in the order of how
 * much they show. The words match what a person sees: a step is a row that
 * opens, not an "expander" or a "tool call".
 */
const STEP_DISCLOSURES: readonly { value: StepDisclosure; label: string }[] = [
  { value: "auto", label: "Collapse when the turn ends" },
  { value: "collapsed", label: "Keep collapsed" },
  { value: "open", label: "Always open" },
]

const AppearanceSettings = ({ theme, onTheme, disclosure, onDisclosure }: { theme: ThemeChoice; onTheme: (theme: ThemeChoice) => void; disclosure: StepDisclosure; onDisclosure: (disclosure: StepDisclosure) => void }): React.JSX.Element => (
  <div {...stylex.props(styles.settingsStack)}>
  <fieldset {...stylex.props(styles.themeFieldset)}>
    <legend {...stylex.props(styles.themeLegend)}>Theme</legend>
    <div {...stylex.props(styles.themeChoices)}>
      {THEMES.map(({ value, label, description }) => {
        const selected = theme === value
        return (
          <label key={value} title={description} {...stylex.props(styles.themeChoice)}>
            <input type="radio" name="theme" value={value} checked={selected} onChange={() => onTheme(value)} {...stylex.props(a11y.visuallyHidden)} />
            <span aria-hidden="true" {...stylex.props(styles.themeTile, selected && styles.themeTileSelected)}>
              {value === "system"
                ? <><ThemePreview variant="dark" half="start" /><ThemePreview variant="light" half="end" /></>
                : <ThemePreview variant={value} />}
            </span>
            <span {...stylex.props(styles.themeName, selected && styles.themeNameSelected)}>{label}</span>
          </label>
        )
      })}
    </div>
  </fieldset>
  <section {...stylex.props(styles.formSection)}>
    <SettingsGroupHead title="Agent actions" description="Whether a step shows its command, diff or thought without being opened" />
    <div {...stylex.props(styles.card)}>
      <div {...stylex.props(styles.row)}>
        <span {...stylex.props(styles.rowText)}>
          <span id="step-disclosure-label" {...stylex.props(styles.rowTitle)}>Action details</span>
          <span id="step-disclosure-note" {...stylex.props(styles.rowNote)}>Opening or closing a step yourself always wins over this default.</span>
        </span>
        <SelectControl
          id="step-disclosure"
          inline
          value={disclosure}
          aria-labelledby="step-disclosure-label"
          aria-describedby="step-disclosure-note"
          onChange={(value) => onDisclosure(value as StepDisclosure)}
          options={STEP_DISCLOSURES.map((option) => ({ value: option.value, label: option.label }))}
        />
      </div>
    </div>
  </section>
  </div>
)

/**
 * One theme as a picture: a rail on the left, a title line, three cards and a
 * footer line on the right. The three dots stand in for window controls and
 * are the only hue on the tile, which is what makes it read as a window rather
 * than as a grey rectangle.
 */
const ThemePreview = ({ variant, half }: { variant: "dark" | "light" | "high-contrast"; half?: "start" | "end" }): React.JSX.Element => {
  const palette = PREVIEW[variant]
  return (
    <span {...stylex.props(styles.preview, palette.frame, half === "start" && styles.previewStart, half === "end" && styles.previewEnd)}>
      <span {...stylex.props(styles.previewRail, palette.rail)}>
        <span {...stylex.props(styles.previewDots)}>
          <span {...stylex.props(styles.previewDot, styles.dotClose)} />
          <span {...stylex.props(styles.previewDot, styles.dotMin)} />
          <span {...stylex.props(styles.previewDot, styles.dotMax)} />
        </span>
        <span {...stylex.props(styles.previewLine, styles.lineLong, palette.ink)} />
        <span {...stylex.props(styles.previewLine, styles.lineShort, palette.ink)} />
        <span {...stylex.props(styles.previewLine, styles.lineMid, palette.ink)} />
      </span>
      <span {...stylex.props(styles.previewMain)}>
        <span {...stylex.props(styles.previewLine, styles.lineShort, palette.ink)} />
        <span {...stylex.props(styles.previewCards)}>
          <span {...stylex.props(styles.previewCard, palette.card)} />
          <span {...stylex.props(styles.previewCard, palette.card)} />
          <span {...stylex.props(styles.previewCard, palette.card)} />
        </span>
        <span {...stylex.props(styles.previewLine, styles.lineMid, palette.ink)} />
      </span>
    </span>
  )
}

const Fact = ({ label, value }: { label: string; value: string }): React.JSX.Element => <div {...stylex.props(styles.factItem)}><dt {...stylex.props(styles.factLabel)}>{label}</dt><dd {...stylex.props(styles.fact)}>{value}</dd></div>

type ResourceView = "extension" | "skill" | "other"

const RESOURCE_VIEWS: readonly { id: ResourceView; label: string; searchLabel: string; resultLabel: string; emptyLabel: string; listLabel: string }[] = [
  { id: "extension", label: "Extensions", searchLabel: "extensions", resultLabel: "extension", emptyLabel: "extensions", listLabel: "Extensions" },
  { id: "skill", label: "Skills", searchLabel: "skills", resultLabel: "skill", emptyLabel: "skills", listLabel: "Skills" },
  { id: "other", label: "More", searchLabel: "other resources", resultLabel: "resource", emptyLabel: "supporting resources", listLabel: "Other agent resources" },
]

const resourceInView = (resource: Resource, view: ResourceView): boolean =>
  view === "other" ? resource.kind !== "extension" && resource.kind !== "skill" : resource.kind === view

const resourceMatches = (resource: Resource, query: string): boolean => [
  resource.name,
  resource.description,
  resource.path,
  resource.kind,
  resource.scope,
].some((value) => value?.toLocaleLowerCase().includes(query) === true)

const formatScope = (scope: Resource["scope"]): string => scope === "builtin" ? "Built-in" : scope === "user" ? "User" : "Project"
const formatKind = (kind: Resource["kind"]): string => kind === "mcp_server" ? "MCP server" : kind === "prompt" ? "Prompt template" : kind[0]!.toLocaleUpperCase() + kind.slice(1)

const AUTH_STATUS_LABELS: Record<Provider["authStatus"], string> = { authenticated: "Ready", environment: "Environment", unauthenticated: "Needs key", expired: "Expired", unknown: "Unknown" }
const formatAuthStatus = (status: Provider["authStatus"]): string => AUTH_STATUS_LABELS[status]
const formatAuthMethod = (method: Provider["supportedAuth"][number]): string => method === "api_key" ? "API key" : method === "oauth" ? "OAuth" : "environment"
const formatTimestamp = (at: number): string => new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
const formatDateTime = (at: number): string => {
  const date = new Date(at)
  return Number.isNaN(date.valueOf()) ? "" : date.toISOString()
}

/**
 * A section arrives, it does not cut.
 *
 * The panel is keyed on the active section, so switching sections unmounts one
 * subtree and mounts another — with no transition that reads as a flash of
 * unrelated content at whatever scroll offset the last one had. Four pixels and
 * a fade is enough to say "this replaced that"; reduced motion keeps the fade,
 * because the acknowledgement is the point rather than the travel.
 *
 * Declared here rather than shared: only a `.stylex.ts` file may export
 * keyframes, and the compiler will not resolve an imported name into
 * `animationName`. See the same note in `Overlay.tsx`.
 */
const enterPanel = stylex.keyframes({ from: { opacity: 0, transform: "translateY(4px)" } })
const fadePanel = stylex.keyframes({ from: { opacity: 0 } })

const styles = stylex.create({
  layout: {
    flex: 1, minHeight: 0, display: "grid", position: "relative",
    gridTemplateColumns: { default: "212px minmax(0, 1fr)", "@media (max-width: 720px)": "minmax(0, 1fr)" },
    gridTemplateRows: { default: "minmax(0, 1fr)", "@media (max-width: 720px)": "auto minmax(0, 1fr)" },
  },
  /**
   * A quiet index beside the scrolling panel: no surface of its own, no rule
   * between it and the body. The column used to be a bordered `surface` with
   * an active tab that wore a border, a shadow and bold at once; the active
   * item is now the one raised step, and the column is the modal it sits in.
   */
  indexEyebrow: { paddingInline: space.sm, color: colors.textMuted, fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine, fontWeight: 600, letterSpacing: "0.09em", textTransform: "uppercase" },
  sectionGroup: { display: "flex", flexDirection: "column", gap: "2px" },
  sectionGroupLabel: { paddingInline: space.sm, paddingBlockEnd: space.xs, color: colors.textFaint, fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine, fontWeight: 600, letterSpacing: "0.09em", textTransform: "uppercase" },
  sectionTabs: {
    alignSelf: { default: "stretch", "@media (max-width: 720px)": "start" }, alignContent: "start", display: "flex", flexDirection: "column",
    gap: space.lg,
    paddingBlock: { default: space.xs, "@media (max-width: 720px)": space.sm }, paddingInline: space.md,
  },
  sectionTab: {
    minWidth: 0, height: "32px", boxSizing: "border-box", display: "flex", alignItems: "center", gap: space.sm, paddingInline: space.sm,
    color: { default: colors.textMuted, ":hover": colors.text }, backgroundColor: { default: "transparent", ":hover": colors.accentSoft },
    borderWidth: 0, borderRadius: radius.md,
    cursor: "pointer", textAlign: "start", transform: { default: "scale(1)", ":active": "scale(0.98)" },
    transitionProperty: "background-color, box-shadow, color, transform", transitionDuration: motion.fast, transitionTimingFunction: motion.settle,
    fontFamily: typography.ui, fontSize: typography.label, lineHeight: typography.labelLine,
  },
  sectionTabActive: { color: colors.text, backgroundColor: { default: colors.surfaceRaised, ":hover": colors.surfaceRaised }, boxShadow: effects.lift, fontWeight: 600 },
  sectionGlyph: { flex: "none", color: colors.textFaint },
  sectionGlyphActive: { color: colors.text },
  sectionLabel: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  body: {
    minWidth: 0, minHeight: 0, overflowY: "auto", containerType: "inline-size",
    paddingInlineStart: { default: space.xxl, "@media (max-width: 720px)": size.gutter },
    paddingInlineEnd: { default: space.xl, "@media (max-width: 720px)": size.gutter },
    paddingBlockStart: { default: space.sm, "@media (max-width: 720px)": 0 }, paddingBlockEnd: space.xxl,
  },
  panel: {
    maxWidth: size.settingsMeasure, display: "flex", flexDirection: "column", gap: space.xl,
    animationName: { default: enterPanel, "@media (prefers-reduced-motion: reduce)": fadePanel },
    animationDuration: { default: motion.moderate, "@media (prefers-reduced-motion: reduce)": motion.accessibleFade },
    animationTimingFunction: motion.settle,
  },
  /**
   * The header's one control, sized like a toolbar control rather than a form
   * button: it sits beside a nineteen-pixel title and a dismiss square, and a
   * 36px filled button there would outrank the title it refreshes.
   */
  headerRefresh: {
    flex: "none", minHeight: size.controlDense, display: "inline-flex", alignItems: "center", gap: space.xs,
    paddingInline: space.sm, boxSizing: "border-box",
    color: { default: colors.textMuted, ":hover": colors.text },
    backgroundColor: { default: colors.sunken, ":hover": colors.accentSoft },
    borderWidth: 0, borderRadius: radius.sm,
    cursor: { default: "pointer", ":disabled": "not-allowed" }, opacity: { default: 1, ":disabled": 0.5 },
    transform: { default: "scale(1)", ":active": "scale(0.97)" },
    transitionProperty: "background-color, box-shadow, color, transform", transitionDuration: motion.fast, transitionTimingFunction: motion.settle,
    fontFamily: typography.ui, fontSize: typography.caption, lineHeight: typography.captionLine, fontWeight: 600,
  },
  /** The word goes when the header has to fit a narrow frame; the glyph stays. */
  headerRefreshLabel: { display: { default: "inline", "@media (max-width: 480px)": "none" } },
  /**
   * The status toast, in the corner of the layout the body scrolls under.
   *
   * It is the one raised surface on the modal, so it reads as a thing that
   * arrived rather than a line that was always there.
   */
  status: {
    position: "absolute", insetBlockEnd: space.lg, insetInlineEnd: space.xl, zIndex: 1,
    minHeight: size.controlDense, boxSizing: "border-box",
    display: "flex", alignItems: "center", gap: space.sm, margin: 0, paddingInline: space.md,
    color: colors.text, backgroundColor: colors.surfaceRaised, borderRadius: radius.md, boxShadow: effects.liftOverlay,
    fontSize: typography.caption, lineHeight: typography.captionLine,
    animationName: { default: enterPanel, "@media (prefers-reduced-motion: reduce)": fadePanel },
    animationDuration: { default: motion.moderate, "@media (prefers-reduced-motion: reduce)": motion.accessibleFade },
    animationTimingFunction: motion.settle,
  },
  statusError: { color: colors.danger },
  statusDone: { color: colors.success },
  statusGlyph: { flex: "none" },
  /** Rows the height of the facts they stand in for. See `FactSkeleton`. */
  factSkeleton: { display: "flex", flexDirection: "column", gap: space.xs },
  factSkeletonRow: { display: "block", height: typography.captionLine, backgroundColor: colors.surfaceRaised, borderRadius: radius.sm },
  list: { display: "flex", flexDirection: "column", gap: "2px", margin: 0, padding: 0, listStyle: "none" },
  /**
   * One card per group, rows divided by a line. The same treatment
   * `PiSettings` gives its groups, so a provider list and a settings group
   * read as the same kind of object in adjacent sections.
   */
  card: { display: "flex", flexDirection: "column", gap: 0, padding: 0, backgroundColor: colors.surface, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.border, borderRadius: radius.lg, boxShadow: effects.lift, overflow: "hidden" },
  row: {
    minHeight: "48px", boxSizing: "border-box", display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", alignItems: "center", gap: space.xl, paddingBlock: space.sm, paddingInline: space.lg,
    borderTopWidth: { default: "1px", ":first-child": 0 }, borderTopStyle: "solid", borderTopColor: colors.border,
  },
  rowNote: { color: colors.textMuted, fontSize: typography.caption, lineHeight: typography.captionLine, maxWidth: size.measure },
  rowControls: { display: "flex", alignItems: "center", gap: space.sm, justifySelf: "end" },
  keyField: { width: size.controlWidth, height: size.controlDense, boxSizing: "border-box", paddingInline: space.md, color: colors.text, backgroundColor: { default: colors.sunken, ":hover": colors.accentSoft, ":focus": colors.sunken }, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.borderStrong, borderRadius: radius.md, fontFamily: typography.mono, fontSize: typography.label },
  submit: { minHeight: size.controlDense, paddingInline: space.md, color: colors.accentOn, backgroundColor: { default: colors.accent, ":hover": colors.accentHover }, borderWidth: 0, borderRadius: radius.md, cursor: { default: "pointer", ":disabled": "not-allowed" }, opacity: { default: 1, ":disabled": 0.5 }, fontFamily: typography.ui, fontSize: typography.label, fontWeight: 600, whiteSpace: "nowrap" },
  sources: { backgroundColor: colors.surface, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.border, borderRadius: radius.lg, boxShadow: effects.lift },
  sourcesSummary: { minHeight: "48px", boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.sm, paddingInline: space.lg, color: colors.text, cursor: "pointer", listStyle: "none", fontSize: typography.body, lineHeight: typography.bodyLine, fontWeight: 500, "::-webkit-details-marker": { display: "none" } },
  sourcesHint: { color: colors.textFaint, fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" },
  sourcesBody: { paddingInline: space.lg, paddingBlockEnd: space.lg, borderTopWidth: "1px", borderTopStyle: "solid", borderTopColor: colors.border },
  /**
   * Selected is a lift, not a recess. `sunken` read as pressed-in beside rows
   * that hover to `surface`; a selected row now steps one above hover and
   * takes the same seat the active segment does.
   */
  rowSelected: { color: colors.text, backgroundColor: { default: colors.surfaceRaised, ":hover": colors.surfaceRaised }, boxShadow: effects.lift },
  rowText: { minWidth: 0, display: "flex", flexDirection: "column", gap: "2px" },
  providerRow: { gridTemplateColumns: `${size.icon} minmax(0, 1fr) auto` },
  providerMark: { display: "grid", placeItems: "center", color: colors.textMuted },
  rowTitle: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.text, fontSize: typography.body, lineHeight: typography.bodyLine, fontWeight: 500 },
  rowDetail: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.textMuted, fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine },
  /** A state as a chip: a word in a recess, so it reads as a status and not as a stray column of type. */
  rowState: { flex: "none", paddingInline: space.sm, paddingBlock: "2px", color: colors.textMuted, backgroundColor: colors.sunken, borderRadius: radius.md, fontSize: typography.micro, lineHeight: typography.microLine, fontWeight: 600 },
  providerActions: { display: "flex", alignItems: "center", gap: space.sm },
  logout: { minHeight: size.controlDense, paddingInline: space.sm, color: { default: colors.textMuted, ":hover": colors.text }, backgroundColor: { default: "transparent", ":hover": colors.accentSoft }, borderWidth: 0, borderRadius: radius.sm, cursor: { default: "pointer", ":disabled": "not-allowed" }, opacity: { default: 1, ":disabled": 0.5 }, fontFamily: typography.ui, fontSize: typography.label },
  good: { color: colors.text },
  needsKey: { color: colors.warning, backgroundColor: colors.warningSoft },
  /** Full access, in the one place a settings panel states it: the level that asks nothing. */
  permissive: { color: colors.danger, backgroundColor: colors.dangerSoft },
  quiet: { margin: 0, color: colors.textMuted, fontSize: typography.caption, lineHeight: typography.captionLine },
  settingsStack: { display: "flex", flexDirection: "column", gap: space.xl },
  resourcePanel: { display: "flex", flexDirection: "column", gap: space.md },
  packageUpdate: {
    display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.sm,
    padding: space.md, color: colors.warning, backgroundColor: colors.warningSoft,
    borderRadius: radius.lg, boxShadow: effects.liftRaised,
  },
  coreUpdate: { display: "flex", alignItems: "center", gap: space.sm, padding: space.md, color: colors.warning, backgroundColor: colors.warningSoft, borderRadius: radius.lg, boxShadow: effects.liftRaised },
  packageUpdateGlyph: { flex: "none", width: size.controlDense, height: size.controlDense, display: "grid", placeItems: "center", color: colors.warning, backgroundColor: colors.surfaceRaised, borderRadius: radius.md, boxShadow: effects.lift },
  packageUpdateCopy: { flex: "1 1 220px", minWidth: 0, display: "flex", flexDirection: "column", gap: "2px" },
  packageUpdateTitle: { color: colors.text, fontSize: typography.label, lineHeight: typography.labelLine, fontWeight: 700 },
  packageUpdateDetail: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.warning, fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine },
  packageUpdateAction: {
    flex: "none", minHeight: size.controlDense, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: space.xs,
    paddingInline: space.md, color: colors.accentOn, backgroundColor: { default: colors.warning, ":hover": colors.accentHover },
    borderWidth: 0, borderRadius: radius.md, boxShadow: effects.lift,
    cursor: { default: "pointer", ":disabled": "not-allowed" }, opacity: { default: 1, ":disabled": 0.6 },
    transform: { default: "scale(1)", ":active": "scale(0.97)" },
    transitionProperty: "background-color, box-shadow, transform", transitionDuration: motion.fast, transitionTimingFunction: motion.settle,
    fontFamily: typography.ui, fontSize: typography.caption, lineHeight: typography.captionLine, fontWeight: 700,
  },
  packagesCurrent: { minHeight: size.controlMicro, display: "flex", alignItems: "center", gap: space.xs, color: colors.success, fontSize: typography.caption, lineHeight: typography.captionLine },
  resourceViews: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "2px", padding: "2px", backgroundColor: colors.sunken, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.border, borderRadius: radius.md },
  resourceView: { minWidth: 0, height: size.controlMicro, boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center", gap: space.xs, paddingInline: space.xs, color: { default: colors.textMuted, ":hover": colors.text }, backgroundColor: { default: "transparent", ":hover": colors.surface }, borderWidth: effects.hairline, borderStyle: "solid", borderColor: "transparent", borderRadius: radius.sm, cursor: "pointer", fontFamily: typography.ui, fontSize: typography.caption, lineHeight: typography.captionLine },
  resourceViewActive: { color: colors.text, backgroundColor: { default: colors.surfaceRaised, ":hover": colors.surfaceRaised }, borderColor: colors.borderStrong, boxShadow: effects.lift, fontWeight: 600 },
  resourceCount: { flex: "none", color: colors.textFaint, fontFamily: typography.mono, fontVariantNumeric: "tabular-nums" },
  resourceFilter: { height: size.controlDense, boxSizing: "border-box", display: "flex", alignItems: "center", gap: space.sm, paddingInlineStart: space.sm, paddingInlineEnd: space.xs, backgroundColor: colors.sunken, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.borderStrong, borderRadius: radius.sm },
  resourceFilterIcon: { flex: "none", color: colors.textFaint },
  resourceFilterInput: { flex: 1, minWidth: 0, height: "100%", color: colors.text, backgroundColor: "transparent", borderWidth: 0, outline: "none", fontFamily: typography.ui, fontSize: typography.label, "::placeholder": { color: colors.textFaint } },
  resourceFilterClear: { flex: "none", width: size.controlMicro, height: size.controlMicro, display: "grid", placeItems: "center", padding: 0, color: { default: colors.textFaint, ":hover": colors.text }, backgroundColor: { default: "transparent", ":hover": colors.surface }, borderWidth: 0, borderRadius: radius.sm, cursor: "pointer" },
  issueDisclosure: { minWidth: 0, backgroundColor: colors.dangerSoft, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.borderStrong, borderRadius: radius.lg },
  issueSummary: { minHeight: size.control, boxSizing: "border-box", display: "flex", alignItems: "center", gap: space.sm, paddingInline: space.sm, color: colors.danger, cursor: "pointer", listStyle: "none", "::-webkit-details-marker": { display: "none" } },
  issueSummaryText: { flex: 1, minWidth: 0, fontSize: typography.label, lineHeight: typography.labelLine, fontWeight: 600 },
  issueList: { display: "flex", flexDirection: "column", gap: space.sm, margin: 0, paddingInline: space.sm, paddingBlockEnd: space.sm, listStyle: "none" },
  /**
   * Two columns of cards where the panel is wide enough for them.
   *
   * A resource card is a self-contained disclosure rather than one step of a
   * list read in order, so tiling them costs no meaning and halves the scroll.
   * `alignItems: start` is what stops a card opened on the left from stretching
   * its closed neighbour to match.
   */
  resourceList: {
    display: "grid",
    gridTemplateColumns: { default: "minmax(0, 1fr)", "@container (min-width: 700px)": "repeat(2, minmax(0, 1fr))" },
    alignItems: "start", gap: space.sm, margin: 0, padding: 0, listStyle: "none",
  },
  resourceCard: { minWidth: 0, backgroundColor: colors.surface, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.border, borderRadius: radius.lg, boxShadow: effects.lift },
  resourceCardError: { backgroundColor: colors.dangerSoft },
  resourceSummary: { minWidth: 0, minHeight: size.controlTall, boxSizing: "border-box", display: "grid", gridTemplateColumns: "28px minmax(0, 1fr) 14px", alignItems: "center", gap: space.sm, paddingBlock: space.sm, paddingInline: space.sm, cursor: "pointer", listStyle: "none", "::-webkit-details-marker": { display: "none" } },
  resourceGlyph: { width: size.controlDense, height: size.controlDense, display: "grid", placeItems: "center", color: colors.textMuted, backgroundColor: colors.surfaceRaised, borderRadius: radius.sm },
  resourceSummaryText: { minWidth: 0, display: "flex", flexDirection: "column", gap: "2px" },
  resourceName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.text, fontSize: typography.label, lineHeight: typography.labelLine, fontWeight: 600 },
  resourceNameInactive: { color: colors.textMuted },
  resourceMeta: { display: "flex", alignItems: "center", gap: space.xs, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.textMuted, fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine },
  // The disclosure already owns its open state; its chevron reads that same
  // attribute rather than waiting for a toggle event to copy it into React.
  resourceChevron: { color: colors.textFaint, transform: { default: "rotate(0deg)", [stylex.when.ancestor("[open]")]: "rotate(90deg)" }, transitionProperty: "transform", transitionDuration: { default: motion.fast, "@media (prefers-reduced-motion: reduce)": "0ms" }, transitionTimingFunction: motion.settle },
  resourceDetail: { display: "flex", flexDirection: "column", gap: space.sm, paddingInline: space.sm, paddingBlockEnd: space.sm },
  resourceDescription: { margin: 0, color: colors.textMuted, fontSize: typography.caption, lineHeight: typography.captionLine, overflowWrap: "anywhere" },
  resourceFacts: { display: "grid", gridTemplateColumns: { default: "minmax(0, 1fr)", "@container (min-width: 360px)": "repeat(3, minmax(0, 1fr))" }, gap: "2px", margin: 0 },
  resourceFact: { minWidth: 0, display: "flex", flexDirection: "column", gap: "2px", padding: space.xs, backgroundColor: colors.sunken },
  resourceFactLabel: { color: colors.textFaint, fontSize: typography.micro, lineHeight: typography.microLine },
  resourceFactValue: { margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.textMuted, fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine },
  resourcePath: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.textFaint, fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine },
  resourceError: { color: colors.danger, fontSize: typography.micro, lineHeight: typography.microLine, overflowWrap: "anywhere" },
  resourceIssue: { display: "flex", flexDirection: "column", gap: space.xs, paddingBlock: space.sm, paddingInline: space.sm, backgroundColor: colors.dangerSoft, borderRadius: radius.sm },
  executable: { flex: "none", paddingInline: space.xs, color: colors.warning, backgroundColor: colors.warningSoft, borderRadius: radius.sm, fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine },
  resourceEmpty: { display: "flex", alignItems: "flex-start", gap: space.sm, padding: space.md, color: colors.textFaint, backgroundColor: colors.surface, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.border, borderRadius: radius.lg, boxShadow: effects.lift },
  emptyDetail: { color: colors.textMuted, fontSize: typography.caption, lineHeight: typography.captionLine },
  formSection: { display: "flex", flexDirection: "column", gap: space.sm },
  formMessage: { marginBlock: 0, paddingInline: space.xs, color: colors.success, fontSize: typography.caption, lineHeight: typography.captionLine },
  formError: { color: colors.danger },
  /**
   * Facts in as many columns as the panel can hold.
   *
   * Five label/value pairs in one column left two thirds of a nine-hundred
   * pixel panel empty and the section a third the height of every other one.
   * Each pair is self-contained — a label and its figure — so it tiles.
   */
  facts: {
    display: "grid",
    gridTemplateColumns: { default: "minmax(0, 1fr)", "@container (min-width: 480px)": "repeat(2, minmax(0, 1fr))", "@container (min-width: 760px)": "repeat(3, minmax(0, 1fr))" },
    gap: "2px", margin: 0,
  },
  factItem: { minWidth: 0, display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: space.md, paddingBlock: space.xs, paddingInline: space.md, backgroundColor: colors.surface, borderRadius: radius.md },
  factLabel: { color: colors.textMuted, fontSize: typography.micro, lineHeight: typography.microLine, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" },
  fact: { margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: typography.mono, fontSize: typography.caption, lineHeight: typography.captionLine },
  log: { display: "flex", flexDirection: "column", gap: space.xs, paddingBlock: space.sm },
  logWarning: { backgroundColor: colors.warningSoft, borderRadius: radius.sm, paddingInline: space.sm },
  logError: { backgroundColor: colors.dangerSoft, borderRadius: radius.sm, paddingInline: space.sm },
  logMeta: { display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: space.sm },
  logLevel: { color: colors.text, fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" },
  logScope: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.textMuted, fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine },
  logTime: { color: colors.textFaint, fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine },
  logMessage: { margin: 0, whiteSpace: "pre-wrap", fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine, overflowWrap: "anywhere" },
  logCode: { color: colors.textMuted, fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine },
  themeFieldset: { minWidth: 0, margin: 0, padding: 0, borderWidth: 0 },
  /** A `legend` set as a group title, so the fieldset heads like every other group. */
  themeLegend: { paddingBlock: 0, paddingInline: space.xs, color: colors.text, fontSize: typography.body, lineHeight: typography.bodyLine, fontWeight: 600 },
  themeChoices: {
    display: "grid",
    gridTemplateColumns: { default: "repeat(2, minmax(0, 1fr))", "@container (min-width: 640px)": "repeat(4, minmax(0, 1fr))" },
    gap: space.md, marginBlockStart: space.sm,
  },
  themeChoice: { minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: space.sm, padding: space.xs, borderRadius: radius.lg, cursor: "pointer", boxShadow: { default: "none", ":focus-within": effects.focusState } },
  /**
   * The tile is the control. At rest it has the card's seat and lifts on
   * hover; the chosen one is outlined. Keyboard focus on the hidden radio
   * reaches the tile through `:focus-within` on the label below.
   */
  themeTile: {
    position: "relative", width: "100%", aspectRatio: "4 / 3", overflow: "hidden", boxSizing: "border-box",
    borderRadius: radius.lg, boxShadow: { default: effects.lift, ":hover": effects.liftRaised },
    transitionProperty: "box-shadow", transitionDuration: motion.fast, transitionTimingFunction: motion.settle,
  },
  /**
   * The chosen tile wears a ring in the focus colour, stood off the tile by
   * two pixels of the panel's own surface — the one place this interface
   * draws a line around a thing, because four pictures of the same window
   * differ too little in elevation for a shadow alone to say which is chosen.
   * Spread shadows rather than an outline, so the ring follows the radius.
   */
  themeTileSelected: { boxShadow: { default: `0 0 0 2px ${colors.surfaceOverlay}, 0 0 0 4px ${colors.focus}`, ":hover": `0 0 0 2px ${colors.surfaceOverlay}, 0 0 0 4px ${colors.focus}` } },
  themeName: { color: colors.textMuted, fontSize: typography.caption, lineHeight: typography.captionLine },
  themeNameSelected: { color: colors.text, fontWeight: 600 },

  /**
   * The miniature window. Everything is a fraction of the tile so the four
   * previews stay identical in shape across the modal's responsive widths.
   */
  preview: { position: "absolute", inset: 0, display: "grid", gridTemplateColumns: "34% minmax(0, 1fr)", paddingBlockStart: "12%", paddingInline: "10%", paddingBlockEnd: "8%", gap: "8%", boxSizing: "border-box" },
  previewStart: { clipPath: "inset(0 50% 0 0)" },
  previewEnd: { clipPath: "inset(0 0 0 50%)" },
  previewRail: { display: "flex", flexDirection: "column", gap: "9%", paddingBlock: "10%", paddingInline: "12%", borderRadius: "3px", boxSizing: "border-box" },
  previewMain: { display: "flex", flexDirection: "column", justifyContent: "space-between", paddingBlock: "10%" },
  previewDots: { display: "flex", gap: "3px", marginBlockEnd: "4%" },
  previewDot: { width: "4px", height: "4px", borderRadius: "50%" },
  dotClose: { backgroundColor: "#ff5f57" }, dotMin: { backgroundColor: "#febc2e" }, dotMax: { backgroundColor: "#28c840" },
  previewLine: { height: "2px", borderRadius: radius.sm },
  lineLong: { width: "90%" }, lineMid: { width: "60%" }, lineShort: { width: "40%" },
  previewCards: { display: "flex", gap: "6%" },
  previewCard: { flex: 1, aspectRatio: "1.6", borderRadius: radius.lg },

  /** Each theme's own greys, as literals. See `AppearanceSettings`. */
  frameDark: { backgroundColor: "#111111" }, railDark: { backgroundColor: "#1b1b1b" }, cardDark: { backgroundColor: "#262626" }, inkDark: { backgroundColor: "#4a4a4a" },
  frameLight: { backgroundColor: "#f7f7f7" }, railLight: { backgroundColor: "#e9e9e9" }, cardLight: { backgroundColor: "#dcdcdc" }, inkLight: { backgroundColor: "#bdbdbd" },
  frameHc: { backgroundColor: "#000000" }, railHc: { backgroundColor: "#0a0a0a", boxShadow: "inset 0 0 0 1px #bdbdbd" }, cardHc: { backgroundColor: "#131313", boxShadow: "inset 0 0 0 1px #bdbdbd" }, inkHc: { backgroundColor: "#ffffff" },
})

const PREVIEW = {
  dark: { frame: styles.frameDark, rail: styles.railDark, card: styles.cardDark, ink: styles.inkDark },
  light: { frame: styles.frameLight, rail: styles.railLight, card: styles.cardLight, ink: styles.inkLight },
  "high-contrast": { frame: styles.frameHc, rail: styles.railHc, card: styles.cardHc, ink: styles.inkHc },
} as const
