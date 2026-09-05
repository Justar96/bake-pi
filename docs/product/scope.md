# What Bake Pi does

Bake Pi is a desktop interface for the Pi coding agent. It consumes Pi's public
SDK and preserves Pi's agent loop, providers, tools, sessions, resources,
extensions, project trust, and credential behavior. Bake Pi owns presentation,
desktop integration, and the boundary between an unprivileged renderer and local
tool execution.

The target audience understands repositories, diffs, and model providers. Bake Pi
does not hide agent activity or teach programming.

## The product goal

A user can open a local workspace, decide whether to trust it, start or resume a
Pi session, and review the agent's work through a graphical interface. The same
session remains usable from the Pi command-line interface (CLI).

Bake Pi keeps no private Pi fork and patches no installed package. A change to Pi
behavior belongs upstream. Exact package pins and generated integrity records make
the consumed version auditable.

## V1 goals

V1 is successful when it provides these outcomes:

- Open a local workspace and start, resume, or navigate a Pi session.
- Stream text, reasoning, tool calls, tool output, retries, compaction, errors,
  queue changes, usage, and cost without inventing a second message store.
- Preserve Pi providers, models, skills, prompt templates, context files,
  extensions, packages, session trees, and message queues.
- Show project trust before project resources load.
- Block tool activity that requires approval and show the exact action, arguments,
  resolved targets, working directory, and reason.
- State that approval is not an operating-system sandbox.
- Ship signed, updateable artifacts after a Windows-first validation cycle.
- Bound upstream upgrades with exact pins, drift reporting, compatibility tests,
  and a release-candidate drift budget.

## V1 non-goals

V1 excludes these capabilities:

- Forking Pi or changing its agent semantics.
- Recreating the Pi terminal user interface (TUI).
- Shipping a second language runtime. Electron supplies the Node.js runtime used
  by the agent host; Bun remains the package manager and development toolchain.
- Running Electron main on Bun.
- Cloud session sync, collaboration, hosted accounts, or remote execution.
- Claiming that a confirmation dialog contains an approved process.
- Arbitrary embedded websites, browser tabs, or a plugin marketplace.
- Multi-window session ownership, an integrated terminal, or multi-agent
  orchestration.

## Capability scope

| Pi capability | V1 target | Intended Bake Pi surface |
| --- | --- | --- |
| Providers and models | Required | Onboarding, model search, thinking selection, catalog refresh |
| API-key authentication | Required | Onboarding and settings through `ModelRuntime` |
| OAuth authentication | Distribution-gated | Existing local credentials may work; public flows require written clearance |
| Prompt streaming | Required | Conversation timeline |
| Built-in tools | Required | Tool cards, diffs, output, and approvals |
| Abort, steer, and follow-up | Required | Composer and queue inspector |
| Session lifecycle and tree operations | Required | Session rail and tree inspector |
| Compaction and retry | Required | Timeline status and session actions |
| Images and file inputs | Required | Composer attachments and previews |
| Skills, prompts, and context files | Required | Resource inspector and command palette |
| Extensions and Pi packages | Required with safety UI | Resource manager, trust flow, and extension dialogs |
| Project trust | Required | Blocking workspace trust screen |
| Usage and cost | Required | Session header and inspector |
| Integrated terminal | Deferred to v2 | No v1 surface |
| External sharing | Deferred | Local export remains in scope |
| llama.cpp router management | Deferred | Reconsidered after provider flows stabilize |
| TUI themes and custom TUI components | Not applicable | Unsupported surfaces produce diagnostics |
| Standalone Pi self-update | Not applicable | Application updates move Bake Pi and Pi together |

The [coverage gap register](../planning/coverage-gaps.md) distinguishes this target
scope from the behavior implemented and verified today.

## Release profiles

**V1-minimal** is a Windows x64 release with API-key authentication and the core
workspace, session, prompt, tool, approval, and resume flows. It excludes
import/export and ARM64.

**V1-full** adds session and resource parity, import/export, the declared platform
matrix, signed updates, and all release-blocking security and recovery evidence.

The scope gate before Milestone 4 chooses between shipping v1-minimal and
continuing directly to v1-full. The roadmap does not treat v1-full as the default
through inertia.
