import { useEffect, useState } from "react"
import * as stylex from "@stylexjs/stylex"
import { ArrowRightIcon, ClockIcon, CommandLineIcon, FolderOpenIcon } from "@heroicons/react/24/outline"
import type { CommandResult, Workspace, WorkspaceLocation } from "@bake-pi/contract"
import { store } from "../../store/session-store.ts"
import { colors, motion, radius, space, typography } from "../../theme/tokens.stylex.ts"
import { focus } from "../../theme/focus.ts"
import { shimmer } from "../../theme/shimmer.ts"
import { size } from "../../theme/sizes.stylex.ts"
import { spinners } from "../../theme/spinners.ts"
import { Modal, overlay } from "./Overlay.tsx"
import { SelectControl } from "./SelectControl.tsx"

type Locations = CommandResult<"list_workspace_locations">

/**
 * The one thing in flight, named rather than counted.
 *
 * A boolean was enough to disable every control and not enough to say which
 * one a person is waiting on, and this panel has up to a dozen ways to start
 * the same wait. `key` is the control that owns the spinner — a location id, or
 * `browse`, or `create` — and `label` is what the live region says while it
 * turns.
 */
interface Pending {
  key: string
  label: string
  /**
   * A WSL open is the slow one, and it is slow for a reason worth stating.
   * Opening the first workspace in a distribution probes for Node, stages the
   * agent host and installs Pi inside Linux; that is a minute the person should
   * be told about rather than left to guess at.
   */
  wsl: boolean
}

/**
 * Every way to arrive at a workspace, in one panel.
 *
 * The lists come from main and hold ids, not paths: a row reopens a recent
 * root, or starts the native picker inside a WSL home, by naming the id main
 * minted. The create form does the same with its parent. The renderer never
 * composes a path, which is the invariant `guard.ts` exists to keep.
 *
 * Under the two columns is a single footer that is a status line, an error, or
 * the WSL note — never two of them and never nothing. It reserves its height,
 * because a message that appears by pushing the panel taller moves the row a
 * person was about to click.
 */
export const WorkspaceDialog = ({ onClose, onOpened }: { onClose: () => void; onOpened: (workspace: Workspace) => void }): React.JSX.Element => {
  const [locations, setLocations] = useState<Locations | undefined>()
  const [pending, setPending] = useState<Pending | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [name, setName] = useState("")
  const [parent, setParent] = useState("")
  const [initializeGit, setInitializeGit] = useState(true)

  useEffect(() => {
    let live = true
    store.send("list_workspace_locations", {}).then((listing) => {
      if (!live) return
      setLocations(listing)
      setParent((current) => (current === "" ? listing.parents[0]?.id ?? "" : current))
    }).catch((cause) => { store.capture(cause); if (live) setLocations({ recent: [], wsl: [], parents: [] }) })
    return () => { live = false }
  }, [])

  const busy = pending !== undefined

  const attempt = async (started: Pending, open: () => Promise<Workspace | undefined>, failure: string): Promise<void> => {
    setPending(started)
    setError(undefined)
    try {
      const workspace = await open()
      if (workspace !== undefined) onOpened(workspace)
    } catch (cause) {
      store.capture(cause)
      setError(failure)
    } finally {
      setPending(undefined)
    }
  }

  const loading = locations === undefined
  const parents = locations?.parents ?? []
  const canCreate = name.trim().length > 0 && parent !== "" && !busy

  return (
    <Modal
      eyebrow="Workspace"
      title="Choose a workspace"
      subtitle="Open an existing project or create a new folder in a known location."
      onClose={onClose}
      closeLabel="Close workspace chooser"
      medium
    >
      <button
        data-autofocus
        type="button"
        disabled={busy}
        aria-busy={pending?.key === "browse"}
        onClick={() => void attempt(
          { key: "browse", label: "Waiting for the folder you choose…", wsl: false },
          () => store.chooseWorkspace(),
          "The folder could not be opened. Try choosing it again.",
        )}
        {...stylex.props(focus.ring, styles.browse, pending?.key === "browse" && styles.working)}
      >
        <span aria-hidden="true" {...stylex.props(styles.browseIcon)}>
          {pending?.key === "browse"
            ? <span {...stylex.props(spinners.running)} />
            : <FolderOpenIcon width={18} height={18} />}
        </span>
        <span {...stylex.props(styles.browseCopy)}>
          <strong {...stylex.props(styles.browseTitle)}>Browse this computer</strong>
          <span {...stylex.props(styles.browseHint)}>Choose any existing project folder</span>
        </span>
        <ArrowRightIcon aria-hidden="true" {...stylex.props(styles.arrow)} />
      </button>

      <div {...stylex.props(styles.columns)}>
        <div {...stylex.props(styles.sections)}>
          <Section label="Recent" empty={loading ? "Loading…" : "Nothing opened yet."} loading={loading} items={locations?.recent ?? []}>
            {(item) => (
              <Row
                item={item}
                action="Open"
                working="Opening"
                icon={<ClockIcon width={15} height={15} />}
                disabled={busy}
                pending={pending?.key === item.id}
                onClick={() => void attempt(
                  { key: item.id, label: `Opening ${item.displayName}…`, wsl: item.runtime.kind === "wsl" },
                  () => store.reopenRecentWorkspace(item.id),
                  "That recent project is no longer available. Choose its folder again to continue.",
                )}
              />
            )}
          </Section>

          <Section label="WSL" empty={loading ? "Loading…" : "No WSL distributions found."} loading={loading} items={locations?.wsl ?? []}>
            {(item) => (
              <Row
                item={item}
                action="Browse"
                working="Preparing"
                icon={<CommandLineIcon width={15} height={15} />}
                disabled={busy}
                pending={pending?.key === item.id}
                onClick={() => void attempt(
                  { key: item.id, label: `Preparing ${item.displayName}…`, wsl: true },
                  () => store.chooseWorkspace(item.id),
                  "The folder could not be opened. Try choosing it again.",
                )}
              />
            )}
          </Section>
        </div>

        <section {...stylex.props(styles.createPanel)}>
          <h3 {...stylex.props(overlay.groupLabel)}>Create new</h3>
          <p {...stylex.props(styles.createHint)}>Start with an empty project folder.</p>
          <label {...stylex.props(styles.fieldGroup)}>
            <span {...stylex.props(overlay.fieldLabel)}>Name</span>
            <input value={name} disabled={busy} placeholder="my-project" spellCheck={false} onChange={(event) => setName(event.currentTarget.value)} {...stylex.props(focus.ring, overlay.field)} />
          </label>
          <label {...stylex.props(styles.fieldGroup)}>
            <span {...stylex.props(overlay.fieldLabel)}>Location</span>
            <SelectControl
              value={parent}
              disabled={busy || parents.length === 0}
              onChange={setParent}
              options={parents.length === 0 ? [{ value: "", label: "Open a folder once to offer its location here" }] : parents.map((location) => ({ value: location.id, label: location.root }))}
            />
          </label>
          <label {...stylex.props(styles.check)}>
            <input type="checkbox" checked={initializeGit} disabled={busy} onChange={(event) => setInitializeGit(event.currentTarget.checked)} {...stylex.props(focus.ring, styles.checkbox)} />
            Initialize a git repository
          </label>
          <button
            type="button"
            disabled={!canCreate}
            aria-busy={pending?.key === "create"}
            onClick={() => void attempt(
              {
                key: "create",
                label: `Creating ${name.trim()}…`,
                wsl: parents.find((location) => location.id === parent)?.runtime.kind === "wsl",
              },
              () => store.createWorkspace({ parent, name: name.trim(), initializeGit }),
              "The workspace could not be created. Check the name and that no folder with it exists.",
            )}
            {...stylex.props(focus.ring, overlay.action, overlay.actionPrimary, styles.createAction, pending?.key === "create" && styles.working)}
          >
            {pending?.key === "create" ? <span aria-hidden="true" {...stylex.props(spinners.running)} /> : null}
            {pending?.key === "create" ? "Creating…" : "Create and open"}
          </button>
        </section>
      </div>

      <Footer pending={pending} error={error} hasWsl={(locations?.wsl.length ?? 0) > 0} />
    </Modal>
  )
}

/**
 * One slot under the panel, holding whichever of three things is true.
 *
 * The status is a live region rather than a caption: a WSL open can run for a
 * minute behind a modal that otherwise looks frozen, and someone who is not
 * watching the spinner still has to be told the wait started and ended. The
 * error takes the same slot with `role="alert"`, which announces immediately,
 * because a failure is not something to catch up on later.
 *
 * The spinner and the shimmer are the interface's existing two ways of saying
 * "still working" — the ring proves the process is alive, the swept word says
 * which process. Neither is the only signal: the sentence says it in words.
 */
const Footer = ({ pending, error, hasWsl }: { pending: Pending | undefined; error: string | undefined; hasWsl: boolean }): React.JSX.Element => (
  <div {...stylex.props(styles.footer)}>
    <p role="status" aria-live="polite" {...stylex.props(styles.status)}>
      {pending === undefined ? null : (
        <>
          <span aria-hidden="true" {...stylex.props(spinners.running, styles.statusSpinner)} />
          <span {...stylex.props(shimmer.text)}>{pending.label}</span>
          {pending.wsl ? <span {...stylex.props(styles.statusNote)}>Pi runs inside the distribution. The first workspace there installs it, which can take a minute.</span> : null}
        </>
      )}
    </p>
    {pending !== undefined || error === undefined
      ? null
      : <p role="alert" {...stylex.props(styles.error)}>{error}</p>}
    {pending !== undefined || error !== undefined || !hasWsl
      ? null
      : <p {...stylex.props(styles.note)}>Pi and its tools run inside the selected distribution. Node 22 or newer is required there — Bake Pi offers to install one if it is missing.</p>}
  </div>
)

const Section = ({ label, empty, loading, items, children }: {
  label: string
  empty: string
  loading: boolean
  items: WorkspaceLocation[]
  children: (item: WorkspaceLocation) => React.ReactNode
}): React.JSX.Element => (
  <section {...stylex.props(styles.section)}>
    <h3 {...stylex.props(overlay.groupLabel)}>{label}</h3>
    {items.length === 0
      ? <p aria-busy={loading} {...stylex.props(styles.empty, loading && shimmer.text)}>{empty}</p>
      : <ul {...stylex.props(styles.list)}>{items.map((item) => <li key={item.id}>{children(item)}</li>)}</ul>}
  </section>
)

/**
 * A row is a name, the path that tells it from a namesake, and a verb.
 *
 * The verb changes rather than disappearing while the row works, and the icon
 * becomes the spinner in place — the row keeps its shape, so nothing below it
 * moves at the moment a person's pointer is over it.
 */
const Row = ({ item, action, working, icon, disabled, pending, onClick }: {
  item: WorkspaceLocation
  action: string
  working: string
  icon: React.JSX.Element
  disabled: boolean
  pending: boolean
  onClick: () => void
}): React.JSX.Element => (
  <button type="button" disabled={disabled} aria-busy={pending} onClick={onClick} aria-label={`${action} ${item.root}`} {...stylex.props(focus.ring, styles.row, pending && styles.rowWorking)}>
    <span aria-hidden="true" {...stylex.props(styles.rowIcon)}>
      {pending ? <span {...stylex.props(spinners.running)} /> : icon}
    </span>
    <span {...stylex.props(styles.rowCopy)}>
      <strong {...stylex.props(styles.rowName)}>{item.displayName}</strong>
      <code title={item.root} {...stylex.props(styles.rowPath)}>{item.root}</code>
    </span>
    <span {...stylex.props(styles.rowAction, pending && shimmer.text)}>{pending ? `${working}…` : action}</span>
  </button>
)

const styles = stylex.create({
  browse: { width: "100%", minHeight: "64px", display: "grid", gridTemplateColumns: `${size.control} minmax(0, 1fr) ${size.icon}`, alignItems: "center", gap: space.md, paddingBlock: space.md, paddingInline: space.md, color: { default: colors.text, ":hover": colors.accentOn }, backgroundColor: { default: colors.sunken, ":hover": colors.accent }, borderWidth: 0, borderRadius: radius.md, cursor: { default: "pointer", ":disabled": "not-allowed" }, opacity: { default: 1, ":disabled": 0.5 }, textAlign: "start", transform: { default: "scale(1)", ":active": "scale(0.98)" }, transitionProperty: "background-color, box-shadow, color, transform", transitionDuration: motion.fast, transitionTimingFunction: motion.settle },
  browseIcon: { width: size.control, height: size.control, display: "grid", placeItems: "center", padding: space.sm, boxSizing: "border-box", color: "inherit" },
  browseCopy: { minWidth: 0, display: "flex", flexDirection: "column", gap: space.xs },
  browseTitle: { fontSize: typography.body, lineHeight: typography.bodyLine, fontWeight: 700 },
  /**
   * Inherited colour at 0.8, not a token, because this line inverts with its
   * row: the button turns to `accent` on hover and every child has to turn with
   * it, which no single token does.
   *
   * A blend is invisible to `contrast.test.ts`, so it was measured by hand
   * against both fills in all three themes: 0.68 held between 5.99 and 6.93,
   * and 0.8 holds between 8.58 and 13.08. The change is legibility rather than
   * compliance — a hint at 0.68 of the row's own colour is thin on a 64px
   * button that is the first thing in the panel.
   */
  browseHint: { color: "inherit", opacity: 0.8, fontSize: typography.caption, lineHeight: typography.captionLine },
  arrow: { width: size.icon, height: size.icon },
  columns: { display: "grid", gridTemplateColumns: { default: "minmax(0, 1.08fr) minmax(248px, 0.92fr)", "@media (max-width: 640px)": "minmax(0, 1fr)" }, alignItems: "start", gap: space.xl },
  sections: { display: "flex", flexDirection: "column", gap: space.lg },
  section: { display: "flex", flexDirection: "column", gap: space.sm },
  list: { margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: space.xs },
  /** The only content the section has when it is empty, so it is read, not glanced at. */
  empty: { margin: 0, color: colors.textMuted, fontSize: typography.caption, lineHeight: typography.captionLine },
  row: {
    width: "100%", minHeight: "52px", display: "grid", gridTemplateColumns: `${size.controlDense} minmax(0, 1fr) auto`, alignItems: "center", gap: space.sm,
    paddingBlock: space.xs, paddingInline: space.sm, boxSizing: "border-box",
    color: { default: colors.textMuted, ":hover": colors.text },
    backgroundColor: { default: "transparent", ":hover": colors.accentSoft },
    borderWidth: 0, borderRadius: radius.md, textAlign: "start",
    cursor: { default: "pointer", ":disabled": "not-allowed" }, opacity: { default: 1, ":disabled": 0.56 },
    transform: { default: "scale(1)", ":active": "scale(0.98)" }, transitionProperty: "background-color, color, transform", transitionDuration: motion.fast, transitionTimingFunction: motion.settle,
  },
  /**
   * The glyph without its plate.
   *
   * Each row used to carry a filled square behind its icon, which on a list of
   * eight rows is eight more boxes than the list has meanings. The column is
   * what gives the rows their rhythm; the plate only drew it twice.
   */
  rowIcon: { width: size.controlDense, height: size.controlDense, display: "grid", placeItems: "center", boxSizing: "border-box", color: colors.textMuted },
  rowCopy: { minWidth: 0, display: "flex", flexDirection: "column", gap: space.xs },
  rowName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.text, fontSize: typography.label, lineHeight: typography.labelLine, fontWeight: 600 },
  /**
   * `textMuted`, not `textFaint`. The path is how a person tells two folders
   * with the same name apart, which makes it something read rather than a hint
   * — and `textFaint` is held to 3.0 precisely because it is never that. The
   * mono face and the caption size keep it subordinate to the name without
   * spending contrast to do it.
   */
  rowPath: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.textMuted, fontFamily: typography.mono, fontSize: typography.caption, lineHeight: typography.captionLine },
  rowAction: { flex: "none", color: colors.textMuted, fontSize: typography.caption, lineHeight: typography.captionLine, fontWeight: 600 },
  /**
   * A third group beside Recent and WSL, not a card.
   *
   * It was a plate filled with `surface`, and on this surface a plate cannot
   * work in both themes. The overlay is the top of the ladder, so a card can
   * only seat — and in light `surface` is `#fdfdfd` against a `#ffffff` modal,
   * a ratio of 1.02, which is no seat at all. Every fill that does seat in
   * light is within a few units of `sunken`, so the plate would have swallowed
   * the wells of its own fields instead.
   *
   * Removing the surface answers all of it. The column now carries the same
   * `groupLabel` its siblings do, its fields sit as wells directly on the modal
   * exactly as every other panel's do, and the 24px column gap is what tells
   * the two apart — which is how this interface separates regions everywhere
   * else it has the room.
   */
  createPanel: { display: "flex", flexDirection: "column", gap: space.sm },
  createHint: { margin: 0, marginBlockEnd: space.xs, color: colors.textMuted, fontSize: typography.caption, lineHeight: typography.captionLine },
  fieldGroup: { display: "flex", flexDirection: "column", gap: space.xs },
  check: { display: "flex", alignItems: "center", gap: space.sm, color: colors.textMuted, fontSize: typography.label, lineHeight: typography.labelLine, cursor: "pointer", userSelect: "none" },
  checkbox: { width: "16px", height: "16px", margin: 0, accentColor: colors.accent, cursor: "pointer" },
  createAction: { width: "100%", marginBlockStart: space.xs },
  /**
   * The control that is working stays at full strength.
   *
   * Everything in the panel is disabled while one thing runs, and the shared
   * `:disabled` rule fades all of it — including the row a person is waiting
   * on, which is the one thing that has to stay legible. Its spinner and its
   * verb were being drawn at 0.56 of the tone they were measured at.
   */
  working: { opacity: { default: 1, ":disabled": 1 } },
  /**
   * A working row also keeps the fill hover would have given it, so the panel
   * says which row is running without a pointer resting on it.
   */
  rowWorking: { opacity: { default: 1, ":disabled": 1 }, color: colors.text, backgroundColor: colors.accentSoft },
  /**
   * A reserved slot, so the status arriving does not move the rows above it.
   * Two lines of caption is the tallest thing it holds — a WSL status and its
   * explanation — and that is the height it keeps when it holds nothing.
   */
  footer: { minHeight: "34px", display: "flex", flexDirection: "column", justifyContent: "center" },
  status: { margin: 0, display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.sm, color: colors.textMuted, fontSize: typography.caption, lineHeight: typography.captionLine },
  statusSpinner: { alignSelf: "center" },
  /** The reason the wait is long, on its own line so the verb stays scannable. */
  statusNote: { flexBasis: "100%", color: colors.textMuted },
  note: { margin: 0, color: colors.textMuted, fontSize: typography.caption, lineHeight: typography.captionLine },
  error: { margin: 0, color: colors.danger, fontSize: typography.caption, lineHeight: typography.captionLine },
})
