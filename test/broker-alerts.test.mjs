import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { setImmediate } from "node:timers"

import { EgoChatError } from "../src/errors.mjs"
import { Broker, classifyAlertTransition } from "../src/broker.mjs"
import { EventStore } from "../src/store.mjs"

class FailingSucceedCommitStore extends EventStore {
  async persist(type, workflow, expectedWorkflow = undefined) {
    if (type === "workflow.succeeded") {
      throw new EgoChatError("injected_commit_failure", "Injected succeeded-commit failure.")
    }
    return super.persist(type, workflow, expectedWorkflow)
  }
}

const sha = (text) => createHash("sha256").update(text).digest("hex")
const canonicalUrl = "https://chatgpt.com/c/alert-fixture"
const turnMarker = "EGO_CHAT_ALERT_TEST"
const terminalMarker = "EGO_CHAT_ALERT_TEST_DONE"
const location = {
  canonicalUrl,
  targetId: "alert-tab",
  taskSpaceId: 902,
  taskSpaceIdentity: { name: "alert-space", taskId: "alert-space-task" },
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

function fakeAlertSink({ notifyResult = { channels: [{ channel: "macos", outcome: "accepted" }] }, onNotify } = {}) {
  const alerts = []
  return {
    alerts,
    describe: () => ({ enabled: true, reason: null, sound: "Glass", webhook: false }),
    notify: async (alert) => {
      alerts.push(alert)
      if (onNotify) return onNotify(alert)
      return notifyResult
    },
  }
}

async function fixture(t, { alertSink, captureAlter = (value) => value, sendThrows = undefined } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ego-chat-broker-alerts-"))
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }))
  let sends = 0
  let captures = 0
  const adapter = {
    bind: async () => ({
      ...location,
      head: {
        fingerprint: sha("before"), fingerprintVersion: "tail-v1",
        lastContentDigest: sha("before"), lastMessageId: "before-assistant",
        lastRole: "assistant", messageCount: 2,
      },
    }),
    sendExchange: async () => {
      sends += 1
      if (sendThrows) throw sendThrows
      return { ...location, modelPolicy, promptMessageId: "confirmed-user", sentAt: new Date().toISOString(), turnMarker }
    },
    captureExchange: async () => {
      captures += 1
      return captureAlter({
        ...location,
        captureState: "provider_terminal",
        generationRunning: false,
        promptMessageId: "confirmed-user",
        turnMarker,
        providerTerminal: {
          schema: "ego-chat-provider-terminal/v1",
          kind: "conversation_exhausted",
          source: "latest_turn_status",
          signalDigest: sha("conversation_exhausted"),
          stableObservations: 2,
        },
      })
    },
  }
  const store = new EventStore(dataDir)
  const broker = new Broker({ alertSink, egoAdapter: adapter, recoveryDelaysMs: [0], store })
  await broker.initialize()
  t.after(() => broker.close())
  await broker.bindConversation({ bindingKey: "alert-test", canonicalUrl, mode: "existing", taskSpace: 902 })
  const request = { bindingKey: "alert-test", expectedTerminalMarker: terminalMarker, prompt: `${turnMarker}\nReview this.`, timeoutMs: 30_000, turnMarker }
  return { adapter, broker, dataDir, request, store, counts: () => ({ captures, sends }) }
}

test("a workflow that ends human_required dispatches exactly one workflow_attention alert", async (t) => {
  const sink = fakeAlertSink()
  const f = await fixture(t, { alertSink: sink })
  const started = await f.broker.startEgoExchange(f.request)
  const stopped = await f.broker.awaitWorkflow({ workflowId: started.id, timeoutMs: 1_000 })
  assert.equal(stopped.status, "human_required")

  assert.equal(sink.alerts.length, 1)
  const alert = sink.alerts[0]
  assert.equal(alert.kind, "workflow_attention")
  assert.equal(alert.workflowId, started.id)
  assert.equal(alert.workflowKind, "ego_exchange")
  assert.equal(alert.status, "human_required")
  assert.equal(alert.code, "chatgpt_conversation_exhausted")
  assert.equal(typeof alert.message, "string")
  assert.ok(alert.message.length <= 200)
  assert.equal(typeof alert.at, "string")
  assert.ok(Number.isFinite(Date.parse(alert.at)))
})

test("a workflow that fails dispatches exactly one alert with the error code", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ego-chat-broker-alerts-failed-"))
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }))
  const sink = fakeAlertSink()
  const responseText = "A complete adopted response."
  const adapter = {
    adopt: async () => ({
      adoptedWhileGenerating: false,
      anchor: { contentDigest: "a".repeat(64), messageId: "adoption-alert-user" },
      canonicalUrl: "https://chatgpt.com/c/alert-failed-fixture",
      durationMs: 5,
      head: {
        fingerprint: "adoption-alert-head",
        fingerprintVersion: "tail-v1",
        lastContentDigest: sha(responseText),
        lastMessageId: "adoption-alert-assistant",
        lastRole: "assistant",
        messageCount: 2,
        renderedMessageCount: 2,
      },
      modelPolicy,
      responseDigest: sha(responseText),
      responseText,
      targetId: "adoption-alert-tab",
      taskSpaceIdentity: { name: "alert-failed-space", taskId: "alert-failed-space-task" },
      taskSpaceId: 903,
    }),
  }
  // Fail the workflow at its final success commit (not inside adopt()'s own
  // retry loop, which never gives up on a generic error) so the outer
  // adoption error handler classifies it as "failed" with a known code.
  const store = new FailingSucceedCommitStore(dataDir)
  const broker = new Broker({ alertSink: sink, egoAdapter: adapter, recoveryDelaysMs: [0], store })
  await broker.initialize()
  t.after(() => broker.close())
  const started = await broker.startConversationAdoption({
    canonicalUrl: "https://chatgpt.com/c/alert-failed-fixture",
    taskSpace: "alert-failed-space",
  })
  const stopped = await broker.awaitWorkflow({ workflowId: started.id, timeoutMs: 2_000 })
  assert.equal(stopped.status, "failed")

  assert.equal(sink.alerts.length, 1)
  const alert = sink.alerts[0]
  assert.equal(alert.kind, "workflow_attention")
  assert.equal(alert.workflowId, started.id)
  assert.equal(alert.status, "failed")
  assert.equal(alert.code, "injected_commit_failure")
})

test("getStatus().alerts reports the sink config, the last alert with channels, and counters", async (t) => {
  const sink = fakeAlertSink()
  const f = await fixture(t, { alertSink: sink })
  const started = await f.broker.startEgoExchange(f.request)
  await f.broker.awaitWorkflow({ workflowId: started.id, timeoutMs: 1_000 })

  // The dispatch is fire-and-forget; wait until the sink was actually invoked
  // and the counters have had a chance to update before asserting.
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  const status = f.broker.getStatus()
  assert.deepEqual(status.alerts.config, sink.describe())
  assert.equal(status.alerts.dispatched, 1)
  assert.equal(status.alerts.failed, 0)
  assert.equal(status.alerts.lastAlert.workflowId, started.id)
  assert.deepEqual(status.alerts.lastAlert.channels, [{ channel: "macos", outcome: "accepted" }])
})

test("a sink whose notify rejects does not break the transition and increments failed", async (t) => {
  const sink = fakeAlertSink({ onNotify: async () => { throw new Error("sink down") } })
  const f = await fixture(t, { alertSink: sink })
  const started = await f.broker.startEgoExchange(f.request)
  const stopped = await f.broker.awaitWorkflow({ workflowId: started.id, timeoutMs: 1_000 })
  assert.equal(stopped.status, "human_required")

  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  const status = f.broker.getStatus()
  assert.equal(status.alerts.dispatched, 1)
  assert.equal(status.alerts.failed, 1)
})

test("getStatus().alerts falls back to a no-op sink description when no alertSink is configured", async (t) => {
  const f = await fixture(t, { alertSink: undefined })
  const status = f.broker.getStatus()
  assert.deepEqual(status.alerts.config, { enabled: false, reason: "no_sink", sound: null, webhook: false })
  assert.equal(status.alerts.dispatched, 0)
  assert.equal(status.alerts.failed, 0)
  assert.equal(status.alerts.lastAlert, null)
})

// classifyAlertTransition is the pure decision function behind the broker's
// dedup logic: fire only when the next state is an attention state and either
// the workflow was not previously in one, or the attention code changed.
// Exercising the full state machine twice into a real second attention
// transition on the same workflow is blocked by the broker's own terminal-
// workflow guards (see the final report), so the decision logic itself is
// unit-tested directly here.
test("classifyAlertTransition fires when entering an attention state from a non-attention state", () => {
  const expected = { id: "w1", kind: "ego_exchange", status: "running", phase: "browser_owned" }
  const next = { id: "w1", kind: "ego_exchange", status: "human_required", phase: "provider_paused", humanRequired: { code: "chatgpt_stopped_thinking", message: "stopped" } }
  assert.deepEqual(classifyAlertTransition(expected, next), { code: "chatgpt_stopped_thinking" })
})

test("classifyAlertTransition does not fire when the attention code is unchanged", () => {
  const expected = { id: "w1", kind: "ego_exchange", status: "human_required", phase: "provider_paused", humanRequired: { code: "chatgpt_stopped_thinking", message: "stopped" } }
  const next = { id: "w1", kind: "ego_exchange", status: "human_required", phase: "provider_paused", humanRequired: { code: "chatgpt_stopped_thinking", message: "stopped again" } }
  assert.equal(classifyAlertTransition(expected, next), null)
})

test("classifyAlertTransition fires again when the attention code changes", () => {
  const expected = { id: "w1", kind: "ego_exchange", status: "human_required", phase: "provider_paused", humanRequired: { code: "chatgpt_stopped_thinking", message: "stopped" } }
  const next = { id: "w1", kind: "ego_exchange", status: "failed", phase: "provider_paused", error: { code: "browser_operation_failed", message: "failed" } }
  assert.deepEqual(classifyAlertTransition(expected, next), { code: "browser_operation_failed" })
})

test("classifyAlertTransition does not fire when leaving or staying outside an attention state", () => {
  assert.equal(classifyAlertTransition(
    { id: "w1", kind: "ego_exchange", status: "running", phase: "browser_owned" },
    { id: "w1", kind: "ego_exchange", status: "running", phase: "response_captured" },
  ), null)
  assert.equal(classifyAlertTransition(
    { id: "w1", kind: "ego_exchange", status: "human_required", phase: "provider_paused", humanRequired: { code: "x" } },
    { id: "w1", kind: "ego_exchange", status: "succeeded", phase: "bound" },
  ), null)
})
