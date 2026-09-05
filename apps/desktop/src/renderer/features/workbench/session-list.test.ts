import { describe, expect, test } from "bun:test"
import type { SessionStatus, SessionSummary } from "@bake-pi/contract"
import { formatSessionTime, groupSessions, messageCountLabel, sessionStatusLabel } from "./session-list.ts"

const summary = (id: string, updatedAt: number, createdAt = updatedAt): SessionSummary => ({
  id,
  workspaceId: "workspace-1",
  title: id,
  createdAt,
  updatedAt,
  messageCount: 2,
  path: `C:\\sessions\\${id}.jsonl`,
})

describe("session rail groups", () => {
  test("put open sessions before saved sessions and order each group by recency", () => {
    const sessions = [summary("saved-old", 10), summary("open", 30), summary("current", 20), summary("saved-new", 40)]

    const groups = groupSessions(sessions, new Set(["open", "current"]))

    expect(groups.open.map(({ id }) => id)).toEqual(["open", "current"])
    expect(groups.saved.map(({ id }) => id)).toEqual(["saved-new", "saved-old"])
    expect(sessions.map(({ id }) => id)).toEqual(["saved-old", "open", "current", "saved-new"])
  })

  test("uses creation time and then id to make equal updates deterministic", () => {
    const groups = groupSessions(
      [summary("later-created", 20, 30), summary("b", 20, 10), summary("a", 20, 10)],
      new Set(),
    )

    expect(groups.saved.map(({ id }) => id)).toEqual(["later-created", "a", "b"])
  })
})

test("every live session state has an explicit label", () => {
  const expected: Record<SessionStatus, string> = {
    idle: "Open",
    streaming: "Working",
    awaiting_approval: "Approval",
    compacting: "Compacting",
    retrying: "Retrying",
    disconnected: "Offline",
    quarantined: "Quarantined",
  }
  for (const [status, label] of Object.entries(expected) as [SessionStatus, string][]) {
    expect(sessionStatusLabel(status, false)).toBe(label)
  }
  expect(sessionStatusLabel("idle", true)).toBe("Current")
})

test("message counts read naturally", () => {
  expect(messageCountLabel(0)).toBe("0 messages")
  expect(messageCountLabel(1)).toBe("1 message")
  expect(messageCountLabel(12)).toBe("12 messages")
})

test("timestamps use stable calendar labels and retain their exact value", () => {
  const now = new Date(2026, 8, 3, 18, 0).getTime()
  const today = formatSessionTime(new Date(2026, 8, 3, 14, 5).getTime(), now, "en-US")
  const yesterday = formatSessionTime(new Date(2026, 8, 2, 9, 7).getTime(), now, "en-US")
  const thisYear = formatSessionTime(new Date(2026, 7, 30, 12, 0).getTime(), now, "en-US")
  const older = formatSessionTime(new Date(2025, 11, 30, 12, 0).getTime(), now, "en-US")

  expect(today.label).toBe("Today · 2:05 PM")
  expect(yesterday.label).toBe("Yesterday · 9:07 AM")
  expect(thisYear.label).toBe("Aug 30 · 12:00 PM")
  expect(older.label).toBe("Dec 30, 2025 · 12:00 PM")
  expect(today.full).toContain("Sep 3, 2026")
  expect(today.dateTime).toBe(new Date(2026, 8, 3, 14, 5).toISOString())
})

test("a timestamp outside JavaScript's date range stays honest", () => {
  expect(formatSessionTime(Number.MAX_SAFE_INTEGER, 0, "en-US")).toEqual({
    label: "Unknown date",
    full: "Update time unavailable",
    dateTime: undefined,
  })
})

test("the sessions modal keeps live details conditional on an attached snapshot", async () => {
  const modal = await Bun.file(new URL("./SessionsRail.tsx", import.meta.url)).text()

  expect(modal).toContain("snapshot === undefined ? null : <SessionState")
  expect(modal).toContain("snapshot === undefined ? null : (")
  expect(modal).toContain("model?.displayName ?? snapshot?.model.modelId")
  expect(modal).not.toContain("session.path")
})
