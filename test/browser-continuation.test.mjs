import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { Broker } from "../src/broker.mjs"
import { EventStore } from "../src/store.mjs"

const sha = (text) => createHash("sha256").update(text).digest("hex")
const canonicalUrl = "https://chatgpt.com/c/terminal-fixture"
const turnMarker = "EGO_CHAT_PROVIDER_TERMINAL_TEST"
const terminalMarker = "EGO_CHAT_PROVIDER_TERMINAL_DONE"
const location = {
  canonicalUrl,
  targetId: "terminal-tab",
  taskSpaceId: 901,
  taskSpaceIdentity: { name: "terminal-space", taskId: "terminal-space-task" },
}
const modelPolicy = {
  adjusted: false,
  effortLabel: "Pro",
  key: "chatgpt-web-default",
  modelLabel: "GPT-6 Astra",
  pillLabel: "Pro",
  powerLevel: 5,
  powerMax: 5,
}

async function fixture(t, { kind = "conversation_exhausted", alter = (value) => value, createOnce = false, provisionalSend = false } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ego-chat-continuation-"))
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }))
  let sends = 0
  let captures = 0
  const adapter = {
    bind: async () => createOnce ? ({ ...location, canonicalUrl: null }) : ({
      ...location,
      head: {
        fingerprint: sha("before"), fingerprintVersion: "tail-v1",
        lastContentDigest: sha("before"), lastMessageId: "before-assistant",
        lastRole: "assistant", messageCount: 2,
      },
    }),
    sendExchange: async () => {
      sends += 1
      return { ...location, ...(provisionalSend ? { canonicalUrl: "https://chatgpt.com/c/WEB:terminal-provisional" } : {}), modelPolicy, promptMessageId: "confirmed-user", sentAt: new Date().toISOString(), turnMarker }
    },
    captureExchange: async () => {
      captures += 1
      return alter({
        ...location,
        captureState: "provider_terminal",
        generationRunning: false,
        promptMessageId: "confirmed-user",
        turnMarker,
        providerTerminal: {
          schema: "ego-chat-provider-terminal/v1",
          kind,
          source: "latest_turn_status",
          signalDigest: sha(kind),
          stableObservations: 2,
        },
      })
    },
  }
  const store = new EventStore(dataDir)
  const broker = new Broker({ egoAdapter: adapter, recoveryDelaysMs: [0], store })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation(createOnce
    ? { bindingKey: "terminal-test", mode: "create_once", startUrl: "https://chatgpt.com/", targetId: location.targetId, taskSpace: 901 }
    : { bindingKey: "terminal-test", canonicalUrl, mode: "existing", taskSpace: 901 })
  const request = { bindingKey: "terminal-test", expectedTerminalMarker: terminalMarker, prompt: `${turnMarker}\nReview this.`, timeoutMs: 30_000, turnMarker }
  return { adapter, broker, dataDir, request, store, counts: () => ({ captures, sends }) }
}

test("confirmed provider exhaustion pauses capture durably without committing an assistant result or resending", async (t) => {
  const f = await fixture(t)
  const started = await f.broker.startEgoExchange(f.request)
  const stopped = await f.broker.awaitWorkflow({ workflowId: started.id, timeoutMs: 1_000 })
  assert.equal(stopped.status, "human_required")
  assert.equal(stopped.phase, "provider_paused")
  assert.equal(stopped.humanRequired.code, "chatgpt_conversation_exhausted")
  assert.equal(stopped.providerTerminal.kind, "conversation_exhausted")
  assert.equal(stopped.result, undefined)
  assert.equal(stopped.private, undefined)
  assert.deepEqual(f.counts(), { captures: 1, sends: 1 })
  assert.equal(f.store.getWorkflow(started.id).private.request.prompt, f.request.prompt)
  assert.equal(f.broker.getConversationBinding({ bindingKey: "terminal-test" }).headMessageId, "before-assistant")
  f.broker.close()
  const restarted = new Broker({ egoAdapter: f.adapter, store: new EventStore(f.dataDir) })
  await restarted.initialize()
  t.after(() => restarted.close())
  assert.equal(restarted.getWorkflow({ workflowId: started.id }).phase, "provider_paused")
  const same = await restarted.startEgoExchange(f.request)
  assert.equal(same.id, started.id)
  assert.deepEqual(f.counts(), { captures: 1, sends: 1 })
})

for (const [kind, code] of [
  ["stopped", "chatgpt_stopped_thinking"],
  ["provider_error", "chatgpt_provider_error"],
  ["quota_limited", "chatgpt_quota_limited"],
]) {
  test(`${kind} remains a distinct no-resend boundary, never context-exhaustion permission`, async (t) => {
    const f = await fixture(t, { kind })
    const started = await f.broker.startEgoExchange(f.request)
    const result = await f.broker.awaitWorkflow({ workflowId: started.id, timeoutMs: 1_000 })
    assert.equal(result.humanRequired.code, code)
    assert.equal(result.providerTerminal.kind, kind)
    assert.deepEqual(f.counts(), { sends: 1, captures: 1 })
  })
}

for (const [label, alter] of [
  ["wrong prompt", (value) => ({ ...value, promptMessageId: "unrelated-user" })],
  ["wrong turn", (value) => ({ ...value, turnMarker: "EGO_CHAT_UNRELATED_TURN" })],
  ["wrong chat", (value) => ({ ...value, canonicalUrl: "https://chatgpt.com/c/unrelated" })],
  ["one unstable observation", (value) => ({ ...value, providerTerminal: { ...value.providerTerminal, stableObservations: 1 } })],
  ["active generation", (value) => ({ ...value, generationRunning: true })],
  ["arbitrary prose provenance", (value) => ({ ...value, providerTerminal: { ...value.providerTerminal, source: "assistant_prose" } })],
  ["response mixed with error", (value) => ({ ...value, responseText: "This conversation is too long" })],
]) {
  test(`terminal capture rejects ${label} before accepting a recovery checkpoint`, async (t) => {
    const f = await fixture(t, { alter })
    const started = await f.broker.startEgoExchange(f.request)
    const result = await f.broker.awaitWorkflow({ workflowId: started.id, timeoutMs: 1_000 })
    assert.equal(result.status, "human_required")
    assert.equal(result.providerTerminal, undefined)
    assert.equal(result.result, undefined)
    assert.deepEqual(f.counts(), { sends: 1, captures: 1 })
  })
}

test("an inactive capture checkpoint survives restart and stops the tight retry loop without another Send", async (t) => {
  const f = await fixture(t)
  const started = await f.broker.startEgoExchange(f.request)
  await f.broker.awaitWorkflow({ workflowId: started.id, timeoutMs: 1_000 })
  f.broker.close()
  const previous = f.store.getWorkflow(started.id)
  const seeded = {
    ...previous,
    phase: "send_confirmed",
    status: "running",
    capturePending: { generationRunning: false, observedAt: new Date(Date.now() - 31 * 60_000).toISOString(), reason: "response_not_terminal" },
  }
  delete seeded.humanRequired
  delete seeded.providerTerminal
  await f.store.persist("test.seed_inactive_capture", seeded, previous)
  let reads = 0
  const restarted = new Broker({ egoAdapter: {
    ...f.adapter,
    captureExchange: async () => {
      reads += 1
      return {
        ...location,
        captureReason: "response_not_terminal",
        captureState: "pending",
        generationRunning: false,
        promptMessageId: "confirmed-user",
        statusLabels: ["Still composing a reply…"],
        turnMarker,
      }
    },
  }, store: new EventStore(f.dataDir) })
  await restarted.initialize()
  t.after(() => restarted.close())
  const result = await restarted.awaitWorkflow({ workflowId: started.id, timeoutMs: 1_000 })
  assert.equal(result.phase, "capture_paused")
  assert.equal(result.humanRequired.code, "inactive_capture_stalled")
  assert.deepEqual(result.humanRequired.diagnostic, { statusLabels: ["Still composing a reply…"] })
  assert.deepEqual(result.captureObservation.statusLabels, ["Still composing a reply…"])
  assert.equal(result.providerTerminal, undefined)
  assert.equal(result.delivery.state, "confirmed")
  assert.equal(reads, 1)
  assert.equal(f.counts().sends, 1)
})

test("a provisional create-once first response pins its permanent URL through provider pause and restart for exact late reconciliation", async (t) => {
  const f = await fixture(t, { createOnce: true, provisionalSend: true })
  const started = await f.broker.startEgoExchange(f.request)
  const paused = await f.broker.awaitWorkflow({ workflowId: started.id, timeoutMs: 1_000 })
  assert.equal(paused.delivery.canonicalUrl, canonicalUrl)
  assert.equal(f.store.getWorkflow(started.id).reconciliation.confirmedTaskSpace.canonicalUrl, canonicalUrl)
  f.broker.close()
  let reconciliations = 0
  f.adapter.reconcile = async () => {
    reconciliations += 1
    return {
      ...location, turnMarker,
      responseText: terminalMarker, responseDigest: sha(terminalMarker),
      head: { fingerprint: sha("after"), fingerprintVersion: "tail-v1", lastContentDigest: sha(terminalMarker), lastMessageId: "late-assistant", lastRole: "assistant", messageCount: 2 },
    }
  }
  const restarted = new Broker({ egoAdapter: f.adapter, store: new EventStore(f.dataDir) })
  await restarted.initialize()
  t.after(() => restarted.close())
  const binding = await restarted.reconcileConversation({ bindingKey: "terminal-test", workflowId: started.id })
  assert.equal(binding.canonicalUrl, canonicalUrl)
  assert.equal(binding.state, "bound")
  assert.equal(restarted.getWorkflow({ workflowId: started.id }).status, "succeeded")
  assert.deepEqual(f.counts(), { captures: 1, sends: 1 })
  assert.equal(reconciliations, 1)
})
