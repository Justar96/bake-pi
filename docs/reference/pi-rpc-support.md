# RPC mode command support

This is the Milestone 0 answer to one question: if a Bake Pi operation cannot be
driven through Pi's SDK, can `runRpcMode` be used as a fallback for it?

The measured answer is **no, not for the operations that would need a fallback**.
RPC mode covers the prompt loop well and covers almost nothing else. Every
capability Bake Pi has had to reach for a private or awkward path to get —
tool approval, project trust, credentials, resource enable/disable — is absent
from the RPC surface entirely. The commands RPC does implement are the ones the
SDK already exposes cleanly, so the fallback would only ever be available where
it is not needed.

That resolves the roadmap's **Integration** decision gate ("Direct SDK versus
`runRpcMode` for unsupported operations") to its default: keep the direct SDK.
The `rpcFallback` handshake flag stays `false`, and this document is the reason
rather than an unexamined default.

- **Source:** `node_modules/@earendil-works/pi-coding-agent/docs/rpc.md` at the
  pinned version, read in full. Not inferred from the CLI's behavior.
- **Pinned Pi:** see [upstream provenance](pi-upstream.md).
- **Scope:** the 39 commands in Bake Pi's contract (`COMMAND_NAMES`). Events are
  covered separately at the end.

## How to read the status column

| Status | Meaning |
| --- | --- |
| Yes | An RPC command exists with the semantics Bake Pi needs. |
| Partial | Something related exists, but it cannot carry the operation as contracted. The note says what is missing. |
| No | RPC mode has no command for this at all. |

## The prompt loop

Complete. This is what RPC mode was built for.

| Bake Pi command | RPC | Status | Note |
| --- | --- | --- | --- |
| `prompt` | `prompt` | Yes | |
| `steer` | `steer` | Yes | |
| `follow_up` | `follow_up` | Yes | |
| `abort` | `abort` | Yes | |
| `compact_session` | `compact` | Yes | Plus `set_auto_compaction`. |
| `set_model` | `set_model` | Yes | Plus `cycle_model`. |
| `set_thinking_level` | `set_thinking_level` | Yes | Plus `cycle_thinking_level`. |
| `list_models` | `get_available_models` | Yes | Models the launched process already resolved, not a catalogue. |
| `get_queue` | — | Partial | The queue is **pushed** through the `queue_update` event and summarized as `pendingMessageCount` in `get_state`. There is no pull command, so a client that connects mid-session cannot ask what is queued; it can only wait for the next change. `clear_queue` exists. |
| `get_runtime_info` | `get_state` | Partial | `get_state` returns model, thinking level, streaming and compacting flags, queue modes, session file, id and name, and message counts. It does not report the Pi version, the contract version, or feature support, which is most of what Bake Pi's handshake carries. |

## Sessions

Partial, and the gaps are structural rather than incidental: an RPC process is
one agent in one working directory, so anything plural or hierarchical is
missing.

| Bake Pi command | RPC | Status | Note |
| --- | --- | --- | --- |
| `open_session` | `switch_session` | Yes | Takes a `sessionPath`, not an id, and an extension can cancel it (`cancelled: true` comes back as a *success*, which a client has to check for rather than treat as an error). |
| `new_session` | `new_session` | Yes | |
| `fork_session` | `fork` | Yes | Takes an `entryId` and forks from a previous user message on the active branch. |
| `clone_session` | `clone` | Yes | Duplicates the active branch at the current position. |
| `create_session` | `new_session` | Partial | `new_session` resets the agent in place. Bake Pi's `create_session` names a workspace, and RPC has no working-directory argument on any command: the cwd is fixed when `pi --mode rpc` launches. One workspace per process. |
| `navigate_tree` | `get_tree`, `get_entries` | Partial | Both return the tree and the current `leafId`, so navigation is fully **readable**. No command moves the active leaf onto an existing branch. `fork` creates a new branch instead of re-entering one. |
| `list_sessions` | — | No | `switch_session` requires a path the client already has. Nothing enumerates sessions, so a session rail cannot be built from RPC. |
| `close_session` | — | No | Sessions are left, not closed. |

## Workspaces, trust, and credentials

Absent. Not reduced or awkward — there is no command in any of these three
groups.

| Bake Pi command | RPC | Status | Note |
| --- | --- | --- | --- |
| `open_workspace` | — | No | The working directory is a launch argument of the process, not a command. |
| `close_workspace` | — | No | |
| `get_project_trust` | — | No | Trust is resolved inside the launched process, and the protocol never mentions it. A client cannot read the trust state, cannot set it, and is not told when project resources load because of it. |
| `set_project_trust` | — | No | |
| `get_auth_status` | — | No | Provider auth is settled by the launch flags (`--provider`, `--model`) and the ambient credential store. |
| `set_api_key` | — | No | |
| `login` | — | No | |
| `logout` | — | No | |
| `list_providers` | — | No | `get_available_models` returns each model's provider, which is a side effect rather than a provider list, and carries no auth status. |
| `refresh_models` | — | No | |

## Tool approval

This is the row that decides the gate, so it gets its own section.

| Bake Pi command | RPC | Status | Note |
| --- | --- | --- | --- |
| `respond_tool_approval` | — | No | See below. |

RPC mode has no approval command and no approval event. `tool_execution_start`
is documented as emitted "when a tool begins" — the client is told after the
decision has already been made, and has nothing to decide with. There is no
protocol point at which a host can block a tool call.

One indirect path exists and is worth naming precisely, because at a glance it
looks like an answer. An extension running inside the RPC process can raise a
dialog through the Extension UI Protocol, which is relayed to the client as an
`extension_ui_request`; the documentation's own `select` example is titled
`"Allow dangerous command?"`. So approval *can* travel over RPC — but only if
the policy itself lives inside Pi as an extension, with the client reduced to
rendering whatever that extension asks. For Bake Pi that would mean:

- Reimplementing `policy/gate.ts` inside the extension, where it cannot see the
  workspace trust state the host owns, and shipping the policy across a process
  boundary as a dialog rather than a decision.
- Inheriting the sub-protocol's timeout semantics. Dialog requests carry a
  `timeout`, and the agent "auto-resolves with `undefined` if the client doesn't
  respond in time." For a confirmation prompt that is reasonable. For an
  approval gate it is a **fail-open on timeout** unless the extension treats
  `undefined` as a denial — the exact hazard `ApprovalGate` avoids by parking
  indefinitely under an abort signal and by never catching its way into an
  allow.

Bake Pi already has the better version of this: the same blocking `tool_call`
hook, in-process, with the trust store and the workspace in scope. RPC would be
a strictly weaker way to reach a mechanism the host already holds directly.

## Resources and diagnostics

| Bake Pi command | RPC | Status | Note |
| --- | --- | --- | --- |
| `list_resources` | — | No | `get_commands` lists slash commands only. Skills, prompts, context files, extensions, and packages are not enumerable. |
| `enable_resource` | — | No | |
| `disable_resource` | — | No | |
| `reload_resources` | — | No | |
| `get_diagnostics` | — | No | The `extension_error` event reports extension failures as they happen. Nothing can be queried. |

## Extension dialogs

Complete, and the one place RPC mode is genuinely equivalent. `ctx.hasUI` is
`true` in RPC mode because these work.

| Bake Pi command | RPC | Status | Note |
| --- | --- | --- | --- |
| `respond_select` | `extension_ui_response` | Yes | Value response. |
| `respond_input` | `extension_ui_response` | Yes | Value response. |
| `respond_editor` | `extension_ui_response` | Yes | Value response. Plus a `set_editor_text` request. |
| `respond_confirm` | `extension_ui_response` | Yes | Confirmation response. Cancellation is a distinct third outcome (`cancelled: true`), not a `false`. |

Requests Bake Pi's contract does not yet model: `notify`, `setStatus`,
`setWidget`, `setTitle`. TUI-only methods such as `custom()` require a real
terminal and are guarded by `ctx.mode === "tui"`.

## Process lifecycle

| Bake Pi command | RPC | Status | Note |
| --- | --- | --- | --- |
| `shutdown` | — | No | Ending an RPC session means closing stdin or killing the process. There is no command that asks the agent to wind down, so nothing acknowledges a clean stop. Bake Pi's supervised shutdown cannot be expressed. |

## Totals

| Status | Count |
| --- | --- |
| Yes | 16 |
| Partial | 4 |
| No | 19 |

## Bash

RPC has `bash` and `abort_bash` for running a command directly, outside the
model loop. Bake Pi's contract has no equivalent, deliberately: an integrated
terminal is named as out of scope for v1. Recorded so a later terminal project
knows the capability is already there.

## Events

Event coverage is much closer to parity than command coverage, which is
consistent with RPC mode being an output-shaped protocol. `agent_start`,
`agent_end`, `agent_settled`, `turn_start`/`turn_end`,
`message_start`/`message_update`/`message_end`, `text_start`/`text_delta`/
`text_end`, `thinking`, `toolcall_start`,
`tool_execution_start`/`update`/`end`, `bash_execution_update`, `queue_update`,
`compaction_start`/`end`, `auto_retry_start`/`end`, the three
`summarization_retry_*` events, and `extension_error` are all published.

Two differences matter for `EVT-001` and `EVT-002`:

- RPC events carry no sequence number and no snapshot fence. Ordering is
  whatever arrives on stdout. Bake Pi's per-session monotonic sequence and
  resynchronization fence are host constructs and would have to be rebuilt on
  top of a stream that does not offer them.
- There is no approval event, per the tool-approval section above.

## When to re-run this

This document is a claim about one pinned Pi version. Re-read `docs/rpc.md` on
every Pi upgrade, and specifically look for: an approval or permission command,
a trust command, a working-directory argument, and a session enumeration
command. Any one of those appearing would be a reason to revisit the Integration
gate rather than to keep this default.
