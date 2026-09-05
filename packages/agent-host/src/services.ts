import type { CommandName, CommandParams, CommandResult, MainOwnedCommand } from "@bake-pi/contract"

/**
 * Every command, as one handler map derived from the contract.
 *
 * Deriving the map means adding a command to the contract without implementing
 * it is a compile error here, and implementing one that no longer exists is a
 * compile error too. The alternative — a hand-written interface beside the
 * contract — drifts, and the first symptom is a command the renderer can send
 * and the host silently ignores.
 */
export type HostServices = {
  [N in Exclude<CommandName, MainOwnedCommand>]: (params: CommandParams<N>) => Promise<CommandResult<N>>
}
