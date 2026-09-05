# Implementation log

- **Record status:** Historical evidence from the first working integration
- **Date:** 2026-08-29
- **Current roadmap:** [Roadmap to Bake Pi v1](../planning/roadmap.md)
- **Current structure:** [Project structure](../architecture/project-structure.md)
- **Open evidence:** [Open coverage gaps](../planning/coverage-gaps.md)

This records what implementation established that planning could not: claims the
code confirmed, claims it contradicted, and questions the plan left open that now
have measured answers.

## Verified by running it

`bun run smoke` launches the real application — Electron process, sandboxed
renderer, real preload, forked utility process, Pi loaded — and requires a
handshake before it writes its report. Its output on Windows 11:

```text
smoke ok
  electron 44.0.0  chromium 152.0.7977.54  node 24.18.1
  pi 0.84.4  contract v1
```

That single line settles the plan's central architectural bet. **Pi's SDK runs
inside `utilityProcess` on Electron's embedded Node with nothing extra shipped.**
`ModelRuntime.create()` succeeded, `ProjectTrustStore` constructed, the
`MessagePort` handshake completed, and the hardened preload loaded without
tripping its own isolation assertion.

The baseline table's version claims were accurate in every particular, including
the Node version embedded in Electron 44.

The current smoke process writes this success report but does not terminate
without intervention. The startup evidence remains valid; clean termination is
tracked separately as `TST-001` in the coverage register.

## Contradicted: ESM main cannot await its own readiness

The plan said Electron 44 loads main asynchronously, "so all initialization must
`await` before the `ready` event." **That is backwards, and it deadlocks.**

Measured, with three minimal apps isolating the variable:

| Entry | Pattern | Result |
| --- | --- | --- |
| CommonJS | `app.whenReady().then(…)` | ready fires |
| ESM | `app.whenReady().then(…)` | ready fires |
| ESM | `await app.whenReady()` at top level | **hangs forever** |
| ESM | `await` something unrelated, then `.then(…)` | ready fires |

An ESM main process does not become ready until its entry module finishes
evaluating. A top-level `await app.whenReady()` is therefore circular: the module
waits for `ready`, and `ready` waits for the module. Unrelated top-level awaits
are fine — they resolve, the module completes, and `ready` follows.

The failure mode is the reason this is worth a section. There is no error, no
log line, and no crash: the process starts and hangs. On Windows it is worse
still, because `electron.exe` is a GUI-subsystem binary with no console attached
to the launching shell, so `console.log` diagnostics go nowhere. This cost real
time to find and would have cost far more if discovered after the codebase had
grown around the wrong shape.

`src/main/index.ts` now uses `.then()`, with the reasoning recorded at the call
site.

## Answered: questions Milestone 0 was to investigate

| Question | Answer | Evidence |
| --- | --- | --- |
| Is persisting an API key publicly supported? | **Yes.** `ModelRuntime.setRuntimeApiKey(providerId, apiKey)` is public, alongside `removeRuntimeApiKey`, `listCredentials`, `getProviderAuthStatus`, `login` and `logout`. | `dist/core/model-runtime.d.ts` |
| Does Pi own project trust? | **Yes**, and Bake Pi should not reimplement it. `ProjectTrustStore(agentDir)` with `get`/`set`/`setMany`, plus `resolveProjectTrusted` and `hasTrustRequiringProjectResources`. | `dist/core/trust-manager.d.ts` |
| Can the SDK be driven directly? | **Yes.** `createAgentSessionRuntime` with a services factory drives sessions without `runRpcMode`. The RPC fallback remains available but is not needed for the vertical slice. | `packages/agent-host/src/runtime.ts` typechecks against Pi's own declarations |
| Does Pi lock a session file? | **No.** No lock of any kind; a second writer is never refused. Bytes stay intact, but the tree forks and one writer's turns leave the active branch in silence. | `session/durability.test.ts` |
| What happens to a torn final JSONL entry? | **Discarded silently**, with the fragment terminated by a newline and left in the file permanently. A torn header throws instead and preserves the file. | `session/durability.test.ts` |
| Does telemetry have a public off switch? | **Yes.** `SettingsManager.setEnableInstallTelemetry`, opt-out by default, durable after an awaited `flush()`. | `session/telemetry.test.ts` |
| Can `runRpcMode` cover what the SDK does not? | **No.** 16 of 39 contract commands supported, 4 partial, 19 absent — including approval, trust, credentials, and resources. | [RPC mode command support](../reference/pi-rpc-support.md) |
| Does `@stylexjs/unplugin` ship a Bun export? | **Yes**, but the default export is a pre-configured plugin object, not a factory. Options require the named `createStylexBunPlugin`. | Cost one build failure to discover |

Trust is now written through Pi's own store, so a project trusted in the CLI is
trusted in Bake Pi and the reverse. A separate Bake Pi trust file would have
meant a project prompting in one interface and not the other, with nothing in
either to explain why.

The four questions that were open when this section was first written are
answered above and detailed further down. Only `telemetryOptOut` flipped to true;
`sessionFileLocking` and `rpcFallback` are reported as `false` because that is
what the measurements found, not because they are still unknown. A feature the
renderer believes in and the host cannot deliver is worse than one never
offered.

## Confirmed soft spot: Bun's CommonJS output

The plan flagged Bun's experimental CJS output against Electron's requirement
that a sandboxed preload be CommonJS. The preload builds correctly today —
verified output, real `var __defProp` CJS prelude, no ES module syntax.

`preload.build.ts` asserts this on every build rather than trusting it, because
the failure presents as `Unable to load preload script` with no stack and no
indication of cause. The esbuild fallback stays specified.

## Two design changes the code forced

**The hardening assertion moved from main to the preload.** Electron 44 exposes
no way to read back a window's effective `webPreferences` — `getLastWebPreferences`
is gone. The two flags that matter, `process.contextIsolated` and
`process.sandboxed`, are observable only from inside the process they describe.
So the preload checks them and refuses to install the capability bridge if either
is false. This is strictly better than what was planned: it asserts what the
renderer actually got rather than what main asked for, and it fails closed —
an unisolated preload exposes nothing rather than exposing everything to page
scripts.

**Windows kill-on-job-close is not implemented, and the code says so.** A Job
Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` needs a native addon.
`terminateTree` covers the supervisor-driven case via `taskkill /T /F`, which is
the common one, but it cannot cover a hard kill of the supervisor itself. That
gap is written into `process-group.ts` rather than left for someone to assume
away, and the diagnostics screen must not claim orphan-freedom until the addon
lands.

## The approval policy is bound to Pi, and the smoke test was never hung

Two items from the sequenced backlog, and both turned on a measurement rather
than a design choice.

### The smoke test had already succeeded

`bun run smoke` printed `smoke ok` and then sat for 90 seconds before exiting 0.
It was recorded as a hang, and it blocked `bun run verify` from being a gate.

It was not a hang. It was the watchdog:

```ts
const exited = await Promise.race([
  child.exited,
  Bun.sleep(TIMEOUT_MS).then(() => "timeout" as const),
])
```

`Promise.race` settles on the first result and does not cancel the loser, so the
`Bun.sleep(90_000)` timer stayed pending — and Bun keeps its event loop alive
while a timer is pending. The script finished its work in about two seconds and
then waited out its own timeout. The tell was exact: elapsed time equalled
`TIMEOUT_MS` to the second, and changing the constant moved the delay with it.

The fix is a `setTimeout` whose handle is cleared in a `.finally()`. Three
consecutive runs now exit 0 in one to two seconds, and `verify` exits 0 in three.

Worth recording because two plausible explanations were wrong before the timing
was measured: an unconsumed `stderr` pipe holding the event loop open (tested
against both a short-lived child and the real Electron tree — it does not), and
Electron descendant processes keeping the parent handle alive (they do not).

### The approval hook is an extension, not `agent.beforeToolCall`

The plan named Pi's `beforeToolCall`. Reading Pi 0.84.4, that is the wrong seat.
`AgentSession._installAgentToolHooks` assigns `agent.beforeToolCall` itself, in
order to drive extension `tool_call` handlers, and the property appears in no
`.d.ts`. Assigning to it would either clobber every loaded extension's hook or
compose Bake Pi's security policy with a private implementation detail.

Pi already exposes this capability publicly. A `tool_call` handler may return
`{ block: true, reason }`, and Pi will not run the tool. So the policy loads as
an inline extension through `resourceLoaderOptions.extensionFactories`, and runs
on the same supported path a user's own extension would.

**The load order is the security argument, and it favours this position.** Pi
appends inline extensions after every file-based one (`resource-loader.js`,
`loadFinalExtensionSet`), and `ExtensionRunner.emitToolCall` iterates in that
order, returning on the first handler that blocks. So:

- Bake Pi's handler runs **last**, and Pi performs no re-validation after a
  handler mutates `event.input`. The last handler is therefore the only one that
  sees the arguments the tool will actually run with. A gate that ran first could
  be shown one path and have another executed.
- A project extension that blocks first short-circuits before Bake Pi is asked.
  That direction is safe: the tool did not run. No ordering lets an earlier
  extension skip a Bake Pi denial, because only a block returns early.

`policy/hook-ordering.test.ts` proves this against real Pi services with a
hostile project extension that rewrites a `write` target to `/tmp` and
deliberately does not block. Bake Pi's handler raises `outside_workspace` on the
rewritten path, not the innocent one it was called with. `policyHookOrdering` is
now reported `true`, and that flag is a claim about ordering, not about the hook
existing.

### The policy grew a third rule, because the second had a hole

`requiresApproval` asked before writes and executions outside the workspace. A
tool with no determinable targets produced an empty target list, no escape, and
therefore no prompt — so an extension-contributed tool ran in a trusted workspace
with nothing shown to the user. That was never written down as a decision; it was
just what the code did.

The third rule: a trusted workspace asks before a tool whose targets this host
cannot determine. It rests on a distinction the extractor now makes explicit.
`resolved: false` ("we cannot tell") is not the same value as an empty target
list ("touches nothing we can name").

Two consequences that were previously accidental are now stated in the policy and
covered by tests:

- **A read outside the workspace does not prompt.** Reading is how the agent
  learns about the machine it runs on. Prompting for each one trains the user to
  approve without reading, and that habit then applies to the writes that matter.
- **A shell command in a trusted workspace does not prompt.** Its one honest
  target is the working directory, `execute`, inside the workspace. A shell
  command is deliberately not parsed for the files it might touch — `eval`, a
  variable, a pipeline, a script that writes a script — because it cannot be done
  correctly, and a policy claiming it could would be lying about the one thing the
  card exists to tell the truth about. The card shows the command; the user reads
  it. Rule 1 still covers the untrusted case, which is the one where the user has
  not yet made that call.

The tests were mutation-checked rather than trusted. Removing the third rule
fails two of them; making a denial not block fails nine; treating a stale request
id as accepted fails two; stopping the handler from consulting the gate fails the
ordering proof.

### Two smaller findings

**Relative tool paths must resolve against the session cwd.** `canonicalize`
resolves against the host process's own working directory, which is wherever
Electron started it and never the workspace. A relative `src/a.ts` resolved there
lands outside the workspace, so the policy would prompt on ordinary in-workspace
edits while a real escape looked identical. `extractTargets` absolutizes against
the session cwd first.

**`createAgentSessionServices` discovers the developer's real extensions.**
Measured on one machine: 14 user-level extensions from `~/.pi/agent`, and 7.8
seconds to load them cold through jiti. That is correct for the product — it is
CLI parity — but it made the first version of the ordering test assert one thing
locally and another on CI, with any of those extensions free to register a
`tool_call` handler of its own. The test now points `agentDir` at a temp
directory, so the loaded set is exactly the two extensions it is about, and it
runs in under 500 ms.

## The last four Milestone 0 questions, measured

Milestone 0 kept four questions open because guessing at them would have set the
handshake's feature flags to fiction. All four now have answers, and the pattern
in them is worth naming before the detail: three of the four found behavior Bake
Pi has to defend against, not behavior it can rely on. The one flag that flipped
to true is the telemetry switch.

The answers live in `packages/agent-host/src/session/durability.test.ts` and
`telemetry.test.ts` as executable assertions rather than as prose here, because
every one of them is a claim about a pinned upstream version. When Pi changes any
of it, a failing test says so; a paragraph in a log would not.

### There is no session lock, and the damage is invisible

Pi takes no lock on a session file — not advisory, not mandatory. A second
writer is never refused, and three managers can open the same file at once.

The obvious hazard would be interleaved bytes, and that one does not happen:
appends are whole-line, so every physical line in the file stays valid JSON no
matter how two writers interleave. The actual hazard is quieter and worse. Each
`SessionManager` holds its own in-memory leaf pointer and never re-reads the
file, so two writers append as children of the same parent. The file keeps every
entry. The active branch keeps one writer's. The other writer's conversation is
still on disk and no longer in the session, and nothing — no error, no
diagnostic, no flag — says so.

Bake Pi cannot fix that inside Pi. It has to prevent the second writer, which is
why application-level single-writer behavior is a Milestone 2 deliverable rather
than a nicety.

There is exactly one case where a second writer *is* refused, and it is the one
the host was least ready for. Pi's first flush is an exclusive create,
`openSync(file, "wx")`, so a second manager pointed at an existing file throws a
raw, unwrapped `EEXIST` from inside an `appendMessage` call that looks like
bookkeeping. A user must never see that string.

### A torn entry is discarded silently, and "repair" is narrower than it sounds

Kill the process mid-append and the final line is half-written and unterminated.
On the next open, Pi discards it. History committed before the tear survives
intact, the torn entry is gone, and there is no thrown error and no flag to
inspect.

The repair is a single newline appended to terminate the fragment, so the next
entry cannot be concatenated onto it. The fragment itself stays in the file
permanently, as an unparseable line that every future load skips in silence.
That has a direct consequence for any integrity check Bake Pi might write: "does
this file contain only valid JSON lines" would report a fault on every session
ever killed mid-append, forever. The condition that identifies a *fresh* tear is
the file not ending in a newline, and it is true exactly once, because the first
load clears it. Detection therefore has to happen before Pi is allowed to open
the file.

A torn *header* takes the opposite path, and the safer one: it throws
`not a valid pi session` and leaves the file byte-identical, so a damaged session
is never mistaken for a fresh one and overwritten.

One incidental finding fell out of building these fixtures and is now a test of
its own, because it surprised: **Pi writes no session file at all until an
assistant message exists.** A session holding only user messages has no file, and
the whole backlog flushes at once when the first assistant message lands. Any
Bake Pi behavior keyed on the file existing — a rail entry, a resume list, a
lock, an mtime comparison — has to treat "no file yet" as an ordinary state.

### Telemetry has a real off switch, and that is only half of `SEC-003`

`SettingsManager.setEnableInstallTelemetry(false)` is public, persists to
`<agentDir>/settings.json`, survives a restart, and toggles both ways. The
default is on, so this is an opt-out rather than an opt-in — which is precisely
why the renderer needs to be told the control exists. `telemetryOptOut` now
reports true.

Two details shape what that flag may honestly claim. First, what Pi calls install
telemetry is two different things: a fresh-install ping to `pi.dev` sent from
interactive mode, which Bake Pi never runs and which is additionally gated by
`PI_OFFLINE`; and provider attribution headers added to requests the user already
chose to make to their own provider. There is no separate endpoint and no
separate payload in the second case. Second, the setter queues its write and
returns; `flush()` is the public durability boundary. A settings screen cannot
report "saved" from the setter returning — it has to await the flush and surface
anything `drainErrors()` collected.

So the flag says the switch is public. It does not say telemetry is off, and it
does not say egress was verified. That half of `SEC-003` is Milestone 5 work and
stays open.

### RPC mode cannot be the fallback, because it lacks exactly what a fallback is for

The Integration decision gate asked whether `runRpcMode` could drive operations
the SDK does not support. Reading the pinned Pi's `docs/rpc.md` in full and
mapping all 39 contract commands against it gives 16 supported, 4 partial, and 19
absent — recorded in [RPC mode command support](../reference/pi-rpc-support.md).

The distribution is what decides the gate. RPC covers the prompt loop
completely, and the prompt loop is what the SDK already exposes cleanly. Every
capability that would motivate reaching for a fallback is absent: no command for
tool approval, none for project trust, none for credentials or login, none for
resource enable/disable, no session enumeration, no working-directory argument,
and no clean shutdown. The fallback is unavailable precisely where it would be
needed.

Tool approval deserves the specific version, because at a glance RPC looks like
it might carry it — the documentation's own dialog example is titled "Allow
dangerous command?". That example is an extension raising a `select` through the
Extension UI Protocol, not a host command. `tool_execution_start` is emitted
when a tool *begins*, after the decision is made. So approval can travel over
RPC only if the policy itself moves inside Pi as an extension, losing sight of
the trust store and workspace the host owns — and inheriting the sub-protocol's
timeout, which auto-resolves with `undefined` when the client does not answer in
time. For a confirmation prompt that is reasonable. For an approval gate it is a
fail-open, which is the exact hazard `ApprovalGate` avoids by parking
indefinitely under an abort signal and never catching its way into an allow.

The gate resolves to its default: keep the direct SDK. `rpcFallback` stays
`false`, now with a document behind it rather than an unexamined default.

## Refusing to be the second writer

The measurements above said Pi takes no session lock and that two writers fork
the tree in silence. This is what Bake Pi does about it, and the shape of the
answer is set by one fact that cannot be engineered around: **the Pi CLI will
never consult a lock Bake Pi invents.** Any design that pretends otherwise is
describing a guarantee it does not have.

So the enforcement is two mechanisms with two different strengths, and they are
deliberately not presented as one.

**A lock file, which is a real guarantee between Bake Pi hosts.**
`<session>.jsonl.lock` is created with `openSync(path, "wx")` — an exclusive
create, so taking it is atomic rather than a check followed by a write — and
holds the pid, a per-process host id, and a timestamp. A second Bake Pi host is
refused with `session_busy`. A lock whose holder is provably dead is stolen, and
the theft is reported rather than swallowed: a host that died holding a session
is precisely the input `REC-002` and `REC-003` need, and that fact is knowable
only at that moment.

Three details in it are load-bearing, and each is a test:

- **Liveness treats `EPERM` as alive.** `process.kill(pid, 0)` throws `EPERM`
  when the process exists and belongs to another user. Reading that as "dead"
  would steal a lock from a running host, which is the one thing the lock exists
  to prevent.
- **Release checks who holds the lock.** Host A hangs, its stale lock is stolen
  by B, and A then finishes shutting down. A naive `unlink` deletes B's lock and
  leaves the session owned by nobody while B still believes it owns it.
- **An unreadable lock is treated as abandoned, not as held.** Refusing forever
  on a corrupt lock file would leave a user with a session they cannot open and
  no way to say why.

**A fingerprint, which is detection and not prevention.** Before every mutating
command — prompt, steer, follow-up — the host re-reads the session file's size
and last entry id and compares them with what it recorded when its own last turn
settled. If the file moved, someone else wrote, and appending now is exactly what
orphans a branch; the command is refused as `session_busy` instead. Refusing is
the whole point: re-reading and continuing is *how* the fork happens, so the
guard must not resolve itself, and a test asserts the refusal stands across
repeated attempts.

The window is one turn wide, not zero, and the code says so in as many words.
Between the check and Pi's append another writer can still land. Nothing closes
that against a program that takes no lock, and claiming otherwise would be worse
than the gap — so what is claimed is what was built: a foreign write is refused
rather than silently absorbed.

Both halves were mutation-tested. Disabling the guard, letting it re-record
instead of refusing, dropping the size comparison, skipping the re-record after a
settled turn, releasing a lock we no longer hold, and treating an unreadable lock
as live each fail the suite.

### The probe that has nowhere to run yet

Detecting a torn entry has a hard constraint: it must happen *before*
`SessionManager.open`, because Pi's load terminates the fragment and from then on
a fresh tear is indistinguishable from an old scar. `session/integrity.ts` does
that, and separates the two — a scar is history and must not be reported as a
fault on every open for the rest of a session's life, while a fresh tear is
information that exists exactly once.

It is not wired to anything, and that is deliberate rather than an oversight.
Bake Pi only ever *creates* sessions: `open_workspace` calls
`SessionManager.create`, `open_session` re-attaches a session already in memory,
and `list_sessions` enumerates that same map. Nothing in the application ever
adopts a session file it did not just write, so there is no file that could be
torn. Wiring the probe into the create path would put it after Pi has already
opened the file — the exact mistake it exists to prevent — in exchange for
detecting nothing.

That absence is now recorded as `CMD-007` rather than left implicit. It is the
larger finding of this piece of work: Bake Pi cannot open an existing session at
all, which means it cannot yet resume its own sessions across a restart, and the
CLI interoperability the project treats as a headline property has no code path.

## Opening a session that already exists

The write guard's larger finding was that Bake Pi could not open a session it had
not just created. That is now implemented, and building it turned up a defect
worse than the missing feature.

### One SessionManager is one session, permanently

`open_workspace` created a single `SessionManager` per workspace and
`startSession` handed it to every session it built. A `SessionManager` is not a
directory or a factory: it *is* one session, with one id and one file, fixed for
its lifetime. Two `create_session` calls in a workspace therefore produced two
`SessionHost`s over the same session id and the same file — and `sessions.set`
is keyed by that id, so the second silently replaced the first in the map. The
first host stayed subscribed to Pi, kept emitting, and could no longer be reached
by any command.

Nothing failed. The measurement that exposed it is a two-line probe: ask one
manager for its id twice and it is stable, ask two managers and they differ. The
fix is to create a manager per session and keep only the session *directory* on
the workspace, which is what the workspace actually owns.

This is the same hazard as `INT-001` — two writers on one session file — arriving
from inside a single host rather than from another process, and the lock would
not have caught it: both hosts would have asked for the same lock, and the second
`SessionLock.acquire` would have refused a session the application had every
right to open.

### Listing must not be built on `open`

Discovery goes through `SessionManager.list(cwd, sessionDir)`, which is public
and returns id, path, cwd, name, timestamps, message count, and the opening
message.

The reason it is `list` and not a loop over `open` is a measured property, and it
is now a test: **`list` does not modify the files it reads.** A torn session file
is byte-identical afterwards, still missing its trailing newline. `open`, by
contrast, repairs a torn file as a side effect — so a session rail built on
`open` would silently destroy the tear evidence for every unfinished write in a
workspace merely by *showing the user a list*. Pi's cheap read path and its
mutating read path look equally innocuous from the type signature, and the
difference decides whether the integrity probe can ever fire.

A torn session still appears in the listing rather than vanishing from it, which
is what makes it recoverable at all.

### The order in adoption is the whole design

`adoptSession` does three things and they cannot be reordered:

1. **Probe the file.** After step 3 the question cannot be asked: Pi's load
   discards the torn entry and terminates the fragment, and a fresh tear becomes
   indistinguishable from an old scar.
2. **Take the lock**, so no second host adopts the same file behind us.
3. **Let Pi open it.**

A torn session is adopted rather than refused — the history before the tear is
intact, and withholding it helps nobody — but the loss is reported as a
`recoverable_error` carrying `session_file_repaired` instead of passing in
silence. A session whose *header* is unreadable is refused before Pi sees it, so
the failure is a contract error naming a path rather than an exception thrown
from inside the SDK, and the file is left untouched for anyone who wants to
recover it by hand.

`list_sessions` now reads disk as the authority and merges live hosts over the
top: disk wins on identity, because it knows the name and the path, and the live
host wins on progress, because only it knows how far the conversation has got
since the listing was taken. A session with no assistant message is not on disk
at all, and exists only in that merge.

### What is not proven

`adoptSession` has no test. Driving it needs a real `ModelRuntime` and agent
directory — the whole `createPiRuntime` — which is the Milestone 2 integration
test rather than a unit. Every piece it composes is tested: the probe against
files Pi produced, the lock and its stale-holder handling, the mapping against
the contract's own validator, and the non-mutating property of `list`. The
composition is not. That is recorded on `CMD-007` rather than implied by the code
existing.

## Driving the whole slice against a model that always answers the same way

Every piece of the agent host was unit-tested and none of them had been run
together. That distinction stopped being academic the moment the composition ran:
it found a defect in code that had been reviewed, typechecked and shipped, and no
unit test of that code could ever have caught it.

### The fixture is a server, not a stub

Determinism could have been bought by stubbing Pi's stream layer. It was bought
by writing an OpenAI-compatible HTTP endpoint instead, registered through a
`models.json` in a throwaway `PI_CODING_AGENT_DIR` and reached over a real
socket.

The difference is what stays real. Pi's own request construction, SSE parsing,
partial-JSON accumulation for tool-call arguments, stop-reason handling, retry
policy and session writes are all exercised; the only thing scripted is what a
language model would have decided. A stub of Pi's stream layer would have proved
that Bake Pi agrees with the test author about Pi, which is not a fact about the
software.

Two details of the fixture are load-bearing:

- **An unscripted request is answered with a 500, never with a polite "done".**
  A request the script did not anticipate means the agent did something the test
  never described. Answering it agreeably hides exactly that.
- **Tool-call arguments are split across two deltas.** A provider that sent them
  whole would never exercise the accumulation path, which is where a real
  provider's framing differs most.

`PI_CODING_AGENT_DIR` is what makes any of this safe to run: models, settings,
credentials, project trust and sessions all resolve under a temp directory, so a
test run neither reads nor writes the developer's own `~/.pi`.

### Three tests passed for the wrong reason first

The first version of the recorder matched waits by event name against the whole
backlog. Several sessions run in one file and they emit the same names, so a wait
for `turn_settled` resolved against a previous test's turn and the assertions
after it ran against a session that had not moved. Everything was green.

Waits are now scoped to a session *and* to a position in the stream, taken before
the command that should cause the event. That is the difference between "this
event happened at some point" and "this command caused this event", and only the
second is worth asserting.

The recorder also runs every envelope through the contract's own `acceptEvent`
before recording it — all of them, not a chosen few. An event the host can emit
but the contract cannot validate is an event the renderer silently drops, and a
test that read payloads directly would never see it. It caught a malformed
`approval_resolved` on the first run.

### What it found: every provider was `unknown`

`toAuthStatus` mapped Pi's provider auth status onto the contract's by switching
on string literals — `"authenticated"`, `"oauth"`, `"api_key"`, `"expired"`.
`ModelRuntime.getProviderAuthStatus` returns none of those. It returns a record:
`{ configured, source?, label? }`. So the switch matched nothing, the default arm
ran every time, and `list_providers`, `get_auth_status`, `logout` and
`set_api_key` all reported `unknown` for every provider, unconditionally.

Nothing was going to catch this. A unit test of `runtime.ts` cannot build a real
`ModelRuntime`, and the value has the right *type* — `unknown` is a legitimate
member of the contract's union, so neither the compiler nor the contract's own
validator had anything to object to. It would have been found by a person
building the login UI and wondering why every provider looked the same.

The mapping is now on the record's shape, and `expired` is deliberately
unreachable: Pi reports what is configured, not whether it still works, and the
only honest report of a stale token is the failure of the request that used it.

### The three orderings this test exists to protect

Each of these is correct in the code and has no unit that could detect it being
wrong, because each is a fact about sequence rather than about a function:

1. **The integrity probe runs before `SessionManager.open`.** Pi's load repairs a
   torn file, so after it the question cannot be asked. Moving the probe one
   step later leaves a session that opens cleanly and reports nothing — the test
   tears a real session file between close and reopen, and that move fails it.
2. **The approval gate blocks rather than announcing.** A gate that emitted
   "denied" and returned `undefined` produces a UI that says denied over a tool
   that ran. The test asserts the file does not exist and that the call comes
   back failed.
3. **The lock is released on dispose.** A lock outliving its host makes the
   session unopenable until the stale-holder check reclaims it, which looks like
   data loss to the person reading the session rail. The test builds a second
   `createPiRuntime` over the same agent directory, is refused `session_busy`,
   and is admitted only after the first host closes.

Seven mutations were applied to the code beneath this file — the two gate
failures above, the probe reordering, the unreleased lock, a `list_sessions` that
reads only live hosts, repeating sequence numbers, and an approval card with its
targets stripped. All seven fail the suite.

### What it did not prove

Three things, and they are the useful part of the result.

`set_model` was still `not_implemented` when this ran, so model *selection* was
the one item of the Milestone 2 exit criterion the test did not cover; the model
came from a settings default instead. Closed since — see *Choosing a model*
below.

A fixture cannot vouch for another vendor's chunk framing. `INT-003` still wants
one capped real-provider lane, and `SEC-002a` reduces to exactly that.

The second writer that matters is the Pi CLI, which does not consult Bake Pi's
lock and never will. What is proven is that a second *Bake Pi* host is refused;
`INT-001` still wants a live CLI fixture, and `CMD-007` still wants a session
file the CLI wrote.

## Choosing a model, and what the contract had wrong about it

`set_model` and `set_thinking_level` were the last two `not_implemented`
handlers inside Milestone 2's first exit criterion. Implementing them against a
real `AgentSession` contradicted three things the contract had assumed.

### Pi has seven thinking levels, and clamps between them

The contract declared four — `off`, `low`, `medium`, `high`. Pi's are
`off | minimal | low | medium | high | xhigh | max`, and the two extra middles
are not decorative: `AgentSession.setThinkingLevel` **clamps** a request to the
levels the selected model supports and then reports the clamped value from
`thinkingLevel`. A model with no `thinkingLevelMap` supports the first five; a
model with `reasoning: false` supports `off` alone.

So the narrow union was not a narrower product, it was a snapshot that could
describe a session as thinking at a level nothing was running at. The old code
made that concrete with an unchecked cast:

```ts
thinkingLevel: (session.thinkingLevel ?? "off") as SessionSnapshot["model"]["thinkingLevel"]
```

The union is now Pi's, and the cast is gone. The command result is read back
from the session rather than echoing the request, so asking for `max` on a model
that stops at `high` returns `high` — the control reports what happened, not what
was asked.

### A model id does not identify a model

`set_model` took `{ sessionId, modelId }`, and `ModelRuntime.getModel` takes
`(providerId, modelId)` for a reason: a gateway, a proxy and the vendor all list
`claude-sonnet-4`. Resolving by id alone would have picked whichever the catalog
enumerated first — a different endpoint, a different credential, a different
bill, and no way for the user to see which. `providerId` is now required on the
command and present in `ModelSelection`, which the `Model` DTO already carried
for every model the renderer can offer.

### One switch, two events, or none

Pi emits **no** session event for a model change — `setModel` notifies extensions
through `model_select` and nothing else — so the command has to announce it. But
`setModel` also applies a thinking level for the new model, and *that* emits
`thinking_level_changed`, which the subscription already maps to `model_changed`.
Emitted naively, one switch produces two events; a thinking level clamped onto
the value already in force produces one event for no change.

`SessionHost.emitModelChanged` reconciles both by comparing against the last
selection it announced. The three cases now hold: a model switch emits once, a
real level change emits once, and a clamped no-op emits nothing.

### The mutation nobody would have looked for

`setModel` and `setThinkingLevel` both append to the session file
(`model_change`, `thinking_level_change`). That makes them mutating commands, so
they go behind the same write guard as a prompt — and, less obviously, they have
to re-record the fingerprint afterwards. Only `agent_settled` did that, and no
turn settles around a model switch. Without the re-record the next prompt reads
the file it moved itself and refuses as `session_busy`: our own write locking us
out of our own session. Removing the `recordWrites` call fails the suite.

Also corrected while the selector was being fed: the `Model` DTO reported
`supportsThinking: false`, `supportsVision: false` and no context window for
every model, hard-coded. They come from Pi's catalog entry now. A selector built
on the literals would have hidden the thinking control on exactly the models that
have one.

## Extension dialogs cross the boundary

Pi creates SDK sessions with print-mode's inert UI. `AgentSession.bindExtensions`
is the public seam that replaces it, and Bake Pi now binds one
`ExtensionUIContext` per session. `ExtensionUiGate` parks select, confirm, input,
and editor promises; emits the contract request; and accepts only a response with
the same id and kind. Abort, timeout, session close, and host shutdown settle the
safe value, while stale, repeated, wrong-kind, and unoffered responses settle
nothing.

One tempting field in the contract was not real: Pi gives every extension the
same UI context and does not say which extension called it. `extensionName` is
therefore optional on a dialog request. The extension error listener does carry
the path, so a hook that throws after its dialog is still named accurately and
does not turn into a generic session failure.

The composition proof is an actual TypeScript file at an arbitrary absolute
path, named in the throwaway Pi settings and loaded through Pi's resource loader
and jiti. It asks a blocking dialog during `before_agent_start`; the provider is
not contacted until the response command arrives; and the extension's use of
that answer is visible in the request on the wire. Together with the already
measured approval hook, that closes the last Milestone 0 criterion.

## Every event Pi emits, and the three defects that found

`EVT-001` said the event projection was partial. What made it hard to close is
that a partial projection is invisible from the inside: the adapter was a
`switch` over Pi's event union with a `default: break`, and a `default` that
ignores is indistinguishable from one that has nothing left to ignore. Nothing
fails. The interface simply stops describing part of what the agent did.

So the closure is not "more cases". It is `mapping/coverage.ts`, a table typed
as `Record<AgentSessionEvent["type"], PiEventCoverage>`. Because the key type is
Pi's own union, an event added upstream is a **compile error in one place**, and
the error names the decision that has to be made: map it, or record why not. Each
entry declares the contract events it produces — empty, with a reason, for the
ones that deliberately produce none.

`mapping/coverage.test.ts` is what keeps the table from becoming prose. It drives
a real `SessionHost` with at least one fixture per entry and compares emissions
to declarations **in both directions**: a mapping the table forgot fails, and so
does a table entry promising an event the adapter never emits. The fixture record
is itself keyed by Pi's union, so a new event cannot be mapped without being
driven, and cannot be dismissed without someone writing the case that shows it
emits nothing.

Twelve events that used to fall through now reach the renderer. The interesting
ones:

- **`message_end`** re-emits every text and reasoning block of the finished
  message. It repairs a dropped delta, and it is the only place `redacted` can be
  honest: the stream's `thinking_*` events do not carry the flag, only the
  completed message does.
- **`tool_execution_update`** carries a running tool's output. Pi reports it as a
  cumulative snapshot rather than a delta, so `ToolCall` gained an optional
  `partialOutput` that replaces rather than appends — the tail is kept when it
  overflows, because the newest output is what someone watching a command is
  watching for.
- **The summarization-retry trio** restores the status it interrupted instead of
  assuming idle. Those retries fire under compaction *and* under branch
  summarization, and only the first of those was compacting.
- **`compaction_end`** counts the messages compaction removed by measuring across
  the operation. Pi's `CompactionResult` reports tokens and a kept-entry id, and
  no count.

The ones that stay unmapped say why, which is the half a table like this is
actually for. `agent_end` is silent because it means the loop stopped emitting,
not that the session is idle — a retry can follow it, and `agent_settled` is the
event that means what `agent_end` looks like it means. `bash_execution_update`
belongs to `executeBash`, the CLI's bang-command path, which Bake Pi never calls.
Partial tool-call JSON emits nothing because a half-parsed tool call is not
something the renderer should hold; the complete call arrives through
`tool_call_started`, which Pi emits for every call — including one about to be
denied — and which carries resolved targets and a real status.

### Three defects that rendered perfectly

Writing the fixtures found bugs that no amount of reading would have.

**A settled turn named the wrong message.** `turn_settled` and `tool_call_started`
computed their message id from `session.messages.length - 1`. That is correct
exactly until a tool runs: Pi appends each tool result *after* the assistant
message, so at `turn_end` — and at every tool call after the first — the last
entry in history is a tool result. The turn was settling a tool result's id, and
each tool card after the first hung off the previous call's result. Both ids were
real, so nothing threw and nothing looked wrong. The host now tracks the assistant
message it last saw finish, which is the only thing that can answer the question.

**Every turn reported `complete`.** The status was a literal. An aborted turn and
a provider failure both arrived as successes. It is read from the message's
`stopReason` now, through the same mapper history already used.

**Tool output crossed as JSON of the wrapper.** Pi's tools return
`{ content, details }`, and the adapter stringified the object, so every tool card
would have shown `{"content":[{"type":"text","text":"..."}]}`. The text extraction
history already used is now shared by both paths.

### Metadata stops being placeholders

`STATE-001` closed alongside, because the events above are what carries it.

Usage comes from `AgentSession.getSessionStats`, which sums the *persisted*
entries rather than this host's turns — so a reopened session reports the whole
history's cost rather than starting from zero. `usage_changed` announces it per
turn, deduplicated against the last figure. A context window Pi cannot know is
omitted rather than sent as zero: Pi reports `tokens: null` right after
compaction, and a meter reading empty is a claim while a missing meter is not.

Session timestamps come from the session file's own `birthtimeMs` and `mtimeMs`,
falling back to this host's clock only while Pi has written no file — which is an
ordinary state, since Pi writes nothing until an assistant message exists. A
reopened session used to report "created now" and sort to the top of the rail
every time it was opened.

Queue entries keep the id and arrival time they were first given. Both were
minted from the entry's position on every read, which reset every prompt's wait
on each snapshot and, when the head was delivered, shifted every remaining id
down onto its neighbour's — so a renderer keyed on them would have animated the
wrong row.

Also corrected on the way: a tool call in projected history reported `succeeded`
unconditionally. The outcome is not in the assistant message; it is in the tool
result that follows. `projectMessages` pairs them now, and a call with no result
yet reports `running`, which is what a snapshot taken mid-batch is looking at.

Remembering the assistant message brought one obligation with it: the id has to
be forgotten on `resync`. Compaction does not merely shorten history, it
renumbers it, so a remembered id afterwards names a different message — and
because it still names a real one, the failure would again be silent. `resync`
clears it and falls back to current history.

Eight mutations of the code beneath this were applied — addressing the turn by
index, dropping the block finalization, stringifying tool output whole, returning
to idle after a summarization retry, zeroing the cost, reporting idle after an
overflow compaction, re-minting queue ids from position, and keeping the
remembered message id across a resync. All eight fail the suite.

## Three mechanisms that had never been introduced to each other

`EVT-002` looked like the smallest remaining Milestone 2 item, because every
piece of it was already written. `stream_gap` was a contract event with a
reducer case and a test. `EventStream.onGap` was a registration point with a
documented purpose. The renderer held a byte-capped buffer with a comment
explaining why breaching the cap discards rather than grows.

None of them were connected to anything. No code emitted `stream_gap`. Nothing
ever registered an `onGap` handler. The buffer had no caller at all — `hold()`
was unreachable from the first line of the class, so the byte cap it enforced
could never be reached either. And underneath all three, `#receive` never
compared sequence numbers: it recorded each arrival as the new high-water mark
and dispatched it. A host that dropped an event produced a projection quietly
missing a message, and the renderer's own documented rule — mark the projection
incomplete on a detected gap — described a comparison that was not in the file.

This is the failure mode the gap register exists for, and it is worth naming
because reading the code is what produces it. Every individual piece reads as
finished. Only asking "what calls this?" reveals that the answer is nothing.

### Two gaps, from opposite directions

They need different repairs, because only one of them is visible to the side
that caused it.

The host's own gap is the buffer between process start and the renderer's port
arriving — a real window, since a restored session can be answering a prompt
before a window exists. Past the cap it discards, and it now records which
sessions the discard cost, announces `stream_gap` for each on attach, and lets
the runtime turn that into `resync("gap")`. Ordering is load-bearing in both
directions: the announcement goes out *after* the flush, or the snapshot would
land behind events that predate it and the fence would discard the newer state;
and `stream_gap` goes out *before* the snapshot, so the jump in history arrives
with its explanation rather than after it.

The renderer's gap is the one nothing on the host can see. An event that fails
its schema check on arrival is dropped there, and from the host's side it was
delivered — it consumed a sequence number and returned. The only evidence that
survives is a number that never shows up, which is why the comparison in
`#receive` is the entire detection mechanism, and why the new `resync_session`
command exists: the renderer is the only party that can report this, so it has
to be able to ask. It asks once per gap rather than once per event that follows
one, because a stream holed mid-turn would otherwise send a command per delta
until the answer arrived.

`resync_session` answers with nothing, deliberately. The snapshot travels as an
event because only the event carries the sequence it was taken at, and a
snapshot returned through the command channel would arrive without a fence — its
recipient could not tell which concurrently delivered events it already
contained.

### The test that is the criterion

The exit criterion is "projection after overflow equals authoritative host
state", and neither half's unit test says anything about that. `emitter.test.ts`
proves the host announces; `stream.test.ts` proves the renderer notices. Both
would pass with the two sides disagreeing about what a session is.

So `test/backpressure.test.ts` wires a real `SessionHost` to the real renderer
`EventStream` and reducer through a real `MessagePort`, overflows the buffer
until a discard actually happens, and compares the resulting projection against
`host.snapshot()` — the host's own answer, not an expectation written by hand,
which would pass just as happily if both sides were wrong together. It is the
only test in the repository that stands on both sides of the process boundary,
which the boundary suite permits precisely because it excludes test files.

### Two more defects that rendered perfectly

**Every assistant message was dated to the moment it was projected.**
`projectMessage` read `Date.now()` for the assistant case while reading
`message.timestamp` for user and tool-result messages — and Pi's
`AssistantMessage` has carried a `timestamp` all along. So a reopened session
claimed the model had answered just now, and every snapshot silently moved
history forward. It surfaced only because the round-trip test compares two
projections of the same session and they disagreed by twenty milliseconds.

**A baseline built from a post-gap snapshot forgot it was incomplete.**
`initialState` hard-coded `gap: false` while the reducer's own snapshot case
reads `snapshot.afterGap`. The store happens to route through both, so it
escaped; anything building a projection from a snapshot directly would have
shown a repaired session as a whole one. It reads `afterGap` now, and the two
paths agree.

Eight mutations were applied and all eight fail the suite: the emitter not
recording which sessions lost events, announcing before flushing, the renderer
not comparing sequence numbers, reporting a gap per following event, re-dating
assistant messages, `initialState` ignoring `afterGap`, the runtime reporting a
gap without repairing it, and `resync_session` accepting a request and doing
nothing.

## The supervisor could not answer the question it was asking

`REC-002` says one session must not be able to exhaust recovery for all of them,
and the shape of that failure is worth stating because it is not obvious. A host
that dies deterministically on one session, restarted faithfully with the same
sessions reopened, dies again on the same session. Three restarts later the
budget is spent and there is no route left to open a different one. The
application is unusable because of one file.

Nothing in main was positioned to prevent that. It reopened nothing after a
crash — sessions were simply gone — and attributed nothing. And `restartMode`,
the function that decided whether restarting was safe at all, had no caller and
could not have had one: it asked for `toolInFlight`, and main has no way to know
whether a tool was running. Tools start and finish as events on the port main
deliberately does not read.

That constraint is the interesting part of this change, because it is not
incidental. Main hands the event `MessagePort` to the host and the renderer and
keeps neither end, which is what stops a streamed token from relaying through the
supervisor. A supervisor that read the stream to know what the host was doing
would give that up. So `RecoveryLedger` is built from the only evidence main has
without reading events: commands going out, answers coming back.

That turns out to be enough for attribution. A command in flight when the process
died names the session the host was working on, and that session is not reopened.
It is a heuristic and it can be wrong — an unrelated crash during a prompt
quarantines a session that did nothing — and the asymmetry is what makes it the
right one. Being wrong that way costs one session a person can reopen by hand,
which lifts the quarantine. Being wrong the other way costs the application.

Everything else is restored by re-issuing `open_session`, rather than by anything
that reconstructs state: each session comes back through the same lock, the same
torn-entry probe and the same snapshot a person's own open would produce.

### Two orderings that are load-bearing

`AgentHost` now calls `onExit` *before* failing its pending commands. The pending
map is the evidence the attribution reads, and `#failAllPending` is what erases
it; the previous order left every crash unattributable. It was correct by
accident before this change only because nothing read the record at all.

And the supervisor cannot deliver its own verdict. A quarantine is main's
decision and the renderer needs to hear it, but main holds no end of the event
port — so the decision travels in the handshake and the restarted host announces
`session_disconnected` for each. Without that the renderer keeps a card with
nothing behind it: events stop, no snapshot ever replaces it, and nothing says
why.

### One command main answers itself

`restart_host` is the first command main handles rather than forwards, and its
justification is that it has to be answerable when no agent host exists — which
is exactly the state the supervisor leaves behind when it declines to restart.
`MAIN_OWNED_COMMANDS` names the split, `HostServices` excludes it so implementing
it in the host is a compile error, and the host refuses it at dispatch rather
than answering: a plausible reply from a process that cannot restart itself would
be a lie.

The supervisor declines for two reasons, and both are the same refusal to guess.
A crash with a credential write in flight leaves Pi's store in a state nobody can
describe — retrying could overwrite a key that landed, reporting failure could
deny one that did. A spent budget means restarting has already failed repeatedly.
Both are decisions for a person.

### Main had no tests

None of the above was reachable by a test when it was written, because
`installCommandRouter` needs `ipcMain` and importing Electron outside Electron
does not even resolve. So the routing decisions moved to `ipc/route.ts`, which
imports Electron only as types, and `router.ts` is now the one-line registration
around it. `RecoveryLedger` was kept free of Electron for the same reason.

Six mutations fail the suite: a crash that blames nobody, a quarantined session
restored anyway, a credential crash restarted silently, a failed open counted as
an open session, `restart_host` forwarded to the dead host, and a quarantine
never announced.

### What is still open, and why it is not a detail

`REC-003` is closed for credentials and open for tools, and the register says so
rather than rounding up. A crash during a tool call is the interruption that
leaves a workspace in a state nobody can describe — a half-written file, a
command that ran once and may run again — and the ledger reads it as clean.
Closing it needs the evidence to survive the crash, which means the host writing
a marker before running a tool and clearing it after, so a restarted host finds
it on disk. The alternative, teeing the event stream through main, buys the same
knowledge by giving up the property this whole design is built on.

That paragraph is now history rather than a plan; the next section is what it
turned into.

## The evidence main cannot gather, gathered by the process that dies

The supervisor's own file said which of the two fixes to build, and the reason
still holds after building it: **the marker survives exactly the crash it
describes.** A tee only reports an interruption if main is alive and correct at
the moment of the crash. A file written before the tool ran is still there
whenever the session is next opened — by a restarted host, by a later launch, or
by a person with a text editor.

`session/tool-marker.ts` writes `<session>.jsonl.tool` when Pi announces
`tool_execution_start` and removes it when the call ends. `adoptSession` reads
and deletes it, and emits `recoverable_error` carrying the new `tool_interrupted`
code naming the tool and the path it was working on. Nothing in main changed:
every session a restart restores comes back through `open_session`, which *is*
the adoption path, so the supervisor reports its own interrupted tools without
learning anything new about events.

Four decisions in it are worth recording, because each is a place the obvious
choice is wrong.

**Presence is the whole signal; there is no liveness check.** A marker is only
read during adoption, and adoption happens after `SessionLock` is acquired — so a
host still alive and still running that tool would have refused the adoption
outright. A marker readable at that moment is necessarily a dead host's. Adding a
pid check would add a second way to be wrong without adding a way to be right.
The ordering is the load-bearing part and it now has a test: a refused adoption
must leave the owning host's marker untouched, because reading the marker is also
deleting it. Both orderings pass every other test in the file.

**An unreadable marker still reports.** The file is rewritten in place rather
than written through a temporary and renamed, so the crash it describes can cut
it mid-write. Both readings of a torn marker — died running a tool, died writing
down that it was about to — mean a tool was interrupted, so the unparseable case
reports an interruption with unknown details instead of shrugging. That tolerance
is also what lets the write stay one syscall on a path that runs twice per call.
What it will not do is assemble a report from the entries that happened to parse:
a half-read batch could name one of three calls and omit the destructive one,
which reads as a complete report and is not one.

**It is a set, not an entry.** Pi runs tool batches. Removing the file when the
first of three calls returns would leave the other two running with nothing
recorded, which is the case a crash is most likely to land in.

**It claims execution began, and nothing more.** A crash while an approval card
is open leaves no marker, which is correct — nothing ran. It also says nothing
about how far a tool got, because nothing can: a file may be whole, half-written
or untouched, and a command may have completed with only its result lost.

Timing is what makes the end-to-end test hard and necessary. The marker is worth
something only if it is on disk *before* the tool body runs and gone *after* the
turn settles, and both are instants inside a turn — a test that awaited the tool
and then looked would see an empty directory and pass while proving nothing. So
`vertical-slice.test.ts` reads the marker synchronously inside the event dispatch,
and stages the crash by replaying the bytes the host itself wrote rather than a
marker composed by the test, so a format change the reader stopped understanding
fails there. Seven mutations fail the suite: never writing the marker, recording
a call without its targets, leaving it behind on dispose, never looking for one
on adoption, reading it before the lock instead of after, reading a torn marker
as no interruption, and reading one without consuming it — the last of which
turns a one-time warning into one that fires on every open forever, which is a
warning nobody reads.

One case is deliberately left standing: a quarantined session is not reopened, so
its marker waits on disk until someone opens that session by hand. That is the
moment the warning is worth reading.

## The kill that was in the wrong order, and the worry that was backwards

`process-group.ts` had a paragraph explaining what it did not yet cover: a hard
kill of the main process, it said, can still leave orphans, and closing that
needs a Windows Job Object and therefore a native addon this toolchain does not
have. `REC-001` carried that as the open gap.

`scripts/orphans.ts` was written to measure it before building anything, in the
real topology — Electron main, a real `utilityProcess`, a tool spawned the way Pi
spawns one, and a process that tool itself starts. On Windows 11:

| How the host dies | host | the tool | what the tool started |
| --- | --- | --- | --- |
| `child.kill()` alone | dies | dies | **survives** |
| `child.kill()` then `terminateTree` | dies | dies | **survives** |
| `terminateTree` then `child.kill()` | dies | dies | dies |
| main hard-killed from outside | dies | dies | dies |

Both halves of the premise were wrong.

**The hard kill of main is not the leaky case.** Windows takes the utility
process and everything under it, so the rare catastrophic case was already
covered, and a Job Object would have bought what the platform already does. The
thing the file apologised for was not a gap.

**The ordinary supervised kill was the leaky one** — every restart, every
shutdown. `host.ts` called `child.kill()` and then `terminateTree(pid)`, and
`taskkill /T` walks a tree by parent: once the parent has exited there is no tree
to walk. The call was present, returned promptly, and was *indistinguishable from
not making it*. The module documented the ordering constraint — "taskkill walks
the tree from the parent, so it must run before the parent exits" — one file away
from its only caller, which violated it.

One layer never needed help. Pi spawns its tool with
`detached: process.platform !== "win32"`, so on Windows the tool is an ordinary
child and dies with the host in every row above. What escapes is what *that*
process starts: a background server, a watcher, a detached build. An earlier
version of this measurement went only one level deep, found a clean tree in all
four scenarios, and would have concluded there was nothing to fix.

The fix is that the ordering is no longer a caller's responsibility.
`terminateHostTree(pid, kill)` owns it, `process-group.test.ts` pins the sequence
with an injected terminator so it needs no Electron, and `host.ts` cannot get it
wrong because there is nothing left to get wrong. Reordering the function fails
the unit test *and* the real measurement, which reports the leaked descendants by
pid.

### The measurement is mostly guard rails, and that is the point

Four earlier versions of `orphans.ts` passed while measuring nothing:

- the tool exited on its own, so everything read as "cleaned up";
- `UtilityProcess.pid` was read straight after `fork`, where it is `undefined`,
  so the tree walk ran as `taskkill /PID undefined` and failed silently;
- the tree was observed before the kill had happened;
- main exited before the observation, and main exiting takes the whole tree.

So the script now refuses to conclude anything unless the tool is alive before
the kill, the tool actually started something, and main is still alive after.
And it runs the old ordering as a counterfactual: if kill-before-walk *also*
leaves nothing behind, the passing run proved only that Windows cleans up on its
own, and the script fails rather than claiming a guarantee it did not
demonstrate.

Two smaller findings are worth keeping. Electron writes nothing useful to stderr
on Windows — the same fact the smoke script records — so a utility process that
fails to start is completely silent; the probe's log file is its diagnostic
channel. And a bundled entry's `__dirname` points at its *source* directory, so
the fixture first loaded its host from the repository, where the root
`package.json` is `"type": "module"` and its `require` calls are a syntax error.
`app.getAppPath()` is the correct question to ask.

### What is still not guaranteed, and reported as such

`processTreeCleanup` is a new feature flag, true on Windows because it was
measured there and false elsewhere because it was not — and off Windows the
guarantee is weaker rather than merely unknown. Pi spawns tools `detached: true`
on POSIX, which puts each in its own process group rather than the host's, so the
negative-pid group kill does not reach them. That is `REC-001a`, and it waits on
a platform lane that can run this measurement rather than on a claim.

## What a session costs, and why one number was never going to do

The Milestone 2 criterion asked for session-count, resident-memory and
buffered-event limits that are measured, documented and enforced. Only the third
existed. The contract had carried `session_limit_reached`,
`memory_ceiling_reached` and `queue_cap_exceeded` since the first commit and
**nothing anywhere threw any of them** — three error codes the renderer could
have mapped to a card that could never appear.

`scripts/budgets.ts` weighs a real host: a real `ModelRuntime`, real sessions,
real turns against the same HTTP provider fixture the vertical slice uses,
sampling resident memory after a forced collection. On Windows 11:

| Measurement | Result |
| --- | --- |
| The runtime with no session open | 122–123 MB |
| The first session | 20 MB |
| Each session after it | 1.3–1.9 MB |
| A 16 KB turn, over a session's first twenty | 0.37–0.55 MB |
| A 16 KB turn, over the next twenty | 1.52–1.72 MB |
| One session, forty 16 KB turns | 38–43 MB |

Two of those rows decided the design.

**The first session is not a session.** It costs ten times what the next one
does, because it pays for everything Pi loads lazily on first use — extension
resolution through jiti, provider client construction, the tokenizer. An earlier
draft averaged it in with the rest and produced a per-session figure around 4 MB,
which would have set the cap four times too low. The script now measures from the
second session and says why.

**A turn does not cost a constant amount.** The same 16 KB reply retains roughly
three times as much twenty turns into a session as it did at the start, because
every turn carries the history before it. That is the finding, and it is what
makes a session count insufficient on its own: the fixed cost of a session is
knowable and a count divides a budget cleanly, but the cost of its history is
unbounded and a count cannot see it. So there are two limits bounding two
different things, rather than one limit with a safety factor.

A third measurement failed before either of those. The first version of the turn
loop scripted a reply of a dozen words and reported a *negative* per-turn cost —
the allocator reclaimed more between samples than the turns retained. That is not
a finding about sessions; it is one about garbage collection, and it is why the
measurement now states the size of turn it assumed instead of implying that a
turn is a turn.

### Nothing evicts

`session/budget.ts` refuses new work and never reclaims old. The reasoning is in
the file, and it is not conservatism: resident memory does not fall back when a
session closes — allocators do not return pages eagerly, and the script shows it
— so an eviction would not reliably recover anything, while it certainly would
drop a conversation the user is watching, release a lock a turn may be
mid-append against, and abandon a running tool. Three certain harms to avoid one
that has not happened. A host that reaches its ceiling stays there, and
`restart_host` — which main answers itself, and which works when no host exists —
is the honest resolution. Reporting the ceiling as reached is what makes that
resolution reachable.

The count is reported ahead of the ceiling when both are breached, and that is a
decision rather than an ordering accident: a host at its session cap is telling
the user to close a session, which works, and a host over its ceiling is telling
them something no close will fix.

### Where the checks sit is the part with no unit test

The queue cap joined them, unasked for by the criterion and belonging with it: a
prompt sent while a turn streams goes to Pi's follow-up queue, which has no limit
of its own, and every entry in it is a turn that will be spent against the model.
Pi's own `pendingMessageCount` is the count consulted rather than this host's
projection, which arrives on an event and therefore lags exactly the burst that
would escape a cap. The residual window is stated in `runtime.ts` rather than
papered over: the cap bounds a queue, it does not serialize the commands building
one.

`budget.test.ts` decides the rules and the script measures the numbers, which
leaves the placement — and placement is where a correct refusal still does
damage. `vertical-slice.test.ts` covers it against real Pi: the adoption cap
refuses **before** the lock is taken, and a version that checks after refuses
just as correctly while leaving a session file locked by a host that does not
exist, unopenable by anyone until the stale-holder check reclaims it. That
mutation fails the suite, as do dropping the queue check and disabling the
ceiling.

## Seven hundred milliseconds nobody had looked at

Milestone 3 budgets cold start at 2.5 seconds and the agent-host handshake at
one second. Both had been written down for months and neither had ever been
read: `scripts/smoke.ts` proved the handshake *happened* and said nothing about
how long it took, and no timer of any kind existed anywhere in the codebase. The
first thing Milestone 2.1 did was start one.

### Where the number had to come from

`performance.now()` in main starts when V8 does, which is already well into an
Electron launch — the executable mapped, Chromium initialised, main's Node
bootstrapped. A stopwatch started from JavaScript therefore cannot see the part
of cold start that happens before JavaScript exists, and would report a
comfortably-met budget by measuring only the cheap half. Electron exposes
`process.getCreationTime()`, so the invisible part is recoverable as a negative
offset in the same frame as every other mark, and `nativeLaunchOffset` returns
`null` rather than zero where a platform cannot answer. A missing measurement
must not read as a fast one.

The marks are first-write-wins, which is not fussiness. The supervisor restarts
the agent host after a crash, and `hostForked` fires again on every restart —
without the rule, the second launch of the day silently overwrites the
cold-start record with a figure measured from a process that had been running
for an hour.

### The answer, and where it actually goes

Measured on the development machine, stable across four consecutive runs to
within a few percent:

```
      72 ms  electron bootstrap, before any of our JavaScript
      27 ms  our entry module, to app ready
     114 ms  app ready, to a window with its document
     214 ms  process creation to a loaded window (budget: 2.5 s)
     750 ms  agent host fork to hello_ack (budget: 1 s)
      27 ms    of which: electron spawning the process and node booting
     697 ms    of which: the host's own bundle evaluating
      21 ms    of which: building the Pi runtime
```

Cold start is fine and will not stay fine — the renderer it loads is still a
connection-state shell, and 214 ms is the floor Milestone 3 builds on top of,
not a result. The handshake is the finding. It sits at three quarters of its
budget on a warm developer machine with no session open, no provider configured,
and nothing asked of it.

And it is not where it would have been guessed. Building the Pi runtime — the
step that resolves Pi, reads the workspace, and constructs every service — costs
**21 milliseconds**. Launching the process costs 27. The remaining 697 ms is the
host's entry module *evaluating*: a one-megabyte bundle whose top-level imports
pull Pi in statically, all of it paid before a single line of the handshake
runs. An optimisation aimed at `createPiRuntime`, which is where anyone would
have looked, would have been chasing three percent of the problem.

Nothing has been done about it here, deliberately. Milestone 2.1 is about being
able to see the number; whether 697 ms of static import is worth converting into
lazy loading is a decision that wants a second measurement — what a lazy import
costs the *first* command instead — and that measurement belongs with the work
that would change it.

### The split needed no shared clock, which is the point

Main can time a fork and a reply. It cannot see inside the process it forked, and
from outside those 750 ms are one opaque interval. The obvious way to open it is
to have the host stamp its milestones and send the timestamps back — and that is
the trap. The host's `performance.timeOrigin` is anchored to its own process's
start; subtracting main's reading from the host's is subtracting two unrelated
zeroes, and the difference between them is not small, stable, or knowable.

So `HelloAck` carries durations and never timestamps. The host reports how long
*its own* module evaluation took and how long *its own* runtime construction
took, each measured start-to-finish inside one process against one clock. Main
subtracts the host's self-reported total from the fork-to-ack interval it
measured itself, and what is left is the launch overhead neither one's code was
running for. Two single-process durations, one subtraction, no agreement
required between any two clocks.

The field is optional, and that is a schema decision with a failure mode behind
it. A required field means a host built before it fails validation, and a
handshake that fails validation presents as an application that never starts.
Nothing about a diagnostic should be able to do that.

### The clock question, asked properly and then set aside

Before any of the above, the design had a synchronized cross-process clock at the
centre of it, with a timestamp on every event envelope. `scripts/clocks.ts` was
written to find out whether that could work: real Electron, a real
`utilityProcess`, and a real sandboxed renderer, sampled 200 times each.

Its first version reported total failure — 197 of 200 samples outside the
window — because it was asking whether the clocks agree *perfectly*. They do not
and cannot: each process anchors its own time origin from the wall clock at its
own start. The useful question is by how much, and rewritten as an NTP-style
offset estimate the answer is that the agent host reads about 288 µs behind main
and the renderer about 543 µs ahead, with single-digit microseconds of spread
and no drift worth reporting. That is roughly a hundredth of the tightest budget
the project has committed to.

Which would have been a green light, except that the clock turned out not to be
load-bearing for anything. An adversarial review of the design asked which of
Milestone 3's six budgets actually needs a cross-process subtraction, and the
answer was none: cold start and the handshake are durations inside main,
shutdown is a duration main observes, first-token overhead is a comparison
between two applications, and the last two need an interface that does not exist.
The precise instrument was for host-to-renderer event latency, a number that
appears in no budget and which — measured from the renderer's intake — would
mostly have reported renderer event-loop occupancy under a name suggesting it
described the host.

So `clocks.ts` gates nothing and is run on demand. It also records what its own
result does not license, which is most of what would matter: the host restarts
and re-anchors, machines suspend, and wall clocks get stepped, and a run seconds
long from three freshly started processes is evidence about none of those. The
claim it supports is exactly one sentence wide, and it is written down at that
width.

## The shutdown budget was being measured by the one script that cannot see it

Milestone 3 budgets graceful shutdown at "under 2 seconds, without supported-case
orphans", and the plan said `bun run orphans` would measure it. `orphans` is the
script that kills a real host over a real tool tree and proves no descendant
survives, so it looked like the obvious home.

It is the wrong one, and the reason is worth keeping. `AgentHost.stop` does three
things: it sends a `shutdown` command raced against two seconds, then walks the
process tree, then kills the child. The orphan probe is a fixture with no
contract, no Pi and no command channel — it calls `terminateHostTree` directly.
So the leg that the two-second budget is mostly *about*, the host being asked to
finish and finishing, never executes there. A number measured in `orphans` and
labelled "graceful shutdown" would have been a measurement of the ungraceful part
wearing the graceful part's name.

The place where all three legs run against a real host with a real Pi already
existed: `bun run smoke` ends by calling `host.stop()` for real. So `stop` now
returns its legs and smoke reports them:

```
     340 ms  graceful shutdown (budget: 2 s)
       1 ms    of which: the shutdown command, raced against 2 s
     339 ms    of which: the ordered tree walk and the kill
```

Comfortably inside budget, and again not where it would have been guessed: the
host answers the shutdown command in a millisecond, and effectively all of the
cost is Windows enumerating a process tree. `orphans` keeps a timer of its own
for the kill it performs — 421 ms for the same walk, which agrees — because the
ungraceful path is what that script exists to prove and it should be able to say
how long its own proof took.

One field on the result is not a duration. `acknowledged` records whether the
host answered the shutdown command at all, and smoke fails the run when it did
not. Without it the budget is trivially passable by the worst possible host: one
that never answers costs almost exactly the two seconds of the race, and a
ceiling set above the race would wave it through every time. A duration cannot
distinguish a host that stopped from a host that was killed mid-sentence, so
something other than a duration has to.

### The command that is slow, and which half of it

Main already recorded every command it routes — `RecoveryLedger.noteSent` and
`noteSettled` — because commands are the only evidence main has about what the
host was doing when it died. That record is also, already, the right place to
hang two timings, and it now carries them: `main` is arrival in the IPC handler
to the command leaving for the host, and `roundTrip` is hand-off to answer in
hand.

What it deliberately does not do is split the round trip, because main cannot.
Splitting it would need an instant taken in the host subtracted from an instant
taken in main, which is the one thing this codebase does not do. The host times
its own handler and reports a duration; round trip minus that duration is the
transport and queueing leg, and it is a subtraction available to whoever holds
both numbers. The renderer-to-main hop stays permanently invisible from main for
the same reason, and the ledger says so rather than quietly starting its clock
somewhere and calling the result "the command".

The aggregate is bounded by the contract rather than by time: one row per command
name per outcome, sums and maxima and never samples, so it reaches its final size
after the first settle of each name and stays there. Answered and failed are kept
apart, because a fast rejection averaged into a slow success is a number that
describes neither.

The awkward part is where main's leg starts. The router wraps its handler in
`ledger.timeArrival(...)`, a callback rather than a returned token, and the
shape is what makes a single arrival slot safe: the handler reaches `noteSent`
without awaiting anything, JavaScript runs that stretch to completion, and the
slot is cleared the moment the handler first yields. If an `await` is ever
inserted above `noteSent`, the slot is already empty and the main leg reports as
unmeasured — which is the honest answer — rather than charging one command's time
to another, which is what a slot held across a yield would eventually do and what
would make the whole table quietly untrustworthy. The invariant is now written
next to the line that depends on it.

## An instrument that has to not change what it measures

The agent host now records spans, and every constraint on how came from the same
place: a streaming turn emits hundreds of block deltas, and an instrument that
does per-delta work is measuring itself.

So the first delta of a turn is the only one that gets an instant, and noting it
is a property read and a comparison — no clock read, no map lookup, no
allocation. That is not asserted, it is measured: a turn of two hundred deltas
driven through real Pi costs the instrument seven clock readings in total, and
the test asserts the number rather than asserting that it is "small". The ring
that holds completed spans is three typed-array columns — a `Uint16` name index,
a `Float64` duration, and a `Uint16` session index — rather than an array of
objects, so recording allocates nothing and the footprint is arithmetic
rather than an estimate about V8: 4096 slots is 49 KB, which is two hundredths of
one percent of the 256 MB session budget it must not eat into.

Bounding it needed a number with a reason. 4096 spans is roughly a quarter of an
hour of history at the rate a couple of actively watched sessions produce, and
that is the property worth stating — a turn someone noticed was slow is still in
the ring by the time they go looking for it. A ring that remembered four seconds
could only ever describe the turn that was running when the report was requested.
The rate is arithmetic over an estimate rather than a measurement, and the comment
says so; it is the one number here that is not the standard `session/budget.ts`
set.

Percentiles come from thirty-six fixed buckets rather than stored samples, and
they return a pair — `{atLeastMs, belowMs}` — so the type itself refuses to state
a precision the buckets do not have. A `p95` reported as a single number would be
a claim the data cannot support.

### A name is not a place to put a path

The report crosses to the renderer, and `SEC-006` is about exactly that: host
internals leaking through a diagnostic. The rule adopted was that a span carries
a name from a closed vocabulary and numbers, and the important part is that it is
enforced in the types rather than by convention. No public method takes a
free-form string in a name position. Pi's tool names fold through a total
narrowing function, so an MCP tool nobody anticipated becomes `other` rather than
becoming a new vocabulary entry that happens to be attacker-influenced. A test
walks the emitted contract schema and asserts what strings exist in it, rather
than only feeding it well-formed data and watching it pass.

The sharpest case is a command whose envelope never validated. Its span has to
start before validation — a malformed or enormous payload is precisely when
validation stops being free — but its name is only known after validation
succeeds. Naming it after the `name` field that arrived would have been a leak
through the one command whose result is a list of names. So the span opens as
`unknown` and is renamed the instant validation succeeds, and a bogus command
driven through real Pi is asserted to appear as `unknown` with its bogus name
absent from the serialised report.

### Whose turn was slow

The first version of the store reported host-wide aggregates, and the agent that
built it declined to attribute a turn to its session on the grounds that a
session id would breach the name-and-numbers rule. That reasoning is wrong, and
the correction is worth recording because the rule is easy to over-apply. The
rule exists to stop *host internals* reaching the renderer. A `SessionId` is not
host internals: the renderer supplied it or received it when the session opened,
it rides on every event envelope, and it is a validated DTO rather than a string.

It also matters. `scripts/budgets.ts` measured a turn's cost growing roughly
threefold over forty turns of history, and the host admits thirty-two sessions.
"Turns are slow" is not an attribution; "this session, the one with four hundred
turns behind it, is the slow one" is, and a host-wide mean actively hides it by
averaging a heavy session against light ones.

Turn legs are therefore per session and tool and command spans are not, because a
`bash` call's duration does not depend on which session ran it. Session ids are
interned into a table capped at twice `MAX_OPEN_SESSIONS`, so the thirty-two that
may be open can never evict one another and the other half is history for closed
ones. Eviction is not plain LRU: closed sessions go first, oldest closed first,
because a closed session's figures can never change again and a live one's still
can. And the ring's session column is swept on eviction, so a freed table index
handed to the next session cannot make one session inherit another's spans.

One defect was fixed rather than documented. A session closed mid-turn used to
leave a turn span open until the open-span cap evicted it, attributing it to
whatever was running much later. It now abandons the span without recording a
duration, because recording accept-to-close as a turn duration would be a fast
fiction about a turn that never finished. A tool span running at that moment
still cannot be closed — tool spans are keyed on Pi's tool call id and the store
cannot relate one back to a session — and that is pinned by a test as the
behaviour rather than papered over with a cleanup that cannot happen.

## What exists now

| Area | State |
| --- | --- |
| `packages/contract` | At the time of this record: 34 commands, 33 events, DTOs, handshake, envelopes, compiled validators. The current registry has 42 commands and 36 events. |
| `packages/agent-host` | Bootstrap, the command dispatcher and its own measured leg, diagnostics, the turn/tool/command timing ring with per-session turn attribution, sequence-fenced emitter, path and approval policy, the approval gate on Pi's blocking `tool_call` hook, session locking, the foreign-write guard and the interrupted-tool marker, session discovery and adoption from disk, the measured capacity limits on session count, resident memory and queue depth, an exhaustive Pi event adapter with its own coverage report, Pi wiring for workspace, trust, session creation, prompt, steer, abort, model and thinking-level selection, and credentials. The whole of it now runs under one end-to-end test in `test/vertical-slice.test.ts` |
| `apps/desktop/src/main` | Lifecycle, hardened window, `bakepi://` protocol, CSP, navigation guards, utility-process supervision, restart budget, ordered process-tree termination and its timing, IPC guard and router, the startup stopwatch, and the per-command latency ledger |
| `apps/desktop/src/preload` | Capability surface derived from the contract, plus the isolation assertion |
| `apps/desktop/src/renderer` | StyleX tokens, event-stream intake with the sequence fence, pure reducers, connection-state shell |
| Tests | 426 passing: boundaries, contract validation, command ownership, sequence fence and gap detection, reducers, supervisor crash attribution, host-kill ordering and command routing, path canonicalization, approval policy, tool-target extraction, approval and extension-dialog gate behavior, Pi hook ordering against a hostile extension, Pi session durability under concurrent writers and a torn entry, session-file integrity, session ownership and the write guard, the interrupted-tool marker, session discovery and summary mapping, the capacity admission rules, Pi's telemetry switch, a fixture for every event Pi can emit on a session, the emitter's discard-and-announce path, a host-to-renderer round trip that compares a recovered projection against the host's own snapshot, and the whole slice — including arbitrary-path extension UI, extension failure attribution, model selection, clamping and the events they produce, and the session cap, memory ceiling and queue cap each refusing on the path that spends the memory, and the timing report a real turn produces — driven end to end against a deterministic HTTP provider |
| Build | Four bundles, `bun run build`; StyleX compiles to static atomic CSS with no runtime injection |

## Not yet implemented, and named as such

`fork_session`, `clone_session`, `navigate_tree`, `compact_session`,
`login` and resource enable/disable throw a structured
`internal_error` carrying `not_implemented:<command>`. They are wired into the
contract, the router and the handler map — so the compiler already requires them
to exist — but they answer honestly rather than returning plausible empty
results.

The approval policy is bound to Pi's blocking `tool_call` hook and
`respond_tool_approval` is implemented; the section above records why that hook
and not `beforeToolCall`. The deterministic HTTP provider now drives both an
approved and a denied model-originated tool call through that hook. What remains
is provider realism: the capped real-provider lane (`SEC-002a`, `INT-003`).
