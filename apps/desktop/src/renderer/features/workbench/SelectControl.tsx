import { useId, useRef } from "react"
import * as stylex from "@stylexjs/stylex"
import { ChevronUpDownIcon } from "@heroicons/react/20/solid"
import { colors, effects, motion, radius, space, typography } from "../../theme/tokens.stylex.ts"
import { focus } from "../../theme/focus.ts"
import { size } from "../../theme/sizes.stylex.ts"
import { scrollbars } from "../../theme/scrollbars.ts"

export interface SelectOption {
  value: string
  label: string
  /** A mark drawn before the label, on the row and on the trigger while chosen. */
  glyph?: React.JSX.Element | null
  /** A second, quieter word after the label: the provider behind a model. */
  hint?: string
}

/**
 * A select with the composition of Reshaped's Select and the rows of its
 * DropdownMenu: a trigger the shape of a field, and a listbox of rows that
 * can each carry a mark.
 *
 * It used to be a native `<select>`, kept for the platform's popup and keyboard
 * model. The platform's popup is also the reason it went: an `<option>` holds
 * text and nothing else, so a list of models could not show whose model each
 * was, and the popup itself drew in the operating system's own colours over a
 * dark panel. The listbox is ours now, and it earns that by keeping the two
 * things the native control gave for free —
 *
 * - **It is a popover.** The list is a `popover="auto"` shown from a
 *   `popovertarget` button, so it renders in the top layer above the modal's
 *   clipped, scrolling body; a click elsewhere or Escape dismisses it and the
 *   browser hands focus back to the trigger. No document listener, no portal.
 * - **It hangs from its trigger by anchor positioning.** The invoker is a
 *   popover's implicit anchor, so `anchor()` needs no name and no measured
 *   coordinates — which matters here because this renderer's CSP allows no
 *   inline `style`, and a measured `top` would have had to be one.
 *
 * Arrow keys move through the rows and wrap; Home and End jump; Enter or Space
 * picks. Focus opens on the chosen row rather than the first, so the arrows
 * start from where the person already is.
 */
export const SelectControl = ({ id, value, options, onChange, disabled = false, inline = false, ...aria }: {
  id?: string
  value: string
  options: readonly SelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  /** Reshaped's `size="small"`: the dense height and the one width every in-row control shares. */
  inline?: boolean
  "aria-label"?: string
  "aria-labelledby"?: string
  "aria-describedby"?: string
}): React.JSX.Element => {
  const generated = useId()
  const listId = `${id ?? generated}-listbox`
  const list = useRef<HTMLUListElement>(null)
  const current = options.findIndex((option) => option.value === value)
  const selected = current < 0 ? undefined : options[current]

  const rows = (): HTMLButtonElement[] => [...(list.current?.querySelectorAll("button") ?? [])]

  return (
    <span {...stylex.props(styles.root, inline && styles.inline, disabled && styles.disabled)}>
      <button
        id={id}
        type="button"
        disabled={disabled}
        popoverTarget={listId}
        aria-haspopup="listbox"
        aria-controls={listId}
        {...aria}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
          event.preventDefault()
          list.current?.showPopover()
        }}
        {...stylex.props(focus.ring, styles.trigger, inline && styles.triggerInline, selected?.glyph != null && styles.triggerWithGlyph)}
      >
        {selected?.glyph == null ? null : <span aria-hidden="true" {...stylex.props(styles.glyph)}>{selected.glyph}</span>}
        <span {...stylex.props(styles.value)}>{selected?.label ?? ""}</span>
        <ChevronUpDownIcon aria-hidden="true" {...stylex.props(styles.indicator)} />
      </button>
      <ul
        ref={list}
        id={listId}
        role="listbox"
        popover="auto"
        aria-labelledby={aria["aria-labelledby"] ?? id}
        aria-label={aria["aria-label"]}
        /*
          Focus first without scrolling, then centre: letting focus scroll puts
          the chosen row against whichever edge it entered from, so a long model
          catalogue always opened looking accidentally scrolled.
        */
        onToggle={(event) => {
          if (event.newState !== "open") return
          const row = rows()[current < 0 ? 0 : current]
          row?.focus({ preventScroll: true })
          row?.scrollIntoView({ block: "center" })
        }}
        onKeyDown={(event) => {
          const all = rows()
          const at = all.indexOf(document.activeElement as HTMLButtonElement)
          if (event.key === "ArrowDown" || event.key === "ArrowUp") all[(at + (event.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus()
          else if (event.key === "Home") all[0]?.focus()
          else if (event.key === "End") all.at(-1)?.focus()
          else return
          event.preventDefault()
        }}
        {...stylex.props(scrollbars.thin, styles.menu, inline && styles.menuInline)}
      >
        {options.map((option) => {
          const chosen = option.value === value
          return (
            <li key={option.value} role="option" aria-selected={chosen} {...stylex.props(styles.row, chosen && styles.rowChosen)}>
              <button
                type="button"
                tabIndex={-1}
                onClick={() => { list.current?.hidePopover(); if (!chosen) onChange(option.value) }}
                {...stylex.props(focus.ring, styles.rowButton)}
              >
                <span aria-hidden="true" {...stylex.props(styles.glyph)}>{option.glyph ?? null}</span>
                <span {...stylex.props(styles.rowLabel)}>{option.label}</span>
                {option.hint === undefined ? null : <span {...stylex.props(styles.rowHint)}>{option.hint}</span>}
              </button>
            </li>
          )
        })}
      </ul>
    </span>
  )
}

const styles = stylex.create({
  root: { position: "relative", minWidth: 0, width: "100%", display: "inline-grid", alignItems: "center" },
  /**
   * One width, not a width per option list.
   *
   * Sized to content, a column of settings rows ended in a ragged edge —
   * "Medium" at 100, "One at a time" at 130, a model name at 180 — and read as
   * three columns of controls rather than one. A single width lines them up,
   * and it is the same width a single-line text setting takes.
   */
  inline: { width: { default: "100%", "@container (min-width: 400px)": size.controlWidth } },
  disabled: { opacity: 0.66 },
  /** The field: a recess in the surface it sits on, no border and no shadow. */
  trigger: {
    width: "100%", minWidth: 0, height: size.control, boxSizing: "border-box",
    display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", alignItems: "center", gap: space.sm,
    paddingBlock: 0, paddingInlineStart: space.md, paddingInlineEnd: space.sm,
    color: colors.text, backgroundColor: { default: colors.sunken, ":hover": colors.accentSoft, ":disabled": colors.sunken },
    borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.borderStrong, borderRadius: radius.md,
    cursor: { default: "pointer", ":disabled": "not-allowed" }, textAlign: "start",
    transitionProperty: "background-color, box-shadow, color", transitionDuration: motion.fast, transitionTimingFunction: motion.settle,
    fontFamily: typography.ui, fontSize: typography.label, lineHeight: typography.labelLine,
  },
  triggerInline: { height: size.controlDense },
  triggerWithGlyph: { gridTemplateColumns: `${size.icon} minmax(0, 1fr) auto` },
  glyph: { display: "grid", placeItems: "center", width: size.icon, height: size.icon, color: colors.textMuted, pointerEvents: "none" },
  value: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  indicator: { width: "16px", height: "16px", color: colors.textMuted, pointerEvents: "none" },
  /**
   * The list, in the top layer, hung from the trigger's bottom-left corner and
   * at least as wide as it. `positionTryFallbacks` flips it above the trigger
   * when the viewport ends first, which a chooser near the foot of a scrolled
   * panel otherwise does every time.
   */
  menu: {
    /*
      `positionAnchor: "auto"` is stated, not left to its initial value. The
      initial value is meant to be the implicit anchor already, but Electron
      44's Chromium resolved the unstated case to no anchor at all and laid
      every list out at the viewport's origin; saying `auto` is what makes it
      resolve to the button that opened it. One shared `anchor-name` would not
      do: it resolves to the last trigger in the document, so every list hung
      from the bottom select on the panel.
    */
    position: "fixed", positionAnchor: "auto", insetBlockStart: `anchor(bottom)`, insetInlineStart: "anchor(left)", marginBlockStart: space.xs,
    positionTryFallbacks: "flip-block",
    minWidth: "anchor-size(width)", maxWidth: "min(360px, 90vw)", width: "max-content", maxHeight: "304px", overflowY: "auto",
    padding: space.xs, listStyle: "none",
    color: colors.text, backgroundColor: colors.surfaceOverlay, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.borderStrong, borderRadius: radius.lg, boxShadow: effects.liftOverlay,
    // `popover` elements have a UA `inset: 0` and `margin: auto` that would recentre the list.
    insetBlockEnd: "auto", insetInlineEnd: "auto", marginBlockEnd: 0, marginInline: 0,
  },
  menuInline: { minWidth: size.controlWidth },
  row: { display: "block", borderRadius: radius.sm },
  /** Selection is the accent's soft wash across the row, not a trailing check. */
  rowChosen: { backgroundColor: colors.accentSoft },
  rowButton: {
    width: "100%", minHeight: size.controlDense, boxSizing: "border-box", display: "grid", gridTemplateColumns: `${size.icon} minmax(0, 1fr) auto`, alignItems: "center", gap: space.sm,
    paddingBlock: space.xs, paddingInline: space.sm, color: colors.text, backgroundColor: { default: "transparent", ":hover": colors.sunken, ":focus-visible": colors.sunken },
    borderWidth: 0, borderRadius: radius.sm, cursor: "pointer", textAlign: "start",
    fontFamily: typography.ui, fontSize: typography.label, lineHeight: typography.labelLine,
  },
  rowLabel: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  rowHint: { color: colors.textFaint, fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine, whiteSpace: "nowrap" },
})
