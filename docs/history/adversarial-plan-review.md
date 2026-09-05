# Adversarial review of the Bake Pi development plan

- **Review date:** 2026-08-29
- **Record status:** Historical review of the superseded root development plan
- **Current roadmap:** [Roadmap to Bake Pi v1](../planning/roadmap.md)
- **Current gaps:** [Open coverage gaps](../planning/coverage-gaps.md)
- **Target at review time:** `DEVELOPMENT_PLAN.md` (825 lines, research date 2026-08-29)
- **Method:** Independent re-verification of every load-bearing external claim, then attack on the architecture, risk model, and schedule.
- **Verdict:** The plan is factually accurate and architecturally sound. It fails on **risk calibration, upstream drift, and schedule realism**. Four findings are blocking; none require abandoning the design.

## Status after the lean-architecture rewrite

This review was written against the Bun-sidecar plan. The plan was subsequently rewritten around the lean architecture — Pi runs on Electron's own Node in a `utilityProcess`, Bun is toolchain-only — which **dissolved several findings rather than fixing them**. Recorded here so the review is read against the right plan:

| Finding | Status |
| --- | --- |
| C1 — Bun 1.4.0 rewrite maturity | **Dissolved.** Bun no longer hosts the agent. Toolchain exposure only |
| C3 — `jiti` extensions and WASM from a compiled binary | **Dissolved.** There is no compiled binary |
| C4 — fallback ladder | **Dissolved.** The ladder collapsed to SDK-in-`utilityProcess` with `runRpcMode` as fallback. The correction below is why |
| S1 — protocol on stdout | **Dissolved.** `MessagePort` and structured clone replaced the wire protocol entirely |
| M2 — CBOR decoder hardening | **Dissolved.** No CBOR. Schema validation on typed objects remains |
| S5 — Windows endpoint protection | **Mostly dissolved.** No unsigned runtime-embedding executable is spawned; a Defender-enabled startup measurement remains |
| S2 — concurrent session writes | **Half dissolved.** Single-window v1 removes the internal case; CLI-versus-app remains |
| C2, H1, H2, H3, H4, H5, M1, M3–M10, S3, S4, S6–S8 | **Still live**, carried into the rewritten plan |

The lesson worth keeping: most of the blocking findings were downstream of one avoidable decision. Removing the second runtime was worth more than every mitigation written for it.

## What survived the attack

These were checked and are correct. Do not trade them away in refinement.

| Claim | Status |
| --- | --- |
| Electron `44.0.0` = Chromium 152, Node.js 24.18.1 | Verified |
| React `19.2.8`, TypeScript `7.0.2`, `@xterm/xterm` `6.0.0`, `@electron-forge/cli` `7.11.2` | Verified as current npm `latest` |
| Pi `v0.84.3` exists, published 2026-08-24 | Verified |
| `@earendil-works/pi-coding-agent` is MIT, `engines.node >= 22.19.0`, bin `pi` to `dist/bundle/cli.js` | Verified |
| Pi SDK exports `createAgentSessionRuntime`, `ModelRuntime`, `SessionManager`; documents `runRpcMode(runtime)` and `pi --mode rpc` | Verified |
| Pi sessions are JSONL trees under `~/.pi/agent/sessions/`; SQLite is a **separate** package used by `pi-server` | Verified — the plan correctly avoids the SQLite backend |
| Bun 1.4 ships `Bun.Terminal`, `Bun.Image`, `bun run --parallel`, `bun test --isolate`, React Compiler, Windows ARM64, isolated-by-default linker | Verified |
| `utilityProcess` cannot launch a non-Node executable; `child_process.spawn` is required | Correct |

The four-process boundary, the fuse and ASAR-integrity posture, the "approval is not a sandbox" honesty, and the no-fork discipline are all right. The critique below is about what the plan *does not* model.

---

## Blocking findings

### C1 — Bun 1.4.0 is the first stable release of a total rewrite, and the risk table does not mention it

The plan's Bun row lists 1.4 features as a benefit list. It never states the material fact: **Bun 1.4.0 (released 2026-08-20, nine days before the plan) is the first stable release of a full Zig-to-Rust rewrite.** Bun's own upgrade is an explicit opt-in because of breaking changes, and public analysis flags native-module compatibility and WebSocket/stream edge cases as where rewrite regressions surface first.

That is precisely Pi's dependency surface: `undici` for provider HTTP and streaming, a WASM image codec, and an optional native clipboard module.

The plan assigns this runtime the process that owns **all** agent state, credentials, PTYs, and tool execution — with no maturity caveat and no rollback path.

**Fix:** pin the newest `1.4.x` patch rather than `1.4.0`; add a runtime-maturity risk row; require Milestone 0 to run every compatibility fixture on **both** Bun and Node so any failure is attributable to Bun rather than to Pi; make "a Bun regression is found after general availability" a pre-defined tier transition (C4), not an improvisation.

### C2 — The Pi pin was already stale on the day the plan was written, and there is no drift budget

`v0.84.4` shipped 2026-08-28. The plan is dated 2026-08-29 and pins `v0.84.3`.

Observed cadence: `v0.84.0` (Aug 6) to `v0.84.4` (Aug 28) — **five releases in 22 days**. Over the plan's own 9–13 week estimate that is roughly 20–30 releases of drift, and over a realistic schedule (H4) considerably more.

The plan's only mechanism is a 10-step manual pull request per update. Nobody runs a 10-step manual gate weekly for six months. The predictable outcome is a v1 shipping on a pin many months stale — which directly contradicts the product goal that a Pi CLI user can move between the CLI and Bake Pi, because both sides drift apart.

**Fix:** invert the default. A **scheduled weekly automated bump attempt** against the newest tag runs the contract suite and publishes a red/green drift report; the 10-step gate becomes the manual escalation path for a red result. Add a hard release gate: the pin must be within a stated distance of the newest upstream release at release-candidate time.

### C3 — The most likely Milestone 0 failure is not in the exit criteria

Pi loads extension TypeScript at runtime from arbitrary absolute paths (`additionalExtensionPaths: ['/path/to/my-extension.ts']`), and it does so through **`jiti`** — a runtime transpiling loader with its own resolver — which is a direct dependency of `@earendil-works/pi-coding-agent`.

`bun build --compile` documents that non-statically-analyzable dynamic imports are **not** included in a single-file executable and require explicit `externals` configuration or code splitting. A compiled binary must therefore still carry a transpiler and permit importing arbitrary user TypeScript from outside its virtual filesystem.

Milestone 0 currently says "load one TypeScript extension" (under Bun) and separately "compile the spike and run it outside the repository". **It never requires loading a user extension from an arbitrary path out of the compiled binary** — the actual product requirement, and the combination most likely to fail.

The same applies to two named assets the plan only gestures at as "native/WASM files found during the spike":

- `@silvia-odwyer/photon-node` ships `photon_rs_bg.wasm`, which must resolve at runtime from a compiled binary.
- `@mariozechner/clipboard` is an optional native dependency.

**Fix:** name all three in the Milestone 0 exit criteria as pass/fail items, with extension loading tested specifically *from the compiled binary*.

### C4 — The fallback is one undifferentiated sentence covering three different failures

> **Correction.** This finding originally claimed the fallback was *unbuildable* — that it needed a Node runtime the app does not ship, leaving only a bundled Node binary or re-enabling the `RunAsNode` fuse. **That reasoning was wrong**, and a second review caught it. Electron's `utilityProcess.fork()` runs a JavaScript module on Electron's own embedded Node (24.18.1, satisfying Pi's `>=22.19.0`) in a crash-isolated process, and it is **unaffected by the `RunAsNode` fuse** — Electron's fuse documentation recommends it as the supported replacement for exactly this case. The gate was always exercisable, and Tier C costs approximately nothing rather than a second runtime and signing target. The plan has been corrected accordingly, and the pre-Milestone-0 installer-costing exercise this finding demanded has been removed. The finding below is what survives.

The Milestone 0 fallback is "launch Pi's official bundled RPC entry point". That single sentence covers three different failures with different costs and different answers: compilation into a single binary fails; the Bun runtime itself fails; or Pi fails under anything but Node. The plan cannot make a gate decision against an undifferentiated fallback.

It also never asks the question that decides whether the fallback is a fallback at all: **can Pi's RPC mode service the commands this product needs** — blocking tool approvals via the policy extension, extension dialog round trips, queue mutation, tree navigation? "Behind the same protocol" is an assumption, not a finding. If RPC cannot block on approvals, the safety model changes and the rung does not exist.

**Fix:** define an explicit four-tier ladder — compiled Bun, then Bun with an on-disk bundle, then the SDK inside a `utilityProcess`, then Pi RPC inside a `utilityProcess`. Note that `utilityProcess` **cannot** launch the Bun executable (hence `child_process.spawn` at Tiers A and B) but **is** correct for the Node-based tiers; the plan states both, and both are true. Require Milestone 0 to produce a per-tier command-support matrix, not a round trip.

---

## High findings

### H1 — Building Pi from vendored source is a permanent cost buying provenance you already have

The plan runs two toolchains (npm/Node for `upstream/pi`, Bun for the app), two lockfiles, an artifact-hash handoff, a drift-detection gate, and a rebuild-and-compare-against-npm step. It even carries its own risk row for the two domains diverging.

It also makes every upstream build-script change a Bake Pi build break.

Be precise about the trade, though — an earlier draft of this finding overstated it. Integrity hashes prove the registry served the pinned bytes; they do **not** prove those bytes match the tagged source. That correspondence is real provenance, and dropping the source build from the release path genuinely loses it. The cost argument still wins, but it is a trade, not a free removal.

**Fix:** consume the published npm packages with exact pins plus integrity hashes as the production input. Keep `upstream/pi` as a read-only reference checkout for diffing, contract fixtures, and issue reproduction. Demote the source build to a periodic verification job that cannot block a release — and specify its comparison as **semantic** (unpacked file list, declaration files, exported API surface, sampled strings), because a bundled `cli.js` is not byte-reproducible and a byte comparison would fail every run and be ignored within a month.

### H2 — Credential interop with the Pi CLI is a concurrency problem the plan does not model

Pi guards its credential store with `proper-lockfile` and exports `CredentialSynchronizationError`. The plan's stated goal is that the CLI and Bake Pi share one `auth.json`. Two processes refreshing the same OAuth token can invalidate each other's refresh token — a silent, user-visible logout.

**Fix:** state a single-writer discipline, honour the upstream lock, treat `CredentialSynchronizationError` as a first-class UI state ("credentials changed on disk — reload"), and add a contract test that runs a CLI login and refresh concurrently with the app.

### H3 — Reusing Pi's OAuth client from a redistributed product is a distribution risk with no owner

The parity matrix marks OAuth authentication **Required** for v1. The plan never asks whether provider terms permit a *different, redistributed* application to use OAuth clients or subscription-based credentials registered to Pi. This can invalidate a public release, and it is not an engineering question that Milestone 0 can settle.

**Fix:** ship **API-key authentication as the supported v1 path**. Keep OAuth reuse available for local personal use, gated behind written clearance from upstream and each provider before public distribution. Add it as a decision gate with a named owner.

### H4 — 9–13 weeks solo is not a credible range for this scope

The scope includes a versioned binary protocol with fuzzing, an Electron security suite, full session and resource parity, extension dialog UI, accessibility, a cross-platform PTY, three operating systems across two architectures, signing and notarization, an SBOM, updates with rollback, and packaged smoke tests on clean virtual machines. The estimate explicitly excludes signing-account delays — which routinely dominate a first desktop release.

Every milestone range is also stated as best-case with no contingency, and the milestones are summed as if later work never re-opens an earlier one.

**Fix:** apply an explicit contingency factor of about 1.8 to the 9–13 week sum, giving **16–23 weeks of engineering effort**, and track signing-account approval, notarization, and store review separately as calendar risk on queues this project does not control — multiplying engineering time does not model someone else's queue. Then split a shippable **v1-minimal** (Windows x64, API-key authentication, no terminal, no import/export, no ARM64) from **v1-full**, and make each post-slice milestone independently shippable.

A note on honesty: 16–23 is a rule of thumb, and it is exactly as underived as the 9–13 it replaces. Its only virtue is that it says so, and that it moves the lever from schedule to scope.

### H5 — Sidecar topology and resource budgets are undefined

"A bounded set of `AgentSessionRuntime` instances" — bounded by what? One sidecar for everything means a single crash takes down every workspace and one runaway tool starves them all. One per workspace multiplies memory by N. The plan never chooses.

**Fix:** choose one sidecar per window with sessions multiplexed inside it, state a memory ceiling and a concurrent-session cap, and make the supervisor enforce both.

---

## Medium findings

- **M1 — Snapshot/event race is unfenced.** The plan has "gap detection" and "authoritative snapshots" but no fence. Every snapshot must carry the sequence number it was taken at, and the renderer must discard buffered events at or below it.
- **M2 — CBOR decoding is hardened only by size and nesting limits.** This is the boundary between the sandboxed renderer path and the process that runs shell commands — a classic parser-differential surface. Require canonical encoding; reject indefinite-length items, unknown tags, and duplicate map keys.
- **M3 — Most exit criteria are unmeasurable.** "Remains responsive", "no known critical issue". Put numbers on the ones that gate a release: cold start to interactive, first-token latency overhead against the Pi CLI, steady-state memory on a 10,000-block session, dropped-frame budget while streaming, shutdown deadline. Without numbers, Milestones 3 and 6 cannot fail.
- **M4 — Version skew between bundled Pi and the user's CLI is unhandled.** Sessions are JSONL trees written by whichever binary touched them last. A user on a newer CLI can write entry types the bundled Pi does not understand. Read the originating version, warn on forward skew, never silently rewrite unknown entries, and add a *newer-CLI-wrote-it* fixture — same-version round-trip is not the risky case.
- **M5 — Real providers appear far too late.** Everything runs against a faux provider until Milestone 2. Streaming shape, tool-call chunking, and retry behaviour are exactly where real providers bite. Add a small capped real-provider smoke lane from Milestone 2 onward.
- **M6 — Telemetry and crash-report egress are never stated.** The plan redacts diagnostics but never says whether anything leaves the machine, to whom, or with what consent. Pi also ships a `telemetry` package that must be explicitly configured or disabled. For a tool that reads source code, "no automatic egress" must be an explicit product statement.
- **M7 — Do not let the sidecar assume it is Node.** Bun's `process.versions.node` is a compatibility claim, not a guarantee. Any Pi code path that branches on runtime identity is a compatibility fixture, not an assumption.
- **M8 — The `set_api_key` hedge is now resolvable.** The SDK documents `ModelRuntime.setRuntimeApiKey()`, `removeRuntimeApiKey()`, `login()`, and `logout()`. Note that `setRuntimeApiKey` is a *runtime override*; Milestone 0 must determine whether persistence to `auth.json` is publicly exposed. Name the real APIs instead of hedging abstractly.
- **M9 — `Bun.Image` is a convenience, not a requirement.** Pi already ships a WASM image stack. Preview-only use is correct, but if it costs Milestone 0 time, drop it without ceremony.
- **M10 — PTY output needs flow control.** `Bun.Terminal` feeding xterm.js over the protocol will drown the boundary on a single large output. Specify backpressure and a drop-or-summarize policy for the terminal event stream.

---

## Addendum — StyleX as the design system

Added after the review, on the maintainer's direction to adopt StyleX in place of the utility-class approach. Verified against the StyleX documentation and the npm manifests.

**The choice is sound, and it strengthens one existing requirement.** StyleX compiles to static CSS at build time with `runtimeInjection: false`, so the renderer needs no `style-src 'unsafe-inline'`. Every runtime CSS-in-JS alternative would have forced that concession against the plan's own Content Security Policy rule. `defineVars`/`createTheme` also give the four required themes a single typed source of truth.

**It collided with two decisions the plan had already locked, and both resolved in StyleX's favour:**

- *"Do not add a second bundler."* StyleX's documented integrations are Next.js, Vite, and `@stylexjs/unplugin`. The Bun bundler is not in the published keyword list, and the docs describe Bun usage via Vite — which would have contradicted the single-bundler rule. Checking the manifest resolves it: **`@stylexjs/unplugin@0.19.0` exports a dedicated `./bun` entry point** alongside webpack, rspack, esbuild, rollup, vite, farm, and rolldown. The single Bun build survives. The `@stylexjs/cli`/PostCSS pre-pass is the documented fallback; adopting Vite is not.
- *"Compile renderer components without a Babel pipeline."* The unplugin uses Babel internally to extract styles. The plan's claim is now bounded to React compilation rather than the whole toolchain, and Milestone 1 must prove the StyleX plugin and Bun's React Compiler compose in one build without ordering defects.

**One design consequence must be planned, not discovered.** StyleX forbids styles at a distance, so rendering model Markdown into an HTML blob styled by a `.prose` descendant sheet is not available. The Markdown renderer must emit React components carrying explicit StyleX props per node. This happens to align exactly with the existing rule that raw HTML from model output is disabled — one renderer satisfies both, and neither is reachable through `dangerouslySetInnerHTML`. Third-party CSS such as `@xterm/xterm`'s stylesheet stays outside StyleX as plain scoped CSS.

**New risk:** StyleX is at `0.19.0`, pre-1.0, and the Bun entry point is its least-travelled integration — while the whole component library will sit on it. Pin exactly, and prove the Bun build path in Milestone 1, before `packages/ui` exists and the fallback stops being cheap.

## Addendum — second-opinion findings

A second adversarial pass over this review and the revised plan produced the C4 correction above, plus the following. The surviving work now appears in the current [roadmap](../planning/roadmap.md) and [coverage register](../planning/coverage-gaps.md). Several are more dangerous than findings in the original review, because they are silent failures rather than plan defects.

**S1 — The protocol shares stdout with arbitrary user code.** The sidecar loads user TypeScript extensions from paths the user controls. That code writes to stdout. With length-prefixed framing on stdio *and* a rule that every decode failure kills the connection, one `console.log` in someone's extension desynchronizes framing, kills the connection, restarts the sidecar, reloads the extension — a restart loop that exhausts the crash budget. Fix: dedicated file descriptor 3 for the Bun tiers, `MessagePort` for the `utilityProcess` tiers, stdout routed to logs and never parsed, and a golden fixture for a noisy extension.

**S2 — Concurrent writes to the same session are unmodelled.** The review fenced *version* skew (M4) and *credential* concurrency (H2) and stopped. But the product actively encourages having a session open in the CLI and the app at once, and the per-window sidecar topology this review introduced recreates the hazard internally — two windows, two runtimes, one append-mode JSONL tree. Interleaved appends are silent corruption, strictly worse than skew. Fix: establish whether Pi locks sessions at all, then enforce single-writer semantics with cross-window routing and a visible read-only state.

**S3 — Sidecar death orphans tool subprocesses and can tear the session file.** Recovery handles the connection and assumes the rest. A Bash tool spawned by Pi survives the sidecar on Windows unless it is in a Job Object with kill-on-close, so the interface shows "disconnected" while an orphaned command keeps mutating the workspace and its result never reaches the session. A kill mid-append can also leave a truncated final JSONL line. And blindly reopening the sessions that were open at crash time lets one poisoned session burn the entire restart budget — recovery must quarantine.

**S4 — The approval classifier has unsound rules, not merely non-sandboxed ones.** `git log` executes attacker-chosen code when the workspace's own `.git/config` sets `core.pager`; the plan had "known read-only command" as a **default-allow**. Workspace containment by string prefix is defeated on Windows by 8.3 names, `\\?\` and UNC forms, `subst` drives, and junctions. Resolving paths at argument time rather than execution time is a time-of-check-to-time-of-use window an allowed write can open with a symlink. And the policy extension's own load-order priority over hostile project extensions is an assumption, not a documented upstream guarantee.

**S5 — Windows endpoint protection is absent from a Windows-first plan.** A compiled Bun sidecar is a large executable embedding a runtime — the shape scanners flag — spawned unsigned from an Electron resources directory. Neither document said "Defender" once, and the startup budgets were set without accounting for scan cost.

**S6 — Backpressure and "authoritative events" contradicted each other.** At the byte cap you could buffer (breaking the cap), drop (breaking authority), or block Pi's handlers (stalling tools). The resolution was already in the design and simply unconnected: breach the cap, discard, mark a gap, force a snapshot resync.

**S7 — Smaller, all real.** The drift budget counted semantic-version *minors* against a cadence that is five *patch* releases in 22 days — it would never have bound; count releases. The environment allowlist deletes Pi's environment-variable credential fallback that this same plan promises to preserve, and a GUI-launched app inherits no shell profile, so "works in the CLI, unauthenticated in the app" was the default outcome. With `sandbox: true` the preload is not a Node context and must not be built with the main process's target. A sidecar that crashes holding the `auth.json` lock locks the CLI out until the staleness timeout.

**S8 — Arithmetic.** The revised plan stated a 1.8 factor and a 20–26 week result; 9–13 × 1.8 is 16–23. It also folded signing delays into a contingency while the preamble declared them excluded. Both corrected above.

## Priority order

Revised after the second pass. The original order was wrong at both ends: it ranked the item with the longest external lead time last, and led with a finding that rested on a false premise.

1. **Day one, zero engineering cost:** open the OAuth distribution-authorization question (**H3**), and start acquiring the Apple Developer and Windows code-signing certificates. H4 identifies signing latency as the thing that dominates first desktop releases, and account acquisition appeared in no list until now. Both queue elsewhere; both can start before a line of code exists.
2. **Rewrite Milestone 0 for C1 and C3** — this is the true engineering first item. Extension loading via `jiti` from a compiled binary is the finding most likely to invalidate Tier A, and every downstream decision waits on the tier. Fold in the cheap questions that are only cheap while the spike is throwaway: the transport decision (S1), whether Pi locks sessions (S2), torn-JSONL behaviour (S3), extension load order against the policy hook (S4), the per-tier command matrix (C4), and whether Pi's telemetry has a public off switch.
3. **C4 is now a half-day `utilityProcess` spike inside Milestone 0**, not a pre-milestone packaging investigation.
4. **Adopt H1** before any of the source-build machinery is written.
5. **C2 drift automation** immediately after Milestone 1's fixtures exist — that is the earliest point at which the job means anything.
6. Decide **H4** and **H5** before Milestone 3; **S4** and **S5** land in Milestones 2 and 1 respectively.

## Sources consulted for this review

- Pi [releases](https://github.com/earendil-works/pi/releases), [SDK documentation](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/docs/sdk.md), and the [`coding-agent` manifest](https://raw.githubusercontent.com/earendil-works/pi/v0.84.3/packages/coding-agent/package.json)
- Bun [1.4 release notes](https://bun.com/blog/bun-v1.4), [single-file executables](https://bun.com/docs/bundler/executables), and [compile-time dynamic-import limits](https://github.com/oven-sh/bun/issues/11732)
- [Electron v44.0.0 release](https://releases.electronjs.org/release/v44.0.0)
- npm `latest` manifests for `typescript`, `react`, `@xterm/xterm`, and `@electron-forge/cli`
