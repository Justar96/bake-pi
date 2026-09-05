import { type Static, Type } from "@sinclair/typebox"
import { SessionId } from "./dto/primitives.ts"
import { CONTRACT_VERSION } from "./version.ts"

/**
 * Feature flags are how the host tells the renderer what this build of Pi
 * actually supports, instead of the renderer inferring it from a version
 * string. Milestone 0 fills these in from measurement: whether an API key can
 * be persisted through a public path, whether telemetry has an off switch,
 * whether the policy hook's ordering guarantee holds.
 */
export const FeatureFlags = Type.Object({
  apiKeyPersistence: Type.Boolean(),
  telemetryOptOut: Type.Boolean(),
  policyHookOrdering: Type.Boolean(),
  sessionFileLocking: Type.Boolean(),
  /**
   * Whether killing the agent host is known to take a tool's own descendants
   * with it. Measured per platform rather than assumed — see
   * `scripts/orphans.ts` — because the renderer must not offer a "stop
   * everything" that quietly leaves a build running.
   */
  processTreeCleanup: Type.Boolean(),
  /** True when the host is driving Pi through `runRpcMode` rather than the SDK directly. */
  rpcFallback: Type.Boolean(),
})
export type FeatureFlags = Static<typeof FeatureFlags>

export const Hello = Type.Object({
  kind: Type.Literal("hello"),
  contractVersion: Type.Integer({ minimum: 1 }),
  appVersion: Type.String({ maxLength: 64 }),
  platform: Type.String({ maxLength: 32 }),
  arch: Type.String({ maxLength: 32 }),
  /**
   * Sessions the supervisor is refusing to reopen after a crash it attributed to
   * them.
   *
   * The supervisor decides this and the host announces it, because the
   * supervisor has no way to speak to the renderer: it hands the event port to
   * the two ends and keeps neither. A session quarantined and never mentioned
   * would leave a card in the interface that nothing is behind.
   */
  quarantinedSessions: Type.Optional(Type.Array(SessionId, { maxItems: 64 })),
})
export type Hello = Static<typeof Hello>

/**
 * What the agent host spent getting to the point of answering.
 *
 * Every figure is a duration measured inside the host against its own clock,
 * never a timestamp. That distinction is the whole reason this is safe to send:
 * a timestamp would have to be compared against main's clock, whose origin is a
 * different process's start, and the two only agree by accident. A duration
 * means the same thing wherever it is read.
 *
 * It rides on the handshake because the handshake is the only message that
 * exists at the moment these numbers are complete, and because main cannot work
 * them out for itself — from outside, forking a process and waiting for a reply
 * is one opaque interval, and it is the largest single leg of cold start.
 *
 * Optional, so that a host built before this field still handshakes rather than
 * failing schema validation and presenting as a dead application.
 */
export const HostStartup = Type.Object({
  /** The host's own timeline start to its entry module finishing evaluation. */
  moduleMs: Type.Number({ minimum: 0 }),
  /** How long building the Pi runtime took, which is where Pi is loaded. */
  runtimeMs: Type.Number({ minimum: 0 }),
  /** The host's own timeline start to the instant it posted this reply. */
  ackMs: Type.Number({ minimum: 0 }),
})
export type HostStartup = Static<typeof HostStartup>

export const HelloAck = Type.Object({
  kind: Type.Literal("hello_ack"),
  contractVersion: Type.Integer({ minimum: 1 }),
  piVersion: Type.String({ maxLength: 64 }),
  nodeVersion: Type.String({ maxLength: 64 }),
  /** Used by the Windows supervisor only for the WSL host's guarded fast-stop path. */
  processId: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647 })),
  features: FeatureFlags,
  startup: Type.Optional(HostStartup),
})
export type HelloAck = Static<typeof HelloAck>

/**
 * A version mismatch is fatal, not negotiable. Two peers that disagree about
 * the shape of a tool-approval request must not proceed on a best guess.
 */
export const isCompatible = (peerVersion: number): boolean => peerVersion === CONTRACT_VERSION
