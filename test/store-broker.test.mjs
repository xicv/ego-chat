import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"

import { Broker } from "../src/broker.mjs"
import {
  ATTACHMENT_CONSUMER_ACKNOWLEDGEMENT_DOES_NOT_GRANT,
  assertValidSignedAttachmentConsumerAcknowledgementEnvelope,
} from "../src/attachment-consumer-ack.mjs"
import {
  buildAmbiguousSendDisposition,
  buildAttachmentCaptureIntent,
  buildAttachmentExecutionDisposition,
  buildConfirmedSendAbsenceDisposition,
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

function fakeReceiptQualification(request, {
  runtimeIdentity = {
    executable_sha256: "1".repeat(64),
    implementation_git_sha: "2".repeat(40),
    package_inventory_sha256: "3".repeat(64),
  },
  signerEnrollmentDigest = "e".repeat(64),
  signerKeyId = `ed25519-spki-sha256:${"f".repeat(64)}`,
} = {}) {
  const authoritySnapshot = {
    consumer_signer_authorization_sha256:
      request.consumer_signer_authorization_sha256,
    qualified_runtime_identity: runtimeIdentity,
    schema: "ego-chat-attachment-receipt-authorization-snapshot/v1",
    signer_enrollment_sha256: signerEnrollmentDigest,
    signer_key_id: signerKeyId,
  }
  return {
    authoritySnapshot,
    authoritySnapshotDigest: sha256Hex(canonicalJsonBytes(authoritySnapshot)),
    consumerSignerAuthorizationDigest:
      request.consumer_signer_authorization_sha256,
    runtimeIdentity,
    signerEnrollmentDigest,
    signerKeyId,
  }
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

function attachmentGraphObservation({
  canonicalConversationLocatorSha256,
  captureOperationKeySha256,
  observedAt,
  sequence,
  sourceConfirmedSendIdentitySha256,
}) {
  return {
    artifacts: [{
      artifact_id: "generation-1",
      artifact_kind: "GENERATED_IMAGE",
      dom_wrapper_id: "image-message-1",
      file_id: "file-1",
      generation_id: "generation-1",
      graph_attachment_id: "image-message-1:part:0",
      image_message_id: "image-message-1",
    }],
    asset_pointer_state: "PRESENT_NON_CONTROL",
    canonical_conversation_locator_sha256: canonicalConversationLocatorSha256,
    capture_operation_key_sha256: captureOperationKeySha256,
    continuation_cursor_present: false,
    direct_branch_ids: ["response-1"],
    direct_response_branch_count: 1,
    generated_image_artifact_count: 1,
    generation_terminal: true,
    graph_complete: true,
    graph_truncated: false,
    hydration_pending: false,
    non_image_artifact_count: 0,
    normal_download_control_count: 0,
    normal_save_control_count: 0,
    observation_sequence: sequence,
    observed_at: observedAt,
    provider_nodes: [{
      message_id: "response-1",
      parent_id: "prompt-confirmed",
      provider_status: "COMPLETE",
      terminal: true,
      turn_exchange_id: "exchange-1",
    }],
    provider_prompt_message_id: "prompt-confirmed",
    react_save_download_prop_count: 0,
    response_message_id: "response-1",
    save_association_candidates: [],
    save_association_id: null,
    schema: "ego-chat-attachment-graph-observation/v1",
    selected_branch_id: "response-1",
    source_confirmed_send_identity_sha256: sourceConfirmedSendIdentitySha256,
    total_artifact_count: 1,
    ui_action_surface_complete: true,
    unclassified_artifact_count: 0,
    visible_attachment_actions: ["EDIT_IMAGE", "SHARE_IMAGE"],
  }
}

function signedAttachmentEnvelope(disposition, fill = 1) {
  const payloadBytes = canonicalJsonBytes(disposition)
  return {
    authority_domain: disposition.authority_domain,
    media_type: disposition.media_type,
    payload_base64url: payloadBytes.toString("base64url"),
    payload_sha256: sha256Hex(payloadBytes),
    schema: "ego-chat-signed-attachment-evidence-envelope/v1",
    signature_base64url: Buffer.alloc(64, fill).toString("base64url"),
    signature_input_domain: disposition.signature_input_domain,
    signer_key_id: disposition.signer_key_id,
  }
}

function attachmentConsumerAcknowledgement(evidence, overrides = {}) {
  const disposition = JSON.parse(
    Buffer.from(evidence.disposition_envelope.payload_base64url, "base64url"),
  )
  return {
    authority_domain: "attachment-evidence-retention-release-only",
    authority_key_id: "a3k-human-approval-root-v1",
    authorized_action: "release-attachment-evidence-reservation",
    confirmed_send_identity_sha256: evidence.confirmed_send_identity
      ? sha256Hex(canonicalJsonBytes(evidence.confirmed_send_identity))
      : null,
    consumer_profile: "a3k-manual-canary-v1",
    consumer_state: disposition.outcome === "EXACTLY_ONE"
      ? "WAITING_HUMAN_SOURCE_APPROVAL"
      : "RECOVERY_REQUIRED",
    consumer_state_record_sha256: "a".repeat(64),
    disposition_envelope_sha256: sha256Hex(
      canonicalJsonBytes(evidence.disposition_envelope),
    ),
    does_not_grant: ATTACHMENT_CONSUMER_ACKNOWLEDGEMENT_DOES_NOT_GRANT,
    external_binding_sha256: evidence.intent.external_binding_sha256,
    idempotency_key_sha256: "b".repeat(64),
    media_type: "application/vnd.a3k.attachment-disposition-consumer-acknowledgement.v1+jcs",
    recovery_policy_sha256: "c".repeat(64),
    schema: "a3k-attachment-disposition-consumer-acknowledgement/v1",
    signature_input_domain: "A3K_ATTACHMENT_DISPOSITION_CONSUMER_ACKNOWLEDGEMENT_V1",
    terminal_evidence_digest: evidence.disposition_envelope.payload_sha256,
    terminal_evidence_kind: "attachment-execution-disposition",
    terminal_outcome: disposition.outcome,
    work_order_id: "CANARY-IMAGE-002",
    ...overrides,
  }
}

function signedAttachmentConsumerAcknowledgement(acknowledgement, fill = 2) {
  const payloadBytes = canonicalJsonBytes(acknowledgement)
  return {
    authority_domain: acknowledgement.authority_domain,
    media_type: acknowledgement.media_type,
    payload_base64url: payloadBytes.toString("base64url"),
    payload_sha256: sha256Hex(payloadBytes),
    schema: "a3k-signed-attachment-disposition-consumer-acknowledgement-envelope/v1",
    signature_base64url: Buffer.alloc(256, fill).toString("base64url"),
    signature_input_domain: acknowledgement.signature_input_domain,
    signer_key_id: acknowledgement.authority_key_id,
  }
}

function browserTaskSpaceIdentity(label = "default") {
  const value = `test-task-space-${label}`
  return { name: value, taskId: value }
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
        taskSpaceIdentity: browserTaskSpaceIdentity("convergence"),
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
        taskSpaceIdentity: browserTaskSpaceIdentity("convergence"),
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
          taskSpaceIdentity: browserTaskSpaceIdentity("convergence"),
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
      qualify: async (request) => fakeReceiptQualification(request),
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

test("receipt exchange signs confirmed absence after a proven pre-click failure and never retries Send", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new EventStore(dataDir)
  await store.initialize()
  await store.persistBinding("binding.created", {
    canonicalUrl: "https://chatgpt.com/c/a3k-presend-absence",
    headContentDigest: "c".repeat(64),
    headFingerprint: "d".repeat(64),
    headFingerprintVersion: "tail-v1",
    headMessageId: "assistant-before",
    headRole: "assistant",
    key: "a3k-presend-absence",
    messageCount: 2,
    revision: 5,
    state: "bound",
    targetId: "tab-presend-absence",
    taskSpaceId: 3,
  })
  let sendCalls = 0
  const broker = new Broker({
    attachmentReceiptAuthority: {
      qualify: async (request) => fakeReceiptQualification(request),
      signAttachmentDisposition: async ({ disposition }) => (
        signedAttachmentEnvelope(disposition)
      ),
    },
    brokerIdentity: {
      brokerId: "receipt-presend-test",
      epoch: 11,
      pid: process.pid,
      runtimeIdentity: null,
      socketPath: null,
    },
    egoAdapter: {
      ...unusedEgoAdapter,
      captureExchange: async () => {
        throw new Error("capture must not run")
      },
      sendExchange: async () => {
        sendCalls += 1
        throw new EgoChatError(
          "human_required",
          "The send control is unavailable.",
          {
            evidence: { draftCleared: true },
            reason: "send_control_unavailable",
          },
        )
      },
    },
    store,
  })
  t.after(() => broker.close())
  const started = await broker.startEgoExchange({
    bindingKey: "a3k-presend-absence",
    expectedTerminalMarker: "DONE_PRESEND_ABSENCE",
    prompt: "EGO_CHAT_A3K_RECEIPT_PRESEND1\nprepare",
    receiptCapture: {
      consumer_signer_authorization_sha256: "b".repeat(64),
      external_binding_sha256: "a".repeat(64),
      profile: "a3k-manual-canary-v1",
      receipt_capture_requested: true,
      schema: "ego-chat-receipt-enabled-exchange-request/v1",
    },
    timeoutMs: 30_000,
    turnMarker: "EGO_CHAT_A3K_RECEIPT_PRESEND1",
  })
  const completed = await broker.awaitWorkflow({
    timeoutMs: 2_000,
    workflowId: started.id,
  })
  const envelope = store.getAttachmentDisposition(started.id)
  const disposition = JSON.parse(
    Buffer.from(envelope.payload_base64url, "base64url").toString("utf8"),
  )
  assert.equal(sendCalls, 1)
  assert.equal(completed.status, "succeeded")
  assert.equal(completed.result.outcome, "CONFIRMED_NOT_SENT")
  assert.equal(disposition.reason, "NO_DISPATCH_ATTEMPT_OCCURRED")
  assert.deepEqual(disposition.dispatch_attempts, [])
  assert.equal(disposition.browser_fencing_generation, 5)
  assert.equal(store.getConfirmedSendIdentity(started.id), undefined)
  assert.equal(
    store.getWorkflow(started.id).private.receiptDispatch.state,
    "PROVEN_NOT_DISPATCHED",
  )
})

test("receipt exchange signs ambiguity after a post-click confirmation failure", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new EventStore(dataDir)
  await store.initialize()
  await store.persistBinding("binding.created", {
    canonicalUrl: "https://chatgpt.com/c/a3k-send-ambiguous",
    headContentDigest: "c".repeat(64),
    headFingerprint: "d".repeat(64),
    headFingerprintVersion: "tail-v1",
    headMessageId: "assistant-before",
    headRole: "assistant",
    key: "a3k-send-ambiguous",
    messageCount: 2,
    revision: 6,
    state: "bound",
    targetId: "tab-send-ambiguous",
    taskSpaceId: 3,
  })
  let sendCalls = 0
  const broker = new Broker({
    attachmentReceiptAuthority: {
      qualify: async (request) => fakeReceiptQualification(request),
      signAttachmentDisposition: async ({ disposition }) => (
        signedAttachmentEnvelope(disposition)
      ),
    },
    brokerIdentity: {
      brokerId: "receipt-ambiguous-test",
      epoch: 12,
      pid: process.pid,
      runtimeIdentity: null,
      socketPath: null,
    },
    egoAdapter: {
      ...unusedEgoAdapter,
      captureExchange: async () => {
        throw new Error("capture must not run")
      },
      sendExchange: async () => {
        sendCalls += 1
        throw new EgoChatError(
          "human_required",
          "The click was not confirmed.",
          { reason: "send_confirmation_ambiguous" },
        )
      },
    },
    store,
  })
  t.after(() => broker.close())
  const started = await broker.startEgoExchange({
    bindingKey: "a3k-send-ambiguous",
    expectedTerminalMarker: "DONE_SEND_AMBIGUOUS",
    prompt: "EGO_CHAT_A3K_RECEIPT_AMBIGUOUS1\nprepare",
    receiptCapture: {
      consumer_signer_authorization_sha256: "b".repeat(64),
      external_binding_sha256: "a".repeat(64),
      profile: "a3k-manual-canary-v1",
      receipt_capture_requested: true,
      schema: "ego-chat-receipt-enabled-exchange-request/v1",
    },
    timeoutMs: 30_000,
    turnMarker: "EGO_CHAT_A3K_RECEIPT_AMBIGUOUS1",
  })
  const completed = await broker.awaitWorkflow({
    timeoutMs: 2_000,
    workflowId: started.id,
  })
  const envelope = store.getAttachmentDisposition(started.id)
  const disposition = JSON.parse(
    Buffer.from(envelope.payload_base64url, "base64url").toString("utf8"),
  )
  assert.equal(sendCalls, 1)
  assert.equal(completed.status, "succeeded")
  assert.equal(completed.result.outcome, "SEND_OUTCOME_UNKNOWN")
  assert.equal(disposition.broker_epoch, 12)
  assert.equal(disposition.browser_fencing_generation, 6)
  assert.equal(
    disposition.pre_dispatch_turn_marker,
    "EGO_CHAT_A3K_RECEIPT_AMBIGUOUS1",
  )
  assert.equal(
    store.getWorkflow(started.id).private.receiptDispatch.state,
    "AMBIGUOUS",
  )
})

test("receipt restart reconciles an armed dispatch without a second Send", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/c/a3k-armed-restart"
  const firstStore = new EventStore(dataDir)
  await firstStore.initialize()
  await firstStore.persistBinding("binding.created", {
    canonicalUrl,
    headContentDigest: "c".repeat(64),
    headFingerprint: "d".repeat(64),
    headFingerprintVersion: "tail-v1",
    headMessageId: "assistant-before",
    headRole: "assistant",
    key: "a3k-armed-restart",
    messageCount: 2,
    revision: 7,
    state: "bound",
    targetId: "tab-armed-restart",
    taskSpaceIdentity: browserTaskSpaceIdentity("3"),
    taskSpaceId: 3,
  })
  let firstSendCalls = 0
  const never = new Promise(() => {})
  const authority = {
    qualify: async (request) => fakeReceiptQualification(request),
    signAttachmentDisposition: async ({ disposition }) => (
      signedAttachmentEnvelope(disposition)
    ),
  }
  const firstBroker = new Broker({
    attachmentReceiptAuthority: authority,
    brokerIdentity: {
      brokerId: "receipt-restart-source",
      epoch: 13,
      pid: process.pid,
      runtimeIdentity: null,
      socketPath: null,
    },
    egoAdapter: {
      ...unusedEgoAdapter,
      captureExchange: async () => never,
      sendExchange: async () => {
        firstSendCalls += 1
        return never
      },
    },
    store: firstStore,
  })
  const started = await firstBroker.startEgoExchange({
    bindingKey: "a3k-armed-restart",
    expectedTerminalMarker: "DONE_ARMED_RESTART",
    prompt: "EGO_CHAT_A3K_RECEIPT_ARMED1\nprepare",
    receiptCapture: {
      consumer_signer_authorization_sha256: "b".repeat(64),
      external_binding_sha256: "a".repeat(64),
      profile: "a3k-manual-canary-v1",
      receipt_capture_requested: true,
      schema: "ego-chat-receipt-enabled-exchange-request/v1",
    },
    timeoutMs: 30_000,
    turnMarker: "EGO_CHAT_A3K_RECEIPT_ARMED1",
  })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (firstStore.getWorkflow(started.id)?.phase === "receipt_dispatch_armed") break
    await new Promise((resolve) => globalThis.setTimeout(resolve, 5))
  }
  assert.equal(firstStore.getWorkflow(started.id).phase, "receipt_dispatch_armed")
  assert.equal(firstSendCalls, 1)
  firstBroker.close()

  let restartedSendCalls = 0
  const restartedStore = new EventStore(dataDir)
  const restartedBroker = new Broker({
    attachmentReceiptAuthority: authority,
    brokerIdentity: {
      brokerId: "receipt-restart-destination",
      epoch: 14,
      pid: process.pid,
      runtimeIdentity: null,
      socketPath: null,
    },
    egoAdapter: {
      ...unusedEgoAdapter,
      captureExchange: async () => {
        throw new Error("capture must not run")
      },
      reconcileBound: async (input) => ({
        canonicalUrl,
        deliveryState: "absent",
        head: {
          fingerprint: input.binding.headFingerprint,
          fingerprintVersion: input.binding.headFingerprintVersion,
          lastContentDigest: input.binding.headContentDigest,
          lastMessageId: input.binding.headMessageId,
          lastRole: input.binding.headRole,
          messageCount: input.binding.messageCount,
        },
        targetId: "tab-armed-restart",
        taskSpaceIdentity: browserTaskSpaceIdentity("3"),
        taskSpaceId: 3,
      }),
      sendExchange: async () => {
        restartedSendCalls += 1
        throw new Error("an armed receipt must never be resent")
      },
    },
    store: restartedStore,
  })
  t.after(() => restartedBroker.close())
  await restartedBroker.initialize()
  const completed = await restartedBroker.awaitWorkflow({
    timeoutMs: 2_000,
    workflowId: started.id,
  })
  const envelope = restartedStore.getAttachmentDisposition(started.id)
  const disposition = JSON.parse(
    Buffer.from(envelope.payload_base64url, "base64url").toString("utf8"),
  )
  assert.equal(restartedSendCalls, 0)
  assert.equal(completed.status, "succeeded")
  assert.equal(completed.result.outcome, "CONFIRMED_NOT_SENT")
  assert.equal(disposition.reason, "ALL_DISPATCH_ATTEMPTS_PROVEN_ABSENT")
  assert.equal(disposition.dispatch_attempts.length, 1)
  assert.equal(disposition.dispatch_attempts[0].browser_fencing_generation, 7)
  assert.equal(
    restartedStore.getWorkflow(started.id).private.receiptDispatch.state,
    "PROVEN_ABSENT",
  )
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
    taskSpaceIdentity: browserTaskSpaceIdentity("4"),
    taskSpaceId: 4,
  })
  const sentAt = "2026-09-04T04:30:00.000Z"
  let legacyCaptureCalls = 0
  const broker = new Broker({
    attachmentReceiptAuthority: {
      qualify: async (request) => fakeReceiptQualification(request),
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
          taskSpaceIdentity: browserTaskSpaceIdentity("4"),
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
        taskSpaceIdentity: browserTaskSpaceIdentity("4"),
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

test("attachment observations and terminal disposition remain create-once across restart", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new EventStore(dataDir)
  await store.initialize()
  await store.persistBinding("binding.created", {
    canonicalUrl: "https://chatgpt.com/c/a3k-durable-capture",
    headContentDigest: "1".repeat(64),
    headFingerprint: "2".repeat(64),
    headFingerprintVersion: "tail-v1",
    headMessageId: "assistant-before",
    headRole: "assistant",
    key: "a3k-durable-capture",
    messageCount: 2,
    revision: 1,
    state: "bound",
    targetId: "tab-durable-capture",
    taskSpaceIdentity: browserTaskSpaceIdentity("5"),
    taskSpaceId: 5,
  })
  const broker = new Broker({
    attachmentReceiptAuthority: {
      qualify: async (request) => fakeReceiptQualification(request, {
        runtimeIdentity: {
          executable_sha256: "3".repeat(64),
          implementation_git_sha: "4".repeat(40),
          package_inventory_sha256: "5".repeat(64),
        },
        signerEnrollmentDigest: "6".repeat(64),
        signerKeyId: `ed25519-spki-sha256:${"7".repeat(64)}`,
      }),
    },
    egoAdapter: {
      ...unusedEgoAdapter,
      captureAttachmentExecution: async () => new Promise(() => {}),
      captureExchange: async () => new Promise(() => {}),
      sendExchange: async (input) => ({
        canonicalUrl: "https://chatgpt.com/c/a3k-durable-capture",
        modelPolicy: modelPolicyObservation(),
        promptMessageId: "prompt-confirmed",
        sentAt: "2026-09-04T05:29:59.000Z",
        targetId: "tab-durable-capture",
        taskSpaceIdentity: browserTaskSpaceIdentity("5"),
        taskSpaceId: 5,
        turnMarker: input.turnMarker,
      }),
    },
    store,
  })
  const started = await broker.startEgoExchange({
    bindingKey: "a3k-durable-capture",
    expectedTerminalMarker: "DONE_DURABLE_CAPTURE",
    prompt: "EGO_CHAT_A3K_RECEIPT_DURABLE1\nprepare",
    receiptCapture: {
      consumer_signer_authorization_sha256: "8".repeat(64),
      external_binding_sha256: "9".repeat(64),
      profile: "a3k-manual-canary-v1",
      receipt_capture_requested: true,
      schema: "ego-chat-receipt-enabled-exchange-request/v1",
    },
    timeoutMs: 30_000,
    turnMarker: "EGO_CHAT_A3K_RECEIPT_DURABLE1",
  })
  let workflow
  for (let attempt = 0; attempt < 50; attempt += 1) {
    workflow = store.getWorkflow(started.id)
    if (workflow?.phase === "awaiting_attachment_capture") break
    await new Promise((resolve) => globalThis.setTimeout(resolve, 5))
  }
  assert.equal(workflow?.phase, "awaiting_attachment_capture")
  assert.equal(workflow?.status, "running")
  await broker.startAttachmentCapture({
    schema: "ego-chat-attachment-capture-request/v1",
    source_workflow_id: started.id,
  })
  broker.close()

  const firstCapture = store.getAttachmentCapture(started.id)
  const identity = store.getConfirmedSendIdentity(started.id)
  const identityDigest = sha256Hex(canonicalJsonBytes(identity))
  const startedAtMs = Date.parse(firstCapture.capture_started_at)
  const firstObservation = attachmentGraphObservation({
    canonicalConversationLocatorSha256: identity.canonical_conversation_url_sha256,
    captureOperationKeySha256: firstCapture.capture_operation_key_sha256,
    observedAt: new Date(startedAtMs + 1_000).toISOString(),
    sequence: 1,
    sourceConfirmedSendIdentitySha256: identityDigest,
  })
  const afterFirst = await store.recordAttachmentCaptureAttempt({
    capture: firstCapture,
    elapsedMonotonicMs: 25,
    observation: firstObservation,
  })
  assert.equal(afterFirst.attempt_journal.length, 1)
  assert.equal(afterFirst.candidate_observations.length, 1)
  assert.equal(afterFirst.accumulated_monotonic_ms, 25)

  const restarted = new EventStore(dataDir)
  await restarted.initialize()
  assert.deepEqual(restarted.getAttachmentCapture(started.id), afterFirst)
  const secondObservation = attachmentGraphObservation({
    canonicalConversationLocatorSha256: identity.canonical_conversation_url_sha256,
    captureOperationKeySha256: firstCapture.capture_operation_key_sha256,
    observedAt: new Date(startedAtMs + 2_000).toISOString(),
    sequence: 2,
    sourceConfirmedSendIdentitySha256: identityDigest,
  })
  const afterSecond = await restarted.recordAttachmentCaptureAttempt({
    capture: afterFirst,
    elapsedMonotonicMs: 30,
    observation: secondObservation,
  })
  assert.equal(afterSecond.attempt_journal.length, 2)
  assert.equal(afterSecond.candidate_observations.length, 2)
  assert.equal(afterSecond.accumulated_monotonic_ms, 55)

  const disposition = buildAttachmentExecutionDisposition({
    captureOperation: afterSecond,
    confirmedSendIdentity: identity,
    confirmedSendIdentityDigest: identityDigest,
    observations: afterSecond.candidate_observations,
    terminalAt: new Date(startedAtMs + 3_000).toISOString(),
  })
  const envelope = signedAttachmentEnvelope(disposition)
  const terminal = await restarted.persistAttachmentDisposition({
    capture: afterSecond,
    envelope,
  })
  assert.equal(terminal.created, true)
  assert.equal(terminal.disposition.outcome, "UNKNOWN")
  assert.equal(terminal.disposition.reason, "UNSUPPORTED_SAVE_ASSOCIATION")
  assert.equal(terminal.workflow.phase, "attachment_disposition_terminal")
  assert.equal(terminal.workflow.status, "succeeded")
  assert.deepEqual(restarted.getAttachmentDisposition(started.id), envelope)

  const replay = await restarted.persistAttachmentDisposition({
    capture: afterSecond,
    envelope,
  })
  assert.equal(replay.created, false)
  assert.deepEqual(replay.envelope, envelope)
  await assert.rejects(
    restarted.persistAttachmentDisposition({
      capture: afterSecond,
      envelope: signedAttachmentEnvelope(disposition, 2),
    }),
    (error) => error.code === "attachment_disposition_conflict",
  )
  assert.deepEqual(restarted.getAttachmentDisposition(started.id), envelope)

  const terminalRestart = new EventStore(dataDir)
  await terminalRestart.initialize()
  assert.deepEqual(terminalRestart.getAttachmentDisposition(started.id), envelope)
  assert.equal(terminalRestart.getAttachmentCapture(started.id).state, "TERMINAL")
  assert.equal(terminalRestart.getMetrics().attachmentReservedBytes, 1024 * 1024)
})

test("terminal attachment evidence is retrieved as one exact immutable chain", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
  const store = new EventStore(dataDir)
  await store.initialize()
  await store.persistBinding("binding.created", {
    canonicalUrl: "https://chatgpt.com/c/evidence-chain",
    headContentDigest: "c".repeat(64),
    headFingerprint: "d".repeat(64),
    headFingerprintVersion: "tail-v1",
    headMessageId: "assistant-before",
    headRole: "assistant",
    key: "a3k-evidence",
    messageCount: 2,
    revision: 1,
    state: "bound",
    targetId: "tab-evidence",
    taskSpaceIdentity: browserTaskSpaceIdentity("1"),
    taskSpaceId: 1,
  })
  const broker = new Broker({
    attachmentReceiptAuthority: {
      qualify: async (request) => fakeReceiptQualification(request),
      verifyConsumerAcknowledgement: async (envelope) => (
        assertValidSignedAttachmentConsumerAcknowledgementEnvelope(envelope)
          .acknowledgement
      ),
    },
    egoAdapter: {
      ...unusedEgoAdapter,
      captureAttachmentExecution: async () => new Promise(() => {}),
      captureExchange: async () => new Promise(() => {}),
      sendExchange: async (input) => ({
        canonicalUrl: "https://chatgpt.com/c/evidence-chain",
        modelPolicy: modelPolicyObservation(),
        promptMessageId: "prompt-confirmed",
        sentAt: "2026-09-04T05:00:00.000Z",
        targetId: "tab-evidence",
        taskSpaceIdentity: browserTaskSpaceIdentity("1"),
        taskSpaceId: 1,
        turnMarker: input.turnMarker,
      }),
    },
    store,
  })
  t.after(() => broker.close())
  const prompt = "EGO_CHAT_A3K_EVIDENCE_12345678\nprepare"
  const started = await broker.startEgoExchange({
    bindingKey: "a3k-evidence",
    expectedTerminalMarker: "EGO_CHAT_A3K_EVIDENCE_RESULT",
    prompt,
    receiptCapture: {
      consumer_signer_authorization_sha256: "8".repeat(64),
      external_binding_sha256: "9".repeat(64),
      profile: "a3k-manual-canary-v1",
      receipt_capture_requested: true,
      schema: "ego-chat-receipt-enabled-exchange-request/v1",
    },
    timeoutMs: 30_000,
    turnMarker: "EGO_CHAT_A3K_EVIDENCE_12345678",
  })
  for (let index = 0; index < 100; index += 1) {
    if (store.getWorkflow(started.id)?.phase === "awaiting_attachment_capture") break
    await new Promise((resolve) => globalThis.setTimeout(resolve, 5))
  }
  await broker.startAttachmentCapture({
    schema: "ego-chat-attachment-capture-request/v1",
    source_workflow_id: started.id,
  })
  broker.close()
  const firstCapture = store.getAttachmentCapture(started.id)
  const identity = store.getConfirmedSendIdentity(started.id)
  const identityDigest = sha256Hex(canonicalJsonBytes(identity))
  const startedAtMs = Date.parse(firstCapture.capture_started_at)
  let capture = await store.recordAttachmentCaptureAttempt({
    capture: firstCapture,
    elapsedMonotonicMs: 25,
    observation: attachmentGraphObservation({
      canonicalConversationLocatorSha256: identity.canonical_conversation_url_sha256,
      captureOperationKeySha256: firstCapture.capture_operation_key_sha256,
      observedAt: new Date(startedAtMs + 1_000).toISOString(),
      sequence: 1,
      sourceConfirmedSendIdentitySha256: identityDigest,
    }),
  })
  capture = await store.recordAttachmentCaptureAttempt({
    capture,
    elapsedMonotonicMs: 25,
    observation: attachmentGraphObservation({
      canonicalConversationLocatorSha256: identity.canonical_conversation_url_sha256,
      captureOperationKeySha256: firstCapture.capture_operation_key_sha256,
      observedAt: new Date(startedAtMs + 2_000).toISOString(),
      sequence: 2,
      sourceConfirmedSendIdentitySha256: identityDigest,
    }),
  })
  const disposition = buildAttachmentExecutionDisposition({
    captureOperation: capture,
    confirmedSendIdentity: identity,
    confirmedSendIdentityDigest: identityDigest,
    observations: capture.candidate_observations,
    terminalAt: new Date(startedAtMs + 3_000).toISOString(),
  })
  await store.persistAttachmentDisposition({
    capture,
    envelope: signedAttachmentEnvelope(disposition),
  })

  const evidence = broker.getAttachmentEvidence({
    schema: "ego-chat-attachment-evidence-request/v1",
    source_workflow_id: started.id,
  })
  assert.equal(evidence.schema, "ego-chat-attachment-evidence-bundle/v1")
  assert.equal(evidence.exact_prompt_utf8_base64url, Buffer.from(prompt).toString("base64url"))
  assert.equal(evidence.intent.source_workflow_id, started.id)
  assert.equal(evidence.confirmed_send_event.workflow_id, started.id)
  assert.equal(evidence.confirmed_send_identity.source_workflow_id, started.id)
  assert.equal(evidence.capture.state, "TERMINAL")
  assert.equal(evidence.disposition_envelope.payload_sha256, evidence.capture.terminal_disposition_sha256)
  assert.equal(evidence.external_binding.external_binding_sha256, "9".repeat(64))
  const wrongLineageEnvelope = signedAttachmentConsumerAcknowledgement(
    attachmentConsumerAcknowledgement(evidence, {
      external_binding_sha256: "e".repeat(64),
    }),
  )
  await assert.rejects(
    broker.releaseAttachmentEvidence({
      acknowledgement_envelope: wrongLineageEnvelope,
      schema: "ego-chat-attachment-evidence-release-request/v1",
      source_workflow_id: started.id,
    }),
    (error) => error.code === "attachment_consumer_acknowledgement_lineage_mismatch",
  )
  assert.equal(store.getMetrics().attachmentReservedBytes, 1024 * 1024)
  const acknowledgement = attachmentConsumerAcknowledgement(evidence)
  const acknowledgementEnvelope = signedAttachmentConsumerAcknowledgement(acknowledgement)
  const released = await broker.releaseAttachmentEvidence({
    acknowledgement_envelope: acknowledgementEnvelope,
    schema: "ego-chat-attachment-evidence-release-request/v1",
    source_workflow_id: started.id,
  })
  assert.equal(released.created, true)
  assert.equal(released.consumer_state, "RECOVERY_REQUIRED")
  assert.equal(store.getMetrics().attachmentIntentCount, 0)
  assert.equal(store.getMetrics().attachmentReservedBytes, 0)
  assert.equal(
    store.getAttachmentExternalBinding("a3k-manual-canary-v1", "9".repeat(64)).state,
    "CONSUMED_RELEASED",
  )
  const retrievedAfterRelease = broker.getAttachmentEvidence({
    schema: "ego-chat-attachment-evidence-request/v1",
    source_workflow_id: started.id,
  })
  assert.deepEqual(
    retrievedAfterRelease.consumer_acknowledgement_envelope,
    acknowledgementEnvelope,
  )
  assert.equal(retrievedAfterRelease.evidence_tombstone.consumer_state, "RECOVERY_REQUIRED")
  const replayed = await broker.releaseAttachmentEvidence({
    acknowledgement_envelope: acknowledgementEnvelope,
    schema: "ego-chat-attachment-evidence-release-request/v1",
    source_workflow_id: started.id,
  })
  assert.equal(replayed.created, false)
  const conflictingEnvelope = signedAttachmentConsumerAcknowledgement(
    attachmentConsumerAcknowledgement(evidence, {
      consumer_state_record_sha256: "d".repeat(64),
    }),
    3,
  )
  await assert.rejects(
    broker.releaseAttachmentEvidence({
      acknowledgement_envelope: conflictingEnvelope,
      schema: "ego-chat-attachment-evidence-release-request/v1",
      source_workflow_id: started.id,
    }),
    (error) => error.code === "attachment_consumer_acknowledgement_conflict",
  )
  const restarted = new EventStore(dataDir)
  await restarted.initialize()
  assert.equal(restarted.getMetrics().attachmentReservedBytes, 0)
  assert.deepEqual(
    restarted.getAttachmentConsumerAcknowledgement(started.id),
    acknowledgementEnvelope,
  )
  assert.throws(
    () => broker.getAttachmentEvidence({
      schema: "ego-chat-attachment-evidence-request/v1",
      source_workflow_id: "4559c675-14a9-4ec0-b5f9-0bb3ec3b73b5",
    }),
    (error) => error.code === "workflow_not_found",
  )

  const prepatchStatePath = path.join(dataDir, "state.json")
  const prepatchState = JSON.parse(await fs.readFile(prepatchStatePath, "utf8"))
  prepatchState.schemaVersion = 7
  delete prepatchState.attachmentIntents[started.id].send_resolution_deadline_at
  for (const observation of prepatchState.attachmentCaptures[started.id]
    .candidate_observations) {
    delete observation.save_association_candidates
  }
  const legacyBindingKey = `a3k-manual-canary-v1:${"9".repeat(64)}`
  prepatchState.attachmentExternalBindings[legacyBindingKey].intent_sha256 = sha256Hex(
    canonicalJsonBytes(prepatchState.attachmentIntents[started.id]),
  )
  const prepatchRecords = {
    attachment_consumer_acknowledgement:
      prepatchState.attachmentConsumerAcknowledgements[started.id],
    attachment_capture: prepatchState.attachmentCaptures[started.id],
    attachment_disposition: prepatchState.attachmentDispositions[started.id],
    attachment_evidence_tombstone:
      prepatchState.attachmentEvidenceTombstones[started.id],
    attachment_intent: prepatchState.attachmentIntents[started.id],
    confirmed_send_event: prepatchState.confirmedSendEvents[started.id],
    confirmed_send_identity: prepatchState.confirmedSendIdentities[started.id],
    external_binding: prepatchState.attachmentExternalBindings[legacyBindingKey],
  }
  await fs.writeFile(
    prepatchStatePath,
    `${JSON.stringify(prepatchState, null, 2)}\n`,
    { mode: 0o600 },
  )
  await fs.rm(path.join(dataDir, "checkpoint.json"), { force: true })
  await fs.rm(path.join(dataDir, "checkpoint.manifest.json"), { force: true })

  const legacyReplay = new EventStore(dataDir)
  await legacyReplay.initialize()
  const quarantine = legacyReplay.getLegacyAttachmentEvidence(started.id)
  assert.equal(quarantine.reason, "LEGACY_CONTRACT_RECOVERY_ONLY")
  assert.deepEqual(quarantine.source_records, prepatchRecords)
  assert.equal(
    quarantine.source_records_sha256,
    sha256Hex(canonicalJsonBytes(prepatchRecords)),
  )
  assert.equal(
    legacyReplay.getWorkflow(started.id).phase,
    "attachment_legacy_recovery_required",
  )
  assert.equal(legacyReplay.getAttachmentIntent(started.id), undefined)
  assert.equal(
    legacyReplay.getAttachmentExternalBinding(
      "a3k-manual-canary-v1",
      "9".repeat(64),
    ).state,
    "CONSUMED_LEGACY_RECOVERY_REQUIRED",
  )

  const freshCanonicalUrl = "https://chatgpt.com/c/evidence-chain-fresh"
  const freshBroker = new Broker({
    attachmentReceiptAuthority: {
      qualify: async (request) => fakeReceiptQualification(request),
    },
    egoAdapter: {
      ...unusedEgoAdapter,
      bind: async () => ({
        canonicalUrl: freshCanonicalUrl,
        head: {
          fingerprint: "fresh-contract-before",
          fingerprintVersion: "tail-v1",
          lastContentDigest: "e".repeat(64),
          lastMessageId: "fresh-contract-assistant-before",
          lastRole: "assistant",
          messageCount: 2,
        },
        targetId: "tab-evidence-fresh",
        taskSpaceIdentity: browserTaskSpaceIdentity("2"),
        taskSpaceId: 2,
      }),
      captureAttachmentExecution: async () => new Promise(() => {}),
      captureExchange: async () => new Promise(() => {}),
      sendExchange: async (input) => ({
        canonicalUrl: freshCanonicalUrl,
        modelPolicy: modelPolicyObservation(),
        promptMessageId: "prompt-fresh-contract",
        sentAt: "2026-09-04T06:00:00.000Z",
        targetId: "tab-evidence-fresh",
        taskSpaceIdentity: browserTaskSpaceIdentity("2"),
        taskSpaceId: 2,
        turnMarker: input.turnMarker,
      }),
    },
    store: legacyReplay,
  })
  t.after(() => freshBroker.close())
  await freshBroker.initialize()
  await freshBroker.bindConversation({
    bindingKey: "a3k-evidence-fresh",
    canonicalUrl: freshCanonicalUrl,
    mode: "existing",
    taskSpace: 2,
  })
  const fresh = await freshBroker.startEgoExchange({
    bindingKey: "a3k-evidence-fresh",
    expectedTerminalMarker: "EGO_CHAT_A3K_FRESH_RESULT",
    prompt: "EGO_CHAT_A3K_FRESH_12345678\nprepare",
    receiptCapture: {
      consumer_signer_authorization_sha256: "8".repeat(64),
      external_binding_sha256: "a".repeat(64),
      profile: "a3k-manual-canary-v1",
      receipt_capture_requested: true,
      schema: "ego-chat-receipt-enabled-exchange-request/v1",
    },
    timeoutMs: 30_000,
    turnMarker: "EGO_CHAT_A3K_FRESH_12345678",
  })
  const freshIntent = legacyReplay.getAttachmentIntent(fresh.id)
  assert.equal(freshIntent.schema, "ego-chat-attachment-capture-intent/v1")
  assert.equal(
    Date.parse(freshIntent.send_resolution_deadline_at)
      - Date.parse(freshIntent.created_at),
    10 * 60 * 1_000,
  )
  for (let index = 0; index < 100; index += 1) {
    if (legacyReplay.getWorkflow(fresh.id)?.phase === "awaiting_attachment_capture") {
      break
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 5))
  }
  assert.equal(
    legacyReplay.getWorkflow(fresh.id)?.phase,
    "awaiting_attachment_capture",
  )
})

for (const terminalKind of ["ambiguous-send", "confirmed-send-absence"]) {
  test(`${terminalKind} evidence is durable, retrievable, and releasable without Send identity`, async (t) => {
    const dataDir = await createDataDir()
    t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
    const store = new EventStore(dataDir)
    await store.initialize()
    const workflowId = terminalKind === "ambiguous-send"
      ? "7b954066-b508-4ba4-9fb9-baaaf7cfe2db"
      : "4b772c95-83ba-46ae-9052-bc6e99740732"
    const operationKey = `exchange:a3k-terminal:EGO_CHAT_A3K_${terminalKind.toUpperCase()}_12345678`
    const externalBindingDigest = terminalKind === "ambiguous-send"
      ? "8".repeat(64)
      : "9".repeat(64)
    const qualification = fakeReceiptQualification({
      consumer_signer_authorization_sha256: "7".repeat(64),
    })
    const workflow = {
      bindingKey: "a3k-terminal",
      createdAt: "2026-09-04T05:00:00.000Z",
      id: workflowId,
      inputDigest: "6".repeat(64),
      kind: "ego_exchange",
      operationKey,
      phase: "browser_owned",
      private: {
        receiptAuthoritySnapshot: qualification.authoritySnapshot,
        receiptAuthoritySnapshotSha256: qualification.authoritySnapshotDigest,
        receiptDispatch: {
          armed_at: "2026-09-04T05:00:00.500Z",
          attempt_number: 1,
          broker_epoch: 3,
          browser_fencing_generation: 4,
          observations: [{
            at: terminalKind === "ambiguous-send"
              ? "2026-09-04T05:00:02.000Z"
              : "2026-09-04T05:00:01.000Z",
            outcome: terminalKind === "ambiguous-send"
              ? "AMBIGUOUS"
              : "NOT_DISPATCHED",
          }],
          schema: "ego-chat-receipt-dispatch-state/v1",
          state: terminalKind === "ambiguous-send"
            ? "AMBIGUOUS"
            : "PROVEN_NOT_DISPATCHED",
        },
        request: {
          prompt: "fixed receipt prompt",
          receiptCapture: {
            consumer_signer_authorization_sha256: "7".repeat(64),
            external_binding_sha256: externalBindingDigest,
            profile: "a3k-manual-canary-v1",
            receipt_capture_requested: true,
            schema: "ego-chat-receipt-enabled-exchange-request/v1",
          },
        },
      },
      reconciliation: {
        turnMarker: `EGO_CHAT_A3K_${terminalKind.toUpperCase()}_12345678`,
      },
      status: "running",
      updatedAt: "2026-09-04T05:00:00.000Z",
    }
    const built = buildAttachmentCaptureIntent({
      authorizationDigest: "7".repeat(64),
      createdAt: workflow.createdAt,
      externalBindingDigest,
      operationKey,
      profile: "a3k-manual-canary-v1",
      runtimeIdentity: qualification.runtimeIdentity,
      signerEnrollmentDigest: qualification.signerEnrollmentDigest,
      signerKeyId: qualification.signerKeyId,
      workflowId,
    })
    await store.persistStarted("workflow.started", workflow, {
      authoritySnapshot: qualification.authoritySnapshot,
      authoritySnapshotDigest: qualification.authoritySnapshotDigest,
      intent: built.intent,
      intentDigest: built.digest,
    })
    const disposition = terminalKind === "ambiguous-send"
      ? buildAmbiguousSendDisposition({
          brokerEpoch: 3,
          browserFencingGeneration: 4,
          firstObservationAt: "2026-09-04T05:00:00.500Z",
          intent: built.intent,
          lastObservationAt: "2026-09-04T05:00:02.000Z",
          preDispatchTurnMarker: workflow.reconciliation.turnMarker,
          terminalAt: "2026-09-04T05:10:00.000Z",
        })
      : buildConfirmedSendAbsenceDisposition({
          browserFencingGeneration: 4,
          dispatchAttempts: [],
          intent: built.intent,
          observedAt: "2026-09-04T05:00:01.000Z",
          terminalAt: "2026-09-04T05:00:02.000Z",
        })
    const dispositionEnvelope = signedAttachmentEnvelope(disposition)
    const persisted = await store.persistTerminalEvidenceDisposition({
      envelope: dispositionEnvelope,
      workflowId,
    })
    assert.equal(persisted.created, true)
    assert.equal(store.getConfirmedSendIdentity(workflowId), undefined)
    assert.equal(store.getAttachmentCapture(workflowId), undefined)
    assert.equal(
      store.getAttachmentExternalBinding(
        "a3k-manual-canary-v1",
        externalBindingDigest,
      ).state,
      terminalKind === "ambiguous-send"
        ? "CONSUMED_AMBIGUOUS_PENDING_ACK"
        : "CONSUMED_NOT_SENT_PENDING_ACK",
    )
    const broker = new Broker({
      attachmentReceiptAuthority: {
        verifyConsumerAcknowledgement: async (envelope) => (
          assertValidSignedAttachmentConsumerAcknowledgementEnvelope(envelope)
            .acknowledgement
        ),
      },
      egoAdapter: unusedEgoAdapter,
      store,
    })
    t.after(() => broker.close())
    const evidence = broker.getAttachmentEvidence({
      schema: "ego-chat-attachment-evidence-request/v1",
      source_workflow_id: workflowId,
    })
    assert.equal(
      evidence.schema,
      terminalKind === "ambiguous-send"
        ? "ego-chat-ambiguous-send-evidence-bundle/v1"
        : "ego-chat-confirmed-send-absence-evidence-bundle/v1",
    )
    assert.equal(evidence.confirmed_send_identity, undefined)
    assert.equal(evidence.capture, undefined)
    const acknowledgement = attachmentConsumerAcknowledgement(evidence, {
      terminal_evidence_kind: terminalKind === "ambiguous-send"
        ? "ambiguous-send-disposition"
        : "confirmed-send-absence",
    })
    const acknowledgementEnvelope = signedAttachmentConsumerAcknowledgement(acknowledgement)
    const released = await broker.releaseAttachmentEvidence({
      acknowledgement_envelope: acknowledgementEnvelope,
      schema: "ego-chat-attachment-evidence-release-request/v1",
      source_workflow_id: workflowId,
    })
    assert.equal(released.created, true)
    assert.equal(store.getMetrics().attachmentReservedBytes, 0)
    const restarted = new EventStore(dataDir)
    await restarted.initialize()
    assert.deepEqual(
      restarted.getAttachmentConsumerAcknowledgement(workflowId),
      acknowledgementEnvelope,
    )
    assert.equal(
      restarted.getAttachmentExternalBinding(
        "a3k-manual-canary-v1",
        externalBindingDigest,
      ).state,
      "CONSUMED_RELEASED",
    )
    const replayed = await store.persistTerminalEvidenceDisposition({
      envelope: dispositionEnvelope,
      workflowId,
    })
    assert.equal(replayed.created, false)
    await assert.rejects(
      store.persistTerminalEvidenceDisposition({
        envelope: signedAttachmentEnvelope({
          ...disposition,
          terminal_at: "2026-09-04T05:00:03.000Z",
        }, 9),
        workflowId,
      }),
      (error) => error.code === "attachment_disposition_conflict",
    )
  })
}

test("legacy attachment quarantine is stable across a stale checkpoint and ledger tail", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const workflowId = "a9f6b990-7475-43f1-b0dd-c04325b90010"
  const externalBindingDigest = "9".repeat(64)
  const profile = "a3k-manual-canary-v1"
  const ledgerKey = `${profile}:${externalBindingDigest}`
  const operationKey = "exchange:a3k-legacy:EGO_CHAT_A3K_LEGACY_TAIL_12345678"
  const intent = {
    consumer_signer_authorization_sha256: "8".repeat(64),
    created_at: "2026-09-03T01:00:00.000Z",
    external_binding_sha256: externalBindingDigest,
    profile,
    schema: "ego-chat-attachment-capture-intent/v1",
    source_workflow_id: workflowId,
    state: "RESERVED",
  }
  const externalBinding = {
    external_binding_sha256: externalBindingDigest,
    intent_sha256: sha256Hex(canonicalJsonBytes(intent)),
    ledger_key: ledgerKey,
    profile,
    schema: "ego-chat-attachment-external-binding-entry/v1",
    source_workflow_id: workflowId,
    state: "CONSUMED_RELEASED",
  }
  const workflow = {
    bindingKey: "a3k-legacy",
    createdAt: "2026-09-03T01:00:00.000Z",
    id: workflowId,
    inputDigest: "7".repeat(64),
    kind: "ego_exchange",
    operationKey,
    phase: "attachment_evidence_released",
    status: "succeeded",
    updatedAt: "2026-09-03T01:00:08.000Z",
  }
  const checkpoint = {
    attachmentCapacity: {
      liveIntentCount: 1,
      liveReservedBytes: 1024 * 1024,
      permanentEntryCount: 1,
      permanentReservedBytes: 32 * 1024,
    },
    attachmentConsumerAcknowledgements: {},
    attachmentExternalBindings: { [ledgerKey]: externalBinding },
    attachmentCaptures: {
      [workflowId]: { schema: "legacy-capture/v1", source_workflow_id: workflowId },
    },
    attachmentDispositions: {},
    attachmentIntents: { [workflowId]: intent },
    attachmentEvidenceTombstones: {},
    bindings: {},
    confirmedSendEvents: {
      [workflowId]: { schema: "legacy-send-event/v1", workflow_id: workflowId },
    },
    confirmedSendIdentities: {
      [workflowId]: { schema: "legacy-send-identity/v1", source_workflow_id: workflowId },
    },
    modelPolicies: {},
    nextSeq: 2,
    operations: {
      [operationKey]: {
        createdAt: workflow.createdAt,
        inputDigest: workflow.inputDigest,
        key: operationKey,
        workflowId,
      },
    },
    schemaVersion: 7,
    workflows: { [workflowId]: workflow },
  }
  const disposition = { schema: "legacy-disposition/v1", source_workflow_id: workflowId }
  const acknowledgement = { schema: "legacy-acknowledgement/v1", source_workflow_id: workflowId }
  const tombstone = { schema: "legacy-tombstone/v1", source_workflow_id: workflowId }
  const tailEvent = {
    at: "2026-09-03T01:00:08.000Z",
    attachmentCapacity: {
      liveIntentCount: 0,
      liveReservedBytes: 0,
      permanentEntryCount: 1,
      permanentReservedBytes: 32 * 1024,
    },
    attachmentConsumerAcknowledgement: {
      envelope: acknowledgement,
      source_workflow_id: workflowId,
    },
    attachmentDisposition: {
      envelope: disposition,
      source_workflow_id: workflowId,
    },
    attachmentEvidenceTombstone: tombstone,
    attachmentExternalBinding: externalBinding,
    schemaVersion: 1,
    seq: 2,
    type: "attachment.evidence_released",
    workflow,
  }
  await fs.writeFile(
    path.join(dataDir, "checkpoint.json"),
    `${JSON.stringify(checkpoint, null, 2)}\n`,
    { mode: 0o600 },
  )
  await fs.writeFile(
    path.join(dataDir, "checkpoint.manifest.json"),
    `${JSON.stringify({
      createdAt: "2026-09-03T01:00:07.000Z",
      digest: digest(JSON.stringify(checkpoint)),
      nextSeq: checkpoint.nextSeq,
    }, null, 2)}\n`,
    { mode: 0o600 },
  )
  await fs.writeFile(
    path.join(dataDir, "events.jsonl"),
    `${JSON.stringify(tailEvent)}\n`,
    { mode: 0o600 },
  )

  const first = new EventStore(dataDir)
  await first.initialize()
  const firstQuarantine = first.getLegacyAttachmentEvidence(workflowId)
  assert.deepEqual(firstQuarantine.source_records, {
    attachment_consumer_acknowledgement: acknowledgement,
    attachment_capture: checkpoint.attachmentCaptures[workflowId],
    attachment_disposition: disposition,
    attachment_evidence_tombstone: tombstone,
    attachment_intent: intent,
    confirmed_send_event: checkpoint.confirmedSendEvents[workflowId],
    confirmed_send_identity: checkpoint.confirmedSendIdentities[workflowId],
    external_binding: externalBinding,
  })
  assert.equal(first.getAttachmentIntent(workflowId), undefined)
  assert.equal(
    first.getAttachmentExternalBinding(profile, externalBindingDigest).state,
    "CONSUMED_LEGACY_RECOVERY_REQUIRED",
  )
  assert.equal(
    JSON.parse(await fs.readFile(path.join(dataDir, "checkpoint.json"), "utf8"))
      .schemaVersion,
    9,
  )
  assert.equal(await fs.readFile(path.join(dataDir, "events.jsonl"), "utf8"), "")

  const freshWorkflowId = "55d7aa4c-423f-48ba-80ae-4a2d2d5a4036"
  const freshOperationKey = "exchange:a3k-fresh:EGO_CHAT_A3K_FRESH_V8_12345678"
  const freshQualification = fakeReceiptQualification({
    consumer_signer_authorization_sha256: "5".repeat(64),
  }, {
    runtimeIdentity: {
      executable_sha256: "3".repeat(64),
      implementation_git_sha: "2".repeat(40),
      package_inventory_sha256: "1".repeat(64),
    },
    signerEnrollmentDigest: "a".repeat(64),
    signerKeyId: `ed25519-spki-sha256:${"b".repeat(64)}`,
  })
  const freshWorkflow = {
    bindingKey: "a3k-fresh",
    createdAt: "2026-09-03T02:00:00.000Z",
    id: freshWorkflowId,
    inputDigest: "6".repeat(64),
    kind: "ego_exchange",
    operationKey: freshOperationKey,
    phase: "queued",
    private: {
      receiptAuthoritySnapshot: freshQualification.authoritySnapshot,
      receiptAuthoritySnapshotSha256: freshQualification.authoritySnapshotDigest,
    },
    status: "running",
    updatedAt: "2026-09-03T02:00:00.000Z",
  }
  const freshAdmission = buildAttachmentCaptureIntent({
    authorizationDigest: "5".repeat(64),
    createdAt: freshWorkflow.createdAt,
    externalBindingDigest: "4".repeat(64),
    operationKey: freshOperationKey,
    profile,
    runtimeIdentity: {
      executable_sha256: "3".repeat(64),
      implementation_git_sha: "2".repeat(40),
      package_inventory_sha256: "1".repeat(64),
    },
    signerEnrollmentDigest: "a".repeat(64),
    signerKeyId: `ed25519-spki-sha256:${"b".repeat(64)}`,
    workflowId: freshWorkflowId,
  })
  await first.persistStarted("workflow.started", freshWorkflow, {
    authoritySnapshot: freshQualification.authoritySnapshot,
    authoritySnapshotDigest: freshQualification.authoritySnapshotDigest,
    intent: freshAdmission.intent,
    intentDigest: freshAdmission.digest,
  })
  const freshBindingBeforeRestart = first.getAttachmentExternalBinding(
    profile,
    "4".repeat(64),
  )
  assert.notEqual(await fs.readFile(path.join(dataDir, "events.jsonl"), "utf8"), "")

  const second = new EventStore(dataDir)
  await second.initialize()
  assert.deepEqual(second.getLegacyAttachmentEvidence(workflowId), firstQuarantine)
  assert.equal(second.getAttachmentIntent(workflowId), undefined)
  assert.deepEqual(second.getAttachmentIntent(freshWorkflowId), freshAdmission.intent)
  assert.deepEqual(
    second.getAttachmentExternalBinding(profile, "4".repeat(64)),
    freshBindingBeforeRestart,
  )
})

test("schema v8 receipt evidence without an immutable authority snapshot is quarantined", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new EventStore(dataDir, { maxEvents: 1 })
  await store.initialize()
  const workflowId = "389ac8fa-36fe-4377-80bd-aec9d8f29a0d"
  const operationKey = "exchange:a3k-v8:EGO_CHAT_A3K_V8_12345678"
  const qualification = fakeReceiptQualification({
    consumer_signer_authorization_sha256: "8".repeat(64),
  })
  const admission = buildAttachmentCaptureIntent({
    authorizationDigest: "8".repeat(64),
    createdAt: "2026-09-04T05:00:00.000Z",
    externalBindingDigest: "9".repeat(64),
    operationKey,
    profile: "a3k-manual-canary-v1",
    runtimeIdentity: qualification.runtimeIdentity,
    signerEnrollmentDigest: qualification.signerEnrollmentDigest,
    signerKeyId: qualification.signerKeyId,
    workflowId,
  })
  await store.persistStarted("workflow.started", {
    bindingKey: "a3k-v8",
    createdAt: "2026-09-04T05:00:00.000Z",
    id: workflowId,
    inputDigest: "7".repeat(64),
    kind: "ego_exchange",
    operationKey,
    phase: "browser_owned",
    private: {
      receiptAuthoritySnapshot: qualification.authoritySnapshot,
      receiptAuthoritySnapshotSha256: qualification.authoritySnapshotDigest,
    },
    reconciliation: { turnMarker: "EGO_CHAT_A3K_V8_12345678" },
    status: "running",
    updatedAt: "2026-09-04T05:00:00.000Z",
  }, {
    authoritySnapshot: qualification.authoritySnapshot,
    authoritySnapshotDigest: qualification.authoritySnapshotDigest,
    intent: admission.intent,
    intentDigest: admission.digest,
  })
  const legacyStatePath = path.join(dataDir, "state.json")
  await fs.rm(path.join(dataDir, "checkpoint.json"), { force: true })
  await fs.rm(path.join(dataDir, "checkpoint.manifest.json"), { force: true })
  const legacyState = JSON.parse(await fs.readFile(legacyStatePath, "utf8"))
  legacyState.schemaVersion = 8
  delete legacyState.workflows[workflowId].private.receiptAuthoritySnapshot
  delete legacyState.workflows[workflowId].private.receiptAuthoritySnapshotSha256
  await fs.writeFile(legacyStatePath, JSON.stringify(legacyState), { mode: 0o600 })

  const restarted = new EventStore(dataDir)
  await restarted.initialize()
  const quarantine = restarted.getLegacyAttachmentEvidence(workflowId)
  assert.equal(quarantine.source_schema_version, 8)
  assert.equal(quarantine.reason, "LEGACY_CONTRACT_RECOVERY_ONLY")
  assert.equal(restarted.getAttachmentIntent(workflowId), undefined)
  assert.equal(
    restarted.getAttachmentExternalBinding(
      "a3k-manual-canary-v1",
      "9".repeat(64),
    ).state,
    "CONSUMED_LEGACY_RECOVERY_REQUIRED",
  )
})

test("binding-only legacy authority remains permanently consumed without mutation", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const workflowId = "80edb351-60d3-476c-af45-e7b7c836ad9a"
  const profile = "a3k-manual-canary-v1"
  const externalBindingDigest = "9".repeat(64)
  const ledgerKey = `${profile}:${externalBindingDigest}`
  const externalBinding = {
    external_binding_sha256: externalBindingDigest,
    ledger_key: ledgerKey,
    profile,
    schema: "ego-chat-attachment-external-binding-entry/v1",
    source_workflow_id: workflowId,
    state: "CONSUMED_RELEASED",
  }
  const legacyState = {
    attachmentCapacity: {
      liveIntentCount: 0,
      liveReservedBytes: 0,
      permanentEntryCount: 1,
      permanentReservedBytes: 32 * 1024,
    },
    attachmentConsumerAcknowledgements: {},
    attachmentExternalBindings: { [ledgerKey]: externalBinding },
    attachmentCaptures: {},
    attachmentDispositions: {},
    attachmentIntents: {},
    attachmentEvidenceTombstones: {},
    bindings: {},
    confirmedSendEvents: {},
    confirmedSendIdentities: {},
    modelPolicies: {},
    nextSeq: 1,
    operations: {},
    schemaVersion: 7,
    workflows: {},
  }
  await fs.writeFile(
    path.join(dataDir, "state.json"),
    `${JSON.stringify(legacyState, null, 2)}\n`,
    { mode: 0o600 },
  )
  const store = new EventStore(dataDir)
  await store.initialize()
  const quarantine = store.getLegacyAttachmentEvidence(workflowId)
  assert.equal(quarantine.source_records.attachment_intent, null)
  assert.deepEqual(quarantine.source_records.external_binding, externalBinding)
  assert.equal(
    store.getAttachmentExternalBinding(profile, externalBindingDigest).state,
    "CONSUMED_LEGACY_RECOVERY_REQUIRED",
  )
  const restarted = new EventStore(dataDir)
  await restarted.initialize()
  assert.deepEqual(restarted.getLegacyAttachmentEvidence(workflowId), quarantine)
  assert.deepEqual(restarted.listWorkflows(), [])
  await store.persistBinding("binding.created", {
    canonicalUrl: "https://chatgpt.com/c/a3k-binding-only",
    headContentDigest: "c".repeat(64),
    headFingerprint: "d".repeat(64),
    headFingerprintVersion: "tail-v1",
    headMessageId: "assistant-before",
    headRole: "assistant",
    key: "a3k-binding-only",
    messageCount: 2,
    revision: 1,
    state: "bound",
    targetId: "tab-binding-only",
    taskSpaceId: 3,
  })
  const broker = new Broker({
    attachmentReceiptAuthority: {
      qualify: async (request) => fakeReceiptQualification(request),
    },
    egoAdapter: unusedEgoAdapter,
    store,
  })
  t.after(() => broker.close())
  const before = {
    events: await fs.readFile(path.join(dataDir, "events.jsonl"), "utf8"),
    externalBinding: store.getAttachmentExternalBinding(profile, externalBindingDigest),
    metrics: store.getMetrics(),
    state: await fs.readFile(path.join(dataDir, "state.json"), "utf8"),
    workflows: store.listWorkflows(),
  }
  await assert.rejects(
    broker.startEgoExchange({
      bindingKey: "a3k-binding-only",
      expectedTerminalMarker: "EGO_CHAT_A3K_BINDING_ONLY_RESULT",
      prompt: "EGO_CHAT_A3K_BINDING_ONLY_FRESH_12345678\nprepare",
      receiptCapture: {
        consumer_signer_authorization_sha256: "8".repeat(64),
        external_binding_sha256: externalBindingDigest,
        profile,
        receipt_capture_requested: true,
        schema: "ego-chat-receipt-enabled-exchange-request/v1",
      },
      timeoutMs: 30_000,
      turnMarker: "EGO_CHAT_A3K_BINDING_ONLY_FRESH_12345678",
    }),
    (error) => error.code === "attachment_external_binding_consumed",
  )
  assert.deepEqual({
    events: await fs.readFile(path.join(dataDir, "events.jsonl"), "utf8"),
    externalBinding: store.getAttachmentExternalBinding(profile, externalBindingDigest),
    metrics: store.getMetrics(),
    state: await fs.readFile(path.join(dataDir, "state.json"), "utf8"),
    workflows: store.listWorkflows(),
  }, before)
})

test("broker recovers a driver failure then signs one quiet terminal disposition", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/c/a3k-broker-capture"
  const store = new EventStore(dataDir)
  await store.initialize()
  await store.persistBinding("binding.created", {
    canonicalUrl,
    headContentDigest: "1".repeat(64),
    headFingerprint: "2".repeat(64),
    headFingerprintVersion: "tail-v1",
    headMessageId: "assistant-before",
    headRole: "assistant",
    key: "a3k-broker-capture",
    messageCount: 2,
    revision: 1,
    state: "bound",
    targetId: "tab-broker-capture",
    taskSpaceIdentity: browserTaskSpaceIdentity("6"),
    taskSpaceId: 6,
  })
  let captureCalls = 0
  let sendCalls = 0
  let signCalls = 0
  const captureGuards = []
  await store.persistBinding("binding.created", {
    canonicalUrl: "https://chatgpt.com/c/foreign-attachment-owner",
    key: "foreign-attachment-owner",
    revision: 1,
    state: "bound",
    targetId: "foreign-tab",
    taskSpaceIdentity: browserTaskSpaceIdentity("foreign"),
    taskSpaceId: 16,
  })
  const broker = new Broker({
    attachmentReceiptAuthority: {
      qualify: async (request) => fakeReceiptQualification(request, {
        runtimeIdentity: {
          executable_sha256: "3".repeat(64),
          implementation_git_sha: "4".repeat(40),
          package_inventory_sha256: "5".repeat(64),
        },
        signerEnrollmentDigest: "6".repeat(64),
        signerKeyId: `ed25519-spki-sha256:${"7".repeat(64)}`,
      }),
      signAttachmentDisposition: async ({ disposition }) => {
        signCalls += 1
        return signedAttachmentEnvelope(disposition)
      },
    },
    egoAdapter: {
      ...unusedEgoAdapter,
      captureAttachmentExecution: async (input, _signal, _onResult, beforeRun) => {
        captureGuards.push(await beforeRun?.())
        captureCalls += 1
        if (captureCalls === 1) {
          throw new EgoChatError("ego_driver_failed", "transient read-only capture failure")
        }
        return attachmentGraphObservation({
          canonicalConversationLocatorSha256: sha256Hex(Buffer.from(canonicalUrl)),
          captureOperationKeySha256: input.captureOperationKeySha256,
          observedAt: new Date().toISOString(),
          sequence: input.observationSequence,
          sourceConfirmedSendIdentitySha256: input.sourceConfirmedSendIdentitySha256,
        })
      },
      captureExchange: async () => new Promise(() => {}),
      sendExchange: async (input) => {
        sendCalls += 1
        return {
          canonicalUrl,
          modelPolicy: modelPolicyObservation(),
          promptMessageId: "prompt-confirmed",
          sentAt: new Date().toISOString(),
          targetId: "tab-broker-capture",
          taskSpaceIdentity: browserTaskSpaceIdentity("6"),
          taskSpaceId: 6,
          turnMarker: input.turnMarker,
        }
      },
    },
    store,
  })
  t.after(() => broker.close())
  const started = await broker.startEgoExchange({
    bindingKey: "a3k-broker-capture",
    expectedTerminalMarker: "DONE_BROKER_CAPTURE",
    prompt: "EGO_CHAT_A3K_RECEIPT_BROKER1\nprepare",
    receiptCapture: {
      consumer_signer_authorization_sha256: "8".repeat(64),
      external_binding_sha256: "9".repeat(64),
      profile: "a3k-manual-canary-v1",
      receipt_capture_requested: true,
      schema: "ego-chat-receipt-enabled-exchange-request/v1",
    },
    timeoutMs: 30_000,
    turnMarker: "EGO_CHAT_A3K_RECEIPT_BROKER1",
  })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (store.getWorkflow(started.id)?.phase === "awaiting_attachment_capture") break
    await new Promise((resolve) => globalThis.setTimeout(resolve, 5))
  }
  assert.equal(store.getWorkflow(started.id).phase, "awaiting_attachment_capture")
  await broker.startAttachmentCapture({
    schema: "ego-chat-attachment-capture-request/v1",
    source_workflow_id: started.id,
  })
  const completed = await broker.awaitWorkflow({
    timeoutMs: 5_000,
    workflowId: started.id,
  })
  assert.equal(completed.status, "succeeded")
  assert.equal(completed.phase, "attachment_disposition_terminal")
  assert.equal(completed.result.outcome, "UNKNOWN")
  assert.equal(completed.result.reason, "UNSUPPORTED_SAVE_ASSOCIATION")
  assert.equal(sendCalls, 1)
  assert.equal(captureCalls, 3)
  assert.equal(signCalls, 1)
  assert.deepEqual(captureGuards, Array.from({ length: 3 }, () => ({
    taskSpaceGuard: {
      deniedIdentities: [browserTaskSpaceIdentity("foreign")],
      deniedSelectors: [],
      ownerSelector: { kind: "stable_identity", identity: browserTaskSpaceIdentity("6") },
      revision: 1,
    },
  })))
  assert.equal(store.getAttachmentCapture(started.id).attempt_journal.length, 3)
  assert.equal(
    store.getAttachmentCapture(started.id).attempt_journal[0].reason,
    "DRIVER_RECOVERY",
  )
  assert.equal(store.getAttachmentCapture(started.id).candidate_pair_count, 1)
  assert.ok(store.getAttachmentDisposition(started.id))
})

test("broker restart resumes the same capture lineage without another Send", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/c/a3k-restarted-capture"
  const firstStore = new EventStore(dataDir)
  await firstStore.initialize()
  await firstStore.persistBinding("binding.created", {
    canonicalUrl,
    headContentDigest: "1".repeat(64),
    headFingerprint: "2".repeat(64),
    headFingerprintVersion: "tail-v1",
    headMessageId: "assistant-before",
    headRole: "assistant",
    key: "a3k-restarted-capture",
    messageCount: 2,
    revision: 1,
    state: "bound",
    targetId: "tab-restarted-capture",
    taskSpaceIdentity: browserTaskSpaceIdentity("7"),
    taskSpaceId: 7,
  })
  let sendCalls = 0
  const qualification = async (request) => fakeReceiptQualification(request, {
    runtimeIdentity: {
      executable_sha256: "3".repeat(64),
      implementation_git_sha: "4".repeat(40),
      package_inventory_sha256: "5".repeat(64),
    },
    signerEnrollmentDigest: "6".repeat(64),
    signerKeyId: `ed25519-spki-sha256:${"7".repeat(64)}`,
  })
  const firstBroker = new Broker({
    attachmentReceiptAuthority: {
      qualify: qualification,
      signAttachmentDisposition: async ({ disposition }) => (
        signedAttachmentEnvelope(disposition)
      ),
    },
    egoAdapter: {
      ...unusedEgoAdapter,
      captureAttachmentExecution: async (input) => attachmentGraphObservation({
        canonicalConversationLocatorSha256: sha256Hex(Buffer.from(canonicalUrl)),
        captureOperationKeySha256: input.captureOperationKeySha256,
        observedAt: new Date().toISOString(),
        sequence: input.observationSequence,
        sourceConfirmedSendIdentitySha256: input.sourceConfirmedSendIdentitySha256,
      }),
      captureExchange: async () => new Promise(() => {}),
      sendExchange: async (input) => {
        sendCalls += 1
        return {
          canonicalUrl,
          modelPolicy: modelPolicyObservation(),
          promptMessageId: "prompt-confirmed",
          sentAt: new Date().toISOString(),
          targetId: "tab-restarted-capture",
          taskSpaceIdentity: browserTaskSpaceIdentity("7"),
          taskSpaceId: 7,
          turnMarker: input.turnMarker,
        }
      },
    },
    store: firstStore,
  })
  const started = await firstBroker.startEgoExchange({
    bindingKey: "a3k-restarted-capture",
    expectedTerminalMarker: "DONE_RESTARTED_CAPTURE",
    prompt: "EGO_CHAT_A3K_RECEIPT_RESTARTED1\nprepare",
    receiptCapture: {
      consumer_signer_authorization_sha256: "8".repeat(64),
      external_binding_sha256: "9".repeat(64),
      profile: "a3k-manual-canary-v1",
      receipt_capture_requested: true,
      schema: "ego-chat-receipt-enabled-exchange-request/v1",
    },
    timeoutMs: 30_000,
    turnMarker: "EGO_CHAT_A3K_RECEIPT_RESTARTED1",
  })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (firstStore.getWorkflow(started.id)?.phase === "awaiting_attachment_capture") break
    await new Promise((resolve) => globalThis.setTimeout(resolve, 5))
  }
  await firstBroker.startAttachmentCapture({
    schema: "ego-chat-attachment-capture-request/v1",
    source_workflow_id: started.id,
  })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (firstStore.getAttachmentCapture(started.id)?.attempt_journal.length === 1) break
    await new Promise((resolve) => globalThis.setTimeout(resolve, 5))
  }
  assert.equal(firstStore.getAttachmentCapture(started.id).attempt_journal.length, 1)
  firstBroker.close()

  const restartedStore = new EventStore(dataDir)
  let restartedCaptureCalls = 0
  const restartedGuards = []
  const restartedBroker = new Broker({
    attachmentReceiptAuthority: {
      qualify: qualification,
      signAttachmentDisposition: async ({ disposition }) => (
        signedAttachmentEnvelope(disposition)
      ),
    },
    egoAdapter: {
      ...unusedEgoAdapter,
      captureAttachmentExecution: async (input, _signal, _onResult, beforeRun) => {
        restartedGuards.push(await beforeRun?.())
        restartedCaptureCalls += 1
        return attachmentGraphObservation({
          canonicalConversationLocatorSha256: sha256Hex(Buffer.from(canonicalUrl)),
          captureOperationKeySha256: input.captureOperationKeySha256,
          observedAt: new Date().toISOString(),
          sequence: input.observationSequence,
          sourceConfirmedSendIdentitySha256: input.sourceConfirmedSendIdentitySha256,
        })
      },
    },
    store: restartedStore,
  })
  t.after(() => restartedBroker.close())
  await restartedBroker.initialize()
  const completed = await restartedBroker.awaitWorkflow({
    timeoutMs: 5_000,
    workflowId: started.id,
  })
  assert.equal(completed.status, "succeeded")
  assert.equal(completed.result.reason, "UNSUPPORTED_SAVE_ASSOCIATION")
  assert.equal(sendCalls, 1)
  assert.equal(restartedCaptureCalls, 2)
  assert.deepEqual(restartedGuards, Array.from({ length: 2 }, () => ({
    taskSpaceGuard: {
      deniedIdentities: [],
      deniedSelectors: [],
      ownerSelector: { kind: "stable_identity", identity: browserTaskSpaceIdentity("7") },
      revision: 1,
    },
  })))
  const terminalCapture = restartedStore.getAttachmentCapture(started.id)
  assert.equal(terminalCapture.attempt_journal.length, 4)
  assert.equal(terminalCapture.attempt_journal[1].reason, "BROKER_RESTART")
  assert.equal(terminalCapture.candidate_pair_count, 1)
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
  assert.equal(visible.supervision.semanticCheckpoint.schema, "EagleSemanticCheckpoint.v1")
  assert.equal(visible.supervision.semanticCheckpoint.workflowDigest.length, 64)
  assert.equal(visible.supervision.semanticCheckpoint.delivery, "sent_waiting_response")
  assert.equal(JSON.stringify(visible.supervision.semanticCheckpoint).includes(parent.id), false)
  assert.equal(JSON.stringify(visible.supervision.semanticCheckpoint).includes(child.id), false)
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

test("binding creation rejects incomplete or malformed browser task-space identity evidence", async (t) => {
  const invalidIdentities = [
    { name: "missing-task-id" },
    { taskId: "missing-name" },
    { name: "", taskId: "empty-name" },
    { name: "wrong-type", taskId: 7 },
    { name: "x".repeat(201), taskId: "over-limit" },
    { extra: "not-closed", name: "closed", taskId: "closed" },
  ]

  for (const [index, taskSpaceIdentity] of invalidIdentities.entries()) {
    const dataDir = await createDataDir()
    t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
    const store = new EventStore(dataDir)
    const broker = new Broker({
      egoAdapter: {
        ...unusedEgoAdapter,
        bind: async (input) => ({
          canonicalUrl: input.canonicalUrl,
          head: { fingerprint: `invalid-identity-${index}`, lastRole: "assistant", messageCount: 2 },
          targetId: `invalid-identity-tab-${index}`,
          taskSpaceIdentity,
          taskSpaceId: 10 + index,
        }),
      },
      store,
    })
    await broker.initialize()
    t.after(() => broker.close())
    const bindingKey = `invalid-identity-${index}`
    await assert.rejects(
      broker.bindConversation({
        bindingKey,
        canonicalUrl: `https://chatgpt.com/c/${bindingKey}`,
        mode: "existing",
        taskSpace: 10 + index,
      }),
      (error) => error.code === "human_required"
        && error.details?.reason === "task_space_identity_invalid",
    )
    assert.throws(
      () => broker.getConversationBinding({ bindingKey }),
      (error) => error.code === "binding_not_found",
    )
  }
})

test("binding creation rejects a successful browser result with no task-space identity", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      bind: async (input) => ({
        canonicalUrl: input.canonicalUrl,
        head: { fingerprint: "missing-identity-head", lastRole: "assistant", messageCount: 2 },
        targetId: "missing-identity-tab",
        taskSpaceId: 10,
      }),
    },
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())

  await assert.rejects(
    broker.bindConversation({
      bindingKey: "missing-identity",
      canonicalUrl: "https://chatgpt.com/c/missing-identity",
      mode: "existing",
      taskSpace: 10,
    }),
    (error) => error.code === "human_required"
      && error.details?.reason === "task_space_identity_missing",
  )
  assert.throws(
    () => broker.getConversationBinding({ bindingKey: "missing-identity" }),
    (error) => error.code === "binding_not_found",
  )
})

test("exchange results cannot omit or replace an established task-space identity", async (t) => {
  const cases = [
    { expectedReason: "task_space_identity_missing", resultIdentity: undefined },
    { expectedReason: "task_space_identity_changed", resultIdentity: browserTaskSpaceIdentity("other") },
  ]
  for (const [index, identityCase] of cases.entries()) {
    const dataDir = await createDataDir()
    t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
    const taskSpaceIdentity = browserTaskSpaceIdentity(`exchange-${index}`)
    const terminalMarker = `EGO_CHAT_IDENTITY_RESULT_DONE_${index}`
    const turnMarker = `EGO_CHAT_IDENTITY_RESULT_TEST_${index}`
    const store = new EventStore(dataDir)
    const broker = new Broker({
      egoAdapter: {
        ...unusedEgoAdapter,
        bind: async (input) => ({
          canonicalUrl: input.canonicalUrl,
          head: { fingerprint: `identity-result-before-${index}`, lastRole: "assistant", messageCount: 2 },
          targetId: `identity-result-tab-${index}`,
          taskSpaceIdentity,
          taskSpaceId: 40 + index,
        }),
        exchange: async (input) => ({
          canonicalUrl: input.binding.canonicalUrl,
          durationMs: 10,
          head: {
            fingerprint: `identity-result-after-${index}`,
            fingerprintVersion: "tail-v1",
            lastContentDigest: digest(terminalMarker),
            lastMessageId: `identity-result-assistant-${index}`,
            lastRole: "assistant",
            messageCount: 4,
          },
          modelPolicy: modelPolicyObservation(),
          responseDigest: digest(terminalMarker),
          responseText: terminalMarker,
          targetId: `identity-result-tab-${index}`,
          ...(identityCase.resultIdentity
            ? { taskSpaceIdentity: identityCase.resultIdentity }
            : {}),
          taskSpaceId: 40 + index,
          turnMarker: input.turnMarker,
        }),
      },
      store,
    })
    await broker.initialize()
    t.after(() => broker.close())
    await broker.bindConversation({
      bindingKey: `identity-result-${index}`,
      canonicalUrl: `https://chatgpt.com/c/identity-result-${index}`,
      mode: "existing",
      taskSpace: 40 + index,
    })
    const before = broker.getConversationBinding({ bindingKey: `identity-result-${index}` })
    const started = await broker.startEgoExchange({
      bindingKey: `identity-result-${index}`,
      expectedTerminalMarker: terminalMarker,
      prompt: `${turnMarker}\nReject unsafe identity evidence.`,
      timeoutMs: 30_000,
      turnMarker,
    })
    const completed = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: started.id })

    assert.equal(completed.status, "human_required")
    assert.equal(completed.humanRequired.code, identityCase.expectedReason)
    assert.deepEqual(
      broker.getConversationBinding({ bindingKey: `identity-result-${index}` }),
      before,
    )
    const durable = store.getWorkflow(started.id)
    assert.equal(durable.result, undefined)
    const workflowEvents = (await fs.readFile(path.join(dataDir, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.workflow?.id === started.id)
    assert.equal(workflowEvents.some((event) => event.type === "exchange.response_captured"), false)
    assert.deepEqual(
      await fs.readdir(path.join(dataDir, "blobs")).catch((error) => {
        if (error.code === "ENOENT") return []
        throw error
      }),
      [],
    )
  }
})

test("staged terminal capture validates task-space identity before result or blob persistence", async (t) => {
  const cases = [
    { expectedReason: "task_space_identity_missing", resultIdentity: undefined },
    { expectedReason: "task_space_identity_changed", resultIdentity: browserTaskSpaceIdentity("staged-other") },
  ]
  for (const [index, identityCase] of cases.entries()) {
    const dataDir = await createDataDir()
    t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
    const taskSpaceIdentity = browserTaskSpaceIdentity(`staged-${index}`)
    const terminalMarker = `EGO_CHAT_STAGED_IDENTITY_DONE_${index}`
    const responseText = terminalMarker
    const turnMarker = `EGO_CHAT_STAGED_IDENTITY_TEST_${index}`
    const store = new EventStore(dataDir)
    const broker = new Broker({
      egoAdapter: {
        ...unusedEgoAdapter,
        bind: async (input) => ({
          canonicalUrl: input.canonicalUrl,
          head: { fingerprint: `staged-before-${index}`, lastRole: "assistant", messageCount: 2 },
          targetId: `staged-tab-${index}`,
          taskSpaceIdentity,
          taskSpaceId: 70 + index,
        }),
        sendExchange: async (input) => ({
          canonicalUrl: input.binding.canonicalUrl,
          modelPolicy: modelPolicyObservation(),
          promptMessageId: `staged-user-${index}`,
          sentAt: new Date().toISOString(),
          targetId: `staged-tab-${index}`,
          taskSpaceIdentity,
          taskSpaceId: 70 + index,
          turnMarker: input.turnMarker,
        }),
        captureExchange: async (input) => ({
          canonicalUrl: input.canonicalUrl,
          durationMs: 10,
          head: {
            fingerprint: `staged-after-${index}`,
            fingerprintVersion: "tail-v1",
            lastContentDigest: digest(responseText),
            lastMessageId: `staged-assistant-${index}`,
            lastRole: "assistant",
            messageCount: 4,
          },
          responseDigest: digest(responseText),
          responseText,
          targetId: `staged-tab-${index}`,
          ...(identityCase.resultIdentity
            ? { taskSpaceIdentity: identityCase.resultIdentity }
            : {}),
          taskSpaceId: 70 + index,
          turnMarker,
        }),
      },
      store,
    })
    await broker.initialize()
    t.after(() => broker.close())
    await broker.bindConversation({
      bindingKey: `staged-identity-${index}`,
      canonicalUrl: `https://chatgpt.com/c/staged-identity-${index}`,
      mode: "existing",
      taskSpace: 70 + index,
    })
    const started = await broker.startEgoExchange({
      bindingKey: `staged-identity-${index}`,
      expectedTerminalMarker: terminalMarker,
      prompt: `${turnMarker}\nReject unsafe staged identity evidence.`,
      timeoutMs: 30_000,
      turnMarker,
    })
    const completed = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: started.id })

    assert.equal(completed.status, "human_required")
    assert.equal(completed.humanRequired.code, identityCase.expectedReason)
    assert.equal(store.getWorkflow(started.id).result, undefined)
    const workflowEvents = (await fs.readFile(path.join(dataDir, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.workflow?.id === started.id)
    assert.equal(workflowEvents.some((event) => event.type === "exchange.response_captured"), false)
    assert.deepEqual(
      await fs.readdir(path.join(dataDir, "blobs")).catch((error) => {
        if (error.code === "ENOENT") return []
        throw error
      }),
      [],
    )
  }
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
      taskSpaceIdentity: browserTaskSpaceIdentity(String(10)),
      taskSpaceId: 10,
    }),
    sendExchange: async (input) => {
      seenTimeouts.push(input.timeoutMs)
      seenBindingStates.push({
        canonicalUrl: input.binding.canonicalUrl,
        state: input.binding.state,
      })
      return {
        canonicalUrl,
        modelPolicy: modelPolicyObservation(),
        promptMessageId: `prompt-${seenBindingStates.length}`,
        sentAt: new Date().toISOString(),
        targetId: "bound-tab",
        taskSpaceIdentity: browserTaskSpaceIdentity(String(10)),
        taskSpaceId: 10,
        turnMarker: input.turnMarker,
      }
    },
    captureExchange: async (input) => {
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
        responseDigest: digest(responseText),
        responseText,
        targetId: "bound-tab",
        taskSpaceIdentity: browserTaskSpaceIdentity(String(10)),
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

test("unbound create-once refuses a monolithic adapter before Send", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  let monolithicCalls = 0
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      bind: async (input) => ({
        canonicalUrl: null,
        targetId: input.targetId,
        taskSpaceIdentity: browserTaskSpaceIdentity("monolithic-create-once"),
        taskSpaceId: 65,
      }),
      exchange: async () => {
        monolithicCalls += 1
        throw new Error("an unbound create-once Send must require staged evidence")
      },
    },
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "monolithic-create-once",
    mode: "create_once",
    startUrl: "https://chatgpt.com/",
    targetId: "monolithic-create-once-tab",
    taskSpace: 65,
  })
  const turnMarker = "EGO_CHAT_MONOLITHIC_CREATE_ONCE"
  const started = await broker.startEgoExchange({
    bindingKey: "monolithic-create-once",
    expectedTerminalMarker: `${turnMarker}_DONE`,
    prompt: `${turnMarker}\nreview`,
    timeoutMs: 30_000,
    turnMarker,
  })
  const stopped = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: started.id })

  assert.equal(stopped.status, "human_required")
  assert.equal(stopped.humanRequired.code, "create_once_staged_exchange_required")
  assert.equal(monolithicCalls, 0)
  assert.equal(broker.getConversationBinding({ bindingKey: "monolithic-create-once" }).state, "unbound")
})

test("a create-once canonical URL is reserved in-lane before another binding can claim it", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/c/create-once-in-lane-reservation"
  const taskSpaceIdentity = { name: "create-once-space", taskId: "create-once-task" }
  const turnMarker = "EGO_CHAT_CREATE_ONCE_RESERVATION"
  const terminalMarker = "EGO_CHAT_CREATE_ONCE_RESERVATION_DONE"
  let releaseSend
  let reportReserved
  const released = new Promise((resolve) => {
    releaseSend = resolve
  })
  const reserved = new Promise((resolve) => {
    reportReserved = resolve
  })
  let competingBrowserCalls = 0
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      bind: async (input) => {
        if (input.bindingKey !== "create-once-owner") {
          competingBrowserCalls += 1
        }
        return {
          canonicalUrl: null,
          head: {
            fingerprint: digest("blank-head"),
            fingerprintVersion: "tail-v1",
            lastContentDigest: null,
            lastMessageId: null,
            lastRole: null,
            messageCount: 0,
          },
          targetId: "create-once-tab",
          taskSpaceIdentity,
          taskSpaceId: 61,
        }
      },
      captureExchange: async () => ({
        canonicalUrl,
        durationMs: 10,
        head: {
          fingerprint: digest(terminalMarker),
          fingerprintVersion: "tail-v1",
          lastContentDigest: digest(terminalMarker),
          lastMessageId: "create-once-assistant",
          lastRole: "assistant",
          messageCount: 2,
        },
        responseDigest: digest(terminalMarker),
        responseText: terminalMarker,
        targetId: "create-once-tab",
        taskSpaceIdentity,
        taskSpaceId: 61,
        turnMarker,
      }),
      sendExchange: async (input, _signal, onResult) => {
        const result = {
          canonicalUrl,
          modelPolicy: modelPolicyObservation(),
          promptMessageId: "create-once-user",
          sentAt: new Date().toISOString(),
          targetId: "create-once-tab",
          taskSpaceIdentity,
          taskSpaceId: 61,
          turnMarker: input.turnMarker,
        }
        onResult(result)
        reportReserved()
        await released
        return result
      },
    },
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "create-once-owner",
    mode: "create_once",
    startUrl: "https://chatgpt.com/",
    targetId: "create-once-tab",
    taskSpace: 61,
  })
  const started = await broker.startEgoExchange({
    bindingKey: "create-once-owner",
    expectedTerminalMarker: terminalMarker,
    prompt: `${turnMarker}\nReserve the learned canonical URL.`,
    timeoutMs: 30_000,
    turnMarker,
  })
  await reserved
  try {
    await assert.rejects(
      broker.bindConversation({
        bindingKey: "create-once-competitor",
        canonicalUrl,
        mode: "existing",
        taskSpace: 62,
      }),
      (error) => error.code === "conversation_reserved",
    )
    assert.equal(competingBrowserCalls, 0)
  } finally {
    releaseSend()
  }
  const completed = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: started.id })
  assert.equal(completed.status, "succeeded")
  assert.equal(
    broker.getConversationBinding({ bindingKey: "create-once-owner" }).canonicalUrl,
    canonicalUrl,
  )
})

test("create-once learns one canonical URL exactly once inside Send", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const firstUrl = "https://chatgpt.com/c/create-once-first-canonical"
  const secondUrl = "https://chatgpt.com/c/create-once-second-canonical"
  const taskSpaceIdentity = { name: "create-once-single-url", taskId: "create-once-single-task" }
  let captureCalls = 0
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      bind: async (input) => ({
        canonicalUrl: null,
        targetId: input.targetId,
        taskSpaceIdentity,
        taskSpaceId: 71,
      }),
      captureExchange: async () => {
        captureCalls += 1
        throw new Error("a changed canonical URL must stop before capture")
      },
      sendExchange: async (input, _signal, onResult) => {
        const first = {
          canonicalUrl: firstUrl,
          modelPolicy: modelPolicyObservation(),
          promptMessageId: "create-once-single-user",
          sentAt: new Date().toISOString(),
          targetId: "create-once-single-tab",
          taskSpaceIdentity,
          taskSpaceId: 71,
          turnMarker: input.turnMarker,
        }
        onResult(first)
        return { ...first, canonicalUrl: secondUrl }
      },
    },
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "create-once-single-url",
    mode: "create_once",
    startUrl: "https://chatgpt.com/",
    targetId: "create-once-single-tab",
    taskSpace: 71,
  })
  const turnMarker = "EGO_CHAT_CREATE_ONCE_SINGLE_URL"
  const started = await broker.startEgoExchange({
    bindingKey: "create-once-single-url",
    expectedTerminalMarker: `${turnMarker}_DONE`,
    prompt: `${turnMarker}\nreview`,
    timeoutMs: 30_000,
    turnMarker,
  })
  const stopped = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: started.id })

  assert.equal(stopped.status, "human_required")
  assert.equal(stopped.humanRequired.code, "canonical_conversation_changed")
  assert.equal(captureCalls, 0)
  assert.equal(broker.getConversationBinding({ bindingKey: "create-once-single-url" }).state, "unbound")
  const workflowEvents = (await fs.readFile(path.join(dataDir, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((event) => event.workflow?.id === started.id)
  assert.equal(workflowEvents.some((event) => event.type === "exchange.send_confirmed"), false)
})

test("bind and verify reject canonical retargeting without residual reservation state", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/c/canonical-transaction"
  const wrongUrl = "https://chatgpt.com/c/canonical-transaction-wrong"
  const taskSpaceIdentity = { name: "canonical-transaction-space", taskId: "canonical-transaction-task" }
  let bindWrong = true
  let verifyWrong = true
  const head = {
    fingerprint: "canonical-transaction-head",
    fingerprintVersion: "tail-v1",
    lastContentDigest: digest("canonical-transaction-head"),
    lastMessageId: "canonical-transaction-assistant",
    lastRole: "assistant",
    messageCount: 2,
  }
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      bind: async () => ({
        canonicalUrl: bindWrong ? wrongUrl : canonicalUrl,
        head,
        targetId: "canonical-transaction-tab",
        taskSpaceIdentity,
        taskSpaceId: 66,
      }),
      verify: async () => ({
        canonicalUrl: verifyWrong ? wrongUrl : canonicalUrl,
        head,
        targetId: "canonical-transaction-tab",
        taskSpaceIdentity,
        taskSpaceId: 66,
      }),
    },
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())

  const bindInput = {
    bindingKey: "canonical-transaction",
    canonicalUrl,
    mode: "existing",
    taskSpace: "canonical-transaction-space",
  }
  await assert.rejects(
    broker.bindConversation(bindInput),
    (error) => error.code === "human_required"
      && error.details?.reason === "canonical_conversation_changed",
  )
  assert.throws(
    () => broker.getConversationBinding({ bindingKey: bindInput.bindingKey }),
    (error) => error.code === "binding_not_found",
  )
  bindWrong = false
  const bound = await broker.bindConversation(bindInput)
  assert.equal(bound.canonicalUrl, canonicalUrl)

  const bindingBeforeVerify = broker.getConversationBinding({ bindingKey: bindInput.bindingKey })
  await assert.rejects(
    broker.verifyConversation({ bindingKey: bindInput.bindingKey }),
    (error) => error.code === "human_required"
      && error.details?.reason === "canonical_conversation_changed",
  )
  assert.deepEqual(
    broker.getConversationBinding({ bindingKey: bindInput.bindingKey }),
    bindingBeforeVerify,
  )
  verifyWrong = false
  const verified = await broker.verifyConversation({ bindingKey: bindInput.bindingKey })
  assert.equal(verified.revision, bindingBeforeVerify.revision + 1)
})

test("adoption rejects canonical retargeting and can retry the same unbound key", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/c/adoption-canonical-transaction"
  const taskSpaceIdentity = { name: "adoption-canonical-space", taskId: "adoption-canonical-task" }
  let wrong = true
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      adopt: async () => {
        const responseText = "Stable adopted response."
        return {
          adoptedWhileGenerating: false,
          anchor: { contentDigest: digest("adoption-user"), messageId: "adoption-user" },
          canonicalUrl: wrong
            ? "https://chatgpt.com/c/adoption-canonical-transaction-wrong"
            : canonicalUrl,
          durationMs: 10,
          head: {
            fingerprint: "adoption-canonical-head",
            fingerprintVersion: "tail-v1",
            lastContentDigest: digest(responseText),
            lastMessageId: "adoption-canonical-assistant",
            lastRole: "assistant",
            messageCount: 2,
            renderedMessageCount: 2,
          },
          modelPolicy: modelPolicyObservation(),
          responseDigest: digest(responseText),
          responseText,
          targetId: "adoption-canonical-tab",
          taskSpaceIdentity,
          taskSpaceId: 67,
        }
      },
    },
    recoveryDelaysMs: [1],
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  const input = {
    bindingKey: "adoption-canonical-transaction",
    canonicalUrl,
    taskSpace: "adoption-canonical-space",
    timeoutMs: 30_000,
  }

  const first = await broker.startConversationAdoption(input)
  const stopped = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: first.id })
  assert.equal(stopped.status, "human_required")
  assert.equal(stopped.humanRequired.code, "canonical_conversation_changed")
  wrong = false
  const second = await broker.startConversationAdoption(input)
  const completed = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: second.id })
  assert.equal(completed.status, "succeeded")
  assert.equal(
    broker.getConversationBinding({ bindingKey: input.bindingKey }).canonicalUrl,
    canonicalUrl,
  )
})

test("Send and capture reject canonical retargeting before result or head persistence", async (t) => {
  for (const stage of ["send", "capture"]) {
    const dataDir = await createDataDir()
    t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
    const canonicalUrl = `https://chatgpt.com/c/${stage}-canonical-transaction`
    const wrongUrl = `https://chatgpt.com/c/${stage}-canonical-transaction-wrong`
    const taskSpaceIdentity = {
      name: `${stage}-canonical-space`,
      taskId: `${stage}-canonical-task`,
    }
    const initialHead = {
      fingerprint: `${stage}-canonical-head-before`,
      fingerprintVersion: "tail-v1",
      lastContentDigest: digest(`${stage}-canonical-head-before`),
      lastMessageId: `${stage}-canonical-assistant-before`,
      lastRole: "assistant",
      messageCount: 2,
    }
    let captureCalls = 0
    let verifyCalls = 0
    const broker = new Broker({
      egoAdapter: {
        ...unusedEgoAdapter,
        bind: async () => ({
          canonicalUrl,
          head: initialHead,
          targetId: `${stage}-canonical-tab`,
          taskSpaceIdentity,
          taskSpaceId: 68,
        }),
        captureExchange: async (input) => {
          captureCalls += 1
          const responseText = input.expectedTerminalMarker
          return {
            canonicalUrl: stage === "capture" ? wrongUrl : canonicalUrl,
            head: {
              fingerprint: `${stage}-canonical-head-after`,
              fingerprintVersion: "tail-v1",
              lastContentDigest: digest(responseText),
              lastMessageId: `${stage}-canonical-assistant-after`,
              lastRole: "assistant",
              messageCount: 4,
            },
            responseDigest: digest(responseText),
            responseText,
            targetId: `${stage}-canonical-tab`,
            taskSpaceIdentity,
            taskSpaceId: 68,
            turnMarker: input.turnMarker,
          }
        },
        sendExchange: async (input) => ({
          canonicalUrl: stage === "send" ? wrongUrl : canonicalUrl,
          modelPolicy: modelPolicyObservation(),
          promptMessageId: `${stage}-canonical-user`,
          sentAt: new Date().toISOString(),
          targetId: `${stage}-canonical-tab`,
          taskSpaceIdentity,
          taskSpaceId: 68,
          turnMarker: input.turnMarker,
        }),
        verify: async () => {
          verifyCalls += 1
          return {
            canonicalUrl,
            head: initialHead,
            targetId: `${stage}-canonical-tab`,
            taskSpaceIdentity,
            taskSpaceId: 68,
          }
        },
      },
      store: new EventStore(dataDir),
    })
    await broker.initialize()
    t.after(() => broker.close())
    await broker.bindConversation({
      bindingKey: `${stage}-canonical-transaction`,
      canonicalUrl,
      mode: "existing",
      taskSpace: `${stage}-canonical-space`,
    })
    const bindingBefore = broker.getConversationBinding({
      bindingKey: `${stage}-canonical-transaction`,
    })
    const turnMarker = `EGO_CHAT_${stage.toUpperCase()}_CANONICAL_TRANSACTION`
    const started = await broker.startEgoExchange({
      bindingKey: `${stage}-canonical-transaction`,
      expectedTerminalMarker: `${turnMarker}_DONE`,
      prompt: `${turnMarker}\nreview`,
      timeoutMs: 30_000,
      turnMarker,
    })
    const stopped = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: started.id })

    assert.equal(stopped.status, "human_required")
    assert.equal(stopped.humanRequired.code, "canonical_conversation_changed")
    assert.equal(captureCalls, stage === "capture" ? 1 : 0)
    assert.equal(stopped.result, undefined)
    assert.deepEqual(
      broker.getConversationBinding({ bindingKey: `${stage}-canonical-transaction` }),
      bindingBefore,
    )
    if (stage === "capture") {
      await assert.rejects(
        broker.verifyConversation({ bindingKey: `${stage}-canonical-transaction` }),
        (error) => error.code === "human_required"
          && error.details?.reason === "binding_key_reserved",
      )
      await broker.abandonWorkflow({
        acknowledgePotentialDelivery: true,
        workflowId: started.id,
      })
    }
    await broker.verifyConversation({ bindingKey: `${stage}-canonical-transaction` })
    assert.equal(verifyCalls, 1)
    const workflowEvents = (await fs.readFile(path.join(dataDir, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.workflow?.id === started.id)
    assert.equal(workflowEvents.some((event) => event.type === "exchange.response_captured"), false)
  }
})

test("a legacy Project binding persists its complete task-space identity across exchange and restart", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/g/g-p-a3k-isolation/c/a3k-isolation-chat"
  const taskSpaceIdentity = {
    name: `ego-chat-bound-${digest(`canonical-conversation\0${canonicalUrl}`).slice(0, 32)}`,
    taskId: "opaque-a3k-isolation-task-id",
  }
  const initialHead = {
    fingerprint: "legacy-identity-before",
    fingerprintVersion: "tail-v1",
    lastContentDigest: "a".repeat(64),
    lastMessageId: "legacy-identity-assistant-before",
    lastRole: "assistant",
    messageCount: 2,
  }
  const now = "2026-08-24T00:00:00.000Z"
  const legacyBinding = {
    canonicalUrl,
    createdAt: now,
    headContentDigest: initialHead.lastContentDigest,
    headFingerprint: initialHead.fingerprint,
    headFingerprintVersion: initialHead.fingerprintVersion,
    headMessageId: initialHead.lastMessageId,
    headRole: initialHead.lastRole,
    key: "legacy-a3k",
    messageCount: initialHead.messageCount,
    mode: "existing",
    modelPolicyKey: "chatgpt-web-default",
    projectUrl: "https://chatgpt.com/g/g-p-a3k-isolation",
    revision: 1,
    startUrl: canonicalUrl,
    state: "bound",
    targetId: "legacy-identity-tab-before",
    taskSpaceId: 3,
    updatedAt: now,
    verifiedAt: now,
  }
  const legacyEvent = `${JSON.stringify({
    at: now,
    binding: legacyBinding,
    schemaVersion: 1,
    seq: 1,
    type: "binding.created",
  })}\n`
  await fs.writeFile(path.join(dataDir, "events.jsonl"), legacyEvent, { mode: 0o600 })

  const legacyStore = new EventStore(dataDir)
  await legacyStore.initialize()
  assert.deepEqual(legacyStore.getBinding("legacy-a3k"), legacyBinding)

  const missingIdentityBroker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      verify: async () => ({
        canonicalUrl,
        head: initialHead,
        targetId: "legacy-identity-tab-before",
        taskSpaceId: 3,
      }),
    },
    store: new EventStore(dataDir),
  })
  await missingIdentityBroker.initialize()
  const eventsBeforeMissingIdentityAttempt = await fs.readFile(
    path.join(dataDir, "events.jsonl"),
    "utf8",
  )
  await assert.rejects(
    missingIdentityBroker.verifyConversation({ bindingKey: "legacy-a3k" }),
    (error) => error.code === "human_required"
      && error.details?.reason === "task_space_identity_missing",
  )
  assert.equal(
    missingIdentityBroker.getConversationBinding({ bindingKey: "legacy-a3k" }).revision,
    1,
  )
  missingIdentityBroker.close()
  assert.equal(
    await fs.readFile(path.join(dataDir, "events.jsonl"), "utf8"),
    eventsBeforeMissingIdentityAttempt,
  )

  const migrationBroker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      verify: async ({ binding }) => {
        assert.equal(binding.canonicalUrl, canonicalUrl)
        assert.equal(binding.taskSpaceIdentity, undefined)
        return {
          canonicalUrl,
          head: {
            fingerprint: binding.headFingerprint,
            fingerprintVersion: "tail-v1",
            lastContentDigest: binding.headContentDigest,
            lastMessageId: binding.headMessageId,
            lastRole: binding.headRole,
            messageCount: binding.messageCount,
          },
          targetId: "legacy-identity-tab-verified",
          taskSpaceIdentity,
          taskSpaceId: 31,
        }
      },
    },
    store: new EventStore(dataDir),
  })
  await migrationBroker.initialize()
  const verified = await migrationBroker.verifyConversation({ bindingKey: "legacy-a3k" })
  assert.equal(verified.canonicalUrl, canonicalUrl)
  assert.deepEqual(verified.taskSpaceIdentity, taskSpaceIdentity)
  assert.equal(verified.revision, 2)
  migrationBroker.close()

  const finalStore = new EventStore(dataDir)
  await finalStore.initialize()
  const migrated = finalStore.getBinding("legacy-a3k")
  assert.equal(migrated.canonicalUrl, canonicalUrl)
  assert.equal(migrated.taskSpaceId, 31)
  assert.deepEqual(migrated.taskSpaceIdentity, taskSpaceIdentity)

  const beforeDriftAttempt = await fs.readFile(path.join(dataDir, "events.jsonl"), "utf8")
  const driftBroker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      verify: async () => ({
        canonicalUrl,
        head: initialHead,
        targetId: "legacy-identity-tab-drifted",
        taskSpaceIdentity: browserTaskSpaceIdentity("drifted"),
        taskSpaceId: 99,
      }),
    },
    store: finalStore,
  })
  await driftBroker.initialize()
  await assert.rejects(
    driftBroker.verifyConversation({ bindingKey: "legacy-a3k" }),
    (error) => error.code === "human_required"
      && error.details?.reason === "task_space_identity_changed",
  )
  assert.deepEqual(
    driftBroker.getConversationBinding({ bindingKey: "legacy-a3k" }).taskSpaceIdentity,
    taskSpaceIdentity,
  )
  driftBroker.close()
  assert.equal(
    await fs.readFile(path.join(dataDir, "events.jsonl"), "utf8"),
    beforeDriftAttempt,
  )
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
      taskSpaceIdentity: browserTaskSpaceIdentity(String(12)),
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
        taskSpaceIdentity: browserTaskSpaceIdentity(String(12)),
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
        taskSpaceIdentity: browserTaskSpaceIdentity("12"),
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
      taskSpaceIdentity: browserTaskSpaceIdentity(String(18)),
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
          taskSpaceIdentity: browserTaskSpaceIdentity(String(18)),
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
        taskSpaceIdentity: browserTaskSpaceIdentity(String(18)),
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
        taskSpaceIdentity: browserTaskSpaceIdentity(String(18)),
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

test("confirmed create-once capture promotes a provisional locator without another Send", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/c/create-once-promoted"
  const provisionalUrl = "https://chatgpt.com/c/WEB:create-once-provisional"
  const terminalMarker = "EGO_CHAT_CREATE_ONCE_PROMOTED_DONE"
  const turnMarker = "EGO_CHAT_CREATE_ONCE_PROMOTED_TEST"
  const promptMessageId = "create-once-promoted-user"
  let captures = 0
  let sends = 0
  const egoAdapter = {
    ...unusedEgoAdapter,
    bind: async (input) => ({
      canonicalUrl: null,
      targetId: input.targetId,
      taskSpaceIdentity: browserTaskSpaceIdentity("19"),
      taskSpaceId: 19,
    }),
    captureExchange: async () => {
      captures += 1
      if (captures === 1) {
        return {
          canonicalUrl,
          captureReason: "response_not_terminal",
          captureState: "pending",
          generationRunning: false,
          promptMessageId,
          targetId: "create-once-promoted-tab",
          taskSpaceIdentity: browserTaskSpaceIdentity("19"),
          taskSpaceId: 19,
          turnMarker,
        }
      }
      const responseText = terminalMarker
      return {
        canonicalUrl,
        head: {
          fingerprint: "create-once-promoted-after",
          fingerprintVersion: "tail-v1",
          lastContentDigest: digest(responseText),
          lastMessageId: "create-once-promoted-assistant",
          lastRole: "assistant",
          messageCount: 2,
        },
        responseDigest: digest(responseText),
        responseText,
        targetId: "create-once-promoted-tab",
        taskSpaceIdentity: browserTaskSpaceIdentity("19"),
        taskSpaceId: 19,
        turnMarker,
      }
    },
    sendExchange: async () => {
      sends += 1
      return {
        canonicalUrl: provisionalUrl,
        modelPolicy: modelPolicyObservation(),
        promptMessageId,
        sentAt: new Date().toISOString(),
        targetId: "create-once-promoted-tab",
        taskSpaceIdentity: browserTaskSpaceIdentity("19"),
        taskSpaceId: 19,
        turnMarker,
      }
    },
  }
  const broker = new Broker({ egoAdapter, store: new EventStore(dataDir) })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "create-once-promoted",
    mode: "create_once",
    startUrl: "https://chatgpt.com/",
    targetId: "create-once-promoted-tab",
    taskSpace: 19,
  })

  const started = await broker.startEgoExchange({
    bindingKey: "create-once-promoted",
    expectedTerminalMarker: terminalMarker,
    prompt: `${turnMarker}\nCapture the promoted conversation.`,
    timeoutMs: 30_000,
    turnMarker,
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(completed.status, "succeeded")
  assert.equal(completed.captureRecoveryCount ?? 0, 0)
  assert.equal(completed.result.canonicalUrl, canonicalUrl)
  assert.equal(sends, 1)
  assert.equal(captures, 2)
  const binding = broker.getConversationBinding({ bindingKey: "create-once-promoted" })
  assert.equal(binding.state, "bound")
  assert.equal(binding.canonicalUrl, canonicalUrl)
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
      taskSpaceIdentity: browserTaskSpaceIdentity(String(21)),
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
        taskSpaceIdentity: browserTaskSpaceIdentity(String(21)),
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
        taskSpaceIdentity: browserTaskSpaceIdentity(String(21)),
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
      taskSpaceIdentity: browserTaskSpaceIdentity(String(23)),
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
        taskSpaceIdentity: browserTaskSpaceIdentity(String(23)),
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
        taskSpaceIdentity: browserTaskSpaceIdentity(String(23)),
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
        taskSpaceIdentity: browserTaskSpaceIdentity(String(23)),
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
      taskSpaceIdentity: browserTaskSpaceIdentity(String(22)),
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
        taskSpaceIdentity: browserTaskSpaceIdentity(String(22)),
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
      taskSpaceIdentity: browserTaskSpaceIdentity(String(22)),
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
      taskSpaceIdentity: browserTaskSpaceIdentity("24"),
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
      taskSpaceIdentity: browserTaskSpaceIdentity("24"),
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
    taskSpaceIdentity: browserTaskSpaceIdentity(String(10)),
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
      taskSpaceIdentity: browserTaskSpaceIdentity(String(input.binding.taskSpaceId)),
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
    taskSpaceIdentity: browserTaskSpaceIdentity(String(10)),
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
      taskSpaceIdentity: browserTaskSpaceIdentity(String(10)),
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
        taskSpaceIdentity: browserTaskSpaceIdentity(String(10)),
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

test("binding create persistence is compare-and-set and cannot overwrite an existing key", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new EventStore(dataDir)
  await store.initialize()
  const first = { key: "binding-create-cas", revision: 1, state: "bound" }
  await store.persistBinding("binding.created", first, null)
  await assert.rejects(
    store.persistBinding("binding.created", {
      key: first.key,
      revision: 1,
      state: "unbound",
    }, null),
    (error) => error.code === "binding_transition_conflict",
  )
  assert.deepEqual(store.getBinding(first.key), first)
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
        taskSpaceIdentity: {
          name: "adopted-review-space",
          taskId: "adopted-review-space",
        },
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
  assert.deepEqual(binding.taskSpaceIdentity, {
    name: "adopted-review-space",
    taskId: "adopted-review-space",
  })
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

test("conversation adoption rejects a complete capture without stable task-space identity", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/c/adoption-missing-identity"
  const responseText = "Adoption response."
  const responseDigest = digest(responseText)
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      adopt: async () => ({
        adoptedWhileGenerating: false,
        anchor: { contentDigest: "a".repeat(64), messageId: "adoption-user" },
        canonicalUrl,
        durationMs: 10,
        head: {
          fingerprint: "adoption-missing-identity-head",
          fingerprintVersion: "tail-v1",
          lastContentDigest: responseDigest,
          lastMessageId: "adoption-assistant",
          lastRole: "assistant",
          messageCount: 2,
          renderedMessageCount: 2,
        },
        modelPolicy: modelPolicyObservation(),
        responseDigest,
        responseText,
        targetId: "adoption-missing-identity-tab",
        taskSpaceId: 55,
      }),
    },
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  const started = await broker.startConversationAdoption({
    bindingKey: "adoption-missing-identity",
    canonicalUrl,
    taskSpace: 55,
    timeoutMs: 30_000,
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: started.id })

  assert.equal(completed.status, "human_required")
  assert.equal(completed.humanRequired.code, "task_space_identity_missing")
  assert.throws(
    () => broker.getConversationBinding({ bindingKey: "adoption-missing-identity" }),
    (error) => error.code === "binding_not_found",
  )
})

test("default adoption task spaces use a domain-separated 128-bit full-Project URL identity", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/g/g-p-adoption-project/c/adoption-project-chat"
  const responseText = "Project adoption response."
  let receivedTaskSpace
  let receivedTaskSpaceGuard
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      adopt: async (input, _signal, _onResult, beforeRun) => {
        const effectiveInput = { ...input, ...beforeRun() }
        receivedTaskSpace = input.taskSpace
        receivedTaskSpaceGuard = effectiveInput.taskSpaceGuard
        return {
          adoptedWhileGenerating: false,
          anchor: { contentDigest: "a".repeat(64), messageId: "project-adoption-user" },
          canonicalUrl,
          durationMs: 10,
          head: {
            fingerprint: "project-adoption-head",
            fingerprintVersion: "tail-v1",
            lastContentDigest: digest(responseText),
            lastMessageId: "project-adoption-assistant",
            lastRole: "assistant",
            messageCount: 2,
            renderedMessageCount: 2,
          },
          modelPolicy: modelPolicyObservation(),
          responseDigest: digest(responseText),
          responseText,
          targetId: "project-adoption-tab",
          taskSpaceIdentity: {
            name: input.taskSpace,
            taskId: "opaque-project-adoption-task-id",
          },
          taskSpaceId: 88,
        }
      },
    },
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())

  const started = await broker.startConversationAdoption({
    bindingKey: "project-adoption",
    canonicalUrl,
    timeoutMs: 30_000,
  })
  const completed = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: started.id })
  const expected = `ego-chat-adopt-${digest(`canonical-adoption\0${canonicalUrl}`).slice(0, 32)}`
  const boundNamespace = `ego-chat-bound-${digest(`canonical-conversation\0${canonicalUrl}`).slice(0, 32)}`

  assert.equal(completed.status, "succeeded")
  assert.equal(receivedTaskSpace, expected)
  assert.deepEqual(receivedTaskSpaceGuard, {
    deniedIdentities: [],
    deniedSelectors: [],
    ownerSelector: { kind: "name", value: expected },
    revision: 1,
  })
  assert.match(receivedTaskSpace, /^ego-chat-adopt-[a-f0-9]{32}$/)
  assert.notEqual(receivedTaskSpace, boundNamespace)
  assert.deepEqual(
    broker.getConversationBinding({ bindingKey: "project-adoption" }).taskSpaceIdentity,
    { name: expected, taskId: "opaque-project-adoption-task-id" },
  )
})

test("adoption cannot persist an exact or one-field-conflicting identity owned by another chat", async (t) => {
  const existingIdentity = { name: "existing-space", taskId: "existing-task" }
  const cases = [
    { expectedReason: "task_space_identity_already_bound", identity: existingIdentity },
    {
      expectedReason: "task_space_identity_conflict",
      identity: { name: existingIdentity.name, taskId: "different-task" },
    },
    {
      expectedReason: "task_space_identity_conflict",
      identity: { name: "different-name", taskId: existingIdentity.taskId },
    },
  ]
  for (const [index, identityCase] of cases.entries()) {
    const dataDir = await createDataDir()
    t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
    const canonicalUrl = `https://chatgpt.com/c/adoption-conflict-${index}`
    const responseText = `Adoption conflict response ${index}.`
    const store = new EventStore(dataDir)
    const broker = new Broker({
      egoAdapter: {
        ...unusedEgoAdapter,
        bind: async (input) => ({
          canonicalUrl: input.canonicalUrl,
          head: { fingerprint: "existing-head", lastRole: "assistant", messageCount: 2 },
          targetId: "existing-tab",
          taskSpaceIdentity: existingIdentity,
          taskSpaceId: 10,
        }),
        adopt: async () => ({
          adoptedWhileGenerating: false,
          anchor: { contentDigest: "a".repeat(64), messageId: `adoption-user-${index}` },
          canonicalUrl,
          durationMs: 10,
          head: {
            fingerprint: `adoption-conflict-head-${index}`,
            fingerprintVersion: "tail-v1",
            lastContentDigest: digest(responseText),
            lastMessageId: `adoption-assistant-${index}`,
            lastRole: "assistant",
            messageCount: 2,
            renderedMessageCount: 2,
          },
          modelPolicy: modelPolicyObservation(),
          responseDigest: digest(responseText),
          responseText,
          targetId: `adoption-tab-${index}`,
          taskSpaceIdentity: identityCase.identity,
          taskSpaceId: 20 + index,
        }),
      },
      store,
    })
    await broker.initialize()
    t.after(() => broker.close())
    await broker.bindConversation({
      bindingKey: "existing-chat",
      canonicalUrl: "https://chatgpt.com/c/existing-chat",
      mode: "existing",
      taskSpace: 10,
    })

    const started = await broker.startConversationAdoption({
      bindingKey: `adoption-conflict-${index}`,
      canonicalUrl,
      taskSpace: 20 + index,
      timeoutMs: 30_000,
    })
    const completed = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: started.id })

    assert.equal(completed.status, "human_required")
    assert.equal(completed.humanRequired.code, identityCase.expectedReason)
    assert.throws(
      () => broker.getConversationBinding({ bindingKey: `adoption-conflict-${index}` }),
      (error) => error.code === "binding_not_found",
    )
    const events = (await fs.readFile(path.join(dataDir, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.workflow?.id === started.id)
    assert.equal(events.some((event) => event.type === "adoption.response_captured"), false)
  }
})

test("a captured adoption keeps its URL and tuple claim across binding failure and restart", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/c/adoption-durable-claim"
  const identity = { name: "adoption-durable-space", taskId: "adoption-durable-task" }
  const responseText = "The adoption capture is durable."
  let foreignBrowserCalls = 0
  class FailingAdoptionCommitStore extends EventStore {
    async persistBinding(eventType, binding, previous = undefined) {
      if (eventType === "binding.adopted") {
        throw new EgoChatError("injected_binding_failure", "Injected binding commit failure.")
      }
      return super.persistBinding(eventType, binding, previous)
    }
  }
  const firstBroker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      adopt: async () => ({
        adoptedWhileGenerating: false,
        anchor: { contentDigest: "a".repeat(64), messageId: "adoption-durable-user" },
        canonicalUrl,
        durationMs: 5,
        head: {
          fingerprint: "adoption-durable-head",
          fingerprintVersion: "tail-v1",
          lastContentDigest: digest(responseText),
          lastMessageId: "adoption-durable-assistant",
          lastRole: "assistant",
          messageCount: 2,
          renderedMessageCount: 2,
        },
        modelPolicy: modelPolicyObservation(),
        responseDigest: digest(responseText),
        responseText,
        targetId: "adoption-durable-tab",
        taskSpaceIdentity: identity,
        taskSpaceId: 77,
      }),
    },
    store: new FailingAdoptionCommitStore(dataDir),
  })
  await firstBroker.initialize()
  const started = await firstBroker.startConversationAdoption({
    bindingKey: "adoption-durable-owner",
    canonicalUrl,
    taskSpace: identity.name,
    timeoutMs: 30_000,
  })
  const stopped = await firstBroker.awaitWorkflow({ timeoutMs: 2_000, workflowId: started.id })
  assert.equal(stopped.status, "failed")
  assert.deepEqual(stopped.reconciliation.adoptionCaptureClaim.taskSpaceIdentity, identity)
  await assert.rejects(
    firstBroker.bindConversation({
      bindingKey: "adoption-durable-foreign",
      canonicalUrl,
      mode: "existing",
      taskSpace: identity.name,
    }),
    (error) => ["conversation_reserved", "human_required"].includes(error.code),
  )
  firstBroker.close()

  const restarted = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      bind: async (input) => {
        foreignBrowserCalls += 1
        return {
          canonicalUrl: input.canonicalUrl,
          head: {
            fingerprint: "adoption-durable-foreign-head",
            fingerprintVersion: "tail-v1",
            lastContentDigest: "b".repeat(64),
            lastMessageId: "adoption-durable-foreign-assistant",
            lastRole: "assistant",
            messageCount: 2,
          },
          targetId: "adoption-durable-foreign-tab",
          taskSpaceIdentity: identity,
          taskSpaceId: 77,
        }
      },
    },
    store: new EventStore(dataDir),
  })
  await restarted.initialize()
  t.after(() => restarted.close())
  await assert.rejects(
    restarted.bindConversation({
      bindingKey: "adoption-durable-foreign",
      canonicalUrl,
      mode: "existing",
      taskSpace: identity.name,
    }),
    (error) => ["conversation_reserved", "human_required"].includes(error.code),
  )
  assert.equal(foreignBrowserCalls, 0)
  await restarted.abandonWorkflow({
    acknowledgePotentialDelivery: true,
    workflowId: started.id,
  })
  const rebound = await restarted.bindConversation({
    bindingKey: "adoption-durable-foreign",
    canonicalUrl,
    mode: "existing",
    taskSpace: identity.name,
  })
  assert.equal(rebound.canonicalUrl, canonicalUrl)
  assert.equal(foreignBrowserCalls, 1)
})

test("an adoption transition failure leaves its running browser admission fenced", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/c/adoption-transition-fence"
  const identity = { name: "adoption-transition-space", taskId: "adoption-transition-task" }
  const responseText = "Captured before the injected transition failure."
  let reportFailedTransition
  const failedTransition = new Promise((resolve) => { reportFailedTransition = resolve })
  class FailingAdoptionTransitionStore extends EventStore {
    async persist(eventType, workflow, expected = undefined) {
      if ([
        "adoption.response_captured",
        "adoption.recovery_scheduled",
        "workflow.failed",
      ].includes(eventType)) {
        if (eventType === "workflow.failed") reportFailedTransition()
        throw new Error(`injected ${eventType} failure`)
      }
      return super.persist(eventType, workflow, expected)
    }
  }
  let preflightCalls = 0
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      adopt: async () => ({
        adoptedWhileGenerating: false,
        anchor: { contentDigest: "a".repeat(64), messageId: "transition-fence-user" },
        canonicalUrl,
        durationMs: 5,
        head: {
          fingerprint: "transition-fence-head",
          fingerprintVersion: "tail-v1",
          lastContentDigest: digest(responseText),
          lastMessageId: "transition-fence-assistant",
          lastRole: "assistant",
          messageCount: 2,
          renderedMessageCount: 2,
        },
        modelPolicy: modelPolicyObservation(),
        responseDigest: digest(responseText),
        responseText,
        targetId: "transition-fence-tab",
        taskSpaceIdentity: identity,
        taskSpaceId: 78,
      }),
      preflight: async () => {
        preflightCalls += 1
        return { safe: true }
      },
    },
    store: new FailingAdoptionTransitionStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  const started = await broker.startConversationAdoption({
    bindingKey: "adoption-transition-fence",
    canonicalUrl,
    taskSpace: identity.name,
    timeoutMs: 30_000,
  })
  await failedTransition
  assert.equal(broker.getWorkflow({ workflowId: started.id }).status, "running")
  await assert.rejects(
    broker.egoPreflight({ taskSpace: identity.name }),
    (error) => error.code === "human_required"
      && error.details?.reason === "task_space_selector_reserved",
  )
  assert.equal(preflightCalls, 0)
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
          taskSpaceIdentity: browserTaskSpaceIdentity(String(14)),
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
        taskSpaceIdentity: browserTaskSpaceIdentity(String(11)),
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
    taskSpaceIdentity: browserTaskSpaceIdentity(String(13)),
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
  let releaseBindingCommit
  let reportBindingCommit
  const bindingCommitReleased = new Promise((resolve) => {
    releaseBindingCommit = resolve
  })
  const bindingCommitStarted = new Promise((resolve) => {
    reportBindingCommit = resolve
  })
  class PausingAdoptionStore extends EventStore {
    async persistBinding(eventType, binding, previous = undefined) {
      if (eventType === "binding.adopted") {
        reportBindingCommit()
        await bindingCommitReleased
      }
      return super.persistBinding(eventType, binding, previous)
    }
  }
  let adoptionCalls = 0
  let preflightMutations = 0
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      adopt: async () => {
        adoptionCalls += 1
        throw new Error("captured adoption must not reopen the browser")
      },
      preflight: async (_input, _signal, beforeRun) => {
        const guard = beforeRun().taskSpaceGuard
        if (guard.deniedIdentities.some((identity) => (
          identity.name === capture.taskSpaceIdentity.name
          || identity.taskId === capture.taskSpaceIdentity.taskId
        ))) {
          throw new EgoChatError("human_required", "The restored adoption tuple remains reserved.", {
            reason: "task_space_identity_already_bound",
          })
        }
        preflightMutations += 1
        return { safe: true }
      },
    },
    store: new PausingAdoptionStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())

  await bindingCommitStarted
  try {
    await assert.rejects(
      broker.egoPreflight({ taskSpace: capture.taskSpaceId }),
      (error) => error.code === "human_required"
        && error.details?.reason === "task_space_identity_already_bound",
    )
    assert.equal(preflightMutations, 0)
  } finally {
    releaseBindingCommit()
  }

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

test("a recycled numeric id does not block adoption into a distinct stable task space", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  let releaseExchange
  let adoptionCalls = 0
  const adoptionCanonicalUrl = "https://chatgpt.com/c/new-adoption"
  const adoptionResponse = "Distinct adoption response."
  const egoAdapter = {
    ...unusedEgoAdapter,
    adopt: async () => {
      adoptionCalls += 1
      return {
        adoptedWhileGenerating: false,
        anchor: { contentDigest: "a".repeat(64), messageId: "adoption-user" },
        canonicalUrl: adoptionCanonicalUrl,
        durationMs: 10,
        head: {
          fingerprint: "distinct-adoption-head",
          fingerprintVersion: "tail-v1",
          lastContentDigest: digest(adoptionResponse),
          lastMessageId: "distinct-adoption-assistant",
          lastRole: "assistant",
          messageCount: 2,
          renderedMessageCount: 2,
        },
        modelPolicy: modelPolicyObservation(),
        responseDigest: digest(adoptionResponse),
        responseText: adoptionResponse,
        targetId: "distinct-adoption-tab",
        taskSpaceIdentity: browserTaskSpaceIdentity("distinct-adoption"),
        taskSpaceId: 15,
      }
    },
    bind: async (input) => ({
      canonicalUrl: input.canonicalUrl,
      head: {
        fingerprint: "busy-initial-head",
        lastRole: "assistant",
        messageCount: 2,
      },
      targetId: "busy-tab",
      taskSpaceIdentity: browserTaskSpaceIdentity(String(15)),
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

  const adoption = await broker.startConversationAdoption({
    canonicalUrl: adoptionCanonicalUrl,
    taskSpace: 15,
    timeoutMs: 30_000,
  })
  const adopted = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: adoption.id })
  assert.equal(adopted.status, "succeeded")
  assert.deepEqual(adopted.result.taskSpaceIdentity, browserTaskSpaceIdentity("distinct-adoption"))
  assert.equal(adoptionCalls, 1)

  releaseExchange()
  const stopped = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: exchange.id })
  assert.equal(stopped.status, "human_required")
})

test("one stable Ego task-space identity cannot be durably bound to two conversations", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
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
      taskSpaceIdentity: {
        name: "shared-browser-workspace",
        taskId: "shared-browser-workspace",
      },
      taskSpaceId: input.taskSpace,
    }),
  }
  const broker = new Broker({ egoAdapter, store: new EventStore(dataDir) })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "task-space-first",
    canonicalUrl: "https://chatgpt.com/c/task-space-first",
    mode: "existing",
    taskSpace: 10,
  })
  await assert.rejects(
    broker.bindConversation({
      bindingKey: "task-space-second",
      canonicalUrl: "https://chatgpt.com/c/task-space-second",
      mode: "existing",
      taskSpace: 11,
    }),
    (error) => error.code === "human_required"
      && error.details?.reason === "task_space_identity_already_bound"
      && error.details?.bindingKey === "task-space-first",
  )
  assert.throws(
    () => broker.getConversationBinding({ bindingKey: "task-space-second" }),
    (error) => error.code === "binding_not_found",
  )
})

test("a live task-space identity is reserved before another binding enters browser work", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const firstIdentity = { name: "reserved-before-persist", taskId: "opaque-reserved-task" }
  let releaseFirst
  let markFirstReserved
  const firstReleased = new Promise((resolve) => {
    releaseFirst = resolve
  })
  const firstReserved = new Promise((resolve) => {
    markFirstReserved = resolve
  })
  const browserActions = []
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      bind: async (input, _signal, onResult, beforeRun) => {
        const effectiveInput = { ...input, ...beforeRun() }
        const result = {
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
          taskSpaceIdentity: firstIdentity,
          taskSpaceId: input.taskSpace,
        }
        if (input.bindingKey === "reservation-first") {
          browserActions.push(input.bindingKey)
          onResult(result)
          markFirstReserved()
          await firstReleased
          return result
        }
        const denied = effectiveInput.taskSpaceGuard.deniedIdentities.some((identity) => (
          identity.name === firstIdentity.name && identity.taskId === firstIdentity.taskId
        ))
        if (denied) {
          throw new EgoChatError("human_required", "The live task-space identity is already reserved.", {
            reason: "task_space_identity_already_bound",
          })
        }
        browserActions.push(input.bindingKey)
        return result
      },
    },
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())

  const first = broker.bindConversation({
    bindingKey: "reservation-first",
    canonicalUrl: "https://chatgpt.com/c/reservation-first",
    mode: "existing",
    taskSpace: 101,
  })
  await firstReserved
  await assert.rejects(
    broker.bindConversation({
      bindingKey: "reservation-second",
      canonicalUrl: "https://chatgpt.com/c/reservation-second",
      mode: "existing",
      taskSpace: 102,
    }),
    (error) => error.code === "human_required"
      && error.details?.reason === "task_space_identity_already_bound",
  )
  assert.deepEqual(browserActions, ["reservation-first"])
  assert.throws(
    () => broker.getConversationBinding({ bindingKey: "reservation-second" }),
    (error) => error.code === "binding_not_found",
  )

  releaseFirst()
  const persisted = await first
  assert.deepEqual(persisted.taskSpaceIdentity, firstIdentity)
})

test("unresolved adoption, bind, and legacy-migration selectors block a recycled numeric target before mutation", async (t) => {
  for (const mode of ["adoption", "bind", "legacy_migration"]) {
    const dataDir = await createDataDir()
    t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
    const canonicalUrl = `https://chatgpt.com/c/unresolved-${mode}`
    const bindingKey = `unresolved-${mode}`
    const selectorName = mode === "legacy_migration"
      ? `ego-chat-bound-${digest(`canonical-conversation\0${canonicalUrl}`).slice(0, 32)}`
      : `unresolved-selector-${mode}`
    const identity = { name: selectorName, taskId: `opaque-${mode}-task-id` }
    const responseText = `Stable ${mode} response.`
    const store = new EventStore(dataDir)
    await store.initialize()
    if (mode === "legacy_migration") {
      const now = new Date().toISOString()
      await store.persistBinding("binding.created", {
        canonicalUrl,
        createdAt: now,
        headContentDigest: digest("legacy-head"),
        headFingerprint: "legacy-head",
        headFingerprintVersion: "tail-v1",
        headMessageId: "legacy-assistant",
        headRole: "assistant",
        key: bindingKey,
        messageCount: 2,
        mode: "existing",
        modelPolicyKey: "chatgpt-web-default",
        revision: 1,
        startUrl: canonicalUrl,
        state: "bound",
        targetId: "legacy-tab",
        taskSpaceId: 77,
        updatedAt: now,
        verifiedAt: now,
      })
    }
    let releaseBrowser
    let reportEntered
    const released = new Promise((resolve) => {
      releaseBrowser = resolve
    })
    const entered = new Promise((resolve) => {
      reportEntered = resolve
    })
    let preflightMutations = 0
    const browserResult = (input) => ({
      canonicalUrl,
      head: {
        fingerprint: `head-${mode}`,
        fingerprintVersion: "tail-v1",
        lastContentDigest: digest(responseText),
        lastMessageId: `assistant-${mode}`,
        lastRole: "assistant",
        messageCount: 2,
        renderedMessageCount: 2,
      },
      targetId: `tab-${mode}`,
      taskSpaceIdentity: identity,
      taskSpaceId: input.taskSpace ?? 77,
    })
    const pauseAndReturn = async (input) => {
      reportEntered()
      await released
      return browserResult(input)
    }
    const broker = new Broker({
      egoAdapter: {
        ...unusedEgoAdapter,
        adopt: async (input) => ({
          ...await pauseAndReturn(input),
          adoptedWhileGenerating: false,
          anchor: { contentDigest: digest("user"), messageId: `user-${mode}` },
          durationMs: 10,
          modelPolicy: modelPolicyObservation(),
          responseDigest: digest(responseText),
          responseText,
        }),
        bind: pauseAndReturn,
        preflight: async (_input, _signal, beforeRun) => {
          const guard = beforeRun().taskSpaceGuard
          const reserved = guard.deniedSelectors.some((selector) => (
            ["legacy_string", "name", "task_id"].includes(selector.kind)
            && (selector.kind === "task_id" ? identity.taskId : identity.name) === selector.value
          ))
          if (reserved) {
            throw new EgoChatError("human_required", "The live numeric target matches a reserved selector.", {
              reason: "task_space_selector_reserved",
            })
          }
          preflightMutations += 1
          return { safe: true }
        },
        verify: pauseAndReturn,
      },
      store,
    })
    await broker.initialize()
    t.after(() => broker.close())

    let pending
    if (mode === "adoption") {
      pending = await broker.startConversationAdoption({
        bindingKey,
        canonicalUrl,
        taskSpace: selectorName,
        timeoutMs: 30_000,
      })
    } else if (mode === "bind") {
      pending = broker.bindConversation({
        bindingKey,
        canonicalUrl,
        mode: "existing",
        taskSpace: selectorName,
      })
    } else {
      pending = broker.verifyConversation({ bindingKey })
    }

    await entered
    try {
      await assert.rejects(
        broker.egoPreflight({ taskSpace: 77 }),
        (error) => error.code === "human_required"
          && error.details?.reason === "task_space_selector_reserved",
      )
      assert.equal(preflightMutations, 0)
    } finally {
      releaseBrowser()
    }
    if (mode === "adoption") {
      const completed = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: pending.id })
      assert.equal(completed.status, "succeeded")
    } else {
      await pending
    }
  }
})

test("public string task spaces are typed names for bind and preflight", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const guards = []
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      bind: async (input, _signal, _onResult, beforeRun) => {
        guards.push(beforeRun().taskSpaceGuard)
        return {
          canonicalUrl: input.canonicalUrl,
          head: {
            fingerprint: "named-bind-head",
            fingerprintVersion: "tail-v1",
            lastContentDigest: digest("named-bind-head"),
            lastMessageId: "named-bind-assistant",
            lastRole: "assistant",
            messageCount: 2,
          },
          targetId: "named-bind-tab",
          taskSpaceIdentity: { name: input.taskSpace, taskId: "opaque-named-bind-id" },
          taskSpaceId: 61,
        }
      },
      preflight: async (input, _signal, beforeRun) => {
        guards.push(beforeRun().taskSpaceGuard)
        return {
          safe: true,
          taskSpaceIdentity: { name: input.taskSpace, taskId: "opaque-named-preflight-id" },
          taskSpaceId: 62,
        }
      },
    },
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())

  await broker.bindConversation({
    bindingKey: "named-bind",
    canonicalUrl: "https://chatgpt.com/c/named-bind",
    mode: "existing",
    taskSpace: "named-bind-space",
  })
  await broker.egoPreflight({ taskSpace: "named-preflight-space" })

  assert.deepEqual(guards.map((guard) => guard.ownerSelector), [
    { kind: "name", value: "named-bind-space" },
    { kind: "name", value: "named-preflight-space" },
  ])
})

test("public and restored task-space selectors reject non-strings, C1 controls, and invisible formatting", async (t) => {
  const invalidPublicValues = ["bad\u0085space", "bad\u009bspace", "bad\u200bspace"]
  let browserCalls = 0
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      preflight: async () => {
        browserCalls += 1
        return { safe: true }
      },
    },
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  for (const taskSpace of invalidPublicValues) {
    await assert.rejects(
      broker.egoPreflight({ taskSpace }),
      (error) => error.code === "invalid_input",
    )
  }
  assert.equal(browserCalls, 0)

  for (const [index, taskSpace] of [undefined, null, { name: "synthetic" }].entries()) {
    const restartDir = await createDataDir()
    t.after(() => fs.rm(restartDir, { force: false, recursive: true }))
    const store = new EventStore(restartDir)
    await store.initialize()
    const canonicalUrl = `https://chatgpt.com/c/malformed-restored-selector-${index}`
    const workflow = {
      bindingKey: `malformed-restored-${index}`,
      canonicalUrlDigest: digest(canonicalUrl),
      createdAt: "2026-09-04T00:00:00.000Z",
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
      id: `42000000-0000-4000-8000-00000000000${index}`,
      kind: "conversation_adoption",
      phase: "waiting",
      private: {
        request: {
          bindingKey: `malformed-restored-${index}`,
          canonicalUrl,
          taskSpace,
          timeoutMs: 30_000,
        },
      },
      status: "running",
      updatedAt: "2026-09-04T00:00:00.000Z",
    }
    await store.persist("workflow.started", workflow)
    const restored = new Broker({
      egoAdapter: new Proxy(unusedEgoAdapter, {
        get(target, property) {
          if (typeof target[property] !== "function") return target[property]
          return async () => {
            browserCalls += 1
            throw new Error("malformed restored selectors must stop before browser work")
          }
        },
      }),
      store: new EventStore(restartDir),
    })
    await restored.initialize()
    t.after(() => restored.close())
    const stopped = restored.getWorkflow({ workflowId: workflow.id })
    assert.equal(stopped.status, "human_required")
    assert.equal(stopped.humanRequired.code, "task_space_selector_invalid")
  }
  assert.equal(browserCalls, 0)

  for (const [index, taskSpaceId] of [
    undefined,
    null,
    { name: "synthetic" },
    "bad\u0085space",
    "bad\u200bspace",
  ].entries()) {
    const restartDir = await createDataDir()
    t.after(() => fs.rm(restartDir, { force: false, recursive: true }))
    const store = new EventStore(restartDir)
    await store.initialize()
    const now = "2026-09-04T00:00:00.000Z"
    const bindingKey = `malformed-legacy-binding-${index}`
    const canonicalUrl = `https://chatgpt.com/c/${bindingKey}`
    await store.persistBinding("binding.created", {
      canonicalUrl,
      createdAt: now,
      headContentDigest: "a".repeat(64),
      headFingerprint: `malformed-legacy-head-${index}`,
      headFingerprintVersion: "tail-v1",
      headMessageId: `malformed-legacy-assistant-${index}`,
      headRole: "assistant",
      key: bindingKey,
      messageCount: 2,
      mode: "existing",
      modelPolicyKey: "chatgpt-web-default",
      revision: 1,
      startUrl: canonicalUrl,
      state: "bound",
      targetId: `malformed-legacy-tab-${index}`,
      ...(taskSpaceId === undefined ? {} : { taskSpaceId }),
      updatedAt: now,
      verifiedAt: now,
    })
    const restored = new Broker({
      egoAdapter: new Proxy(unusedEgoAdapter, {
        get(target, property) {
          if (typeof target[property] !== "function") return target[property]
          return async () => {
            browserCalls += 1
            throw new Error("malformed legacy selectors must stop before browser work")
          }
        },
      }),
      store: new EventStore(restartDir),
    })
    await restored.initialize()
    t.after(() => restored.close())
    await assert.rejects(
      restored.verifyConversation({ bindingKey }),
      (error) => error.code === "human_required"
        && error.details?.reason === "task_space_selector_invalid",
    )
  }
  assert.equal(browserCalls, 0)
})

test("restart bookkeeping keeps numeric locations distinct from typed names", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new EventStore(dataDir)
  await store.initialize()
  const now = "2026-09-05T00:00:00.000Z"
  const deadlineAt = new Date(Date.now() + 30_000).toISOString()
  const workflows = [
    {
      bindingKey: "numeric-restart-adoption",
      canonicalUrl: "https://chatgpt.com/c/numeric-restart-adoption",
      id: "43000000-0000-4000-8000-000000000001",
      taskSpace: 7,
      taskSpaceSelector: { kind: "numeric_location", value: 7 },
    },
    {
      bindingKey: "named-restart-adoption",
      canonicalUrl: "https://chatgpt.com/c/named-restart-adoption",
      id: "43000000-0000-4000-8000-000000000002",
      taskSpace: "7",
      taskSpaceSelector: { kind: "name", value: "7" },
    },
  ]
  for (const seeded of workflows) {
    await store.persist("workflow.started", {
      bindingKey: seeded.bindingKey,
      canonicalUrlDigest: digest(seeded.canonicalUrl),
      createdAt: now,
      deadlineAt,
      id: seeded.id,
      kind: "conversation_adoption",
      phase: "waiting",
      private: {
        request: {
          bindingKey: seeded.bindingKey,
          canonicalUrl: seeded.canonicalUrl,
          taskSpace: seeded.taskSpace,
          taskSpaceSelector: seeded.taskSpaceSelector,
          timeoutMs: 30_000,
        },
      },
      status: "running",
      updatedAt: now,
    })
  }

  const entered = []
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      adopt: async (input) => {
        entered.push(input.bindingKey)
        return new Promise(() => {})
      },
    },
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())

  assert.deepEqual(entered.sort(), workflows.map((workflow) => workflow.bindingKey).sort())
  for (const workflow of workflows) {
    assert.equal(broker.getWorkflow({ workflowId: workflow.id }).status, "running")
  }
})

test("a malformed durable capture still reserves its binding key and canonical URL", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const store = new EventStore(dataDir)
  await store.initialize()
  const canonicalUrl = "https://chatgpt.com/c/malformed-durable-claim"
  const bindingKey = "malformed-durable-claim"
  await store.persist("workflow.failed", {
    bindingKey,
    canonicalUrlDigest: digest(canonicalUrl),
    createdAt: "2026-09-05T00:00:00.000Z",
    error: { code: "injected_failure", message: "Injected post-capture failure." },
    id: "44000000-0000-4000-8000-000000000001",
    kind: "conversation_adoption",
    phase: "stopped",
    reconciliation: {
      adoptionCaptureClaim: {
        canonicalUrl,
        taskSpaceId: null,
        taskSpaceIdentity: { name: "incomplete" },
      },
    },
    status: "failed",
    updatedAt: "2026-09-05T00:00:01.000Z",
  })
  let browserCalls = 0
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      bind: async () => {
        browserCalls += 1
        throw new Error("a malformed durable claim must stop before browser work")
      },
    },
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())

  await assert.rejects(
    broker.bindConversation({
      bindingKey,
      canonicalUrl: "https://chatgpt.com/c/foreign-after-malformed-claim",
      mode: "existing",
      taskSpace: "foreign-after-malformed-claim",
    }),
    (error) => error.code === "human_required"
      && error.details?.reason === "binding_key_reserved",
  )
  await assert.rejects(
    broker.bindConversation({
      bindingKey: "foreign-malformed-claim-url",
      canonicalUrl,
      mode: "existing",
      taskSpace: "foreign-malformed-claim-url",
    }),
    (error) => ["conversation_reserved", "human_required"].includes(error.code),
  )
  assert.equal(browserCalls, 0)
})

test("browser results must carry canonical URL evidence except for pre-Send create-once binding", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/c/canonical-evidence-required"
  const identity = { name: "canonical-evidence-space", taskId: "canonical-evidence-task" }
  let returnCanonical = false
  let mode = "existing"
  const browserResult = (input = {}) => ({
    canonicalUrl: returnCanonical ? canonicalUrl : null,
    head: {
      fingerprint: "canonical-evidence-head",
      fingerprintVersion: "tail-v1",
      lastContentDigest: "a".repeat(64),
      lastMessageId: "canonical-evidence-assistant",
      lastRole: "assistant",
      messageCount: 2,
    },
    targetId: "canonical-evidence-tab",
    taskSpaceIdentity: input.mode === "create_once"
      ? { name: "canonical-evidence-create-once", taskId: "canonical-evidence-create-once-task" }
      : identity,
    taskSpaceId: input.mode === "create_once" ? 76 : 75,
  })
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      bind: async (input) => browserResult(input),
      verify: async () => browserResult(),
    },
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())

  const input = {
    bindingKey: "canonical-evidence",
    canonicalUrl,
    mode,
    taskSpace: identity.name,
  }
  await assert.rejects(
    broker.bindConversation(input),
    (error) => error.code === "human_required"
      && error.details?.reason === "canonical_conversation_evidence_invalid",
  )
  returnCanonical = true
  await broker.bindConversation(input)
  returnCanonical = false
  await assert.rejects(
    broker.verifyConversation({ bindingKey: input.bindingKey }),
    (error) => error.code === "human_required"
      && error.details?.reason === "canonical_conversation_evidence_invalid",
  )

  mode = "create_once"
  const created = await broker.bindConversation({
    bindingKey: "canonical-evidence-create-once",
    mode,
    startUrl: "https://chatgpt.com/",
    targetId: "canonical-evidence-new-tab",
    taskSpace: 75,
  })
  assert.equal(created.state, "unbound")
  assert.equal(created.canonicalUrl, null)
})

test("one binding key has an owner-scoped admission and is reusable after the owner fails", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  let enterFirst
  let releaseFirst
  let adoptionCalls = 0
  let calls = 0
  const entered = new Promise((resolve) => { enterFirst = resolve })
  const released = new Promise((resolve) => { releaseFirst = resolve })
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      adopt: async () => {
        adoptionCalls += 1
        throw new Error("a competing adoption must not enter browser work")
      },
      bind: async (input) => {
        calls += 1
        if (calls === 1) {
          enterFirst()
          await released
          throw new Error("injected first owner failure")
        }
        return {
          canonicalUrl: input.canonicalUrl,
          head: {
            fingerprint: "binding-key-lease-head",
            fingerprintVersion: "tail-v1",
            lastContentDigest: "b".repeat(64),
            lastMessageId: "binding-key-lease-assistant",
            lastRole: "assistant",
            messageCount: 2,
          },
          targetId: "binding-key-lease-tab",
          taskSpaceIdentity: { name: input.taskSpace, taskId: "binding-key-lease-task" },
          taskSpaceId: 76,
        }
      },
    },
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  const firstInput = {
    bindingKey: "binding-key-lease",
    canonicalUrl: "https://chatgpt.com/c/binding-key-lease-first",
    mode: "existing",
    taskSpace: "binding-key-lease-space",
  }
  const first = broker.bindConversation(firstInput)
  await entered
  await assert.rejects(
    broker.bindConversation({
      ...firstInput,
      canonicalUrl: "https://chatgpt.com/c/binding-key-lease-second",
      taskSpace: "binding-key-lease-other-space",
    }),
    (error) => error.code === "conversation_busy",
  )
  await assert.rejects(
    broker.startConversationAdoption({
      bindingKey: firstInput.bindingKey,
      canonicalUrl: "https://chatgpt.com/c/binding-key-lease-adoption",
      taskSpace: "binding-key-lease-adoption-space",
      timeoutMs: 30_000,
    }),
    (error) => error.code === "conversation_busy",
  )
  assert.equal(calls, 1)
  assert.equal(adoptionCalls, 0)
  releaseFirst()
  await assert.rejects(first, /injected first owner failure/)
  const bound = await broker.bindConversation(firstInput)
  assert.equal(bound.key, firstInput.bindingKey)
  assert.equal(calls, 2)
})

test("completed exchanges do not reclaim their binding after a later exchange advances it", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const bindingKey = "sequential-exchange-claim"
  const canonicalUrl = "https://chatgpt.com/c/sequential-exchange-claim"
  const taskSpaceIdentity = browserTaskSpaceIdentity("sequential-exchange-claim")
  let exchangeCount = 0
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      bind: async (input) => ({
        canonicalUrl: input.canonicalUrl,
        head: {
          fingerprint: "sequential-exchange-head-0",
          fingerprintVersion: "tail-v1",
          lastContentDigest: digest("sequential-exchange-response-0"),
          lastMessageId: "sequential-exchange-assistant-0",
          lastRole: "assistant",
          messageCount: 2,
        },
        targetId: "sequential-exchange-tab",
        taskSpaceIdentity,
        taskSpaceId: 77,
      }),
      sendExchange: async (input) => {
        exchangeCount += 1
        return {
          canonicalUrl,
          modelPolicy: modelPolicyObservation(),
          promptMessageId: `sequential-exchange-user-${exchangeCount}`,
          sentAt: new Date().toISOString(),
          targetId: "sequential-exchange-tab",
          taskSpaceIdentity,
          taskSpaceId: 77,
          turnMarker: input.turnMarker,
        }
      },
      captureExchange: async (input) => {
        const responseText = `sequential-exchange-response-${exchangeCount}`
        const responseDigest = digest(responseText)
        return {
          canonicalUrl,
          durationMs: 10,
          head: {
            fingerprint: `sequential-exchange-head-${exchangeCount}`,
            fingerprintVersion: "tail-v1",
            lastContentDigest: responseDigest,
            lastMessageId: `sequential-exchange-assistant-${exchangeCount}`,
            lastRole: "assistant",
            messageCount: 2 + (exchangeCount * 2),
          },
          modelPolicy: modelPolicyObservation(),
          responseDigest,
          responseText,
          targetId: "sequential-exchange-tab",
          taskSpaceIdentity,
          taskSpaceId: 77,
          turnMarker: input.turnMarker,
        }
      },
    },
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey,
    canonicalUrl,
    mode: "existing",
    taskSpace: taskSpaceIdentity.name,
  })

  for (let index = 1; index <= 3; index += 1) {
    const turnMarker = `EGO_CHAT_SEQUENTIAL_EXCHANGE_${index}`
    const started = await broker.startEgoExchange({
      bindingKey,
      expectedTerminalMarker: `SEQUENTIAL_EXCHANGE_DONE_${index}`,
      prompt: `${turnMarker}\nContinue the same durable review.`,
      timeoutMs: 30_000,
      turnMarker,
    })
    const completed = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: started.id })
    assert.equal(completed.status, "succeeded")
  }

  assert.equal(exchangeCount, 3)
})

test("a dormant legacy binding reserves its deterministic recovery name", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/c/dormant-legacy-binding"
  const recoveryName = `ego-chat-bound-${digest(`canonical-conversation\0${canonicalUrl}`).slice(0, 32)}`
  const now = new Date().toISOString()
  const store = new EventStore(dataDir)
  await store.initialize()
  await store.persistBinding("binding.created", {
    canonicalUrl,
    createdAt: now,
    headContentDigest: digest("dormant-legacy-head"),
    headFingerprint: "dormant-legacy-head",
    headFingerprintVersion: "tail-v1",
    headMessageId: "dormant-legacy-assistant",
    headRole: "assistant",
    key: "dormant-legacy",
    messageCount: 2,
    mode: "existing",
    modelPolicyKey: "chatgpt-web-default",
    revision: 1,
    startUrl: canonicalUrl,
    state: "bound",
    targetId: "dormant-legacy-tab",
    taskSpaceId: 63,
    updatedAt: now,
    verifiedAt: now,
  })
  let bindCalls = 0
  let verifyCalls = 0
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      bind: async () => {
        bindCalls += 1
        throw new Error("the dormant recovery name must be reserved before browser work")
      },
      verify: async ({ binding }, _signal, _onResult, beforeRun) => {
        verifyCalls += 1
        assert.deepEqual(beforeRun().taskSpaceGuard.ownerSelector, {
          kind: "name",
          value: recoveryName,
        })
        return {
          canonicalUrl,
          head: {
            fingerprint: binding.headFingerprint,
            fingerprintVersion: "tail-v1",
            lastContentDigest: binding.headContentDigest,
            lastMessageId: binding.headMessageId,
            lastRole: "assistant",
            messageCount: 2,
          },
          targetId: binding.targetId,
          taskSpaceIdentity: { name: recoveryName, taskId: "opaque-dormant-legacy-id" },
          taskSpaceId: 64,
        }
      },
    },
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())

  await assert.rejects(
    broker.bindConversation({
      bindingKey: "recovery-name-thief",
      canonicalUrl: "https://chatgpt.com/c/recovery-name-thief",
      mode: "existing",
      taskSpace: recoveryName,
    }),
    (error) => error.code === "task_space_already_bound",
  )
  assert.equal(bindCalls, 0)

  const migrated = await broker.verifyConversation({ bindingKey: "dormant-legacy" })
  assert.deepEqual(migrated.taskSpaceIdentity, {
    name: recoveryName,
    taskId: "opaque-dormant-legacy-id",
  })
  assert.equal(verifyCalls, 1)
})

test("one canonical conversation cannot run through two distinct task-space identities", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/g/g-p-a3k/c/shared-canonical-chat"
  const now = "2026-08-24T00:00:00.000Z"
  const seeded = new EventStore(dataDir)
  await seeded.initialize()
  for (const [index, bindingKey] of ["canonical-first", "canonical-second"].entries()) {
    await seeded.persistBinding("binding.created", {
      canonicalUrl,
      createdAt: now,
      key: bindingKey,
      modelPolicyKey: "chatgpt-web-default",
      revision: 1,
      state: "bound",
      targetId: `canonical-tab-${index}`,
      taskSpaceIdentity: browserTaskSpaceIdentity(`canonical-${index}`),
      taskSpaceId: 30 + index,
      updatedAt: now,
      verifiedAt: now,
    })
  }

  let adapterCalls = 0
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      ensureModelPolicy: async () => {
        adapterCalls += 1
        return modelPolicyObservation()
      },
    },
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())

  for (const bindingKey of ["canonical-first", "canonical-second"]) {
    await assert.rejects(
      broker.ensureModelPolicy({ bindingKey }),
      (error) => error.code === "human_required"
        && error.details?.reason === "canonical_conversation_already_bound",
    )
  }
  assert.equal(adapterCalls, 0)
})

test("recycled numeric task-space ids do not serialize different conversation identities", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const now = "2026-08-24T00:00:00.000Z"
  const seeded = new EventStore(dataDir)
  await seeded.initialize()
  for (const [index, bindingKey] of ["recycled-a3k", "recycled-people-planner"].entries()) {
    const canonicalUrl = `https://chatgpt.com/c/${bindingKey}`
    await seeded.persistBinding("binding.created", {
      canonicalUrl,
      createdAt: now,
      headContentDigest: digest(`head-${bindingKey}`),
      headFingerprint: `head-${bindingKey}`,
      headFingerprintVersion: "tail-v1",
      headMessageId: `assistant-${bindingKey}`,
      headRole: "assistant",
      key: bindingKey,
      messageCount: 2,
      mode: "existing",
      modelPolicyKey: "chatgpt-web-default",
      projectUrl: null,
      revision: 1,
      startUrl: canonicalUrl,
      state: "bound",
      targetId: `tab-${bindingKey}`,
      ...(index === 0 ? { taskSpaceIdentity: browserTaskSpaceIdentity("stable-a3k") } : {}),
      taskSpaceId: 10,
      updatedAt: now,
      verifiedAt: now,
    })
  }
  const entered = []
  let release
  const released = new Promise((resolve) => {
    release = resolve
  })
  let bothEntered
  const bothActive = new Promise((resolve) => {
    bothEntered = resolve
  })
  const egoAdapter = {
    ...unusedEgoAdapter,
    exchange: async (input) => {
      entered.push(input.binding.key)
      if (entered.length === 2) {
        bothEntered()
      }
      await released
      throw new EgoChatError("human_required", "Test exchange stopped.", {
        reason: "test_exchange_stopped",
      })
    },
  }
  const broker = new Broker({ egoAdapter, store: new EventStore(dataDir) })
  await broker.initialize()
  t.after(() => broker.close())

  const workflows = []
  for (const bindingKey of ["recycled-a3k", "recycled-people-planner"]) {
    const marker = `EGO_CHAT_${bindingKey.toUpperCase().replaceAll("-", "_")}_TEST`
    workflows.push(await broker.startEgoExchange({
      bindingKey,
      expectedTerminalMarker: `${marker}_DONE`,
      prompt: `${marker}\nreview`,
      timeoutMs: 30_000,
      turnMarker: marker,
    }))
  }

  await Promise.race([
    bothActive,
    new Promise((_, reject) => setTimeout(() => reject(new Error("both bindings did not enter")), 1_000)),
  ])
  assert.deepEqual(entered.sort(), ["recycled-a3k", "recycled-people-planner"])

  release()
  const completed = await Promise.all(workflows.map((workflow) => (
    broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: workflow.id })
  )))
  assert.ok(completed.every((workflow) => workflow.status === "human_required"))
})

test("preflight admits a recycled numeric location only after fresh live tuple comparison", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const persistedIdentity = { name: "old-space", taskId: "old-task-id" }
  const liveIdentity = { name: "new-space", taskId: "new-task-id" }
  const now = new Date().toISOString()
  const store = new EventStore(dataDir)
  await store.initialize()
  await store.persistBinding("binding.created", {
    canonicalUrl: "https://chatgpt.com/c/old-space",
    createdAt: now,
    key: "old-space",
    modelPolicyKey: "chatgpt-web-default",
    revision: 1,
    state: "bound",
    targetId: "old-tab",
    taskSpaceIdentity: persistedIdentity,
    taskSpaceId: 44,
    updatedAt: now,
    verifiedAt: now,
  })
  let observedGuard
  let mutations = 0
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      preflight: async (_input, _signal, beforeRun) => {
        observedGuard = beforeRun().taskSpaceGuard
        const conflicts = observedGuard.deniedIdentities.some((identity) => (
          identity.name === liveIdentity.name || identity.taskId === liveIdentity.taskId
        ))
        if (conflicts) {
          throw new Error("fresh live identity should be distinct")
        }
        mutations += 1
        return {
          safe: true,
          taskSpaceIdentity: liveIdentity,
          taskSpaceId: 44,
        }
      },
    },
    store,
  })
  await broker.initialize()
  t.after(() => broker.close())

  const result = await broker.egoPreflight({ taskSpace: 44 })
  assert.equal(result.safe, true)
  assert.equal(mutations, 1)
  assert.deepEqual(observedGuard.ownerSelector, { kind: "numeric_location", value: 44 })
  assert.deepEqual(observedGuard.deniedIdentities, [persistedIdentity])
})

test("stable task-space identity comparison rejects discordant tuples and permits distinct tuples", async (t) => {
  const cases = [
    {
      expectedReason: "task_space_identity_conflict",
      first: { name: "same-name", taskId: "task-one" },
      second: { name: "same-name", taskId: "task-two" },
    },
    {
      expectedReason: "task_space_identity_conflict",
      first: { name: "name-one", taskId: "same-task" },
      second: { name: "name-two", taskId: "same-task" },
    },
    {
      expectedReason: null,
      first: { name: "name-one", taskId: "task-one" },
      second: { name: "name-two", taskId: "task-two" },
    },
  ]

  for (const [index, identityCase] of cases.entries()) {
    const dataDir = await createDataDir()
    t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
    let release
    const released = new Promise((resolve) => {
      release = resolve
    })
    let enteredCount = 0
    let firstEntered
    const entered = new Promise((resolve) => {
      firstEntered = resolve
    })
    const identities = new Map([
      ["identity-first", identityCase.first],
      ["identity-second", identityCase.second],
    ])
    const egoAdapter = {
      ...unusedEgoAdapter,
      bind: async (input) => ({
        canonicalUrl: input.canonicalUrl,
        head: { fingerprint: `identity-head-${index}`, lastRole: "assistant", messageCount: 2 },
        targetId: `identity-tab-${index}`,
        taskSpaceIdentity: identities.get(input.bindingKey),
        taskSpaceId: input.taskSpace,
      }),
      ensureModelPolicy: async () => {
        enteredCount += 1
        firstEntered()
        await released
        return modelPolicyObservation()
      },
    }
    const broker = new Broker({ egoAdapter, store: new EventStore(dataDir) })
    await broker.initialize()
    t.after(() => broker.close())
    await broker.bindConversation({
      bindingKey: "identity-first",
      canonicalUrl: `https://chatgpt.com/c/identity-first-${index}`,
      mode: "existing",
      taskSpace: 20 + index,
    })
    if (identityCase.expectedReason) {
      await assert.rejects(
        broker.bindConversation({
          bindingKey: "identity-second",
          canonicalUrl: `https://chatgpt.com/c/identity-second-${index}`,
          mode: "existing",
          taskSpace: 30 + index,
        }),
        (error) => error.code === "human_required"
          && error.details?.reason === identityCase.expectedReason,
      )
      assert.throws(
        () => broker.getConversationBinding({ bindingKey: "identity-second" }),
        (error) => error.code === "binding_not_found",
      )
      continue
    }
    await broker.bindConversation({
      bindingKey: "identity-second",
      canonicalUrl: `https://chatgpt.com/c/identity-second-${index}`,
      mode: "existing",
      taskSpace: 30 + index,
    })

    const first = broker.ensureModelPolicy({ bindingKey: "identity-first" })
    await entered
    const second = broker.ensureModelPolicy({ bindingKey: "identity-second" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(enteredCount, 2)
    release()
    await first
    await second
  }
})

test("simultaneous legacy migrations reserve deterministic names and reject a shared opaque task ID", async (t) => {
  const cases = [
    {
      expectedFulfilled: 1,
      firstTaskId: "shared-migrated-task",
      secondTaskId: "shared-migrated-task",
    },
    {
      expectedFulfilled: 2,
      firstTaskId: "distinct-migrated-task-a",
      secondTaskId: "distinct-migrated-task-b",
    },
  ]
  for (const [index, identityCase] of cases.entries()) {
    const dataDir = await createDataDir()
    t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
    const seeded = new EventStore(dataDir)
    await seeded.initialize()
    const now = new Date().toISOString()
    for (const [bindingIndex, bindingKey] of ["legacy-first", "legacy-second"].entries()) {
      await seeded.persistBinding("binding.created", {
        canonicalUrl: `https://chatgpt.com/c/${bindingKey}-${index}`,
        createdAt: now,
        headContentDigest: digest(`legacy-head-${bindingKey}-${index}`),
        headFingerprint: `legacy-head-${bindingKey}-${index}`,
        headFingerprintVersion: "tail-v1",
        headMessageId: `legacy-assistant-${bindingKey}-${index}`,
        headRole: "assistant",
        key: bindingKey,
        messageCount: 2,
        mode: "existing",
        modelPolicyKey: "chatgpt-web-default",
        revision: 1,
        startUrl: `https://chatgpt.com/c/${bindingKey}-${index}`,
        state: "bound",
        targetId: `legacy-tab-${bindingKey}-${index}`,
        taskSpaceId: 90 + bindingIndex,
        updatedAt: now,
        verifiedAt: now,
      })
    }
    let entered = 0
    let release
    let bothEntered
    const released = new Promise((resolve) => {
      release = resolve
    })
    const ready = new Promise((resolve) => {
      bothEntered = resolve
    })
    const taskIds = new Map([
      ["legacy-first", identityCase.firstTaskId],
      ["legacy-second", identityCase.secondTaskId],
    ])
    const broker = new Broker({
      egoAdapter: {
        ...unusedEgoAdapter,
        verify: async ({ binding }) => {
          entered += 1
          if (entered === 2) {
            bothEntered()
          }
          await released
          return {
            canonicalUrl: binding.canonicalUrl,
            head: {
              fingerprint: binding.headFingerprint,
              fingerprintVersion: "tail-v1",
              lastContentDigest: binding.headContentDigest,
              lastMessageId: binding.headMessageId,
              lastRole: "assistant",
              messageCount: 2,
            },
            targetId: binding.targetId,
            taskSpaceIdentity: {
              name: `ego-chat-bound-${digest(`canonical-conversation\0${binding.canonicalUrl}`).slice(0, 32)}`,
              taskId: taskIds.get(binding.key),
            },
            taskSpaceId: binding.taskSpaceId,
          }
        },
      },
      store: new EventStore(dataDir),
    })
    await broker.initialize()
    t.after(() => broker.close())

    const migrations = [
      broker.verifyConversation({ bindingKey: "legacy-first" }),
      broker.verifyConversation({ bindingKey: "legacy-second" }),
    ]
    await ready
    release()
    const outcomes = await Promise.allSettled(migrations)
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled")
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected")

    assert.equal(fulfilled.length, identityCase.expectedFulfilled)
    assert.equal(rejected.length, 2 - identityCase.expectedFulfilled)
    if (rejected.length > 0) {
      assert.equal(rejected[0].reason.code, "human_required")
      assert.equal(rejected[0].reason.details?.reason, "task_space_identity_conflict")
    }
    const migratedBindings = ["legacy-first", "legacy-second"]
      .map((bindingKey) => broker.getConversationBinding({ bindingKey }))
      .filter((binding) => binding.taskSpaceIdentity)
    assert.equal(migratedBindings.length, identityCase.expectedFulfilled)
  }
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
      taskSpaceIdentity: browserTaskSpaceIdentity(String(10)),
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
        taskSpaceIdentity: browserTaskSpaceIdentity(String(10)),
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
          taskSpaceIdentity: browserTaskSpaceIdentity("10"),
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
          taskSpaceIdentity: browserTaskSpaceIdentity(String(10)),
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
        taskSpaceIdentity: browserTaskSpaceIdentity(String(10)),
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
  const taskSpaceIdentity = browserTaskSpaceIdentity("10")
  const reconciliationIdentities = [
    undefined,
    browserTaskSpaceIdentity("reconcile-drift"),
    taskSpaceIdentity,
  ]
  let reconciliationCalls = 0
  const egoAdapter = {
    bind: async (input) => ({
      canonicalUrl: null,
      targetId: input.targetId,
      taskSpaceIdentity,
      taskSpaceId: 10,
    }),
    sendExchange: async (input) => ({
      canonicalUrl,
      modelPolicy: modelPolicyObservation(),
      promptMessageId: "reconciled-prompt",
      sentAt: new Date().toISOString(),
      targetId: "reconciled-tab",
      taskSpaceIdentity,
      taskSpaceId: 10,
      turnMarker: input.turnMarker,
    }),
    captureExchange: async () => {
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
      reconciliationCalls += 1
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
        ...(reconciliationIdentities[reconciliationCalls - 1]
          ? { taskSpaceIdentity: reconciliationIdentities[reconciliationCalls - 1] }
          : {}),
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

  const bindingBeforeUnsafeResults = broker.getConversationBinding({ bindingKey: "ego-chat-main" })
  const ledgerBeforeUnsafeResults = await fs.readFile(path.join(dataDir, "events.jsonl"), "utf8")
  for (const expectedReason of ["task_space_identity_missing", "task_space_identity_changed"]) {
    await assert.rejects(
      broker.reconcileConversation({
        bindingKey: "ego-chat-main",
        workflowId: stopped.id,
      }),
      (error) => error.code === "human_required"
        && error.details?.reason === expectedReason,
    )
    assert.deepEqual(
      broker.getConversationBinding({ bindingKey: "ego-chat-main" }),
      bindingBeforeUnsafeResults,
    )
    assert.equal(
      await fs.readFile(path.join(dataDir, "events.jsonl"), "utf8"),
      ledgerBeforeUnsafeResults,
    )
  }

  await assert.rejects(
    broker.reconcileWorkflowObservation({
      bindingKey: "ego-chat-main",
      workflowId: stopped.id,
    }),
    (error) => error.code === "workflow_not_observation_reconcilable",
  )

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
  assert.equal(reconciliationCalls, 3)
})

test("cancelled confirmed create-once capture reconciles its exact first Send without resending", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const taskSpaceIdentity = browserTaskSpaceIdentity("cancelled-create-once")
  const canonicalUrl = "https://chatgpt.com/c/cancelled-create-once-recovered"
  const terminalMarker = "DONE_CANCELLED_CREATE_ONCE"
  const responseText = `Recovered acknowledgement.\n${terminalMarker}`
  let sendCalls = 0
  let reconcileCalls = 0
  let captureEntered
  const entered = new Promise((resolve) => { captureEntered = resolve })
  const store = new EventStore(dataDir)
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      bind: async (input) => ({
        canonicalUrl: null,
        targetId: input.targetId,
        taskSpaceIdentity,
        taskSpaceId: 73,
      }),
      sendExchange: async (input) => {
        sendCalls += 1
        return {
          canonicalUrl: "https://chatgpt.com/c/WEB:cancelled-create-once",
          modelPolicy: modelPolicyObservation(),
          promptMessageId: "cancelled-create-once-prompt",
          sentAt: new Date().toISOString(),
          targetId: "cancelled-create-once-tab",
          taskSpaceIdentity,
          taskSpaceId: 73,
          turnMarker: input.turnMarker,
        }
      },
      captureExchange: async (_input, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled capture")), { once: true })
        captureEntered()
      }),
      reconcile: async (input) => {
        reconcileCalls += 1
        assert.equal(input.promptMessageId, "cancelled-create-once-prompt")
        return {
          canonicalUrl,
          head: {
            fingerprint: "cancelled-create-once-after",
            fingerprintVersion: "tail-v1",
            lastContentDigest: digest(responseText),
            lastMessageId: "cancelled-create-once-assistant",
            lastRole: "assistant",
            messageCount: 2,
          },
          responseDigest: digest(responseText),
          responseText,
          targetId: "cancelled-create-once-tab",
          taskSpaceIdentity,
          taskSpaceId: 73,
          turnMarker: input.turnMarker,
        }
      },
    },
    store,
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "cancelled-create-once",
    mode: "create_once",
    startUrl: "https://chatgpt.com/",
    targetId: "cancelled-create-once-tab",
    taskSpace: 73,
  })
  const turnMarker = "EGO_CHAT_CANCELLED_CREATE_ONCE"
  const started = await broker.startEgoExchange({
    bindingKey: "cancelled-create-once",
    expectedTerminalMarker: terminalMarker,
    prompt: `${turnMarker}\nReview the checkpoint.`,
    timeoutMs: 30_000,
    turnMarker,
  })
  await entered
  await broker.cancelWorkflow({ workflowId: started.id })
  await new Promise((resolve) => globalThis.setImmediate(resolve))
  const cancelled = store.getWorkflow(started.id)
  for (const privatePatch of [
    { ...cancelled.private, send: undefined },
    { ...cancelled.private, send: { ...cancelled.private.send, promptMessageId: "wrong-prompt" } },
    { ...cancelled.private, send: { ...cancelled.private.send, targetId: "wrong-tab" } },
    { ...cancelled.private, request: { ...cancelled.private.request, receiptCapture: {} } },
  ]) {
    await store.persist("workflow.human_required", { ...cancelled, private: privatePatch })
    await assert.rejects(
      broker.reconcileConversation({ bindingKey: "cancelled-create-once", workflowId: started.id }),
      (error) => error.code === "workflow_not_reconcilable",
    )
    assert.equal(reconcileCalls, 0)
  }
  await store.persist("workflow.human_required", cancelled)
  const recovered = await broker.reconcileConversation({
    bindingKey: "cancelled-create-once",
    workflowId: started.id,
  })
  assert.equal(recovered.canonicalUrl, canonicalUrl)
  assert.equal(recovered.state, "bound")
  assert.equal(recovered.recovery.responseText, responseText)
  assert.equal(broker.getWorkflow({ workflowId: started.id }).status, "succeeded")
  assert.equal(sendCalls, 1)
  assert.equal(reconcileCalls, 1)
})

test("reconciliation rejects canonical retargeting before blob or binding persistence", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const canonicalUrl = "https://chatgpt.com/c/reconcile-canonical-transaction"
  const wrongUrl = "https://chatgpt.com/c/reconcile-canonical-transaction-wrong"
  const terminalMarker = "EGO_CHAT_RECONCILE_CANONICAL_TRANSACTION_DONE"
  const turnMarker = "EGO_CHAT_RECONCILE_CANONICAL_TRANSACTION"
  const taskSpaceIdentity = { name: "reconcile-canonical-space", taskId: "reconcile-canonical-task" }
  const initialHead = {
    fingerprint: "reconcile-canonical-before",
    fingerprintVersion: "tail-v1",
    lastContentDigest: digest("reconcile-canonical-before"),
    lastMessageId: "reconcile-canonical-assistant-before",
    lastRole: "assistant",
    messageCount: 2,
  }
  let verifyCalls = 0
  const broker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      bind: async () => ({
        canonicalUrl,
        head: initialHead,
        targetId: "reconcile-canonical-tab",
        taskSpaceIdentity,
        taskSpaceId: 69,
      }),
      exchange: async () => {
        throw new EgoChatError("human_required", "The Send confirmation is ambiguous.", {
          reason: "send_confirmation_ambiguous",
        })
      },
      reconcileBound: async (input) => {
        const responseText = terminalMarker
        return {
          canonicalUrl: wrongUrl,
          head: {
            fingerprint: "reconcile-canonical-after",
            fingerprintVersion: "tail-v1",
            lastContentDigest: digest(responseText),
            lastMessageId: "reconcile-canonical-assistant-after",
            lastRole: "assistant",
            messageCount: 4,
          },
          responseDigest: digest(responseText),
          responseText,
          targetId: "reconcile-canonical-tab",
          taskSpaceIdentity,
          taskSpaceId: 69,
          turnMarker: input.turnMarker,
        }
      },
      verify: async () => {
        verifyCalls += 1
        return {
          canonicalUrl,
          head: initialHead,
          targetId: "reconcile-canonical-tab",
          taskSpaceIdentity,
          taskSpaceId: 69,
        }
      },
    },
    store: new EventStore(dataDir),
  })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({
    bindingKey: "reconcile-canonical-transaction",
    canonicalUrl,
    mode: "existing",
    taskSpace: "reconcile-canonical-space",
  })
  const bindingBefore = broker.getConversationBinding({
    bindingKey: "reconcile-canonical-transaction",
  })
  const started = await broker.startEgoExchange({
    bindingKey: "reconcile-canonical-transaction",
    expectedTerminalMarker: terminalMarker,
    prompt: `${turnMarker}\nreview`,
    timeoutMs: 30_000,
    turnMarker,
  })
  const stopped = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: started.id })
  assert.equal(stopped.humanRequired.code, "send_confirmation_ambiguous")

  await assert.rejects(
    broker.reconcileConversation({
      bindingKey: "reconcile-canonical-transaction",
      workflowId: started.id,
    }),
    (error) => error.code === "human_required"
      && error.details?.reason === "canonical_conversation_changed",
  )
  assert.deepEqual(
    broker.getConversationBinding({ bindingKey: "reconcile-canonical-transaction" }),
    bindingBefore,
  )
  assert.deepEqual(
    await fs.readdir(path.join(dataDir, "blobs")).catch((error) => {
      if (error.code === "ENOENT") return []
      throw error
    }),
    [],
  )
  await broker.verifyConversation({ bindingKey: "reconcile-canonical-transaction" })
  assert.equal(verifyCalls, 1)
})

test("monitor observation reconciliation leaves durable and browser effects unchanged; explicit reconciliation remains exact", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const turnMarker = "EGO_CHAT_CONVERGENCE_LATE123_C1"
  const terminalMarker = "EGO_CHAT_REVIEW_DONE_LATE123"
  const prompt = `${turnMarker}\nreview\n${terminalMarker}`
  const responseText = `${terminalMarker}`
  const responseDigest = digest(responseText)
  let bindCalls = 0
  let browserOperationCalls = 0
  let reconciliationCalls = 0
  let sendCalls = 0
  const taskSpaceIdentity = { name: "bound-late-space", taskId: "bound-late-space" }
  const egoAdapter = {
    ...unusedEgoAdapter,
    bind: async (input) => {
      bindCalls += 1
      return {
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
        taskSpaceIdentity,
        taskSpaceId: 10,
      }
    },
    exchange: async () => {
      browserOperationCalls += 1
      sendCalls += 1
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
      assert.equal(input.allowDeliveryAbsent, false)
      assert.equal(input.allowTaskSpaceReclaim, true)
      assert.equal(input.allowProtocolRepairCapture, undefined)
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
        taskSpaceIdentity,
        taskSpaceId: 10,
        turnMarker,
      }
    },
  }
  const store = new EventStore(dataDir)
  const broker = new Broker({ egoAdapter, store })
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

  const workflowBeforeObservation = broker.getWorkflow({ workflowId: stopped.id })
  const bindingBeforeObservation = broker.getConversationBinding({
    bindingKey: "ego-chat-main",
  })
  const metricsBeforeObservation = store.getMetrics()
  const eventLedgerBeforeObservation = await fs.readFile(
    path.join(dataDir, "events.jsonl"),
    "utf8",
  )
  const browserOperationCallsBeforeObservation = browserOperationCalls
  const bindCallsBeforeObservation = bindCalls
  const sendCallsBeforeObservation = sendCalls

  const observed = await broker.reconcileWorkflowObservation({
    bindingKey: "ego-chat-main",
    workflowId: stopped.id,
  })
  assert.deepEqual(observed, {
    observationOnly: true,
    phase: stopped.phase,
    status: "human_required",
    workflowId: stopped.id,
  })
  assert.equal(reconciliationCalls, 0)
  assert.equal(bindCalls, bindCallsBeforeObservation)
  assert.equal(browserOperationCalls, browserOperationCallsBeforeObservation)
  assert.equal(sendCalls, sendCallsBeforeObservation)
  assert.deepEqual(broker.getWorkflow({ workflowId: stopped.id }), workflowBeforeObservation)
  assert.deepEqual(
    broker.getConversationBinding({ bindingKey: "ego-chat-main" }),
    bindingBeforeObservation,
  )
  assert.deepEqual(store.getMetrics(), metricsBeforeObservation)
  assert.equal(
    await fs.readFile(path.join(dataDir, "events.jsonl"), "utf8"),
    eventLedgerBeforeObservation,
  )

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
  assert.deepEqual(reconciled.taskSpaceIdentity, taskSpaceIdentity)
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

  const nextTurnMarker = "EGO_CHAT_POST_RECONCILIATION_SEND"
  const next = await broker.startEgoExchange({
    bindingKey: "ego-chat-main",
    expectedTerminalMarker: "EGO_CHAT_POST_RECONCILIATION_DONE",
    prompt: `${nextTurnMarker}\nreview`,
    timeoutMs: 30_000,
    turnMarker: nextTurnMarker,
  })
  const nextStopped = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: next.id })
  assert.equal(nextStopped.status, "human_required")
  assert.equal(nextStopped.humanRequired.code, "send_confirmation_ambiguous")
  assert.equal(sendCalls, 2)
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
      taskSpaceIdentity: browserTaskSpaceIdentity(String(10)),
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
  const taskSpaceIdentity = { name: "reanchor-space", taskId: "reanchor-space" }
  const reanchorIdentities = [
    undefined,
    browserTaskSpaceIdentity("reanchor-drift"),
    taskSpaceIdentity,
  ]
  const egoAdapter = {
    ...unusedEgoAdapter,
    bind: async (input) => ({
      canonicalUrl: input.canonicalUrl,
      head: initialHead,
      targetId: "reanchor-tab",
      taskSpaceIdentity,
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
        ...(reanchorIdentities[reanchorCalls - 1]
          ? { taskSpaceIdentity: reanchorIdentities[reanchorCalls - 1] }
          : {}),
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
  const bindingBeforeUnsafeResults = broker.getConversationBinding({ bindingKey: "ego-chat-main" })
  const ledgerBeforeUnsafeResults = await fs.readFile(path.join(dataDir, "events.jsonl"), "utf8")
  await assert.rejects(
    broker.reanchorConversation(input),
    (error) => error.code === "human_required"
      && error.details?.reason === "task_space_identity_missing",
  )
  assert.deepEqual(
    broker.getConversationBinding({ bindingKey: "ego-chat-main" }),
    bindingBeforeUnsafeResults,
  )
  assert.equal(await fs.readFile(path.join(dataDir, "events.jsonl"), "utf8"), ledgerBeforeUnsafeResults)
  await assert.rejects(
    broker.reanchorConversation(input),
    (error) => error.code === "human_required"
      && error.details?.reason === "task_space_identity_changed",
  )
  assert.deepEqual(
    broker.getConversationBinding({ bindingKey: "ego-chat-main" }),
    bindingBeforeUnsafeResults,
  )
  assert.equal(await fs.readFile(path.join(dataDir, "events.jsonl"), "utf8"), ledgerBeforeUnsafeResults)
  const reanchored = await broker.reanchorConversation(input)

  assert.equal(reanchored.headFingerprint, observedHead.fingerprint)
  assert.equal(reanchored.headMessageId, "external-assistant")
  assert.equal(reanchored.lastReanchorSourceWorkflowId, stopped.id)
  assert.equal(reanchored.messageCount, 4)
  assert.equal(reanchored.reanchor.changeKind, "message_appended")
  assert.equal(reanchored.revision, 2)
  assert.deepEqual(reanchored.taskSpaceIdentity, taskSpaceIdentity)
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
  assert.equal(reanchorCalls, 3)
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
      taskSpaceIdentity: browserTaskSpaceIdentity(String(10)),
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
  let reconciliationCalls = 0
  const egoAdapter = {
    ...unusedEgoAdapter,
    bind: async (input) => ({
      canonicalUrl: input.canonicalUrl,
      head: beforeHead,
      targetId: "driver-interruption-tab",
      taskSpaceIdentity: browserTaskSpaceIdentity(String(10)),
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
      reconciliationCalls += 1
      assert.equal(input.allowDeliveryAbsent, true)
      assert.equal(input.expectedPreviousContentDigest, beforeHead.lastContentDigest)
      assert.equal(input.expectedPreviousMessageId, beforeHead.lastMessageId)
      return {
        canonicalUrl: input.binding.canonicalUrl,
        deliveryState: "absent",
        head: beforeHead,
        targetId: "driver-interruption-tab",
        ...(reconciliationCalls === 1
          ? {}
          : {
              taskSpaceIdentity: reconciliationCalls === 2
                ? browserTaskSpaceIdentity("delivery-absence-drift")
                : browserTaskSpaceIdentity(String(10)),
            }),
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
      taskSpaceIdentity: browserTaskSpaceIdentity(String(10)),
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

  const ledgerBeforeUnsafeAbsence = await fs.readFile(path.join(dataDir, "events.jsonl"), "utf8")
  for (const expectedReason of ["task_space_identity_missing", "task_space_identity_changed"]) {
    await assert.rejects(
      broker.reconcileConversation({
        bindingKey: "ego-chat-main",
        workflowId: stopped.id,
      }),
      (error) => error.code === "human_required"
        && error.details?.reason === expectedReason,
    )
    assert.deepEqual(
      broker.getConversationBinding({ bindingKey: "ego-chat-main" }),
      bindingBefore,
    )
    assert.equal(
      await fs.readFile(path.join(dataDir, "events.jsonl"), "utf8"),
      ledgerBeforeUnsafeAbsence,
    )
  }

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
  assert.equal(reconciliationCalls, 3)

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
    taskSpaceIdentity: browserTaskSpaceIdentity(String(24)),
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
  let restartForeignGuard
  let firstReconciliationStarted
  const reconciliationStarted = new Promise((resolve) => {
    firstReconciliationStarted = resolve
  })
  const firstBroker = new Broker({
    egoAdapter: {
      ...unusedEgoAdapter,
      preflight: async (_input, _signal, beforeRun) => {
        restartForeignGuard = beforeRun().taskSpaceGuard
        return { safe: true }
      },
      reconcileBound: async (_input, _signal, _onResult, beforeRun) => {
        reconciliations += 1
        assert.deepEqual(beforeRun().taskSpaceGuard.ownerSelector, {
          identity: browserTaskSpaceIdentity(String(24)),
          kind: "stable_identity",
        })
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
  await firstBroker.egoPreflight({ taskSpace: 999 })
  assert.deepEqual(restartForeignGuard.deniedIdentities, [browserTaskSpaceIdentity(String(24))])
  assert.deepEqual(restartForeignGuard.deniedSelectors, [])
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
          taskSpaceIdentity: browserTaskSpaceIdentity(String(24)),
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
          taskSpaceIdentity: browserTaskSpaceIdentity(String(24)),
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
          taskSpaceIdentity: browserTaskSpaceIdentity(String(24)),
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

test("a legacy binding resumes confirmed-Send capture with the Send tuple after restart without resending", async (t) => {
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
        taskSpaceIdentity: browserTaskSpaceIdentity(String(10)),
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
        assert.deepEqual(input.binding.taskSpaceIdentity, browserTaskSpaceIdentity(String(10)))
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
          taskSpaceIdentity: browserTaskSpaceIdentity(String(10)),
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
  assert.deepEqual(committedBinding.taskSpaceIdentity, browserTaskSpaceIdentity(String(10)))
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

test("restart rejects every incomplete or conflicting post-Send identity record before browser work", async (t) => {
  const taskSpaceIdentity = { name: "restart-evidence-space", taskId: "restart-evidence-task" }
  const canonicalUrl = "https://chatgpt.com/c/restart-evidence"
  const cases = [
    {
      id: "154869d6-3548-4afb-af8e-799a1853c7e1",
      reason: "confirmed_task_space_identity_missing",
      send: {
        canonicalUrl,
        promptMessageId: "restart-evidence-user",
        sentAt: "2026-08-24T00:00:00.000Z",
        targetId: "restart-evidence-tab",
        taskSpaceId: 70,
      },
    },
    {
      id: "c4824cd6-4afe-4f82-8983-e61d75f8d63b",
      reason: "confirmed_task_space_identity_missing",
      result: { canonicalUrl },
      send: {
        canonicalUrl,
        promptMessageId: "restart-evidence-user",
        sentAt: "2026-08-24T00:00:00.000Z",
        targetId: "restart-evidence-tab",
        taskSpaceIdentity,
        taskSpaceId: 70,
      },
    },
    {
      bindingCanonicalUrl: null,
      id: "27a1563f-ecf4-4acc-8c07-c7e66d4a7408",
      reason: "canonical_conversation_changed",
      result: {
        canonicalUrl: "https://chatgpt.com/c/restart-evidence-other",
        taskSpaceIdentity,
        taskSpaceId: 70,
      },
      send: {
        canonicalUrl,
        promptMessageId: "restart-evidence-user",
        sentAt: "2026-08-24T00:00:00.000Z",
        targetId: "restart-evidence-tab",
        taskSpaceIdentity,
        taskSpaceId: 70,
      },
    },
  ]

  for (const evidenceCase of cases) {
    const dataDir = await createDataDir()
    t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
    const now = "2026-08-24T00:00:00.000Z"
    const store = new EventStore(dataDir)
    await store.initialize()
    const bindingCanonicalUrl = evidenceCase.bindingCanonicalUrl === null ? null : canonicalUrl
    const binding = {
      canonicalUrl: bindingCanonicalUrl,
      createdAt: now,
      headContentDigest: "a".repeat(64),
      headFingerprint: "restart-evidence-head",
      headFingerprintVersion: "tail-v1",
      headMessageId: "restart-evidence-assistant",
      headRole: "assistant",
      key: `restart-evidence-${evidenceCase.id.slice(0, 8)}`,
      messageCount: 2,
      mode: bindingCanonicalUrl ? "existing" : "create_once",
      modelPolicyKey: "chatgpt-web-default",
      revision: 1,
      startUrl: bindingCanonicalUrl ?? "https://chatgpt.com/",
      state: bindingCanonicalUrl ? "bound" : "unbound",
      targetId: "restart-evidence-tab",
      taskSpaceIdentity,
      taskSpaceId: 70,
      updatedAt: now,
      verifiedAt: now,
    }
    await store.persistBinding("binding.created", binding)
    const turnMarker = `EGO_CHAT_RESTART_EVIDENCE_${evidenceCase.id.slice(0, 8).toUpperCase()}`
    const workflow = {
      bindingKey: binding.key,
      createdAt: now,
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
      id: evidenceCase.id,
      inputDigest: digest(`${turnMarker}\nreview`),
      kind: "ego_exchange",
      operationKey: `exchange:${binding.key}:${turnMarker}`,
      phase: evidenceCase.result ? "response_captured" : "send_confirmed",
      private: {
        request: {
          bindingKey: binding.key,
          expectedTerminalMarker: `${turnMarker}_DONE`,
          prompt: `${turnMarker}\nreview`,
          timeoutMs: 30_000,
          turnMarker,
        },
        send: evidenceCase.send,
      },
      reconciliation: {
        beforeHead: {
          contentDigest: binding.headContentDigest,
          fingerprint: binding.headFingerprint,
          fingerprintVersion: binding.headFingerprintVersion,
          messageId: binding.headMessageId,
          role: binding.headRole,
        },
        confirmedTaskSpace: {
          canonicalUrl,
          taskSpaceIdentity,
          taskSpaceId: 70,
        },
        expectedTerminalMarker: `${turnMarker}_DONE`,
        turnMarker,
      },
      ...(evidenceCase.result ? { result: evidenceCase.result } : {}),
      status: "running",
      updatedAt: now,
    }
    await store.persist("workflow.started", workflow)
    let browserCalls = 0
    const broker = new Broker({
      egoAdapter: new Proxy(unusedEgoAdapter, {
        get(target, property) {
          if (typeof target[property] !== "function") return target[property]
          return async () => {
            browserCalls += 1
            throw new Error("invalid post-Send evidence must stop before browser work")
          }
        },
      }),
      store: new EventStore(dataDir),
    })
    await broker.initialize()
    t.after(() => broker.close())

    const stopped = broker.getWorkflow({ workflowId: workflow.id })
    assert.equal(stopped.status, "human_required")
    assert.equal(stopped.humanRequired.details?.reason, evidenceCase.reason)
    assert.equal(browserCalls, 0)
    assert.equal(broker.getConversationBinding({ bindingKey: binding.key }).revision, 1)
    assert.deepEqual(
      await fs.readdir(path.join(dataDir, "blobs")).catch((error) => {
        if (error.code === "ENOENT") return []
        throw error
      }),
      [],
    )
  }
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
          taskSpaceIdentity: browserTaskSpaceIdentity("convergence"),
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
          taskSpaceIdentity: browserTaskSpaceIdentity("convergence"),
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
        taskSpaceIdentity: browserTaskSpaceIdentity(String(10)),
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
          taskSpaceIdentity: browserTaskSpaceIdentity(String(10)),
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
          taskSpaceIdentity: browserTaskSpaceIdentity(String(10)),
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

test("committed v3-v7 store provenance remains reproducible and migratable", async (t) => {
  const fixturePath = path.join(
    import.meta.dirname,
    "fixtures",
    "a3k-legacy-attachment-state-provenance-v1.json",
  )
  const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8"))

  assert.equal(fixture.schema, "EgoA3KLegacyAttachmentStateProvenance.v1")
  assert.deepEqual(
    fixture.versions.map((entry) => entry.schema_version),
    [3, 4, 5, 6, 7],
  )

  for (const entry of fixture.versions) {
    const producerRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ego-chat-historical-store-"))
    const producerDataDir = await createDataDir()
    const storeSource = execFileSync(
      "git",
      ["show", `${entry.producer_commit}:src/store.mjs`],
      { cwd: path.join(import.meta.dirname, "..") },
    )
    assert.equal(sha256Hex(storeSource), entry.store_source_sha256)
    assert.match(storeSource.toString("utf8"), new RegExp(`schemaVersion: ${entry.schema_version}`))
    try {
      const archive = execFileSync("git", ["archive", entry.producer_commit], {
        cwd: path.join(import.meta.dirname, ".."),
        maxBuffer: 64 * 1024 * 1024,
      })
      execFileSync("tar", ["-x", "-C", producerRoot], { input: archive })
      const historicalModule = await import(
        pathToFileURL(path.join(producerRoot, "src", "store.mjs"))
      )
      const historicalStore = new historicalModule.EventStore(producerDataDir)
      await historicalStore.initialize()
      const persistedState = JSON.parse(
        await fs.readFile(path.join(producerDataDir, "state.json"), "utf8"),
      )
      assert.deepEqual(persistedState, entry.persisted_state)
      assert.deepEqual(Object.keys(persistedState).sort(), entry.empty_state_keys)
    } finally {
      await fs.rm(producerRoot, { force: true, recursive: true })
      await fs.rm(producerDataDir, { force: true, recursive: true })
    }

    const dataDir = await createDataDir()
    t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
    await fs.writeFile(
      path.join(dataDir, "state.json"),
      canonicalJsonBytes(entry.persisted_state),
      { mode: 0o600 },
    )
    const store = new EventStore(dataDir)
    await store.initialize()
    const migratedState = JSON.parse(await fs.readFile(path.join(dataDir, "state.json"), "utf8"))
    assert.equal(migratedState.schemaVersion, 9)
    assert.deepEqual(migratedState.legacyAttachmentEvidence, {})
  }
})

test("historical v5-v7 producers emit nonempty migration fixtures", async (t) => {
  const fixturePath = path.join(
    import.meta.dirname,
    "fixtures",
    "a3k-legacy-attachment-provenance-v2.json",
  )
  const fixtureBytes = await fs.readFile(fixturePath)
  const fixture = JSON.parse(fixtureBytes)
  const builder = await import(
    "./fixtures/build-a3k-legacy-attachment-provenance-v2.mjs"
  )

  assert.deepEqual(await builder.serializeA3kLegacyAttachmentProvenance(), fixtureBytes)
  assert.equal(fixture.schema, "ego-chat-a3k-legacy-attachment-provenance/v2")
  assert.deepEqual(fixture.versions.map((entry) => entry.schema_version), [5, 6, 7])

  for (const entry of fixture.versions) {
    for (const source of entry.producer_source_files) {
      const sourceBytes = execFileSync(
        "git",
        ["show", `${entry.producer_commit}:${source.path}`],
        { cwd: path.join(import.meta.dirname, "..") },
      )
      assert.equal(sha256Hex(sourceBytes), source.sha256)
    }
    const dataDir = await createDataDir()
    t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
    for (const [name, artifact] of Object.entries(entry.artifacts)) {
      const bytes = Buffer.from(artifact.base64url, "base64url")
      assert.equal(bytes.length, artifact.size_bytes)
      assert.equal(sha256Hex(bytes), artifact.sha256)
      await fs.writeFile(path.join(dataDir, name), bytes, { mode: 0o600 })
    }

    const store = new EventStore(dataDir)
    await store.initialize()
    const workflowId = entry.expected_source_workflow_id
    const quarantine = store.getLegacyAttachmentEvidence(workflowId)
    assert.ok(quarantine.source_records.attachment_intent)
    assert.ok(quarantine.source_records.external_binding)
    assert.equal(
      Boolean(quarantine.source_records.confirmed_send_identity),
      entry.schema_version >= 6,
    )
    assert.equal(
      Boolean(quarantine.source_records.confirmed_send_event),
      entry.schema_version >= 6,
    )
    assert.equal(
      Boolean(quarantine.source_records.attachment_capture),
      entry.schema_version >= 6,
    )
    assert.equal(
      Boolean(quarantine.source_records.attachment_disposition),
      entry.schema_version >= 6,
    )
    assert.equal(
      Boolean(quarantine.source_records.attachment_consumer_acknowledgement),
      entry.schema_version >= 7,
    )
    assert.equal(
      Boolean(quarantine.source_records.attachment_evidence_tombstone),
      entry.schema_version >= 7,
    )
    assert.equal(store.getAttachmentIntent(workflowId), undefined)
    assert.equal(store.getConfirmedSendIdentity(workflowId), undefined)
    assert.equal(store.getConfirmedSendEvent(workflowId), undefined)
    assert.equal(store.getAttachmentCapture(workflowId), undefined)
    assert.equal(store.getAttachmentDisposition(workflowId), undefined)
    assert.equal(store.getAttachmentConsumerAcknowledgement(workflowId), undefined)
    assert.equal(store.getAttachmentEvidenceTombstone(workflowId), undefined)
    assert.equal(
      store.getAttachmentExternalBinding(
        "a3k-manual-canary-v1",
        entry.expected_external_binding_sha256,
      ).state,
      "CONSUMED_LEGACY_RECOVERY_REQUIRED",
    )
    assert.equal(await fs.readFile(path.join(dataDir, "events.jsonl"), "utf8"), "")
    assert.equal(
      JSON.parse(await fs.readFile(path.join(dataDir, "checkpoint.json"), "utf8"))
        .schemaVersion,
      9,
    )

    const migratedStateBytes = await fs.readFile(path.join(dataDir, "state.json"))
    const migratedCheckpointBytes = await fs.readFile(path.join(dataDir, "checkpoint.json"))
    const restarted = new EventStore(dataDir)
    await restarted.initialize()
    assert.deepEqual(restarted.getLegacyAttachmentEvidence(workflowId), quarantine)
    assert.deepEqual(
      await fs.readFile(path.join(dataDir, "state.json")),
      migratedStateBytes,
    )
    assert.deepEqual(
      await fs.readFile(path.join(dataDir, "checkpoint.json")),
      migratedCheckpointBytes,
    )

    const freshWorkflowId = `77d7aa4c-423f-48ba-80ae-4a2d2d5a40${entry.schema_version}`
    const freshOperationKey = `exchange:a3k-history-reuse:EGO_CHAT_A3K_HISTORY_REUSE_${entry.schema_version}`
    const freshWorkflow = {
      bindingKey: `history-reuse-${entry.schema_version}`,
      createdAt: "2026-09-04T06:00:00.000Z",
      id: freshWorkflowId,
      inputDigest: "d".repeat(64),
      kind: "ego_exchange",
      operationKey: freshOperationKey,
      phase: "queued",
      private: {},
      status: "running",
      updatedAt: "2026-09-04T06:00:00.000Z",
    }
    const freshQualification = fakeReceiptQualification({
      consumer_signer_authorization_sha256: "c".repeat(64),
    }, {
      runtimeIdentity: {
        executable_sha256: "b".repeat(64),
        implementation_git_sha: "a".repeat(40),
        package_inventory_sha256: "9".repeat(64),
      },
      signerEnrollmentDigest: "8".repeat(64),
      signerKeyId: `ed25519-spki-sha256:${"7".repeat(64)}`,
    })
    freshWorkflow.private = {
      receiptAuthoritySnapshot: freshQualification.authoritySnapshot,
      receiptAuthoritySnapshotSha256: freshQualification.authoritySnapshotDigest,
    }
    const freshAdmission = buildAttachmentCaptureIntent({
      authorizationDigest: "c".repeat(64),
      createdAt: freshWorkflow.createdAt,
      externalBindingDigest: entry.expected_external_binding_sha256,
      operationKey: freshOperationKey,
      profile: "a3k-manual-canary-v1",
      runtimeIdentity: {
        executable_sha256: "b".repeat(64),
        implementation_git_sha: "a".repeat(40),
        package_inventory_sha256: "9".repeat(64),
      },
      signerEnrollmentDigest: "8".repeat(64),
      signerKeyId: `ed25519-spki-sha256:${"7".repeat(64)}`,
      workflowId: freshWorkflowId,
    })
    const beforeRejectedReuse = {
      binding: restarted.getAttachmentExternalBinding(
        "a3k-manual-canary-v1",
        entry.expected_external_binding_sha256,
      ),
      events: await fs.readFile(path.join(dataDir, "events.jsonl")),
      metrics: restarted.getMetrics(),
      state: await fs.readFile(path.join(dataDir, "state.json")),
      workflows: restarted.listWorkflows(),
    }
    await assert.rejects(
      restarted.persistStarted("workflow.started", freshWorkflow, {
        authoritySnapshot: freshQualification.authoritySnapshot,
        authoritySnapshotDigest: freshQualification.authoritySnapshotDigest,
        intent: freshAdmission.intent,
        intentDigest: freshAdmission.digest,
      }),
      (error) => error.code === "attachment_external_binding_consumed",
    )
    assert.deepEqual({
      binding: restarted.getAttachmentExternalBinding(
        "a3k-manual-canary-v1",
        entry.expected_external_binding_sha256,
      ),
      events: await fs.readFile(path.join(dataDir, "events.jsonl")),
      metrics: restarted.getMetrics(),
      state: await fs.readFile(path.join(dataDir, "state.json")),
      workflows: restarted.listWorkflows(),
    }, beforeRejectedReuse)
  }
})

test("interrupted legacy compaction rolls forward before restart returns", async (t) => {
  const fixture = JSON.parse(await fs.readFile(path.join(
    import.meta.dirname,
    "fixtures",
    "a3k-legacy-attachment-provenance-v2.json",
  )))
  const entry = fixture.versions.find((candidate) => candidate.schema_version === 7)
  const phases = ["state", "checkpoint", "manifest", "events", "blobs"]
  const workflowIds = [
    "96fd0f1f-b3a7-4af4-8969-81cb4eab2f01",
    "96fd0f1f-b3a7-4af4-8969-81cb4eab2f02",
    "96fd0f1f-b3a7-4af4-8969-81cb4eab2f03",
    "96fd0f1f-b3a7-4af4-8969-81cb4eab2f04",
    "96fd0f1f-b3a7-4af4-8969-81cb4eab2f05",
  ]

  for (const [index, phase] of phases.entries()) {
    const dataDir = await createDataDir()
    t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
    for (const [name, artifact] of Object.entries(entry.artifacts)) {
      await fs.writeFile(
        path.join(dataDir, name),
        Buffer.from(artifact.base64url, "base64url"),
        { mode: 0o600 },
      )
    }
    const interrupted = new EventStore(dataDir, {
      compactionFaultInjector: async (completedPhase) => {
        if (completedPhase === phase) {
          throw new Error(`injected compaction interruption after ${phase}`)
        }
      },
    })
    await assert.rejects(
      interrupted.initialize(),
      new RegExp(`injected compaction interruption after ${phase}`),
    )

    const recovered = new EventStore(dataDir)
    await recovered.initialize()
    const state = JSON.parse(await fs.readFile(path.join(dataDir, "state.json")))
    const checkpoint = JSON.parse(
      await fs.readFile(path.join(dataDir, "checkpoint.json")),
    )
    const manifest = JSON.parse(
      await fs.readFile(path.join(dataDir, "checkpoint.manifest.json")),
    )
    const quarantine = recovered.getLegacyAttachmentEvidence(
      entry.expected_source_workflow_id,
    )
    assert.equal(state.schemaVersion, 9)
    assert.deepEqual(checkpoint, state)
    assert.equal(manifest.digest, digestJson(checkpoint))
    assert.equal(manifest.nextSeq, checkpoint.nextSeq)
    assert.equal(await fs.readFile(path.join(dataDir, "events.jsonl"), "utf8"), "")
    assert.ok(quarantine.source_records_sha256)
    assert.equal(recovered.getAttachmentIntent(entry.expected_source_workflow_id), undefined)
    assert.equal(recovered.getConfirmedSendIdentity(entry.expected_source_workflow_id), undefined)
    assert.equal(recovered.getConfirmedSendEvent(entry.expected_source_workflow_id), undefined)
    assert.equal(recovered.getAttachmentCapture(entry.expected_source_workflow_id), undefined)
    assert.equal(recovered.getAttachmentDisposition(entry.expected_source_workflow_id), undefined)
    assert.equal(
      recovered.getAttachmentConsumerAcknowledgement(entry.expected_source_workflow_id),
      undefined,
    )
    assert.equal(
      recovered.getAttachmentEvidenceTombstone(entry.expected_source_workflow_id),
      undefined,
    )
    assert.equal(
      recovered.getAttachmentExternalBinding(
        "a3k-manual-canary-v1",
        entry.expected_external_binding_sha256,
      ).state,
      "CONSUMED_LEGACY_RECOVERY_REQUIRED",
    )

    const freshOperationKey = `exchange:a3k-interrupted:${phase}`
    const admission = buildAttachmentCaptureIntent({
      authorizationDigest: "c".repeat(64),
      createdAt: "2026-09-04T07:00:00.000Z",
      externalBindingDigest: entry.expected_external_binding_sha256,
      operationKey: freshOperationKey,
      profile: "a3k-manual-canary-v1",
      runtimeIdentity: {
        executable_sha256: "b".repeat(64),
        implementation_git_sha: "a".repeat(40),
        package_inventory_sha256: "9".repeat(64),
      },
      signerEnrollmentDigest: "8".repeat(64),
      signerKeyId: `ed25519-spki-sha256:${"7".repeat(64)}`,
      workflowId: workflowIds[index],
    })
    const qualification = fakeReceiptQualification({
      consumer_signer_authorization_sha256: "c".repeat(64),
    }, {
      runtimeIdentity: admission.intent.qualified_runtime_identity,
      signerEnrollmentDigest: admission.intent.signer_enrollment_sha256,
      signerKeyId: admission.intent.signer_key_id,
    })
    await assert.rejects(
      recovered.persistStarted("workflow.started", {
        bindingKey: `interrupted-${phase}`,
        createdAt: "2026-09-04T07:00:00.000Z",
        id: workflowIds[index],
        inputDigest: "d".repeat(64),
        kind: "ego_exchange",
        operationKey: freshOperationKey,
        phase: "queued",
        private: {
          receiptAuthoritySnapshot: qualification.authoritySnapshot,
          receiptAuthoritySnapshotSha256: qualification.authoritySnapshotDigest,
        },
        status: "running",
        updatedAt: "2026-09-04T07:00:00.000Z",
      }, {
        authoritySnapshot: qualification.authoritySnapshot,
        authoritySnapshotDigest: qualification.authoritySnapshotDigest,
        intent: admission.intent,
        intentDigest: admission.digest,
      }),
      (error) => error.code === "attachment_external_binding_consumed",
    )

    const restarted = new EventStore(dataDir)
    await restarted.initialize()
    assert.deepEqual(
      restarted.getLegacyAttachmentEvidence(entry.expected_source_workflow_id),
      quarantine,
    )
    assert.equal(await fs.readFile(path.join(dataDir, "events.jsonl"), "utf8"), "")
  }
})

test("interrupted compaction reconciles referenced and orphan blob inventory", async (t) => {
  const phases = ["state", "checkpoint", "manifest", "events", "blobs"]
  for (const [index, phase] of phases.entries()) {
    const dataDir = await createDataDir()
    t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
    const options = {
      maxBlobBytes: 1_024,
      maxEvents: 1,
      rawRetentionMs: 30 * 24 * 60 * 60 * 1_000,
    }
    const seed = new EventStore(dataDir, options)
    await seed.initialize()
    const referencedBody = `pending attachment recovery body ${phase}`
    const referenced = await seed.putBlob(referencedBody)
    const now = "2026-09-04T07:30:00.000Z"
    const workflow = {
      createdAt: now,
      id: `a9f39cf8-c522-4915-910d-3f778859cb0${index}`,
      kind: "ego_exchange",
      phase: "awaiting_attachment_capture",
      result: {
        responseDigest: digest(referencedBody),
        responseRef: referenced,
      },
      status: "human_required",
      updatedAt: now,
    }
    await seed.persist("workflow.human_required", workflow)

    const orphanBody = Buffer.from(`orphaned compaction body ${phase}`)
    const orphanDigest = digest(orphanBody)
    const orphanDirectory = path.join(dataDir, "blobs", "sha256", orphanDigest.slice(0, 2))
    const orphanPath = path.join(orphanDirectory, orphanDigest)
    assert.ok(referenced.sizeBytes + orphanBody.length < options.maxBlobBytes)

    await fs.rm(path.join(dataDir, "checkpoint.manifest.json"))
    let orphanSeededAfterStartupReconciliation = false
    const interrupted = new EventStore(dataDir, {
      ...options,
      compactionFaultInjector: async (completedPhase) => {
        if (completedPhase === "before_state") {
          await fs.mkdir(orphanDirectory, { mode: 0o700, recursive: true })
          await fs.writeFile(orphanPath, orphanBody, { mode: 0o600 })
          orphanSeededAfterStartupReconciliation = true
        }
        if (completedPhase === phase) {
          throw new Error(`injected blob compaction interruption after ${phase}`)
        }
      },
    })
    await assert.rejects(
      interrupted.initialize(),
      new RegExp(`injected blob compaction interruption after ${phase}`),
    )
    assert.equal(orphanSeededAfterStartupReconciliation, true)

    const recovered = new EventStore(dataDir, options)
    await recovered.initialize()
    assert.equal(
      (await recovered.readBlob(referenced, { maxBytes: 1_024, offset: 0 })).text,
      referencedBody,
    )
    await assert.rejects(
      fs.stat(orphanPath),
      (error) => error.code === "ENOENT",
    )
    assert.equal(recovered.getWorkflow(workflow.id).status, "human_required")
    assert.equal(recovered.getMetrics().blobBytes, referenced.sizeBytes)
    assert.equal(recovered.getMetrics().protectedBlobBytes, referenced.sizeBytes)

    const durableSnapshot = {
      blob: await fs.readFile(path.join(
        dataDir,
        "blobs",
        "sha256",
        referenced.digest.slice(0, 2),
        referenced.digest,
      )),
      checkpoint: await fs.readFile(path.join(dataDir, "checkpoint.json")),
      events: await fs.readFile(path.join(dataDir, "events.jsonl")),
      manifest: await fs.readFile(path.join(dataDir, "checkpoint.manifest.json")),
      state: await fs.readFile(path.join(dataDir, "state.json")),
    }
    const restarted = new EventStore(dataDir, options)
    await restarted.initialize()
    assert.deepEqual({
      blob: await fs.readFile(path.join(
        dataDir,
        "blobs",
        "sha256",
        referenced.digest.slice(0, 2),
        referenced.digest,
      )),
      checkpoint: await fs.readFile(path.join(dataDir, "checkpoint.json")),
      events: await fs.readFile(path.join(dataDir, "events.jsonl")),
      manifest: await fs.readFile(path.join(dataDir, "checkpoint.manifest.json")),
      state: await fs.readFile(path.join(dataDir, "state.json")),
    }, durableSnapshot)
  }
})

test("referenced blob inventory fails closed on identity, layout, and content drift", async (t) => {
  const cases = [
    "missing",
    "truncated",
    "same-size-rewrite",
    "declared-size-mismatch",
    "misplaced-reference",
    "duplicate-reference",
    "symlink",
    "hardlink",
    "fifo",
    "directory",
    "socket",
    "root-mode",
    "prefix-mode",
    "inode-replacement",
  ]

  for (const [index, corruption] of cases.entries()) {
    const dataDir = await createDataDir()
    t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
    const options = { maxBlobBytes: 1_024, maxEvents: 1 }
    const seed = new EventStore(dataDir, options)
    await seed.initialize()
    const body = `protected inventory body ${corruption}`
    const reference = await seed.putBlob(body)
    const workflow = {
      createdAt: "2026-09-05T01:00:00.000Z",
      id: `c2d48761-8d55-4466-a0a2-58a21f467${String(index).padStart(3, "0")}`,
      kind: "ego_exchange",
      phase: "awaiting_attachment_capture",
      result: {
        responseDigest: reference.digest,
        responseRef: reference,
      },
      status: "human_required",
      updatedAt: "2026-09-05T01:00:00.000Z",
    }
    await seed.persist("workflow.human_required", workflow)

    const blobRoot = path.join(dataDir, "blobs", "sha256")
    const prefixDirectory = path.join(blobRoot, reference.digest.slice(0, 2))
    const blobPath = path.join(prefixDirectory, reference.digest)
    const otherPrefix = reference.digest.startsWith("ff") ? "00" : "ff"
    const misplacedDirectory = path.join(blobRoot, otherPrefix)
    const misplacedPath = path.join(misplacedDirectory, reference.digest)
    let closeSocket = async () => {}
    let replacementTriggered = corruption !== "inode-replacement"

    if (corruption === "missing") {
      await fs.rm(blobPath)
    } else if (corruption === "truncated") {
      await fs.writeFile(blobPath, body.slice(1), { mode: 0o600 })
    } else if (corruption === "same-size-rewrite") {
      await fs.writeFile(blobPath, "x".repeat(Buffer.byteLength(body)), { mode: 0o600 })
    } else if (corruption === "declared-size-mismatch") {
      for (const stateName of ["state.json", "checkpoint.json"]) {
        const statePath = path.join(dataDir, stateName)
        const state = JSON.parse(await fs.readFile(statePath, "utf8"))
        state.workflows[workflow.id].result.responseRef.sizeBytes += 1
        await fs.writeFile(statePath, JSON.stringify(state), { mode: 0o600 })
      }
      const checkpoint = JSON.parse(
        await fs.readFile(path.join(dataDir, "checkpoint.json"), "utf8"),
      )
      const manifestPath = path.join(dataDir, "checkpoint.manifest.json")
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"))
      manifest.digest = digestJson(checkpoint)
      await fs.writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 })
    } else if (corruption === "misplaced-reference") {
      await fs.mkdir(misplacedDirectory, { mode: 0o700 })
      await fs.rename(blobPath, misplacedPath)
    } else if (corruption === "duplicate-reference") {
      await fs.mkdir(misplacedDirectory, { mode: 0o700 })
      await fs.copyFile(blobPath, misplacedPath)
    } else if (corruption === "symlink") {
      const target = path.join(dataDir, "blob-symlink-target")
      await fs.writeFile(target, body, { mode: 0o600 })
      await fs.rm(blobPath)
      await fs.symlink(target, blobPath)
    } else if (corruption === "hardlink") {
      await fs.link(blobPath, path.join(dataDir, "blob-hardlink"))
    } else if (corruption === "fifo") {
      await fs.rm(blobPath)
      execFileSync("mkfifo", [blobPath])
    } else if (corruption === "directory") {
      await fs.rm(blobPath)
      await fs.mkdir(blobPath, { mode: 0o700 })
    } else if (corruption === "socket") {
      const net = await import("node:net")
      await fs.rm(blobPath)
      const server = net.createServer()
      const shortSocketPath = path.join("/tmp", `ego-blob-${process.pid}-${index}.sock`)
      await fs.rm(shortSocketPath, { force: true })
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(shortSocketPath, resolve)
      })
      await fs.rename(shortSocketPath, blobPath)
      closeSocket = async () => {
        await new Promise((resolve) => server.close(resolve))
        await fs.rm(shortSocketPath, { force: true })
      }
    } else if (corruption === "root-mode") {
      await fs.chmod(blobRoot, 0o755)
    } else if (corruption === "prefix-mode") {
      await fs.chmod(prefixDirectory, 0o755)
    }

    const replayed = new EventStore(dataDir, {
      ...options,
      compactionFaultInjector: async (phase) => {
        if (corruption === "inode-replacement" && phase === "blob_read") {
          await fs.rm(blobPath)
          await fs.writeFile(blobPath, body, { mode: 0o600 })
          replacementTriggered = true
        }
      },
    })
    try {
      await assert.rejects(
        replayed.initialize(),
        (error) => error.code === "corrupt_result_blob_inventory",
      )
      assert.equal(replacementTriggered, true)
    } finally {
      await closeSocket()
    }
  }
})

test("blob reconciliation closes mutations after root and prefix enumeration", async (t) => {
  const injectionPoints = [
    "after_blob_root_enumeration",
    "after_blob_prefix_enumeration",
  ]
  for (const injectionPoint of injectionPoints) {
    const dataDir = await createDataDir()
    t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
    const options = { maxBlobBytes: 1_024, maxEvents: 1 }
    const seed = new EventStore(dataDir, options)
    await seed.initialize()
    const body = `protected inventory body ${injectionPoint}`
    const reference = await seed.putBlob(body)
    const now = "2026-09-05T02:00:00.000Z"
    const workflow = {
      createdAt: now,
      id: `d2d48761-8d55-4466-a0a2-${digest(injectionPoint).slice(0, 12)}`,
      kind: "ego_exchange",
      phase: "awaiting_attachment_capture",
      result: { responseDigest: reference.digest, responseRef: reference },
      status: "human_required",
      updatedAt: now,
    }
    await seed.persist("workflow.human_required", workflow)

    const blobRoot = path.join(dataDir, "blobs", "sha256")
    const referencePrefix = reference.digest.slice(0, 2)
    const orphanBody = Buffer.from(`late orphan ${injectionPoint}`)
    const orphanDigest = digest(orphanBody)
    const orphanPrefix = injectionPoint === "after_blob_root_enumeration"
      ? (referencePrefix === "ff" ? "00" : "ff")
      : referencePrefix
    const orphanDirectory = path.join(blobRoot, orphanPrefix)
    const orphanPath = path.join(orphanDirectory, orphanDigest)
    let injected = false
    const recovered = new EventStore(dataDir, {
      ...options,
      compactionFaultInjector: async (phase, context) => {
        if (injected || phase !== injectionPoint) return
        if (
          phase === "after_blob_prefix_enumeration"
          && context?.prefix !== referencePrefix
        ) return
        await fs.mkdir(orphanDirectory, { mode: 0o700, recursive: true })
        await fs.writeFile(orphanPath, orphanBody, { mode: 0o600 })
        injected = true
      },
    })

    await recovered.initialize()
    assert.equal(injected, true)
    await assert.rejects(fs.stat(orphanPath), (error) => error.code === "ENOENT")
    assert.equal(
      (await recovered.readBlob(reference, { maxBytes: 1_024, offset: 0 })).text,
      body,
    )
    assert.equal(recovered.getMetrics().blobBytes, reference.sizeBytes)
    assert.equal(recovered.getMetrics().protectedBlobBytes, reference.sizeBytes)
    assert.deepEqual(await fs.readdir(blobRoot), [referencePrefix])
    assert.deepEqual(
      await fs.readdir(path.join(blobRoot, referencePrefix)),
      [reference.digest],
    )

    const durableSnapshot = {
      blob: await fs.readFile(path.join(blobRoot, referencePrefix, reference.digest)),
      checkpoint: await fs.readFile(path.join(dataDir, "checkpoint.json")),
      events: await fs.readFile(path.join(dataDir, "events.jsonl")),
      manifest: await fs.readFile(path.join(dataDir, "checkpoint.manifest.json")),
      state: await fs.readFile(path.join(dataDir, "state.json")),
    }

    const restarted = new EventStore(dataDir, options)
    await restarted.initialize()
    assert.equal(restarted.getMetrics().blobBytes, reference.sizeBytes)
    assert.equal(restarted.getMetrics().protectedBlobBytes, reference.sizeBytes)
    assert.deepEqual({
      blob: await fs.readFile(path.join(blobRoot, referencePrefix, reference.digest)),
      checkpoint: await fs.readFile(path.join(dataDir, "checkpoint.json")),
      events: await fs.readFile(path.join(dataDir, "events.jsonl")),
      manifest: await fs.readFile(path.join(dataDir, "checkpoint.manifest.json")),
      state: await fs.readFile(path.join(dataDir, "state.json")),
    }, durableSnapshot)
  }
})

test("orphan quarantine never silently deletes a replacement inode", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
  const seed = new EventStore(dataDir, { maxBlobBytes: 1_024, maxEvents: 1 })
  await seed.initialize()
  const orphanBody = Buffer.from("orphan pending quarantine")
  const orphanDigest = digest(orphanBody)
  const orphanDirectory = path.join(
    dataDir,
    "blobs",
    "sha256",
    orphanDigest.slice(0, 2),
  )
  const orphanPath = path.join(orphanDirectory, orphanDigest)
  await fs.mkdir(orphanDirectory, { mode: 0o700, recursive: true })
  await fs.writeFile(orphanPath, orphanBody, { mode: 0o600 })

  const replacement = Buffer.from("replacement inode retained")
  let replaced = false
  const recovered = new EventStore(dataDir, {
    maxBlobBytes: 1_024,
    maxEvents: 1,
    compactionFaultInjector: async (phase, context) => {
      if (replaced || phase !== "before_orphan_quarantine") return
      assert.equal(context?.filePath, orphanPath)
      await fs.rm(orphanPath)
      await fs.writeFile(orphanPath, replacement, { mode: 0o600 })
      replaced = true
    },
  })

  await assert.rejects(
    recovered.initialize(),
    (error) => error.code === "corrupt_result_blob_inventory",
  )
  assert.equal(replaced, true)
  await assert.rejects(fs.stat(orphanPath), (error) => error.code === "ENOENT")
  const quarantineDirectory = path.join(dataDir, "blob-quarantine")
  const quarantined = await fs.readdir(quarantineDirectory)
  assert.equal(quarantined.length, 1)
  assert.ok((await fs.readFile(path.join(quarantineDirectory, quarantined[0])))
    .equals(replacement))

  const restarted = new EventStore(dataDir, { maxBlobBytes: 1_024, maxEvents: 1 })
  await assert.rejects(
    restarted.initialize(),
    (error) => error.code === "corrupt_result_blob_inventory",
  )
})

test("orphan quarantine root remains descriptor-pinned across pathname replacement", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
  const seed = new EventStore(dataDir, { maxBlobBytes: 1_024, maxEvents: 1 })
  await seed.initialize()
  const orphanBody = Buffer.from("orphan retained after quarantine root replacement")
  const orphanDigest = digest(orphanBody)
  const orphanDirectory = path.join(
    dataDir,
    "blobs",
    "sha256",
    orphanDigest.slice(0, 2),
  )
  const orphanPath = path.join(orphanDirectory, orphanDigest)
  await fs.mkdir(orphanDirectory, { mode: 0o700, recursive: true })
  await fs.writeFile(orphanPath, orphanBody, { mode: 0o600 })
  const quarantinePath = path.join(dataDir, "blob-quarantine")
  const pinnedPath = path.join(dataDir, "blob-quarantine-pinned")
  let replaced = false
  const recovered = new EventStore(dataDir, {
    maxBlobBytes: 1_024,
    maxEvents: 1,
    compactionFaultInjector: async (phase) => {
      if (replaced || phase !== "before_orphan_quarantine") return
      await fs.rename(quarantinePath, pinnedPath)
      await fs.mkdir(quarantinePath, { mode: 0o700 })
      replaced = true
    },
  })

  await assert.rejects(
    recovered.initialize(),
    (error) => error.code === "corrupt_result_blob_inventory",
  )
  assert.equal(replaced, true)
  assert.deepEqual(await fs.readdir(pinnedPath), [])
  const replacementEntries = await fs.readdir(quarantinePath)
  assert.equal(replacementEntries.length, 1)
  assert.ok((await fs.readFile(path.join(quarantinePath, replacementEntries[0])))
    .equals(orphanBody))
})
