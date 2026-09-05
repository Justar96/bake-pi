import type { Static } from "@sinclair/typebox"
import { approvalCommands } from "./approval.ts"
import { authCommands } from "./auth.ts"
import { extensionUiCommands } from "./extension-ui.ts"
import { imageCommands } from "./image.ts"
import { modelCommands } from "./model.ts"
import { promptCommands } from "./prompt.ts"
import { resourceCommands } from "./resources.ts"
import { runtimeCommands } from "./runtime.ts"
import { sessionCommands } from "./session.ts"
import { settingsCommands } from "./settings.ts"
import { timingsCommands } from "./timings.ts"
import { workspaceCommands } from "./workspace.ts"

export * from "./define.ts"
export { DiagnosticEntry, RuntimeInfo } from "./runtime.ts"
export { Attachment } from "./prompt.ts"
export { MAX_DIRECTORY_ENTRIES } from "./workspace.ts"
export {
  MAX_IMAGE_BYTES,
  RENDERABLE_IMAGE_MEDIA_TYPES,
  renderableImageMediaType,
  type RenderableImageMediaType,
} from "./image.ts"
export {
  PiSettingKey,
  PiPackageSource,
  PiSettingsPatch,
  PiSettingsSnapshot,
} from "./settings.ts"
export {
  MAX_TIMING_SESSIONS,
  MAX_TIMING_SPANS,
  TIMING_TOOL_LABELS,
  TURN_SPAN_NAMES,
  type SpanName,
  type TimingToolLabel,
  type TurnSpanName,
} from "./timings.ts"

/**
 * Every command whose schemas can be written down without knowing what the
 * other commands are — which is all of them but one.
 *
 * It is separate from `CommandDefs` only because `get_timings` is not in that
 * position: its result enumerates one span name per command, so its schema is a
 * function of this object rather than a sibling of it. Keeping the two steps
 * visible here is better than the alternative, which is a circular import that
 * would fail at load rather than at build.
 */
const registeredCommands = {
  ...runtimeCommands,
  ...workspaceCommands,
  ...sessionCommands,
  ...imageCommands,
  ...promptCommands,
  ...modelCommands,
  ...authCommands,
  ...settingsCommands,
  ...resourceCommands,
  ...extensionUiCommands,
  ...approvalCommands,
} as const

/**
 * The single command registry. It is the source of truth for three things that
 * would otherwise drift: the preload's exposed key set, the main-process
 * router's dispatch table, and the host's handler map. Each is derived from
 * these keys, so adding a command to one and forgetting the others is a
 * compile error rather than a runtime gap.
 */
export const CommandDefs = {
  ...registeredCommands,
  // Every command name except `get_timings`, which `timingsCommands` adds
  // itself because it is the one name this object cannot know yet.
  ...timingsCommands(Object.keys(registeredCommands)),
} as const

export type CommandName = keyof typeof CommandDefs
export type CommandParams<N extends CommandName> = Static<(typeof CommandDefs)[N]["params"]>
export type CommandResult<N extends CommandName> = Static<(typeof CommandDefs)[N]["result"]>

export const COMMAND_NAMES = Object.keys(CommandDefs).sort() as readonly CommandName[]

export const isCommandName = (value: unknown): value is CommandName =>
  typeof value === "string" && Object.hasOwn(CommandDefs, value)

/**
 * The commands main answers itself instead of forwarding to the agent host.
 *
 * Native pickers stay in main because only main may receive host paths from the
 * operating system. Restart stays here because it has to be answerable when no
 * agent host exists. Everything involving Pi semantics still goes to the host.
 *
 * `HostServices` excludes these, so implementing one in the host is a compile
 * error rather than dead code the router will never reach.
 */
export const MAIN_OWNED_COMMANDS = [
  "choose_attachments",
  "choose_workspace",
  "create_workspace",
  "list_workspace_locations",
  "reopen_recent_workspace",
  "restart_host",
  "reveal_log_file",
] as const satisfies readonly CommandName[]
export type MainOwnedCommand = (typeof MAIN_OWNED_COMMANDS)[number]

export const isMainOwnedCommand = (name: CommandName): name is MainOwnedCommand =>
  (MAIN_OWNED_COMMANDS as readonly CommandName[]).includes(name)

/** Commands used between main and the host but never exposed to the renderer. */
export const HOST_INTERNAL_COMMANDS = ["open_workspace", "read_image"] as const satisfies readonly CommandName[]
export type HostInternalCommand = (typeof HOST_INTERNAL_COMMANDS)[number]

export const isHostInternalCommand = (name: CommandName): name is HostInternalCommand =>
  (HOST_INTERNAL_COMMANDS as readonly CommandName[]).includes(name)

export type RendererCommandName = Exclude<CommandName, HostInternalCommand>
export const RENDERER_COMMAND_NAMES = COMMAND_NAMES.filter(
  (name): name is RendererCommandName => !isHostInternalCommand(name),
)

/**
 * Commands the renderer may only issue from a real user gesture, and which main
 * therefore checks for a recent interaction before forwarding. They either grant
 * trust, load executable code, or move a credential.
 */
export const GESTURE_REQUIRED_COMMANDS = [
  "choose_workspace",
  "choose_attachments",
  "create_workspace",
  "set_project_trust",
  "set_default_trust",
  "set_api_key",
  "login",
  "logout",
  "enable_resource",
  "reload_resources",
  "update_resources",
  "update_global_settings",
] as const satisfies readonly CommandName[]
