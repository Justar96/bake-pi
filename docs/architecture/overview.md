# How Bake Pi isolates presentation from execution

Bake Pi separates the graphical interface from the process that runs Pi and its
tools. The renderer owns presentation. Electron main owns desktop lifecycle and
the privileged command boundary. An Electron utility process owns Pi state and
local execution.

This split preserves Pi behavior without giving renderer code access to Node.js,
Electron, credentials, session files, or tools.

## Runtime and process model

```text
renderer ── validated commands ──► preload ──► main ──► agent host
    ▲                                                        │
    └──────────── sequenced events over MessagePort ─────────┘
                                                             │
                                                    Pi SDK and local OS
```

Electron 44 embeds Node.js 24.18.1. The agent host runs as a JavaScript module in
`utilityProcess`, so the application ships no separate Node or Bun runtime. Bun
installs dependencies, runs scripts and tests, and builds the four bundles.

The runtime types used during development are not a claim about Electron's
embedded runtime. `@types/node` is currently 26.4.0, while executable behavior
must remain compatible with Electron's Node.js 24.18.1 until Electron changes.
The mismatch is tracked as a compatibility risk in the
[coverage gap register](../planning/coverage-gaps.md).

## Commands cross the privileged boundary

Commands travel renderer → preload → main → agent host. The preload exposes one
method per contract command rather than raw `ipcRenderer`, channel names, or a
generic `invoke` function. Main validates the command envelope and sender before
dispatch.

The contract package declares command parameters, results, events, data-transfer
objects, error codes, and the handshake. TypeBox keeps runtime schemas beside
their TypeScript types. The package includes neither DOM nor Node ambient types,
which keeps it importable from both sides of the boundary.

## Events bypass main without bypassing validation

Main transfers a `MessagePort` between the agent host and renderer. Agent events
then flow directly to the renderer, avoiding a main-process relay for every
streamed token. Renderer-to-privilege commands still pass through main.

Each session event carries a monotonic sequence number. A snapshot records the
sequence at which it was taken. The renderer replaces its projection on snapshot,
discards events at or below the fence, and applies events above it. A detected gap
marks the projection incomplete until a new snapshot repairs it.

The current code verifies basic fencing, replay rejection, gap recording, snapshot
replacement, and ordered blocks. Backpressure-triggered resynchronization remains
planned rather than implemented.

## The agent host preserves Pi behavior

`packages/agent-host` is the only workspace that depends on
`@earendil-works/pi-coding-agent`. It creates Pi's `ModelRuntime`,
`ProjectTrustStore`, `SessionManager`, and session runtime through public APIs.
It maps Pi events onto Bake Pi contract events and keeps Pi authoritative.

The host does not bundle Pi. Pi and its dependency tree resolve from
`node_modules` at runtime because extensions load TypeScript from arbitrary paths
and the image stack resolves WebAssembly by path. Packaging must preserve those
runtime resolutions.

## Session state remains authoritative

The renderer stores a projection of the active session. Pi owns message history,
session files, credentials, resource discovery, compaction, and tools. A session
snapshot replaces the projection; renderer state never becomes a competing
source of truth.

V1 is single-window. Multi-window support would require one writer across windows
and the CLI for each append-only JSON Lines (JSONL) session tree. Session locking
and torn-entry behavior are still open integration questions, so multi-window
ownership is outside v1.

## Security controls and their limits

The renderer is configured with `nodeIntegration: false`,
`contextIsolation: true`, and `sandbox: true`. It loads from the private
`bakepi://` protocol. Main supplies Content Security Policy headers, denies
unexpected navigation and new windows, and validates command senders.

The preload checks `process.contextIsolated` and `process.sandboxed` before it
installs the capability bridge. A failed check exposes no bridge.

Project trust and tool approval reduce accidental execution. They do not contain
an approved process. The current approval implementation is not yet bound to Pi's
blocking hook, and its trusted-workspace behavior does not yet match the intended
policy. The mismatch is a release blocker.

## Key trade-offs and rejected alternatives

**Electron supplies the only shipped runtime.** A Bun-compiled sidecar would add
runtime resolution, platform build, signing, endpoint-protection, and protocol
risk without changing the product outcome.

**The Pi SDK remains the integration boundary.** Building on lower-level Pi
packages would require Bake Pi to reproduce sessions, compaction, trust,
credentials, resources, and tools while preserving CLI interoperability.

**Structured clone replaces a custom wire format.** `MessagePort` already carries
typed objects and binary data. A length-framed protocol would add parser,
fragmentation, and stdout-corruption failure modes without crossing a network.

**The renderer uses a small external store.** The host already emits an ordered,
authoritative event stream. `useSyncExternalStore` plus pure reducers covers the
remaining subscription problem without introducing server-cache semantics.

**StyleX emits static CSS.** Compile-time styles keep `style-src 'unsafe-inline'`
out of the renderer policy. The cost is that Markdown must render through React
components with explicit styles instead of a descendant-selector stylesheet.

The factual file map and build details live in
[Project structure](project-structure.md).
