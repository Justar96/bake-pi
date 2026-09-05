import type { ApprovalReason, ToolTarget, TrustLevel } from "@bake-pi/contract"

/**
 * The approval policy, in full.
 *
 * Three rules, and they are stated in one place because a policy the user
 * cannot predict is a policy they click through. Every prompt can name its
 * reason in a single line, and a user who has seen it once knows when the next
 * one comes.
 *
 *   1. An untrusted workspace asks before every tool.
 *   2. A trusted workspace asks before anything that writes or executes outside
 *      the workspace root.
 *   3. A trusted workspace asks before a tool whose targets this host cannot
 *      determine, because rule 2 cannot be applied to an unknown.
 *
 * A workspace with full access asks before nothing. That is the level a person
 * chooses on the prompt bar when they have decided the prompts are in the way,
 * and it is stated as a level rather than as a hidden allowance so the bar can
 * show it the whole time it is in force.
 *
 * Two consequences are worth stating, because both were previously true by
 * accident rather than by decision, and neither was written down:
 *
 * **A read outside the workspace does not prompt.** Reading is how the agent
 * learns about the machine it runs on — a config file, a sibling repository, a
 * lockfile in a parent directory. Prompting for each one trains the user to
 * approve without reading, and that habit is then applied to the writes that
 * matter. This is a deliberate trade, not an oversight.
 *
 * **A shell command in a trusted workspace does not prompt.** Its target is the
 * working directory, `execute`, inside the workspace, so rule 2 does not fire.
 * That is what trusting a project means here: Pi's own CLI runs commands in a
 * trusted project without asking, and an interface that asked every time would
 * be a different product wearing Pi's session format. Rule 1 still covers the
 * untrusted case, which is the one where the user has not yet made that call.
 *
 * What this is not: a sandbox. An approved tool runs with the full privileges
 * of the user, and denying one does not contain a tool that was already
 * allowed. The UI says so plainly rather than implying containment it cannot
 * deliver.
 */
export const requiresApproval = (
  trust: TrustLevel,
  targets: readonly ToolTarget[],
  targetsResolved = true,
): ApprovalReason | undefined => {
  if (trust === "untrusted") return "workspace_untrusted"
  if (trust === "full") return undefined

  const escapes = targets.some((target) => !target.insideWorkspace && target.kind !== "read")
  if (escapes) return "outside_workspace"

  // Fails closed, and this is the case that used to fall through to "allow".
  // A tool with no determinable target is not a tool that touches nothing; it
  // is a tool this host does not understand, which is exactly what an
  // extension-contributed tool is.
  if (!targetsResolved) return "targets_unknown"

  return undefined
}

/**
 * Session-scoped allowances from "allow for session".
 *
 * Never persisted, and never keyed by anything but the tool name within one
 * session. A durable allowance is how a decision made about one repository
 * ends up applying to the next one, and neither the plan nor the UI can explain
 * that to a user afterwards.
 */
export class SessionAllowances {
  readonly #allowed = new Map<string, Set<string>>()

  allow(sessionId: string, toolName: string): void {
    const names = this.#allowed.get(sessionId) ?? new Set<string>()
    names.add(toolName)
    this.#allowed.set(sessionId, names)
  }

  isAllowed(sessionId: string, toolName: string): boolean {
    return this.#allowed.get(sessionId)?.has(toolName) ?? false
  }

  forget(sessionId: string): void {
    this.#allowed.delete(sessionId)
  }
}
