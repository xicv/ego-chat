import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { Broker } from "../src/broker.mjs"
import { EgoChatError } from "../src/errors.mjs"
import { EventStore } from "../src/store.mjs"

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

function createConvergenceEgoAdapter(reviewFactory) {
  let exchanges = 0
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
        assert.equal(input.modelPolicy.modelSelection, "strongest_available")
        assert.equal(input.modelPolicy.thinkingEffort, "maximum_available")
        const review = reviewFactory(parseConvergenceIdentity(input.prompt), exchanges)
        const responseText = `${JSON.stringify(review)}\n${input.expectedTerminalMarker}`
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
  }
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
        { evidence: "The target digest is exact.", id: "AC-1", status: "pass" },
        {
          evidence: settled ? "The second cycle resolved the review." : "Another cycle is required.",
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
  assert.equal(appServer.closed, true)
  assert.equal(broker.getConversationBinding({ bindingKey: "ego-chat-main" }).revision, 3)
  assert.equal(broker.getModelPolicy().revision, 2)
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

test("convergence stops before ChatGPT after two Codex turns without workspace activity", async (t) => {
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
      workspaceActivity: { count: 0, types: [] },
    }
  }
  const ego = createConvergenceEgoAdapter(() => {
    throw new Error("an uninspected candidate must not reach ChatGPT")
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
  const stopped = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(stopped.status, "human_required")
  assert.equal(stopped.humanRequired.code, "codex_workspace_not_inspected")
  assert.equal(stopped.codexInspectionRetryCount, 1)
  assert.equal(appServer.turns, 2)
  assert.equal(ego.exchanges, 0)
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

test("convergence rejects an App Server exit whose turn identity changed", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const appServer = new FakeConvergenceAppServer()
  appServer.runStructuredTurn = async (input) => {
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
  const ego = createConvergenceEgoAdapter(() => {
    throw new Error("a mismatched App Server turn must not reach ChatGPT")
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
    canonicalUrl: "https://chatgpt.com/c/convergence-app-server-identity-change-test",
    mode: "existing",
    taskSpace: 10,
  })

  const started = await broker.startConvergence({
    acceptanceCriteria: ["The exact accepted App Server turn remains bound."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Reject a transport exit that reports a different turn identity.",
  })
  const stopped = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(stopped.status, "human_required")
  assert.equal(stopped.humanRequired.code, "app_server_exited")
  assert.equal(stopped.humanRequired.diagnostic.turnId, "codex-different-turn")
  assert.equal(stopped.appServerRecoveryCount, 0)
  assert.equal(ego.exchanges, 0)
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

test("convergence bounds consecutive pre-review App Server exits without browser delivery", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const clients = Array.from({ length: 5 }, (_, index) => {
    const client = new FakeConvergenceAppServer()
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
    if (index > 0) {
      client.recoverStructuredTurn = async (threadId, turnId) => {
        assert.equal(threadId, "codex-convergence-thread")
        assert.equal(turnId, `codex-interrupted-turn-${index}`)
        return { disposition: "retry", status: "interrupted" }
      }
    }
    return client
  })
  const ego = createConvergenceEgoAdapter(() => {
    throw new Error("an exhausted App Server recovery budget must not reach ChatGPT")
  })
  const broker = new Broker({
    appServerFactory: () => clients.shift(),
    egoAdapter: ego.adapter,
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
    acceptanceCriteria: ["Identity is bound.", "Runaway detached retries are bounded."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Stop detached recovery after repeated exits without candidate progress.",
  })
  const stopped = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(stopped.status, "human_required")
  assert.equal(stopped.humanRequired.code, "app_server_recovery_exhausted")
  assert.equal(stopped.humanRequired.diagnostic.consecutiveExitCount, 5)
  assert.equal(stopped.humanRequired.diagnostic.recoveryLimit, 4)
  assert.equal(stopped.humanRequired.diagnostic.turnId, "codex-interrupted-turn-5")
  assert.equal(stopped.appServerRecoveryCount, 4)
  assert.equal(ego.exchanges, 0)
})

test("convergence blocks a secret-bearing review packet before browser submission", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const appServer = new FakeConvergenceAppServer(() => convergenceCandidate(
    1,
    `Unsafe token ${OPENAI_LIKE_TEST_TOKEN} must not leave the broker.`,
  ))
  const ego = createConvergenceEgoAdapter(() => {
    throw new Error("secret-bearing packet must not reach ChatGPT")
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
  const stopped = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(stopped.status, "human_required")
  assert.equal(stopped.humanRequired.code, "review_packet_secret_detected")
  assert.equal(ego.exchanges, 0)
})

test("convergence detects repeated candidate and review state instead of looping forever", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const repeatedCandidate = convergenceCandidate(1, "The unchanged candidate packet.")
  const appServer = new FakeConvergenceAppServer(() => repeatedCandidate)
  const ego = createConvergenceEgoAdapter((identity) => ({
    ...identity,
    criteria: [
      { evidence: "Identity remains correct.", id: "AC-1", status: "pass" },
      { evidence: "The same unresolved issue remains.", id: "AC-2", status: "fail" },
    ],
    decision: "continue",
    findings: [{
      action: "Supply evidence that changes the candidate state.",
      id: "B-STAGNANT",
      severity: "blocking",
      title: "Candidate did not change",
    }],
    summary: "The same blocking state remains.",
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
    target: "Stop if neither side changes the review state.",
  })
  const stopped = await broker.awaitWorkflow({ timeoutMs: 5_000, workflowId: started.id })

  assert.equal(stopped.status, "human_required")
  assert.equal(stopped.humanRequired.code, "convergence_stagnated")
  assert.equal(appServer.turns, 2)
  assert.equal(ego.exchanges, 2)
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
  const broker = new Broker({
    appServerFactory: () => appServer,
    egoAdapter: {
      ...unusedEgoAdapter,
      bind: async (input) => ({
        canonicalUrl: input.canonicalUrl,
        head: { fingerprint: "lease-head", lastRole: "assistant", messageCount: 2 },
        targetId: "lease-tab",
        taskSpaceId: 10,
      }),
    },
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
  assert.equal(stopped.humanRequired.code, "codex_reported_blocked")
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
  const egoAdapter = {
    ...unusedEgoAdapter,
    bind: async (input) => ({
      canonicalUrl: input.canonicalUrl,
      head: beforeHead,
      targetId: "driver-interruption-tab",
      taskSpaceId: 10,
    }),
    exchange: async () => {
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

test("running convergence fails closed after broker restart", async (t) => {
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
