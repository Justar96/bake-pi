<img src="assets/app-icon/07-cube-connected-v1.png" alt="" width="96" align="right">

# Bake Pi

A desktop interface for the [Pi coding agent](https://github.com/earendil-works/pi).

Bake Pi runs on Electron and consumes Pi's published SDK and its append-only JSONL session files directly. There is no fork, no patched package, and no second message store: sessions started here stay usable from the Pi CLI, and the other way round.

[![Release](https://img.shields.io/github/v/release/Justar96/bake-pi?include_prereleases&sort=semver)](https://github.com/Justar96/bake-pi/releases)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## Download

Beta builds are on the [releases page](https://github.com/Justar96/bake-pi/releases).

| Platform | Asset |
| --- | --- |
| Windows x64 | `BakePi-Setup.exe` |
| Debian / Ubuntu x64 | `bake-pi_*_amd64.deb` |
| Fedora / RHEL x64 | `bake-pi-*.x86_64.rpm` |

No macOS build yet. The builds are unsigned, so Windows shows a SmartScreen warning; choose **More info → Run anyway**. Windows updates itself from the releases feed once installed.

## What it does differently

- **One source of truth.** Pi owns session trees, credentials, tools, extensions, and compaction. Bake Pi never keeps a parallel copy.
- **Streaming that skips the main process.** Tokens and session events travel from the agent host straight to the renderer over a transferred `MessagePort`.
- **A locked-down renderer.** Sandboxed and context-isolated, with no `'unsafe-inline'` (StyleX compiles to static CSS) and no `'unsafe-eval'`.
- **Recoverable crashes.** Atomic on-disk tool markers isolate a failing session; the supervisor restores healthy workspaces and reports interrupted tools.

## Develop

Requires [Bun](https://bun.com) 1.4+. Electron embeds the Node.js runtime, so no separate Node install is needed for Windows workspaces; a WSL workspace needs Node 22+ inside its distribution, and Bake Pi offers to install a pinned copy under `~/.cache/bake-pi` if none is found.

```bash
bun install                  # hoisted linker, see bunfig.toml
bun run dev                  # build every bundle and launch with live reload
```

```bash
bun run build                # bundle main, preload, renderer, and host into apps/desktop/dist
bun test                     # unit, reducer, policy, and import-boundary tests
bun run typecheck            # every workspace and tsconfig target, in parallel
bun run verify               # the full gate: typecheck, test, build, smoke, journey, orphans, budgets
bun run make                 # installers: Squirrel on Windows, deb and rpm on Linux
```

Harnesses behind `verify` can also be run alone: `smoke` (real Electron handshake and startup timing), `journey` (drives the primary flow over the DevTools protocol), `orphans` (kills the host mid-tool and checks the process tree), `budgets` and `resources` (memory and renderer ceilings).

## Architecture

```text
Renderer (React 19 + StyleX) ── validated commands ──► Preload ──► Main Process (Electron)
    ▲                                                                      │
    │                                                         utilityProcess dispatch
    │                                                                      ▼
    └────────────── sequenced events (MessagePort) ─────────────── Agent Host (Pi SDK)
```

| Workspace | Role |
| --- | --- |
| `packages/contract` | TypeBox schemas for commands, events, and envelopes. No DOM or Node types. |
| `packages/agent-host` | The only consumer of the Pi SDK. Owns Pi runtimes, tool policy, session locks, and crash markers. |
| `apps/desktop` | Main process, preload bridge, and renderer. |

[Architecture overview](docs/architecture/overview.md) explains the trust boundaries and the trade-offs behind them.

## Documentation

[Documentation index](docs/README.md) · [Project structure](docs/architecture/project-structure.md) · [Product scope](docs/product/scope.md) · [Roadmap](docs/planning/roadmap.md) · [Coverage gaps](docs/planning/coverage-gaps.md) · [Pi provenance](docs/reference/pi-upstream.md) · [Contributing and agent guidelines](AGENTS.md)

## License

MIT. Upstream Pi is MIT-licensed; see [Pi provenance](docs/reference/pi-upstream.md) for pinned dependency licenses.
