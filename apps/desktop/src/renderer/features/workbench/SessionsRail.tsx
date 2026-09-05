import * as stylex from "@stylexjs/stylex"
import { MessageSquare } from "lucide-react"
import type { SessionSummary } from "@bake-pi/contract"
import { store, type WorkbenchView } from "../../store/session-store.ts"
import type { SessionCoreSnapshot } from "../../store/session-projection.ts"
import { colors, effects, radius, space, typography } from "../../theme/tokens.stylex.ts"
import { focus } from "../../theme/focus.ts"
import { Modal } from "./Overlay.tsx"
import { size } from "../../theme/sizes.stylex.ts"
import { THINKING_LABELS } from "../conversation/thinking-level.ts"
import { formatSessionTime, groupSessions, messageCountLabel, sessionStatusLabel } from "./session-list.ts"
import { LabIcon } from "../../ui/LabIcon.tsx"
import { labMarkForModel } from "../../ui/lab-icons.ts"

/** Saved Pi conversations, in a modal beside but separate from Settings. */
export const SessionsModal = ({ state, onClose }: { state: WorkbenchView; onClose: () => void }): React.JSX.Element => {
  const groups = groupSessions(state.sessionList, new Set(Object.keys(state.sessions)))
  const sessionCount = state.sessionList.length

  return (
    <Modal id="sessions-modal" eyebrow="Workspace" title="Sessions" onClose={onClose} closeLabel="Close sessions">
      <nav aria-label="Sessions" {...stylex.props(styles.content)}>
        <p {...stylex.props(styles.lede)}>Open a recent Pi conversation or return to one already attached to this workspace.</p>
        {sessionCount === 0 ? (
          <div {...stylex.props(styles.empty)}>
            <MessageSquare size={18} aria-hidden="true" {...stylex.props(styles.emptyGlyph)} />
            <span {...stylex.props(styles.rowText)}>
              <span {...stylex.props(styles.rowTitle)}>No saved sessions yet</span>
              <span {...stylex.props(styles.quiet)}>Start a conversation and it will appear here automatically.</span>
            </span>
          </div>
        ) : (
          <>
            {groups.open.length > 0 ? <SessionGroup id="open-sessions" title="Open" sessions={groups.open} state={state} onSelect={onClose} /> : null}
            {groups.saved.length > 0 ? <SessionGroup id="saved-sessions" title="Saved" sessions={groups.saved} state={state} onSelect={onClose} afterOpen={groups.open.length > 0} /> : null}
          </>
        )}
      </nav>
    </Modal>
  )
}

const SessionGroup = ({
  id,
  title,
  sessions,
  state,
  onSelect,
  afterOpen = false,
}: {
  id: string
  title: string
  sessions: SessionSummary[]
  state: WorkbenchView
  onSelect: () => void
  afterOpen?: boolean
}): React.JSX.Element => (
  <section aria-labelledby={id} {...stylex.props(styles.section, afterOpen && styles.sectionAfterOpen)}>
    <div {...stylex.props(styles.sectionHeading)}>
      <h3 id={id} {...stylex.props(styles.sectionTitle)}>{title}</h3>
      <span aria-hidden="true" {...stylex.props(styles.sectionCount)}>{sessions.length}</span>
    </div>
    <ul {...stylex.props(styles.list)}>
      {sessions.map((session) => <SessionRow key={session.id} session={session} state={state} onSelect={onSelect} />)}
    </ul>
  </section>
)

const SessionRow = ({ session, state, onSelect }: { session: SessionSummary; state: WorkbenchView; onSelect: () => void }): React.JSX.Element => {
  const current = state.activeSessionId === session.id
  const snapshot = state.sessions[session.id]?.snapshot
  const timestamp = formatSessionTime(session.updatedAt)
  const model = snapshot === undefined
    ? undefined
    : state.models.find(({ id, providerId }) => id === snapshot.model.modelId && providerId === snapshot.model.providerId)
  const provider = snapshot === undefined
    ? undefined
    : state.providers.find(({ id }) => id === snapshot.model.providerId)
  const modelName = model?.displayName ?? snapshot?.model.modelId
  const thinking = snapshot === undefined || snapshot.model.thinkingLevel === "off"
    ? undefined
    : `${THINKING_LABELS[snapshot.model.thinkingLevel]} thinking`

  return (
    <li>
      <button
        type="button"
        aria-current={current ? "page" : undefined}
        onClick={() => {
          store.selectSession(session.id)
          onSelect()
        }}
        {...stylex.props(focus.control, styles.row, current && styles.rowSelected)}
      >
        <span {...stylex.props(styles.rowHead)}>
          <span title={session.title || "Untitled session"} {...stylex.props(styles.rowTitle)}>{session.title || "Untitled session"}</span>
          {snapshot === undefined ? null : <SessionState snapshot={snapshot} current={current} />}
        </span>
        <span {...stylex.props(styles.rowMeta)}>
          <span>{messageCountLabel(session.messageCount)}</span>
          <span aria-hidden="true" {...stylex.props(styles.metaSeparator)}>·</span>
          <time {...(timestamp.dateTime === undefined ? {} : { dateTime: timestamp.dateTime })} title={timestamp.full} {...stylex.props(styles.rowTime)}>{timestamp.label}</time>
        </span>
        {snapshot === undefined ? null : (
          <span title={`${provider?.displayName ?? snapshot.model.providerId} / ${modelName}${thinking === undefined ? "" : ` · ${thinking}`}`} {...stylex.props(styles.rowRuntime)}>
            {/*
              The mark leads the line because the provider name after it is the
              first thing a narrow rail drops, and the lab is the half of
              "OpenRouter / claude-sonnet-5" that a person is actually
              scanning for. It survives the width the words do not.
            */}
            <LabIcon mark={labMarkForModel({ id: snapshot.model.modelId, providerId: snapshot.model.providerId })} size="micro" />
            <span {...stylex.props(styles.runtimeProvider)}>{provider?.displayName ?? snapshot.model.providerId}<span aria-hidden="true"> / </span></span>
            <span>{modelName}</span>
            {thinking === undefined ? null : <><span aria-hidden="true" {...stylex.props(styles.metaSeparator)}>·</span><span>{thinking}</span></>}
          </span>
        )}
      </button>
    </li>
  )
}

const SessionState = ({ snapshot, current }: { snapshot: SessionCoreSnapshot; current: boolean }): React.JSX.Element => (
  <span
    {...stylex.props(
      styles.rowState,
      current && snapshot.status === "idle" && styles.rowStateCurrent,
      (snapshot.status === "streaming" || snapshot.status === "compacting" || snapshot.status === "retrying") && styles.rowStateWorking,
      snapshot.status === "awaiting_approval" && styles.rowStateAttention,
      (snapshot.status === "disconnected" || snapshot.status === "quarantined") && styles.rowStateUnavailable,
    )}
  >
    {sessionStatusLabel(snapshot.status, current)}
  </span>
)

const styles = stylex.create({
  content: { containerType: "inline-size", display: "flex", flexDirection: "column", gap: space.lg },
  lede: { maxWidth: size.measure, margin: 0, color: colors.textMuted, fontSize: typography.body, lineHeight: typography.bodyLine },
  section: { minWidth: 0 },
  sectionAfterOpen: { marginBlockStart: space.sm },
  sectionHeading: { position: "sticky", insetBlockStart: 0, zIndex: 1, height: size.controlDense, display: "flex", alignItems: "center", gap: space.sm, paddingInline: space.sm, backgroundColor: colors.surfaceOverlay },
  sectionTitle: { flex: 1, margin: 0, color: colors.textMuted, fontSize: typography.micro, lineHeight: typography.microLine, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" },
  sectionCount: { minWidth: "20px", paddingInline: space.xs, color: colors.textMuted, backgroundColor: colors.sunken, borderRadius: radius.md, textAlign: "center", fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine },
  list: { display: "flex", flexDirection: "column", gap: space.xs, margin: 0, padding: 0, listStyle: "none" },
  row: { width: "100%", minHeight: "56px", boxSizing: "border-box", display: "flex", flexDirection: "column", gap: space.xs, paddingBlock: space.sm, paddingInline: space.md, color: { default: colors.textMuted, ":hover": colors.text }, backgroundColor: { default: colors.surface, ":hover": colors.surfaceRaised, ":active": colors.sunken }, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.border, borderRadius: radius.md, boxShadow: effects.lift, cursor: "pointer", textAlign: "start" },
  /**
   * Selected is a lift, not a recess: one step above the hover fill, with the
   * same seat the active segment in settings and activity takes.
   */
  rowSelected: { color: colors.text, backgroundColor: { default: colors.surfaceRaised, ":hover": colors.surfaceRaised, ":active": colors.surfaceRaised }, boxShadow: effects.lift },
  rowHead: { minWidth: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", alignItems: "center", gap: space.sm },
  rowText: { minWidth: 0, display: "flex", flexDirection: "column", gap: "2px" },
  rowTitle: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.text, fontSize: typography.label, lineHeight: typography.labelLine, fontWeight: 600 },
  rowMeta: { minWidth: 0, display: "flex", alignItems: "center", gap: space.xs, overflow: "hidden", color: colors.textMuted, fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine, whiteSpace: "nowrap" },
  metaSeparator: { flex: "none", color: colors.textFaint },
  rowTime: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
  rowRuntime: { minWidth: 0, display: "flex", alignItems: "center", gap: space.xs, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.textMuted, fontSize: typography.caption, lineHeight: typography.captionLine },
  runtimeProvider: { display: { default: "none", "@container (min-width: 400px)": "inline" } },
  /** A word always accompanies the monochrome fill, so no status depends on colour. */
  rowState: { flex: "none", minWidth: size.controlMicro, height: "20px", boxSizing: "border-box", display: "inline-flex", alignItems: "center", justifyContent: "center", paddingInline: space.sm, color: colors.textMuted, backgroundColor: colors.sunken, borderRadius: radius.md, fontSize: typography.micro, lineHeight: typography.microLine, fontWeight: 600 },
  rowStateCurrent: { color: colors.accentOn, backgroundColor: colors.accent },
  rowStateWorking: { color: colors.running, backgroundColor: colors.runningSoft },
  rowStateAttention: { color: colors.warning, backgroundColor: colors.warningSoft },
  rowStateUnavailable: { color: colors.danger, backgroundColor: colors.dangerSoft },
  empty: { display: "flex", alignItems: "flex-start", gap: space.sm, padding: space.lg, backgroundColor: colors.surface, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.border, borderRadius: radius.lg, boxShadow: effects.lift },
  emptyGlyph: { flex: "none", color: colors.textMuted },
  quiet: { margin: 0, color: colors.textMuted, fontSize: typography.caption, lineHeight: typography.captionLine },
})
