import * as stylex from "@stylexjs/stylex"
import { AlertTriangle, Check } from "lucide-react"
import type { ApprovalRequest } from "@bake-pi/contract"
import { store } from "../../store/session-store.ts"
import { colors, effects, motion, radius, space, typography } from "../../theme/tokens.stylex.ts"
import { focus } from "../../theme/focus.ts"
import { size } from "../../theme/sizes.stylex.ts"
import { scrollbars } from "../../theme/scrollbars.ts"

/**
 * Every decision the agent is waiting on, oldest first.
 *
 * `aria-live` because a card that appears while a person is reading the
 * transcript is the one thing in this column that stops the session until it
 * is answered, and a screen reader was told nothing about it. Polite rather
 * than assertive: the turn is already parked, so nothing is lost by letting
 * the current phrase finish.
 *
 * Only the first card takes focus. Every card used to carry `autoFocus`, so a
 * batch of parallel tool calls moved focus to whichever mounted last, and a
 * second call arriving while a person read the first card pulled the keyboard
 * out from under them mid-decision.
 */
export const ApprovalTray = ({ approvals }: { approvals: ApprovalRequest[] }): React.JSX.Element | null => {
  if (approvals.length === 0) return null
  return (
    <aside aria-label="Tool approvals" aria-live="polite" {...stylex.props(scrollbars.thin, styles.tray)}>
      {approvals.map((approval, index) => <ApprovalCard key={approval.id} approval={approval} first={index === 0} />)}
    </aside>
  )
}

const ApprovalCard = ({ approval, first }: { approval: ApprovalRequest; first: boolean }): React.JSX.Element => {
  const decide = (decision: "allow_once" | "allow_for_session" | "deny"): void => {
    void store.decideApproval(approval.id, decision).catch((error: unknown) => store.capture(error))
  }
  return (
    <section
      aria-labelledby={`approval-${approval.id}`}
      /*
        The key the card has been promising. `Deny` has worn an `esc` chip
        since it was written and nothing was listening for it — not here, not
        in `keybindings.ts` — so the one hint on the card was the one thing it
        could not do. Deny rather than dismiss, because this card has no
        dismissal: the tool call is parked on an answer, and the safe answer is
        no. It is scoped to the card, like the question tray's Escape, so it
        cannot reach past the decision a person is looking at.
      */
      onKeyDown={(event) => {
        if (event.key !== "Escape") return
        event.preventDefault()
        decide("deny")
      }}
      {...stylex.props(styles.card)}
    >
      <div {...stylex.props(styles.heading)}>
        <span {...stylex.props(styles.icon)}><AlertTriangle size={18} /></span>
        <div {...stylex.props(styles.request)}>
          <h2 id={`approval-${approval.id}`} {...stylex.props(styles.title)}>{approvalTitle(approval)}</h2>
          {approval.call.targets.length > 0 ? (
            <p {...stylex.props(styles.target)}>
              <code>{approval.call.targets[0]!.path}</code>
              {approval.call.targets.length > 1 ? ` + ${String(approval.call.targets.length - 1)} more` : ""}
            </p>
          ) : <p {...stylex.props(styles.target)}>{reasonText(approval.reason)}</p>}
        </div>
      </div>
      <div {...stylex.props(styles.actions)}>
        <button type="button" onClick={() => decide("deny")} autoFocus={first} {...stylex.props(focus.control, styles.deny)}>Deny <kbd {...stylex.props(styles.key)}>esc</kbd></button>
        <button type="button" onClick={() => decide("allow_for_session")} {...stylex.props(focus.control, styles.secondary)}>Allow for this session</button>
        <button type="button" onClick={() => decide("allow_once")} {...stylex.props(focus.control, styles.allow)}><Check size={15} /> Allow once</button>
      </div>
    </section>
  )
}

const reasonText = (reason: ApprovalRequest["reason"]): string => ({
  workspace_untrusted: "This workspace is untrusted, so every tool requires a decision.",
  outside_workspace: "This tool wants to write or execute outside the open workspace.",
  targets_unknown: "This extension tool did not expose targets the policy can verify.",
}[reason])

const approvalTitle = (approval: ApprovalRequest): string => ({
  workspace_untrusted: `Run ${approval.call.name} in an untrusted workspace`,
  outside_workspace: approval.call.targets.some((target) => target.kind === "write") ? "Write outside the workspace root" : "Work outside the workspace root",
  targets_unknown: `Run ${approval.call.name} with unverified targets`,
}[approval.reason])

/**
 * Declared here rather than shared from the theme because StyleX cannot import
 * keyframes across modules — only a `.stylex.ts` file may export them, and even
 * then the compiler will not resolve the imported name into `animationName`.
 * The duplication is the compiler's, not a choice.
 */
const fadeIn = stylex.keyframes({ from: { opacity: 0 } })

const enterApproval = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(100%)" },
})


const styles = stylex.create({
  /**
   * In the flow between the timeline and the composer, not floating over them.
   *
   * It used to be absolutely positioned at `bottom: 172px` — a number that was
   * the composer's height on the day it was written, and nothing kept the two
   * agreeing. The composer has since changed height twice. Here the tray is
   * simply the middle child of the conversation column, so it sits above the
   * composer because it is declared above it, and the timeline gives up exactly
   * the room the tray takes rather than being covered by it.
   */
  /**
   * Capped and scrolling, because a batch of parallel tool calls raises a card
   * each. Four of them are taller than the conversation column, and since the
   * tray is a `flex: none` sibling of the timeline it took the room rather
   * than sharing it — the transcript the decisions are about disappeared. A
   * scroll keeps every pending decision reachable, which hiding the overflow
   * would not: each of these cards is a turn waiting on an answer.
   */
  tray: { flex: "none", maxHeight: "60vh", overflowY: "auto", zIndex: 5, display: "flex", flexDirection: "column", alignItems: "center", gap: space.sm, paddingInline: size.columnInset, paddingBlockEnd: space.sm },
  /**
   * A solid neutral card carrying one warning mark, rather than a card that is
   * entirely made of warning.
   *
   * The whole surface used to be `warningSoft` with a `warning` outline. Two
   * problems: the outline was the one border left in the conversation, and it
   * was invisible anyway outside high contrast, so the card's shape rested on a
   * fill that also had to carry the alarm. Amber at that area reads as an error
   * banner — but nothing has gone wrong here, somebody is being asked a
   * question. So the card uses one quiet surface and spends its
   * colour on the icon and the primary action, which is where a person looks.
   */
  card: { width: `min(${size.column}, 100%)`, display: "flex", flexDirection: { default: "row", "@media (max-width: 720px)": "column" }, alignItems: { default: "center", "@media (max-width: 720px)": "stretch" }, gap: space.md, padding: space.md, boxSizing: "border-box", color: colors.text, backgroundColor: colors.surfaceRaised, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.borderStrong, borderRadius: radius.lg, boxShadow: effects.liftRaised, animationName: { default: enterApproval, "@media (prefers-reduced-motion: reduce)": fadeIn }, animationDuration: { default: motion.moderate, "@media (prefers-reduced-motion: reduce)": motion.accessibleFade }, animationTimingFunction: motion.settle },
  heading: { minWidth: 0, flex: 1, display: "flex", alignItems: "center", gap: space.md },
  icon: { width: size.control, height: size.control, display: "grid", placeItems: "center", flex: "none", color: colors.warning, backgroundColor: colors.warningSoft, borderRadius: radius.md },
  request: { minWidth: 0 },
  /** Text, not amber. The icon beside it already says which kind of card this is. */
  title: { margin: 0, color: colors.text, fontFamily: typography.display, fontSize: typography.subtitle, lineHeight: typography.subtitleLine, fontWeight: 400 },
  target: { maxWidth: "48ch", marginBlockStart: space.xs, marginBlockEnd: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.textMuted, fontSize: typography.caption },
  actions: { flex: "none", display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: space.sm },
  deny: { minHeight: size.control, display: "inline-flex", alignItems: "center", gap: space.sm, paddingInline: space.lg, color: colors.text, backgroundColor: { default: colors.surface, ":hover": colors.surfaceRaised }, borderWidth: 0, borderRadius: radius.md, cursor: "pointer", fontWeight: 600 },
  key: { color: colors.textFaint, fontFamily: typography.mono, fontSize: typography.micro },
  secondary: { minHeight: size.control, paddingInline: space.lg, color: colors.text, backgroundColor: { default: colors.surface, ":hover": colors.surfaceRaised }, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.borderStrong, borderRadius: radius.md, cursor: "pointer", fontWeight: 600 },
  /**
   * The one saturated thing on the card. `warningSoft` as its label rather than
   * `accentOn`, because `accentOn` is measured for contrast against the accent
   * and this button is amber — the pairing `contrast.test.ts` actually asserts
   * for warning is against its own soft fill.
   */
  allow: { minHeight: size.control, display: "inline-flex", alignItems: "center", gap: space.sm, paddingInline: space.lg, color: colors.warningSoft, backgroundColor: colors.warning, opacity: { default: 1, ":hover": 0.88 }, borderWidth: 0, borderRadius: radius.md, cursor: "pointer", fontWeight: 700 },
})
