# Bake Pi: repository context

Electron desktop interface for Pi's published SDK and session files. Pi owns
sessions, credentials, resources, tools, and compaction: no fork, package patches,
or second message store. V1 is single-window.

## Where to start

- Read [roadmap](docs/planning/roadmap.md) and [coverage gaps](docs/planning/coverage-gaps.md)
  before choosing work. They separate intended behavior from evidence; verify
  status claims against current code and tests rather than copying old counts.
- [Project structure](docs/architecture/project-structure.md) maps ownership and
  implementation details. Update it when workspaces, build targets, ambient
  environments, or enforced boundaries change.
- [Pi provenance](docs/reference/pi-upstream.md) is generated from `bun.lock` by
  `bun run provenance`; never hand-edit it. Keep the host's Pi runtime package pins aligned.

## Build and verification

Use Bun 1.4+ with the hoisted linker in `bunfig.toml`. Electron's embedded Node
runs main and the native agent host, not Bun; installed Node types are newer
than that runtime. Shared host APIs must also work on Node 22+ in WSL.
Root postinstall explicitly runs Electron's installer before stamping the manifest;
Electron 44 no longer downloads its binary through a dependency install hook.

```sh
bun install
bun run dev                  # watches four bundles; reloads renderer, restarts for host/main/preload edits
bun run verify               # typecheck, tests, build, smoke, journey, orphans, budgets
bun run typecheck:renderer    # focused check; other surfaces are in package.json
bun test path/to/file.test.ts
bun run build && bun run resources  # real 10,000-block renderer/frame/memory probe
```

- `resources` measures the existing build; use `build:production` first for a
  production sample. Keep development/production and traced/untraced results separate.
- CI gates on Windows and checks regenerated provenance. `verify` does not include
  `resources`, `wsl-smoke`, or packaged proof; run the relevant lane for those changes.
- Packaging is the system-Node exception: use `bun run package`, `make`, or `publish`,
  which launch Forge under Node. Keep the root `yauzl` override; it avoids incomplete
  Electron extraction on newer Node. `bun run packaged` checks the built artifact.
  Forge `--targets` takes short maker names (`squirrel`, `deb`, `rpm`), not package names.
- Pi must stay external to the host bundle: arbitrary-path jiti extensions and
  `photon_rs_bg.wasm` need ordinary module/file resolution. Preserve the production
  dependency stage and WASM ASAR unpacking in `apps/desktop/forge.config.ts`.
- Windows frame geometry depends on the per-monitor-v2 manifest, stamped on install
  and packaging. For frame/DPI changes run `bun run frame`; for artwork changes run
  `bun run app-icon` and include the generated icons.

## Process boundaries

| Location | Ownership / restriction |
| --- | --- |
| `packages/contract` | TypeBox schemas; no DOM, Node, or Electron ambient types |
| `packages/agent-host` | Only workspace allowed to import/depend on Pi; SDK adapter, policy, session ownership |
| `apps/desktop/src/main` | Native capabilities, IPC validation, host supervision; no Pi imports |
| `apps/desktop/src/preload` | CommonJS with a no-ESM build assertion; bridge derived from `RENDERER_COMMAND_NAMES`, no raw IPC or generic invoke |
| `apps/desktop/src/renderer` | React + StyleX; no Node, Electron, or Pi imports |

Commands travel renderer → preload → main → host. Main validates sender and
payload; `MAIN_OWNED_COMMANDS` and `HOST_INTERNAL_COMMANDS` in
`packages/contract/src/commands/index.ts` define routing exceptions. Events bypass
main over a transferred MessagePort or WSL loopback WebSocket. Do not tee streaming
into main. `scripts/boundaries.test.ts` enforces dependency and bridge boundaries.

## State, recovery, and policy

- Renderer session state is a disposable projection. Event snapshots replace it
  and establish a sequence fence; gaps require resync, not local reconstruction.
  See `store/stream.ts` and `store/session-projection.ts` under the renderer.
- Navigation belongs to the latest user selection, not the last async completion.
  Background events and late open/close/resume results must not steal focus. A late
  command snapshot supplies only a missing baseline, never overwrites a newer event
  projection. `store/session-store.test.ts` covers these races.
- Main's recovery ledger uses commands, not tool events: quarantine the triggering
  session, restore workspaces before sessions, and require manual restart after
  ambiguous credential mutation or an exhausted restart budget.
- Pi takes no session lock. Preserve Bake's ownership/write guard. Inspect torn JSONL
  **before** `SessionManager.open` repairs it; consume interruption markers **after**
  acquiring the lock, because reading deletes them. See host `runtime.ts` and `session/`.
- Approval is an inline Pi `tool_call` extension, never an assignment to private
  `agent.beforeToolCall`. Every non-decision path denies. After a Pi upgrade,
  `policy/hook-ordering.test.ts` must pass before claiming `policyHookOrdering: true`;
  maintain the exhaustive event mapping and fixtures in host `mapping/coverage.ts`.
- Capacity rejects new work rather than evicting sessions. Host `session/budget.ts`
  owns session/memory/queue limits; the event-byte cap lives in the contract.
  The prompt-queue cap is a policy choice, not a measured memory budget.

## Renderer constraints

- Compile-time StyleX only. Keep the CSP free of `'unsafe-inline'` and `'unsafe-eval'`:
  no runtime `TypeCompiler.Compile`, `new Function`, or WASM-based Shiki. Markdown
  renders through explicit React components, not a library's HTML/CSS strings;
  syntax colours use the existing CSSOM path in `Code.tsx` / `Diff.tsx`.
- Use shared renderer `theme/` tokens, sizes, scrollbars, and motion. StyleX token
  values must be literals; their tests read source because uncompiled StyleX modules
  cannot be imported. Elevation is fill + shadow, not decorative borders:
  `effects.hairline` is zero outside high contrast. Check light-theme separation too.
- Completed timeline blocks are virtualized; the active stream stays mounted.
  Preserve completed-row identity, live text selection, and detached scroll intent.
  Start at the tail and batch measurement renders; `resources` checks initial rows,
  scrolling coverage, selection, and session switching. `store/stream-batcher.ts`
  is the single stream-delivery frame boundary; do not add a second store scheduler.

## Measurement rules

- Compute durations within one process; subtract durations, never instants from
  different processes. Host timestamps may cross for display.
- Timing spans contain closed-vocabulary names, numbers, and optional session IDs,
  never paths, prompts, or tool arguments. No per-delta timing allocations.
- Use fresh `budgets` / `resources` output with its machine and allocator noise,
  not historical figures. CI sanity ceilings are not minimum-machine performance
  evidence. Graceful shutdown requires acknowledgement, not merely a short duration.
