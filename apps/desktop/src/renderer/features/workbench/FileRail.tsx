import { useEffect, useMemo, useRef, useState } from "react"
import * as stylex from "@stylexjs/stylex"
import { ChevronRight, Eye, EyeOff, RefreshCw, Search, X } from "lucide-react"
import { store, type Listing } from "../../store/session-store.ts"
import { colors, effects, motion, radius, space, typography } from "../../theme/tokens.stylex.ts"
import { focus } from "../../theme/focus.ts"
import { size } from "../../theme/sizes.stylex.ts"
import { scrollbars } from "../../theme/scrollbars.ts"
import { spinners } from "../../theme/spinners.ts"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { FileIcon } from "./FileIcon.tsx"
import { WORKSPACE_FILE_DRAG_TYPE } from "./file-drag.ts"
import { pickFileIcon, useFileIcons, type FileIconSet } from "./file-icons.ts"
import {
  filterListings,
  isGitMetadataDirectory,
  SHOW_IGNORED_BY_DEFAULT,
} from "./file-tree-visibility.ts"

/**
 * The left rail: the workspace as a tree, one directory at a time.
 *
 * Lazy by directory rather than walked at open. A repository is not a small
 * thing and the interesting part of it is three levels down a path the person
 * already knows — reading the whole tree to draw the two folders they expand
 * would spend seconds of the host's time on names nobody asked for, and would
 * do it again on every workspace change.
 *
 * The listing is held here, in the component, and not in the session store.
 * Renderer state is a projection of what Pi holds, and a directory listing is
 * not that: it is a read of the filesystem at an instant, and it goes stale the
 * moment a tool writes a file. Keeping it out of the store is what stops it
 * from looking authoritative.
 *
 * Every path the tree can name came back from a listing the host had already
 * contained, and expanding one is checked again on arrival. So the rail cannot
 * be steered out of the workspace by anything the model says or does.
 */
export const FileRail = ({
  workspaceRoot,
  isGitRepository,
  dragFiles,
  onFileDragging,
  onClose,
}: {
  workspaceRoot: string
  isGitRepository: boolean
  dragFiles: boolean
  onFileDragging: (dragging: boolean) => void
  onClose?: () => void
}): React.JSX.Element => {
  const [listings, setListings] = useState<Record<string, Listing>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [failed, setFailed] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState("")
  const [showIgnored, setShowIgnored] = useState(SHOW_IGNORED_BY_DEFAULT)
  const [refreshing, setRefreshing] = useState(false)
  const [rootFailed, setRootFailed] = useState(false)
  const icons = useFileIcons()
  const field = useRef<HTMLInputElement>(null)
  const loading = useRef(new Set<string>())
  const currentWorkspace = useRef(workspaceRoot)
  currentWorkspace.current = workspaceRoot

  // Re-read on workspace change rather than on mount: the rail outlives one
  // workspace, and a tree left over from the previous one is a tree of paths
  // that no longer resolve.
  useEffect(() => {
    let live = true
    setListings({})
    setExpanded(new Set())
    setFailed(new Set())
    setFilter("")
    setShowIgnored(SHOW_IGNORED_BY_DEFAULT)
    setRefreshing(false)
    setRootFailed(false)
    loading.current.clear()
    void store
      .listDirectory()
      .then((listing) => { if (live) setListings({ [workspaceRoot]: listing }) })
      .catch(() => { if (live) setRootFailed(true) })
    return () => { live = false }
  }, [workspaceRoot])

  const toggle = (path: string): void => {
    const next = new Set(expanded)
    if (next.delete(path)) {
      setExpanded(next)
      return
    }
    next.add(path)
    setExpanded(next)
    if (listings[path] !== undefined || loading.current.has(path)) return
    const requestedFrom = workspaceRoot
    loading.current.add(path)
    setFailed((current) => {
      const withoutPath = new Set(current)
      withoutPath.delete(path)
      return withoutPath
    })
    void store
      .listDirectory(path)
      .then((listing) => {
        if (currentWorkspace.current === requestedFrom) {
          setListings((current) => ({ ...current, [path]: listing }))
        }
      })
      .catch(() => {
        if (currentWorkspace.current === requestedFrom) {
          setFailed((current) => new Set(current).add(path))
        }
      })
      .finally(() => loading.current.delete(path))
  }

  const query = filter.trim().toLowerCase()
  const root = listings[workspaceRoot]
  // Filtering every level while rendering revisited the same descendants for
  // each ancestor. One memoized pass makes the work linear in the paths that
  // have actually been loaded, regardless of how deep the open tree is.
  const visibleListings = useMemo(
    () => filterListings(listings, query, showIgnored),
    [listings, query, showIgnored],
  )
  const surviving = visibleListings[workspaceRoot]?.entries ?? []

  /** Re-read every open directory without collapsing the person's position. */
  const refresh = (): void => {
    if (refreshing) return
    const requestedFrom = workspaceRoot
    const paths = [workspaceRoot, ...expanded]
    setRefreshing(true)
    void Promise.allSettled(
      paths.map(async (path) => await store.listDirectory(path === workspaceRoot ? undefined : path)),
    ).then((results) => {
      if (currentWorkspace.current !== requestedFrom) return
      setListings((current) => {
        const next = { ...current }
        results.forEach((result, index) => {
          if (result.status === "fulfilled") next[paths[index]!] = result.value
        })
        return next
      })
      setFailed(new Set(paths.filter((_, index) => results[index]?.status === "rejected")))
      setRootFailed(results[0]?.status === "rejected" && root === undefined)
    }).finally(() => {
      if (currentWorkspace.current === requestedFrom) setRefreshing(false)
    })
  }

  return (
    <aside aria-label="Files" {...stylex.props(styles.rail)}>
      {/*
        The search leads the rail. Filtering is the one thing a person does to
        a tree of any size every time they see it, so the field takes the
        first row, and the header beneath keeps the rail's name and its
        actions.

        A row rather than a `<label>` wrapping everything, because the clear
        button lives in the field. A button inside a label is a control whose
        click the label also claims, and the field is named by `aria-label`
        just as clearly.
      */}
      <div {...stylex.props(styles.filterRow)}>
        <div {...stylex.props(styles.filter)}>
          <Search size={14} aria-hidden="true" {...stylex.props(styles.filterIcon)} />
          <input
            ref={field}
            type="text"
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === "Escape" && filter !== "") { event.stopPropagation(); setFilter("") } }}
            aria-label="Search open files"
            placeholder="Search open files"
            spellCheck={false}
            {...stylex.props(styles.filterInput)}
          />
          {filter === "" ? null : (
            <Tooltip label="Clear filter">
              <button
                type="button"
                onClick={() => { setFilter(""); field.current?.focus() }}
                aria-label="Clear filter"
                {...stylex.props(focus.control, styles.filterClear)}
              >
                <X size={12} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>

      {/*
        The rail's actions as glyphs beside the eyebrow, each named by its
        tooltip rather than by a word on its face. The toggle among them says
        its state twice — `aria-pressed` underneath and an open eye against a
        struck one on the surface — because one step of grey fill reads as
        decoration until the pointer arrives to ask what it meant.
      */}
      <div {...stylex.props(styles.header)}>
        <span {...stylex.props(styles.eyebrow)}>Files</span>
        {isGitRepository ? (
          <Tooltip label={showIgnored ? "Hide Git-ignored files" : "Show Git-ignored files"}>
            <button
              type="button"
              onClick={() => setShowIgnored((shown) => !shown)}
              aria-label="Git-ignored files"
              aria-pressed={showIgnored}
              {...stylex.props(focus.control, styles.headerAction, showIgnored && styles.headerActionActive)}
            >
              {showIgnored ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}
            </button>
          </Tooltip>
        ) : null}
        <Tooltip label={refreshing ? "Refreshing files" : "Refresh files"}>
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing || root === undefined}
            aria-label={refreshing ? "Refreshing files" : "Refresh files"}
            aria-busy={refreshing}
            {...stylex.props(focus.control, styles.headerAction)}
          >
            <RefreshCw size={14} aria-hidden="true" {...stylex.props(refreshing && spinners.rotate)} />
          </button>
        </Tooltip>
        {onClose === undefined ? null : (
          <Tooltip label="Close files" align="end">
            <button type="button" onClick={onClose} aria-label="Close files" {...stylex.props(focus.control, styles.headerAction)}><X size={14} aria-hidden="true" /></button>
          </Tooltip>
        )}
      </div>

      <nav aria-label="Workspace files" {...stylex.props(scrollbars.thin, styles.tree)}>
        {rootFailed ? (
          <p {...stylex.props(styles.note)}>The workspace directory could not be read.</p>
        ) : root === undefined ? (
          <p role="status" {...stylex.props(styles.note)}>Reading the workspace…</p>
        ) : root.entries.length === 0 ? (
          <p {...stylex.props(styles.note)}>This workspace is empty.</p>
        ) : surviving.length === 0 && query !== "" ? (
          // Only what is open can be filtered, so a query that matches nothing
          // has to say which of the two it means: nothing here, or nothing read
          // yet. A blank tree said neither.
          <p role="status" {...stylex.props(styles.note)}>No open file or folder matches “{filter.trim()}”.</p>
        ) : surviving.length === 0 ? (
          <p role="status" {...stylex.props(styles.note)}>Git-ignored files are hidden.</p>
        ) : (
          <>
            <Level
              entries={surviving}
              depth={0}
              listings={visibleListings}
              expanded={expanded}
              failed={failed}
              icons={icons}
              dragFiles={dragFiles}
              onToggle={toggle}
              onFileDragging={onFileDragging}
            />
            {root.truncated ? <Truncated depth={0} /> : null}
          </>
        )}
      </nav>
    </aside>
  )
}

/**
 * One directory's worth of rows, and its expanded children beneath each.
 *
 * Recursive rather than flattened because the filter has to keep a matching
 * file's ancestors: a rail that showed the match alone would show a file name
 * with no indication of where it lives, which is the one thing a tree is for.
 * A directory therefore survives the filter if it matches or if anything
 * already read beneath it does.
 */
const Level = ({
  entries,
  depth,
  listings,
  expanded,
  failed,
  icons,
  dragFiles,
  onToggle,
  onFileDragging,
}: {
  entries: Listing["entries"]
  depth: number
  listings: Record<string, Listing>
  expanded: Set<string>
  failed: Set<string>
  icons: FileIconSet
  dragFiles: boolean
  onToggle: (path: string) => void
  onFileDragging: (dragging: boolean) => void
}): React.JSX.Element => (
  <>
    {entries.map((entry) => {
      const open = expanded.has(entry.path)
      const below = listings[entry.path]
      return (
        <div key={entry.path}>
          {isGitMetadataDirectory(entry) ? (
            <div
              title={`${entry.path} — repository metadata is hidden`}
              {...stylex.props(styles.row, styles.metadataRow, INDENT[Math.min(depth, INDENT.length - 1)]!)}
            >
              <span aria-hidden="true" {...stylex.props(styles.glyph, styles.spacer)} />
              <FileIcon icon={pickFileIcon(icons, entry, false)} />
              <span {...stylex.props(styles.name)}>{entry.name}</span>
              <span aria-hidden="true" {...stylex.props(styles.ignoredBadge)}>hidden</span>
            </div>
          ) : entry.kind === "directory" ? (
            <button
              type="button"
              aria-expanded={open}
              title={entry.ignored ? `${entry.path} — ignored by Git` : entry.path}
              aria-label={entry.ignored ? `${entry.name}, ignored by Git` : entry.name}
              onClick={() => onToggle(entry.path)}
              {...stylex.props(focus.control, styles.row, styles.directory, entry.ignored && styles.ignoredRow, INDENT[Math.min(depth, INDENT.length - 1)]!)}
            >
              <ChevronRight size={14} aria-hidden="true" {...stylex.props(styles.glyph, styles.chevron, open && styles.chevronOpen)} />
              <FileIcon icon={pickFileIcon(icons, entry, open)} />
              <span {...stylex.props(styles.name)}>{entry.name}</span>
              {entry.ignored ? <span aria-hidden="true" {...stylex.props(styles.ignoredBadge)}>ignored</span> : null}
            </button>
          ) : (
            <span
              draggable={dragFiles}
              title={dragFiles
                ? `${entry.path} — drag to the prompt${entry.ignored ? " — ignored by Git" : ""}`
                : (entry.ignored ? `${entry.path} — ignored by Git` : entry.path)}
              aria-label={dragFiles
                ? `${entry.name}, drag to prompt${entry.ignored ? ", ignored by Git" : ""}`
                : (entry.ignored ? `${entry.name}, ignored by Git` : entry.name)}
              onDragStart={(event) => {
                if (!dragFiles) {
                  event.preventDefault()
                  return
                }
                event.dataTransfer.effectAllowed = "copy"
                event.dataTransfer.setData(WORKSPACE_FILE_DRAG_TYPE, entry.path)
                onFileDragging(true)
              }}
              onDragEnd={() => onFileDragging(false)}
              {...stylex.props(styles.row, styles.file, dragFiles && styles.fileDraggable, entry.ignored && styles.ignoredRow, INDENT[Math.min(depth, INDENT.length - 1)]!)}
            >
              <span aria-hidden="true" {...stylex.props(styles.glyph, styles.spacer)} />
              <FileIcon icon={pickFileIcon(icons, entry, false)} />
              <span {...stylex.props(styles.name)}>{entry.name}</span>
              {entry.ignored ? <span aria-hidden="true" {...stylex.props(styles.ignoredBadge)}>ignored</span> : null}
            </span>
          )}
          {!open ? null : (
            <div {...stylex.props(styles.reveal)}>
              {failed.has(entry.path) ? (
                <p {...stylex.props(styles.note, INDENT[Math.min(depth + 1, INDENT.length - 1)]!)}>Could not be read.</p>
              ) : below === undefined ? (
                <p role="status" {...stylex.props(styles.note, INDENT[Math.min(depth + 1, INDENT.length - 1)]!)}>Reading…</p>
              ) : (
                <>
                  <Level
                    entries={below.entries}
                    depth={depth + 1}
                    listings={listings}
                    expanded={expanded}
                    failed={failed}
                    icons={icons}
                    dragFiles={dragFiles}
                    onToggle={onToggle}
                    onFileDragging={onFileDragging}
                  />
                  {below.truncated ? <Truncated depth={depth + 1} /> : null}
                </>
              )}
            </div>
          )}
        </div>
      )
    })}
  </>
)

/**
 * A directory the host stopped listing.
 *
 * The cap is the host's and the count is not worth carrying across the
 * boundary; what a person needs is that the rows above are a part rather than
 * the whole, because a tree that quietly shows the first thousand names is a
 * tree that says a directory holds what fits.
 */
const Truncated = ({ depth }: { depth: number }): React.JSX.Element => (
  <p {...stylex.props(styles.note, INDENT[Math.min(depth, INDENT.length - 1)]!)}>Too many entries to list them all.</p>
)

/**
 * Entrances for the rail's arrivals.
 *
 * `enterReveal` and `enterPop` travel two pixels and a tenth of scale while
 * they fade; under reduced motion both are swapped for `enterFade`, which
 * keeps the acknowledgement and drops the travel — the same split the modal
 * makes between its scale-in and the scrim's fade. Arrivals only: a thing
 * leaving unmounts, and keeping it alive to say goodbye would be state held
 * for the sake of an animation.
 */
/**
 * Declared here rather than shared from the theme because StyleX cannot import
 * keyframes across modules — only a `.stylex.ts` file may export them, and even
 * then the compiler will not resolve the imported name into `animationName`.
 * The duplication is the compiler's, not a choice.
 */
const enterFade = stylex.keyframes({ from: { opacity: 0 } })

const enterReveal = stylex.keyframes({ from: { opacity: 0, transform: "translateY(-2px)" } })
const enterPop = stylex.keyframes({ from: { opacity: 0, transform: "scale(0.9)" } })

const styles = stylex.create({
  /**
   * `canvasSubtle`, one tint step behind the conversation. The columns are told
   * apart by tint and never by a rule — that is the borderless rule applied to
   * the layout itself rather than to a control.
   */
  rail: { minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", backgroundColor: colors.canvasSubtle },
  /**
   * Everything in this rail starts on the same 16px gutter, and each of the
   * three regions reaches it a different way: the header pads to it directly,
   * the filter row pads 8 and the field inside it pads 8 again, and the tree
   * pads 8 with `depth0` adding the last 8. They were 12, 20 and 16 before,
   * which is three near-misses reading as a wobble down the left edge.
   */
  header: { flex: "none", height: size.railHeader, display: "flex", alignItems: "center", gap: space.xs, paddingInlineStart: size.gutter, paddingInlineEnd: space.sm },
  /**
   * The rail's name, set as an eyebrow rather than as a heading.
   *
   * Tracked to 0.12em and drawn in `textMuted` rather than `textFaint`: at
   * 11.5px uppercase, tracking is what separates a label from a smudge, and
   * the muted step is what lets it be read at a glance without competing with
   * the rows beneath it. It carries no rule under it — the 16px gutter every
   * row below shares is what says where the rail begins.
   */
  eyebrow: { flex: 1, color: colors.textMuted, fontSize: typography.micro, lineHeight: typography.microLine, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" },
  /**
   * A press compresses the button to 0.97, icon and all — it answers the
   * finger, which is what makes a click read as a press rather than a
   * recolour. No transition is declared here: `focus.control` already names
   * `transform`, and the tree rows stay unscaled on purpose — they are
   * navigation, not actions.
   */
  headerAction: { width: size.controlDense, height: size.controlDense, display: "grid", placeItems: "center", padding: 0, color: { default: colors.textMuted, ":hover": colors.text, ":active": colors.text, ":disabled": colors.textFaint }, backgroundColor: { default: "transparent", ":hover": colors.surface, ":active": colors.sunken, ":disabled": "transparent" }, borderWidth: 0, borderRadius: radius.sm, opacity: { default: 1, ":disabled": 0.55 }, cursor: { default: "pointer", ":disabled": "default" }, transform: { default: "none", ":active": "scale(0.97)", ":disabled": "none" } },
  /**
   * The pressed state of the row's one toggle: a fill step that is there
   * between hovers rather than only during one, so pressed reads as pressed
   * with the pointer anywhere else. The glyph swap says which way.
   */
  headerActionActive: { color: colors.text, backgroundColor: { default: colors.surface, ":hover": colors.surfaceRaised }, boxShadow: effects.lift },

  filterRow: { flex: "none", paddingInline: size.gutter, paddingBlockStart: space.sm, paddingBlockEnd: space.sm },
  /**
   * Sunken rather than raised. A field is somewhere to put something into, and
   * in this system that reads as a recess in the rail rather than a card on it.
   */
  filter: { height: size.control, boxSizing: "border-box", display: "flex", alignItems: "center", gap: space.sm, paddingInlineStart: space.md, paddingInlineEnd: space.xs, backgroundColor: { default: colors.sunken, ":focus-within": colors.surface }, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.borderStrong, borderRadius: radius.md, boxShadow: { default: "none", ":focus-within": effects.focusState }, transitionProperty: "background-color, box-shadow", transitionDuration: motion.fast, transitionTimingFunction: motion.settle },
  filterIcon: { flex: "none", color: colors.textFaint },
  filterInput: { flex: 1, minWidth: 0, height: "100%", color: colors.text, backgroundColor: "transparent", borderWidth: 0, outline: "none", fontFamily: typography.ui, fontSize: typography.label, "::placeholder": { color: colors.textFaint } },
  /**
   * Present only while there is something to clear.
   *
   * `type="search"` would have given a native one, drawn by the platform in a
   * weight this palette has no say over — and the field is a recess in a grey
   * rail, which is exactly where a stock magnifier-and-cross reads as somebody
   * else's control. It pops into the field rather than blinking on, so the
   * arrival of the one undo the query has reads as a consequence of typing.
   */
  filterClear: { flex: "none", width: size.controlMicro, height: size.controlMicro, display: "grid", placeItems: "center", padding: 0, color: { default: colors.textFaint, ":hover": colors.text, ":active": colors.text }, backgroundColor: { default: "transparent", ":hover": colors.surface, ":active": colors.sunken }, borderWidth: 0, borderRadius: radius.sm, cursor: "pointer", transform: { default: "none", ":active": "scale(0.97)" }, animationName: { default: enterPop, "@media (prefers-reduced-motion: reduce)": enterFade }, animationDuration: { default: motion.moderate, "@media (prefers-reduced-motion: reduce)": motion.accessibleFade }, animationTimingFunction: motion.settle },

  tree: { flex: 1, minHeight: 0, overflowY: "auto", paddingInline: space.sm, paddingBlockStart: space.xs, paddingBlockEnd: space.lg },
  /**
   * Expanded children unfold from their row: a fade with a two-pixel settle,
   * and never a height animation — a tree level is unbounded content, and
   * height costs layout on every frame it runs. The teleport is bridged, not
   * measured.
   */
  reveal: { animationName: { default: enterReveal, "@media (prefers-reduced-motion: reduce)": enterFade }, animationDuration: { default: motion.moderate, "@media (prefers-reduced-motion: reduce)": motion.accessibleFade }, animationTimingFunction: motion.settle },
  /**
   * `border-box`, and it has to be said here rather than once globally.
   *
   * A row is `width: 100%` with padding on both sides. Under the UA's default
   * `content-box` that is wider than the rail, and because the tree scrolls
   * vertically the browser gives the horizontal overflow a scrollbar too — a
   * bar along the bottom of the window, under a column of short file names.
   *
   * There is no reset to lean on: `index.html` cannot carry one, because the
   * CSP deliberately omits `style-src 'unsafe-inline'`, and StyleX has no
   * universal selector. So every box that combines a percentage width with
   * padding declares this itself, which is why it appears on the composer, the
   * queue, the fields and here.
   */
  row: { width: "100%", boxSizing: "border-box", height: size.controlDense, display: "flex", alignItems: "center", gap: "7px", paddingInlineEnd: space.sm, borderRadius: radius.sm, fontSize: typography.label, lineHeight: typography.labelLine, textAlign: "start" },
  directory: { color: { default: colors.text, ":hover": colors.text, ":active": colors.text }, backgroundColor: { default: "transparent", ":hover": colors.surface, ":active": colors.sunken }, borderWidth: 0, cursor: "pointer", fontWeight: 500 },
  file: { color: colors.textMuted, backgroundColor: "transparent", cursor: "default", userSelect: "none" },
  fileDraggable: { color: { default: colors.textMuted, ":hover": colors.text, ":active": colors.text }, backgroundColor: { default: "transparent", ":hover": colors.surface, ":active": colors.sunken }, cursor: { default: "grab", ":active": "grabbing" }, transitionProperty: "background-color, color", transitionDuration: motion.fast, transitionTimingFunction: motion.settle },
  metadataRow: { color: colors.textFaint, backgroundColor: "transparent", cursor: "default", fontWeight: 500 },
  ignoredRow: { color: colors.textFaint },
  name: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  ignoredBadge: { flex: "none", color: colors.textFaint, fontSize: typography.micro, lineHeight: typography.microLine, fontWeight: 500 },
  /**
   * Every row spends the same 14px on a chevron slot and 16px on an icon, which
   * is what lets a file and a folder at the same depth start their names in
   * the same place. A file has nothing to expand, so its chevron slot is empty
   * — the way VS Code's own explorer does it.
   *
   * A file used to borrow the next indent step instead, so that its name lined
   * up with the directory names beside it — an alignment that was right by
   * accident and wrong the moment a directory was one level deeper. Now the
   * indent means depth and only depth, and the two slots do the aligning.
   */
  glyph: { flex: "none" },
  spacer: { width: 14, height: 14 },
  chevron: { color: colors.textMuted, transitionProperty: "transform", transitionDuration: motion.fast, transitionTimingFunction: motion.move },
  chevronOpen: { transform: "rotate(90deg)" },
  /**
   * Indentation as eight declared steps rather than a computed inline style.
   *
   * The CSP carries no `style-src 'unsafe-inline'` and this interface compiles
   * every rule at build time, so a per-row `padding-inline-start` computed from
   * the depth has nowhere to go. Eight is not a limit on how deep the tree
   * reads — past it rows stop indenting further, which is what a rail this
   * narrow would have had to do anyway.
   */
  depth0: { paddingInlineStart: space.sm },
  depth1: { paddingInlineStart: "20px" },
  depth2: { paddingInlineStart: "32px" },
  depth3: { paddingInlineStart: "44px" },
  depth4: { paddingInlineStart: "56px" },
  depth5: { paddingInlineStart: "68px" },
  depth6: { paddingInlineStart: "80px" },
  depth7: { paddingInlineStart: "92px" },
  /**
   * Status text fades in rather than snapping on: a note answers an action —
   * a query, an expand — and arriving with a soft edge keeps the tree from
   * reading as flicker. Opacity only, so reduced motion keeps all of it.
   */
  note: { margin: 0, paddingBlock: space.sm, paddingInlineEnd: space.sm, color: colors.textFaint, fontSize: typography.caption, lineHeight: typography.captionLine, animationName: enterFade, animationDuration: { default: motion.moderate, "@media (prefers-reduced-motion: reduce)": motion.accessibleFade }, animationTimingFunction: motion.settle },
})

/** Twelve pixels per level, declared once each. */
const INDENT = [styles.depth0, styles.depth1, styles.depth2, styles.depth3, styles.depth4, styles.depth5, styles.depth6, styles.depth7] as const
