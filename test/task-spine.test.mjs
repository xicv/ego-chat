import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { Broker } from "../src/broker.mjs"
import { EventStore } from "../src/store.mjs"
import {
  FakeEffectAdapter,
  FakeRemoteImplementer,
  FakeVerificationRunner,
} from "../src/task-fakes.mjs"
import {
  DurableTaskSpine,
  EFFECT_CRASH_POINTS,
  InjectedEffectCrash,
} from "../src/task-spine.mjs"
import { DurableTaskStore } from "../src/task-store.mjs"

const BASE_SHA = "1".repeat(40)
const BASE_TWO = "5".repeat(40)
const HEAD_ONE = "2".repeat(40)
const HEAD_TWO = "3".repeat(40)
const HEAD_THREE = "4".repeat(40)

async function taskEnvironment(t, start = "2026-09-03T00:00:00.000Z") {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ego-chat-task-spine-"))
  await fs.chmod(dataDir, 0o700)
  t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
  let currentTime = new Date(start)
  let sequence = 0
  const clock = () => new Date(currentTime)
  const idFactory = (kind) => `${kind}-${++sequence}`
  const createSpine = async () => {
    const spine = new DurableTaskSpine({
      clock,
      idFactory,
      store: new DurableTaskStore(dataDir),
    })
    await spine.initialize()
    return spine
  }
  return {
    advance(ms) {
      currentTime = new Date(currentTime.getTime() + ms)
    },
    createSpine,
    dataDir,
  }
}

async function createTask(spine) {
  return spine.createConversation({
    acceptanceContract: {
      criteria: ["verify the exact current head", "obtain bound approval"],
      target: "bounded durable runner spine",
    },
    conversationId: "conversation-1",
    taskId: "task-1",
  })
}

test("durable clients reconstruct and attach by conversation cursor without ChatGPT", async (t) => {
  const env = await taskEnvironment(t)
  const firstClient = await env.createSpine()
  const created = await createTask(firstClient)
  const originalDigest = created.conversation.acceptanceContractDigest
  created.conversation.acceptanceContract.target = "caller attempted mutation"

  const reconstructedClient = await env.createSpine()
  const initialAttachment = await reconstructedClient.attachConversation({
    conversationId: "conversation-1",
    cursor: 0,
  })
  assert.equal(initialAttachment.conversation.acceptanceContract.target, "bounded durable runner spine")
  assert.equal(initialAttachment.conversation.acceptanceContractDigest, originalDigest)
  assert.deepEqual(initialAttachment.events.map((event) => event.seq), [1, 2])
  assert.equal(initialAttachment.tasks[0].status, "awaiting_implementation")

  const cursor = initialAttachment.cursor
  const remote = new FakeRemoteImplementer(firstClient)
  const firstArtifact = await remote.publishPullRequest({
    baseSha: BASE_SHA,
    headSha: HEAD_ONE,
    taskId: "task-1",
  })
  const resumedAttachment = await reconstructedClient.attachConversation({
    conversationId: "conversation-1",
    cursor,
  })
  assert.deepEqual(resumedAttachment.events.map((event) => event.type), ["artifact.published"])
  assert.equal(resumedAttachment.tasks[0].currentHeadSha, HEAD_ONE)
  const reconstructedArtifact = await new FakeRemoteImplementer(reconstructedClient).publishPullRequest({
    baseSha: BASE_SHA,
    headSha: HEAD_TWO,
    taskId: "task-1",
  })
  assert.notEqual(reconstructedArtifact.id, firstArtifact.id)
  await assert.rejects(
    reconstructedClient.attachConversation({
      conversationId: "conversation-1",
      cursor: resumedAttachment.cursor + 100,
    }),
    (error) => error.code === "invalid_task_cursor",
  )
})

test("the durable store snapshots commands before its asynchronous transaction queue", async (t) => {
  const env = await taskEnvironment(t)
  const spine = await env.createSpine()
  const acceptanceContract = { target: "original" }
  const requiredEvidenceKinds = ["verification"]
  const pending = spine.createConversation({
    acceptanceContract,
    conversationId: "conversation-1",
    requiredEvidenceKinds,
    taskId: "task-1",
  })
  acceptanceContract.target = "mutated-after-call"
  requiredEvidenceKinds[0] = "implementation"

  const created = await pending
  assert.equal(created.conversation.acceptanceContract.target, "original")
  assert.deepEqual(created.task.requiredEvidenceKinds, ["verification"])
  const reconstructed = await env.createSpine()
  const attachment = await reconstructed.attachConversation({
    conversationId: "conversation-1",
    cursor: 0,
  })
  assert.equal(attachment.conversation.acceptanceContract.target, "original")
  assert.deepEqual(attachment.tasks[0].requiredEvidenceKinds, ["verification"])
})

test("the broker exposes the task spine without coupling it to browser or App Server execution", async (t) => {
  const env = await taskEnvironment(t)
  const firstBroker = new Broker({
    egoAdapter: {},
    store: new EventStore(env.dataDir),
    taskSpine: new DurableTaskSpine({
      store: new DurableTaskStore(env.dataDir),
    }),
  })
  await firstBroker.initialize()
  await createTask(firstBroker.getTaskSpine())
  assert.equal(firstBroker.getStatus().taskSpine.conversationCount, 1)
  firstBroker.close()

  const reconstructedBroker = new Broker({
    egoAdapter: {},
    store: new EventStore(env.dataDir),
    taskSpine: new DurableTaskSpine({
      store: new DurableTaskStore(env.dataDir),
    }),
  })
  await reconstructedBroker.initialize()
  const attachment = await reconstructedBroker.getTaskSpine().attachConversation({
    conversationId: "conversation-1",
    cursor: 0,
  })
  assert.equal(attachment.tasks[0].id, "task-1")
  assert.deepEqual(attachment.events.map((event) => event.seq), [1, 2])
  reconstructedBroker.close()
})

test("an optional task-spine initialization failure does not destabilize the browser broker", async (t) => {
  const env = await taskEnvironment(t)
  const broker = new Broker({
    egoAdapter: {},
    store: new EventStore(env.dataDir),
    taskSpine: {
      async initialize() {
        const error = new Error("deliberately corrupt optional task state")
        error.code = "corrupt_task_state"
        throw error
      },
    },
  })

  await broker.initialize()
  assert.equal(broker.getStatus().store.workflowCount, 0)
  assert.deepEqual(broker.getStatus().taskSpine, {
    errorCode: "corrupt_task_state",
    status: "unavailable",
  })
  assert.throws(
    () => broker.getTaskSpine(),
    (error) => (
      error.code === "task_spine_unavailable"
      && error.details.reasonCode === "corrupt_task_state"
    ),
  )
  broker.close()
})

test("fake implementer and runners enforce exact-head leases with monotonic fencing", async (t) => {
  const env = await taskEnvironment(t)
  const spine = await env.createSpine()
  await createTask(spine)
  const remote = new FakeRemoteImplementer(spine)
  const artifact = await remote.publishPullRequest({
    baseSha: BASE_SHA,
    headSha: HEAD_ONE,
    taskId: "task-1",
  })
  assert.equal(artifact.baseSha, BASE_SHA)
  assert.equal(artifact.headSha, HEAD_ONE)
  assert.equal(artifact.remoteRef.transport, "fake")

  const firstRunner = new FakeVerificationRunner(spine, "runner-1")
  const secondRunner = new FakeVerificationRunner(spine, "runner-2")
  await firstRunner.register()
  await secondRunner.register()
  const firstLease = await firstRunner.lease({
    activityId: "verification-1",
    leaseId: "lease-1",
    taskId: "task-1",
    ttlMs: 1_000,
  })
  assert.equal(firstLease.fencingToken, 1)
  assert.equal(firstLease.headSha, HEAD_ONE)

  env.advance(1_001)
  const secondLease = await secondRunner.lease({
    activityId: "verification-1",
    leaseId: "lease-2",
    taskId: "task-1",
    ttlMs: 1_000,
  })
  assert.equal(secondLease.fencingToken, 2)
  await assert.rejects(
    firstRunner.complete({
      evidence: { command: "npm test", passed: true },
      fencingToken: firstLease.fencingToken,
      leaseId: firstLease.id,
    }),
    (error) => error.code === "stale_fencing_token",
  )

  const completed = await secondRunner.complete({
    evidence: { command: "npm test", passed: true },
    fencingToken: secondLease.fencingToken,
    leaseId: secondLease.id,
  })
  assert.equal(completed.activity.headSha, HEAD_ONE)
  assert.equal(completed.task.status, "waiting_approval")
})

test("forced reassignment increments fencing before the original lease expires", async (t) => {
  const env = await taskEnvironment(t)
  const spine = await env.createSpine()
  await createTask(spine)
  await new FakeRemoteImplementer(spine).publishPullRequest({
    baseSha: BASE_SHA,
    headSha: HEAD_ONE,
    taskId: "task-1",
  })
  const firstRunner = new FakeVerificationRunner(spine, "runner-1")
  const secondRunner = new FakeVerificationRunner(spine, "runner-2")
  await firstRunner.register()
  await secondRunner.register()
  const firstLease = await firstRunner.lease({
    activityId: "verification-1",
    leaseId: "lease-1",
    taskId: "task-1",
    ttlMs: 60_000,
  })
  const replacement = await secondRunner.lease({
    activityId: "verification-1",
    leaseId: "lease-2",
    reassign: true,
    taskId: "task-1",
    ttlMs: 60_000,
  })
  assert.equal(replacement.fencingToken, firstLease.fencingToken + 1)
  await assert.rejects(
    firstRunner.complete({
      evidence: { passed: true },
      fencingToken: firstLease.fencingToken,
      leaseId: firstLease.id,
    }),
    (error) => error.code === "stale_fencing_token",
  )
})

test("retrying failed verification clears old evidence and completes through the latest lease", async (t) => {
  const env = await taskEnvironment(t)
  let spine = await env.createSpine()
  await createTask(spine)
  await new FakeRemoteImplementer(spine).publishPullRequest({
    baseSha: BASE_SHA,
    headSha: HEAD_ONE,
    taskId: "task-1",
  })
  const runner = new FakeVerificationRunner(spine, "runner-1")
  await runner.register()
  const failedLease = await runner.lease({
    activityId: "verification-1",
    leaseId: "lease-1",
    taskId: "task-1",
    ttlMs: 60_000,
  })
  const failed = await runner.complete({
    evidence: { result: "fail" },
    fencingToken: failedLease.fencingToken,
    leaseId: failedLease.id,
    success: false,
  })
  assert.equal(failed.activity.status, "failed")
  assert.equal(failed.activity.completedAt, failed.lease.completedAt)

  const retryLease = await runner.lease({
    activityId: "verification-1",
    leaseId: "lease-2",
    taskId: "task-1",
    ttlMs: 60_000,
  })
  let attachment = await spine.attachConversation({ conversationId: "conversation-1", cursor: 0 })
  let activity = attachment.activities.find((value) => value.id === "verification-1")
  assert.equal(retryLease.fencingToken, failedLease.fencingToken + 1)
  assert.equal(activity.status, "leased")
  assert.equal(activity.evidence, null)
  assert.equal(activity.completedAt, null)

  spine = await env.createSpine()
  const reconstructedRunner = new FakeVerificationRunner(spine, "runner-1")
  const completed = await reconstructedRunner.complete({
    evidence: { result: "pass" },
    fencingToken: retryLease.fencingToken,
    leaseId: retryLease.id,
  })
  assert.equal(completed.activity.status, "succeeded")
  assert.equal(completed.activity.completedAt, completed.lease.completedAt)
  attachment = await spine.attachConversation({ conversationId: "conversation-1", cursor: 0 })
  activity = attachment.activities.find((value) => value.id === "verification-1")
  assert.equal(activity.evidence.value.result, "pass")
  assert.equal(activity.lastFencingToken, 2)
  await env.createSpine()
})

test("fencing remains monotonic across repeated reassignment and reconstruction", async (t) => {
  const env = await taskEnvironment(t)
  let spine = await env.createSpine()
  await createTask(spine)
  await new FakeRemoteImplementer(spine).publishPullRequest({
    baseSha: BASE_SHA,
    headSha: HEAD_ONE,
    taskId: "task-1",
  })
  const first = new FakeVerificationRunner(spine, "runner-1")
  const second = new FakeVerificationRunner(spine, "runner-2")
  await first.register()
  await second.register()
  const leaseOne = await first.lease({
    activityId: "verification-1",
    leaseId: "lease-1",
    taskId: "task-1",
    ttlMs: 60_000,
  })
  const leaseTwo = await second.lease({
    activityId: "verification-1",
    leaseId: "lease-2",
    reassign: true,
    taskId: "task-1",
    ttlMs: 60_000,
  })

  spine = await env.createSpine()
  const reconstructedRunner = new FakeVerificationRunner(spine, "runner-1")
  const leaseThree = await reconstructedRunner.lease({
    activityId: "verification-1",
    leaseId: "lease-3",
    reassign: true,
    taskId: "task-1",
    ttlMs: 60_000,
  })
  assert.deepEqual(
    [leaseOne.fencingToken, leaseTwo.fencingToken, leaseThree.fencingToken],
    [1, 2, 3],
  )
})

test("verification leases require a runner with the declared capability", async (t) => {
  const env = await taskEnvironment(t)
  const spine = await env.createSpine()
  await createTask(spine)
  await new FakeRemoteImplementer(spine).publishPullRequest({
    baseSha: BASE_SHA,
    headSha: HEAD_ONE,
    taskId: "task-1",
  })
  const runner = new FakeVerificationRunner(spine, "runner-1")
  await runner.register(["build"])

  await assert.rejects(
    runner.lease({
      activityId: "verification-1",
      leaseId: "lease-1",
      taskId: "task-1",
      ttlMs: 60_000,
    }),
    (error) => error.code === "runner_capability_missing",
  )
})

test("head changes stale exact-head evidence and approvals before new verification advances", async (t) => {
  const env = await taskEnvironment(t)
  const spine = await env.createSpine()
  await createTask(spine)
  const remote = new FakeRemoteImplementer(spine)
  await remote.publishPullRequest({ baseSha: BASE_SHA, headSha: HEAD_ONE, taskId: "task-1" })
  const runner = new FakeVerificationRunner(spine, "runner-1")
  await runner.register()
  const firstLease = await runner.lease({
    activityId: "verification-1",
    leaseId: "lease-1",
    taskId: "task-1",
    ttlMs: 60_000,
  })
  await runner.complete({
    evidence: { suite: "focused", result: "pass" },
    fencingToken: firstLease.fencingToken,
    leaseId: firstLease.id,
  })
  await spine.recordReview({
    activityId: "review-1",
    baseSha: BASE_SHA,
    evidence: { findingCount: 0 },
    headSha: HEAD_ONE,
    outcome: "accepted",
    taskId: "task-1",
  })
  const approved = await spine.grantApproval({
    approvalId: "approval-1",
    approver: "local-owner",
    baseSha: BASE_SHA,
    evidenceActivityIds: ["verification-1"],
    headSha: HEAD_ONE,
    taskId: "task-1",
  })
  assert.equal(approved.task.status, "ready_to_merge")
  assert.equal(approved.approval.evidenceBindings[0].activityId, "verification-1")

  await remote.publishPullRequest({ baseSha: BASE_SHA, headSha: HEAD_TWO, taskId: "task-1" })
  let attached = await spine.attachConversation({ conversationId: "conversation-1", cursor: 0 })
  assert.equal(attached.tasks[0].status, "waiting_verification")
  assert.equal(attached.activities.find((value) => value.id === "verification-1").status, "stale")
  assert.equal(attached.activities.find((value) => value.id === "review-1").status, "stale")
  assert.equal(attached.approvals[0].status, "stale")
  const updateEvent = attached.events.find((event) => event.type === "artifact.updated")
  assert.deepEqual(updateEvent.data.invalidatedActivityIds.sort(), ["review-1", "verification-1"])
  assert.deepEqual(updateEvent.data.invalidatedApprovalIds, ["approval-1"])

  const currentLease = await runner.lease({
    activityId: "verification-2",
    leaseId: "lease-2",
    taskId: "task-1",
    ttlMs: 60_000,
  })
  const currentVerification = await runner.complete({
    evidence: { suite: "focused", result: "pass" },
    fencingToken: currentLease.fencingToken,
    leaseId: currentLease.id,
  })
  assert.equal(currentVerification.task.status, "waiting_approval")
  const currentApproval = await spine.grantApproval({
    approvalId: "approval-2",
    approver: "local-owner",
    baseSha: BASE_SHA,
    evidenceActivityIds: ["verification-2"],
    headSha: HEAD_TWO,
    taskId: "task-1",
  })
  assert.equal(currentApproval.task.status, "ready_to_merge")

  await remote.publishPullRequest({ baseSha: BASE_SHA, headSha: HEAD_THREE, taskId: "task-1" })
  attached = await spine.attachConversation({ conversationId: "conversation-1", cursor: 0 })
  assert.equal(attached.approvals.find((value) => value.id === "approval-2").status, "stale")
  assert.equal(attached.tasks[0].status, "waiting_verification")
})

test("a base change invalidates evidence and approval even when the head is unchanged", async (t) => {
  const env = await taskEnvironment(t)
  const spine = await env.createSpine()
  await createTask(spine)
  const remote = new FakeRemoteImplementer(spine)
  await remote.publishPullRequest({ baseSha: BASE_SHA, headSha: HEAD_ONE, taskId: "task-1" })
  const runner = new FakeVerificationRunner(spine, "runner-1")
  await runner.register()
  const lease = await runner.lease({
    activityId: "verification-1",
    leaseId: "lease-1",
    taskId: "task-1",
    ttlMs: 60_000,
  })
  await runner.complete({
    evidence: { result: "pass" },
    fencingToken: lease.fencingToken,
    leaseId: lease.id,
  })
  await assert.rejects(
    spine.grantApproval({
      approvalId: "wrong-base-approval",
      approver: "local-owner",
      baseSha: BASE_TWO,
      evidenceActivityIds: ["verification-1"],
      headSha: HEAD_ONE,
      taskId: "task-1",
    }),
    (error) => error.code === "stale_revision_approval",
  )
  await spine.grantApproval({
    approvalId: "approval-1",
    approver: "local-owner",
    baseSha: BASE_SHA,
    evidenceActivityIds: ["verification-1"],
    headSha: HEAD_ONE,
    taskId: "task-1",
  })

  await remote.publishPullRequest({ baseSha: BASE_TWO, headSha: HEAD_ONE, taskId: "task-1" })
  await assert.rejects(
    spine.recordReview({
      activityId: "late-review",
      baseSha: BASE_SHA,
      evidence: { findingCount: 0 },
      headSha: HEAD_ONE,
      outcome: "accepted",
      taskId: "task-1",
    }),
    (error) => error.code === "stale_revision_evidence",
  )
  const attached = await spine.attachConversation({ conversationId: "conversation-1", cursor: 0 })
  assert.equal(attached.tasks[0].currentBaseSha, BASE_TWO)
  assert.equal(attached.tasks[0].status, "waiting_verification")
  assert.equal(attached.activities.find((value) => value.id === "verification-1").status, "stale")
  assert.equal(attached.approvals.find((value) => value.id === "approval-1").status, "stale")
  assert.equal(attached.activities.some((value) => value.id === "late-review"), false)
  const updateEvent = attached.events.findLast((event) => event.type === "artifact.updated")
  assert.equal(updateEvent.data.baseChanged, true)
  assert.equal(updateEvent.data.headChanged, false)

  await assert.rejects(
    runner.complete({
      evidence: { result: "late pass" },
      fencingToken: lease.fencingToken,
      leaseId: lease.id,
    }),
    (error) => error.code === "stale_fencing_token",
  )
})

test("waiting approval requires every configured current-revision evidence kind", async (t) => {
  const env = await taskEnvironment(t)
  const spine = await env.createSpine()
  await spine.createConversation({
    acceptanceContract: { criteria: ["verification", "review"] },
    conversationId: "conversation-1",
    requiredEvidenceKinds: ["verification", "review"],
    taskId: "task-1",
  })
  await new FakeRemoteImplementer(spine).publishPullRequest({
    baseSha: BASE_SHA,
    headSha: HEAD_ONE,
    taskId: "task-1",
  })
  const runner = new FakeVerificationRunner(spine, "runner-1")
  await runner.register()
  const lease = await runner.lease({
    activityId: "verification-1",
    leaseId: "lease-1",
    taskId: "task-1",
    ttlMs: 60_000,
  })
  const verified = await runner.complete({
    evidence: { result: "pass" },
    fencingToken: lease.fencingToken,
    leaseId: lease.id,
  })
  assert.equal(verified.task.status, "waiting_evidence")

  await spine.recordReview({
    activityId: "review-1",
    baseSha: BASE_SHA,
    evidence: { findingCount: 0 },
    headSha: HEAD_ONE,
    outcome: "accepted",
    taskId: "task-1",
  })
  const attached = await spine.attachConversation({ conversationId: "conversation-1", cursor: 0 })
  assert.equal(attached.tasks[0].status, "waiting_approval")
})

test("the immutable settlement contract binds every accepted required evidence kind", async (t) => {
  const env = await taskEnvironment(t)
  let spine = await env.createSpine()
  await assert.rejects(
    spine.createConversation({
      acceptanceContract: { criteria: ["implementation"] },
      conversationId: "unsupported-conversation",
      requiredEvidenceKinds: ["implementation"],
      taskId: "unsupported-task",
    }),
    (error) => error.code === "invalid_task_command",
  )
  const created = await spine.createConversation({
    acceptanceContract: { criteria: ["verification", "review"] },
    conversationId: "conversation-1",
    requiredEvidenceKinds: ["verification", "review"],
    taskId: "task-1",
  })
  assert.equal(created.task.settlementContractDigest.length, 64)
  assert.deepEqual(created.task.settlementContract.requiredEvidenceKinds, ["verification", "review"])
  await new FakeRemoteImplementer(spine).publishPullRequest({
    baseSha: BASE_SHA,
    headSha: HEAD_ONE,
    taskId: "task-1",
  })
  const runner = new FakeVerificationRunner(spine, "runner-1")
  await runner.register()
  const lease = await runner.lease({
    activityId: "verification-1",
    leaseId: "lease-1",
    taskId: "task-1",
    ttlMs: 60_000,
  })
  await runner.complete({
    evidence: { result: "pass" },
    fencingToken: lease.fencingToken,
    leaseId: lease.id,
  })
  await spine.recordReview({
    activityId: "review-1",
    baseSha: BASE_SHA,
    evidence: { findingCount: 0 },
    headSha: HEAD_ONE,
    outcome: "accepted",
    taskId: "task-1",
  })

  spine = await env.createSpine()
  const reconstructed = await spine.attachConversation({ conversationId: "conversation-1", cursor: 0 })
  const reconstructedTask = reconstructed.tasks[0]
  assert.equal(reconstructedTask.status, "waiting_approval")
  assert.equal(reconstructedTask.settlementContractDigest, created.task.settlementContractDigest)
  assert.equal(
    reconstructed.events.find((event) => event.type === "task.created").data.settlementContractDigest,
    created.task.settlementContractDigest,
  )
  await assert.rejects(
    spine.grantApproval({
      approvalId: "incomplete-approval",
      approver: "local-owner",
      baseSha: BASE_SHA,
      evidenceActivityIds: ["verification-1"],
      headSha: HEAD_ONE,
      taskId: "task-1",
    }),
    (error) => error.code === "approval_evidence_missing",
  )
  const approved = await spine.grantApproval({
    approvalId: "approval-1",
    approver: "local-owner",
    baseSha: BASE_SHA,
    evidenceActivityIds: ["verification-1", "review-1"],
    headSha: HEAD_ONE,
    taskId: "task-1",
  })
  assert.equal(approved.task.status, "ready_to_merge")

  const state = JSON.parse(await fs.readFile(path.join(env.dataDir, "task-spine-state.json"), "utf8"))
  state.tasks["task-1"].requiredEvidenceKinds = ["verification"]
  const fileName = "weakened-settlement-policy.json"
  await fs.writeFile(path.join(env.dataDir, fileName), `${JSON.stringify(state)}\n`, { mode: 0o600 })
  await assert.rejects(
    new DurableTaskStore(env.dataDir, { fileName }).initialize(),
    (error) => error.code === "corrupt_task_state",
  )
})

test("every durable effect boundary replays without duplicating an external side effect", async (t) => {
  const env = await taskEnvironment(t)
  let spine = await env.createSpine()
  await createTask(spine)
  const adapter = new FakeEffectAdapter()

  for (const [index, crashAfter] of EFFECT_CRASH_POINTS.entries()) {
    const effectId = `effect-${index + 1}`
    await assert.rejects(
      spine.runEffect({
        adapter,
        crashAfter,
        effectId,
        input: { headSha: HEAD_ONE, ordinal: index + 1 },
        kind: "fake_remote_status",
        taskId: "task-1",
      }),
      (error) => error instanceof InjectedEffectCrash && error.crashPoint === crashAfter,
      crashAfter,
    )

    spine = await env.createSpine()
    const completed = await spine.runEffect({
      adapter,
      effectId,
      input: { headSha: HEAD_ONE, ordinal: index + 1 },
      kind: "fake_remote_status",
      taskId: "task-1",
    })
    assert.equal(completed.status, "succeeded", crashAfter)
    assert.equal(adapter.creationCount(effectId), 1, crashAfter)
    assert.equal(adapter.applyCallCount(effectId), 1, crashAfter)

    const replayed = await spine.runEffect({
      adapter,
      effectId,
      input: { headSha: HEAD_ONE, ordinal: index + 1 },
      kind: "fake_remote_status",
      taskId: "task-1",
    })
    assert.equal(replayed.resultDigest, completed.resultDigest, crashAfter)
    assert.equal(adapter.creationCount(effectId), 1, crashAfter)
    assert.equal(adapter.applyCallCount(effectId), 1, crashAfter)
  }

  await assert.rejects(
    spine.runEffect({
      adapter,
      effectId: "effect-1",
      input: { changed: true },
      kind: "fake_remote_status",
      taskId: "task-1",
    }),
    (error) => error.code === "effect_identity_conflict",
  )

  const attached = await spine.attachConversation({ conversationId: "conversation-1", cursor: 0 })
  assert.equal(attached.effects.length, EFFECT_CRASH_POINTS.length)
  assert.ok(attached.effects.every((effect) => effect.status === "succeeded"))
  for (const effect of attached.effects) {
    assert.equal(effect.adapterId, "fake-effect-adapter")
    const lifecycle = attached.events
      .filter((event) => event.entityId === effect.id)
      .map((event) => event.type)
    assert.deepEqual(lifecycle, [
      "effect.reserved",
      "effect.dispatching",
      "effect.reconciled_absent",
      "effect.applied",
      "effect.succeeded",
    ])
  }
})

test("an effect identity cannot be resumed through a different adapter", async (t) => {
  const env = await taskEnvironment(t)
  const spine = await env.createSpine()
  await createTask(spine)
  await spine.runEffect({
    adapter: new FakeEffectAdapter("adapter-a"),
    effectId: "effect-1",
    input: { headSha: HEAD_ONE },
    kind: "fake_remote_status",
    taskId: "task-1",
  })

  await assert.rejects(
    spine.runEffect({
      adapter: new FakeEffectAdapter("adapter-b"),
      effectId: "effect-1",
      input: { headSha: HEAD_ONE },
      kind: "fake_remote_status",
      taskId: "task-1",
    }),
    (error) => error.code === "effect_identity_conflict",
  )
})

test("an effect dispatch uses the immutable input captured by its durable reservation", async (t) => {
  const env = await taskEnvironment(t)
  const spine = await env.createSpine()
  await createTask(spine)
  const callerInput = { value: "reserved" }
  let appliedInput
  let appliedIdentity
  const adapter = {
    id: "mutating-reconciler",
    async apply({ input, ...identity }) {
      appliedInput = structuredClone(input)
      appliedIdentity = structuredClone(identity)
      return { received: input.value }
    },
    async reconcile(identity) {
      callerInput.value = "mutated-after-reservation"
      identity.taskId = "mutated-task"
      identity.inputDigest = "f".repeat(64)
      return { found: false }
    },
  }

  const completed = await spine.runEffect({
    adapter,
    effectId: "effect-immutable-input",
    input: callerInput,
    kind: "fake_remote_status",
    taskId: "task-1",
  })
  assert.deepEqual(appliedInput, { value: "reserved" })
  assert.equal(appliedIdentity.taskId, "task-1")
  assert.equal(appliedIdentity.effectId, "effect-immutable-input")
  assert.equal(appliedIdentity.inputDigest, completed.inputDigest)
  assert.deepEqual(completed.input, { value: "reserved" })
  assert.deepEqual(completed.result, { received: "reserved" })
  assert.equal(callerInput.value, "mutated-after-reservation")
})

test("ambiguous effect reconciliation neither applies nor settles the effect", async (t) => {
  const env = await taskEnvironment(t)
  const spine = await env.createSpine()
  await createTask(spine)
  let applyCount = 0
  const adapter = {
    id: "ambiguous-adapter",
    async apply() {
      applyCount += 1
      return { unexpected: true }
    },
    async reconcile() {
      return { found: "unknown" }
    },
  }

  await assert.rejects(
    spine.runEffect({
      adapter,
      effectId: "effect-ambiguous",
      input: { headSha: HEAD_ONE },
      kind: "fake_remote_status",
      taskId: "task-1",
    }),
    (error) => error.code === "effect_reconciliation_ambiguous",
  )
  assert.equal(applyCount, 0)
  const attached = await spine.attachConversation({ conversationId: "conversation-1", cursor: 0 })
  assert.equal(attached.effects[0].status, "dispatching")
  assert.equal(attached.effects[0].result, null)
})

test("reconstruction rejects valid JSON that violates durable domain invariants", async (t) => {
  const env = await taskEnvironment(t)
  const spine = await env.createSpine()
  await createTask(spine)
  await spine.publishPullRequest({
    artifactId: "artifact-1",
    baseSha: BASE_SHA,
    headSha: HEAD_ONE,
    remoteRef: { number: 1, repository: "fake/example" },
    taskId: "task-1",
  })
  const runner = new FakeVerificationRunner(spine, "runner-1")
  await runner.register()
  const completedLease = await runner.lease({
    activityId: "verification-1",
    leaseId: "lease-1",
    taskId: "task-1",
    ttlMs: 60_000,
  })
  await runner.complete({
    evidence: { result: "pass" },
    fencingToken: completedLease.fencingToken,
    leaseId: completedLease.id,
  })
  await spine.grantApproval({
    approvalId: "approval-1",
    approver: "local-owner",
    baseSha: BASE_SHA,
    evidenceActivityIds: ["verification-1"],
    headSha: HEAD_ONE,
    taskId: "task-1",
  })
  await spine.runEffect({
    adapter: new FakeEffectAdapter(),
    effectId: "effect-1",
    input: { action: "publish" },
    kind: "fake_remote_status",
    taskId: "task-1",
  })
  await runner.lease({
    activityId: "verification-2",
    leaseId: "lease-2",
    taskId: "task-1",
    ttlMs: 60_000,
  })

  const original = JSON.parse(await fs.readFile(path.join(env.dataDir, "task-spine-state.json"), "utf8"))
  await new DurableTaskStore(env.dataDir).initialize()
  const tamperCases = [
    ["acceptance-digest", (state) => { state.conversations["conversation-1"].acceptanceContract.target = "changed" }],
    ["effect-input-digest", (state) => { state.effects["effect-1"].input.action = "changed" }],
    ["effect-result-digest", (state) => { state.effects["effect-1"].result.externalId = "changed" }],
    ["current-artifact-binding", (state) => { state.tasks["task-1"].currentHeadSha = HEAD_TWO }],
    ["entity-status", (state) => { state.activities["verification-1"].status = "unknown" }],
    ["approval-evidence-binding", (state) => {
      state.approvals["approval-1"].evidenceBindings[0].evidenceDigest = "f".repeat(64)
    }],
    ["lease-fencing", (state) => { state.leases["lease-2"].fencingToken = 7 }],
    ["succeeded-verification-without-lease", (state) => {
      state.activities["verification-1"].leaseIds = []
      state.activities["verification-1"].lastFencingToken = 0
      delete state.leases["lease-1"]
    }],
    ["succeeded-verification-with-expired-lease", (state) => {
      const lease = state.leases["lease-1"]
      lease.status = "expired"
      lease.endedAt = lease.completedAt
      delete lease.completedAt
    }],
    ["succeeded-verification-with-reassigned-lease", (state) => {
      const lease = state.leases["lease-1"]
      lease.status = "reassigned"
      lease.endedAt = lease.completedAt
      delete lease.completedAt
    }],
    ["failed-verification-without-completed-lease", (state) => {
      const activity = state.activities["verification-1"]
      activity.status = "failed"
      activity.leaseIds = []
      activity.lastFencingToken = 0
      delete state.leases["lease-1"]
    }],
    ["cross-entity-reference", (state) => { delete state.artifacts["artifact-1"] }],
  ]

  for (const [index, [label, mutate]] of tamperCases.entries()) {
    const state = structuredClone(original)
    mutate(state)
    const fileName = `tampered-${index}.json`
    await fs.writeFile(path.join(env.dataDir, fileName), `${JSON.stringify(state)}\n`, { mode: 0o600 })
    const store = new DurableTaskStore(env.dataDir, { fileName })
    await assert.rejects(
      store.initialize(),
      (error) => error.code === "corrupt_task_state",
      label,
    )
  }
})
