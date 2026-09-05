import { randomUUID } from "node:crypto"
import type { ExtensionUiRequest } from "@bake-pi/contract"
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent"
import type { EventEmitter } from "../emitter.ts"

/** A renderer that disappeared must not leave an extension parked forever. */
export const EXTENSION_UI_TIMEOUT_MS = 30 * 60_000

type DialogKind = ExtensionUiRequest["kind"]
type DialogResult = string | boolean | undefined

interface PendingDialog {
  request: ExtensionUiRequest
  defaultValue: DialogResult
  settle: (value: DialogResult) => void
  timer: NodeJS.Timeout | undefined
  signal: AbortSignal | undefined
  onAbort: () => void
}

/**
 * Bridges Pi's blocking extension UI promises onto the command/event contract.
 *
 * Pi calls a method on one shared `ExtensionUIContext`; the answer arrives later
 * as an unrelated renderer command. This object owns that gap. A response only
 * settles a request with the same id and kind, and every non-response path —
 * abort, timeout, session close, host shutdown — returns Pi's safe default.
 */
export class ExtensionUiGate {
  readonly #emitter: EventEmitter
  readonly #pending = new Map<string, PendingDialog>()
  readonly #bySession = new Map<string, Set<string>>()

  constructor(emitter: EventEmitter) {
    this.#emitter = emitter
  }

  contextFor(sessionId: string): ExtensionUIContext {
    return {
      select: async (title, options, dialogOptions) => {
        if (options.length === 0) return undefined
        const request: ExtensionUiRequest = {
          id: randomUUID(),
          sessionId,
          kind: "select",
          title: clamp(title, 256),
          options: options.slice(0, 64).map((option) => {
            const value = clamp(option, 256)
            return { value, label: value }
          }),
        }
        return (await this.#park(request, undefined, dialogOptions)) as string | undefined
      },
      confirm: async (title, message, dialogOptions) => {
        const request: ExtensionUiRequest = {
          id: randomUUID(),
          sessionId,
          kind: "confirm",
          title: clamp(title, 256),
          message: clamp(message, 4096),
        }
        return (await this.#park(request, false, dialogOptions)) as boolean
      },
      input: async (title, placeholder, dialogOptions) => {
        const request: ExtensionUiRequest = {
          id: randomUUID(),
          sessionId,
          kind: "input",
          title: clamp(title, 256),
          ...(placeholder === undefined ? {} : { placeholder: clamp(placeholder, 256) }),
          // Pi's input API carries no password/secret hint.
          secret: false,
        }
        return (await this.#park(request, undefined, dialogOptions)) as string | undefined
      },
      editor: async (title, prefill) => {
        const request: ExtensionUiRequest = {
          id: randomUUID(),
          sessionId,
          kind: "editor",
          title: clamp(title, 256),
          initialText: clamp(prefill ?? "", 1_048_576),
        }
        return (await this.#park(request, undefined)) as string | undefined
      },

      // Bake Pi models the four portable dialogs. Terminal components, theme
      // mutation, widgets and raw input have no renderer contract and retain
      // Pi print-mode's inert behavior instead of pretending to work.
      notify: () => {},
      onTerminalInput: () => () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      custom: async <T,>() => undefined as T,
      pasteToEditor: () => {},
      setEditorText: () => {},
      getEditorText: () => "",
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      // A terminal theme has no meaning in the renderer. Callers that need one
      // are using TUI-only UI and must guard on `ctx.mode`/`ctx.hasUI`.
      get theme() {
        return undefined as never
      },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "UI not available" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    }
  }

  respondSelect(requestId: string, value: string | null): boolean {
    const pending = this.#ofKind(requestId, "select")
    if (pending === undefined) return false
    if (value !== null && !pending.request.options.some((option) => option.value === value)) return false
    this.#resolve(requestId, value ?? undefined)
    return true
  }

  respondConfirm(requestId: string, confirmed: boolean): boolean {
    if (this.#ofKind(requestId, "confirm") === undefined) return false
    this.#resolve(requestId, confirmed)
    return true
  }

  respondInput(requestId: string, value: string | null): boolean {
    if (this.#ofKind(requestId, "input") === undefined) return false
    this.#resolve(requestId, value ?? undefined)
    return true
  }

  respondEditor(requestId: string, text: string | null): boolean {
    if (this.#ofKind(requestId, "editor") === undefined) return false
    this.#resolve(requestId, text ?? undefined)
    return true
  }

  cancelSession(sessionId: string): void {
    for (const requestId of [...(this.#bySession.get(sessionId) ?? [])]) this.#resolveDefault(requestId)
    this.#bySession.delete(sessionId)
  }

  cancelAll(): void {
    for (const requestId of [...this.#pending.keys()]) this.#resolveDefault(requestId)
  }

  #ofKind<K extends DialogKind>(requestId: string, kind: K): (PendingDialog & { request: Extract<ExtensionUiRequest, { kind: K }> }) | undefined {
    const pending = this.#pending.get(requestId)
    return pending?.request.kind === kind
      ? (pending as PendingDialog & { request: Extract<ExtensionUiRequest, { kind: K }> })
      : undefined
  }

  #park(
    request: ExtensionUiRequest,
    defaultValue: DialogResult,
    options?: ExtensionUIDialogOptions,
  ): Promise<DialogResult> {
    if (options?.signal?.aborted === true) return Promise.resolve(defaultValue)

    return new Promise<DialogResult>((resolve) => {
      const onAbort = (): void => this.#resolveDefault(request.id)
      options?.signal?.addEventListener("abort", onAbort, { once: true })

      const timeoutMs = options?.timeout ?? EXTENSION_UI_TIMEOUT_MS
      const timer = timeoutMs > 0 ? setTimeout(() => this.#resolveDefault(request.id), timeoutMs) : undefined
      this.#pending.set(request.id, {
        request,
        defaultValue,
        settle: resolve,
        timer,
        signal: options?.signal,
        onAbort,
      })

      const forSession = this.#bySession.get(request.sessionId) ?? new Set<string>()
      forSession.add(request.id)
      this.#bySession.set(request.sessionId, forSession)
      this.#emitter.emit("extension_ui_requested", { request }, request.sessionId)

      // The signal can change between the check above and listener attachment.
      if (options?.signal?.aborted === true) this.#resolveDefault(request.id)
    })
  }

  #resolveDefault(requestId: string): void {
    const pending = this.#pending.get(requestId)
    if (pending !== undefined) this.#resolve(requestId, pending.defaultValue)
  }

  #resolve(requestId: string, value: DialogResult): void {
    const pending = this.#pending.get(requestId)
    if (pending === undefined) return
    this.#pending.delete(requestId)
    this.#bySession.get(pending.request.sessionId)?.delete(requestId)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    pending.signal?.removeEventListener("abort", pending.onAbort)
    this.#emitter.emit("extension_ui_resolved", { requestId }, pending.request.sessionId)
    pending.settle(value)
  }
}

const clamp = (value: string, maxLength: number): string => value.slice(0, maxLength)
