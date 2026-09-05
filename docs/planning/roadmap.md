# Roadmap to Bake Pi v1

This roadmap turns the [product scope](../product/scope.md) into independently
verifiable milestones. It distinguishes code that exists from behavior that has
passed its intended acceptance evidence.

## Roadmap rules

Milestone status uses four terms:

- **Verified** means the exit evidence exists and passes in the repository.
- **Active** means implementation exists, but at least one exit criterion remains
  open.
- **Planned** means the goal is accepted but implementation has not started.
- **Blocked** means progress requires an external decision or a prerequisite that
  the project cannot currently satisfy.

A file, handler, or UI control does not close an exit criterion by existing. The
criterion closes when its named evidence passes. Open evidence remains in the
[coverage gap register](coverage-gaps.md) and links back to its owning milestone.

Effort ranges are planning inputs for one experienced full-time engineer. They do
not include signing-account approval, notarization queues, store review, branding,
or legal review.

## Current position

| Milestone | Status | Current evidence | Primary open work |
| --- | --- | --- | --- |
| 0 — Integration proof | Verified | Real Electron/Pi handshake succeeds; every integration question is measured; the deterministic-provider slice loads an arbitrary-path extension and answers its blocking dialog | None |
| 1 — Enforced boundaries | Active | `bun run verify` exits 0: typecheck, 510 tests, four builds, real smoke and journey | Packaged fuse proof, broader security tests |
| 2 — Agent-host vertical slice | Active | The slice runs end to end under test: open, trust, credential, create, prompt, stream, approve, deny, tool result, abort, close, reopen, model and thinking-level selection, and a second host refused; the Pi event adapter is exhaustive and driven by a fixture for every event Pi emits; a crash mid-tool is reported when the session is opened again; a killed host leaves no descendant on Windows; capacity limits are measured on a real host and enforced | Remaining command gaps, real-provider lane |
| 2.1 — Observable to itself | Verified | `bun run smoke` reports cold start, the handshake and graceful shutdown decomposed into legs; `get_timings` reports turn, tool and command spans with turns attributed per session; main logs its own command legs; the instrument's cost is measured, not claimed | None. The three budgets it cannot reach are named with their reasons (`PERF-003`, `PERF-004`) |
| 3 — Core desktop experience | Active | The workbench is implemented against the contract store — onboarding, native workspace selection, trust, session rail, virtualized timeline, composer, model and thinking controls, attachments, approvals, tools, diffs, diagnostics, recovery notices and four themes on a borderless, elevation-led design system whose contrast is asserted rather than eyeballed; the real Electron smoke fails unless the renderer consumes its event port, validates a real event in the main world and paints the interactive onboarding action, and `bun run journey` drives the primary journey through that renderer from onboarding to a resumed conversation | Accessibility, theme, frame and renderer-memory evidence (`UI-003`, `UI-004`, `UI-005`, `PERF-003`, `PERF-004`) |
| 4 — Session and resource parity | Planned | Contract surface exists | Session tree, resources, extensions, import/export, parity tests |
| 5 — Harden and distribute | Planned | Forge and fuse configuration exists | Makers, signing, packages, updates, platform and security suites |

## Milestone 0: prove the integration

- **Status:** Verified
- **Planning estimate:** 2–3 days for the original spike; remaining questions are
  carried forward until measured.
- **Goal:** Prove that an unmodified published Pi SDK can run inside Electron's
  utility process while preserving extension, session, trust, and credential
  behavior.
- **User-visible outcome:** None. This milestone removes architectural uncertainty
  before product work depends on it.

### Dependencies

- Exact Pi and Electron pins in `bun.lock`.
- A real Electron launch on Windows.
- A deterministic way to report the child-process handshake to the smoke script.

### Deliverables

- A utility-process host using Electron's embedded Node.js.
- A `MessagePort` handshake carrying contract and runtime versions.
- A Pi `ModelRuntime`, trust store, workspace, and session created through public
  SDK APIs.
- Recorded answers for session locking, torn final JSONL entries, telemetry
  control, extension hook ordering, and RPC fallback coverage.

### Exit criteria

- [x] No Pi source modification or `node_modules` patch is required.
- [x] Electron launches the agent host, loads Pi, and completes contract v1
  negotiation.
- [x] Pi project trust and API-key operations are reachable through public APIs.
- [x] A real session can create, stream, persist, reopen, and dispose against a
  deterministic provider fixture.
- [x] An extension loads from an arbitrary TypeScript path and exercises a
  blocking tool hook plus dialog request.
- [x] Session locking behavior is measured: Pi takes no lock, and two writers
  fork the session tree rather than interleaving bytes.
- [x] A session with a torn final JSONL entry has a recorded recovery result.
- [x] Pi telemetry has a verified public disable path.
- [x] Policy-hook ordering is verified against a hostile project extension.
- [x] `runRpcMode` has a command-support matrix for the operations Bake Pi needs.

### Exit evidence

- `bun run smoke` proves the real process topology and handshake, and exits 0.
- `packages/agent-host/src/session/durability.test.ts` holds the locking and
  torn-entry answers as executable assertions rather than prose.
- `packages/agent-host/src/session/telemetry.test.ts` holds the telemetry answer.
- `packages/agent-host/test/vertical-slice.test.ts` is the session lifecycle,
  driven against the HTTP provider fixture in `test/provider-fixture.ts`.
- [RPC mode command support](../reference/pi-rpc-support.md) is the command matrix.
- [Implementation log](../history/implementation-log.md) records the API and
  runtime findings already measured.

One substitution is worth stating plainly, because the criterion named a
different fixture. Session locking was measured with two `SessionManager` writers
in one process, not with the Pi CLI and Bake Pi running side by side. That is
sufficient for the question the criterion asks — the measured answer is that Pi
takes no lock of any kind, so there is no cross-process contention that could
behave differently, and the fork arises from per-manager leaf state rather than
from process boundaries. What a live CLI fixture would add is proof that Bake
Pi's own enforcement works against a real second application, and that is
`INT-001` under Milestone 2 rather than a Milestone 0 measurement.

### Open gaps and deferred work

Every Milestone 0 criterion is now backed by executable evidence. The approval
policy exercises the blocking tool-hook half, while `vertical-slice.test.ts`
loads a TypeScript extension from an explicit absolute path, waits on its
blocking dialog, and proves the answer changes the request Pi sends to the model.
`extension-ui/gate.test.ts` covers the other dialog shapes and cancellation
paths. A failure after the dialog is attributed to the extension without ending
the session.

What the measurements found did not close merely by being known. `INT-001` now
closes through the single-writer guard and real CLI interoperability lane;
`INT-002a` closes through the real Electron journey that reopens a torn session,
keeps its earlier history and renders the recovery notice. `SEC-003` (telemetry
state is not reported and egress is not captured) and `SEC-002a` remain open in
the [coverage gap register](coverage-gaps.md), owned by Milestones 2 and 5.

## Milestone 1: enforce architectural boundaries

- **Status:** Active, substantially implemented
- **Planning estimate:** 4–6 days
- **Goal:** Make renderer isolation, package ownership, contract completeness,
  build formats, and process startup mechanically checkable.
- **User-visible outcome:** The application can start and report connection state,
  but it is not yet a usable coding interface.

### Dependencies

- Milestone 0's utility-process decision.
- Bun workspace and exact dependency pins.
- A runtime-neutral contract package.

### Deliverables

- Contract schemas, envelopes, exact version negotiation, and renderer-safe error
  codes.
- Derived preload capabilities and a complete agent-host handler map.
- Hardened BrowserWindow preferences, private asset protocol, Content Security
  Policy, navigation guards, IPC sender validation, supervision, and restart
  budget.
- Separate main, preload, renderer, and agent-host builds.
- CI for typecheck, tests, build, smoke, provenance, and dependency drift.

### Exit criteria

- [x] Renderer code cannot import Node.js, Electron, or Pi under its TypeScript
  environment and boundary tests.
- [x] Only `packages/agent-host` depends on and imports Pi.
- [x] The contract compiles without DOM or Node ambient types.
- [x] The preload exposes contract commands without raw IPC or a generic invoke.
- [x] The preload refuses to expose the bridge without context isolation and
  sandboxing.
- [x] All four bundles build, including the CommonJS preload assertion.
- [x] The real process topology reaches a Pi handshake.
- [x] The smoke process returns exit code 0 without external termination.
- [x] Packaged binaries prove the configured Electron fuse values (`bun run packaged`, in CI).
- [ ] Runtime sender, navigation, protocol, and Content Security Policy behavior
  have direct tests rather than configuration-only evidence.

### Exit evidence

- `bun run typecheck`
- `bun test` — currently 510 tests across thirty-nine files
- `bun run build`
- `bun run smoke` — exits 0 in 1–2 seconds
- `bun run orphans` — kills a real host over a real tool tree and proves nothing
  survives, alongside the counterfactual that makes that mean something
- `bun run budgets` — weighs a real host and fails if a session, a turn, or the
  empty runtime costs more than `session/budget.ts` declares
- `bun run verify` — chains all of the above and exits 0
- `.github/workflows/ci.yml`

### Open gaps and deferred work

Open items: `SEC-004`, `TYPE-001`, `TST-002`, `TST-003`, `TST-004`, and the
main-process rows in the coverage register. Product workflows remain deferred.

The three `TST-*` rows are new and share a shape worth naming: each is an
enforcement this milestone claims in prose that the mechanism does not actually
reach. Two boundary rules see direct specifiers only, the preload's no-ESM
assertion cannot match minified output, and the preload's command surface is
guaranteed by construction rather than by the set-equality test its comment
cites. None is currently violated, which is exactly why they went unnoticed — a
rule that is not enforced and not broken looks identical to one that is.

## Milestone 2: complete the agent-host vertical slice

- **Status:** Active
- **Planning estimate:** 7–10 days
- **Goal:** Drive one complete workspace-to-tool-result flow through Pi, with
  approval, persistence, recovery, and honest feature reporting.
- **User-visible outcome:** A thin interface can open a workspace, trust it,
  authenticate, create a session, prompt, stream a result, review a tool action,
  abort, and resume.

### Dependencies

- Milestone 1 contract, supervision, and renderer event projection.
- Measured answers from Milestone 0's integration questions.

### Deliverables

- Agent-host adapters for the required vertical-slice commands and Pi events.
- A predictable approval policy on Pi's blocking `tool_call` extension hook. Not
  `agent.beforeToolCall`: that property is Pi's own private mechanism for driving
  extension hooks, and assigning to it would clobber every loaded extension. See
  `packages/agent-host/src/policy/extension.ts`.
- Session mutation serialization and application-level single-writer behavior.
- Host crash recovery, ambiguity handling, session quarantine, and process-tree
  cleanup.
- Real resource discovery and feature flags based on measured support.
- Faux-provider fixtures and a capped real-provider smoke lane.
- Enforced session, event-buffer, and memory budgets based on measurements.

### Exit criteria

- [x] Workspace open, trust, authentication, model selection, session creation,
  prompt, streaming, approval, tool result, abort, close, and resume pass one
  integration test: `packages/agent-host/test/vertical-slice.test.ts`.
- [ ] Every control offered by the thin slice maps to an implemented handler; no
  offered path returns `not_implemented:<command>`.
- [x] Trusted and untrusted approval behavior matches the documented product
  policy, including execution and outside-workspace reads.
- [x] A denied approval prevents the Pi tool call from running.
- [ ] CLI/app concurrent session access cannot silently interleave writes. A
  second Bake Pi host is refused end to end and admitted after the first
  releases; the CLI half is `INT-001` and needs a live-CLI fixture.
- [x] A killed host leaves no descendant tool process in the supported recovery
  cases and never claims stronger guarantees than it provides. Measured on
  Windows by `bun run orphans`, with `processTreeCleanup` reporting false on the
  platforms where it has not been — and where it is known to be weaker.
- [x] Restart after a crash restores safe sessions, quarantines the triggering
  session, and requires confirmation after ambiguous mutation. The tool half no
  longer depends on main seeing anything: the host marks a running tool beside
  the session file, so the interruption is reported when the session is opened
  again rather than read as clean.
- [x] A buffer-cap breach forces a fenced snapshot resynchronization.
- [x] Contract tests cover every Pi event mapped by the adapter.
- [ ] One inexpensive real-provider lane proves actual streaming and tool-call
  chunk behavior.
- [x] Session count, resident memory, and buffered-event limits are measured,
  documented, and enforced. `bun run budgets` weighs a real host; `session/budget.ts`
  declares what it found and refuses on it; the prompt queue is capped alongside
  them because it is the fourth thing a user can grow without bound.

### Exit evidence

The milestone exits through integration and recovery tests, not through handler
presence. Diagnostic feature flags must report unsupported behavior as false.

### Open gaps and deferred work

Open items: `CMD-001`, `CMD-003`, `CMD-004`, `CMD-010`,
`INT-003`–`INT-005`, `REC-001a`, `SEC-002a`,
`SEC-003`, and `EVT-003`.

Most of those are new, from an audit of this milestone's own claims, and two are
worth stating here rather than only in the register. `CMD-008` closed during it:
a key set through `set_api_key` reached no session at all, because the host built
one `ModelRuntime` and every session built its own. Every status reported success
and only the turn failed, which is the shape of defect this milestone's exit
criteria are least able to see — the slice asserted the credential command's
result, not a turn that depended on it. The recovery audit's three follow-ups
also closed: supervisor restores now traverse the same ledger path as renderer
commands, workspace closure removes every owned session from that ledger, and a
failed or half-handshaken restart has a visible, recoverable state.

Two more criteria closed with the event adapter. `EVT-001` was the kind of gap
that cannot be closed by looking: a `switch` with a permissive `default` is
indistinguishable, from the inside, from one that handles everything. It is now a
table keyed by Pi's own `AgentSessionEvent` union — so an event added upstream is
a compile error rather than a silent omission — with a test that drives a fixture
for each entry and asserts the emissions match what the table declares, in both
directions. Twelve previously unmapped events now reach the renderer, and mapping
them found three defects that rendered perfectly: `turn_settled` and every tool
call after the first were addressed by history index, which names the tool result
Pi appends *after* the assistant message; every turn was reported complete,
aborted and failed ones included; and tool output crossed as the JSON of Pi's
result wrapper. `STATE-001` closed alongside it, because usage, session
timestamps and queue identity are what those events carry.

The capacity criterion closed by measuring rather than by choosing. `bun run
budgets` weighs a real host — a real `ModelRuntime`, real sessions, real turns
against the provider fixture — and it found the shape of the problem rather than
confirming an assumption. A session costs a small, roughly constant amount once
Pi's one-time lazy loading is excluded, which is what makes a count a fair way to
divide a budget. A turn is neither small nor constant: the same 16 KB reply
retains several times more across a session's second twenty turns than across its
first, because every turn carries the history before it. Figures are deliberately
not quoted here — the per-session measurement is a difference of two
resident-memory samples and resolves to a few tenths of a megabyte at best, so
`bun run budgets` prints the total behind each mean and the noise beside it, and
that output is the citable form. A session count therefore cannot bound
a host's memory, and that is why there is a ceiling as well as a cap — not as a
second belt, but because the two bound different things.

Three refusals now exist for three error codes that had no producer at all:
`session_limit_reached`, `memory_ceiling_reached`, and `queue_cap_exceeded`. The
last was not named in the criterion and belongs with it: an unbounded prompt queue
is the fourth thing a user can grow without limit, and it is the only one
denominated in money. Nothing evicts. The ceiling refuses new work rather than
reclaiming old, because resident memory does not fall back when a session closes
and because evicting one would drop a conversation, release a lock mid-append and
abandon a running tool; `restart_host` is the honest resolution and reporting the
ceiling is what makes it reachable. Where each check sits is the half with no unit
test, so `vertical-slice.test.ts` holds it: the adoption cap refuses *before* the
lock is taken, and moving it after — which refuses just as correctly — leaves a
session no host can open until the stale-holder check reclaims it, and fails that
test.

The first exit criterion is closed. Model selection was its last row, and
implementing it corrected three things the contract had wrong: four thinking
levels where Pi has seven and clamps between them, a `set_model` that identified
a model by id alone where the same id is offered by several providers, and a
`Model` DTO whose capability flags were hard-coded false. The real Pi CLI half
is now measured by `test/cli-interop.test.ts`: the pinned CLI writes a session,
Bake adopts and continues it, the CLI appends again, and Bake refuses to fork
that history. One thing remains behind the criterion: a real provider
(`INT-003`), because a fixture cannot vouch for another vendor's chunk framing.

## Milestone 2.1: make the application observable to itself

- **Status:** Verified
- **Planning estimate:** 3–5 days
- **Goal:** Give Bake Pi a way to say where time went, so that a slow turn is
  attributed rather than guessed at — and measure every declared performance
  budget that does not depend on an interface that has not been built yet.
- **User-visible outcome:** None directly. A developer can ask a running host
  what it has been spending time on, and three of Milestone 3's six budgets stop
  being assertions and become measurements.

### Why this is its own milestone

Milestone 3 declares six performance budgets and Milestone 2 shipped no
instrument capable of reading any of them. That is not a gap in Milestone 3's
interface work; it is a missing capability underneath it, and discovering a
budget is unmeasurable *after* building the UI that must satisfy it is the
expensive order to find out. Three of the six can be measured today against code
that already exists. The other three cannot, for reasons that have nothing to do
with instrumentation, and naming which is which is half the value of doing this
first.

The scope was cut hard after an adversarial review, and what was cut is recorded
here because the reasoning is the durable part. The original design proposed a
synchronized cross-process clock, a timestamp on every event envelope, and a
host-side store of everything. It was a precise instrument for host-to-renderer
event latency — a number that appears in none of the six budgets. Meanwhile
*none* of the six needs a cross-process clock: cold start and handshake are
durations inside main, shutdown is a duration main observes, first-token overhead
is a comparison a driver script makes between two applications, and the last two
need the interface. A store in the agent host could never report shutdown at all,
because it dies with the process being shut down.

### Dependencies

- Milestone 2's command routing, supervision and session host, which are where
  the measurements are taken.
- `scripts/smoke.ts` and `scripts/orphans.ts`, which already stand up the real
  Electron topology and are the right drivers rather than new ones.

### Deliverables

- Startup timings recorded in main and reported through the existing smoke
  report: application start to `whenReady`, `whenReady` to a loaded window, and
  fork to `hello_ack`.
- Shutdown duration recorded in `smoke.ts`, which exercises the real graceful
  command path before the ordered kill.
- `packages/agent-host/src/observability/timings.ts`: a bounded ring of spans
  with fixed-bucket percentiles, at turn granularity — prompt accepted, first
  delta, turn settled, tool-call duration, command handler duration — with an
  injected clock.
- A `get_timings` contract command returning those spans and their aggregates,
  with span detail constrained to names and numbers.
- Command-latency timestamps on the record `RecoveryLedger` already keeps, so a
  slow command decomposes into main's leg and the host's leg rather than into one
  leg and a residual.
- `scripts/clocks.ts`: whether Electron's three runtimes can be timed against
  each other, recorded at exactly the strength the measurement supports.

### Exit criteria

- [x] Cold start to a loaded window is measured on every `bun run smoke`, against
  a stated definition of what "loaded" currently means.
- [x] Agent-host handshake duration is measured on every `bun run smoke`, and
  decomposed into process launch, the host's own module evaluation, and building
  the Pi runtime — which is what showed that the third of those, the one anyone
  would optimise, is three percent of the cost.
- [x] Graceful shutdown duration is measured, split into the `shutdown`
  command's race and the ordered tree walk. It is measured by `bun run smoke`
  rather than by `bun run orphans` as originally planned: the orphan probe drives
  `terminateHostTree` directly and carries no command channel, so the leg that
  dominates the two-second budget never runs there. `orphans` times its own kill,
  which is the ungraceful half it exists to prove.
- [x] A turn decomposes into prompt-accepted, first delta, and settled, per
  session, readable through `get_timings`. Two sessions driven through real Pi in
  the vertical slice keep their own figures, and each session's aggregate is
  checked against the sum of its own spans in the ring rather than being allowed
  to agree with itself by construction.
- [x] A slow command is attributable to main's leg or the host's leg without a
  debugger. Main times its own leg and the round trip; the host times its whole
  leg, from before envelope validation to after the reply is posted. What is left
  in the residual is stated at the recording site rather than left to be guessed:
  the `MessagePort` hop each way, queueing, main's own settle, and two
  schema-level triage checks — not "transport plus whatever dispatch costs".
- [x] Instrumenting the streaming path does not change what it measures. The
  cost is a measurement rather than a claim: a turn of two hundred block deltas
  costs the instrument seven clock readings in total, asserted against real Pi,
  and noting the first delta is a property read and a comparison. The ring stores
  typed-array columns rather than objects, so recording allocates nothing.
- [x] Span detail cannot carry a path, a tool argument, or any free-form string
  from host internals. Enforced in the types rather than by convention: no public
  method takes a free-form string in a name position, an unrecognised Pi tool
  folds onto `other`, a command whose envelope never validated is measured as
  `unknown` rather than under the arbitrary name it arrived with, and a test walks
  the emitted schema and asserts the only non-literal strings in it are the two
  `SessionId` fields — which are the renderer's own handles, not host internals.
- [x] Every one of Milestone 3's six budgets is either measured here or named as
  unmeasurable with the reason and the milestone that unblocks it — see "Open gaps
  and deferred work" below, and `PERF-003` and `PERF-004` in the coverage
  register.

### Measured so far

| Leg | Measured | Budget |
| --- | --- | --- |
| Process creation to a loaded window | 175–215 ms | 2.5 s |
| Agent-host fork to `hello_ack` | 620–770 ms | 1 s |
| — of which the host's bundle evaluating | 574–697 ms | — |
| — of which building the Pi runtime | 16–21 ms | — |
| Graceful shutdown, total | 340 ms | 2 s |
| — of which the `shutdown` command | 1 ms | — |
| — of which the ordered tree walk and kill | 339 ms | — |

Development machine, warm, no session open. Two things worth carrying forward.
The handshake is already spending three quarters of its budget, and it is not
spending it where anyone would look: building the Pi runtime — resolving Pi,
reading the workspace, constructing every service — is under three percent of it,
and the rest is the host's entry module evaluating its static imports. That
run's cold start was a floor rather than a result because the renderer was still
a connection-state shell. The Milestone 3 smoke now loads the workbench and
requires its interactive onboarding action to paint inside the same budget.

### Exit evidence

The three measurable budgets close through the drivers that already exist —
`smoke`, and `orphans` for the ungraceful kill — rather than through a new
script, because those are the only harnesses that stand up the real process
topology. Which of them owns a budget was decided by where the code under it
actually runs, not by the name of the script: shutdown moved to `smoke` on
discovering that the orphan probe never sends a `shutdown` command at all. `bun run budgets` is
deliberately not the model: it runs the host in-process under Bun with no
Electron, no utility process and no renderer, which is the wrong chassis for a
latency any of these budgets is about.

Budget assertions are **not** wired into CI. Wall-clock latency on a shared
runner varies severalfold, and Milestone 3 states its budgets pass "on the named
minimum machine", which a hosted runner is not. `verify` prints the legs and
asserts only generous sanity ceilings; the budgets are asserted on the named
machine.

### Open gaps and deferred work

Three of the six budgets are out of reach here, and each for a reason that is not
about instrumentation:

- **First-token overhead versus the Pi CLI** now has a real pinned-CLI lane, but
  not a comparable timer. It still needs an agreed observation point on both
  sides — host emission, renderer intake and painted glyph are three different
  numbers. Bake Pi's own host half is delivered here; the CLI subtrahend is not.
- **Dropped frames in a ten-thousand-block session** now has a real-Electron
  instrument under `bun run resources`: it rewrites its own closed temporary Pi
  session into 10,000 text blocks, reopens it through production paths, and
  measures 600 virtualized scroll frames at the display's observed cadence.
- **Idle renderer memory with ten thousand blocks** uses the same run and takes
  the last renderer-process reading only after frame collection has stopped and
  the large session has sat idle for a second.

Both renderer budgets pass repeated runs on the development machine named by
the script. The remaining evidence is a run on the project's named minimum
machine; that hardware baseline still needs to be specified.

Three documentation rows opened against this milestone rather than a future one,
because they misdescribe instruments it delivered: `DOC-003` (the "instants never
cross the process boundary" rule is stated absolutely, and the contract carries
seven of them for display), `DOC-004` (`bun run budgets` is credited with the
prompt-queue cap, which it neither measures nor checks) and `DOC-005` (the
capacity figures are quoted with three different sets of numbers across four
documents). None changes what the instruments do; each changes what a reader
believes they do, which for a milestone whose whole purpose is self-description
is the same kind of defect.

Cross-process timestamps are deliberately not adopted. `scripts/clocks.ts`
records that Electron's three runtimes agree to under a millisecond over a short
undisturbed window, and equally records what that does not license: the agent
host restarts, machines suspend, and wall clocks are stepped, none of which the
measurement covers. Nothing in the codebase subtracts one process's clock from
another's, so the script gates nothing and is run on demand.

## Milestone 3: deliver the core desktop experience

- **Status:** Active
- **Planning estimate:** 8–12 days
- **Goal:** Turn the vertical slice into a usable, accessible desktop coding
  experience without hiding Pi state.
- **User-visible outcome:** A Windows x64 alpha supports the primary coding loop.

### Dependencies

- A verified Milestone 2 flow and stable contract events.
- Measured baseline hardware for performance budgets.
- Milestone 2.1, which supplies the readings for three of the six budgets below
  and names what the remaining three need from this milestone.

### Deliverables

- Onboarding, workspace and session rail, conversation timeline, composer, model
  selector, queue, approvals, tool cards, diffs, errors, and diagnostics.
- Image and file attachments with contract limits.
- Virtualized completed blocks with a mounted active stream.
- Keyboard navigation, screen-reader semantics, focus restoration, selection-safe
  streaming, and reduced-motion behavior.
- Light, dark, high-contrast, and system StyleX themes on a fluid-functionalism
  design system: cool slate, elevation rather than outline, and a motion scale
  that collapses under `prefers-reduced-motion` at the token.
- Contrast asserted as arithmetic across every theme and substrate, which is
  what lets the interface drop its outlines without dropping its boundaries.
- Markdown rendered as React components with raw HTML disabled and links checked.
- Syntax-coloured code and parsed unified diffs, coloured without weakening the
  renderer's Content Security Policy.

### Exit criteria

- [x] A user can open a workspace, decide trust, select a model, prompt, inspect
  tools, approve them, abort, and resume. Driven end to end through the shipped
  interface by `bun run journey`. Installing the alpha is not covered — there is
  no installer yet (`PKG-001`) — and neither is interactive authentication,
  which does not exist (`CMD-003`).
- [ ] Primary flows work using keyboard navigation and named screen-reader
  controls.
- [x] Credentials and privileged APIs never enter renderer state. API keys stay
  in an uncontrolled input and one command argument; native paths come from
  main-owned pickers, and `open_workspace` is absent from the preload surface.
- [x] Model Markdown cannot introduce raw HTML, unsafe URLs, executable SVG, or
  unsanitized external navigation.
- [x] Streaming preserves text selection and stops following when the user moves
  away from the bottom.
- [ ] The declared performance budgets pass on the named minimum machine.

### Performance exit budgets

| Measurement | Target |
| --- | --- |
| Cold start to interactive window | Under 2.5 seconds |
| Agent-host handshake after launch | Under 1 second |
| First-token overhead versus the Pi CLI | Under 150 milliseconds |
| Dropped frames in a 10,000-block session | Under 1%, no frame over 100 milliseconds |
| Idle renderer memory with 10,000 blocks | Under 600 MB |
| Graceful shutdown without supported-case orphans | Under 2 seconds |

### Exit evidence

The full workbench is implemented: onboarding, native workspace selection,
trust, session rail, virtualized timeline, composer, model/thinking controls,
attachments, approvals, tools, diffs, diagnostics, recovery notices and four
themes. Fenced code and tool-result patches are coloured: Shiki tokenizes and
`@pierre/diffs` parses, and each token's colour reaches the DOM through React's
`style` prop, so `style-src` keeps its refusal of `'unsafe-inline'` and a patch
is detected by parsing rather than by guessing at a leading `+`.

The real Electron smoke now fails unless the main-world renderer consumes the
transferred event port and paints the interactive onboarding action; unless a
real event envelope survives the contract's validators in that world and reaches
the DOM, which is the assertion the onboarding text could not make and which
`SEC-009` was found underneath; and unless CSSOM still applies a colour while a
parser-created `style` attribute still does not.

`bun run resources` extends the same real application journey with a valid
10,000-block Pi session. It requires the virtualized tail to render with fewer
than 200 mounted rows, holds a real paragraph selection while another Pi turn
streams and asserts both the selection and viewport remain in place, measures
initial load and 600 scrolling frames with `requestAnimationFrame`, asserts
under one percent dropped and no frame over 100 ms, then checks the idle renderer
process remains under 600 MB. The command prints CPU, memory, platform, and
observed display cadence because these are named-machine budgets and deliberately
do not run in CI.

`bun run journey` then drives the primary journey through that same renderer
against the fixture model — onboarding to a conversation resumed after a reload,
including a tool approved and a turn stopped mid-flight. It finds every control
by the name a screen reader would announce and presses it with a mouse event
Chromium synthesizes, which is what lets it satisfy the real user-gesture check
rather than route around it, and is why it found `REC-007`: a reloaded renderer
was never given another event port.

A manual Windows accessibility pass verified the named landmarks,
skip-link-first tab order, primary action and native directory picker. Hostile
Markdown, unified-diff parsing and a ten-thousand-block projection have direct
tests. The real journey also proves detached following and selection-safe
streaming at that scale. Component accessibility, the minimum-machine renderer
run, and real-provider evidence still gate exit.

### Open gaps and deferred work

`UI-003`, `UI-004` and `UI-005` remain open at proof strength rather
than implementation strength; see the coverage register for the missing runs.
Import/export and complete resource parity remain Milestone 4 work.

## Milestone 4: reach session and resource parity

- **Status:** Planned
- **Planning estimate:** 8–12 days
- **Goal:** Cover the required Pi capabilities beyond the primary prompt loop.
- **User-visible outcome:** Bake Pi and the Pi CLI can move between sessions and
  resources without losing supported behavior.

### Dependencies

- A stable Milestone 3 interaction model.
- Compatibility fixtures for the pinned Pi version and forward version skew.

### Deliverables

- New, open, switch, fork, clone, import, export, tree navigation, labels, and
  compaction.
- Skills, prompt templates, context files, system prompts, extensions, packages,
  reload, enable, disable, and extension dialogs.
- Provider login/logout and supported settings flows.
- Retry, overflow, compaction, usage, context, and cost surfaces.
- Same-version and newer-CLI-written session fixtures.

### Exit criteria

- [ ] Every required row in the product capability table has an automated
  acceptance test.
- [ ] CLI-to-app and app-to-CLI session round trips preserve recognized entries.
- [ ] Forward-skew sessions preserve unknown entries or open read-only with an
  explicit warning.
- [x] Protected project settings and resources load only after trust resolves;
  context files still follow Pi's documented trust-independent behavior.
- [ ] Extension errors and unsupported TUI-only UI produce actionable
  diagnostics.
- [ ] Import/export and tree operations preserve session identity and history.
- [ ] Credential mutation conflicts surface explicitly instead of producing a
  silent logout.

### Exit evidence

Parity closes through a traceable capability-to-test matrix. Contract entries
without implemented behavior do not count as parity.

### Open gaps and deferred work

Integrated terminal, external sharing services, multi-window ownership, and
multi-agent orchestration remain outside v1.

## Milestone 5: harden and distribute v1

- **Status:** Planned
- **Planning estimate:** 10–15 days, excluding external approval queues
- **Goal:** Produce signed, updateable artifacts whose runtime, security, privacy,
  recovery, and provenance claims are backed by clean-machine evidence.
- **User-visible outcome:** A release candidate can install, run, update, roll
  back, and uninstall on every declared target.

### Dependencies

- The selected v1-minimal or v1-full scope gate.
- Signing identities and distribution authorization.
- Green product and compatibility suites.

### Deliverables

- Forge makers and platform-specific build jobs.
- Signing, notarization, checksums, software bill of materials, license notices,
  provenance, and build manifest.
- Update channels with staged rollout and rollback.
- Packaged end-to-end, security, migration, and clean-machine smoke suites.
- Privacy behavior, security-boundary, troubleshooting, and release-runbook docs.

### Exit criteria

- [ ] Every release-blocking suite passes on a clean target machine.
- [ ] No known critical or high-severity security issue remains open.
- [x] Packaged binaries prove the configured fuse and ASAR-integrity state (`bun run packaged`; the integrity check is only meaningful once signed).
- [ ] Updates and rollback preserve sessions and configuration.
- [ ] Diagnostic exports and local crash artifacts pass credential-redaction tests.
- [ ] A full session makes no unexpected outbound connection beyond the selected
  provider and update endpoint.
- [ ] Artifacts report the correct Electron, Pi, contract, commit, platform, and
  architecture versions.
- [ ] Every Milestone 3 performance budget passes on the declared minimum
  specification.
- [ ] The Pi pin is within three published releases and 30 days of upstream, or a
  written exception names the incompatibility.
- [ ] Signed installers pass first launch, persistence, update, rollback,
  uninstall, and filesystem-permission tests.

### Exit evidence

Evidence consists of immutable artifact metadata and platform test reports. A
development build cannot close a packaging or signing criterion.

### Open gaps and deferred work

Forge has Squirrel.Windows, deb and rpm makers and a GitHub publisher;
`.github/workflows/release.yml` builds a draft release from a `v*` tag, and
`src/main/update.ts` reads `update.electronjs.org` from a packaged Windows
build. `bun run packaged` reads the fuse wire back out of the built executable
and starts the package under its own user-data directory, on every push to
`main` and before every release. Signing, a macOS maker, staged rollout and
rollback, and release documentation remain open. Unsigned, the
ASAR-integrity fuse and the updater's trust in the feed rest on GitHub alone.

## Decision gates

| Gate | Decision | Default if unresolved |
| --- | --- | --- |
| Distribution authorization | Whether a redistributed app may initiate Pi OAuth/subscription flows | Ship public v1 with API keys only |
| Integration | ~~Direct SDK versus `runRpcMode` for unsupported operations~~ **Resolved to the default:** RPC mode has no command for approval, trust, credentials, or resources, so the fallback is absent wherever it would be needed. See [RPC mode command support](../reference/pi-rpc-support.md) | Keep direct SDK only where fixtures pass |
| Upstream drift | Whether the Pi pin is close enough for a release candidate | Block unless within three releases and 30 days or excepted in writing |
| Artifact staging | ~~Whether Forge consumes the hoisted workspace safely~~ **Resolved to the default:** the hoisted workspace leaves `apps/desktop` without a `node_modules`, so `forge.config.ts` stages a clean production install of Pi inside the package (`packageAfterCopy`) | Require a clean production stage if package crawling is unreliable |
| Credentials | Upstream credential store versus a later keychain adapter | Preserve upstream storage for v1 |
| Scope | Ship v1-minimal or continue to v1-full | Prefer v1-minimal after Milestone 3 packaging |
| Platform | Add an operating system or architecture | Add only after its complete packaged suite passes |
| Terminal and containment | Reconsider terminal and contained execution | Post-v1 projects, not hidden v1 scope |

## Release definitions

V1-minimal exits Milestones 0 through 3 plus the Windows x64, API-key, packaging,
security, privacy, and update subset of Milestone 5.

V1-full exits all six milestones for every declared platform. A release is not
defined by elapsed time; it is defined by the selected profile's exit evidence.

## Sequenced backlog

1. ~~Close the clean smoke-exit defect so `bun run verify` is a reliable gate.~~
   Done: the watchdog timer is cancelled, and `verify` exits 0.
2. ~~Bind the approval policy to Pi and resolve the documented policy
   mismatch.~~ Done: the policy loads as an inline Pi `tool_call` extension, the
   third rule closes the target-free hole, and hook ordering is measured against
   a hostile extension. The residual is `SEC-002a`, which needs the provider lane.
3. ~~Finish the remaining Milestone 0 measurements: session locking, torn JSONL,
   telemetry, and RPC support.~~ Done, and three of the four found something
   Bake Pi has to defend against rather than rely on: there is no session lock
   and concurrent writers fork the tree silently, a torn entry is discarded
   without a word, and RPC mode cannot carry approval, trust, credentials, or
   resources. Telemetry has a real public opt-out. `INT-001` is now closed by the
   pinned CLI interoperability lane; the remaining residual is `SEC-003`.
4. Complete the Milestone 2 command, event, recovery, and resource slice.
   In progress. Done so far: single-writer enforcement (`INT-001`), session
   discovery and adoption from disk with the torn-entry probe wired ahead of Pi's
   load (`CMD-007`, `INT-002a`), the session-identity defect where one
   `SessionManager` was shared across every session in a workspace, and the
   end-to-end test itself — an HTTP provider fixture plus one file driving open,
   trust, credential, create, prompt, stream, approve, deny, abort, close and
   reopen, which also closes the last investigative Milestone 0 criterion and
   found the auth-status mapping defect; and model and thinking-level selection
   (`CMD-002`), which closes the first exit criterion and corrected the thinking
   union, the `set_model` signature and the hard-coded model capabilities on the
   way; and extension dialog correlation (`CMD-005`), whose arbitrary-path
   fixture closes Milestone 0; and the event adapter (`EVT-001`) with the
   snapshot metadata it feeds (`STATE-001`), which is now a report keyed by Pi's
   own event union with a fixture per entry, and which found that a settled turn
   and every tool call after the first named the wrong message; and backpressure
   recovery (`EVT-002`), which connected three mechanisms that each existed and
   none of which were wired to each other, and found that the renderer had never
   compared sequence numbers at all; and crash recovery (`REC-002`), where the
   supervisor now attributes a crash to whatever the host was working on,
   quarantines that session and restores the rest, and where `restartMode` turned
   out to have been asking main for a fact main cannot have; and the tool half of
   `REC-003`, which is closed by giving up on main seeing it — the host writes a
   marker beside the session file before each tool and removes it after, so the
   evidence survives exactly the crash it describes and is reported by the same
   adoption path a restart already restores sessions through; and the process-tree
   guarantee (`REC-001`), where the measurement contradicted the premise twice —
   a hard kill of main leaves nothing behind, and the leaky case was the ordinary
   supervised kill, whose tree walk ran after the parent had already exited and
   so walked nothing at all; and the capacity limits, where the
   measurement decided the design rather than confirming it: a session's fixed
   cost is small and steady, a turn's is neither — the same reply retains three
   times as much twenty turns later — so a count and a ceiling bound different
   things and neither substitutes for the other, and the prompt queue was capped
   alongside them because it is the fourth unbounded thing and the only one
   denominated in money; and the real pinned Pi CLI interoperability lane, which
   closes session adoption and the foreign-writer counterfactual. Next: the
   remaining `not_implemented` handlers and an executed real-provider run.
5. Build the Milestone 3 interface outward from the verified slice. In progress:
   the full workbench, native pickers, safe Markdown, block virtualization,
   recovery surfaces and themes are implemented; accessibility, full-flow and
   renderer performance evidence remain.
6. Run the scope gate and package v1-minimal unless evidence supports continuing.
7. Add Milestone 4 parity capabilities in dependency order.
8. Complete the selected Milestone 5 artifact and platform matrix.
