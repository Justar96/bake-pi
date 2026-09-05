import { useEffect, useState } from "react"
import * as stylex from "@stylexjs/stylex"
import { KeyRound, RotateCcw, ShieldCheck, ShieldQuestion } from "lucide-react"
import { ArrowRightIcon, FolderOpenIcon } from "@heroicons/react/24/outline"
import { store } from "./store/session-store.ts"
import { useReadableView } from "./store/use-readable-view.ts"
import { remember, rememberedChoice, rememberedWorkspace, rememberWorkspace } from "./store/preferences.ts"
import { scrollbars } from "./theme/scrollbars.ts"
import { colors, darkEffects, darkTheme, effects, highContrastEffects, highContrastTheme, lightEffects, lightTheme, motion, radius, space, typography } from "./theme/tokens.stylex.ts"
import { focus } from "./theme/focus.ts"
import { size } from "./theme/sizes.stylex.ts"
import { AppearanceContext, type Appearance, type ThemeChoice } from "./theme/appearance.ts"
import { STEP_DISCLOSURE_CHOICES, StepDisclosureContext, type StepDisclosure } from "./features/conversation/disclosure.ts"
import { BakePiBrand } from "./ui/BakePiBrand.tsx"
import { TetrisLoader } from "./ui/TetrisLoader.tsx"
import { Workbench } from "./features/workbench/Workbench.tsx"
import { WorkspaceDialog } from "./features/workbench/WorkspaceDialog.tsx"
import type { ContractError, WorkspaceRuntime } from "@bake-pi/contract"

/** The four the picker offers, named once so a stored value can be checked against them. */
const THEME_CHOICES = ["system", "light", "dark", "high-contrast"] as const satisfies readonly ThemeChoice[]
const SKIP_OPENING_CHOICES = ["false", "true"] as const

/**
 * Automatic reopening is a startup behavior, not a reaction to every empty
 * workspace. The module is rebuilt on a renderer reload, while this flag stays
 * set when a person explicitly closes a workspace in the running application.
 */
let startupWorkspaceChoiceHandled = false

export const App = (): React.JSX.Element => {
  const state = useReadableView(store.views.shell)
  /*
   * The theme was `useState("system")` and therefore forgotten on every launch:
   * somebody who needs the high-contrast theme had to choose it again each time
   * the application started, which is the one case where a preference is not a
   * preference. It is remembered on change and validated on read, so a value
   * from an older build falls back to following the system rather than
   * resolving to a theme that no longer exists.
   */
  const [theme, setTheme] = useState<ThemeChoice>(() => rememberedChoice("theme", THEME_CHOICES, "system"))
  const chooseTheme = (choice: ThemeChoice): void => {
    setTheme(choice)
    remember("theme", choice)
  }
  const [disclosure, setDisclosure] = useState<StepDisclosure>(() => rememberedChoice("step-disclosure", STEP_DISCLOSURE_CHOICES, "auto"))
  const chooseDisclosure = (choice: StepDisclosure): void => {
    setDisclosure(choice)
    remember("step-disclosure", choice)
  }
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches)
  const [trustReviewed, setTrustReviewed] = useState<string | undefined>()

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)")
    const change = (): void => setSystemDark(query.matches)
    query.addEventListener("change", change)
    return () => query.removeEventListener("change", change)
  }, [])

  const appearance: Appearance = theme === "high-contrast" ? "high-contrast" : theme === "light" || (theme === "system" && !systemDark) ? "light" : "dark"
  // Two theme classes rather than one. Colour and elevation are separate
  // variable groups because the two lift strategies need different shadows —
  // dark seats a lighter surface, light asks the shadow to carry the whole
  // step, and high contrast replaces both with an outline. One group could not
  // hold that without a shadow token that lies in two of the three themes.
  const appliedTheme = appearance === "high-contrast" ? highContrastTheme : appearance === "light" ? lightTheme : darkTheme
  const appliedEffects = appearance === "high-contrast" ? highContrastEffects : appearance === "light" ? lightEffects : darkEffects
  const workspace = state.workspace
  const needsTrust = workspace?.trust === "untrusted" && trustReviewed !== workspace.id
  const onWorkbench = workspace !== undefined && !needsTrust

  return (
    <AppearanceContext.Provider value={appearance}>
    <StepDisclosureContext.Provider value={disclosure}>
    <div {...stylex.props(styles.app, appliedTheme, appliedEffects)}>
      <a href="#main-content" {...stylex.props(focus.ring, styles.skip)}>Skip to main content</a>
      {/*
        The workbench has the tab strip as its drag region. Every screen
        before that has no chrome of its own, and `titleBarStyle: hidden`
        removes the native one, so without this bar the window can only be
        moved from the caption buttons — which on Windows are not a grab.
      */}
      {onWorkbench ? null : <div aria-hidden="true" {...stylex.props(styles.windowDrag)} />}
      {workspace === undefined && state.connection.status !== "connected" ? <ConnectionScreen state={state.connection.status} error={state.connection.status === "disconnected" ? state.connection.error : undefined} /> : workspace === undefined ? <NoWorkspace /> : needsTrust ? <TrustWorkspace workspaceName={workspace.displayName} root={workspace.root} runtime={workspace.runtime} onReviewed={() => setTrustReviewed(workspace.id)} /> : <Workbench theme={theme} onTheme={chooseTheme} disclosure={disclosure} onDisclosure={chooseDisclosure} />}
    </div>
    </StepDisclosureContext.Provider>
    </AppearanceContext.Provider>
  )
}

const ConnectionScreen = ({ state, error }: { state: "connecting" | "disconnected"; error?: ContractError | undefined }): React.JSX.Element =>
  state === "connecting" ? <Splash /> : <HostDisconnected error={error} />

/**
 * The starting screen: a thumbnail, a line saying what is happening, and a
 * small indeterminate bar under it.
 *
 * No card around it. A container would be chrome drawn to hold three elements
 * that already read as one group, and this interface tells things apart by
 * fills and elevation rather than by boxes — a panel here would be the only
 * outline on the screen, wrapped around the one thing nobody looks at for
 * longer than a second.
 *
 * The board drops randomized pieces into collision-checked placements while
 * the host connects. Its lifetime follows the connection, never an artificial
 * minimum delay. Startup has no measured percentage, so the text and
 * indeterminate bar remain below it.
 */
const Splash = (): React.JSX.Element => (
  <main id="main-content" {...stylex.props(scrollbars.thin, styles.center, styles.splashCenter)}>
    {/* The status role sits here, not on `main` — it would replace the
        landmark, and the splash is the one screen a person may need to skip
        past to reach anything. */}
    <div role="status" {...stylex.props(styles.splash)}>
      <TetrisLoader />
      <span {...stylex.props(styles.splashStatus)}>Starting the agent host…</span>
      <span aria-hidden="true" {...stylex.props(styles.track)}><span {...stylex.props(styles.bar)} /></span>
    </div>
  </main>
)

/**
 * The screen a failed host leaves behind, and for a while the only thing it
 * said was that the host was gone.
 *
 * That was survivable when the host had already been running — the sentence
 * about recovery is true, and restarting is the whole answer. It was useless
 * for the case that actually reaches us: a first launch on somebody else's
 * machine where the host never started, where "disconnected" is the only word
 * anyone has, and where the reason was being discarded twice over on the way
 * here. So the reason is shown when there is one, and the log is one click
 * away, because a person who cannot fix this themselves can at least send the
 * file to somebody who can.
 *
 * The third control only appears when a Pi installed from upstream is the one
 * selected, and it is the reason this screen asks main a question at all. The
 * settings panel that chose that Pi lives inside the workbench, and the
 * workbench is exactly what a host that will not start never reaches — so the
 * way back cannot live there. Offering it here keeps a bad install from being a
 * one-way door.
 */
const HostDisconnected = ({ error }: { error?: ContractError | undefined }): React.JSX.Element => {
  const [managedPi, setManagedPi] = useState<string | undefined>(undefined)
  const [reverting, setReverting] = useState(false)

  useEffect(() => {
    void store.send("get_pi_runtime", {}).then(
      (runtime) => { setManagedPi(runtime.activeVersion) },
      () => {
        // Main answers this without the host, so a failure here is main itself
        // being unreachable. Nothing on this screen would work in that case,
        // and a second error message would explain none of it.
      },
    )
  }, [])

  return (
  <main id="main-content" {...stylex.props(scrollbars.thin, styles.center)}>
    <span {...stylex.props(styles.trustIcon, styles.dangerIcon)}><RotateCcw size={26} /></span>
    <span {...stylex.props(styles.kicker)}>Connection</span>
    <h1 {...stylex.props(styles.emptyTitle)}>Agent host disconnected</h1>
    <p {...stylex.props(styles.body)}>Your conversation remains visible after recovery. Restart the host to reopen safe sessions.</p>
    {error === undefined ? undefined : (
      <code {...stylex.props(styles.rootPath, styles.failure)}>
        {error.code}{error.detail === undefined ? "" : `: ${error.detail}`}
      </code>
    )}
    <div {...stylex.props(styles.actions)}>
      <button type="button" onClick={() => void store.restartHost().catch((thrown: unknown) => store.capture(thrown))} {...stylex.props(focus.control, styles.primary)}><RotateCcw size={16} /> Restart agent host</button>
      <button type="button" onClick={() => void store.revealLogFile().catch((thrown: unknown) => store.capture(thrown))} {...stylex.props(focus.control, styles.secondary)}><FolderOpenIcon width={16} height={16} /> Show log</button>
      {managedPi === undefined ? undefined : (
        <button
          type="button"
          disabled={reverting}
          onClick={() => {
            setReverting(true)
            void store.send("use_pi", {})
              .catch((thrown: unknown) => store.capture(thrown))
              .finally(() => { setReverting(false) })
          }}
          {...stylex.props(focus.control, styles.secondary)}
        >
          <RotateCcw size={16} /> {reverting ? "Switching…" : `Use the bundled Pi instead of ${managedPi}`}
        </button>
      )}
    </div>
  </main>
  )
}

const slide = stylex.keyframes({
  "0%": { transform: "translateX(-110%)" },
  "100%": { transform: "translateX(440%)" },
})

/**
 * The first screen stays task-focused: the chooser is the only action on first
 * use, then the last project becomes the fast path and the chooser steps back.
 * Automatic opening remains opt-in so this choice is always reachable again.
 */
/**
 * The recent-row folder glyph is inlined rather than fetched: the renderer CSP
 * allows no external images, and a remote image would paint late on the one
 * screen everyone sees.
 */
const FolderIcon = ({ size = 16 }: { size?: number }): React.JSX.Element => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 18 18" fill="none">
    <defs>
      <linearGradient id="recent-folder-fill" x1="9.252" y1="0.485" x2="8.842" y2="16.966" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#ffd400" />
        <stop offset="0.415" stopColor="#ffd000" />
        <stop offset="0.845" stopColor="#ffc301" />
        <stop offset="1" stopColor="#ffbd02" />
      </linearGradient>
    </defs>
    <path d="M17.579,3.283H9.727a.419.419,0,0,1-.233-.07L7.251,1.721a.42.42,0,0,0-.233-.071H.421A.42.42,0,0,0,0,2.07V15.93a.42.42,0,0,0,.421.42H17.579A.42.42,0,0,0,18,15.93V3.7A.42.42,0,0,0,17.579,3.283Z" fill="#dfa500" />
    <rect x="1.636" y="2.455" width="4.091" height="0.818" rx="0.172" fill="#fff" />
    <path d="M17.579,3.263H8.956a.421.421,0,0,0-.3.123L7.272,4.773a.42.42,0,0,1-.3.123H.421A.42.42,0,0,0,0,5.316V15.91a.42.42,0,0,0,.421.419H17.579A.42.42,0,0,0,18,15.91V3.683A.42.42,0,0,0,17.579,3.263Z" fill="url(#recent-folder-fill)" />
  </svg>
)

const NoWorkspace = (): React.JSX.Element => {
  const [recent] = useState(() => rememberedWorkspace())
  const [skipOpening, setSkipOpening] = useState(
    () => rememberedChoice("skip-opening-screen", SKIP_OPENING_CHOICES, "false") === "true",
  )
  const [opening, setOpening] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [error, setError] = useState<string | undefined>()


  const reopenRecent = async (): Promise<void> => {
    setOpening(true)
    setError(undefined)
    try {
      const workspace = await store.reopenRecentWorkspace()
      if (workspace === undefined) {
        setError("That recent project is no longer available. Choose its folder again to continue.")
        return
      }
      rememberWorkspace(workspace)
    } catch (cause) {
      store.capture(cause)
      setError("That recent project could not be opened. Choose another folder or turn off automatic opening.")
    } finally {
      setOpening(false)
    }
  }

  useEffect(() => {
    if (startupWorkspaceChoiceHandled) return
    startupWorkspaceChoiceHandled = true
    if (skipOpening && recent !== undefined) void reopenRecent()
  }, [recent, skipOpening])

  const setSkip = (checked: boolean): void => {
    setSkipOpening(checked)
    remember("skip-opening-screen", checked ? "true" : "false")
  }

  return (
    <main id="main-content" aria-busy={opening} {...stylex.props(scrollbars.thin, styles.center, styles.launchScreen)}>
      <div {...stylex.props(styles.launchContent)}>
        <div {...stylex.props(styles.launchIntro)}>
          <BakePiBrand />
          <p {...stylex.props(styles.body)}>Open a project folder to begin. Sessions, credentials and tools stay where Pi keeps them, so this picks up exactly what the CLI left.</p>
        </div>

        <div {...stylex.props(styles.launchPanel)}>
          {recent === undefined ? null : (
            <section aria-labelledby="recent-project-heading" {...stylex.props(styles.recentSection)}>
              <h2 id="recent-project-heading" {...stylex.props(styles.recentHeading)}>Recent project</h2>
              <button
                type="button"
                aria-label={`Open recent project ${recent.displayName || recent.root}`}
                disabled={opening}
                onClick={() => void reopenRecent()}
                {...stylex.props(focus.control, styles.recentProject)}
              >
                <span aria-hidden="true" {...stylex.props(styles.recentIcon)}><FolderIcon /></span>
                <strong {...stylex.props(styles.recentName)}>{recent.displayName || recent.root}</strong>
                <code title={recent.root} {...stylex.props(styles.recentPath)}>{recent.root}</code>
                <ArrowRightIcon aria-hidden="true" width={15} height={15} {...stylex.props(styles.recentArrow)} />
              </button>
            </section>
          )}

          <button
            type="button"
            aria-label="Open a workspace"
            disabled={opening}
            onClick={() => setChoosing(true)}
            {...stylex.props(focus.control, recent === undefined ? styles.primary : styles.secondary)}
          >
            <FolderOpenIcon aria-hidden="true" width={16} height={16} />
            Open a workspace…
          </button>

          <label {...stylex.props(styles.skipOpening)}>
            <input
              type="checkbox"
              checked={skipOpening}
              disabled={opening}
              onChange={(event) => setSkip(event.currentTarget.checked)}
              {...stylex.props(focus.control, styles.checkbox)}
            />
            <span {...stylex.props(styles.skipOpeningCopy)}>
              <strong {...stylex.props(styles.skipOpeningTitle)}>Skip this screen next time</strong>
              <span {...stylex.props(styles.skipOpeningHint)}>Automatically open the most recent project when Bake Pi starts.</span>
            </span>
          </label>

          {error === undefined ? null : <p role="alert" {...stylex.props(styles.launchError)}>{error}</p>}
        </div>
      </div>
      {choosing ? <WorkspaceDialog onClose={() => setChoosing(false)} onOpened={(workspace) => { rememberWorkspace(workspace); setChoosing(false) }} /> : null}
    </main>
  )
}

const TrustWorkspace = ({ workspaceName, root, runtime, onReviewed }: { workspaceName: string; root: string; runtime: WorkspaceRuntime; onReviewed: () => void }): React.JSX.Element => {
  const [busy, setBusy] = useState(false)
  const trust = async (): Promise<void> => {
    setBusy(true)
    try { await store.decideTrust("trusted"); onReviewed() } catch (error) { store.capture(error) } finally { setBusy(false) }
  }
  return (
    <main id="main-content" {...stylex.props(scrollbars.thin, styles.center)}>
      <span {...stylex.props(styles.trustIcon)}><ShieldQuestion size={28} /></span>
      <span {...stylex.props(styles.kicker)}>Project trust</span>
      <h1 {...stylex.props(styles.title)}>Do you trust {workspaceName}?</h1>
      <code title={root} {...stylex.props(styles.rootPath)}>{root}</code>
      <p {...stylex.props(styles.body)}>{runtime.kind === "wsl" ? `Pi, project extensions, and tools run inside the ${runtime.distro} WSL distribution.` : "Pi, project extensions, and tools run on Windows."}</p>
      <p {...stylex.props(styles.body)}>Trust allows project extensions and lets tools write inside this workspace without asking each time. It is not a sandbox. Outside-workspace and unknown-target tools still require approval.</p>
      <div {...stylex.props(styles.trustActions)}><button type="button" onClick={onReviewed} {...stylex.props(focus.control, styles.secondary)}><KeyRound size={16} /> Continue restricted</button><button type="button" disabled={busy} onClick={() => void trust()} {...stylex.props(focus.control, styles.primary)}><ShieldCheck size={16} /> Trust workspace</button></div>
    </main>
  )
}

const styles = stylex.create({
  app: { position: "fixed", inset: 0, color: colors.text, backgroundColor: colors.canvas, fontFamily: typography.ui, fontSize: typography.body, lineHeight: typography.bodyLine, "::selection": { color: colors.selectionText, backgroundColor: colors.selection } },
  /**
   * Same height as the tab strip, so the native overlay buttons sit in a
   * grab of matching depth on screens that have no strip. Inset with the
   * titlebar-area env vars for the same reason the strip is: a resize must
   * not slide our hit targets under the caption buttons.
   */
  windowDrag: {
    position: "fixed",
    insetBlockStart: 0,
    insetInlineStart: "env(titlebar-area-x, 0px)",
    width: "env(titlebar-area-width, 100%)",
    height: size.tabStrip,
    zIndex: 2,
    userSelect: "none",
    WebkitAppRegion: "drag",
  },
  skip: { position: "fixed", insetInlineStart: space.lg, insetBlockStart: { default: "-80px", ":focus": space.lg }, zIndex: 100, padding: space.md, color: colors.accentOn, backgroundColor: colors.accent, borderRadius: radius.md,  WebkitAppRegion: "no-drag" },
  center: { height: "100%", boxSizing: "border-box", overflowY: "auto", overflowX: "hidden", display: "flex", flexDirection: "column", alignItems: "flex-start", justifyContent: "flex-start", paddingBlockStart: "clamp(80px, 14vh, 128px)", paddingBlockEnd: space.xxxl, paddingInline: "clamp(24px, 4vw, 64px)", textAlign: "start" },
  launchScreen: { justifyContent: { default: "center", "@media (max-height: 680px)": "flex-start" } },
  /**
   * Reading stays on the left and action stays on the right. The chooser is a
   * single button now, so the two-column composition no longer splits one
   * workspace decision across two competing calls to action.
   */
  launchContent: {
    width: "min(920px, 100%)",
    display: "grid",
    gridTemplateColumns: { default: "minmax(0, 1fr) minmax(300px, 380px)", "@media (max-width: 960px)": "minmax(0, 1fr)" },
    alignItems: "center",
    columnGap: space.xxxl,
    rowGap: space.xxl,
    marginInline: "auto",
  },
  launchIntro: { minWidth: 0, display: "flex", flexDirection: "column", alignItems: "flex-start" },
  launchPanel: { minWidth: 0, display: "flex", flexDirection: "column", alignItems: "stretch" },
  splashCenter: { alignItems: "center", justifyContent: "center", paddingBlockStart: size.tabStrip, paddingBlockEnd: size.tabStrip, paddingInline: space.xxl, textAlign: "center" },
  title: { maxWidth: "24ch", marginBlock: space.sm, fontFamily: typography.display, fontSize: typography.title, lineHeight: typography.titleLine, fontWeight: 500, textWrap: "balance", overflowWrap: "anywhere" },
  body: { maxWidth: "48ch", marginBlockStart: space.sm, marginBlockEnd: space.lg, color: colors.textMuted, lineHeight: typography.bodyLine },
  primary: { minHeight: size.control, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: space.sm, paddingInline: space.lg, color: colors.accentOn, backgroundColor: { default: colors.accent, ":hover": colors.accentHover, ":active": colors.accent }, borderWidth: 0, borderRadius: radius.md, cursor: { default: "pointer", ":disabled": "not-allowed" }, opacity: { default: 1, ":disabled": 0.5 }, fontWeight: 700, WebkitAppRegion: "no-drag" },
  actions: { display: "flex", flexWrap: "wrap", gap: space.sm, justifyContent: "center", marginBlockStart: space.lg },
  failure: { marginBlockStart: space.sm, color: colors.danger },
  secondary: { minHeight: size.control, display: "inline-flex", alignItems: "center", gap: space.sm, paddingInline: space.lg, color: { default: colors.textMuted, ":hover": colors.text }, backgroundColor: { default: colors.surface, ":hover": colors.surfaceRaised }, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.borderStrong, borderRadius: radius.md, cursor: { default: "pointer", ":disabled": "not-allowed" }, opacity: { default: 1, ":disabled": 0.5 }, fontWeight: 600, WebkitAppRegion: "no-drag" },
  splash: { display: "flex", flexDirection: "column", alignItems: "center", gap: space.lg },
  splashStatus: { color: colors.textMuted, fontSize: typography.caption, lineHeight: typography.captionLine },
  /**
   * Indeterminate, and honest about it. Under reduced motion the travelling
   * fill becomes a still full-width one rather than a short bar frozen a
   * quarter of the way along, which would read as stuck.
   */
  track: { width: "112px", height: "2px", overflow: "hidden", backgroundColor: colors.surfaceRaised, borderRadius: radius.sm },
  bar: { display: "block", width: { default: "26%", "@media (prefers-reduced-motion: reduce)": "100%" }, height: "100%", backgroundColor: colors.accent, borderRadius: radius.sm, opacity: { default: 1, "@media (prefers-reduced-motion: reduce)": 0.45 }, animationName: { default: slide, "@media (prefers-reduced-motion: reduce)": "none" }, animationDuration: "1500ms", animationIterationCount: "infinite", animationTimingFunction: "linear" },
  dangerIcon: { color: colors.danger, backgroundColor: colors.dangerSoft },
  /** The spare screen stays on the same compact scale as the workbench. */
  emptyTitle: { maxWidth: "24ch", marginBlock: space.sm, fontFamily: typography.display, fontSize: typography.title, lineHeight: typography.titleLine, fontWeight: 500, textWrap: "balance" },
  kicker: { color: colors.textFaint, fontSize: typography.micro, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" },
  recentSection: { width: "100%", marginBlockEnd: space.lg },
  recentHeading: { marginBlockStart: 0, marginBlockEnd: space.sm, color: colors.textFaint, fontSize: typography.micro, lineHeight: typography.microLine, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" },
  recentProject: { width: "100%", minHeight: size.controlTall, display: "flex", alignItems: "center", gap: space.sm, paddingBlock: space.xs, paddingInline: space.sm, marginInline: `calc(-1 * ${space.sm})`, borderWidth: 0, borderRadius: radius.md, color: { default: colors.textMuted, ":hover": colors.text }, backgroundColor: { default: "transparent", ":hover": colors.surfaceRaised }, cursor: { default: "pointer", ":disabled": "not-allowed" }, opacity: { default: 1, ":disabled": 0.56 }, textAlign: "start", transform: { default: "scale(1)", ":active": "scale(0.98)" }, transitionProperty: "background-color, color, transform", transitionDuration: motion.fast, transitionTimingFunction: motion.settle, WebkitAppRegion: "no-drag" },
  recentIcon: { display: "inline-flex", flex: "none" },
  recentName: { maxWidth: "60%", flex: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.text, fontSize: typography.body, lineHeight: typography.bodyLine, fontWeight: 650 },
  recentPath: { minWidth: 0, flexGrow: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.textFaint, fontFamily: typography.mono, fontSize: typography.caption, lineHeight: typography.captionLine },
  recentArrow: { flex: "none" },
  skipOpening: { minHeight: size.controlTall, display: "flex", alignItems: "center", gap: space.md, marginBlockStart: space.lg, color: colors.textMuted, cursor: "pointer", userSelect: "none", WebkitAppRegion: "no-drag" },
  checkbox: { width: "18px", height: "18px", flex: "none", margin: 0, accentColor: colors.accent, cursor: { default: "pointer", ":disabled": "not-allowed" } },
  skipOpeningCopy: { display: "flex", flexDirection: "column", gap: space.xs },
  skipOpeningTitle: { color: colors.text, fontSize: typography.label, lineHeight: typography.labelLine, fontWeight: 600 },
  skipOpeningHint: { color: colors.textFaint, fontSize: typography.caption, lineHeight: typography.captionLine },
  launchError: { marginBlockStart: space.md, marginBlockEnd: 0, color: colors.danger, fontSize: typography.caption, lineHeight: typography.captionLine },
  trustIcon: { width: "56px", height: "56px", display: "grid", placeItems: "center", marginBlockEnd: space.lg, color: colors.warning, backgroundColor: colors.warningSoft, borderRadius: radius.lg },
  rootPath: { maxWidth: "min(720px, 88vw)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingBlock: space.sm, paddingInline: space.md, color: colors.textMuted, backgroundColor: colors.sunken, borderRadius: radius.sm, fontFamily: typography.mono, fontSize: typography.caption },
  trustActions: { display: "flex", flexWrap: "wrap", justifyContent: "flex-start", gap: space.md },
})
