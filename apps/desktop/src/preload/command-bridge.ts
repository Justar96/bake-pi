import {
  BakePiError,
  RENDERER_COMMAND_NAMES,
  checkEnvelope,
  parseCommandParams,
  parseCommandResult,
  type CommandParams,
  type CommandResult,
  type ContractError,
  type RendererCommandName,
} from "@bake-pi/contract"

export type CommandSurface = {
  [N in RendererCommandName]: (params: CommandParams<N>) => Promise<CommandResult<N>>
}

type InvokeMain = (name: RendererCommandName, params: unknown) => Promise<unknown>

const internalError = (): ContractError => ({ code: "internal_error", retryable: false })

/**
 * Builds the renderer's command vocabulary and validates both sides of every
 * call at the privilege boundary.
 *
 * Main validates renderer input again before dispatch. The result check is the
 * other direction: a malformed or stale host response must not become trusted
 * renderer state merely because it crossed Electron IPC successfully.
 */
export const createCommandSurface = (invokeMain: InvokeMain): CommandSurface => {
  const invoke = async <N extends RendererCommandName>(name: N, params: CommandParams<N>): Promise<CommandResult<N>> => {
    let checkedParams: CommandParams<N>
    try {
      checkedParams = parseCommandParams(name, params)
    } catch (error) {
      throw error instanceof BakePiError ? error.toContractError() : internalError()
    }

    const raw = await invokeMain(name, checkedParams)
    if (typeof raw !== "object" || raw === null) throw internalError()
    // Main returns the body of a response rather than a full wire envelope.
    // Supplying an inert id lets the contract's existing envelope validator
    // verify the discriminant and error body without inventing a second schema.
    const envelope = { ...raw, kind: "response", id: "preload" }
    if (!checkEnvelope("response", envelope)) throw internalError()

    const response = raw as { ok: true; result: unknown } | { ok: false; error: ContractError }
    if (!response.ok) throw response.error
    try {
      return parseCommandResult(name, response.result)
    } catch {
      throw internalError()
    }
  }

  return Object.fromEntries(
    RENDERER_COMMAND_NAMES.map((name) => [name, (params: CommandParams<typeof name>) => invoke(name, params)]),
  ) as CommandSurface
}
