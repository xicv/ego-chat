# Bound task-space recovery and provable pre-Send retry

Date: 2026-09-10. Status: approved design (roadmap Tier 1 items 2 and 6, chosen by the user), not yet implemented.

## Summary

Two changes to the broker and the browser driver so that an unattended run survives the two failure codes that ended real runs on this Mac since 5 September:

1. **Vanished bound Space.** When the Ego Space bound to a conversation is absent from the live browser state (no Space matches its stable identity and none conflicts with it), the driver recreates the same identity by name, reopens the canonical conversation in it and continues, instead of ending the workflow with `bound_task_space_identity_changed`. The broker grants the recreation only after the Space has been missing for a bounded delay, so a Space that merely disappears for a moment during a browser restart is not duplicated.
2. **Provably pre-Send driver crash.** A driver crash at a stage before any prompt text was inserted is retried through the existing pre-Send backoff even though the driver had nothing to clear and therefore reported no `draftCleared`, instead of ending as `browser_operation_interrupted_before_send_confirmation`.

Both changes keep at-most-once delivery: recreation is read-only browser work that happens before conversation selection, and the retry rule only widens the set of failures already proven to have happened before the Send click.

## Ledger evidence (this Mac, 24 August to 10 September 2026)

- `bound_task_space_identity_changed`: four standalone exchanges (binding `a3k-step7-continuation-20260905` on 5 September, the adopted binding `adopt-f064b109…` on 7 and 8 September, `ego-chat-main` on 10 September at 00:39Z), each failing within three seconds of the operation start with `matchCount: 0`, plus the 28-cycle convergence that ended on 10 September. The message in every record is "The durable task-space identity is no longer present in the live browser state", which is the zero-match branch of `useBoundTaskSpace`.
- `browser_operation_interrupted_before_send_confirmation`: `ego_driver_error` at `composing_prompt` and at `inserting_prompt_chunk` with `draftCleared: true` (24 August, before the staged Send adapter existed), `ego_driver_error` at `selecting_conversation` with no `draftCleared` (25 August), and `invalid_driver_output` with no stage at all (10 September, after six `model_policy_mismatch` retries).

## Verified Ego facts

- The driver's Space surface is `listTaskSpaces()` returning `{ id, name, taskId, ownership }`, `useOrCreateTaskSpace(nameOrId)`, `claimTaskSpace(id)` and `takeOverTaskSpace(id)`. There is no delete or rename call.
- `useOrCreateTaskSpace(name)` creates a Space whose `taskId` equals the requested name. Verified live on 2026-09-10: the preflight for `claude-code-live-check` returned `{ name: "claude-code-live-check", taskId: "claude-code-live-check" }`, and the `ego-chat-main` Space is `ego-chat-bound-e00bb7aa16a99097910c7c5a85b14f8f` in both fields.
- The numeric `id` is a location hint that Ego may recycle. The persisted `{ name, taskId }` pair is the identity (README "Persistent conversation").

## Goals

- A running exchange, capture, restart reconciliation, manual reconciliation, verify or re-anchor whose bound Space has vanished continues after one recorded recovery, with the binding's numeric location re-recorded and the ledger showing the recovery rather than `bound_task_space_identity_changed`.
- A driver crash at a pre-composition stage is retried with the same backoff and deadline as every other pre-Send recovery.
- No new human ceremony; no change to Send fences, head attribution, capture, reconciliation semantics or binding immutability.

## Non-goals

- Recovering a Space whose recorded identity has an opaque `taskId` (a user-created Space bound by number). Recreating it by name could not reproduce the identity and would leave a conflicting Space behind, so it keeps today's terminal behaviour.
- Resolving two live Spaces with the same identity. That remains `bound_task_space_identity_ambiguous`.
- Retrying stage-unknown driver failures (`invalid_driver_output`, `ego_driver_timeout`, `ego_browser_process_failed`, `driver_output_too_large`). The last stage cannot be proven for them, so they stay on the reconciliation path. Automatic reconciliation for standalone exchanges is a separate roadmap item.
- Any change to convergence, successor preparation, attachments or the monitor.

## Part A: recreate a vanished bound Space

### A1. Definitions

- **Missing.** For a bound binding with a valid recorded identity, the live list contains zero Spaces whose identity matches exactly and zero Spaces that share only the name or only the `taskId` (no conflict). Location matches by numeric id are irrelevant: a recycled number is not the bound Space.
- **Recreatable identity.** `identity.name === identity.taskId`. This is every Space that Ego Chat itself named (deterministic `ego-chat-bound-…` names, adoption and successor names, preflight names). Ego assigns `taskId` equal to the name, so recreating by name reproduces the identity exactly.
- **Eligible operation.** Driver modes `exchange`, `capture_exchange`, `reconcile_bound`, `reanchor` and `verify` running for a `bound` binding with a canonical URL. The driver input carries `taskSpaceRecovery: { allowRecreate: true }` only when the broker has granted recreation for that attempt.

### A2. Driver behaviour (`src/ego-driver-source.mjs`)

1. `useBoundTaskSpace(binding)`, at the branch that today raises `bound_task_space_identity_changed` with `matchCount: 0`:
   - If the identity is not recreatable or the mode is not eligible: unchanged (terminal `bound_task_space_identity_changed`).
   - If recreatable and eligible but `input.taskSpaceRecovery?.allowRecreate !== true`: raise `bound_task_space_missing` (new reason, retryable) with `{ matchCount: 0, recreatable: true, taskSpaceId }`. No browser mutation.
   - If recreatable, eligible and granted: call `selectObservedTaskSpace(identity.name, { expectedIdentity: identity, allowRecreate: true })`, which creates the Space through the existing `immediately_before_task_space_creation` broker-fenced mutation, re-observes it and applies every existing check (single location match, exact identity match, uniqueness, no conflicts, `agent` ownership, guard admission). On success record `taskSpaceRecovery = { method: "recreate", previousTaskSpaceId: binding.taskSpaceId, taskSpaceId: <new id> }` in the driver's per-run state, exactly like `taskSpaceControlRecovery`.
2. `selectObservedTaskSpace`: the creation branch currently refuses when the guard's owner selector is `stable_identity` or `expectedIdentity` is set. With `allowRecreate: true` it permits creation when the requested name equals both fields of `expectedIdentity` and `expectedIdentity` matches the guard's owner identity exactly. Every post-creation check stays as it is; the guard's `deniedIdentities` and `deniedSelectors` still apply.
3. `revalidateSelectedTaskSpace` (the fence re-proof before critical actions): when zero location matches, zero identity matches and zero conflicts are observed for an eligible mode with a recreatable identity, raise `bound_task_space_missing` instead of `bound_task_space_identity_changed`. No creation happens inside a fence; the broker's retry re-enters through `useBoundTaskSpace`. Once the Send click has been dispatched (`sendClickStarted`), the same observation is reported as `send_confirmation_ambiguous` with `taskSpaceMissing: true`, because the prompt may already have been accepted; that code is a bound-recovery code, so the broker reconciles the possibly delivered prompt (recreating the Space through the reconciliation loop) instead of retrying the Send.
4. `emitSelectedResult` adds `taskSpaceRecovery` to the emitted result when set, so every mode's result can carry it.
5. After recreation, `selectConversation` finds no tab with the old `targetId` and takes its existing "open the canonical URL" path, which already verifies the URL and the head. No new navigation code.

### A3. Broker behaviour (`src/broker.mjs`)

1. `RETRYABLE_PRE_SEND_REASONS` gains `bound_task_space_missing`. The capture loop and the restart-reconciliation loop already retry every reason that is not human-only.
2. Recreation authority. A helper computes the driver input from the workflow's last recovery record: `{ allowRecreate: true }` when `record.code === "bound_task_space_missing"` and `Date.now() - Date.parse(record.at) >= boundTaskSpaceRecreateDelayMs` (constructor option, default `BOUND_TASK_SPACE_RECREATE_DELAY_MS = 30_000` from `src/constants.mjs`), otherwise `undefined`. With the default backoff (250 ms, 1 s, 2 s, 5 s, 10 s, 30 s) the recreation happens on the sixth or seventh attempt, after roughly 48 seconds of cheap list reads, which leaves a restarting browser time to restore its Spaces.
   - Pre-Send loop: from `current.lastRecovery`, passed in the `sendExchange` params. The automatic re-anchor inside that loop passes the same value.
   - Capture loop: from `current.lastCaptureRecovery`, passed in the `captureExchange` params.
   - Restart reconciliation (`#recoverBrowserOwnedAfterRestart`): from `current.lastRecovery`, passed in the `reconcileBound` params.
   - Explicit host operations `verifyConversation`, `reconcileConversation` and `reanchorConversation`: `{ allowRecreate: true }` immediately. They are read-only, user-initiated and retried by the host, so the delay would only add ceremony.
3. Result validation. `validateTaskSpaceRecovery(value)` mirrors `validateTaskSpaceControlRecovery`: exactly the keys `method` (`"recreate"`), `previousTaskSpaceId` and `taskSpaceId` (positive safe integers), otherwise `task_space_recovery_proof_invalid`.
4. Persistence and visibility.
   - Send path: the validated record is stored in `private.send.taskSpaceRecovery` and copied to the public workflow field `taskSpaceRecovery` in the same `exchange.send_confirmed` transition.
   - Capture path: the capture result's record, or else the send's, is carried on `result.taskSpaceRecovery` and the workflow field is updated at `exchange.response_captured`.
   - Restart reconciliation and manual reconciliation: the workflow field is updated when the driver result carries a record.
   - `verifyConversation` and `reanchorConversation` return the record alongside the binding.
   - The binding's numeric location and `targetId` are re-recorded by the existing commits (`binding.verified` at head commit, `binding.checkpointed`, `binding.reconciled`, `binding.reanchored`). When the committed result carries a recovery record, the head-commit and checkpoint events are written as `binding.task_space_recovered` instead of `binding.verified` / `binding.checkpointed`, so the ledger names the recovery. The store's binding reducer is type-agnostic.
5. Nothing else changes: the workflow's admission already reserves the binding's stable identity, `#reserveBrowserTaskSpaceIdentity` compares identities rather than numbers, `taskSpaceIdentityCommitPatch` and `effectiveWorkflowBinding` see an unchanged identity, and the guard's owner selector matches the recreated Space.

### A4. Safety argument

- **At-most-once.** Recreation happens inside `useBoundTaskSpace`, before the conversation is selected and before any composer work; the Send fences, the `immediately_before_send_click` re-proof and confirmation logic are untouched. A Space that vanishes after the click is handled by the unchanged capture and reconciliation paths.
- **Identity.** The recreated Space has the same `{ name, taskId }`, so every reservation, guard, evidence comparison and claim keeps working; only the numeric location changes, which the code already treats as a hint.
- **Duplicates.** A Space that comes back after recreation produces two exact matches and the unchanged `bound_task_space_identity_ambiguous` outcome. The delay makes this unlikely for a browser restart; the residual case is documented and remains a human boundary.
- **Opaque identities and conflicts.** Untouched: they still end as `bound_task_space_identity_changed` or `bound_task_space_identity_conflict`.
- **Concurrency.** The operation's admission reserves the identity for its owner; another binding cannot claim the recreated Space, and the guard denies other bindings' identities during creation as today.

### A5. Codes and messages

- New reason `bound_task_space_missing`: "The bound Ego task space is not present in the live browser state." It is retryable and never human-only.
- The existing `bound_task_space_identity_changed` message is unchanged for the non-recreatable cases.

## Part B: retry provably pre-Send driver crashes

### B1. Stages

The driver reports `driverStage` only on the unexpected-error path (`ego_driver_error`), and attaches `draftCleared` only when text may have been inserted (`unsentDraftMayExist`). Stages at which no prompt text exists:

`dispatching_exchange`, `checking_browser_contract`, `selecting_conversation`, `checking_generation_state`, `reading_before_head`, `verifying_model_policy`, `verifying_precompose_head`, `inspecting_composer`.

`composing_prompt` and later stages may have inserted text and keep requiring `draftCleared: true`.

### B2. Rule

`provenPreSendDriverFailure(details)` is true when `PRECLICK_DRIVER_STAGES.has(details.driverStage)` and either `details.draftCleared === true` or `PRE_COMPOSITION_DRIVER_STAGES.has(details.driverStage)`. It replaces the inline `draftCleared === true && PRECLICK…` test in `#canRetryPreSend`, `#receiptFailureIsProvenPreClick` and the `allowDeliveryAbsent` computation in `reconcileConversation` (applied to the stored `browserInterruption`).

### B3. Effect

An `ego_driver_error` at `selecting_conversation` is retried through `exchange.pre_send_recovery_scheduled` with `lastRecovery.code: "ego_driver_error"` and its `driverStage`, bounded by the workflow deadline. The same error at `verifying_composed_prompt` without `draftCleared` still ends as `browser_operation_interrupted_before_send_confirmation`, and stage-unknown failures are unchanged.

## Part C: commit a response recovered by restart reconciliation

Found while testing Part A. When a broker restart interrupted a browser-owned exchange and restart reconciliation then found the complete attributable response, `#runEgoExchange` skipped the capture-commit tail (blob storage and `exchange.response_captured`) because the result was already set, and the following integrity check ended the workflow with `response_capture_state_invalid`. The ledger has never recorded that code, so the path had not been exercised live. The commit tail now runs for any result that has no stored `responseRef`, which makes a fresh capture and a restart-recovered response commit identically. No behaviour changes for results restored from the `response_captured` phase.

## Contracts and constants

- `BROWSER_CONTRACT_REVISION` 18 → 19 (new driver input `taskSpaceRecovery` and result field `taskSpaceRecovery`).
- `runtimeGeneration` → `2026-09-10.1`.
- `BOUND_TASK_SPACE_RECREATE_DELAY_MS = 30_000` in `src/constants.mjs`; Broker option `boundTaskSpaceRecreateDelayMs` for tests.
- `storeSchemaRevision` and `mcpSchemaRevision` unchanged: the new ledger and public fields are optional additions and no tool input schema changes.

## Documentation

- README: the "Further work remains on same-chat recovery after complete loss of an established browser Space" sentence, the numeric-location paragraph under "Persistent conversation", the recovery-states sentence under "Current-host-owned convergence", and the release verification section at release time.
- CONTINUITY.md recovery model: the deterministic task space is reclaimed and, when it has vanished, recreated by name.
- `skills/ego-chat/SKILL.md` and the MCP instructions: add a vanished Ego-Chat-named Space to the list of broker recovery states.

## Testing

- Driver harness (`test/ego-adapter.test.mjs`): the existing case "an established identity that disappears cannot fall through to a replacement workspace" becomes two cases (missing without authority raises `bound_task_space_missing` and performs no creation; missing with authority recreates, re-observes, opens the canonical URL and returns the tuple with `taskSpaceRecovery`), plus cases for an opaque identity (unchanged terminal), a name-only conflict (unchanged), a Space vanishing at a Send fence in exchange mode (`bound_task_space_missing`, no click), `verify` and `capture_exchange` recreation, and rejection of `allowRecreate` for a non-eligible mode.
- Broker (`test/store-broker.test.mjs`): the pre-Send loop with a fake adapter that throws `bound_task_space_missing` until the delay elapses and then returns a result with `taskSpaceRecovery` (asserting the retry count, the granted flag in the adapter params, the `binding.task_space_recovered` event, the re-recorded `taskSpaceId` and the public field); the capture loop and restart reconciliation analogues; `verifyConversation` passing the flag; Part B cases (`selecting_conversation` retried, `verifying_composed_prompt` without `draftCleared` terminal, `allowDeliveryAbsent` accepting a pre-composition stage).
- Deterministic suites: `npm run lint`, `npm test`, `cargo fmt --check`, `cargo clippy --all-targets`, `cargo test`.
- Live qualification after install: on the throwaway binding `claude-code-live-check`, remove its Space while idle, run one `ego_exchange_and_wait`, and expect `lastRecovery.code: "bound_task_space_missing"`, a `taskSpaceRecovery` record, a `binding.task_space_recovered` event and a succeeded workflow. This spends one strongest-model ChatGPT turn.
