import { type Static, Type } from "@sinclair/typebox"
import { ContractError } from "../errors.ts"

/**
 * Main-process supervision state delivered outside the streamed event port.
 *
 * The event port dies with the host, so it cannot announce its own abrupt
 * disappearance. Main sends only these two low-frequency lifecycle notices;
 * session events and streamed content still bypass main entirely.
 */
export const HostConnectionNotice = Type.Union([
  Type.Object({ status: Type.Literal("connecting") }),
  Type.Object({ status: Type.Literal("disconnected"), error: Type.Optional(ContractError) }),
])
export type HostConnectionNotice = Static<typeof HostConnectionNotice>
