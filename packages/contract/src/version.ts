/**
 * The contract version both sides compare during the handshake.
 *
 * Bump on any change to a command, event, or DTO shape that an older peer could
 * misread. A mismatch fails the handshake with a structured error; it never
 * degrades to a best-effort connection, because a half-understood agent stream
 * is worse than no stream.
 */
export const CONTRACT_VERSION = 5 as const

export type ContractVersion = typeof CONTRACT_VERSION
