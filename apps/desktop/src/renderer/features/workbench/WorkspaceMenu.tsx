import { useEffect, useRef, useState } from "react"
import * as stylex from "@stylexjs/stylex"
import { ChevronDown, FolderOpen, FolderPlus, GitBranch, LogOut } from "lucide-react"
import { type Workspace, type WorkspaceLocation, workspaceTargetKey } from "@bake-pi/contract"
import { store } from "../../store/session-store.ts"
import { rememberWorkspace } from "../../store/preferences.ts"
import { colors, effects, radius, space, typography } from "../../theme/tokens.stylex.ts"
import { focus } from "../../theme/focus.ts"
import { size } from "../../theme/sizes.stylex.ts"
import { WorkspaceDialog } from "./WorkspaceDialog.tsx"

/**
 * The workspace chip in the tab strip, and the menu it drops.
 *
 * The chip used to be a label. It is the one object everything else in the
 * strip belongs to, so it is where switching belongs too: the recent roots
 * main knows about, the native picker, the full chooser, and leaving the
 * workspace. Recents are fetched when the menu opens rather than kept — the
 * list is main's, and a menu that opens once a session does not need a cache.
 */
export const WorkspaceMenu = ({ workspace }: { workspace: Workspace }): React.JSX.Element => {
  const [open, setOpen] = useState(false)
  const [dialog, setDialog] = useState(false)
  const [recent, setRecent] = useState<WorkspaceLocation[] | undefined>()
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    let live = true
    setRecent(undefined)
    store.send("list_workspace_locations", {})
      .then((listing) => { if (live) setRecent(listing.recent.filter((location) => !sameWorkspace(location, workspace))) })
      .catch((cause) => { store.capture(cause); if (live) setRecent([]) })
    return () => { live = false }
  }, [open, workspace.root])

  const run = (action: () => Promise<Workspace | undefined | void>): void => {
    setOpen(false)
    void action().then((opened) => { if (opened !== undefined) rememberWorkspace(opened) }).catch((cause) => store.capture(cause))
  }

  return (
    <div
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return
        event.preventDefault()
        setOpen(false)
        trigger.current?.focus()
      }}
      {...stylex.props(styles.root)}
    >
      <button
        ref={trigger}
        type="button"
        title={workspace.root}
        aria-label={`Workspace ${workspace.displayName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        {...stylex.props(focus.control, styles.chip, open && styles.chipOpen)}
      >
        {workspace.isGitRepository ? <GitBranch size={12} aria-label="Git repository" {...stylex.props(styles.glyph)} /> : null}
        <span {...stylex.props(styles.name)}>{workspace.displayName}</span>
        <ChevronDown size={12} aria-hidden="true" {...stylex.props(styles.glyph)} />
      </button>

      {!open ? null : (
        <div role="menu" aria-label="Workspace" {...stylex.props(styles.menu)}>
          <span {...stylex.props(styles.groupLabel)}>Switch to</span>
          {recent === undefined
            ? <span {...stylex.props(styles.note)}>Loading…</span>
            : recent.length === 0
              ? <span {...stylex.props(styles.note)}>No other recent workspaces</span>
              : recent.map((location) => (
                <button key={location.id} type="button" role="menuitem" title={location.root} onClick={() => run(() => store.reopenRecentWorkspace(location.id))} {...stylex.props(focus.ring, styles.item)}>
                  <span {...stylex.props(styles.itemLabel)}>{location.displayName}</span>
                  <span {...stylex.props(styles.itemHint)}>{location.root}</span>
                </button>
              ))}
          <span aria-hidden="true" {...stylex.props(styles.rule)} />
          <button type="button" role="menuitem" onClick={() => run(() => store.chooseWorkspace())} {...stylex.props(focus.ring, styles.item)}>
            <FolderOpen size={14} {...stylex.props(styles.itemGlyph)} /><span {...stylex.props(styles.itemLabel)}>Open a folder…</span>
          </button>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); setDialog(true) }} {...stylex.props(focus.ring, styles.item)}>
            <FolderPlus size={14} {...stylex.props(styles.itemGlyph)} /><span {...stylex.props(styles.itemLabel)}>Add or create workspace…</span>
          </button>
          <span aria-hidden="true" {...stylex.props(styles.rule)} />
          <button type="button" role="menuitem" onClick={() => run(() => store.closeWorkspace())} {...stylex.props(focus.ring, styles.item)}>
            <LogOut size={14} {...stylex.props(styles.itemGlyph)} /><span {...stylex.props(styles.itemLabel)}>Close workspace</span>
          </button>
        </div>
      )}

      {dialog ? <WorkspaceDialog onClose={() => setDialog(false)} onOpened={(opened) => { rememberWorkspace(opened); setDialog(false) }} /> : null}
    </div>
  )
}

const styles = stylex.create({
  root: { position: "relative", display: { default: "flex", "@media (max-width: 720px)": "none" }, alignItems: "center", WebkitAppRegion: "no-drag" },
  /**
   * The recess the label used to be, now a control: same mono caption, same
   * cap on width, plus a hover fill and a chevron so it reads as something
   * that opens.
   */
  chip: {
    boxSizing: "border-box", maxWidth: "200px", height: size.controlMicro, display: "inline-flex", alignItems: "center", gap: space.xs, paddingInline: space.xs,
    color: { default: colors.textFaint, ":hover": colors.text }, backgroundColor: { default: "transparent", ":hover": colors.surface },
    borderWidth: 0, borderRadius: radius.sm, cursor: "pointer", fontFamily: typography.mono, fontSize: typography.caption,
  },
  chipOpen: { color: colors.text, backgroundColor: colors.surface },
  glyph: { flex: "none" },
  name: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  menu: {
    position: "absolute", insetInlineStart: 0, insetBlockStart: `calc(100% + ${space.xs})`, zIndex: 40,
    width: "320px", display: "flex", flexDirection: "column", padding: space.xs,
    backgroundColor: colors.surfaceOverlay, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.borderStrong, borderRadius: radius.lg, boxShadow: effects.liftOverlay,
  },
  groupLabel: { paddingBlock: space.xs, paddingInline: space.sm, color: colors.textMuted, fontSize: typography.micro, lineHeight: typography.microLine, fontWeight: 600, letterSpacing: "0.09em", textTransform: "uppercase" },
  note: { paddingBlock: space.xs, paddingInline: space.sm, color: colors.textFaint, fontSize: typography.caption, lineHeight: typography.captionLine },
  rule: { height: effects.hairline, marginBlock: space.xs, backgroundColor: colors.border },
  item: {
    width: "100%", minHeight: size.controlDense, display: "flex", alignItems: "center", gap: space.sm, paddingInline: space.sm, boxSizing: "border-box",
    color: colors.text, backgroundColor: { default: "transparent", ":hover": colors.sunken }, borderWidth: 0, borderRadius: radius.sm, cursor: "pointer", textAlign: "start",
    fontFamily: typography.ui, fontSize: typography.label, lineHeight: typography.labelLine,
  },
  itemGlyph: { flex: "none", color: colors.textMuted },
  itemLabel: { flex: "none", maxWidth: "55%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 },
  itemHint: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.textFaint, textAlign: "end", fontFamily: typography.mono, fontSize: typography.micro },
})

const sameWorkspace = (left: WorkspaceLocation, right: Workspace): boolean =>
  workspaceTargetKey(left) === workspaceTargetKey(right)
