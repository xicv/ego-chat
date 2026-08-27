import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import test from "node:test"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

import { loadOrCreateBrokerToken } from "../src/auth-token.mjs"
import { Broker } from "../src/broker.mjs"
import { MAX_PROMPT_BYTES } from "../src/constants.mjs"
import { prepareAgentReview } from "../src/convergence.mjs"
import { EgoChatError } from "../src/errors.mjs"
import { startIpcServer } from "../src/ipc-server.mjs"
import { EventStore } from "../src/store.mjs"
import {
  MCP_PATH,
  createTestConfig,
  removeTestConfig,
  stopTestDaemon,
} from "./helpers.mjs"

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function modelPolicyObservation() {
  return {
    adjusted: false,
    effortLabel: "Pro",
    key: "chatgpt-web-default",
    modelLabel: "GPT-5.6 Sol",
    pillLabel: "Pro",
    powerLevel: 5,
    powerMax: 5,
  }
}

test("the Codex MCP gate explicitly forwards its isolated broker environment", async () => {
  const source = await fs.readFile(
    new URL("../scripts/codex-mcp-gate.mjs", import.meta.url),
    "utf8",
  )
  for (const name of [
    "EGO_CHAT_DATA_DIR",
    "EGO_CHAT_EGO_BROWSER",
    "EGO_CHAT_SOCKET_PATH",
  ]) {
    assert.match(source, new RegExp(`mcp_servers\\.ego_chat\\.env\\.${name}=`))
  }
})

function strictReviewResponse(input) {
  const candidateDigest = input.prompt.match(/Candidate digest: ([a-f0-9]{64})/)?.[1]
  const cycle = Number(input.prompt.match(/Cycle: (\d+)/)?.[1])
  const targetDigest = input.prompt.match(/Target digest: ([a-f0-9]{64})/)?.[1]
  assert.match(candidateDigest, /^[a-f0-9]{64}$/)
  assert.match(targetDigest, /^[a-f0-9]{64}$/)
  assert.equal(Number.isInteger(cycle), true)
  return `${JSON.stringify({
    candidateDigest,
    criteria: [{ evidence: "The controlled candidate meets AC-1.", id: "AC-1", status: "pass" }],
    cycle,
    decision: "settled",
    findings: [],
    summary: "The controlled strict review is settled.",
    targetDigest,
  })}\n${input.expectedTerminalMarker}`
}

function reviewInput(label) {
  return {
    acceptanceCriteria: ["The controlled candidate passes its exact criterion."],
    bindingKey: "ego-chat-main",
    candidate: {
      blockers: [],
      criteria: [{ evidence: `Controlled evidence for ${label}.`, id: "AC-1", status: "pass" }],
      reviewPacket: `Controlled review packet for ${label}.`,
      status: "candidate",
      summary: `Controlled candidate ${label}.`,
    },
    cycle: 1,
    target: `Settle controlled candidate ${label}.`,
    timeoutMs: 30_000,
    waitMode: "token_saver",
  }
}

async function connectClient(env) {
  const transport = new StdioClientTransport({
    args: [MCP_PATH],
    command: process.execPath,
    env,
    stderr: "pipe",
  })
  const client = new Client({ name: "ego-chat-test", version: "1.0.0" })
  await client.connect(transport)
  return client
}

test("a new MCP facade reattaches to a broker workflow after the first facade exits", async (t) => {
  const { config, env } = await createTestConfig()
  t.after(async () => {
    await stopTestDaemon(config)
    await removeTestConfig(config)
  })

  const firstClient = await connectClient(env)
  const tools = await firstClient.listTools()
  assert.match(firstClient.getInstructions(), /binding ego-chat-main/)
  assert.match(firstClient.getInstructions(), /ego_converge_until_settled/)
  assert.match(firstClient.getInstructions(), /Codex or ZCode task remains the implementer, use ego_review_candidate_and_wait/)
  assert.match(firstClient.getInstructions(), /retry internally with a deterministic fresh marker only after durable reconciliation proves/)
  assert.match(firstClient.getInstructions(), /post-settlement commit, push, merge, deploy, or release work outside the review target/)
  assert.ok(tools.tools.some((tool) => tool.name === "ego_exchange_and_wait"))
  assert.ok(tools.tools.some((tool) => tool.name === "ego_adopt_conversation_and_wait"))
  assert.ok(tools.tools.some((tool) => tool.name === "ego_start_conversation_adoption"))
  assert.ok(tools.tools.some((tool) => tool.name === "ego_review_candidate_and_wait"))
  assert.ok(tools.tools.some((tool) => tool.name === "ego_ensure_model_policy"))
  assert.ok(tools.tools.some((tool) => tool.name === "ego_get_model_policy"))
  assert.ok(tools.tools.some((tool) => tool.name === "ego_start_convergence"))
  assert.ok(tools.tools.some((tool) => tool.name === "ego_converge_until_settled"))
  const reanchorTool = tools.tools.find((tool) => tool.name === "ego_reanchor_conversation")
  assert.ok(reanchorTool)
  assert.equal(
    reanchorTool.inputSchema.properties.acknowledgeExternalChange.const,
    true,
  )
  assert.equal(
    reanchorTool.inputSchema.required.includes("sourceWorkflowId"),
    true,
  )
  const reviewTool = tools.tools.find((tool) => tool.name === "ego_review_candidate_and_wait")
  assert.equal(
    reviewTool.inputSchema.properties.candidate.properties.reviewPacket.maxLength,
    MAX_PROMPT_BYTES,
  )
  const abandonmentTool = tools.tools.find((tool) => tool.name === "abandon_workflow_recovery")
  assert.ok(abandonmentTool)
  assert.equal(
    abandonmentTool.inputSchema.properties.acknowledgePotentialDelivery.const,
    true,
  )
  for (const toolName of [
    "ego_adopt_conversation_and_wait",
    "ego_exchange_and_wait",
    "ego_review_candidate_and_wait",
    "ego_converge_until_settled",
    "await_workflow",
  ]) {
    const waitMode = tools.tools.find((tool) => tool.name === toolName)
      ?.inputSchema?.properties?.waitMode
    assert.deepEqual(waitMode?.enum, ["progress", "token_saver"])
  }
  const modelPolicy = await firstClient.callTool({
    arguments: {},
    name: "ego_get_model_policy",
  })
  assert.equal(modelPolicy.isError, undefined)
  assert.equal(modelPolicy.structuredContent.modelSelection, "strongest_available")
  assert.equal(modelPolicy.structuredContent.thinkingEffort, "maximum_available")
  const started = await firstClient.callTool({
    arguments: { delayMs: 1_200, value: "facade-recovery" },
    name: "gate0_start_probe",
  })
  const workflowId = started.structuredContent.id
  await firstClient.close()

  const secondClient = await connectClient(env)
  t.after(() => secondClient.close())
  const completed = await secondClient.callTool({
    arguments: { timeoutMs: 5_000, waitMode: "token_saver", workflowId },
    name: "await_workflow",
  })

  assert.equal(completed.isError, undefined)
  assert.equal(completed.structuredContent.status, "succeeded")
  assert.equal(completed.structuredContent.result.text, "facade-recovery")
  assert.equal(completed.structuredContent.waitMode, "token_saver")
  assert.equal(completed.content[0].text.includes("\n"), false)
})

test("conversation adoption returns the stable ChatGPT tail into the same MCP turn", async (t) => {
  const { config, env } = await createTestConfig()
  const canonicalUrl = "https://chatgpt.com/c/mcp-adoption"
  const derivedBindingKey = `adopt-${digest(canonicalUrl).slice(0, 24)}`
  const responseText = "The existing ChatGPT long-think response is ready."
  const responseDigest = digest(responseText)
  let adoptionCalls = 0
  let exchangeCalls = 0
  let receivedTaskSpace
  let receivedTimeoutMs
  const egoAdapter = {
    adopt: async (input) => {
      adoptionCalls += 1
      receivedTaskSpace = input.taskSpace
      receivedTimeoutMs = input.timeoutMs
      return {
        adoptedWhileGenerating: true,
        anchor: { contentDigest: "a".repeat(64), messageId: "mcp-adopt-user" },
        canonicalUrl,
        durationMs: 10_000,
        head: {
          fingerprint: "mcp-adopt-head",
          fingerprintVersion: "tail-v1",
          lastContentDigest: responseDigest,
          lastMessageId: "mcp-adopt-assistant",
          lastRole: "assistant",
          messageCount: 2,
          renderedMessageCount: 2,
        },
        modelPolicy: modelPolicyObservation(),
        responseDigest,
        responseText,
        targetId: "mcp-adopt-tab",
        taskSpaceId: 12,
      }
    },
    exchange: async () => {
      exchangeCalls += 1
      throw new Error("adoption must not send")
    },
  }
  const broker = new Broker({ egoAdapter, store: new EventStore(config.dataDir) })
  await broker.initialize()
  const token = await loadOrCreateBrokerToken(config.dataDir)
  const methods = new Map([
    ["conversation.start_adoption", (params) => broker.startConversationAdoption(params)],
    ["workflow.await", (params, signal) => broker.awaitWorkflow(params, signal)],
  ])
  const ipc = await startIpcServer({
    dispatch: async (method, params, signal) => {
      const handler = methods.get(method)
      if (!handler) {
        throw new EgoChatError("method_not_found", "Unexpected controlled adoption method.")
      }
      return handler(params, signal)
    },
    socketPath: config.socketPath,
    token,
  })
  t.after(async () => {
    broker.close()
    await ipc.close()
    await removeTestConfig(config)
  })
  const client = await connectClient(env)
  t.after(() => client.close())

  const adopted = await client.callTool({
    arguments: {
      canonicalUrl,
    },
    name: "ego_adopt_conversation_and_wait",
  })
  assert.equal(adopted.isError, undefined)
  assert.equal(adopted.structuredContent.status, "succeeded")
  assert.equal(adopted.structuredContent.result.bindingKey, derivedBindingKey)
  assert.equal(adopted.structuredContent.result.responseText, responseText)
  assert.equal(adopted.structuredContent.result.responseDigest, responseDigest)
  assert.equal(adopted.structuredContent.result.modelPolicy.powerLevel, 5)
  assert.equal(adopted.structuredContent.waitMode, "token_saver")
  assert.equal(adopted.content[0].text.includes("\n"), false)
  assert.equal(adoptionCalls, 1)
  assert.equal(exchangeCalls, 0)
  assert.equal(receivedTaskSpace, "ego-chat-adoptions")
  assert.equal(receivedTimeoutMs > 0 && receivedTimeoutMs <= 15 * 60 * 1_000, true)
  assert.equal(broker.getConversationBinding({ bindingKey: derivedBindingKey }).state, "bound")
})

test("MCP re-anchors only the exact acknowledged stable head from a proven pre-send stop", async (t) => {
  const { config, env } = await createTestConfig()
  const canonicalUrl = "https://chatgpt.com/c/mcp-reanchor"
  const initialHead = {
    fingerprint: "a".repeat(64),
    fingerprintVersion: "tail-v1",
    lastContentDigest: "b".repeat(64),
    lastMessageId: "mcp-reanchor-initial-assistant",
    lastRole: "assistant",
    messageCount: 2,
  }
  const observedHead = {
    fingerprint: "c".repeat(64),
    fingerprintVersion: "tail-v1",
    lastContentDigest: "d".repeat(64),
    lastMessageId: "mcp-reanchor-external-assistant",
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
    bind: async (input) => ({
      canonicalUrl: input.canonicalUrl,
      head: initialHead,
      targetId: "mcp-reanchor-tab",
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
      return {
        canonicalUrl: input.binding.canonicalUrl,
        head: observedHead,
        headChange,
        targetId: "mcp-reanchor-tab",
        taskSpaceId: 10,
      }
    },
  }
  const broker = new Broker({ egoAdapter, store: new EventStore(config.dataDir) })
  await broker.initialize()
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl,
    mode: "existing",
    taskSpace: 10,
  })
  const token = await loadOrCreateBrokerToken(config.dataDir)
  const methods = new Map([
    ["conversation.reanchor", (params) => broker.reanchorConversation(params)],
    ["ego.start_exchange", (params) => broker.startEgoExchange(params)],
    ["workflow.await", (params, signal) => broker.awaitWorkflow(params, signal)],
  ])
  const ipc = await startIpcServer({
    dispatch: async (method, params, signal) => {
      const handler = methods.get(method)
      if (!handler) {
        throw new EgoChatError("method_not_found", "Unexpected controlled re-anchor method.")
      }
      return handler(params, signal)
    },
    socketPath: config.socketPath,
    token,
  })
  t.after(async () => {
    broker.close()
    await ipc.close()
    await removeTestConfig(config)
  })
  const client = await connectClient(env)
  t.after(() => client.close())

  const turnMarker = "EGO_CHAT_MCP_REANCHOR_TEST123"
  const stopped = await client.callTool({
    arguments: {
      bindingKey: "ego-chat-main",
      expectedTerminalMarker: "EGO_CHAT_MCP_REANCHOR_DONE123",
      prompt: `${turnMarker}\nreview`,
      timeoutMs: 30_000,
      turnMarker,
      waitMode: "token_saver",
    },
    name: "ego_exchange_and_wait",
  })
  assert.equal(stopped.structuredContent.status, "human_required")
  assert.equal(stopped.structuredContent.humanRequired.code, "conversation_head_changed")

  const reanchored = await client.callTool({
    arguments: {
      acknowledgeExternalChange: true,
      bindingKey: "ego-chat-main",
      expectedBindingRevision: 1,
      expectedObservedHeadFingerprint: observedHead.fingerprint,
      sourceWorkflowId: stopped.structuredContent.id,
    },
    name: "ego_reanchor_conversation",
  })
  assert.equal(reanchored.isError, undefined)
  assert.equal(reanchored.structuredContent.headFingerprint, observedHead.fingerprint)
  assert.equal(reanchored.structuredContent.reanchor.changeKind, "message_appended")
  assert.equal(reanchored.structuredContent.revision, 2)
  assert.equal(reanchorCalls, 1)
})

test("two MCP facades cannot interleave sends on one conversation binding", async (t) => {
  const { config, env } = await createTestConfig()
  const canonicalUrl = "https://chatgpt.com/c/two-facade-lease"
  let enterExchange
  let releaseExchange
  const entered = new Promise((resolve) => {
    enterExchange = resolve
  })
  const released = new Promise((resolve) => {
    releaseExchange = resolve
  })
  let exchangeCalls = 0
  const egoAdapter = {
    bind: async (input) => ({
      canonicalUrl: input.canonicalUrl,
      head: {
        fingerprint: "a".repeat(64),
        fingerprintVersion: "tail-v1",
        lastContentDigest: "b".repeat(64),
        lastMessageId: "two-facade-initial-assistant",
        lastRole: "assistant",
        messageCount: 2,
      },
      targetId: "two-facade-tab",
      taskSpaceId: 10,
    }),
    exchange: async (input) => {
      exchangeCalls += 1
      enterExchange()
      await released
      const responseText = input.expectedTerminalMarker
      return {
        canonicalUrl,
        head: {
          fingerprint: "c".repeat(64),
          fingerprintVersion: "tail-v1",
          lastContentDigest: digest(responseText),
          lastMessageId: "two-facade-completed-assistant",
          lastRole: "assistant",
          messageCount: 4,
        },
        modelPolicy: modelPolicyObservation(),
        responseDigest: digest(responseText),
        responseText,
        targetId: "two-facade-tab",
        taskSpaceId: 10,
        turnMarker: input.turnMarker,
      }
    },
  }
  const broker = new Broker({ egoAdapter, store: new EventStore(config.dataDir) })
  await broker.initialize()
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl,
    mode: "existing",
    taskSpace: 10,
  })
  const token = await loadOrCreateBrokerToken(config.dataDir)
  const methods = new Map([
    ["ego.start_exchange", (params) => broker.startEgoExchange(params)],
    ["workflow.await", (params, signal) => broker.awaitWorkflow(params, signal)],
  ])
  const ipc = await startIpcServer({
    dispatch: async (method, params, signal) => {
      const handler = methods.get(method)
      if (!handler) {
        throw new EgoChatError("method_not_found", "Unexpected controlled concurrency method.")
      }
      return handler(params, signal)
    },
    socketPath: config.socketPath,
    token,
  })
  const firstClient = await connectClient(env)
  const secondClient = await connectClient(env)
  t.after(async () => {
    await firstClient.close()
    await secondClient.close()
    broker.close()
    await ipc.close()
    await removeTestConfig(config)
  })

  const firstMarker = "EGO_CHAT_TWO_FACADE_FIRST123"
  const firstCall = firstClient.callTool({
    arguments: {
      bindingKey: "ego-chat-main",
      expectedTerminalMarker: "EGO_CHAT_TWO_FACADE_FIRST_DONE123",
      prompt: `${firstMarker}\nfirst review`,
      timeoutMs: 30_000,
      turnMarker: firstMarker,
      waitMode: "token_saver",
    },
    name: "ego_exchange_and_wait",
  })
  await entered

  const secondMarker = "EGO_CHAT_TWO_FACADE_SECOND123"
  const second = await secondClient.callTool({
    arguments: {
      bindingKey: "ego-chat-main",
      expectedTerminalMarker: "EGO_CHAT_TWO_FACADE_SECOND_DONE123",
      prompt: `${secondMarker}\nsecond review`,
      timeoutMs: 30_000,
      turnMarker: secondMarker,
      waitMode: "token_saver",
    },
    name: "ego_exchange_and_wait",
  })
  const secondError = JSON.parse(second.content[0].text)
  assert.equal(second.isError, true)
  assert.equal(secondError.code, "conversation_busy")
  assert.equal(exchangeCalls, 1)

  releaseExchange()
  const first = await firstCall
  assert.equal(first.isError, undefined)
  assert.equal(first.structuredContent.status, "succeeded")
  assert.equal(exchangeCalls, 1)
})

test("Token-Saver wait errors preserve the durable workflow recovery handle", async (t) => {
  const { config, env } = await createTestConfig()
  const workflowId = "a2397352-b40f-428a-87d6-379abb262573"
  const token = await loadOrCreateBrokerToken(config.dataDir)
  const ipc = await startIpcServer({
    dispatch: async (method) => {
      if (method === "ego.start_exchange") {
        return { id: workflowId, kind: "ego_exchange", status: "running" }
      }
      if (method === "workflow.await") {
        throw new EgoChatError("wait_timeout", "The controlled workflow is still running.")
      }
      throw new EgoChatError("method_not_found", "Unexpected Token-Saver recovery method.")
    },
    socketPath: config.socketPath,
    token,
  })
  t.after(async () => {
    await ipc.close()
    await removeTestConfig(config)
  })
  const client = await connectClient(env)
  t.after(() => client.close())

  const turnMarker = "EGO_CHAT_TOKEN_SAVER_RECOVERY"
  const result = await client.callTool({
    arguments: {
      bindingKey: "ego-chat-main",
      expectedTerminalMarker: "TOKEN_SAVER_RECOVERY_DONE",
      prompt: `${turnMarker}\nreview`,
      timeoutMs: 30_000,
      turnMarker,
      waitMode: "token_saver",
    },
    name: "ego_exchange_and_wait",
  })
  const error = JSON.parse(result.content[0].text)
  assert.equal(result.isError, true)
  assert.equal(error.code, "wait_timeout")
  assert.equal(error.details.waitMode, "token_saver")
  assert.equal(error.details.workflowId, workflowId)
})

test("strict candidate review crosses MCP, validates settlement, and reconciles without resending", async (t) => {
  const { config, env } = await createTestConfig()
  const canonicalUrl = "https://chatgpt.com/c/controlled-mcp-review"
  const responseDigests = new Map()
  let exchanges = 0
  const exchangeMarkers = []
  let pendingRecovery = null
  let reconciliations = 0
  const egoAdapter = {
    bind: async () => ({
      canonicalUrl,
      head: {
        fingerprint: "controlled-head-0",
        fingerprintVersion: "tail-v1",
        lastContentDigest: "0".repeat(64),
        lastMessageId: "controlled-assistant-0",
        lastRole: "assistant",
        messageCount: 2,
      },
      targetId: "controlled-tab",
      taskSpaceId: 10,
    }),
    exchange: async (input) => {
      exchanges += 1
      exchangeMarkers.push(input.turnMarker)
      if (input.prompt.includes("always-absent")) {
        pendingRecovery = { kind: "absent" }
        throw new EgoChatError(
          "ego_driver_error",
          "The fixed Ego Browser driver failed before delivery.",
          {
            diagnosticDigest: "e".repeat(64),
            draftCleared: true,
            driverStage: "verifying_presend_model_policy",
            evidence: { modelPolicy: modelPolicyObservation() },
          },
        )
      }
      if (input.turnMarker === "EGO_CHAT_MCP_LARGE_RESULT_20260825") {
        const responseText = `${"😀large-token-saver-result ".repeat(900)}${input.expectedTerminalMarker}`
        return {
          canonicalUrl,
          head: {
            fingerprint: "controlled-large-result-head",
            fingerprintVersion: "tail-v1",
            lastContentDigest: digest(responseText),
            lastMessageId: "controlled-large-result-assistant",
            lastRole: "assistant",
            messageCount: input.binding.messageCount + 2,
          },
          modelPolicy: modelPolicyObservation(),
          responseDigest: digest(responseText),
          responseText,
          targetId: "controlled-tab",
          taskSpaceId: 10,
          turnMarker: input.turnMarker,
        }
      }
      const responseText = strictReviewResponse(input)
      responseDigests.set(exchanges, digest(responseText))
      if (exchanges === 3) {
        pendingRecovery = { kind: "recover", responseText }
        throw new EgoChatError(
          "human_required",
          "The completed pair was captured late.",
          {
            evidence: { modelPolicy: modelPolicyObservation() },
            reason: "conversation_head_commit_mismatch",
          },
        )
      }
      if (exchanges === 4) {
        pendingRecovery = { kind: "reject", responseText }
        throw new EgoChatError(
          "human_required",
          "The send confirmation was ambiguous.",
          {
            evidence: { modelPolicy: modelPolicyObservation() },
            reason: "send_confirmation_ambiguous",
          },
        )
      }
      if (exchanges === 5) {
        pendingRecovery = { kind: "absent" }
        throw new EgoChatError(
          "ego_driver_error",
          "The fixed Ego Browser driver failed.",
          {
            diagnosticDigest: "f".repeat(64),
            draftCleared: true,
            driverStage: "composing_prompt",
            evidence: { modelPolicy: modelPolicyObservation() },
          },
        )
      }
      const returnedText = exchanges === 2
        ? `not-json\n${input.expectedTerminalMarker}`
        : responseText
      responseDigests.set(exchanges, digest(returnedText))
      return {
        canonicalUrl,
        head: {
          fingerprint: `controlled-head-${exchanges}`,
          fingerprintVersion: "tail-v1",
          lastContentDigest: digest(returnedText),
          lastMessageId: `controlled-assistant-${exchanges}`,
          lastRole: "assistant",
          messageCount: input.binding.messageCount + 2,
        },
        modelPolicy: modelPolicyObservation(),
        responseDigest: digest(returnedText),
        responseText: returnedText,
        targetId: "controlled-tab",
        taskSpaceId: 10,
        turnMarker: input.turnMarker,
      }
    },
    reconcileBound: async (input) => {
      reconciliations += 1
      assert.ok(pendingRecovery)
      assert.equal(input.turnMarker.length > 20, true)
      assert.equal(input.expectedTerminalMarker.length > 20, true)
      if (pendingRecovery.kind === "reject") {
        throw new EgoChatError(
          "human_required",
          "The browser pair is not attributable.",
          { reason: "bound_reconciliation_mismatch" },
        )
      }
      if (pendingRecovery.kind === "absent") {
        pendingRecovery = null
        return {
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
          targetId: "controlled-tab",
          taskSpaceId: 10,
          turnMarker: input.turnMarker,
        }
      }
      const responseText = pendingRecovery.responseText
      pendingRecovery = null
      return {
        canonicalUrl,
        head: {
          fingerprint: `controlled-reconciled-head-${reconciliations}`,
          fingerprintVersion: "tail-v1",
          lastContentDigest: digest(responseText),
          lastMessageId: `controlled-reconciled-assistant-${reconciliations}`,
          lastRole: "assistant",
          messageCount: input.binding.messageCount + 2,
        },
        responseDigest: digest(responseText),
        responseText,
        targetId: "controlled-tab",
        taskSpaceId: 10,
        turnMarker: input.turnMarker,
      }
    },
  }
  const broker = new Broker({ egoAdapter, store: new EventStore(config.dataDir) })
  await broker.initialize()
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl,
    mode: "existing",
    taskSpace: 10,
  })
  const token = await loadOrCreateBrokerToken(config.dataDir)
  const methods = new Map([
    ["conversation.reconcile", (params) => broker.reconcileConversation(params)],
    ["ego.start_exchange", (params) => broker.startEgoExchange(params)],
    ["result.read", (params) => broker.readResult(params)],
    ["workflow.await", (params, signal) => broker.awaitWorkflow(params, signal)],
  ])
  const ipc = await startIpcServer({
    dispatch: async (method, params, signal) => {
      const handler = methods.get(method)
      if (!handler) {
        throw new EgoChatError("method_not_found", "Unexpected controlled test method.")
      }
      return handler(params, signal)
    },
    socketPath: config.socketPath,
    token,
  })
  t.after(async () => {
    broker.close()
    await ipc.close()
    await removeTestConfig(config)
  })
  const client = await connectClient(env)
  t.after(() => client.close())

  const directInput = reviewInput("direct")
  const expectedDirect = prepareAgentReview({
    ...directInput,
    markerToken: "A".repeat(32),
  })
  const settled = await client.callTool({
    arguments: directInput,
    name: "ego_review_candidate_and_wait",
  })
  assert.equal(settled.isError, undefined)
  assert.equal(settled.structuredContent.settled, true)
  assert.equal(settled.structuredContent.recoveredLateResponse, false)
  assert.equal(settled.structuredContent.modelPolicy.modelLabel, "GPT-5.6 Sol")
  assert.equal(settled.structuredContent.responseDigest, responseDigests.get(1))
  assert.equal(settled.structuredContent.candidateDigest, expectedDirect.candidateDigest)
  assert.equal(settled.structuredContent.targetDigest, expectedDirect.contract.targetDigest)
  assert.equal(settled.structuredContent.review.candidateDigest, expectedDirect.candidateDigest)
  assert.equal(settled.structuredContent.review.targetDigest, expectedDirect.contract.targetDigest)
  assert.equal(settled.structuredContent.operationId, expectedDirect.operationId)
  assert.match(settled.structuredContent.operationId, /^review-[a-f0-9]{48}$/)
  assert.equal(settled.structuredContent.waitMode, "token_saver")
  assert.equal(settled.content[0].text.includes("\n"), false)

  const replayed = await client.callTool({
    arguments: directInput,
    name: "ego_review_candidate_and_wait",
  })
  assert.equal(replayed.isError, undefined)
  assert.equal(replayed.structuredContent.exchangeWorkflowId, settled.structuredContent.exchangeWorkflowId)
  assert.equal(replayed.structuredContent.operationId, settled.structuredContent.operationId)
  assert.equal(exchanges, 1)

  const malformed = await client.callTool({
    arguments: reviewInput("malformed"),
    name: "ego_review_candidate_and_wait",
  })
  assert.equal(malformed.isError, true)
  assert.equal(JSON.parse(malformed.content[0].text).details.reason, "convergence_protocol_invalid")

  const recovered = await client.callTool({
    arguments: reviewInput("late-recovery"),
    name: "ego_review_candidate_and_wait",
  })
  assert.equal(recovered.isError, undefined)
  assert.equal(recovered.structuredContent.settled, true)
  assert.equal(recovered.structuredContent.recoveredLateResponse, true)
  assert.equal(recovered.structuredContent.modelPolicy.powerLevel, 5)
  assert.equal(recovered.structuredContent.responseDigest, responseDigests.get(3))

  const ambiguous = await client.callTool({
    arguments: reviewInput("ambiguous"),
    name: "ego_review_candidate_and_wait",
  })
  assert.equal(ambiguous.isError, true)
  assert.equal(JSON.parse(ambiguous.content[0].text).details.reason, "bound_reconciliation_mismatch")

  const absentInput = reviewInput("delivery-absent")
  const absent = await client.callTool({
    arguments: absentInput,
    name: "ego_review_candidate_and_wait",
  })
  assert.equal(absent.isError, undefined)
  assert.equal(absent.structuredContent.settled, true)
  assert.equal(absent.structuredContent.deliveryAttemptCount, 2)
  assert.equal(absent.structuredContent.deliveryAbsentWorkflowIds.length, 1)
  assert.notEqual(exchangeMarkers[4], exchangeMarkers[5])
  assert.equal(exchanges, 6)
  assert.equal(reconciliations, 3)

  const replayedAbsent = await client.callTool({
    arguments: absentInput,
    name: "ego_review_candidate_and_wait",
  })
  assert.equal(replayedAbsent.isError, undefined)
  assert.equal(replayedAbsent.structuredContent.exchangeWorkflowId, absent.structuredContent.exchangeWorkflowId)
  assert.deepEqual(
    replayedAbsent.structuredContent.deliveryAbsentWorkflowIds,
    absent.structuredContent.deliveryAbsentWorkflowIds,
  )
  assert.equal(exchanges, 6)

  const explicitOperationId = "review-conflict-operation-20260825"
  const firstConflict = await client.callTool({
    arguments: { ...reviewInput("conflict-base"), operationId: explicitOperationId },
    name: "ego_review_candidate_and_wait",
  })
  assert.equal(firstConflict.isError, undefined)
  assert.equal(firstConflict.structuredContent.operationId, explicitOperationId)
  const conflictingRetry = await client.callTool({
    arguments: { ...reviewInput("conflict-changed"), operationId: explicitOperationId },
    name: "ego_review_candidate_and_wait",
  })
  assert.equal(conflictingRetry.isError, true)
  assert.equal(JSON.parse(conflictingRetry.content[0].text).code, "operation_key_conflict")
  assert.equal(exchanges, 7)

  const largeTurnMarker = "EGO_CHAT_MCP_LARGE_RESULT_20260825"
  const largeResult = await client.callTool({
    arguments: {
      bindingKey: "ego-chat-main",
      expectedTerminalMarker: "EGO_CHAT_MCP_LARGE_RESULT_DONE",
      prompt: `${largeTurnMarker}\nReturn the large controlled response.`,
      timeoutMs: 30_000,
      turnMarker: largeTurnMarker,
      waitMode: "token_saver",
    },
    name: "ego_exchange_and_wait",
  })
  assert.equal(largeResult.isError, undefined)
  assert.equal(largeResult.structuredContent.result.responseText, undefined)
  assert.match(largeResult.structuredContent.result.responseRef.digest, /^[a-f0-9]{64}$/)
  assert.ok(largeResult.structuredContent.result.responseExcerpt.length < 5_000)
  assert.ok(Buffer.byteLength(largeResult.content[0].text, "utf8") < 1_024)
  assert.equal(largeResult.content[0].text.includes("large-token-saver-result"), false)
  const largeWorkflowId = largeResult.structuredContent.id
  const largeDigest = largeResult.structuredContent.result.responseRef.digest
  const read = await client.callTool({
    arguments: {
      expectedDigest: largeDigest,
      maxBytes: 256 * 1024,
      offset: 0,
      workflowId: largeWorkflowId,
    },
    name: "ego_read_result",
  })
  assert.equal(read.isError, undefined)
  assert.equal(read.structuredContent.complete, true)
  assert.match(read.content[0].text, /EGO_CHAT_MCP_LARGE_RESULT_DONE$/)
  const crossWorkflowRead = await client.callTool({
    arguments: {
      expectedDigest: largeDigest,
      maxBytes: 64 * 1024,
      offset: 0,
      workflowId: settled.structuredContent.exchangeWorkflowId,
    },
    name: "ego_read_result",
  })
  assert.equal(crossWorkflowRead.isError, true)
  assert.equal(JSON.parse(crossWorkflowRead.content[0].text).code, "result_digest_mismatch")
  assert.equal(exchanges, 8)

  const exhausted = await client.callTool({
    arguments: reviewInput("always-absent"),
    name: "ego_review_candidate_and_wait",
  })
  const exhaustedError = JSON.parse(exhausted.content[0].text)
  assert.equal(exhausted.isError, true)
  assert.equal(exhaustedError.details.reason, "review_delivery_retries_exhausted")
  assert.equal(exhaustedError.details.deliveryAttemptCount, 3)
  assert.equal(exhaustedError.details.deliveryAbsentWorkflowIds.length, 3)
  assert.equal(new Set(exchangeMarkers.slice(-3)).size, 3)
  assert.equal(exchanges, 11)
  assert.equal(reconciliations, 6)
})
