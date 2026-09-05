import { type Static, Type } from "@sinclair/typebox"

/**
 * Errors cross the boundary as codes. The renderer maps a code to a message it
 * owns, so no host-side string — and no stack trace — is ever rendered.
 * `detail` is a short, already-safe fragment (a path, a model name); it is not
 * a place to smuggle an exception message.
 */
export const ErrorCode = Type.Union([
  // Protocol
  Type.Literal("contract_version_mismatch"),
  Type.Literal("malformed_command"),
  Type.Literal("unknown_command"),
  Type.Literal("payload_too_large"),
  Type.Literal("handshake_failed"),
  // Lifecycle
  Type.Literal("host_unavailable"),
  Type.Literal("host_shutting_down"),
  Type.Literal("session_disconnected"),
  Type.Literal("session_quarantined"),
  // Workspace and trust
  Type.Literal("workspace_not_open"),
  Type.Literal("workspace_untrusted"),
  Type.Literal("path_outside_workspace"),
  // Session
  Type.Literal("session_not_found"),
  Type.Literal("session_busy"),
  Type.Literal("session_limit_reached"),
  Type.Literal("session_file_repaired"),
  /**
   * A tool was running when the host that started it died. What it did to the
   * workspace is not knowable from here: a file may be half-written, a command
   * may have run once and may be safe to run again, or may not.
   */
  Type.Literal("tool_interrupted"),
  // Model and auth
  Type.Literal("model_not_found"),
  Type.Literal("provider_unauthenticated"),
  Type.Literal("auth_unsupported"),
  // Resources and extensions
  Type.Literal("resource_not_found"),
  Type.Literal("extension_failed"),
  /**
   * A managed Pi cannot be installed, selected or removed in the state the
   * application is in — one install is already running, the version asked for
   * is not on disk, or the one asked to go is the one in use.
   *
   * Separate from `internal_error` because none of these is a fault. Each is a
   * true statement about the request, the detail says which, and the panel can
   * repeat it to the person who pressed the button instead of showing them a
   * diagnostics entry that explains nothing.
   */
  Type.Literal("pi_unavailable"),
  // Capacity
  Type.Literal("memory_ceiling_reached"),
  Type.Literal("queue_cap_exceeded"),
  // Catch-all. Always paired with a diagnostics entry the user can open.
  Type.Literal("internal_error"),
])
export type ErrorCode = Static<typeof ErrorCode>

export const ContractError = Type.Object({
  code: ErrorCode,
  /** Short, renderer-safe fragment: a path, a model id. Never an exception message. */
  detail: Type.Optional(Type.String({ maxLength: 512 })),
  /** Correlates with an entry in the diagnostics log, where the raw error lives. */
  diagnosticId: Type.Optional(Type.String({ maxLength: 64 })),
  retryable: Type.Boolean(),
})
export type ContractError = Static<typeof ContractError>

export class BakePiError extends Error {
  readonly code: ErrorCode
  readonly detail: string | undefined
  readonly retryable: boolean

  constructor(code: ErrorCode, options: { detail?: string; retryable?: boolean; cause?: unknown } = {}) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "BakePiError"
    this.code = code
    this.detail = options.detail
    this.retryable = options.retryable ?? false
  }

  /** Strips everything the renderer must not see. `diagnosticId` is attached by the caller that logged it. */
  toContractError(diagnosticId?: string): ContractError {
    return {
      code: this.code,
      ...(this.detail === undefined ? {} : { detail: this.detail }),
      ...(diagnosticId === undefined ? {} : { diagnosticId }),
      retryable: this.retryable,
    }
  }
}
