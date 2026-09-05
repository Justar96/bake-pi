import { useEffect, useRef, useState } from "react"
import * as stylex from "@stylexjs/stylex"
import { AlertTriangle, TerminalSquare, X } from "lucide-react"
import type { SessionStatus } from "@bake-pi/contract"
import { store, type AppState } from "../../store/session-store.ts"
import type { SessionProjection } from "../../store/session-projection.ts"
import { useReadableView } from "../../store/use-readable-view.ts"
import { forget, remember, rememberedNumberIfSet, tokenPixels } from "../../store/preferences.ts"
import { colors, effects, motion, radius, space, typography } from "../../theme/tokens.stylex.ts"
import { focus } from "../../theme/focus.ts"
import { size } from "../../theme/sizes.stylex.ts"
import { scrollbars } from "../../theme/scrollbars.ts"
import { spinners } from "../../theme/spinners.ts"
import type { ThemeChoice } from "../../theme/appearance.ts"
import type { StepDisclosure } from "../conversation/disclosure.ts"
import { ApprovalTray } from "../conversation/ApprovalTray.tsx"
import { Composer } from "../conversation/Composer.tsx"
import { QuestionTray } from "../conversation/QuestionTray.tsx"
import { Timeline } from "../conversation/Timeline.tsx"
import { ActivityRail } from "./ActivityRail.tsx"
import { CommandPalette, type PaletteEntry } from "./CommandPalette.tsx"
import { FileRail } from "./FileRail.tsx"
import { SettingsModal, type SettingsSection } from "./SettingsRail.tsx"
import { SessionsModal } from "./SessionsRail.tsx"
import { TabStrip } from "./TabStrip.tsx"
import { errorBody, errorTitle } from "./ui-copy.ts"
import { matchCommand, WORKBENCH_COMMANDS, type CommandContext } from "./keybindings.ts"
import { RAIL_ACTIVITY, RAIL_FILES, fitColumns, fitRail, preferredRailWidths } from "./layout.ts"

/**
 * The window's inner width, as a render input.
 *
 * Rail fitting is a function of this number, and a resize does not otherwise
 * re-render: the remembered widths are state, the window is not. Reading it
 * here is what makes a squeeze recompute the grid rather than honour a
 * preference the window can no longer show.
 */
const useWindowWidth = (): number => {
  const [width, setWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])
  return width
}

/**
 * The workspace, as three columns under one strip.
 *
 * Two rails around one fluid centre, and the centre is the only column whose
 * content has no natural width — a file name and a token count both stop at a
 * length they choose, while a paragraph will use whatever it is given. So every
 * Most of what a wider window brings goes to the conversation; untouched rails
 * take a modest share until their defaults cap, and every pixel a person takes
 * back off a rail returns to the centre.
 *
 * The rails' widths start at their tokens and are then the person's: the seam
 * beside each one is a `separator` that drags, and what they leave it at is
 * remembered. Their limits are above, and the conversation's floor is one of
 * them — a rail cannot be widened into the column it exists to annotate. A
 * shrinking window refits the same way without writing the squeeze over the
 * preference, so the remembered widths come back when there is room again.
 *
 * The columns are told apart by tint and never by a rule: both rails sit on
 * `canvasSubtle`, one step behind the conversation's `canvas`. That is the
 * borderless rule applied to the layout rather than to a control, and it is why
 * the only line in this file is the one a pointer holds.
 *
 * The right column is activity only. Sessions and settings temporarily take
 * over the workspace in modal surfaces instead of replacing its context. Under
 * 1200px activity folds off-canvas; under 960px the file rail follows. The
 * composer never collapses — it is the only column you cannot work without.
 */
export const Workbench = ({ theme, onTheme, disclosure, onDisclosure }: { theme: ThemeChoice; onTheme: (theme: ThemeChoice) => void; disclosure: StepDisclosure; onDisclosure: (disclosure: StepDisclosure) => void }): React.JSX.Element => {
  const state = useReadableView(store.views.workbench)
  // The tokens are the 1440px defaults and `localStorage` is the memory of a
  // person having disagreed with them. Read the tokens once; an untouched rail
  // scales from those values with the window, while a remembered number stays
  // exact and does not fight the drag.
  const defaults = useRef({ files: 0, activity: 0 })
  if (defaults.current.files === 0) {
    defaults.current = { files: tokenPixels(size.railFiles), activity: tokenPixels(size.railActivity) }
  }
  const [filesWidth, setFilesWidth] = useState<number | undefined>(() => rememberedNumberIfSet("rail.files", RAIL_FILES.min, RAIL_FILES.max))
  const [activityWidth, setActivityWidth] = useState<number | undefined>(() => rememberedNumberIfSet("rail.activity", RAIL_ACTIVITY.min, RAIL_ACTIVITY.max))
  const [filesOpen, setFilesOpen] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("providers")
  const [followRequest, setFollowRequest] = useState(0)
  const [fileDragging, setFileDragging] = useState(false)
  const innerWidth = useWindowWidth()
  const active = state.activeSessionId === undefined ? undefined : state.sessions[state.activeSessionId]
  const projection = state.activeSessionId === undefined ? undefined : store.views.session(state.activeSessionId)
  const activeQuestion = state.extensionRequest?.sessionId === state.activeSessionId
    ? state.extensionRequest
    : undefined
  /*
    Nothing has been said in this session and nothing is on its way.

    Stated here rather than inside the timeline because it decides where the
    *composer* sits, and the composer is this column's sibling of the timeline
    rather than its child. The condition is `EmptyTimeline`'s own, in the terms
    the workbench view already carries: a message count, and the two statuses
    that mean a turn is running with nothing shown for it yet. It costs no
    subscription — `core` publishes when the count changes, which is the same
    moment the layout has to stop resting.
  */
  const resting = active !== undefined
    && active.snapshot.messageCount === 0
    && active.snapshot.status !== "streaming"
    && active.snapshot.status !== "compacting"
  const workspace = state.workspace!
  const preferredWidths = preferredRailWidths(innerWidth, defaults.current)
  const filesWant = filesWidth ?? preferredWidths.files
  const activityWant = activityWidth ?? preferredWidths.activity
  // Fitting is display-only: a squeeze does not write the remembered widths,
  // so widening the window restores what the person asked.
  const layout = fitColumns(filesWant, activityWant, innerWidth)
  const filesDisplay = layout.files
  const rightDisplay = layout.activity
  // Before a session exists, activity has nothing to project. Reserving its
  // track anyway leaves a blank strip beside the start screen, so the track
  // collapses until a session can fill it.
  const rightOccupied = projection !== undefined
  const rightTrack = rightOccupied ? rightDisplay : 0
  const otherForFiles = layout.activityInGrid ? rightDisplay : 0
  const otherForActivity = layout.filesInGrid ? filesDisplay : 0

  const newSession = (): void => {
    void store.createSession().catch((error: unknown) => store.capture(error))
  }

  // Named once so the tab strip, command palette, and keybindings all open the
  // same surfaces rather than carrying three readings of the interaction.
  const toggleFilesRail = (): void => setFilesOpen((open) => !open)
  const toggleActivityRail = (): void => setActivityOpen((open) => !open)
  const openSessionsModal = (): void => {
    setSettingsOpen(false)
    setSessionsOpen(true)
  }
  // One opener, because the rule that settings and sessions never share the
  // screen belongs to opening settings rather than to each entry point into
  // it. The entries stay zero-argument: both are handlers, and a handler that
  // took a section would be handed a DOM event as one.
  const openSettings = (section: SettingsSection): void => {
    setSessionsOpen(false)
    setSettingsSection(section)
    setSettingsOpen(true)
  }
  const openSettingsModal = (): void => openSettings("providers")
  const showResources = (): void => openSettings("resources")

  /*
    The workbench's keybindings. The context is a ref rather than a state
    value: the listener binds once and reads the latest context through it, so
    a streaming session re-rendering on every event does not re-bind the
    window's keydown on every render. The registry and its non-conflict rules
    live in `keybindings.ts`.
  */
  const [paletteOpen, setPaletteOpen] = useState(false)
  const commandContext = useRef<CommandContext | undefined>(undefined)
  const context: CommandContext = {
    snapshot: active?.snapshot,
    newSession,
    attachFiles: () => void store.chooseAttachments().catch((error: unknown) => store.capture(error)),
    compactSession: () => void store.compactSession().catch((error: unknown) => store.capture(error)),
    toggleFilesRail,
    toggleActivityRail,
    openSessions: openSessionsModal,
    openSettings: openSettingsModal,
    togglePalette: () => setPaletteOpen((open) => !open),
  }
  commandContext.current = context

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      const command = matchCommand(event, WORKBENCH_COMMANDS)
      if (command === undefined) return
      const latest = commandContext.current
      if (latest === undefined || !command.available(latest)) return
      event.preventDefault()
      command.run(latest)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  // Built at the point of use rather than on every render: the palette is shut
  // for almost all of them, and a fresh array each frame would also defeat the
  // palette's own memo on `entries`.
  const paletteEntries = (): PaletteEntry[] =>
    WORKBENCH_COMMANDS.filter((command) => command.available(context)).map((command) => ({
      id: command.id,
      title: command.title,
      group: command.group,
      icon: command.icon,
      keys: command.keys,
      run: () => command.run(context),
    }))

  return (
    <div {...stylex.props(styles.workbench)}>
      <TabStrip
        state={state}
        onNewSession={newSession}
        sessionsOpen={sessionsOpen}
        settingsOpen={settingsOpen}
        onToggleSessions={openSessionsModal}
        onToggleSettings={openSettingsModal}
        onShowResources={showResources}
        onToggleFiles={toggleFilesRail}
        onToggleActivity={toggleActivityRail}
        onOpenPalette={() => setPaletteOpen(true)}
      />

      <div {...stylex.props(styles.columns(filesDisplay, rightTrack))}>
        <div {...stylex.props(styles.filesColumn(filesDisplay), filesOpen && styles.railOpenStart)}>
          <FileRail
            workspaceRoot={workspace.root}
            isGitRepository={workspace.isGitRepository}
            dragFiles={active !== undefined && !state.sessionStarting}
            onFileDragging={setFileDragging}
            {...(filesOpen ? { onClose: () => setFilesOpen(false) } : {})}
          />
          <RailHandle
            label="Resize files"
            edge="start"
            width={filesDisplay}
            limits={RAIL_FILES}
            onResize={(want) => {
              const next = fitRail(want, RAIL_FILES, otherForFiles, innerWidth)
              setFilesWidth(next)
              return next
            }}
            onReset={() => {
              setFilesWidth(undefined)
              forget("rail.files")
            }}
            onCommit={(width) => remember("rail.files", Math.round(width))}
          />
        </div>

        <main id="main-content" tabIndex={-1} {...stylex.props(styles.main)}>
          {active !== undefined && projection !== undefined ? (
            <div {...stylex.props(styles.conversation, styles.conversationEnter, resting && styles.conversationResting)}>
              <ProjectedTimeline projection={projection} followRequest={followRequest} status={active.snapshot.status} aborting={state.abortingSessionId === state.activeSessionId} resting={resting} />
              <QuestionTray key={activeQuestion?.id} request={activeQuestion} />
              <ProjectedApprovals projection={projection} />
              <Composer
                snapshot={active.snapshot}
                aborting={state.abortingSessionId === state.activeSessionId}
                resting={resting}
                models={state.models}
                providers={state.providers}
                attachments={state.attachments}
                workspace={workspace}
                onFileDrop={() => {
                  setFileDragging(false)
                  setFilesOpen(false)
                }}
                onPromptSubmit={() => setFollowRequest((request) => request + 1)}
              />
            </div>
          ) : (
            /*
              The start surface and the loading surface are one. A second
              session starting keeps the live conversation on screen — the tab
              strip already carries the pending tab, and emptying the column
              would hide a session that still exists. With no session at all,
              the click's answer happens where the click did.
            */
            <div {...stylex.props(styles.conversation)}>
              <StartSession starting={state.sessionStarting} onStart={newSession} />
              {state.sessionStarting ? <QuestionTray key={state.extensionRequest?.id} request={state.extensionRequest} /> : null}
            </div>
          )}
        </main>

        <div {...stylex.props(styles.activityColumn(rightDisplay), activityOpen && styles.railOpenEnd)}>
          {projection === undefined ? null : (
            <ProjectedActivity projection={projection} {...(activityOpen ? { onClose: () => setActivityOpen(false) } : {})} />
          )}
          {rightOccupied ? (
            <RailHandle
              label="Resize activity"
              edge="end"
              width={rightDisplay}
              limits={RAIL_ACTIVITY}
              onResize={(want) => {
                const next = fitRail(want, RAIL_ACTIVITY, otherForActivity, innerWidth)
                setActivityWidth(next)
                return next
              }}
              onReset={() => {
                setActivityWidth(undefined)
                forget("rail.activity")
              }}
              onCommit={(width) => remember("rail.activity", Math.round(width))}
            />
          ) : null}
        </div>
      </div>

      {/*
        One scrim per rail rather than one shared: each is scoped to the width
        where its own rail is off-canvas, and those two widths are different.
        Both stay mounted so they can fade out with the rail they belong to.
      */}
      <div aria-hidden="true" onClick={() => setFilesOpen(false)} {...stylex.props(styles.railScrim, styles.railScrimStart, filesOpen && styles.railScrimOpen, fileDragging && styles.railScrimPassThrough)} />
      <div
        aria-hidden="true"
        onClick={() => setActivityOpen(false)}
        {...stylex.props(styles.railScrim, styles.railScrimEnd, activityOpen && styles.railScrimOpen)}
      />

      <NoticeStack notices={state.notices} />
      {sessionsOpen ? <SessionsModal state={state} onClose={() => setSessionsOpen(false)} /> : null}
      {settingsOpen ? (
        <SettingsModal
          providers={state.providers}
          models={state.models}
          resources={state.resources}
          extensionErrors={state.extensionErrors}
          piUpdate={state.connection.status === "connected" && state.connection.latestPiVersion !== undefined
            ? { currentVersion: state.connection.piVersion, latestVersion: state.connection.latestPiVersion }
            : undefined}
          section={settingsSection}
          onSection={setSettingsSection}
          workspaceTrust={workspace.trust}
          theme={theme}
          onTheme={onTheme}
          disclosure={disclosure}
          onDisclosure={onDisclosure}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
      {paletteOpen ? <CommandPalette entries={paletteEntries()} onClose={() => setPaletteOpen(false)} /> : null}
    </div>
  )
}

const ProjectedTimeline = ({ projection, followRequest, status, aborting, resting }: { projection: SessionProjection; followRequest: number; status: SessionStatus; aborting: boolean; resting: boolean }): React.JSX.Element => {
  const timeline = useReadableView(projection.view("timeline"))
  /*
    Keyed by session, so a switch gets a fresh virtualizer rather than the
    previous session's scroll offset and measurement cache applied to rows that
    have neither. Switching from a long session scrolled deep into its history
    to a short one rendered an empty window for a frame — the old offset was
    past the new session's whole height — before the layout effect pinned it to
    the end. A new instance starts at its own estimated tail, then measures
    and pins without first mounting the head's Markdown and tool listings.
  */
  return <Timeline key={timeline.sessionId} timeline={timeline} followRequest={followRequest} status={status} aborting={aborting} resting={resting} />
}

const ProjectedApprovals = ({ projection }: { projection: SessionProjection }): React.JSX.Element | null => {
  const approvals = useReadableView(projection.view("approvals"))
  return <ApprovalTray approvals={approvals} />
}

/**
 * Two views, one rail. They stay separate views because they change on
 * different events — a tool call republishes activity, a todo result
 * republishes the plan — and subscribing to both here is what draws them in
 * one column without merging the two publications.
 */
const ProjectedActivity = ({ projection, onClose }: { projection: SessionProjection; onClose?: () => void }): React.JSX.Element => {
  const activity = useReadableView(projection.view("activity"))
  const todo = useReadableView(projection.view("todo"))
  return <ActivityRail activity={activity} todo={todo} {...(onClose === undefined ? {} : { onClose })} />
}

/**
 * The seam between a rail and the conversation, made draggable.
 *
 * A `separator` with a value rather than a bare `div`, because that is what it
 * is: the ARIA role carries the width, its bounds, and its orientation, so the
 * arrow keys below are the same control a pointer drags rather than a keyboard
 * consolation prize. Home and End take it to its limits; a double-click puts it
 * back on its responsive default.
 *
 * Pointer capture is what makes the drag survive leaving the handle — an eight
 * pixel target that stopped tracking the moment the pointer outran it would be
 * unusable, and capture is also why the move and up handlers can be props on
 * this element rather than listeners on the window.
 *
 * The rail is a column only above its breakpoint; below it the rail is an
 * overlay at its last fitted width, so the handle is not drawn there. Resizing something
 * that is already covering the conversation would be resizing the wrong thing.
 */
const RailHandle = ({
  label,
  edge,
  width,
  limits,
  onResize,
  onReset,
  onCommit,
}: {
  label: string
  edge: "start" | "end"
  width: number
  limits: { min: number; max: number }
  onResize: (want: number) => number
  onReset: () => void
  onCommit: (width: number) => void
}): React.JSX.Element => {
  const from = useRef<{ x: number; width: number } | undefined>(undefined)
  /*
   * The width the layout actually took, which is not the width this handle
   * asked for: the parent clamps against the other rail and the conversation's
   * floor. It is a ref rather than the `width` prop because the last move and
   * the release arrive in the same frame — React has not re-rendered in
   * between, so committing the prop persisted a width one drag-step stale.
   * `onResize` returns what it applied, and this remembers it.
   */
  const applied = useRef(width)
  // Which way the pointer has to travel to make this rail wider. The files rail
  // grows to the right and the activity rail grows to the left, and both the
  // drag and the arrow keys owe their sign to this one number.
  const grows = edge === "start" ? 1 : -1

  const nudge = (steps: number): void => {
    applied.current = onResize(Math.min(limits.max, Math.max(limits.min, width + steps)))
    onCommit(applied.current)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      tabIndex={0}
      onPointerDown={(event) => {
        // Prevents the drag from starting a text selection in the rail behind
        // it, which is what makes a slow drag select a column of file names.
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        from.current = { x: event.clientX, width }
        applied.current = width
      }}
      onPointerMove={(event) => {
        const start = from.current
        if (start === undefined) return
        applied.current = onResize(start.width + (event.clientX - start.x) * grows)
      }}
      onPointerUp={(event) => {
        const start = from.current
        if (start === undefined) return
        from.current = undefined
        event.currentTarget.releasePointerCapture(event.pointerId)
        // A click that did not move must not persist the display width over
        // the remembered one: after a squeeze the handle shows a fitted
        // value, and writing that on pointer-up would forget the preference
        // the next widening is supposed to restore.
        if (applied.current !== start.width) onCommit(applied.current)
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") nudge(-16 * grows)
        else if (event.key === "ArrowRight") nudge(16 * grows)
        else if (event.key === "Home") nudge(limits.min - width)
        else if (event.key === "End") nudge(limits.max - width)
        else return
        event.preventDefault()
      }}
      onDoubleClick={onReset}
      {...stylex.props(styles.handle, edge === "start" ? styles.handleStart : styles.handleEnd)}
    />
  )
}

/**
 * The workspace is open and nothing is in it yet.
 *
 * It shares the conversation's measure and centres one compact group in the
 * available pane. Safe centring lets a short window fall back to normal flow
 * and scroll instead of clipping the title or its only action.
 *
 * The same surface is the loading surface. The button that started the session
 * becomes the busy seat — disabled, ring spinning, label honest — and a status
 * line names what is being waited on, so the click's answer happens where the
 * click did. The interoperability note rides beside the button rather than
 * below it: the status line's arrival must not push anything down.
 */
const StartSession = ({ starting, onStart }: { starting: boolean; onStart: () => void }): React.JSX.Element => (
  <section {...stylex.props(scrollbars.thin, styles.start, styles.startEnter)}>
    <h2 {...stylex.props(styles.startTitle)}>No session open</h2>
    <p {...stylex.props(styles.startBody)}>Start one to begin. It becomes a Pi session on disk — the same history, tools and compaction the CLI would give it.</p>
    <div {...stylex.props(styles.startActions)}>
      <button type="button" onClick={onStart} disabled={starting} aria-busy={starting} {...stylex.props(focus.control, styles.primary)}>
        {starting ? <span aria-hidden="true" {...stylex.props(spinners.running)} /> : null}
        {starting ? "Starting…" : "Start a session"}
      </button>
      <span {...stylex.props(styles.startFeature)}><TerminalSquare size={14} aria-hidden="true" /> Works with Pi CLI</span>
    </div>
    {starting ? <p role="status" {...stylex.props(styles.startStatus)}>Starting the Pi agent…</p> : null}
  </section>
)

const NoticeStack = ({ notices }: { notices: AppState["notices"] }): React.JSX.Element | null => notices.length === 0 ? null : <div aria-live="assertive" {...stylex.props(styles.notices)}>{notices.map((notice, index) => <div key={`${notice.code}-${index}`} role="alert" {...stylex.props(styles.notice)}><span aria-hidden="true" {...stylex.props(styles.noticeIcon)}><AlertTriangle size={18} /></span><div {...stylex.props(styles.noticeBody)}><strong {...stylex.props(styles.noticeTitle)}>{errorTitle(notice.code)}</strong><p {...stylex.props(styles.noticeText)}>{errorBody(notice.code, notice.detail)}</p></div><button type="button" onClick={() => store.dismissNotice(index)} aria-label="Dismiss error" {...stylex.props(focus.control, styles.smallIcon)}><X size={15} /></button></div>)}</div>

/**
 * How a surface arrives: a short rise while it fades in, reduced to the fade
 * alone under reduced motion — the same split the modal makes between its
 * scale-in and the scrim's. The start screen takes the slow duration because
 * it is the workspace's first impression; the conversation takes the quicker
 * one because it is the answer to a wait, and answers should feel immediate.
 */
/**
 * Declared here rather than shared from the theme because StyleX cannot import
 * keyframes across modules — only a `.stylex.ts` file may export them, and even
 * then the compiler will not resolve the imported name into `animationName`.
 * The duplication is the compiler's, not a choice.
 */
const enterFade = stylex.keyframes({ from: { opacity: 0 } })

const enterRise = stylex.keyframes({ from: { opacity: 0, transform: "translateY(4px)" } })

const styles = stylex.create({
  workbench: { position: "fixed", inset: 0, display: "flex", flexDirection: "column", color: colors.text, backgroundColor: colors.canvas, fontFamily: typography.ui, fontSize: typography.body },
  /**
   * Rail, fluid, rail. Both rail widths are bounded because both hold content
   * with a natural width; the middle track is `minmax(0, 1fr)` rather than
   * `1fr` so a long unbroken line in the conversation cannot push the grid
   * wider than the window.
   */
  /**
   * The two rail widths are now the person's, so the template is computed
   * rather than declared — a dynamic style, which reaches the page as a custom
   * property set through CSSOM. That is the one way a runtime number can get
   * into a rule here: the CSP refuses `style-src 'unsafe-inline'`, which blocks
   * a `style` attribute the parser creates and not a property React sets.
   *
   * The tokens are still where the responsive widths start, read once at mount. Below each
   * breakpoint the rail leaves the grid entirely and the width it would have
   * had stops being part of this.
   */
  columns: (files: number, activity: number) => ({
    flex: 1,
    minHeight: 0,
    display: "grid",
    gridTemplateColumns: {
      default: `${String(files)}px minmax(0, 1fr) ${String(activity)}px`,
      "@media (max-width: 1200px)": `${String(files)}px minmax(0, 1fr)`,
      "@media (max-width: 960px)": "minmax(0, 1fr)",
    },
  }),
  /**
   * Eight pixels wide, straddling the seam, with only its centred two pixels
   * painted when it is wanted. The wider transparent area keeps the splitter
   * easy to catch without turning hover into a heavy bar.
   *
   * `col-resize` is the whole affordance at rest — the pointer changing shape
   * over the seam is how a person finds a splitter, and it costs the layout
   * nothing. Under the pointer a quiet line appears; while held or focused it
   * brightens enough to identify the active separator.
   */
  handle: {
    position: "absolute",
    insetBlockStart: 0,
    insetBlockEnd: 0,
    zIndex: 4,
    width: "8px",
    boxSizing: "border-box",
    display: "grid",
    placeItems: "center",
    paddingInline: "3px",
    cursor: "col-resize",
    touchAction: "none",
    backgroundColor: { default: "transparent", ":hover": colors.borderStrong, ":active": colors.accent, ":focus-visible": colors.focus },
    backgroundClip: "content-box",
    transitionProperty: "background-color",
    transitionDuration: motion.fast,
    transitionTimingFunction: motion.settle,
    outline: "none",
  },
  handleStart: { insetInlineEnd: "-4px", display: { default: "grid", "@media (max-width: 960px)": "none" } },
  handleEnd: { insetInlineStart: "-4px", display: { default: "grid", "@media (max-width: 1200px)": "none" } },

  /**
   * A rail is a column above its breakpoint and a panel off the edge below it,
   * and the breakpoint decides which — never the toggle.
   *
   * The toggle used to carry the whole `position: fixed` block, which meant the
   * flag was doing two jobs: saying the rail was wanted, and saying how it
   * should be laid out. It also meant a folded rail was `display: none`, and
   * `display` is the one property that cannot be moved — a rail that appears
   * has to appear *somewhere*, so it appeared instantly, at full size, over the
   * conversation.
   *
   * Now the media query alone lifts the rail out of the grid and parks it past
   * the window edge, and the toggle only slides it back. That is what makes the
   * motion below possible, and it is also why the flag surviving a widened
   * window is harmless: every off-canvas declaration is scoped to the width
   * where the rail is off-canvas, so above it the rail is a grid column again
   * and the leftover flag has nothing to act on.
   *
   * `visibility` rather than `display`, and it is what does the hiding.
   *
   * It buys what `display: none` bought — out of the tab order, out of the
   * accessibility tree, no hit target — and it is the one hiding property CSS
   * interpolates *asymmetrically*: any moment between the two endpoints counts
   * as `visible`, so the rail is on screen for the whole of its slide out and
   * gone the instant it lands. No delay to declare, and nothing to unwind if
   * the toggle is hit again mid-slide.
   */
  filesColumn: (width: number) => ({
    minHeight: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr)",
    containerType: "inline-size",
    position: { default: "relative", "@media (max-width: 960px)": "fixed" },
    insetBlockStart: { default: null, "@media (max-width: 960px)": size.tabStrip },
    insetBlockEnd: { default: null, "@media (max-width: 960px)": 0 },
    insetInlineStart: { default: null, "@media (max-width: 960px)": 0 },
    zIndex: { default: null, "@media (max-width: 960px)": 20 },
    width: { default: null, "@media (max-width: 960px)": `min(${String(width)}px, calc(100vw - 48px))` },
    boxShadow: { default: null, "@media (max-width: 960px)": effects.liftOverlay },
    transform: { default: null, "@media (max-width: 960px)": "translateX(-100%)" },
    visibility: { default: "visible", "@media (max-width: 960px)": "hidden" },
    transitionProperty: "transform, visibility",
    transitionDuration: motion.moderateExit,
    transitionTimingFunction: motion.settle,
  }),
  activityColumn: (width: number) => ({
    minHeight: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr)",
    containerType: "inline-size",
    position: { default: "relative", "@media (max-width: 1200px)": "fixed" },
    insetBlockStart: { default: null, "@media (max-width: 1200px)": size.tabStrip },
    insetBlockEnd: { default: null, "@media (max-width: 1200px)": 0 },
    insetInlineEnd: { default: null, "@media (max-width: 1200px)": 0 },
    zIndex: { default: null, "@media (max-width: 1200px)": 20 },
    width: { default: null, "@media (max-width: 1200px)": `min(${String(width)}px, calc(100vw - 48px))` },
    boxShadow: { default: null, "@media (max-width: 1200px)": effects.liftOverlay },
    transform: { default: null, "@media (max-width: 1200px)": "translateX(100%)" },
    visibility: { default: "visible", "@media (max-width: 1200px)": "hidden" },
    transitionProperty: "transform, visibility",
    transitionDuration: motion.moderateExit,
    transitionTimingFunction: motion.settle,
  }),
  /**
   * Arriving is slower than leaving, which is the motion scale's one rule: a
   * thing arriving wants to be noticed and a thing leaving wants to be gone.
   * Both durations collapse to a millisecond under `prefers-reduced-motion` at
   * the token, so nothing here has to ask.
   */
  /*
    Both keys are restated, and they have to be.
    StyleX resolves a conflict between two namespaces per property *and per
    condition*: a plain `visibility: "visible"` here would collide with the
    `default` branch above and leave the `@media` branch standing — and a
    media-scoped declaration is emitted after an unscoped one, so the rail
    would stay hidden at exactly the widths this style exists for.
  */
  railOpenStart: {
    transform: { default: null, "@media (max-width: 960px)": "translateX(0)" },
    visibility: { default: "visible", "@media (max-width: 960px)": "visible" },
    transitionDuration: motion.moderate,
  },
  railOpenEnd: {
    transform: { default: null, "@media (max-width: 1200px)": "translateX(0)" },
    visibility: { default: "visible", "@media (max-width: 1200px)": "visible" },
    transitionDuration: motion.moderate,
  },

  /**
   * The scrim an off-canvas rail opens over, which it did not have.
   *
   * A rail folded to the edge blocks part of the workspace — without a scrim,
   * the conversation
   * underneath stayed clickable behind a panel covering it, and the only way
   * out was the toggle it was launched from.
   *
   * It starts below the tab strip rather than at the top of the window so the
   * toggle that opened the rail is never the thing the scrim covers.
   */
  railScrim: {
    position: "fixed", insetBlockStart: size.tabStrip, insetBlockEnd: 0, insetInline: 0, zIndex: 19,
    backgroundColor: effects.scrim,
    opacity: 0, visibility: "hidden",
    transitionProperty: "opacity, visibility",
    transitionDuration: motion.moderateExit,
    transitionTimingFunction: motion.settle,
  },
  railScrimStart: { display: { default: "none", "@media (max-width: 960px)": "block" } },
  railScrimEnd: { display: { default: "none", "@media (max-width: 1200px)": "block" } },
  railScrimOpen: { opacity: 1, visibility: "visible", transitionDuration: motion.moderate },
  railScrimPassThrough: { pointerEvents: "none" },

  main: { minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", backgroundColor: colors.canvas, outline: "none" },
  conversation: { position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" },
  /**
   * Before the first prompt, the greeting and the composer are one group in
   * the middle of the column rather than a blank page over a field pinned to
   * the floor. `safe center` so a short window overflows downward from the top
   * edge instead of clipping the composer past it, which is the one element
   * this pane cannot be used without.
   */
  conversationResting: { justifyContent: "safe center" },
  /** Plays once, when the first session's pane mounts; switching sessions does not remount it. */
  conversationEnter: { animationName: { default: enterRise, "@media (prefers-reduced-motion: reduce)": enterFade }, animationDuration: { default: motion.moderate, "@media (prefers-reduced-motion: reduce)": motion.accessibleFade }, animationTimingFunction: motion.settle },

  start: { flex: 1, minHeight: 0, width: "100%", maxWidth: size.column, boxSizing: "border-box", overflowY: "auto", overflowX: "hidden", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "safe center", marginInline: "auto", paddingBlock: space.xl, paddingInline: size.columnInset, textAlign: "center" },
  startEnter: { animationName: { default: enterRise, "@media (prefers-reduced-motion: reduce)": enterFade }, animationDuration: { default: motion.slow, "@media (prefers-reduced-motion: reduce)": motion.accessibleFade }, animationTimingFunction: motion.settle },
  startTitle: { marginBlock: 0, fontFamily: typography.display, fontSize: typography.title, lineHeight: typography.titleLine, fontWeight: 500 },
  startBody: { maxWidth: "48ch", marginBlockStart: space.sm, marginBlockEnd: space.xl, color: colors.textMuted, lineHeight: typography.bodyLine },
  startActions: { display: "flex", alignItems: "center", justifyContent: "center", flexWrap: "wrap", gap: space.md },
  /** The one line that exists only while the host answers — it fades, it does not travel. */
  startStatus: { marginBlock: 0, marginBlockStart: space.md, color: colors.textMuted, fontSize: typography.caption, lineHeight: typography.captionLine, animationName: enterFade, animationDuration: { default: motion.moderate, "@media (prefers-reduced-motion: reduce)": motion.accessibleFade }, animationTimingFunction: motion.settle },
  startFeature: { display: "inline-flex", alignItems: "center", gap: space.xs, color: colors.textMuted, fontSize: typography.caption, lineHeight: typography.captionLine, fontWeight: 500 },
  primary: { minHeight: size.control, display: "inline-flex", alignItems: "center", gap: space.sm, paddingInline: space.lg, color: colors.accentOn, backgroundColor: { default: colors.accent, ":hover": colors.accentHover }, borderWidth: 0, borderRadius: radius.md, cursor: { default: "pointer", ":disabled": "not-allowed" }, opacity: { default: 1, ":disabled": 0.5 }, fontWeight: 700 },
  /**
   * Hover is `accentSoft` rather than `surfaceOverlay`. Every surface this
   * button appears on — a modal header, an error toast — *is* `surfaceOverlay`,
   * so hovering to it was hovering to nothing.
   */
  smallIcon: { width: size.controlDense, height: size.controlDense, display: "grid", placeItems: "center", padding: 0, color: { default: colors.textMuted, ":hover": colors.text }, backgroundColor: { default: "transparent", ":hover": colors.accentSoft }, borderWidth: 0, borderRadius: radius.sm, cursor: "pointer" },
  notices: { position: "fixed", insetInlineEnd: space.xl, insetBlockEnd: space.xl, zIndex: 60, width: "min(420px, calc(100vw - 48px))", display: "flex", flexDirection: "column", gap: space.sm },
  /**
   * The last drawn line in the interface, retired.
   *
   * A toast carried a 4px `danger` bar down its leading edge — the one rule
   * that survived the move to elevation, and the only place a colour worked as
   * a stripe rather than as a fill. The icon does that job now: same colour,
   * and it sits where the eye lands first anyway.
   */
  notice: { display: "flex", alignItems: "flex-start", gap: space.md, padding: space.lg, color: colors.text, backgroundColor: colors.surfaceOverlay, borderRadius: radius.lg, boxShadow: effects.liftOverlay },
  noticeIcon: { flex: "none", width: size.control, height: size.control, display: "grid", placeItems: "center", color: colors.danger, backgroundColor: colors.dangerSoft, borderRadius: radius.md },
  noticeBody: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: space.xs },
  noticeTitle: { fontWeight: 600 },
  noticeText: { margin: 0, color: colors.textMuted, fontSize: typography.caption, lineHeight: typography.captionLine },
})
