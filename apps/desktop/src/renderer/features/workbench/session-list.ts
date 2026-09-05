import type { SessionStatus, SessionSummary } from "@bake-pi/contract"

export interface SessionGroups {
  open: SessionSummary[]
  saved: SessionSummary[]
}

/**
 * The order a person scans the rail in: what is already open first, then every
 * closed session, with both groups ordered by recency. Selection does not
 * reorder the open group under the pointer. A copy is sorted so renderer
 * presentation never mutates the host's projection.
 */
export const groupSessions = (
  sessions: readonly SessionSummary[],
  attachedIds: ReadonlySet<string>,
): SessionGroups => {
  const byRecency = (left: SessionSummary, right: SessionSummary): number =>
    right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || left.id.localeCompare(right.id)
  const ordered = [...sessions].sort(byRecency)
  const open = ordered.filter((session) => attachedIds.has(session.id))
  return {
    open,
    saved: ordered.filter((session) => !attachedIds.has(session.id)),
  }
}

const STATUS_LABELS: Record<SessionStatus, string> = {
  idle: "Open",
  streaming: "Working",
  awaiting_approval: "Approval",
  compacting: "Compacting",
  retrying: "Retrying",
  disconnected: "Offline",
  quarantined: "Quarantined",
}

/** A word in every state, because the monochrome status ramp cannot carry meaning alone. */
export const sessionStatusLabel = (status: SessionStatus, current: boolean): string =>
  status === "idle" && current ? "Current" : STATUS_LABELS[status]

export const messageCountLabel = (count: number): string => `${String(count)} ${count === 1 ? "message" : "messages"}`

export interface FormattedSessionTime {
  label: string
  full: string
  dateTime: string | undefined
}

/**
 * Compact enough for a rail, exact in the native tooltip and the time element.
 * Calendar words beat elapsed minutes here: unlike a timer they do not become
 * false merely because the rail stayed open while the clock advanced.
 */
export const formatSessionTime = (
  at: number,
  now = Date.now(),
  locale?: string,
): FormattedSessionTime => {
  const date = new Date(at)
  if (!Number.isFinite(date.getTime())) {
    return { label: "Unknown date", full: "Update time unavailable", dateTime: undefined }
  }
  const today = new Date(now)
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)

  const time = formatter(locale, "time").format(date)
  const dateLabel = sameDay(date, today)
    ? "Today"
    : sameDay(date, yesterday)
      ? "Yesterday"
      : formatter(locale, date.getFullYear() === today.getFullYear() ? "day" : "dayWithYear").format(date)

  return {
    label: `${dateLabel} · ${time}`,
    full: formatter(locale, "exact").format(date),
    dateTime: date.toISOString(),
  }
}

const FORMATS = {
  time: { hour: "numeric", minute: "2-digit" },
  day: { month: "short", day: "numeric" },
  dayWithYear: { month: "short", day: "numeric", year: "numeric" },
  exact: { dateStyle: "medium", timeStyle: "short" },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>

/**
 * Constructing a `DateTimeFormat` is the expensive half; formatting with one is
 * not. The rail formats every row on every render, so the four shapes it asks
 * for are built once per locale and kept.
 */
const formatters = new Map<string, Intl.DateTimeFormat>()

const formatter = (locale: string | undefined, shape: keyof typeof FORMATS): Intl.DateTimeFormat => {
  const key = `${locale ?? ""}|${shape}`
  const known = formatters.get(key)
  if (known) return known
  const made = new Intl.DateTimeFormat(locale, FORMATS[shape])
  formatters.set(key, made)
  return made
}

const sameDay = (left: Date, right: Date): boolean =>
  left.getFullYear() === right.getFullYear() &&
  left.getMonth() === right.getMonth() &&
  left.getDate() === right.getDate()
