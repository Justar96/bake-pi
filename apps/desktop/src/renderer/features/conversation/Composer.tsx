import { useEffect, useLayoutEffect, useRef, useState } from "react"
import * as stylex from "@stylexjs/stylex"
import { ArrowUp, Brain, ChevronDown, CornerDownRight, Cpu, File, FileText, Image, ListPlus, Lock, Paperclip, Plus, Scissors, ShieldAlert, ShieldCheck, Square, SquarePlus, X, Zap } from "lucide-react"
import type { Attachment, DirectoryEntry, Model, Provider, SessionSnapshot, Workspace } from "@bake-pi/contract"
import { store } from "../../store/session-store.ts"
import type { SessionCoreSnapshot } from "../../store/session-projection.ts"
import { insertFileMention, tokenAt, workspaceRelativePath, type Token } from "./composer-token.ts"
import { THINKING_LABELS, type ThinkingLevel, type Tone } from "./thinking-level.ts"
import { TRUST_LABELS } from "./trust-level.ts"
import { colors, effects, motion, radius, space, typography } from "../../theme/tokens.stylex.ts"
import { a11y } from "../../theme/a11y.ts"
import { focus } from "../../theme/focus.ts"
import { size } from "../../theme/sizes.stylex.ts"
import { scrollbars } from "../../theme/scrollbars.ts"
import { availableModels } from "./available-models.ts"
import { composerIsDense, contextRampStop, readContext } from "./composer-layout.ts"
import { FileIcon } from "../workbench/FileIcon.tsx"
import { hasWorkspaceFileDrag, WORKSPACE_FILE_DRAG_TYPE } from "../workbench/file-drag.ts"
import { pickFileIcon, useFileIcons } from "../workbench/file-icons.ts"
import { LabIcon } from "../../ui/LabIcon.tsx"
import { labArtwork, labMarkForModel } from "../../ui/lab-icons.ts"

/**
 * How many queued messages the card lists before it stops listing them.
 *
 * The queue is bounded only by the host's cap, and a card that grows with it
 * pushes the field a person is typing in off the bottom of the window — the one
 * thing a prompt bar may never do. Three rows plus a count is the compromise:
 * enough to see what is next and what follows it, short enough that the
 * composer never takes more than a third of the column.
 */
const QUEUE_VISIBLE = 3

/**
 * How many rows either menu offers before it stops offering them.
 *
 * A menu that grows with a directory is the same failure as a queue that grows
 * with the session: it pushes the field a person is typing in off the screen.
 * Eight is what fits above the composer at the shortest window the layout
 * supports, and the filter is how you reach the ninth.
 */
const MENU_ROWS = 8

/** One row of either menu, which are the same object with different sources. */
interface Row {
  key: string
  label: string
  hint: string
  glyph: React.JSX.Element
  /** A directory does not complete the mention, it descends into it. */
  descend?: string
  run?: () => Promise<unknown>
  /** Opens the file picker and leaves the draft alone; only the `+` menu offers it. */
  attach?: true
}

/**
 * The first row of the `+` menu: the disk picker, above the workspace listing.
 *
 * The button used to be a paperclip that went straight to the picker. Most of
 * what gets attached is already in the workspace, though, and reaching it meant
 * knowing to type `@`. The `+` puts both behind one control, the way the
 * reference prompt bar does: pick from disk, or pick from the tree.
 */
const ATTACH_ROW: Row = {
  key: "\0attach",
  label: "Attach files",
  hint: "Choose from disk",
  glyph: <Paperclip size={14} aria-hidden="true" />,
  attach: true,
}

/**
 * The slash palette, and every entry is implemented end to end.
 *
 * This is deliberately not a place to invent verbs. Each row names something a
 * person can otherwise only reach through a menu they have to go looking for,
 * and `available` is what keeps a row from offering an action the session is in
 * no position to take — a fork of a conversation with no messages in it is not
 * a thing, and neither is stopping a turn that is not running.
 */
const COMMANDS: { name: string; hint: string; glyph: React.JSX.Element; available: (snapshot: SessionCoreSnapshot) => boolean; run: (snapshot: SessionCoreSnapshot) => Promise<unknown> }[] = [
  {
    name: "compact",
    hint: "Summarize this conversation to free context",
    glyph: <Scissors size={14} aria-hidden="true" />,
    available: (snapshot) => snapshot.status === "idle" && snapshot.messageCount > 0,
    run: () => store.compactSession(),
  },
  {
    name: "new",
    hint: "Start a fresh session in this workspace",
    glyph: <SquarePlus size={14} aria-hidden="true" />,
    available: () => true,
    run: () => store.newSession(),
  },
  {
    name: "attach",
    hint: "Choose files to send with the next message",
    glyph: <Paperclip size={14} aria-hidden="true" />,
    available: () => true,
    run: () => store.chooseAttachments(),
  },
]

/**
 * The three permission levels, in the order of how much they let through.
 *
 * Each hint is the policy in two clauses: what runs on its own, and what still
 * has to ask. A chooser whose options cannot be told apart at a glance is a
 * chooser people leave alone, and the thing being chosen here is what an agent
 * is allowed to do to a person's disk — so the sentences say it in the order a
 * person asks it, rather than naming the mechanism. Full access says what it
 * costs as well, and the cost is now that it *stays*: the host remembers the
 * level a workspace was last set to and restores it on the next open, so the
 * sentence has to say the level is standing rather than borrowed. `TrustLevel`
 * carries the reasoning, including what it gave up to work that way.
 *
 * Every chooser's rows stack for the same reason. A sentence set beside its
 * label wraps around it and reads as one ragged block; under the label it
 * reads as a caption, which is what it is. The glyph in front repeats the
 * trigger's own, so the three rows are told apart before a word is read —
 * colour is never the only thing saying which is which.
 */
const PERMISSIONS: { key: Workspace["trust"]; label: string; hint: string; tone: Tone; glyph: React.JSX.Element }[] = [
  { key: "untrusted", label: TRUST_LABELS.untrusted, tone: "warning", glyph: <Lock size={14} aria-hidden="true" />, hint: "Every tool asks first. Project extensions stay unloaded." },
  { key: "trusted", label: TRUST_LABELS.trusted, tone: "success", glyph: <ShieldCheck size={14} aria-hidden="true" />, hint: "Tools run unasked inside this workspace. Reaching outside it asks." },
  { key: "full", label: TRUST_LABELS.full, tone: "danger", glyph: <ShieldAlert size={14} aria-hidden="true" />, hint: "Nothing asks, anywhere. Stays on for this project until you change it." },
]

/**
 * Returns focus to the prompt, but only from the composer's own controls.
 *
 * Sending refocuses the field because the click that sent the message left
 * focus on a button, and typing the next prompt should not need a second
 * click. What it must not do is take focus from something that arrived while
 * the send was in flight: a prompt whose `before_agent_start` hook asks a
 * question puts a card on screen and focuses its first option, and this ran
 * afterwards and pulled focus straight back out of it. The card's arrow keys,
 * its digits and its Enter then did nothing at all until it was clicked —
 * a whole keyboard model lost to a race that the journey saw and a person
 * would have called the card broken.
 *
 * So: take focus back when the composer still holds it, or when nothing does.
 * Never from elsewhere.
 */
const restorePromptFocus = (shell: HTMLDivElement | null, element: HTMLTextAreaElement | null): void => {
  if (element === null) return
  const active = document.activeElement
  const claimed = active !== null && active !== document.body && !(shell?.contains(active) ?? false)
  if (claimed) return
  element.focus()
}

/**
 * The prompt bar, following fluid functionalism's `InputMessage`.
 *
 * The field, its attachments and the two action slots sit on one compact,
 * raised surface. A short draft shares its row with the controls; long text,
 * attachments, streaming actions or a narrow conversation move the editor
 * above them. Focus deepens the same seat instead of drawing a ring around it.
 * The queue lives *outside* that surface, above it and with no box of its own,
 * because those messages belong to the session rather than to what is being
 * typed now.
 *
 * The queue is also read-only, and that is a contract fact rather than a taste.
 * `QueuedPrompt` carries an id and delivery mode, but no command removes or
 * reorders one entry: Pi owns the queue. Abort clears the whole queue and puts
 * its text back in this editor; there is no per-row affordance with nothing
 * behind it.
 */
export const Composer = ({ snapshot, aborting, resting, models, providers, attachments, workspace, onFileDrop, onPromptSubmit }: {
  snapshot: SessionCoreSnapshot
  /** An abort this composer asked for and has not been answered on yet. */
  aborting: boolean
  /**
   * Nothing has been said in this session yet, so the composer is centred in
   * the pane rather than docked under a transcript — and takes the narrower of
   * the two column widths while it is. The workbench decides this; the
   * composer only wears it.
   */
  resting: boolean
  models: Model[]
  providers: Provider[]
  attachments: Attachment[]
  workspace: Workspace
  onFileDrop: () => void
  onPromptSubmit: () => void
}): React.JSX.Element => {
  const trust = workspace.trust
  const composer = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const [busy, setBusy] = useState(false)
  // Whether a draft exists, never the draft itself. The text stays on the
  // uncontrolled element; this flips at most twice per message and decides
  // which actions the right slot is allowed to offer.
  const [hasDraft, setHasDraft] = useState(false)
  const [dense, setDense] = useState(false)
  const icons = useFileIcons()
  const [fileDropActive, setFileDropActive] = useState(false)
  const streaming = snapshot.status === "streaming" || snapshot.status === "awaiting_approval" || snapshot.status === "retrying"
  const stoppable = streaming || snapshot.status === "compacting"
  const modelOptions = availableModels(models, providers)
  const selectedModelName = models.find((model) => model.providerId === snapshot.model.providerId && model.id === snapshot.model.modelId)?.displayName ?? snapshot.model.modelId
  const selectedLabGlyph = labGlyph(snapshot.model.modelId, snapshot.model.providerId)
  const providerNames = new Map(providers.map((provider) => [provider.id, provider.displayName]))


  // The composer is always the same two-row bar; the column's width only
  // decides how much each control may say. ResizeObserver reads the column
  // itself, since window size is a poor proxy for it once rails are open.
  useLayoutEffect(() => {
    const shell = composer.current
    if (shell === null) return
    const sync = (): void => setDense(composerIsDense(shell.clientWidth))
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(shell)
    return () => observer.disconnect()
  }, [])

  // The mention under the caret, the rows it resolved to, and which one Enter
  // would take. All three exist only while a menu is open.
  const [token, setToken] = useState<Token | undefined>(undefined)
  const [rows, setRows] = useState<Row[]>([])
  const [active, setActive] = useState(0)
  // Escape closes the menu and it stays closed until the next edit. A ref
  // rather than state: nothing renders from it, and it has to be readable
  // inside the same event that sets it.
  const dismissed = useRef(false)
  // Whether the open menu came from the `+` button rather than a typed `@`.
  // Both are the same file menu; the button's adds the disk picker on top.
  const [viaPlus, setViaPlus] = useState(false)
  /**
   * Listings, kept for as long as a mention is open.
   *
   * The rail deliberately does not cache — it re-reads, because a tool may have
   * written since. Here the opposite is right: this is a menu being filtered a
   * keystroke at a time, and re-reading `src` on every letter would put a round
   * trip between a person and the next character they type.
   */
  const listings = useRef(new Map<string, DirectoryEntry[]>())

  /**
   * Names a file the way a person would, which is not the way the contract
   * carries it.
   *
   * `DirectoryEntry.path` is absolute and canonical, because that is the only
   * form the host will accept back. In a sentence it is noise — a drive letter
   * and six directories in front of the one word that matters — so the mention
   * carries the path relative to the workspace, which is the root the agent is
   * already working from. The absolute form is the fallback for the case that
   * should not arise: an entry from outside this root.
   */
  const relative = (path: string): string => workspaceRelativePath(workspace.root, path)

  /**
   * Writes a file mention over one range of the draft and leaves the caret
   * after it. The `@` menu's pick and a drop from the tree are the same write
   * over a different range, and the mention's spelling — relative to the
   * workspace root, one trailing space — is `insertFileMention`'s to decide.
   */
  const writeMention = (element: HTMLTextAreaElement, start: number, end: number, path: string): void => {
    const insertion = insertFileMention(element.value, start, end, workspace.root, path)
    element.value = insertion.text
    element.setSelectionRange(insertion.caret, insertion.caret)
    setHasDraft(element.value.trim().length > 0)
  }

  /** Inserts the tree's host-issued path at the live selection and returns focus. */
  const insertDroppedFile = (path: string): void => {
    const element = textarea.current
    if (element === null) return
    writeMention(element, element.selectionStart, element.selectionEnd, path)
    dismissed.current = false
    setViaPlus(false)
    setToken(undefined)
    element.focus()
  }

  /**
   * Walks down to the directory a query names, one listing at a time.
   *
   * It would be shorter to join the workspace root with the typed segments and
   * ask for that path — and it would give away the one thing that makes this
   * safe. Every path the renderer can name came back from a listing the host
   * had already contained, so the renderer can only walk down from the root the
   * user opened. Composing a path out of what is in the field would let the
   * field decide what gets read, which is the asymmetry `DirectoryEntry` exists
   * to preserve.
   */
  const walk = async (segments: string[]): Promise<DirectoryEntry[]> => {
    let key = ""
    let path: string | undefined
    for (;;) {
      let entries = listings.current.get(key)
      if (entries === undefined) {
        entries = (await store.listDirectory(path)).entries
        listings.current.set(key, entries)
      }
      const next = segments.shift()
      if (next === undefined) return entries
      const directory = entries.find((entry) => entry.kind === "directory" && entry.name === next)
      if (directory === undefined) return []
      key = key === "" ? next : `${key}/${next}`
      path = directory.path
    }
  }

  /**
   * Resolves the open mention into rows.
   *
   * Cancellation matters more than it looks. A listing is a round trip, and
   * someone typing `src/co` fires one per letter; without the flag a slow
   * answer for `s` lands after the answer for `src/co` and replaces a correct
   * menu with a stale one.
   */
  useEffect(() => {
    if (token === undefined) {
      setRows([])
      setViaPlus(false)
      // The cache lives exactly as long as the mention that filled it. Holding
      // it longer would be the second source of truth the store refuses to be.
      listings.current.clear()
      return
    }
    if (token.kind === "command") {
      const typed = token.query.toLowerCase()
      setRows(COMMANDS.filter((command) => command.available(snapshot) && command.name.startsWith(typed)).map((command) => ({
        key: command.name,
        label: `/${command.name}`,
        hint: command.hint,
        glyph: command.glyph,
        run: () => command.run(snapshot),
      })))
      return
    }
    let cancelled = false
    const segments = token.query.split("/")
    const leaf = (segments.pop() ?? "").toLowerCase()
    void (async () => {
      const entries = await walk(segments)
      if (cancelled) return
      const listed: Row[] = entries
        .filter((entry) => entry.name.toLowerCase().startsWith(leaf))
        .slice(0, MENU_ROWS)
        .map((entry) => ({
          key: entry.path,
          label: entry.name,
          hint: entry.kind === "directory" ? "Directory" : relative(entry.path),
          glyph: <FileIcon icon={pickFileIcon(icons, entry, false)} />,
          ...(entry.kind === "directory" ? { descend: entry.name } : {}),
        }))
      setRows(viaPlus && token.query === "" ? [ATTACH_ROW, ...listed] : listed)
    })().catch((error: unknown) => { store.capture(error) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token?.kind, token?.query, viaPlus, snapshot.status, snapshot.messageCount, icons])

  useEffect(() => { setActive(0) }, [token?.kind, token?.query])

  /** Re-reads the caret. `onSelect` covers arrows and clicks, `onInput` covers typing. */
  const syncToken = (element: HTMLTextAreaElement): void => {
    setToken(dismissed.current ? undefined : tokenAt(element.value, element.selectionStart))
  }

  /** Writes into the uncontrolled field and leaves the caret after what it wrote. */
  const replaceToken = (element: HTMLTextAreaElement, text: string): void => {
    if (token === undefined) return
    const caret = element.selectionStart
    element.value = element.value.slice(0, token.start) + text + element.value.slice(caret)
    const at = token.start + text.length
    element.setSelectionRange(at, at)
    setHasDraft(element.value.trim().length > 0)
  }

  const choose = (row: Row): void => {
    const element = textarea.current
    if (element === null || token === undefined) return
    if (row.descend !== undefined) {
      // A directory does not finish the mention, it moves it down a level.
      const segments = token.query.split("/")
      segments[segments.length - 1] = row.descend
      replaceToken(element, `@${segments.join("/")}/`)
      element.focus()
      syncToken(element)
      return
    }
    if (row.attach === true) {
      setToken(undefined)
      void store.chooseAttachments().catch((error: unknown) => { store.capture(error) })
      return
    }
    if (row.run !== undefined) {
      // A command is the whole message, so it leaves nothing behind in the field.
      element.value = ""
      setHasDraft(false)
      setToken(undefined)
      element.focus()
      void row.run().catch((error: unknown) => { store.capture(error) })
      return
    }
    writeMention(element, token.start, element.selectionStart, row.key)
    element.focus()
    setToken(undefined)
  }

  const open = token !== undefined && rows.length > 0

  /**
   * The `+` opens the file menu at the caret, as if `@` had been typed there,
   * without putting an `@` in the draft. A pick then inserts the mention where
   * the caret was; closing the menu leaves the text exactly as it was found.
   */
  const togglePlus = (): void => {
    const element = textarea.current
    if (element === null) return
    if (token !== undefined) {
      setToken(undefined)
      return
    }
    element.focus()
    dismissed.current = false
    setViaPlus(true)
    setToken({ kind: "file", start: element.selectionStart, query: "" })
  }

  const submit = async (mode: "prompt" | "steer" | "follow_up"): Promise<void> => {
    const text = textarea.current?.value.trim() ?? ""
    if (text.length === 0 || busy) return
    onPromptSubmit()
    setBusy(true)
    try {
      await store.submitPrompt(text, mode)
      if (textarea.current !== null) textarea.current.value = ""
      setHasDraft(false)
    } catch (error) {
      store.capture(error)
    } finally {
      setBusy(false)
      restorePromptFocus(composer.current, textarea.current)
    }
  }

  const stop = async (): Promise<void> => {
    try {
      const recovered = await store.abortActive()
      const element = textarea.current
      if (element === null || recovered.length === 0) return
      const queuedText = recovered.map((prompt) => prompt.text).join("\n\n")
      element.value = [queuedText, element.value].filter((part) => part.trim().length > 0).join("\n\n")
      setHasDraft(true)
    } catch (error) {
      store.capture(error)
    } finally {
      restorePromptFocus(composer.current, textarea.current)
    }
  }

  const selectedModel = `${snapshot.model.providerId}\0${snapshot.model.modelId}`
  const permission = PERMISSIONS.find((option) => option.key === trust)
  const queued = snapshot.queue.slice(0, QUEUE_VISIBLE)
  const overflow = snapshot.queue.length - queued.length
  const context = snapshot.usage.context

  return (
    <section aria-label="Prompt composer" {...stylex.props(styles.area)}>
      {snapshot.queue.length === 0 ? null : (
        <ol aria-label={`${snapshot.queue.length} queued ${snapshot.queue.length === 1 ? "message" : "messages"}`} {...stylex.props(styles.queue)}>
          {queued.map((prompt, index) => (
            <li key={prompt.id} {...stylex.props(styles.queueRow)}>
              <span aria-hidden="true" {...stylex.props(styles.queueIndex)}>{index + 1}</span>
              <span {...stylex.props(styles.queueMode)}>{prompt.mode === "steer" ? "Steer" : "Next"}</span>
              <span {...stylex.props(styles.queueText)}>{prompt.text}</span>
            </li>
          ))}
          {overflow > 0 ? <li {...stylex.props(styles.queueRow)}><span aria-hidden="true" {...stylex.props(styles.queueIndex)} /><span {...stylex.props(styles.queueMore)}>{overflow} more</span></li> : null}
        </ol>
      )}

      <div {...stylex.props(styles.anchor, resting && styles.anchorResting)}>
      {!open ? null : (
        <ul
          id="prompt-menu"
          role="listbox"
          aria-label={token?.kind === "command" ? "Commands" : "Workspace files"}
          {...stylex.props(styles.menu)}
        >
          {rows.map((row, index) => (
            <li key={row.key} id={`prompt-row-${String(index)}`} role="option" aria-selected={index === active} {...stylex.props(styles.menuRow, index === active && styles.menuRowActive)}>
              {/*
                * `onMouseDown` is where the pick happens, not `onClick`. A
                * mousedown on anything else blurs the textarea, and a blurred
                * textarea has no caret — so by the time a click fired there
                * would be no token left to replace.
                */}
              <button type="button" onMouseDown={(event) => { event.preventDefault(); choose(row) }} onMouseEnter={() => setActive(index)} {...stylex.props(focus.ring, styles.interactive, styles.menuButton)}>
                <span {...stylex.props(styles.menuGlyph)}>{row.glyph}</span>
                <span {...stylex.props(styles.menuLabel)}>{row.label}</span>
                <span {...stylex.props(styles.menuHint)}>{row.hint}</span>
              </button>
            </li>
          ))}
          <li {...stylex.props(styles.menuFoot)}>
            {token?.kind === "command" ? "Enter runs it · Esc dismisses" : "Enter inserts · a directory opens · Esc dismisses"}
          </li>
        </ul>
      )}

      <div
        ref={composer}
        onDragOver={(event) => {
          if (!hasWorkspaceFileDrag(event.dataTransfer.types)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = "copy"
          setFileDropActive(true)
        }}
        onDragLeave={(event) => {
          const next = event.relatedTarget
          if (next instanceof Node && event.currentTarget.contains(next)) return
          setFileDropActive(false)
        }}
        onDrop={(event) => {
          if (!hasWorkspaceFileDrag(event.dataTransfer.types)) return
          event.preventDefault()
          setFileDropActive(false)
          const path = event.dataTransfer.getData(WORKSPACE_FILE_DRAG_TYPE)
          if (path === "") return
          insertDroppedFile(path)
          onFileDrop()
        }}
        {...stylex.props(styles.composer, fileDropActive && styles.composerFileDrop)}
      >
        {attachments.length === 0 ? null : (
          <ul aria-label="Attachments" {...stylex.props(styles.tiles)}>
            {attachments.map((attachment) => <AttachmentTile key={attachment.path} attachment={attachment} />)}
          </ul>
        )}

        <label htmlFor="prompt" {...stylex.props(a11y.visuallyHidden)}>Message Pi</label>
        {/*
          The field gets the card's first row to itself. The verbs used to ride
          beside it, bottom-aligned against the caret's last line; with a row
          of their own below the field there is nothing left to align, and a
          draft that grows to eight lines changes nothing but the field.
        */}
        <div {...stylex.props(styles.editor)}>
          <textarea
            id="prompt"
            ref={textarea}
            rows={1}
            placeholder={streaming ? "Steer, or queue what comes next…" : "Ask Pi anything…"}
            role="combobox"
            aria-expanded={open}
            aria-controls="prompt-menu"
            aria-autocomplete="list"
            aria-activedescendant={open ? `prompt-row-${String(active)}` : undefined}
            onInput={(event) => {
              setHasDraft(event.currentTarget.value.trim().length > 0)
              dismissed.current = false
              syncToken(event.currentTarget)
            }}
            // A caret move cannot close the `+` menu, because that menu is not
            // anchored to anything in the text for the caret to leave.
            onSelect={(event) => { if (!viaPlus) syncToken(event.currentTarget) }}
            onBlur={() => setToken(undefined)}
            onKeyDown={(event) => {
              if (open) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault()
                  setActive((current) => (current + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length)
                  return
                }
                // Tab as well as Enter, because completing a path is what Tab
                // means everywhere else a path is typed.
                if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
                  event.preventDefault()
                  choose(rows[active]!)
                  return
                }
              }
              if (event.key === "Escape" && token !== undefined) {
                // Only when a menu is open. Escape with no menu belongs to
                // whatever is listening outside the composer.
                event.preventDefault()
                dismissed.current = true
                setToken(undefined)
                return
              }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void submit(streaming ? "follow_up" : "prompt")
              }
            }}
            {...stylex.props(scrollbars.thin, styles.textarea)}
          />

        </div>

        {/*
          What attaches to this message, and what happens to it: one row at the
          foot of the card, the reference bars' split. Files on the left, the
          verbs on the right, and nothing else — every standing choice, the
          permission level included, sits below the card with the gauge.

          Permissions used to ride here, beside send, on the argument that it
          is the one choice that changes what pressing send may do. That was
          true and still cost more than it bought: three chooser popups on two
          different rows, one of them opening upward out of the card, so the
          control a person reaches for depended on which of two rows the
          interface had decided it belonged to. All three are one row now, all
          three open the same way, and what the send will run under is the
          coloured pill directly under it.
        */}
        <div {...stylex.props(styles.controlRow)}>
          {/* `onMouseDown` for the same reason as the menu rows: a click would
              blur the textarea first, and the menu closes on blur. */}
          <button
            type="button"
            onMouseDown={(event) => { event.preventDefault(); togglePlus() }}
            aria-label="Add files"
            aria-haspopup="listbox"
            aria-expanded={open && viaPlus}
            title="Add files"
            {...stylex.props(focus.ring, styles.interactive, styles.iconButton, open && viaPlus && styles.iconButtonOpen)}
          >
            <Plus size={16} aria-hidden="true" />
          </button>
          <span {...stylex.props(styles.rowSpacer)} aria-hidden="true" />
          {stoppable ? (
            /*
              Still live while the abort is in flight, and deliberately. A
              control that goes dead until a command answers is a control a
              hung abort strands, with nothing left to press; refusing the
              duplicate belongs in `abortActive`, where every caller passes.
              What changes here is the look and the name: the danger fill is
              spent, so the button reads as already pressed rather than as an
              action still waiting to be taken, and a screen reader is given
              the state by the accessible name rather than by the fill.
            */
            <button type="button" onClick={() => void stop()} aria-label={aborting ? "Stopping" : "Stop"} title={aborting ? "Stopping" : "Stop"} {...stylex.props(focus.ring, styles.interactive, styles.action, styles.stop, aborting && styles.stopping)}>
              <Square size={14} aria-hidden="true" />
            </button>
          ) : null}
          {streaming && hasDraft ? (
            <button type="button" disabled={busy} onClick={() => void submit("steer")} aria-label="Steer now" title="Steer now" {...stylex.props(focus.ring, styles.interactive, styles.action, styles.steer)}>
              <CornerDownRight size={14} aria-hidden="true" />
            </button>
          ) : null}
          {/* Fluid turns send into Queue while a turn is in flight. Pi lets a
              draft interrupt as well as follow, so Steer sits beside it: two
              different futures for the same words, and neither should be a
              guess the interface makes on a person's behalf. */}
          <button
            type="button"
            disabled={busy || !hasDraft || snapshot.status === "compacting"}
            onClick={() => void submit(streaming ? "follow_up" : "prompt")}
            aria-label={streaming ? "Queue message" : "Send message"}
            title={streaming ? "Queue message" : "Send message"}
            {...stylex.props(focus.ring, styles.interactive, styles.action, styles.send)}
          >
            {streaming ? <ListPlus size={14} aria-hidden="true" /> : <ArrowUp size={14} aria-hidden="true" />}
          </button>
        </div>
      </div>

      {/*
        Below the card, the session's standing choices as ghost pills: no seat,
        no edge, a muted word that steps out of the canvas when a pointer is on
        it. They are read far more often than they are changed — the card is
        the message's, this row is the conversation's, which is also where the
        window's pressure gauge and the permission level belong.

        Two groups, split by the spacer: what the answer will be made of on the
        left, what it is allowed to touch and how much room it has left on the
        right. Permissions is the one pill that keeps a colour, because it is
        the one whose value a person needs to read from across the room.

        Every pill leads with a glyph, the reference prompt bar's signature.
        The model's is the mark of the lab that made it, which is the fastest
        thing on the row to recognise and the one thing the truncated name
        beside it cannot say faster. A model no table knows falls back to a
        processor — the one thing every provider has in common, since
        `Provider` carries no locality for the reference's laptop-for-local,
        cloud-for-remote split to resolve from. Thinking's bolt is what the
        reference spends on its performance pill, which is the choice effort
        is.
      */}
      <div {...stylex.props(styles.belowRow)}>
        <ChoiceMenu
          label="Model"
          value={selectedModel}
          displayValue={selectedModelName}
          glyph={selectedLabGlyph ?? <Cpu size={14} aria-hidden="true" />}
          disabled={modelOptions.length === 0}
          disabledTitle="Connect a provider in Settings to change models"
          options={modelOptions.map((model) => {
            const glyph = labGlyph(model.id, model.providerId)
            return { key: `${model.providerId}\0${model.id}`, label: model.displayName, hint: modelCaption(model, providerNames), marks: modelMarks(model), ...(glyph === undefined ? {} : { glyph }) }
          })}
          onPick={(key) => {
            const [providerId, modelId] = key.split("\0")
            if (providerId !== undefined && modelId !== undefined) void store.setModel(providerId, modelId).catch((error: unknown) => store.capture(error))
          }}
        />
        {snapshot.model.availableThinkingLevels.length > 1 ? (
          <ChoiceMenu
            label="Thinking"
            value={snapshot.model.thinkingLevel}
            glyph={<Zap size={14} aria-hidden="true" />}
            plain
            options={snapshot.model.availableThinkingLevels.map((level) => ({ key: level, label: THINKING_LABELS[level], glyph: <EffortRing level={level} />, ...(level === "max" ? { triggerLabel: <DecryptText text={THINKING_LABELS[level]} /> } : {}) }))}
            onPick={(key) => void store.setThinking(key as SessionSnapshot["model"]["thinkingLevel"]).catch((error: unknown) => store.capture(error))}
          />
        ) : null}
        <span {...stylex.props(styles.rowSpacer)} aria-hidden="true" />
        {/*
          The two readings of what this session is spending sit together on the
          right: what it is allowed to do, and how much room it has left to do
          it in. Permissions keeps its tone where the other pills are muted —
          it is the only one on the row whose value changes what a tool call
          may reach, and the colour is what makes that legible without reading
          the word. Dense keeps the glyph and drops the word, which the glyph
          was already carrying.
        */}
        <ChoiceMenu
          label="Permissions"
          value={trust}
          tone={permission?.tone}
          glyph={permission?.glyph}
          compact={dense}
          align="end"
          options={PERMISSIONS}
          onPick={(key) => void store.decideTrust(key as Workspace["trust"]).catch((error: unknown) => store.capture(error))}
        />
        {context === undefined ? (
          <span title="The model reports its context window after the first turn" {...stylex.props(styles.context, styles.contextAbsent)}>
            {dense ? "—" : "Context —"}
          </span>
        ) : <ContextGauge context={context} dense={dense} />}
      </div>
      </div>
    </section>
  )
}

/**
 * A chooser that looks like the interface it sits in.
 *
 * It replaces a native `<select>`, and the reason is not decoration. A select
 * renders its popup in the platform's own list, at the platform's own size, in
 * the platform's own colours — so the two most-used controls on the prompt bar
 * were the only two things in the workbench that did not follow the theme, and
 * the high-contrast theme could not reach them at all. The button is also free
 * to say `Sonnet 4.6` and let the menu carry the provider, where the select had
 * to fit both into whatever width it happened to have.
 *
 * The keyboard contract is the one a `<select>` already taught people: arrows
 * move through the options, Enter and Space open and commit, Escape closes and
 * gives focus back to the button. `aria-activedescendant` is deliberately not
 * used here — focus really does move onto each option, which is what makes the
 * arrow keys work for a screen reader without a second announcement path.
 */
const ChoiceMenu = ({ label, value, displayValue, disabled = false, disabledTitle, options, onPick, tone, glyph, compact = false, plain = false, align = "start" }: {
  label: string
  value: string
  displayValue?: string
  disabled?: boolean
  disabledTitle?: string
  options: { key: string; label: React.ReactNode; hint?: string; tone?: Tone; glyph?: React.JSX.Element; marks?: React.JSX.Element | undefined; triggerLabel?: React.ReactNode }[]
  onPick: (key: string) => void
  /**
   * Colours the trigger's own word and glyph. Nothing else.
   *
   * It used to come with a soft seat as well — `warningSoft` or `successSoft`
   * behind the word — and that made one pill on a row of ghost pills into a
   * small card, sitting on the canvas under a composer that is itself the only
   * card in the region. Two objects claiming the same kind of surface, one of
   * them 28px tall. The colour was always the part doing the work: it is what
   * a person reads from across the room, and it survives the seat's removal
   * intact, on a substrate `theme/contrast.test.ts` measures directly.
   *
   * There used to be a status dot in front of it as well. It was six pixels of
   * the same colour the word beside it was already carrying, on a row where
   * every other control is a word — so it read as a bullet on three of the
   * chips and as nothing at all on the fourth, and it cost the model chip a
   * character of the name it exists to show. The word is the state; colouring
   * the word is enough, and it is what survives when a person cannot tell the
   * tones apart, which a dot alone never did.
   */
  tone?: Tone | undefined
  /** Drawn before the value — and alone when `compact`, the word being what a narrow row cannot afford. */
  glyph?: React.JSX.Element | undefined
  compact?: boolean
  /** Neutral text with no state-coloured seat. */
  plain?: boolean
  /** Which edge of the trigger the popup hangs from; `end` for a chooser at the end of its row. */
  align?: "start" | "end"
}): React.JSX.Element => {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const current = options.findIndex((option) => option.key === value)
  /** The chip's own label when an option carries one: the row stays a plain word, and the flourish lives only on the trigger. */
  const selected = current < 0 ? undefined : options[current]

  // Focus lands on the selected option, not the first one, so the arrows start
  // from where the person already is rather than from the top of the list.
  useEffect(() => {
    if (!open) return
    const rows = list.current?.querySelectorAll("button")
    const row = rows?.[current < 0 ? 0 : current]
    // Focus first without scrolling, then centre it. Letting focus do the
    // scrolling puts the selected row hard against whichever edge it entered
    // from, with a half-drawn row above it; a long model catalogue always
    // opened looking like it had been scrolled by accident.
    row?.focus({ preventScroll: true })
    row?.scrollIntoView({ block: "center" })
  }, [open, current])

  const close = (restore: boolean): void => {
    setOpen(false)
    if (restore) trigger.current?.focus()
  }

  const move = (from: number, delta: number): void => {
    const rows = list.current?.querySelectorAll("button")
    if (rows === undefined || rows.length === 0) return
    rows[(from + delta + rows.length) % rows.length]?.focus()
  }

  return (
    <div
      {...stylex.props(styles.choice)}
      // One handler for the whole control: a blur that lands outside it is the
      // only reliable "clicked elsewhere" signal that does not need a document
      // listener, and `relatedTarget` is what tells the two apart.
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}
      onKeyDown={(event) => { if (event.key === "Escape" && open) { event.preventDefault(); close(true) } }}
    >
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        title={disabled ? disabledTitle : undefined}
        onClick={() => setOpen((was) => !was)}
        {...stylex.props(
          focus.ring,
          styles.interactive,
          styles.chip,
          styles.chipButton,
          tone !== undefined && TONES[tone],
          plain && styles.chipPlain,
          compact && styles.chipDense,
          open && styles.chipOpen,
        )}
      >
        {glyph}
        {compact ? null : <span {...stylex.props(styles.chipValue)}>{selected?.triggerLabel ?? selected?.label ?? displayValue ?? value}</span>}
        {compact ? null : <ChevronDown size={12} aria-hidden="true" {...stylex.props(styles.chipChevron, open && styles.chipChevronOpen)} />}
      </button>
      {!open ? null : (
        <ul ref={list} role="listbox" aria-label={label} {...stylex.props(scrollbars.thin, styles.menu, styles.choiceMenu, align === "end" && styles.choiceMenuEnd)}>
          {options.map((option, index) => (
            <li key={option.key} role="option" aria-selected={option.key === value} {...stylex.props(styles.menuRow, option.key === value && styles.choiceSelected)}>
              <button
                type="button"
                onClick={() => { onPick(option.key); close(true) }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault()
                    move(index, event.key === "ArrowDown" ? 1 : -1)
                  }
                }}
                {...stylex.props(focus.ring, styles.interactive, styles.menuButton, styles.choiceRow)}
              >
                {option.glyph === undefined ? null : <span {...stylex.props(styles.choiceGlyph, option.tone !== undefined && TONES[option.tone])}>{option.glyph}</span>}
                <span {...stylex.props(styles.choiceText)}>
                  <span {...stylex.props(styles.menuLabel, styles.choiceLabel, option.tone !== undefined && TONES[option.tone])}>{option.label}</span>
                  {option.hint === undefined ? null : <span {...stylex.props(styles.choiceCaption)}>{option.hint}</span>}
                </span>
                {option.marks}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * The ring's geometry, in its own user units.
 *
 * A 14-unit box holding a 5-unit radius at 2 wide leaves a half unit of air
 * outside the stroke, so nothing clips when the browser rounds. Drawn at 14
 * device pixels, which is about the cap height of the label beside it — the
 * gauge reads as a piece of punctuation in the row rather than a widget on it.
 */
const RING_BOX = 14
const RING_RADIUS = 5
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

/**
 * How full the context window is, in the smallest thing that can say it.
 *
 * The row used to print `12,345 / 200,000` in mono, which is the widest control
 * on it and the one nobody reads to the digit. A ring, a percentage, and the
 * word only when there is room for it: the exact counts move into the title,
 * and the activity rail keeps the full breakdown including where compaction
 * lands.
 *
 * The arc is exact, and that is worth a note because the activity rail's bar is
 * not. A CSS length computed per render would have to be an inline style, and
 * this renderer's CSP carries no `style-src 'unsafe-inline'` — so the rail
 * picks from twenty-one declared widths. `stroke-dashoffset` is not a style: it
 * is an SVG geometry attribute, in the same class as the `cx` and `r` beside
 * it, and `style-src` has nothing to say about attributes React sets on an
 * `<svg>` child. So the ring gets the unrounded fraction, and no quantisation
 * has to be explained to anyone reading it.
 */
const ContextGauge = ({ context, dense }: {
  context: NonNullable<SessionSnapshot["usage"]["context"]>
  dense: boolean
}): React.JSX.Element => {
  const reading = readContext(context)
  const threshold = context.compactionThresholdTokens
  const title = `${context.usedTokens.toLocaleString()} of ${context.maxTokens.toLocaleString()} context tokens used${threshold === undefined ? "" : ` · compacts at ${threshold.toLocaleString()}`}`
  const centre = RING_BOX / 2
  return (
    <span title={title} {...stylex.props(styles.context)}>
      {dense ? null : <span {...stylex.props(styles.contextWord)}>Context</span>}
      {/*
        A meter rather than a progressbar, for the reason the activity rail's
        meter states: this is a measurement inside a known range, not a task
        advancing towards completion, and the two are read aloud differently.
        The role goes on the wrapper and the drawing is hidden, so the two
        circles are never announced as anything of their own.
      */}
      <span role="meter" aria-valuenow={reading.percent} aria-valuemin={0} aria-valuemax={100} aria-label="Context window used" {...stylex.props(styles.gauge)}>
        <svg width={RING_BOX} height={RING_BOX} viewBox={`0 0 ${String(RING_BOX)} ${String(RING_BOX)}`} fill="none" aria-hidden="true" {...stylex.props(styles.ring)}>
          <circle cx={centre} cy={centre} r={RING_RADIUS} {...stylex.props(styles.ringTrack)} />
          {/*
            One dash as long as the whole circle, pulled back by what is unused:
            at zero the offset is the full circumference and nothing is drawn,
            at one it is nought and the ring closes. `styles.ring` turns the
            drawing a quarter turn so the arc leaves twelve o'clock, which is
            where a person expects a gauge to start rather than at three.
          */}
          <circle
            cx={centre}
            cy={centre}
            r={RING_RADIUS}
            strokeDasharray={RING_LENGTH}
            strokeDashoffset={RING_LENGTH * (1 - reading.fraction)}
            {...stylex.props(styles.ringFill, RING_RAMP[contextRampStop(reading.warmth)] ?? RING_RAMP[0])}
          />
        </svg>
      </span>
      <span {...stylex.props(styles.contextPercent, TEXT_PRESSURE[reading.pressure])}>{reading.percent}%</span>
    </span>
  )
}

/**
 * The rungs of the thinking ladder, from none lit to all six.
 *
 * The reference prompt bar draws its performance levels as circle steps —
 * dashed, half, full. Three rungs is an icon font's ladder; seven is not,
 * and inventing four glyphs nobody has learned is worse than lighting a
 * share of one ring.
 */
const EFFORT_STEPS: Record<ThinkingLevel, number> = {
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
}

/**
 * The dash and the gap, in the ring's own units: two dashes to a rung,
 * twelve around the ring.
 *
 * Dashed, and that is the point. A solid arc filling to the rung was the
 * context gauge in miniature — same box, same radius, same twelve o'clock
 * start — and two identical instruments on one row saying different things
 * (one reads pressure, the other a setting) is a confusion the row does not
 * survive. Twelve short marks rather than six long ones: the ring reads as
 * one dense texture instead of six slabs, and what the rung says is carried
 * by the proportion lit — half the ring is half the ladder, which is all
 * the reference's own half-full circle ever said.
 */
const EFFORT_DASHES_PER_STEP = 2
const EFFORT_GAP = 1
const EFFORT_DASH = RING_LENGTH / (EFFORT_STEPS.max * EFFORT_DASHES_PER_STEP) - EFFORT_GAP

/**
 * A thinking level as a ring of dashes: the track draws all twelve in the
 * recess colour, the rung lights its share, and off lights none — the
 * honest picture of no reasoning at all. The dash pattern is an attribute
 * for the reason the gauge's offset is: `stroke-dasharray` is geometry, and
 * `style-src` has nothing to say about geometry. The fill's pattern is its
 * dash-and-gap repeated once per lit step and then a gap longer than the
 * circle — which is how a repeating pattern is made to stop, since nothing
 * after the terminator ever draws.
 */
const EffortRing = ({ level }: { level: ThinkingLevel }): React.JSX.Element => {
  const centre = RING_BOX / 2
  const lit = EFFORT_STEPS[level] * EFFORT_DASHES_PER_STEP
  return (
    <svg width={RING_BOX} height={RING_BOX} viewBox={`0 0 ${String(RING_BOX)} ${String(RING_BOX)}`} fill="none" aria-hidden="true" {...stylex.props(styles.ring)}>
      <circle cx={centre} cy={centre} r={RING_RADIUS} strokeDasharray={`${EFFORT_DASH} ${EFFORT_GAP}`} {...stylex.props(styles.ringTrack)} />
      {lit === 0 ? null : (
        <circle
          cx={centre}
          cy={centre}
          r={RING_RADIUS}
          strokeDasharray={`${`${EFFORT_DASH} ${EFFORT_GAP} `.repeat(lit)}0 ${RING_LENGTH}`}
          {...stylex.props(styles.ringFill, styles.effortArc)}
        />
      )}
    </svg>
  )
}

/**
 * The cipher glyphs a decrypt plays through on its way to a word.
 *
 * Operators and box drawing, no letters. Letters would accidentally spell
 * words and the eye would try to parse the noise; symbols never do.
 */
const DECRYPT_GLYPHS = "!<>-_\\/[]{}—=+*^?#"
/** One tick of the scramble, in milliseconds. */
const DECRYPT_TICK = 28
/** Ticks each character spends scrambled before it settles, left to right. */
const DECRYPT_TICKS_PER_CHAR = 3

const scramble = (length: number): string => {
  let out = ""
  for (let index = 0; index < length; index += 1) out += DECRYPT_GLYPHS[Math.floor(Math.random() * DECRYPT_GLYPHS.length)]
  return out
}


/**
 * The thinking chip's top rung, which decrypts once each time it is picked
 * — the one flourish the bar saves for Max.
 *
 * Canvas UI's decrypt-reveal renders the page as cipher and decodes it
 * around the cursor, which is an html-in-canvas shader this CSP would never
 * admit. But the read of it is only "scrambled glyphs settling into a
 * word", and that is text rather than paint: an interval and a charset, no
 * styles, so `style-src` and the no-`new Function` rule never come into it.
 *
 * Mount is the only trigger, so it plays exactly once per selection:
 * picking Max swaps the chip's plain string for this component, and leaving
 * Max swaps it back — so changing away and back decrypts again, while
 * reopening the menu, or re-picking the rung already sat on, never does.
 * The menu row is a plain word throughout; `triggerLabel` on the option is
 * what lets the two differ. While the scramble runs it wears a chromatic
 * fringe — the theme's
 * red a pixel left, its blue a pixel right — and the settled word is clean,
 * because the aberration is the effect's costume, not its text. The word
 * itself is always present for a screen reader in a visually-hidden twin;
 * the scramble is decoration and hidden from the a11y tree outright.
 * Reduced motion gets the word with no ceremony, checked at play time the
 * way EffortScrubber checks it at render time.
 */
const DecryptText = ({ text }: { text: string }): React.JSX.Element => {
  const [display, setDisplay] = useState(text)
  const [playing, setPlaying] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  const stop = (): void => {
    if (timer.current !== undefined) {
      window.clearInterval(timer.current)
      timer.current = undefined
    }
  }

  const play = (): void => {
    stop()
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    let ticks = 0
    setPlaying(true)
    // Scramble synchronously, so not one painted frame shows the settled word.
    setDisplay(scramble(text.length))
    timer.current = window.setInterval(() => {
      ticks += 1
      const settled = Math.floor(ticks / DECRYPT_TICKS_PER_CHAR)
      if (settled >= text.length) {
        stop()
        setDisplay(text)
        setPlaying(false)
        return
      }
      setDisplay(text.slice(0, settled) + scramble(text.length - settled))
    }, DECRYPT_TICK)
  }

  // Mount is the whole of it: picking Max swaps the chip's plain string for
  // this component, and the layout effect fires before the first paint.
  useLayoutEffect(() => {
    play()
    return stop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <span {...stylex.props(styles.decrypt)}>
      <span {...stylex.props(a11y.visuallyHidden)}>{text}</span>
      <span aria-hidden="true" {...stylex.props(styles.decryptSizer)}>{text}</span>
      <span aria-hidden="true" {...stylex.props(styles.decryptOverlay)}>
        {!playing ? null : (
          <>
            <span {...stylex.props(styles.decryptFringe, styles.decryptFringeRed)}>{display}</span>
            <span {...stylex.props(styles.decryptFringe, styles.decryptFringeBlue)}>{display}</span>
          </>
        )}
        {display}
      </span>
    </span>
  )
}

/**
 * One attachment, as a tile rather than a chip.
 *
 * Fluid shows a thumbnail for an image and this cannot: the contract carries a
 * path, a media type and a byte count, never the bytes — renderer-side bytes
 * not crossing the boundary is the rule the whole attachment design rests on.
 * So the tile spends its room on the media type, the name and the size, which
 * are the three things a person checks before sending anyway.
 */
const AttachmentTile = ({ attachment }: { attachment: Attachment }): React.JSX.Element => {
  const name = basename(attachment.path)
  const Glyph = attachment.mediaType.startsWith("image/") ? Image : attachment.mediaType.startsWith("text/") ? FileText : File
  return (
    <li title={`${attachment.path} · ${formatBytes(attachment.bytes)}`} {...stylex.props(styles.tile)}>
      <button type="button" onClick={() => store.removeAttachment(attachment.path)} aria-label={`Remove ${name}`} {...stylex.props(focus.ring, styles.interactive, styles.tileRemove)}><X size={12} /></button>
      <Glyph size={24} aria-hidden="true" {...stylex.props(styles.tileGlyph)} />
      <span {...stylex.props(styles.tileName)}>{name}</span>
      <span {...stylex.props(styles.tileSize)}>{formatBytes(attachment.bytes)}</span>
    </li>
  )
}

const basename = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

/** Decimal rather than binary, because the picker beside it says KB too. */
const formatBytes = (bytes: number): string =>
  bytes < 1_000 ? `${bytes} B` : bytes < 1_000_000 ? `${Math.round(bytes / 1_000)} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`

/**
 * A context window as a person quotes it: 200,000 is "200K", a million and a
 * half is "1.5M". Decimal rather than binary, for the same reason as the
 * bytes above.
 */
const formatContext = (tokens: number): string =>
  tokens >= 1_000_000 ? `${Math.round(tokens / 100_000) / 10}M` : `${Math.round(tokens / 1_000)}K`

/**
 * The mark of the lab behind a model, when one of the tables knows the id.
 *
 * `undefined` rather than an empty glyph, and the two callers differ on what
 * they do with it: the trigger falls back to the generic processor it drew
 * before, and a row in the list draws nothing at all — a catalogue where only
 * some rows are marked still reads as a catalogue with marks, while a column of
 * reserved empty boxes reads as a rendering fault.
 */
const labGlyph = (modelId: string, providerId: string): React.JSX.Element | undefined => {
  const mark = labMarkForModel({ id: modelId, providerId })
  return labArtwork(mark) === undefined ? undefined : <LabIcon mark={mark} />
}

/**
 * The caption under a model's name: whose it is, and how much of a
 * conversation it holds. The two facts a person compares when picking between
 * models they cannot otherwise tell apart, in the order they ask them.
 */
const modelCaption = (model: Model, providerNames: Map<string, string>): string => {
  const provider = providerNames.get(model.providerId) ?? model.providerId
  return model.contextWindowTokens === undefined ? provider : `${provider} · ${formatContext(model.contextWindowTokens)} context`
}

/**
 * What a model can do, as marks at the row's end.
 *
 * Only the two capabilities that change what the next message may be: whether
 * it can see an image, and whether it can reason — the second being what the
 * chooser beside this one spends. Tool calls carry no mark because calling
 * tools is the premise of an agent's picker rather than a difference inside
 * it, and a mark on every row says nothing.
 */
const modelMarks = (model: Model): React.JSX.Element | undefined => {
  if (!model.supportsVision && !model.supportsThinking) return undefined
  return (
    <span {...stylex.props(styles.choiceMarks)}>
      {model.supportsVision ? <span role="img" aria-label="Understands images" title="Understands images" {...stylex.props(styles.choiceMark)}><Image size={12} aria-hidden="true" /></span> : null}
      {model.supportsThinking ? <span role="img" aria-label="Can reason" title="Can reason" {...stylex.props(styles.choiceMark)}><Brain size={12} aria-hidden="true" /></span> : null}
    </span>
  )
}

const TONES = stylex.create({
  faint: { color: colors.textFaint },
  reasoning: { color: colors.reasoning },
  success: { color: colors.success },
  running: { color: colors.running },
  warning: { color: colors.warning },
  danger: { color: colors.danger },
})
/** The gauge's ring, and its percentage, take the same three readings. */
/**
 * The gauge's arc, warming as the window fills.
 *
 * Ten stops between three tokens, `CONTEXT_RAMP_STOPS` apart: the neutral
 * accent at empty, `warning` at the stop the reading calls pressing, `danger`
 * at full. `readContext` anchors the middle stop on the model's own compaction
 * threshold, so the ring turns amber exactly where the percentage beside it
 * does — the ramp adds resolution to that signal rather than a second one.
 *
 * The in-between colours are `color-mix` over the theme's own variables rather
 * than nine new literals, which is what keeps a themed gauge themed: high
 * contrast mixes its reds, light mixes its ambers, and no palette gains a
 * colour nobody chose. They are not measured by `theme/contrast.test.ts`,
 * because a mix has no token to measure — but every stop lies between two
 * colours that are, on the one substrate this is drawn on. Contrast against a
 * fixed background is monotone in luminance and each theme keeps its whole
 * status set on one side of the canvas, so a stop cannot be less readable than
 * the poorer of the two ends it came from. Both ends are asserted at 4.5.
 */
const RAMP = stylex.create({
  stop0: { stroke: colors.accent },
  stop1: { stroke: `color-mix(in oklab, ${colors.accent} 80%, ${colors.warning})` },
  stop2: { stroke: `color-mix(in oklab, ${colors.accent} 60%, ${colors.warning})` },
  stop3: { stroke: `color-mix(in oklab, ${colors.accent} 40%, ${colors.warning})` },
  stop4: { stroke: `color-mix(in oklab, ${colors.accent} 20%, ${colors.warning})` },
  stop5: { stroke: colors.warning },
  stop6: { stroke: `color-mix(in oklab, ${colors.warning} 75%, ${colors.danger})` },
  stop7: { stroke: `color-mix(in oklab, ${colors.warning} 50%, ${colors.danger})` },
  stop8: { stroke: `color-mix(in oklab, ${colors.warning} 25%, ${colors.danger})` },
  stop9: { stroke: colors.danger },
})

/** The ramp by index, which is how `contextRampStop` addresses it. */
const RING_RAMP = [RAMP.stop0, RAMP.stop1, RAMP.stop2, RAMP.stop3, RAMP.stop4, RAMP.stop5, RAMP.stop6, RAMP.stop7, RAMP.stop8, RAMP.stop9]

/**
 * The percentage beside the ring, which is text and is held to text's
 * threshold. It was `textFaint` while calm — a 3.0 colour for hints and line
 * numbers — on a number that is the whole reason the gauge is on the row.
 */
const TEXT_PRESSURE = stylex.create({
  calm: { color: colors.textMuted },
  pressing: { color: colors.warning },
  critical: { color: colors.danger },
})

const styles = stylex.create({
  area: { display: "flex", flexDirection: "column", gap: space.xs, paddingBlockEnd: size.gutter, paddingInline: size.columnInset, backgroundColor: colors.canvas },

  /**
   * Inset from the composer on both sides, with no surface of its own. A box
   * around staged text made the queue look like a second composer. The index
   * and the muted type are the whole labelling mechanism.
   */
  queue: { width: "100%", maxWidth: `calc(${size.column} - ${space.xl})`, marginInline: "auto", marginBlock: 0, padding: 0, listStyle: "none", boxSizing: "border-box" },
  queueRow: { height: size.controlDense, display: "flex", alignItems: "center", gap: space.sm, paddingInline: space.sm, borderRadius: radius.sm },
  queueIndex: { flex: "none", width: "13px", textAlign: "center", color: colors.textFaint, fontFamily: typography.mono, fontSize: typography.micro },
  queueMode: { flex: "none", color: colors.textFaint, fontSize: typography.micro, fontWeight: 700, textTransform: "uppercase" },
  /** Muted, because none of it has been sent yet. */
  queueText: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.textMuted, fontSize: typography.label, lineHeight: typography.labelLine },
  queueMore: { color: colors.accent, fontSize: typography.caption },

  /**
   * The composer's own box, moved out one level so a menu can be positioned
   * against it. The composer is the anchor rather than the section, because a
   * menu aligned to the section would start at the gutter and a menu aligned to
   * the window would drift as the rails resize.
   */
  anchor: { position: "relative", maxWidth: size.column, width: "100%", marginInline: "auto" },
  /** See `size.columnResting`: an empty session has no transcript to line up with. */
  anchorResting: { maxWidth: size.columnResting },

  /**
   * Above the field rather than below it, always.
   *
   * The composer sits at the bottom of the column, so a menu under it would be
   * off-screen or would push the field it belongs to. Growing upward also keeps
   * the row a person is aiming at nearest the caret they are typing with.
   */
  menu: { position: "absolute", insetInline: 0, insetBlockEnd: `calc(100% + ${space.sm})`, zIndex: 2, margin: 0, padding: space.xs, listStyle: "none", backgroundColor: colors.surfaceOverlay, borderRadius: radius.lg, boxShadow: effects.liftOverlay },
  menuRow: { display: "block" },
  /** A fill, not an outline: the active row recesses from the overlay in every theme. */
  menuRowActive: { backgroundColor: colors.sunken, borderRadius: radius.sm },
  menuButton: { width: "100%", height: size.controlDense, display: "flex", alignItems: "center", gap: space.sm, paddingInline: space.sm, color: colors.text, backgroundColor: "transparent", borderWidth: 0, borderRadius: radius.sm, textAlign: "start", fontFamily: typography.ui, fontSize: typography.label },
  menuGlyph: { flex: "none", width: size.iconMicro, display: "grid", placeItems: "center", color: colors.textMuted },
  menuLabel: { flex: "none", maxWidth: "50%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 },
  menuHint: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.textFaint, textAlign: "end", fontFamily: typography.mono, fontSize: typography.micro },
  menuFoot: { paddingBlock: space.xs, paddingInline: space.sm, color: colors.textFaint, fontSize: typography.micro, lineHeight: typography.microLine },

  composer: { position: "relative", width: "100%", boxSizing: "border-box", display: "grid", gridTemplateColumns: "minmax(0, 1fr)", rowGap: space.sm, padding: space.md, backgroundColor: colors.surfaceRaised, borderWidth: effects.hairline, borderStyle: "solid", borderColor: { default: colors.border, ":focus-within": colors.focus }, borderRadius: radius.lg, boxShadow: { default: effects.lift, ":focus-within": effects.liftRaised }, transitionProperty: "background-color, box-shadow", transitionDuration: motion.fast, transitionTimingFunction: motion.settle },
  composerFileDrop: { backgroundColor: colors.accentSoft, boxShadow: effects.liftRaised },

  tiles: { gridColumn: "1 / -1", display: "flex", flexWrap: "wrap", gap: space.sm, margin: 0, padding: 0, listStyle: "none" },
  tile: { position: "relative", width: size.attachmentTile, height: size.attachmentTile, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: space.xs, padding: space.sm, backgroundColor: colors.sunken, borderRadius: radius.sm },
  tileRemove: { position: "absolute", insetBlockStart: "2px", insetInlineEnd: "2px", width: size.icon, height: size.icon, display: "grid", placeItems: "center", padding: 0, color: { default: colors.textFaint, ":hover": colors.text }, backgroundColor: { default: "transparent", ":hover": colors.surfaceOverlay }, borderWidth: 0, borderRadius: radius.sm },
  tileGlyph: { flex: "none", color: colors.textMuted },
  tileName: { maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.textMuted, fontSize: typography.micro, lineHeight: typography.microLine },
  tileSize: { color: colors.textFaint, fontFamily: typography.mono, fontSize: typography.micro },

  /** The field alone on the card's first row — nothing beside it to align to. */
  editor: { minWidth: 0, display: "flex" },

  /**
   * The card's control row: message-scoped controls on the left — files, and
   * the permission level the send will run under — and the verbs on the
   * right. One 28px height for all of them, so the row reads as one line of
   * equal seats.
   */
  controlRow: { minWidth: 0, display: "flex", alignItems: "center", gap: space.xs },
  /**
   * The standing choices, below and outside the card: a caption row rather
   * than a control surface. It keeps the card's inset through the pills' own
   * padding — 4 here plus their 8 lands their words on the same 12px column
   * the card's contents keep — and takes no surface of its own.
   */
  belowRow: { minWidth: 0, display: "flex", alignItems: "center", gap: space.xs, marginBlockStart: space.xs, paddingInline: space.xs },
  /** Where a row's two halves part. */
  rowSpacer: { flex: 1 },

  /**
   * `field-sizing: content` is what grows the field with what is in it. The
   * alternative is measuring `scrollHeight` and assigning a height, which would
   * be the renderer writing style imperatively — the one thing this codebase
   * keeps out so `style-src` can stay free of `unsafe-inline`.
   *
   * One comfortable line at rest, then content-sized growth. Eight lines is the
  * ceiling: past that the composer has become a document, and the scrollbar is
  * the honest answer.
   */
  textarea: { flex: 1, minWidth: 0, boxSizing: "border-box", fieldSizing: "content", minHeight: "44px", maxHeight: "216px", resize: "none", paddingBlock: space.sm, paddingInline: space.sm, color: colors.text, "::placeholder": { color: colors.textFaint }, backgroundColor: "transparent", borderWidth: 0, outline: "none", fontFamily: typography.ui, fontSize: typography.body, lineHeight: typography.bodyLine, caretColor: colors.accent },

  chip: { height: size.controlDense, display: "inline-flex", alignItems: "center", gap: space.xs, paddingInline: space.sm, color: colors.textMuted, borderRadius: radius.md, fontSize: typography.label, whiteSpace: "nowrap" },
  /**
   * Permissions keep their semantic tone. Thinking is deliberately neutral:
   * effort is a setting rather than a status, so its trigger and option labels
   * use the ordinary high-contrast text colour without a coloured seat.
   */
  /** Square, so a glyph alone sits centred rather than left of an empty run. */
  chipDense: { width: size.controlDense, paddingInline: 0, justifyContent: "center" },
  /**
   * The chooser is positioned from here, and it is the only chip allowed to
   * shrink: a model name is the longest thing on the row and the least costly
   * to clip, because the menu carries the whole of it a click away.
   */
  choice: { position: "relative", display: "flex", minWidth: 0, flexShrink: 1 },
  /**
   * A chooser trigger as a ghost pill: no seat, no edge, a muted word at rest
   * and a fill when a pointer arrives. The recessed well it used to sit in
   * was furniture for a settings row inside the card; with the standing
   * choices below the card on the canvas, a pill only needs to step away from
   * its ground on hover. That is now true of every chip on the row, the toned
   * one included — its state is in the word, and a word does not need a card
   * behind it to be read.
   *
   * Hover is a lift *and* a fill, and the fill is the reason
   * `theme/contrast.test.ts` measures the status colours on `surfaceOverlay`
   * as well as on their own soft fills and on the canvas. Those three are the
   * whole set of substrates a tinted word is drawn on, and the third one only
   * exists while a pointer is on it — which is the easiest kind of pairing to
   * ship unmeasured.
   */
  chipButton: { maxWidth: "100%", borderWidth: 0, backgroundColor: { default: "transparent", ":hover": colors.surfaceOverlay }, color: { default: colors.textMuted, ":hover": colors.text }, boxShadow: { default: "none", ":hover": effects.lift, ":focus-visible": effects.focusState }, fontFamily: typography.ui, fontWeight: 500 },
  chipPlain: { color: colors.text },
  chipValue: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  /**
   * An open chooser stays raised for as long as its menu is up.
   *
   * Without it the trigger drops back to rest the moment the pointer leaves it
   * to travel to the menu, and the row shows a menu belonging to nothing. It is
   * the hover lift one step further rather than a different fill, for the
   * reason `chipButton` gives: the toned chips' fill is already saying
   * something, and the trigger of an open menu is the last place to overwrite
   * it.
   */
  chipOpen: { boxShadow: { default: effects.liftRaised, ":focus-visible": effects.focusState } },
  /** Turning over is what says the menu is above the chip rather than below it. */
  chipChevron: { flex: "none", color: colors.textFaint, transitionProperty: "transform", transitionDuration: motion.fast, transitionTimingFunction: motion.settle },
  chipChevronOpen: { transform: "rotate(180deg)" },
  /**
   * Anchored to its own trigger rather than to the composer, and sized to its
   * contents — a list of three thinking levels has no business being as wide as
   * a list of twenty models.
   *
   * The cap is 320 rather than 340 because 340 does not fit. `styles.menu` sets
   * `insetInline: 0`, which this has to undo to anchor to the trigger, and
   * undoing it also removes the only thing that was keeping the menu inside the
   * composer. The narrowest composer the layout reaches is the conversation
   * floor less its gutters — 480 - 32 = 448 — and a 340px menu opened from a
   * chip on that row leaves the composer on one side or the other. 320 is the
   * widest cap that survives it in both directions, measured at every composer
   * width between 448 and 880.
   *
   * The floor is 248 rather than the trigger's own width because every row now
   * stacks a caption under its label, and a caption narrower than that breaks
   * after every third word instead of where the sentence does. The ceiling on
   * height is seven rows plus the menu's padding: the longest thinking ladder
   * is all seven levels, and it opens whole rather than a rung short.
   */
  choiceMenu: { insetInline: "auto auto", insetInlineStart: 0, minWidth: "248px", maxWidth: "320px", width: "max-content", maxHeight: "304px", overflowY: "auto" },
  /**
   * The same menu hung from the trigger's trailing edge instead of its leading
   * one, for a chooser that sits at the end of its row.
   *
   * A 320px popup anchored to the start of a pill 40px from the right edge of
   * the column leaves most of itself outside the conversation, which is where
   * nothing else in this interface is allowed to be. Flipping the anchor is
   * enough because the row has only two ends; a chooser in the middle of a row
   * would need measurement, and there is no such chooser.
   */
  choiceMenuEnd: { insetInlineStart: "auto", insetInlineEnd: 0 },
  /**
   * Selection is the accent's soft wash across the whole row, not a trailing
   * check. A checkmark says "picked from a list"; the wash says "this is where
   * the setting sits" — and it survives greyscale, which a second grey glyph
   * beside the status dot did not.
   */
  choiceSelected: { backgroundColor: colors.accentSoft, borderRadius: radius.sm },
  choiceRow: { gap: space.sm, height: "auto", minHeight: size.controlDense, paddingBlock: space.xs },
  /** Repeats the trigger's glyph on its row, centred against the row rather than its first line. */
  choiceGlyph: { flex: "none", width: size.icon, display: "grid", placeItems: "center", alignSelf: "center" },
  /** A label over its caption, so every row in the menu shares one left edge. */
  choiceText: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "1px" },
  choiceLabel: { maxWidth: "none" },
  choiceCaption: { flex: "none", width: "100%", overflow: "visible", color: colors.textMuted, fontFamily: typography.ui, textAlign: "start", textOverflow: "clip", whiteSpace: "normal", fontSize: typography.micro, lineHeight: typography.microLine },
  /** Capability marks close the row, faint until their title is asked for. */
  choiceMarks: { flex: "none", alignSelf: "center", display: "flex", alignItems: "center", gap: space.xs },
  choiceMark: { display: "grid", placeItems: "center", color: colors.textFaint },

  /**
   * The gauge: the word, a short bar, the percentage. It keeps the chips'
   * height so the control row stays one line of equal seats, and it takes no
   * seat of its own because it is a reading rather than a control.
   */
  context: { height: size.controlDense, display: "inline-flex", alignItems: "center", gap: space.xs, paddingInline: space.xs, color: colors.textMuted, whiteSpace: "nowrap" },
  contextAbsent: { fontFamily: typography.ui, fontSize: typography.label },
  contextWord: { fontFamily: typography.ui, fontSize: typography.label },
  contextPercent: { fontFamily: typography.mono, fontSize: typography.micro, fontVariantNumeric: "tabular-nums" },
  gauge: { flex: "none", display: "grid", placeItems: "center" },
  /**
   * A quarter turn anticlockwise, so the arc leaves twelve o'clock rather than
   * three. The rotation is static — it is the drawing's orientation, not the
   * reading — which is what keeps the only per-render value in an attribute.
   */
  ring: { display: "block", transform: "rotate(-90deg)" },
  /** The unused part of the window: the recess every other well in here sits in. */
  /**
   * The unfilled part of a ring, and the reason the gauge was hard to see.
   *
   * It was `sunken`, which is a *surface* one step below the canvas: on the
   * canvas this row sits on it came out at about 1.1:1 in every theme — a ring
   * that is only there once it is nearly full, so an empty window looked like
   * a missing control. `borderStrong` is the token for a boundary that has to
   * be seen, roughly 2:1 here, which reads as a ring without competing with
   * the arc inside it or with the number beside it.
   */
  ringTrack: { fill: "none", stroke: colors.borderStrong, strokeWidth: 2 },
  /**
   * The used part. Butt caps rather than round: a round cap two units wide on a
   * five-unit radius draws about a thirteenth of the circle on its own, so an
   * empty window would show a floating bead and a full one would overlap its
   * own start. The stroke transitions because the arc moves on its own between
   * turns, and a jump reads as a glitch where a sweep reads as growth.
   */
  ringFill: { fill: "none", strokeWidth: 2, strokeLinecap: "butt", transitionProperty: "stroke-dashoffset, stroke", transitionDuration: motion.slow, transitionTimingFunction: motion.settle },
  /** The effort rung's arc: muted, so seven rings in one menu serve their words rather than outshout them. */
  effortArc: { stroke: colors.textMuted },
  /** Positioned, so the scramble and its fringes have a containing block. */
  decrypt: { position: "relative", display: "block" },
  /** Holds the final word's width invisibly, so the scramble never resizes the chip it sits in. */
  decryptSizer: { visibility: "hidden" },
  /** The scrambling text, drawn over the sizer. */
  decryptOverlay: { position: "absolute", insetInlineStart: 0, insetBlockStart: 0 },
  /** A chromatic fringe, worn only while the scramble runs — the settled word is clean. */
  decryptFringe: { position: "absolute", insetInlineStart: 0, insetBlockStart: 0, opacity: 0.8 },
  decryptFringeRed: { color: colors.danger, transform: "translateX(-1px)" },
  decryptFringeBlue: { color: colors.running, transform: "translateX(1px)" },

  interactive: { transitionProperty: "background-color, border-color, box-shadow, color, opacity, transform", transitionDuration: motion.fast, transitionTimingFunction: motion.settle, transform: { default: "translateY(0)", ":active": "translateY(1px)" }, cursor: { default: "pointer", ":disabled": "not-allowed" }, opacity: { default: 1, ":disabled": 0.4 } },
  iconButton: { width: size.controlDense, height: size.controlDense, flex: "none", display: "grid", placeItems: "center", padding: 0, color: { default: colors.textMuted, ":hover": colors.text }, backgroundColor: { default: "transparent", ":hover": colors.surfaceOverlay }, borderWidth: 0, borderRadius: radius.md },
  iconButtonOpen: { color: colors.text, backgroundColor: colors.surfaceOverlay },
  /**
   * One geometry for all four verbs: a 28px icon seat, the height every
   * chooser pill on the bar already keeps. Words used to ride beside the
   * glyphs, and at three wide during a turn the cluster outweighed the draft
   * it served — stop, steer, queue and send are four of the most drawn buttons
   * in software, and the title and aria-label say the word for anyone who does
   * not read the glyph. Icon-only also retires the dense variant: there is no
   * label left to give up, and nothing changes size when a turn starts and
   * Send becomes Queue.
   */
  action: { width: size.controlDense, height: size.controlDense, boxSizing: "border-box", flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", padding: 0, borderWidth: 0, borderRadius: radius.md, fontFamily: typography.ui, fontSize: typography.label, fontWeight: 600 },
  stop: { color: colors.danger, backgroundColor: colors.dangerSoft },
  /** The same seat with the alarm spent: pressed, and waiting on the turn. */
  stopping: { color: colors.textMuted, backgroundColor: colors.surfaceOverlay },
  steer: { color: { default: colors.text, ":disabled": colors.textFaint }, backgroundColor: colors.surfaceOverlay },
  /**
   * The one filled control in the composer, and it needs no shadow to say so:
   * it is the only thing here wearing the accent, on a surface that is already
   * raised. With nothing to send it gives the accent up entirely — a grey seat
   * and a faint arrow, the reference bar's answer to a button that is not yet
   * a verb.
   */
  send: { color: { default: colors.accentOn, ":disabled": colors.textFaint }, backgroundColor: { default: colors.accent, ":hover": colors.accentHover, ":disabled": colors.surfaceOverlay } },

})
