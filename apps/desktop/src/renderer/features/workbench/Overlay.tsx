import { useEffect, useId, useRef } from "react"
import * as stylex from "@stylexjs/stylex"
import { X } from "lucide-react"
import { colors, effects, motion, radius, space, typography } from "../../theme/tokens.stylex.ts"
import { focus } from "../../theme/focus.ts"
import { size } from "../../theme/sizes.stylex.ts"
import { scrollbars } from "../../theme/scrollbars.ts"

/**
 * The modal surface that opens over the workspace, and its control vocabulary.
 *
 * Settings and session history use this surface because they temporarily take
 * over the workspace. The activity rail remains contextual and non-blocking;
 * these panels get a scrim and trapped focus instead.
 *
 * The shell is `surfaceOverlay`, because that is what the token is for — the
 * palette calls it "menus, popovers, dialogs".
 *
 * The heading is an eyebrow over a display line, which is the one place this
 * interface can afford editorial scale: a panel holds a single heading and
 * nothing competes with it, so a tracked uppercase word above the title can say
 * which family of things the panel belongs to in eleven pixels rather than in a
 * sentence. It is also what lets the title itself stay short.
 *
 * A panel whose body is a set of views — settings, with its section index —
 * names the current view in that title and its purpose in the `subtitle`
 * beneath, and puts the one control that acts on the whole view in `aside`.
 * Both exist because the alternative was observed: every section repeated its
 * own `h3` and its own lede below a header that already said "Settings", and
 * carried a refresh button of its own wording in its own position. Three
 * heading levels for one question, and a control that moved when the view did.
 * One title that changes, one line under it, one control beside it.
 */

/**
 * Controls shared by modal surfaces.
 *
 * Form controls use `sunken` or `accentSoft`, and that is not a preference. On
 * a `surfaceOverlay` header or modal those are the tokens that still read as a
 * step in both themes. Both approaches keep shape in the fill and elevation
 * rather than a decorative border.
 */
export const overlay = stylex.create({
  /** The line under a title that says what the panel is for. Never a paragraph. */
  lede: { maxWidth: size.measure, marginBlock: 0, color: colors.textMuted, fontSize: typography.body, lineHeight: typography.bodyLine },
  /**
   * A group heading inside a body: "Use an API key", "Recent entries".
   *
   * Tracked uppercase at the micro size rather than a second `h3` in the UI
   * sans, because a panel that titles itself at display scale and then sets its
   * sections in bold 13.5 has two heading systems inside a compact panel.
   */
  groupLabel: { marginBlock: 0, color: colors.textMuted, fontSize: typography.micro, lineHeight: typography.microLine, fontWeight: 600, letterSpacing: "0.09em", textTransform: "uppercase" },
  fieldLabel: { color: colors.textMuted, fontSize: typography.micro, lineHeight: typography.microLine, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" },
  /** A field is a well; focus deepens its seat without drawing around it. */
  field: {
    width: "100%", minHeight: size.control, boxSizing: "border-box",
    paddingBlock: space.xs, paddingInline: space.md,
    color: colors.text, backgroundColor: colors.sunken,
    borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.border, borderRadius: radius.md,
    fontFamily: typography.ui, fontSize: typography.body, lineHeight: typography.bodyLine,
  },
  /** The ordinary button on a panel: 36px, and the same well the fields are. */
  action: {
    minHeight: size.control, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: space.sm,
    paddingInline: space.md, boxSizing: "border-box",
    color: colors.text,
    backgroundColor: { default: colors.sunken, ":hover": colors.accentSoft },
    borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.border, borderRadius: radius.md,
    cursor: { default: "pointer", ":disabled": "not-allowed" }, opacity: { default: 1, ":disabled": 0.5 },
    transform: { default: "scale(1)", ":active": "scale(0.97)" },
    transitionProperty: "background-color, box-shadow, transform", transitionDuration: motion.fast, transitionTimingFunction: motion.settle,
    fontFamily: typography.ui, fontSize: typography.label, lineHeight: typography.labelLine, fontWeight: 600,
  },
  /**
   * The one filled button, at the same 36px.
   *
   * `controlTall` belongs to an empty state, where a single button carries a
   * whole screen. Inside a panel it is a button that has outgrown its panel.
   */
  actionPrimary: {
    color: colors.accentOn,
    backgroundColor: { default: colors.accent, ":hover": colors.accentHover },
    borderWidth: 0,
  },
  /** A row inside a body: a provider, a log entry, a block of facts. */
  well: { paddingBlock: space.sm, paddingInline: space.md, backgroundColor: colors.sunken, borderRadius: radius.md },
})

export const Modal = ({ id, eyebrow, title, subtitle, onClose, closeLabel, aside, medium = false, wide = false, contained = false, children }: {
  id?: string
  /** Omitted by a panel whose index already names the family — settings puts it above its section list. */
  eyebrow?: string
  title: string
  subtitle?: string
  onClose: () => void
  closeLabel: string
  aside?: React.ReactNode
  medium?: boolean
  wide?: boolean
  contained?: boolean
  children: React.ReactNode
}): React.JSX.Element => {
  const dialog = useDialogFocus(onClose)
  const headingId = useId()
  return (
    <div onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }} {...stylex.props(styles.scrim, styles.modalScrim)}>
      <section id={id} ref={dialog} role="dialog" aria-modal="true" aria-labelledby={eyebrow === undefined ? `${headingId}-title` : `${headingId}-eyebrow ${headingId}-title`} {...stylex.props(styles.modal, medium && styles.modalMedium, wide && styles.modalWide)}>
        <Heading id={headingId} eyebrow={eyebrow} title={title} subtitle={subtitle} onClose={onClose} closeLabel={closeLabel} aside={aside} />
        <div {...stylex.props(scrollbars.thin, styles.body, styles.modalBody, contained && styles.containedBody)}>{children}</div>
      </section>
    </div>
  )
}

/**
 * No rule under it, on either surface.
 *
 * The header is told from the body by the air below it and by the body
 * scrolling under it, which is how every other header in this interface is told
 * from the thing it heads.
 */
const Heading = ({ id, eyebrow, title, subtitle, onClose, closeLabel, aside }: {
  id: string
  eyebrow?: string | undefined
  title: string
  subtitle?: string | undefined
  onClose: () => void
  closeLabel: string
  aside?: React.ReactNode
}): React.JSX.Element => (
  <header {...stylex.props(styles.header)}>
    <span {...stylex.props(styles.heading)}>
      {eyebrow === undefined ? null : <span id={`${id}-eyebrow`} {...stylex.props(styles.eyebrow)}>{eyebrow}</span>}
      <h2 id={`${id}-title`} {...stylex.props(styles.title)}>{title}</h2>
      {subtitle === undefined ? null : <p {...stylex.props(styles.subtitle)}>{subtitle}</p>}
    </span>
    <span {...stylex.props(styles.headerControls)}>
      {aside}
      <button type="button" onClick={onClose} aria-label={closeLabel} {...stylex.props(focus.ring, styles.close)}><X size={16} /></button>
    </span>
  </header>
)

const focusableSelector = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])"

/**
 * Focus goes in, stays in, and comes back out where it started.
 *
 * `onClose` is held in a ref rather than in the dependency list because the
 * effect installs a document-level key handler and restores focus when it tears
 * down: a caller passing a fresh closure each render would otherwise reinstall
 * the handler and re-steal focus on every keystroke typed into the panel.
 */
export const useDialogFocus = (onClose: () => void): React.RefObject<HTMLElement | null> => {
  const dialog = useRef<HTMLElement>(null)
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const current = dialog.current
    /*
      The first focusable is the close button, because the heading comes first
      in the document and has to — an overlay whose title is not the first thing
      announced is an overlay a screen reader describes by its dismiss control.
      So a panel that has a field worth answering says so with `data-autofocus`,
      and everything else takes the first control in the header — the dismiss
      control, unless the panel put something beside it — which is the right
      landing place for a list.
    */
    const initial = current?.querySelector<HTMLElement>("[data-autofocus]") ?? current?.querySelector<HTMLElement>(focusableSelector)
    initial?.focus()

    const keydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault()
        close.current()
        return
      }
      if (event.key !== "Tab" || current === null) return
      const focusable = [...current.querySelectorAll<HTMLElement>(focusableSelector)]
      if (focusable.length === 0) return
      const first = focusable[0]!
      const last = focusable.at(-1)!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener("keydown", keydown)
    return () => {
      document.removeEventListener("keydown", keydown)
      previous?.focus()
    }
  }, [])

  return dialog
}

/**
 * The dialog and its scrim enter from where they live.
 *
 * The dialog grows from its own centre and the scrim fades. Reduced motion keeps only that opacity cue:
 * less movement does not have to mean a state change with no acknowledgement.
 *
 * Entrances only. These panels are unmounted when they close — the exit would
 * need the element kept alive past the decision to remove it, which is state
 * held for the sake of an animation. The motion scale already says an exit
 * should be quicker than its entrance; here it is quickest.
 */

/**
 * Declared here rather than shared from the theme because StyleX cannot import
 * keyframes across modules — only a `.stylex.ts` file may export them, and even
 * then the compiler will not resolve the imported name into `animationName`.
 * The duplication is the compiler's, not a choice.
 */
const fadeIn = stylex.keyframes({ from: { opacity: 0 } })

const enterModal = stylex.keyframes({ from: { opacity: 0, transform: "scale(0.96)" } })

const styles = stylex.create({
  scrim: {
    position: "fixed", insetBlockEnd: 0, insetInlineStart: 0, insetInlineEnd: 0, backgroundColor: effects.scrim,
    animationName: fadeIn,
    animationDuration: { default: motion.moderate, "@media (prefers-reduced-motion: reduce)": motion.accessibleFade },
    animationTimingFunction: motion.settle,
  },
  modalScrim: { insetBlockStart: 0, zIndex: 50, display: "grid", placeItems: "center", padding: { default: space.xl, "@media (max-width: 640px)": space.sm } },
  /**
   * 520px rather than 600, and a height it cannot exceed.
   *
   * Everything a dialog holds is one question and one control — a select, a
   * line of text, at most an editor — and 600px of measure for one question is
   * a paragraph's width spent on a label. The `maxHeight` is what keeps the
   * editor variant from growing into a full-height panel; the body scrolls
   * inside the surface instead of the surface growing past the viewport.
   */
  modal: {
    width: "min(520px, 100%)", maxHeight: "min(560px, 84vh)",
    display: "flex", flexDirection: "column",
    color: colors.text, backgroundColor: colors.surfaceOverlay,
    borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.borderStrong,
    borderRadius: radius.lg, boxShadow: effects.liftOverlay,
    animationName: { default: enterModal, "@media (prefers-reduced-motion: reduce)": fadeIn },
    animationDuration: { default: motion.moderate, "@media (prefers-reduced-motion: reduce)": motion.accessibleFade },
    animationTimingFunction: motion.settle,
  },
  /** A little more measure for dialogs that compare two peer workflows. */
  modalMedium: { width: "min(720px, 100%)", maxHeight: "min(680px, calc(100dvh - 48px))" },
  /**
   * A height, not a ceiling.
   *
   * The wide modal is the one that holds several views behind a section index,
   * and a ceiling let it take the height of whichever view was showing:
   * Diagnostics collapsed it to two thirds of what Agent filled, so switching
   * sections resized the dialog and — centred in the scrim — moved it up the
   * screen as well. The index beside the body has to stay put for the whole
   * time a person is choosing from it, so the panel is one size and the body
   * scrolls inside it.
   */
  /**
   * A size, and the release of the ceiling above it.
   *
   * `maxHeight: none` is load-bearing rather than tidy: the base `modal` caps
   * at 560px, so declaring a height here without lifting that cap left the
   * wide panel exactly 560px tall and the extra height silently discarded.
   * The height below already clamps itself to the viewport, which is the job
   * the cap was doing.
   */
  modalWide: { width: "min(1120px, 100%)", height: "min(880px, calc(100dvh - 48px))", maxHeight: "none" },

  header: { flex: "none", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: space.lg, paddingInlineStart: space.xl, paddingInlineEnd: space.md, paddingBlockStart: space.lg, paddingBlockEnd: space.md },
  heading: { minWidth: 0, display: "flex", flexDirection: "column", gap: space.xs },
  /**
   * `textMuted`, not `textFaint`.
   *
   * An eyebrow is the only thing naming the family a panel belongs to, and
   * `textFaint` is asserted at the large-text threshold on the canvas and the
   * rails — not on `surfaceOverlay`, where at eleven pixels it would not clear
   * it.
   */
  eyebrow: { color: colors.textMuted, fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine, fontWeight: 600, letterSpacing: "0.09em", textTransform: "uppercase" },
  /**
   * `title`, at regular weight.
   *
   * Nineteen pixels gives Geist enough room to read as an editorial heading
   * without turning a compact utility panel into an empty state. Regular weight
   * keeps the eyebrow above it as the hierarchy's emphatic line.
   */
  title: { margin: 0, fontFamily: typography.display, fontSize: typography.title, lineHeight: typography.titleLine, letterSpacing: "-0.008em", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis" },
  /**
   * The purpose line, at body scale rather than caption.
   *
   * It is the only prose in the header and it is read once, on arrival; setting
   * it at 11.5 to keep the header short makes the one sentence that explains
   * the panel the smallest type on it. `measure` caps it so a long section
   * description wraps rather than running the header out to the modal's width
   * and pushing the refresh control into the title.
   */
  subtitle: { maxWidth: size.measure, marginBlock: 0, color: colors.textMuted, fontSize: typography.body, lineHeight: typography.bodyLine },
  /** The header's control cluster: whatever acts on the whole panel, then dismiss. */
  headerControls: { flex: "none", display: "flex", alignItems: "center", gap: space.xs },
  /**
   * Hover is `accentSoft` rather than `surfaceOverlay`, which is what this
   * button used to hover to: the same colour as the panel it sits on, which is
   * to say no hover at all.
   */
  close: {
    flex: "none", width: size.controlDense, height: size.controlDense, display: "grid", placeItems: "center", padding: 0,
    color: { default: colors.textMuted, ":hover": colors.text },
    backgroundColor: { default: colors.sunken, ":hover": colors.accentSoft },
    borderWidth: 0, borderRadius: radius.sm, cursor: "pointer",
    transform: { default: "scale(1)", ":active": "scale(0.94)" },
    transitionProperty: "background-color, box-shadow, color, transform", transitionDuration: motion.fast, transitionTimingFunction: motion.settle,
  },

  body: { flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: space.md, paddingInline: space.xl, paddingBlockEnd: space.xl },
  modalBody: { gap: space.md, paddingBlockEnd: space.sm },
  containedBody: { overflowY: "hidden", paddingInline: 0, paddingBlockEnd: 0 },
})
