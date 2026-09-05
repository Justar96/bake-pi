import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent"
import type { ApprovalGate } from "./gate.ts"

/** The name the startup extension list shows for this hook, as `<inline:bake-pi-approval>`. */
export const APPROVAL_EXTENSION_NAME = "bake-pi-approval"

/**
 * Bake Pi's approval policy, as a Pi extension.
 *
 * **Why an extension and not a wrapped `agent.beforeToolCall`.** Pi installs its
 * own `beforeToolCall` on the Agent to drive extension `tool_call` handlers, and
 * that property is not part of Pi's typed public surface. Assigning to it would
 * either clobber every extension's hook or require us to compose with a private
 * implementation detail that upstream is free to change. Pi already exposes
 * exactly this capability publicly: a `tool_call` handler may return
 * `{ block: true }`, and Pi will not run the tool. So Bake Pi registers as one
 * more extension, through `resourceLoaderOptions.extensionFactories`, and the
 * policy runs on the same supported path a user's own extension would.
 *
 * **Hook ordering, measured rather than assumed.** In Pi 0.85.0 the resource
 * loader appends inline extensions after every discovered file-based extension
 * (`resource-loader.js`, `loadFinalExtensionSet`), and `ExtensionRunner.emitToolCall`
 * iterates extensions in that order, returning on the first handler that answers
 * `{ block: true }`. Two consequences, and both favour this position:
 *
 * - Bake Pi's handler runs **last**, so it sees `event.input` as every earlier
 *   extension has already mutated it. Pi performs no re-validation after a
 *   mutation, so the last handler is the only one that sees the arguments the
 *   tool will actually run with. A gate that ran first could be shown one path
 *   and have another executed.
 * - A project extension that blocks first short-circuits before Bake Pi is
 *   consulted. That direction is safe: the outcome is that the tool did not run.
 *   There is no ordering in which an earlier extension can cause Bake Pi's
 *   denial to be skipped, because only a block returns early.
 *
 * The one thing this position cannot defend against is a hostile extension that
 * never blocks and instead mutates arguments *after* us — which the load order
 * makes impossible, since nothing runs after an inline extension. That is why
 * the ordering is stated here with the file it was read from: if a future Pi
 * release loads inline extensions first, this comment is the thing that makes
 * the regression legible instead of silent.
 */
export const createApprovalExtension = (gate: ApprovalGate): InlineExtension => ({
  name: APPROVAL_EXTENSION_NAME,
  factory: (pi: ExtensionAPI) => {
    pi.on("tool_call", async (event, ctx) => {
      // The session id comes from Pi's own session manager rather than from
      // anything captured when the extension was created. Pi replaces the live
      // session on new, switch, fork, clone and import while these services and
      // this handler stay bound, so a captured id would drift to the wrong
      // session exactly when the user did something that mattered.
      const sessionId = ctx.sessionManager.getSessionId()

      return await gate.evaluate(
        sessionId,
        ctx.cwd,
        { toolCallId: event.toolCallId, toolName: event.toolName, input: event.input },
        ctx.signal,
      )
    })
  },
})
