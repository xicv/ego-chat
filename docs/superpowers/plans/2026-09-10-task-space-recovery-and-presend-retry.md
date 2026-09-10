# Plan: bound task-space recovery and provable pre-Send retry

Spec: `docs/superpowers/specs/2026-09-10-task-space-recovery-and-presend-retry-design.md`. Branch `feature/space-recovery-presend-retry`, worktree `~/.config/superpowers/worktrees/ego-chat/space-recovery-presend-retry`. Line numbers below are from `main` at `65e3840` and drift as edits land; search for the quoted anchors.

Conventions: conventional commits without attribution lines, one commit per task, `npm run lint` and the affected Node suite before every commit, `npm test` plus the Rust checks before the review task.

---

### Task 1: constants and broker helpers

- [ ] **Step 1: constants** — `src/constants.mjs`: `BROWSER_CONTRACT_REVISION` 19, `runtimeGeneration: "2026-09-10.1"`, add `export const BOUND_TASK_SPACE_RECREATE_DELAY_MS = 30_000`.
- [ ] **Step 2: code sets** — `src/broker.mjs`: add `"bound_task_space_missing"` to `RETRYABLE_PRE_SEND_REASONS` (keep alphabetical). Add `PRE_COMPOSITION_DRIVER_STAGES` (the eight stages in spec B1) next to `PRECLICK_DRIVER_STAGES`, and a module function `provenPreSendDriverFailure(details)` implementing spec B2.
- [ ] **Step 3: validators** — add `validateTaskSpaceRecovery(value)` after `validateTaskSpaceControlRecovery` (line 214): `undefined` passes through; otherwise exactly `{ method: "recreate", previousTaskSpaceId, taskSpaceId }` with positive safe integers, else `human_required` / `task_space_recovery_proof_invalid`; return a `structuredClone`.
- [ ] **Step 4: authority helper** — Broker constructor option `boundTaskSpaceRecreateDelayMs` (validated like `recoveryDelaysMs`, default from the constant). Private method `#taskSpaceRecoveryInput(record)` returning `{ allowRecreate: true }` when `record?.code === "bound_task_space_missing"` and `Date.now() - Date.parse(record.at) >= this.#boundTaskSpaceRecreateDelayMs`, else `undefined`.
- [ ] **Step 5: Part B gate** — replace the inline `draftCleared === true && PRECLICK_DRIVER_STAGES.has(...)` tests in `#canRetryPreSend` (both branches), `#receiptFailureIsProvenPreClick` and the `allowDeliveryAbsent` computation in `reconcileConversation` (anchor `browserInterruption?.draftCleared === true`) with `provenPreSendDriverFailure(...)`.
- [ ] **Step 6: commit** — `feat: add task-space recovery authority and provable pre-send failure gate`.

### Task 2: driver recreation path

File `src/ego-driver-source.mjs`.

- [ ] **Step 1: state** — next to `let taskSpaceControlRecovery = null` (line 79) add `let taskSpaceRecovery = null`. Add helpers: `recreatableTaskSpaceIdentity(identity)` (valid identity with `name === taskId`), `canRecreateBoundTaskSpace(binding)` (binding `state === "bound"`, canonical URL present, identity recreatable, `input.mode` in `["capture_exchange", "exchange", "reanchor", "reconcile_bound", "verify"]`), and `taskSpaceRecreateGranted()` (`input.taskSpaceRecovery` is a plain object whose only key is `allowRecreate: true`; any other shape is treated as not granted).
- [ ] **Step 2: `useBoundTaskSpace`** — at the anchor `"The durable task-space identity is no longer present in the live browser state."` (line 1616): before raising, if `canRecreateBoundTaskSpace(binding)` and not granted, raise `bound_task_space_missing` with `{ matchCount: 0, recreatable: true, taskSpaceId: binding.taskSpaceId }`; if granted, `const selected = await selectObservedTaskSpace(binding.taskSpaceIdentity.name, { allowRecreate: true, expectedIdentity: binding.taskSpaceIdentity })`; on success set `taskSpaceRecovery = { method: "recreate", previousTaskSpaceId: binding.taskSpaceId, taskSpaceId: selected.id }` and return `selected`; otherwise return `null`. Non-recreatable bindings keep the existing raise.
- [ ] **Step 3: `selectObservedTaskSpace`** — accept `allowRecreate = false`. In the creation branch (anchor `"The requested existing task space is not present before selection."`), compute `recreation = allowRecreate && typeof identifier === "string" && expectedIdentity && identifier === expectedIdentity.name && identifier === expectedIdentity.taskId && guard.ownerSelector.kind === "stable_identity" && taskSpaceIdentityMatches({ name: identifier, taskId: identifier }, guard.ownerSelector.identity)`; when `recreation` is true skip the refusal and fall through to the existing `runBrokerMutation("immediately_before_task_space_creation", () => useOrCreateTaskSpace(identifier))`. Leave every later check unchanged (they already enforce the exact identity, uniqueness, conflicts, ownership and guard).
- [ ] **Step 4: `revalidateSelectedTaskSpace`** — in the failure branch, when `locationMatches.length === 0 && identityMatches.length === 0 && identityConflicts.length === 0 && canRecreateBoundTaskSpace(input.binding)`, use reason `bound_task_space_missing` (details unchanged plus `recreatable: true`), except after `sendClickStarted`, where the same observation is `send_confirmation_ambiguous` with `taskSpaceMissing: true` (Codex review finding: a post-click loss must reconcile, never retry the Send).
- [ ] **Step 5: results** — in `emitSelectedResult` add `...(taskSpaceRecovery ? { taskSpaceRecovery } : {})` to the emitted `result`.
- [ ] **Step 6: driver tests** — see Task 4; run `node --test --test-reporter=spec test/ego-adapter.test.mjs`.
- [ ] **Step 7: commit** — `feat: recreate a vanished bound task space by its recorded identity`.

### Task 3: broker call sites and persistence

File `src/broker.mjs`.

- [ ] **Step 1: pre-Send loop** — in the `while (!sent)` loop (anchor `sent = await this.#egoAdapter.sendExchange(`), add `taskSpaceRecovery: this.#taskSpaceRecoveryInput(current.lastRecovery)` to the params (omit the key when `undefined`). Pass the same value into `#autoReanchorRunningExchange` and on to `this.#egoAdapter.reanchor` params there.
- [ ] **Step 2: send commit** — after `validateTaskSpaceControlRecovery(sent.taskSpaceControlRecovery)`, add `const taskSpaceRecovery = validateTaskSpaceRecovery(sent.taskSpaceRecovery)`; include it in `private.send` and, when present, as top-level `taskSpaceRecovery` in `sendConfirmedPatch`.
- [ ] **Step 3: capture loop** — add `taskSpaceRecovery: this.#taskSpaceRecoveryInput(current.lastCaptureRecovery)` to the `captureExchange` params; after the capture succeeds set `result.taskSpaceRecovery = validateTaskSpaceRecovery(captured.taskSpaceRecovery) ?? current.private.send.taskSpaceRecovery` (delete the key when both are undefined) and include `taskSpaceRecovery` in the `exchange.response_captured` transition when present.
- [ ] **Step 4: head commit event** — at the anchor `currentBinding.state === "unbound" ? "binding.promoted" : "binding.verified"`, use `"binding.task_space_recovered"` instead of `"binding.verified"` when `result.taskSpaceRecovery` is present.
- [ ] **Step 5: restart reconciliation** — in `#recoverBrowserOwnedAfterRestart` add `taskSpaceRecovery: this.#taskSpaceRecoveryInput(this.#store.getWorkflow(workflow.id)?.lastRecovery)` to the `reconcileBound` params; when `verified.taskSpaceRecovery` validates, persist it on the workflow in the next transition the function performs (`exchange.restart_delivery_absent`) or, on the captured path, on the returned result so `#runEgoExchange` stores it.
- [ ] **Step 6: explicit operations** — `verifyConversation`, `reconcileConversation` (both `reconcile` and `reconcileBound` branches) and `reanchorConversation`: pass `taskSpaceRecovery: { allowRecreate: true }`; validate the returned record; `verifyConversation` writes `binding.task_space_recovered` instead of `binding.checkpointed` when present and returns `{ ...publicBinding(nextBinding), ...(taskSpaceRecovery ? { taskSpaceRecovery } : {}) }`; `reanchorConversation` returns the record the same way; `reconcileConversation` stores it on the workflow when it transitions.
- [ ] **Step 7: CLI/MCP surface** — no schema change. Confirm `workflow_status` shows `taskSpaceRecovery` through `publicWorkflow` (structuredClone of the record, nothing to add).
- [ ] **Step 8: commit** — `feat: grant and record bound task-space recreation across exchange, capture and reconciliation`.
- [ ] **Step 9: restart commit fix (spec Part C)** — in `#runEgoExchange`, close the `if (!result)` block after the staged/monolithic capture and run the capture-commit tail under `if (result && !result.responseRef)` so a restart-recovered response is stored and committed. Commit `fix: commit a response recovered by restart reconciliation`.

### Task 4: driver tests (`test/ego-adapter.test.mjs`)

Harness knobs: `runPreSendDriverCase` (line 329; `listedTaskSpaces`-style options, `taskSpaceDriftAtFence`, `rawTaskSpaceGuard`), `runTaskSpaceReconciliationCase` (line 1360; `taskSpaceIdentity`, `listedTaskSpaces`, `duplicateIdentity`), `runBoundHeadDriverCase` (line 761). Add a `taskSpaceRecovery` input option and a `useOrCreateTaskSpace` fake that appends a Space `{ id: <fresh>, name, taskId: name, ownership: "agent" }` to the listed Spaces and counts creations.

- [ ] **Step 1** — rewrite "an established identity that disappears cannot fall through to a replacement workspace" (line 3550) into "a vanished bound task space is reported as missing without recreation authority": expect `bound_task_space_missing`, `details.recreatable === true`, zero creations, zero selections.
- [ ] **Step 2** — "a granted recreation recreates the recorded identity, reopens the canonical conversation and reports the recovery": `taskSpaceRecovery: { allowRecreate: true }`, expect one creation with the identity name, the result `taskSpaceId` equal to the new id, `taskSpaceIdentity` unchanged, `taskSpaceRecovery` equal to `{ method: "recreate", previousTaskSpaceId, taskSpaceId }`, one `openOrReuseTab` navigation to the canonical URL, and for `exchange` mode with `exchangeStage: "send_only"` a completed Send (existing counters).
- [ ] **Step 3** — opaque identity (`taskId` differs from `name`) missing with authority: unchanged `bound_task_space_identity_changed`, zero creations. Name-only conflict present with authority: unchanged `bound_task_space_identity_conflict`, zero creations.
- [ ] **Step 4** — Space removed at each `taskSpaceDriftAtFence` value (missing rather than renamed) in exchange mode: `bound_task_space_missing`, zero mouse events. Renamed drift keeps `bound_task_space_identity_changed` (existing test at line 2732 unchanged).
- [ ] **Step 5** — `verify` and `capture_exchange` recreation succeed with `taskSpaceRecovery` in the result; `adopt` and `bind` ignore `allowRecreate` (no creation, existing reasons).
- [ ] **Step 6** — guard: a granted recreation whose identity is in `deniedIdentities` fails with `task_space_identity_already_bound` after creation is refused (assert zero creations by checking the guard before the mutation, as the existing creation branch does).
- [ ] **Step 7: commit** — `test: cover bound task-space recreation in the browser driver`.

### Task 5: broker tests (`test/store-broker.test.mjs`)

Use `new Broker({ ..., recoveryDelaysMs: [0], boundTaskSpaceRecreateDelayMs: 0 })` for the granted cases and a positive delay with a `lastRecovery.at` in the future to prove the flag is withheld.

- [ ] **Step 1** — pre-Send loop: fake `sendExchange` throws `human_required` / `bound_task_space_missing` while `params.taskSpaceRecovery` is undefined, then returns a result carrying `taskSpaceRecovery` once the flag arrives; assert `recoveryCount`, `lastRecovery.code`, `workflow.taskSpaceRecovery`, `private.send` not exposed, binding `taskSpaceId` re-recorded, a `binding.task_space_recovered` event in the store, and that `bound_task_space_identity_changed` never appears.
- [ ] **Step 2** — capture loop: `captureExchange` throws `bound_task_space_missing` once, then succeeds with a recovery record; assert `captureRecoveryCount`, the flag in the second call, `result.taskSpaceRecovery`.
- [ ] **Step 3** — restart reconciliation: a `browser_owned` workflow recovered after `initialize()` whose `reconcileBound` throws `bound_task_space_missing` then succeeds; assert the flag and the workflow field.
- [ ] **Step 4** — `verifyConversation` and `reconcileConversation` pass `allowRecreate: true` immediately and surface the record.
- [ ] **Step 5** — Part B: `sendExchange` throws `new EgoChatError("ego_driver_error", ..., { driverStage: "selecting_conversation" })` twice then succeeds: `recoveryCount === 2`, `lastRecovery.driverStage`; the same with `driverStage: "verifying_composed_prompt"` and no `draftCleared`: `human_required` / `browser_operation_interrupted_before_send_confirmation`; `reconcileConversation` with a stored `browserInterruption` at `selecting_conversation` proves absence (`allowDeliveryAbsent`).
- [ ] **Step 6: commit** — `test: cover task-space recreation authority and pre-composition retry in the broker`.

### Task 6: documentation

- [ ] README: replace the "Further work remains on same-chat recovery after complete loss of an established browser Space" clause; extend the numeric-location paragraph ("Persistent conversation") with the recreation rule and the opaque-identity limit; add "a vanished Ego-Chat-named Space (recreated after a short delay)" to the recovery-states sentence under "Current-host-owned convergence".
- [ ] CONTINUITY.md recovery model line 45: reclaimed automatically and recreated by name after it vanishes.
- [ ] `skills/ego-chat/SKILL.md` "Browser ownership and concurrent use": add the vanished-Space recovery state; `src/mcp-server.mjs` MCP_INSTRUCTIONS task-space sentence likewise.
- [ ] Commit `docs: describe bound task-space recreation and pre-composition retry`.

### Task 7: verification and review

- [ ] `npm run lint`, `npm test` (695 + new), `cargo fmt --check`, `cargo clippy --all-targets`, `cargo test`.
- [ ] `git fetch origin main:main && codex review --base main`; on a quota message (`hit your usage limit`, `5-hour message limit`, `rate limit`, `too many requests`, `429`) run `glm-review --base main` and record that GLM saw only the diff. Fix confirmed findings with their own commits and re-run until nothing actionable remains.
- [ ] Record the evidence in this file's Evidence section.

### Task 8: pull request, merge, install, live qualification

- [ ] Push, open the PR into `main` with summary and verification, merge with a merge commit, `git pull --ff-only` in the main checkout.
- [ ] Confirm `ego-chat broker-status` shows no running workflow, then `cargo install --path . --locked`, `ego-chat setup-claude` (reinstalls the runtime and hands off the broker; the browser contract changed), `ego-chat doctor && ego-chat doctor-zcode && ego-chat doctor-claude`, refresh skill copies with the `install-*-skill --force` commands if a doctor reports drift. Restart Claude Code sessions afterwards.
- [ ] Live qualification on `claude-code-live-check` (spec "Testing"), then record the observed `workflow_status` and ledger events here.
- [ ] Remove the worktree and local branch.

### Task 9: release 0.2.23

- [ ] Branch `chore/release-0.2.23` from `main`: bump `Cargo.toml`, `Cargo.lock` (package entry), `package.json`, both `package-lock.json` occurrences, `APP_VERSION` in `src/constants.mjs`; rewrite the README "Release verification" paragraph and install command for 0.2.23; `cargo test` (the version test), `npm test`, `cargo package --list`, `cargo publish --dry-run --locked`; commit `chore: release ego-chat 0.2.23`.
- [ ] PR, merge, `git pull --ff-only`, annotated tag `v0.2.23` ("Ego Chat v0.2.23") on the merge commit, push the tag.
- [ ] `cargo publish --locked` from the tagged commit; compute the crate SHA-256 from `target/package/ego-chat-0.2.23.crate`; create the GitHub release "Ego Chat v0.2.23" with Changes, Verification, crate digest, qualification limits and upgrade commands, following the v0.2.22 layout.
- [ ] Reinstall locally from the tagged `main` (`cargo install --path . --locked`) or from crates.io, run the three doctors, confirm `ego-chat broker-status` reports runtime `0.2.23`.

## Evidence

(appended as tasks complete)

Recorded 2026-09-10 on the development Mac, branch `feature/space-recovery-presend-retry` at the commits listed by `git log main..HEAD`.

Deterministic suites: `npm run lint` exit 0; `npm test` 718 tests, 717 pass, 0 fail, 1 skipped (the long MCP lane, as on `main`); `cargo fmt --check` clean; `cargo clippy --all-targets` zero warnings; `cargo test` 33 passed. New coverage: 11 driver cases in `test/ego-adapter.test.mjs` (175 in the file) and 12 broker cases in `test/store-broker.test.mjs` (198 in the file). The committed A3K public-boundary fixture was regenerated with `node test/fixtures/build-a3k-public-boundary-v1.mjs test/fixtures` because the producer contract hashes `src/constants.mjs`.

Two defects surfaced during the work and were fixed on the branch: a response found by restart reconciliation was never committed (spec Part C; the ledger has no `response_capture_state_invalid` record, so it had never happened live), and the first Codex pass found that a Space vanishing after the Send click would have been retried as pre-Send; it is now reported as `send_confirmation_ambiguous` with `taskSpaceMissing: true` and covered by a driver regression.
