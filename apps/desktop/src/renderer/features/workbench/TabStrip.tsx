import * as stylex from "@stylexjs/stylex"
import { ArrowUp, Blocks, Command, History, PanelLeft, PanelRight, Plus, RotateCcw, Settings2, TriangleAlert, X } from "lucide-react"
import type { SessionStatus, SessionSummary } from "@bake-pi/contract"
import { store, type WorkbenchView } from "../../store/session-store.ts"
import { colors, effects, radius, space, typography } from "../../theme/tokens.stylex.ts"
import { focus } from "../../theme/focus.ts"
import { size } from "../../theme/sizes.stylex.ts"
import { scrollbars } from "../../theme/scrollbars.ts"
import { spinners } from "../../theme/spinners.ts"
import { WorkspaceMenu } from "./WorkspaceMenu.tsx"

/**
 * The strip that replaced the page header.
 *
 * There is no title bar inside the application because the tab states the
 * session once, and stating it twice is how a header ends up disagreeing with
 * the tab beside it. What the tab adds over a title is demand: a session
 * blocked on an approval lifts and counts, because a background session has
 * nowhere else to ask.
 *
 * Only attached sessions get a tab. Every session in the workspace, including
 * the ones nothing is holding open, lives in the Sessions modal — a tab is a
 * thing being held open, not a thing that exists.
 *
 * The right end is where the wireframe drew window controls. The renderer does
 * not counterfeit them: `createMainWindow` places Electron's native overlay
 * over this strip, and the title-bar environment variables reserve its real
 * width here. The remaining space goes to the controls that had nowhere else
 * to live once the header was deleted.
 */
export const TabStrip = ({
  state,
  onNewSession,
  sessionsOpen,
  settingsOpen,
  onToggleSessions,
  onToggleSettings,
  onShowResources,
  onShowPiEngine,
  onToggleFiles,
  onToggleActivity,
  onOpenPalette,
}: {
  state: WorkbenchView
  onNewSession: () => void
  sessionsOpen: boolean
  settingsOpen: boolean
  onToggleSessions: () => void
  onToggleSettings: () => void
  onShowResources: () => void
  /**
   * Where the Pi update badge leads.
   *
   * It used to lead to Resources, which was the only place the newer version
   * was named and a place that could do nothing about it. Now that installing
   * upstream Pi is a thing this application can do, the badge goes to the
   * section that does it.
   */
  onShowPiEngine: () => void
  onToggleFiles: () => void
  onToggleActivity: () => void
  onOpenPalette: () => void
}): React.JSX.Element => {
  const workspace = state.workspace!
  const open = state.sessionList.filter((session) => state.sessions[session.id] !== undefined)

  return (
    <header {...stylex.props(styles.strip)}>
      <div {...stylex.props(styles.identity)}>
        {/*
          The two rail toggles appear only at the widths where their rail has
          folded to an overlay. Above those widths the rails are simply there,
          and a control for showing something already shown is a control that
          teaches a person to distrust the others beside it.
        */}
        <button type="button" onClick={onToggleFiles} aria-label="Toggle files" title="Files" {...stylex.props(focus.control, styles.press, styles.controlIcon, styles.filesToggle)}><PanelLeft size={16} /></button>
        <span {...stylex.props(styles.wordmark)}>bakepi</span>
        {/*
          The workspace as a compact recess rather than as trailing text.

          It is the one piece of the strip that names what everything else is
          about, and set as loose caption beside the wordmark it read as a
          subtitle of the wordmark. A solid recess makes it an object — the
          thing the tabs, the rails and the tools all belong to.
        */}
        <WorkspaceMenu workspace={workspace} />
      </div>

      <div role="tablist" aria-label="Open sessions" {...stylex.props(scrollbars.thin, styles.tabs)}>
        {open.map((session) => (
          <Tab key={session.id} session={session} state={state} />
        ))}
        {state.sessionStarting ? <StartingTab /> : null}
        <button type="button" onClick={onNewSession} disabled={state.sessionStarting} aria-label="New session" title="New session" {...stylex.props(focus.control, styles.press, styles.newTab)}>
          <Plus size={16} />
        </button>
      </div>
      {/*
        The leftover of the strip after the tabs have taken what they need.
        Tabs used to be `flex: 1`, so the empty space a person grabs to move
        the window lived inside a scrollport — and a drag there either scrolled
        the tabs or did nothing, never moved the window. This stretch is that
        grab, and it is why the tablist no longer grows.
      */}
      <div aria-hidden="true" {...stylex.props(styles.dragFill)} />

      <div {...stylex.props(styles.controls)}>
        <Connection state={state} onShowResources={onShowResources} onShowPiEngine={onShowPiEngine} />
        <button
          type="button"
          onClick={onToggleSessions}
          aria-label="Sessions"
          aria-expanded={sessionsOpen}
          aria-controls="sessions-modal"
          title="Sessions"
          {...stylex.props(focus.control, styles.press, styles.controlIcon, sessionsOpen && styles.controlIconActive)}
        ><History size={16} /></button>
        <button
          type="button"
          onClick={onToggleSettings}
          aria-label="Settings"
          aria-expanded={settingsOpen}
          aria-controls="settings-modal"
          title="Settings"
          {...stylex.props(focus.control, styles.press, styles.controlIcon, settingsOpen && styles.controlIconActive)}
        ><Settings2 size={16} /></button>
        {/*
          The palette is how every command — including the modal surfaces and
          activity rail — is reached from the keyboard, so its trigger stands
          beside them and names its own key.
        */}
        <button type="button" onClick={onOpenPalette} aria-label="Command palette" title="Command palette (Ctrl+K)" {...stylex.props(focus.control, styles.press, styles.controlIcon)}><Command size={16} /></button>
        <button type="button" onClick={onToggleActivity} aria-label="Toggle activity" title="Activity" {...stylex.props(focus.control, styles.press, styles.controlIcon, styles.activityToggle)}><PanelRight size={16} /></button>
      </div>
    </header>
  )
}

/** One tab, at whichever of the two widths `styles.tab` declares. */
const Tab = ({ session, state }: { session: SessionSummary; state: WorkbenchView }): React.JSX.Element => {
  const selected = !state.sessionStarting && state.activeSessionId === session.id
  const snapshot = state.sessions[session.id]!.snapshot
  const approvals = snapshot.approvalCount
  const questions = state.extensionRequest?.sessionId === session.id ? 1 : 0
  const demands = approvals + questions

  return (
    <div {...stylex.props(styles.tab, selected && styles.tabSelected, !selected && demands > 0 && styles.tabDemanding)}>
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        onClick={() => store.selectSession(session.id)}
        {...stylex.props(focus.control, styles.press, styles.tabButton)}
      >
        <StatusMark status={snapshot.status} />
        <span {...stylex.props(styles.tabTitle, selected && styles.tabTitleSelected)}>{session.title || "Untitled session"}</span>
      </button>
      {demands > 0 ? (
        <span aria-label={`${demands} ${demands === 1 ? "action" : "actions"} awaiting you`} {...stylex.props(styles.count)}>{demands}</span>
      ) : snapshot.status === "quarantined" ? (
        <span {...stylex.props(styles.quarantined)}>Quarantined</span>
      ) : (
        <button
          type="button"
          onClick={() => void store.closeSession(session.id).catch((error: unknown) => store.capture(error))}
          aria-label={`Close ${session.title || "untitled session"}`}
          {...stylex.props(focus.control, styles.press, styles.closeTab)}
        >
          <X size={14} />
        </button>
      )}
    </div>
  )
}

/** A selected tab while Pi is creating the authoritative session behind it. */
const StartingTab = (): React.JSX.Element => (
  <div {...stylex.props(styles.tab, styles.tabSelected)}>
    <button type="button" role="tab" aria-selected="true" aria-label="Starting new session" disabled {...stylex.props(styles.tabButton)}>
      <span aria-hidden="true" {...stylex.props(spinners.running)} />
      <span {...stylex.props(styles.tabTitle, styles.tabTitleSelected)}>New session</span>
    </button>
  </div>
)

/**
 * The dot in front of a tab's title, and the one place a session's state is
 * drawn without words.
 *
 * A spinner for the two states where something is happening and a person is
 * waiting on it, a dot for everything else. `awaiting_approval` gets no mark
 * at all: the count badge on the other end of the tab already says it, louder,
 * and two marks for one state is how a tab runs out of room.
 *
 * The dot is the last thing in the interface that was told apart by hue alone,
 * and in a grey palette it cannot be. So it is told apart by fill instead: idle
 * is a dim disc, waiting a bright one, and gone a ring — a hole where the fill
 * should be, which reads as absence at seven pixels in a way that a third shade
 * of grey would not.
 */
const StatusMark = ({ status }: { status: SessionStatus }): React.JSX.Element => {
  if (status === "streaming" || status === "compacting" || status === "retrying") {
    return <span aria-label={status === "streaming" ? "Streaming" : status === "compacting" ? "Compacting" : "Retrying"} {...stylex.props(spinners.running)} />
  }
  return (
    <span
      aria-label={status}
      {...stylex.props(
        styles.dot,
        status === "idle" ? styles.dotIdle : status === "awaiting_approval" ? styles.dotWaiting : styles.dotGone,
      )}
    />
  )
}

/**
 * Whether Pi is there, and what to do when it is not.
 *
 * The whole indicator used to be `display: none` under 1200px, which is the
 * width a laptop actually runs at — so the one state a person has to act on
 * was invisible on the commonest window, and the restart it offers went with
 * it. Now only the wording folds away: the dot and, when it exists, the
 * restart survive at every width, and the words stay in the accessibility tree
 * rather than leaving the live region with nothing to announce.
 */
const Connection = ({ state, onShowResources, onShowPiEngine }: { state: WorkbenchView; onShowResources: () => void; onShowPiEngine: () => void }): React.JSX.Element => {
  const connection = state.connection
  const status = connection.status
  const said = status === "connected"
    ? `Pi ${connection.piVersion || "agent"} connected`
    : status === "connecting"
      ? "Connecting to Pi"
      : "Pi disconnected"
  const extensions = state.resources.filter(
    (resource) => resource.kind === "extension" && resource.scope !== "builtin",
  )
  const loadErrors = state.resources.filter(
    (resource) => resource.kind === "extension" && resource.loadError !== undefined,
  ).length
  const errorCount = loadErrors + state.extensionErrors.length
  const detail = connection.status !== "connected" || connection.runtime === undefined
    ? said
    : [
        said,
        `Bake Pi ${connection.runtime.appVersion}`,
        `Electron ${connection.runtime.electronVersion}`,
        `Node ${connection.runtime.nodeVersion}`,
        `${connection.runtime.platform}/${connection.runtime.arch}`,
      ].join(" · ")

  return (
    <div {...stylex.props(styles.connectionGroup)}>
      {/* The title is for the narrow window, where the mark is all that is left
          of this and a mark alone does not say which state it is. */}
      <div role="status" title={detail} {...stylex.props(styles.connection)}>
        {status === "connecting" ? (
          <span aria-hidden="true" {...stylex.props(spinners.running, spinners.small)} />
        ) : (
          <span aria-hidden="true" {...stylex.props(styles.dot, status === "connected" ? styles.dotIdle : styles.dotGone)} />
        )}
        <span {...stylex.props(styles.connectionText)}>{said}</span>
        {status === "disconnected" ? (
          <button type="button" onClick={() => void store.restartHost().catch((error: unknown) => store.capture(error))} {...stylex.props(focus.control, styles.press, styles.restart)}>
            <RotateCcw size={13} /> Restart
          </button>
        ) : null}
      </div>
      {connection.status === "connected" && connection.latestPiVersion !== undefined ? (
        <button
          type="button"
          onClick={onShowPiEngine}
          aria-label={`Pi ${connection.latestPiVersion} update available; running ${connection.piVersion}`}
          title={`Pi ${connection.latestPiVersion} available · running ${connection.piVersion}`}
          {...stylex.props(focus.control, styles.press, styles.updateStatus)}
        >
          <ArrowUp size={13} aria-hidden="true" />
          <span {...stylex.props(styles.updateStatusLabel)}>Pi {connection.latestPiVersion}</span>
        </button>
      ) : null}
      {extensions.length === 0 && errorCount === 0 ? null : (
        <button
          type="button"
          onClick={onShowResources}
          aria-label={errorCount > 0
            ? `${extensions.length} installed Pi extensions, ${errorCount} extension issues`
            : `${extensions.length} installed Pi extensions`}
          title={errorCount > 0
            ? `${extensions.length} installed extensions · ${errorCount} issues`
            : `${extensions.length} installed extensions`}
          {...stylex.props(focus.control, styles.press, styles.resourceStatus, errorCount > 0 && styles.resourceStatusError)}
        >
          {errorCount > 0 ? <TriangleAlert size={13} aria-hidden="true" /> : <Blocks size={13} aria-hidden="true" />}
          <span>{extensions.length}</span>
        </button>
      )}
    </div>
  )
}

const styles = stylex.create({
  /**
   * The strip's controls give under the pointer, which the shared
   * `focus.control` deliberately does not do: a press is this row's
   * character rather than every control's, and `focus.control` already names
   * `transform` in its transition list so the movement is carried for free.
   */
  press: { transform: { default: "scale(1)", ":active": "scale(0.97)" } },
  /**
   * `size.tabStrip`, which is 44: a 28px tab with eight pixels of air above
   * and below — the grab, and the gap between the strip's three zones.
   *
   * The overlay caption buttons occupy the trailing (Windows) or leading
   * (macOS) end. `titlebar-area-*` is the content rectangle they leave;
   * padding by that inset keeps our controls out from under them as the
   * window resizes. `%` rather than `vw`: `100vw` includes a scrollbar the
   * frame does not have and over-pads by that width.
   */
  strip: {
    flex: "none",
    height: size.tabStrip,
    display: "flex",
    alignItems: "stretch",
    paddingInlineStart: "env(titlebar-area-x, 0px)",
    paddingInlineEnd: "calc(100% - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100%))",
    backgroundColor: colors.canvasSubtle,
    zIndex: 3,
    userSelect: "none",
    WebkitAppRegion: "drag",
  },
  /**
   * Three zones, and the gaps say which is which: `sm` between the things
   * inside one zone, `lg` between one zone and the next. The strip used to
   * run one gap all the way across, so the wordmark, the workspace, the first
   * tab and the connection dot were all the same distance apart and the eye
   * had nothing to group them by.
   */
  identity: { flex: "none", display: "flex", alignItems: "center", gap: space.sm, paddingInlineStart: { default: size.gutter, "@media (max-width: 960px)": space.xs }, paddingInlineEnd: space.lg },
  filesToggle: { display: { default: "none", "@media (max-width: 960px)": "grid" }, WebkitAppRegion: "no-drag" },
  activityToggle: { display: { default: "none", "@media (max-width: 1200px)": "grid" } },
  wordmark: { color: colors.text, fontFamily: typography.display, fontSize: typography.label, fontWeight: 700, lineHeight: typography.labelLine },

  /**
   * Sized to its tabs, allowed to shrink, never grown into the leftover.
   * Growing made the empty grab live inside this scrollport, so a drag there
   * could not move the window. `no-drag` is what lets the tablist scroll
   * without starting a move.
   */
  tabs: { flexGrow: 0, flexShrink: 1, flexBasis: "auto", minWidth: "176px", display: "flex", alignItems: "center", gap: "2px", paddingInlineEnd: space.sm, overflowX: "auto", scrollbarWidth: "none", WebkitAppRegion: "no-drag" },
  dragFill: { flexGrow: 1, flexShrink: 0, flexBasis: "32px", minWidth: "32px", alignSelf: "stretch" },
  /**
   * A tab is a row, not a button: the title selects and the × closes, and one
   * button cannot be both without the close becoming a click target inside its
   * own activation region.
   */
  /**
  * 176px, and 144 once the window is narrow enough that the strip is mostly
   * controls.
   *
   * Fixed rather than fitted, at either width: a strip whose tabs resize as
   * titles arrive moves every other tab under the pointer, and titles do arrive
  * — several seconds in, when Pi names the session. 144 is the width at which
   * a status mark, an ellipsized title and a close button still each have room;
   * below it the title would be an ellipsis with nothing before it.
   */
  tab: { flex: "none", width: { default: "176px", "@media (max-width: 720px)": "144px" }, height: size.controlDense, boxSizing: "border-box", display: "flex", alignItems: "center", paddingInlineEnd: space.xs, borderWidth: effects.hairline, borderStyle: "solid", borderColor: "transparent", borderRadius: radius.sm, WebkitAppRegion: "no-drag" },
  tabSelected: { backgroundColor: colors.surface, borderColor: colors.borderStrong },
  /**
   * A background session with something to decide. It takes the first solid
   * surface step — enough to be found in the strip, not enough to be mistaken
   * for the selected tab, which the count badge then settles.
   */
  tabDemanding: { backgroundColor: colors.surface, borderColor: colors.border },
  tabButton: { flex: 1, minWidth: 0, height: "100%", display: "flex", alignItems: "center", gap: space.sm, paddingInlineStart: space.sm, paddingInlineEnd: space.xs, backgroundColor: "transparent", borderWidth: 0, borderRadius: radius.sm, cursor: "pointer", textAlign: "start" },
  tabTitle: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.textMuted, fontFamily: typography.ui, fontSize: typography.label, lineHeight: typography.labelLine },
  tabTitleSelected: { color: colors.text, fontWeight: 600 },
  closeTab: { flex: "none", width: size.controlMicro, height: size.controlMicro, display: "grid", placeItems: "center", padding: 0, color: { default: colors.textFaint, ":hover": colors.text }, backgroundColor: { default: "transparent", ":hover": colors.surfaceOverlay }, borderWidth: 0, borderRadius: radius.sm, cursor: "pointer" },
  newTab: { flex: "none", width: size.controlDense, height: size.controlDense, display: "grid", placeItems: "center", marginInlineStart: space.xs, color: { default: colors.textMuted, ":hover": colors.text }, backgroundColor: { default: "transparent", ":hover": colors.surface }, borderWidth: 0, borderRadius: radius.sm, cursor: { default: "pointer", ":disabled": "not-allowed" }, opacity: { default: 1, ":disabled": 0.4 }, WebkitAppRegion: "no-drag" },

  count: { flex: "none", minWidth: "20px", height: "20px", display: "inline-flex", alignItems: "center", justifyContent: "center", paddingInline: space.xs, color: colors.warningSoft, backgroundColor: colors.warning, borderRadius: radius.md, fontSize: typography.micro, fontWeight: 700 },
  quarantined: { flex: "none", height: "20px", display: "inline-flex", alignItems: "center", paddingInline: "7px", color: colors.danger, backgroundColor: colors.dangerSoft, borderRadius: radius.md, fontSize: typography.micro, fontWeight: 700 },

  dot: { flex: "none", boxSizing: "border-box", width: "8px", height: "8px", borderRadius: radius.pill },
  dotIdle: { backgroundColor: colors.success },
  dotWaiting: { backgroundColor: colors.warning },
  dotGone: { backgroundColor: "transparent", borderWidth: "2px", borderStyle: "solid", borderColor: colors.danger },
  /**
   * A ring rather than an icon, so it is one element and one animation. Under
   * reduced motion the animation is removed, which leaves the state visible
   * without making the ring travel.
   */

  /**
   * The controls end on the gutter the way the identity begins on it: 10px of
   * padding plus the 6px an icon sits inside a 28px button puts the glyph's
   * edge 16 from the window, which is where the rail's rows and the
   * conversation's text also begin.
   */
  controls: { flex: "none", display: "flex", alignItems: "center", gap: "2px", paddingInlineStart: space.sm, paddingInlineEnd: "10px", WebkitAppRegion: "no-drag" },
  connectionGroup: { display: "inline-flex", alignItems: "center", gap: "2px" },
  connection: { display: "inline-flex", alignItems: "center", gap: space.sm, paddingInlineStart: space.sm, paddingInlineEnd: space.sm, color: colors.textMuted, fontSize: typography.caption },
  /**
   * The words fold away where the strip is short of room; the dot beside them
   * does not. Clipped rather than `display: none`, so the live region still
   * has something to announce when the status changes on a narrow window.
   */
  connectionText: {
    position: { default: null, "@media (max-width: 1200px)": "absolute" },
    width: { default: null, "@media (max-width: 1200px)": "1px" },
    height: { default: null, "@media (max-width: 1200px)": "1px" },
    overflow: { default: null, "@media (max-width: 1200px)": "hidden" },
    clip: { default: null, "@media (max-width: 1200px)": "rect(0, 0, 0, 0)" },
    whiteSpace: "nowrap",
  },
  restart: { minHeight: size.controlMicro, display: "inline-flex", alignItems: "center", gap: space.xs, paddingInline: space.sm, color: colors.danger, backgroundColor: colors.dangerSoft, borderWidth: 0, borderRadius: radius.sm, cursor: "pointer", fontSize: typography.caption, fontWeight: 600 },
  updateStatus: { minWidth: size.controlMicro, height: size.controlMicro, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: space.xs, paddingInline: space.sm, color: colors.accentOn, backgroundColor: { default: colors.warning, ":hover": colors.accentHover }, borderWidth: 0, boxShadow: effects.liftRaised, borderRadius: radius.md, cursor: "pointer", fontFamily: typography.ui, fontSize: typography.micro, lineHeight: typography.microLine, fontWeight: 700, WebkitAppRegion: "no-drag" },
  updateStatusLabel: { display: { default: "inline", "@media (max-width: 1080px)": "none" } },
  resourceStatus: { minWidth: size.controlMicro, height: size.controlMicro, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: space.xs, paddingInline: space.sm, color: { default: colors.textMuted, ":hover": colors.text }, backgroundColor: { default: colors.sunken, ":hover": colors.surface }, borderWidth: 0, borderRadius: radius.md, cursor: "pointer", fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine },
  resourceStatusError: { color: { default: colors.warning, ":hover": colors.warning }, backgroundColor: { default: colors.warningSoft, ":hover": colors.warningSoft } },
  controlIcon: { width: size.controlDense, height: size.controlDense, display: "grid", placeItems: "center", padding: 0, color: { default: colors.textMuted, ":hover": colors.text }, backgroundColor: { default: "transparent", ":hover": colors.surface }, borderWidth: 0, borderRadius: radius.sm, cursor: "pointer", WebkitAppRegion: "no-drag" },
  controlIconActive: { color: colors.text, backgroundColor: { default: colors.surface, ":hover": colors.surfaceRaised } },
})
