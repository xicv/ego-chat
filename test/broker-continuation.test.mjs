import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { Broker } from "../src/broker.mjs"
import { createContract, digestJson } from "../src/convergence.mjs"
import { EventStore } from "../src/store.mjs"

const sha = (text) => createHash("sha256").update(text).digest("hex")
const keys = ["continuation-original", "continuation-successor", "continuation-other"]
const modelPolicy = {
  adjusted: false, effortLabel: "Pro", key: "chatgpt-web-default", modelLabel: "GPT-6 Astra",
  pillLabel: "Pro", powerLevel: 5, powerMax: 5,
}

function location(key) {
  return {
    canonicalUrl: `https://chatgpt.com/g/g-p-continuation-tests/c/${key}`,
    targetId: `${key}-tab`, taskSpaceId: 801 + keys.indexOf(key),
    taskSpaceIdentity: { name: `${key}-space`, taskId: `${key}-task` },
  }
}

function head(key, responseText = "initial assistant") {
  return {
    fingerprint: sha(`${key}:${responseText}`), fingerprintVersion: "tail-v1",
    lastContentDigest: sha(responseText), lastMessageId: `${key}-${responseText === "initial assistant" ? "initial" : "final"}`,
    lastRole: "assistant", messageCount: responseText === "initial assistant" ? 2 : 4,
  }
}

class ContinuationStore extends EventStore {
  constructor(directory) {
    super(directory)
    this.successorChildLinked = new Promise((resolve) => { this.signalSuccessorChildLinked = resolve })
  }

  async persist(type, workflow, expectedWorkflow = undefined) {
    const result = await super.persist(type, workflow, expectedWorkflow)
    if (type === "convergence.chatgpt_review_started" && workflow.activeChat?.generation === 1) {
      this.signalSuccessorChildLinked(workflow.childWorkflowId)
    }
    return result
  }
}

class PauseAfterResumeStore extends ContinuationStore {
  constructor(directory) {
    super(directory)
    this.committed = new Promise((resolve) => { this.signalCommitted = resolve })
  }

  async persistConvergenceResume(input) {
    const result = await super.persistConvergenceResume(input)
    if (result.created) {
      this.signalCommitted(result)
      await new Promise(() => {})
    }
    return result
  }
}

class PauseBeforeCancellationStore extends ContinuationStore {
  constructor(directory) {
    super(directory)
    this.cancellationStarted = Promise.withResolvers()
    this.releaseCancellation = Promise.withResolvers()
  }

  async persist(type, workflow, expectedWorkflow = undefined) {
    if (type === "convergence.continuation_cancelled"
      || (type === "workflow.cancelled" && workflow.phase === "recovery_abandoned")) {
      this.cancellationStarted.resolve()
      await this.releaseCancellation.promise
    }
    return super.persist(type, workflow, expectedWorkflow)
  }
}

class PauseBeforeParentCheckpointStore extends ContinuationStore {
  constructor(directory) {
    super(directory)
    this.beforeCheckpoint = new Promise((resolve) => { this.signalBeforeCheckpoint = resolve })
  }

  async persist(type, workflow, expectedWorkflow = undefined) {
    if (workflow.kind === "convergence" && workflow.phase === "continuation_paused") {
      this.signalBeforeCheckpoint()
      await new Promise(() => {})
    }
    return super.persist(type, workflow, expectedWorkflow)
  }
}

async function harness(t, { Store = ContinuationStore, automatic = false, initialControls = {} } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ego-broker-continuation-"))
  const brokers = []
  t.after(async () => {
    for (const broker of brokers) broker.close()
    await fs.rm(directory, { recursive: true, force: false })
  })
  const sends = []
  const preparations = []
  let localCalls = 0
  let reconciliations = 0
  const controls = { holdSuccessorCapture: false, ...initialControls }
  let capturedSuccessor
  const successorCaptureStarted = new Promise((resolve) => { capturedSuccessor = resolve })
  const browserLocation = (binding) => keys.includes(binding.key) ? location(binding.key) : {
    canonicalUrl: `https://chatgpt.com/g/g-p-continuation-tests/c/${binding.key}`,
    targetId: binding.targetId, taskSpaceId: binding.taskSpaceId, taskSpaceIdentity: binding.taskSpaceIdentity,
  }
  const completedCapture = (input) => {
    const responseText = `The exact retained candidate is verified.\nEGO_CHAT_DECISION: SETTLED\n${input.expectedTerminalMarker}`
    return {
      ...browserLocation(input.binding), durationMs: 1, modelPolicy,
      head: head(input.binding.key, responseText), responseText, responseDigest: sha(responseText),
      turnMarker: input.turnMarker,
    }
  }
  const adapter = {
    prepareSuccessor: async (input, signal, onResult, beforeRun) => {
      await beforeRun?.()
      preparations.push(input)
      controls.preparationStarted?.resolve()
      if (controls.holdPreparation) await controls.holdPreparation.promise
      const result = {
        canonicalUrl: null, startUrl: input.startUrl, targetId: "prepared-successor-tab",
        taskSpaceId: 901, taskSpaceIdentity: { name: input.taskSpaceName, taskId: "prepared-successor-task" },
        head: { fingerprint: sha("null"), fingerprintVersion: "tail-v1", lastContentDigest: null, lastMessageId: null, lastRole: null, messageCount: 0, renderedMessageCount: 0 },
      }
      await onResult?.(result)
      if (controls.losePreparationAck) {
        controls.losePreparationAck = false
        throw new Error("Synthetic lost blank-tab acknowledgement")
      }
      return result
    },
    bind: async (input) => {
      const key = keys.find((candidate) => location(candidate).canonicalUrl === input.canonicalUrl)
      assert.ok(key)
      return { ...location(key), head: head(key) }
    },
    sendExchange: async (input, signal, onResult, beforeRun) => {
      if (input.binding.key.startsWith("successor-") && controls.holdSuccessorSend) {
        controls.successorSendStarted.resolve()
        await controls.holdSuccessorSend.promise
      }
      try { await beforeRun?.() } finally {
        if (input.binding.key.startsWith("successor-")) controls.successorSendChecked?.resolve()
      }
      sends.push({ bindingKey: input.binding.key, turnMarker: input.turnMarker, prompt: input.prompt })
      return {
        ...browserLocation(input.binding), modelPolicy, turnMarker: input.turnMarker,
        promptMessageId: `${input.binding.key}-confirmed-user`, sentAt: new Date().toISOString(),
      }
    },
    captureExchange: async (input) => {
      if (input.binding.key === keys[0]) {
        return {
          ...location(keys[0]), captureState: "provider_terminal", generationRunning: false,
          promptMessageId: input.promptMessageId, turnMarker: input.turnMarker,
          providerTerminal: {
            schema: "ego-chat-provider-terminal/v1", kind: "conversation_exhausted",
            source: "latest_turn_status", signalDigest: sha("bounded exact provider exhaustion"), stableObservations: 2,
          },
        }
      }
      if (controls.successorTerminal) return {
        ...browserLocation(input.binding), captureState: "provider_terminal", generationRunning: false,
        promptMessageId: input.promptMessageId, turnMarker: input.turnMarker,
        providerTerminal: { schema: "ego-chat-provider-terminal/v1", kind: controls.successorTerminal,
          source: "latest_turn_status", signalDigest: sha("exact successor terminal"), stableObservations: 2 },
      }
      if (controls.holdSuccessorCapture) {
        capturedSuccessor()
        await new Promise(() => {})
      }
      return completedCapture(input)
    },
    reconcileBound: async (input) => {
      reconciliations += 1
      return completedCapture(input)
    },
    reconcile: async (input) => {
      reconciliations += 1
      return completedCapture(input)
    },
  }
  const makeBroker = (store) => {
    const broker = new Broker({
      store, egoAdapter: adapter, recoveryDelaysMs: [0],
      appServerFactory: () => {
        localCalls += 1
        throw new Error("A retained candidate must not launch or connect local model work")
      },
    })
    brokers.push(broker)
    return broker
  }
  const bootstrap = makeBroker(new EventStore(directory))
  await bootstrap.initialize()
  for (const key of keys) {
    await bootstrap.bindConversation({ bindingKey: key, mode: "existing", canonicalUrl: location(key).canonicalUrl, taskSpace: location(key).taskSpaceId })
  }
  bootstrap.close()
  const store = new Store(directory)
  await store.initialize()
  const contract = createContract("Private retained implementation target.", ["The exact candidate survives a conversation boundary."])
  const candidate = {
    blockers: [], criteria: [{ id: "AC-1", status: "pass", evidence: "Private deterministic candidate evidence." }],
    reviewPacket: "Private retained review packet.", status: "candidate", summary: "Private retained candidate.",
  }
  const now = new Date().toISOString()
  const parent = {
    id: randomUUID(), kind: "convergence", bindingKey: keys[0], status: "running", phase: "codex_captured",
    cycle: 1, candidateDigest: digestJson(candidate), targetDigest: contract.targetDigest,
    cwd: directory, codexSandbox: "read-only", codexThreadId: "retained-local-thread", maxCycles: null,
    createdAt: now, updatedAt: now, deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    inputDigest: digestJson({ contract, cwd: directory, sandbox: "read-only" }),
    private: {
      contract, priorReview: null,
      cycles: [{ cycle: 1, candidate, candidateDigest: digestJson(candidate), codex: { turnId: "retained-local-turn", responseDigest: sha("candidate"), workspaceActivity: { count: 1, types: ["commandExecution"] } } }],
      request: {
        acceptanceCriteria: contract.criteria.map(({ text }) => text), target: contract.target,
        bindingKey: keys[0], cwd: directory, codexSandbox: "read-only", allowTaskSpaceReclaim: true,
        ...(automatic ? { conversationContinuation: "same_project_on_exhaustion" } : {}),
        chatGptTimeoutMs: 30_000, codexTurnTimeoutMs: 30_000, wallClockTimeoutMs: 3_600_000,
      },
    },
  }
  await store.persist("workflow.started", parent)
  const broker = makeBroker(store)
  await broker.initialize()
  const paused = store instanceof PauseBeforeParentCheckpointStore
    ? await store.beforeCheckpoint.then(() => broker.getWorkflow({ workflowId: parent.id }))
    : controls.successorSendStarted
      ? await controls.successorSendStarted.promise.then(() => broker.getWorkflow({ workflowId: parent.id }))
    : controls.holdSuccessorCapture
      ? await successorCaptureStarted.then(() => broker.getWorkflow({ workflowId: parent.id }))
    : store.beforeSuccessorAdmission
      ? await store.beforeSuccessorAdmission.promise.then(() => broker.getWorkflow({ workflowId: parent.id }))
    : store.beforeReviewIntent
      ? await store.beforeReviewIntent.promise.then(() => broker.getWorkflow({ workflowId: parent.id }))
    : store.beforePromotion
      ? await store.beforePromotion.promise.then(() => broker.getWorkflow({ workflowId: parent.id }))
    : await broker.awaitWorkflow({ workflowId: parent.id, timeoutMs: 2_000 })
  const successor = (key = keys[1]) => ({
    bindingKey: key, canonicalUrl: location(key).canonicalUrl,
    expectedBindingRevision: store.getBinding(key).revision, acknowledgeConversationChange: true,
  })
  const request = (selected = successor()) => ({
    workflowId: parent.id, expectedCheckpointDigest: paused.continuationCheckpoint?.checkpointDigest,
    ...(selected ? { successor: selected } : {}),
  })
  return {
    broker, controls, directory, makeBroker, parent, paused, preparations, request, sends, store, successor, successorCaptureStarted,
    counts: () => ({ localCalls, reconciliations }),
  }
}

test("opted-in exhaustion prepares one successor and consumes its first review without a duplicate Send", async (t) => {
  const f = await harness(t, { automatic: true })
  const done = await f.broker.awaitWorkflow({ workflowId: f.parent.id, timeoutMs: 2_000 })
  assert.equal(done.status, "succeeded")
  assert.equal(done.activeChat.generation, 1)
  assert.equal(done.bindingKey, keys[0])
  assert.equal(done.candidateDigest, f.parent.candidateDigest)
  assert.equal(f.preparations.length, 1)
  assert.equal(f.sends.length, 2)
  assert.equal(f.sends[1].bindingKey, done.activeChat.bindingKey)
  assert.equal(f.store.getBinding(done.activeChat.bindingKey).state, "bound")
  assert.equal(f.counts().localCalls, 0)
})

test("an unexpected successor preparation failure retains its checkpoint and reservation across retention and restart", async (t) => {
  class ZeroRetentionStore extends EventStore {
    constructor(directory) { super(directory, { maxEvents: 1, maxTerminalWorkflows: 0, rawRetentionMs: 0 }) }
  }
  const f = await harness(t, { automatic: true, Store: ZeroRetentionStore, initialControls: { losePreparationAck: true } })
  assert.equal(f.paused.status, "human_required")
  assert.equal(f.paused.humanRequired.code, "successor_recovery_required")
  const before = f.store.getWorkflow(f.parent.id)
  await f.store.persist("workflow.succeeded", { id: randomUUID(), kind: "probe", status: "succeeded", phase: "complete", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  assert.ok(f.store.getWorkflow(f.parent.id))
  assert.ok(f.store.getWorkflow(before.private.continuationCheckpoint.source.workflowId))
  f.broker.close()
  const restarted = f.makeBroker(new ZeroRetentionStore(f.directory))
  await restarted.initialize()
  assert.equal(restarted.getWorkflow({ workflowId: f.parent.id }).status, "human_required")
  await restarted.prepareSuccessor({ workflowId: f.parent.id, expectedCheckpointDigest: before.private.continuationCheckpoint.digest, acknowledgeNewChat: true })
  assert.equal(f.preparations[1].allowCreate, false)
  assert.equal(f.sends.length, 1)
  const resume = { workflowId: f.parent.id, expectedCheckpointDigest: before.private.continuationCheckpoint.digest }
  await Promise.all([restarted.resumeConvergence(resume), restarted.resumeConvergence(resume)])
  const done = await restarted.awaitWorkflow({ workflowId: f.parent.id, timeoutMs: 2_000 })
  assert.equal(done.status, "succeeded")
  assert.equal(f.sends.length, 2)
})

test("an unexpected promotion failure can consume its already completed successor without reconciliation or Send", async (t) => {
  class FailPromotionOnceStore extends EventStore {
    constructor(directory) { super(directory, { maxEvents: 1, maxTerminalWorkflows: 0, rawRetentionMs: 0 }); this.failPromotion = true }
    async persistSuccessorPromotion(input) {
      if (this.failPromotion) { this.failPromotion = false; throw new Error("Synthetic promotion failure") }
      return super.persistSuccessorPromotion(input)
    }
  }
  const f = await harness(t, { automatic: true, Store: FailPromotionOnceStore })
  assert.equal(f.paused.status, "human_required")
  assert.equal(f.paused.humanRequired.code, "successor_recovery_required")
  await f.broker.resumeConvergence(f.request(null))
  const done = await f.broker.awaitWorkflow({ workflowId: f.parent.id, timeoutMs: 2_000 })
  assert.equal(done.status, "succeeded")
  assert.equal(f.sends.length, 2)
  assert.equal(f.counts().reconciliations, 0)
})

test("monitor supervision follows the pending successor rather than the exhausted predecessor", async (t) => {
  const f = await harness(t, { automatic: true, initialControls: { holdSuccessorCapture: true } })
  const status = f.broker.getStatus()
  const parent = status.runningWorkflows.find(workflow => workflow.id === f.parent.id)
  assert.equal(parent.supervision.chatGpt.delivery, "sent_waiting_response")
  assert.equal(parent.supervision.stage, "chatgpt")
  assert.equal(parent.supervision.semanticCheckpoint.loop.actionClass, "response_wait")
})

test("restart after first successor capture retains its response and promotes without another Send", async (t) => {
  class PromotionBarrierStore extends EventStore {
    constructor(directory) {
      super(directory, { maxEvents: 1, maxTerminalWorkflows: 0, rawRetentionMs: 0 })
      this.beforePromotion = Promise.withResolvers()
    }
    async persistSuccessorPromotion() {
      this.beforePromotion.resolve()
      await new Promise(() => {})
    }
  }
  const f = await harness(t, { automatic: true, Store: PromotionBarrierStore })
  const before = f.store.getWorkflow(f.parent.id)
  const key = before.private.successorReview.bindingKey
  const child = f.store.getWorkflowByOperationKey(`exchange:${key}:${before.private.successorReview.turnMarker}`)
  assert.equal(child.status, "succeeded")
  await f.store.persist("workflow.succeeded", { id: randomUUID(), kind: "probe", status: "succeeded", phase: "complete", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  assert.ok(f.store.getWorkflow(child.id))
  f.broker.close()
  const restarted = f.makeBroker(new EventStore(f.directory, { maxEvents: 1, maxTerminalWorkflows: 0, rawRetentionMs: 0 }))
  await restarted.initialize()
  const done = await restarted.awaitWorkflow({ workflowId: f.parent.id, timeoutMs: 2_000 })
  assert.equal(done.status, "succeeded")
  assert.equal(done.activeChat.bindingKey, key)
  assert.equal(f.preparations.length, 1)
  assert.equal(f.sends.length, 2)
})

test("a successor quota boundary revokes the predecessor checkpoint's permission to choose another chat", async (t) => {
  const f = await harness(t, { automatic: true, initialControls: { successorTerminal: "quota_limited" } })
  assert.equal(f.paused.humanRequired.code, "chatgpt_quota_limited")
  await assert.rejects(f.broker.resumeConvergence(f.request(f.successor(keys[2]))), { code: "continuation_not_authorized" })
  assert.deepEqual(f.paused.continuationCheckpoint.allowedActions, [])
  assert.equal(f.sends.length, 2)
})

test("an exact paused successor can reconcile a late answer and resume without another Send", async (t) => {
  const f = await harness(t, { automatic: true, initialControls: { successorTerminal: "quota_limited" } })
  const intent = f.store.getWorkflow(f.parent.id).private.successorReview
  const child = f.store.getWorkflowByOperationKey(`exchange:${intent.bindingKey}:${intent.turnMarker}`)
  await f.broker.reconcileConversation({ bindingKey: intent.bindingKey, workflowId: child.id })
  await f.broker.resumeConvergence(f.request(null))
  const done = await f.broker.awaitWorkflow({ workflowId: f.parent.id, timeoutMs: 2_000 })
  assert.equal(done.status, "succeeded")
  assert.equal(done.activeChat.bindingKey, intent.bindingKey)
  await f.broker.resumeConvergence(f.request(null))
  assert.equal(f.sends.length, 2)
  assert.equal(f.counts().reconciliations, 1)
})

test("concurrent exact recovered-successor resumes do not release the winning runner's reservation", async (t) => {
  class CaptureBarrierStore extends ContinuationStore {
    constructor(directory) { super(directory); this.capturing = Promise.withResolvers(); this.releaseCapture = Promise.withResolvers() }
    async persist(type, workflow, expected) {
      if (type === "convergence.chatgpt_review_captured") { this.capturing.resolve(); await this.releaseCapture.promise }
      return super.persist(type, workflow, expected)
    }
  }
  const f = await harness(t, { Store: CaptureBarrierStore, automatic: true, initialControls: { successorTerminal: "quota_limited" } })
  const intent = f.store.getWorkflow(f.parent.id).private.successorReview
  const child = f.store.getWorkflowByOperationKey(`exchange:${intent.bindingKey}:${intent.turnMarker}`)
  await f.broker.reconcileConversation({ bindingKey: intent.bindingKey, workflowId: child.id })
  await Promise.all([f.broker.resumeConvergence(f.request(null)), f.broker.resumeConvergence(f.request(null))])
  await f.store.capturing.promise
  const marker = "EGO_CHAT_CONCURRENT_RESUME_FOREIGN"
  await assert.rejects(f.broker.startEgoExchange({ bindingKey: intent.bindingKey, prompt: marker, turnMarker: marker,
    expectedTerminalMarker: "EGO_CHAT_CONCURRENT_RESUME_DONE", timeoutMs: 30_000 }), { code: "conversation_reserved" })
  f.store.releaseCapture.resolve()
  await f.broker.awaitWorkflow({ workflowId: f.parent.id, timeoutMs: 2_000 })
  assert.equal(f.sends.length, 2)
})

test("cancellation winning successor child admission prevents its Send", async (t) => {
  class PausedAdmissionStore extends EventStore {
    constructor(directory) {
      super(directory)
      this.beforeSuccessorAdmission = Promise.withResolvers()
      this.releaseAdmission = Promise.withResolvers()
    }
    async persistStarted(type, workflow, receipt, expectedParent) {
      if (workflow.successorParentId) {
        this.beforeSuccessorAdmission.resolve()
        await this.releaseAdmission.promise
      }
      return super.persistStarted(type, workflow, receipt, expectedParent)
    }
  }
  const f = await harness(t, { Store: PausedAdmissionStore, automatic: true })
  assert.equal(f.paused.phase, "successor_reviewing")
  const cancelled = await f.broker.cancelWorkflow({ workflowId: f.parent.id })
  f.store.releaseAdmission.resolve()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(cancelled.status, "cancelled")
  assert.equal(f.sends.length, 1)
  assert.equal(f.store.listWorkflows().some(workflow => workflow.successorParentId === f.parent.id), false)
})

test("the prepared automatic successor binding stays exclusive while review intent is being committed", async (t) => {
  class IntentBarrierStore extends EventStore {
    constructor(directory) {
      super(directory)
      this.beforeReviewIntent = Promise.withResolvers()
      this.releaseIntent = Promise.withResolvers()
    }
    async persist(type, workflow, expected) {
      if (type === "convergence.successor_review_reserved") {
        this.beforeReviewIntent.resolve()
        await this.releaseIntent.promise
      }
      return super.persist(type, workflow, expected)
    }
  }
  const f = await harness(t, { Store: IntentBarrierStore, automatic: true })
  const key = f.paused.successorPreparation.bindingKey
  const marker = "EGO_CHAT_UNRELATED_PENDING_SUCCESSOR_TEST"
  const attempt = f.broker.startEgoExchange({ bindingKey: key, prompt: marker, turnMarker: marker,
    expectedTerminalMarker: "EGO_CHAT_UNRELATED_PENDING_SUCCESSOR_DONE", timeoutMs: 30_000 })
  const rejected = assert.rejects(attempt, { code: "conversation_reserved" })
  f.store.releaseIntent.resolve()
  await rejected
  await f.broker.awaitWorkflow({ workflowId: f.parent.id, timeoutMs: 2_000 })
  assert.equal(f.sends.length, 2)
})

test("an admitted successor cannot dispatch after durable parent cancellation but before cleanup returns", async (t) => {
  class CancelBarrierStore extends EventStore {
    constructor(directory) {
      super(directory)
      this.cancelCommitted = Promise.withResolvers()
      this.releaseCancel = Promise.withResolvers()
    }
    async persist(type, workflow, expected) {
      const result = await super.persist(type, workflow, expected)
      if (type === "convergence.continuation_cancelled") {
        this.cancelCommitted.resolve()
        await this.releaseCancel.promise
      }
      return result
    }
  }
  const controls = {
    successorSendStarted: Promise.withResolvers(), holdSuccessorSend: Promise.withResolvers(),
    successorSendChecked: Promise.withResolvers(),
  }
  const f = await harness(t, { Store: CancelBarrierStore, automatic: true, initialControls: controls })
  const cancelling = f.broker.cancelWorkflow({ workflowId: f.parent.id })
  await f.store.cancelCommitted.promise
  controls.holdSuccessorSend.resolve()
  await controls.successorSendChecked.promise
  await new Promise(resolve => setTimeout(resolve, 20))
  f.store.releaseCancel.resolve()
  await cancelling
  assert.equal(f.sends.length, 1)
})

test("successor preparation reserves one blank binding without Send or advancing the task", async (t) => {
  const f = await harness(t)
  const request = { workflowId: f.parent.id, expectedCheckpointDigest: f.paused.continuationCheckpoint.checkpointDigest, acknowledgeNewChat: true }
  const result = await f.broker.prepareSuccessor(request)
  assert.equal(result.status, "human_required")
  assert.equal(result.phase, "continuation_paused")
  assert.equal(result.activeChat, undefined)
  assert.equal(result.successorPreparation.state, "prepared")
  assert.equal(result.successorPreparation.canonicalUrl, undefined)
  const binding = f.store.getBinding(result.successorPreparation.bindingKey)
  assert.equal(binding.state, "unbound")
  assert.equal(binding.canonicalUrl, null)
  assert.equal(binding.startUrl, "https://chatgpt.com/g/g-p-continuation-tests")
  assert.equal(binding.targetId, "prepared-successor-tab")
  assert.equal(f.preparations.length, 1)
  assert.equal(f.preparations[0].allowCreate, true)
  assert.equal(f.sends.length, 1)
  assert.equal(f.counts().localCalls, 0)
  assert.deepEqual((await f.broker.prepareSuccessor(request)).successorPreparation, result.successorPreparation)
  assert.equal(f.preparations.length, 1)
  f.broker.close()
  const restarted = f.makeBroker(new EventStore(f.directory))
  await restarted.initialize()
  assert.deepEqual((await restarted.prepareSuccessor(request)).successorPreparation, result.successorPreparation)
  assert.equal(f.preparations.length, 1)
})

test("lost preparation acknowledgement restarts in observation-only mode and preserves the exact reservation", async (t) => {
  const f = await harness(t)
  f.controls.losePreparationAck = true
  const request = { workflowId: f.parent.id, expectedCheckpointDigest: f.paused.continuationCheckpoint.checkpointDigest, acknowledgeNewChat: true }
  await assert.rejects(f.broker.prepareSuccessor(request), /Synthetic lost/)
  const interrupted = f.broker.getWorkflow({ workflowId: f.parent.id })
  assert.equal(interrupted.successorPreparation.state, "dispatched")
  assert.equal(f.store.getBinding(interrupted.successorPreparation.bindingKey), undefined)
  f.broker.close()
  const restarted = f.makeBroker(new EventStore(f.directory))
  await restarted.initialize()
  assert.equal(f.preparations.length, 1, "restart alone cannot initiate browser creation")
  const completed = await restarted.prepareSuccessor(request)
  assert.equal(completed.successorPreparation.state, "prepared")
  assert.equal(completed.successorPreparation.bindingKey, interrupted.successorPreparation.bindingKey)
  assert.deepEqual(f.preparations.map(({ allowCreate }) => allowCreate), [true, false])
  assert.equal(f.sends.length, 1)
})

test("cancelling preparation prevents its late result from creating a binding or reviving the task", async (t) => {
  const f = await harness(t)
  f.controls.preparationStarted = Promise.withResolvers()
  f.controls.holdPreparation = Promise.withResolvers()
  const request = { workflowId: f.parent.id, expectedCheckpointDigest: f.paused.continuationCheckpoint.checkpointDigest, acknowledgeNewChat: true }
  const preparing = f.broker.prepareSuccessor(request)
  const rejected = assert.rejects(preparing, { code: "continuation_transition_conflict" })
  await f.controls.preparationStarted.promise
  await assert.rejects(f.broker.prepareSuccessor(request), { code: "workflow_busy" })
  const key = f.broker.getWorkflow({ workflowId: f.parent.id }).successorPreparation.bindingKey
  await f.broker.cancelWorkflow({ workflowId: f.parent.id })
  f.controls.holdPreparation.resolve()
  await rejected
  assert.equal(f.store.getBinding(key), undefined)
  assert.equal(f.broker.getWorkflow({ workflowId: f.parent.id }).status, "cancelled")
  assert.equal(f.preparations.length, 1)
  assert.equal(f.sends.length, 1)
})

test("preparation requires explicit exact-checkpoint authority and capacity before browser creation", async (t) => {
  class FullBindingStore extends EventStore {
    constructor(directory) {
      super(directory, { maxBindings: 3 })
    }
  }
  const f = await harness(t, { Store: FullBindingStore })
  const request = { workflowId: f.parent.id, expectedCheckpointDigest: f.paused.continuationCheckpoint.checkpointDigest, acknowledgeNewChat: true }
  await assert.rejects(f.broker.prepareSuccessor({ ...request, acknowledgeNewChat: false }), { code: "invalid_input" })
  await assert.rejects(f.broker.prepareSuccessor({ ...request, expectedCheckpointDigest: "f".repeat(64) }))
  await assert.rejects(f.broker.prepareSuccessor(request), { code: "binding_capacity_exhausted" })
  assert.equal(f.broker.getWorkflow({ workflowId: f.parent.id }).successorPreparation, undefined)
  assert.equal(f.preparations.length, 0)
  assert.equal(f.sends.length, 1)
})

test("a preparation reservation keeps its binding capacity across restart and releases it on cancellation", async (t) => {
  class ReservedCapacityStore extends EventStore {
    constructor(directory) { super(directory, { maxBindings: 4 }) }
  }
  const f = await harness(t, { Store: ReservedCapacityStore })
  f.controls.losePreparationAck = true
  const request = { workflowId: f.parent.id, expectedCheckpointDigest: f.paused.continuationCheckpoint.checkpointDigest, acknowledgeNewChat: true }
  await assert.rejects(f.broker.prepareSuccessor(request), /Synthetic lost/)
  f.broker.close()
  const store = new ReservedCapacityStore(f.directory)
  const restarted = f.makeBroker(store)
  await restarted.initialize()
  const extra = { ...store.getBinding(keys[2]), key: "capacity-competitor" }
  await assert.rejects(store.persistBinding("binding.created", extra), { code: "binding_capacity_exhausted" })
  await restarted.cancelWorkflow({ workflowId: f.parent.id })
  await store.persistBinding("binding.created", extra)
  assert.equal(store.getBinding(extra.key).key, extra.key)
  assert.equal(f.preparations.length, 1)
})

test("closing the broker prevents a late blank preparation acknowledgement from committing", async (t) => {
  const f = await harness(t)
  f.controls.preparationStarted = Promise.withResolvers()
  f.controls.holdPreparation = Promise.withResolvers()
  const request = { workflowId: f.parent.id, expectedCheckpointDigest: f.paused.continuationCheckpoint.checkpointDigest, acknowledgeNewChat: true }
  const preparing = f.broker.prepareSuccessor(request)
  const rejected = assert.rejects(preparing, /no owner-scoped task-space admission/)
  await f.controls.preparationStarted.promise
  const key = f.broker.getWorkflow({ workflowId: f.parent.id }).successorPreparation.bindingKey
  f.broker.close()
  f.controls.holdPreparation.resolve()
  await rejected
  assert.equal(f.store.getBinding(key), undefined)
  assert.equal(f.store.getWorkflow(f.parent.id).private.successorPreparation.state, "dispatched")
})

test("exhausted review preserves an exact private convergence checkpoint and public receipt", async (t) => {
  const f = await harness(t)
  assert.equal(f.paused.status, "human_required")
  assert.equal(f.paused.phase, "continuation_paused")
  assert.equal(f.paused.continuationCheckpoint.reasonCode, "chatgpt_conversation_exhausted")
  assert.match(f.paused.continuationCheckpoint.checkpointDigest, /^[a-f0-9]{64}$/)
  assert.equal(f.paused.private, undefined)
  assert.equal(JSON.stringify(f.paused.continuationCheckpoint).includes("Private"), false)
  assert.equal(JSON.stringify(f.paused.continuationCheckpoint).includes("chatgpt.com"), false)
  assert.deepEqual(f.store.getWorkflow(f.parent.id).private.contract, f.parent.private.contract)
  assert.deepEqual(f.store.getWorkflow(f.parent.id).private.cycles[0].candidate, f.parent.private.cycles[0].candidate)
  assert.equal(f.store.getWorkflow(f.paused.childWorkflowId).phase, "provider_paused")
  assert.equal(f.store.getBinding(keys[0]).headMessageId, head(keys[0]).lastMessageId)
  assert.equal(f.sends.length, 1)
  assert.equal(f.counts().localCalls, 0)
})

test("approved successor keeps the parent and candidate while concurrent replay sends only once", async (t) => {
  const f = await harness(t)
  const oldBinding = f.store.getBinding(keys[0])
  const oldChild = f.store.getWorkflow(f.paused.childWorkflowId)
  const request = f.request()
  const resumed = await Promise.all([f.broker.resumeConvergence(request), f.broker.resumeConvergence(request)])
  assert.equal(resumed.every(({ id }) => id === f.parent.id), true)
  const completed = await f.broker.awaitWorkflow({ workflowId: f.parent.id, timeoutMs: 2_000 })
  assert.equal(completed.status, "succeeded")
  assert.equal(completed.bindingKey, keys[0])
  assert.deepEqual(completed.activeChat, { bindingKey: keys[1], generation: 1 })
  assert.equal(completed.candidateDigest, f.parent.candidateDigest)
  assert.equal(completed.cycle, 1)
  assert.deepEqual(f.sends.map(({ bindingKey }) => bindingKey), [keys[0], keys[1]])
  assert.notEqual(f.sends[0].turnMarker, f.sends[1].turnMarker)
  assert.match(f.sends[1].prompt, new RegExp(`Candidate digest: ${f.parent.candidateDigest}`))
  assert.deepEqual(f.store.getBinding(keys[0]), oldBinding)
  assert.deepEqual(f.store.getWorkflow(oldChild.id), oldChild)
  assert.equal(f.counts().localCalls, 0)
  const replay = await f.broker.resumeConvergence(request)
  assert.equal(replay.id, f.parent.id)
  assert.equal(f.sends.length, 2)
})

test("same-binding resume consumes only a reconciled successful child without another Send", async (t) => {
  const f = await harness(t)
  const request = f.request(null)
  await assert.rejects(f.broker.resumeConvergence(request))
  await f.broker.reconcileConversation({ bindingKey: keys[0], workflowId: f.paused.childWorkflowId })
  const child = f.store.getWorkflow(f.paused.childWorkflowId)
  assert.equal(child.status, "succeeded")
  assert.equal(child.result.reconciled, true)
  await f.broker.resumeConvergence(request)
  const completed = await f.broker.awaitWorkflow({ workflowId: f.parent.id, timeoutMs: 2_000 })
  assert.equal(completed.status, "succeeded")
  assert.equal(completed.childWorkflowId, child.id)
  assert.equal(completed.activeChat, undefined)
  assert.equal(completed.candidateDigest, f.parent.candidateDigest)
  assert.equal(f.sends.length, 1)
  assert.deepEqual(f.counts(), { localCalls: 0, reconciliations: 1 })
})

test("cancelling a paused continuation permanently revokes resume without changing either chat", async (t) => {
  const f = await harness(t)
  const request = f.request()
  const oldBinding = f.store.getBinding(keys[0])
  const successorBinding = f.store.getBinding(keys[1])
  const oldChild = f.store.getWorkflow(f.paused.childWorkflowId)
  const cancelled = await f.broker.cancelWorkflow({ workflowId: f.parent.id })
  assert.equal(cancelled.status, "cancelled")
  assert.equal(cancelled.phase, "continuation_cancelled")
  assert.equal(cancelled.continuationCheckpoint, undefined)
  assert.equal(f.store.getWorkflow(f.parent.id).private?.continuationCheckpoint, undefined)
  await assert.rejects(f.broker.resumeConvergence(request))
  assert.deepEqual(f.store.getBinding(keys[0]), oldBinding)
  assert.deepEqual(f.store.getBinding(keys[1]), successorBinding)
  assert.deepEqual(f.store.getWorkflow(oldChild.id), oldChild)
  assert.equal(f.sends.length, 1)
  assert.deepEqual(f.counts(), { localCalls: 0, reconciliations: 0 })
  f.broker.close()
  const restarted = f.makeBroker(new EventStore(f.directory))
  await restarted.initialize()
  assert.equal(restarted.getWorkflow({ workflowId: f.parent.id }).status, "cancelled")
  await assert.rejects(restarted.resumeConvergence(request))
  assert.equal(f.sends.length, 1)
  assert.deepEqual(f.counts(), { localCalls: 0, reconciliations: 0 })
})

test("stale or conflicting continuation choices cannot alter the paused evidence", async (t) => {
  const f = await harness(t)
  const before = f.store.getWorkflow(f.parent.id)
  for (const input of [
    { ...f.request(), expectedCheckpointDigest: "f".repeat(64) },
    f.request({ ...f.successor(), expectedBindingRevision: f.successor().expectedBindingRevision + 1 }),
    f.request({ ...f.successor(), canonicalUrl: location(keys[2]).canonicalUrl }),
    f.request({ ...f.successor(), acknowledgeConversationChange: false }),
  ]) {
    await assert.rejects(f.broker.resumeConvergence(input))
    assert.deepEqual(f.store.getWorkflow(f.parent.id), before)
    assert.equal(f.sends.length, 1)
  }
  const choices = await Promise.allSettled([
    f.broker.resumeConvergence(f.request()),
    f.broker.resumeConvergence(f.request(f.successor(keys[2]))),
  ])
  assert.equal(choices.filter(({ status }) => status === "fulfilled").length, 1)
  assert.equal(choices.filter(({ status }) => status === "rejected").length, 1)
  const result = await f.broker.awaitWorkflow({ workflowId: f.parent.id, timeoutMs: 2_000 })
  assert.equal(result.status, "succeeded")
  assert.equal(f.sends.length, 2)
  assert.equal(f.counts().localCalls, 0)
})

for (const action of ["cancel", "abandon"]) {
  test(`paused ${action} cannot rebase onto a concurrently resumed successor`, async (t) => {
    const f = await harness(t, { Store: PauseBeforeCancellationStore })
    f.controls.holdSuccessorCapture = true
    const cancellation = action === "cancel"
      ? f.broker.cancelWorkflow({ workflowId: f.parent.id })
      : f.broker.abandonWorkflow({ workflowId: f.parent.id, acknowledgePotentialDelivery: true })
    // Attach the rejection handler before releasing the deliberately held write.
    const rejectedCancellation = assert.rejects(cancellation, { code: "workflow_transition_conflict" })
    await f.store.cancellationStarted.promise
    await f.broker.resumeConvergence(f.request())
    await f.successorCaptureStarted
    await f.store.successorChildLinked
    const running = f.store.getWorkflow(f.parent.id)
    assert.equal(running.status, "running")
    f.store.releaseCancellation.resolve()
    await rejectedCancellation
    assert.deepEqual(f.store.getWorkflow(f.parent.id), running)
    assert.equal(f.store.getWorkflow(running.childWorkflowId).status, "running")
    assert.equal(f.sends.length, 2)
    assert.equal(f.counts().localCalls, 0)
    // Retrying cancellation against the current state must take the normal
    // in-flight path, including cancelling its exact successor child.
    const cancelled = await f.broker.cancelWorkflow({ workflowId: f.parent.id })
    assert.equal(cancelled.status, "human_required")
    assert.equal(cancelled.humanRequired.code, "cancelled_during_convergence")
    assert.equal(f.store.getWorkflow(running.childWorkflowId).status, "human_required")
  })
}

test("restart after the durable resume transition sends the successor review only once", async (t) => {
  const f = await harness(t, { Store: PauseAfterResumeStore })
  const request = f.request()
  const oldChild = f.store.getWorkflow(f.paused.childWorkflowId)
  f.broker.resumeConvergence(request).catch(() => {})
  await f.store.committed
  assert.equal(f.sends.length, 1)
  assert.equal(f.store.getWorkflow(f.parent.id).phase, "codex_captured")
  f.broker.close()
  const restartedStore = new EventStore(f.directory)
  const restarted = f.makeBroker(restartedStore)
  await restarted.initialize()
  const result = await restarted.awaitWorkflow({ workflowId: f.parent.id, timeoutMs: 2_000 })
  assert.equal(result.status, "succeeded")
  assert.deepEqual(result.activeChat, { bindingKey: keys[1], generation: 1 })
  assert.equal(f.sends.length, 2)
  assert.deepEqual(restartedStore.getWorkflow(oldChild.id), oldChild)
  await restarted.resumeConvergence(request)
  assert.equal(f.sends.length, 2)
  assert.equal(f.counts().localCalls, 0)
})

test("restart during confirmed successor capture reattaches its exact child without another Send", async (t) => {
  const f = await harness(t)
  f.controls.holdSuccessorCapture = true
  await f.broker.resumeConvergence(f.request())
  await f.successorCaptureStarted
  await f.store.successorChildLinked
  const before = f.store.getWorkflow(f.parent.id)
  const child = f.store.getWorkflow(before.childWorkflowId)
  assert.equal(child.bindingKey, keys[1])
  assert.equal(child.phase, "send_confirmed")
  f.broker.close()
  f.controls.holdSuccessorCapture = false
  const restarted = f.makeBroker(new EventStore(f.directory))
  await restarted.initialize()
  const result = await restarted.awaitWorkflow({ workflowId: f.parent.id, timeoutMs: 2_000 })
  assert.equal(result.status, "succeeded")
  assert.equal(result.childWorkflowId, child.id)
  assert.equal(f.sends.length, 2)
  assert.equal(f.counts().localCalls, 0)
})

for (const cancelled of [false, true]) {
  test(`restart after terminal child and before parent checkpoint preserves authority (cancelled=${cancelled})`, async (t) => {
    const f = await harness(t, { Store: PauseBeforeParentCheckpointStore })
    const before = f.store.getWorkflow(f.parent.id)
    const child = f.store.getWorkflow(before.childWorkflowId)
    assert.equal(before.status, "running")
    assert.equal(before.phase, "chatgpt_running")
    assert.equal(child.status, "human_required")
    assert.equal(child.phase, "provider_paused")
    f.broker.close()
    if (cancelled) {
      await f.store.persist("test.child_cancelled", { ...child, phase: "cancelled", status: "cancelled" }, child)
    }
    const restartedStore = new EventStore(f.directory)
    const restarted = f.makeBroker(restartedStore)
    await restarted.initialize()
    const paused = await restarted.awaitWorkflow({ workflowId: f.parent.id, timeoutMs: 2_000 })
    assert.equal(paused.status, "human_required")
    if (cancelled) {
      assert.equal(paused.continuationCheckpoint, undefined)
      await assert.rejects(restarted.resumeConvergence({
        workflowId: f.parent.id, expectedCheckpointDigest: "f".repeat(64), successor: f.successor(),
      }))
      assert.equal(restartedStore.getWorkflow(child.id).status, "cancelled")
    } else {
      assert.equal(paused.phase, "continuation_paused")
      assert.equal(paused.continuationCheckpoint.reasonCode, "chatgpt_conversation_exhausted")
      assert.equal(restartedStore.getWorkflow(f.parent.id).private.continuationCheckpoint.source.workflowId, child.id)
      assert.deepEqual(restartedStore.getWorkflow(child.id), child)
    }
    assert.equal(f.sends.length, 1)
    assert.equal(f.counts().localCalls, 0)
  })
}
