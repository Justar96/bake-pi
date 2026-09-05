import { useEffect, useMemo, useRef, useState } from "react"
import * as stylex from "@stylexjs/stylex"
import { Search } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { colors, effects, motion, radius, space, typography } from "../../theme/tokens.stylex.ts"
import { focus } from "../../theme/focus.ts"
import { size } from "../../theme/sizes.stylex.ts"
import { scrollbars } from "../../theme/scrollbars.ts"

/**
 * The command palette: the workbench's whole verb list behind one keystroke.
 *
 * The shape is the reference command menu's — a search line, grouped rows,
 * the active command's own key printed at the row's end — set in this
 * interface's vocabulary: overlay surface, no rules drawn, state by fill.
 *
 * Focus stays in the input for the life of the palette, and the active row is
 * `aria-activedescendant` rather than a real focus move — the same contract
 * the composer's token menu keeps, chosen for the same reason: arrow keys that
 * move a highlight without moving the caret are the behaviour a person typing
 * a filter expects, and a screen reader announces the row either way.
 *
 * The registry decides what is offered; the palette renders what it is given
 * and runs what is picked. Every run closes the palette — a command that
 * leaves it open would be a command with a hidden effect.
 */
export interface PaletteEntry {
  id: string
  title: string
  group: string
  icon: LucideIcon
  keys: string[]
  run: () => void
}

export const CommandPalette = ({ entries, onClose }: { entries: PaletteEntry[]; onClose: () => void }): React.JSX.Element => {
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)

  const lowered = query.trim().toLowerCase()
  const rows = useMemo(
    () => entries.filter((entry) => lowered === "" || entry.title.toLowerCase().includes(lowered)),
    [entries, lowered],
  )

  /* A fresh filter is a fresh list: the highlight returns to the top rather
     than pointing at a row that no longer exists. */
  useEffect(() => { setActive(0) }, [query])
  useEffect(() => { input.current?.focus() }, [])
  /* The highlight can run past either edge; the list follows it. */
  useEffect(() => {
    list.current?.querySelectorAll("[data-row]")[active]?.scrollIntoView({ block: "nearest" })
  }, [active, rows.length])

  const run = (entry: PaletteEntry): void => {
    entry.run()
    onClose()
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (rows.length > 0) setActive((current) => (current + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length)
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      const row = rows[active]
      if (row !== undefined) run(row)
      return
    }
    if (event.key === "Escape") {
      // The palette's own Escape ends at the palette: a rail behind it is not
      // listening for a key that was aimed here.
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
  }

  return (
    // A mousedown on the scrim itself is a close; one that lands on the card
    // is not, which `currentTarget` tells apart.
    <div onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }} {...stylex.props(styles.scrim)}>
      <section role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown} {...stylex.props(styles.card)}>
        <div {...stylex.props(styles.inputRow)}>
          <Search size={15} aria-hidden="true" {...stylex.props(styles.inputIcon)} />
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Type a command or search…"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={rows.length === 0 ? undefined : `palette-row-${String(active)}`}
            aria-label="Search commands"
            {...stylex.props(styles.input)}
          />
        </div>

        <ul id="palette-list" role="listbox" aria-label="Commands" ref={list} {...stylex.props(scrollbars.thin, styles.list)}>
          {rows.length === 0 ? <li {...stylex.props(styles.empty)}>No matching commands.</li> : rows.flatMap((row, index) => {
            const items = []
            // A group header wherever the group changes, so a filtered list
            // never shows a heading with nothing under it.
            if (index === 0 || rows[index - 1]!.group !== row.group) {
              items.push(<li key={`header-${row.group}`} role="presentation" {...stylex.props(styles.groupLabel)}>{row.group}</li>)
            }
            items.push(
              <li key={row.id} role="option" id={`palette-row-${String(index)}`} aria-selected={index === active} {...stylex.props(styles.row, index === active && styles.rowActive)}>
                {/*
                  The pick happens on `onMouseDown`, not `onClick` — the
                  composer's menu rule. A click blurs the input first, and the
                  palette has no reason to spend a blur before it acts.
                */}
                <button type="button" tabIndex={-1} data-row onMouseEnter={() => setActive(index)} onMouseDown={(event) => { event.preventDefault(); run(row) }} {...stylex.props(focus.ring, styles.rowButton)}>
                  <row.icon size={14} aria-hidden="true" {...stylex.props(styles.rowIcon)} />
                  <span {...stylex.props(styles.rowLabel)}>{row.title}</span>
                  {row.keys[0] === undefined ? null : <span {...stylex.props(styles.kbd)}>{row.keys[0]}</span>}
                </button>
              </li>,
            )
            return items
          })}
        </ul>

        <div {...stylex.props(styles.foot)}>
          <span>↑↓ to choose · Enter to run · Esc to close</span>
        </div>
      </section>
    </div>
  )
}

/**
 * The palette drops in from where it lives rather than growing from its
 * centre: a command surface arrives from the top of the window, the way the
 * composer's menus grow from the bottom. Reduced motion keeps only the fade —
 * which is the scrim's own enter, so the two share one keyframes rather than
 * declaring the same fade twice.
 */

/**
 * Declared here rather than shared from the theme because StyleX cannot import
 * keyframes across modules — only a `.stylex.ts` file may export them, and even
 * then the compiler will not resolve the imported name into `animationName`.
 * The duplication is the compiler's, not a choice.
 */
const fadeIn = stylex.keyframes({ from: { opacity: 0 } })

const enterPalette = stylex.keyframes({ from: { opacity: 0, transform: "translateY(-6px)" } })

const styles = stylex.create({
  scrim: {
    position: "fixed", inset: 0, zIndex: 50,
    display: "flex", justifyContent: "center", alignItems: "flex-start",
    paddingBlockStart: "18vh", paddingInline: space.xl,
    backgroundColor: effects.scrim,
    animationName: fadeIn,
    animationDuration: { default: motion.moderate, "@media (prefers-reduced-motion: reduce)": motion.accessibleFade },
    animationTimingFunction: motion.settle,
  },
  card: {
    width: "min(520px, 100%)", maxHeight: "60vh",
    display: "flex", flexDirection: "column", overflow: "hidden",
    backgroundColor: colors.surfaceOverlay, borderRadius: radius.lg, boxShadow: effects.liftOverlay,
    animationName: { default: enterPalette, "@media (prefers-reduced-motion: reduce)": fadeIn },
    animationDuration: { default: motion.moderate, "@media (prefers-reduced-motion: reduce)": motion.accessibleFade },
    animationTimingFunction: motion.settle,
  },

  inputRow: { flex: "none", display: "flex", alignItems: "center", gap: space.sm, paddingInline: space.md, paddingBlock: space.md },
  inputIcon: { flex: "none", color: colors.textFaint },
  input: { flex: 1, minWidth: 0, padding: 0, color: colors.text, "::placeholder": { color: colors.textFaint }, backgroundColor: "transparent", borderWidth: 0, outline: "none", fontFamily: typography.ui, fontSize: typography.body, lineHeight: typography.bodyLine, caretColor: colors.accent },

  list: { flex: 1, minHeight: 0, maxHeight: "320px", overflowY: "auto", margin: 0, padding: space.xs, paddingBlockStart: 0, listStyle: "none" },
  /** The same eyebrow the rails put over their groups. */
  groupLabel: { paddingInline: space.sm, paddingBlockStart: space.sm, paddingBlockEnd: space.xs, color: colors.textFaint, fontSize: typography.micro, lineHeight: typography.microLine, fontWeight: 700, letterSpacing: "0.09em", textTransform: "uppercase" },
  row: { display: "block", borderRadius: radius.sm },
  /** A fill, not an outline: the menu convention, at the palette's size. */
  rowActive: { backgroundColor: colors.sunken },
  rowButton: { width: "100%", height: size.controlDense, display: "flex", alignItems: "center", gap: space.sm, paddingInline: space.sm, color: colors.text, backgroundColor: "transparent", borderWidth: 0, borderRadius: radius.sm, cursor: "pointer", textAlign: "start", fontFamily: typography.ui, fontSize: typography.label },
  rowIcon: { flex: "none", color: colors.textFaint },
  rowLabel: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  /** A keycap: the chord the row would also answer to, on the smallest seat. */
  kbd: { flex: "none", paddingBlock: "1px", paddingInline: "6px", color: colors.textFaint, backgroundColor: colors.sunken, borderRadius: radius.sm, fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine },
  empty: { paddingBlock: space.md, paddingInline: space.sm, color: colors.textFaint, fontSize: typography.caption },

  foot: { flex: "none", display: "flex", justifyContent: "flex-end", paddingBlock: space.xs, paddingInline: space.md, color: colors.textFaint, fontSize: typography.micro, lineHeight: typography.microLine },
})
