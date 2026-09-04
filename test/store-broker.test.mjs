import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { Broker } from "../src/broker.mjs"
import {
  canonicalJsonBytes,
  operationKeyDigest,
  sha256Hex,
} from "../src/attachment-execution-receipt.mjs"
import {
  buildChatGptPrompt,
  createContract,
  digestJson,
  reviewSignature,
} from "../src/convergence.mjs"
import { EgoChatError } from "../src/errors.mjs"
import { EventStore } from "../src/store.mjs"
import { superviseWorkflow } from "../src/workflow-supervision.mjs"

const OPENAI_LIKE_TEST_TOKEN = `sk-proj-${"A".repeat(26)}123456`

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

async function createDataDir() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ego-chat-store-test-"))
  await fs.chmod(dataDir, 0o700)
  return dataDir
}

const unusedEgoAdapter = {
  adopt: async () => {
    throw new Error("not expected")
  },
  bind: async () => {
    throw new Error("not expected")
  },
  exchange: async () => {
    throw new Error("not expected")
  },
  ensureModelPolicy: async () => {
    throw new Error("not expected")
  },
  preflight: async () => {
    throw new Error("not expected")
  },
  reconcile: async () => {
    throw new Error("not expected")
  },
  reconcileBound: async () => {
    throw new Error("not expected")
  },
  reanchor: async () => {
    throw new Error("not expected")
  },
  verify: async () => {
    throw new Error("not expected")
  },
}

function modelPolicyObservation(overrides = {}) {
  return {
    adjusted: false,
    effortLabel: "Pro",
    key: "chatgpt-web-default",
    modelLabel: "GPT-5.6 Sol",
    pillLabel: "Pro",
    powerLevel: 5,
    powerMax: 5,
    ...overrides,
  }
}

function parseConvergenceIdentity(prompt) {
  return {
    candidateDigest: prompt.match(/Candidate digest: ([a-f0-9]{64})/)?.[1],
    cycle: Number(prompt.match(/Cycle: (\d+)/)?.[1]),
    targetDigest: prompt.match(/Target digest: ([a-f0-9]{64})/)?.[1],
  }
}

function convergenceCandidate(cycle, reviewPacket = `Candidate packet for cycle ${cycle}.`) {
  return {
    blockers: [],
    criteria: [
      { evidence: "The immutable identity is recorded.", id: "AC-1", status: "pass" },
      { evidence: `Cycle ${cycle} produced deterministic evidence.`, id: "AC-2", status: "pass" },
    ],
    reviewPacket,
    status: "candidate",
    summary: `Codex candidate ${cycle}.`,
  }
}

async function seedRestartBinding(dataDir, canonicalUrl) {
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      bind: async (input) => ({
        canonicalUrl: input.canonicalUrl,
        head: {
          fingerprint: "restart-initial-head",
          fingerprintVersion: "tail-v1",
          lastContentDigest: "a".repeat(64),
          lastMessageId: "restart-initial-assistant",
          lastRole: "assistant",
          messageCount: 2,
        },
        targetId: "restart-tab",
        taskSpaceId: 10,
      }),
    },
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl,
    mode: "existing",
    taskSpace: 10,
  })
  broker.close()
}

function convergenceRestartWorkflow({
  candidate,
  childWorkflowId = undefined,
  contract,
  cycle = 1,
  id,
  phase,
  review = undefined,
}) {
  const candidateDigest = digestJson(candidate)
  const cycleRecord = {
    candidate,
    candidateDigest,
    codex: {
      appServerRecoveryCount: 0,
      durationMs: 10,
      inspectionRetryCount: 0,
      responseDigest: "b".repeat(64),
      turnId: `codex-restart-captured-${cycle}`,
      workspaceActivity: { count: 1, types: ["commandExecution"] },
    },
    cycle,
    ...(review
      ? {
          chatGpt: {
            childWorkflowId: childWorkflowId ?? `captured-review-${cycle}`,
            protocolNormalization: "natural_language",
            protocolRepairCount: 0,
            protocolRepairWorkflowIds: [],
            redactedSecretSignatures: [],
            responseDigest: "c".repeat(64),
          },
          review,
          reviewSignature: reviewSignature(review),
        }
      : {}),
  }
  return {
    appServerRecoveryCount: 0,
    bindingKey: "ego-chat-main",
    candidateDigest,
    childWorkflowId,
    codexSandbox: "read-only",
    codexThreadId: "codex-convergence-thread",
    createdAt: new Date().toISOString(),
    cwd: process.cwd(),
    cycle,
    deadlineAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    id,
    inputDigest: digestJson({ contract, cwd: process.cwd(), sandbox: "read-only" }),
    kind: "convergence",
    maxCycles: null,
    phase,
    private: {
      contract,
      cycles: [cycleRecord],
      priorReview: review ?? null,
      request: {
        acceptanceCriteria: contract.criteria.map(({ text }) => text),
        allowTaskSpaceReclaim: true,
        bindingKey: "ego-chat-main",
        chatGptTimeoutMs: 30_000,
        codexSandbox: "read-only",
        codexTurnTimeoutMs: 30_000,
        cwd: process.cwd(),
        target: contract.target,
        wallClockTimeoutMs: 60 * 60_000,
      },
    },
    status: "running",
    targetDigest: contract.targetDigest,
    updatedAt: new Date().toISOString(),
  }
}

class FakeConvergenceAppServer {
  constructor(candidateFactory = (cycle) => convergenceCandidate(cycle)) {
    this.additionalContexts = []
    this.candidateFactory = candidateFactory
    this.closed = false
    this.prompts = []
    this.turns = 0
  }

  async close() {
    this.closed = true
  }

  async connect() {}

  async recoverStructuredTurn() {
    throw new Error("not expected")
  }

  async resumeThread(threadId) {
    return { id: threadId, sessionId: threadId }
  }

  async runStructuredTurn(input) {
    this.turns += 1
    this.additionalContexts.push(input.additionalContext ?? null)
    this.prompts.push(input.prompt)
    await input.onStarted?.({ turnId: `codex-turn-${this.turns}` })
    return {
      durationMs: 10,
      responseDigest: String(this.turns).repeat(64),
      turnId: `codex-turn-${this.turns}`,
      value: this.candidateFactory(this.turns),
      workspaceActivity: {
        count: 1,
        types: ["commandExecution"],
      },
    }
  }

  async startThread() {
    return { id: "codex-convergence-thread", sessionId: "codex-convergence-thread" }
  }

  async unsubscribeThread(threadId) {
    assert.equal(threadId, "codex-convergence-thread")
  }
}

class ConvergenceHistoryStore extends EventStore {
  constructor(dataDir) {
    super(dataDir)
    this.candidateCaptureHistory = []
  }

  async persist(type, workflow, expectedWorkflow = undefined) {
    if (type === "convergence.codex_candidate_captured") {
      this.candidateCaptureHistory.push(workflow.private.cycles.map((record) => ({
        hasCandidate: Object.hasOwn(record, "candidate"),
        hasReview: Object.hasOwn(record, "review"),
      })))
    }
    return super.persist(type, workflow, expectedWorkflow)
  }
}

class PauseAfterLivenessCaptureStore extends EventStore {
  constructor(dataDir) {
    super(dataDir)
    this.captureCommitted = new Promise((resolve) => {
      this.resolveCaptureCommitted = resolve
    })
    this.paused = false
  }

  async persist(type, workflow, expectedWorkflow = undefined) {
    const persisted = await super.persist(type, workflow, expectedWorkflow)
    const checkpoint = workflow.private?.cycles?.at(-1)?.livenessCheckpoint
    if (type === "convergence.codex_candidate_captured" && checkpoint && !this.paused) {
      this.paused = true
      this.resolveCaptureCommitted()
      return new Promise(() => {})
    }
    return persisted
  }
}

class PauseAfterTransitionStore extends EventStore {
  constructor(dataDir, transitionType) {
    super(dataDir)
    this.transitionCommitted = new Promise((resolve) => {
      this.resolveTransitionCommitted = resolve
    })
    this.transitionType = transitionType
    this.paused = false
  }

  async persist(type, workflow, expectedWorkflow = undefined) {
    const persisted = await super.persist(type, workflow, expectedWorkflow)
    if (type === this.transitionType && !this.paused) {
      this.paused = true
      this.resolveTransitionCommitted()
      return new Promise(() => {})
    }
    return persisted
  }
}

class PauseAfterEighthRecoveryResultStore extends EventStore {
  constructor(dataDir) {
    super(dataDir)
    this.resultCommitted = new Promise((resolve) => {
      this.resolveResultCommitted = resolve
    })
    this.paused = false
  }

  async persist(type, workflow, expectedWorkflow = undefined) {
    const checkpoint = workflow.private?.cycles?.at(-1)?.livenessCheckpoint
    const isEighthResultWrite = (
      (
        type === "convergence.codex_candidate_captured"
        && checkpoint?.kind === "app_server"
        && checkpoint.recoveryCount === 8
      )
      || (
        type === "convergence.codex_app_server_recovered"
        && workflow.consecutiveAppServerExitCount >= 8
      )
    )
    const persisted = await super.persist(type, workflow, expectedWorkflow)
    if (isEighthResultWrite && !this.paused) {
      this.paused = true
      this.resolveResultCommitted(type)
      return new Promise(() => {})
    }
    return persisted
  }
}

function createConvergenceEgoAdapter(reviewFactory) {
  let exchanges = 0
  const taskSpaceReclaimAuthorizations = []
  return {
    adapter: {
      ...unusedEgoAdapter,
      bind: async (input) => ({
        canonicalUrl: input.canonicalUrl,
        head: { fingerprint: "initial-head", lastRole: "assistant", messageCount: 2 },
        targetId: "convergence-tab",
        taskSpaceId: 10,
      }),
      exchange: async (input) => {
        exchanges += 1
        taskSpaceReclaimAuthorizations.push(input.allowTaskSpaceReclaim === true)
        assert.equal(input.modelPolicy.modelSelection, "strongest_available")
        assert.equal(input.modelPolicy.thinkingEffort, "maximum_available")
        const review = await reviewFactory(parseConvergenceIdentity(input.prompt), exchanges, input)
        const responseText = `${typeof review === "string" ? review : JSON.stringify(review)}\n${input.expectedTerminalMarker}`
        return {
          canonicalUrl: input.binding.canonicalUrl,
          durationMs: 20,
          head: {
            fingerprint: `convergence-head-${exchanges}`,
            fingerprintVersion: "tail-v1",
            lastContentDigest: digest(responseText),
            lastMessageId: `convergence-assistant-${exchanges}`,
            lastRole: "assistant",
            messageCount: 2 + exchanges * 2,
          },
          modelPolicy: modelPolicyObservation(),
          responseDigest: digest(responseText),
          responseText,
          targetId: "convergence-tab",
          taskSpaceId: 10,
          turnMarker: input.turnMarker,
        }
      },
    },
    get exchanges() {
      return exchanges
    },
    get taskSpaceReclaimAuthorizations() {
      return [...taskSpaceReclaimAuthorizations]
    },
  }
}

async function persistCompletedRecoveryReceipt(t, {
  suffix,
  value,
  workspaceActivity,
}) {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new PauseAfterTransitionStore(dataDir, "convergence.codex_app_server_recovered")
  const turnId = `codex-pending-result-${suffix}`
  const sourceClient = new FakeConvergenceAppServer()
  sourceClient.runStructuredTurn = async (input) => {
    await input.onStarted({ turnId })
    throw new EgoChatError("app_server_exited", "The accepted turn transport exited.")
  }
  const recoveryClient = new FakeConvergenceAppServer()
  recoveryClient.recoverStructuredTurn = async () => ({
    disposition: "completed",
    result: {
      durationMs: 10,
      responseDigest: "f".repeat(64),
      turnId,
      value,
      workspaceActivity,
    },
  })
  const clients = [sourceClient, recoveryClient]
  const broker = new Broker({
    appServerFactory: () => clients.shift(),
    egoAdapter: createConvergenceEgoAdapter(() => {
      throw new Error("review must not start before the completed result is durable")
    }).adapter,
    recoveryDelaysMs: [1],
    store,
  })
  await broker.initialize()
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: `https://chatgpt.com/c/convergence-pending-result-${suffix}`,
    mode: "existing",
    taskSpace: 10,
  })
  const started = await broker.startConvergence({
    acceptanceCriteria: ["Identity is bound.", "Deferred rotation is restart safe."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Keep durable completed-result continuation off its abandoned thread.",
  })
  await store.transitionCommitted
  broker.close()
  return { dataDir, started, turnId }
}

test("event ledger reconstructs the latest workflow and uses private file modes", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))

  const store = new EventStore(dataDir)
  await store.initialize()
  const workflow = {
    createdAt: "2026-08-24T00:00:00.000Z",
    id: "a844bc61-cafe-4f39-9fe4-f17570cbfc67",
    kind: "probe",
    status: "running",
    updatedAt: "2026-08-24T00:00:00.000Z",
  }
  await store.persist("workflow.started", workflow)
  await store.persist("workflow.cancelled", { ...workflow, status: "cancelled" })
  await store.persistBinding("binding.created", {
    canonicalUrl: null,
    key: "ego-chat-main",
    state: "unbound",
  })
  await store.persistModelPolicy("model_policy.verified", {
    createdAt: "2026-08-24T00:00:00.000Z",
    enforcement: "repair_then_verify",
    key: "chatgpt-web-default",
    lastObserved: modelPolicyObservation(),
    modelSelection: "strongest_available",
    revision: 1,
    state: "verified",
    thinkingEffort: "maximum_available",
    updatedAt: "2026-08-24T00:00:00.000Z",
  })

  const replayed = new EventStore(dataDir)
  await replayed.initialize()
  assert.equal(replayed.getWorkflow(workflow.id).status, "cancelled")
  assert.equal(replayed.getBinding("ego-chat-main").state, "unbound")
  assert.equal(replayed.getModelPolicy("chatgpt-web-default").lastObserved.modelLabel, "GPT-5.6 Sol")
  assert.equal((await fs.stat(path.join(dataDir, "events.jsonl"))).mode & 0o777, 0o600)
  assert.equal((await fs.stat(path.join(dataDir, "state.json"))).mode & 0o777, 0o600)
})

test("receipt admission atomically reserves capacity and globally consumes an A3K binding", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new EventStore(dataDir, { maxAttachmentIntents: 1 })
  await store.initialize()
  for (const [key, suffix] of [["a3k-one", "one"], ["a3k-two", "two"]]) {
    await store.persistBinding("binding.created", {
      canonicalUrl: `https://chatgpt.com/c/${suffix}`,
      headContentDigest: "c".repeat(64),
      headFingerprint: "d".repeat(64),
      headFingerprintVersion: "tail-v1",
      headMessageId: `assistant-${suffix}`,
      headRole: "assistant",
      key,
      messageCount: 2,
      revision: 1,
      state: "bound",
      targetId: `tab-${suffix}`,
      taskSpaceId: suffix === "one" ? 1 : 2,
    })
  }
  let sendCount = 0
  const never = new Promise(() => {})
  const broker = new Broker({
    attachmentReceiptAuthority: {
      qualify: async (request) => ({
        consumerSignerAuthorizationDigest: request.consumer_signer_authorization_sha256,
        runtimeIdentity: {
          executable_sha256: "1".repeat(64),
          implementation_git_sha: "2".repeat(40),
          package_inventory_sha256: "3".repeat(64),
        },
        signerEnrollmentDigest: "e".repeat(64),
        signerKeyId: `ed25519-spki-sha256:${"f".repeat(64)}`,
      }),
    },
    egoAdapter: {
      ...unusedEgoAdapter,
      captureExchange: async () => never,
      sendExchange: async () => {
        sendCount += 1
        return never
      },
    },
    store,
  })
  t.after(() => broker.close())
  const receiptCapture = {
    consumer_signer_authorization_sha256: "b".repeat(64),
    external_binding_sha256: "a".repeat(64),
    profile: "a3k-manual-canary-v1",
    receipt_capture_requested: true,
    schema: "ego-chat-receipt-enabled-exchange-request/v1",
  }
  const request = (bindingKey, suffix) => ({
    bindingKey,
    expectedTerminalMarker: `DONE_${suffix}`,
    prompt: `EGO_CHAT_A3K_RECEIPT_${suffix}\nprepare`,
    receiptCapture,
    timeoutMs: 30_000,
    turnMarker: `EGO_CHAT_A3K_RECEIPT_${suffix}`,
  })

  const admitted = await broker.startEgoExchange(request("a3k-one", "ONE12345"))
  await assert.rejects(
    broker.startEgoExchange(request("a3k-two", "TWO12345")),
    (error) => error.code === "attachment_external_binding_consumed",
  )
  await assert.rejects(
    broker.startEgoExchange({
      ...request("a3k-two", "CAP12345"),
      receiptCapture: {
        ...receiptCapture,
        external_binding_sha256: "f".repeat(64),
      },
    }),
    (error) => error.code === "attachment_evidence_capacity_exhausted",
  )
  await new Promise((resolve) => globalThis.setImmediate(resolve))

  assert.equal(sendCount, 1)
  assert.equal(store.getMetrics().attachmentIntentCount, 1)
  assert.equal(store.getMetrics().attachmentReservedBytes, 1024 * 1024)
  assert.equal(store.getMetrics().attachmentPermanentReservedBytes, 32 * 1024)
  assert.equal(store.getAttachmentIntent(admitted.id).source_workflow_id, admitted.id)
  assert.equal(
    store.getAttachmentExternalBinding("a3k-manual-canary-v1", "a".repeat(64)).state,
    "RESERVED",
  )

  const replayed = new EventStore(dataDir, { maxAttachmentIntents: 1 })
  await replayed.initialize()
  assert.equal(replayed.getMetrics().attachmentIntentCount, 1)
  assert.equal(replayed.getAttachmentIntent(admitted.id).source_workflow_id, admitted.id)
})

test("receipt admission fails before Send when signer authority is unavailable", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new EventStore(dataDir)
  await store.initialize()
  await store.persistBinding("binding.created", {
    canonicalUrl: "https://chatgpt.com/c/a3k-no-signer",
    headContentDigest: "c".repeat(64),
    headFingerprint: "d".repeat(64),
    headFingerprintVersion: "tail-v1",
    headMessageId: "assistant-before",
    headRole: "assistant",
    key: "a3k-no-signer",
    messageCount: 2,
    revision: 1,
    state: "bound",
    targetId: "tab-no-signer",
    taskSpaceId: 3,
  })
  let sendCount = 0
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      captureExchange: async () => {},
      sendExchange: async () => {
        sendCount += 1
      },
    },
    store,
  })
  t.after(() => broker.close())

  await assert.rejects(
    broker.startEgoExchange({
      bindingKey: "a3k-no-signer",
      expectedTerminalMarker: "DONE_NO_SIGNER",
      prompt: "EGO_CHAT_A3K_RECEIPT_NOSIGNER1\nprepare",
      receiptCapture: {
        consumer_signer_authorization_sha256: "b".repeat(64),
        external_binding_sha256: "a".repeat(64),
        profile: "a3k-manual-canary-v1",
        receipt_capture_requested: true,
        schema: "ego-chat-receipt-enabled-exchange-request/v1",
      },
      timeoutMs: 30_000,
      turnMarker: "EGO_CHAT_A3K_RECEIPT_NOSIGNER1",
    }),
    (error) => error.code === "attachment_receipt_authority_unavailable",
  )
  assert.equal(sendCount, 0)
  assert.equal(store.getMetrics().attachmentIntentCount, 0)
})

test("receipt Send confirmation atomically persists its immutable identity and event cross-digests", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new EventStore(dataDir)
  await store.initialize()
  await store.persistBinding("binding.created", {
    canonicalUrl: "https://chatgpt.com/c/a3k-confirmed-send",
    headContentDigest: "c".repeat(64),
    headFingerprint: "d".repeat(64),
    headFingerprintVersion: "tail-v1",
    headMessageId: "assistant-before",
    headRole: "assistant",
    key: "a3k-confirmed",
    messageCount: 2,
    revision: 7,
    state: "bound",
    targetId: "tab-confirmed",
    taskSpaceId: 4,
  })
  const sentAt = "2026-09-04T04:30:00.000Z"
  let legacyCaptureCalls = 0
  const broker = new Broker({
    attachmentReceiptAuthority: {
      qualify: async (request) => ({
        consumerSignerAuthorizationDigest: request.consumer_signer_authorization_sha256,
        runtimeIdentity: {
          executable_sha256: "1".repeat(64),
          implementation_git_sha: "2".repeat(40),
          package_inventory_sha256: "3".repeat(64),
        },
        signerEnrollmentDigest: "e".repeat(64),
        signerKeyId: `ed25519-spki-sha256:${"f".repeat(64)}`,
      }),
    },
    egoAdapter: {
      ...unusedEgoAdapter,
      captureExchange: async (input) => {
        legacyCaptureCalls += 1
        return {
          canonicalUrl: input.canonicalUrl,
          captureReason: "generation_running",
          captureState: "pending",
          generationRunning: true,
          promptMessageId: input.promptMessageId,
          targetId: "tab-confirmed",
          taskSpaceId: 4,
          turnMarker: input.turnMarker,
        }
      },
      sendExchange: async (input) => ({
        canonicalUrl: "https://chatgpt.com/c/a3k-confirmed-send",
        modelPolicy: modelPolicyObservation(),
        promptMessageId: "prompt-confirmed",
        sentAt,
        targetId: "tab-confirmed",
        taskSpaceId: 4,
        turnMarker: input.turnMarker,
      }),
    },
    store,
  })
  t.after(() => broker.close())
  const prompt = "EGO_CHAT_A3K_RECEIPT_CONFIRMED1\nprepare"
  const started = await broker.startEgoExchange({
    bindingKey: "a3k-confirmed",
    expectedTerminalMarker: "DONE_CONFIRMED",
    prompt,
    receiptCapture: {
      consumer_signer_authorization_sha256: "b".repeat(64),
      external_binding_sha256: "a".repeat(64),
      profile: "a3k-manual-canary-v1",
      receipt_capture_requested: true,
      schema: "ego-chat-receipt-enabled-exchange-request/v1",
    },
    timeoutMs: 30_000,
    turnMarker: "EGO_CHAT_A3K_RECEIPT_CONFIRMED1",
  })
  let workflow
  for (let attempt = 0; attempt < 50; attempt += 1) {
    workflow = store.getWorkflow(started.id)
    if (workflow?.phase === "awaiting_attachment_capture") break
    await new Promise((resolve) => globalThis.setTimeout(resolve, 5))
  }

  const identity = store.getConfirmedSendIdentity(started.id)
  assert.equal(workflow.phase, "awaiting_attachment_capture")
  assert.equal(legacyCaptureCalls, 0)
  assert.equal(identity.source_workflow_id, started.id)
  assert.equal(identity.binding_key, "a3k-confirmed")
  assert.equal(identity.binding_revision, 7)
  assert.equal(identity.canonical_conversation_url_sha256, sha256Hex(
    Buffer.from("https://chatgpt.com/c/a3k-confirmed-send", "utf8"),
  ))
  assert.equal(identity.conversation_id, "a3k-confirmed-send")
  assert.equal(identity.before_head_message_id, "assistant-before")
  assert.equal(identity.exact_prompt_utf8_sha256, digest(prompt))
  assert.equal(identity.exact_prompt_utf8_byte_length, Buffer.byteLength(prompt, "utf8"))
  assert.equal(identity.provider_prompt_message_id, "prompt-confirmed")
  assert.equal(identity.sent_at, sentAt)
  const eventProjection = {
    event_type: "send_confirmed",
    operation_key_sha256: operationKeyDigest(workflow.operationKey),
    prompt_message_id: "prompt-confirmed",
    schema: "ego-chat-confirmed-send-event/v1",
    sent_at: sentAt,
    sequence: identity.send_event_sequence,
    workflow_id: started.id,
  }
  assert.equal(identity.send_event_sha256, sha256Hex(canonicalJsonBytes(eventProjection)))
  assert.equal(
    workflow.private.confirmedSendIdentitySha256,
    sha256Hex(canonicalJsonBytes(identity)),
  )

  const replayed = new EventStore(dataDir)
  await replayed.initialize()
  assert.deepEqual(replayed.getConfirmedSendIdentity(started.id), identity)
  const restartedBroker = new Broker({ egoAdapter: unusedEgoAdapter, store: replayed })
  t.after(() => restartedBroker.close())
  await restartedBroker.initialize()
  await new Promise((resolve) => globalThis.setTimeout(resolve, 20))
  assert.equal(
    replayed.getWorkflow(started.id).phase,
    "awaiting_attachment_capture",
  )

  const captureStarted = await restartedBroker.startAttachmentCapture({
    schema: "ego-chat-attachment-capture-request/v1",
    source_workflow_id: started.id,
  })
  assert.equal(captureStarted.phase, "attachment_capture_started")
  const capture = replayed.getAttachmentCapture(started.id)
  assert.equal(capture.schema, "ego-chat-attachment-capture-operation/v1")
  assert.equal(capture.source_workflow_id, started.id)
  assert.equal(capture.state, "CAPTURING")
  assert.equal(capture.accumulated_monotonic_ms, 0)
  assert.deepEqual(capture.attempt_journal, [])
  assert.equal(
    Date.parse(capture.capture_deadline_at) - Date.parse(capture.capture_started_at),
    10 * 60 * 1_000,
  )
  const replay = await restartedBroker.startAttachmentCapture({
    schema: "ego-chat-attachment-capture-request/v1",
    source_workflow_id: started.id,
  })
  assert.equal(replay.phase, "attachment_capture_started")
  assert.deepEqual(replayed.getAttachmentCapture(started.id), capture)

  restartedBroker.close()
  const captureReplayStore = new EventStore(dataDir)
  await captureReplayStore.initialize()
  const captureReplayBroker = new Broker({
    egoAdapter: unusedEgoAdapter,
    store: captureReplayStore,
  })
  t.after(() => captureReplayBroker.close())
  await captureReplayBroker.initialize()
  const captureReplayed = captureReplayStore.getWorkflow(started.id)
  assert.equal(captureReplayed.phase, "attachment_capture_started")
  assert.equal(captureReplayed.status, "running")
  assert.equal(captureReplayed.humanRequired, undefined)
  assert.deepEqual(captureReplayStore.getAttachmentCapture(started.id), capture)
})

test("receipt evidence replay rejects a confirmed Send event without its immutable identity", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const workflowId = "4a08ed8c-1df9-4a31-913f-632d15195289"
  await fs.writeFile(path.join(dataDir, "events.jsonl"), `${JSON.stringify({
    at: "2026-09-04T04:31:00.000Z",
    confirmedSendEvent: {
      confirmed_send_identity_sha256: "a".repeat(64),
      event_type: "send_confirmed",
      operation_key_sha256: "b".repeat(64),
      prompt_message_id: "prompt-orphaned",
      schema: "ego-chat-confirmed-send-event/v1",
      sent_at: "2026-09-04T04:31:00.000Z",
      sequence: 1,
      workflow_id: workflowId,
    },
    schemaVersion: 1,
    seq: 1,
    type: "exchange.send_confirmed",
    workflow: {
      createdAt: "2026-09-04T04:30:00.000Z",
      id: workflowId,
      kind: "ego_exchange",
      status: "running",
      updatedAt: "2026-09-04T04:31:00.000Z",
    },
  })}\n`, { mode: 0o600 })

  const replayed = new EventStore(dataDir)
  await assert.rejects(
    replayed.initialize(),
    (error) => error.code === "corrupt_attachment_evidence_state",
  )
})

test("workflow status exposes exact convergence and ChatGPT delivery supervision", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new EventStore(dataDir)
  await store.initialize()
  const child = {
    createdAt: "2026-09-03T00:00:00.000Z",
    id: "4a993f1d-64dd-4741-a78d-55b4378521bc",
    kind: "ego_exchange",
    phase: "send_confirmed",
    status: "running",
    updatedAt: "2026-09-03T00:02:00.000Z",
  }
  const parent = {
    appServerRecoveryCount: 4,
    bindingKey: "ego-chat-main",
    childWorkflowId: child.id,
    codexInspectionRetryCount: 7,
    createdAt: "2026-09-03T00:00:00.000Z",
    cycle: 1,
    id: "ab36e59f-5667-493a-be9d-849f7198f857",
    kind: "convergence",
    phase: "chatgpt_running",
    status: "running",
    updatedAt: "2026-09-03T00:01:00.000Z",
  }
  await store.persist("workflow.started", child)
  await store.persist("workflow.started", parent)
  const broker = new Broker({ egoAdapter: unusedEgoAdapter, store })

  const visible = broker.getStatus().runningWorkflows.find((workflow) => workflow.id === parent.id)

  assert.equal(visible.supervision.chatGpt.delivery, "sent_waiting_response")
  assert.equal(visible.supervision.chatGpt.childPhase, "send_confirmed")
  assert.equal(visible.supervision.codex.appServerRecoveryCount, 4)
  assert.equal(visible.supervision.codex.inspectionRetryCount, 7)
  assert.equal(visible.supervision.lastTransitionAt, child.updatedAt)
  assert.match(visible.supervision.message, /durably sent/)
})

test("binding persistence compare-and-swap rejects a stale re-anchor commit", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new EventStore(dataDir)
  await store.initialize()
  const initial = {
    canonicalUrl: "https://chatgpt.com/c/binding-cas",
    headFingerprint: "a".repeat(64),
    key: "ego-chat-main",
    revision: 1,
    state: "bound",
  }
  await store.persistBinding("binding.created", initial)
  const concurrent = { ...initial, headFingerprint: "b".repeat(64), revision: 2 }
  await store.persistBinding("binding.concurrent", concurrent, initial)

  await assert.rejects(
    store.persistBinding(
      "binding.reanchored",
      { ...initial, headFingerprint: "c".repeat(64), revision: 2 },
      initial,
    ),
    (error) => error.code === "binding_transition_conflict",
  )
  assert.deepEqual(store.getBinding("ego-chat-main"), concurrent)
})

test("create-once binding is promoted and reused for every later exchange", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const seenBindingStates = []
  const seenTimeouts = []
  const canonicalUrl = "https://chatgpt.com/c/gate0-conversation"
  const egoAdapter = {
    bind: async (input) => ({
      canonicalUrl: null,
      targetId: input.targetId,
      taskSpaceId: 10,
    }),
    exchange: async (input) => {
      seenTimeouts.push(input.timeoutMs)
      seenBindingStates.push({
        canonicalUrl: input.binding.canonicalUrl,
        state: input.binding.state,
      })
      const responseText = input.expectedTerminalMarker
      return {
        canonicalUrl,
        durationMs: 75_000,
        head: {
          fingerprint: `head-${seenBindingStates.length}`,
          fingerprintVersion: "tail-v1",
          lastContentDigest: digest(responseText),
          lastMessageId: `assistant-${seenBindingStates.length}`,
          lastRole: "assistant",
          messageCount: seenBindingStates.length * 2,
        },
        modelPolicy: modelPolicyObservation(),
        responseDigest: digest(responseText),
        responseText,
        targetId: "bound-tab",
        taskSpaceId: 10,
        turnMarker: input.turnMarker,
      }
    },
    preflight: async () => {
      throw new Error("not expected")
    },
    reconcile: async () => {
      throw new Error("not expected")
    },
    verify: async () => {
      throw new Error("not expected")
    },
  }
  const broker = new Broker({ egoAdapter, store: new EventStore(dataDir) })
  await broker.initialize()
  t.after(() => broker.close())

  const created = await broker.bindConversation({
    bindingKey: "ego-chat-main",
    mode: "create_once",
    startUrl: "https://chatgpt.com/",
    targetId: "new-chat-tab",
    taskSpace: 10,
  })
  assert.equal(created.state, "unbound")
  assert.equal(created.canonicalUrl, null)

  for (const suffix of ["FIRST123", "SECOND456"]) {
    const turnMarker = `EGO_CHAT_GATE0_${suffix}`
    const request = {
      bindingKey: "ego-chat-main",
      expectedTerminalMarker: `DONE_${suffix}`,
      prompt: `${turnMarker}\nreview`,
      timeoutMs: 30_000,
      turnMarker,
    }
    const workflow = await broker.startEgoExchange(request)
    const duplicate = await broker.startEgoExchange(request)
    assert.equal(duplicate.id, workflow.id)
    const completed = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: workflow.id })
    assert.equal(completed.status, "succeeded")
    assert.equal(completed.result.canonicalUrl, canonicalUrl)
  }

  assert.deepEqual(seenBindingStates, [
    { canonicalUrl: null, state: "unbound" },
    { canonicalUrl, state: "bound" },
  ])
  assert.equal(seenTimeouts.length, 2)
  assert.ok(seenTimeouts.every((timeoutMs) => timeoutMs >= 2 * 60 * 60 * 1_000))
  const binding = broker.getConversationBinding({ bindingKey: "ego-chat-main" })
  assert.equal(binding.canonicalUrl, canonicalUrl)
  assert.equal(binding.headFingerprint, "head-2")
  assert.equal(binding.messageCount, 4)
  assert.equal(binding.revision, 3)
  assert.equal(binding.state, "bound")
  assert.equal(binding.targetId, "bound-tab")
  assert.equal(binding.modelPolicyKey, "chatgpt-web-default")
  const modelPolicy = broker.getModelPolicy()
  assert.equal(modelPolicy.modelSelection, "strongest_available")
  assert.equal(modelPolicy.thinkingEffort, "maximum_available")
  assert.equal(modelPolicy.revision, 2)
  assert.equal(modelPolicy.lastObserved.powerLevel, 5)
})

test("binding-owned task-space reclaim remains available during read-only capture", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/c/task-space-reclaim"
  const terminalMarker = "EGO_CHAT_TASK_SPACE_RECLAIM_DONE"
  const turnMarker = "EGO_CHAT_TASK_SPACE_RECLAIM_TEST"
  let captures = 0
  let sends = 0
  const egoAdapter = {
    ...unusedEgoAdapter,
    bind: async () => ({
      canonicalUrl,
      head: {
        fingerprint: "task-space-reclaim-before",
        fingerprintVersion: "tail-v1",
        lastContentDigest: "a".repeat(64),
        lastMessageId: "task-space-reclaim-assistant-before",
        lastRole: "assistant",
        messageCount: 2,
      },
      targetId: "task-space-reclaim-tab",
      taskSpaceId: 12,
    }),
    captureExchange: async (input) => {
      captures += 1
      assert.equal(input.allowTaskSpaceReclaim, true)
      const responseText = terminalMarker
      return {
        canonicalUrl,
        head: {
          fingerprint: "task-space-reclaim-after",
          fingerprintVersion: "tail-v1",
          lastContentDigest: digest(responseText),
          lastMessageId: "task-space-reclaim-assistant-after",
          lastRole: "assistant",
          messageCount: 4,
        },
        responseDigest: digest(responseText),
        responseText,
        targetId: "task-space-reclaim-tab",
        taskSpaceId: 12,
        turnMarker,
      }
    },
    sendExchange: async (input) => {
      sends += 1
      assert.equal(input.allowTaskSpaceReclaim, true)
      return {
        canonicalUrl,
        modelPolicy: modelPolicyObservation(),
        promptMessageId: "task-space-reclaim-user",
        sentAt: new Date().toISOString(),
        targetId: "task-space-reclaim-tab",
        taskSpaceControlRecovery: { method: "claim", taskSpaceId: 12 },
        taskSpaceId: 12,
        turnMarker,
      }
    },
  }
  const broker = new Broker({ egoAdapter, store: new EventStore(dataDir) })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl,
    mode: "existing",
    taskSpace: 12,
  })

  const started = await broker.startEgoExchange({
    allowTaskSpaceReclaim: true,
    bindingKey: "ego-chat-main",
    expectedTerminalMarker: terminalMarker,
    prompt: `${turnMarker}\nReview with explicit task-space recovery.`,
    timeoutMs: 30_000,
    turnMarker,
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.deepEqual(completed.result.taskSpaceControlRecovery, {
    method: "claim",
    taskSpaceId: 12,
  })
  assert.equal(sends, 1)
  assert.equal(captures, 1)
})

test("confirmed exchanges resume after a bounded pending capture without another Send", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/c/capture-slice"
  const terminalMarker = "EGO_CHAT_CAPTURE_SLICE_DONE"
  const turnMarker = "EGO_CHAT_CAPTURE_SLICE_TEST"
  const promptMessageId = "capture-slice-user"
  let captures = 0
  let sends = 0
  const egoAdapter = {
    ...unusedEgoAdapter,
    bind: async () => ({
      canonicalUrl,
      head: {
        fingerprint: "capture-slice-before",
        fingerprintVersion: "tail-v1",
        lastContentDigest: "a".repeat(64),
        lastMessageId: "capture-slice-assistant-before",
        lastRole: "assistant",
        messageCount: 2,
      },
      targetId: "capture-slice-tab",
      taskSpaceId: 18,
    }),
    captureExchange: async () => {
      captures += 1
      if (captures <= 2) {
        return {
          canonicalUrl,
          captureReason: "response_not_terminal",
          captureState: "pending",
          generationRunning: false,
          promptMessageId,
          targetId: "capture-slice-tab",
          taskSpaceId: 18,
          turnMarker,
        }
      }
      const responseText = terminalMarker
      return {
        canonicalUrl,
        head: {
          fingerprint: "capture-slice-after",
          fingerprintVersion: "tail-v1",
          lastContentDigest: digest(responseText),
          lastMessageId: "capture-slice-assistant-after",
          lastRole: "assistant",
          messageCount: 4,
        },
        responseDigest: digest(responseText),
        responseText,
        targetId: "capture-slice-tab",
        taskSpaceId: 18,
        turnMarker,
      }
    },
    sendExchange: async () => {
      sends += 1
      await new Promise((resolve) => setTimeout(resolve, 50))
      return {
        canonicalUrl,
        modelPolicy: modelPolicyObservation(),
        promptMessageId,
        sentAt: new Date().toISOString(),
        targetId: "capture-slice-tab",
        taskSpaceId: 18,
        turnMarker,
      }
    },
  }
  const broker = new Broker({ egoAdapter, store: new EventStore(dataDir) })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "capture-slice",
    canonicalUrl,
    mode: "existing",
    taskSpace: 18,
  })

  const started = await broker.startEgoExchange({
    bindingKey: "capture-slice",
    expectedTerminalMarker: terminalMarker,
    prompt: `${turnMarker}\nWait for the bounded capture to resume.`,
    timeoutMs: 30_000,
    turnMarker,
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 7_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.ok(
    Date.parse(completed.deadlineAt) - Date.parse(completed.createdAt)
      >= 2 * 60 * 60 * 1_000 + 25,
  )
  assert.equal(sends, 1)
  assert.equal(captures, 3)
  const events = (await fs.readFile(path.join(dataDir, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  const pendingEvents = events.filter((event) => event.type === "exchange.response_pending")
  assert.equal(pendingEvents.length, 1)
  assert.deepEqual(pendingEvents[0].workflow.capturePending, {
    generationRunning: false,
    observedAt: pendingEvents[0].at,
    reason: "response_not_terminal",
  })
})

test("recoverable maximum-model UI uncertainty stays in the same exchange until Send succeeds", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/c/model-policy-recovery"
  const terminalMarker = "EGO_CHAT_MODEL_POLICY_RECOVERY_DONE"
  const turnMarker = "EGO_CHAT_MODEL_POLICY_RECOVERY_TEST"
  let sends = 0
  const egoAdapter = {
    ...unusedEgoAdapter,
    bind: async () => ({
      canonicalUrl,
      head: {
        fingerprint: "model-policy-before",
        fingerprintVersion: "tail-v1",
        lastContentDigest: "a".repeat(64),
        lastMessageId: "model-policy-assistant-before",
        lastRole: "assistant",
        messageCount: 2,
      },
      targetId: "model-policy-tab",
      taskSpaceId: 21,
    }),
    captureExchange: async () => {
      const responseText = terminalMarker
      return {
        canonicalUrl,
        head: {
          fingerprint: "model-policy-after",
          fingerprintVersion: "tail-v1",
          lastContentDigest: digest(responseText),
          lastMessageId: "model-policy-assistant-after",
          lastRole: "assistant",
          messageCount: 4,
        },
        responseDigest: digest(responseText),
        responseText,
        targetId: "model-policy-tab",
        taskSpaceId: 21,
        turnMarker,
      }
    },
    sendExchange: async () => {
      sends += 1
      if (sends < 3) {
        throw new EgoChatError(
          "human_required",
          "The maximum-power control could not be read during this observation.",
          { reason: "model_policy_ui_unknown" },
        )
      }
      return {
        canonicalUrl,
        modelPolicy: modelPolicyObservation(),
        promptMessageId: "model-policy-user",
        sentAt: new Date().toISOString(),
        targetId: "model-policy-tab",
        taskSpaceId: 21,
        turnMarker,
      }
    },
  }
  const broker = new Broker({
    egoAdapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "model-policy-recovery",
    canonicalUrl,
    mode: "existing",
    taskSpace: 21,
  })

  const started = await broker.startEgoExchange({
    bindingKey: "model-policy-recovery",
    expectedTerminalMarker: terminalMarker,
    prompt: `${turnMarker}\nContinue after transient model-policy UI uncertainty.`,
    timeoutMs: 30_000,
    turnMarker,
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.recoveryCount, 2)
  assert.equal(completed.lastRecovery.code, "model_policy_ui_unknown")
  assert.equal(sends, 3)
})

test("a stable external assistant turn is automatically re-anchored before the same fresh Send", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/c/automatic-reanchor"
  const terminalMarker = "EGO_CHAT_AUTOMATIC_REANCHOR_DONE"
  const turnMarker = "EGO_CHAT_AUTOMATIC_REANCHOR_TEST"
  const initialHead = {
    fingerprint: "a".repeat(64),
    fingerprintVersion: "tail-v1",
    lastContentDigest: "b".repeat(64),
    lastMessageId: "automatic-reanchor-before",
    lastRole: "assistant",
    messageCount: 2,
  }
  const observedHead = {
    fingerprint: "c".repeat(64),
    fingerprintVersion: "tail-v1",
    lastContentDigest: "d".repeat(64),
    lastMessageId: "automatic-reanchor-external-assistant",
    lastRole: "assistant",
    messageCount: 4,
    renderedMessageCount: 4,
  }
  const headChange = {
    changeKind: "message_appended",
    expectedFingerprint: initialHead.fingerprint,
    expectedMessageCount: 2,
    expectedRole: "assistant",
    observedFingerprint: observedHead.fingerprint,
    observedRenderedMessageCount: 4,
    observedRole: "assistant",
  }
  let sends = 0
  let reanchors = 0
  const egoAdapter = {
    ...unusedEgoAdapter,
    bind: async () => ({
      canonicalUrl,
      head: initialHead,
      targetId: "automatic-reanchor-tab",
      taskSpaceId: 23,
    }),
    captureExchange: async () => {
      const responseText = terminalMarker
      return {
        canonicalUrl,
        head: {
          fingerprint: "e".repeat(64),
          fingerprintVersion: "tail-v1",
          lastContentDigest: digest(responseText),
          lastMessageId: "automatic-reanchor-after",
          lastRole: "assistant",
          messageCount: 6,
        },
        responseDigest: digest(responseText),
        responseText,
        targetId: "automatic-reanchor-tab",
        taskSpaceId: 23,
        turnMarker,
      }
    },
    reanchor: async (input) => {
      reanchors += 1
      assert.equal(input.binding.headFingerprint, initialHead.fingerprint)
      assert.equal(input.expectedObservedHeadFingerprint, observedHead.fingerprint)
      return {
        canonicalUrl,
        head: observedHead,
        headChange,
        targetId: "automatic-reanchor-tab",
        taskSpaceId: 23,
      }
    },
    sendExchange: async (input) => {
      sends += 1
      if (sends === 1) {
        throw new EgoChatError(
          "human_required",
          "The stable assistant head advanced before composition.",
          { evidence: { headChange }, reason: "conversation_head_changed" },
        )
      }
      assert.equal(input.binding.headFingerprint, observedHead.fingerprint)
      return {
        canonicalUrl,
        modelPolicy: modelPolicyObservation(),
        promptMessageId: "automatic-reanchor-user",
        sentAt: new Date().toISOString(),
        targetId: "automatic-reanchor-tab",
        taskSpaceId: 23,
        turnMarker,
      }
    },
  }
  const broker = new Broker({
    egoAdapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "automatic-reanchor",
    canonicalUrl,
    mode: "existing",
    taskSpace: 23,
  })

  const started = await broker.startEgoExchange({
    bindingKey: "automatic-reanchor",
    expectedTerminalMarker: terminalMarker,
    prompt: `${turnMarker}\nContinue on the latest stable assistant head.`,
    timeoutMs: 30_000,
    turnMarker,
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.automaticReanchorCount, 1)
  assert.equal(reanchors, 1)
  assert.equal(sends, 2)
  assert.equal(
    broker.getConversationBinding({ bindingKey: "automatic-reanchor" }).revision,
    3,
  )
})

test("confirmed response capture retries beyond three transient transport failures", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/c/capture-recovery"
  const terminalMarker = "EGO_CHAT_CAPTURE_RECOVERY_DONE"
  const turnMarker = "EGO_CHAT_CAPTURE_RECOVERY_TEST"
  let captures = 0
  const egoAdapter = {
    ...unusedEgoAdapter,
    bind: async () => ({
      canonicalUrl,
      head: {
        fingerprint: "capture-recovery-before",
        fingerprintVersion: "tail-v1",
        lastContentDigest: "a".repeat(64),
        lastMessageId: "capture-recovery-assistant-before",
        lastRole: "assistant",
        messageCount: 2,
      },
      targetId: "capture-recovery-tab",
      taskSpaceId: 22,
    }),
    captureExchange: async () => {
      captures += 1
      if (captures <= 4) {
        throw new EgoChatError("human_required", "The browser pair is not attributable.", {
          evidence: {
            anchorCount: 1,
            committedCount: 3,
            promptMessageIdMatches: true,
            renderedMarkerCount: 1,
            responseEndsWithTerminal: true,
            responseText: "must not enter durable recovery state",
            terminalCount: 1,
          },
          reason: "bound_reconciliation_mismatch",
        })
      }
      const responseText = terminalMarker
      return {
        canonicalUrl,
        head: {
          fingerprint: "capture-recovery-after",
          fingerprintVersion: "tail-v1",
          lastContentDigest: digest(responseText),
          lastMessageId: "capture-recovery-assistant-after",
          lastRole: "assistant",
          messageCount: 4,
        },
        responseDigest: digest(responseText),
        responseText,
        targetId: "capture-recovery-tab",
        taskSpaceId: 22,
        turnMarker,
      }
    },
    sendExchange: async () => ({
      canonicalUrl,
      modelPolicy: modelPolicyObservation(),
      promptMessageId: "capture-recovery-user",
      sentAt: new Date().toISOString(),
      targetId: "capture-recovery-tab",
      taskSpaceId: 22,
      turnMarker,
    }),
  }
  const broker = new Broker({
    egoAdapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "capture-recovery",
    canonicalUrl,
    mode: "existing",
    taskSpace: 22,
  })

  const started = await broker.startEgoExchange({
    bindingKey: "capture-recovery",
    expectedTerminalMarker: terminalMarker,
    prompt: `${turnMarker}\nKeep waiting for the confirmed response.`,
    timeoutMs: 30_000,
    turnMarker,
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.captureRecoveryCount, 4)
  assert.deepEqual(completed.lastCaptureRecovery.evidence, {
    anchorCount: 1,
    committedCount: 3,
    promptMessageIdMatches: true,
    renderedMarkerCount: 1,
    responseEndsWithTerminal: true,
    terminalCount: 1,
  })
  assert.equal(Object.hasOwn(completed.lastCaptureRecovery.evidence, "responseText"), false)
  assert.equal(captures, 5)
})

test("an image-only response protocol gap stops capture without retrying", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/c/image-only-response"
  const terminalMarker = "EGO_CHAT_IMAGE_ONLY_RESPONSE_DONE"
  const turnMarker = "EGO_CHAT_IMAGE_ONLY_RESPONSE_TEST"
  let captures = 0
  const egoAdapter = {
    ...unusedEgoAdapter,
    bind: async () => ({
      canonicalUrl,
      head: {
        fingerprint: "image-only-before",
        fingerprintVersion: "tail-v1",
        lastContentDigest: "a".repeat(64),
        lastMessageId: "image-only-assistant-before",
        lastRole: "assistant",
        messageCount: 2,
      },
      targetId: "image-only-tab",
      taskSpaceId: 24,
    }),
    captureExchange: async () => {
      captures += 1
      if (captures > 1) {
        throw new EgoChatError("human_required", "Unexpected retry.", {
          reason: "authentication_required",
        })
      }
      throw new EgoChatError(
        "human_required",
        "The confirmed prompt produced an image-only assistant turn.",
        {
          evidence: {
            attachmentCount: 1,
            promptMessageIdMatches: true,
            responseMessageIdPresent: true,
            responseText: "must not enter durable terminal evidence",
          },
          reason: "image_only_response_without_terminal_marker",
        },
      )
    },
    sendExchange: async () => ({
      canonicalUrl,
      modelPolicy: modelPolicyObservation(),
      promptMessageId: "image-only-user",
      sentAt: new Date().toISOString(),
      targetId: "image-only-tab",
      taskSpaceId: 24,
      turnMarker,
    }),
  }
  const broker = new Broker({
    egoAdapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "image-only-response",
    canonicalUrl,
    mode: "existing",
    taskSpace: 24,
  })

  const started = await broker.startEgoExchange({
    bindingKey: "image-only-response",
    expectedTerminalMarker: terminalMarker,
    prompt: `${turnMarker}\nGenerate one image.`,
    timeoutMs: 30_000,
    turnMarker,
  })
  const stopped = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: started.id })

  assert.equal(stopped.status, "human_required")
  assert.equal(
    stopped.humanRequired.code,
    "image_only_response_without_terminal_marker",
  )
  assert.deepEqual(stopped.humanRequired.evidence, {
    attachmentCount: 1,
    promptMessageIdMatches: true,
    responseMessageIdPresent: true,
  })
  assert.equal(captures, 1)
})

test("event checkpoints bound the active ledger and result blobs are digest verified", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new EventStore(dataDir, { maxEvents: 2 })
  await store.initialize()
  const first = {
    createdAt: "2026-08-24T00:00:00.000Z",
    id: "f36250f7-e634-4dd4-b430-873de1074fcb",
    kind: "probe",
    status: "running",
    updatedAt: "2026-08-24T00:00:00.000Z",
  }
  const second = {
    ...first,
    id: "624f02af-b1ab-49c5-b4fd-27291f424b98",
  }
  await store.persist("workflow.started", first)
  await store.persist("workflow.started", second)

  assert.equal(await fs.readFile(path.join(dataDir, "events.jsonl"), "utf8"), "")
  assert.ok((await fs.stat(path.join(dataDir, "checkpoint.json"))).size > 0)
  const replayed = new EventStore(dataDir, { maxEvents: 2 })
  await replayed.initialize()
  assert.equal(replayed.getWorkflow(first.id).status, "running")
  assert.equal(replayed.getWorkflow(second.id).status, "running")

  const body = "large-result\n".repeat(2_000)
  const reference = await replayed.putBlob(body, { mediaType: "text/plain" })
  const captured = await replayed.readBlob(reference, { maxBytes: 256 * 1024, offset: 0 })
  assert.equal(captured.complete, true)
  assert.equal(captured.text, body)
  assert.equal(captured.digest, digest(body))

  const unicodeBody = "A😀漢B"
  const unicodeReference = await replayed.putBlob(unicodeBody)
  const unicodeChunks = []
  let offset = 0
  do {
    const chunk = await replayed.readBlob(unicodeReference, { maxBytes: 4, offset })
    unicodeChunks.push(chunk.text)
    offset = chunk.nextOffset
  } while (offset !== null)
  assert.equal(unicodeChunks.join(""), unicodeBody)
  await assert.rejects(
    replayed.readBlob(unicodeReference, { maxBytes: 4, offset: 2 }),
    (error) => error.code === "invalid_result_range",
  )
  await assert.rejects(
    replayed.readBlob(unicodeReference, { maxBytes: 4, offset: 100 }),
    (error) => error.code === "invalid_result_range",
  )
  await assert.rejects(
    replayed.readBlob({ digest: "../outside" }, { maxBytes: 4, offset: 0 }),
    (error) => error.code === "invalid_result_ref",
  )

  const corruptReference = await replayed.putBlob("digest-verified body")
  const corruptPath = path.join(
    dataDir,
    "blobs",
    "sha256",
    corruptReference.digest.slice(0, 2),
    corruptReference.digest,
  )
  await fs.writeFile(corruptPath, "tampered body", { mode: 0o600 })
  await assert.rejects(
    replayed.readBlob(corruptReference, { maxBytes: 64, offset: 0 }),
    (error) => error.code === "corrupt_result_blob",
  )
})

test("checkpoint recovery falls back to the last atomic state snapshot", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new EventStore(dataDir, { maxEvents: 1 })
  await store.initialize()
  const workflow = {
    createdAt: "2026-08-24T00:00:00.000Z",
    id: "70b8fe89-319b-4205-a042-c56ae541c5fc",
    kind: "probe",
    status: "running",
    updatedAt: "2026-08-24T00:00:00.000Z",
  }
  await store.persist("workflow.started", workflow)
  const manifestPath = path.join(dataDir, "checkpoint.manifest.json")
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"))
  await fs.writeFile(manifestPath, `${JSON.stringify({ ...manifest, digest: "0".repeat(64) })}\n`, {
    mode: 0o600,
  })

  const recovered = new EventStore(dataDir)
  await recovered.initialize()

  assert.equal(recovered.getWorkflow(workflow.id).status, "running")
})

test("checkpoint recovery uses the atomic state snapshot when either checkpoint file is missing", async (t) => {
  for (const missingFile of ["checkpoint.json", "checkpoint.manifest.json"]) {
    const dataDir = await createDataDir()
    t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
    const store = new EventStore(dataDir, { maxEvents: 1 })
    await store.initialize()
    const workflow = {
      createdAt: "2026-08-24T00:00:00.000Z",
      id: missingFile === "checkpoint.json"
        ? "4f9d2973-fc0e-4a50-9a45-7e85cdabb29f"
        : "37aef2ec-810f-4a20-bb7c-9f21ba0b3a99",
      kind: "probe",
      status: "running",
      updatedAt: "2026-08-24T00:00:00.000Z",
    }
    await store.persist("workflow.started", workflow)
    await fs.unlink(path.join(dataDir, missingFile))

    const recovered = new EventStore(dataDir)
    await recovered.initialize()

    assert.equal(recovered.getWorkflow(workflow.id).status, "running")
  }
})

test("v0.1 exchange history migrates into durable at-most-once operation identity", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const turnMarker = "EGO_CHAT_LEGACY_OPERATION_20260824"
  const operationKey = `exchange:ego-chat-main:${turnMarker}`
  const legacyWorkflow = {
    bindingKey: "ego-chat-main",
    createdAt: "2026-08-24T00:00:00.000Z",
    id: "49bf5d17-f7f4-43a5-8089-0ace4db3297a",
    inputDigest: "d".repeat(64),
    kind: "ego_exchange",
    reconciliation: { turnMarker },
    status: "succeeded",
    updatedAt: "2026-08-24T00:00:01.000Z",
  }
  await fs.writeFile(path.join(dataDir, "events.jsonl"), `${JSON.stringify({
    at: legacyWorkflow.createdAt,
    schemaVersion: 1,
    seq: 1,
    type: "workflow.started",
    workflow: legacyWorkflow,
  })}\n`, { mode: 0o600 })

  const migrated = new EventStore(dataDir)
  await migrated.initialize()

  assert.equal(migrated.getOperation(operationKey).workflowId, legacyWorkflow.id)
  assert.equal(migrated.getWorkflow(legacyWorkflow.id).operationKey, operationKey)
  await assert.rejects(
    migrated.persistStarted("workflow.started", {
      ...legacyWorkflow,
      id: "d9839931-5c3b-4874-82b8-758428857343",
      inputDigest: "e".repeat(64),
      operationKey,
    }),
    (error) => error.code === "operation_key_conflict",
  )
})

test("large ChatGPT responses persist by reference and remain digest-bound readable", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const seeded = new EventStore(dataDir)
  await seeded.initialize()
  const now = "2026-08-24T00:00:00.000Z"
  await seeded.persistBinding("binding.created", {
    canonicalUrl: "https://chatgpt.com/c/large-result",
    createdAt: now,
    headContentDigest: "a".repeat(64),
    headFingerprint: "head-before-large-result",
    headFingerprintVersion: "tail-v1",
    headMessageId: "assistant-before-large-result",
    headRole: "assistant",
    key: "ego-chat-main",
    messageCount: 2,
    mode: "existing",
    modelPolicyKey: "chatgpt-web-default",
    projectUrl: null,
    revision: 1,
    startUrl: "https://chatgpt.com/c/large-result",
    state: "bound",
    targetId: "large-result-tab",
    taskSpaceId: 10,
    updatedAt: now,
    verifiedAt: now,
  })
  await seeded.persistModelPolicy("model_policy.verified", {
    createdAt: now,
    enforcement: "repair_then_verify",
    key: "chatgpt-web-default",
    lastObserved: {
      ...modelPolicyObservation(),
      bindingKey: "ego-chat-main",
      selectionChanged: false,
      verifiedAt: now,
    },
    modelSelection: "strongest_available",
    revision: 1,
    state: "verified",
    thinkingEffort: "maximum_available",
    updatedAt: now,
  })
  const responseText = `${"review evidence ".repeat(2_000)}LARGE_RESULT_DONE`
  const egoAdapter = {
    ...unusedEgoAdapter,
    exchange: async (input) => ({
      canonicalUrl: input.binding.canonicalUrl,
      durationMs: 20,
      head: {
        fingerprint: "head-after-large-result",
        fingerprintVersion: "tail-v1",
        lastContentDigest: digest(responseText),
        lastMessageId: "assistant-after-large-result",
        lastRole: "assistant",
        messageCount: 4,
      },
      modelPolicy: modelPolicyObservation(),
      responseDigest: digest(responseText),
      responseText,
      targetId: input.binding.targetId,
      taskSpaceId: input.binding.taskSpaceId,
      turnMarker: input.turnMarker,
    }),
  }
  const broker = new Broker({ egoAdapter, store: new EventStore(dataDir) })
  await broker.initialize()
  t.after(() => broker.close())
  const turnMarker = "EGO_CHAT_LARGE_RESULT_20260824"
  const started = await broker.startEgoExchange({
    bindingKey: "ego-chat-main",
    expectedTerminalMarker: "LARGE_RESULT_DONE",
    prompt: `${turnMarker}\nReturn a large review.`,
    timeoutMs: 30_000,
    turnMarker,
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.result.responseText, undefined)
  assert.equal(completed.result.responseRef.digest, digest(responseText))
  assert.ok(completed.result.responseExcerpt.length < responseText.length)
  const captured = await broker.readResult({
    expectedDigest: completed.result.responseRef.digest,
    maxBytes: 256 * 1024,
    offset: 0,
    workflowId: started.id,
  })
  assert.equal(captured.complete, true)
  assert.equal(captured.text, responseText)
})

test("blob quota expiry keeps bounded metadata while removing an unpinned raw body", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new EventStore(dataDir, {
    maxBlobBytes: 64,
    maxEvents: 1,
    rawRetentionMs: -1,
  })
  await store.initialize()
  const body = "a response larger than the configured test quota"
  const responseRef = await store.putBlob(body)
  const workflow = {
    createdAt: new Date().toISOString(),
    id: "e81747d3-76eb-4388-8071-f4c5f226db8c",
    kind: "ego_exchange",
    result: {
      responseDigest: digest(body),
      responseRef,
    },
    status: "succeeded",
    updatedAt: new Date().toISOString(),
  }
  await store.persist("workflow.succeeded", workflow)

  const retained = store.getWorkflow(workflow.id)
  assert.equal(retained.result.responseExpired, true)
  assert.equal(retained.result.responseRef, undefined)
  assert.equal(store.getMetrics().blobBytes, 0)
  await assert.rejects(
    store.readBlob(responseRef, { maxBytes: 1_024, offset: 0 }),
    (error) => error.code === "result_not_found",
  )
})

test("blob retention pins running and human-required recovery bodies within the hard quota", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const options = {
    maxBlobBytes: 64,
    maxEvents: 1,
    rawRetentionMs: 30 * 24 * 60 * 60 * 1_000,
  }
  const store = new EventStore(dataDir, options)
  await store.initialize()
  const now = new Date().toISOString()
  const pinnedCases = [
    ["running", "running recovery body"],
    ["human_required", "human-required recovery body"],
  ]
  const references = []
  for (const [status, body] of pinnedCases) {
    const responseRef = await store.putBlob(body)
    references.push([body, responseRef])
    await store.persist(`workflow.${status}`, {
      createdAt: now,
      id: status === "running"
        ? "196c3bff-75c1-4bb2-852d-33cbcf21927b"
        : "d7fe2fbf-f9f7-4f58-8c63-c2f66528982c",
      kind: "ego_exchange",
      result: { responseDigest: digest(body), responseRef },
      status,
      updatedAt: now,
    })
  }

  const replayed = new EventStore(dataDir, options)
  await replayed.initialize()
  for (const [body, responseRef] of references) {
    const captured = await replayed.readBlob(responseRef, { maxBytes: 1_024, offset: 0 })
    assert.equal(captured.text, body)
  }
  assert.ok(replayed.getMetrics().blobBytes <= options.maxBlobBytes)
  assert.equal(replayed.getMetrics().protectedBlobBytes, replayed.getMetrics().blobBytes)
})

test("worst-case protected result admission stops before a new browser workflow", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const options = {
    maxBlobBytes: 64,
    maxEvents: 1,
    maxOperations: 10,
    maxRecoveryWorkflows: 10,
    maxResultBytes: 32,
  }
  const store = new EventStore(dataDir, options)
  await store.initialize()
  const workflows = []
  for (const [index, fill] of [[1, "a"], [2, "b"]]) {
    const now = new Date().toISOString()
    const workflow = {
      bindingKey: "ego-chat-main",
      createdAt: now,
      id: `00000000-0000-4000-8000-00000000000${index}`,
      inputDigest: String(index).repeat(64),
      kind: "ego_exchange",
      operationKey: `exchange:ego-chat-main:EGO_CHAT_CAPACITY_${index}`,
      status: "running",
      updatedAt: now,
    }
    const started = await store.persistStarted("workflow.started", workflow)
    assert.equal(started.created, true)
    const body = fill.repeat(24)
    const responseRef = await store.putBlob(body)
    const stopped = {
      ...workflow,
      result: { responseDigest: digest(body), responseRef },
      status: "human_required",
      updatedAt: new Date().toISOString(),
    }
    await store.persist("workflow.human_required", stopped)
    workflows.push(stopped)
  }

  const blocked = {
    bindingKey: "ego-chat-main",
    createdAt: new Date().toISOString(),
    id: "00000000-0000-4000-8000-000000000003",
    inputDigest: "3".repeat(64),
    kind: "ego_exchange",
    operationKey: "exchange:ego-chat-main:EGO_CHAT_CAPACITY_3",
    status: "running",
    updatedAt: new Date().toISOString(),
  }
  await assert.rejects(
    store.persistStarted("workflow.started", blocked),
    (error) => error.code === "protected_storage_capacity_exhausted"
      && error.details.protectedBlobBytes === 48
      && error.details.requiredBytes === 80,
  )
  assert.equal(store.getWorkflow(blocked.id), undefined)
  assert.equal(store.getOperation(blocked.operationKey), undefined)
  assert.equal(store.getMetrics().blobBytes, 48)
  assert.equal(store.getMetrics().protectedBlobBytes, 48)

  const exactRetry = await store.persistStarted("workflow.started", workflows[0])
  assert.equal(exactRetry.created, false)
  assert.equal(exactRetry.workflow.id, workflows[0].id)

  const replayed = new EventStore(dataDir, options)
  await replayed.initialize()
  await assert.rejects(
    replayed.persistStarted("workflow.started", blocked),
    (error) => error.code === "protected_storage_capacity_exhausted",
  )
  const replayedRetry = await replayed.persistStarted("workflow.started", workflows[1])
  assert.equal(replayedRetry.created, false)
})

test("protected-capacity rejection occurs before policy mutation, composition, or Send", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const options = {
    maxBlobBytes: 64,
    maxOperations: 10,
    maxRecoveryWorkflows: 10,
    maxResultBytes: 32,
  }
  const store = new EventStore(dataDir, options)
  await store.initialize()
  await store.persistBinding("binding.created", {
    canonicalUrl: "https://chatgpt.com/c/storage-admission-test",
    createdAt: new Date().toISOString(),
    headContentDigest: "a".repeat(64),
    headFingerprint: "capacity-head",
    headFingerprintVersion: "tail-v1",
    headMessageId: "capacity-assistant",
    headRole: "assistant",
    key: "ego-chat-main",
    messageCount: 2,
    modelPolicyKey: "chatgpt-web-default",
    revision: 1,
    state: "bound",
    targetId: "capacity-tab",
    taskSpaceId: 10,
    updatedAt: new Date().toISOString(),
  })
  for (const [index, fill] of [[1, "c"], [2, "d"]]) {
    const body = fill.repeat(24)
    const responseRef = await store.putBlob(body)
    await store.persist("workflow.human_required", {
      bindingKey: "ego-chat-main",
      createdAt: new Date().toISOString(),
      id: `20000000-0000-4000-8000-00000000000${index}`,
      kind: "ego_exchange",
      result: { responseDigest: digest(body), responseRef },
      status: "human_required",
      updatedAt: new Date().toISOString(),
    })
  }
  let browserOperations = 0
  const broker = new Broker({
    egoAdapter: new Proxy(unusedEgoAdapter, {
      get(target, property, receiver) {
        if (property === "exchange" || property === "sendExchange") {
          return async () => {
            browserOperations += 1
            throw new Error("capacity rejection must occur before browser work")
          }
        }
        return Reflect.get(target, property, receiver)
      },
    }),
    store,
  })
  await broker.initialize()
  t.after(() => broker.close())
  const turnMarker = "EGO_CHAT_STORAGE_ADMISSION_TEST"
  await assert.rejects(
    broker.startEgoExchange({
      bindingKey: "ego-chat-main",
      expectedTerminalMarker: "EGO_CHAT_STORAGE_ADMISSION_DONE",
      prompt: `${turnMarker}\nDo not reach the browser.`,
      timeoutMs: 30_000,
      turnMarker,
    }),
    (error) => error.code === "protected_storage_capacity_exhausted",
  )
  assert.equal(browserOperations, 0)
})

test("a bodyless late response keeps quota reserved across restart until exact reconciliation stores it", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const options = {
    maxBlobBytes: 64,
    maxEvents: 1,
    maxOperations: 10,
    maxRecoveryWorkflows: 10,
    maxResultBytes: 32,
  }
  const terminalMarker = "RECOVERY_RESULT_DONE"
  const responseText = terminalMarker
  const responseDigest = digest(responseText)
  const turnMarker = "EGO_CHAT_RESERVED_RECOVERY_20260825"
  const prompt = `${turnMarker}\nRecover the exact late response.`
  const beforeHead = {
    fingerprint: "reserved-before-tail",
    fingerprintVersion: "tail-v1",
    lastContentDigest: "a".repeat(64),
    lastMessageId: "reserved-before-assistant",
    lastRole: "assistant",
    messageCount: 2,
  }
  let browserCalls = 0
  let reconciliationCalls = 0
  const egoAdapter = {
    ...unusedEgoAdapter,
    bind: async (input) => ({
      canonicalUrl: input.canonicalUrl,
      head: beforeHead,
      targetId: "reserved-tab",
      taskSpaceId: 10,
    }),
    exchange: async () => {
      browserCalls += 1
      throw new EgoChatError(
        "human_required",
        "The click was not confirmed.",
        {
          evidence: { modelPolicy: modelPolicyObservation() },
          reason: "send_confirmation_ambiguous",
        },
      )
    },
    reconcileBound: async (input) => {
      reconciliationCalls += 1
      assert.equal(input.expectedPreviousMessageId, beforeHead.lastMessageId)
      return {
        canonicalUrl: input.binding.canonicalUrl,
        head: {
          fingerprint: "reserved-after-tail",
          fingerprintVersion: "tail-v1",
          lastContentDigest: responseDigest,
          lastMessageId: "reserved-after-assistant",
          lastRole: "assistant",
          messageCount: 4,
        },
        responseDigest,
        responseText,
        targetId: "reserved-tab",
        taskSpaceId: 10,
        turnMarker,
      }
    },
  }
  const store = new EventStore(dataDir, options)
  const broker = new Broker({ egoAdapter, store })
  await broker.initialize()
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/reserved-late-response",
    mode: "existing",
    taskSpace: 10,
  })
  const pinnedBody = "p".repeat(32)
  const pinnedRef = await store.putBlob(pinnedBody)
  await store.persist("workflow.human_required", {
    bindingKey: "another-binding",
    createdAt: new Date().toISOString(),
    id: "30000000-0000-4000-8000-000000000001",
    kind: "ego_exchange",
    result: { responseDigest: digest(pinnedBody), responseRef: pinnedRef },
    status: "human_required",
    updatedAt: new Date().toISOString(),
  })

  const started = await broker.startEgoExchange({
    bindingKey: "ego-chat-main",
    expectedTerminalMarker: terminalMarker,
    prompt,
    timeoutMs: 30_000,
    turnMarker,
  })
  const stopped = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: started.id })
  assert.equal(stopped.status, "human_required")
  assert.equal(store.getMetrics().protectedBlobBytes, 32)
  assert.equal(store.getMetrics().reservedBlobBytes, 32)
  broker.close()

  const replayedStore = new EventStore(dataDir, options)
  const replayedBroker = new Broker({ egoAdapter, store: replayedStore })
  await replayedBroker.initialize()
  t.after(() => replayedBroker.close())
  assert.equal(replayedStore.getMetrics().protectedBlobBytes, 32)
  assert.equal(replayedStore.getMetrics().reservedBlobBytes, 32)
  await assert.rejects(
    replayedBroker.startEgoExchange({
      bindingKey: "ego-chat-main",
      expectedTerminalMarker: "NEW_RESULT_DONE",
      prompt: "EGO_CHAT_NEW_RESERVED_OPERATION_20260825\nDo not reach the browser.",
      timeoutMs: 30_000,
      turnMarker: "EGO_CHAT_NEW_RESERVED_OPERATION_20260825",
    }),
    (error) => error.code === "protected_storage_capacity_exhausted",
  )
  assert.equal(browserCalls, 1)

  const reconciled = await replayedBroker.reconcileConversation({
    bindingKey: "ego-chat-main",
    workflowId: stopped.id,
  })
  assert.equal(reconciled.recovery.responseText, responseText)
  assert.equal(replayedStore.getMetrics().protectedBlobBytes, 32)
  assert.equal(replayedStore.getMetrics().reservedBlobBytes, 0)
  assert.equal(replayedStore.getMetrics().blobBytes, 32 + Buffer.byteLength(responseText))
  assert.equal(reconciliationCalls, 1)

  replayedBroker.close()
  const finalStore = new EventStore(dataDir, options)
  const finalBroker = new Broker({ egoAdapter, store: finalStore })
  await finalBroker.initialize()
  t.after(() => finalBroker.close())
  const captured = await finalBroker.readResult({
    expectedDigest: responseDigest,
    maxBytes: 32,
    offset: 0,
    workflowId: stopped.id,
  })
  assert.equal(captured.text, responseText)
  const exactRetry = await finalBroker.startEgoExchange({
    bindingKey: "ego-chat-main",
    expectedTerminalMarker: terminalMarker,
    prompt,
    timeoutMs: 30_000,
    turnMarker,
  })
  assert.equal(exactRetry.status, "succeeded")
  assert.equal(browserCalls, 1)
  assert.equal(reconciliationCalls, 1)
})

test("explicit recovery abandonment releases a failed workflow reservation but preserves its operation tombstone", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const options = {
    maxBlobBytes: 32,
    maxEvents: 1,
    maxOperations: 10,
    maxRecoveryWorkflows: 10,
    maxResultBytes: 32,
  }
  const workflow = {
    bindingKey: "ego-chat-main",
    createdAt: new Date().toISOString(),
    id: "30000000-0000-4000-8000-000000000002",
    inputDigest: "b".repeat(64),
    kind: "ego_exchange",
    operationKey: "exchange:ego-chat-main:EGO_CHAT_ABANDON_FAILED_20260825",
    phase: "stopped",
    status: "running",
    updatedAt: new Date().toISOString(),
  }
  const store = new EventStore(dataDir, options)
  await store.initialize()
  await store.persistStarted("workflow.started", workflow)
  const failed = {
    ...workflow,
    error: { code: "ego_driver_error", message: "Legacy browser process stopped." },
    status: "failed",
    updatedAt: new Date().toISOString(),
  }
  await store.persist("workflow.failed", failed)
  assert.equal(store.getMetrics().reservedBlobBytes, 32)

  const replayedStore = new EventStore(dataDir, options)
  const broker = new Broker({ egoAdapter: unusedEgoAdapter, store: replayedStore })
  await broker.initialize()
  t.after(() => broker.close())
  assert.equal(replayedStore.getMetrics().reservedBlobBytes, 32)
  const abandoned = await broker.abandonWorkflow({
    acknowledgePotentialDelivery: true,
    workflowId: workflow.id,
  })
  assert.equal(abandoned.status, "cancelled")
  assert.equal(abandoned.phase, "recovery_abandoned")
  assert.equal(abandoned.abandonment.acknowledgePotentialDelivery, true)
  assert.equal(replayedStore.getMetrics().reservedBlobBytes, 0)
  assert.equal(replayedStore.getOperation(workflow.operationKey).workflowId, workflow.id)
  const exactRetry = await replayedStore.persistStarted("workflow.started", workflow)
  assert.equal(exactRetry.created, false)
  assert.equal(exactRetry.workflow.status, "cancelled")
})

test("the bounded exact operation ledger fails closed at capacity across compaction and restart", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const options = { maxEvents: 1, maxOperations: 3, maxTerminalWorkflows: 0 }
  const store = new EventStore(dataDir, options)
  await store.initialize()
  const retained = []
  for (let index = 1; index <= 3; index += 1) {
    const workflow = {
      createdAt: new Date().toISOString(),
      id: `10000000-0000-4000-8000-00000000000${index}`,
      inputDigest: String(index).repeat(64),
      kind: "ego_exchange",
      operationKey: `exchange:ego-chat-main:EGO_CHAT_OPERATION_CAP_${index}`,
      status: "succeeded",
      updatedAt: new Date().toISOString(),
    }
    await store.persistStarted("workflow.started", workflow)
    retained.push(workflow)
  }
  const newOperation = {
    ...retained[0],
    id: "10000000-0000-4000-8000-000000000004",
    inputDigest: "4".repeat(64),
    operationKey: "exchange:ego-chat-main:EGO_CHAT_OPERATION_CAP_4",
  }
  await assert.rejects(
    store.persistStarted("workflow.started", newOperation),
    (error) => error.code === "operation_capacity_exhausted" && error.details.limit === 3,
  )
  assert.equal(store.getMetrics().operationSlotsRemaining, 0)

  const replayed = new EventStore(dataDir, options)
  await replayed.initialize()
  await assert.rejects(
    replayed.persistStarted("workflow.started", retained[0]),
    (error) => error.code === "operation_already_completed",
  )
  await assert.rejects(
    replayed.persistStarted("workflow.started", newOperation),
    (error) => error.code === "operation_capacity_exhausted",
  )
})

test("durable state rejects growth beyond its hard checkpoint byte limit", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new EventStore(dataDir, { maxStateBytes: 1_024 })
  await store.initialize()
  await assert.rejects(
    store.persistBinding("binding.created", {
      canonicalUrl: `https://chatgpt.com/c/${"x".repeat(2_000)}`,
      key: "oversized-state",
      state: "bound",
    }),
    (error) => error.code === "state_capacity_exhausted"
      && error.details.limitBytes === 1_024,
  )
  assert.equal(store.getBinding("oversized-state"), undefined)
})

test("operation identity survives workflow-detail retention and still blocks a resend", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new EventStore(dataDir, { maxEvents: 1, maxTerminalWorkflows: 0 })
  await store.initialize()
  const workflow = {
    createdAt: new Date().toISOString(),
    id: "936977d2-ccbf-4a31-86b8-7bdb5dbe302f",
    inputDigest: "c".repeat(64),
    kind: "ego_exchange",
    operationKey: "exchange:ego-chat-main:EGO_CHAT_RETAINED_OPERATION_20260824",
    status: "succeeded",
    updatedAt: new Date().toISOString(),
  }
  await store.persistStarted("workflow.started", workflow)

  assert.equal(store.getWorkflow(workflow.id), undefined)
  assert.equal(store.getOperation(workflow.operationKey).workflowId, workflow.id)
  await assert.rejects(
    store.persistStarted("workflow.started", workflow),
    (error) => error.code === "operation_already_completed"
      && error.details.existingWorkflowId === workflow.id,
  )
})

test("conversation adoption waits outside the caller, captures one stable tail, and creates the binding", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/c/adopted-conversation"
  const responseText = "The long review is complete."
  const responseDigest = digest(responseText)
  let releaseAdoption
  let received
  let adoptionCalls = 0
  const egoAdapter = {
    ...unusedEgoAdapter,
    adopt: async (input) => {
      adoptionCalls += 1
      received = input
      await new Promise((resolve) => {
        releaseAdoption = resolve
      })
      return {
        adoptedWhileGenerating: true,
        anchor: {
          contentDigest: "a".repeat(64),
          messageId: "adopt-user-1",
        },
        canonicalUrl,
        durationMs: 25_000,
        head: {
          fingerprint: "adopted-head",
          fingerprintVersion: "tail-v1",
          lastContentDigest: responseDigest,
          lastMessageId: "adopt-assistant-1",
          lastRole: "assistant",
          messageCount: 4,
          renderedMessageCount: 4,
        },
        modelPolicy: modelPolicyObservation(),
        responseDigest,
        responseText,
        targetId: "adopted-tab",
        taskSpaceId: 10,
      }
    },
  }
  const broker = new Broker({ egoAdapter, store: new EventStore(dataDir) })
  await broker.initialize()
  t.after(() => broker.close())

  const started = await broker.startConversationAdoption({
    bindingKey: "adopted-review",
    canonicalUrl,
    taskSpace: 10,
    timeoutMs: 30_000,
  })
  assert.equal(started.kind, "conversation_adoption")
  assert.equal(started.status, "running")
  assert.equal(started.private, undefined)
  assert.throws(
    () => broker.getConversationBinding({ bindingKey: "adopted-review" }),
    (error) => error.code === "binding_not_found",
  )
  await assert.rejects(
    broker.startConversationAdoption({
      bindingKey: "duplicate-adoption",
      canonicalUrl,
      taskSpace: 11,
      timeoutMs: 30_000,
    }),
    (error) => error.code === "conversation_reserved",
  )

  releaseAdoption()
  const completed = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: started.id })
  assert.equal(completed.status, "succeeded")
  assert.equal(completed.result.adoptedWhileGenerating, true)
  assert.equal(completed.result.responseText, "The long review is complete.")
  assert.equal(completed.result.responseDigest, responseDigest)
  assert.equal(received.canonicalUrl, canonicalUrl)
  assert.equal(received.modelPolicy.modelSelection, "strongest_available")
  assert.equal(received.modelPolicy.thinkingEffort, "maximum_available")
  assert.equal(received.timeoutMs > 0 && received.timeoutMs <= 30_000, true)

  const binding = broker.getConversationBinding({ bindingKey: "adopted-review" })
  assert.equal(binding.adoptionWorkflowId, started.id)
  assert.equal(binding.canonicalUrl, canonicalUrl)
  assert.equal(binding.headFingerprint, "adopted-head")
  assert.equal(binding.headMessageId, "adopt-assistant-1")
  assert.equal(binding.messageCount, 4)
  assert.equal(binding.mode, "existing")
  assert.equal(binding.state, "bound")
  await assert.rejects(
    broker.startConversationAdoption({
      canonicalUrl,
      taskSpace: 11,
      timeoutMs: 30_000,
    }),
    (error) => (
      error.code === "conversation_already_bound"
      && error.details?.bindingKey === "adopted-review"
    ),
  )
  assert.equal(adoptionCalls, 1)
})

test("conversation adoption keeps retrying transient browser and model-policy state", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/c/recovering-adoption"
  const responseText = "Recovered adoption response."
  const responseDigest = digest(responseText)
  let adoptionCalls = 0
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      adopt: async (input) => {
        adoptionCalls += 1
        assert.equal(input.allowTaskSpaceReclaim, true)
        if (adoptionCalls === 1) {
          throw new EgoChatError(
            "human_required",
            "The maximum-model UI is still hydrating.",
            { reason: "model_policy_ui_unknown" },
          )
        }
        return {
          adoptedWhileGenerating: false,
          anchor: { contentDigest: "a".repeat(64), messageId: "recovering-user" },
          canonicalUrl,
          durationMs: 1_000,
          head: {
            fingerprint: "recovering-head",
            fingerprintVersion: "tail-v1",
            lastContentDigest: responseDigest,
            lastMessageId: "recovering-assistant",
            lastRole: "assistant",
            messageCount: 2,
            renderedMessageCount: 2,
          },
          modelPolicy: modelPolicyObservation({ adjusted: true }),
          responseDigest,
          responseText,
          targetId: "recovering-tab",
          taskSpaceId: 14,
        }
      },
    },
    recoveryDelaysMs: [0],
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())

  const started = await broker.startConversationAdoption({
    bindingKey: "recovering-adoption",
    canonicalUrl,
    taskSpace: 14,
    timeoutMs: 30_000,
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.result.responseText, responseText)
  assert.equal(adoptionCalls, 2)
})

test("a read-only conversation adoption resumes safely after a broker restart", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/c/restarted-adoption"
  const responseText = "Recovered without resending."
  const responseDigest = digest(responseText)
  const store = new EventStore(dataDir)
  await store.initialize()
  const workflow = {
    bindingKey: "restarted-review",
    canonicalUrlDigest: digest(canonicalUrl),
    createdAt: "2026-08-24T00:00:00.000Z",
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    id: "5f695a20-20e6-4724-aa23-b99e2c7dbb93",
    kind: "conversation_adoption",
    phase: "waiting",
    private: {
      request: {
        bindingKey: "restarted-review",
        canonicalUrl,
        taskSpace: 11,
        timeoutMs: 30_000,
      },
    },
    status: "running",
    updatedAt: "2026-08-24T00:00:00.000Z",
  }
  await store.persist("workflow.started", workflow)

  let adoptionCalls = 0
  const egoAdapter = {
    ...unusedEgoAdapter,
    adopt: async () => {
      adoptionCalls += 1
      return {
        adoptedWhileGenerating: false,
        anchor: { contentDigest: "d".repeat(64), messageId: "restart-user" },
        canonicalUrl,
        durationMs: 1_000,
        head: {
          fingerprint: "restart-head",
          fingerprintVersion: "tail-v1",
          lastContentDigest: responseDigest,
          lastMessageId: "restart-assistant",
          lastRole: "assistant",
          messageCount: 2,
          renderedMessageCount: 2,
        },
        modelPolicy: modelPolicyObservation(),
        responseDigest,
        responseText,
        targetId: "restart-tab",
        taskSpaceId: 11,
      }
    },
  }
  const broker = new Broker({ egoAdapter, store: new EventStore(dataDir) })
  await broker.initialize()
  t.after(() => broker.close())

  const completed = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: workflow.id })
  assert.equal(completed.status, "succeeded")
  assert.equal(completed.result.responseText, "Recovered without resending.")
  assert.equal(adoptionCalls, 1)
  assert.equal(broker.getConversationBinding({ bindingKey: "restarted-review" }).state, "bound")
})

test("a captured adoption finalizes its binding after restart without reopening the browser", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/c/captured-adoption"
  const responseText = "The response was durably captured before restart."
  const responseDigest = digest(responseText)
  const capture = {
    adoptedWhileGenerating: true,
    anchor: { contentDigest: "f".repeat(64), messageId: "captured-user" },
    canonicalUrl,
    durationMs: 20_000,
    head: {
      fingerprint: "captured-head",
      fingerprintVersion: "tail-v1",
      lastContentDigest: responseDigest,
      lastMessageId: "captured-assistant",
      lastRole: "assistant",
      messageCount: 6,
      renderedMessageCount: 6,
    },
    modelPolicy: modelPolicyObservation(),
    responseDigest,
    responseText,
    targetId: "captured-tab",
    taskSpaceId: 13,
  }
  const workflow = {
    bindingKey: "captured-review",
    canonicalUrlDigest: digest(canonicalUrl),
    createdAt: "2026-08-24T00:00:00.000Z",
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    id: "94101294-a21f-4664-8aca-dbe673aad8f7",
    kind: "conversation_adoption",
    phase: "captured",
    private: {
      capture,
      request: {
        bindingKey: "captured-review",
        canonicalUrl,
        taskSpace: 13,
        timeoutMs: 30_000,
      },
    },
    status: "running",
    updatedAt: "2026-08-24T00:00:00.000Z",
  }
  const store = new EventStore(dataDir)
  await store.initialize()
  await store.persist("adoption.response_captured", workflow)
  let adoptionCalls = 0
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      adopt: async () => {
        adoptionCalls += 1
        throw new Error("captured adoption must not reopen the browser")
      },
    },
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())

  const completed = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: workflow.id })
  assert.equal(completed.status, "succeeded")
  assert.equal(completed.result.responseDigest, responseDigest)
  assert.equal(adoptionCalls, 0)
  assert.equal(broker.getConversationBinding({ bindingKey: "captured-review" }).adoptionWorkflowId, workflow.id)
})

test("conversation adoption rejects non-private canonical URLs before opening the browser", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  let adoptionCalls = 0
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      adopt: async () => {
        adoptionCalls += 1
        throw new Error("invalid URL must not reach the browser")
      },
    },
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())

  for (const canonicalUrl of [
    "https://chatgpt.com/share/not-the-private-conversation",
    "https://user:password@chatgpt.com/c/credential-bearing",
    "https://chatgpt.com:8443/c/nonstandard-port",
  ]) {
    await assert.rejects(
      broker.startConversationAdoption({
        bindingKey: "invalid-review",
        canonicalUrl,
        taskSpace: 14,
        timeoutMs: 30_000,
      }),
      (error) => error.code === "invalid_input",
    )
  }
  assert.equal(adoptionCalls, 0)
})

test("conversation adoption does not enter a task space with an active bound operation", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  let releaseExchange
  let adoptionCalls = 0
  const egoAdapter = {
    ...unusedEgoAdapter,
    adopt: async () => {
      adoptionCalls += 1
      throw new Error("busy task space must not reach adoption")
    },
    bind: async (input) => ({
      canonicalUrl: input.canonicalUrl,
      head: {
        fingerprint: "busy-initial-head",
        lastRole: "assistant",
        messageCount: 2,
      },
      targetId: "busy-tab",
      taskSpaceId: 15,
    }),
    exchange: async () => {
      await new Promise((resolve) => {
        releaseExchange = resolve
      })
      throw new EgoChatError("human_required", "Test exchange stopped.", {
        reason: "test_exchange_stopped",
      })
    },
  }
  const broker = new Broker({ egoAdapter, store: new EventStore(dataDir) })
  await broker.initialize()
  t.after(() => broker.close())

  await broker.bindConversation({
    bindingKey: "busy-review",
    canonicalUrl: "https://chatgpt.com/c/busy-review",
    mode: "existing",
    taskSpace: 15,
  })
  const turnMarker = "EGO_CHAT_BUSY_SPACE_1234"
  const exchange = await broker.startEgoExchange({
    bindingKey: "busy-review",
    expectedTerminalMarker: "BUSY_SPACE_DONE",
    prompt: `${turnMarker}\nreview`,
    timeoutMs: 30_000,
    turnMarker,
  })

  await assert.rejects(
    broker.startConversationAdoption({
      canonicalUrl: "https://chatgpt.com/c/new-adoption",
      taskSpace: 15,
      timeoutMs: 30_000,
    }),
    (error) => error.code === "task_space_busy",
  )
  assert.equal(adoptionCalls, 0)

  releaseExchange()
  const stopped = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: exchange.id })
  assert.equal(stopped.status, "human_required")
})

test("one Ego task space cannot run browser operations for two bindings concurrently", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  let releaseFirst
  let firstEntered
  const entered = new Promise((resolve) => {
    firstEntered = resolve
  })
  const released = new Promise((resolve) => {
    releaseFirst = resolve
  })
  let exchanges = 0
  const egoAdapter = {
    ...unusedEgoAdapter,
    bind: async (input) => ({
      canonicalUrl: input.canonicalUrl,
      head: {
        fingerprint: `head-${input.bindingKey}`,
        fingerprintVersion: "tail-v1",
        lastContentDigest: digest(`head-${input.bindingKey}`),
        lastMessageId: `assistant-${input.bindingKey}`,
        lastRole: "assistant",
        messageCount: 2,
      },
      targetId: `tab-${input.bindingKey}`,
      taskSpaceId: 10,
    }),
    exchange: async (input) => {
      exchanges += 1
      firstEntered()
      await released
      const responseText = input.expectedTerminalMarker
      return {
        canonicalUrl: input.binding.canonicalUrl,
        durationMs: 10,
        head: {
          fingerprint: "first-completed-head",
          fingerprintVersion: "tail-v1",
          lastContentDigest: digest(responseText),
          lastMessageId: "first-completed-assistant",
          lastRole: "assistant",
          messageCount: 4,
        },
        modelPolicy: modelPolicyObservation(),
        responseDigest: digest(responseText),
        responseText,
        targetId: input.binding.targetId,
        taskSpaceId: 10,
        turnMarker: input.turnMarker,
      }
    },
  }
  const broker = new Broker({ egoAdapter, store: new EventStore(dataDir) })
  await broker.initialize()
  t.after(() => broker.close())
  for (const bindingKey of ["task-space-first", "task-space-second"]) {
    await broker.bindConversation({
      bindingKey,
      canonicalUrl: `https://chatgpt.com/c/${bindingKey}`,
      mode: "existing",
      taskSpace: 10,
    })
  }

  const firstMarker = "EGO_CHAT_TASK_SPACE_FIRST_20260825"
  const first = await broker.startEgoExchange({
    bindingKey: "task-space-first",
    expectedTerminalMarker: "EGO_CHAT_TASK_SPACE_FIRST_DONE",
    prompt: `${firstMarker}\nreview`,
    timeoutMs: 30_000,
    turnMarker: firstMarker,
  })
  await entered
  const secondMarker = "EGO_CHAT_TASK_SPACE_SECOND_20260825"
  await assert.rejects(
    broker.startEgoExchange({
      bindingKey: "task-space-second",
      expectedTerminalMarker: "EGO_CHAT_TASK_SPACE_SECOND_DONE",
      prompt: `${secondMarker}\nreview`,
      timeoutMs: 30_000,
      turnMarker: secondMarker,
    }),
    (error) => error.code === "task_space_busy"
      && error.details?.bindingKey === "task-space-first",
  )
  assert.equal(exchanges, 1)

  releaseFirst()
  const completed = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: first.id })
  assert.equal(completed.status, "succeeded")
})

test("maximum policy automatically records a future strongest model without a code change", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const observations = [
    modelPolicyObservation(),
    modelPolicyObservation({
      effortLabel: "Ultra",
      modelLabel: "GPT-6 Sol",
      pillLabel: "Ultra",
      powerLevel: 6,
      powerMax: 6,
    }),
  ]
  const egoAdapter = {
    ...unusedEgoAdapter,
    bind: async (input) => ({
      canonicalUrl: input.canonicalUrl,
      head: { fingerprint: "head-0", lastRole: "assistant", messageCount: 4 },
      targetId: input.targetId ?? "policy-tab",
      taskSpaceId: 10,
    }),
    ensureModelPolicy: async ({ modelPolicy }) => {
      assert.equal(modelPolicy.modelSelection, "strongest_available")
      assert.equal(modelPolicy.thinkingEffort, "maximum_available")
      return observations.shift()
    },
  }
  const broker = new Broker({ egoAdapter, store: new EventStore(dataDir) })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/policy-conversation",
    mode: "existing",
    taskSpace: 10,
  })

  const current = await broker.ensureModelPolicy({ bindingKey: "ego-chat-main" })
  assert.equal(current.lastObserved.modelLabel, "GPT-5.6 Sol")
  assert.equal(current.revision, 1)

  const upgraded = await broker.ensureModelPolicy({ bindingKey: "ego-chat-main" })
  assert.equal(upgraded.lastObserved.effortLabel, "Ultra")
  assert.equal(upgraded.lastObserved.modelLabel, "GPT-6 Sol")
  assert.equal(upgraded.lastObserved.powerLevel, 6)
  assert.equal(upgraded.lastObserved.selectionChanged, true)
  assert.equal(upgraded.revision, 2)
})

test("broker alternates Codex and one persistent ChatGPT conversation until strict settlement", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const appServer = new FakeConvergenceAppServer()
  const ego = createConvergenceEgoAdapter((identity) => {
    assert.ok(identity.candidateDigest)
    assert.ok(identity.targetDigest)
    const settled = identity.cycle === 2
    return {
      ...identity,
      criteria: [
        {
          ...(settled
            ? { evidence: "The target digest is exact." }
            : { assessment: "The target digest is exact." }),
          id: "AC-1",
          status: "pass",
        },
        {
          ...(settled
            ? { evidence: "The second cycle resolved the review." }
            : { assessment: "Another cycle is required." }),
          id: "AC-2",
          status: settled ? "pass" : "fail",
        },
      ],
      decision: settled ? "settled" : "continue",
      findings: settled
        ? []
        : [{
            action: "Revise the candidate once using this review.",
            id: "B-SECOND-CYCLE",
            severity: "blocking",
            title: "One revision is required",
          }],
      summary: settled ? "The immutable contract is settled." : "Return one revised candidate.",
    }
  })
  const broker = new Broker({
    appServerFactory: () => appServer,
    egoAdapter: ego.adapter,
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-test",
    mode: "existing",
    taskSpace: 10,
  })

  const started = await broker.startConvergence({
    acceptanceCriteria: [
      "Every turn binds the immutable target identity.",
      "An independent second-cycle review settles the candidate.",
    ],
    allowTaskSpaceReclaim: true,
    bindingKey: "ego-chat-main",
    codexSandbox: "read-only",
    cwd: process.cwd(),
    maxCycles: 4,
    target: "Qualify a two-cycle convergence handshake without changing files.",
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.phase, "settled")
  assert.equal(completed.result.cycleCount, 2)
  assert.equal(completed.result.codexThreadId, "codex-convergence-thread")
  assert.equal(completed.result.criteria.every(({ status }) => status === "pass"), true)
  assert.equal(appServer.turns, 2)
  assert.equal(appServer.additionalContexts[0], null)
  assert.equal(appServer.additionalContexts[1].chatgpt_review.kind, "untrusted")
  assert.equal(ego.exchanges, 2)
  assert.deepEqual(ego.taskSpaceReclaimAuthorizations, [true, true])
  assert.equal(appServer.closed, true)
  assert.equal(broker.getConversationBinding({ bindingKey: "ego-chat-main" }).revision, 3)
  assert.equal(broker.getModelPolicy().revision, 2)
})

test("a live convergence reconnects an App Server that goes idle during ChatGPT review", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const firstClient = new FakeConvergenceAppServer()
  const firstRunStructuredTurn = firstClient.runStructuredTurn.bind(firstClient)
  let firstClientTurnAttempts = 0
  firstClient.runStructuredTurn = async (input) => {
    firstClientTurnAttempts += 1
    if (firstClientTurnAttempts === 2) {
      throw new EgoChatError("app_server_state", "Codex App Server is not connected.")
    }
    return firstRunStructuredTurn(input)
  }
  const resumedClient = new FakeConvergenceAppServer(() => convergenceCandidate(2))
  const clients = [firstClient, resumedClient]
  const ego = createConvergenceEgoAdapter((identity) => ({
    ...identity,
    criteria: [
      { evidence: "The target digest is exact.", id: "AC-1", status: "pass" },
      {
        evidence: identity.cycle === 2
          ? "The disconnected idle App Server was replaced before the next accepted turn."
          : "Reconnect once before the next accepted turn.",
        id: "AC-2",
        status: identity.cycle === 2 ? "pass" : "fail",
      },
    ],
    decision: identity.cycle === 2 ? "settled" : "continue",
    findings: identity.cycle === 2
      ? []
      : [{
          action: "Continue after the idle App Server disconnects.",
          id: "B-IDLE-APP-SERVER",
          severity: "blocking",
          title: "Reconnect the idle App Server",
        }],
    summary: identity.cycle === 2
      ? "The live reconnect path is settled."
      : "Exercise the live reconnect path.",
  }))
  const broker = new Broker({
    appServerFactory: () => clients.shift(),
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-idle-app-server",
    mode: "existing",
    taskSpace: 10,
  })

  const started = await broker.startConvergence({
    acceptanceCriteria: [
      "Every turn binds the immutable target identity.",
      "An idle App Server disconnect is recovered before the next accepted turn.",
    ],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Keep live convergence healthy across a ChatGPT review longer than the App Server lifetime.",
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.result.cycleCount, 2)
  assert.equal(completed.appServerSetupRecoveryCount, 1)
  assert.equal(firstClientTurnAttempts, 2)
  assert.equal(resumedClient.turns, 1)
  assert.equal(ego.exchanges, 2)
})

test("broker renews its ChatGPT child wait without ending convergence", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const appServer = new FakeConvergenceAppServer()
  const ego = createConvergenceEgoAdapter(async (identity) => {
    await new Promise((resolve) => setTimeout(resolve, 30))
    return {
      ...identity,
      criteria: [
        { evidence: "The target digest is exact.", id: "AC-1", status: "pass" },
        { evidence: "The long review remained attached.", id: "AC-2", status: "pass" },
      ],
      decision: "settled",
      findings: [],
      summary: "The review settled after multiple broker wait windows.",
    }
  })
  const broker = new Broker({
    appServerFactory: () => appServer,
    convergenceChildWaitSliceMs: 5,
    egoAdapter: ego.adapter,
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-child-wait-renewal",
    mode: "existing",
    taskSpace: 10,
  })

  const started = await broker.startConvergence({
    acceptanceCriteria: [
      "Every turn binds the immutable target identity.",
      "A long ChatGPT review stays attached until completion.",
    ],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Keep convergence alive across parent wait-window expiry.",
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.ok(completed.chatGptWaitWindowCount >= 1)
  assert.equal(ego.exchanges, 1)
})

test("broker carries an invalid delivered review into the next implementation cycle", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const appServer = new FakeConvergenceAppServer()
  const detailedReview = `Keep the complete review available. ${"evidence ".repeat(2_000)}`
  const ego = createConvergenceEgoAdapter((identity, exchanges) => {
    if (exchanges === 1) {
      return detailedReview
    }
    return {
      ...identity,
      criteria: [
        { evidence: "The immutable identity is exact.", id: "AC-1", status: "pass" },
        { evidence: "The candidate is independently settled.", id: "AC-2", status: "pass" },
      ],
      decision: "settled",
      findings: [],
      summary: "The same candidate is settled after protocol repair.",
    }
  })
  const broker = new Broker({
    appServerFactory: () => appServer,
    egoAdapter: ego.adapter,
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-protocol-repair",
    mode: "existing",
    taskSpace: 10,
  })

  const started = await broker.startConvergence({
    acceptanceCriteria: [
      "Every turn binds the immutable target identity.",
      "The exact candidate is independently settled.",
    ],
    bindingKey: "ego-chat-main",
    codexSandbox: "read-only",
    cwd: process.cwd(),
    maxCycles: 2,
    target: "Use malformed review prose as feedback without another browser correction turn.",
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.result.cycleCount, 2)
  assert.equal(completed.result.protocolRepairCount, 0)
  assert.equal(appServer.turns, 2)
  assert.equal(
    JSON.parse(appServer.additionalContexts[1].chatgpt_review.value).summary,
    detailedReview.trim(),
  )
  assert.equal(ego.exchanges, 2)
})

test("broker consumes repeated free-form review as feedback instead of stopping for protocol", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const appServer = new FakeConvergenceAppServer()
  const ego = createConvergenceEgoAdapter((identity) => identity.cycle === 3
    ? [
        "The third candidate resolves the prior feedback.",
        "EGO_CHAT_DECISION: SETTLED",
      ].join("\n")
    : "Add a restart regression and continue.")
  const broker = new Broker({
    appServerFactory: () => appServer,
    egoAdapter: ego.adapter,
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-protocol-stagnation",
    mode: "existing",
    taskSpace: 10,
  })

  const started = await broker.startConvergence({
    acceptanceCriteria: [
      "Every turn binds the immutable target identity.",
      "The exact candidate is independently settled.",
    ],
    bindingKey: "ego-chat-main",
    codexSandbox: "read-only",
    cwd: process.cwd(),
    target: "Continue through free-form review until substantive settlement.",
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.result.cycleCount, 3)
  assert.equal(appServer.turns, 3)
  assert.equal(ego.exchanges, 3)
  assert.deepEqual(ego.taskSpaceReclaimAuthorizations, [true, true, true])
})

test("broker-owned convergence has no implicit cycle ceiling", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const appServer = new FakeConvergenceAppServer()
  const store = new ConvergenceHistoryStore(dataDir)
  const ego = createConvergenceEgoAdapter((identity) => {
    const settled = identity.cycle === 7
    return {
      ...identity,
      criteria: [
        { evidence: "The immutable target identity is exact.", id: "AC-1", status: "pass" },
        {
          evidence: settled
            ? "The seventh cycle settled the target."
            : `Cycle ${identity.cycle} still requires one more revision.`,
          id: "AC-2",
          status: settled ? "pass" : "fail",
        },
      ],
      decision: settled ? "settled" : "continue",
      findings: settled
        ? []
        : [{
            action: `Prepare candidate cycle ${identity.cycle + 1}.`,
            id: `B-CYCLE-${identity.cycle}`,
            severity: "blocking",
            title: `Cycle ${identity.cycle} remains unsettled`,
          }],
      summary: settled
        ? "The target is settled after seven cycles."
        : `Continue from cycle ${identity.cycle}.`,
    }
  })
  const broker = new Broker({
    appServerFactory: () => appServer,
    egoAdapter: ego.adapter,
    store,
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-no-implicit-cycle-ceiling",
    mode: "existing",
    taskSpace: 10,
  })

  const started = await broker.startConvergence({
    acceptanceCriteria: [
      "Every cycle binds the immutable target identity.",
      "The target is independently settled.",
    ],
    bindingKey: "ego-chat-main",
    codexSandbox: "read-only",
    cwd: process.cwd(),
    target: "Continue the broker-owned loop until objective settlement.",
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.result.cycleCount, 7)
  assert.equal(appServer.turns, 7)
  assert.equal(ego.exchanges, 7)
  assert.equal(store.candidateCaptureHistory.length, 7)
  for (const [index, history] of store.candidateCaptureHistory.entries()) {
    assert.equal(history.length, index + 1)
    assert.deepEqual(history.at(-1), { hasCandidate: true, hasReview: false })
    assert.ok(history.slice(0, -1).every((record) => (
      record.hasCandidate === false && record.hasReview === false
    )))
  }
})

test("broker-owned convergence turns an oversized review packet into continuation", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const appServer = new FakeConvergenceAppServer((cycle) => convergenceCandidate(
    cycle,
    cycle === 1 ? "界".repeat(70_000) : "Compact exact evidence for cycle 2.",
  ))
  const ego = createConvergenceEgoAdapter((identity, _exchanges, input) => {
    if (identity.cycle === 1) {
      assert.match(input.prompt, /deterministically compacted/)
    }
    return {
      ...identity,
      criteria: [
        { evidence: "The immutable identity is exact.", id: "AC-1", status: "pass" },
        { evidence: "The visible packet appears settled.", id: "AC-2", status: "pass" },
      ],
      decision: "settled",
      findings: [],
      summary: "The visible review evidence is settled.",
    }
  })
  const broker = new Broker({
    appServerFactory: () => appServer,
    egoAdapter: ego.adapter,
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-oversized-review-packet",
    mode: "existing",
    taskSpace: 10,
  })

  const started = await broker.startConvergence({
    acceptanceCriteria: ["Identity is bound.", "The exact candidate is settled."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Keep an oversized review packet inside the continuous loop.",
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.result.cycleCount, 2)
  assert.equal(appServer.turns, 2)
  assert.match(
    appServer.additionalContexts[1].chatgpt_review.value,
    /Review evidence was compacted for transport/,
  )
  assert.equal(ego.exchanges, 2)
})

test("broker-owned convergence reconciles an ambiguous review send without human relay", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/c/convergence-ambiguous-send-recovery"
  const beforeHead = {
    fingerprint: "ambiguous-review-before",
    fingerprintVersion: "tail-v1",
    lastContentDigest: "a".repeat(64),
    lastMessageId: "ambiguous-review-assistant-before",
    lastRole: "assistant",
    messageCount: 2,
  }
  let exchanges = 0
  let reconciliations = 0
  const appServer = new FakeConvergenceAppServer()
  const broker = new Broker({
    appServerFactory: () => appServer,
    egoAdapter: {
      ...unusedEgoAdapter,
      bind: async (input) => ({
        canonicalUrl: input.canonicalUrl,
        head: beforeHead,
        targetId: "ambiguous-review-tab",
        taskSpaceId: 10,
      }),
      exchange: async (input) => {
        exchanges += 1
        if (exchanges === 1) {
          throw new EgoChatError(
            "human_required",
            "The review Send may have been accepted.",
            {
              evidence: { modelPolicy: modelPolicyObservation() },
              reason: "send_confirmation_ambiguous",
            },
          )
        }
        const identity = parseConvergenceIdentity(input.prompt)
        const responseText = `${JSON.stringify({
          ...identity,
          criteria: [
            { evidence: "The target identity is exact.", id: "AC-1", status: "pass" },
            { evidence: "The recovered review delivery is settled.", id: "AC-2", status: "pass" },
          ],
          decision: "settled",
          findings: [],
          summary: "The proven-absent retry is settled.",
        })}\n${input.expectedTerminalMarker}`
        return {
          canonicalUrl,
          durationMs: 20,
          head: {
            fingerprint: "ambiguous-review-after",
            fingerprintVersion: "tail-v1",
            lastContentDigest: digest(responseText),
            lastMessageId: "ambiguous-review-assistant-after",
            lastRole: "assistant",
            messageCount: 4,
          },
          modelPolicy: modelPolicyObservation(),
          responseDigest: digest(responseText),
          responseText,
          targetId: "ambiguous-review-tab",
          taskSpaceId: 10,
          turnMarker: input.turnMarker,
        }
      },
      reconcileBound: async (input) => {
        reconciliations += 1
        assert.equal(input.allowDeliveryAbsent, true)
        assert.equal(input.allowTaskSpaceReclaim, true)
        return {
          canonicalUrl,
          deliveryState: "absent",
          head: beforeHead,
          targetId: "ambiguous-review-tab",
          taskSpaceId: 10,
          turnMarker: input.turnMarker,
        }
      },
    },
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl,
    mode: "existing",
    taskSpace: 10,
  })

  const started = await broker.startConvergence({
    acceptanceCriteria: ["Identity is bound.", "The recovered review is settled."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Keep an ambiguous review Send inside durable reconciliation.",
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(exchanges, 2)
  assert.equal(reconciliations, 1)
})

test("an explicit convergence cycle budget remains authoritative", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const appServer = new FakeConvergenceAppServer()
  const ego = createConvergenceEgoAdapter((identity) => ({
    ...identity,
    criteria: [
      { evidence: "The immutable target identity is exact.", id: "AC-1", status: "pass" },
      {
        evidence: `Cycle ${identity.cycle} remains unsettled.`,
        id: "AC-2",
        status: "fail",
      },
    ],
    decision: "continue",
    findings: [{
      action: "Continue only if the explicit budget permits it.",
      id: `B-BUDGET-${identity.cycle}`,
      severity: "blocking",
      title: `Cycle ${identity.cycle} remains unsettled`,
    }],
    summary: `Cycle ${identity.cycle} requires another candidate.`,
  }))
  const broker = new Broker({
    appServerFactory: () => appServer,
    egoAdapter: ego.adapter,
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-explicit-cycle-budget",
    mode: "existing",
    taskSpace: 10,
  })

  const started = await broker.startConvergence({
    acceptanceCriteria: ["Identity is bound.", "The target is settled."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    maxCycles: 2,
    target: "Respect the caller's explicit two-cycle budget.",
  })
  const stopped = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(stopped.status, "human_required")
  assert.equal(stopped.humanRequired.code, "convergence_cycle_limit_reached")
  assert.equal(appServer.turns, 2)
  assert.equal(ego.exchanges, 2)
})

test("convergence corrects one schema-only Codex turn before sending to ChatGPT", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const appServer = new FakeConvergenceAppServer()
  appServer.runStructuredTurn = async (input) => {
    appServer.turns += 1
    appServer.prompts.push(input.prompt)
    return {
      durationMs: 10,
      responseDigest: String(appServer.turns).repeat(64),
      turnId: `codex-turn-${appServer.turns}`,
      value: appServer.turns === 1
        ? {
            ...convergenceCandidate(1),
            blockers: ["The final JSON instruction was mistaken for a ban on tools."],
            status: "blocked",
          }
        : convergenceCandidate(1),
      workspaceActivity: appServer.turns === 1
        ? { count: 0, types: [] }
        : { count: 1, types: ["commandExecution"] },
    }
  }
  const ego = createConvergenceEgoAdapter((identity) => ({
    ...identity,
    criteria: [
      { evidence: "The target digest is exact.", id: "AC-1", status: "pass" },
      { evidence: "The corrected turn inspected the workspace.", id: "AC-2", status: "pass" },
    ],
    decision: "settled",
    findings: [],
    summary: "The corrected candidate is settled.",
  }))
  const broker = new Broker({
    appServerFactory: () => appServer,
    egoAdapter: ego.adapter,
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-inspection-correction-test",
    mode: "existing",
    taskSpace: 10,
  })

  const started = await broker.startConvergence({
    acceptanceCriteria: ["Identity is bound.", "The workspace is inspected before review."],
    bindingKey: "ego-chat-main",
    codexSandbox: "workspace-write",
    cwd: process.cwd(),
    target: "Inspect the project and produce an evidence-backed candidate.",
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.codexInspectionRetryCount, 1)
  assert.equal(appServer.turns, 2)
  assert.match(appServer.prompts[0], /MUST inspect the supplied cwd with local tools/)
  assert.match(appServer.prompts[1], /made no observable workspace tool call/i)
  assert.equal(ego.exchanges, 1)
})

test("convergence repairs an inconsistent Codex candidate without stopping", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const appServer = new FakeConvergenceAppServer()
  appServer.runStructuredTurn = async (input) => {
    appServer.turns += 1
    appServer.prompts.push(input.prompt)
    await input.onStarted?.({ turnId: `codex-candidate-correction-${appServer.turns}` })
    return {
      durationMs: 10,
      responseDigest: String(appServer.turns).repeat(64),
      turnId: `codex-candidate-correction-${appServer.turns}`,
      value: appServer.turns === 1
        ? {
            ...convergenceCandidate(1),
            blockers: ["A contradictory blocker remained in a candidate envelope."],
          }
        : convergenceCandidate(1),
      workspaceActivity: { count: 1, types: ["commandExecution"] },
    }
  }
  const ego = createConvergenceEgoAdapter((identity) => ({
    ...identity,
    criteria: [
      { evidence: "The target digest is exact.", id: "AC-1", status: "pass" },
      { evidence: "The corrected candidate is settled.", id: "AC-2", status: "pass" },
    ],
    decision: "settled",
    findings: [],
    summary: "The corrected candidate is settled.",
  }))
  const broker = new Broker({
    appServerFactory: () => appServer,
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-candidate-correction",
    mode: "existing",
    taskSpace: 10,
  })

  const started = await broker.startConvergence({
    acceptanceCriteria: ["Identity is bound.", "The corrected candidate is settled."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Correct an inconsistent implementing-agent candidate internally.",
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.candidateCorrectionCount, 1)
  assert.equal(appServer.turns, 2)
  assert.match(appServer.prompts[1], /internal correction turn/)
  assert.equal(ego.exchanges, 1)
})

test("convergence preserves workspace inspection across candidate correction turns", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const appServer = new FakeConvergenceAppServer()
  appServer.runStructuredTurn = async (input) => {
    appServer.turns += 1
    appServer.prompts.push(input.prompt)
    await input.onStarted?.({ turnId: `codex-cycle-activity-${appServer.turns}` })
    if (appServer.turns > 2) {
      throw new Error("the valid second-turn candidate should already be reviewable")
    }
    return {
      durationMs: 10,
      responseDigest: String(appServer.turns).repeat(64),
      turnId: `codex-cycle-activity-${appServer.turns}`,
      value: appServer.turns === 1
        ? {
            ...convergenceCandidate(1),
            blockers: ["The first envelope is internally inconsistent."],
          }
        : convergenceCandidate(1),
      workspaceActivity: appServer.turns === 1
        ? { count: 2, types: ["commandExecution", "fileChange"] }
        : { count: 0, types: [] },
    }
  }
  const ego = createConvergenceEgoAdapter((identity) => ({
    ...identity,
    criteria: [
      { evidence: "The target digest is exact.", id: "AC-1", status: "pass" },
      { evidence: "Earlier cycle activity remains attributable to the corrected candidate.", id: "AC-2", status: "pass" },
    ],
    decision: "settled",
    findings: [],
    summary: "The corrected candidate retains its cycle inspection evidence.",
  }))
  const broker = new Broker({
    appServerFactory: () => appServer,
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-cycle-activity",
    mode: "existing",
    taskSpace: 10,
  })

  const started = await broker.startConvergence({
    acceptanceCriteria: ["Identity is bound.", "Cycle inspection survives correction turns."],
    bindingKey: "ego-chat-main",
    codexSandbox: "workspace-write",
    cwd: process.cwd(),
    target: "Preserve observable workspace activity across one convergence cycle.",
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.candidateCorrectionCount, 1)
  assert.equal(completed.codexInspectionRetryCount ?? 0, 0)
  assert.equal(appServer.turns, 2)
  assert.equal(ego.exchanges, 1)
})

test("convergence keeps correcting Codex until workspace inspection is observable", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const appServer = new FakeConvergenceAppServer()
  appServer.runStructuredTurn = async (input) => {
    appServer.turns += 1
    appServer.prompts.push(input.prompt)
    return {
      durationMs: 10,
      responseDigest: String(appServer.turns).repeat(64),
      turnId: `codex-turn-${appServer.turns}`,
      value: convergenceCandidate(1),
      workspaceActivity: appServer.turns === 3
        ? { count: 1, types: ["commandExecution"] }
        : { count: 0, types: [] },
    }
  }
  const ego = createConvergenceEgoAdapter((identity) => ({
    ...identity,
    criteria: [
      { evidence: "Identity is bound.", id: "AC-1", status: "pass" },
      { evidence: "The third turn inspected the workspace.", id: "AC-2", status: "pass" },
    ],
    decision: "settled",
    findings: [],
    summary: "The inspected candidate is settled.",
  }))
  const broker = new Broker({
    appServerFactory: () => appServer,
    egoAdapter: ego.adapter,
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-inspection-required-test",
    mode: "existing",
    taskSpace: 10,
  })

  const started = await broker.startConvergence({
    acceptanceCriteria: ["Identity is bound.", "The workspace is inspected before review."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Require workspace evidence before external review.",
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.codexInspectionRetryCount, 2)
  assert.equal(appServer.turns, 3)
  assert.equal(ego.exchanges, 1)
})

test("convergence asks ChatGPT for recovery guidance instead of retrying side A forever", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const appServer = new FakeConvergenceAppServer()
  appServer.runStructuredTurn = async (input) => {
    appServer.turns += 1
    appServer.prompts.push(input.prompt)
    await input.onStarted?.({ turnId: `codex-liveness-${appServer.turns}` })
    return {
      durationMs: 10,
      responseDigest: String(appServer.turns).repeat(64),
      turnId: `codex-liveness-${appServer.turns}`,
      value: convergenceCandidate(appServer.turns <= 3 ? 1 : 2),
      workspaceActivity: appServer.turns <= 3
        ? { count: 0, types: [] }
        : { count: 1, types: ["commandExecution"] },
    }
  }
  const ego = createConvergenceEgoAdapter((identity, exchange, input) => {
    if (identity.cycle === 1) {
      assert.match(input.prompt, /Broker liveness checkpoint/)
      assert.match(input.prompt, /No implementation claim is being made/)
      return {
        ...identity,
        criteria: [
          { evidence: "Side A has not yet produced evidence.", id: "AC-1", status: "unknown" },
          { evidence: "Retry with a concrete workspace command.", id: "AC-2", status: "unknown" },
        ],
        decision: "continue",
        findings: [{
          action: "Inspect the workspace and report the resulting evidence in the next cycle.",
          id: "B-SIDE-A-LIVENESS",
          severity: "blocking",
          title: "Recover side A with observable inspection",
        }],
        summary: "Continue with concrete workspace inspection.",
      }
    }
    assert.equal(exchange, 2)
    return {
      ...identity,
      criteria: [
        { evidence: "The target digest remained bound.", id: "AC-1", status: "pass" },
        { evidence: "The next cycle produced observable workspace evidence.", id: "AC-2", status: "pass" },
      ],
      decision: "settled",
      findings: [],
      summary: "The automatically recovered convergence is settled.",
    }
  })
  const broker = new Broker({
    appServerFactory: () => appServer,
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-side-a-liveness",
    mode: "existing",
    taskSpace: 10,
  })

  const started = await broker.startConvergence({
    acceptanceCriteria: ["Identity is bound.", "Side A recovers without human relay."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Keep both convergence sides live when side A repeats without inspection.",
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(
    completed.status,
    "succeeded",
    JSON.stringify(completed.error ?? completed.humanRequired ?? completed),
  )
  assert.equal(completed.codexInspectionLivenessCheckpointCount, 1)
  assert.equal(completed.codexInspectionRetryCount, 3)
  assert.equal(appServer.turns, 4)
  assert.equal(ego.exchanges, 2)
})

test("no-inspection liveness guidance rotates to a fresh Codex thread", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const sourceClient = new FakeConvergenceAppServer()
  sourceClient.runStructuredTurn = async (input) => {
    sourceClient.turns += 1
    if (sourceClient.turns > 3) {
      throw new Error("the abandoned no-inspection thread must not run the next cycle")
    }
    const turnId = `codex-no-inspection-source-${sourceClient.turns}`
    await input.onStarted?.({ turnId })
    return {
      durationMs: 10,
      responseDigest: String(sourceClient.turns).repeat(64),
      turnId,
      value: convergenceCandidate(1),
      workspaceActivity: { count: 0, types: [] },
    }
  }
  const replacementClient = new FakeConvergenceAppServer(() => convergenceCandidate(2))
  replacementClient.startThread = async () => ({
    id: "codex-no-inspection-fresh-thread",
    sessionId: "codex-no-inspection-fresh-thread",
  })
  replacementClient.unsubscribeThread = async (threadId) => {
    assert.equal(threadId, "codex-no-inspection-fresh-thread")
  }
  const clients = [sourceClient, replacementClient]
  let appServerFactoryCalls = 0
  const ego = createConvergenceEgoAdapter((identity, exchange) => {
    if (exchange === 1) {
      return {
        ...identity,
        criteria: [
          { evidence: "The first cycle has no workspace evidence.", id: "AC-1", status: "unknown" },
          { evidence: "A fresh thread must inspect the workspace.", id: "AC-2", status: "unknown" },
        ],
        decision: "continue",
        findings: [{
          action: "Continue in a fresh Codex thread with observable inspection.",
          id: "B-NO-INSPECTION-THREAD",
          severity: "blocking",
          title: "Rotate the exhausted Codex thread",
        }],
        summary: "Continue after the no-inspection liveness checkpoint.",
      }
    }
    assert.equal(exchange, 2)
    return {
      ...identity,
      criteria: [
        { evidence: "The target identity remained exact.", id: "AC-1", status: "pass" },
        { evidence: "The fresh thread inspected the workspace.", id: "AC-2", status: "pass" },
      ],
      decision: "settled",
      findings: [],
      summary: "The fresh-thread continuation is settled.",
    }
  })
  const broker = new Broker({
    appServerFactory: () => {
      appServerFactoryCalls += 1
      return clients.shift()
    },
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-inspection-liveness-thread-rotation",
    mode: "existing",
    taskSpace: 10,
  })

  const started = await broker.startConvergence({
    acceptanceCriteria: ["Identity is bound.", "The fresh thread inspects the workspace."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Rotate after a no-inspection liveness checkpoint.",
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(
    completed.status,
    "succeeded",
    JSON.stringify(completed.error ?? completed.humanRequired ?? completed),
  )
  assert.equal(completed.codexInspectionLivenessCheckpointCount, 1)
  assert.equal(completed.codexThreadGeneration, 2)
  assert.equal(completed.codexThreadRotationCount, 1)
  assert.equal(completed.lastCodexThreadRotation.abandonedThreadId, "codex-convergence-thread")
  assert.equal(completed.lastCodexThreadRotation.threadId, "codex-no-inspection-fresh-thread")
  assert.equal(sourceClient.turns, 3)
  assert.equal(replacementClient.turns, 1)
  assert.equal(appServerFactoryCalls, 2)
  assert.equal(ego.exchanges, 2)
})

test("no-inspection liveness candidate capture is atomic across broker restart", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new PauseAfterLivenessCaptureStore(dataDir)
  const firstClient = new FakeConvergenceAppServer()
  firstClient.runStructuredTurn = async (input) => {
    firstClient.turns += 1
    const turnId = `codex-atomic-inspection-${firstClient.turns}`
    await input.onStarted({ turnId })
    return {
      durationMs: 10,
      responseDigest: String(firstClient.turns).repeat(64),
      turnId,
      value: convergenceCandidate(1),
      workspaceActivity: { count: 0, types: [] },
    }
  }
  let reviewStarted
  const reviewStartedPromise = new Promise((resolve) => {
    reviewStarted = resolve
  })
  const ego = createConvergenceEgoAdapter(async () => {
    reviewStarted()
    return new Promise(() => {})
  })
  const firstBroker = new Broker({
    appServerFactory: () => firstClient,
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store,
  })
  await firstBroker.initialize()
  await firstBroker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-atomic-inspection-liveness",
    mode: "existing",
    taskSpace: 10,
  })
  const started = await firstBroker.startConvergence({
    acceptanceCriteria: ["Identity is bound.", "The checkpoint is captured atomically."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Capture one no-inspection checkpoint atomically.",
  })
  await store.captureCommitted
  const captured = firstBroker.getWorkflow({ workflowId: started.id })
  assert.equal(captured.phase, "codex_captured")
  assert.equal(captured.codexInspectionRetryCount, 3)
  assert.equal(captured.codexInspectionLivenessCheckpointCount, 1)
  firstBroker.close()

  const secondClient = new FakeConvergenceAppServer()
  const secondBroker = new Broker({
    appServerFactory: () => secondClient,
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await secondBroker.initialize()
  t.after(() => secondBroker.close())
  await reviewStartedPromise
  const resumed = secondBroker.getWorkflow({ workflowId: started.id })

  assert.equal(resumed.codexInspectionRetryCount, 3)
  assert.equal(resumed.codexInspectionLivenessCheckpointCount, 1)
  assert.equal(secondClient.turns, 0)
  assert.equal(ego.exchanges, 1)
})

test("convergence resumes the exact Codex thread after one pre-review App Server exit", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const firstClient = new FakeConvergenceAppServer()
  firstClient.runStructuredTurn = async (input) => {
    await input.onStarted({ turnId: "codex-interrupted-turn" })
    throw new EgoChatError(
      "app_server_exited",
      "Codex App Server exited before the operation completed.",
      {
        diagnosticDigest: "d".repeat(64),
        exitCode: 70,
        turnId: "codex-interrupted-turn",
      },
    )
  }
  const secondClient = new FakeConvergenceAppServer()
  let resumedOptions
  secondClient.resumeThread = async (threadId, options) => {
    assert.equal(threadId, "codex-convergence-thread")
    resumedOptions = options
    return { id: threadId, sessionId: threadId }
  }
  secondClient.recoverStructuredTurn = async (threadId, turnId) => {
    assert.equal(threadId, "codex-convergence-thread")
    assert.equal(turnId, "codex-interrupted-turn")
    return { disposition: "retry", status: "interrupted" }
  }
  const clients = [firstClient, secondClient]
  const ego = createConvergenceEgoAdapter((identity) => ({
    ...identity,
    criteria: [
      { evidence: "The target digest is exact.", id: "AC-1", status: "pass" },
      { evidence: "The resumed candidate was reviewed once.", id: "AC-2", status: "pass" },
    ],
    decision: "settled",
    findings: [],
    summary: "The recovered convergence is settled.",
  }))
  const broker = new Broker({
    appServerFactory: () => clients.shift(),
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-app-server-recovery-test",
    mode: "existing",
    taskSpace: 10,
  })

  const started = await broker.startConvergence({
    acceptanceCriteria: ["Identity is bound.", "The recovered candidate is reviewed once."],
    bindingKey: "ego-chat-main",
    codexSandbox: "workspace-write",
    cwd: process.cwd(),
    target: "Recover a pre-review Codex transport exit without duplicating a ChatGPT send.",
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.appServerRecoveryCount, 1)
  assert.equal(completed.appServerRecoveryDisposition, "retry")
  assert.equal(completed.lastAppServerExit.diagnosticDigest, "d".repeat(64))
  assert.equal(completed.lastAppServerExit.exitCode, 70)
  assert.equal(completed.lastAppServerExit.turnId, "codex-interrupted-turn")
  assert.equal(resumedOptions.cwd, process.cwd())
  assert.equal(resumedOptions.sandbox, "workspace-write")
  assert.match(resumedOptions.developerInstructions, /Never contact ChatGPT/)
  assert.equal(secondClient.turns, 1)
  assert.equal(ego.exchanges, 1)
  assert.equal(firstClient.closed, true)
  assert.equal(secondClient.closed, true)
})

test("convergence retries transient App Server setup without ending the workflow", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const firstClient = new FakeConvergenceAppServer()
  firstClient.connect = async () => {
    throw new EgoChatError(
      "app_server_exited",
      "Codex App Server exited during initialization.",
      { signal: "SIGTERM" },
    )
  }
  const secondClient = new FakeConvergenceAppServer()
  const clients = [firstClient, secondClient]
  const ego = createConvergenceEgoAdapter((identity) => ({
    ...identity,
    criteria: [
      { evidence: "The setup recovered.", id: "AC-1", status: "pass" },
      { evidence: "The candidate was reviewed.", id: "AC-2", status: "pass" },
    ],
    decision: "settled",
    findings: [],
    summary: "The recovered setup is settled.",
  }))
  const broker = new Broker({
    appServerFactory: () => clients.shift(),
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-app-server-setup-recovery",
    mode: "existing",
    taskSpace: 10,
  })

  const started = await broker.startConvergence({
    acceptanceCriteria: ["The setup recovers.", "The candidate is reviewed."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Retry a transient App Server setup exit.",
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.appServerSetupRecoveryCount, 1)
  assert.equal(completed.appServerRecoveryCount, 0)
  assert.equal(completed.codexAppServerLivenessCheckpointCount ?? 0, 0)
  assert.equal(firstClient.closed, true)
  assert.equal(secondClient.turns, 1)
  assert.equal(ego.exchanges, 1)
})

test("restart recovery counts connect and resume failures for an accepted turn", async (t) => {
  for (const failurePoint of ["connect", "resume"]) {
    await t.test(failurePoint, async (t) => {
      const dataDir = await createDataDir()
      t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
      const firstClient = new FakeConvergenceAppServer()
      let accepted
      const acceptedPromise = new Promise((resolve) => {
        accepted = resolve
      })
      firstClient.runStructuredTurn = async (input) => {
        await input.onStarted({ turnId: `codex-${failurePoint}-accepted-turn` })
        accepted()
        return new Promise(() => {})
      }
      const firstBroker = new Broker({
        appServerFactory: () => firstClient,
        egoAdapter: createConvergenceEgoAdapter(() => {
          throw new Error("review must not start before broker restart")
        }).adapter,
        recoveryDelaysMs: [1],
        store: new EventStore(dataDir),
      })
      await firstBroker.initialize()
      await firstBroker.bindConversation({
        bindingKey: "ego-chat-main",
        canonicalUrl: `https://chatgpt.com/c/convergence-${failurePoint}-recovery-threshold`,
        mode: "existing",
        taskSpace: 10,
      })
      const started = await firstBroker.startConvergence({
        acceptanceCriteria: ["Identity is bound.", "Accepted-turn recovery is bounded."],
        bindingKey: "ego-chat-main",
        cwd: process.cwd(),
        target: `Count ${failurePoint} failures while recovering an accepted turn.`,
      })
      await acceptedPromise
      firstBroker.close()

      let clientCount = 0
      let resumeCount = 0
      let reviewStarted
      const reviewStartedPromise = new Promise((resolve) => {
        reviewStarted = resolve
      })
      const ego = createConvergenceEgoAdapter(async () => {
        reviewStarted()
        return new Promise(() => {})
      })
      const secondBroker = new Broker({
        appServerFactory: () => {
          clientCount += 1
          const client = new FakeConvergenceAppServer()
          if (failurePoint === "connect") {
            client.connect = async () => {
              throw new EgoChatError("app_server_exited", "Connect failed during recovery.")
            }
          } else {
            client.resumeThread = async () => {
              resumeCount += 1
              throw new EgoChatError("app_server_exited", "Resume failed during recovery.")
            }
          }
          return client
        },
        egoAdapter: ego.adapter,
        recoveryDelaysMs: [1],
        store: new EventStore(dataDir),
      })
      await secondBroker.initialize()
      t.after(() => secondBroker.close())
      await reviewStartedPromise
      const captured = secondBroker.getWorkflow({ workflowId: started.id })

      assert.equal(captured.appServerRecoveryCount, 8)
      assert.equal(captured.appServerSetupRecoveryCount ?? 0, 0)
      assert.equal(captured.codexAppServerLivenessCheckpointCount, 1)
      assert.equal(captured.codexThreadRotationPending.abandonedThreadId, "codex-convergence-thread")
      assert.equal(clientCount, 8)
      assert.equal(resumeCount, failurePoint === "resume" ? 8 : 0)
      assert.equal(ego.exchanges, 1)
    })
  }
})

test("a completed accepted turn wins after seven restart resume failures", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const firstClient = new FakeConvergenceAppServer()
  let accepted
  const acceptedPromise = new Promise((resolve) => {
    accepted = resolve
  })
  firstClient.runStructuredTurn = async (input) => {
    await input.onStarted({ turnId: "codex-seven-failures-accepted-turn" })
    accepted()
    return new Promise(() => {})
  }
  const ego = createConvergenceEgoAdapter((identity) => ({
    ...identity,
    criteria: [
      { evidence: "The accepted turn completed exactly once.", id: "AC-1", status: "pass" },
      { evidence: "No liveness checkpoint replaced real progress.", id: "AC-2", status: "pass" },
    ],
    decision: "settled",
    findings: [],
    summary: "The completed recovery is settled.",
  }))
  const firstBroker = new Broker({
    appServerFactory: () => firstClient,
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await firstBroker.initialize()
  await firstBroker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-seven-resume-failures",
    mode: "existing",
    taskSpace: 10,
  })
  const started = await firstBroker.startConvergence({
    acceptanceCriteria: ["Identity is bound.", "Completed recovery wins at the boundary."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Accept real completed progress after seven resume failures.",
  })
  await acceptedPromise
  firstBroker.close()

  let clientCount = 0
  const secondBroker = new Broker({
    appServerFactory: () => {
      const clientIndex = clientCount
      clientCount += 1
      const client = new FakeConvergenceAppServer()
      if (clientIndex < 7) {
        client.resumeThread = async () => {
          throw new EgoChatError("app_server_exited", "Resume failed during recovery.")
        }
      } else {
        client.recoverStructuredTurn = async (_threadId, turnId) => ({
          disposition: "completed",
          result: {
            durationMs: 10,
            responseDigest: "c".repeat(64),
            turnId,
            value: convergenceCandidate(1),
            workspaceActivity: { count: 1, types: ["commandExecution"] },
          },
        })
      }
      return client
    },
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await secondBroker.initialize()
  t.after(() => secondBroker.close())
  const completed = await secondBroker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.appServerRecoveryCount, 7)
  assert.equal(completed.codexAppServerLivenessCheckpointCount ?? 0, 0)
  assert.equal(completed.codexThreadRotationCount ?? 0, 0)
  assert.equal(clientCount, 8)
  assert.equal(ego.exchanges, 1)
})

test("convergence reconciles the accepted turn when an App Server exit reports another identity", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const firstClient = new FakeConvergenceAppServer()
  firstClient.runStructuredTurn = async (input) => {
    await input.onStarted({ turnId: "codex-accepted-turn" })
    throw new EgoChatError(
      "app_server_exited",
      "Codex App Server exited before the operation completed.",
      {
        diagnosticDigest: "d".repeat(64),
        signal: "SIGTERM",
        turnId: "codex-different-turn",
      },
    )
  }
  const secondClient = new FakeConvergenceAppServer()
  secondClient.recoverStructuredTurn = async (_threadId, turnId) => {
    assert.equal(turnId, "codex-accepted-turn")
    return {
      disposition: "completed",
      result: {
        durationMs: 10,
        responseDigest: "e".repeat(64),
        turnId,
        value: {
          blockers: [],
          criteria: [{ evidence: "The accepted turn was recovered.", id: "AC-1", status: "pass" }],
          reviewPacket: "Exact recovery evidence.",
          status: "candidate",
          summary: "The accepted turn completed before transport exit.",
        },
        workspaceActivity: { count: 1, types: ["commandExecution"] },
      },
    }
  }
  const clients = [firstClient, secondClient]
  const ego = createConvergenceEgoAdapter((identity) => ({
    ...identity,
    criteria: [{ evidence: "The accepted turn is exact.", id: "AC-1", status: "pass" }],
    decision: "settled",
    findings: [],
    summary: "The exact accepted turn is settled.",
  }))
  const broker = new Broker({
    appServerFactory: () => clients.shift(),
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-app-server-identity-change-test",
    mode: "existing",
    taskSpace: 10,
  })

  const started = await broker.startConvergence({
    acceptanceCriteria: ["The exact accepted App Server turn remains bound."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Recover the accepted turn even when exit diagnostics report another identity.",
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.appServerRecoveryCount, 1)
  assert.equal(completed.lastAppServerExit.turnId, "codex-different-turn")
  assert.equal(ego.exchanges, 1)
})

test("convergence keeps recovering pre-review App Server exits until real progress", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const clients = Array.from({ length: 4 }, (_, index) => {
    const client = new FakeConvergenceAppServer()
    if (index < 3) {
      client.runStructuredTurn = async (input) => {
        await input.onStarted({ turnId: `codex-interrupted-turn-${index + 1}` })
        throw new EgoChatError(
          "app_server_exited",
          "Codex App Server exited before the operation completed.",
          {
            diagnosticDigest: String(index + 1).repeat(64),
            exitCode: 70 + index,
            turnId: `codex-interrupted-turn-${index + 1}`,
          },
        )
      }
    }
    if (index > 0) {
      client.recoverStructuredTurn = async (threadId, turnId) => {
        assert.equal(threadId, "codex-convergence-thread")
        assert.equal(turnId, `codex-interrupted-turn-${index}`)
        return { disposition: "retry", status: "interrupted" }
      }
    }
    return client
  })
  const ego = createConvergenceEgoAdapter((identity) => ({
    ...identity,
    criteria: [
      { evidence: "The target digest is exact.", id: "AC-1", status: "pass" },
      { evidence: "Recovery continued to a reviewed candidate.", id: "AC-2", status: "pass" },
    ],
    decision: "settled",
    findings: [],
    summary: "The recovered convergence is settled.",
  }))
  const broker = new Broker({
    appServerFactory: () => clients.shift(),
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-app-server-budget-test",
    mode: "existing",
    taskSpace: 10,
  })

  const started = await broker.startConvergence({
    acceptanceCriteria: ["Identity is bound.", "Recovery continues until real progress."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Recover repeated pre-review App Server exits without human relay.",
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.appServerRecoveryCount, 3)
  assert.equal(completed.lastAppServerExit.turnId, "codex-interrupted-turn-3")
  assert.equal(ego.exchanges, 1)
})

test("convergence keeps recovering beyond the old App Server exit ceiling", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const clients = Array.from({ length: 6 }, (_, index) => {
    const client = new FakeConvergenceAppServer()
    if (index < 5) {
      client.runStructuredTurn = async (input) => {
        await input.onStarted({ turnId: `codex-interrupted-turn-${index + 1}` })
        throw new EgoChatError(
          "app_server_exited",
          "Codex App Server exited before the operation completed.",
          {
            diagnosticDigest: String(index + 1).repeat(64),
            signal: "SIGTERM",
            turnId: `codex-interrupted-turn-${index + 1}`,
          },
        )
      }
    }
    if (index > 0) {
      client.recoverStructuredTurn = async (threadId, turnId) => {
        assert.equal(threadId, "codex-convergence-thread")
        assert.equal(turnId, `codex-interrupted-turn-${index}`)
        return { disposition: "retry", status: "interrupted" }
      }
    }
    return client
  })
  const ego = createConvergenceEgoAdapter((identity) => ({
    ...identity,
    criteria: [
      { evidence: "Identity remained bound across every reconnect.", id: "AC-1", status: "pass" },
      { evidence: "The sixth App Server produced reviewable progress.", id: "AC-2", status: "pass" },
    ],
    decision: "settled",
    findings: [],
    summary: "The recovered candidate is settled.",
  }))
  const broker = new Broker({
    appServerFactory: () => clients.shift(),
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-app-server-exhaustion-test",
    mode: "existing",
    taskSpace: 10,
  })

  const started = await broker.startConvergence({
    acceptanceCriteria: ["Identity is bound.", "Recovery continues until progress."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Keep the durable convergence alive across repeated App Server exits.",
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.appServerRecoveryCount, 5)
  assert.equal(completed.lastAppServerExit.turnId, "codex-interrupted-turn-5")
  assert.equal(ego.exchanges, 1)
})

test("convergence switches from repeated App Server recovery to a ChatGPT liveness checkpoint", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  let clientCount = 0
  let oldThreadRecoveryCalls = 0
  const clients = []
  const appServerFactory = () => {
    const client = new FakeConvergenceAppServer(() => convergenceCandidate(2))
    const clientIndex = clientCount
    clientCount += 1
    clients.push(client)
    const ownedThreadId = clientIndex === 0
      ? "codex-stuck-thread"
      : `codex-fresh-thread-${clientIndex}`
    client.startThread = async () => ({ id: ownedThreadId, sessionId: ownedThreadId })
    client.unsubscribeThread = async (threadId) => {
      assert.equal(threadId, ownedThreadId)
    }
    if (clientIndex === 0) {
      client.runStructuredTurn = async (input) => {
        await input.onStarted({ turnId: "codex-app-server-liveness-turn" })
        throw new EgoChatError(
          "app_server_exited",
          "Codex App Server exited before the operation completed.",
          { turnId: "codex-app-server-liveness-turn" },
        )
      }
    } else {
      client.recoverStructuredTurn = async (_threadId, turnId) => {
        oldThreadRecoveryCalls += 1
        assert.equal(turnId, "codex-app-server-liveness-turn")
        throw new EgoChatError(
          "app_server_recovery_ambiguous",
          "The accepted Codex turn remains unreadable.",
          { turnId },
        )
      }
    }
    return client
  }
  const ego = createConvergenceEgoAdapter((identity, _exchange, input) => {
    if (identity.cycle === 1) {
      assert.match(input.prompt, /trapped in repeated App Server recovery/)
      assert.match(input.prompt, /Consecutive recovery attempts: 8/)
      assert.match(input.prompt, /No implementation claim is being made/)
      return {
        ...identity,
        criteria: [
          { evidence: "No completed candidate exists yet.", id: "AC-1", status: "unknown" },
          { evidence: "Start a fresh Codex cycle.", id: "AC-2", status: "unknown" },
        ],
        decision: "continue",
        findings: [{
          action: "Start a fresh Codex cycle and inspect the workspace again.",
          id: "B-APP-SERVER-LIVENESS",
          severity: "blocking",
          title: "Leave the unreadable accepted turn",
        }],
        summary: "Continue through a fresh Codex cycle.",
      }
    }
    return {
      ...identity,
      criteria: [
        { evidence: "The target identity remained exact.", id: "AC-1", status: "pass" },
        { evidence: "The fresh Codex cycle produced workspace evidence.", id: "AC-2", status: "pass" },
      ],
      decision: "settled",
      findings: [],
      summary: "The App Server liveness recovery is settled.",
    }
  })
  const broker = new Broker({
    appServerFactory,
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-app-server-liveness",
    mode: "existing",
    taskSpace: 10,
  })

  const started = await broker.startConvergence({
    acceptanceCriteria: ["Identity is bound.", "Recovery leaves an unreadable accepted turn."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Keep both sides live when App Server recovery repeats indefinitely.",
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.appServerRecoveryCount, 8)
  assert.equal(completed.codexAppServerLivenessCheckpointCount, 1)
  assert.equal(completed.lastAppServerLivenessCheckpoint.code, "app_server_recovery_ambiguous")
  assert.equal(completed.lastAppServerLivenessCheckpoint.recoveryCount, 8)
  assert.equal(completed.codexThreadGeneration, 2)
  assert.equal(completed.codexThreadRotationCount, 1)
  assert.equal(completed.lastCodexThreadRotation.abandonedThreadId, "codex-stuck-thread")
  assert.equal(completed.lastCodexThreadRotation.threadId, "codex-fresh-thread-9")
  assert.equal(completed.result.codexThreadId, "codex-fresh-thread-9")
  assert.equal(oldThreadRecoveryCalls, 8)
  assert.equal(clients.at(-1).turns, 1)
  assert.equal(ego.exchanges, 2)
})

test("App Server liveness candidate capture is atomic across broker restart", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new PauseAfterLivenessCaptureStore(dataDir)
  let reviewStarted
  const reviewStartedPromise = new Promise((resolve) => {
    reviewStarted = resolve
  })
  const ego = createConvergenceEgoAdapter(async () => {
    reviewStarted()
    return new Promise(() => {})
  })
  let clientCount = 0
  const firstBroker = new Broker({
    appServerFactory: () => {
      const client = new FakeConvergenceAppServer()
      const clientIndex = clientCount
      clientCount += 1
      if (clientIndex === 0) {
        client.runStructuredTurn = async (input) => {
          await input.onStarted({ turnId: "codex-atomic-app-server-turn" })
          throw new EgoChatError(
            "app_server_exited",
            "Codex App Server exited before the operation completed.",
            { turnId: "codex-atomic-app-server-turn" },
          )
        }
      } else {
        client.recoverStructuredTurn = async () => {
          throw new EgoChatError(
            "app_server_recovery_ambiguous",
            "The accepted Codex turn remains unreadable.",
          )
        }
      }
      return client
    },
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store,
  })
  await firstBroker.initialize()
  await firstBroker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-atomic-app-server-liveness",
    mode: "existing",
    taskSpace: 10,
  })
  const started = await firstBroker.startConvergence({
    acceptanceCriteria: ["Identity is bound.", "The recovery checkpoint is captured atomically."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Capture one App Server recovery checkpoint atomically.",
  })
  await store.captureCommitted
  const captured = firstBroker.getWorkflow({ workflowId: started.id })
  assert.equal(captured.phase, "codex_captured")
  assert.equal(captured.appServerRecoveryCount, 8)
  assert.equal(captured.codexAppServerLivenessCheckpointCount, 1)
  firstBroker.close()

  const secondClient = new FakeConvergenceAppServer()
  let resumedThreads = 0
  let recoveryCalls = 0
  secondClient.resumeThread = async () => {
    resumedThreads += 1
    throw new Error("captured liveness review must not resume the abandoned thread")
  }
  secondClient.recoverStructuredTurn = async () => {
    recoveryCalls += 1
    throw new Error("captured liveness candidate must not recover the source turn")
  }
  let secondFactoryCalls = 0
  const secondBroker = new Broker({
    appServerFactory: () => {
      secondFactoryCalls += 1
      return secondClient
    },
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await secondBroker.initialize()
  t.after(() => secondBroker.close())
  await reviewStartedPromise
  const resumed = secondBroker.getWorkflow({ workflowId: started.id })

  assert.equal(resumed.appServerRecoveryCount, 8)
  assert.equal(resumed.codexAppServerLivenessCheckpointCount, 1)
  assert.equal(recoveryCalls, 0)
  assert.equal(resumedThreads, 0)
  assert.equal(secondFactoryCalls, 0)
  assert.equal(secondClient.turns, 0)
  assert.equal(ego.exchanges, 1)
})

test("the eighth conclusive recovery retry is atomically captured before restart", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new PauseAfterEighthRecoveryResultStore(dataDir)
  let clientCount = 0
  let turnCount = 0
  const firstBroker = new Broker({
    appServerFactory: () => {
      const clientIndex = clientCount
      clientCount += 1
      const client = new FakeConvergenceAppServer()
      client.runStructuredTurn = async (input) => {
        turnCount += 1
        const turnId = `codex-conclusive-retry-${turnCount}`
        await input.onStarted({ turnId })
        throw new EgoChatError("app_server_exited", "The accepted turn was interrupted.")
      }
      if (clientIndex > 0) {
        client.recoverStructuredTurn = async (_threadId, turnId) => {
          assert.equal(turnId, `codex-conclusive-retry-${clientIndex}`)
          return { disposition: "retry", status: "interrupted" }
        }
      }
      return client
    },
    egoAdapter: createConvergenceEgoAdapter(() => {
      throw new Error("review must not start before atomic capture returns")
    }).adapter,
    recoveryDelaysMs: [1],
    store,
  })
  await firstBroker.initialize()
  await firstBroker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-atomic-conclusive-retry",
    mode: "existing",
    taskSpace: 10,
  })
  const started = await firstBroker.startConvergence({
    acceptanceCriteria: ["Identity is bound.", "The eighth conclusive retry is atomic."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Capture the eighth conclusive App Server retry atomically.",
  })
  const firstResultWrite = await store.resultCommitted
  const captured = firstBroker.getWorkflow({ workflowId: started.id })

  assert.equal(firstResultWrite, "convergence.codex_candidate_captured")
  assert.equal(captured.phase, "codex_captured")
  assert.equal(captured.appServerRecoveryCount, 8)
  assert.equal(captured.codexAppServerLivenessCheckpointCount, 1)
  assert.equal(captured.codexThreadRotationPending.sourceTurnId, "codex-conclusive-retry-8")
  assert.equal(captured.activeCodexTurn, undefined)
  assert.equal(captured.pendingCodexContinuation, undefined)
  assert.equal(clientCount, 9)
  assert.equal(turnCount, 8)
  firstBroker.close()

  let reviewStarted
  const reviewStartedPromise = new Promise((resolve) => {
    reviewStarted = resolve
  })
  const ego = createConvergenceEgoAdapter(async () => {
    reviewStarted()
    return new Promise(() => {})
  })
  let resumedFactoryCalls = 0
  const secondBroker = new Broker({
    appServerFactory: () => {
      resumedFactoryCalls += 1
      return new FakeConvergenceAppServer()
    },
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await secondBroker.initialize()
  t.after(() => secondBroker.close())
  await reviewStartedPromise
  const resumed = secondBroker.getWorkflow({ workflowId: started.id })

  assert.equal(resumed.codexAppServerLivenessCheckpointCount, 1)
  assert.equal(resumedFactoryCalls, 0)
  assert.equal(ego.exchanges, 1)
})

test("a committed no-inspection continuation retires its source turn before restart", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new PauseAfterTransitionStore(
    dataDir,
    "convergence.codex_workspace_inspection_retry_started",
  )
  const firstClient = new FakeConvergenceAppServer()
  firstClient.runStructuredTurn = async (input) => {
    await input.onStarted({ turnId: "codex-consumed-inspection-source" })
    return {
      durationMs: 10,
      responseDigest: "a".repeat(64),
      turnId: "codex-consumed-inspection-source",
      value: convergenceCandidate(1),
      workspaceActivity: { count: 0, types: [] },
    }
  }
  const ego = createConvergenceEgoAdapter((identity) => ({
    ...identity,
    criteria: [
      { evidence: "The source turn was consumed once.", id: "AC-1", status: "pass" },
      { evidence: "The restarted continuation inspected the workspace.", id: "AC-2", status: "pass" },
    ],
    decision: "settled",
    findings: [],
    summary: "The restart-safe inspection continuation is settled.",
  }))
  const firstBroker = new Broker({
    appServerFactory: () => firstClient,
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store,
  })
  await firstBroker.initialize()
  await firstBroker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-consumed-inspection",
    mode: "existing",
    taskSpace: 10,
  })
  const started = await firstBroker.startConvergence({
    acceptanceCriteria: ["The source is consumed once.", "The continuation inspects the workspace."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Retire a no-inspection source turn atomically.",
  })
  await store.transitionCommitted
  const continued = firstBroker.getWorkflow({ workflowId: started.id })
  assert.equal(continued.phase, "codex_ready")
  assert.equal(continued.activeCodexTurn, undefined)
  assert.equal(continued.pendingCodexContinuation.kind, "workspace_inspection")
  firstBroker.close()

  const secondClient = new FakeConvergenceAppServer()
  let recoveryCalls = 0
  secondClient.recoverStructuredTurn = async () => {
    recoveryCalls += 1
    throw new Error("a consumed source turn must not be recovered")
  }
  const secondBroker = new Broker({
    appServerFactory: () => secondClient,
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await secondBroker.initialize()
  t.after(() => secondBroker.close())
  const completed = await secondBroker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.codexInspectionRetryCount, 1)
  assert.equal(secondClient.turns, 1)
  assert.match(secondClient.prompts[0], /made no observable workspace tool call/i)
  assert.equal(recoveryCalls, 0)
})

test("a committed candidate correction retires its source turn before restart", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new PauseAfterTransitionStore(
    dataDir,
    "convergence.codex_candidate_correction_started",
  )
  const firstClient = new FakeConvergenceAppServer()
  firstClient.runStructuredTurn = async (input) => {
    await input.onStarted({ turnId: "codex-consumed-correction-source" })
    return {
      durationMs: 10,
      responseDigest: "a".repeat(64),
      turnId: "codex-consumed-correction-source",
      value: {
        ...convergenceCandidate(1),
        blockers: ["This makes the candidate envelope inconsistent."],
      },
      workspaceActivity: { count: 2, types: ["commandExecution", "fileChange"] },
    }
  }
  const ego = createConvergenceEgoAdapter((identity) => ({
    ...identity,
    criteria: [
      { evidence: "The source turn was consumed once.", id: "AC-1", status: "pass" },
      { evidence: "The correction retained prior workspace evidence.", id: "AC-2", status: "pass" },
    ],
    decision: "settled",
    findings: [],
    summary: "The restart-safe candidate correction is settled.",
  }))
  const firstBroker = new Broker({
    appServerFactory: () => firstClient,
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store,
  })
  await firstBroker.initialize()
  await firstBroker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-consumed-correction",
    mode: "existing",
    taskSpace: 10,
  })
  const started = await firstBroker.startConvergence({
    acceptanceCriteria: ["The source is consumed once.", "The correction retains evidence."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Retire a candidate-correction source turn atomically.",
  })
  await store.transitionCommitted
  const continued = firstBroker.getWorkflow({ workflowId: started.id })
  assert.equal(continued.phase, "codex_ready")
  assert.equal(continued.activeCodexTurn, undefined)
  assert.equal(continued.activeCodexWorkspaceActivity.count, 2)
  assert.equal(continued.pendingCodexContinuation.kind, "candidate_correction")
  firstBroker.close()

  const secondClient = new FakeConvergenceAppServer()
  secondClient.runStructuredTurn = async (input) => {
    secondClient.turns += 1
    secondClient.prompts.push(input.prompt)
    await input.onStarted({ turnId: "codex-restarted-correction" })
    return {
      durationMs: 10,
      responseDigest: "b".repeat(64),
      turnId: "codex-restarted-correction",
      value: convergenceCandidate(1),
      workspaceActivity: { count: 0, types: [] },
    }
  }
  let recoveryCalls = 0
  secondClient.recoverStructuredTurn = async () => {
    recoveryCalls += 1
    throw new Error("a consumed source turn must not be recovered")
  }
  const secondBroker = new Broker({
    appServerFactory: () => secondClient,
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await secondBroker.initialize()
  t.after(() => secondBroker.close())
  const completed = await secondBroker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.candidateCorrectionCount, 1)
  assert.equal(secondClient.turns, 1)
  assert.match(secondClient.prompts[0], /internal correction turn/)
  assert.equal(recoveryCalls, 0)
})

test("a conclusive recovery retry retires its source turn before restart", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new PauseAfterTransitionStore(
    dataDir,
    "convergence.codex_app_server_recovered",
  )
  const firstClient = new FakeConvergenceAppServer()
  firstClient.runStructuredTurn = async (input) => {
    await input.onStarted({ turnId: "codex-consumed-recovery-source" })
    throw new EgoChatError("app_server_exited", "The accepted turn was interrupted.")
  }
  const recoveryClient = new FakeConvergenceAppServer()
  recoveryClient.recoverStructuredTurn = async (_threadId, turnId) => {
    assert.equal(turnId, "codex-consumed-recovery-source")
    return { disposition: "retry", status: "interrupted" }
  }
  const firstClients = [firstClient, recoveryClient]
  const ego = createConvergenceEgoAdapter((identity) => ({
    ...identity,
    criteria: [
      { evidence: "The source recovery was consumed once.", id: "AC-1", status: "pass" },
      { evidence: "A fresh turn produced the candidate.", id: "AC-2", status: "pass" },
    ],
    decision: "settled",
    findings: [],
    summary: "The restart-safe recovery continuation is settled.",
  }))
  const firstBroker = new Broker({
    appServerFactory: () => firstClients.shift(),
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store,
  })
  await firstBroker.initialize()
  await firstBroker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-consumed-recovery",
    mode: "existing",
    taskSpace: 10,
  })
  const started = await firstBroker.startConvergence({
    acceptanceCriteria: ["The recovery source is consumed once.", "A fresh turn continues."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Retire a conclusive recovery retry atomically.",
  })
  await store.transitionCommitted
  const continued = firstBroker.getWorkflow({ workflowId: started.id })
  assert.equal(continued.phase, "codex_ready")
  assert.equal(continued.activeCodexTurn, undefined)
  assert.equal(continued.appServerRecoveryCount, 1)
  firstBroker.close()

  const secondClient = new FakeConvergenceAppServer()
  let recoveryCalls = 0
  secondClient.recoverStructuredTurn = async () => {
    recoveryCalls += 1
    throw new Error("a consumed recovery result must not be recovered again")
  }
  const secondBroker = new Broker({
    appServerFactory: () => secondClient,
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await secondBroker.initialize()
  t.after(() => secondBroker.close())
  const completed = await secondBroker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.appServerRecoveryCount, 1)
  assert.equal(secondClient.turns, 1)
  assert.equal(recoveryCalls, 0)
})

test("completed no-inspection recovery resets the streak durably across restart", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new PauseAfterTransitionStore(dataDir, "convergence.codex_app_server_recovered")
  let clientCount = 0
  const firstBroker = new Broker({
    appServerFactory: () => {
      const clientIndex = clientCount
      clientCount += 1
      const client = new FakeConvergenceAppServer()
      if (clientIndex === 0) {
        client.runStructuredTurn = async (input) => {
          await input.onStarted({ turnId: "codex-seven-no-inspection" })
          throw new EgoChatError("app_server_exited", "The accepted turn was interrupted.")
        }
      } else if (clientIndex < 7) {
        client.recoverStructuredTurn = async () => {
          throw new EgoChatError("app_server_recovery_ambiguous", "Recovery remains unreadable.")
        }
      } else {
        client.recoverStructuredTurn = async (_threadId, turnId) => ({
          disposition: "completed",
          result: {
            durationMs: 10,
            responseDigest: "a".repeat(64),
            turnId,
            value: convergenceCandidate(1),
            workspaceActivity: { count: 0, types: [] },
          },
        })
      }
      return client
    },
    egoAdapter: createConvergenceEgoAdapter(() => {
      throw new Error("review must not start before the completed-turn reset")
    }).adapter,
    recoveryDelaysMs: [1],
    store,
  })
  await firstBroker.initialize()
  await firstBroker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-no-inspection-streak-reset",
    mode: "existing",
    taskSpace: 10,
  })
  const started = await firstBroker.startConvergence({
    acceptanceCriteria: ["Identity is bound.", "Completed turns reset the recovery streak."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Reset a seven-attempt streak on completed no-inspection progress.",
  })
  await store.transitionCommitted
  const reset = firstBroker.getWorkflow({ workflowId: started.id })

  assert.equal(reset.appServerRecoveryCount, 7)
  assert.equal(reset.consecutiveAppServerExitCount, 0)
  assert.equal(reset.activeCodexTurn.turnId, "codex-seven-no-inspection")
  firstBroker.close()

  const resumedClient = new FakeConvergenceAppServer()
  resumedClient.recoverStructuredTurn = async (_threadId, turnId) => ({
    disposition: "completed",
    result: {
      durationMs: 10,
      responseDigest: "b".repeat(64),
      turnId,
      value: convergenceCandidate(1),
      workspaceActivity: { count: 0, types: [] },
    },
  })
  resumedClient.runStructuredTurn = async (input) => {
    await input.onStarted({ turnId: "codex-post-reset-inspection" })
    throw new EgoChatError("app_server_exited", "One new recovery is required.")
  }
  const finalRecoveryClient = new FakeConvergenceAppServer()
  finalRecoveryClient.recoverStructuredTurn = async (_threadId, turnId) => ({
    disposition: "completed",
    result: {
      durationMs: 10,
      responseDigest: "c".repeat(64),
      turnId,
      value: convergenceCandidate(1),
      workspaceActivity: { count: 1, types: ["commandExecution"] },
    },
  })
  const secondClients = [resumedClient, finalRecoveryClient]
  const ego = createConvergenceEgoAdapter((identity) => ({
    ...identity,
    criteria: [
      { evidence: "The completed turn reset the old streak.", id: "AC-1", status: "pass" },
      { evidence: "One later recovery remained ordinary.", id: "AC-2", status: "pass" },
    ],
    decision: "settled",
    findings: [],
    summary: "The reset recovery sequence is settled.",
  }))
  const secondBroker = new Broker({
    appServerFactory: () => secondClients.shift(),
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await secondBroker.initialize()
  t.after(() => secondBroker.close())
  const completed = await secondBroker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.appServerRecoveryCount, 8)
  assert.equal(completed.codexAppServerLivenessCheckpointCount ?? 0, 0)
  assert.equal(completed.codexInspectionRetryCount, 1)
  assert.equal(ego.exchanges, 1)
})

test("completed invalid-envelope recovery resets the streak before correction", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  let clientCount = 0
  const ego = createConvergenceEgoAdapter((identity) => ({
    ...identity,
    criteria: [
      { evidence: "The completed turn reset the old streak.", id: "AC-1", status: "pass" },
      { evidence: "The correction survived one later recovery.", id: "AC-2", status: "pass" },
    ],
    decision: "settled",
    findings: [],
    summary: "The reset candidate-correction sequence is settled.",
  }))
  const broker = new Broker({
    appServerFactory: () => {
      const clientIndex = clientCount
      clientCount += 1
      const client = new FakeConvergenceAppServer()
      if (clientIndex === 0) {
        client.runStructuredTurn = async (input) => {
          await input.onStarted({ turnId: "codex-seven-invalid-envelope" })
          throw new EgoChatError("app_server_exited", "The accepted turn was interrupted.")
        }
      } else if (clientIndex < 7) {
        client.recoverStructuredTurn = async () => {
          throw new EgoChatError("app_server_recovery_ambiguous", "Recovery remains unreadable.")
        }
      } else if (clientIndex === 7) {
        client.recoverStructuredTurn = async (_threadId, turnId) => ({
          disposition: "completed",
          result: {
            durationMs: 10,
            responseDigest: "d".repeat(64),
            turnId,
            value: {
              ...convergenceCandidate(1),
              blockers: ["This completed envelope is inconsistent."],
            },
            workspaceActivity: { count: 1, types: ["commandExecution"] },
          },
        })
        client.runStructuredTurn = async (input) => {
          await input.onStarted({ turnId: "codex-post-reset-correction" })
          throw new EgoChatError("app_server_exited", "One new recovery is required.")
        }
      } else {
        client.recoverStructuredTurn = async (_threadId, turnId) => ({
          disposition: "completed",
          result: {
            durationMs: 10,
            responseDigest: "e".repeat(64),
            turnId,
            value: convergenceCandidate(1),
            workspaceActivity: { count: 0, types: [] },
          },
        })
      }
      return client
    },
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-invalid-envelope-streak-reset",
    mode: "existing",
    taskSpace: 10,
  })
  const started = await broker.startConvergence({
    acceptanceCriteria: ["Identity is bound.", "Completed turns reset the recovery streak."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Reset a seven-attempt streak before candidate correction.",
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.appServerRecoveryCount, 8)
  assert.equal(completed.codexAppServerLivenessCheckpointCount ?? 0, 0)
  assert.equal(completed.candidateCorrectionCount, 1)
  assert.equal(clientCount, 9)
  assert.equal(ego.exchanges, 1)
})

test("convergence redacts a secret-bearing review packet and keeps progressing", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const appServer = new FakeConvergenceAppServer(() => convergenceCandidate(
    1,
    `Unsafe token ${OPENAI_LIKE_TEST_TOKEN} must not leave the broker.`,
  ))
  const ego = createConvergenceEgoAdapter((identity, _exchange, input) => {
    assert.doesNotMatch(input.prompt, new RegExp(OPENAI_LIKE_TEST_TOKEN))
    assert.match(input.prompt, /EGO_CHAT_REDACTED_OPENAI_API_KEY/)
    return {
      ...identity,
      criteria: [
        { evidence: "The review identity remains bound.", id: "AC-1", status: "pass" },
        { evidence: "The protected token was redacted before transport.", id: "AC-2", status: "pass" },
      ],
      decision: "settled",
      findings: [],
      summary: "The redacted candidate is settled.",
    }
  })
  const broker = new Broker({
    appServerFactory: () => appServer,
    egoAdapter: ego.adapter,
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-secret-test",
    mode: "existing",
    taskSpace: 10,
  })

  const started = await broker.startConvergence({
    acceptanceCriteria: ["Identity is bound.", "No protected material leaves the broker."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Prepare a safe review packet.",
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(ego.exchanges, 1)
})

test("convergence challenges repeated candidate and review state without terminating", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const repeatedCandidate = convergenceCandidate(1, "The unchanged candidate packet.")
  const appServer = new FakeConvergenceAppServer(() => repeatedCandidate)
  const ego = createConvergenceEgoAdapter((identity) => ({
    ...identity,
    criteria: [
      { evidence: "Identity remains correct.", id: "AC-1", status: "pass" },
      {
        evidence: identity.cycle === 3
          ? "The third independent pass settles the blocker."
          : "The same unresolved issue remains.",
        id: "AC-2",
        status: identity.cycle === 3 ? "pass" : "fail",
      },
    ],
    decision: identity.cycle === 3 ? "settled" : "continue",
    findings: identity.cycle === 3 ? [] : [{
      action: "Supply evidence that changes the candidate state.",
      id: "B-STAGNANT",
      severity: "blocking",
      title: "Candidate did not change",
    }],
    summary: identity.cycle === 3
      ? "The repeated candidate is now independently settled."
      : "The same blocking state remains.",
  }))
  const broker = new Broker({
    appServerFactory: () => appServer,
    egoAdapter: ego.adapter,
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-stagnation-test",
    mode: "existing",
    taskSpace: 10,
  })

  const started = await broker.startConvergence({
    acceptanceCriteria: ["Identity is bound.", "The blocker is resolved."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    maxCycles: 4,
    target: "Challenge repetition but keep the convergence conversation alive.",
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.result.cycleCount, 3)
  assert.equal(appServer.turns, 3)
  assert.equal(ego.exchanges, 3)
})

test("an active convergence lease blocks interleaved sends to its conversation", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  let releaseTurn
  let turnEntered
  const entered = new Promise((resolve) => {
    turnEntered = resolve
  })
  const released = new Promise((resolve) => {
    releaseTurn = resolve
  })
  const appServer = new FakeConvergenceAppServer()
  appServer.runStructuredTurn = async () => {
    turnEntered()
    await released
    return {
      durationMs: 10,
      responseDigest: "a".repeat(64),
      turnId: "codex-blocked-turn",
      value: {
        ...convergenceCandidate(1),
        blockers: ["Test stop after lease qualification."],
        status: "blocked",
      },
      workspaceActivity: { count: 1, types: ["commandExecution"] },
    }
  }
  const ego = createConvergenceEgoAdapter((identity) => ({
    ...identity,
    criteria: [
      { evidence: "Identity is bound.", id: "AC-1", status: "pass" },
      { evidence: "The implementing agent still reports a blocker.", id: "AC-2", status: "unknown" },
    ],
    decision: "continue",
    findings: [{
      action: "Re-evaluate the implementing-agent blocker.",
      id: "B-IMPLEMENTER",
      severity: "blocking",
      title: "Implementer blocker remains",
    }],
    summary: "Continue after reviewing the blocker.",
  }))
  const broker = new Broker({
    appServerFactory: () => appServer,
    egoAdapter: ego.adapter,
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-lease-test",
    mode: "existing",
    taskSpace: 10,
  })
  const started = await broker.startConvergence({
    acceptanceCriteria: ["Identity is bound.", "The lease is exclusive."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    maxCycles: 1,
    target: "Hold the conversation lease while Codex is working.",
  })
  await entered

  const turnMarker = "EGO_CHAT_CONCURRENT_SEND_TEST123"
  await assert.rejects(
    () => broker.startEgoExchange({
      bindingKey: "ego-chat-main",
      expectedTerminalMarker: "DONE_CONCURRENT_SEND_TEST123",
      prompt: `${turnMarker}\ninterleaved review`,
      timeoutMs: 30_000,
      turnMarker,
    }),
    (error) => error.code === "conversation_reserved" && error.details?.workflowId === started.id,
  )

  releaseTurn()
  const stopped = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })
  assert.equal(stopped.humanRequired.code, "convergence_cycle_limit_reached")
  assert.equal(ego.exchanges, 1)
})

test("cancellation remains terminal when an older App Server phase finishes later", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  let releaseStart
  let startEntered
  const entered = new Promise((resolve) => {
    startEntered = resolve
  })
  const released = new Promise((resolve) => {
    releaseStart = resolve
  })
  const appServer = new FakeConvergenceAppServer()
  appServer.startThread = async () => {
    startEntered()
    await released
    return { id: "late-codex-thread", sessionId: "late-codex-thread" }
  }
  appServer.unsubscribeThread = async () => {}
  const broker = new Broker({
    appServerFactory: () => appServer,
    egoAdapter: {
      ...unusedEgoAdapter,
      bind: async (input) => ({
        canonicalUrl: input.canonicalUrl,
        head: { fingerprint: "cancel-head", lastRole: "assistant", messageCount: 2 },
        targetId: "cancel-tab",
        taskSpaceId: 10,
      }),
    },
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-cancel-test",
    mode: "existing",
    taskSpace: 10,
  })
  const started = await broker.startConvergence({
    acceptanceCriteria: ["Cancellation is terminal.", "Stale work cannot resurrect state."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Prove terminal-state precedence.",
  })
  await entered

  const cancelled = await broker.cancelWorkflow({ workflowId: started.id })
  assert.equal(cancelled.status, "human_required")
  assert.equal(cancelled.humanRequired.code, "cancelled_during_convergence")
  releaseStart()
  await new Promise((resolve) => globalThis.setImmediate(resolve))
  await new Promise((resolve) => globalThis.setImmediate(resolve))

  const final = broker.getWorkflow({ workflowId: started.id })
  assert.equal(final.status, "human_required")
  assert.equal(final.humanRequired.code, "cancelled_during_convergence")
})

test("confirmed first send can reconcile an unbound lease by exact workflow digest", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/c/reconciled-conversation"
  const terminalMarker = "DONE_RECONCILE123"
  const responseText = `Recovered create-once response.\n${terminalMarker}`
  const responseDigest = digest(responseText)
  const egoAdapter = {
    bind: async (input) => ({ canonicalUrl: null, targetId: input.targetId, taskSpaceId: 10 }),
    exchange: async () => {
      throw new EgoChatError(
        "human_required",
        "Canonical URL appeared late.",
        {
          evidence: { modelPolicy: modelPolicyObservation() },
          reason: "canonical_conversation_missing",
        },
      )
    },
    preflight: async () => {
      throw new Error("not expected")
    },
    reconcile: async ({ expectedTerminalMarker, inputDigest, turnMarker }) => {
      assert.match(inputDigest, /^[a-f0-9]{64}$/)
      assert.equal(expectedTerminalMarker, terminalMarker)
      assert.equal(turnMarker, "EGO_CHAT_GATE0_RECONCILE123")
      return {
        canonicalUrl,
        head: {
          fingerprint: "reconciled-head",
          fingerprintVersion: "tail-v1",
          lastContentDigest: responseDigest,
          lastMessageId: "reconciled-assistant",
          lastRole: "assistant",
          messageCount: 2,
        },
        responseDigest,
        responseText,
        targetId: "reconciled-tab",
        taskSpaceId: 10,
        turnMarker,
      }
    },
    verify: async () => {
      throw new Error("not expected")
    },
  }
  const broker = new Broker({ egoAdapter, store: new EventStore(dataDir) })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    mode: "create_once",
    startUrl: "https://chatgpt.com/",
    targetId: "new-chat-tab",
    taskSpace: 10,
  })
  const turnMarker = "EGO_CHAT_GATE0_RECONCILE123"
  const started = await broker.startEgoExchange({
    bindingKey: "ego-chat-main",
    expectedTerminalMarker: terminalMarker,
    prompt: `${turnMarker}\nreview`,
    timeoutMs: 30_000,
    turnMarker,
  })
  const stopped = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: started.id })
  assert.equal(stopped.humanRequired.code, "canonical_conversation_missing")

  const reconciled = await broker.reconcileConversation({
    bindingKey: "ego-chat-main",
    workflowId: stopped.id,
  })
  assert.equal(reconciled.canonicalUrl, canonicalUrl)
  assert.equal(reconciled.headFingerprint, "reconciled-head")
  assert.equal(reconciled.revision, 2)
  assert.equal(reconciled.state, "bound")
  assert.equal(reconciled.recovery.responseText, responseText)
  assert.equal(broker.getWorkflow({ workflowId: stopped.id }).status, "succeeded")
})

test("a bound late send reconciles only one exact tail-anchored workflow pair", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const turnMarker = "EGO_CHAT_CONVERGENCE_LATE123_C1"
  const terminalMarker = "EGO_CHAT_REVIEW_DONE_LATE123"
  const prompt = `${turnMarker}\nreview\n${terminalMarker}`
  const responseText = `${terminalMarker}`
  const responseDigest = digest(responseText)
  let reconciliationCalls = 0
  const egoAdapter = {
    ...unusedEgoAdapter,
    bind: async (input) => ({
      canonicalUrl: input.canonicalUrl,
      head: {
        fingerprint: "old-tail",
        fingerprintVersion: "tail-v1",
        lastContentDigest: "a".repeat(64),
        lastMessageId: "old-assistant",
        lastRole: "assistant",
        messageCount: 4,
      },
      targetId: "bound-tab",
      taskSpaceId: 10,
    }),
    exchange: async () => {
      throw new EgoChatError(
        "human_required",
        "The click was not confirmed.",
        {
          evidence: { modelPolicy: modelPolicyObservation() },
          reason: "send_confirmation_ambiguous",
        },
      )
    },
    reconcileBound: async (input) => {
      reconciliationCalls += 1
      assert.equal(input.expectedPreviousContentDigest, "a".repeat(64))
      assert.equal(input.expectedPreviousMessageId, "old-assistant")
      assert.equal(input.expectedTerminalMarker, terminalMarker)
      assert.equal(input.turnMarker, turnMarker)
      assert.match(input.inputDigest, /^[a-f0-9]{64}$/)
      return {
        canonicalUrl: input.binding.canonicalUrl,
        head: {
          fingerprint: "new-tail",
          fingerprintVersion: "tail-v1",
          lastContentDigest: responseDigest,
          lastMessageId: "late-assistant",
          lastRole: "assistant",
          messageCount: 5,
          renderedMessageCount: 5,
        },
        responseDigest,
        responseText,
        targetId: "bound-tab",
        taskSpaceId: 10,
        turnMarker,
      }
    },
  }
  const broker = new Broker({ egoAdapter, store: new EventStore(dataDir) })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/bound-late-send",
    mode: "existing",
    taskSpace: 10,
  })
  const started = await broker.startEgoExchange({
    bindingKey: "ego-chat-main",
    expectedTerminalMarker: terminalMarker,
    prompt,
    timeoutMs: 30_000,
    turnMarker,
  })
  const stopped = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: started.id })
  assert.equal(stopped.humanRequired.code, "send_confirmation_ambiguous")
  assert.equal(stopped.reconciliation.beforeHead.messageId, "old-assistant")
  assert.equal(stopped.reconciliation.modelPolicyObservation.modelLabel, "GPT-5.6 Sol")

  const reconciled = await broker.reconcileConversation({
    bindingKey: "ego-chat-main",
    workflowId: stopped.id,
  })
  assert.equal(reconciled.headFingerprint, "new-tail")
  assert.equal(reconciled.headFingerprintVersion, "tail-v1")
  assert.equal(reconciled.headMessageId, "late-assistant")
  assert.equal(reconciled.lastReconciledWorkflowId, stopped.id)
  assert.equal(reconciled.messageCount, 6)
  assert.equal(reconciled.recovery.modelPolicy.effortLabel, "Pro")
  assert.equal(reconciled.recovery.modelPolicy.modelLabel, "GPT-5.6 Sol")
  assert.equal(reconciled.recovery.modelPolicy.policyRevision, 1)
  assert.match(reconciled.recovery.responseDigest, /^[a-f0-9]{64}$/)
  assert.equal(reconciled.recovery.responseText, terminalMarker)
  assert.equal(reconciled.revision, 2)
  const completed = broker.getWorkflow({ workflowId: stopped.id })
  assert.equal(completed.status, "succeeded")
  assert.equal(completed.humanRequired, undefined)
  assert.equal(completed.result.responseRef.digest, responseDigest)

  const exactRetry = await broker.reconcileConversation({
    bindingKey: "ego-chat-main",
    workflowId: stopped.id,
  })
  assert.equal(exactRetry.recovery.responseText, terminalMarker)
  assert.equal(exactRetry.revision, 2)
  assert.equal(reconciliationCalls, 1)
})

test("a changed conversation head records actionable pre-send evidence", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const initialHead = {
    fingerprint: "a".repeat(64),
    fingerprintVersion: "tail-v1",
    lastContentDigest: "b".repeat(64),
    lastMessageId: "initial-assistant",
    lastRole: "assistant",
    messageCount: 2,
  }
  const headChange = {
    changeKind: "message_appended",
    expectedFingerprint: initialHead.fingerprint,
    expectedMessageCount: 2,
    expectedRole: "assistant",
    observedFingerprint: "c".repeat(64),
    observedRenderedMessageCount: 4,
    observedRole: "assistant",
  }
  const userHeadChange = {
    ...headChange,
    changeKind: "message_appended",
    observedFingerprint: "d".repeat(64),
    observedRenderedMessageCount: 3,
    observedRole: "user",
  }
  let exchangeCalls = 0
  const egoAdapter = {
    ...unusedEgoAdapter,
    bind: async (input) => ({
      canonicalUrl: input.canonicalUrl,
      head: initialHead,
      targetId: "head-change-tab",
      taskSpaceId: 10,
    }),
    exchange: async () => {
      exchangeCalls += 1
      throw new EgoChatError(
        "human_required",
        "The bound conversation head changed outside the broker workflow.",
        {
          evidence: { headChange: exchangeCalls === 1 ? headChange : userHeadChange },
          reason: "conversation_head_changed",
        },
      )
    },
  }
  const broker = new Broker({ egoAdapter, store: new EventStore(dataDir) })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/head-change",
    mode: "existing",
    taskSpace: 10,
  })

  const turnMarker = "EGO_CHAT_HEAD_CHANGE_TEST123"
  const started = await broker.startEgoExchange({
    bindingKey: "ego-chat-main",
    expectedTerminalMarker: "EGO_CHAT_HEAD_CHANGE_DONE123",
    prompt: `${turnMarker}\nreview`,
    timeoutMs: 30_000,
    turnMarker,
  })
  const stopped = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: started.id })

  assert.equal(stopped.status, "human_required")
  assert.equal(stopped.phase, "pre_send_head_changed")
  assert.equal(stopped.humanRequired.code, "conversation_head_changed")
  assert.deepEqual(stopped.humanRequired.headChange, headChange)
  assert.deepEqual(stopped.humanRequired.reanchor, {
    acknowledgeExternalChangeRequired: true,
    bindingKey: "ego-chat-main",
    expectedBindingRevision: 1,
    expectedObservedHeadFingerprint: headChange.observedFingerprint,
    sourceWorkflowId: stopped.id,
  })
  assert.equal(stopped.reconciliation.sendState, "not_attempted")

  const userTurnMarker = "EGO_CHAT_USER_HEAD_CHANGE_TEST123"
  const userHeadStarted = await broker.startEgoExchange({
    bindingKey: "ego-chat-main",
    expectedTerminalMarker: "EGO_CHAT_USER_HEAD_CHANGE_DONE123",
    prompt: `${userTurnMarker}\nreview`,
    timeoutMs: 30_000,
    turnMarker: userTurnMarker,
  })
  const userHeadStopped = await broker.awaitWorkflow({
    timeoutMs: 2_000,
    workflowId: userHeadStarted.id,
  })
  assert.equal(userHeadStopped.phase, "pre_send_head_changed")
  assert.equal(userHeadStopped.humanRequired.reanchor, undefined)
  assert.equal(userHeadStopped.reconciliation.sendState, "not_attempted")
  await assert.rejects(
    broker.reanchorConversation({
      acknowledgeExternalChange: true,
      bindingKey: "ego-chat-main",
      expectedBindingRevision: 1,
      expectedObservedHeadFingerprint: userHeadChange.observedFingerprint,
      sourceWorkflowId: userHeadStopped.id,
    }),
    (error) => error.code === "reanchor_source_unsafe",
  )
})

test("an explicitly acknowledged stable external head can re-anchor one safe stopped workflow", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const initialHead = {
    fingerprint: "a".repeat(64),
    fingerprintVersion: "tail-v1",
    lastContentDigest: "b".repeat(64),
    lastMessageId: "initial-assistant",
    lastRole: "assistant",
    messageCount: 2,
  }
  const observedHead = {
    fingerprint: "c".repeat(64),
    fingerprintVersion: "tail-v1",
    lastContentDigest: "d".repeat(64),
    lastMessageId: "external-assistant",
    lastRole: "assistant",
    messageCount: 4,
    renderedMessageCount: 4,
  }
  const headChange = {
    changeKind: "message_appended",
    expectedFingerprint: initialHead.fingerprint,
    expectedMessageCount: 2,
    expectedRole: "assistant",
    observedFingerprint: observedHead.fingerprint,
    observedRenderedMessageCount: 4,
    observedRole: "assistant",
  }
  let reanchorCalls = 0
  const egoAdapter = {
    ...unusedEgoAdapter,
    bind: async (input) => ({
      canonicalUrl: input.canonicalUrl,
      head: initialHead,
      targetId: "reanchor-tab",
      taskSpaceId: 10,
    }),
    exchange: async () => {
      throw new EgoChatError(
        "human_required",
        "The bound conversation head changed outside the broker workflow.",
        { evidence: { headChange }, reason: "conversation_head_changed" },
      )
    },
    reanchor: async (input) => {
      reanchorCalls += 1
      assert.equal(input.binding.revision, 1)
      assert.equal(input.expectedObservedHeadFingerprint, observedHead.fingerprint)
      return {
        canonicalUrl: input.binding.canonicalUrl,
        head: observedHead,
        headChange,
        targetId: "reanchor-tab",
        taskSpaceId: 10,
      }
    },
  }
  const store = new EventStore(dataDir)
  const broker = new Broker({ egoAdapter, store })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/reanchor",
    mode: "existing",
    taskSpace: 10,
  })
  const turnMarker = "EGO_CHAT_REANCHOR_TEST123"
  const started = await broker.startEgoExchange({
    bindingKey: "ego-chat-main",
    expectedTerminalMarker: "EGO_CHAT_REANCHOR_DONE123",
    prompt: `${turnMarker}\nreview`,
    timeoutMs: 30_000,
    turnMarker,
  })
  const stopped = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: started.id })

  const input = {
    acknowledgeExternalChange: true,
    bindingKey: "ego-chat-main",
    expectedBindingRevision: 1,
    expectedObservedHeadFingerprint: observedHead.fingerprint,
    sourceWorkflowId: stopped.id,
  }
  const reanchored = await broker.reanchorConversation(input)

  assert.equal(reanchored.headFingerprint, observedHead.fingerprint)
  assert.equal(reanchored.headMessageId, "external-assistant")
  assert.equal(reanchored.lastReanchorSourceWorkflowId, stopped.id)
  assert.equal(reanchored.messageCount, 4)
  assert.equal(reanchored.reanchor.changeKind, "message_appended")
  assert.equal(reanchored.revision, 2)
  const completed = broker.getWorkflow({ workflowId: stopped.id })
  assert.equal(completed.phase, "head_reanchored")
  assert.equal(completed.status, "cancelled")

  await assert.rejects(
    broker.reanchorConversation({
      ...input,
      expectedObservedHeadFingerprint: "e".repeat(64),
    }),
    (error) => error.code === "reanchor_replay_mismatch",
  )

  await store.persist("test.reanchor_commit_interrupted", stopped, completed)
  const replayed = await broker.reanchorConversation(input)
  assert.equal(replayed.revision, 2)
  assert.equal(reanchorCalls, 1)
  assert.equal(broker.getWorkflow({ workflowId: stopped.id }).phase, "head_reanchored")
  assert.equal(broker.getWorkflow({ workflowId: stopped.id }).status, "cancelled")
})

test("re-anchoring rejects an ambiguous possible send before browser work", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const initialHead = {
    fingerprint: "a".repeat(64),
    fingerprintVersion: "tail-v1",
    lastContentDigest: "b".repeat(64),
    lastMessageId: "ambiguous-initial-assistant",
    lastRole: "assistant",
    messageCount: 2,
  }
  let reanchorCalls = 0
  const egoAdapter = {
    ...unusedEgoAdapter,
    bind: async (input) => ({
      canonicalUrl: input.canonicalUrl,
      head: initialHead,
      targetId: "ambiguous-reanchor-tab",
      taskSpaceId: 10,
    }),
    exchange: async () => {
      throw new EgoChatError(
        "human_required",
        "The send click may have occurred.",
        { reason: "send_confirmation_ambiguous" },
      )
    },
    reanchor: async () => {
      reanchorCalls += 1
      throw new Error("re-anchor must not inspect the browser")
    },
  }
  const broker = new Broker({ egoAdapter, store: new EventStore(dataDir) })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/ambiguous-reanchor",
    mode: "existing",
    taskSpace: 10,
  })
  const turnMarker = "EGO_CHAT_AMBIGUOUS_REANCHOR123"
  const started = await broker.startEgoExchange({
    bindingKey: "ego-chat-main",
    expectedTerminalMarker: "EGO_CHAT_AMBIGUOUS_REANCHOR_DONE123",
    prompt: `${turnMarker}\nreview`,
    timeoutMs: 30_000,
    turnMarker,
  })
  const stopped = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: started.id })

  await assert.rejects(
    broker.reanchorConversation({
      acknowledgeExternalChange: true,
      bindingKey: "ego-chat-main",
      expectedBindingRevision: 1,
      expectedObservedHeadFingerprint: "c".repeat(64),
      sourceWorkflowId: stopped.id,
    }),
    (error) => error.code === "reanchor_source_unsafe",
  )
  assert.equal(reanchorCalls, 0)
})

test("a pre-click driver interruption preserves safe proof and can reconcile delivery absence", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const turnMarker = "EGO_CHAT_DRIVER_INTERRUPTED123"
  const terminalMarker = "EGO_CHAT_DRIVER_INTERRUPTED_DONE123"
  const beforeHead = {
    fingerprint: "driver-interruption-tail",
    fingerprintVersion: "tail-v1",
    lastContentDigest: "c".repeat(64),
    lastMessageId: "driver-interruption-assistant",
    lastRole: "assistant",
    messageCount: 8,
  }
  let exchangeCalls = 0
  const egoAdapter = {
    ...unusedEgoAdapter,
    bind: async (input) => ({
      canonicalUrl: input.canonicalUrl,
      head: beforeHead,
      targetId: "driver-interruption-tab",
      taskSpaceId: 10,
    }),
    exchange: async () => {
      exchangeCalls += 1
      throw new EgoChatError(
        "ego_driver_error",
        "The fixed Ego Browser driver failed.",
        {
          diagnosticDigest: "d".repeat(64),
          draftCleared: true,
          driverStage: "composing_prompt",
          evidence: { modelPolicy: modelPolicyObservation() },
        },
      )
    },
    reconcileBound: async (input) => {
      assert.equal(input.allowDeliveryAbsent, true)
      assert.equal(input.expectedPreviousContentDigest, beforeHead.lastContentDigest)
      assert.equal(input.expectedPreviousMessageId, beforeHead.lastMessageId)
      return {
        canonicalUrl: input.binding.canonicalUrl,
        deliveryState: "absent",
        head: beforeHead,
        targetId: "driver-interruption-tab",
        taskSpaceId: 10,
        turnMarker,
      }
    },
    verify: async (input) => ({
      canonicalUrl: input.binding.canonicalUrl,
      head: {
        ...beforeHead,
        fingerprint: "interleaved-tail",
        lastContentDigest: "e".repeat(64),
        lastMessageId: "interleaved-assistant",
        messageCount: 10,
      },
      targetId: "driver-interruption-tab",
      taskSpaceId: 10,
    }),
  }
  const broker = new Broker({ egoAdapter, store: new EventStore(dataDir) })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/driver-interruption",
    mode: "existing",
    taskSpace: 10,
  })
  const bindingBefore = broker.getConversationBinding({ bindingKey: "ego-chat-main" })
  const started = await broker.startEgoExchange({
    bindingKey: "ego-chat-main",
    expectedTerminalMarker: terminalMarker,
    prompt: `${turnMarker}\nreview`,
    timeoutMs: 30_000,
    turnMarker,
  })
  const stopped = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: started.id })

  assert.equal(stopped.status, "human_required")
  assert.equal(
    stopped.humanRequired.code,
    "browser_operation_interrupted_before_send_confirmation",
  )
  assert.deepEqual(stopped.humanRequired.diagnostic, {
    diagnosticDigest: "d".repeat(64),
    draftCleared: true,
    driverStage: "composing_prompt",
    errorCode: "ego_driver_error",
  })
  assert.equal(stopped.reconciliation.modelPolicyObservation.effortLabel, "Pro")

  const reconciled = await broker.reconcileConversation({
    bindingKey: "ego-chat-main",
    workflowId: stopped.id,
  })
  assert.equal(reconciled.recovery.deliveryState, "absent")
  assert.equal(reconciled.recovery.workflowId, stopped.id)
  assert.equal(broker.getWorkflow({ workflowId: stopped.id }).status, "cancelled")
  assert.deepEqual(
    broker.getConversationBinding({ bindingKey: "ego-chat-main" }),
    bindingBefore,
  )

  await broker.verifyConversation({ bindingKey: "ego-chat-main" })
  await assert.rejects(
    broker.startEgoExchange({
      bindingKey: "ego-chat-main",
      expectedPreviousHead: stopped.reconciliation.beforeHead,
      expectedTerminalMarker: "EGO_CHAT_DRIVER_RETRY_DONE123",
      prompt: "EGO_CHAT_DRIVER_RETRY123\nreview",
      timeoutMs: 30_000,
      turnMarker: "EGO_CHAT_DRIVER_RETRY123",
    }),
    (error) => error instanceof EgoChatError
      && error.code === "human_required"
      && error.details?.reason === "review_retry_anchor_changed",
  )
  assert.equal(exchangeCalls, 1)
})

test("probe completes through await and survives a broker restart", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))

  const firstBroker = new Broker({
    egoAdapter: unusedEgoAdapter,
    store: new EventStore(dataDir),
  })
  await firstBroker.initialize()
  const started = await firstBroker.startProbe({ delayMs: 150, value: "restart-safe" })
  firstBroker.close()

  const secondBroker = new Broker({
    egoAdapter: unusedEgoAdapter,
    store: new EventStore(dataDir),
  })
  await secondBroker.initialize()
  t.after(() => secondBroker.close())
  const completed = await secondBroker.awaitWorkflow({ timeoutMs: 2_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.result.text, "restart-safe")
  assert.equal("private" in completed, false)
})

test("browser workflows fail closed after broker restart", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new EventStore(dataDir)
  await store.initialize()
  const workflow = {
    createdAt: "2026-08-24T00:00:00.000Z",
    id: "576b81ec-a1dd-4a37-be29-bc0bc68bd03d",
    kind: "ego_exchange",
    private: { request: {} },
    status: "running",
    updatedAt: "2026-08-24T00:00:00.000Z",
  }
  await store.persist("workflow.started", workflow)

  const broker = new Broker({ egoAdapter: unusedEgoAdapter, store: new EventStore(dataDir) })
  await broker.initialize()
  t.after(() => broker.close())

  const reconciled = broker.getWorkflow({ workflowId: workflow.id })
  assert.equal(reconciled.status, "human_required")
  assert.equal(reconciled.humanRequired.code, "broker_restarted_during_browser_operation")
  assert.equal("private" in reconciled, false)
})

test("a fully identified pre-send exchange reconciles and continues after broker restart", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new EventStore(dataDir)
  await store.initialize()
  const now = new Date().toISOString()
  const canonicalUrl = "https://chatgpt.com/c/restart-presend-recovery"
  const terminalMarker = "EGO_CHAT_RESTART_PRESEND_DONE"
  const turnMarker = "EGO_CHAT_RESTART_PRESEND_TEST"
  const prompt = `${turnMarker}\nContinue after broker restart.`
  const beforeHead = {
    contentDigest: "a".repeat(64),
    fingerprint: "b".repeat(64),
    fingerprintVersion: "tail-v1",
    messageId: "restart-presend-assistant-before",
    role: "assistant",
  }
  await store.persistBinding("binding.created", {
    canonicalUrl,
    createdAt: now,
    headContentDigest: beforeHead.contentDigest,
    headFingerprint: beforeHead.fingerprint,
    headFingerprintVersion: beforeHead.fingerprintVersion,
    headMessageId: beforeHead.messageId,
    headRole: beforeHead.role,
    key: "restart-presend",
    messageCount: 2,
    mode: "existing",
    modelPolicyKey: "chatgpt-web-default",
    projectUrl: null,
    revision: 1,
    startUrl: canonicalUrl,
    state: "bound",
    targetId: "restart-presend-tab",
    taskSpaceId: 24,
    updatedAt: now,
    verifiedAt: now,
  })
  const workflow = {
    bindingKey: "restart-presend",
    createdAt: now,
    deadlineAt: new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString(),
    id: "962529e6-3486-4a2b-ad9c-b62102556776",
    inputDigest: digest(prompt),
    kind: "ego_exchange",
    operationKey: `exchange:restart-presend:${turnMarker}`,
    phase: "browser_owned",
    private: {
      modelPolicy: {
        enforcement: "repair_then_verify",
        key: "chatgpt-web-default",
        modelSelection: "strongest_available",
        thinkingEffort: "maximum_available",
      },
      request: {
        allowProtocolRepairCapture: true,
        allowTaskSpaceReclaim: true,
        bindingKey: "restart-presend",
        expectedTerminalMarker: terminalMarker,
        prompt,
        requestedTimeoutMs: 30_000,
        timeoutMs: 2 * 60 * 60 * 1_000,
        turnMarker,
      },
    },
    reconciliation: {
      allowProtocolRepairCapture: true,
      beforeHead,
      bindingRevision: 1,
      expectedTerminalMarker: terminalMarker,
      turnMarker,
    },
    status: "running",
    updatedAt: now,
  }
  await store.persist("workflow.started", workflow)

  let captures = 0
  let reconciliations = 0
  let sends = 0
  let firstReconciliationStarted
  const reconciliationStarted = new Promise((resolve) => {
    firstReconciliationStarted = resolve
  })
  const firstBroker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      reconcileBound: async () => {
        reconciliations += 1
        firstReconciliationStarted()
        return new Promise(() => {})
      },
    },
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await firstBroker.initialize()
  await reconciliationStarted
  assert.equal(
    firstBroker.getWorkflow({ workflowId: workflow.id }).phase,
    "restart_reconciling",
  )
  firstBroker.close()

  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      captureExchange: async () => {
        captures += 1
        const responseText = terminalMarker
        return {
          canonicalUrl,
          head: {
            fingerprint: "c".repeat(64),
            fingerprintVersion: "tail-v1",
            lastContentDigest: digest(responseText),
            lastMessageId: "restart-presend-assistant-after",
            lastRole: "assistant",
            messageCount: 4,
          },
          responseDigest: digest(responseText),
          responseText,
          targetId: "restart-presend-tab",
          taskSpaceId: 24,
          turnMarker,
        }
      },
      reconcileBound: async (input) => {
        reconciliations += 1
        assert.equal(input.allowDeliveryAbsent, true)
        assert.equal(input.allowTaskSpaceReclaim, true)
        return {
          canonicalUrl,
          deliveryState: "absent",
          head: {
            fingerprint: beforeHead.fingerprint,
            fingerprintVersion: beforeHead.fingerprintVersion,
            lastContentDigest: beforeHead.contentDigest,
            lastMessageId: beforeHead.messageId,
            lastRole: beforeHead.role,
            messageCount: 2,
          },
          targetId: "restart-presend-tab",
          taskSpaceId: 24,
          turnMarker,
        }
      },
      sendExchange: async () => {
        sends += 1
        return {
          canonicalUrl,
          modelPolicy: modelPolicyObservation(),
          promptMessageId: "restart-presend-user",
          sentAt: new Date().toISOString(),
          targetId: "restart-presend-tab",
          taskSpaceId: 24,
          turnMarker,
        }
      },
    },
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  const completed = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: workflow.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.restartRecoveryCount, 1)
  assert.equal(reconciliations, 2)
  assert.equal(sends, 1)
  assert.equal(captures, 1)
})

test("a confirmed send resumes read-only capture after broker restart without resending", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new EventStore(dataDir)
  await store.initialize()
  const now = new Date().toISOString()
  const canonicalUrl = "https://chatgpt.com/c/resumable-confirmed-send"
  await store.persistBinding("binding.created", {
    canonicalUrl,
    createdAt: now,
    headContentDigest: "b".repeat(64),
    headFingerprint: "head-before-restart",
    headFingerprintVersion: "tail-v1",
    headMessageId: "assistant-before-restart",
    headRole: "assistant",
    key: "ego-chat-main",
    messageCount: 2,
    mode: "existing",
    modelPolicyKey: "chatgpt-web-default",
    projectUrl: null,
    revision: 1,
    startUrl: canonicalUrl,
    state: "bound",
    targetId: "resumable-tab",
    taskSpaceId: 10,
    updatedAt: now,
    verifiedAt: now,
  })
  await store.persistModelPolicy("model_policy.verified", {
    createdAt: now,
    enforcement: "repair_then_verify",
    key: "chatgpt-web-default",
    lastObserved: {
      ...modelPolicyObservation(),
      bindingKey: "ego-chat-main",
      selectionChanged: false,
      verifiedAt: now,
    },
    modelSelection: "strongest_available",
    revision: 1,
    state: "verified",
    thinkingEffort: "maximum_available",
    updatedAt: now,
  })
  const turnMarker = "EGO_CHAT_RESUME_CONFIRMED_20260824"
  const terminalMarker = "EGO_CHAT_RESUME_CONFIRMED_DONE"
  const prompt = `${turnMarker}\nFinish after the broker restarts.`
  const workflow = {
    bindingKey: "ego-chat-main",
    createdAt: now,
    deadlineAt: new Date(Date.now() + 16 * 60_000).toISOString(),
    id: "4be9a3cc-a8d5-47e3-ac6f-058d3f2c6452",
    inputDigest: digest(prompt),
    kind: "ego_exchange",
    operationKey: `exchange:ego-chat-main:${turnMarker}`,
    phase: "send_confirmed",
    private: {
      captureAttempts: 0,
      modelPolicy: {
        enforcement: "repair_then_verify",
        key: "chatgpt-web-default",
        lastObserved: modelPolicyObservation(),
        modelSelection: "strongest_available",
        revision: 1,
        state: "verified",
        thinkingEffort: "maximum_available",
      },
      request: {
        bindingKey: "ego-chat-main",
        expectedTerminalMarker: terminalMarker,
        prompt,
        requestedTimeoutMs: 30_000,
        timeoutMs: 2 * 60 * 60 * 1_000,
        turnMarker,
      },
      send: {
        canonicalUrl,
        modelPolicy: modelPolicyObservation(),
        promptMessageId: "user-confirmed-before-restart",
        sentAt: now,
        targetId: "resumable-tab",
        taskSpaceId: 10,
        turnMarker,
      },
    },
    reconciliation: {
      beforeHead: {
        contentDigest: "b".repeat(64),
        fingerprint: "head-before-restart",
        fingerprintVersion: "tail-v1",
        messageId: "assistant-before-restart",
        role: "assistant",
      },
      expectedTerminalMarker: terminalMarker,
      modelPolicyObservation: modelPolicyObservation(),
      promptMessageId: "user-confirmed-before-restart",
      sentAt: now,
      turnMarker,
    },
    status: "running",
    updatedAt: now,
  }
  await store.persist("exchange.send_confirmed", workflow)

  let captures = 0
  let sends = 0
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      captureExchange: async (input) => {
        captures += 1
        assert.equal(input.canonicalUrl, canonicalUrl)
        assert.equal(input.expectedPreviousMessageId, "assistant-before-restart")
        assert.ok(input.timeoutMs > 15 * 60_000)
        return {
          canonicalUrl,
          durationMs: 40,
          head: {
            fingerprint: "head-after-restart",
            fingerprintVersion: "tail-v1",
            lastContentDigest: digest(terminalMarker),
            lastMessageId: "assistant-after-restart",
            lastRole: "assistant",
            messageCount: 4,
          },
          responseDigest: digest(terminalMarker),
          responseText: terminalMarker,
          targetId: "resumable-tab",
          taskSpaceId: 10,
          turnMarker,
        }
      },
      sendExchange: async () => {
        sends += 1
        throw new Error("confirmed prompt must not be sent again")
      },
    },
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  const completed = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: workflow.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.phase, "head_committed")
  assert.equal(sends, 0)
  assert.equal(captures, 1)

  const committedBinding = broker.getConversationBinding({ bindingKey: "ego-chat-main" })
  const committedPolicy = broker.getModelPolicy()
  broker.close()
  const rewindStore = new EventStore(dataDir)
  await rewindStore.initialize()
  await rewindStore.persist("test.response_captured_before_restart", {
    ...completed,
    phase: "response_captured",
    private: {
      request: workflow.private.request,
    },
    status: "running",
  })
  const resumedBroker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      captureExchange: async () => {
        captures += 1
        throw new Error("a captured response must not reopen the browser")
      },
      sendExchange: async () => {
        sends += 1
        throw new Error("a captured response must not be sent again")
      },
    },
    store: new EventStore(dataDir),
  })
  await resumedBroker.initialize()
  t.after(() => resumedBroker.close())
  const finalizedAgain = await resumedBroker.awaitWorkflow({
    timeoutMs: 2_000,
    workflowId: workflow.id,
  })

  assert.equal(finalizedAgain.status, "succeeded")
  assert.equal(sends, 0)
  assert.equal(captures, 1)
  assert.equal(
    resumedBroker.getConversationBinding({ bindingKey: "ego-chat-main" }).revision,
    committedBinding.revision,
  )
  assert.equal(resumedBroker.getModelPolicy().revision, committedPolicy.revision)
})

test("incomplete legacy convergence metadata remains non-resumable after broker restart", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new EventStore(dataDir)
  await store.initialize()
  const workflow = {
    bindingKey: "ego-chat-main",
    createdAt: "2026-08-24T00:00:00.000Z",
    id: "f71c8e6e-fcd5-4a5a-b6a8-ae5509d36a46",
    kind: "convergence",
    private: { request: {} },
    status: "running",
    updatedAt: "2026-08-24T00:00:00.000Z",
  }
  await store.persist("workflow.started", workflow)

  const broker = new Broker({ egoAdapter: unusedEgoAdapter, store: new EventStore(dataDir) })
  await broker.initialize()
  t.after(() => broker.close())

  const reconciled = broker.getWorkflow({ workflowId: workflow.id })
  assert.equal(reconciled.status, "human_required")
  assert.equal(reconciled.humanRequired.code, "broker_restarted_during_convergence")
  assert.equal("private" in reconciled, false)
})

test("running convergence resumes an exact completed pre-review Codex turn after broker restart", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const firstClient = new FakeConvergenceAppServer()
  let turnIdentityRecorded
  const recorded = new Promise((resolve) => {
    turnIdentityRecorded = resolve
  })
  firstClient.runStructuredTurn = async (input) => {
    firstClient.turns += 1
    await input.onStarted({ turnId: "codex-restart-turn" })
    turnIdentityRecorded()
    return new Promise(() => {})
  }
  const ego = createConvergenceEgoAdapter((identity) => ({
    ...identity,
    criteria: [
      { evidence: "The target digest is exact.", id: "AC-1", status: "pass" },
      { evidence: "The exact completed turn survived restart.", id: "AC-2", status: "pass" },
    ],
    decision: "settled",
    findings: [],
    summary: "The restart-safe convergence is settled.",
  }))
  const firstBroker = new Broker({
    appServerFactory: () => firstClient,
    egoAdapter: ego.adapter,
    store: new EventStore(dataDir),
  })
  await firstBroker.initialize()
  await firstBroker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-broker-restart-test",
    mode: "existing",
    taskSpace: 10,
  })
  const started = await firstBroker.startConvergence({
    acceptanceCriteria: ["Identity is bound.", "The exact completed turn survives restart."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Resume a durably identified pre-review Codex turn after broker restart.",
  })
  await recorded
  assert.equal(
    firstBroker.getWorkflow({ workflowId: started.id }).activeCodexTurn.turnId,
    "codex-restart-turn",
  )
  firstBroker.close()

  const secondClient = new FakeConvergenceAppServer()
  secondClient.recoverStructuredTurn = async (threadId, turnId) => {
    assert.equal(threadId, "codex-convergence-thread")
    assert.equal(turnId, "codex-restart-turn")
    return {
      disposition: "completed",
      result: {
        durationMs: 10,
        responseDigest: "a".repeat(64),
        turnId,
        value: convergenceCandidate(1),
        workspaceActivity: { count: 1, types: ["commandExecution"] },
      },
    }
  }
  const secondBroker = new Broker({
    appServerFactory: () => secondClient,
    egoAdapter: ego.adapter,
    store: new EventStore(dataDir),
  })
  await secondBroker.initialize()
  t.after(() => secondBroker.close())
  const completed = await secondBroker.awaitWorkflow({
    timeoutMs: 5_000,
    workflowId: started.id,
  })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.phase, "settled")
  assert.equal(secondClient.turns, 0)
  assert.equal(ego.exchanges, 1)
})

test("a completed recovered result is reviewable without its old App Server after restart", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new PauseAfterTransitionStore(dataDir, "convergence.codex_app_server_recovered")
  const sourceClient = new FakeConvergenceAppServer()
  sourceClient.runStructuredTurn = async (input) => {
    await input.onStarted({ turnId: "codex-durable-completed-result" })
    throw new EgoChatError("app_server_exited", "The accepted turn transport exited.")
  }
  const recoveryClient = new FakeConvergenceAppServer()
  recoveryClient.recoverStructuredTurn = async (_threadId, turnId) => ({
    disposition: "completed",
    result: {
      durationMs: 10,
      responseDigest: "a".repeat(64),
      turnId,
      value: convergenceCandidate(1),
      workspaceActivity: { count: 2, types: ["commandExecution", "fileChange"] },
    },
  })
  const firstClients = [sourceClient, recoveryClient]
  const firstBroker = new Broker({
    appServerFactory: () => firstClients.shift(),
    egoAdapter: createConvergenceEgoAdapter(() => {
      throw new Error("review must not start before the durable result transition returns")
    }).adapter,
    recoveryDelaysMs: [1],
    store,
  })
  await firstBroker.initialize()
  await firstBroker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-durable-completed-result",
    mode: "existing",
    taskSpace: 10,
  })
  const started = await firstBroker.startConvergence({
    acceptanceCriteria: ["Identity is bound.", "Recovered completion is durable."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Persist one completed recovered result before consuming it.",
  })
  await store.transitionCommitted
  const pending = store.getWorkflow(started.id)

  assert.equal(pending.consecutiveAppServerExitCount, 0)
  assert.equal(pending.activeCodexWorkspaceActivity.count, 2)
  assert.equal(pending.private.pendingCodexResult.turnId, "codex-durable-completed-result")
  assert.equal(pending.private.pendingCodexResult.result.workspaceActivity.count, 2)
  firstBroker.close()

  let reviewStarted
  let releaseReview
  const reviewStartedPromise = new Promise((resolve) => {
    reviewStarted = resolve
  })
  const reviewReleased = new Promise((resolve) => {
    releaseReview = resolve
  })
  const ego = createConvergenceEgoAdapter(async (identity) => {
    reviewStarted()
    await reviewReleased
    return {
      ...identity,
      criteria: [
        { evidence: "The pending result remained exact.", id: "AC-1", status: "pass" },
        { evidence: "Workspace activity was merged once.", id: "AC-2", status: "pass" },
      ],
      decision: "settled",
      findings: [],
      summary: "The durable completed result is settled.",
    }
  })
  let appServerFactoryCalls = 0
  const finalStore = new EventStore(dataDir)
  const secondBroker = new Broker({
    appServerFactory: () => {
      appServerFactoryCalls += 1
      throw new Error("the durable result must be reviewed before App Server setup")
    },
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: finalStore,
  })
  await secondBroker.initialize()
  t.after(() => secondBroker.close())
  await reviewStartedPromise
  const captured = finalStore.getWorkflow(started.id)

  assert.ok(["codex_captured", "chatgpt_running"].includes(captured.phase))
  assert.equal(captured.private.cycles.at(-1).codex.workspaceActivity.count, 2)
  assert.equal(captured.private.pendingCodexResult, undefined)
  assert.equal(captured.activeCodexWorkspaceActivity, undefined)
  assert.equal(captured.activeCodexTurn, undefined)
  assert.equal(
    captured.codexThreadRotationPending.sourceTurnId,
    "codex-durable-completed-result",
  )
  assert.equal(appServerFactoryCalls, 0)
  releaseReview()
  const completed = await secondBroker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.codexThreadRotationPending, undefined)
  assert.equal(appServerFactoryCalls, 0)
  assert.equal(ego.exchanges, 1)
  const supervision = superviseWorkflow(completed)
  assert.equal(supervision.stage, "settled")
  assert.equal(supervision.chatGpt.delivery, "response_captured")
  assert.equal(supervision.codex.threadRotationPending, false)
  assert.doesNotMatch(supervision.message, /thread rotation pending/i)
})

test("restart settles a captured settled review before deferred thread rotation", async (t) => {
  const { dataDir, started } = await persistCompletedRecoveryReceipt(t, {
    suffix: "settled-review-crash",
    value: convergenceCandidate(1),
    workspaceActivity: { count: 2, types: ["commandExecution", "fileChange"] },
  })
  const ego = createConvergenceEgoAdapter((identity) => ({
    ...identity,
    criteria: [
      { evidence: "The pending result remained exact.", id: "AC-1", status: "pass" },
      { evidence: "The captured review settles the target.", id: "AC-2", status: "pass" },
    ],
    decision: "settled",
    findings: [],
    summary: "The captured review is settled.",
  }))
  const reviewStore = new PauseAfterTransitionStore(
    dataDir,
    "convergence.chatgpt_review_captured",
  )
  let appServerFactoryCalls = 0
  const appServerFactory = () => {
    appServerFactoryCalls += 1
    throw new Error("settled review recovery must not construct an App Server")
  }
  const interruptedBroker = new Broker({
    appServerFactory,
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: reviewStore,
  })
  await interruptedBroker.initialize()
  await reviewStore.transitionCommitted
  const captured = reviewStore.getWorkflow(started.id)

  assert.equal(captured.phase, "review_captured")
  assert.equal(captured.codexThreadRotationPending.sourceTurnId, "codex-pending-result-settled-review-crash")
  assert.equal(captured.private.cycles.at(-1).review.decision, "settled")
  assert.equal(appServerFactoryCalls, 0)
  assert.equal(ego.exchanges, 1)
  const capturedChildWorkflowId = captured.childWorkflowId
  interruptedBroker.close()

  const finalStore = new EventStore(dataDir)
  const finalBroker = new Broker({
    appServerFactory,
    egoAdapter: unusedEgoAdapter,
    recoveryDelaysMs: [1],
    store: finalStore,
  })
  await finalBroker.initialize()
  t.after(() => finalBroker.close())
  const completed = await finalBroker.awaitWorkflow({
    timeoutMs: 5_000,
    workflowId: started.id,
  })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.phase, "settled")
  assert.equal(completed.childWorkflowId, capturedChildWorkflowId)
  assert.equal(completed.codexThreadRotationPending, undefined)
  assert.equal(appServerFactoryCalls, 0)
  assert.equal(ego.exchanges, 1)
  const supervision = superviseWorkflow(completed)
  assert.equal(supervision.stage, "settled")
  assert.equal(supervision.chatGpt.delivery, "response_captured")
  assert.equal(supervision.codex.threadRotationPending, false)
  assert.doesNotMatch(supervision.message, /thread rotation pending/i)
})

test("a continued review establishes a fresh App Server only after the durable review is captured", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new PauseAfterTransitionStore(dataDir, "convergence.codex_app_server_recovered")
  const sourceClient = new FakeConvergenceAppServer()
  sourceClient.runStructuredTurn = async (input) => {
    await input.onStarted({ turnId: "codex-deferred-app-server-result" })
    throw new EgoChatError("app_server_exited", "The accepted turn transport exited.")
  }
  const recoveryClient = new FakeConvergenceAppServer()
  recoveryClient.recoverStructuredTurn = async (_threadId, turnId) => ({
    disposition: "completed",
    result: {
      durationMs: 10,
      responseDigest: "b".repeat(64),
      turnId,
      value: convergenceCandidate(1),
      workspaceActivity: { count: 2, types: ["commandExecution", "fileChange"] },
    },
  })
  const firstClients = [sourceClient, recoveryClient]
  const firstBroker = new Broker({
    appServerFactory: () => firstClients.shift(),
    egoAdapter: createConvergenceEgoAdapter(() => {
      throw new Error("review must not start before the durable result transition returns")
    }).adapter,
    recoveryDelaysMs: [1],
    store,
  })
  await firstBroker.initialize()
  await firstBroker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-deferred-app-server",
    mode: "existing",
    taskSpace: 10,
  })
  const started = await firstBroker.startConvergence({
    acceptanceCriteria: ["Identity is bound.", "Setup follows durable review."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Review a durable completed result before establishing its continuation thread.",
  })
  await store.transitionCommitted
  firstBroker.close()

  const ego = createConvergenceEgoAdapter((identity, exchange) => {
    if (exchange === 1) {
      return {
        ...identity,
        criteria: [
          { evidence: "The first candidate is durable.", id: "AC-1", status: "pass" },
          { evidence: "One continuation remains.", id: "AC-2", status: "fail" },
        ],
        decision: "continue",
        findings: [{
          action: "Continue in a fresh Codex thread.",
          id: "B-CONTINUE-AFTER-DURABLE-REVIEW",
          severity: "blocking",
          title: "One continuation remains",
        }],
        summary: "Continue after capturing this review.",
      }
    }
    if (exchange === 2) {
      const captured = restartStore.getWorkflow(started.id)
      assert.equal(captured.cycle, 2)
      assert.equal(captured.codexThreadGeneration, 2)
      assert.equal(captured.codexThreadRotationPending, undefined)
      assert.notEqual(
        captured.lastCodexThreadRotation.threadId,
        captured.lastCodexThreadRotation.abandonedThreadId,
      )
      const supervision = superviseWorkflow(captured)
      assert.equal(supervision.codex.threadRotationPending, false)
      assert.doesNotMatch(supervision.message, /thread rotation pending/i)
      return {
        ...identity,
        criteria: [
          { evidence: "The replacement generation is exact.", id: "AC-1", status: "pass" },
          { evidence: "One ordinary cycle remains.", id: "AC-2", status: "fail" },
        ],
        decision: "continue",
        findings: [{
          action: "Continue without another thread rotation.",
          id: "B-ONE-ORDINARY-CYCLE",
          severity: "blocking",
          title: "One ordinary cycle remains",
        }],
        summary: "Continue on the already rotated thread.",
      }
    }
    return {
      ...identity,
      criteria: [
        { evidence: "The identity remained exact.", id: "AC-1", status: "pass" },
        { evidence: "Setup followed the captured review.", id: "AC-2", status: "pass" },
      ],
      decision: "settled",
      findings: [],
      summary: "The deferred continuation is settled.",
    }
  })
  const continuationClient = new FakeConvergenceAppServer((turn) => convergenceCandidate(turn + 1))
  continuationClient.startThread = async () => ({
    id: "codex-deferred-continuation-thread",
    sessionId: "codex-deferred-continuation-thread",
  })
  const restartStore = new EventStore(dataDir)
  let appServerFactoryCalls = 0
  const secondBroker = new Broker({
    appServerFactory: () => {
      appServerFactoryCalls += 1
      const snapshot = restartStore.getWorkflow(started.id)
      assert.equal(snapshot.phase, "review_captured")
      assert.equal(snapshot.private.cycles.at(-1).codex.workspaceActivity.count, 2)
      assert.equal(snapshot.private.pendingCodexResult, undefined)
      assert.equal(snapshot.activeCodexWorkspaceActivity, undefined)
      assert.equal(snapshot.activeCodexTurn, undefined)
      assert.equal(snapshot.codexThreadRotationPending.sourceTurnId, "codex-deferred-app-server-result")
      assert.equal(ego.exchanges, 1)
      return continuationClient
    },
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: restartStore,
  })
  await secondBroker.initialize()
  t.after(() => secondBroker.close())
  const completed = await secondBroker.awaitWorkflow({
    timeoutMs: 5_000,
    workflowId: started.id,
  })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.result.cycleCount, 3)
  assert.equal(appServerFactoryCalls, 1)
  assert.equal(continuationClient.turns, 2)
  assert.equal(ego.exchanges, 3)
})

test("Cycle 2 candidate correction does not restore a consumed local rotation marker", async (t) => {
  const { dataDir, started } = await persistCompletedRecoveryReceipt(t, {
    suffix: "cycle-two-correction",
    value: convergenceCandidate(1),
    workspaceActivity: { count: 2, types: ["commandExecution", "fileChange"] },
  })
  const ego = createConvergenceEgoAdapter((identity, exchange) => {
    assert.equal(exchange, 1)
    return {
      ...identity,
      criteria: [
        { evidence: "The first candidate is durable.", id: "AC-1", status: "pass" },
        { evidence: "Cycle 2 must correct its envelope.", id: "AC-2", status: "fail" },
      ],
      decision: "continue",
      findings: [{
        action: "Correct the Cycle 2 candidate envelope.",
        id: "B-CYCLE-TWO-CORRECTION",
        severity: "blocking",
        title: "Cycle 2 correction required",
      }],
      summary: "Continue to the Cycle 2 correction.",
    }
  })
  const continuationClient = new FakeConvergenceAppServer(() => ({
    ...convergenceCandidate(2),
    blockers: ["This Cycle 2 envelope is inconsistent."],
  }))
  continuationClient.startThread = async () => ({
    id: "codex-cycle-two-correction-thread",
    sessionId: "codex-cycle-two-correction-thread",
  })
  const restartStore = new PauseAfterTransitionStore(
    dataDir,
    "convergence.codex_candidate_correction_started",
  )
  let appServerFactoryCalls = 0
  const broker = new Broker({
    appServerFactory: () => {
      appServerFactoryCalls += 1
      return continuationClient
    },
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: restartStore,
  })
  await broker.initialize()
  await restartStore.transitionCommitted
  t.after(() => broker.close())
  const corrected = restartStore.getWorkflow(started.id)

  assert.equal(corrected.phase, "codex_ready")
  assert.equal(corrected.cycle, 2)
  assert.equal(corrected.codexThreadGeneration, 2)
  assert.equal(corrected.codexThreadRotationCount, 1)
  assert.equal(corrected.codexThreadRotationPending, undefined)
  assert.equal(corrected.pendingCodexContinuation.kind, "candidate_correction")
  assert.equal(corrected.activeCodexWorkspaceActivity.count, 1)
  assert.equal(appServerFactoryCalls, 1)
  assert.equal(continuationClient.turns, 1)
  assert.equal(ego.exchanges, 1)
  const supervision = superviseWorkflow(corrected)
  assert.equal(supervision.codex.threadRotationPending, false)
  assert.doesNotMatch(supervision.message, /thread rotation pending/i)
})

test("deferred completed-result continuations never resume the abandoned thread after restart", async (t) => {
  const scenarios = [
    {
      expectedActivityCount: 2,
      expectedPrompt: /internal correction turn/,
      suffix: "candidate-correction",
      transitionType: "convergence.codex_candidate_correction_started",
      value: {
        ...convergenceCandidate(1),
        blockers: ["This completed envelope is inconsistent."],
      },
      workspaceActivity: { count: 2, types: ["commandExecution", "fileChange"] },
    },
    {
      expectedActivityCount: 1,
      expectedPrompt: /made no observable workspace tool call/i,
      suffix: "workspace-inspection",
      transitionType: "convergence.codex_workspace_inspection_retry_started",
      value: convergenceCandidate(1),
      workspaceActivity: { count: 0, types: [] },
    },
  ]

  for (const scenario of scenarios) {
    await t.test(scenario.suffix, async (t) => {
      const { dataDir, started, turnId } = await persistCompletedRecoveryReceipt(t, scenario)
      const continuationStore = new PauseAfterTransitionStore(dataDir, scenario.transitionType)
      let prematureFactoryCalls = 0
      const continuationBroker = new Broker({
        appServerFactory: () => {
          prematureFactoryCalls += 1
          throw new Error("the abandoned App Server must not be resumed")
        },
        egoAdapter: unusedEgoAdapter,
        recoveryDelaysMs: [1],
        store: continuationStore,
      })
      await continuationBroker.initialize()
      await continuationStore.transitionCommitted
      const continued = continuationStore.getWorkflow(started.id)

      assert.equal(continued.phase, "codex_ready")
      assert.equal(continued.activeCodexTurn, undefined)
      assert.equal(continued.private.pendingCodexResult, undefined)
      assert.equal(continued.codexThreadRotationPending.sourceTurnId, turnId)
      assert.equal(prematureFactoryCalls, 0)
      continuationBroker.close()

      const freshClient = new FakeConvergenceAppServer()
      let resumeCalls = 0
      let recoveryCalls = 0
      freshClient.resumeThread = async () => {
        resumeCalls += 1
        throw new Error("the abandoned thread must never be resumed")
      }
      freshClient.recoverStructuredTurn = async () => {
        recoveryCalls += 1
        throw new Error("the consumed result must never be recovered")
      }
      freshClient.runStructuredTurn = async (input) => {
        freshClient.turns += 1
        freshClient.prompts.push(input.prompt)
        await input.onStarted({ turnId: `codex-fresh-${scenario.suffix}` })
        return {
          durationMs: 10,
          responseDigest: "9".repeat(64),
          turnId: `codex-fresh-${scenario.suffix}`,
          value: convergenceCandidate(1),
          workspaceActivity: scenario.suffix === "candidate-correction"
            ? { count: 0, types: [] }
            : { count: 1, types: ["commandExecution"] },
        }
      }
      const finalStore = new EventStore(dataDir)
      const ego = createConvergenceEgoAdapter((identity) => {
        const captured = finalStore.getWorkflow(started.id)
        assert.equal(
          captured.private.cycles.at(-1).codex.workspaceActivity.count,
          scenario.expectedActivityCount,
        )
        return {
          ...identity,
          criteria: [
            { evidence: "The durable identity remained exact.", id: "AC-1", status: "pass" },
            { evidence: "The continuation used a fresh thread.", id: "AC-2", status: "pass" },
          ],
          decision: "settled",
          findings: [],
          summary: "The restart-safe deferred continuation is settled.",
        }
      })
      const finalBroker = new Broker({
        appServerFactory: () => freshClient,
        egoAdapter: ego.adapter,
        recoveryDelaysMs: [1],
        store: finalStore,
      })
      await finalBroker.initialize()
      t.after(() => finalBroker.close())
      const completed = await finalBroker.awaitWorkflow({
        timeoutMs: 5_000,
        workflowId: started.id,
      })

      assert.equal(completed.status, "succeeded")
      assert.equal(freshClient.turns, 1)
      assert.match(freshClient.prompts[0], scenario.expectedPrompt)
      assert.equal(resumeCalls, 0)
      assert.equal(recoveryCalls, 0)
      assert.equal(ego.exchanges, 1)
    })
  }
})

test("restart continues a scheduled deferred rotation instead of resuming the abandoned thread", async (t) => {
  const scenario = {
    suffix: "rotation-recovery",
    value: {
      ...convergenceCandidate(1),
      blockers: ["This completed envelope needs correction."],
    },
    workspaceActivity: { count: 2, types: ["commandExecution", "fileChange"] },
  }
  const { dataDir, started, turnId } = await persistCompletedRecoveryReceipt(t, scenario)
  const rotationStore = new PauseAfterTransitionStore(
    dataDir,
    "convergence.codex_thread_rotation_recovery_scheduled",
  )
  const failedRotationClient = new FakeConvergenceAppServer()
  failedRotationClient.connect = async () => {
    throw new EgoChatError("app_server_exited", "Fresh thread setup exited.")
  }
  let abandonedResumeCalls = 0
  failedRotationClient.resumeThread = async () => {
    abandonedResumeCalls += 1
    throw new Error("the abandoned thread must never be resumed")
  }
  const interruptedBroker = new Broker({
    appServerFactory: () => failedRotationClient,
    egoAdapter: unusedEgoAdapter,
    recoveryDelaysMs: [1],
    store: rotationStore,
  })
  await interruptedBroker.initialize()
  await rotationStore.transitionCommitted
  const interrupted = rotationStore.getWorkflow(started.id)

  assert.equal(interrupted.phase, "codex_ready")
  assert.equal(interrupted.codexThreadRotationPending.sourceTurnId, turnId)
  assert.equal(interrupted.private.pendingCodexResult, undefined)
  assert.equal(abandonedResumeCalls, 0)
  interruptedBroker.close()

  const freshClient = new FakeConvergenceAppServer()
  let resumedAfterRestart = 0
  freshClient.resumeThread = async () => {
    resumedAfterRestart += 1
    throw new Error("restart must continue rotation, not resume the abandoned thread")
  }
  const ego = createConvergenceEgoAdapter((identity) => ({
    ...identity,
    criteria: [
      { evidence: "The durable identity remained exact.", id: "AC-1", status: "pass" },
      { evidence: "The scheduled rotation resumed safely.", id: "AC-2", status: "pass" },
    ],
    decision: "settled",
    findings: [],
    summary: "The scheduled rotation recovery is settled.",
  }))
  const finalBroker = new Broker({
    appServerFactory: () => freshClient,
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await finalBroker.initialize()
  t.after(() => finalBroker.close())
  const completed = await finalBroker.awaitWorkflow({
    timeoutMs: 5_000,
    workflowId: started.id,
  })

  assert.equal(completed.status, "succeeded")
  assert.equal(freshClient.turns, 1)
  assert.match(freshClient.prompts[0], /internal correction turn/)
  assert.equal(resumedAfterRestart, 0)
  assert.equal(ego.exchanges, 1)
})

test("broker restart preserves prior cycle activity for a recovered envelope-only turn", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const firstClient = new FakeConvergenceAppServer()
  let secondTurnStarted
  const secondTurnRecorded = new Promise((resolve) => {
    secondTurnStarted = resolve
  })
  firstClient.runStructuredTurn = async (input) => {
    firstClient.turns += 1
    const turnId = `codex-restart-cycle-activity-${firstClient.turns}`
    await input.onStarted({ turnId })
    if (firstClient.turns === 1) {
      return {
        durationMs: 10,
        responseDigest: "a".repeat(64),
        turnId,
        value: {
          ...convergenceCandidate(1),
          blockers: ["Correct this envelope while preserving the completed inspection."],
        },
        workspaceActivity: { count: 1, types: ["commandExecution"] },
      }
    }
    secondTurnStarted()
    return new Promise(() => {})
  }
  const ego = createConvergenceEgoAdapter((identity) => ({
    ...identity,
    criteria: [
      { evidence: "The target digest is exact.", id: "AC-1", status: "pass" },
      { evidence: "The earlier cycle inspection survived restart.", id: "AC-2", status: "pass" },
    ],
    decision: "settled",
    findings: [],
    summary: "The restart-safe cycle evidence is settled.",
  }))
  const firstBroker = new Broker({
    appServerFactory: () => firstClient,
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await firstBroker.initialize()
  await firstBroker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-restart-cycle-activity",
    mode: "existing",
    taskSpace: 10,
  })
  const started = await firstBroker.startConvergence({
    acceptanceCriteria: ["Identity is bound.", "Cycle activity survives broker restart."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Preserve same-cycle workspace evidence across a broker restart.",
  })
  await secondTurnRecorded
  const interrupted = firstBroker.getWorkflow({ workflowId: started.id })
  assert.equal(interrupted.activeCodexWorkspaceActivity.count, 1)
  assert.equal(interrupted.activeCodexTurn.turnId, "codex-restart-cycle-activity-2")
  firstBroker.close()

  const secondClient = new FakeConvergenceAppServer()
  secondClient.recoverStructuredTurn = async (_threadId, turnId) => ({
    disposition: "completed",
    result: {
      durationMs: 10,
      responseDigest: "b".repeat(64),
      turnId,
      value: convergenceCandidate(1),
      workspaceActivity: { count: 0, types: [] },
    },
  })
  const secondBroker = new Broker({
    appServerFactory: () => secondClient,
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await secondBroker.initialize()
  t.after(() => secondBroker.close())
  const completed = await secondBroker.awaitWorkflow({
    timeoutMs: 5_000,
    workflowId: started.id,
  })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.codexInspectionRetryCount ?? 0, 0)
  assert.equal(secondClient.turns, 0)
  assert.equal(ego.exchanges, 1)
})

test("broker restart preserves the same-cycle no-inspection liveness threshold", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const firstClient = new FakeConvergenceAppServer()
  let thirdTurnStarted
  const thirdTurnRecorded = new Promise((resolve) => {
    thirdTurnStarted = resolve
  })
  firstClient.runStructuredTurn = async (input) => {
    firstClient.turns += 1
    const turnId = `codex-restart-no-inspection-${firstClient.turns}`
    await input.onStarted({ turnId })
    if (firstClient.turns === 3) {
      thirdTurnStarted()
      return new Promise(() => {})
    }
    return {
      durationMs: 10,
      responseDigest: String(firstClient.turns).repeat(64),
      turnId,
      value: convergenceCandidate(1),
      workspaceActivity: { count: 0, types: [] },
    }
  }
  const ego = createConvergenceEgoAdapter((identity, _exchange, input) => {
    if (identity.cycle === 1) {
      assert.match(input.prompt, /Broker liveness checkpoint/)
      return {
        ...identity,
        criteria: [
          { evidence: "No workspace evidence exists yet.", id: "AC-1", status: "unknown" },
          { evidence: "The next cycle must inspect the workspace.", id: "AC-2", status: "unknown" },
        ],
        decision: "continue",
        findings: [{
          action: "Run a concrete workspace inspection in the next cycle.",
          id: "B-RESTART-LIVENESS",
          severity: "blocking",
          title: "Resume with observable workspace evidence",
        }],
        summary: "Continue after the liveness checkpoint.",
      }
    }
    return {
      ...identity,
      criteria: [
        { evidence: "The target identity remained exact.", id: "AC-1", status: "pass" },
        { evidence: "The post-restart cycle inspected the workspace.", id: "AC-2", status: "pass" },
      ],
      decision: "settled",
      findings: [],
      summary: "The restart-safe liveness recovery is settled.",
    }
  })
  const firstBroker = new Broker({
    appServerFactory: () => firstClient,
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await firstBroker.initialize()
  await firstBroker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl: "https://chatgpt.com/c/convergence-restart-no-inspection",
    mode: "existing",
    taskSpace: 10,
  })
  const started = await firstBroker.startConvergence({
    acceptanceCriteria: ["Identity is bound.", "No-inspection retries survive broker restart."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Preserve the liveness threshold across a broker restart.",
  })
  await thirdTurnRecorded
  const interrupted = firstBroker.getWorkflow({ workflowId: started.id })
  assert.equal(interrupted.activeCodexInspectionRetryCount, 2)
  assert.equal(interrupted.activeCodexTurn.turnId, "codex-restart-no-inspection-3")
  firstBroker.close()

  const secondClient = new FakeConvergenceAppServer(() => convergenceCandidate(2))
  secondClient.recoverStructuredTurn = async (_threadId, turnId) => ({
    disposition: "completed",
    result: {
      durationMs: 10,
      responseDigest: "c".repeat(64),
      turnId,
      value: convergenceCandidate(1),
      workspaceActivity: { count: 0, types: [] },
    },
  })
  const secondBroker = new Broker({
    appServerFactory: () => secondClient,
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await secondBroker.initialize()
  t.after(() => secondBroker.close())
  const completed = await secondBroker.awaitWorkflow({
    timeoutMs: 5_000,
    workflowId: started.id,
  })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.codexInspectionLivenessCheckpointCount, 1)
  assert.equal(completed.codexInspectionRetryCount, 3)
  assert.equal(secondClient.turns, 1)
  assert.equal(ego.exchanges, 2)
})

test("broker restart repairs a missing no-inspection thread rotation", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  await seedRestartBinding(
    dataDir,
    "https://chatgpt.com/c/convergence-restart-missing-inspection-rotation",
  )
  const contract = createContract(
    "Repair a legacy no-inspection continuation that reused its exhausted thread.",
    ["Identity is bound.", "The continuation uses a fresh Codex thread."],
  )
  const candidate = {
    ...convergenceCandidate(1),
    blockers: ["The exhausted thread produced no workspace evidence."],
    status: "blocked",
  }
  const candidateDigest = digestJson(candidate)
  const review = {
    candidateDigest,
    criteria: [
      { evidence: "The target identity remains exact.", id: "AC-1", status: "pass" },
      { evidence: "Continue in a fresh Codex thread.", id: "AC-2", status: "fail" },
    ],
    cycle: 1,
    decision: "continue",
    findings: [{
      action: "Rotate before the next Codex turn.",
      id: "B-ROTATE-AFTER-INSPECTION-LIVENESS",
      severity: "blocking",
      title: "Fresh Codex thread required",
    }],
    summary: "Continue after repairing the missing rotation.",
    targetDigest: contract.targetDigest,
  }
  const workflow = convergenceRestartWorkflow({
    candidate,
    contract,
    cycle: 1,
    id: "d4a5532d-d4bc-4bf8-8db4-c65e9f85b534",
    phase: "codex_running",
    review,
  })
  workflow.cycle = 2
  workflow.codexInspectionLivenessCheckpointCount = 1
  workflow.codexInspectionRetryCount = 3
  workflow.codexThreadGeneration = 1
  workflow.codexThreadRotationCount = 0
  workflow.activeCodexTurn = {
    continuation: { cycle: 2, kind: "cycle" },
    cycle: 2,
    turnId: "codex-wrongly-reused-thread-turn",
  }
  workflow.private.cycles[0].livenessCheckpoint = {
    kind: "inspection",
    retryCount: 3,
    sourceTurnId: "codex-no-inspection-source-turn",
  }
  const store = new EventStore(dataDir)
  await store.initialize()
  await store.persist("workflow.started", workflow)

  const replacementClient = new FakeConvergenceAppServer(() => convergenceCandidate(2))
  replacementClient.resumeThread = async () => {
    throw new Error("the exhausted Codex thread must not be resumed")
  }
  replacementClient.startThread = async () => ({
    id: "codex-repaired-inspection-thread",
    sessionId: "codex-repaired-inspection-thread",
  })
  replacementClient.unsubscribeThread = async (threadId) => {
    assert.equal(threadId, "codex-repaired-inspection-thread")
  }
  const ego = createConvergenceEgoAdapter((identity) => ({
    ...identity,
    criteria: [
      { evidence: "The target identity remained exact.", id: "AC-1", status: "pass" },
      { evidence: "The repaired continuation used a fresh thread.", id: "AC-2", status: "pass" },
    ],
    decision: "settled",
    findings: [],
    summary: "The repaired fresh-thread continuation is settled.",
  }))
  const broker = new Broker({
    appServerFactory: () => replacementClient,
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  const completed = await broker.awaitWorkflow({
    timeoutMs: 5_000,
    workflowId: workflow.id,
  })

  assert.equal(
    completed.status,
    "succeeded",
    JSON.stringify(completed.error ?? completed.humanRequired ?? completed),
  )
  assert.equal(completed.codexThreadGeneration, 2)
  assert.equal(completed.codexThreadRotationCount, 1)
  assert.equal(completed.lastCodexThreadRotation.abandonedThreadId, "codex-convergence-thread")
  assert.equal(completed.lastCodexThreadRotation.threadId, "codex-repaired-inspection-thread")
  assert.equal(replacementClient.turns, 1)
  assert.equal(ego.exchanges, 1)
})

test("broker restart retires an old-thread review before accepting settlement", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/c/convergence-restart-old-thread-review"
  await seedRestartBinding(dataDir, canonicalUrl)
  const contract = createContract(
    "Retire a delivered review whose candidate reused an exhausted Codex thread.",
    ["Identity is bound.", "Only a fresh-thread candidate may settle."],
  )
  const workflowId = "45401d01-c88f-470e-bd70-fbb410676f61"
  const staleCandidate = convergenceCandidate(2)
  const staleCandidateDigest = digestJson(staleCandidate)
  const markerToken = digestJson({
    cycle: 2,
    purpose: "review",
    workflowId,
  }).slice(0, 32).toUpperCase()
  const turnMarker = `EGO_CHAT_CONVERGENCE_${markerToken}_C2`
  const terminalMarker = `EGO_CHAT_REVIEW_DONE_${markerToken}`
  const staleReview = {
    candidateDigest: staleCandidateDigest,
    criteria: [
      { evidence: "The target digest is exact.", id: "AC-1", status: "pass" },
      { evidence: "The stale candidate appears complete.", id: "AC-2", status: "pass" },
    ],
    cycle: 2,
    decision: "settled",
    findings: [],
    summary: "The stale candidate would otherwise settle.",
    targetDigest: contract.targetDigest,
  }
  const staleResponseText = `${JSON.stringify(staleReview)}\n${terminalMarker}`
  let staleBrowserSends = 0
  const firstBroker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      exchange: async (input) => {
        staleBrowserSends += 1
        return {
          canonicalUrl,
          durationMs: 20,
          head: {
            fingerprint: "old-thread-review-head",
            fingerprintVersion: "tail-v1",
            lastContentDigest: digest(staleResponseText),
            lastMessageId: "old-thread-review-assistant",
            lastRole: "assistant",
            messageCount: 4,
          },
          modelPolicy: modelPolicyObservation(),
          responseDigest: digest(staleResponseText),
          responseText: staleResponseText,
          targetId: "restart-tab",
          taskSpaceId: 10,
          turnMarker: input.turnMarker,
        }
      },
    },
    store: new EventStore(dataDir),
  })
  await firstBroker.initialize()
  const staleChild = await firstBroker.startEgoExchange({
    allowProtocolRepairCapture: true,
    allowTaskSpaceReclaim: true,
    bindingKey: "ego-chat-main",
    expectedTerminalMarker: terminalMarker,
    prompt: buildChatGptPrompt({
      candidate: staleCandidate,
      candidateDigest: staleCandidateDigest,
      contract,
      cycle: 2,
      terminalMarker,
      turnMarker,
    }),
    timeoutMs: 30_000,
    turnMarker,
  })
  await firstBroker.awaitWorkflow({ timeoutMs: 5_000, workflowId: staleChild.id })
  firstBroker.close()

  const livenessCandidate = {
    ...convergenceCandidate(1),
    blockers: ["The exhausted thread produced no workspace evidence."],
    status: "blocked",
  }
  const livenessCandidateDigest = digestJson(livenessCandidate)
  const livenessReview = {
    candidateDigest: livenessCandidateDigest,
    criteria: [
      { evidence: "The target identity remains exact.", id: "AC-1", status: "pass" },
      { evidence: "Continue in a fresh Codex thread.", id: "AC-2", status: "fail" },
    ],
    cycle: 1,
    decision: "continue",
    findings: [{
      action: "Rotate before the next Codex turn.",
      id: "B-ROTATE-AFTER-INSPECTION-LIVENESS",
      severity: "blocking",
      title: "Fresh Codex thread required",
    }],
    summary: "Continue after repairing the missing rotation.",
    targetDigest: contract.targetDigest,
  }
  const livenessWorkflow = convergenceRestartWorkflow({
    candidate: livenessCandidate,
    contract,
    id: workflowId,
    phase: "review_captured",
    review: livenessReview,
  })
  livenessWorkflow.codexInspectionLivenessCheckpointCount = 1
  livenessWorkflow.codexInspectionRetryCount = 3
  livenessWorkflow.codexThreadGeneration = 1
  livenessWorkflow.codexThreadRotationCount = 0
  livenessWorkflow.private.cycles[0].livenessCheckpoint = {
    kind: "inspection",
    retryCount: 3,
    sourceTurnId: "codex-no-inspection-source-turn",
  }
  const store = new EventStore(dataDir)
  await store.initialize()
  await store.persist("workflow.started", livenessWorkflow)
  const persistedLiveness = store.getWorkflow(workflowId)
  const staleWorkflow = structuredClone(persistedLiveness)
  staleWorkflow.candidateDigest = staleCandidateDigest
  staleWorkflow.childWorkflowId = staleChild.id
  staleWorkflow.cycle = 2
  staleWorkflow.phase = "chatgpt_running"
  staleWorkflow.private.cycles = [
    {
      candidateDigest: livenessCandidateDigest,
      codex: {
        responseDigest: "b".repeat(64),
        turnId: "codex-no-inspection-source-turn",
      },
      cycle: 1,
      reviewSignature: reviewSignature(livenessReview),
    },
    {
      candidate: staleCandidate,
      candidateDigest: staleCandidateDigest,
      codex: {
        appServerRecoveryCount: 0,
        durationMs: 10,
        inspectionRetryCount: 0,
        responseDigest: "c".repeat(64),
        turnId: "codex-old-thread-candidate",
        workspaceActivity: { count: 1, types: ["commandExecution"] },
      },
      cycle: 2,
    },
  ]
  staleWorkflow.private.priorReview = livenessReview
  delete staleWorkflow.lastCodexLivenessCheckpoint
  await store.persist("convergence.chatgpt_review_started", staleWorkflow, persistedLiveness)

  const appServer = new FakeConvergenceAppServer(() => convergenceCandidate(3))
  appServer.resumeThread = async () => {
    throw new Error("the exhausted Codex thread must not be resumed")
  }
  appServer.startThread = async () => ({
    id: "codex-repaired-review-thread",
    sessionId: "codex-repaired-review-thread",
  })
  const ego = createConvergenceEgoAdapter((identity) => ({
    ...identity,
    criteria: [
      { evidence: "The target identity remained exact.", id: "AC-1", status: "pass" },
      { evidence: "The fresh-thread candidate is complete.", id: "AC-2", status: "pass" },
    ],
    decision: "settled",
    findings: [],
    summary: "The fresh-thread candidate is settled.",
  }))
  const broker = new Broker({
    appServerFactory: () => appServer,
    egoAdapter: ego.adapter,
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  const completed = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId })

  assert.equal(
    completed.status,
    "succeeded",
    JSON.stringify(completed.error ?? completed.humanRequired ?? completed),
  )
  assert.equal(completed.result.cycleCount, 3)
  assert.equal(completed.codexThreadGeneration, 2)
  assert.equal(completed.codexThreadRotationCount, 1)
  assert.equal(completed.lastCodexThreadRotation.threadId, "codex-repaired-review-thread")
  assert.equal(appServer.turns, 1)
  assert.equal(ego.exchanges, 1)
  assert.equal(staleBrowserSends, 1)
})

test("running convergence resumes a captured Codex candidate after broker restart", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  await seedRestartBinding(
    dataDir,
    "https://chatgpt.com/c/convergence-restart-codex-captured",
  )
  const contract = createContract(
    "Resume a durably captured candidate without repeating its Codex turn.",
    ["Identity is bound.", "The captured candidate is independently settled."],
  )
  const candidate = convergenceCandidate(1)
  const workflow = convergenceRestartWorkflow({
    candidate,
    contract,
    id: "4dd5f6d7-762f-4cf9-8ec0-cbe7c365c4a1",
    phase: "codex_captured",
  })
  const store = new EventStore(dataDir)
  await store.initialize()
  await store.persist("workflow.started", workflow)

  const appServer = new FakeConvergenceAppServer()
  const ego = createConvergenceEgoAdapter((identity) => ({
    ...identity,
    criteria: [
      { evidence: "The target digest is exact.", id: "AC-1", status: "pass" },
      { evidence: "The captured candidate is settled.", id: "AC-2", status: "pass" },
    ],
    decision: "settled",
    findings: [],
    summary: "The captured candidate remained reviewable after restart.",
  }))
  const broker = new Broker({
    appServerFactory: () => appServer,
    egoAdapter: ego.adapter,
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  const completed = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: workflow.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.result.cycleCount, 1)
  assert.equal(appServer.turns, 0)
  assert.equal(ego.exchanges, 1)
})

test("running convergence continues after a captured review survives broker restart", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  await seedRestartBinding(
    dataDir,
    "https://chatgpt.com/c/convergence-restart-review-captured",
  )
  const contract = createContract(
    "Continue from durable review feedback without asking a human to restart the cycle.",
    ["Identity is bound.", "The second candidate settles the prior review."],
  )
  const firstCandidate = convergenceCandidate(1)
  const firstReview = {
    candidateDigest: digestJson(firstCandidate),
    criteria: [
      { evidence: "The target digest is exact.", id: "AC-1", status: "pass" },
      { evidence: "One implementation correction remains.", id: "AC-2", status: "fail" },
    ],
    cycle: 1,
    decision: "continue",
    findings: [{
      action: "Apply the remaining implementation correction.",
      id: "B-RESTART-CONTINUE",
      severity: "blocking",
      title: "One correction remains",
    }],
    summary: "Continue with the durable review feedback.",
    targetDigest: contract.targetDigest,
  }
  const workflow = convergenceRestartWorkflow({
    candidate: firstCandidate,
    contract,
    id: "a9432978-ec53-49c6-bf95-4cf7a2d55cb7",
    phase: "review_captured",
    review: firstReview,
  })
  const store = new EventStore(dataDir)
  await store.initialize()
  await store.persist("workflow.started", workflow)

  const appServer = new FakeConvergenceAppServer(() => convergenceCandidate(2))
  const ego = createConvergenceEgoAdapter((identity) => ({
    ...identity,
    criteria: [
      { evidence: "The target digest is exact.", id: "AC-1", status: "pass" },
      { evidence: "The second candidate resolves the review.", id: "AC-2", status: "pass" },
    ],
    decision: "settled",
    findings: [],
    summary: "The resumed second cycle is settled.",
  }))
  const broker = new Broker({
    appServerFactory: () => appServer,
    egoAdapter: ego.adapter,
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  const completed = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: workflow.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.result.cycleCount, 2)
  assert.equal(appServer.turns, 1)
  assert.equal(ego.exchanges, 1)
  assert.equal(appServer.additionalContexts[0].chatgpt_review.value, JSON.stringify(firstReview))
})

test("running convergence consumes its exact completed ChatGPT child after broker restart", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/c/convergence-restart-chatgpt-running"
  await seedRestartBinding(dataDir, canonicalUrl)
  const contract = createContract(
    "Consume a completed browser review without sending a duplicate after restart.",
    ["Identity is bound.", "The completed browser review settles the candidate."],
  )
  const candidate = convergenceCandidate(1)
  const candidateDigest = digestJson(candidate)
  const workflowId = "ba5a0697-ee25-413f-b8ce-e48d1d37b372"
  const markerToken = digestJson({
    cycle: 1,
    purpose: "review",
    workflowId,
  }).slice(0, 32).toUpperCase()
  const turnMarker = `EGO_CHAT_CONVERGENCE_${markerToken}_C1`
  const terminalMarker = `EGO_CHAT_REVIEW_DONE_${markerToken}`
  const prompt = buildChatGptPrompt({
    candidate,
    candidateDigest,
    contract,
    cycle: 1,
    terminalMarker,
    turnMarker,
  })
  const review = {
    candidateDigest,
    criteria: [
      { evidence: "The target digest is exact.", id: "AC-1", status: "pass" },
      { evidence: "The completed review settles the candidate.", id: "AC-2", status: "pass" },
    ],
    cycle: 1,
    decision: "settled",
    findings: [],
    summary: "The completed child review is settled.",
    targetDigest: contract.targetDigest,
  }
  const responseText = `${JSON.stringify(review)}\n${terminalMarker}`
  let browserSends = 0
  const firstBroker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      exchange: async (input) => {
        browserSends += 1
        return {
          canonicalUrl,
          durationMs: 20,
          head: {
            fingerprint: "completed-child-head",
            fingerprintVersion: "tail-v1",
            lastContentDigest: digest(responseText),
            lastMessageId: "completed-child-assistant",
            lastRole: "assistant",
            messageCount: 4,
          },
          modelPolicy: modelPolicyObservation(),
          responseDigest: digest(responseText),
          responseText,
          targetId: "restart-tab",
          taskSpaceId: 10,
          turnMarker: input.turnMarker,
        }
      },
    },
    store: new EventStore(dataDir),
  })
  await firstBroker.initialize()
  const child = await firstBroker.startEgoExchange({
    allowProtocolRepairCapture: true,
    allowTaskSpaceReclaim: true,
    bindingKey: "ego-chat-main",
    expectedTerminalMarker: terminalMarker,
    prompt,
    timeoutMs: 30_000,
    turnMarker,
  })
  await firstBroker.awaitWorkflow({ timeoutMs: 5_000, workflowId: child.id })
  firstBroker.close()

  const workflow = convergenceRestartWorkflow({
    candidate,
    childWorkflowId: child.id,
    contract,
    id: workflowId,
    phase: "chatgpt_running",
  })
  const store = new EventStore(dataDir)
  await store.initialize()
  await store.persist("workflow.started", workflow)

  const appServer = new FakeConvergenceAppServer()
  const broker = new Broker({
    appServerFactory: () => appServer,
    egoAdapter: unusedEgoAdapter,
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  const completed = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.result.cycleCount, 1)
  assert.equal(appServer.turns, 0)
  assert.equal(browserSends, 1)
})

test("running convergence resumes confirmed ChatGPT capture after broker restart without resending", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/c/convergence-restart-confirmed-review"
  let captureEntered
  const captureStarted = new Promise((resolve) => {
    captureEntered = resolve
  })
  let captures = 0
  let sends = 0
  let sentPrompt
  const firstClient = new FakeConvergenceAppServer()
  const firstBroker = new Broker({
    appServerFactory: () => firstClient,
    egoAdapter: {
      ...unusedEgoAdapter,
      bind: async (input) => ({
        canonicalUrl: input.canonicalUrl,
        head: {
          fingerprint: "confirmed-review-before",
          fingerprintVersion: "tail-v1",
          lastContentDigest: "a".repeat(64),
          lastMessageId: "confirmed-review-assistant-before",
          lastRole: "assistant",
          messageCount: 2,
        },
        targetId: "confirmed-review-tab",
        taskSpaceId: 10,
      }),
      captureExchange: async (_input, signal) => {
        captures += 1
        captureEntered()
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
      },
      sendExchange: async (input) => {
        sends += 1
        sentPrompt = input.prompt
        return {
          canonicalUrl,
          modelPolicy: modelPolicyObservation(),
          promptMessageId: "confirmed-review-user",
          sentAt: new Date().toISOString(),
          targetId: "confirmed-review-tab",
          taskSpaceId: 10,
          turnMarker: input.turnMarker,
        }
      },
    },
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await firstBroker.initialize()
  await firstBroker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl,
    mode: "existing",
    taskSpace: 10,
  })
  const started = await firstBroker.startConvergence({
    acceptanceCriteria: [
      "The exact confirmed send is preserved.",
      "Restart capture never duplicates the review prompt.",
    ],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Resume a confirmed ChatGPT review after broker restart.",
  })
  await captureStarted
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (firstBroker.getWorkflow({ workflowId: started.id }).phase === "chatgpt_running") {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(firstBroker.getWorkflow({ workflowId: started.id }).phase, "chatgpt_running")
  firstBroker.close()
  await new Promise((resolve) => globalThis.setImmediate(resolve))
  await new Promise((resolve) => globalThis.setImmediate(resolve))

  const identity = parseConvergenceIdentity(sentPrompt)
  const secondClient = new FakeConvergenceAppServer()
  const secondBroker = new Broker({
    appServerFactory: () => secondClient,
    egoAdapter: {
      ...unusedEgoAdapter,
      captureExchange: async (input) => {
        captures += 1
        const responseText = `${JSON.stringify({
          ...identity,
          criteria: [
            { evidence: "The confirmed send identity is exact.", id: "AC-1", status: "pass" },
            { evidence: "No duplicate review prompt was sent.", id: "AC-2", status: "pass" },
          ],
          decision: "settled",
          findings: [],
          summary: "The restarted capture is settled without a resend.",
        })}\n${input.expectedTerminalMarker}`
        return {
          canonicalUrl,
          head: {
            fingerprint: "confirmed-review-after",
            fingerprintVersion: "tail-v1",
            lastContentDigest: digest(responseText),
            lastMessageId: "confirmed-review-assistant-after",
            lastRole: "assistant",
            messageCount: 4,
          },
          responseDigest: digest(responseText),
          responseText,
          targetId: "confirmed-review-tab",
          taskSpaceId: 10,
          turnMarker: input.turnMarker,
        }
      },
      sendExchange: async () => {
        sends += 1
        throw new Error("the confirmed review prompt must not be sent again")
      },
    },
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await secondBroker.initialize()
  t.after(() => secondBroker.close())
  const completed = await secondBroker.awaitWorkflow({
    timeoutMs: 5_000,
    workflowId: started.id,
  })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.result.cycleCount, 1)
  assert.equal(firstClient.turns, 1)
  assert.equal(secondClient.turns, 0)
  assert.equal(sends, 1)
  assert.equal(captures, 2)
})
