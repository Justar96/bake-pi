import { useState } from "react"
import * as stylex from "@stylexjs/stylex"
import { Check, Eye, EyeOff, MessageCircleQuestion, X } from "lucide-react"
import type { ExtensionUiRequest } from "@bake-pi/contract"
import { store } from "../../store/session-store.ts"
import { colors, effects, motion, radius, space, typography } from "../../theme/tokens.stylex.ts"
import { focus } from "../../theme/focus.ts"
import { size } from "../../theme/sizes.stylex.ts"
import { scrollbars } from "../../theme/scrollbars.ts"
import { spinners } from "../../theme/spinners.ts"
import { answersOnEnter, optionKeyTarget, optionShortcut } from "./question-keys.ts"

/**
 * A blocking Pi extension question in the same column as the conversation.
 *
 * The request still resolves through the typed command that matches its kind;
 * this component owns presentation only. Every exit that is not an explicit
 * answer sends the safe empty value, because hiding a request while its promise
 * remains parked would leave the whole turn stuck.
 */
export const QuestionTray = ({ request }: { request: ExtensionUiRequest | undefined }): React.JSX.Element | null => {
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [text, setText] = useState(request?.kind === "editor" ? request.initialText : "")
  const [busy, setBusy] = useState(false)
  // Which option the arrows are on, which is also the one option in the group
  // that Tab can reach: a radio group is one tab stop, not one per choice.
  const [focused, setFocused] = useState(0)
  const [revealed, setRevealed] = useState(false)

  if (request === undefined) return null

  const canAnswer = request.kind === "select"
    ? selected !== undefined
    : request.kind === "input"
      ? text.trim().length > 0
      : true

  const respond = async (accepted: boolean): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      if (request.kind === "confirm") {
        await store.send("respond_confirm", { requestId: request.id, confirmed: accepted })
      } else if (request.kind === "select") {
        await store.send("respond_select", { requestId: request.id, value: accepted ? selected ?? null : null })
      } else if (request.kind === "input") {
        await store.send("respond_input", { requestId: request.id, value: accepted ? text.trim() : null })
      } else {
        await store.send("respond_editor", { requestId: request.id, text: accepted ? text : null })
      }
    } catch (error) {
      setBusy(false)
      store.capture(error)
    }
  }

  const cancel = (): void => { void respond(false) }
  const answer = (): void => { if (canAnswer) void respond(true) }

  return (
    <aside aria-label="Agent question" aria-live="polite" {...stylex.props(styles.tray)}>
      <section
        aria-labelledby={`question-${request.id}`}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault()
            cancel()
            return
          }
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return
          // A footer button pressed with Enter has already answered — the
          // browser turns that press into a click, and answering here as well
          // would make Skip send and Send send twice. An option row is the
          // exception, because Enter in a radio group submits.
          const pressed = event.target as HTMLElement
          if (pressed.tagName === "BUTTON" && pressed.getAttribute("role") !== "radio") return
          if (!answersOnEnter(request.kind, event.ctrlKey || event.metaKey)) return
          event.preventDefault()
          answer()
        }}
        {...stylex.props(styles.card)}
      >
        <header {...stylex.props(styles.header)}>
          <span aria-hidden="true" {...stylex.props(styles.icon)}><MessageCircleQuestion size={17} /></span>
          <div {...stylex.props(styles.heading)}>
            <span {...stylex.props(styles.eyebrow)}>{request.extensionName ?? "Agent needs input"}</span>
            <h2 id={`question-${request.id}`} {...stylex.props(styles.title)}>{request.title}</h2>
          </div>
          <button type="button" aria-label="Skip question" disabled={busy} onClick={cancel} {...stylex.props(focus.control, styles.close)}><X size={14} /></button>
        </header>

        {request.message === undefined || request.message.length === 0 ? null : <p {...stylex.props(styles.message)}>{request.message}</p>}

        {request.kind === "select" ? (
          <div
            role="radiogroup"
            aria-label={request.title}
            onKeyDown={(event) => {
              const target = optionKeyTarget(event.key, focused, request.options.length)
              if (target === undefined) return
              event.preventDefault()
              setFocused(target)
              setSelected(request.options[target]!.value)
              // The DOM rather than a ref per row: the rows are this element's
              // own `radio` children in order, and moving focus is the half of
              // the keyboard model React state cannot express.
              event.currentTarget.querySelectorAll<HTMLButtonElement>(RADIO_ROWS)[target]?.focus()
            }}
            {...stylex.props(scrollbars.thin, styles.options)}
          >
            {request.options.map((option, index) => {
              const on = selected === option.value
              const shortcut = optionShortcut(index)
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  autoFocus={index === 0}
                  tabIndex={index === focused ? 0 : -1}
                  disabled={busy}
                  onClick={() => {
                    setSelected(option.value)
                    setFocused(index)
                  }}
                  {...stylex.props(focus.control, styles.option, on && styles.optionSelected)}
                >
                  <span aria-hidden="true" {...stylex.props(styles.radio, on && styles.radioSelected)}>
                    <span {...stylex.props(styles.radioDot, on && styles.radioDotSelected)} />
                  </span>
                  <span {...stylex.props(styles.optionLabel, on && styles.optionLabelSelected)}>{option.label}</span>
                  {shortcut === undefined ? null : <kbd aria-hidden="true" {...stylex.props(styles.key)}>{shortcut}</kbd>}
                </button>
              )
            })}
          </div>
        ) : request.kind === "input" ? (
          <div {...stylex.props(styles.fieldShell)}>
            <input
              autoFocus
              aria-label="Your answer"
              type={request.secret && !revealed ? "password" : "text"}
              value={text}
              placeholder={request.placeholder ?? "Type your answer…"}
              disabled={busy}
              onChange={(event) => setText(event.target.value)}
              {...stylex.props(focus.control, styles.field, styles.fieldInShell, request.secret && styles.fieldWithAction)}
            />
            {/*
              A secret is masked until it is asked for, and it can be asked
              for. The alternative is a person typing a token they cannot
              proof-read into a field whose only feedback is a count of dots.
            */}
            {request.secret ? (
              <button
                type="button"
                aria-label={revealed ? "Hide answer" : "Show answer"}
                disabled={busy}
                onClick={() => setRevealed((on) => !on)}
                {...stylex.props(focus.control, styles.fieldAction)}
              >
                {revealed ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
              </button>
            ) : null}
          </div>
        ) : request.kind === "editor" ? (
          <div {...stylex.props(styles.fieldShell)}>
            <textarea
              autoFocus
              aria-label={request.language === undefined ? "Your answer" : `Your answer, ${request.language}`}
              rows={6}
              value={text}
              disabled={busy}
              onChange={(event) => setText(event.target.value)}
              {...stylex.props(scrollbars.thin, focus.control, styles.field, styles.fieldInShell, styles.editor)}
            />
            {/*
              The language the request declared, which the renderer has been
              reading off the contract and discarding. It is a note about what
              belongs in the box; the field is a plain textarea and showing the
              word promises no highlighting.
            */}
            {request.language === undefined ? null : <span aria-hidden="true" {...stylex.props(styles.language)}>{request.language}</span>}
          </div>
        ) : null}

        {request.extensionName === undefined ? (
          <p {...stylex.props(styles.provenance)}>A loaded extension asked this question. Pi does not identify which extension called its shared UI.</p>
        ) : null}

        <footer {...stylex.props(styles.footer)}>
          {request.kind === "editor" ? <span {...stylex.props(styles.hint)}>Ctrl or ⌘ and Enter sends</span> : null}
          <button type="button" autoFocus={request.kind === "confirm"} disabled={busy} onClick={cancel} {...stylex.props(focus.control, styles.action, styles.skip)}>
            Skip <kbd aria-hidden="true" {...stylex.props(styles.key)}>esc</kbd>
          </button>
          <button type="button" disabled={busy || !canAnswer} aria-busy={busy} onClick={answer} {...stylex.props(focus.control, styles.action, styles.answer)}>
            {busy ? <span aria-hidden="true" {...stylex.props(spinners.running)} /> : <Check size={14} aria-hidden="true" />}
            {busy ? "Sending…" : request.kind === "confirm" ? "Continue" : "Send answer"}
          </button>
        </footer>
      </section>
    </aside>
  )
}

/** The option rows, as the query that finds them. `role="radio"` is what makes a row a row. */
const RADIO_ROWS = '[role="radio"]'

/**
 * Declared here rather than shared from the theme because StyleX cannot import
 * keyframes across modules — only a `.stylex.ts` file may export them, and even
 * then the compiler will not resolve the imported name into `animationName`.
 * The duplication is the compiler's, not a choice.
 */
const fadeIn = stylex.keyframes({ from: { opacity: 0 } })

const enterQuestion = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(12px) scale(0.98)" },
})


const styles = stylex.create({
  tray: { flex: "none", zIndex: 6, display: "flex", justifyContent: "center", paddingInline: size.columnInset, paddingBlockEnd: space.sm },
  card: { width: `min(${size.column}, 100%)`, boxSizing: "border-box", padding: space.md, color: colors.text, backgroundColor: colors.surfaceRaised, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.borderStrong, borderRadius: radius.lg, boxShadow: effects.liftRaised, animationName: { default: enterQuestion, "@media (prefers-reduced-motion: reduce)": fadeIn }, animationDuration: { default: motion.moderate, "@media (prefers-reduced-motion: reduce)": motion.accessibleFade }, animationTimingFunction: motion.settle },
  header: { display: "flex", alignItems: "flex-start", gap: space.sm },
  icon: { width: "32px", height: "32px", flex: "none", display: "grid", placeItems: "center", color: colors.running, backgroundColor: colors.runningSoft, borderRadius: radius.md },
  heading: { minWidth: 0, flex: 1 },
  eyebrow: { display: "block", marginBlockEnd: "2px", color: colors.textFaint, fontSize: typography.micro, lineHeight: typography.microLine, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" },
  title: { margin: 0, paddingInlineEnd: space.sm, color: colors.text, fontFamily: typography.display, fontSize: typography.subtitle, lineHeight: typography.subtitleLine, fontWeight: 500 },
  close: { width: "28px", height: "28px", flex: "none", display: "grid", placeItems: "center", color: { default: colors.textFaint, ":hover": colors.text }, backgroundColor: { default: "transparent", ":hover": colors.surfaceOverlay }, borderWidth: 0, borderRadius: radius.md, cursor: "pointer", transform: { default: "scale(1)", ":active": "scale(0.96)" }, opacity: { default: 1, ":disabled": 0.45 } },
  message: { marginBlockStart: space.md, marginBlockEnd: 0, color: colors.textMuted, fontSize: typography.body, lineHeight: typography.bodyLine, whiteSpace: "pre-wrap" },
  /**
   * A question may carry 64 options, and the card sits above the composer in a
   * column of fixed height. Without a cap the footer — the only way to answer
   * or to skip — leaves the screen, and the tray has no scroll of its own to
   * bring it back. 40vh keeps the message, several rows and the footer in view
   * at any window height the workbench supports.
   */
  options: { maxHeight: "40vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: space.xs, marginBlockStart: space.md },
  option: { width: "100%", minHeight: "34px", display: "flex", alignItems: "center", gap: space.sm, paddingBlock: space.xs, paddingInline: space.sm, color: colors.textMuted, backgroundColor: { default: "transparent", ":hover": colors.surfaceOverlay }, borderWidth: 0, borderRadius: radius.md, fontFamily: typography.ui, textAlign: "start", cursor: "pointer", transform: { default: "scale(1)", ":active": "scale(0.99)" }, opacity: { default: 1, ":disabled": 0.5 } },
  optionSelected: { backgroundColor: colors.surfaceOverlay },
  radio: { width: "16px", height: "16px", flex: "none", display: "grid", placeItems: "center", color: colors.textFaint, backgroundColor: colors.canvasSubtle, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.borderStrong, borderRadius: radius.pill },
  radioSelected: { color: colors.accentOn, backgroundColor: colors.accent },
  radioDot: { width: "6px", height: "6px", opacity: 0, backgroundColor: colors.accentOn, borderRadius: radius.pill, transform: "scale(0.7)", transitionProperty: "opacity, transform", transitionDuration: motion.fast, transitionTimingFunction: motion.settle },
  radioDotSelected: { opacity: 1, transform: "scale(1)" },
  optionLabel: { flex: 1, minWidth: 0, color: colors.textMuted, fontSize: typography.body, lineHeight: typography.bodyLine },
  optionLabelSelected: { color: colors.text },
  field: { width: "100%", minHeight: "38px", boxSizing: "border-box", marginBlockStart: space.md, paddingBlock: space.sm, paddingInline: space.md, color: colors.text, backgroundColor: colors.sunken, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.borderStrong, borderRadius: radius.md, fontFamily: typography.ui, fontSize: typography.body, lineHeight: typography.bodyLine, resize: "none", opacity: { default: 1, ":disabled": 0.5 } },
  editor: { minHeight: "112px", fontFamily: typography.mono },
  /**
   * The field's own box, so the reveal toggle and the language note can sit in
   * it. The field gives up its top margin to the shell rather than keeping it:
   * an inset measured against a box that includes a 12px margin puts the
   * toggle 6px below the middle of the input it belongs to.
   */
  fieldShell: { position: "relative", marginBlockStart: space.md },
  fieldInShell: { marginBlockStart: 0 },
  fieldWithAction: { paddingInlineEnd: `calc(${size.icon} + ${space.md} + ${space.sm})` },
  fieldAction: { position: "absolute", insetInlineEnd: space.sm, insetBlockStart: "50%", width: size.controlDense, height: size.controlDense, display: "grid", placeItems: "center", padding: 0, color: { default: colors.textFaint, ":hover": colors.text }, backgroundColor: { default: "transparent", ":hover": colors.surfaceOverlay }, borderWidth: 0, borderRadius: radius.sm, cursor: "pointer", transform: "translateY(-50%)", opacity: { default: 1, ":disabled": 0.45 } },
  /** A note in the corner of the box, not a control: the field is a textarea and this is the word for what goes in it. */
  language: { position: "absolute", insetInlineEnd: space.sm, insetBlockStart: space.sm, color: colors.textFaint, fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine, pointerEvents: "none" },
  provenance: { marginBlockStart: space.md, marginBlockEnd: 0, color: colors.textFaint, fontSize: typography.micro, lineHeight: typography.microLine },
  footer: { display: "flex", justifyContent: "flex-end", alignItems: "center", gap: space.sm, marginBlockStart: space.md },
  /** Pushed to the leading edge, because it is a note about the keyboard and not an action. */
  hint: { marginInlineEnd: "auto", color: colors.textFaint, fontSize: typography.micro, lineHeight: typography.microLine },
  action: { minHeight: "34px", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: space.xs, paddingInline: space.md, borderWidth: 0, borderRadius: radius.md, fontFamily: typography.ui, fontSize: typography.label, lineHeight: typography.labelLine, fontWeight: 600, cursor: { default: "pointer", ":disabled": "default" }, transform: { default: "scale(1)", ":active": "scale(0.97)" }, opacity: { default: 1, ":disabled": 0.45 } },
  skip: { color: colors.textMuted, backgroundColor: { default: "transparent", ":hover": colors.surfaceOverlay } },
  answer: { color: colors.accentOn, backgroundColor: { default: colors.accent, ":hover": colors.accentHover } },
  /**
   * The key that does this, in the shape of a key. The approval card's Deny
   * wears `esc` the same way, which is the point: two cards that both answer
   * Escape say so in one language.
   */
  key: { color: colors.textFaint, fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine },
})
