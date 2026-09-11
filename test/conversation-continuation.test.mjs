import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  activeConvergenceBindingKey,
  buildContinuationCheckpoint,
  buildConvergenceResume,
  buildSuccessorPreparation,
  convergenceReviewIdentity,
  publicContinuationCheckpoint,
  validateContinuationCheckpoint,
  validateConvergenceContinuationLineage,
} from "../src/conversation-continuation.mjs"
import { canonicalJsonBytes } from "../src/attachment-execution-receipt.mjs"
import { createContract, digestJson } from "../src/convergence.mjs"
import { MAX_REVIEW_PACKET_BYTES } from "../src/constants.mjs"
import { EventStore } from "../src/store.mjs"

// Mirrors the private checkpointDigest helper: canonicalize, drop `digest`, sha256.
// Used to synthesize a pre-0.2.29 checkpoint record that never carried
// priorReviewSummary, with a digest computed the way it always was.
function legacyDigest(checkpoint) {
  const payload = { ...checkpoint }
  delete payload.digest
  return createHash("sha256").update(canonicalJsonBytes(payload)).digest("hex")
}

const NOW = "2026-09-08T10:00:00.000Z"
const PARENT_ID = "383f31a4-43db-4672-a6c7-c1369a81ecb6"
const CHILD_ID = "962c26c0-9238-467f-a2f7-e1a902f9b878"

function fixture() {
  const contract = createContract("Private target must not enter public status.", ["Verified evidence remains exact."])
  const candidate = {
    blockers: [],
    criteria: [{ id: "AC-1", status: "pass", evidence: "Private evidence." }],
    reviewPacket: "Private review packet.",
    status: "candidate",
    summary: "Private candidate.",
  }
  const binding = {
    key: "original-chat", canonicalUrl: "https://chatgpt.com/c/original", state: "bound",
    revision: 2, headFingerprint: "a".repeat(64), headContentDigest: "b".repeat(64),
    headMessageId: "assistant-original", headRole: "assistant", headFingerprintVersion: "tail-v1",
    taskSpaceIdentity: { name: "original-space", taskId: "original-space" }, taskSpaceId: 1,
    targetId: "original-tab", projectUrl: null,
  }
  const successorBinding = {
    ...binding, key: "successor-chat", canonicalUrl: "https://chatgpt.com/c/successor", revision: 1,
    taskSpaceIdentity: { name: "successor-space", taskId: "successor-space" }, taskSpaceId: 2,
    targetId: "successor-tab",
  }
  const identity = convergenceReviewIdentity(PARENT_ID, 1)
  const child = {
    id: CHILD_ID, kind: "ego_exchange", bindingKey: binding.key,
    operationKey: `exchange:${binding.key}:${identity.turnMarker}`, inputDigest: "c".repeat(64),
    phase: "provider_paused", status: "human_required", createdAt: NOW, updatedAt: NOW,
    humanRequired: { code: "chatgpt_conversation_exhausted" },
    providerTerminal: {
      schema: "ego-chat-provider-terminal/v1", kind: "conversation_exhausted", source: "latest_turn_status",
      signalDigest: "d".repeat(64), stableObservations: 2, observedAt: NOW,
    },
    reconciliation: { turnMarker: identity.turnMarker, expectedTerminalMarker: identity.terminalMarker },
    private: { send: { canonicalUrl: binding.canonicalUrl, sentAt: NOW } },
  }
  const workflow = {
    id: PARENT_ID, kind: "convergence", bindingKey: binding.key,
    status: "running", phase: "chatgpt_running", cycle: 1, childWorkflowId: child.id,
    candidateDigest: digestJson(candidate), targetDigest: contract.targetDigest,
    createdAt: NOW, updatedAt: NOW, deadlineAt: "2026-09-08T18:00:00.000Z",
    cwd: "/private/example", codexSandbox: "read-only", codexThreadId: "local-thread", maxCycles: null,
    private: {
      contract, cycles: [{ cycle: 1, candidate, candidateDigest: digestJson(candidate) }], priorReview: null,
      request: { bindingKey: binding.key, cwd: "/private/example", target: contract.target },
    },
  }
  return { workflow, child, binding, successorBinding }
}

function pausedFixture() {
  const value = fixture()
  const checkpoint = buildContinuationCheckpoint({ ...value, at: NOW })
  value.workflow = {
    ...value.workflow, status: "human_required", phase: "continuation_paused",
    humanRequired: { code: "chatgpt_conversation_exhausted" },
    private: { ...value.workflow.private, continuationCheckpoint: checkpoint },
  }
  return { ...value, checkpoint }
}

test("capacity checkpoint authorizes no action, stays private, and resumes one exact successor", () => {
  const value = pausedFixture()
  const original = structuredClone(value)
  const publicReceipt = publicContinuationCheckpoint(value.checkpoint)
  assert.equal(JSON.stringify(publicReceipt).includes("Private"), false)
  assert.equal(JSON.stringify(publicReceipt).includes("chatgpt.com"), false)
  assert.equal(publicReceipt.checkpointDigest, value.checkpoint.digest)
  const resumed = buildConvergenceResume({
    ...value, expectedCheckpointDigest: value.checkpoint.digest,
    acknowledgeConversationChange: true, at: NOW,
  })
  assert.equal(resumed.workflow.id, value.workflow.id)
  assert.equal(resumed.workflow.bindingKey, "original-chat")
  assert.equal(activeConvergenceBindingKey(resumed.workflow), "successor-chat")
  assert.equal(resumed.workflow.activeChat.generation, 1)
  assert.equal(resumed.workflow.phase, "codex_captured")
  assert.equal(resumed.workflow.status, "running")
  assert.equal(resumed.workflow.cycle, 1)
  assert.equal(resumed.workflow.childWorkflowId, undefined)
  assert.deepEqual(resumed.workflow.private.cycles, value.workflow.private.cycles)
  assert.deepEqual(value, original)
})

test("buildContinuationCheckpoint carries a redacted, bounded prior review summary and null when there is none", () => {
  const nullCase = fixture()
  const nullCheckpoint = buildContinuationCheckpoint({ ...nullCase, at: NOW })
  assert.equal(nullCheckpoint.priorReviewSummary, null)

  const withReview = fixture()
  withReview.workflow = {
    ...withReview.workflow,
    private: {
      ...withReview.workflow.private,
      priorReview: {
        criteria: [], decision: "continue", findings: [],
        summary: `One more pass is needed. Secret: AKIAABCDEFGHIJKLMNOP should never leave the broker.`,
      },
    },
  }
  const checkpoint = buildContinuationCheckpoint({ ...withReview, at: NOW })
  assert.equal(typeof checkpoint.priorReviewSummary, "string")
  assert.ok(checkpoint.priorReviewSummary.length <= 4_000)
  assert.match(checkpoint.priorReviewSummary, /One more pass is needed\./)
  assert.equal(checkpoint.priorReviewSummary.includes("AKIAABCDEFGHIJKLMNOP"), false)
  assert.equal(validateContinuationCheckpoint(checkpoint).priorReviewSummary, checkpoint.priorReviewSummary)
})

test("validateContinuationCheckpoint accepts a pre-0.2.29 checkpoint without a prior-review summary field", () => {
  const value = pausedFixture()
  const legacy = { ...value.checkpoint }
  delete legacy.priorReviewSummary
  legacy.digest = legacyDigest(legacy)
  const validated = validateContinuationCheckpoint(legacy)
  assert.equal(Object.hasOwn(validated, "priorReviewSummary"), false)
  assert.equal(validated.digest, legacy.digest)
})

test("successor continuation requires explicit authority and exact immutable checkpoint", () => {
  const value = pausedFixture()
  assert.throws(() => buildConvergenceResume({ ...value, expectedCheckpointDigest: value.checkpoint.digest, at: NOW }))
  assert.throws(() => buildConvergenceResume({ ...value, expectedCheckpointDigest: "f".repeat(64), acknowledgeConversationChange: true, at: NOW }))
  value.workflow.private.cycles[0].candidate.reviewPacket = "changed"
  assert.throws(() => validateContinuationCheckpoint(value.checkpoint, value))
})

test("Project title slugs preserve the same stable Project identity in continuation evidence", () => {
  const value = fixture()
  const project = "g-p-0123456789abcdef0123456789abcdef"
  value.binding.canonicalUrl = `https://chatgpt.com/g/${project}-ego-chat/c/original`
  value.binding.projectUrl = `https://chatgpt.com/g/${project}/project`
  value.child.private.send.canonicalUrl = value.binding.canonicalUrl
  const checkpoint = buildContinuationCheckpoint({ ...value, at: NOW })
  assert.equal(checkpoint.binding.projectScope, project)
})

for (const state of ["dispatched", "prepared"]) {
  test(`resume consumes ${state} preparation so the next exhausted generation can prepare again`, () => {
    const value = pausedFixture()
    const prior = buildSuccessorPreparation({
      ...value, expectedCheckpointDigest: value.checkpoint.digest, acknowledgeNewChat: true, at: NOW,
    })
    value.workflow.private.successorPreparation = {
      ...prior, state, ...(state === "prepared" ? { preparedBinding: value.successorBinding } : {}),
    }
    const resumed = buildConvergenceResume({
      ...value, expectedCheckpointDigest: value.checkpoint.digest,
      acknowledgeConversationChange: true, at: NOW,
    }).workflow
    const identity = convergenceReviewIdentity(PARENT_ID, 1, 1)
    const child = {
      ...value.child, id: "f998efc2-f1b4-4e89-87ce-153d75f0cc7f", bindingKey: value.successorBinding.key,
      operationKey: `exchange:${value.successorBinding.key}:${identity.turnMarker}`,
      reconciliation: { turnMarker: identity.turnMarker, expectedTerminalMarker: identity.terminalMarker },
      private: { send: { canonicalUrl: value.successorBinding.canonicalUrl, sentAt: NOW } },
    }
    const running = { ...resumed, phase: "chatgpt_running", childWorkflowId: child.id }
    const checkpoint = buildContinuationCheckpoint({ workflow: running, child, binding: value.successorBinding, at: NOW })
    const workflow = {
      ...running, status: "human_required", phase: "continuation_paused",
      humanRequired: { code: "chatgpt_conversation_exhausted" },
      private: { ...running.private, continuationCheckpoint: checkpoint },
    }
    const next = buildSuccessorPreparation({
      workflow, child, binding: value.successorBinding, expectedCheckpointDigest: checkpoint.digest,
      acknowledgeNewChat: true, at: NOW,
    })
    assert.notEqual(next.bindingKey, prior.bindingKey)
    assert.equal(resumed.private.successorPreparation, undefined)
  })
}

test("same-binding resume consumes only the exact reconciled committed response", () => {
  const value = pausedFixture()
  const responseText = "The independently recovered response."
  const responseDigest = createHash("sha256").update(responseText).digest("hex")
  value.binding = {
    ...value.binding, revision: 3, headFingerprint: "e".repeat(64),
    headContentDigest: responseDigest, headMessageId: "recovered-assistant",
  }
  value.child = {
    ...value.child, status: "succeeded", phase: "head_committed",
    result: {
      canonicalUrl: value.binding.canonicalUrl, reconciled: true, responseDigest, responseText,
      head: {
        fingerprint: value.binding.headFingerprint, lastContentDigest: responseDigest,
        lastMessageId: value.binding.headMessageId,
      },
    },
  }
  const input = { ...value, successorBinding: undefined, expectedCheckpointDigest: value.checkpoint.digest, at: NOW }
  const resumed = buildConvergenceResume(input)
  assert.equal(resumed.workflow.phase, "chatgpt_running")
  assert.equal(resumed.workflow.childWorkflowId, CHILD_ID)
  assert.equal(activeConvergenceBindingKey(resumed.workflow), value.binding.key)
  assert.equal(resumed.receipt.mode, "same_binding")
  value.child.result.responseText = "tampered"
  assert.throws(() => buildConvergenceResume(input))
})

test("other failed child boundaries preserve checkpoints without authorizing successor rotation", () => {
  for (const [code, kind] of [
    ["chatgpt_stopped_thinking", "stopped"], ["chatgpt_quota_limited", "quota_limited"],
    ["chatgpt_provider_error", "provider_error"], ["authentication_required", null],
    ["completion_timeout_after_confirmed_send", null], ["send_confirmation_ambiguous", null],
    ["inactive_capture_stalled", null], ["cancelled_during_exchange", null],
  ]) {
    const value = fixture()
    value.child.humanRequired.code = code
    if (kind) value.child.providerTerminal.kind = kind
    else delete value.child.providerTerminal
    const checkpoint = buildContinuationCheckpoint({ ...value, at: NOW })
    const workflow = {
      ...value.workflow, phase: "continuation_paused", status: "human_required",
      humanRequired: { code }, private: { ...value.workflow.private, continuationCheckpoint: checkpoint },
    }
    assert.deepEqual(publicContinuationCheckpoint(checkpoint).allowedActions, [])
    assert.throws(() => buildConvergenceResume({
      ...value, workflow, expectedCheckpointDigest: checkpoint.digest,
      acknowledgeConversationChange: true, at: NOW,
    }), code)
    assert.throws(() => buildSuccessorPreparation({
      ...value, workflow, expectedCheckpointDigest: checkpoint.digest,
      acknowledgeNewChat: true, at: NOW,
    }), code)
  }
})

test("checkpoint validation rejects unsupported fields, corruption, accessors, and malformed source identity", () => {
  const value = pausedFixture()
  for (const change of [
    (copy) => { copy.extra = true },
    (copy) => { copy.source.inputDigest = "x" },
    (copy) => { copy.contract.target = "replaced" },
    (copy) => { copy.source.providerTerminal.stableObservations = 1 },
    (copy) => { copy.binding.canonicalUrl = "https://chatgpt.com/c/WEB:temporary" },
    (copy) => { copy.generation = 999 },
    (copy) => { copy.priorReviewSummary = "A tampered carried-context summary." },
  ]) {
    const copy = structuredClone(value.checkpoint)
    change(copy)
    assert.throws(() => validateContinuationCheckpoint(copy))
  }
  let invoked = false
  const hostile = { ...value.checkpoint }
  Object.defineProperty(hostile, "contract", { enumerable: true, get() { invoked = true; return value.checkpoint.contract } })
  assert.throws(() => validateContinuationCheckpoint(hostile))
  assert.equal(invoked, false)
  const unrelated = structuredClone(value.child)
  unrelated.operationKey = "exchange:someone-else:MARKER"
  assert.throws(() => validateContinuationCheckpoint(value.checkpoint, { child: unrelated }))
})

test("successor validation rejects partial identity overlap, unbound locators, and cross-project scope", () => {
  for (const change of [
    (copy, value) => { copy.taskSpaceIdentity.taskId = value.binding.taskSpaceIdentity.taskId },
    (copy, value) => { copy.taskSpaceIdentity.name = value.binding.taskSpaceIdentity.name },
    (copy, value) => { copy.canonicalUrl = value.binding.canonicalUrl },
    (copy) => { copy.state = "unbound" },
    (copy) => { copy.canonicalUrl = "https://chatgpt.com/c/WEB:temporary" },
    (copy) => { copy.projectUrl = "https://chatgpt.com/g/g-p-other/project" },
    (copy) => { copy.canonicalUrl = "https://chatgpt.com/g/g-p-other/c/successor" },
  ]) {
    const value = pausedFixture()
    change(value.successorBinding, value)
    assert.throws(() => buildConvergenceResume({
      ...value, expectedCheckpointDigest: value.checkpoint.digest,
      acknowledgeConversationChange: true, at: NOW,
    }))
  }
})

test("generation-zero markers remain compatible and successor markers are distinct and deterministic", () => {
  const token = digestJson({ cycle: 1, purpose: "review", workflowId: PARENT_ID }).slice(0, 32).toUpperCase()
  assert.equal(convergenceReviewIdentity(PARENT_ID, 1).turnMarker, `EGO_CHAT_CONVERGENCE_${token}_C1`)
  assert.notDeepEqual(convergenceReviewIdentity(PARENT_ID, 1, 1), convergenceReviewIdentity(PARENT_ID, 1))
  assert.deepEqual(convergenceReviewIdentity(PARENT_ID, 1, 1), convergenceReviewIdentity(PARENT_ID, 1, 1))
})

test("maximum supported candidate packets survive checkpoint and resume despite JSON escaping", () => {
  for (const character of ["x", '"', "\u0000"]) {
    const value = fixture()
    const record = value.workflow.private.cycles[0]
    record.candidate.reviewPacket = character.repeat(MAX_REVIEW_PACKET_BYTES)
    record.candidateDigest = digestJson(record.candidate)
    value.workflow.candidateDigest = record.candidateDigest
    const checkpoint = buildContinuationCheckpoint({ ...value, at: NOW })
    assert.equal(checkpoint.candidate.reviewPacket.length, MAX_REVIEW_PACKET_BYTES)
    assert.ok(JSON.stringify(publicContinuationCheckpoint(checkpoint)).length < 1024)
    value.workflow = {
      ...value.workflow, status: "human_required", phase: "continuation_paused",
      private: { ...value.workflow.private, continuationCheckpoint: checkpoint },
    }
    const { workflow } = buildConvergenceResume({
      ...value, expectedCheckpointDigest: checkpoint.digest,
      acknowledgeConversationChange: true, at: NOW,
    })
    assert.equal(workflow.phase, "codex_captured")
    assert.equal(workflow.private.cycles[0].candidate.reviewPacket, record.candidate.reviewPacket)
  }
})

test("resume receipt pins the selected canonical URL and binding revision", () => {
  const value = pausedFixture()
  const input = { ...value, expectedCheckpointDigest: value.checkpoint.digest, acknowledgeConversationChange: true, at: NOW }
  const first = buildConvergenceResume(input)
  assert.equal(first.receipt.bindingRevision, value.successorBinding.revision)
  assert.equal(first.receipt.canonicalUrlDigest, createHash("sha256").update(value.successorBinding.canonicalUrl).digest("hex"))
  value.successorBinding.revision += 1
  assert.notEqual(buildConvergenceResume(input).receipt.requestDigest, first.receipt.requestDigest)
  value.successorBinding.canonicalUrl = "https://chatgpt.com/c/changed-successor"
  assert.notEqual(buildConvergenceResume(input).receipt.requestDigest, first.receipt.requestDigest)
})

test("lineage validation binds active generation to its original-to-successor history", () => {
  const value = pausedFixture()
  const { workflow } = buildConvergenceResume({
    ...value, expectedCheckpointDigest: value.checkpoint.digest,
    acknowledgeConversationChange: true, at: NOW,
  })
  assert.equal(validateConvergenceContinuationLineage(workflow), true)
  assert.equal(validateConvergenceContinuationLineage(fixture().workflow), true)
  for (const change of [
    (copy) => { copy.activeChat.bindingKey = "unrelated-chat" },
    (copy) => { copy.activeChat.generation = 2 },
    (copy) => { copy.private.chatGenerations = [] },
    (copy) => { copy.private.chatGenerations[0].predecessor.key = "unrelated-chat" },
    (copy) => { copy.private.chatGenerations[0].source.reason = "chatgpt_stopped_thinking" },
    (copy) => { copy.private.chatGenerations[0].receipt.requestDigest = "f".repeat(64) },
    (copy) => { copy.continuationResume.bindingRevision += 1 },
  ]) {
    const copy = structuredClone(workflow)
    change(copy)
    assert.throws(() => validateConvergenceContinuationLineage(copy))
  }
  assert.equal(validateConvergenceContinuationLineage({ ...workflow, status: "succeeded", private: undefined }), true)
})

test("a later same-binding receipt retains the established successor lineage", () => {
  const value = pausedFixture()
  const { workflow } = buildConvergenceResume({
    ...value, expectedCheckpointDigest: value.checkpoint.digest,
    acknowledgeConversationChange: true, at: NOW,
  })
  const receipt = {
    ...workflow.continuationResume, mode: "same_binding", checkpointDigest: "e".repeat(64),
    bindingRevision: 5, sourceChildWorkflowId: "1718258c-b012-408e-bab2-5ff2bdc047ca",
    resumedAt: "2026-09-08T10:10:00.000Z",
  }
  receipt.requestDigest = digestJson({
    checkpointDigest: receipt.checkpointDigest, bindingKey: receipt.bindingKey,
    bindingRevision: receipt.bindingRevision, canonicalUrlDigest: receipt.canonicalUrlDigest,
    generation: receipt.generation, mode: receipt.mode,
  })
  workflow.continuationResume = receipt
  assert.equal(validateConvergenceContinuationLineage(workflow), true)
  receipt.canonicalUrlDigest = "0".repeat(64)
  assert.throws(() => validateConvergenceContinuationLineage(workflow))
})

test("two successor generations retain one continuous lineage and cannot recycle an old chat", () => {
  const value = pausedFixture()
  const first = buildConvergenceResume({
    ...value, expectedCheckpointDigest: value.checkpoint.digest,
    acknowledgeConversationChange: true, at: NOW,
  })
  const identity = convergenceReviewIdentity(PARENT_ID, 1, 1)
  const child = {
    ...value.child, id: "bfdfbc3e-69d1-42b2-bc17-b4e0c9095526", bindingKey: value.successorBinding.key,
    operationKey: `exchange:${value.successorBinding.key}:${identity.turnMarker}`,
    reconciliation: { turnMarker: identity.turnMarker, expectedTerminalMarker: identity.terminalMarker },
    private: { send: { canonicalUrl: value.successorBinding.canonicalUrl, sentAt: NOW } },
  }
  const workflow = { ...first.workflow, phase: "chatgpt_running", childWorkflowId: child.id }
  const checkpoint = buildContinuationCheckpoint({ workflow, child, binding: value.successorBinding, at: NOW })
  const paused = {
    ...workflow, status: "human_required", phase: "continuation_paused",
    humanRequired: { code: "chatgpt_conversation_exhausted" },
    private: { ...workflow.private, continuationCheckpoint: checkpoint },
  }
  const successorBinding = {
    ...value.successorBinding, key: "third-chat", canonicalUrl: "https://chatgpt.com/c/third",
    taskSpaceIdentity: { name: "third-space", taskId: "third-space" }, targetId: "third-tab", taskSpaceId: 3,
  }
  const input = {
    workflow: paused, child, binding: value.successorBinding, successorBinding,
    expectedCheckpointDigest: checkpoint.digest, acknowledgeConversationChange: true, at: NOW,
  }
  const second = buildConvergenceResume(input)
  assert.equal(second.workflow.activeChat.generation, 2)
  assert.equal(validateConvergenceContinuationLineage(second.workflow), true)
  const corrupt = structuredClone(second.workflow)
  corrupt.private.chatGenerations[1].predecessor.canonicalUrl = "https://chatgpt.com/c/broken-chain"
  assert.throws(() => validateConvergenceContinuationLineage(corrupt))
  assert.throws(() => buildConvergenceResume({ ...input, successorBinding: value.binding }))
})

test("the store durably reserves exactly one successor and preserves old records", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ego-continuation-"))
  t.after(() => fs.rm(directory, { recursive: true, force: false }))
  const store = new EventStore(directory)
  await store.initialize()
  const value = pausedFixture()
  await store.persistBinding("binding.created", value.binding)
  await store.persistBinding("binding.created", value.successorBinding)
  await store.persist("workflow.started", value.child)
  await store.persist("workflow.started", value.workflow)
  const input = {
    expectedWorkflow: value.workflow, expectedChild: value.child, expectedBinding: value.binding,
    expectedSuccessorBinding: value.successorBinding, expectedCheckpointDigest: value.checkpoint.digest,
    acknowledgeConversationChange: true, at: NOW,
  }
  const results = await Promise.all([store.persistConvergenceResume(input), store.persistConvergenceResume(input)])
  assert.deepEqual(results.map(({ created }) => created).sort(), [false, true])
  assert.deepEqual(store.getBinding(value.binding.key), value.binding)
  assert.deepEqual(store.getWorkflow(value.child.id), value.child)
  const restarted = new EventStore(directory)
  await restarted.initialize()
  assert.equal(activeConvergenceBindingKey(restarted.getWorkflow(value.workflow.id)), value.successorBinding.key)
})

test("resume CAS rejects any changed participant without mutating the paused parent", async (t) => {
  for (const changed of ["parent", "child", "binding", "successor"]) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ego-continuation-cas-"))
    t.after(() => fs.rm(directory, { recursive: true, force: false }))
    const store = new EventStore(directory)
    await store.initialize()
    const value = pausedFixture()
    await store.persistBinding("binding.created", value.binding)
    await store.persistBinding("binding.created", value.successorBinding)
    await store.persist("workflow.started", value.child)
    await store.persist("workflow.started", value.workflow)
    if (changed === "parent") await store.persist("workflow.changed", { ...value.workflow, updatedAt: "2026-09-08T10:00:01.000Z" })
    if (changed === "child") await store.persist("workflow.changed", { ...value.child, updatedAt: "2026-09-08T10:00:01.000Z" })
    if (changed === "binding") await store.persistBinding("binding.changed", { ...value.binding, revision: 3 })
    if (changed === "successor") await store.persistBinding("binding.changed", { ...value.successorBinding, revision: 2 })
    const before = store.getWorkflow(PARENT_ID)
    await assert.rejects(store.persistConvergenceResume({
      expectedWorkflow: value.workflow, expectedChild: value.child, expectedBinding: value.binding,
      expectedSuccessorBinding: value.successorBinding, expectedCheckpointDigest: value.checkpoint.digest,
      acknowledgeConversationChange: true, at: NOW,
    }), { code: "continuation_transition_conflict" })
    assert.deepEqual(store.getWorkflow(PARENT_ID), before)
  }
})

test("resume snapshots caller state before queueing and conflicting successor requests cannot replace the receipt", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ego-continuation-snapshot-"))
  t.after(() => fs.rm(directory, { recursive: true, force: false }))
  const store = new EventStore(directory)
  await store.initialize()
  const value = pausedFixture()
  await store.persistBinding("binding.created", value.binding)
  await store.persistBinding("binding.created", value.successorBinding)
  await store.persist("workflow.started", value.child)
  await store.persist("workflow.started", value.workflow)
  const input = {
    expectedWorkflow: value.workflow, expectedChild: value.child, expectedBinding: value.binding,
    expectedSuccessorBinding: value.successorBinding, expectedCheckpointDigest: value.checkpoint.digest,
    acknowledgeConversationChange: true, at: NOW,
  }
  const running = store.persistConvergenceResume(input)
  input.expectedSuccessorBinding.key = "caller-mutated"
  const result = await running
  assert.equal(activeConvergenceBindingKey(result.workflow), "successor-chat")
  input.expectedSuccessorBinding = { ...input.expectedSuccessorBinding, key: "another-successor" }
  await assert.rejects(store.persistConvergenceResume(input), { code: "continuation_transition_conflict" })
  assert.equal(activeConvergenceBindingKey(store.getWorkflow(PARENT_ID)), "successor-chat")
})

async function recoveredChildRetentionFixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ego-continuation-retention-"))
  t.after(() => fs.rm(directory, { recursive: true, force: false }))
  const limits = { maxEvents: 1, maxTerminalWorkflows: 0, rawRetentionMs: 0, ...options }
  const store = new EventStore(directory, limits)
  await store.initialize()
  const value = pausedFixture()
  await store.persistBinding("binding.created", value.binding)
  await store.persist("workflow.started", value.child)
  await store.persist("workflow.started", value.workflow)
  const responseText = "The exact recovered review remains attributable."
  const responseDigest = createHash("sha256").update(responseText).digest("hex")
  const binding = {
    ...value.binding, revision: 3, headFingerprint: "e".repeat(64),
    headContentDigest: responseDigest, headMessageId: "recovered-review",
  }
  await store.persistBinding("binding.reconciled", binding)
  const responseRef = await store.putBlob(responseText)
  const child = {
    ...value.child, phase: "head_committed", status: "succeeded", updatedAt: "2000-01-01T00:00:00.000Z",
    result: {
      canonicalUrl: binding.canonicalUrl, reconciled: true,
      responseDigest: responseRef.digest, responseRef,
      head: { fingerprint: binding.headFingerprint, lastContentDigest: responseRef.digest, lastMessageId: binding.headMessageId },
    },
  }
  await store.persist("workflow.succeeded", child)
  return { ...value, store, directory, limits, child, binding, responseRef }
}

test("a paused continuation pins its reconciled child and blob through eviction and restart", async (t) => {
  const value = await recoveredChildRetentionFixture(t)
  assert.deepEqual(value.store.getWorkflow(CHILD_ID), value.child)
  assert.equal(value.store.getMetrics().recoveryWorkflowCount, 2)
  assert.equal(value.store.getMetrics().protectedBlobBytes, value.responseRef.sizeBytes)
  const restarted = new EventStore(value.directory, value.limits)
  await restarted.initialize()
  assert.deepEqual(restarted.getWorkflow(CHILD_ID), value.child)
  assert.equal((await restarted.readBlob(value.responseRef, { maxBytes: 1024, offset: 0 })).complete, true)
  const resumed = await restarted.persistConvergenceResume({
    expectedWorkflow: value.workflow, expectedChild: value.child, expectedBinding: value.binding,
    expectedCheckpointDigest: value.checkpoint.digest, at: NOW,
  })
  assert.equal(resumed.workflow.phase, "chatgpt_running")
  assert.deepEqual(restarted.getWorkflow(CHILD_ID), value.child)
  assert.equal(restarted.getMetrics().protectedBlobBytes, value.responseRef.sizeBytes)
  await restarted.persist("convergence.chatgpt_review_captured", { ...resumed.workflow, phase: "review_captured" })
  assert.equal(restarted.getWorkflow(CHILD_ID), undefined)
  assert.equal(restarted.getMetrics().protectedBlobBytes, 0)
  await assert.rejects(restarted.readBlob(value.responseRef, { maxBytes: 1024, offset: 0 }), { code: "result_not_found" })
})

test("continuation dependency pins count against bounded recovery admission", async (t) => {
  const value = await recoveredChildRetentionFixture(t, { maxRecoveryWorkflows: 2 })
  await assert.rejects(value.store.persist("workflow.started", {
    id: "9e41cd66-321a-4282-9971-e45759929599", kind: "probe", status: "running", createdAt: NOW, updatedAt: NOW,
  }), { code: "recovery_workflow_capacity_exhausted" })
  assert.equal(value.store.getMetrics().recoveryWorkflowCount, 2)
})

test("explicitly abandoned paused parents release their child and blob retention pin", async (t) => {
  const value = await recoveredChildRetentionFixture(t)
  assert.ok(value.store.getWorkflow(CHILD_ID))
  await value.store.persist("workflow.abandoned", {
    ...value.workflow, status: "cancelled", abandonment: { acknowledgedAt: NOW },
  })
  assert.equal(value.store.getWorkflow(CHILD_ID), undefined)
  assert.equal(value.store.getMetrics().protectedBlobBytes, 0)
})

test("the current generation child is pinned before its running parent records the child link", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ego-continuation-unlinked-"))
  t.after(() => fs.rm(directory, { recursive: true, force: false }))
  const limits = { maxEvents: 1, maxTerminalWorkflows: 0, rawRetentionMs: 0 }
  const store = new EventStore(directory, limits)
  await store.initialize()
  const value = pausedFixture()
  const { workflow } = buildConvergenceResume({
    ...value, expectedCheckpointDigest: value.checkpoint.digest,
    acknowledgeConversationChange: true, at: NOW,
  })
  assert.equal(workflow.phase, "codex_captured")
  assert.equal(workflow.childWorkflowId, undefined)
  assert.equal(workflow.activeChat.generation, 1)
  await store.persistBinding("binding.created", value.binding)
  await store.persistBinding("binding.created", value.successorBinding)
  await store.persist("workflow.started", value.child)
  await store.persist("convergence.resumed", workflow)
  const identity = convergenceReviewIdentity(workflow.id, workflow.cycle, workflow.activeChat.generation)
  const child = {
    id: "a70ef8a5-04f2-4223-978c-f6dce3b39e2a", kind: "ego_exchange", bindingKey: value.successorBinding.key,
    operationKey: `exchange:${value.successorBinding.key}:${identity.turnMarker}`,
    phase: "send_confirmed", status: "running", createdAt: NOW, updatedAt: NOW,
    reconciliation: { turnMarker: identity.turnMarker, expectedTerminalMarker: identity.terminalMarker },
  }
  await store.persist("workflow.started", child)
  const responseRef = await store.putBlob("The successor review completed before its parent linkage.")
  const succeeded = {
    ...child, phase: "head_committed", status: "succeeded", updatedAt: "2000-01-01T00:00:00.000Z",
    result: { responseDigest: responseRef.digest, responseRef },
  }
  await store.persist("workflow.succeeded", succeeded)
  assert.deepEqual(store.getWorkflow(succeeded.id), succeeded)
  assert.equal(store.getWorkflow(workflow.id).childWorkflowId, undefined)
  assert.equal(store.getMetrics().recoveryWorkflowCount, 3)
  assert.equal(store.getMetrics().protectedBlobBytes, responseRef.sizeBytes)
  const restarted = new EventStore(directory, limits)
  await restarted.initialize()
  assert.deepEqual(restarted.getWorkflow(succeeded.id), succeeded)
  assert.equal((await restarted.readBlob(responseRef, { maxBytes: 1024, offset: 0 })).complete, true)

  const anotherCycle = convergenceReviewIdentity(workflow.id, workflow.cycle + 1, workflow.activeChat.generation)
  const unrelated = {
    ...succeeded, id: "fdedfb8b-0bf2-45b0-a1fd-4c2d0f0bb11c", result: undefined,
    operationKey: `exchange:${value.successorBinding.key}:${anotherCycle.turnMarker}`,
    reconciliation: { turnMarker: anotherCycle.turnMarker, expectedTerminalMarker: anotherCycle.terminalMarker },
  }
  await restarted.persist("workflow.succeeded", unrelated)
  assert.equal(restarted.getWorkflow(unrelated.id), undefined)
  assert.deepEqual(restarted.getWorkflow(succeeded.id), succeeded)
  await restarted.persist("convergence.chatgpt_review_captured", {
    ...workflow, phase: "review_captured", childWorkflowId: child.id,
  })
  assert.equal(restarted.getWorkflow(succeeded.id), undefined)
  assert.equal(restarted.getMetrics().protectedBlobBytes, 0)
})
