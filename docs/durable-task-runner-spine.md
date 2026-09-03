# Durable Task and Runner Spine

This is the first bounded slice of a repository-independent task control plane. It records what a logical task is, which exact revision its evidence covers, who currently holds a verification lease, and whether an external effect is safe to continue after a crash. It does not automate a real repository or change the existing ChatGPT browser workflow.

## Module boundary

- `src/task-domain.mjs` is the deterministic reducer. Commands include every timestamp, identity, SHA, and fencing input; the reducer performs no I/O.
- `src/task-store.mjs` is the single-writer disk adapter. It synchronously snapshots each command before queueing it, then persists one schema-versioned state file with a private atomic write, file sync, rename, and directory sync.
- `src/task-spine.mjs` is the local orchestration API. It supplies clocks and identities, exposes cursor attachment, and owns effect recovery sequencing.
- `src/task-fakes.mjs` contains the fake remote implementer, verification runner, and identity-aware external effect adapter used by tests.
- `src/broker.mjs` accepts the spine as an optional compatibility dependency. `bin/ego-chatd.mjs` constructs it beside the existing browser `EventStore`; existing Ego Browser and Codex App Server operations remain on their original path.

The browser store initializes first. If the optional task store is corrupt or otherwise cannot initialize, broker startup continues with `taskSpine.status = "unavailable"`; task-spine access fails explicitly with `task_spine_unavailable`, while the pre-existing browser workflow store remains usable. Standalone task-spine construction still fails closed on invalid durable state.

## Durable model and invariants

One schema-versioned state contains first-class collections for conversations, tasks, activities, artifacts, effects, approvals, runners, leases, and globally ordered conversation events.

- A conversation stores the acceptance contract and its canonical SHA-256 digest. Each task also stores an immutable settlement contract and digest covering both that acceptance contract and the ordered required-evidence policy; the task-creation event carries the same digest. There is no update command. Read APIs return clones, so a caller cannot mutate stored contract data.
- A pull-request artifact records an exact lowercase 40- or 64-character base SHA and head SHA. Publishing a new artifact revision is the only way to change the current revision.
- Verification and review evidence bind to both the current base and head. A change to either SHA marks prior verification/review activities, their active leases, and prior approvals stale in the same reducer transaction.
- Verification leases carry an activity-local monotonic fencing token. Expiry or explicit reassignment ends the previous lease and increments the token. A late completion must match the active lease, runner, token, and current base/head revision. Durable successful or failed verification evidence must match the final completed lease, its fencing token, and its completion time.
- A verification lease may be issued only to a runner registered with the `verification` capability. This bounded slice accepts `verification` and `review` as required evidence because both have reachable successful transitions; `implementation` evidence remains a future activity type. Successful activities for every configured evidence kind advance the task to `waiting_approval`; partial evidence remains `waiting_evidence` (or `waiting_verification` when verification is still missing).
- A review and an approval must each name the exact current base and head. An approval must also name successful activities covering every required evidence kind. It advances the task to `ready_to_merge`; a later base or head change invalidates it.
- Every conversation event receives a monotonically increasing sequence. A client attaches with a conversation ID and last-seen cursor, receives later ordered events, and also receives the current conversation-scoped entity snapshot.
- Caller-supplied JSON is rebuilt from validated own data descriptors into fresh plain objects and arrays before byte measurement, queueing, reducer access, or persistence. Accessors, inherited serialization hooks, cycles, holes, extras, and oversized values are rejected without invoking caller code. Future cursors are rejected rather than silently skipping later events.
- Reconstruction revalidates stored value and settlement-contract digests, entity statuses, revision bindings, cross-entity indexes, final-lease completion provenance, fencing, and approval evidence before exposing state.

## Local entry point

The API does not open ChatGPT:

```js
import { createDurableTaskSpine } from "./src/task-spine.mjs"

const spine = createDurableTaskSpine({ dataDir: "/private/local/ego-chat-data" })
await spine.initialize()
const created = await spine.createConversation({
  acceptanceContract: { criteria: ["verification passes for the exact head"] },
})

const attached = await spine.attachConversation({
  conversationId: created.conversation.id,
  cursor: 0,
})
```

Reconstructing the store, spine, or broker from the same private data directory reloads the same state. A second read client refreshes from disk before attachment. This slice deliberately assumes the existing broker remains the sole writer; multi-process writer locking and event compaction are later work.

## External effect lifecycle

An effect identity is reserved durably with a stable adapter identity and an immutable cloned input plus its canonical digest before adapter invocation:

```text
reserved -> dispatching -> applied -> succeeded
                |
                +-> reconcile by effect identity and input digest after restart
```

`dispatching` is intentionally uncertain: the external action may or may not have happened. Recovery must call `adapter.reconcile` before `adapter.apply`. A proven existing result moves to `applied` without another apply. A proven absence permits an identity-aware apply. An ambiguous answer fails closed. Once `applied` is durable, recovery completes the ledger without calling the adapter again. Reusing an effect identity with a different adapter, task, kind, or input digest is rejected.

The deterministic suite injects crashes after reservation, dispatch intent, external apply, durable applied outcome, and terminal success. Replaying every case against the fake external ledger produces one external object for each effect identity. A separate negative test proves that ambiguous reconciliation neither calls `apply` nor settles the durable effect. A future real adapter must provide equivalent idempotency-key and lookup semantics; the local ledger alone cannot promise exactly-once behavior from an arbitrary remote API.

## Explicit limitations

- No real GitHub, GitLab, cloud, deployment, production, credential, merge, or approval adapter exists.
- An `approver` is a durable logical identity, not authentication. A future boundary must authenticate and authorize it before issuing `grantApproval`.
- Explicit lease reassignment is a trusted local command in this slice. Scheduling policy and runner authentication are not implemented.
- The task store is an atomic snapshot optimized for the bounded slice. It has no multi-writer lock, migration framework, pruning, or archival policy yet.
- Task-spine events are separate from the existing browser workflow JSONL. Cross-ledger transactionality and mapping existing convergence workflows into logical tasks are intentionally deferred.
- Fake-adapter proof does not establish behavior for a real remote service; real integrations need provider-specific reconciliation tests before gaining write authority.
