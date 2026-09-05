# Project structure

This page maps the repository as it exists on 2026-09-04. It describes source
ownership and enforced boundaries; planned files belong in the
[roadmap](../planning/roadmap.md).

## Repository tree

```text
bake-pi/
├── .github/                    CI verification and packaged proof, the tagged release, a shared setup action, dependency drift
├── apps/desktop/
│   ├── build/                  Four Bun build targets, shared settings, the watch loop, the Windows manifest, the rendered app icon
│   ├── src/main/               Electron lifecycle, security, IPC, supervision, startup timings
│   ├── src/preload/            Narrow renderer capability bridge
│   ├── src/renderer/           React workbench, event projection, feature UI, StyleX themes
│   ├── forge.config.ts         ASAR, fuses, app icon, the Squirrel, deb and rpm makers, the GitHub publisher, the production stage
│   └── tsconfig.*.json         Main, preload, and renderer environments
├── packages/agent-host/
│   ├── src/                    Pi runtime adapter, dispatch, emitter, diagnostics
│   │   ├── extension-ui/       Correlated portable extension dialogs
│   │   ├── mapping/            Pi messages and events projected onto the contract
│   │   ├── observability/      Turn, tool and command spans; the bounded ring
│   │   ├── policy/             Path classification, approval rules, the Pi hook
│   │   └── session/            Attachments, integrity, ownership, crash markers, discovery, permissions
│   └── test/                   The end-to-end slice, the host/renderer round trip, and their fixtures
├── packages/contract/
│   └── src/                    Commands, events, DTOs, validation, handshake
├── scripts/                    Boundary tests, real-Electron probes, budgets, clocks, drift, provenance
├── docs/                       Product, architecture, planning, history, reference
├── bun.lock                    Text lockfile with exact resolved versions
├── bunfig.toml                 Hoisted linker and test configuration
├── package.json                Workspace scripts and shared development dependencies
├── tsconfig.base.json          Strict compiler baseline
├── tsconfig.tests.json         Bun test ambient environment
└── tsconfig.tools.json         Script and build-tool ambient environment
```

## Workspace responsibilities

| Workspace | Responsibility | Direct runtime dependencies |
| --- | --- | --- |
| `apps/desktop` | Electron main, preload, renderer, builds, and packaging | Contract, React, StyleX, TanStack Virtual, React Markdown, Shiki, `@pierre/diffs`, Lucide, Electron |
| `packages/agent-host` | Pi SDK adapter and privileged session runtime | Contract, `@earendil-works/pi-coding-agent`, matching `@earendil-works/pi-server`, and `ws` |
| `packages/contract` | Runtime-neutral command and event schemas | TypeBox |

The root workspace owns shared tool dependencies, scripts, CI configuration, and
documentation.

## Enforced dependency boundaries

| Boundary | Rule | Current enforcement |
| --- | --- | --- |
| Renderer has no privileged imports | No Node builtin, Electron, or Pi imports under `src/renderer` | Renderer `tsconfig` plus `scripts/boundaries.test.ts` |
| Only the agent host touches Pi | Pi appears in one workspace manifest and no other source imports it | Manifest and source scans in `scripts/boundaries.test.ts` |
| Contract remains runtime-neutral | No DOM, Node, or Electron ambient surface | `packages/contract/tsconfig.json` and boundary tests |
| Main does not understand Pi | Main imports the contract but not Pi | Source scan and the absence of Electron from the agent-host manifest |
| Preload exposes capabilities | No raw `ipcRenderer`, generic invoke, or hand-written command list | Derived bridge plus boundary tests |

These checks run under `bun test`. They prove import and configuration boundaries,
not the full runtime security model.

## Build targets

`bun run build` produces four bundles.

| Output | Target | Format | External modules | Source |
| --- | --- | --- | --- | --- |
| `main` | Node | ESM | `electron` | `apps/desktop/src/main` |
| `preload` | Node-compatible sandbox preload | CommonJS | `electron` | `apps/desktop/src/preload` |
| `renderer` | Browser | ESM | None | `apps/desktop/src/renderer` |
| `agent-host` | Node | ESM | Pi and its dependency tree | `packages/agent-host/src` |

The preload build asserts that its output contains no ES module syntax. Bun's
CommonJS output remains an observed compatibility surface, so the assertion runs
on every build.

The renderer build also copies `fonts.css`, the Latin variable subsets of Geist
Sans and Geist Mono, and their OFL licenses from the two pinned Fontsource build
dependencies. Those assets are not JavaScript dependencies and no font is
fetched at runtime: the private `bakepi://app` origin serves them beside the
StyleX stylesheet, which keeps both `style-src` and `font-src` same-origin under
the renderer CSP. `bun run smoke` asks Chromium's `FontFaceSet` to load both
families through that real origin and fails if either face falls back.

It also writes `file-icons.json`: the vscode-icons artwork for every icon the
`vscode-icons-js` name tables can reach, taken from the `@iconify-json/vscode-icons`
build dependency with `style` attributes stripped. The file rail fetches it once
from the same origin and draws each icon inline, so no `style-src` or `img-src`
exception is needed for two megabytes of path data that never enters the bundle.

Pi stays external to the agent-host bundle. Packaging keeps ordinary
`node_modules` resolution and unpacks `photon_rs_bg.wasm` from the ASAR archive.

## TypeScript environments

All TypeScript projects extend `tsconfig.base.json`, which enables strict mode,
unchecked indexed-access checks, exact optional properties, isolated modules, and
no emit.

| Configuration | Ambient environment |
| --- | --- |
| `apps/desktop/tsconfig.main.json` | Electron main and Node |
| `apps/desktop/tsconfig.preload.json` | Preload's narrow Electron/DOM surface |
| `apps/desktop/tsconfig.renderer.json` | Browser DOM without Node |
| `packages/agent-host/tsconfig.json` | The shared Node surface for Electron's host and Node 22+ inside WSL |
| `packages/contract/tsconfig.json` | Neither DOM nor Node |
| `tsconfig.tools.json` | Bun build scripts and repository tools |
| `tsconfig.tests.json` | Bun test files plus the environments they exercise |

The direct development dependency is `@types/node@26.4.0`; Electron 44 executes
main and agent-host code on Node.js 24.18.1. Typechecking cannot prove runtime API
availability across that version difference.

## Contract organization

`packages/contract/src` mirrors the protocol structure:

- `commands/` declares 50 command schemas by capability group. Forty-nine are
  renderer capabilities; host-internal `open_workspace` is deliberately absent
  from the preload surface.
- `events/` declares 36 event schemas by lifecycle family.
- `dto/` declares shared session, model, tool, resource, message, and approval data.
- `envelope.ts` declares correlated command, response, and event envelopes.
- `handshake.ts` and `version.ts` declare exact contract-version negotiation.
- `errors.ts` declares renderer-safe error codes.
- `validate.ts` compiles and applies the runtime validators.

Adding a command changes the contract-derived preload surface and makes the
agent-host handler map incomplete until a handler exists.

## Agent-host organization

`packages/agent-host/src` is the only place Pi may be imported, and it is
organized by what each part is allowed to assume.

- `index.ts` and `parent-port.ts` own the host's parent channel. The default is
  Electron's parent `MessagePort`; `--listen` opens an authenticated loopback
  WebSocket for a plain Node host in WSL. The transport token is removed before
  the ordinary `hello` envelope reaches the runtime, so both wires present the
  same `ParentPort`. That socket also mints short-lived, single-use tickets for
  renderer event sockets; each accepted socket is adapted to the same
  `HostMessagePort` as Electron's transferred event port. `dispatch.ts` is the
  command path itself, split out because
  the entry module acquires a real parent port at module scope and cannot be
  imported by a test — which would otherwise leave the host's own command leg,
  the thing main's residual is measured against, unobservable.
- `runtime.ts` is the adapter around Pi and the only file that constructs Pi
  objects: the model runtime, the trust store, workspaces, and sessions.
- `session-host.ts` is one live session projected onto the contract, including
  the write guard that runs before every mutating command.
- `emitter.ts` owns per-session sequence numbers and the snapshot fence.
- `diagnostics.ts` holds the raw errors that never cross to the renderer.

Five directories hold logic that is deliberately independent of Pi's runtime, so
it can be tested without building a session:

- `policy/` decides whether a tool call needs approval. `paths.ts` canonicalizes
  and classifies targets, `targets.ts` extracts them from tool arguments,
  `approval.ts` is the three-rule policy, `gate.ts` parks and resolves requests,
  and `extension.ts` binds the gate to Pi's blocking `tool_call` hook.
- `observability/` decides what may be *said* about a session's timing. It holds
  no Pi types and reads no clock it was not given, which is what lets its ring,
  its percentile buckets and its eviction order be tested without a session at
  all.
- `extension-ui/` correlates Pi's portable select, input, editor, and confirm
  dialogs with contract responses and resolves every abort, timeout, close, or
  shutdown to the safe default.
- `session/` decides what may be done with a session file and Pi's durable
  workspace-scoped configuration. `integrity.ts` judges
  its bytes before Pi opens it, `ownership.ts` holds the advisory lock and the
  foreign-write fingerprint, `tool-marker.ts` records a running tool beside the
  session so a crash mid-tool is still reported after it, `attachments.ts`
  validates workspace containment, byte counts and image types before using
  Pi's public processing APIs, `discovery.ts` maps Pi's listing onto contract
  summaries, `settings.ts` maps the settings UI only onto Pi's public
  `SettingsManager` getters and setters, `workspace-permissions.ts` remembers the
  permission level each workspace was last set to plus the level an undecided one
  opens at — the half of a trust decision Pi's boolean `ProjectTrustStore` has no
  room for, and never a way to exceed the grant Pi recorded — and `budget.ts`
  holds the capacity limits
  — how many sessions may be open, how heavy the host may get, and how deep a
  prompt queue may grow — with the measurement each number came from.
- `mapping/` projects Pi onto the contract. `messages.ts` maps messages, blocks,
  usage and tool output; `coverage.ts` is the adapter report — a table keyed by
  Pi's own `AgentSessionEvent` union declaring what each event becomes, so an
  event added upstream is a compile error rather than a silent fall-through, and
  `coverage.test.ts` drives a fixture for every entry.

`budget.ts` is a decision module with no state of its own: `runtime.ts` calls it
before Pi builds a session and before a prompt is allowed to wait, and both call
sites are placed where a refusal costs nothing — ahead of the runtime that would
have to be unwound, and ahead of the lock that would otherwise be left on a file
nobody could then open. `scripts/budgets.ts` is where its numbers come from.

Two ordering constraints are worth knowing before changing this code, and neither
fails visibly when it is broken. `integrity.ts` must run before
`SessionManager.open`, because Pi's load repairs a torn file and destroys the
evidence. `tool-marker.ts` must be read *after* the lock is acquired, because
reading a marker is also deleting it, and a read taken earlier would consume the
marker of the live host that legitimately owns the session. Each file states what
it costs if it is moved.

`test/` holds fixtures that must not ship inside the agent host: the HTTP
provider in `provider-fixture.ts`, the real pinned-CLI interoperability lane in
`cli-interop.test.ts`, and `fake-session.ts`, a Pi session runtime
carrying only the members `SessionHost` touches — so a host that starts calling
something new fails loudly there rather than silently reading undefined.

`test/backpressure.test.ts` is the one file in the repository that stands on both
sides of the process boundary, importing the renderer's stream and reducer
alongside the host and wiring them through a real `MessagePort`. It is how the
claim "a projection that lost events ends up equal to the session" is checked
against the host's own snapshot rather than against a written expectation. The
boundary suite allows it because it excludes test files; shipped renderer code
importing the agent host would still fail there.

## Main-process organization

Main owns lifecycle, security, IPC and supervision, and reads no events — it
creates the event `MessagePort`, hands one end to the agent host and the other to
the renderer, and keeps neither. That is what keeps a streamed token off the
supervisor's path, and it is also the constraint that shapes everything below.

- `ipc/route.ts` is what happens to a command: the guard check, then either an
  answer or a forward through the host supervisor.
  `ipc/router.ts` is the `ipcMain` registration around it, separate so the
  decisions can be tested without booting Electron. It passes each command's
  main-process arrival instant as a value rather than storing it in shared
  timing state — importing `electron` outside Electron does not resolve.
- `ipc/guard.ts` checks sender identity, command name, params and user gesture
  before any of that runs.
- `supervisor/host.ts` contains `UtilityProcessLauncher`, the current
  `HostLauncher` implementation. Its exit handler calls `onExit` before failing
  pending commands, because the pending map is the evidence a crash is
  attributed from.
- `supervisor/wsl-process.ts` holds every `wsl.exe` invocation main makes, so
  the `--exec` argument vector and the output caps are stated once.
- `supervisor/wsl-node.ts` finds the Node the person actually installed in a
  distribution. A version manager writes its `eval` to an interactive rc file,
  which is why the obvious `sh -lc "node -v"` reports "no Node" on a machine
  that has several; the module explains the two passes and why they are in that
  order. It answers with an absolute, symlink-resolved path because fnm's PATH
  entry is a per-shell directory that outlives nothing.
- `supervisor/wsl-node-install.ts` brings a Node of its own when a distribution
  has none — the part of VS Code's remote model that makes "install Node first"
  not a step anybody performs. The version and its SHA-256 are pinned in the
  file, the download happens on the Windows side and is piped in over stdin, and
  the archive is gzip rather than xz because `xz-utils` is missing from exactly
  the minimal images this fallback exists to rescue. Main offers it; nothing
  downloads without a person choosing it.
- `supervisor/wsl-launcher.ts` is the socket-channel implementation for a host
  inside one WSL distribution. It resolves Node 22 or newer through
  `wsl-node.ts` and spawns that binary by path, stages a content-addressed ESM
  bundle under `~/.cache/bake-pi`, consumes the one startup line without logging
  its token, and then carries the existing command envelopes over loopback
  WebSocket. The first connect to that socket is retried: WSL's localhost relay
  publishes the Windows-side listener about a second after the guest binds, so
  the announcement arrives before the port is reachable. Renderer attachment requests a
  one-time event ticket on that control channel and passes only the resulting
  loopback URL to preload, which adapts JSON frames back to the renderer's
  existing `MessagePort` intake. It is not selected for workspaces until the
  workspace runtime descriptor and production dependency placement exist.
- `supervisor/supervisor.ts` is the one owner of transport generations, recorded
  dispatch, restart policy, workspace-before-session restoration, quarantine,
  stale-generation suppression, and post-restore event-channel attachment. It
  depends on replaceable host-launcher and renderer-endpoint interfaces, so
  their load-bearing order is tested without starting Electron. Native dialogs,
  renderer crash budgeting, resource probing, and app-wide quit coordination
  remain composed outside it.
- `supervisor/recovery.ts` decides what a crash meant: which session to blame,
  which workspace roots and sessions to restore, and whether restarting is safe
  to do without asking. The supervisor restores roots before sessions because a
  replacement host starts with an empty workspace map. The ledger is built only
  from commands, and it says in its own comments what it therefore cannot see.
- `supervisor/health.ts` is the restart budget. `supervisor/quit.ts` makes quit
  one awaited operation, so concurrent quit signals neither start a second host
  teardown nor let Electron exit before the first one finishes.
- `supervisor/process-group.ts` takes the tool process tree, which the OS will not
  clean up on its own.
- `recent-workspace.ts` remembers up to ten canonical roots Electron opened,
  most recent first. `workspace-locations.ts` gives those roots and discovered
  WSL homes opaque process-local ids, validates that a new workspace name is one
  child segment, creates it, and rolls it back if requested Git initialization
  fails. The renderer can return an id but cannot supply a filesystem path.
- `window-state.ts` remembers normal window bounds with their display and work
  area. Electron reports this geometry in device-independent pixels, so restore
  never applies a monitor's physical scale twice; it preserves the window's
  display-relative position across rearrangements, falls back to a visible
  display when one disappears, and refits when display metrics change.

Main answers six commands rather than forwarding them (`MAIN_OWNED_COMMANDS`
in the contract): `choose_workspace` and `choose_attachments` invoke native
pickers; `list_workspace_locations`, `create_workspace`, and
`reopen_recent_workspace` operate on main's opaque location ids; and
`restart_host` has to work when no agent host is running. A chosen workspace
reaches the host through internal `open_workspace`, which is excluded from the
renderer command vocabulary.

## Renderer organization

The renderer is a projection of Pi-owned state and contains the Milestone 3
workbench without gaining any direct filesystem, Electron, or Pi capability.

- `store/stream.ts` owns MessagePort intake, sequence fencing, gap detection,
  and batched delivery acknowledgements. The host spends a one-megabyte credit
  window as it posts events and receives that credit back on the same port, so
  a connected but stalled renderer is bounded by the same discard-and-resync
  policy as a renderer that has not connected yet.
  `store/stream-batcher.ts` folds adjacent deltas for one block once per paint,
  drains them before every structural event, and caps one retained paint at
  256 KiB. Sequence validation still happens before batching:
  a sequence number that never arrives is an event lost on this side, and it is
  reported once so the store can ask the host for a snapshot. It drops an event
  the contract rejects and raises anything else, because a validator that cannot
  run at all fails every event after it — including the snapshot that would
  repair the projection — and advances no counter while doing so.
- `store/reducers/session.ts` projects contract events into session state. A
  weak index carried by each immutable message array addresses message updates
  by id without rescanning a long history for every streamed batch; a second
  weak index addresses tool calls by id, since their update events carry no
  message id. Its
  `PROJECTION` table is typed `Record<SessionEventName, string>` and says what
  each session event becomes, so an event added to the contract fails the build
  here rather than falling through the reducer's `default` — which is what had
  happened to the whole tool-call lifecycle, leaving a running tool invisible
  until the turn ended and a snapshot replaced the projection. It also carries
  the two announcements no snapshot can: how many messages a compaction removed,
  and that a turn is waiting on a retry. Both survive the snapshot that follows
  them, because a snapshot is the thing they explain.
- `store/session-projection.ts` owns one session's disposable indexes and named
  read views: core metadata, timeline, activity, approvals, and todo. A snapshot
  replaces its reducer state and rebuilds every derivation; between snapshots a
  text delta publishes only the timeline view, and a structural rebuild retains
  the identity of every completed row whose inputs did not change. That keeps
  both React work and a live DOM selection attached to the row being read.
  `store/readable-view.ts` is the runtime-neutral external-store contract,
  and `store/use-readable-view.ts` is its only React adapter.
- `store/session-store.ts` connects the stream to those projections and exposes
  only contract-derived actions. App observes the shell view, Workbench observes
  its non-streaming view, and the conversation leaves subscribe to the active
  session views directly. `store/stream-batcher.ts` is the only animation-frame
  boundary; there is no second render scheduler behind it. The store receives
  the event port from the main world: preload waits for page load and transfers
  Electron's port with `window.postMessage`, because `contextBridge` copies
  values and cannot carry a DOM `MessagePort` prototype. Workspace changes are
  serialized and generation-checked so an early workspace event or a late
  session result cannot move one workspace's projection into another.
- `features/workbench/` owns the shell: a 44px tab strip over three columns —
  `FileRail.tsx`, the conversation, and a right rail that switches between
  `ActivityRail.tsx` and `SettingsRail.tsx`. The file rail reads
  the workspace through `list_directory`, one directory at a time, and holds the
  listing in the component rather than the store, because a directory listing is
  a read of the filesystem at an instant and not a projection of anything Pi
  owns. It keeps each listing's `truncated` flag and says so in the tree, since a
  directory the host stopped reading is otherwise indistinguishable from one that
  ends there. Containment is decided in the host, never here.
  Both rails are resizable: a `role="separator"` handle drags, arrows and
  Home/End move it from the keyboard, and a double-click restores the token's
  width. Each rail clamps to its own limits and both yield before the
  conversation drops under 400px, so no drag can produce a layout the window
  cannot show. Widths are remembered per rail through `store/preferences.ts`.
  The columns are `minmax(0, 1fr)` tracks over rails that set `minWidth: 0`,
  without which a rail whose min-content exceeded its track pushed the grid past
  the viewport rather than scrolling inside itself.
  Either rail is a grid column above its breakpoint and an off-canvas panel
  below it — the right rail at 1180, files at 940 — and the breakpoint alone
  decides which. The file and activity toggles slide their panel back in over a
  scrim scoped to the same width. Settings deliberately has no scrim: it is a
  non-modal view in the right rail, so ordinary focus and pointer interaction
  remain available in the uncovered workspace. Hiding is `visibility`, not
  `display`: it buys the
  same removal from the tab order and the accessibility tree, and it is the one
  hiding property CSS interpolates asymmetrically, so a rail stays drawn for the
  whole of its slide out. `window.ts` normally holds the window to 720 DIPs for
  the same reason those breakpoints exist — a breakpoint no window can reach is
  a rule nobody can check. It lowers that floor only when a high-scale display's
  entire work area is smaller, keeping the native frame reachable. The width of
  that frame is decided by `build/windows.manifest`, not by `window.ts`: Electron
  insets the client area by the current display's frame thickness on the left,
  right and bottom, and Windows sizes the frame to match only for a per-monitor
  DPI aware v2 process. Electron's own manifest says v1, so on a 150% display
  beside a 100% primary three pixels of frame showed inside the hairline on
  those three sides. `scripts/manifest.ts` stamps the manifest into the
  development binary on install, `forge.config.ts` into the package, and
  `bun run frame` opens the window on every display and measures the result.
- `features/conversation/` owns safe Markdown, the block-level virtualized
  timeline, active-stream following, the composer, attachments, queue controls,
  tool presentation, and approval cards. Completed virtual rows are memoized at
  the row boundary, keyed-row anchoring holds a detached viewport while measured
  heights settle, and text that is provably one plain paragraph bypasses the GFM
  parser; anything carrying a Markdown, block, entity, or autolink marker stays
  on the full safe-Markdown path.
- `features/conversation/turn-summary.ts` and `TurnSummary.tsx` recap the turn
  that just ended — its tools, its tool time, its tokens, and the files it
  changed — in the gap between the last answer and the next prompt. Scoped to
  one turn on purpose: the activity rail owns the session's ledger and its whole
  list of changes, and a second meter for one number is two numbers that drift.
  Line counts come from `presentToolStep`, so the recap cannot count differently
  from the steps it summarizes, and changed files are named by the host's
  canonicalized write targets rather than by an argument. A turn that ran no
  tools gets no card. Tool time is summed from each call's own two host
  instants, and there is no turn duration because nothing in the contract
  records when a turn opened and settled — inferring one would be the
  cross-process instant arithmetic the observability rule forbids.
- `features/conversation/composer-token.ts` decides whether the caret is
  standing in a mention. `@` opens the workspace files, `/` opens the command
  palette, and a command is only a command at the very start of the draft —
  prose is full of slashes that are not one. It reads the text before the caret
  rather than the end of the draft, so adding a reference mid-sentence works.
  The composer's menu resolves an `@` by walking listings a directory at a time,
  never by joining the workspace root with what was typed: every path the
  renderer can name came back from a listing the host had already contained, and
  composing one would let the field decide what gets read. The mention that
  lands in the message is relative to the workspace, because that is the root
  the agent is working from and an absolute path is noise in a sentence. The
  palette holds only commands the contract already has, and each row states when
  the session can take it — there is no `/fork` before there is a message to
  fork from.
- `features/conversation/highlight.ts` and `diff-model.ts` are the halves of
  syntax colour that never touch the DOM: Shiki tokenizes, `@pierre/diffs`
  parses a patch into rows. `Code.tsx` and `Diff.tsx` then hand each token's
  colour to React's `style` prop, which writes it through CSSOM — the one path
  `style-src` does not police. Rendering a library's HTML string instead would
  need `'unsafe-inline'`, which is why neither library's own renderer is used.
  Shiki runs on its JavaScript regex engine because the same policy blocks WASM.
  Tokenization is cached in an eight-entry, source-weighted LRU; inputs above
  100,000 characters or 2,000 lines remain plain text so one pasted artifact
  cannot monopolize the renderer or live in token memory for the window's life.
- `features/conversation/code-theme.ts` holds the three syntax themes, in VS
  Code's format so Milestone 4's importer can accept the same shape. They are
  greyscale like the rest of the interface, which means hue can no longer tell
  a keyword from a comment: seven scopes collapse onto one lightness ramp, with
  italic and bold separating its two ends. `code-theme.test.ts` asserts the
  ramp's contrast and its ordering, which it can do by importing the module —
  the palette in `tokens.stylex.ts` has to be read as text instead.
- `theme/appearance.ts` names the persisted theme choice and resolves it to
  light, dark or high-contrast for consumers that pick by name rather than by
  CSS, which is what a Shiki theme needs.
- `theme/sizes.stylex.ts` holds the measurements the layout is built from — the
  strip's height, each rail's default width, the control sizes — so a number that
  two files have to agree on is written once. `sizes.test.ts` reads it as text
  for the same reason `contrast.test.ts` does, and holds a roster of the tokens
  so one cannot quietly disappear.
- `store/preferences.ts` is the only place the renderer writes to
  `localStorage`, under a `bakepi:` prefix and inside try/catch on every access,
  because storage can be denied outright and a preference is never worth a blank
  window. It parses compile-time size constants when it needs a numeric default,
  so `sizes.stylex.ts` stays the single place a width is written. What it holds
  is presentation the host has no opinion about — the theme, a rail's width, and
  the last selected session id for each canonical workspace. A remembered id is
  accepted only if Pi's fresh listing still owns it; messages and session state
  never enter local storage, which would make it a second source of truth.
- `theme/scrollbars.ts` is the one scrollbar every scrolling surface wears: a
  10px track for the pointer with a 4px thumb painted inside it by a transparent
  border and `background-clip: content-box`, tinted 8/12/16 percent at rest,
  hover and drag. It is applied by composition at each call site rather than
  globally, and it has to be — the CSP omits `style-src 'unsafe-inline'` so
  `index.html` cannot carry an inline stylesheet, and StyleX has no universal
  selector.
  The elements that import it are therefore exactly the elements that scroll,
  and `scrollbars.test.ts` holds that: it reads the renderer as text, finds
  every style declaring a scrolling overflow, requires each to be composed with
  `scrollbars.thin` at its call site, and holds the whole set against a roster
  so a new scrolling surface has to be listed rather than noticed.
- `theme/spinners.ts` is the same idea for the one spinner: a `border-box` ring
  at `size.iconMicro`, `runningSoft` with a `running` cap, 1100ms linear, stopped
  by the reduced-motion query. The tab strip's streaming mark, its reconnection
  mark and the start screen's session mark had each declared their own keyframes
  and their own copy of the ring, so one animation was emitted three times and a
  tone change had to land in three files. `geometry.test.ts` now names the ring
  once in its roster of true circles instead of once per call site.
- `features/workbench/SettingsRail.tsx` owns the single configuration surface:
  provider credentials, Pi behavior, resources, privacy, diagnostics, and
  appearance. `PiSettings.tsx` groups the public Pi setting surface, replaces
  its projection only with Pi's post-flush snapshot, and marks effective
  project overrides as locked global controls rather than pretending they were
  changed. One
  Settings control in the tab strip swaps it into the existing right rail;
  section tabs replace only the rail body, so no overlay or second drawer is
  created. The tab pattern has roving focus and arrow/Home/End navigation, and
  the active body alone is mounted so an API key cannot remain in hidden DOM.
  The rail is non-modal: Escape closes it and returns focus to its trigger, but
  ordinary Tab may leave it.
- `features/workbench/Overlay.tsx` owns the extension dialog and the form/action
  vocabulary shared with Settings. A dialog is the one surface that blocks the
  workspace: it sits on `surfaceOverlay` over a scrim and traps focus. Focus
  enters at `[data-autofocus]` when a question names one and at the close button
  otherwise, and returns where it came from.
- `theme/tokens.stylex.ts` is the design system: a neutral greyscale palette in
  three themes, a spacing and radius scale, an `effects` group and a `motion`
  group. Nothing in it carries a hue, status included, so the five state roles
  are one lightness ladder ordered by urgency and every place that used to lean
  on colour says the same thing again with a glyph, a word or a shape —
  `contrast.test.ts` asserts both the neutrality and the ladder's spacing.
  It follows fluid functionalism's two rules — elevation rather than outline,
  and a different lift in light than in dark — so `effects.hairline` is `0px`
  everywhere but the high-contrast theme, where an outline is the accessibility
  requirement, and every other boundary in the interface is a difference
  between two fills or a shadow. `motion` collapses interactive durations under
  `prefers-reduced-motion` at the token, so a transition written anywhere obeys
  the setting without its author asking; rare state arrivals keep a 200ms
  opacity-only cue while removing translation and scale. Every value is a
  literal because the StyleX compiler folds these calls at build time and
  rejects anything it cannot see, which is why `theme/contrast.test.ts` reads
  this file as text rather than importing it: a `.stylex.ts` module throws when
  it is loaded without the Babel plugin, and the ratios worth asserting are the
  ones the compiler reads.
- `App.tsx` owns the connection, onboarding and project-trust gates before it
  mounts the workbench.
- `build/watch.ts` is `bun run dev`: it watches the four bundles' sources plus
  the contract, and does one of two things. A renderer edit is rebuilt and the
  running app reloads itself — `src/main/dev-reload.ts` watches `dist/renderer`
  for the `build-stamp` the renderer build writes last, which is the only signal
  that says a bundle is complete rather than merely being written. A main,
  preload or host edit restarts Electron, because those processes cannot be
  replaced in place. The split is what lets an interface change keep the
  conversation it is being judged against. Each rebuild runs in a fresh
  subprocess: a second `buildRenderer()` in one process fails on sources that
  had just built, because the StyleX plugin carries state across builds.

## Update triggers

Update this page when a workspace is added or removed, a source directory changes
ownership, a build target changes format or runtime, a TypeScript environment
changes ambient types, or an enforced dependency boundary changes.

This page describes ownership and boundaries, not completeness. What each part
does *not* yet do belongs in the [coverage gap register](../planning/coverage-gaps.md).
