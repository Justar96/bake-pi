import { randomUUID } from "node:crypto"
import type { ApprovalDecision, ApprovalRequest, ToolCall, TrustLevel } from "@bake-pi/contract"
import type { Diagnostics } from "../diagnostics.ts"
import type { EventEmitter } from "../emitter.ts"
import { SessionAllowances, requiresApproval } from "./approval.ts"
import { classifyTargets } from "./paths.ts"
import { extractTargets, isBuiltinToolName } from "./targets.ts"
import { abortedToolReason, deniedToolReason } from "../tool-outcome.ts"

/**
 * How long a request may stay unanswered before it is denied.
 *
 * Deliberately long. A user reading a diff before approving a write is doing
 * exactly what the card is for, and a policy that timed out under them would
 * teach them to approve first and read after. The bound exists for the case
 * with no user in it at all: a renderer that crashed with a card open leaves Pi
 * awaiting a decision that can never arrive, and the session would appear hung
 * with nothing on screen to explain it.
 *
 * Expiry denies. Every path out of a pending request that is not an explicit
 * user decision denies, because the failure mode of a lost decision has to be
 * "nothing ran".
 */
export const APPROVAL_TIMEOUT_MS = 30 * 60_000

export interface ApprovalContext {
  workspaceRoot: string
  trust: TrustLevel
}

export interface ToolCallUnderReview {
  toolCallId: string
  toolName: string
  input: unknown
}

/** What Pi's `tool_call` hook accepts back. `undefined` lets the call proceed. */
export interface ToolCallVerdict {
  block: true
  reason: string
}

interface ApprovalResolution {
  decision: ApprovalDecision
  resolvedBy: "user" | "policy" | "cancelled"
}

interface Pending {
  request: ApprovalRequest
  settle: (resolution: ApprovalResolution) => void
  timer: NodeJS.Timeout
}

export interface ApprovalGateOptions {
  emitter: EventEmitter
  diagnostics: Diagnostics
  /**
   * Resolves the workspace a session belongs to, at decision time rather than
   * at session creation. Trust is mutable — a user can trust a workspace with a
   * session already open — and a policy reading a value captured earlier would
   * apply the trust decision the user has since changed.
   */
  resolveContext: (sessionId: string) => ApprovalContext | undefined
  timeoutMs?: number
}

/**
 * The approval gate: Pi's blocking `tool_call` hook, wired to the contract.
 *
 * The reason this is a class holding promises rather than a function: Pi's hook
 * is async and blocks the tool call for as long as it is unresolved, but the
 * decision arrives on a completely different channel — a `respond_tool_approval`
 * command from the renderer, routed through main. So the hook has to park, and
 * something has to own the parked continuations, correlate a later decision to
 * one of them, and guarantee that every one of them eventually settles.
 *
 * Three invariants, each of which is a test:
 *
 *   1. Nothing runs on a decision that did not arrive. Expiry, abort, session
 *      close and host shutdown all deny.
 *   2. An unknown or stale request id is dropped, never treated as an allow.
 *   3. A denial returns `block: true` to Pi, which is what actually stops the
 *      tool. Emitting a "denied" event without blocking would produce a UI that
 *      says denied over a tool that ran.
 *
 * Nothing here catches. An exception raised while deciding propagates out of the
 * `tool_call` handler into Pi rather than being swallowed into an allow, which is
 * the only direction a bug in this file is permitted to fail.
 */
export class ApprovalGate {
  readonly #options: ApprovalGateOptions
  readonly #allowances = new SessionAllowances()
  readonly #pending = new Map<string, Pending>()
  /** Reverse index so a session close can settle its own requests and no others. */
  readonly #bySession = new Map<string, Set<string>>()

  constructor(options: ApprovalGateOptions) {
    this.#options = options
  }

  /**
   * Runs the policy for one tool call and, if it needs a decision, waits for one.
   *
   * Returns `undefined` to let the call proceed, or a verdict to block it.
   */
  async evaluate(
    sessionId: string,
    cwd: string,
    call: ToolCallUnderReview,
    signal: AbortSignal | undefined,
  ): Promise<ToolCallVerdict | undefined> {
    const context = this.#options.resolveContext(sessionId)
    if (context === undefined) {
      // A tool call from a session this host does not know about. There is no
      // workspace root to judge containment against and no card to ask in, so
      // there is no way to allow it responsibly.
      this.#options.diagnostics.capture("approval.unknown_session", new Error(sessionId))
      return { block: true, reason: "Bake Pi could not identify the session this tool call belongs to." }
    }

    const extracted = extractTargets(call.toolName, call.input, cwd)
    const targets = classifyTargets(context.workspaceRoot, extracted.targets)

    const reason = requiresApproval(context.trust, targets, extracted.resolved)
    if (reason === undefined) return undefined

    // Checked after the policy rather than before it, so a session allowance can
    // only skip a prompt the policy would have raised. Checking first would make
    // an allowance a standing permission whose scope nobody can state.
    if (this.#allowances.isAllowed(sessionId, call.toolName)) return undefined

    const request: ApprovalRequest = {
      id: randomUUID(),
      sessionId,
      call: {
        id: call.toolCallId,
        name: call.toolName,
        // Anything outside Pi's built-in tool table reached the agent through a
        // loaded extension, and the card flags it as such.
        source: isBuiltinToolName(call.toolName) ? "builtin" : "extension",
        args: call.input,
        targets,
        status: "pending_approval",
      } satisfies ToolCall,
      reason,
      requestedAt: Date.now(),
    }

    const resolution = await this.#park(request, signal)
    if (resolution.decision === "allow_for_session") this.#allowances.allow(sessionId, call.toolName)
    if (resolution.decision !== "deny") return undefined

    return {
      block: true,
      reason: resolution.resolvedBy === "cancelled"
        ? abortedToolReason()
        : deniedToolReason(describe(reason)),
    }
  }

  /**
   * Applies a decision from the renderer.
   *
   * An unknown request id returns `false` rather than throwing. It is the
   * expected shape of a late click on a card whose request already expired or
   * whose session already closed, and a thrown error there would reach the user
   * as a failure when the correct answer is "that decision no longer applies to
   * anything".
   */
  respond(requestId: string, decision: ApprovalDecision): boolean {
    if (!this.#pending.has(requestId)) return false
    this.#resolve(requestId, decision, "user")
    return true
  }

  /** Denies everything outstanding for one session. Called on close and dispose. */
  cancelSession(sessionId: string): void {
    for (const requestId of [...(this.#bySession.get(sessionId) ?? [])]) {
      this.#resolve(requestId, "deny", "cancelled")
    }
    this.#bySession.delete(sessionId)
    this.#allowances.forget(sessionId)
  }

  /** Denies everything outstanding. Called on host shutdown. */
  cancelAll(): void {
    for (const requestId of [...this.#pending.keys()]) this.#resolve(requestId, "deny", "cancelled")
  }

  /**
   * The requests currently awaiting a decision for one session.
   *
   * Exists so a snapshot can carry them: a renderer that reloaded with a card
   * open has forgotten the request while Pi is still blocked on it, and the
   * snapshot is the only thing that can put the card back.
   */
  pendingFor(sessionId: string): readonly ApprovalRequest[] {
    return [...(this.#bySession.get(sessionId) ?? [])]
      .map((id) => this.#pending.get(id)?.request)
      .filter((request): request is ApprovalRequest => request !== undefined)
  }

  #park(request: ApprovalRequest, signal: AbortSignal | undefined): Promise<ApprovalResolution> {
    return new Promise<ApprovalResolution>((resolve) => {
      const timer = setTimeout(
        () => this.#resolve(request.id, "deny", "cancelled"),
        this.#options.timeoutMs ?? APPROVAL_TIMEOUT_MS,
      )

      // An abort is the user saying stop, which denies anything still waiting.
      // Pi aborts the tool call itself as well, but the request has to settle
      // regardless or the promise leaks and the card never clears.
      const onAbort = (): void => this.#resolve(request.id, "deny", "cancelled")
      signal?.addEventListener("abort", onAbort, { once: true })

      this.#pending.set(request.id, {
        request,
        settle: (decision) => {
          signal?.removeEventListener("abort", onAbort)
          resolve(decision)
        },
        timer,
      })

      const forSession = this.#bySession.get(request.sessionId) ?? new Set<string>()
      forSession.add(request.id)
      this.#bySession.set(request.sessionId, forSession)

      // Emitted with the session id so it is sequenced against that session's
      // tool events. A card that arrived before the tool call it describes would
      // render against a timeline entry the renderer has not seen yet.
      this.#options.emitter.emit("approval_requested", { request }, request.sessionId)

      // A signal that was already aborted when the call reached us never fires
      // the listener, so the request would park forever on a session that is
      // already stopping.
      if (signal?.aborted === true) this.#resolve(request.id, "deny", "cancelled")
    })
  }

  #resolve(requestId: string, decision: ApprovalDecision, resolvedBy: "user" | "policy" | "cancelled"): void {
    const pending = this.#pending.get(requestId)
    if (pending === undefined) return
    this.#pending.delete(requestId)
    this.#bySession.get(pending.request.sessionId)?.delete(requestId)
    clearTimeout(pending.timer)

    this.#options.emitter.emit("approval_resolved", { requestId, decision, resolvedBy }, pending.request.sessionId)
    pending.settle({ decision, resolvedBy })
  }
}

const describe = (reason: ApprovalRequest["reason"]): string => {
  switch (reason) {
    case "workspace_untrusted":
      return "the workspace is not trusted"
    case "outside_workspace":
      return "the tool targets a path outside the workspace"
    case "targets_unknown":
      return "Bake Pi could not determine what the tool would touch"
  }
}
