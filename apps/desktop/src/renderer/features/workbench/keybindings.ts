import type { LucideIcon } from "lucide-react"
import { Command as CommandGlyph, History, PanelLeft, PanelRight, Paperclip, Scissors, Settings, SquarePlus } from "lucide-react"
import type { SessionCoreSnapshot } from "../../store/session-projection.ts"

/**
 * The workbench's command registry, and the rules that keep its keybindings
 * out of everything else's way.
 *
 * The bindings follow VS Code's workbench vocabulary, because it is the one a
 * person reaching for a keyboard already speaks: the palette on `Ctrl+K`
 * (with `Ctrl+Shift+P` kept as its synonym, the binding VS Code itself gives
 * "Show All Commands"), a new thing on `Ctrl+N`, settings on `Ctrl+,`, the
 * primary sidebar on `Ctrl+B` and the secondary one on `Ctrl+Alt+B`. Where a
 * VS Code binding exists for what a command does, it is the binding; where
 * none exists, the command gets no key rather than an invented one.
 *
 * Non-conflict is four rules, and `keybindings.test.ts` holds all of them:
 *
 *   1. No bare keys, ever. A letter without a modifier is a text field's.
 *   2. `Ctrl+letter` only where plain-text editing gives the letter no
 *      meaning — `B` is bold only in rich text, and this app's fields are
 *      plain; `N` and `K` mean nothing to a `<textarea>` at all.
 *   3. `Alt` never stands alone: on Windows a bare Alt-letter is the menu
 *      mnemonic layer, so the one Alt binding rides with Ctrl.
 *   4. One chord names one command in every context — there are no `when`
 *      clauses and no chords (the two-keystroke kind) to shadow each other.
 *      If two commands ever want the same keys, that is a design conversation,
 *      not a precedence rule.
 *
 * Every binding is workbench-wide and fires from any field, the way VS Code's
 * workbench commands fire from inside its editors; the registry matches on a
 * minimal event shape rather than `KeyboardEvent` so the contract is testable
 * without a DOM.
 *
 * One verb is deliberately absent: stopping a turn. Aborting returns the
 * queue's text, and only the composer has somewhere to put it — a palette row
 * would silently discard what a person had lined up.
 */

/** What a command may see and do. Workbench builds one; the registry never imports the store. */
export interface CommandContext {
  /** The active session, when one is open. */
  snapshot: SessionCoreSnapshot | undefined
  newSession: () => void
  attachFiles: () => void
  compactSession: () => void
  toggleFilesRail: () => void
  toggleActivityRail: () => void
  openSessions: () => void
  openSettings: () => void
  togglePalette: () => void
}

export interface Command {
  id: string
  title: string
  group: "Session" | "View"
  icon: LucideIcon
  /** Every chord that fires the command; the first is the one the palette prints. */
  keys: string[]
  /** A command that cannot act right now is not offered at all — the slash palette's rule, kept here. */
  available: (context: CommandContext) => boolean
  run: (context: CommandContext) => void
}

export const WORKBENCH_COMMANDS: Command[] = [
  {
    id: "session.new",
    title: "New session",
    group: "Session",
    icon: SquarePlus,
    keys: ["Ctrl+N"],
    available: () => true,
    run: (context) => context.newSession(),
  },
  {
    id: "session.attach",
    title: "Attach files…",
    group: "Session",
    icon: Paperclip,
    keys: [],
    available: (context) => context.snapshot !== undefined,
    run: (context) => context.attachFiles(),
  },
  {
    id: "session.compact",
    title: "Compact conversation",
    group: "Session",
    icon: Scissors,
    keys: [],
    available: (context) => context.snapshot !== undefined && context.snapshot.status === "idle" && context.snapshot.messageCount > 0,
    run: (context) => context.compactSession(),
  },
  {
    id: "view.palette",
    title: "Command palette",
    group: "View",
    icon: CommandGlyph,
    keys: ["Ctrl+K", "Ctrl+Shift+P"],
    available: () => true,
    run: (context) => context.togglePalette(),
  },
  {
    id: "view.files",
    title: "Toggle files rail",
    group: "View",
    icon: PanelLeft,
    keys: ["Ctrl+B"],
    available: () => true,
    run: (context) => context.toggleFilesRail(),
  },
  {
    id: "view.activity",
    title: "Toggle activity rail",
    group: "View",
    icon: PanelRight,
    keys: ["Ctrl+Alt+B"],
    available: () => true,
    run: (context) => context.toggleActivityRail(),
  },
  {
    id: "view.sessions",
    title: "Open sessions",
    group: "View",
    icon: History,
    keys: [],
    available: () => true,
    run: (context) => context.openSessions(),
  },
  {
    id: "view.settings",
    title: "Open settings",
    group: "View",
    icon: Settings,
    keys: ["Ctrl+,"],
    available: () => true,
    run: (context) => context.openSettings(),
  },
]

/** The least a keyboard event must say for a chord to be read from it. */
export interface ChordEvent {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

/**
 * A chord in one canonical form: the key lowercased, modifiers before it in
 * VS Code's display order — `ctrl+shift+alt+key`. Registry entries are
 * authored in display case ("Ctrl+,"), so both sides pass through here before
 * they are ever compared.
 */
export const parseChord = (chord: string): string => {
  const parts = chord.toLowerCase().split("+")
  const key = parts[parts.length - 1] ?? ""
  const modifiers = new Set(parts.slice(0, -1))
  return chordOf(modifiers.has("ctrl") || modifiers.has("cmd") || modifiers.has("meta"), modifiers.has("shift"), modifiers.has("alt"), key)
}

/** The canonical form itself, so an authored chord and a pressed one cannot spell it differently. */
const chordOf = (ctrl: boolean, shift: boolean, alt: boolean, key: string): string =>
  [ctrl ? "ctrl" : undefined, shift ? "shift" : undefined, alt ? "alt" : undefined, key]
    .filter((part) => part !== undefined)
    .join("+")

/**
 * The chord an event carries, or nothing when the event is not one: a bare
 * modifier press, or a key with no modifier at all — this registry binds none
 * of those, so they are nobody's command.
 *
 * `meta` counts as `ctrl`: the app ships on Windows, but a person arriving
 * with macOS habits should not be punished for the reflex.
 */
const eventChord = (event: ChordEvent): string | undefined => {
  const key = event.key.toLowerCase()
  if (key === "control" || key === "shift" || key === "alt" || key === "meta") return undefined
  const ctrl = event.ctrlKey || event.metaKey
  if (!ctrl && !event.altKey) return undefined
  return chordOf(ctrl, event.shiftKey, event.altKey, key)
}

/**
 * The command an event fires, if any. The match is exact — extra modifiers
 * make a different chord, not a weaker one: `Ctrl+Shift+K` is not a sloppy
 * `Ctrl+K`, it is nothing at all.
 */
export const matchCommand = (event: ChordEvent, commands: Command[]): Command | undefined => {
  const chord = eventChord(event)
  if (chord === undefined) return undefined
  return commands.find((command) => command.keys.some((keys) => parseChord(keys) === chord))
}
