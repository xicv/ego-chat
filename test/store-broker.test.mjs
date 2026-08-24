import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { Broker } from "../src/broker.mjs"
import { EgoChatError } from "../src/errors.mjs"
import { EventStore } from "../src/store.mjs"

const OPENAI_LIKE_TEST_TOKEN = `sk-proj-${"A".repeat(26)}123456`

async function createDataDir() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ego-chat-store-test-"))
  await fs.chmod(dataDir, 0o700)
  return dataDir
}

const unusedEgoAdapter = {
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
    this.turns = 0
  }

  async close() {
    this.closed = true
  }

  async connect() {}

  async runStructuredTurn(input) {
    this.turns += 1
    this.additionalContexts.push(input.additionalContext ?? null)
    return {
      durationMs: 10,
      responseDigest: String(this.turns).repeat(64),
      turnId: `codex-turn-${this.turns}`,
      value: this.candidateFactory(this.turns),
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
        return {
          canonicalUrl: input.binding.canonicalUrl,
          durationMs: 20,
          head: {
            fingerprint: `convergence-head-${exchanges}`,
            lastRole: "assistant",
            messageCount: 2 + exchanges * 2,
          },
          modelPolicy: modelPolicyObservation(),
          responseText: `${JSON.stringify(review)}\n${input.expectedTerminalMarker}`,
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
  const canonicalUrl = "https://chatgpt.com/c/gate0-conversation"
  const egoAdapter = {
    bind: async (input) => ({
      canonicalUrl: null,
      targetId: input.targetId,
      taskSpaceId: 10,
    }),
    exchange: async (input) => {
      seenBindingStates.push({
        canonicalUrl: input.binding.canonicalUrl,
        state: input.binding.state,
      })
      return {
        canonicalUrl,
        durationMs: 75_000,
        head: {
          fingerprint: `head-${seenBindingStates.length}`,
          lastRole: "assistant",
          messageCount: seenBindingStates.length * 2,
        },
        modelPolicy: modelPolicyObservation(),
        responseText: input.expectedTerminalMarker,
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
    const workflow = await broker.startEgoExchange({
      bindingKey: "ego-chat-main",
      expectedTerminalMarker: `DONE_${suffix}`,
      prompt: `${turnMarker}\nreview`,
      timeoutMs: 30_000,
      turnMarker,
    })
    const completed = await broker.awaitWorkflow({ timeoutMs: 2_000, workflowId: workflow.id })
    assert.equal(completed.status, "succeeded")
    assert.equal(completed.result.canonicalUrl, canonicalUrl)
  }

  assert.deepEqual(seenBindingStates, [
    { canonicalUrl: null, state: "unbound" },
    { canonicalUrl, state: "bound" },
  ])
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
  const egoAdapter = {
    bind: async (input) => ({ canonicalUrl: null, targetId: input.targetId, taskSpaceId: 10 }),
    exchange: async () => {
      throw new EgoChatError(
        "human_required",
        "Canonical URL appeared late.",
        { reason: "canonical_conversation_missing" },
      )
    },
    preflight: async () => {
      throw new Error("not expected")
    },
    reconcile: async ({ inputDigest }) => {
      assert.match(inputDigest, /^[a-f0-9]{64}$/)
      return {
        canonicalUrl,
        head: { fingerprint: "reconciled-head", lastRole: "assistant", messageCount: 2 },
        targetId: "reconciled-tab",
        taskSpaceId: 10,
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
    expectedTerminalMarker: "DONE_RECONCILE123",
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
})

test("a bound late send reconciles only one exact tail-anchored workflow pair", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const turnMarker = "EGO_CHAT_CONVERGENCE_LATE123_C1"
  const terminalMarker = "EGO_CHAT_REVIEW_DONE_LATE123"
  const prompt = `${turnMarker}\nreview\n${terminalMarker}`
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
          lastContentDigest: "b".repeat(64),
          lastMessageId: "late-assistant",
          lastRole: "assistant",
          messageCount: 5,
          renderedMessageCount: 5,
        },
        responseText: `${terminalMarker}`,
        targetId: "bound-tab",
        taskSpaceId: 10,
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
  assert.equal(broker.getWorkflow({ workflowId: stopped.id }).status, "human_required")
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
