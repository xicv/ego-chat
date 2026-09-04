# Eagle Monitor and semantic liveness v1

Eagle Monitor is a deterministic macOS supervision plane around the existing Ego Chat broker. This slice supervises one explicitly configured durable workflow. It does not own ChatGPT, Ego Browser, Codex, or any remote side effect.

## Authority boundary

The monitor may:

- read local broker status and the exact configured workflow;
- inspect the canonical broker lease, local power source, wake discontinuities, and free space;
- start the packaged broker only when IPC is unavailable, the canonical broker lease has no live broker or browser process, and that dead result persists across the configured confirmation interval;
- await/get only the configured durable workflow UUID;
- ask the authoritative broker's `workflow.reconcile_observation` capability to validate durable recovery evidence for that exact workflow and existing binding without invoking the Ego Browser adapter or mutating broker state;
- maintain private redacted state/incidents and issue a local macOS notification.

The monitor must never select or adopt a conversation, select or downgrade a model, create an exchange or convergence workflow, compose or send text, spawn a browser child, click or inspect browser UI, clear drafts, cancel or abandon work, bypass sign-in/challenges, delete broker state, or grant authority to a model. The broker remains the only browser and delivery authority. Ambiguous and confirmed Send states permit only exact-workflow attachment and a broker-owned read-only reconciliation check; neither path contains a Send, workflow-creation, broker-state mutation, or browser-adapter call.

The MVP has no LLM or direct network dependency. A future BYOK advisor, if justified by shadow evidence, must accept only redacted bounded evidence and return a schema such as `diagnosis`, `confidence`, `missingEvidence`, and `recommendedActionClass`. The deterministic policy must independently reject actions outside the current state's allowlist. Free-form model output can never become a command, browser operation, or recovery authority.

Semantic liveness v1 does **not** implement that future advisor. It is deterministic and
shadow/read-only: its result is observability evidence only and cannot select a monitor action,
renew a broker recovery, notify through the Web conversation, execute a model, or settle a
workflow. The PR #20 operational reducer and its closed typed action allowlist remain the sole
source of monitor actions.

## Explicit non-goals

This slice is not a ChatGPT client, browser controller, multi-host scheduler, general workflow engine, credential manager, or autonomous incident-repair agent. It does not provide remote notification, multi-workflow orchestration, destructive state repair, model-driven execution, or continuous progress during forced sleep. Those capabilities require separate design and authority; Send, conversation identity, model policy, browser ownership, and settlement remain exclusively broker-owned.

## CLI and stable exit semantics

All commands emit one JSON object on stdout. `--json` is accepted for explicit caller intent and JSON remains the default.

```text
eagle-monitor start --workflow UUID [--binding-key KEY] [--mode shadow|safe]
                    [--power-policy allow-sleep|keep-awake-on-ac] [--json]
eagle-monitor status [--json]
eagle-monitor stop [--json]
eagle-monitor doctor [--json]
eagle-monitor incidents [--limit 1..200] [--json]
```

Safe mode requires the existing binding key so the broker can reconcile the exact workflow without guessing. Shadow mode predicts and records actions but executes no recovery. Starting with different workflow or policy inputs while active fails closed; stop first. Repeating the same start or stop is idempotent.

| Exit | Meaning |
|---:|---|
| 0 | Command completed and the requested/observed condition is healthy. |
| 2 | Valid result requires attention or is degraded, including semantic `stagnant`, `looping`, or `human_required`; inspect the JSON reason. |
| 3 | `status` found no active or loaded monitor. |
| 64 | Invalid command or arguments. |
| 69 | Platform/service unavailable (including non-macOS lifecycle use). |
| 70 | Software/lifecycle operation failed safely. |

Error JSON contains a stable error code and bounded message. It does not echo command arguments.
`doctor`, `status`, `incidents`, and `stop` remain available when the configured Ego Browser
executable is missing; `doctor` reports that dependency as unhealthy, while `start` still
requires an existing executable before it can write or load a service definition.

## User-scoped lifecycle and storage

`start` writes `~/Library/LaunchAgents/com.xicv.ego-chat.eagle-monitor.plist` and calls `launchctl bootstrap gui/<uid> ...`. `stop` calls `launchctl bootout gui/<uid>/com.xicv.ego-chat.eagle-monitor` and removes only a plist whose digest matches the private session record. A same-label file or loaded service without that proof is preserved for human inspection. The definition pins absolute Node, daemon, installed Ego Browser, monitor-data, broker-data, broker-socket, and working-directory paths; broker recovery does not depend on launchd's ambient `PATH`. It sends daemon stdout/stderr to `/dev/null` so launchd cannot create unbounded text logs; durable evidence goes through the bounded typed state/incident store. It uses a `077` umask, background process type, and launchd throttling. It never targets `system`, invokes `sudo`, installs a LaunchDaemon, or registers a privileged helper.

Lifecycle management rejects UID 0 rather than treating a root invocation as a user scope. `start` validates any existing private state before writing the session or registering the service, so corrupt state fails closed without creating a launchd restart loop. `doctor` includes the same redacted operational status shape as `status` alongside its local dependency checks.

Monitor state lives below the canonical Ego Chat data directory in `eagle-monitor/`. The directory must be owned by the current user with no group/other permissions. Session, lease, epoch, and state files are atomic private JSON with a one-megabyte read ceiling; persisted records reject unknown fields and invalid typed values. One exclusive live monitor lease holds a monotonic epoch. Recovery-state writes require that lease, and every active recovery passes it into the action adapter, which asserts the current owner/epoch at its dispatch boundary. A launchd stop signal also revokes that dispatch facade before shutdown cleanup, so an in-flight observation cannot begin a later recovery action after stop. Read-only CLI observers never write recovery state. Broker autostart repeats both the monitor-fence assertion and canonical broker-death/runtime proof immediately before daemon spawn. A stale owner fails with `monitor_lease_lost`. The daemon's canonical broker lease independently permits only one authoritative broker generation even if two start attempts race. Read-only CLI observers do not take the recovery lease; `status` and `doctor` report only whether that lease is active and its epoch, never its PID or raw owner identity. A loaded service with no active monitor lease is degraded rather than healthy.

State retains at most 200 incidents. Public status and incidents contain only timestamps, typed state/phase, recovery count, broker epoch, digests of broker runtime/workflow/binding identities, and a curated human-action reason. Phase evidence that is not a bounded lowercase code is discarded rather than persisted. State whose workflow digest does not match the active session is not trusted for status or recovery; a new exact workflow begins with fresh workflow-scoped timers and counters while retaining bounded incident and broker crash-loop history. Raw workflow IDs and binding keys remain only in the private session input needed for exact attachment. Prompt/response bodies, canonical URLs, API keys, cookies, tokens, browser data, unrelated processes, and arbitrary subprocess errors are neither persisted nor returned.

## Semantic checkpoint v1

The broker's existing read-only `broker.status` supervision view now includes an
`EagleSemanticCheckpoint.v1` projection for each running workflow. Older brokers and terminal
workflow reads are supported by constructing the same conservative projection from the existing
public workflow record. This adds no IPC method and no authority.

The checkpoint has a canonical, recursively key-sorted JSON serialization. Serialization rejects
unknown or malformed fields, recomputes the blocker/criterion/evidence aggregate digests and final
loop fingerprint from their typed components, and enforces a hard 16 KiB UTF-8 limit. Its bounded
fields are:

- the SHA-256 workflow, candidate, review, result, sanitized-argument, evidence, and delta digests;
- typed acceptance-criterion deltas, diagnostic blocker-delta digests, and typed evidence identities;
- typed phase, delivery, action, and tool classes;
- cycle/step sequence and event/deadline timing metadata;
- a named expected-wait source with start, deadline, identity digest, and maximum extension;
- a deterministic step fingerprint and bounded novelty sample/score.

The projection hashes evidence text and blocker/review content before it leaves the broker. It
does not copy prompts, responses, review prose, canonical URLs, binding keys, credentials,
cookies, tokens, absolute paths, filenames, raw shell output, or unbounded tool results. Counts
such as tokens, heartbeats, recoveries, and workspace activity may influence neither evidence
identity nor useful-progress renewal. Tool observations contribute only a bounded typed tool class;
sanitized arguments and results contribute only SHA-256 digests.

Useful progress is renewed only by a previously unseen identity in one of these closed classes:

- acceptance-criterion delta;
- addition or removal of a stable producer-owned `B-*` blocker identity;
- relevant test result;
- verified artifact or verified source;
- completed required verification;
- actionable review tied to its candidate.

Acceptance-criterion evidence is keyed by the stable criterion ID and its `from`/`to` status
transition. Its evidence-text digest remains diagnostic checkpoint metadata only, so rephrasing the
same transition cannot renew useful progress. A reduced public terminal record does not invent
criterion deltas from an empty baseline. Its completed-verification identity is the same
candidate-bound identity used by the live review path, so settlement cannot double-count an
already observed review or make criterion prose/order into new evidence.

An unstructured blocker string is hashed only into diagnostic loop metadata; changing its prose
does not create useful evidence. Actionable-review evidence is keyed by its producer-owned finding
ID and candidate, never by mutable title/action prose. An unverified candidate digest is metadata,
not evidence. A timestamp-only change, repeated prose, the same tool result, or a
heartbeat/recovery/token-count change is also not evidence. The monitor
retains up to 512 exact evidence identities for the workflow and fails closed by declining further
renewals if that bounded capacity is exhausted; it never evicts an identity and later counts the
same identity again.

## Semantic state machine and defaults

Semantic classification is independent of the operational state/action reducer. The public
`status.semantic` object reports one of:

| Classification | Meaning |
|---|---|
| `progressing` | New attributable evidence arrived, or its 15-minute useful-progress lease remains valid. |
| `expected_wait` | A named operation is inside its pinned deadline or its one permitted extension. |
| `suspect` | The useful lease/wait is absent or expired at the first independent observation. |
| `stagnant` | A second same-fence observation still has no useful evidence or valid wait. |
| `looping` | After hysteresis, the bounded fingerprint window matches a repeated, alternating, or short-cycle pattern. |
| `settled` | The broker's existing verified terminal settlement was observed; the monitor did not create it. |
| `human_required` | The existing operational reducer proved a genuine workflow/user boundary. |

The state machine is deterministic:

```text
new evidence -> progressing
named bounded operation -> expected_wait
lease/wait expiry -> suspect -> stagnant
                              -> looping (when a bounded pattern is proven)
broker settlement -> settled
genuine workflow boundary -> human_required
```

Every final stall/loop classification therefore has at least two observations under the same
workflow digest and broker epoch. The fingerprint covers phase, action class, tool class,
sanitized-argument digest, result digest, evidence digest, criterion-delta digest, and diagnostic
blocker-delta digest. The bounded
12-step window recognizes `AAA`, `ABABAB`, and `ABCABC` forms. New attributable evidence clears the
pattern window. A valid expected wait suppresses loop classification and records only meaningful
step transitions, not repeated polling of the same waiting step; this preserves cross-step loop
evidence without creating a false loop during the same wait. A sequence that keeps changing named
wait identities without new evidence does not gain indefinite cover: repeated, alternating, or
short-cycle fingerprints across those waits are classified as a loop.

The useful-progress lease defaults to 15 minutes. Expected waits are named by operation, use the
earlier of the durable workflow deadline and a phase-specific bound, and pin their first observed
deadline. The state retains up to 16 wait identities as non-evicting tombstones for the workflow.
If the same identity disappears and later returns, it reuses the original start, deadline, and
extension state; the gap is a meaningful loop observation, not a fresh wait. A seventeenth new
identity receives no wait cover. The same identity may receive at most one 60-second extension; a
later timestamp, source-deadline change, new evidence, or daemon restart cannot renew it again. Both
checkpoint and persisted waits have a hard eight-hour base-duration ceiling. Persisted wait
observations must match their containing semantic observation and a retained history entry, and
useful-progress renewals cannot be dated after it, so corrupt future timestamps cannot provide
indefinite liveness cover. A same-workflow observation whose wall clock precedes the last persisted
semantic observation is rejected before monitor action or state mutation, including across broker
epochs. Epoch changes may reset hysteresis, but cannot move the workflow time floor backward and
revive an expired lease or wait. The read-only public/CLI status projection clamps its requested
clock to the persisted semantic `observedAt` before evaluating both useful-progress and expected-wait
activity. Public useful-progress activity also requires its renewal time to be no later than that
effective status clock and its expiry to be no earlier.

`status.semantic.dimensions` models the following separately instead of folding them into one
activity timestamp:

- process health: `healthy`, `dead`, or `unknown`;
- transport health: `healthy`, `degraded`, or `unknown`;
- recovery: `idle` or `in_flight`;
- settlement: `active` or `settled`;
- genuine human boundary: boolean;
- useful-progress and expected-wait leases, each with its own identity and deadline.

`status.semantic.metrics` exposes observation/suspect counts, novelty score, loop pattern, and
whether the bounded evidence-identity capacity was exhausted. Public leases contain only digests,
typed operation names, deadlines, and active/extension state. `incidents` records semantic suspect,
stagnant, and loop transitions using a stable key derived from workflow digest, broker epoch, phase,
evidence window, fingerprint, and failure class. The incident UUID is deterministically derived from
that key. A bounded persisted set of emitted keys, reconstructed from existing incidents when
needed, prevents an unchanged incident from being emitted again after daemon restart or an
intervening expected wait. There is no independent deduplication-key ledger: the bounded set is
rebuilt only from retained semantic incidents whose derivation key and deterministic UUID validate.
Incident records form a strict discriminated union, so legacy or operational records cannot carry
semantic derivation fields or a non-null loop pattern, and cannot be used as semantic deduplication
evidence.

Persisted semantic state is optional under the existing monitor state schema, allowing a session
created by the first monitor slice to resume. Once present it is strict `EagleSemanticState.v1`;
unknown versions/fields, corrupt digests or lease relations, cross-workflow/cross-epoch state, or a
checkpoint for another workflow fail closed before recovery-state mutation. A legitimately changed
broker epoch starts fresh hysteresis while retaining exact evidence identities. State remains atomic
and every write still requires the current monitor lease fence.

Persisted classifications are also relationally validated: classification, reason, dimensions,
leases, loop metrics, hysteresis count, and incident identity must describe one state the classifier
can actually produce. Each useful-progress lease retains the bounded, sorted identities of the exact
attributable evidence that created it and binds them to an aggregate digest; every identity must
already exist in the bounded seen-evidence set. Public status exposes only that aggregate lease
digest. Semantic settlement and genuine-human claims must match the trusted outer operational state;
loop claims must be reproduced from the bounded fingerprint history; and incident identities are
recomputed from the outer phase plus their semantic derivation inputs. Invalid or forged relations
fail closed without replacing the last valid state.

## State/action contract

The reducer has explicit states for `startup`, `healthy`, `stalled_before_send`, `ambiguous_unconfirmed_delivery`, `send_confirmed_capture`, `settled`, `human_required_auth_challenge`, `human_required_other`, `power_sleep`, `disk_full`, `version_skew`, and `crash_loop`. Each maps to a closed action allowlist. The entire monitor vocabulary is limited to observation, exact-workflow attachment/reconciliation, conclusively-dead broker start, local notification, and idle-sleep assertion management.

Broker death requires both an unavailable authenticated IPC endpoint and no live PID/process group in the broker's canonical lease, observed for at least one second. A retained canonical lease from an incompatible broker runtime is version skew, not restart authority, even when its owner is dead. Starts are recorded durably before dispatch. Three starts within ten minutes open the crash-loop circuit for five-minute observations and notification; there is no destructive lock cleanup. Phase-aware deterministic backoff is bounded from one second during initial death confirmation through five minutes for human/circuit-breaker states. Unchanged state, phase, broker epoch, and workflow-update evidence advances through the state's backoff schedule; useful durable progress resets it. A running confirmed-Send capture that exceeds its two-hour service budget stays in the send-confirmed state, performs no recovery action, and notifies for exact-workflow review. A configured monitor-policy digest mismatch is version skew and blocks recovery.

Before Send, a stale phase can only be reattached so the broker applies its own existing recovery policy. For a convergence parent, the monitor joins the typed `broker.status` supervision projection to `workflow.get` only by the configured workflow UUID. `queued` may become stalled-before-Send, and only `sent_waiting_response` establishes confirmed-Send capture. Both `not_confirmed` and `reconciling_delivery` remain ambiguous delivery states: the monitor can only observe or reattach the configured convergence parent so the authoritative broker performs its existing reconciliation. It never invokes exchange-only reconciliation for that parent, guesses or adopts its child, retries Send, or creates an operation. A terminal ambiguity with the exact binding may call `workflow.reconcile_observation` only when that configured workflow is the existing `ego_exchange`. The broker implements this as a read-only method: it rejects unbound or unrelated recovery, validates only existing durable records, returns bounded phase/status metadata, and never invokes the Ego Browser adapter or any state transition. A terminal result is recorded as `terminal_observed`, not successful recovery. The monitor persists a redacted digest of that terminal snapshot, creates a human-required incident, and notifies once; it does not reconcile that unchanged snapshot again. A changed durable snapshot may receive one new observation-only check. The IPC authority table classifies `broker.status`, `workflow.get`, `workflow.await`, and `workflow.reconcile_observation` as read-only; the monitor adapter contains no other workflow or conversation method. Direct exchange phases `send_confirmed`, `capture_pending`, and `restart_reconciling` are read-only attachment/reconciliation states. Settlement is observation-only.

## Power, permissions, and security

`allow-sleep` is the default. The daemon runs the read-only `pmset -g uuidlog` event stream and converts only its typed `Sleeping`/`HasPoweredOn` markers into one-shot `power_sleep` observations; raw power diagnostics are discarded. A timer/clock discontinuity remains a conservative process-restart fallback. The monitor performs no recovery on the sleep/wake observation, then fully revalidates broker/runtime/workflow/storage state. This means **resume after wake**, not progress while asleep.

`keep-awake-on-ac` starts `/usr/bin/caffeinate -i -w <monitor-pid>` only while an authorized workflow is active and `pmset` reports AC power. This requests prevention of idle system sleep only. Lid closure, explicit sleep, low battery, thermal protection, shutdown, and OS policy can still suspend the Mac. A laptop expected to work overnight must remain open and powered, or the workload must move to an always-on host.

This slice requires no Accessibility, Automation, Input Monitoring, Screen Recording, Keychain, root, or system-daemon permission. Its local notification uses `osascript`; notification failure cannot expand recovery authority. Broker authentication tokens remain broker-owned and are read only through the existing private IPC client.

Automated interaction with ChatGPT may be governed by the applicable OpenAI individual, API, Business, Enterprise, or integration terms. Whether the existing browser workflow is permitted for the intended account remains an open product/legal question, not a conclusion made by this project. Eagle Monitor deliberately does not broaden the broker's browser interaction surface.

## Operational runbook

1. Obtain the durable workflow UUID and existing binding from Ego Chat; do not create replacements for monitoring.
2. Run `eagle-monitor doctor --json`. Resolve platform, runtime, private-state, or definition mismatch findings.
3. Start with `--mode shadow --power-policy allow-sleep` and inspect `status`/`incidents` after representative overnight sessions.
4. Stop the shadow monitor. Enable `--mode safe --binding-key ...` only after reviewing predicted actions.
5. For `human_required_auth_challenge`, complete the challenge in the authoritative user session, then let the monitor re-observe. Never provide credentials to the monitor or an advisor.
6. For `version_skew`, stop and perform an separately authorized Ego Chat upgrade/restart; the monitor will not mutate a mismatched broker.
7. For `disk_full` or corrupt state, stop and preserve evidence. Do not delete broker or monitor ledgers blindly.
8. For `crash_loop`, inspect bounded monitor incidents, broker logs, and runtime identity. The circuit remains fail-closed; do not clear locks to force another generation.
9. Use `eagle-monitor stop --json` before changing the exact workflow, binding, mode, or power policy.

Tests exercise lifecycle behavior with an injected fake runner. They must never call real `launchctl bootstrap`, `bootout`, or install/register a live LaunchAgent.
